#!/usr/bin/env node
/**
 * scripts/bulk-import.js —— event 表大批量导入（关索引 → 批量写 → 临时表回填 tsvector → 重建索引）
 *
 * 用法：
 *   node scripts/bulk-import.js --n=200000 --db=history_atlas_bulk_test
 *   node scripts/bulk-import.js --n=200000 --db=x_bulk_test --batch=5000 --mode=auto
 *   node scripts/bulk-import.js --n=200000 --db=x_bulk_test --keep-indexes   # 对照组：不关索引
 *
 * 与生产写入路径（src/ingest/router.js / src/seed/index.js 每批 250 行 INSERT + 逐批 UPDATE
 * 回填 search_tsv，索引全程在线）的差别只有四步：
 *
 *   1) 建库：DROP/CREATE <db> → 应用 src/db/schema.sql（表结构/索引与生产完全一致）
 *   2) 关索引：删掉 event 上所有**非唯一**索引（保留 pkey 与 slug unique），
 *      让每行插入不再维护 GIN/GIST/BTREE 索引
 *   3) 批量写：优先 COPY；但 node-postgres **没有** COPY FROM STDIN 流式实现
 *      （需要 pg-copy-streams，本项目禁装依赖），探测必然失败 →
 *      降级为「多行 INSERT ... VALUES (...),(...) 每批 5000 行」（生产是 250 行/批，这里大 20 倍）
 *   4) 回填 search_tsv：先把 toTsv(tokenize(...)) 灌进 **UNLOGGED 临时表**，
 *      再一条 `UPDATE event e SET search_tsv = to_tsvector('simple', t.tsv) FROM tmp_tsv t` 全表回填；
 *      最后一次性重建全部索引，逐条计时
 *
 * 安全阀：库名必须以 `_bulk_test` 结尾，且拒绝 history_atlas —— 本脚本会 DROP DATABASE。
 *
 * 本文件同时被 bench/import-compare.js 复用（导出 runBulkImport / insertRows / backfillTsv / buildIndexes）。
 */
import pg from 'pg'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { makeEventRows, EVENT_COLS } from '../bench/gen.js'
import { tokenize, toTsv } from '../src/domain/tokenize.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')
export const SCHEMA_FILE = path.join(ROOT, 'src', 'db', 'schema.sql')

/* ---------- 连接参数（原生 PG 19，trust 认证） ---------- */
export const PG_HOST = process.env.PGHOST || '127.0.0.1'
export const PG_PORT = Number(process.env.PGPORT || 5433)
export const PG_USER = process.env.PGUSER || 'postgres'
export const ADMIN_DB = process.env.PG_ADMIN_DB || 'postgres'

/** @param {string} db */
export function connString(db) {
  return `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${db}`
}

/** 毫秒计时（单调时钟，不受系统时间调整影响） */
export const now = () => Number(process.hrtime.bigint() / 1000000n)

/** 千分位 */
export const fmtInt = (v) => Number(v).toLocaleString('en-US')

/* ---------- 安全阀 ---------- */

/**
 * 只允许在一次性试验库上跑：名字必须以 `_bulk_test` 结尾，且不得是生产库。
 * @param {string} name
 */
export function assertTestDb(name) {
  if (typeof name !== 'string' || !/^[a-z0-9_]+$/i.test(name)) {
    throw new Error(`库名非法（只允许字母/数字/下划线）：${JSON.stringify(name)}`)
  }
  if (name === 'history_atlas') {
    throw new Error('拒绝在 history_atlas（生产库，728 事件）上运行：本脚本会 DROP DATABASE。')
  }
  if (!/_bulk_test$/.test(name)) {
    throw new Error(`库名必须以 _bulk_test 结尾（环境约束），收到 "${name}"`)
  }
}

/* ---------- 建库 / 建表 ---------- */

/**
 * DROP DATABASE IF EXISTS → CREATE DATABASE（保证从空库开始计时）。
 * @param {string} dbName
 */
export async function createFreshDatabase(dbName) {
  assertTestDb(dbName)
  const admin = new pg.Client({ connectionString: connString(ADMIN_DB) })
  await admin.connect()
  try {
    await admin.query('SET client_min_messages = warning')
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    await admin.query(`CREATE DATABASE "${dbName}" TEMPLATE template0 ENCODING 'UTF8'`)
  } finally {
    await admin.end().catch(() => {})
  }
}

