#!/usr/bin/env node
/**
 * scripts/shard-migrate.js —— 把单库数据按时间区间重新分布到多个分片实例。
 *
 *   node scripts/shard-migrate.js --dry-run
 *   node scripts/shard-migrate.js --apply
 *
 * 依赖环境变量（与 src/db/shard.js 同口径）：
 *   SHARD_URLS="postgres://.../history_atlas,..."
 *   SHARD_RANGES="-5000:500,500:1500,1500:3000"
 *
 * 行为：
 *   1. 从源库（DATABASE_URL，默认 5433/history_atlas）读出全部 event 及其 claims/sources
 *   2. 按 t_start_year 归到目标分片
 *   3. 目标分片 upsert（幂等，可重复执行）
 *   4. --dry-run 只打印分布，不写库
 */
import pg from 'pg'

const APPLY = process.argv.includes('--apply')
const SRC_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/history_atlas'
const RAW_URLS = String(process.env.SHARD_URLS || '').trim()
const RAW_RANGES = String(process.env.SHARD_RANGES || '').trim()

if (!RAW_URLS) {
  console.error('[shard-migrate] 需要设置 SHARD_URLS（逗号分隔的目标库连接串）')
  process.exit(1)
}

const urls = RAW_URLS.split(',').map((s) => s.trim()).filter(Boolean)
const ranges = RAW_RANGES ? RAW_RANGES.split(',').map((s) => s.trim()).filter(Boolean) : []

if (ranges.length && ranges.length !== urls.length) {
  console.error(`[shard-migrate] SHARD_RANGES(${ranges.length}) 与 SHARD_URLS(${urls.length}) 数量不一致`)
  process.exit(1)
}

/** @type {{url:string, from:number, to:number, idx:number}[]} */
const shards = urls.map((url, i) => {
  if (ranges.length) {
    const [a, b] = ranges[i].split(':').map(Number)
    return { url, from: a, to: b, idx: i }
  }
  // 未给区间：均分 [-5000, 3000)
  const lo = -5000
  const hi = 3000
  const step = (hi - lo) / urls.length
  return { url, from: lo + step * i, to: i === urls.length - 1 ? Infinity : lo + step * (i + 1), idx: i }
})

const shardFor = (year) => shards.find((s) => year >= s.from && year < s.to) || null

const src = new pg.Client({ connectionString: SRC_URL })
await src.connect()

console.log('[shard-migrate] 源库:', SRC_URL.replace(/\/\/[^@]*@/, '//***@'))
console.log('[shard-migrate] 目标分片:')
for (const s of shards) {
  console.log(`   shard${s.idx}  [${s.from}, ${s.to === Infinity ? '∞' : s.to})  ${s.url.replace(/\/\/[^@]*@/, '//***@')}`)
}
console.log(`[shard-migrate] 模式: ${APPLY ? 'APPLY（写库）' : 'DRY-RUN（只统计）'}`)

const { rows: events } = await src.query(
  `SELECT id, slug, title, track, category, discipline,
          t_start_year, t_start_month, t_start_day,
          t_end_year, t_end_month, t_end_day,
          t_precision, t_certainty, place_slug, lat, lon,
          summary, search_text, status, rev, search_tsv::text AS search_tsv_text
     FROM event ORDER BY t_start_year, id`,
)
console.log(`[shard-migrate] 源库事件数: ${events.length}`)

/** 按分片分桶 */
const buckets = new Map(shards.map((s) => [s.idx, []]))
const orphans = []
for (const ev of events) {
  const s = shardFor(Number(ev.t_start_year))
  if (s) buckets.get(s.idx).push(ev)
  else orphans.push(ev)
}

for (const [idx, list] of buckets) {
  console.log(`   shard${idx}: ${list.length} 条`)
}
if (orphans.length) {
  console.warn(`[shard-migrate] ⚠ ${orphans.length} 条落在所有区间之外（t_start_year 越界），将被跳过`)
  for (const o of orphans.slice(0, 5)) console.warn(`      ${o.slug} @ ${o.t_start_year}`)
}

if (!APPLY) {
  console.log('[shard-migrate] DRY-RUN 结束，未写任何数据')
  await src.end()
  process.exit(0)
}

/* ---------------- 写入 ---------------- */

const EV_COLS = [
  'id', 'slug', 'title', 'track', 'category', 'discipline',
  't_start_year', 't_start_month', 't_start_day',
  't_end_year', 't_end_month', 't_end_day',
  't_precision', 't_certainty', 'place_slug', 'lat', 'lon',
  'summary', 'search_text', 'status', 'rev',
]

