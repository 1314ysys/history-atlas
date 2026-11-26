#!/usr/bin/env node
/**
 * bench/shard-compare.js —— 单库 30 万 vs 3 分片（各 10 万）的查询对比
 *
 * 为什么要有「单库 30 万」这个对照：
 *   主库 history_atlas 只有 728 行，拿它跟 30 万的分片比毫无意义——差异全来自数据量，
 *   而不是分片。所以本脚本在 5433 上另建 history_atlas_single30w，灌**完全相同**的
 *   30 万行（同一份 gen.js 数据、同样的区间过滤规则），只让「物理拓扑」不同：
 *     A 单库：5433 / history_atlas_single30w，300000 行，单实例
 *     B 分片：5441 + 5442 + 5443，各 100000 行，走 src/db/shard.js 真实扇出
 *
 * 查询直接复刻 src/api/timeline.js 的 SQL（同一套谓词、同一套合并排序、同样 limit 200），
 * 所以测出来的差值就是「分片本身」带来的，而不是换个查询写法换来的。
 *
 * 额外测两组东西（都是分片特有的坑）：
 *   1) 分页并列项（tie）：timeline.js 的 ORDER BY 以 `id` 收尾，而分片后 id 是**片内自增**，
 *      跨片不唯一 → 同一时间窗在两套拓扑下可能返回不同的 201 行。这里用 `slug`（全局唯一）
 *      收尾做对照，量化「换全局唯一键收尾」是否能把行集拉平。
 *   2) 计数（withTotal=1）的 planner 归因：分片后每片只有 10 万行，planner 更爱选 parallel plan，
 *      而在本机（小表 + 资源紧张）上 parallel 反而更慢。这里分别测「planner 自由」与
 *      「强制串行计划」两种口径。
 *
 * 用法：
 *   node bench/shard-compare.js                 # 建单库 + 灌数 + 对比 + 删单库
 *   node bench/shard-compare.js --iters=20      # 迭代次数（默认 20）
 *   node bench/shard-compare.js --no-seed       # 复用已存在的单库（跳过灌数）
 *   node bench/shard-compare.js --keep-single   # 跑完不 DROP 单库（调试用）
 *   node bench/shard-compare.js --explain       # 额外打印 COUNT 查询的执行计划
 *
 * 跑完默认 DROP history_atlas_single30w，**保留** 3 个分片实例（后续 bench 还要用）。
 */
import {
  SHARDS, DB_NAME, ROWS_PER_SHARD,
  shardRowBatches, insertRows, connect, ensureDatabase, applySchema, dropDatabase,
  shardUrls, shardRanges, waitPort,
} from '../scripts/shard-proto.js'

const PRIMARY_PORT = 5433
const SINGLE_DB = 'history_atlas_single30w'
const TOTAL_ROWS = ROWS_PER_SHARD * SHARDS.length

