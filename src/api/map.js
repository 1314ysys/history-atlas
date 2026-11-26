import { db } from '../db/client.js'

const DEFAULT_FROM = -3000
const DEFAULT_TO = 2100
const DEFAULT_LIMIT = 4000
const MAX_LIMIT = 20000

const MAP_COLUMNS = `slug, title, lat, lon, t_start_year, t_end_year,
  t_precision, t_certainty, track, category`

/**
 * 解析整型查询参数，非法或缺省时回退。
 * @param {string|undefined} value
 * @param {number} fallback
 * @returns {number}
 */
export function intParam(value, fallback) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/**
 * 规范化地图查询：缺省 [-3000, 2100]；from > to 时自动交换（避免 int4range 报错）；
 * limit 夹在 [1, 20000]，默认 4000。
 * @param {Record<string, string>} [query]
 * @returns {{ from: number, to: number, limit: number }}
 */
export function parseRangeQuery(query = {}) {
  let from = intParam(query.from, DEFAULT_FROM)
  let to = intParam(query.to, DEFAULT_TO)
  if (from > to) [from, to] = [to, from]
  const limit = Math.min(Math.max(intParam(query.limit, DEFAULT_LIMIT), 1), MAX_LIMIT)
  return { from, to, limit }
}

export const routes = [
  /**
   * GET /api/map/events?from=-3000&to=2100&limit=4000
   * → { from, to, total, events: [{slug,title,lat,lon,t_start_year,t_end_year,
   *                                t_precision,t_certainty,track,category}] }
   */
  ['GET', '/api/map/events', async ({ query }) => {
    const { from, to, limit } = parseRangeQuery(query)

    const { rows } = await db.query(
      `SELECT ${MAP_COLUMNS}
         FROM event
        WHERE status = 'published'
          AND lat IS NOT NULL
          AND lon IS NOT NULL
          AND t_span && int4range($1::int, $2::int)
        ORDER BY t_start_year
        LIMIT $3`,
      [from, to, limit],
    )

    return { from, to, total: rows.length, events: rows }
  }],
]
