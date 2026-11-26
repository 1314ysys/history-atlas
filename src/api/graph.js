import { db } from '../db/client.js'

const DEFAULT_DEPTH = 2
const MAX_DEPTH = 4
const DEFAULT_HUBS = 24
const MAX_HUBS = 200
/** 节点上限：防止度数极高的数据集把响应撑爆 */
const MAX_NODES = 500

/** @param {string|undefined} value @param {number} fallback @returns {number} */
function intParam(value, fallback) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/** @param {number} n @param {number} lo @param {number} hi @returns {number} */
function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi)
}

/**
 * 以某人为起点做 BFS 展开（在 JS 里逐跳查询，不用递归 CTE）。
 * @param {string} slug 起点人物 slug
 * @param {number} depth 跳数（1..4）
 * @returns {Promise<{center:{slug:string,name:string}, depth:number,
 *   nodes:{slug:string,name:string,dynasty:string|null}[],
 *   edges:{from:string,to:string,type:string}[]}|null>} 起点不存在时返回 null
 */
export async function expandPersonGraph(slug, depth = DEFAULT_DEPTH) {
  const { rows: rootRows } = await db.query(`SELECT slug, name FROM person WHERE slug = $1`, [slug])
  const root = rootRows[0]
  if (!root) return null

  const visited = new Set([root.slug])
  let frontier = [root.slug]

  /** @type {Map<string, {from:string,to:string,type:string}>} */
  const edgeMap = new Map()

  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const { rows } = await db.query(
      `SELECT from_slug, to_slug, type
         FROM person_relation
        WHERE from_slug = ANY($1::text[]) OR to_slug = ANY($1::text[])`,
      [frontier],
    )

    /** @type {string[]} */
    const next = []
    for (const r of rows) {
      const key = `${r.from_slug}\u0000${r.to_slug}\u0000${r.type}`
      if (!edgeMap.has(key)) edgeMap.set(key, { from: r.from_slug, to: r.to_slug, type: r.type })
      for (const s of [r.from_slug, r.to_slug]) {
        if (!visited.has(s)) {
          visited.add(s)
          next.push(s)
        }
      }
    }

    frontier = next
    if (visited.size >= MAX_NODES) break
  }

  const slugs = [...visited].slice(0, MAX_NODES)
  const { rows: nodeRows } = await db.query(
    `SELECT slug, name, dynasty FROM person WHERE slug = ANY($1::text[]) ORDER BY name`,
    [slugs],
  )

  const nodes = nodeRows.map((p) => ({ slug: p.slug, name: p.name, dynasty: p.dynasty ?? null }))
  const known = new Set(nodes.map((n) => n.slug))
  const edges = [...edgeMap.values()].filter((e) => known.has(e.from) && known.has(e.to))

  return {
    center: { slug: root.slug, name: root.name },
    depth,
    nodes,
    edges,
  }
}

export const routes = [
  /**
   * GET /api/person/:slug/graph?depth=2
   * → { center:{slug,name}, depth, nodes:[{slug,name,dynasty}], edges:[{from,to,type}] }
   */
  ['GET', '/api/person/:slug/graph', async ({ params, query }) => {
    const depth = clamp(intParam(query.depth, DEFAULT_DEPTH), 1, MAX_DEPTH)
    const graph = await expandPersonGraph(params.slug, depth)

    if (!graph) {
      return {
        __status: 404,
        error: { code: 'PERSON_NOT_FOUND', message: `no person ${params.slug}` },
      }
    }

    return graph
  }],

  /**
   * GET /api/graph/hubs?limit=24
   * 关系度数最高的一批人物（用于关系图默认视图）。
   * → { nodes:[{slug,name,dynasty,degree}] }
   */
  ['GET', '/api/graph/hubs', async ({ query }) => {
    const limit = clamp(intParam(query.limit, DEFAULT_HUBS), 1, MAX_HUBS)

    const { rows } = await db.query(
      `SELECT p.slug, p.name, p.dynasty, count(*)::int AS degree
         FROM person p
         JOIN person_relation r ON r.from_slug = p.slug OR r.to_slug = p.slug
        GROUP BY p.slug, p.name, p.dynasty
        ORDER BY degree DESC, p.name
        LIMIT $1`,
      [limit],
    )

    return { nodes: rows }
  }],
]
