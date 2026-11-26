#!/usr/bin/env node
/**
 * scripts/partition-dryrun.js —— event 表"按 t_start_year 500 年一档分区"的实测脚本
 * =============================================================================
 * 目的：回答一个具体问题 —— **在 50 万 ~ 1 亿量级上，声明的 RANGE 分区到底值不值得做？**
 *
 * 做法（严格对齐 src/db/migrations/002-partition.sql 的方案 B，不另写一套 DDL）：
 *   1. setup   : 建库 partition_proto，按生产 schema 建**普通表** event（含全部 12 个索引）
 *   2. load    : 用 bench/gen.js 灌 100000 条（每批 500 行多行 INSERT），记录灌入/建索引耗时
 *   3. migrate : **直接执行 002-partition.sql 的方案 B 全文**
 *                → event 变成 17 分区的分区表，原普通表改名 event_legacy
 *                → 于是 event（分区表）与 event_legacy（普通表）持有**完全相同**的数据
 *                  和**完全相同**的 12 个索引，构成公平的 A/B 对照
 *   4. bench   : 10 年 / 100 年 / 全时段(limit 200) 三档 × 各 20 次，输出 p50/p95
 *   5. explain : 证明 partition pruning（打印真正被扫描的分区名），并给出反例
 *                （t_span 区间查询无法剪枝）
 *   6. stats   : 分区数、每分区行数/体积、索引总体积对比
 *   7. teardown: DROP DATABASE partition_proto
 *
 * 额外阶段：
 *   migration-check : 在**独立克隆库**上把方案 A / 方案 B 各跑一遍，验证 DDL 可执行性、
 *                     17 个分区、外键数量、序列接管、ON UPDATE CASCADE，并记录
 *                     `ON CONFLICT (slug)` 的破坏性（42P10）。
 *
 * 用法（**必须分阶段跑**，单次执行控制在 3 分钟内）：
 *   node scripts/partition-dryrun.js --stage=setup,load
 *   node scripts/partition-dryrun.js --stage=migrate
 *   node scripts/partition-dryrun.js --stage=bench,explain,stats
 *   node scripts/partition-dryrun.js --stage=migration-check
 *   node scripts/partition-dryrun.js --stage=teardown
 *   node scripts/partition-dryrun.js --stage=all        # 一次性跑完（约 1.5~2 分钟）
 *
 * 环境变量 / 默认值：
 *   PGHOST=127.0.0.1  PGPORT=5433  PGUSER=postgres   （trust 认证）
 *   DB=partition_proto  ROWS=100000  BATCH=500  ITERS=20  LIMIT=200
 *
 * 安全约定：
 *   · 只操作自己建的 partition_proto / partition_mig_* 库；
 *   · **绝不触碰** history_atlas（不 DROP、不 ALTER、不连它做任何写操作）；
 *   · teardown 会先 terminate 该库上的其他连接再 DROP，避免"库被占用"。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { EVENT_COLS, makeEventRows } from '../bench/gen.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const MIGRATION = path.join(ROOT, 'src/db/migrations/002-partition.sql')

const HOST = process.env.PGHOST || '127.0.0.1'
const PORT = Number(process.env.PGPORT || 5433)
const USER = process.env.PGUSER || 'postgres'
const DB = process.env.DB || 'partition_proto'
const ROWS = Number(process.env.ROWS || 100_000)
const BATCH = Number(process.env.BATCH || 500)
const ITERS = Number(process.env.ITERS || 20)
const WARMUP = 3
const LIMIT = Number(process.env.LIMIT || 200)

const PARENT = 'event'          // 迁移后：分区表
const FLAT = 'event_legacy'     // 迁移后：同数据的普通表

/** 生产库 event 上的 12 个索引名（实测自 pg_indexes），用于保证 A/B 索引对等 */
const PROD_INDEXES = `
CREATE INDEX event_year_idx   ON event (t_start_year);
CREATE INDEX event_track_idx  ON event (track, t_start_year);
CREATE INDEX event_status_idx ON event (status);
CREATE INDEX event_place_idx  ON event (place_slug);
CREATE INDEX event_fts_idx    ON event USING GIN (search_tsv);
CREATE INDEX event_span_idx   ON event USING GIST (t_span);
CREATE INDEX event_timeline_cover_idx
  ON event (t_start_year)
  INCLUDE (slug, title, t_start_month, t_start_day, t_end_year,
           t_precision, t_certainty, track, category, discipline, lat, lon)
  WHERE status = 'published';
CREATE INDEX event_title_trgm_idx       ON event USING GIN (title gin_trgm_ops);
CREATE INDEX event_summary_trgm_idx     ON event USING GIN (summary gin_trgm_ops);
CREATE INDEX event_search_text_trgm_idx ON event USING GIN (search_text gin_trgm_ops);
`