/** @param {string} dbName */
export async function dropDatabase(dbName) {
  assertTestDb(dbName)
  const admin = new pg.Client({ connectionString: connString(ADMIN_DB) })
  await admin.connect()
  try {
    await admin.query('SET client_min_messages = warning')
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
  } finally {
    await admin.end().catch(() => {})
  }
}

/**
 * 应用生产 schema（多语句一次性下发；pg 走简单查询协议，允许分号分隔的多条语句）。
 * @param {pg.Client} client
 */
export async function applySchema(client) {
  const sql = await readFile(SCHEMA_FILE, 'utf8')
  await client.query(sql)
}

/** @param {string} db */
export async function connect(db) {
  const client = new pg.Client({ connectionString: connString(db) })
  await client.connect()
  await client.query('SET client_min_messages = warning')
  await client.query('SET standard_conforming_strings = on')
  return client
}

/* ---------- 索引清单（与 schema.sql + 001-search.sql 对齐） ---------- */

/**
 * event 上的**非唯一**索引。关索引时全删，重建时按此清单全部建回。
 * schema.sql 定义 6 个；trgm 3 个来自 src/db/migrations/001-search.sql（生产库实际存在）。
 */
export const EVENT_INDEXES = [
  {
    name: 'event_year_idx',
    kind: 'btree',
    ddl: `CREATE INDEX event_year_idx ON event (t_start_year)`,
  },
  {
    name: 'event_track_idx',
    kind: 'btree',
    ddl: `CREATE INDEX event_track_idx ON event (track, t_start_year)`,
  },
  {
    name: 'event_status_idx',
    kind: 'btree',
    ddl: `CREATE INDEX event_status_idx ON event (status)`,
  },
  {
    name: 'event_place_idx',
    kind: 'btree',
    ddl: `CREATE INDEX event_place_idx ON event (place_slug)`,
  },
  {
    name: 'event_fts_idx',
    kind: 'gin(tsvector)',
    ddl: `CREATE INDEX event_fts_idx ON event USING GIN (search_tsv)`,
  },
  {
    name: 'event_timeline_cover_idx',
    kind: 'btree-cover',
    ddl: `CREATE INDEX event_timeline_cover_idx
            ON event (t_start_year)
            INCLUDE (slug, title, t_start_month, t_start_day, t_end_year,
                     t_precision, t_certainty, track, category, discipline, lat, lon)
            WHERE status = 'published'`,
  },
  {
    name: 'event_span_idx',
    kind: 'gist(range)',
    ddl: `CREATE INDEX event_span_idx ON event USING GIST (t_span)`,
  },
  {
    name: 'event_title_trgm_idx',
    kind: 'gin(trgm)',
    ddl: `CREATE INDEX event_title_trgm_idx ON event USING GIN (title gin_trgm_ops)`,
    needsExtension: 'pg_trgm',
  },
  {
    name: 'event_summary_trgm_idx',
    kind: 'gin(trgm)',
    ddl: `CREATE INDEX event_summary_trgm_idx ON event USING GIN (summary gin_trgm_ops)`,
    needsExtension: 'pg_trgm',
  },
  {
    name: 'event_search_text_trgm_idx',
    kind: 'gin(trgm)',
    ddl: `CREATE INDEX event_search_text_trgm_idx ON event USING GIN (search_text gin_trgm_ops)`,
    needsExtension: 'pg_trgm',
  },
]

/**
 * 需要 pg_trgm 的那 3 个索引（来自 src/db/migrations/001-search.sql）。
 * schema.sql 本身只定义 7 个 event 索引，但**生产库实际有 10 个**；
 * 为了让"关索引→重建"与生产同构，建表后先把这 3 个也补上，再一起关掉。
 */
export const TRGM_INDEXES = EVENT_INDEXES.filter((ix) => ix.needsExtension === 'pg_trgm')

/**
 * 补齐到生产索引集（10 个）。空表上建索引只需几 ms，计入"建库+建表"。
 * @param {pg.Client} client
 */
export async function ensureProductionIndexSet(client) {
  await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')
  for (const ix of TRGM_INDEXES) {
    await client.query(ix.ddl.replace('CREATE INDEX ', 'CREATE INDEX IF NOT EXISTS '))
  }
}