const args = process.argv.slice(2)
const argOf = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`))
  return hit ? Number(hit.split('=')[1]) : d
}
const ITERS = argOf('iters', 20)
const WARMUP = argOf('warmup', 3)
const NO_SEED = args.includes('--no-seed')
const KEEP_SINGLE = args.includes('--keep-single')
const EXPLAIN = args.includes('--explain')

const ts = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(`[${ts()}]`, ...a)

// 分片配置必须在 import src/db/shard.js 之前写进 env（该模块在顶层读 env）
process.env.SHARD_URLS = shardUrls()
process.env.SHARD_RANGES = shardRanges()
const { shardingEnabled, shardsForRange, queryShards, closeShards } = await import('../src/db/shard.js')

// ---------------------------------------------------------------- SQL（复刻 timeline.js）

const LITE = `slug, title, t_start_year, t_end_year,
  t_start_month, t_start_day, t_precision, t_certainty,
  track, category, discipline, lat, lon`
const LIMIT = 200

/** 与 timeline.js 完全相同的谓词：$1=from $2=to $3=track $4=limit $5=span $6=offset */
const pred = (spanIdx) => `status = 'published'
      AND t_start_year >= $1::int - $${spanIdx}::int
      AND t_start_year < $2::int
      AND COALESCE(t_end_year, t_start_year) >= $1::int
      AND ($3::text IS NULL OR track = $3)`
const COUNT_SQL = `SELECT count(*)::int AS n FROM event WHERE ${pred(4)}`

/** 线上代码（timeline.js）当前用的排序：以片内 id 收尾 */
const PAGE_SQL_ID = `SELECT ${LITE} FROM event WHERE ${pred(5)}
  ORDER BY t_start_year, t_start_month NULLS FIRST, t_start_day NULLS FIRST, id
  LIMIT $4 OFFSET $6`
/** 分片安全版：以全局唯一键 slug 收尾（ev-<i> 全局唯一，两侧完全一致） */
const PAGE_SQL_SLUG = `SELECT ${LITE} FROM event WHERE ${pred(5)}
  ORDER BY t_start_year, t_start_month NULLS FIRST, t_start_day NULLS FIRST, slug
  LIMIT $4 OFFSET $6`

const cmpKey = (a, b) =>
  (a.t_start_year - b.t_start_year) ||
  ((a.t_start_month ?? 0) - (b.t_start_month ?? 0)) ||
  ((a.t_start_day ?? 0) - (b.t_start_day ?? 0))

/** 线上 timeline.js 的合并口径：只按年/月/日排，并列项保持到达顺序（跨片不稳定） */
const sortMerge = (rows) => rows.sort(cmpKey)
/** 分片安全口径：并列项再按全局唯一键 slug 排，跨片可复现 */
const sortMergeSlug = (rows) => rows.sort((a, b) =>
  cmpKey(a, b) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))

const sumN = (rows) => [{ n: rows.reduce((s, r) => s + (Number(r.n) || 0), 0) }]

// ---------------------------------------------------------------- 查询清单

const QUERIES = [
  { id: '10y', from: 1495, to: 1505, withTotal: false, label: '10 年窗口 [1495,1505)' },
  { id: '100y', from: 1450, to: 1550, withTotal: false, label: '100 年窗口 [1450,1550)' },
  { id: '500y', from: 1000, to: 1500, withTotal: false, label: '500 年窗口 [1000,1500)' },
  { id: '500y-x', from: 1200, to: 1700, withTotal: false, label: '500 年跨片 [1200,1700)' },
  { id: '10y-1s', from: 600, to: 610, withTotal: false, label: '10 年单片 [600,610)' },
  { id: 'full', from: -5000, to: 3000, withTotal: false, label: '全时段 [-5000,3000) limit200' },
  { id: 'full+total', from: -5000, to: 3000, withTotal: true, label: '全时段 + withTotal=1' },
]

// ---------------------------------------------------------------- 建单库对照

async function seedSingle() {
  log(`准备单库对照：${PRIMARY_PORT}/${SINGLE_DB}`)
  // 本机可能同时有别的会话在动 5433，灌数遇到 57P01（管理员命令断开）就重来一次
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await seedSingleOnce()
    } catch (e) {
      const code = e?.code || ''
      log(`单库灌数第 ${attempt} 次失败（${code || e.message}），重试…`)
      if (attempt === 3) throw e
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  return 0
}

async function seedSingleOnce() {
  await dropDatabase(PRIMARY_PORT, SINGLE_DB)
  await ensureDatabase(PRIMARY_PORT, SINGLE_DB)
  await applySchema(PRIMARY_PORT, SINGLE_DB)
  const c = await connect(PRIMARY_PORT, SINGLE_DB)
  try {
    await c.query('SET synchronous_commit = off')
    await c.query('TRUNCATE event RESTART IDENTITY CASCADE')
    const t0 = Date.now()
    let n = 0
    // 逐片生成、依次插入：与 3 分片**完全相同**的 30 万行，只是都落在同一个实例里
    for (const s of SHARDS) {
      for (const batch of shardRowBatches(s.idx)) {
        await insertRows(c, batch)
        n += batch.length
      }
      log(`  已灌 ${n}/${TOTAL_ROWS} 行（区间 [${s.from},${s.to})）`)
    }
    await c.query('ANALYZE event')
    log(`单库灌数完成：${n} 行，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    return n
  } finally {
    await c.end()
  }
}

// ---------------------------------------------------------------- 单侧查询

