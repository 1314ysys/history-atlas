import { db } from '../db/client.js'
import { shardingEnabled, shardsForRange, queryShards } from '../db/shard.js'

const LITE_COLUMNS = `slug, title, t_start_year, t_end_year,
  t_start_month, t_start_day, t_precision, t_certainty,
  track, category, discipline, lat, lon`

/** 每页默认条数（分页早停：先画首屏，再按需追加） */
const DEFAULT_LIMIT = 200
/** 单页硬上限 */
const MAX_LIMIT = 2000

/**
 * 事件最大跨年跨度（缓存 10 分钟）。
 * 用于给 btree 覆盖索引一个「下界保护带」：
 *   只有 t_start_year >= from - maxSpan 的事件才可能覆盖 from 之后的时间点，
 *   否则像 t_start_year < 1095 这种谓词会从索引最早处一路扫下来，过滤掉全表。
 */
let maxSpanCache = { value: 0, at: 0 }
async function maxSpan() {
  if (Date.now() - maxSpanCache.at < 10 * 60 * 1000) return maxSpanCache.value
  const { rows } = await db.query(
    `SELECT COALESCE(max(GREATEST(COALESCE(t_end_year, t_start_year) - t_start_year, 0)), 0)::int AS m
       FROM event WHERE status = 'published'`,
  )
  maxSpanCache = { value: rows[0]?.m ?? 0, at: Date.now() }
  return maxSpanCache.value
}

export const routes = [
  /**
   * GET /api/timeline?from=-3000&to=2100&track=cn&limit=200&offset=0&withTotal=1
   *
   * v2 契约：
   *   total      命中总数（withTotal=0 时为 null，避免大区间全量计数）
   *   returned   本页条数
   *   hasMore    是否还有下一页（用 limit+1 探测，不做全量计数）
   *   nextOffset 下一页 offset
   */
  ['GET', '/api/timeline', async ({ query }) => {
    const from = Number.isFinite(Number(query.from)) ? Number(query.from) : -3000
    const to = Number.isFinite(Number(query.to)) ? Number(query.to) : 2100
    const track = query.track === 'cn' || query.track === 'world' ? query.track : null
    const limit = Math.min(Math.max(Number(query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
    const offset = Math.max(Number(query.offset) || 0, 0)
    const withTotal = query.withTotal === '1' || query.withTotal === 'true'
    const span = await maxSpan()

    // 同一谓词，两种参数编号：分页查询占位符是 $3=track/$5=span，计数是 $3=track/$4=span
    const pred = (spanIdx) => `status = 'published'
          AND t_start_year >= $1::int - $${spanIdx}::int
          AND t_start_year < $2::int
          AND COALESCE(t_end_year, t_start_year) >= $1::int
          AND ($3::text IS NULL OR track = $3)`

    const pageSql = `SELECT ${LITE_COLUMNS}
           FROM event
          WHERE ${pred(5)}
          ORDER BY t_start_year,
                   t_start_month NULLS FIRST,
                   t_start_day NULLS FIRST,
                   id
          LIMIT $4 OFFSET $6`

    const pageArgs = [from, to, track, limit + 1, span, offset]
    const countSql = `SELECT count(*)::int AS n FROM event WHERE ${pred(4)}`
    const countArgs = [from, to, track, span]

    let pageRows
    let totalCount = null
    let shardMeta = null

    if (shardingEnabled()) {
      // 分片模式：并发打到覆盖该区间的分片，本地合并后统一排序分页。
      //
      // 两个必须遵守的约束（由 bench/shard-verify.js 实测暴露）：
      //  1) 路由必须扩边：谓词含「跨年宽事件下界保护带」(t_start_year >= from - span)，
      //     若只按 [from,to) 选片，起点在上一片、跨到 from 之后的宽事件会被静默漏掉
      //     （实测 [600,610) 窗口单库 2104 行 / 分片仅 2000 行，漏 104 行）。
      //  2) 排序收尾键必须跨片唯一：id 是各片自增，跨片会撞；
      //     用 slug（全局唯一）收尾，否则分页会出现重复/漏行（实测 201/201 行错位）。
      const targets = shardsForRange(from - span, to)
      if (!targets.length) {
        return { from, to, track, limit, offset, total: 0, returned: 0, hasMore: false, nextOffset: null, events: [] }
      }
      // 分片模式专用 SQL：排序以 slug 收尾（跨片唯一）
      const shardPageSql = `SELECT ${LITE_COLUMNS}
           FROM event
          WHERE ${pred(5)}
          ORDER BY t_start_year,
                   t_start_month NULLS FIRST,
                   t_start_day NULLS FIRST,
                   slug
          LIMIT $4 OFFSET $6`
      const fan = await queryShards(targets, shardPageSql, [from, to, track, limit + 1 + offset, span, 0], {
        merge: (rows) =>
          rows.sort(
            (a, b) =>
              (a.t_start_year - b.t_start_year) ||
              ((a.t_start_month ?? 0) - (b.t_start_month ?? 0)) ||
              ((a.t_start_day ?? 0) - (b.t_start_day ?? 0)) ||
              (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
          ),
      })
      pageRows = fan.rows.slice(offset, offset + limit + 1)
      shardMeta = { shards: fan.perShard, degraded: fan.degraded, routed: targets.map((s) => s.idx) }
      if (withTotal) {
        const c = await queryShards(targets, countSql, countArgs, {
          merge: (rows) => [{ n: rows.reduce((s, r) => s + (Number(r.n) || 0), 0) }],
        })
        totalCount = c.rows[0]?.n ?? 0
        if (c.degraded.length) shardMeta.degraded = [...(shardMeta.degraded || []), ...c.degraded]
      }
    } else {
      const [page, count] = await Promise.all([
        db.query(pageSql, pageArgs),
        withTotal ? db.query(countSql, countArgs) : Promise.resolve({ rows: [{ n: null }] }),
      ])
      pageRows = page.rows
      totalCount = count.rows[0]?.n ?? null
    }

    const hasMore = pageRows.length > limit
    const events = hasMore ? pageRows.slice(0, limit) : pageRows
    const returned = events.length
    const nextOffset = offset + returned

    return {
      from,
      to,
      track,
      limit,
      offset,
      total: totalCount,
      returned,
      hasMore,
      nextOffset: hasMore ? nextOffset : null,
      maxSpan: span,
      ...(shardMeta ? { shards: shardMeta.shards, degraded: shardMeta.degraded } : {}),
      events,
    }
  }],
]