/** event 上现存索引（含 pkey / unique） */
export async function listEventIndexes(client) {
  const { rows } = await client.query(`
    SELECT c.relname            AS name,
           i.indisunique        AS is_unique,
           i.indisprimary       AS is_primary,
           am.amname            AS method
      FROM pg_index i
      JOIN pg_class c     ON c.oid = i.indexrelid
      JOIN pg_class t     ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_am am       ON am.oid = c.relam
     WHERE t.relname = 'event' AND n.nspname = 'public'
     ORDER BY c.relname`)
  return rows
}

/**
 * 「关索引」：删掉 event 上所有非唯一索引（保留 pkey 与 unique 约束索引）。
 * @returns {Promise<string[]>} 被删掉的索引名
 */
export async function dropNonUniqueEventIndexes(client) {
  const all = await listEventIndexes(client)
  const victims = all.filter((r) => !r.is_unique && !r.is_primary).map((r) => r.name)
  for (const name of victims) {
    await client.query(`DROP INDEX IF EXISTS public."${name}"`)
  }
  return victims
}

/* ---------- COPY 可用性探测 ---------- */

/**
 * 探测 `COPY event (...) FROM STDIN WITH (FORMAT csv, NULL '')`。
 *
 * node-postgres **没有**流式 COPY 实现：收到 CopyInResponse 后它会立刻回
 * `COPY from stdin failed: No source stream defined`（SQLSTATE 57014），
 * 即"服务端等你喂数据，客户端没管道可喂"。要真用 COPY 必须装 pg-copy-streams，
 * 而本项目禁改依赖；本机也没有 psql.exe（embedded-postgres 只带 postgres/initdb/pg_ctl）。
 *
 * 探测走**独立连接**：失败后直接销毁该连接，主连接不受影响。
 *
 * @param {string} db
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok:boolean, ms:number, error?:string, code?:string, note?:string}>}
 */
export async function probeCopy(db, timeoutMs = 8000) {
  const client = new pg.Client({
    connectionString: connString(db),
    connectionTimeoutMillis: 4000,
  })
  const t0 = now()
  try {
    await client.connect()
  } catch (e) {
    return { ok: false, ms: now() - t0, error: `连接失败：${e.message}` }
  }
  const sql = `COPY event (${EVENT_COLS.join(', ')}) FROM STDIN WITH (FORMAT csv, NULL '')`
  try {
    const res = await Promise.race([
      client.query(sql),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`探测超时 ${timeoutMs}ms（连接挂起）`)), timeoutMs).unref?.()),
    ])
    return {
      ok: true,
      ms: now() - t0,
      note: `COPY 意外成功（command=${res?.command}）——真要走这条路还得再喂数据流`,
    }
  } catch (e) {
    return { ok: false, ms: now() - t0, error: e.message, code: e.code }
  } finally {
    // COPY 失败后连接还可能停在 CopyIn 状态；先砸 socket 再 end，避免 end() 挂死
    try { client.connection?.stream?.destroy() } catch { /* ignore */ }
    try { await client.end() } catch { /* ignore */ }
  }
}

/* ---------- 批量写入 ---------- */

/**
 * 把 JS 值转成 SQL 字面量。
 *
 * 为什么不用 $1..$n 占位符：PG 有线协议单语句最多 65535 个绑定参数，
 * 5000 行 × 20 列 = 100,000 个参数 → 超限（"bind message supplies ... parameters"）。
 * 所以 5000 行/批只能用字面量拼接；standard_conforming_strings=on 下只需把 ' 变成 ''。
 *
 * @param {unknown} v
 */
export function literal(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return `'${String(v).replace(/'/g, "''")}'`
}

/**
 * 多行 INSERT 批量写入（每批 `batchRows` 行一条语句）。
 *
 * @param {pg.Client} client
 * @param {{total:number, batchRows?:number, from?:number, log?:Function}} opts
 * @returns {Promise<{mode:string, ms:number, rows:number, batches:number, sqlBytes:number}>}
 */