async function runSingle(client, q, span, sql = PAGE_SQL_ID) {
  const t0 = performance.now()
  const page = await client.query(sql, [q.from, q.to, null, LIMIT + 1, span, 0])
  let total = null
  if (q.withTotal) {
    const c = await client.query(COUNT_SQL, [q.from, q.to, null, span])
    total = c.rows[0].n
  }
  const ms = performance.now() - t0
  const rows = page.rows.slice(0, LIMIT + 1)
  return { ms, slugs: rows.map((r) => r.slug), total, fanout: 1, perShardMs: [], countMs: null, degraded: 0 }
}

async function runSharded(q, span, sql = PAGE_SQL_ID, merge = sortMerge) {
  const targets = shardsForRange(q.from, q.to)
  const t0 = performance.now()
  const fan = await queryShards(targets, sql, [q.from, q.to, null, LIMIT + 1, span, 0], { merge })
  const rows = fan.rows.slice(0, LIMIT + 1)
  let total = null
  let countMs = null
  if (q.withTotal) {
    const t1 = performance.now()
    const c = await queryShards(targets, COUNT_SQL, [q.from, q.to, null, span], { merge: sumN })
    total = c.rows[0]?.n ?? null
    countMs = +(performance.now() - t1).toFixed(2)
  }
  const ms = performance.now() - t0
  return {
    ms,
    slugs: rows.map((r) => r.slug),
    total,
    fanout: targets.length,
    perShardMs: fan.perShard.map((p) => p.ms),
    countMs,
    degraded: fan.degraded.length,
  }
}

// ---------------------------------------------------------------- 统计

function pct(lat, p) {
  if (!lat.length) return 0
  const i = Math.min(lat.length - 1, Math.floor(p * lat.length))
  return +lat[i].toFixed(2)
}
const median = (a) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return +s[Math.floor(s.length / 2)].toFixed(2)
}

async function benchSide(name, runner) {
  const out = []
  for (const q of QUERIES) {
    for (let i = 0; i < WARMUP; i++) await runner(q)
    const lat = []
    let last = null
    for (let i = 0; i < ITERS; i++) {
      const r = await runner(q)
      lat.push(r.ms)
      last = r
    }
    lat.sort((a, b) => a - b)
    const rec = {
      id: q.id,
      label: q.label,
      p50: pct(lat, 0.5),
      p95: pct(lat, 0.95),
      rows: last.slugs.length,
      total: last.total,
      slugs: last.slugs,
      fanout: last.fanout,
      perShardMs: last.perShardMs,
      medianPerShardMs: median(last.perShardMs),
      countMs: last.countMs,
      degraded: last.degraded,
    }
    out.push(rec)
    log(`  ${name} ${q.id}: p50=${rec.p50}ms p95=${rec.p95}ms rows=${rec.rows} fanout=${rec.fanout}`)
  }
  return out
}

// ---------------------------------------------------------------- 计数归因（强制串行计划）

const serialPool = new Map()
async function serialClient(port, db) {
  const key = `${port}/${db}`
  if (!serialPool.has(key)) {
    const c = await connect(port, db)
    await c.query('SET max_parallel_workers_per_gather = 0')
    serialPool.set(key, c)
  }
  return serialPool.get(key)
}

async function countSerial(side, span) {
  const t0 = performance.now()
  if (side === 'single') {
    const c = await serialClient(PRIMARY_PORT, SINGLE_DB)
    const r = await c.query(COUNT_SQL, [-5000, 3000, null, span])
    return { ms: performance.now() - t0, n: r.rows[0].n, fanout: 1 }
  }
  const targets = shardsForRange(-5000, 3000)
  const rs = await Promise.all(targets.map(async (t) => {
    // targets 是 shard.js 的分片对象（带 url），端口要从本文件的拓扑里取
    const port = SHARDS.find((s) => s.idx === t.idx).port
    const c = await serialClient(port, DB_NAME)
    const r = await c.query(COUNT_SQL, [-5000, 3000, null, span])
    return Number(r.rows[0].n)
  }))
  return { ms: performance.now() - t0, n: rs.reduce((a, b) => a + b, 0), fanout: targets.length }
}

