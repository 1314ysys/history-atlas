/**
 * facets.js —— 分面聚合的纯函数模块（SQL 形状 + 结果整形）
 *
 * 设计目标是给检索层复用的**两份纯逻辑**：
 *   1) `facetSql(whereSql)`  一次 GROUPING SETS 算出 track / category / discipline 三组分面；
 *   2) `shapeFacets(rows)`   把行整理成前端可直接消费的 `{ track:[{value,count}], … }`。
 *
 * 这一层不做 IO、不连数据库、不改入参，便于单测与在不同 handler 间复用。
 */

/** 分面维度（顺序即 SQL 选列顺序） */
export const FACET_FIELDS = /** @type {const} */ (['track', 'category', 'discipline'])

/**
 * 归一化 WHERE 片段：
 *   · 空 / 空白 → `TRUE`
 *   · 容忍调用方带前导 `WHERE`（大小写不敏感）
 *   · 容忍尾部分号
 * @param {string} [whereSql]
 * @returns {string}
 */
function normalizeWhere(whereSql) {
  let w = typeof whereSql === 'string' ? whereSql.trim() : ''
  if (!w) return 'TRUE'
  w = w.replace(/;\s*$/, '').trim()
  w = w.replace(/^WHERE\s+/i, '')
  return w || 'TRUE'
}

/**
 * 构造分面聚合 SQL。
 *
 * 产出的 SQL 形如：
 * ```
 * SELECT track, category, discipline, count(*)::int AS n
 *   FROM event
 *  WHERE <whereSql>
 *  GROUP BY GROUPING SETS ((track), (category), (discipline))
 * ```
 * 参数占位符（$1、$2…）原样保留，由调用方按同序传 `params`。
 *
 * @param {string} [whereSql] 与 hits 完全相同的过滤条件（不含 LIMIT）
 * @returns {{sql: string, fields: string[]}}
 */
export function facetSql(whereSql) {
  const where = normalizeWhere(whereSql)
  const sql = `SELECT track, category, discipline, count(*)::int AS n
  FROM event
 WHERE ${where}
 GROUP BY GROUPING SETS ((track), (category), (discipline))`
  // 每次返回新数组，避免调用方改动污染后续调用
  return { sql, fields: [...FACET_FIELDS] }
}

/** @returns {{track:{value:string,count:number}[], category:{value:string,count:number}[], discipline:{value:string,count:number}[]}} */
export function emptyFacets() {
  return { track: [], category: [], discipline: [] }
}

/**
 * 行 → 分面对象。
 *
 * 兼容两种行形状：
 *   · `{ track, category, discipline, n | count }`（GROUPING SETS 直出）
 *   · `{ dim, value, count }`（预先展开成「维度-值-计数」三元组）
 *
 * 规则：丢弃 NULL 桶与 0 计数；维度内按 count 降序、value 升序；纯函数不改入参。
 *
 * @param {object[]|null|undefined} rows
 */
export function shapeFacets(rows) {
  const out = emptyFacets()
  if (!Array.isArray(rows)) return out

  /** 每个维度先收集到 Map，最后统一排序，避免边插边排 */
  const buckets = {
    track: new Map(),
    category: new Map(),
    discipline: new Map(),
  }

  const add = (dim, value, count) => {
    if (!FACET_FIELDS.includes(dim)) return
    if (value === null || value === undefined) return
    const v = String(value).trim()
    if (!v) return
    const n = Number(count)
    if (!Number.isFinite(n) || n <= 0) return
    const m = buckets[dim]
    m.set(v, (m.get(v) ?? 0) + Math.trunc(n))
  }

  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const count = 'n' in r ? r.n : r.count
    if (r.dim !== undefined) {
      // {dim, value, count} 形状
      add(r.dim, r.value, count)
      continue
    }
    // {track, category, discipline, n} 形状：GROUPING SETS 每个桶只有一个维度非空
    for (const dim of FACET_FIELDS) add(dim, r[dim], count)
  }

  // 同 count 时按 value 升序：中文用 zh 排序规则（技 < 制），否则会退化成码位序
  const collator = new Intl.Collator('zh-Hans-CN', { sensitivity: 'variant' })
  for (const dim of FACET_FIELDS) {
    out[dim] = [...buckets[dim].entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || collator.compare(a.value, b.value))
  }

  return out
}

export default { FACET_FIELDS, facetSql, shapeFacets, emptyFacets }
