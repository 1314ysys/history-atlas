#!/usr/bin/env node
/**
 * scripts/copy-import-parallel.js —— COPY 导入 + worker_threads 并行预生成
 *
 *   node scripts/copy-import-parallel.js --n=200000 [--workers=4] [--db=xxx] [--keep-db]
 *
 * 相对 copy-import.js（v3，4,472 ev/s）的优化：
 *   预生成 + CSV 序列化从 37% 的时间占比降到 ~10%
 *   方法：把「生成事件/说法/出处 + CSV 序列化」按事件区间切给 N 个 worker 并行，
 *         主线程只负责预分配 id、收集结果、执行 COPY。
 *
 * id 分配策略：
 *   按上限预分配（event = N，claim = N×3，source = N×2），
 *   每个 worker 分到独立的 id 段，避免跨 worker 协调。
 *   实际用不满的部分会在序列里留下空洞——id 只需唯一，不影响正确性。
 */
import pg from 'pg'
import { from as copyFrom } from 'pg-copy-streams'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.split('=')[1] : d
}
const N = Number(arg('n', '200000'))
const WORKERS = Math.max(1, Math.min(Number(arg('workers', '4')), 16))
const DBNAME = arg('db', `ha_par_${Date.now().toString(36)}`)
const KEEP = process.argv.includes('--keep-db')
const ADMIN = 'postgres://postgres@127.0.0.1:5433/postgres'
const TARGET = `postgres://postgres@127.0.0.1:5433/${DBNAME}`
const now = () => Number(process.hrtime.bigint() / 1000000n)

const gen = await import('../bench/gen.js')