export async function insertRows(client, { total, batchRows = 5000, from = 0, log }) {
  const cols = EVENT_COLS.join(', ')
  const t0 = now()
  let done = 0
  let batches = 0
  let sqlBytes = 0
  for (let off = 0; off < total; off += batchRows) {
    const n = Math.min(batchRows, total - off)
    const rows = makeEventRows(from + off, n, total)
    const values = rows.map((r) => `(${r.map(literal).join(',')})`).join(',')
    const sql = `INSERT INTO event (${cols}) VALUES ${values}`
    sqlBytes += sql.length
    await client.query(sql)
    done += n
    batches++
    if (log) log(done, total, now() - t0)
  }
  return { mode: 'insert', ms: now() - t0, rows: done, batches, sqlBytes }
}

/* ---------- 回填 search_tsv ---------- */

/**
 * 回填规则与生产一致（seed/index.js、ingest/router.js）：
 * title + summary + category + discipline + place_slug → tokenize → toTsv。
 * @param {string[]} fields
 */
export function tsvFromFields(fields) {
  return toTsv(tokenize(fields.filter((v) => typeof v === 'string' && v.length > 0).join(' ')))
}

/**
 * 两段式回填：
 *   ① 分页读 event → JS 分词 → 批量灌 UNLOGGED 临时表 tmp_tsv（2 列，参数化插入不超限）
 *   ② 一条 `UPDATE ... FROM tmp_tsv` 全表回填 search_tsv
 *
 * 相比「逐行 UPDATE」，UPDATE 次数从 N 降到 1，且 event 表只被顺序扫一遍 + 一遍堆更新。
 *
 * @param {pg.Client} client
 * @param {{pageSize?:number, log?:Function}} [opts]
 */
export async function backfillTsv(client, { pageSize = 5000, log } = {}) {
  const t0 = now()
  await client.query('DROP TABLE IF EXISTS tmp_tsv')
  await client.query('CREATE UNLOGGED TABLE tmp_tsv (id BIGINT NOT NULL, tsv TEXT NOT NULL)')

  let readMs = 0
  let tokenizeMs = 0
  let loadMs = 0
  let rowsRead = 0
  let lastId = 0

  for (;;) {
    const tRead = now()
    const { rows } = await client.query(
      `SELECT id, title, summary, category, discipline, place_slug
         FROM event WHERE id > $1 ORDER BY id LIMIT $2`,
      [lastId, pageSize],
    )
    readMs += now() - tRead
    if (rows.length === 0) break

    const tTok = now()
    const ids = []
    const tsvs = []
    for (const r of rows) {
      ids.push(String(r.id))
      tsvs.push(tsvFromFields([r.title, r.summary, r.category, r.discipline, r.place_slug]))
    }
    tokenizeMs += now() - tTok

    const tLoad = now()
    await client.query(
      `INSERT INTO tmp_tsv (id, tsv) SELECT * FROM unnest($1::bigint[], $2::text[])`,
      [ids, tsvs],
    )
    loadMs += now() - tLoad

    lastId = rows[rows.length - 1].id
    rowsRead += rows.length
    if (log) log(rowsRead, 0, now() - t0)
  }

  await client.query('ANALYZE tmp_tsv')

  const tUpd = now()
  const upd = await client.query(
    `UPDATE event e SET search_tsv = to_tsvector('simple', t.tsv)
       FROM tmp_tsv t WHERE e.id = t.id`,
  )
  const updateMs = now() - tUpd

  await client.query('DROP TABLE tmp_tsv')

  return {
    ms: now() - t0,
    rowsRead,
    updated: upd.rowCount,
    readMs,
    tokenizeMs,
    loadMs,
    updateMs,
    updateStatements: 1,
  }
}

/* ---------- 重建索引 ---------- */

/**
 * 逐条重建 event 全部索引并计时。
 * @param {pg.Client} client
 * @param {{log?:Function}} [opts]
 */
export async function buildIndexes(client, { log } = {}) {
  const t0 = now()
  await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')

  const out = []
  for (const ix of EVENT_INDEXES) {
    const t = now()
    await client.query(ix.ddl)
    const ms = now() - t
    let bytes = 0
    try {
      const { rows } = await client.query(
        `SELECT pg_relation_size(to_regclass($1))::bigint AS b`,
        [`public.${ix.name}`],
      )
      bytes = Number(rows[0]?.b ?? 0)
    } catch { /* 忽略 */ }
    out.push({ name: ix.name, kind: ix.kind, ms, bytes })
    if (log) log(ix.name, ms)
  }

  return { ms: now() - t0, indexes: out, totalBytes: out.reduce((s, x) => s + x.bytes, 0) }
}

