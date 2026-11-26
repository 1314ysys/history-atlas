import { db } from '../db/client.js'
import { formatEventTime } from '../domain/time.js'

export const routes = [
  /**
   * GET /api/event/:slug  → 事件全量详情
   */
  ['GET', '/api/event/:slug', async ({ params }) => {
    const { rows } = await db.query(`SELECT * FROM event WHERE slug = $1`, [params.slug])
    const ev = rows[0]
    if (!ev) {
      return { __status: 404, error: { code: 'EVENT_NOT_FOUND', message: `no event ${params.slug}` } }
    }

    const [claims, sources, persons, place] = await Promise.all([
      db.query(
        `SELECT id, statement, evidence_level, confidence, disputed_group, adopted, rationale, sort_order
           FROM event_claim WHERE event_id = $1 ORDER BY sort_order, id`,
        [ev.id],
      ),
      db.query(
        `SELECT id, claim_id, source_slug, locator, quote, quote_sha256, verified_status, verified_at
           FROM event_source WHERE event_id = $1 ORDER BY id`,
        [ev.id],
      ),
      db.query(
        `SELECT p.slug, p.name, p.dynasty, ep.role
           FROM event_person ep JOIN person p ON p.id = ep.person_id
          WHERE ep.event_id = $1 ORDER BY p.name`,
        [ev.id],
      ),
      ev.place_slug
        ? db.query(`SELECT slug, name, lat, lon, note FROM place WHERE slug = $1`, [ev.place_slug])
        : Promise.resolve({ rows: [] }),
    ])

    const time = formatEventTime(ev)

    return {
      event: {
        ...ev,
        time_text: time.text,
        time_sort: time.sort,
        category: ev.category,
      },
      claims: claims.rows,
      sources: sources.rows,
      persons: persons.rows,
      place: place.rows[0] || null,
    }
  }],
]