async function benchCount(side, span) {
  for (let i = 0; i < WARMUP; i++) await countSerial(side, span)
  const lat = []
  let last = null
  for (let i = 0; i < ITERS; i++) {
    const r = await countSerial(side, span)
    lat.push(r.ms)
    last = r
  }
  lat.sort((a, b) => a - b)
  return { p50: pct(lat, 0.5), p95: pct(lat, 0.95), n: last.n, fanout: last.fanout }
}

// ---------------------------------------------------------------- 主流程

const t0 = Date.now()
log(`分片拓扑: ${SHARDS.map((s) => `#${s.idx}:${s.port}[${s.from},${s.to})`).join(' ')}`)
if (!shardingEnabled()) {
  console.error('shardingEnabled() 为 false —— SHARD_URLS/SHARD_RANGES 未生效')
  process.exit(1)
}
for (const s of SHARDS) {
  if (!(await waitPort(s.port, 3000))) {
    console.error(`shard${s.idx} 端口 ${s.port} 未监听：先跑 node scripts/shard-proto.js init && ... seed`)
    process.exit(1)
  }
}
const counts = []
for (const s of SHARDS) {
  const c = await connect(s.port)
  const r = await c.query('SELECT count(*)::int AS n FROM event')
  counts.push(r.rows[0].n)
  await c.end()
}
log(`分片行数: ${counts.join(' / ')}`)
if (counts.some((n) => n !== ROWS_PER_SHARD)) {
  console.error(`分片行数不是各 ${ROWS_PER_SHARD}，先跑 node scripts/shard-proto.js seed`)
  process.exit(1)
}

let singleClient = null
let ok = false
try {
  if (!NO_SEED) {
    const n = await seedSingle()
    if (n !== TOTAL_ROWS) throw new Error(`单库行数 ${n} ≠ ${TOTAL_ROWS}`)
  } else {
    log(`--no-seed：复用已有 ${SINGLE_DB}`)
  }

  singleClient = await connect(PRIMARY_PORT, SINGLE_DB)
  const sc = await singleClient.query('SELECT count(*)::int AS n FROM event')
  if (sc.rows[0].n !== TOTAL_ROWS) throw new Error(`${SINGLE_DB} 行数 ${sc.rows[0].n} ≠ ${TOTAL_ROWS}`)
  const meta = await singleClient.query(
    'SELECT count(DISTINCT slug)::int AS d, min(t_start_year)::int lo, max(t_start_year)::int hi FROM event')
  log(`单库: ${sc.rows[0].n} 行，distinct=${meta.rows[0].d}，年份 [${meta.rows[0].lo},${meta.rows[0].hi}]`)

  const spanRow = await singleClient.query(
    `SELECT COALESCE(max(GREATEST(COALESCE(t_end_year, t_start_year) - t_start_year, 0)), 0)::int AS m
       FROM event WHERE status = 'published'`)
  const span = spanRow.rows[0].m
  log(`maxSpan=${span}（timeline.js 的下界保护带参数）`)

  log(`预热 ${WARMUP} 次 + 每查询 ${ITERS} 次迭代`)
  const A = await benchSide('单库', (q) => runSingle(singleClient, q, span))
  const B = await benchSide('分片', (q) => runSharded(q, span))

  // ---------------- 对比表（线上 SQL 口径：ORDER BY ... , id）
  console.log('\n=== A/B 对比：单库 30 万（5433） vs 3 分片（5441/5442/5443，各 10 万） ===')
  console.log('查询'.padEnd(30) + '扇出'.padEnd(6) + '单库p50'.padEnd(10) + '单库p95'.padEnd(10) +
    '分片p50'.padEnd(10) + '分片p95'.padEnd(10) + '分片/单库'.padEnd(11) +
    '行数(单/片)'.padEnd(14) + 'total(单/片)'.padEnd(18) + '行集一致')
  const verdicts = []
  for (let i = 0; i < QUERIES.length; i++) {
    const a = A[i]
    const b = B[i]
    const sameRows = a.slugs.length === b.slugs.length && a.slugs.every((s, k) => s === b.slugs[k])
    const sameTotal = (a.total ?? null) === (b.total ?? null)
    const ratio = a.p50 > 0 ? +(b.p50 / a.p50).toFixed(2) : null
    verdicts.push({ id: a.id, label: a.label, fanout: b.fanout, a, b, sameRows, sameTotal, ratio })
    console.log(
      a.label.padEnd(30) + String(b.fanout).padEnd(6) +
      String(a.p50).padEnd(10) + String(a.p95).padEnd(10) +
      String(b.p50).padEnd(10) + String(b.p95).padEnd(10) +
      String(ratio ?? '-').padEnd(11) +
      `${a.rows}/${b.rows}`.padEnd(14) +
      `${a.total ?? '-'}/${b.total ?? '-'}`.padEnd(18) +
      (sameRows && sameTotal ? 'YES' : 'NO'),
    )
  }

  // ---------------- 扇出成本
  console.log('\n=== 扇出成本（分片侧） ===')
  console.log('查询'.padEnd(30) + '扇出'.padEnd(6) + '单片中位ms'.padEnd(12) + '扇出总p50'.padEnd(12) +
    '扇出/单片'.padEnd(12) + '备注')
  for (const v of verdicts) {
    const b = v.b
    const fanCost = b.medianPerShardMs > 0 ? +(b.p50 / b.medianPerShardMs).toFixed(2) : null
    console.log(
      v.label.padEnd(30) + String(v.fanout).padEnd(6) +
      String(b.medianPerShardMs).padEnd(12) + String(b.p50).padEnd(12) +
      String(fanCost ?? '-').padEnd(12) +
      (v.fanout > 1 ? `并行 ${v.fanout} 片，各自返回 ${LIMIT + 1} 行再归并` : '单片命中（不扇出）'),
    )
  }

  // ---------------- 分页并列项 + 边界宽事件
  console.log('\n=== 分页稳定性：并列项 tie + 边界宽事件 ===')
  console.log('查询'.padEnd(30) + 'id收尾差异'.padEnd(12) + 'slug收尾差异'.padEnd(14) +
    '单库count'.padEnd(11) + '分片count'.padEnd(11) + '漏行'.padEnd(7) + '结论')
  const tieRows = []
  for (const q of QUERIES.filter((x) => !x.withTotal)) {
    const sId = await runSingle(singleClient, q, span, PAGE_SQL_ID)
    const bId = await runSharded(q, span, PAGE_SQL_ID)
    const sSl = await runSingle(singleClient, q, span, PAGE_SQL_SLUG)
    const bSl = await runSharded(q, span, PAGE_SQL_SLUG, sortMergeSlug)
    const diffId = sId.slugs.filter((x, i) => x !== bId.slugs[i]).length
    const diffSl = sSl.slugs.filter((x, i) => x !== bSl.slugs[i]).length
    // count 口径能直接量化「漏行」：谓词一致，唯一差别是路由有没有覆盖到边界宽事件
    const sCnt = (await singleClient.query(COUNT_SQL, [q.from, q.to, null, span])).rows[0].n
    const bCnt = (await queryShards(shardsForRange(q.from, q.to), COUNT_SQL,
      [q.from, q.to, null, span], { merge: sumN })).rows[0].n
    const lost = sCnt - bCnt
    tieRows.push({ label: q.label, diffId, diffSl, singleCount: sCnt, shardCount: bCnt, lost })
    console.log(
      q.label.padEnd(30) + String(diffId).padEnd(12) + String(diffSl).padEnd(14) +
      String(sCnt).padEnd(11) + String(bCnt).padEnd(11) + String(lost).padEnd(7) +
      (lost !== 0 ? '边界宽事件漏行（路由需按 maxSpan 扩边）'
        : diffId === 0 && diffSl === 0 ? '一致'
          : diffSl === 0 ? '换全局唯一键收尾即修复' : '仍有差异'),
    )
  }

  // ---------------- 计数归因
  const cSingleSerial = await benchCount('single', span)
  const cShardSerial = await benchCount('sharded', span)
  const fullVerdict = verdicts.find((v) => v.id === 'full+total')
  console.log('\n=== withTotal=1（全时段计数）planner 归因 ===')
  console.log('口径'.padEnd(26) + '单库p50'.padEnd(11) + '单库p95'.padEnd(11) +
    '分片p50'.padEnd(11) + '分片p95'.padEnd(11) + '分片/单库'.padEnd(11) + 'total(单/片)')
  console.log(
    'planner 自由（默认）'.padEnd(26) +
    String(fullVerdict.a.p50).padEnd(11) + String(fullVerdict.a.p95).padEnd(11) +
    String(fullVerdict.b.p50).padEnd(11) + String(fullVerdict.b.p95).padEnd(11) +
    String(fullVerdict.ratio).padEnd(11) +
    `${fullVerdict.a.total}/${fullVerdict.b.total}`,
  )
  console.log(
    '强制串行计划'.padEnd(26) +
    String(cSingleSerial.p50).padEnd(11) + String(cSingleSerial.p95).padEnd(11) +
    String(cShardSerial.p50).padEnd(11) + String(cShardSerial.p95).padEnd(11) +
    String(+(cShardSerial.p50 / cSingleSerial.p50).toFixed(2)).padEnd(11) +
    `${cSingleSerial.n}/${cShardSerial.n}`,
  )

  if (EXPLAIN) {
    console.log('\n=== COUNT 查询执行计划（全时段谓词） ===')
    for (const [label, port, db] of [
      ['单库 30 万', PRIMARY_PORT, SINGLE_DB],
      ['shard1 10 万', SHARDS[1].port, DB_NAME],
    ]) {
      const c = await connect(port, db)
      const ex = await c.query(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) ${COUNT_SQL}`, [-5000, 3000, null, span])
      console.log(`--- ${label}（${port}/${db}）---`)
      console.log(ex.rows.map((r) => '  ' + r['QUERY PLAN']).join('\n'))
      await c.end()
    }
  }

  // ---------------- 正确性
  const bad = verdicts.filter((v) => !v.sameRows || !v.sameTotal)
  console.log('\n=== 正确性（单库结果 vs 分片合并结果） ===')
  for (const v of verdicts) {
    console.log(`${v.sameRows && v.sameTotal ? 'PASS' : 'FAIL'}  ${v.label.padEnd(30)} ` +
      `rows ${v.a.rows}/${v.b.rows} total ${v.a.total ?? '-'}/${v.b.total ?? '-'} 首行=${v.b.slugs[0] ?? '-'}`)
  }
  if (bad.length) console.log(`\n⚠ ${bad.length} 个查询行集不一致（原因见上面的 tie 稳定性表）`)

  // ---------------- 机器可读汇总
  const summary = {
    topology: {
      single: { port: PRIMARY_PORT, db: SINGLE_DB, rows: TOTAL_ROWS },
      shards: SHARDS.map((s) => ({ idx: s.idx, port: s.port, range: [s.from, s.to], rows: ROWS_PER_SHARD })),
    },
    iters: ITERS,
    warmup: WARMUP,
    span,
    results: verdicts.map((v) => ({
      id: v.id,
      label: v.label,
      fanout: v.fanout,
      single: { p50: v.a.p50, p95: v.a.p95, rows: v.a.rows, total: v.a.total },
      sharded: {
        p50: v.b.p50, p95: v.b.p95, rows: v.b.rows, total: v.b.total,
        perShardMs: v.b.perShardMs, medianPerShardMs: v.b.medianPerShardMs,
        countMs: v.b.countMs, degraded: v.b.degraded,
      },
      ratioP50: v.ratio,
      identical: v.sameRows && v.sameTotal,
    })),
    ties: tieRows,
    countSerial: { single: cSingleSerial, sharded: cShardSerial },
    totalElapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
  }
  console.log('\nJSON:' + JSON.stringify(summary))
  ok = bad.length === 0
} catch (e) {
  console.error('ERROR:', e?.message || e)
  if (e?.stack) console.error(e.stack.split('\n').slice(0, 8).join('\n'))
  process.exitCode = 1
} finally {
  for (const c of serialPool.values()) { try { await c.end() } catch { /* ignore */ } }
  try { if (singleClient) await singleClient.end() } catch { /* ignore */ }
  try { await closeShards() } catch { /* ignore */ }
  if (!KEEP_SINGLE) {
    try {
      await dropDatabase(PRIMARY_PORT, SINGLE_DB)
      log(`已 DROP ${SINGLE_DB}（3 个分片实例保留：5441/5442/5443）`)
    } catch (e) {
      log(`DROP ${SINGLE_DB} 失败: ${e.message}`)
    }
  }
}
process.exitCode = ok ? (process.exitCode ?? 0) : 1
