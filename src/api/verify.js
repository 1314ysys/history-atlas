import { db } from '../db/client.js'
import { verify as verifyArchived } from '../archive/store.js'

const SHA256_RE = /^[0-9a-f]{64}$/

/** @param {unknown} value @returns {number|null} 兼容 BIGINT 返回 string/BigInt 的驱动 */
function toNumberOrNull(value) {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** @param {unknown} value @returns {string|null} */
function toIsoOrNull(value) {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number') return new Date(value).toISOString()
  return String(value)
}

export const routes = [
  /**
   * GET /api/verify/:sha256  → { sha256, status, size, checked_at, first_seen_at }
   * 校验内容寻址存档：文件存在且重算 sha256 与请求的 sha 一致才算 verified。
   */
  ['GET', '/api/verify/:sha256', async ({ params }) => {
    const sha = String(params.sha256 ?? '')

    if (!SHA256_RE.test(sha)) {
      return {
        __status: 400,
        error: {
          code: 'BAD_HASH',
          message: 'sha256 must be 64 lowercase hex characters',
        },
      }
    }

    const result = await verifyArchived(sha)
    const status = result.status

    // archive_blob 只作为元数据补充：拿不到（表缺失 / 无记录）不影响校验结论
    let blobSize = null
    let firstSeenAt = null
    try {
      const { rows } = await db.query(
        `SELECT size, first_seen_at FROM archive_blob WHERE sha256 = $1`,
        [sha],
      )
      if (rows[0]) {
        blobSize = toNumberOrNull(rows[0].size)
        firstSeenAt = toIsoOrNull(rows[0].first_seen_at)
      }
    } catch (err) {
      console.warn('[verify] archive_blob lookup failed:', err.message)
    }

    let size = blobSize ?? (status === 'verified' ? toNumberOrNull(result.size) : null)
    if (status === 'missing') {
      size = null
      firstSeenAt = null
    }

    return {
      sha256: sha,
      status,
      size,
      checked_at: new Date().toISOString(),
      first_seen_at: firstSeenAt,
    }
  }],
]
