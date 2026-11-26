import { db, schemaVersion } from '../db/client.js'
import { shardingEnabled, shardInfo } from '../db/shard.js'

export const routes = [
  ['GET', '/api/health', async () => {
    const { rows } = await db.query('SELECT 1 AS ok, version() AS v')
    return {
      ok: rows[0]?.ok === 1,
      db: db.mode(),
      engine: String(rows[0]?.v || '').split(' ').slice(0, 2).join(' '),
      schema: await schemaVersion(),
      runtime: process.version,
      sharding: shardingEnabled() ? { enabled: true, shards: shardInfo() } : { enabled: false },
      searchReadFrom: String(process.env.SEARCH_READ_FROM || 'primary').toLowerCase(),
      cache: { ttlMs: Number(process.env.CACHE_TTL_MS || 0) || 0 },
    }
  }],

  ['GET', '/api/stats', async () => {
    const q = async (sql, params = []) => (await db.readQuery(sql, params)).rows[0]
    const [events, cn, world, persons, places, claims, sources, verified, tech, boundaries, staged] =
      await Promise.all([
        q(`SELECT count(*)::int AS n FROM event WHERE status='published'`),
        q(`SELECT count(*)::int AS n FROM event WHERE status='published' AND track='cn'`),
        q(`SELECT count(*)::int AS n FROM event WHERE status='published' AND track='world'`),
        q(`SELECT count(*)::int AS n FROM person`),
        q(`SELECT count(*)::int AS n FROM place`),
        q(`SELECT count(*)::int AS n FROM event_claim`),
        q(`SELECT count(*)::int AS n FROM event_source`),
        q(`SELECT count(*)::int AS n FROM event_source WHERE verified_status='verified'`),
        q(`SELECT count(*)::int AS n FROM tech`),
        q(`SELECT count(*)::int AS n FROM boundary_slice`),
        q(`SELECT count(*)::int AS n FROM staging_event WHERE state='pending'`),
      ])

    const { rows: span } = await db.query(
      `SELECT min(t_start_year)::int AS min_year, max(t_start_year)::int AS max_year
         FROM event WHERE status='published'`,
    )

    return {
      events: events.n,
      cn: cn.n,
      world: world.n,
      persons: persons.n,
      places: places.n,
      claims: claims.n,
      sources: sources.n,
      verified: verified.n,
      tech: tech.n,
      boundaries: boundaries.n,
      staged: staged.n,
      span: span[0] || { min_year: null, max_year: null },
    }
  }],
]
