import { createHash } from 'node:crypto'
import { db } from '../db/client.js'
import { putText } from '../archive/store.js'
import { tokenize, toTsv } from '../domain/tokenize.js'
import { ingestBatch } from './validate.js'

const DEFAULT_TOKEN = 'dev-token'

/** 期望的 Bearer token（运行时可被 env 覆盖） */
function expectedToken() {
  return process.env.INGEST_TOKEN || DEFAULT_TOKEN
}

/** /v1/ingest/* 鉴权：Authorization 必须严格等于 `Bearer <token>` */
function isAuthorized(req) {
  const header = (req && req.headers && req.headers.authorization) || ''
  return header === `Bearer ${expectedToken()}`
}

function unauthorized() {
  return {
    __status: 401,
    error: { code: 'UNAUTHORIZED', message: 'missing or invalid Authorization header, expected "Bearer <INGEST_TOKEN>"' },
  }
}

function badRequest(code, message) {
  return Object.assign(new Error(message), { statusCode: 400, code })
}

/** jsonb 列在不同驱动下可能已解析，也可能是字符串 */
function asJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return fallback
    }
  }
  return value
}

/**
 * external_id → slug 的安全化形式：保留字母/数字（含中日韩汉字），其余折叠为单个连字符。
 * 全部被折叠掉时退化为短哈希，保证 slug 非空且可重复生成。
 * @param {string} text @returns {string}
 */
function safeSlug(text) {
  const cleaned = String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  if (cleaned) return cleaned
  return `x${createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 10)}`
}

function searchTextOf(payload) {
  const place = payload.place || {}
  return [payload.title, payload.summary, payload.category, place.name]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ')
    .toLowerCase()
}

/** 全文检索列的词串（与 seed 同规则，字段集合对齐 searchTextOf，保证命中集合一致） */
function searchTsvOf(payload) {
  const place = payload.place || {}
  return toTsv(tokenize(
    [payload.title, payload.summary, payload.category, place.name]
      .filter((v) => typeof v === 'string' && v.trim())
      .join(' '),
  ))
}

/** 提升前的最后一道防线：payload 结构不可用则跳过该行，而不是让整批事务回滚 */
function promotable(payload) {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    typeof payload.title === 'string' &&
    payload.title.length > 0 &&
    (payload.track === 'cn' || payload.track === 'world') &&
    typeof payload.category === 'string' &&
    payload.category.length > 0 &&
    payload.time !== null &&
    typeof payload.time === 'object' &&
    Number.isInteger(payload.time.start_year)
  )
}

const INSERT_EVENT_SQL = `
  INSERT INTO event (slug, title, track, category, discipline,
                     t_start_year, t_start_month, t_start_day,
                     t_end_year, t_end_month, t_end_day,
                     t_precision, t_certainty,
                     place_slug, lat, lon, summary, search_text, search_tsv, status)
  VALUES ($1, $2, $3, $4, NULL,
          $5, $6, $7,
          $8, $9, $10,
          $11::t_precision, $12::t_certainty,
          NULL, $13, $14, $15, $16, to_tsvector('simple', $17::text), 'published')
  ON CONFLICT (slug) DO NOTHING
  RETURNING id`

/**
 * 写入正式 event，slug 冲突时依次尝试 `-2`、`-3`…
 * @returns {Promise<number|null>} 新 event.id；尝试用尽则 null
 */
async function insertEvent(tx, payload) {
  const time = payload.time || {}
  const place = payload.place || {}
  const base = `ing-${safeSlug(payload.external_id)}`
  for (let i = 1; i <= 100; i++) {
    const slug = i === 1 ? base : `${base}-${i}`
    const { rows } = await tx.query(INSERT_EVENT_SQL, [
      slug,
      payload.title,
      payload.track,
      payload.category,
      time.start_year,
      time.start_month ?? null,
      time.start_day ?? null,
      time.end_year ?? null,
      time.end_month ?? null,
      time.end_day ?? null,
      time.precision ?? 'year',
      time.certainty ?? 'certain',
      typeof place.lat === 'number' ? place.lat : null,
      typeof place.lon === 'number' ? place.lon : null,
      payload.summary ?? null,
      searchTextOf(payload),
      searchTsvOf(payload),
    ])
    if (rows.length > 0) return rows[0].id
  }
  return null
}

/** 多说法：一条 claim 一行，与种子数据同构（不合并争议） */
async function insertClaims(tx, eventId, claims) {
  if (!Array.isArray(claims)) return 0
  let n = 0
  for (let i = 0; i < claims.length; i++) {
    const c = claims[i]
    if (!c || typeof c.statement !== 'string' || !c.statement) continue
    await tx.query(
      `INSERT INTO event_claim (event_id, statement, evidence_level, adopted, sort_order)
       VALUES ($1, $2, $3::evidence_level, $4, $5)`,
      [eventId, c.statement, c.evidence_level || 'C', c.adopted === true, i],
    )
    n++
  }
  return n
}

/**
 * 史料：payload 只有 title（无 slug），这里派生 `ing-src-<title>` 并落到 source 表，
 * 保证 event_source.source_slug 可解析；quote 存在时写入内容寻址存档并标记 verified。
 */