/** @param {pg.Client} client @param {string} rel */
export async function relationSize(client, rel) {
  const { rows } = await client.query(
    `SELECT pg_total_relation_size(to_regclass($1))::bigint AS b`,
    [`public.${rel}`],
  )
  return Number(rows[0]?.b ?? 0)
}

/* ---------- 编排 ---------- */

const defaultLog = (msg) => process.stdout.write(`${msg}\n`)

/**
 * 完整跑一遍「关索引大批量导入」。
 *
 * @param {{
 *   n?: number, db?: string, batchRows?: number,
 *   mode?: 'auto'|'copy'|'insert', keepIndexes?: boolean,
 *   analyze?: boolean, log?: (msg:string)=>void
 * }} opts
 */
export async function runBulkImport({
  n = 200000,
  db = 'history_atlas_bulk_test',
  batchRows = 5000,
  mode = 'auto',
  keepIndexes = false,
  analyze = true,
  log = defaultLog,
} = {}) {
  assertTestDb(db)
  const report = {
    n,
    db,
    batchRows,
    mode,
    copy: null,
    writeMode: null,
    indexesDropped: [],
    times: {},
    write: null,
    backfill: null,
    indexBuild: null,
    verify: null,
    maintenanceWorkMemMb: null,
  }
  const tAll = now()
  const section = (label, ms) => {
    report.times[label] = ms
    log(`[bulk] ${label}：${fmtInt(ms)} ms`)
  }

  // ---------- 1. 建库 + 建表 ----------
  let t = now()
  await createFreshDatabase(db)
  const client = await connect(db)
  try {
    await applySchema(client)
    await ensureProductionIndexSet(client) // 补齐到生产索引集（10 个），与线上同构
    section('buildDbAndSchema', now() - t)

    const { rows: mem } = await client.query('SHOW maintenance_work_mem')
    report.maintenanceWorkMemMb = mem[0].maintenance_work_mem
    log(`[bulk] 目标库 ${db}，n=${fmtInt(n)}，maintenance_work_mem=${report.maintenanceWorkMemMb}`)

    // ---------- 2. 关索引 ----------
    t = now()
    if (keepIndexes) {
      log('[bulk] --keep-indexes：跳过"关索引"（对照组）')
      section('dropIndexes', 0)
    } else {
      report.indexesDropped = await dropNonUniqueEventIndexes(client)
      section('dropIndexes', now() - t)
      const left = await listEventIndexes(client)
      log(`[bulk] 关索引：删除 ${report.indexesDropped.length} 个非唯一索引，` +
          `保留 ${left.map((r) => r.name).join(', ')}`)
    }

    // ---------- 3. 批量写入 ----------
    if (mode !== 'insert') {
      report.copy = await probeCopy(db)
      log(report.copy.ok
        ? `[bulk] COPY 探测：可用（${report.copy.note}）`
        : `[bulk] COPY 探测：不可用 —— ${report.copy.error}（SQLSTATE ${report.copy.code ?? 'n/a'}）→ 降级`)
    } else {
      log('[bulk] --mode=insert：跳过 COPY 探测，直接用多行 INSERT')
    }
    if (mode === 'copy' && !report.copy?.ok) {
      throw new Error('--mode=copy 但 COPY 不可用：pg 未实现 COPY FROM STDIN 流式')
    }

    t = now()
    let lastPct = 0
    const progress = (done, total, ms) => {
      const pct = Math.floor((done / total) * 100)
      if (pct >= lastPct + 20 || done === total) {
        lastPct = pct - (pct % 20)
        log(`[bulk]   写入 ${fmtInt(done)}/${fmtInt(total)}（${pct}%，${fmtInt(ms)} ms）`)
      }
    }
    report.write = await insertRows(client, { total: n, batchRows, log: progress })
    report.writeMode = report.write.mode
    section('write', report.write.ms)
    log(`[bulk] 写入方式：多行 INSERT，${fmtInt(batchRows)} 行/批 × ${report.write.batches} 批` +
        `（生产 250 行/批，本方案放大 ${batchRows / 250}×；SQL 总体积 ${(report.write.sqlBytes / 1048576).toFixed(1)} MB）`)

    // ---------- 4. 回填 search_tsv ----------
    t = now()
    report.backfill = await backfillTsv(client, { log: (d) => { if (d % 20000 === 0) log(`[bulk]   回填读取 ${fmtInt(d)}`) } })
    section('backfill', report.backfill.ms)
    log(`[bulk] 回填拆分：读表 ${fmtInt(report.backfill.readMs)} + 分词 ${fmtInt(report.backfill.tokenizeMs)}` +
        ` + 灌临时表 ${fmtInt(report.backfill.loadMs)} + 1 条 UPDATE ${fmtInt(report.backfill.updateMs)} ms` +
        `（UPDATE 影响 ${fmtInt(report.backfill.updated)} 行）`)

    // ---------- 5. ANALYZE ----------
    if (analyze) {
      t = now()
      await client.query('ANALYZE event')
      section('analyze', now() - t)
    }

    // ---------- 6. 重建索引 ----------
    t = now()
    report.indexBuild = await buildIndexes(client, { log: (name, ms) => log(`[bulk]   建 ${name} ${fmtInt(ms)} ms`) })
    section('buildIndexes', report.indexBuild.ms)

    // ---------- 7. 校验 ----------
    const { rows: check } = await client.query(
      `SELECT count(*)::int AS total, count(search_tsv)::int AS with_tsv, min(id) AS lo, max(id) AS hi FROM event`,
    )
    const { rows: probeQ } = await client.query(
      `SELECT count(*)::int AS n FROM event
        WHERE status = 'published' AND search_tsv @@ to_tsquery('simple', $1)`,
      [toTsv(tokenize('水运仪象台')).split(' ').join(' & ')],
    )
    report.verify = {
      ...check[0],
      expect: n,
      tsvQueryHits: probeQ[0].n,
      eventTableBytes: await relationSize(client, 'event'),
    }

    section('total', now() - tAll)

    const sec = (label) => (report.times[label] ?? 0) / 1000
    report.rowsPerSec = {
      writeOnly: Math.round(n / Math.max(sec('write'), 0.001)),
      endToEnd: Math.round(n / Math.max(sec('total'), 0.001)),
      backfillOnly: Math.round(n / Math.max(sec('backfill'), 0.001)),
    }
    return report
  } finally {
    await client.end().catch(() => {})
  }
}

