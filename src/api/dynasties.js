import { db } from '../db/client.js'

export const routes = [
  /**
   * GET /api/dynasties?from&to
   * 返回与请求区间相交的王朝存续区间，供时间轴画底色带。
   * → { dynasties:[{ slug, name, nameEn, start_year, end_year, era_group, color, certainty }] }
   */
  ['GET', '/api/dynasties', async ({ query }) => {
    const from = Number.isFinite(Number(query.from)) ? Number(query.from) : -3000
    const to = Number.isFinite(Number(query.to)) ? Number(query.to) : 2100

    const { rows } = await db.query(
      `SELECT slug, name, name_en, start_year, end_year, era_group, color, certainty
         FROM dynasty
        WHERE end_year >= $1::int AND start_year <= $2::int
        ORDER BY start_year`,
      [from, to],
    )

    return {
      from,
      to,
      total: rows.length,
      dynasties: rows.map((r) => ({
        slug: r.slug,
        name: r.name,
        nameEn: r.name_en,
        start_year: r.start_year,
        end_year: r.end_year,
        era_group: r.era_group,
        color: r.color,
        certainty: r.certainty,
      })),
    }
  }],
]
