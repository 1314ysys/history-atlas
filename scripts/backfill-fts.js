#!/usr/bin/env node
/**
 * scripts/backfill-fts.js —— 给已有 event 行补 search_tsv 并建 GIN 索引。
 * 不删库、不重灌，可与运行中的服务并存（列可空，旧进程不受影响）。
 *
 *   node scripts/backfill-fts.js
 */
import { db } from '../src/db/client.js'
import { tokenize, toTsv } from '../src/domain/tokenize.js'

const t0 = Date.now()
console.log(`[fts] 模式：${db.mode()}`)

await db.exec(`ALTER TABLE event ADD COLUMN IF NOT EXISTS search_tsv TSVECTOR`)
console.log('[fts] 列已就绪')

const { rows } = await db.query(
  `SELECT id, title, summary, category, discipline, place_slug FROM event ORDER BY id`,
)
console.log(`[fts] 待回填 ${rows.length} 行`)

let done = 0
for (const r of rows) {
  const text = [r.title, r.summary, r.category, r.discipline, r.place_slug]
    .filter(Boolean)
    .join(' ')
  const tsv = toTsv(tokenize(text))
  await db.query(`UPDATE event SET search_tsv = to_tsvector('simple', $1) WHERE id = $2`, [tsv, r.id])
  done++
  if (done % 200 === 0) process.stdout.write(`\r  ${done}/${rows.length}`)
}

await db.exec(`CREATE INDEX IF NOT EXISTS event_fts_idx ON event USING GIN (search_tsv)`)
console.log(`\n[fts] 索引已就绪，用时 ${Date.now() - t0} ms`)

const chk = await db.query(
  `SELECT count(*)::int AS total,
          count(search_tsv)::int AS filled
     FROM event`,
)
console.log(`[fts] 行数 ${chk.rows[0].total}，已回填 ${chk.rows[0].filled}`)

const ex = await db.query(
  `EXPLAIN (ANALYZE, COSTS OFF) SELECT slug FROM event
    WHERE status='published' AND search_tsv @@ to_tsquery('simple', $1) LIMIT 20`,
  ['水运 & 运仪 & 仪象 & 象台'],
)
console.log('[fts] EXPLAIN 水运仪象台：')
for (const r of ex.rows) console.log('   ', r['QUERY PLAN'])

await db.close()