/* ---------------- 建库 ---------------- */
const admin = new pg.Client({ connectionString: ADMIN })
await admin.connect()
await admin.query(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`)
await admin.query(`CREATE DATABASE "${DBNAME}"`)
await admin.end()

const main = new pg.Client({ connectionString: TARGET })
await main.connect()
await main.query(await readFile('src/db/schema.sql', 'utf8'))
console.log(`[par] db=${DBNAME} n=${N} workers=${WORKERS}`)

const IDX = [
  'event_track_idx', 'event_status_idx', 'event_fts_idx',
  'event_timeline_cover_idx', 'event_span_idx', 'event_place_idx',
  'person_name_idx', 'rel_from_idx', 'rel_to_idx',
  'claim_event_idx', 'esource_event_idx', 'boundary_year_idx', 'dynasty_span_idx',
]
for (const i of IDX) await main.query(`DROP INDEX IF EXISTS ${i}`)

/* ---------------- 预分配 id ---------------- */
const tId = now()
/**
 * 批量分配 id 区间。
 *
 * 不用 `SELECT nextval(...) FROM generate_series(1, N)`——实测 120 万次 nextval
 * 要 10.2 秒（每次都要写 WAL）。改用「读 last_value → setval 推进」一次搞定，
 * 代价是可能与其他写入方抢号，导入场景可接受。
 */
async function allocIdRange(seqTable, count) {
  const { rows: seqRows } = await main.query(
    `SELECT pg_get_serial_sequence($1, 'id') AS seq`,
    [seqTable],
  )
  const seq = seqRows[0].seq
  const { rows } = await main.query(`SELECT last_value, is_called FROM ${seq}`)
  const last = Number(rows[0].last_value)
  const start = rows[0].is_called ? last + 1 : last
  const end = start + count - 1
  await main.query(`SELECT setval($1, $2, true)`, [seq, end])
  const arr = new Array(count)
  for (let i = 0; i < count; i++) arr[i] = start + i
  return arr
}

const CLAIM_PER_EVENT = 3 // gen.js 的上限
const SOURCE_PER_EVENT = 2
const allEvIds = await allocIdRange('event', N)
const allClaimIds = await allocIdRange('event_claim', N * CLAIM_PER_EVENT)
const allSourceIds = await allocIdRange('event_source', N * SOURCE_PER_EVENT)
const idMs = now() - tId
console.log(`[par] 预分配 id：${idMs} ms（event ${N}, claim ${N * CLAIM_PER_EVENT}, source ${N * SOURCE_PER_EVENT}）`)

/* ---------------- 切分区间 ---------------- */
const chunkSize = Math.ceil(N / WORKERS)
const chunks = []
for (let i = 0; i < WORKERS; i++) {
  const start = i * chunkSize
  if (start >= N) break
  const count = Math.min(chunkSize, N - start)
  chunks.push({
    idx: i,
    start,
    count,
    evIds: allEvIds.slice(start, start + count),
    claimIds: allClaimIds.slice(start * CLAIM_PER_EVENT, (start + count) * CLAIM_PER_EVENT),
    sourceIds: allSourceIds.slice(start * SOURCE_PER_EVENT, (start + count) * SOURCE_PER_EVENT),
  })
}

/* ---------------- 并行生成 ---------------- */
console.log(`[par] 启动 ${chunks.length} 个 worker 并行生成…`)
const tGen = now()
const workerPath = path.join(HERE, 'gen-worker.mjs')

const results = await Promise.all(
  chunks.map(
    (ch) =>
      new Promise((resolve, reject) => {
        const w = new Worker(workerPath, {
          workerData: {
            startIdx: ch.start,
            count: ch.count,
            total: N,
            evIds: ch.evIds,
            claimIds: ch.claimIds,
            sourceIds: ch.sourceIds,
          },
        })
        w.once('message', resolve)
        w.once('error', reject)
        w.once('exit', (code) => {
          if (code !== 0) reject(new Error(`worker ${ch.idx} 退出码 ${code}`))
        })
      }),
  ),
)
const genMs = now() - tGen

// 按 chunk 顺序拼接
const evCsv = []
const claimCsv = []
const sourceCsv = []
let claimsTotal = 0
let sourcesTotal = 0
for (const r of results) {
  evCsv.push(...r.evCsv)
  claimCsv.push(...r.claimCsv)
  sourceCsv.push(...r.sourceCsv)
  claimsTotal += r.claimsUsed
  sourcesTotal += r.sourcesUsed
}
console.log(`[par] 生成完成：${genMs} ms（${claimsTotal} 说法 / ${sourcesTotal} 出处）`)

/* ---------------- COPY ---------------- */
async function copyCsv(client, sql, lines) {
  const stream = client.query(copyFrom(sql))
  const FLUSH = 20000
  let i = 0
  while (i < lines.length) {
    const chunk = lines.slice(i, i + FLUSH).join('')
    i += FLUSH
    if (!stream.write(chunk)) await new Promise((r) => stream.once('drain', r))
  }
  stream.end()
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve)
    stream.on('error', reject)
  })
}

console.log('[par] COPY event…')
const t1 = now()
await copyCsv(
  main,
  `COPY event (id,${gen.EVENT_COLS.join(',')},search_tsv) FROM STDIN WITH (FORMAT csv, NULL '\\N')`,
  evCsv,
)
const copyEvMs = now() - t1
console.log(`[par] event：${copyEvMs} ms → ${Math.round(N / (copyEvMs / 1000))} ev/s`)

/* ---------------- 并行 claims / sources / tsv ---------------- */
console.log('[par] 临时禁用外键…')
await main.query('ALTER TABLE event_source DROP CONSTRAINT IF EXISTS event_source_claim_id_fkey')
await main.query('ALTER TABLE event_source DROP CONSTRAINT IF EXISTS event_source_event_id_fkey')
await main.query('ALTER TABLE event_claim DROP CONSTRAINT IF EXISTS event_claim_event_id_fkey')

console.log('[par] 并行 COPY claims / sources…')
const t2 = now()
const connClaim = new pg.Client({ connectionString: TARGET })
const connSrc = new pg.Client({ connectionString: TARGET })
await Promise.all([connClaim.connect(), connSrc.connect()])

const [claimsRes, sourcesRes] = await Promise.all([
  (async () => {
    const t = now()
    await copyCsv(
      connClaim,
      `COPY event_claim (id,${gen.CLAIM_COLS.join(',')}) FROM STDIN WITH (FORMAT csv, NULL '\\N')`,
      claimCsv,
    )
    return now() - t
  })(),
  (async () => {
    const t = now()
    await copyCsv(
      connSrc,
      `COPY event_source (id,${gen.SOURCE_COLS.join(',')}) FROM STDIN WITH (FORMAT csv, NULL '\\N')`,
      sourceCsv,
    )
    return now() - t
  })(),
])
const parMs = now() - t2
await Promise.all([connClaim.end(), connSrc.end()])
console.log(`[par] claims ${claimsRes} ms / sources ${sourcesRes} ms → 并行 ${parMs} ms`)

/* ---------------- 外键 + 索引 ---------------- */
console.log('[par] 重建外键…')
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
console.log(`[par] 外键：${fkMs} ms`)

console.log('[par] 重建索引…')
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
console.log(`[par] 索引：${idxMs} ms`)

await main.query('VACUUM ANALYZE event, event_claim, event_source')

// 正确性校验：search_tsv 不能为空，且 tsquery 能命中
const nullTsv = await main.query('SELECT count(*)::int AS n FROM event WHERE search_tsv IS NULL')
const tsvHit = await main.query(
  `SELECT count(*)::int AS n FROM event WHERE search_tsv @@ to_tsquery('simple', $1)`,
  ['水运 & 运仪'],
)
console.log(
  `[par] search_tsv NULL: ${nullTsv.rows[0].n} 条（应为 0）| tsquery 命中: ${tsvHit.rows[0].n} 条`,
)

/* ---------------- 汇总 ---------------- */
const totalMs = idMs + genMs + copyEvMs + parMs + fkMs + idxMs
const dbBytes = Number((await main.query('SELECT pg_database_size(current_database())::bigint AS v')).rows[0].v)
const cnt = await main.query('SELECT count(*)::int AS n FROM event')

console.log('\n=== 汇总（并行预生成版）===')
console.log(`  事件 ${cnt.rows[0].n} | 说法 ${claimsTotal} | 出处 ${sourcesTotal}`)
console.log(`  ─────────────────────────────`)
const pct = (x) => `${((x / totalMs) * 100).toFixed(1)}%`
console.log(`  预分配 id:      ${String(idMs).padStart(7)} ms  ${pct(idMs)}`)
console.log(`  并行预生成:     ${String(genMs).padStart(7)} ms  ${pct(genMs)}`)
console.log(`  COPY event:     ${String(copyEvMs).padStart(7)} ms  ${pct(copyEvMs)}`)
console.log(`  并行 c/s:       ${String(parMs).padStart(7)} ms  ${pct(parMs)}`)
console.log(`  重建外键:       ${String(fkMs).padStart(7)} ms  ${pct(fkMs)}`)
console.log(`  重建索引:       ${String(idxMs).padStart(7)} ms  ${pct(idxMs)}`)
console.log(`  ─────────────────────────────`)
console.log(`  合计:           ${String(totalMs).padStart(7)} ms`)
console.log(`  端到端吞吐:     ${Math.round(N / (totalMs / 1000))} ev/s`)
console.log(`  库体积:         ${(dbBytes / 1048576).toFixed(1)} MB (${Math.round(dbBytes / N)} B/事件)`)

await main.end()
if (!KEEP) {
  const a2 = new pg.Client({ connectionString: ADMIN })
  await a2.connect()
  await a2.query(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`)
  await a2.end()
  console.log('[par] 已清理')
} else {
  console.log(`[par] 保留 ${DBNAME}`)
}
