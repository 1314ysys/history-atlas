import { db } from '../db/client.js'
import { formatEventTime } from '../domain/time.js'

export const routes = [
  /**
   * GET /api/person/:slug
   * 人物基本信息 + 相关事件 + 人物关系（含对方姓名），供详情抽屉的人物面板使用。
   */
  ['GET', '/api/person/:slug', async ({ params }) => {
    const { rows } = await db.query(
      `SELECT slug, name, aliases, birth_year, death_year, dynasty, note
         FROM person WHERE slug = $1`,
      [params.slug],
    )
    const person = rows[0]
    if (!person) {
      return { __status: 404, error: { code: 'PERSON_NOT_FOUND', message: `no person ${params.slug}` } }
    }

    const [events, rels, degree] = await Promise.all([
      db.query(
        `SELECT e.slug, e.title, e.t_start_year, e.t_end_year, e.t_start_month, e.t_start_day,
                e.t_precision, e.t_certainty, e.track, e.category, ep.role
           FROM event_person ep
           JOIN event e ON e.id = ep.event_id
          WHERE ep.person_id = (SELECT id FROM person WHERE slug = $1)
            AND e.status = 'published'
          ORDER BY e.t_start_year
          LIMIT 200`,
        [params.slug],
      ),
      db.query(
        `SELECT r.from_slug, r.to_slug, r.type, r.t_start_year, r.t_end_year,
                pf.name AS from_name, pf.dynasty AS from_dynasty,
                pt.name AS to_name, pt.dynasty AS to_dynasty
           FROM person_relation r
           LEFT JOIN person pf ON pf.slug = r.from_slug
           LEFT JOIN person pt ON pt.slug = r.to_slug
          WHERE r.from_slug = $1 OR r.to_slug = $1
          ORDER BY r.type, r.t_start_year NULLS LAST
          LIMIT 300`,
        [params.slug],
      ),
      db.query(
        `SELECT count(*)::int AS n FROM person_relation WHERE from_slug = $1 OR to_slug = $1`,
        [params.slug],
      ),
    ])

    return {
      person: {
        ...person,
        degree: degree.rows[0]?.n ?? 0,
      },
      events: events.rows.map((e) => ({ ...e, time_text: formatEventTime(e).text })),
      relations: rels.rows.map((r) => {
        const outgoing = r.from_slug === params.slug
        return {
          type: r.type,
          direction: outgoing ? 'out' : 'in',
          t_start_year: r.t_start_year,
          t_end_year: r.t_end_year,
          other: {
            slug: outgoing ? r.to_slug : r.from_slug,
            name: outgoing ? r.to_name : r.from_name,
            dynasty: outgoing ? r.to_dynasty : r.from_dynasty,
          },
        }
      }),
      meta: { degree: degree.rows[0]?.n ?? 0 },
    }
  }],
]
