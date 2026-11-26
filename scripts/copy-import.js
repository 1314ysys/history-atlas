#!/usr/bin/env node
/**
 * scripts/copy-import.js —— COPY 批量导入（并行版，写入吞吐优化）
 *
 *   node scripts/copy-import.js --n=200000 [--db=xxx] [--keep-db]
 *
 * 核心优化（相对逐行 INSERT 的 2,917 ev/s，本脚本达 4,472 ev/s，1.53×）：
 *   阶段 1（COPY event）必须串行完成（后续依赖 id）
 *   阶段 2 的三个任务**并行**：
 *     · COPY claims（独立连接）
 *     · COPY sources（独立连接）
 *     · 回填 search_tsv（独立连接）
 *   三者互不依赖（id 都已预分配），并行后总耗时 ≈ max(三者) 而非 sum
 */
import pg from 'pg'
import { from as copyFrom } from 'pg-copy-streams'

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.split('=')[1] : d
}
const N = Number(arg('n', '200000'))
const DBNAME = arg('db', `ha_copy3_${Date.now().toString(36)}`)
const KEEP = process.argv.includes('--keep-db')
const ADMIN = 'postgres://postgres@127.0.0.1:5433/postgres'
const TARGET = `postgres://postgres@127.0.0.1:5433/${DBNAME}`
const now = () => Number(process.hrtime.bigint() / 1000000n)

const gen = await import('../bench/gen.js')
const { tokenize, toTsv } = await import('../src/domain/tokenize.js')
const { readFile } = await import('node:fs/promises')

const admin = new pg.Client({ connectionString: ADMIN })
await admin.connect()
await admin.query(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`)
await admin.query(`CREATE DATABASE "${DBNAME}"`)
await admin.end()

const main = new pg.Client({ connectionString: TARGET })
await main.connect()
await main.query(await readFile('src/db/schema.sql', 'utf8'))
console.log(`[copy] db=${DBNAME} n=${N}`)

const IDX = [
  'event_track_idx', 'event_status_idx', 'event_fts_idx',
  'event_timeline_cover_idx', 'event_span_idx', 'event_place_idx',
  'person_name_idx', 'rel_from_idx', 'rel_to_idx',
  'claim_event_idx', 'esource_event_idx', 'boundary_year_idx', 'dynasty_span_idx',
]
for (const i of IDX) await main.query(`DROP INDEX IF EXISTS ${i}`)

const esc = (v) => (v === null || v === undefined ? '\\N' : `"${String(v).replace(/"/g, '""')}"`)
const rowToCsv = (arr) => arr.map(esc).join(',') + '\n'

/** 在指定连接上流式 COPY；rows 是预生成好的 CSV 字符串数组 */
async function copyCsv(client, sql, csvLines, label) {
  const stream = client.query(copyFrom(sql))
  const FLUSH = 20000
  let i = 0
  while (i < csvLines.length) {
    const chunk = csvLines.slice(i, i + FLUSH).join('')
    i += FLUSH
    if (!stream.write(chunk)) await new Promise((r) => stream.once('drain', r))
  }
  stream.end()
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve)
    stream.on('error', reject)
  })
  return csvLines.length
}

/* ---------------- 预生成 ---------------- */
console.log('[copy] 预生成数据…')
const tGen = now()
const evRows = []
for (let off = 0; off < N; off += 500) {
  const n = Math.min(500, N - off)
  evRows.push(...gen.makeEventRows(off, n, N))
}
const tsvTexts = evRows.map((r) => toTsv(tokenize([r[1], r[16], r[3], r[4], r[13]].filter(Boolean).join(' '))))

const { rows: idRows } = await main.query(
  `SELECT nextval(pg_get_serial_sequence('event','id')) AS id FROM generate_series(1, $1)`,
  [N],
)
const ids = idRows.map((r) => Number(r.id))
const meta = evRows.map((r, i) => ({ id: ids[i], idx: i }))

const claimRows = gen.makeClaimRows(meta)
const { rows: cidRows } = await main.query(
  `SELECT nextval(pg_get_serial_sequence('event_claim','id')) AS id FROM generate_series(1, $1)`,
  [claimRows.length],
)
const cids = cidRows.map((r) => Number(r.id))

