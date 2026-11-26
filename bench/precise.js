#!/usr/bin/env node
/**
 * bench/precise.js —— 精确测量：存储构成 + 查询延迟（修正 v2.js 的测量 bug）
 *
 *   node bench/precise.js --n=200000
 *
 * 与 v2.js 的区别：
 *   · 存储用 pg_class 查询（方式 D，最稳），不用参数化的 pg_total_relation_size
 *   · VACUUM FULL 所有表（不只是 event），消除死元组干扰
 *   · 查询用真实命中词，避免 tooBroad 早退污染数据
 *   · 同时测 API handler 与裸 SQL，区分「数据库耗时」与「应用层开销」
 */
import pg from 'pg'
import zlib from 'node:zlib'

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.split('=')[1] : d
}
const N = Number(arg('n', '200000'))
const DBNAME = `ha_precise_${Date.now().toString(36)}`
const ADMIN = 'postgres://postgres@127.0.0.1:5433/postgres'
const TARGET = `postgres://postgres@127.0.0.1:5433/${DBNAME}`
const now = () => Number(process.hrtime.bigint() / 1000000n)
const mb = (b) => `${(Number(b) / 1048576).toFixed(1)} MB`

const admin = new pg.Client({ connectionString: ADMIN })
await admin.connect()
await admin.query(`CREATE DATABASE "${DBNAME}"`)
await admin.end()

process.env.DATABASE_URL = TARGET
const { db, resetSchema } = await import('../src/db/client.js')
const gen = await import('./gen.js')
const { tokenize, toTsv } = await import('../src/domain/tokenize.js')
const timeline = (await import('../src/api/timeline.js')).routes.find((r) => r[1] === '/api/timeline')[2]
const search = (await import('../src/api/search.js')).routes.find((r) => r[1] === '/api/search')[2]

console.log(`[precise] n=${N} db=${DBNAME}`)
await resetSchema()

/* ---------------- 写入 ---------------- */
const CLAIM_COLS = gen.CLAIM_COLS
const SOURCE_COLS = gen.SOURCE_COLS

function multi(table, cols, rows, returning = '') {
  const per = 250
  const parts = []
  const params = []
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per)
    const tuple = []
    for (let ri = 0; ri < chunk.length; ri++) {
      const slots = cols.map((_, ci) => `$${params.length + ri * cols.length + ci + 1}`)
      tuple.push(`(${slots.join(',')})`)
    }
    parts.push(tuple.join(','))
    for (const row of chunk) params.push(...row)
  }
  return { sql: `INSERT INTO ${table} (${cols.join(',')}) VALUES ${parts.join(',')}${returning}`, params }
}

const tIns = now()
let claims = 0
let sources = 0
for (let off = 0; off < N; off += 500) {
  const n = Math.min(500, N - off)
  const rows = gen.makeEventRows(off, n, N)
  const tsvs = rows.map((r) => toTsv(tokenize([r[1], r[16], r[3], r[4], r[13]].filter(Boolean).join(' '))))

  const q = multi('event', gen.EVENT_COLS, rows, ' RETURNING id')
  const res = await db.query(q.sql, q.params)
  const meta = res.rows.map((r, k) => ({ id: r.id, idx: off + k }))

  // 回填 tsvector（数组参数）
  await db.query(
    `UPDATE event e SET search_tsv = to_tsvector('simple', t.tsv)
       FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS tsv) t
      WHERE e.id = t.id`,
    [res.rows.map((r) => r.id), tsvs],
  )

  const cRows = gen.makeClaimRows(meta)
  const claimMap = new Map()
  if (cRows.length) {
    const c = multi('event_claim', CLAIM_COLS, cRows, ' RETURNING id')
    const cRes = await db.query(c.sql, c.params)
    cRows.forEach((row, i) => {
      const list = claimMap.get(row[0]) || []
      list.push(cRes.rows[i].id)
      claimMap.set(row[0], list)
    })
    claims += cRows.length
  }
  const sRows = gen.makeSourceRows(meta, claimMap)
  if (sRows.length) {
    const s = multi('event_source', SOURCE_COLS, sRows)
    await db.query(s.sql, s.params)
    sources += sRows.length
  }
  if (off % 50000 === 0) process.stdout.write(`\r  insert ${off + n}/${N}`)
}
const insertMs = now() - tIns
console.log(`\n[precise] 插入 ${N} 条 + ${claims} 说法 + ${sources} 出处：${insertMs} ms（${Math.round(N / (insertMs / 1000))} ev/s）`)