/** 生产 schema 里 event 用到的 3 个枚举（其余枚举本压测用不到） */
const TYPES = `
CREATE TYPE t_precision   AS ENUM ('day','month','year','decade','century','millennium','unknown');
CREATE TYPE t_certainty   AS ENUM ('certain','probable','circa','disputed','legendary');
CREATE TYPE entity_status AS ENUM ('draft','staged','reviewed','published','rejected');
`

/** 与 src/db/schema.sql 中 event 的定义逐列对齐（含 GENERATED t_span / BIGSERIAL / CHECK） */
const FLAT_TABLE = `
CREATE TABLE event (
  id            BIGSERIAL PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  title         TEXT NOT NULL,
  track         TEXT NOT NULL CHECK (track IN ('cn','world')),
  category      TEXT NOT NULL,
  discipline    TEXT,
  t_start_year  INT  NOT NULL,
  t_start_month SMALLINT,
  t_start_day   SMALLINT,
  t_end_year    INT,
  t_end_month   SMALLINT,
  t_end_day     SMALLINT,
  t_precision   t_precision  NOT NULL DEFAULT 'year',
  t_certainty   t_certainty  NOT NULL DEFAULT 'certain',
  t_span        INT4RANGE GENERATED ALWAYS AS
                (int4range(t_start_year, COALESCE(t_end_year, t_start_year) + 1)) STORED,
  place_slug    TEXT,
  lat           DOUBLE PRECISION,
  lon           DOUBLE PRECISION,
  summary       TEXT,
  search_text   TEXT,
  search_tsv    TSVECTOR,
  status        entity_status NOT NULL DEFAULT 'published',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  rev           INT NOT NULL DEFAULT 1
);
`

// ============================================================================
// 小工具
// ============================================================================
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6
const f2 = (x) => Math.round(x * 100) / 100
const nowBig = () => process.hrtime.bigint()

function log(...a) { console.log(...a) }
function hdr(title) { log('\n' + '='.repeat(78) + '\n' + title + '\n' + '='.repeat(78)) }

/** nearest-rank 分位数：p 取 0~1 */
function pct(sorted, p) {
  if (!sorted.length) return NaN
  const rank = Math.ceil(p * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b)
  return {
    n: s.length,
    p50: f2(pct(s, 0.5)),
    p95: f2(pct(s, 0.95)),
    min: f2(s[0]),
    max: f2(s[s.length - 1]),
    mean: f2(s.reduce((a, b) => a + b, 0) / s.length),
  }
}

/** 用 admin 连接（postgres 库）建/删库 */
async function adminClient() {
  const c = new pg.Client({ host: HOST, port: PORT, user: USER, database: 'postgres' })
  await c.connect()
  return c
}

async function connectDB(db = DB) {
  const c = new pg.Client({ host: HOST, port: PORT, user: USER, database: db })
  await c.connect()
  c.on('notice', (n) => {
    // 只显示"非预期"的 notice：跳过老版本常见的 "does not exist, skipping"
    if (!/does not exist, skipping/.test(n.message)) log('   NOTICE: ' + n.message)
  })
  return c
}

/**
 * 构造多行 INSERT 的 VALUES 占位符：n 行 × EVENT_COLS.length 列。
 * 例：n=2, cols=3 → "($1,$2,$3),($4,$5,$6)"
 * 注意这里必须按**行**展开括号，只写一处 "($1..$k)" 会让绑定参数数与占位符数不符（08P01）。
 */
function valuesClause(n, ncols) {
  const groups = []
  let p = 0
  for (let r = 0; r < n; r++) {
    const one = []
    for (let c = 0; c < ncols; c++) one.push('$' + (++p))
    groups.push('(' + one.join(',') + ')')
  }
  return groups.join(',')
}

/** 单条多行 INSERT 语句（批大小运行时决定，故整句按 n 构造） */
function insertSql(n) {
  return `INSERT INTO event (${EVENT_COLS.join(',')}) VALUES ${valuesClause(n, EVENT_COLS.length)}`
}

/** 从 002-partition.sql 里按 `-- @@PLAN_x_BEGIN` / `_END` **整行精确**切出对应段落 */
function readPlan(name) {
  const src = fs.readFileSync(MIGRATION, 'utf8')
  const lines = src.split(/\r?\n/)
  const b = lines.findIndex((l) => l.trim() === `-- @@${name}_BEGIN`)
  const e = lines.findIndex((l) => l.trim() === `-- @@${name}_END`)
  if (b < 0 || e < 0 || e < b) {
    throw new Error(`在 002-partition.sql 中找不到 ${name} 的标记行 @@${name}_BEGIN/_END`)
  }
  return lines.slice(b + 1, e).join('\n')
}