/* ---------- 报告 ---------- */

/** @param {Awaited<ReturnType<typeof runBulkImport>>} r */
export function formatReport(r) {
  const L = []
  const pad = (s, w) => String(s).padEnd(w)
  const num = (ms) => fmtInt(ms ?? 0)
  const sec = (label) => (r.times[label] ?? 0) / 1000

  L.push('')
  L.push('='.repeat(78))
  L.push(`bulk-import 报告   库=${r.db}   行数=${fmtInt(r.n)}`)
  L.push('='.repeat(78))

  L.push('COPY 可用性')
  if (!r.copy) {
    L.push('  · 未探测（--mode=insert）')
  } else if (r.copy.ok) {
    L.push('  · 可用')
  } else {
    L.push(`  · 不可用：${r.copy.error}`)
    L.push(`  · SQLSTATE ${r.copy.code ?? 'n/a'}；node-postgres 无 COPY FROM STDIN 流式实现`)
    L.push('    （需 pg-copy-streams；本项目禁装依赖，本机亦无 psql.exe）')
    L.push('  · 降级方案：多行 INSERT ... VALUES，5000 行/批（生产 250 行/批的 20 倍）')
  }
  L.push(`  · 实际写入方式：${r.writeMode === 'copy' ? 'COPY' : '多行 INSERT（字面量）'}` +
         `，${fmtInt(r.batchRows)} 行/批 × ${r.write?.batches ?? 0} 批`)

  L.push('')
  L.push('分阶段耗时')
  L.push(`  ${pad('建库+建表', 22)}${num(r.times.buildDbAndSchema).padStart(9)} ms`)
  L.push(`  ${pad('关索引', 22)}${num(r.times.dropIndexes).padStart(9)} ms   (删除 ${r.indexesDropped.length} 个非唯一索引)`)
  L.push(`  ${pad('纯导入', 22)}${num(r.times.write).padStart(9)} ms   (${r.write ? (r.write.sqlBytes / 1048576).toFixed(1) : 0} MB SQL)`)
  L.push(`  ${pad('回填 search_tsv', 22)}${num(r.times.backfill).padStart(9)} ms   (读表 ${num(r.backfill?.readMs)} / 分词 ${num(r.backfill?.tokenizeMs)} / 灌临时表 ${num(r.backfill?.loadMs)} / 1×UPDATE ${num(r.backfill?.updateMs)})`)
  L.push(`  ${pad('ANALYZE', 22)}${num(r.times.analyze).padStart(9)} ms`)
  L.push(`  ${pad('重建索引', 22)}${num(r.times.buildIndexes).padStart(9)} ms`)
  for (const ix of r.indexBuild?.indexes ?? []) {
    L.push(`      ${pad(ix.name, 30)}${pad(ix.kind, 13)}${num(ix.ms).padStart(7)} ms  ${(ix.bytes / 1024 / 1024).toFixed(1).padStart(6)} MB`)
  }
  L.push(`  ${pad('总耗时', 22)}${num(r.times.total).padStart(9)} ms`)

  L.push('')
  L.push('吞吐')
  L.push(`  · 纯导入 rows/s   ：${fmtInt(r.rowsPerSec?.writeOnly ?? 0)}`)
  L.push(`  · 端到端 rows/s   ：${fmtInt(r.rowsPerSec?.endToEnd ?? 0)}  （含建库/回填/建索引）`)
  L.push(`  · 仅回填 rows/s   ：${fmtInt(r.rowsPerSec?.backfillOnly ?? 0)}`)

  L.push('')
  L.push('校验')
  L.push(`  · event 行数 ${fmtInt(r.verify?.total ?? 0)} / 期望 ${fmtInt(r.verify?.expect ?? r.n)}` +
         `，search_tsv 已填 ${fmtInt(r.verify?.with_tsv ?? 0)}`)
  L.push(`  · search_tsv @@ '水运 & 运仪 & 仪象 & 象台' 命中 ${fmtInt(r.verify?.tsvQueryHits ?? 0)} 行`)
  L.push(`  · event 表 ${((r.verify?.eventTableBytes ?? 0) / 1048576).toFixed(1)} MB` +
         `，索引合计 ${((r.indexBuild?.totalBytes ?? 0) / 1048576).toFixed(1)} MB`)
  L.push(`  · 时间守恒检查：${['buildDbAndSchema', 'dropIndexes', 'write', 'backfill', 'analyze', 'buildIndexes']
    .reduce((s, k) => s + sec(k), 0).toFixed(2)}s（分项）+ 调度开销 ≈ ${sec('total').toFixed(2)}s（总计）`)
  L.push('='.repeat(78))
  L.push('')
  return L.join('\n')
}

