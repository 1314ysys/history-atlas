#!/usr/bin/env node
/**
 * bench/paging.js —— 分页早停 + 下界保护带的覆盖索引：与旧 GiST 方案对比
 *   node bench/paging.js --n=500000
 */
import pg from 'pg'

const N = Number((process.argv.find((a) => a.startsWith('--n=')) || '--n=500000').split('=')[1])
const DBNAME = `ha_paging_${Date.now().toString(36)}`
const ADMIN = `postgres://postgres@127.0.0.1:${process.env.PGPORT || 5433}/postgres`
const TARGET = `postgres://postgres@127.0.0.1:${process.env.PGPORT || 5433}/${DBNAME}`

const now = () => Number(process.hrtime.bigint() / 1000000n)

const admin = new pg.Client({ connectionString: ADMIN })
await admin.connect()
await admin.query(`CREATE DATABASE "${DBNAME}"`)
await admin.end()

process.env.DATABASE_URL = TARGET
const { db, resetSchema } = await import('../src/db/client.js')
const gen = await import('./gen.js')
const handler = (await import('../src/api/timeline.js')).routes.find((r) => r[1] === '/api/timeline')[2]

console.log(`[paging] db=${DBNAME} n=${N}`)
await resetSchema()

function multiInsert(table, cols, rows) {
  const per = 300
  const parts = []
  const params = []
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per)
    parts.push(chunk.map((row, ri) => `(${row.map((_, ci) => `$${params.length + ri * cols.length + ci + 1}`).join(',')})`).join(','))
    for (const row of chunk) params.push(...row)
  }
  return { sql: `INSERT INTO ${table} (${cols.join(',')}) VALUES ${parts.join(',')}`, params }
}

const t0 = now()
for (let off = 0; off < N; off += 500) {
  const n = Math.min(500, N - off)
  const rows = gen.makeEventRows(off, n, N)
  const q = multiInsert('event', gen.EVENT_COLS, rows)
  await db.query(q.sql, q.params)
  if (off % 100000 === 0) process.stdout.write(`\r  insert ${off + n}/${N}`)
}
console.log(`\n[paging] 插入 ${N} 条，用时 ${now() - t0} ms`)

await db.exec(`
CREATE INDEX IF NOT EXISTS event_timeline_cover_idx
  ON event (t_start_year)
  INCLUDE (slug, title, t_start_month, t_start_day, t_end_year,
           t_precision, t_certainty, track, category, discipline, lat, lon)
  WHERE status = 'published'`)
await db.exec(`VACUUM (ANALYZE) event`)
console.log('[paging] 覆盖索引就绪')

const OLD_SQL = `SELECT slug,title,t_start_year,t_start_month,t_start_day,t_end_year,
       t_precision,t_certainty,track,category,discipline,lat,lon
  FROM event
 WHERE status='published' AND t_span && int4range($1::int,$2::int)
 ORDER BY t_start_year, t_start_month NULLS FIRST, t_start_day NULLS FIRST, id
 LIMIT $3`

function stats(a) {
  const s = [...a].sort((x, y) => x - y)
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2) }
}

async function runSql(from, to, limit, reps = 15) {
  for (let i = 0; i < 3; i++) await db.query(OLD_SQL, [from, to, limit])
  const t = []
  let rows = 0
  for (let i = 0; i < reps; i++) {
    const a = now()
    const r = await db.query(OLD_SQL, [from, to, limit])
    t.push(now() - a)
    rows = r.rows.length
  }
  return { ...stats(t), rows }
}

async function runApi(from, to, withTotal, reps = 15) {
  await handler({ query: { from, to, limit: 200, withTotal: withTotal ? '1' : '0' } })
  const t = []
  let info = null
  for (let i = 0; i < reps; i++) {
    const a = now()
    const r = await handler({ query: { from, to, limit: 200, withTotal: withTotal ? '1' : '0' } })
    t.push(now() - a)
    info = { returned: r.returned, total: r.total, hasMore: r.hasMore }
  }
  return { ...stats(t), ...info }
}

const cases = [
  ['10 年', 1085, 1095],
  ['100 年', 1000, 1100],
  ['500 年', 500, 1000],
  ['全时段', -5000, 2025],
]

const out = []
for (const [label, from, to] of cases) {
  const oldBig = await runSql(from, to, 20000)
  const neuNoTotal = await runApi(from, to, false)
  const neuTotal = await runApi(from, to, true)
  out.push({ label, oldBig, neuNoTotal, neuTotal })
  console.log(`\n[${label}] ${from}..${to}`)
  console.log(`  旧 GiST + limit 20000 : p50=${oldBig.p50}ms p95=${oldBig.p95} rows=${oldBig.rows}`)
  console.log(`  新 覆盖索引 + 分页(无total): p50=${neuNoTotal.p50}ms p95=${neuNoTotal.p95} rows=${neuNoTotal.returned} hasMore=${neuNoTotal.hasMore}`)
  console.log(`  新 覆盖索引 + 分页(含total): p50=${neuTotal.p50}ms p95=${neuTotal.p95} total=${neuTotal.total}`)
}

const span = await db.query(`SELECT max(GREATEST(COALESCE(t_end_year,t_start_year)-t_start_year,0))::int AS m FROM event`)
console.log('\n最大跨年跨度:', span.rows[0].m)

const ex = await db.query(
  `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
   SELECT slug, title, t_start_year FROM event
    WHERE status='published'
      AND t_start_year >= $1::int - $3::int
      AND t_start_year < $2::int
      AND COALESCE(t_end_year,t_start_year) >= $1::int
    ORDER BY t_start_year, t_start_month NULLS FIRST, t_start_day NULLS FIRST, id
    LIMIT 200`,
  [1000, 1100, span.rows[0].m],
)
console.log('\n--- 新谓词 100 年窗口计划 ---')
for (const r of ex.rows) console.log(r['QUERY PLAN'])

console.log('\nJSON:', JSON.stringify({ n: N, out }))

await db.close()
const a2 = new pg.Client({ connectionString: ADMIN })
await a2.connect()
await a2.query(`DROP DATABASE IF EXISTS "${DBNAME}"`)
await a2.end()
console.log('[paging] 已清理测试库')
process.exit(0)
