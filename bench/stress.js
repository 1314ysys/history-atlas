#!/usr/bin/env node
/**
 * bench/stress.js —— 单档压力测试：插入 N 条事件（含 claims/sources），
 * 量出库里实际占用字节数，并对 4 类查询打点，用于换算「多少 TB 时 500ms」。
 *
 *   node bench/stress.js --n=500000
 */
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    return m ? [m[1], m[2] ?? true] : [a, true]
  }),
)
const N = Number(argv.n || 100000)
const REPS = Number(argv.reps || 30)

const dir = await mkdtemp(path.join(os.tmpdir(), 'ha-stress-'))
process.env.PG_DATA_DIR = dir
process.env.ARCHIVE_DIR = path.join(dir, 'archive')

const gen = await import('./gen.js')
const { db, resetSchema } = await import('../src/db/client.js')
const timelineMod = await import('../src/api/timeline.js')
const searchMod = await import('../src/api/search.js')
const timeline = timelineMod.routes.find((r) => r[1] === '/api/timeline')[2]
const search = searchMod.routes.find((r) => r[1] === '/api/search')[2]

const now = () => Number(process.hrtime.bigint() / 1000000n)

function multiInsert(table, cols, rows) {
  const per = 300
  const parts = []
  const params = []
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per)
    const tuples = chunk.map((row, ri) => `(${row.map((_, ci) => `$${params.length + ri * cols.length + ci + 1}`).join(',')})`)
    parts.push(tuples.join(','))
    for (const row of chunk) params.push(...row)
  }
  return { sql: `INSERT INTO ${table} (${cols.join(',')}) VALUES ${parts.join(',')} RETURNING id`, params }
}

function stats(list) {
  const s = [...list].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) }
}

async function bench(fn, reps = REPS) {
  for (let i = 0; i < 3; i++) await fn()
  const t = []
  for (let i = 0; i < reps; i++) {
    const a = now()
    await fn()
    t.push(now() - a)
  }
  return stats(t)
}

async function dirBytes(d) {
  let total = 0
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) total += await dirBytes(p)
    else total += (await stat(p)).size
  }
  return total
}

console.log(`[stress] n=${N} dir=${dir}`)
await resetSchema()

const CLAIM_COLS = ['event_id', 'statement', 'evidence_level', 'confidence', 'disputed_group', 'adopted', 'rationale', 'sort_order']
const SOURCE_COLS = ['event_id', 'claim_id', 'source_slug', 'locator', 'quote', 'quote_sha256', 'verified_status', 'verified_at']

const t0 = now()
const BATCH = 500
let claims = 0
let sources = 0
for (let off = 0; off < N; off += BATCH) {
  const n = Math.min(BATCH, N - off)
  const evRows = gen.makeEventRows(off, n, N)
  const { sql, params } = multiInsert('event', gen.EVENT_COLS, evRows)
  const res = await db.query(sql, params)
  const evMeta = res.rows.map((r, k) => ({ id: r.id, idx: off + k }))

  const cRows = gen.makeClaimRows(evMeta)
  const claimIdsByEvent = new Map()
  if (cRows.length) {
    const c = multiInsert('event_claim', CLAIM_COLS, cRows)
    const cRes = await db.query(c.sql, c.params)
    cRows.forEach((row, i) => {
      const list = claimIdsByEvent.get(row[0]) || []
      list.push(cRes.rows[i].id)
      claimIdsByEvent.set(row[0], list)
    })
    claims += cRows.length
  }

  const sRows = gen.makeSourceRows(evMeta, claimIdsByEvent)
  if (sRows.length) {
    const s = multiInsert('event_source', SOURCE_COLS, sRows)
    await db.query(s.sql, s.params)
    sources += sRows.length
  }
  if ((off / BATCH) % 20 === 0) process.stdout.write(`\r  insert ${off + n}/${N}`)
}
const insertMs = now() - t0
const bytes = await dirBytes(dir)

const q = {
  w10: await bench(() => timeline({ query: { from: 1085, to: 1095 }, params: {} })),
  w100: await bench(() => timeline({ query: { from: 1000, to: 1100 }, params: {} })),
  wfull: await bench(() => timeline({ query: { from: -5000, to: 2025 }, params: {} })),
  search: await bench(() => search({ query: { q: '不存在的词zzz', limit: 20 }, params: {} })),
  searchZh: await bench(() => search({ query: { q: '纪事', limit: 20 }, params: {} })),
}

const out = {
  n: N,
  claims,
  sources,
  insertMs,
  bytes,
  kbPerEvent: +(bytes / N / 1024).toFixed(2),
  tb: +(bytes / 1024 ** 4).toFixed(6),
  q,
}
console.log('\n' + JSON.stringify(out, null, 2))
await rm(dir, { recursive: true, force: true })
process.exit(0)