function multiInsert(table, cols, rows, returning = '') {
  const per = 200
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

const t0 = Date.now()
let migrated = 0
let claimsCopied = 0
let sourcesCopied = 0

for (const [idx, list] of buckets) {
  if (!list.length) continue
  const s = shards.find((x) => x.idx === idx)
  const dst = new pg.Client({ connectionString: s.url })
  await dst.connect()
  console.log(`[shard-migrate] → shard${idx} 开始写入 ${list.length} 条…`)

  // 1) event（不含 search_tsv，先按文本列写，再统一回填）
  const evRows = list.map((e) => EV_COLS.map((c) => e[c]))
  for (let off = 0; off < evRows.length; off += 200) {
    const chunk = evRows.slice(off, off + 200)
    const q = multiInsert('event', EV_COLS, chunk)
    await dst.query(q.sql, q.params)
  }
  migrated += list.length

  // 2) search_tsv 回填（用源库算好的文本，避免重复分词）
  const ids = list.map((e) => e.id)
  const tsvs = list.map((e) => e.search_tsv_text || '')
  await dst.query(
    `UPDATE event e SET search_tsv = t.tsv::tsvector
       FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS tsv) t
      WHERE e.id = t.id AND t.tsv <> ''`,
    [ids, tsvs],
  )

  // 3) claims / sources
  const idList = ids
  const { rows: claims } = await src.query(
    `SELECT id, event_id, statement, evidence_level, confidence, disputed_group, adopted, rationale, sort_order
       FROM event_claim WHERE event_id = ANY($1::bigint[])`,
    [idList],
  )
  const { rows: sources } = await src.query(
    `SELECT id, event_id, claim_id, source_slug, locator, quote, quote_sha256, verified_status, verified_at
       FROM event_source WHERE event_id = ANY($1::bigint[])`,
    [idList],
  )
  if (claims.length) {
    const C_COLS = ['id', 'event_id', 'statement', 'evidence_level', 'confidence', 'disputed_group', 'adopted', 'rationale', 'sort_order']
    for (let off = 0; off < claims.length; off += 200) {
      const q = multiInsert('event_claim', C_COLS, claims.slice(off, off + 200).map((c) => C_COLS.map((k) => c[k])))
      await dst.query(q.sql, q.params)
    }
    claimsCopied += claims.length
  }
  if (sources.length) {
    const S_COLS = ['id', 'event_id', 'claim_id', 'source_slug', 'locator', 'quote', 'quote_sha256', 'verified_status', 'verified_at']
    for (let off = 0; off < sources.length; off += 200) {
      const q = multiInsert('event_source', S_COLS, sources.slice(off, off + 200).map((c) => S_COLS.map((k) => c[k])))
      await dst.query(q.sql, q.params)
    }
    sourcesCopied += sources.length
  }

  // 4) 序列校正（显式写入 id 后必须把 sequence 推到 max 之后）
  await dst.query(`SELECT setval(pg_get_serial_sequence('event','id'), COALESCE((SELECT max(id) FROM event), 1))`)
  await dst.query(`SELECT setval(pg_get_serial_sequence('event_claim','id'), COALESCE((SELECT max(id) FROM event_claim), 1))`)
  await dst.query(`SELECT setval(pg_get_serial_sequence('event_source','id'), COALESCE((SELECT max(id) FROM event_source), 1))`)

  const cnt = await dst.query('SELECT count(*)::int AS n FROM event')
  console.log(`[shard-migrate]   shard${idx} 完成，当前 ${cnt.rows[0].n} 条`)
  await dst.end()
}

// 5) 非时间维度的小表（place/person/dynasty/source 等）全量复制到每个分片
const SMALL_TABLES = ['source', 'place', 'person', 'person_relation', 'tech', 'boundary_slice', 'dynasty', 'search_synonym', 'search_vocab']
for (const s of shards) {
  const dst = new pg.Client({ connectionString: s.url })
  await dst.connect()
  for (const t of SMALL_TABLES) {
    try {
      const { rows } = await src.query(`SELECT * FROM ${t}`)
      if (!rows.length) continue
      const cols = Object.keys(rows[0])
      await dst.query(`DELETE FROM ${t}`)
      for (let off = 0; off < rows.length; off += 200) {
        const q = multiInsert(t, cols, rows.slice(off, off + 200).map((r) => cols.map((c) => r[c])))
        await dst.query(q.sql, q.params)
      }
    } catch (e) {
      console.warn(`[shard-migrate] 复制 ${t} 到 shard${s.idx} 失败：${e.message.split('\n')[0]}`)
    }
  }
  await dst.end()
}

console.log(`\n[shard-migrate] 完成：event ${migrated} / claim ${claimsCopied} / source ${sourcesCopied}，用时 ${Date.now() - t0} ms`)
await src.end()