/* ---------------- 索引 ---------------- */
console.log('[precise] 建索引…')
const tIdx = now()
await db.exec(`
CREATE INDEX IF NOT EXISTS event_timeline_cover_idx
  ON event (t_start_year)
  INCLUDE (slug, title, t_start_month, t_start_day, t_end_year,
           t_precision, t_certainty, track, category, discipline, lat, lon)
  WHERE status = 'published'`)
await db.exec('CREATE INDEX IF NOT EXISTS event_fts_idx ON event USING GIN (search_tsv)')
await db.exec('CREATE INDEX IF NOT EXISTS event_span_idx ON event USING GIST (t_span)')
await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm')
await db.exec('CREATE INDEX IF NOT EXISTS event_title_trgm_idx ON event USING GIN (title gin_trgm_ops)')
await db.exec('CREATE INDEX IF NOT EXISTS event_summary_trgm_idx ON event USING GIN (summary gin_trgm_ops)')
const idxMs = now() - tIdx
console.log(`[precise] 索引耗时：${idxMs} ms`)

/* ---------------- VACUUM FULL 全部表 ---------------- */
console.log('[precise] VACUUM FULL（消除死元组）…')
const tVac = now()
await db.exec('VACUUM FULL event')
await db.exec('VACUUM FULL event_claim')
await db.exec('VACUUM FULL event_source')
await db.exec('VACUUM (ANALYZE) event, event_claim, event_source')
console.log(`[precise] VACUUM 耗时：${now() - tVac} ms`)

/* ---------------- 存储（pg_class 方式） ---------------- */
const dbBytes = Number((await db.query('SELECT pg_database_size(current_database())::bigint AS v')).rows[0].v)
const rel = await db.query(`
  SELECT c.relname,
         pg_relation_size(c.oid)::bigint AS heap,
         pg_indexes_size(c.oid)::bigint AS idx,
         pg_total_relation_size(c.oid)::bigint AS total
    FROM pg_class c
   WHERE c.relname = ANY($1::text[]) AND c.relkind = 'r'
   ORDER BY total DESC`, [['event', 'event_claim', 'event_source']])

const idxList = await db.query(`
  SELECT c.relname AS name, pg_relation_size(c.oid)::bigint AS bytes
    FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
   WHERE i.indrelid = 'event'::regclass
   ORDER BY bytes DESC`)

console.log('\n=== 存储构成 ===')
console.log('  数据库总计:', mb(dbBytes), '| 每事件:', Math.round(dbBytes / N), 'B')
console.log('  表:')
for (const r of rel.rows) {
  console.log(`    ${r.relname.padEnd(14)} heap=${mb(r.heap).padStart(10)}  idx=${mb(r.idx).padStart(9)}  total=${mb(r.total).padStart(10)}`)
}
console.log('  event 索引明细:')
for (const r of idxList.rows) {
  console.log(`    ${r.name.padEnd(30)} ${(Number(r.bytes) / 1024).toFixed(0).padStart(6)} KB`)
}

/* ---------------- 查询延迟 ---------------- */
function stats(a) {
  const s = [...a].sort((x, y) => x - y)
  const p = (x) => +s[Math.min(s.length - 1, Math.floor(x * s.length))].toFixed(2)
  return { p50: p(0.5), p95: p(0.95), p99: p(0.99) }
}
async function bench(fn, reps = 25) {
  for (let i = 0; i < 4; i++) await fn()
  const t = []
  let info = null
  for (let i = 0; i < reps; i++) {
    const a = now()
    info = await fn()
    t.push(now() - a)
  }
  return { ...stats(t), info }
}

