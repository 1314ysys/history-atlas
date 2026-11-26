#!/usr/bin/env node
/**
 * bench/shard-verify.js —— 用已就位的 3 个分片实例（5441/5442/5443）
 * 对比「单库 30 万」vs「3 分片各 10 万」的查询表现。
 *
 *   node bench/shard-verify.js
 *
 * 前置：scripts/shard-proto.js 已建好 3 个分片实例并各灌 10 万条。
 * 本脚本会临时建一个 30 万行的单库做对照，跑完 DROP。
 */
import pg from 'pg'

const ADMIN = 'postgres://postgres@127.0.0.1:5433/postgres'
const SINGLE_DB = `ha_shard_cmp_${Date.now().toString(36)}`
const SINGLE = `postgres://postgres@127.0.0.1:5433/${SINGLE_DB}`
const SHARDS = [
  { url: 'postgres://postgres@127.0.0.1:5441/history_atlas', from: -5000, to: 500, idx: 0 },
  { url: 'postgres://postgres@127.0.0.1:5442/history_atlas', from: 500, to: 1500, idx: 1 },
  { url: 'postgres://postgres@127.0.0.1:5443/history_atlas', from: 1500, to: 3000, idx: 2 },
]

const now = () => Number(process.hrtime.bigint() / 1000000n)
const stats = (a) => {
  const s = [...a].sort((x, y) => x - y)
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2) }
}

const COLS = `slug, title, t_start_year, t_end_year, t_start_month, t_start_day,
  t_precision, t_certainty, track, category, discipline, lat, lon`

/** 分页早停 + 下界保护带的谓词（与生产一致） */
const buildSql = (span) => `SELECT ${COLS}
  FROM event
 WHERE status = 'published'
   AND t_start_year >= $1::int - $3::int
   AND t_start_year < $2::int
   AND COALESCE(t_end_year, t_start_year) >= $1::int
 ORDER BY t_start_year, t_start_month NULLS FIRST, t_start_day NULLS FIRST, id
 LIMIT 200`

const MAX_SPAN = 250 // 与 gen.js 的跨年跨度上限一致

async function benchSingle(client, from, to, reps = 20) {
  const sql = buildSql()
  for (let i = 0; i < 3; i++) await client.query(sql, [from, to, MAX_SPAN])
  const t = []
  let rows = 0
  for (let i = 0; i < reps; i++) {
    const a = now()
    const r = await client.query(sql, [from, to, MAX_SPAN])
    t.push(now() - a)
    rows = r.rows.length
  }
  return { ...stats(t), rows }
}

async function benchShards(clients, from, to, reps = 20) {
  const targets = SHARDS.filter((s) => s.to > from && s.from < to)
  const sql = buildSql()
  const run = async () => {
    const a = now()
    const parts = await Promise.all(
      targets.map((s) => clients[s.idx].query(sql, [from, to, MAX_SPAN])),
    )
    const merged = parts.flatMap((p) => p.rows).sort(
      (x, y) =>
        x.t_start_year - y.t_start_year ||
        (x.t_start_month ?? 0) - (y.t_start_month ?? 0) ||
        (x.t_start_day ?? 0) - (y.t_start_day ?? 0),
    )
    return { ms: now() - a, rows: Math.min(200, merged.length) }
  }
  for (let i = 0; i < 3; i++) await run()
  const t = []
  let rows = 0
  for (let i = 0; i < reps; i++) {
    const r = await run()
    t.push(r.ms)
    rows = r.rows
  }
  return { ...stats(t), rows, shards: targets.length }
}

/* ---------------- 建单库对照 ---------------- */

const admin = new pg.Client({ connectionString: ADMIN })
await admin.connect()
await admin.query(`CREATE DATABASE "${SINGLE_DB}"`)
await admin.end()

const single = new pg.Client({ connectionString: SINGLE })
await single.connect()
const { readFile } = await import('node:fs/promises')
const ddl = await readFile('src/db/schema.sql', 'utf8')
await single.query(ddl)
// 从 3 个分片汇总全部 30 万行
console.log('[verify] 汇总 3 个分片到单库…')
const COLS_ALL = `slug, title, track, category, discipline,
  t_start_year, t_start_month, t_start_day, t_end_year, t_end_month, t_end_day,
  t_precision, t_certainty, place_slug, lat, lon, summary, search_text, status, rev`
for (const s of SHARDS) {
  const c = new pg.Client({ connectionString: s.url })
  await c.connect()
  const { rows } = await c.query(`SELECT ${COLS_ALL} FROM event`)
  await c.end()
  const per = 200
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per)
    const cols = COLS_ALL.split(',').map((x) => x.trim())
    const parts = []
    const params = []
    for (const row of chunk) {
      const slots = cols.map((_, ci) => `$${params.length + ci + 1}`)
      parts.push(`(${slots.join(',')})`)
      for (const c2 of cols) params.push(row[c2])
    }
    await single.query(`INSERT INTO event (${cols.join(',')}) VALUES ${parts.join(',')}`, params)
  }
  process.stdout.write(`\r  ${s.idx} done`)
}
console.log('')
await single.query('VACUUM (ANALYZE) event')
const cnt = await single.query('SELECT count(*)::int AS n FROM event')
console.log('[verify] 单库行数:', cnt.rows[0].n)

const clients = {}
for (const s of SHARDS) {
  const c = new pg.Client({ connectionString: s.url })
  await c.connect()
  clients[s.idx] = c
}

/* ---------------- 对比 ---------------- */

const cases = [
  ['10 年', 1000, 1010],
  ['100 年', 1000, 1100],
  ['500 年', 500, 1000],
  ['全时段', -5000, 2025],
]

const out = []
for (const [label, from, to] of cases) {
  const a = await benchSingle(single, from, to)
  const b = await benchShards(clients, from, to)
  out.push({ label, from, to, single: a, shards: b })
  const speedup = (a.p50 / b.p50).toFixed(2)
  console.log(`\n[${label}] ${from}..${to}`)
  console.log(`  单库 30万 : p50=${a.p50}ms p95=${a.p95} rows=${a.rows}`)
  console.log(`  3 分片    : p50=${b.p50}ms p95=${b.p95} rows=${b.rows} (扇出 ${b.shards} 片)  倍率 ${speedup}x`)
}

/* ---------------- 清理 ---------------- */
for (const c of Object.values(clients)) await c.end()
await single.end()
const a2 = new pg.Client({ connectionString: ADMIN })
await a2.connect()
await a2.query(`DROP DATABASE IF EXISTS "${SINGLE_DB}" WITH (FORCE)`)
await a2.end()

console.log('\nJSON:', JSON.stringify({ out }))
console.log('[verify] 已清理单库对照，3 个分片实例保留')
process.exit(0)
