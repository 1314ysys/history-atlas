#!/usr/bin/env node
/**
 * scripts/add-covering-index.js —— 给 event 加时间轴覆盖索引（可重复执行）
 * 加完 VACUUM ANALYZE，并打印 EXPLAIN 证明走了 Index Only Scan。
 */
import { db } from '../src/db/client.js'

const t0 = Date.now()
console.log(`[idx] 模式：${db.mode()}`)

await db.exec(`
CREATE INDEX IF NOT EXISTS event_timeline_cover_idx
  ON event (t_start_year)
  INCLUDE (slug, title, t_start_month, t_start_day, t_end_year,
           t_precision, t_certainty, track, category, discipline, lat, lon)
  WHERE status = 'published'
`)
console.log(`[idx] 索引就绪，用时 ${Date.now() - t0} ms`)

await db.exec(`VACUUM (ANALYZE) event`)
console.log('[idx] VACUUM ANALYZE 完成')

for (const [label, from, to] of [['100 年', 1000, 1100], ['10 年', 1085, 1095]]) {
  const ex = await db.query(
    `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
     SELECT slug, title, t_start_year, t_start_month, t_start_day, t_end_year,
            t_precision, t_certainty, track, category, discipline, lat, lon
       FROM event
      WHERE status = 'published' AND t_span && int4range($1::int, $2::int)
      ORDER BY t_start_year, t_start_month NULLS FIRST, t_start_day NULLS FIRST, id
      LIMIT 200`,
    [from, to],
  )
  console.log(`[idx] ${label} EXPLAIN：`)
  for (const r of ex.rows) console.log('   ', r['QUERY PLAN'])
}

const size = await db.query(
  `SELECT pg_size_pretty(pg_relation_size('event_timeline_cover_idx')) AS s`,
)
console.log(`[idx] 覆盖索引体积：${size.rows[0].s}`)
await db.close()