const q = {}
q.range10 = await bench(() => timeline({ query: { from: 1085, to: 1095, limit: 200 } }))
q.range100 = await bench(() => timeline({ query: { from: 1000, to: 1100, limit: 200 } }))
q.range500 = await bench(() => timeline({ query: { from: 500, to: 1000, limit: 200 } }))
q.rangeFull = await bench(() => timeline({ query: { from: -5000, to: 2025, limit: 200 } }))
q.range100Total = await bench(() => timeline({ query: { from: 1000, to: 1100, limit: 200, withTotal: '1' } }))
q.searchPrecise = await bench(() => search({ query: { q: '水运仪象台', limit: 20 } }))
q.searchBroad = await bench(() => search({ query: { q: '纪事', limit: 20 } }))
q.searchMiss = await bench(() => search({ query: { q: '不存在zzz', limit: 20 } }))

console.log('\n=== 查询延迟（ms）===')
for (const [k, v] of Object.entries(q)) {
  const extra = v.info?.tooBroad ? ' [tooBroad]' : v.info?.returned != null ? ` rows=${v.info.returned}` : ''
  console.log(`  ${k.padEnd(18)} p50=${String(v.p50).padStart(6)}  p95=${String(v.p95).padStart(6)}  p99=${String(v.p99).padStart(6)}${extra}`)
}

/* ---------------- 压缩 ---------------- */
const { rows: dumpRows } = await db.query(
  `SELECT slug,title,track,category,t_start_year,t_end_year,t_precision,t_certainty,summary FROM event ORDER BY id`,
)
const raw = Buffer.from(dumpRows.map((r) => JSON.stringify(r)).join('\n'), 'utf8')
const codecs = [
  ['gzip-6', () => zlib.gzipSync(raw, { level: 6 })],
  ['zstd-3', () => zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } })],
  ['zstd-9', () => zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 9 } })],
  ['zstd-19', () => zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } })],
  ['brotli-5', () => zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })],
]
const comp = []
for (const [name, fn] of codecs) {
  const t = now()
  const out = fn()
  const cMs = now() - t
  const t2 = now()
  const back = name.startsWith('zstd') ? zlib.zstdDecompressSync(out) : name.startsWith('brotli') ? zlib.brotliDecompressSync(out) : zlib.gunzipSync(out)
  const dMs = now() - t2
  comp.push({
    codec: name,
    ratio: +(raw.length / out.length).toFixed(2),
    cMBps: +(raw.length / 1048576 / (cMs / 1000)).toFixed(1),
    dMBps: +(raw.length / 1048576 / (dMs / 1000)).toFixed(1),
    ok: back.length === raw.length,
  })
}

console.log('\n=== 压缩（JSONL 原始 ' + mb(raw.length) + '）===')
for (const c of comp) {
  console.log(`  ${c.codec.padEnd(10)} ${String(c.ratio).padStart(6)}×  c=${String(c.cMBps).padStart(6)} MB/s  d=${String(c.dMBps).padStart(6)} MB/s  ${c.ok ? 'OK' : 'FAIL'}`)
}

/* ---------------- 汇总 ---------------- */
const summary = {
  n: N,
  claims,
  sources,
  insertMs,
  eventsPerSec: Math.round(N / (insertMs / 1000)),
  indexMs: idxMs,
  storage: {
    dbBytes,
    dbPretty: mb(dbBytes),
    bytesPerEvent: Math.round(dbBytes / N),
    tables: Object.fromEntries(rel.rows.map((r) => [r.relname, { heap: mb(r.heap), idx: mb(r.idx), total: mb(r.total) }])),
    eventIndexes: Object.fromEntries(idxList.rows.map((r) => [r.name, `${(Number(r.bytes) / 1024).toFixed(0)} KB`])),
  },
  query: Object.fromEntries(Object.entries(q).map(([k,v]) => [k, { p50:v.p50, p95:v.p95, p99:v.p99, tooBroad: v.info?.tooBroad ?? false, returned: v.info?.returned ?? null, total: v.info?.total ?? null }])),
  compression: comp,
}
console.log('\nJSON_START')
console.log(JSON.stringify(summary))
console.log('JSON_END')

await db.close()
const a2 = new pg.Client({ connectionString: ADMIN })
await a2.connect()
await a2.query(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`)
await a2.end()
console.log('[precise] 已清理临时库')
process.exit(0)