// ============================================================================
// 阶段 1：setup —— 建库 + 生产同构普通表
// ============================================================================
async function stageSetup() {
  hdr(`[setup] 建库 ${DB} + 生产同构普通表 ${PARENT}`)
  const admin = await adminClient()
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${DB}`)
    log(`   数据库 ${DB} 已重建`)
  } finally {
    await admin.end()
  }

  const c = await connectDB()
  try {
    await c.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')
    await c.query(TYPES)
    await c.query(FLAT_TABLE)
    log('   类型 + event 普通表已建（BIGSERIAL PK / UNIQUE(slug) / CHECK track / GENERATED t_span）')
  } finally {
    await c.end()
  }
}

// ============================================================================
// 阶段 2：load —— 灌 ROWS 条 + 建 12 个生产索引
// ============================================================================
async function stageLoad() {
  hdr(`[load] 灌 ${ROWS.toLocaleString()} 条（每批 ${BATCH} 行多行 INSERT）+ 建 12 个生产索引`)
  const c = await connectDB()
  try {
    const t0 = nowBig()
    let done = 0
    for (let off = 0; off < ROWS; off += BATCH) {
      const n = Math.min(BATCH, ROWS - off)
      const rows = makeEventRows(off, n, ROWS)
      await c.query(insertSql(n), rows.flat())   // 多行 INSERT：一次 500 行 / 10000 个占位符
      done += n
      if (done % 10_000 === 0 || done === ROWS) {
        const el = ms(t0)
        log(`   ${String(done).padStart(7)} / ${ROWS}  ${f2(el).toFixed(0).padStart(6)}ms  ` +
            `(${(done / (el / 1000)).toFixed(0)} rows/s)`)
      }
    }
    const loadMs = ms(t0)

    const t1 = nowBig()
    await c.query(PROD_INDEXES)
    const idxMs = ms(t1)

    await c.query('ANALYZE event')
    const one = await c.query(
      `SELECT count(*)::int AS n, min(t_start_year) AS lo, max(t_start_year) AS hi FROM event`
    )
    log(`\n   灌数据 ${f2(loadMs)} ms（${(ROWS / (loadMs / 1000)).toFixed(0)} rows/s）`)
    log(`   建 12 个索引 ${f2(idxMs)} ms`)
    log(`   行数 ${one.rows[0].n}  年份范围 [${one.rows[0].lo}, ${one.rows[0].hi}]`)
  } finally {
    await c.end()
  }
}

// ============================================================================
// 阶段 3：migrate —— 直接执行 002-partition.sql 的方案 B
// ============================================================================
async function stageMigrate() {
  hdr('[migrate] 执行 002-partition.sql 方案 B（原表 → event_legacy，分区表接管 event）')
  const planB = readPlan('PLAN_B')
  log(`   方案 B 段落 ${planB.length} 字符`)

  const c = await connectDB()
  try {
    const before = await c.query('SELECT count(*)::int AS n FROM event')

    // ------------------------------------------------------------------
    // 迁移前置：关掉本表的 autovacuum + 设 lock_timeout
    // ------------------------------------------------------------------
    // 实测（100 万行）：不关 autovacuum 时，迁移会以 40P01 deadlock detected 失败。
    // 机理：迁移事务里 INSERT...SELECT 对 event 持 ACCESS SHARE，
    //       随后 RENAME 要升级成 ACCESS EXCLUSIVE；同时 autovacuum 在 event / 其索引上
    //       持 ShareUpdateExclusive 并反过来等我们持有的索引锁 → 互相等待 → 死锁。
    // 这是**规模相关**的风险：728 行/10 万行时 autovacuum 根本来不及介入，跑一次就过；
    // 到了百万行就会必然撞上（详见 docs/report/partition.md §4 R11）。
    const tv = nowBig()
    await c.query('VACUUM (ANALYZE) event')
    await c.query('ALTER TABLE event SET (autovacuum_enabled = false)')
    await c.query("SET lock_timeout = '60s'")
    log(`   前置 VACUUM(ANALYZE) + 关闭 autovacuum 耗时 ${f2(ms(tv))} ms`)

    // 死锁/锁超时后整个 BEGIN..COMMIT 已回滚，连接仍可用，故可安全重试。
    let dur = null
    let attempts = 0
    let lastErr = null
    while (attempts < 3) {
      attempts++
      const t0 = nowBig()
      try {
        await c.query(planB)
        dur = ms(t0)
        break
      } catch (e) {
        lastErr = e
        const retriable = ['40P01', '55P03', '57014'].includes(e.code)
        log(`   第 ${attempts} 次尝试失败 [${e.code}] ${e.message}` +
            `${e.detail ? ' | ' + e.detail : ''}${retriable ? '  → 事务已回滚，重试' : ''}`)
        if (!retriable) throw e
        await c.query('VACUUM (ANALYZE) event').catch(() => {})
      }
    }
    if (dur === null) throw lastErr

    // 关掉新分区表的 autovacuum，避免压测期间 autovacuum 介入污染计时
    await c.query(`
      DO $do$ DECLARE r record; BEGIN
        FOR r IN SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
                  WHERE i.inhparent = 'public.event'::regclass
        LOOP EXECUTE format('ALTER TABLE %I SET (autovacuum_enabled = false)', r.relname); END LOOP;
      END $do$`).catch(() => {})
    await c.query('ALTER TABLE event_legacy SET (autovacuum_enabled = false)').catch(() => {})

    const part = await c.query(
      `SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'public.event'::regclass`
    )
    const both = await c.query(
      `SELECT (SELECT count(*) FROM event)::int AS part_rows,
              (SELECT count(*) FROM event_legacy)::int AS flat_rows`
    )
    const kind = await c.query(
      `SELECT relname, relkind FROM pg_class WHERE relname IN ('event','event_legacy') ORDER BY 1`
    )
    log(`\n   迁移耗时 ${f2(dur)} ms（第 ${attempts} 次尝试成功；` +
        `含 17 分区建表 + 复制 ${before.rows[0].n} 行 + 重建 12 索引 + 换名）`)
    log(`   分区数 ${part.rows[0].n}`)
    log(`   行数：分区表 ${both.rows[0].part_rows}  普通表 ${both.rows[0].flat_rows}`)
    log(`   关系：${kind.rows.map((r) => `${r.relname}=${r.relkind === 'p' ? 'partitioned' : 'table'}`).join('  ')}`)
    if (both.rows[0].part_rows !== both.rows[0].flat_rows) {
      throw new Error('行数不守恒！分区表与普通表行数不一致')
    }
  } finally {
    await c.end()
  }
}

// ============================================================================
// 阶段 4：bench —— 分区表 vs 同数据普通表
// ============================================================================
const TIMELINE_SQL = (tbl) => `
SELECT slug, title, t_start_year, t_start_month, t_start_day, t_end_year,
       t_precision, t_certainty, track, category, discipline, lat, lon
FROM ${tbl}
WHERE status = 'published' AND t_start_year >= $1 AND t_start_year < $2
ORDER BY t_start_year
LIMIT ${LIMIT}`

const WINDOWS = [
  { id: '10y', from: 1495, to: 1505, label: '10 年 [1495,1505)' },
  { id: '100y', from: 1450, to: 1550, label: '100 年 [1450,1550)' },
  { id: 'full', from: -5000, to: 2025, label: '全时段 [-5000,2025) limit 200' },
]

/** COUNT(*) 版本：暴露"17 路 Append"在无谓词/宽谓词下的开销 */
const COUNT_SQL = (tbl) => `
SELECT count(*)::int AS n FROM ${tbl}
WHERE status = 'published' AND t_start_year >= $1 AND t_start_year < $2`

async function timeIt(c, sql, params, iters) {
  for (let i = 0; i < WARMUP; i++) await c.query(sql, params)   // 预热，不计入
  const samples = []
  for (let i = 0; i < iters; i++) {
    const t = nowBig()
    await c.query(sql, params)
    samples.push(ms(t))
  }
  return stats(samples)
}

async function stageBench() {
  hdr(`[bench] 分区表 ${PARENT}  vs  同数据普通表 ${FLAT}   （各 ${ITERS} 次，预热 ${WARMUP} 次）`)
  const c = await connectDB()
  try {
    const rowsOut = []
    for (const w of WINDOWS) {
      const params = [w.from, w.to]
      const flat = await timeIt(c, TIMELINE_SQL(FLAT), params, ITERS)
      const part = await timeIt(c, TIMELINE_SQL(PARENT), params, ITERS)
      const flatCnt = await timeIt(c, COUNT_SQL(FLAT), params, ITERS)
      const partCnt = await timeIt(c, COUNT_SQL(PARENT), params, ITERS)

      // 命中行数（确认两表返回一致）
      const nFlat = (await c.query(COUNT_SQL(FLAT), params)).rows[0].n
      const nPart = (await c.query(COUNT_SQL(PARENT), params)).rows[0].n

      rowsOut.push({
        window: w.id,
        label: w.label,
        matching_rows: nFlat,
        same_result: nFlat === nPart,
        flat: flat,
        part: part,
        speedup_p50: f2(flat.p50 / part.p50),
        speedup_p95: f2(flat.p95 / part.p95),
        flat_count: flatCnt,
        part_count: partCnt,
      })
    }

    log('\n【主查询】timeline: WHERE status=\'published\' AND t_start_year ∈ [a,b) ORDER BY t_start_year LIMIT 200')
    log('窗口       命中行   普通表 p50/p95(ms)   分区表 p50/p95(ms)   p50 加速  p95 加速')
    log('-'.repeat(78))
    for (const r of rowsOut) {
      log(
        `${r.window.padEnd(10)} ${String(r.matching_rows).padStart(6)}   ` +
        `${String(r.flat.p50).padStart(7)} / ${String(r.flat.p95).padStart(7)}   ` +
        `${String(r.part.p50).padStart(7)} / ${String(r.part.p95).padStart(7)}   ` +
        `${String(r.speedup_p50).padStart(6)}x   ${String(r.speedup_p95).padStart(6)}x` +
        (r.same_result ? '' : '   ⚠ 结果不一致!')
      )
    }

    log('\n【对照查询】COUNT(*) 同谓词（无 LIMIT，体现 17 路 Append 的固定开销）')
    log('窗口       普通表 p50/p95(ms)   分区表 p50/p95(ms)   p50 加速')
    log('-'.repeat(78))
    for (const r of rowsOut) {
      log(
        `${r.window.padEnd(10)} ` +
        `${String(r.flat_count.p50).padStart(7)} / ${String(r.flat_count.p95).padStart(7)}   ` +
        `${String(r.part_count.p50).padStart(7)} / ${String(r.part_count.p95).padStart(7)}   ` +
        `${String(f2(r.flat_count.p50 / r.part_count.p50)).padStart(6)}x`
      )
    }

    log('\nJSON ' + JSON.stringify(rowsOut.map((r) => ({
      window: r.window, rows: r.matching_rows,
      flat_p50: r.flat.p50, flat_p95: r.flat.p95,
      part_p50: r.part.p50, part_p95: r.part.p95,
      sp50: r.speedup_p50, sp95: r.speedup_p95,
      flat_count_p50: r.flat_count.p50, part_count_p50: r.part_count.p50,
    }))))

    // ------------------------------------------------------------------
    // 附加场景：这些正是「分区之后会变差」的地方，决策时必须看到
    // ------------------------------------------------------------------
    const midId = (await c.query(`SELECT id FROM ${FLAT} ORDER BY id LIMIT 1 OFFSET 50000`)).rows[0].id
    const midSlug = (await c.query(`SELECT slug FROM ${FLAT} WHERE id = $1`, [midId])).rows[0].slug

    const extras = [
      {
        key: 'pk_point',
        label: `按主键点查 id=${midId}（分区后 PK 不再是全局唯一索引）`,
        sql: (t) => `SELECT slug, title, t_start_year FROM ${t} WHERE id = $1`,
        params: [midId],
      },
      {
        key: 'slug_point',
        label: `按 slug 点查 ${midSlug}（UNIQUE(slug) → UNIQUE(slug,year)）`,
        sql: (t) => `SELECT id, slug, title FROM ${t} WHERE slug = $1`,
        params: [midSlug],
      },
      {
        key: 'bare_count',
        label: '无条件全表 count(*)（17 路 Append 的固定开销）',
        sql: (t) => `SELECT count(*)::int AS n FROM ${t}`,
        params: [],
      },
    ]

    const extraOut = []
    log('\n【附加场景】分区后**注定变差**的访问模式')
    log('场景                                                    普通表 p50   分区表 p50   倍率')
    log('-'.repeat(78))
    for (const e of extras) {
      const flat = await timeIt(c, e.sql(FLAT), e.params, ITERS)
      const part = await timeIt(c, e.sql(PARENT), e.params, ITERS)
      extraOut.push({ key: e.key, flat_p50: flat.p50, part_p50: part.p50, ratio: f2(flat.p50 / part.p50) })
      log(`${e.label.padEnd(52)} ${String(flat.p50).padStart(9)} ${String(part.p50).padStart(11)} ${String(f2(flat.p50 / part.p50)).padStart(8)}x`)
    }
    log('\nJSON ' + JSON.stringify(extraOut))
  } finally {
    await c.end()
  }
}

// ============================================================================
// 阶段 5：explain —— pruning 证据
// ============================================================================
/** 递归收集 EXPLAIN JSON 里出现的 Relation Name（= 真正被扫描的物理对象） */
function collectRelations(node, out = new Set()) {
  if (!node) return out
  if (node['Relation Name']) out.add(node['Relation Name'])
  for (const key of ['Plans']) {
    for (const child of node[key] || []) collectRelations(child, out)
  }
  return out
}

async function explainOne(c, label, sql, params, tblForRegex) {
  const r = await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params)
  const plan = r.rows[0]['QUERY PLAN'][0]
  const rels = [...collectRelations(plan.Plan)].filter((x) => x.startsWith(tblForRegex))
  const parts = [...new Set(rels.map((x) => x.replace(/_event_[a-z0-9_]*idx$/, '')))].sort()
  return {
    label,
    execution_ms: f2(plan['Execution Time']),
    scanned_relations: parts,
    scanned_count: parts.length,
    rows: plan.Plan['Actual Rows'] ?? null,
  }
}

async function stageExplain() {
  hdr('[explain] partition pruning 证据')
  const c = await connectDB()
  try {
    const cases = [
      {
        label: '① 单分区内 10 年 [1460,1470)',
        sql: TIMELINE_SQL(PARENT), params: [1460, 1470], re: 'event_y_',
      },
      {
        label: '② 跨 1500 边界的 10 年 [1495,1505)',
        sql: TIMELINE_SQL(PARENT), params: [1495, 1505], re: 'event_y_',
      },
      {
        label: '③ 跨 1500 边界的 100 年 [1450,1550)',
        sql: TIMELINE_SQL(PARENT), params: [1450, 1550], re: 'event_y_',
      },
      {
        label: '④ 全时段 [-5000,2025) limit 200',
        sql: TIMELINE_SQL(PARENT), params: [-5000, 2025], re: 'event_y_',
      },
      {
        // 反例：谓词落在 t_span（生成列、非分区键），必须扫全部分区
        label: '⑤ 反例：t_span && int4range(1495,1505)（谓词不在分区键上）',
        sql: `SELECT slug, title FROM ${PARENT}
              WHERE status='published' AND t_span && int4range($1,$2)
              ORDER BY t_start_year LIMIT ${LIMIT}`,
        params: [1495, 1505], re: 'event_y_',
      },
      {
        label: '⑥ 对照：同样的 10 年窗口在普通表上',
        sql: TIMELINE_SQL(FLAT), params: [1495, 1505], re: 'event',
      },
    ]

    const out = []
    for (const cs of cases) {
      const res = await explainOne(c, cs.label, cs.sql, cs.params, cs.re)
      out.push(res)
      log(`\n${cs.label}`)
      log(`   执行 ${res.execution_ms} ms  扫描物理对象 ${res.scanned_count} 个`)
      if (res.scanned_relations.length <= 20) {
        log(`   → ${res.scanned_relations.join(', ')}`)
      } else {
        log(`   → ${res.scanned_relations.slice(0, 6).join(', ')} ... 共 ${res.scanned_count} 个`)
      }
    }

    // 把最关键的完整执行计划原文打出来（报告里要贴）
    log('\n---------- EXPLAIN 原文：② 跨边界 10 年 [1495,1505) ----------')
    const raw = await c.query(
      `EXPLAIN (ANALYZE, COSTS ON, BUFFERS, FORMAT TEXT) ${TIMELINE_SQL(PARENT)}`, [1495, 1505]
    )
    for (const line of raw.rows.map((x) => x['QUERY PLAN'])) log('   ' + line)

    log('\n---------- EXPLAIN 原文：⑤ 反例 t_span 无剪枝 ----------')
    const raw2 = await c.query(
      `EXPLAIN (ANALYZE, COSTS OFF, FORMAT TEXT)
         SELECT slug, title FROM ${PARENT}
          WHERE status='published' AND t_span && int4range($1,$2)
          ORDER BY t_start_year LIMIT ${LIMIT}`, [1495, 1505]
    )
    const l2 = raw2.rows.map((x) => x['QUERY PLAN'])
    for (const line of l2.slice(0, 8)) log('   ' + line)
    log(`   ... （共 ${l2.length} 行，Append 下挂了全部 17 个分区）`)

    log('\nJSON ' + JSON.stringify(out.map((r) => ({
      label: r.label, ms: r.execution_ms, scanned: r.scanned_count,
    }))))
  } finally {
    await c.end()
  }
}

// ============================================================================
// 阶段 6：stats —— 分区清单 / 体积
// ============================================================================
async function stageStats() {
  hdr('[stats] 分区数、每分区行数、体积对比')
  const c = await connectDB()
  try {
    const parts = await c.query(`
      SELECT c.relname AS partition,
             c.reltuples::bigint AS approx_rows,
             pg_total_relation_size(c.oid) AS bytes,
             pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
             c.reltuples::bigint = 0 AS is_empty
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'public.event'::regclass
      ORDER BY 1`)

    log('\n分区                                 近似行数      体积')
    log('-'.repeat(78))
    let empty = 0
    let totalRows = 0
    let totalBytes = 0
    for (const r of parts.rows) {
      const ar = Number(r.approx_rows)
      if (ar === 0) empty++
      totalRows += ar
      totalBytes += Number(r.bytes)
      log(`${r.partition.padEnd(36)} ${String(ar).padStart(8)}   ${r.size.padStart(10)}`)
    }

    const exact = await c.query(`SELECT count(*)::int AS n FROM event`)
    const metaIdx = await c.query(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'event'`)
    const childIdx = await c.query(`
      SELECT count(*)::int AS n FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'public.event'::regclass
        AND c.relkind IN ('r','p')`)

    // 分区表总占用 vs 普通表总占用
    // 注意：pg_total_relation_size('分区父表') 恒为 0 —— 声明式分区表本身不存任何元组，
    // 所有数据都在子分区里。必须对父表 + 全部子分区求和，否则会得到"分区表 0 字节"的假结论。
    const sizeOf = async (t) => (await c.query(
      `WITH tree AS (
         SELECT c.oid FROM pg_class c WHERE c.oid = $1::regclass
         UNION ALL
         SELECT i.inhrelid FROM pg_inherits i WHERE i.inhparent = $1::regclass
       )
       SELECT COALESCE(sum(pg_total_relation_size(oid)), 0)::bigint AS b,
              COALESCE(sum(pg_relation_size(oid)), 0)::bigint       AS heap,
              COALESCE(sum(pg_indexes_size(oid)), 0)::bigint        AS idx
       FROM tree`, [t])).rows[0]

    const pSize = await sizeOf('event')
    const fSize = await sizeOf(FLAT)

    log('\n' + '-'.repeat(78))
    log(`  分区数            ${parts.rows.length}`)
    log(`  空分区数          ${empty}  （${f2(100 * empty / parts.rows.length)}%）`)
    log(`  分区行数合计      ${totalRows}  （精确 count(*) = ${exact.rows[0].n}）`)
    log(`  父表列出的索引    ${metaIdx.rows[0].n}`)
    log(`  分区表物理索引数  ${(await c.query(`
        SELECT count(*)::int AS n FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_inherits p ON p.inhrelid = i.indrelid
        WHERE p.inhparent = 'public.event'::regclass`)).rows[0].n}  （= 12 索引 × 17 分区）`)
    log('')
    log(`  分区表 total/heap/index : ${pSize.b} / ${pSize.heap} / ${pSize.idx} bytes`)
    log(`  普通表 total/heap/index : ${fSize.b} / ${fSize.heap} / ${fSize.idx} bytes`)
    log(`  体积比(分区/普通)       : total ${f2(100 * pSize.b / fSize.b)}%  ` +
        `heap ${f2(100 * pSize.heap / fSize.heap)}%  index ${f2(100 * pSize.idx / fSize.idx)}%`)

    log('\nJSON ' + JSON.stringify({
      partitions: parts.rows.length,
      empty_partitions: empty,
      rows_exact: exact.rows[0].n,
      part_bytes: { total: Number(pSize.b), heap: Number(pSize.heap), index: Number(pSize.idx) },
      flat_bytes: { total: Number(fSize.b), heap: Number(fSize.heap), index: Number(fSize.idx) },
    }))
    log('\n分区明细 ' + JSON.stringify(parts.rows.map((r) => [r.partition, Number(r.approx_rows)])))
  } finally {
    await c.end()
  }
}

