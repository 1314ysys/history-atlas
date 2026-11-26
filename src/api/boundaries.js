import { db } from '../db/client.js'

/** 缺省年份：取数据集中部，避免无参请求命中极端切片 */
const DEFAULT_YEAR = 1000

/** @returns {{ type: 'FeatureCollection', features: any[] }} */
const emptyCollection = () => ({ type: 'FeatureCollection', features: [] })

/** @param {string|undefined} value @param {number} fallback @returns {number} */
function intParam(value, fallback) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/**
 * 把 boundary_slice.geojson 统一成 FeatureCollection。
 * PGlite 会把 jsonb 解析成 JS 对象；若驱动返回字符串则 JSON.parse。
 * 兼容三种存法：FeatureCollection / Feature / 裸 geometry（自动包成 Feature）。
 * @param {unknown} raw
 * @returns {{ type: 'FeatureCollection', features: any[] }|null} 无法识别时返回 null
 */
export function toFeatureCollection(raw) {
  let gj = raw
  if (typeof gj === 'string') {
    try {
      gj = JSON.parse(gj)
    } catch {
      return null
    }
  }
  if (!gj || typeof gj !== 'object') return null

  if (gj.type === 'FeatureCollection' && Array.isArray(gj.features)) {
    return { type: 'FeatureCollection', features: gj.features }
  }
  if (gj.type === 'Feature') {
    return { type: 'FeatureCollection', features: [gj] }
  }
  if (typeof gj.type === 'string' && Array.isArray(gj.coordinates)) {
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: gj }],
    }
  }
  return null
}

export const routes = [
  /**
   * GET /api/boundaries/list
   * 返回全部时间切片清单（按年份升序），供地图切片条使用。
   * → { slices:[{ year, name, note, featureCount }] }
   */
  ['GET', '/api/boundaries/list', async () => {
    const { rows } = await db.query(
      `SELECT year, name, note, geojson FROM boundary_slice ORDER BY year`,
    )
    return {
      slices: rows.map((r) => {
        const fc = toFeatureCollection(r.geojson)
        return {
          year: r.year,
          name: r.name ?? null,
          note: r.note ?? null,
          featureCount: fc ? fc.features.length : 0,
        }
      }),
    }
  }],

  /**
   * GET /api/boundaries?year=1092
   * 取 boundary_slice 中与请求年份最接近的一条，返回其 GeoJSON（FeatureCollection）
   * 并用 meta 说明来源，供前端标注「示意」。
   * → { type:'FeatureCollection', features:[...], meta:{ year, name, note } }
   */
  ['GET', '/api/boundaries', async ({ query }) => {
    const year = intParam(query.year, DEFAULT_YEAR)

    const { rows } = await db.query(
      `SELECT year, name, note, geojson
         FROM boundary_slice
        ORDER BY abs(year - $1::int), year
        LIMIT 1`,
      [year],
    )

    const row = rows[0]
    if (!row) {
      return { ...emptyCollection(), meta: { year, name: null, note: null } }
    }

    const collection = toFeatureCollection(row.geojson) || emptyCollection()
    return {
      ...collection,
      meta: { year: row.year, name: row.name ?? null, note: row.note ?? null },
    }
  }],
]