/* ---------- CLI ---------- */

function arg(k, d) {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
  if (!hit) return d
  if (hit === `--${k}`) return true
  return hit.slice(k.length + 3)
}

export async function main(argv = process.argv.slice(2)) {
  const n = Number(arg('n', 200000))
  const db = String(arg('db', 'history_atlas_bulk_test'))
  const batchRows = Number(arg('batch', 5000))
  const mode = String(arg('mode', 'auto'))
  const keepIndexes = arg('keep-indexes', false) === true
  const keepDb = arg('keep-db', false) === true

  if (!Number.isFinite(n) || n <= 0) throw new Error(`--n 非法：${arg('n')}`)
  if (!Number.isFinite(batchRows) || batchRows <= 0) throw new Error(`--batch 非法：${arg('batch')}`)

  const report = await runBulkImport({ n, db, batchRows, mode, keepIndexes })
  process.stdout.write(formatReport(report))
  if (!keepDb && arg('drop-db', false) === true) {
    await dropDatabase(db)
    process.stdout.write(`[bulk] 已 DROP DATABASE ${db}\n`)
  }
  return report
}

const isMain = (() => {
  if (!process.argv[1]) return false
  try {
    return pathToFileURL(process.argv[1]).href === import.meta.url
  } catch {
    return false
  }
})()

if (isMain) {
  main().then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`[bulk] 失败：${err?.stack || err}\n`)
      process.exit(1)
    },
  )
}
