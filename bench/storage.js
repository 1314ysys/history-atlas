#!/usr/bin/env node
/**
 * bench/storage.js —— 存储 / 检索 / 压缩 三合一的实测画像（原生 PostgreSQL）
 *
 *   node bench/storage.js --n=500000
 *
 * 输出：库体积构成、每事件字节、JSONL dump 的多种编码器压缩比与速度、四类查询分位。
 */
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import pg from 'pg'

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    return m ? [m[1], m[2] ?? true] : [a, true]
  }),
)
const N = Number(argv.n || 500000)
const REPS = Number(argv.reps || 15)
const DBNAME = `history_atlas_bench_${Date.now().toString(36)}`
const ADMIN = `postgres://postgres@127.0.0.1:${process.env.PGPORT || 5433}/postgres`
const TARGET = `postgres://postgres@127.0.0.1:${process.env.PGPORT || 5433}/${DBNAME}`

const now = () => Number(process.hrtime.bigint() / 1000000n)
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`

// 1) 建库
const admin = new pg.Client({ connectionString: ADMIN })
await admin.connect()
await admin.query(`CREATE DATABASE "${DBNAME}"`)
await admin.end()

process.env.DATABASE_URL = TARGET
const { db, resetSchema } = await import('../src/db/client.js')
const gen = await import('./gen.js')
const timelineMod = await import('../src/api/timeline.js')
const searchMod = await import('../src/api/search.js')
const { tokenize, toTsv } = await import('../src/domain/tokenize.js')
const timeline = timelineMod.routes.find((r) => r[1] === '/api/timeline')[2]
const search = searchMod.routes.find((r) => r[1] === '/api/search')[2]

console.log(`[bench] db=${DBNAME} n=${N}`)
await resetSchema()

// 2) 写入
const CLAIM_COLS = ['event_id', 'statement', 'evidence_level', 'confidence', 'disputed_group', 'adopted', 'rationale', 'sort_order']
const SOURCE_COLS = ['event_id', 'claim_id', 'source_slug', 'locator', 'quote', 'quote_sha256', 'verified_status', 'verified_at']

function multiInsert(table, cols, rows) {
  const per = 300
  const parts = []
  const params = []
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per)
    parts.push(chunk.map((row, ri) => `(${row.map((_, ci) => `$${params.length + ri * cols.length + ci + 1}`).join(',')})`).join(','))
    for (const row of chunk) params.push(...row)
  }
  return { sql: `INSERT INTO ${table} (${cols.join(',')}) VALUES ${parts.join(',')} RETURNING id`, params }
}

const tIns = now()
const BATCH = 500
for (let off = 0; off < N; off += BATCH) {
  const n = Math.min(BATCH, N - off)
  const evRows = gen.makeEventRows(off, n, N)
  const ev = multiInsert('event', gen.EVENT_COLS, evRows)
  const res = await db.query(ev.sql, ev.params)
  const meta = res.rows.map((r, k) => ({ id: r.id, idx: off + k }))

  // 同步写 search_tsv：用真实分词器
  for (let k = 0; k < meta.length; k++) {
    const row = evRows[k]
    const text = [row[1], row[16], row[3], row[4], row[13]].filter(Boolean).join(' ')
    await db.query('UPDATE event SET search_tsv = to_tsvector($1, $2) WHERE id = $3', ['simple', toTsv(tokenize(text)), meta[k].id])
  }

  const cRows = gen.makeClaimRows(meta)
  const claimMap = new Map()
  if (cRows.length) {
    const c = multiInsert('event_claim', CLAIM_COLS, cRows)
    const cRes = await db.query(c.sql, c.params)
    cRows.forEach((row, i) => {
      const list = claimMap.get(row[0]) || []
      list.push(cRes.rows[i].id)
      claimMap.set(row[0], list)
    })
  }
  const sRows = gen.makeSourceRows(meta, claimMap)
  if (sRows.length) {
    const s = multiInsert('event_source', SOURCE_COLS, sRows)
    await db.query(s.sql, s.params)
  }
  if ((off / BATCH) % 40 === 0) process.stdout.write(`\r  insert ${off + n}/${N}`)
}
const insertMs = now() - tIns

// 3) 存储画像
const sizeOf = async (sqluble, arg) => (await db.query(sqluble, arg ? [arg] : [])).rows[0].v
const dbBytes = await sizeOf('SELECT pg_database_size(current_database())::bigint AS v')
const tbl = {}
for (const t of ['event', 'event_claim', 'event_source', 'person', 'person_relation']) {
  tbl[t] = Number(await sizeOf('SELECT pg_total_relation_size($1)::bigint AS v', t))
}
const idxBytes = Number(await sizeOf(`SELECT pg_indexes_size('event')::bigint AS v`))
const ftsBytes = Number(await sizeOf(
  `SELECT pg_relation_size(oid)::bigint AS v FROM pg_class WHERE relname='event_fts_idx'`,
))

// 4) dump + 压缩
const { rows: dumpRows } = await db.query(
  `SELECT slug,title,track,category,discipline,t_start_year,t_end_year,t_precision,t_certainty,summary
     FROM event ORDER BY id`,
)
const jsonl = dumpRows.map((r) => JSON.stringify(r)).join('\n')
const raw = Buffer.from(jsonl, 'utf8')
const tmp = await mkdtemp(path.join(os.tmpdir(), 'ha-cmp-'))
const rawPath = path.join(tmp, 'events.jsonl')
await writeFile(rawPath, raw)

const codecs = [
  ['gzip-6', () => zlib.gzipSync(raw, { level: 6 })],
  ['zstd-3', () => zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } })],
  ['zstd-9', () => zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 9 } })],
  ['zstd-19', () => zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } })],
  ['brotli-5', () => zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })],
]
const compression = []
for (const [name, fn] of codecs) {
  const t0 = now()
  const out = fn()
  const cMs = now() - t0
  const t1 = now()
  const back = name.startsWith('zstd') ? zlib.zstdDecompressSync(out) : name.startsWith('brotli') ? zlib.brotliDecompressSync(out) : zlib.gunzipSync(out)
  const dMs = now() - t1
  compression.push({
    codec: name,
    bytes: out.length,
    ratio: +(raw.length / out.length).toFixed(2),
    compressMs: cMs,
    decompressMs: dMs,
    cMBps: +(raw.length / 1024 / 1024 / (cMs / 1000)).toFixed(1),
    dMBps: +(raw.length / 1024 / 1024 / (dMs / 1000)).toFixed(1),
    ok: back.length === raw.length,
  })
}
// brotli-11 只在 20MB 样本上测（太慢）
const sample = raw.subarray(0, Math.min(raw.length, 20 * 1024 * 1024))
const b11t = now()
const b11 = zlib.brotliCompressSync(sample, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } })
compression.push({
  codec: 'brotli-11*',
  bytes: Math.round((b11.length / sample.length) * raw.length),
  ratio: +(sample.length / b11.length).toFixed(2),
  compressMs: now() - b11t,
  decompressMs: 0,
  cMBps: +(sample.length / 1024 / 1024 / ((now() - b11t) / 1000)).toFixed(1),
  dMBps: 0,
  ok: true,
  note: '20MB 样本外推',
})
await rm(tmp, { recursive: true, force: true })

// 5) 查询
function stats(list) {
  const s = [...list].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2) }
}
async function bench(fn, reps = REPS) {
  for (let i = 0; i < 4; i++) await fn()
  const t = []
  for (let i = 0; i < reps; i++) {
    const a = now()
    await fn()
    t.push(now() - a)
  }
  return stats(t)
}
const q = {
  w10: await bench(() => timeline({ query: { from: 1085, to: 1095 }, params: {} })),
  w100: await bench(() => timeline({ query: { from: 1000, to: 1100 }, params: {} })),
  wfull: await bench(() => timeline({ query: { from: -5000, to: 2025 }, params: {} })),
  search: await bench(() => search({ query: { q: '不存在zzz', limit: 20 }, params: {} })),
  searchZh: await bench(() => search({ query: { q: '纪事', limit: 20 }, params: {} })),
}

console.log('\n' + JSON.stringify({
  n: N,
  insertMs,
  insertRowsPerSec: Math.round(N / (insertMs / 1000)),
  storage: {
    dbBytes,
    dbPretty: mb(dbBytes),
    bytesPerEvent: Math.round(dbBytes / N),
    tables: Object.fromEntries(Object.entries(tbl).map(([k, v]) => [k, mb(v)])),
    eventIndexBytes: mb(idxBytes),
    ftsIndexBytes: mb(ftsBytes),
  },
  dump: { rows: dumpRows.length, rawBytes: raw.length, rawPretty: mb(raw.length) },
  compression,
  query: q,
}, null, 2))

// 6) 清理
await db.close()
const admin2 = new pg.Client({ connectionString: ADMIN })
await admin2.connect()
await admin2.query(`DROP DATABASE IF EXISTS "${DBNAME}"`)
await admin2.end()
console.log('[bench] 已清理测试库')
process.exit(0)