// ============================================================================
// 阶段 7：migration-check —— 方案 A / B 在克隆库上各跑一遍
// ============================================================================
const CLONE_ROWS = 2000

async function buildClone(admin, name) {
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${name}`)
  const c = await connectDB(name)
  await c.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')
  await c.query(TYPES)
  await c.query(FLAT_TABLE)
  for (let off = 0; off < CLONE_ROWS; off += BATCH) {
    const n = Math.min(BATCH, CLONE_ROWS - off)
    await c.query(insertSql(n), makeEventRows(off, n, CLONE_ROWS).flat())
  }
  await c.query(PROD_INDEXES)
  // 三张子表（方案 A 的复合外键需要它们存在）
  await c.query(`
    CREATE TABLE person (id BIGSERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
    CREATE TABLE event_claim (
      id BIGSERIAL PRIMARY KEY,
      event_id BIGINT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
      statement TEXT NOT NULL);
    CREATE TABLE event_source (
      id BIGSERIAL PRIMARY KEY,
      event_id BIGINT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
      source_slug TEXT NOT NULL);
    CREATE TABLE event_person (
      event_id BIGINT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
      person_id BIGINT NOT NULL,
      PRIMARY KEY (event_id, person_id));
  `)
  await c.query(`INSERT INTO person(slug,name) SELECT 'per-'||g,'p'||g FROM generate_series(1,100) g`)
  await c.query(`INSERT INTO event_claim(event_id,statement) SELECT id,'stmt-'||id FROM event`)
  await c.query(`INSERT INTO event_source(event_id,source_slug) SELECT id,'src-'||(id%100) FROM event`)
  await c.query(`INSERT INTO event_person(event_id,person_id) SELECT id,1+(id%100) FROM event`)
  return c
}

async function stageMigrationCheck() {
  hdr('[migration-check] 002-partition.sql 方案 A / B 可执行性验证（克隆库，不碰 history_atlas）')
  const admin = await adminClient()
  const results = {}
  try {
    for (const plan of ['PLAN_A', 'PLAN_B']) {
      const db = `partition_mig_${plan.slice(-1).toLowerCase()}`
      log(`\n---- ${plan} on ${db} ----`)
      const c = await buildClone(admin, db)
      try {
        // 先记录"老代码"的硬依赖：ON CONFLICT (slug) 在普通表上可用
        const t0 = nowBig()
        await c.query(readPlan(plan))
        results[plan] = { applied_ms: f2(ms(t0)) }

        const q = async (sql, params) => (await c.query(sql, params)).rows
        results[plan].relkind = (await q(`SELECT relkind FROM pg_class WHERE relname='event'`))[0].relkind
        results[plan].partitions = (await q(
          `SELECT count(*)::int n FROM pg_inherits WHERE inhparent='public.event'::regclass`))[0].n
        results[plan].indexes_on_event = (await q(
          `SELECT count(*)::int n FROM pg_indexes WHERE tablename='event'`))[0].n
        results[plan].fk_to_event = (await q(
          `SELECT count(*)::int n FROM pg_constraint WHERE confrelid='public.event'::regclass`))[0].n
        results[plan].rows_part = (await q(`SELECT count(*)::int n FROM event`))[0].n
        results[plan].rows_flat = (await q(`SELECT count(*)::int n FROM event_legacy`))[0].n

        // 序列接管：新插入的 id 必须大于历史 max(id)
        const maxOld = (await q(`SELECT max(id)::int m FROM event`))[0].m
        const newId = (await q(
          `INSERT INTO event(slug,title,track,category,t_start_year)
           VALUES ('probe-x','p','cn','politics',1500) RETURNING id`))[0].id
        results[plan].seq_ok = Number(newId) > Number(maxOld)
        results[plan].new_id = newId

        // 破坏性检查：ON CONFLICT (slug) 是否还成立
        try {
          await c.query(`INSERT INTO event(slug,title,track,category,t_start_year)
                         VALUES ('probe-x','dup','cn','politics',1500)
                         ON CONFLICT (slug) DO NOTHING`)
          results[plan].on_conflict_slug = 'OK'
        } catch (e) {
          results[plan].on_conflict_slug = 'FAIL ' + e.code
        }

        if (plan === 'PLAN_A') {
          // 复合外键语义
          const row = (await q(`SELECT c.id, c.event_id, c.event_year
                                  FROM event_claim c JOIN event e ON e.id=c.event_id
                                 WHERE e.t_end_year IS NULL ORDER BY c.id LIMIT 1`))[0]
          if (row) {
            await c.query(`UPDATE event SET t_start_year=$1 WHERE id=$2`,
              [Number(row.event_year) + 700, row.event_id])
            const after = (await q(`SELECT event_year FROM event_claim WHERE id=$1`, [row.id]))[0].event_year
            results[plan].on_update_cascade =
              Number(after) === Number(row.event_year) + 700 ? 'PASS' : `FAIL (${row.event_year}->${after})`
          }
          try {
            await c.query(`INSERT INTO event_claim(event_id,event_year,statement)
                           VALUES (999999,4242,'orphan')`)
            results[plan].orphan_insert = 'ACCEPTED (BAD)'
          } catch (e) {
            results[plan].orphan_insert = 'REJECTED ' + e.code
          }
        }
      } finally {
        await c.end()
      }
      log('   ' + JSON.stringify(results[plan]))
    }
  } finally {
    // 清理克隆库
    for (const db of ['partition_mig_a', 'partition_mig_b']) {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {})
    }
    await admin.end()
  }
  log('\nJSON ' + JSON.stringify(results))
}

// ============================================================================
// 阶段 8：teardown
// ============================================================================
async function stageTeardown() {
  hdr(`[teardown] DROP DATABASE ${DB}`)
  const admin = await adminClient()
  try {
    const sz = await admin.query(`SELECT pg_size_pretty(pg_database_size($1)) AS s`, [DB]).catch(() => null)
    if (sz) log(`   库体积 ${sz.rows[0].s}`)
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
    const left = await admin.query(
      `SELECT datname FROM pg_database WHERE datname LIKE 'partition_%' ORDER BY 1`)
    log(`   ${DB} 已删除`)
    log(`   残留的 partition_* 库：${left.rows.map((r) => r.datname).join(', ') || '（无）'}`)
  } finally {
    await admin.end()
  }
}

// ============================================================================
// main
// ============================================================================
const ALL = ['setup', 'load', 'migrate', 'bench', 'explain', 'stats', 'migration-check', 'teardown']
const FN = {
  setup: stageSetup,
  load: stageLoad,
  migrate: stageMigrate,
  bench: stageBench,
  explain: stageExplain,
  stats: stageStats,
  'migration-check': stageMigrationCheck,
  teardown: stageTeardown,
}

const argRaw = process.argv.find((a) => a.startsWith('--stage='))
const wanted = argRaw
  ? argRaw.slice('--stage='.length).split(',').map((s) => s.trim()).filter(Boolean)
  : ['all']

const list = wanted.includes('all') ? ALL : wanted
for (const s of list) {
  if (!FN[s]) {
    console.error(`未知阶段 "${s}"，可选：${ALL.join(', ')} 或 all`)
    process.exit(1)
  }
}

const t0 = nowBig()
try {
  for (const s of list) {
    await FN[s]()
  }
  log(`\n完成，总耗时 ${(ms(t0) / 1000).toFixed(1)} s（阶段：${list.join(', ')}）`)
} catch (e) {
  console.error(`\n[FAILED] ${e.code || ''} ${e.message}${e.detail ? '\n  detail: ' + e.detail : ''}`)
  if (e.hint) console.error('  hint: ' + e.hint)
  process.exit(1)
}