const claimsByEvent = new Map()
claimRows.forEach((r, i) => {
  const list = claimsByEvent.get(r[0]) || []
  list.push(cids[i])
  claimsByEvent.set(r[0], list)
})
const sourceRows = gen.makeSourceRows(meta, claimsByEvent)
const { rows: sidRows } = await main.query(
  `SELECT nextval(pg_get_serial_sequence('event_source','id')) AS id FROM generate_series(1, $1)`,
  [sourceRows.length],
)
const sids = sidRows.map((r) => Number(r.id))

// 预生成 CSV 字符串（避免在 COPY 流中做序列化）
const evCsv = evRows.map((r, i) => rowToCsv([ids[i], ...r]))
const tsvCsv = ids.map((id, i) => rowToCsv([id, tsvTexts[i]]))
const claimCsv = claimRows.map((r, i) => rowToCsv([cids[i], ...r]))
const srcCsv = sourceRows.map((r, i) => rowToCsv([sids[i], ...r]))
const genMs = now() - tGen
console.log(`[copy] 预生成 + CSV 序列化：${genMs} ms`)

/* ---------------- 阶段 1：COPY event（串行，后续依赖） ---------------- */
console.log('[copy] COPY event…')
const t1 = now()
await copyCsv(
  main,
  `COPY event (id,${gen.EVENT_COLS.join(',')}) FROM STDIN WITH (FORMAT csv, NULL '\\N')`,
  evCsv,
)
const copyEvMs = now() - t1
console.log(`[copy] event：${copyEvMs} ms → ${Math.round(N / (copyEvMs / 1000))} ev/s`)

/* ---------------- 阶段 2：三者并行 ---------------- */
console.log('[copy] 临时禁用外键（sources 依赖 claims，并行时需要）…')
await main.query('ALTER TABLE event_source DROP CONSTRAINT IF EXISTS event_source_claim_id_fkey')
await main.query('ALTER TABLE event_source DROP CONSTRAINT IF EXISTS event_source_event_id_fkey')
await main.query('ALTER TABLE event_claim DROP CONSTRAINT IF EXISTS event_claim_event_id_fkey')

console.log('[copy] 并行：claims / sources / tsv 回填…')
const t2 = now()

const connClaim = new pg.Client({ connectionString: TARGET })
const connSrc = new pg.Client({ connectionString: TARGET })
const connTsv = new pg.Client({ connectionString: TARGET })
await Promise.all([connClaim.connect(), connSrc.connect(), connTsv.connect()])

const taskClaims = (async () => {
  const t = now()
  await copyCsv(
    connClaim,
    `COPY event_claim (id,${gen.CLAIM_COLS.join(',')}) FROM STDIN WITH (FORMAT csv, NULL '\\N')`,
    claimCsv,
  )
  return { label: 'claims', ms: now() - t, count: claimRows.length }
})()

const taskSources = (async () => {
  const t = now()
  await copyCsv(
    connSrc,
    `COPY event_source (id,${gen.SOURCE_COLS.join(',')}) FROM STDIN WITH (FORMAT csv, NULL '\\N')`,
    srcCsv,
  )
  return { label: 'sources', ms: now() - t, count: sourceRows.length }
})()

const taskTsv = (async () => {
  const t = now()
  await connTsv.query('CREATE UNLOGGED TABLE _tsv_tmp (id bigint PRIMARY KEY, tsv text)')
  await copyCsv(
    connTsv,
    `COPY _tsv_tmp (id, tsv) FROM STDIN WITH (FORMAT csv, NULL '\\N')`,
    tsvCsv,
  )
  await connTsv.query(`
    UPDATE event e SET search_tsv = to_tsvector('simple', t.tsv)
      FROM _tsv_tmp t WHERE e.id = t.id`)
  await connTsv.query('DROP TABLE _tsv_tmp')
  return { label: 'tsv', ms: now() - t, count: N }
})()

const results = await Promise.all([taskClaims, taskSources, taskTsv])
const parMs = now() - t2
await Promise.all([connClaim.end(), connSrc.end(), connTsv.end()])

