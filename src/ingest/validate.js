import { createHash } from 'node:crypto'
import { db } from '../db/client.js'
import { validateEvent, canonicalJSON } from './schema.js'

/** @param {string} text @returns {string} hex sha256 */
export function sha256hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 幂等键：collector + external_id + 规范化 payload 的 sha256。
 * 同一采集器对同一事件重复投递 → 同键；任一字段变化 → 换键。
 * @param {{collector:string, externalId:string, payload:object}} args
 * @returns {string}
 */
export function idemKey({ collector, externalId, payload }) {
  return sha256hex(`${collector}\n${externalId}\n${canonicalJSON(payload)}`)
}

/** 带 HTTP 语义的错误（server.js 会读 statusCode / code） */
function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code })
}

/**
 * 批量接收一条采集批次：校验 → 落 staging（幂等）→ 回写批次统计。
 *
 * 幂等策略：staging_event.idem_key 上有 UNIQUE 约束，
 * `INSERT ... ON CONFLICT (idem_key) DO NOTHING RETURNING id` 返回空即"重复投递"，
 * 重复不报错、不重复入库，只计入 duplicates。
 *
 * @param {{collector:string, batchId:string, events:unknown[]}} args
 * @returns {Promise<{batch_id:string, accepted:number, rejected:number, duplicates:number, staged:true, errors:object[]}>}
 */
export async function ingestBatch({ collector, batchId, events }) {
  if (typeof collector !== 'string' || !collector.trim() || collector.length > 100) {
    throw httpError(400, 'INVALID_COLLECTOR', 'collector must be a non-empty string (max 100 chars)')
  }
  if (typeof batchId !== 'string' || !batchId.trim() || batchId.length > 200) {
    throw httpError(400, 'INVALID_BATCH_ID', 'batch_id must be a non-empty string (max 200 chars)')
  }
  if (!Array.isArray(events)) {
    throw httpError(400, 'INVALID_EVENTS', 'events must be an array')
  }

  const col = collector.trim()
  const bid = batchId.trim()

  // ---- 1. 逐条校验 ----
  const errors = []
  const valid = []
  for (let i = 0; i < events.length; i++) {
    const raw = events[i]
    const res = validateEvent(raw)
    if (!res.ok) {
      const externalId = raw !== null && typeof raw === 'object' && typeof raw.external_id === 'string' ? raw.external_id : null
      for (const e of res.errors) {
        errors.push({ index: i, external_id: externalId, path: e.path, message: e.message })
      }
      continue
    }
    valid.push({
      index: i,
      external_id: res.value.external_id,
      payload: res.value,
      idem_key: idemKey({ collector: col, externalId: res.value.external_id, payload: res.value }),
    })
  }
  const rejected = events.length - valid.length

  // ---- 2. 批次行占位（重投同一 batch_id 时保留原有行与首投时间） ----
  await db.query(
    `INSERT INTO ingest_batch (batch_id, collector, accepted, rejected, status, errors)
     VALUES ($1, $2, 0, 0, 'staged', '[]'::jsonb)
     ON CONFLICT (batch_id) DO NOTHING`,
    [bid, col],
  )

  // ---- 3. 逐条落 staging，用 RETURNING 判断是否真的插入 ----
  let accepted = 0
  let duplicates = 0
  for (const item of valid) {
    const { rows } = await db.query(
      `INSERT INTO staging_event (batch_id, external_id, idem_key, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (idem_key) DO NOTHING
       RETURNING id`,
      [bid, item.external_id, item.idem_key, JSON.stringify(item.payload)],
    )
    if (rows.length > 0) accepted++
    else duplicates++
  }

  // ---- 4. 回写批次统计 ----
  // accepted 记该批次**累计**入库条数（重投不膨胀，与 GET /batches/:id 的 staged_count 一致）；
  // 响应里的 accepted 只记本次投递的真实新插入数。
  const { rows: countRows } = await db.query(
    `SELECT count(*)::int AS n FROM staging_event WHERE batch_id = $1`,
    [bid],
  )
  const stored = countRows[0]?.n ?? 0
  // 状态跟随批次实际内容，而不是"本次投递"的结果；已 promote 过的批次不因重投退回 staged。
  const status = stored > 0 ? 'staged' : rejected > 0 ? 'rejected' : 'duplicate'
  await db.query(
    `UPDATE ingest_batch
        SET accepted = $2,
            rejected = $3,
            errors   = $4::jsonb,
            status   = CASE WHEN status IN ('promoted', 'partial') THEN status ELSE $5 END
      WHERE batch_id = $1`,
    [bid, stored, rejected, JSON.stringify(errors), status],
  )

  return {
    batch_id: bid,
    accepted,
    rejected,
    duplicates,
    staged: true,
    errors,
  }
}