async function insertSources(tx, eventId, sources) {
  if (!Array.isArray(sources)) return 0
  let n = 0
  for (const s of sources) {
    if (!s || typeof s.title !== 'string' || !s.title) continue
    const sourceSlug = `ing-src-${safeSlug(s.title)}`
    await tx.query(
      `INSERT INTO source (slug, title, kind, retrieved_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE
         SET title = EXCLUDED.title,
             retrieved_url = COALESCE(EXCLUDED.retrieved_url, source.retrieved_url)`,
      [sourceSlug, s.title, s.retrieved_url ? 'web' : 'text', s.retrieved_url ?? null],
    )

    let quoteSha = null
    if (typeof s.quote === 'string' && s.quote) {
      const put = await putText(s.quote)
      quoteSha = put.sha256
      await tx.query(
        `INSERT INTO archive_blob (sha256, size, mime, storage_key)
         VALUES ($1, $2, 'text/plain', $3)
         ON CONFLICT (sha256) DO NOTHING`,
        [put.sha256, put.size, put.key],
      )
    }

    await tx.query(
      `INSERT INTO event_source (event_id, claim_id, source_slug, locator, quote, quote_sha256, verified_status, verified_at)
       VALUES ($1, NULL, $2, $3, $4, $5, $6::verify_status, $7)`,
      [eventId, sourceSlug, s.locator ?? null, s.quote ?? null, quoteSha,
       quoteSha ? 'verified' : 'unverified', quoteSha ? new Date() : null],
    )
    n++
  }
  return n
}

/**
 * 整批提升：pending → 正式 event（含 claims / sources），成功的行置 state='promoted'。
 * 全程一个事务；只有 payload 结构不可用的行会被跳过（计入 skipped）。
 */
async function promoteBatch(batchId) {
  return db.tx(async (tx) => {
    const { rows: staged } = await tx.query(
      `SELECT id, external_id, payload FROM staging_event
        WHERE batch_id = $1 AND state = 'pending'
        ORDER BY id`,
      [batchId],
    )

    let promoted = 0
    for (const row of staged) {
      const payload = asJson(row.payload, null)
      if (!promotable(payload)) continue
      const eventId = await insertEvent(tx, payload)
      if (eventId == null) continue
      await insertClaims(tx, eventId, payload.claims)
      await insertSources(tx, eventId, payload.sources)
      await tx.query(`UPDATE staging_event SET state = 'promoted' WHERE id = $1`, [row.id])
      promoted++
    }

    const { rows: countRows } = await tx.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE state = 'pending')::int AS pending
         FROM staging_event WHERE batch_id = $1`,
      [batchId],
    )
    const total = countRows[0]?.total ?? 0
    const pending = countRows[0]?.pending ?? 0
    await tx.query(`UPDATE ingest_batch SET status = $2 WHERE batch_id = $1`, [
      batchId,
      pending === 0 ? 'promoted' : 'partial',
    ])

    return { promoted, skipped: Math.max(total - promoted, 0) }
  })
}

export const routes = [
  /**
   * POST /v1/ingest/events
   * body: { collector, batch_id, events: [] }
   * → { batch_id, accepted, rejected, duplicates, staged: true, errors[] }
   */
  ['POST', '/v1/ingest/events', async ({ req, body }) => {
    if (!isAuthorized(req)) return unauthorized()
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw badRequest('INVALID_BODY', 'body must be a JSON object { collector, batch_id, events }')
    }
    const { collector, batch_id: batchId, events } = body
    if (typeof collector !== 'string' || !collector.trim()) {
      throw badRequest('INVALID_COLLECTOR', 'collector must be a non-empty string')
    }
    if (typeof batchId !== 'string' || !batchId.trim()) {
      throw badRequest('INVALID_BATCH_ID', 'batch_id must be a non-empty string')
    }
    if (!Array.isArray(events)) {
      throw badRequest('INVALID_EVENTS', 'events must be an array')
    }
    return ingestBatch({ collector, batchId, events })
  }],

  /**
   * GET /v1/ingest/batches/:batchId
   * → { batch_id, status, accepted, rejected, errors[], staged_count, pending_count }
   */
  ['GET', '/v1/ingest/batches/:batchId', async ({ req, params }) => {
    if (!isAuthorized(req)) return unauthorized()

    const { rows } = await db.query(
      `SELECT batch_id, collector, status, accepted, rejected, errors, received_at
         FROM ingest_batch WHERE batch_id = $1`,
      [params.batchId],
    )
    const batch = rows[0]
    if (!batch) {
      return { __status: 404, error: { code: 'BATCH_NOT_FOUND', message: `no batch ${params.batchId}` } }
    }

    const { rows: counts } = await db.query(
      `SELECT count(*)::int AS staged_count,
              count(*) FILTER (WHERE state = 'pending')::int AS pending_count
         FROM staging_event WHERE batch_id = $1`,
      [params.batchId],
    )

    return {
      batch_id: batch.batch_id,
      status: batch.status,
      accepted: batch.accepted,
      rejected: batch.rejected,
      errors: asJson(batch.errors, []),
      staged_count: counts[0]?.staged_count ?? 0,
      pending_count: counts[0]?.pending_count ?? 0,
    }
  }],

  /**
   * POST /v1/ingest/batches/:batchId/promote
   * staging_event(state='pending') → event / event_claim / event_source，成功后 state='promoted'
   * → { promoted, skipped }
   */
  ['POST', '/v1/ingest/batches/:batchId/promote', async ({ req, params }) => {
    if (!isAuthorized(req)) return unauthorized()

    const { rows } = await db.query(`SELECT batch_id FROM ingest_batch WHERE batch_id = $1`, [params.batchId])
    if (!rows.length) {
      return { __status: 404, error: { code: 'BATCH_NOT_FOUND', message: `no batch ${params.batchId}` } }
    }

    return promoteBatch(params.batchId)
  }],
]