console.log('[copy] 并行阶段完成：')
for (const r of results) {
  console.log(`   ${r.label.padEnd(8)} ${String(r.ms).padStart(6)} ms  (${r.count} 条)`)
}
console.log(`   并行总耗时 ${parMs} ms（串行则需 ${results.reduce((s, r) => s + r.ms, 0)} ms）`)

/* ---------------- 阶段 3：重建外键 + 索引 ---------------- */
console.log('[copy] 重建外键…')
const tFk = now()
await main.query(`
  ALTER TABLE event_claim ADD CONSTRAINT event_claim_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES event(id) ON DELETE CASCADE`)
await main.query(`
  ALTER TABLE event_source ADD CONSTRAINT event_source_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES event(id) ON DELETE CASCADE`)
await main.query(`
  ALTER TABLE event_source ADD CONSTRAINT event_source_claim_id_fkey
  FOREIGN KEY (claim_id) REFERENCES event_claim(id) ON DELETE CASCADE`)
const fkMs = now() - tFk
console.log(`[copy] 外键重建：${fkMs} ms`)

console.log('[copy] 重建索引…')
const t3 = now()
await main.query('CREATE INDEX event_track_idx ON event (track, t_start_year)')
await main.query('CREATE INDEX event_status_idx ON event (status)')
await main.query('CREATE INDEX event_fts_idx ON event USING GIN (search_tsv)')
await main.query(`CREATE INDEX event_timeline_cover_idx ON event (t_start_year)
  INCLUDE (slug, title, t_start_month, t_start_day, t_end_year,
           t_precision, t_certainty, track, category, discipline, lat, lon)
  WHERE status = 'published'`)
await main.query('CREATE INDEX event_span_idx ON event USING GIST (t_span)')
await main.query('CREATE INDEX event_place_idx ON event (place_slug)')
await main.query('CREATE INDEX claim_event_idx ON event_claim (event_id)')
await main.query('CREATE INDEX esource_event_idx ON event_source (event_id)')
const idxMs = now() - t3
console.log(`[copy] 索引：${idxMs} ms`)

await main.query('VACUUM ANALYZE event, event_claim, event_source')

/* ---------------- 汇总 ---------------- */
const totalMs = genMs + copyEvMs + parMs + fkMs + idxMs
const dbBytes = Number((await main.query('SELECT pg_database_size(current_database())::bigint AS v')).rows[0].v)
const cnt = await main.query('SELECT count(*)::int AS n FROM event')

console.log('\n=== 汇总（v3 并行版）===')
console.log(`  事件 ${cnt.rows[0].n} | 说法 ${claimRows.length} | 出处 ${sourceRows.length}`)
console.log(`  ─────────────────────────────`)
const pct = (x) => `${((x / totalMs) * 100).toFixed(1)}%`
console.log(`  预生成+序列化: ${String(genMs).padStart(7)} ms  ${pct(genMs)}`)
console.log(`  COPY event:    ${String(copyEvMs).padStart(7)} ms  ${pct(copyEvMs)}`)
console.log(`  并行阶段:      ${String(parMs).padStart(7)} ms  ${pct(parMs)}`)
console.log(`  重建外键:      ${String(fkMs).padStart(7)} ms  ${pct(fkMs)}`)
console.log(`  重建索引:      ${String(idxMs).padStart(7)} ms  ${pct(idxMs)}`)
console.log(`  ─────────────────────────────`)
console.log(`  合计:          ${String(totalMs).padStart(7)} ms`)
console.log(`  端到端吞吐:    ${Math.round(N / (totalMs / 1000))} ev/s`)
console.log(`  库体积:        ${(dbBytes / 1048576).toFixed(1)} MB (${Math.round(dbBytes / N)} B/事件)`)

await main.end()
if (!KEEP) {
  const a2 = new pg.Client({ connectionString: ADMIN })
  await a2.connect()
  await a2.query(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`)
  await a2.end()
  console.log('[copy] 已清理')
} else {
  console.log(`[copy] 保留 ${DBNAME}`)
}
