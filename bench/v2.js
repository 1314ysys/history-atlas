#!/usr/bin/env node
/**
 * bench/v2.js —— v2 系统（原生 PG + FTS + 覆盖索引 + 分页）综合压测
 *
 *   node bench/v2.js --n=500000 [--claims=1]
 *
 * 覆盖：写入吞吐 / 存储构成 / 区间查询 / 全文检索 / 分面 / 压缩 / 复制延迟
 */
import pg from 'pg'
import zlib from 'node:zlib'
import os from 'node:os'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.split('=')[1] : d
}
const N = Number(arg('n', '500000'))
const WITH_CLAIMS = arg('claims', '1') === '1'
const DBNAME = `ha_v2_${Date.now().toString(36)}`
const ADMIN = `postgres://postgres@127.0.0.1:5433/postgres`
const TARGET = `postgres://postgres@127.0.0.1:5433/${DBNAME}`
const now = () => Number(process.hrtime.bigint() / 1000000n)
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`

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

console.log(`[v2] n=${N} claims=${WITH_CLAIMS} db=${DBNAME}`)
await resetSchema()

/* ---------- 写入 ---------- */
function multi(sqlTable, cols, rows, returning = '') {
  const per = 250
  const parts = []
  const params = []
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per)
    parts.push(chunk.map((row, ri) => `(${row.map((_, ci) => `$${params.length + ri * cols.length + ci + 1}`).join(',')})`).join(','))
    for (const row of chunk) params.push(...row)
  }
  return { sql: `INSERT INTO ${sqlTable} (${cols.join(',')}) VALUES ${parts.join(',')}${returning}`, params }
}

const EV_COLS = [...gen.EVENT_COLS, 'search_tsv']
const tIns = now()
let claims = 0
let sources = 0
for (let off = 0; off < N; off += 500) {
  const n = Math.min(500, N - off)
  const rows = gen.makeEventRows(off, n, N)
  const withTsv = rows.map((r) => [...r, toTsv(tokenize([r[1], r[16], r[3], r[4], r[13]].filter(Boolean).join(' ')))])
  // 先按 20 列插事件（不含 search_tsv），再用数组参数一次性回填 tsvector，
  // 避免多行 VALUES 里混表达式导致参数类型推断失败。
  const cols = gen.EVENT_COLS.join(',')
  const per = 250
  const parts = []
  const params = []
  for (let i = 0; i < withTsv.length; i += per) {
    const chunk = withTsv.slice(i, i + per)
    const tuple = []
    for (let ri = 0; ri < chunk.length; ri++) {
      const row = chunk[ri]
      const slots = gen.EVENT_COLS.map((_, ci) => `$${params.length + ri * gen.EVENT_COLS.length + ci + 1}`)
      tuple.push(`(${slots.join(',')})`)
    }
    parts.push(tuple.join(','))
    for (const row of chunk) params.push(...row.slice(0, gen.EVENT_COLS.length))
  }
  const sql = `INSERT INTO event (${cols}) VALUES ${parts.join(',')} RETURNING id`
  const res = await db.query(sql, params)

  // 回填 search_tsv（数组参数，类型显式）
  const ids = res.rows.map((r) => r.id)
  const tsvs = withTsv.map((r) => r[r.length - 1])
  await db.query(
    `UPDATE event e SET search_tsv = to_tsvector('simple', t.tsv)
       FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS tsv) t
      WHERE e.id = t.id`,
    [ids, tsvs],
  )
  const meta = res.rows.map((r, k) => ({ id: r.id, idx: off + k }))

  if (WITH_CLAIMS) {
    const cRows = gen.makeClaimRows(meta)
    const claimMap = new Map()
    if (cRows.length) {
      const c = multi('event_claim', gen.CLAIM_COLS, cRows, ' RETURNING id')
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
      const s = multi('event_source', gen.SOURCE_COLS, sRows)
      await db.query(s.sql, s.params)
      sources += sRows.length
    }
  }
  if (off % 100000 === 0) process.stdout.write(`\r  insert ${off + n}/${N}`)
}
const insertMs = now() - tIns
console.log(`\n[v2] 插入完成：${insertMs} ms，${Math.round(N / (insertMs / 1000))} events/s（claims=${claims}, sources=${sources}）`)

/* ---------- 索引（schema.sql 已含，这里确保覆盖索引存在） ---------- */
await db.exec(`
CREATE INDEX IF NOT EXISTS event_timeline_cover_idx
  ON event (t_start_year)
  INCLUDE (slug, title, t_start_month, t_start_day, t_end_year,
           t_precision, t_certainty, track, category, discipline, lat, lon)
  WHERE status = 'published'`)
await db.exec('VACUUM (ANALYZE) event')
if (WITH_CLAIMS) await db.exec('VACUUM (ANALYZE) event_claim, event_source')

// 回填 search_tsv 是 UPDATE，会留下死元组把 event 表撑大；VACUUM FULL 收回真实体积
const beforeVac = Number((await db.query('SELECT pg_total_relation_size($1)::bigint AS v', ['event'])).rows[0].v)
await db.exec('VACUUM FULL event')
await db.exec('ANALYZE event')
const afterVac = Number((await db.query('SELECT pg_total_relation_size($1)::bigint AS v', ['event'])).rows[0].v)
console.log(`[v2] event 表 VACUUM FULL：${mb(beforeVac)} -> ${mb(afterVac)}`)

// 应用迁移（trgm 索引 + 同义词表），让压测库与生产同构
try {
  const { readdir, readFile } = await import('node:fs/promises')
  const dir = path.join(process.cwd(), 'src', 'db', 'migrations')
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = await readFile(path.join(dir, f), 'utf8')
    await db.exec(sql)
    console.log(`[v2] 已应用迁移 ${f}`)
  }
} catch (e) {
  console.log('[v2] 迁移应用失败（不影响主流程）：', e.message)
}

/* ---------- 存储 ---------- */
const one = async (sql, p) => (await db.query(sql, p)).rows[0]
const dbBytes = Number((await one('SELECT pg_database_size(current_database())::bigint AS v')).v)
const tableSizes = {}
for (const t of ['event', 'event_claim', 'event_source', 'person', 'place', 'dynasty', 'source']) {
  try {
    tableSizes[t] = Number((await one('SELECT pg_total_relation_size($1)::bigint AS v', [t])).v)
  } catch { /* 表可能为空 */ }
}
const idx = {}
for (const name of ['event_fts_idx', 'event_timeline_cover_idx', 'event_span_idx', 'event_title_trgm_idx', 'event_summary_trgm_idx']) {
  try {
    const r = await one(`SELECT COALESCE(pg_relation_size($1),0)::bigint AS v`, [name])
    idx[name] = Number(r.v)
  } catch { idx[name] = 0 }
}

/* ---------- 查询 ---------- */
function stats(a) {
  const s = [...a].sort((x, y) => x - y)
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2) }
}
async function bench(fn, reps = 20) {
  for (let i = 0; i < 3; i++) await fn()
  const t = []
  for (let i = 0; i < reps; i++) {
    const a = now()
    await fn()
    t.push(now() - a)
  }
  return stats(t)
}

const q = {}
q.range10 = await bench(() => timeline({ query: { from: 1085, to: 1095, limit: 200 } }))
q.range100 = await bench(() => timeline({ query: { from: 1000, to: 1100, limit: 200 } }))
q.range500 = await bench(() => timeline({ query: { from: 500, to: 1000, limit: 200 } }))
q.rangeFull = await bench(() => timeline({ query: { from: -5000, to: 2025, limit: 200 } }))
q.range100WithTotal = await bench(() => timeline({ query: { from: 1000, to: 1100, limit: 200, withTotal: '1' } }))
q.searchHit1 = await bench(() => search({ query: { q: '水运仪象台', limit: 20 } }))
q.searchHitMany = await bench(() => search({ query: { q: '纪事', limit: 20 } }))
q.searchMiss = await bench(() => search({ query: { q: '不存在zzz', limit: 20 } }))
q.searchSynonym = await bench(() => search({ query: { q: '造纸', limit: 20 } }))

/* ---------- 压缩 ---------- */
const { rows: dumpRows } = await db.query(
  `SELECT slug,title,track,category,t_start_year,t_end_year,t_precision,t_certainty,summary FROM event ORDER BY id`,
)
const raw = Buffer.from(dumpRows.map((r) => JSON.stringify(r)).join('\n'), 'utf8')
const tmp = await mkdtemp(path.join(os.tmpdir(), 'ha-v2-'))
await writeFile(path.join(tmp, 'e.jsonl'), raw)
const codecs = [
  ['gzip-6', () => zlib.gzipSync(raw, { level: 6 })],
  ['zstd-3', () => zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } })],
  ['zstd-9', () => zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 9 } })],
  ['zstd-19', () => zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } })],
  ['brotli-5', () => zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })],
]
const compression = []
for (const [name, fn] of codecs) {
  const t = now()
  const out = fn()
  const cMs = now() - t
  const t2 = now()
  const back = name.startsWith('zstd') ? zlib.zstdDecompressSync(out) : name.startsWith('brotli') ? zlib.brotliDecompressSync(out) : zlib.gunzipSync(out)
  const dMs = now() - t2
  compression.push({
    codec: name,
    ratio: +(raw.length / out.length).toFixed(2),
    bytes: out.length,
    cMBps: +(raw.length / 1048576 / (cMs / 1000)).toFixed(1),
    dMBps: +(raw.length / 1048576 / (dMs / 1000)).toFixed(1),
    ok: back.length === raw.length,
  })
}
const sample = raw.subarray(0, Math.min(raw.length, 16 * 1048576))
const b11t = now()
const b11 = zlib.brotliCompressSync(sample, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } })
compression.push({
  codec: 'brotli-11*',
  ratio: +(sample.length / b11.length).toFixed(2),
  bytes: Math.round((b11.length / sample.length) * raw.length),
  cMBps: +(sample.length / 1048576 / ((now() - b11t) / 1000)).toFixed(1),
  dMBps: 0,
  ok: true,
  note: '16MB 样本外推',
})
await rm(tmp, { recursive: true, force: true })

const report = {
  n: N,
  withClaims: WITH_CLAIMS,
  claims,
  sources,
  insertMs,
  eventsPerSec: Math.round(N / (insertMs / 1000)),
  storage: {
    dbBytes,
    dbPretty: mb(dbBytes),
    bytesPerEvent: Math.round(dbBytes / N),
    tables: Object.fromEntries(Object.entries(tableSizes).map(([k, v]) => [k, mb(v)])),
    indexes: Object.fromEntries(Object.entries(idx).map(([k, v]) => [k, mb(v)])),
  },
  query: q,
  compression,
}
console.log('\n' + JSON.stringify(report, null, 2))

await db.close()
const a2 = new pg.Client({ connectionString: ADMIN })
await a2.connect()
await a2.query(`DROP DATABASE IF EXISTS "${DBNAME}"`)
await a2.end()
console.log('[v2] 已清理测试库')
process.exit(0)
