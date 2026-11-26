import { db } from '../db/client.js'
import { formatEventTime } from '../domain/time.js'
import { toTsQuery, tokenize } from '../domain/tokenize.js'
import { facetSql, shapeFacets, emptyFacets } from '../search/facets.js'

const HIT_COLUMNS = `slug, title, summary, t_start_year, t_end_year,
  t_precision, t_certainty, track, category`

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const CANDIDATE_FACTOR = 3

/** 同义词查询结果在进程内缓存 5 分钟（含未命中的负缓存） */
export const SYNONYM_TTL_MS = 5 * 60 * 1000
const SYNONYM_CACHE_MAX = 500
/** 单字扩展词最多追加几个 trgm ILIKE 分支（防止 OR 组无限膨胀） */
const MAX_TRGM_EXPANSIONS = 4

/** 排序口径与原实现一致：按起点年升序、缺年份在后 */
const ORDER_TAIL = 'ORDER BY t_start_year NULLS LAST'

/** @type {Map<string, {expires:number, expands:string[]|null}>} */
const synonymCache = new Map()
/** 同义词表不可用时只告警一次 */
let synonymWarned = false

const cpLength = (s) => Array.from(String(s ?? '')).length
const normTerm = (s) => String(s ?? '').trim().toLowerCase()

/**
 * 文本检索的命中评分（纯函数，可单测）。
 *
 * 分档：标题完全等于 q → 100；标题以 q 开头 → 80；标题包含 → 60；
 * summary 包含 → 30；其余 → 10（仅 search_text 命中，即 SQL 已放行的弱命中）。
 * 大小写不敏感，入参 q 前后空白忽略。
 *
 * @param {{title?:string|null, summary?:string|null}} row
 * @param {string} q
 * @returns {number} 0（空查询）或 10/30/60/80/100
 */
export function scoreHit(row, q) {
  const needle = String(q ?? '').trim().toLowerCase()
  if (!needle) return 0
  const title = String(row?.title ?? '').toLowerCase()
  const summary = String(row?.summary ?? '').toLowerCase()
  if (title === needle) return 100
  if (title.startsWith(needle)) return 80
  if (title.includes(needle)) return 60
  if (summary.includes(needle)) return 30
  return 10
}

/** 同分时按 |t_start_year| 升序（缺年份视为 0） */
function absYear(row) {
  const y = Number(row?.t_start_year)
  return Number.isFinite(y) ? Math.abs(y) : 0
}

// ---------------------------------------------------------------- 词条分类

/**
 * 把一个术语分成三类（决定它在 SQL 里怎么落地）：
 *
 *   'fts'  —— ≥2 字的词：search_tsv 是 bigram 词素，整词拆成 bigram 的 AND 链
 *             （「青霉素」→ `青霉 & 霉素`），语义等价「原文包含该子串」；
 *   'trgm' —— 单字（如「秦」「纸」）：bigram 语料里基本不存在单字词素，
 *             只能走 `ILIKE '%秦%'`，由 001-search.sql 的 GIN trgm 索引承担；
 *   'none' —— 纯标点/空白，没有词条。
 *
 * @param {string} term
 * @returns {{kind:'fts', tsquery:string} | {kind:'trgm', pattern:string} | {kind:'none'}}
 */
function classifyTerm(term) {
  const text = String(term ?? '').trim()
  if (!text) return { kind: 'none' }
  const tokens = tokenize(text)
  if (!tokens.length) return { kind: 'none' }
  // ASCII 词是「整词词素」，单字母也有意义；CJK 词素是 bigram，单字词素几乎不存在
  const usable = tokens.some((t) => (/^[a-z0-9]/i.test(t) ? t.length >= 1 : cpLength(t) >= 2))
  if (usable) return { kind: 'fts', tsquery: toTsQuery(text) }
  return { kind: 'trgm', pattern: text }
}

// ---------------------------------------------------------------- 同义词

/**
 * 读同义词扩展（进程内 Map 缓存，TTL 5 分钟；未命中同样缓存，避免击穿）。
 *
 * @param {string} term 查询词
 * @returns {Promise<string[]|null>} 扩展词数组；未命中返回 null
 */
export async function loadSynonym(term) {
  const key = normTerm(term)
  if (!key) return null

  const now = Date.now()
  const cached = synonymCache.get(key)
  if (cached && cached.expires > now) return cached.expands

  let expands = null
  try {
    const { rows } = await db.query(
      `SELECT expands FROM search_synonym WHERE term = $1 LIMIT 1`,
      [key],
    )
    const raw = rows[0]?.expands
    if (Array.isArray(raw)) {
      expands = raw.map((s) => String(s).trim()).filter(Boolean)
      if (!expands.length) expands = null
    }
  } catch (err) {
    // 迁移未应用（无 search_synonym 表）/ 只读库：降级为「无同义词」，不影响主检索
    if (!synonymWarned) {
      synonymWarned = true
      console.warn('[search] 同义词表不可用，跳过扩展：', err?.message || err)
    }
    expands = null
  }

  if (synonymCache.size >= SYNONYM_CACHE_MAX) {
    // Map 保持插入序：淘汰最早写入的一条（查询词基数很大时的兜底）
    const oldest = synonymCache.keys().next().value
    if (oldest !== undefined) synonymCache.delete(oldest)
  }
  synonymCache.set(key, { expires: now + SYNONYM_TTL_MS, expands })
  return expands
}

/** 清空同义词缓存（测试/运维用：改完表不想等 5 分钟时调用） */
export function clearSynonymCache() {
  synonymCache.clear()
}

// ---------------------------------------------------------------- 查询计划

/**
 * 把查询词编译成「待 OR 的匹配组」：
 *
 *   { ftsGroups: ['青霉 & 霉素', '盘尼西林', …],   // 走 search_tsv @@ to_tsquery
 *     patterns:  ['%纸%'],                        // 走 title/summary/search_text ILIKE（trgm 索引）
 *     synonyms:  ['盘尼西林', '纸'] }              // 实际生效的扩展词（回给前端观测）
 *
 * 同义词只对「主体词能进 tsquery」的查询生效：单字查询本来就整表 ILIKE，
 * 再叠加扩展词的收益很低，却会让 OR 组变长。
 *
 * @param {string} q
 * @returns {Promise<{ftsGroups:string[], patterns:string[], synonyms:string[]}>}
 */
export async function planSearch(q) {
  const text = String(q ?? '').trim()
  const spec = { ftsGroups: [], patterns: [], synonyms: [] }
  if (!text) return spec

  const base = classifyTerm(text)
  if (base.kind === 'fts') spec.ftsGroups.push(base.tsquery)
  else if (base.kind === 'trgm') spec.patterns.push(`%${base.pattern}%`)
  else return spec

  if (base.kind !== 'fts') return spec

  const expands = await loadSynonym(text)
  if (!expands?.length) return spec

  const ftsSeen = new Set(spec.ftsGroups)
  const patternSeen = new Set(spec.patterns)
  let trgmUsed = 0

  for (const term of expands) {
    const c = classifyTerm(term)
    if (c.kind === 'fts') {
      if (ftsSeen.has(c.tsquery)) continue
      ftsSeen.add(c.tsquery)
      spec.ftsGroups.push(c.tsquery)
      spec.synonyms.push(term)
    } else if (c.kind === 'trgm' && trgmUsed < MAX_TRGM_EXPANSIONS) {
      // pg_trgm 至少要 2~3 个字符才能用上 GIN 索引；
      // 单字扩展词（如「纸」）会让整条 SQL 退化为全表扫（50 万行实测 5.6 秒），
      // 因此扩展词只接受长度 ≥ 2 的 trgm 模式。用户自己输入单字时仍走原兜底。
      if (c.pattern.length < 2) continue
      const p = `%${c.pattern}%`
      if (patternSeen.has(p)) continue
      patternSeen.add(p)
      spec.patterns.push(p)
      spec.synonyms.push(term)
      trgmUsed++
    }
  }
  return spec
}

/**
 * 匹配组 → SQL 谓词片段 + 参数。
 * tsquery 组用 `|` 拼成 OR（一个参数），每个 ILIKE 模式复用同一个占位符三次。
 *
 * @param {{ftsGroups?:string[], patterns?:string[]}} spec
 * @returns {{predicate:string, params:string[]}}
 */
export function buildPredicate(spec) {
  const params = []
  const parts = []

  if (spec.ftsGroups?.length) {
    params.push(spec.ftsGroups.join(' | '))
    parts.push(`search_tsv @@ to_tsquery('simple', $${params.length})`)
  }

  if (spec.patterns?.length) {
    const ors = []
    for (const p of spec.patterns) {
      params.push(p)
      const n = params.length
      ors.push(`title ILIKE $${n} OR summary ILIKE $${n} OR search_text ILIKE $${n}`)
    }
    parts.push(`(${ors.join(' OR ')})`)
  }

  return { predicate: parts.join(' OR '), params }
}

/**
 * 旧 LIKE 兜底口径（title/summary/search_text 三条件 OR），
 * 现在复用 trgm 索引路径：`ILIKE '%q%'` 与该 LIKE 语义相同，但可走 GIN trgm。
 *
 * @param {string} q
 */
function fallbackSpec(q) {
  const text = String(q ?? '').trim()
  if (!text) return { ftsGroups: [], patterns: [], synonyms: [] }
  return { ftsGroups: [], patterns: [`%${text}%`], synonyms: [] }
}

// ---------------------------------------------------------------- 取数

/**
 * hits 查询（纯构造，便于外部脚本 EXPLAIN 与实测）。
 *
 * @param {{ftsGroups?:string[], patterns?:string[]}} spec
 * @param {number} limit
 * @returns {{sql:string, params:string[]}}
 */
export function buildHitQuery(spec, limit) {
  const { predicate, params } = buildPredicate(spec)
  // FTS 路径按 ts_rank 排序：同一批候选里相关度高的先进，避免只按年份取到无关条目。
  // $1 就是 buildPredicate 里第一个参数（ftsGroups 的 OR 组）。
  const order = spec.ftsGroups?.length
    ? `ORDER BY ts_rank(search_tsv, to_tsquery('simple', $1)) DESC, t_start_year NULLS LAST`
    : ORDER_TAIL
  const sql = `SELECT ${HIT_COLUMNS}
     FROM event
    WHERE status = 'published'
      AND (${predicate})
    ${order}
    LIMIT $${params.length + 1}`
  return { sql, params: [...params, limit * CANDIDATE_FACTOR] }
}

/** 高频词防护：命中超过这个数量就判定"过宽"，直接给提示而不是硬跑 */
const BROAD_LIMIT = 5000
const BROAD_TTL_MS = 10 * 60 * 1000
/** @type {Map<string, {broad:boolean, at:number}>} */
const broadCache = new Map()

/**
 * 判断查询是否过宽（命中数 > BROAD_LIMIT）。
 * 用 `SELECT count(*) FROM (... LIMIT N+1)` 把扫描量卡死在 N+1 行，
 * 避免像「纪事」这种命中近乎全库的词把 GIN 位图整个物化（50 万档实测 454 ms）。
 *
 * @param {{ftsGroups?:string[], patterns?:string[]}} spec
 * @param {string} key 缓存键（原查询词）
 */
export async function isTooBroad(spec, key) {
  const hit = broadCache.get(key)
  if (hit && Date.now() - hit.at < BROAD_TTL_MS) return hit.broad
  if (!spec.ftsGroups?.length) return false
  const { predicate, params } = buildPredicate(spec)
  // count 只扫前 5001 行，代价可控；与 fetchHits 同源，避免口径不一致
  const { rows } = await searchRead(
    `SELECT count(*)::int AS n
       FROM (SELECT 1 FROM event WHERE status = 'published' AND (${predicate}) LIMIT ${BROAD_LIMIT + 1}) t`,
    params,
  )
  const broad = (rows[0]?.n ?? 0) > BROAD_LIMIT
  if (broadCache.size > 500) broadCache.clear()
  broadCache.set(key, { broad, at: Date.now() })
  return broad
}

/**
 * 分面查询（纯构造）：一次 GROUP BY GROUPING SETS 同时产出 track / category / discipline。
 * 统计口径 = 与 hits 完全相同的 WHERE（不加 LIMIT）。
 *
 * @param {{ftsGroups?:string[], patterns?:string[]}} spec
 * @returns {{sql:string, params:string[]}}
 */
export function buildFacetQuery(spec) {
  const { predicate, params } = buildPredicate(spec)
  // 统一复用 src/search/facets.js 的 SQL 形状（GROUPING SETS 一次算三组维度）
  const { sql } = facetSql(`status = 'published' AND (${predicate})`)
  return { sql, params }
}

/**
 * 取候选行（limit × 3，交给 scoreHit 重排后再截断）。
 *
 * @param {{ftsGroups:string[], patterns:string[]}} spec
 * @param {number} limit
 */
/**
 * 检索读源选择。
 *
 * 实测结论（docs/report/read-split.md）：在本项目规模下，检索走只读副本
 * **QPS 收益为 0**（配对交错 p50 0.96–1.00x），瓶颈是单进程 Node 而非 PG
 * （服务端 Execution Time 仅 0.23–0.47 ms）。同时副本读存在 3–45 ms 的
 * 「读己之写」窗口，实测 50% 的写后立即读会读到旧值。
 *
 * 因此默认走主库保证一致性；当出现「写多读多、且可容忍秒级陈旧」的场景，
 * 设置 `SEARCH_READ_FROM=replica` 即可整体切到副本（副本不可达会自动回退主库）。
 */
const READ_FROM_REPLICA = String(process.env.SEARCH_READ_FROM || 'primary').toLowerCase() === 'replica'

/** 统一的检索读入口：默认主库，可按 env 切副本 */
function searchRead(sql, params) {
  return READ_FROM_REPLICA ? db.readQuery(sql, params) : db.query(sql, params)
}

async function fetchHits(spec, limit) {
  const { sql, params } = buildHitQuery(spec, limit)
  const { rows } = await searchRead(sql, params)
  return rows
}

/**
 * 分面聚合：失败时降级为空分面，不影响主结果。
 *
 * @param {{ftsGroups:string[], patterns:string[]}} spec
 * @returns {Promise<{track:{value:string,count:number}[], category:…, discipline:…}|null>}
 */
async function fetchFacets(spec) {
  const { sql, params } = buildFacetQuery(spec)
  try {
    const { rows } = await searchRead(sql, params)
    return shapeFacets(rows)
  } catch (err) {
    console.warn('[search] 分面聚合失败，降级为空 facets：', err?.message || err)
    return null
  }
}

// ---------------------------------------------------------------- 拼写建议

/** 词表缓存（10 分钟）：零命中时用编辑距离给出候选词 */
const VOCAB_TTL_MS = 10 * 60 * 1000
let vocabCache = { list: [], freq: new Map(), at: 0 }
let vocabWarned = false

async function loadVocab() {
  // 用 at > 0 判断「是否已尝试过」，而不是 list.length。
  // 否则词表为空（表不存在 / 无数据）时，每次零命中查询都会重新查库，
  // 实测让 searchMiss 从 1 ms 劣化到 67 ms（每请求多一次失败的 SQL 往返）。
  if (vocabCache.at > 0 && Date.now() - vocabCache.at < VOCAB_TTL_MS) return vocabCache
  try {
    const { rows } = await searchRead(
      `SELECT term, freq FROM search_vocab WHERE freq >= 2 ORDER BY freq DESC LIMIT 40000`,
    )
    vocabCache = {
      list: rows.map((r) => r.term),
      freq: new Map(rows.map((r) => [r.term, Number(r.freq) || 0])),
      at: Date.now(),
    }
  } catch (err) {
    if (!vocabWarned) {
      console.warn('[search] 拼写词表不可用，跳过建议：', err?.message || err)
      vocabWarned = true
    }
    vocabCache = { list: [], freq: new Map(), at: Date.now() }
  }
  return vocabCache
}

/**
 * 零命中时的拼写建议。任何异常都返回空数组，不影响主结果。
 * @param {string} q
 * @returns {Promise<{term:string, distance:number}[]>}
 */
async function safeSuggest(q) {
  const text = String(q ?? '').trim()
  if (text.length < 2 || text.length > 12) return []
  try {
    const voc = await loadVocab()
    if (!voc.list.length) return []
    const { suggest } = await import('../domain/spell.js')
    return suggest(text, voc.list, { maxDistance: 2, limit: 3, weights: voc.freq })
  } catch (err) {
    console.warn('[search] 拼写建议失败：', err?.message || err)
    return []
  }
}

export const routes = [
  /**
   * GET /api/search?q=秦&limit=20
   * → { q, total, hits:[{ slug, title, summary, time_text, t_start_year, track, score }],
   *     synonyms:[…], facets:{ track:[{value,count}], category:[…], discipline:[…] } }
   */
  ['GET', '/api/search', async ({ query }) => {
    const q = typeof query.q === 'string' ? query.q.trim() : ''
    const limit = Math.min(Math.max(Number(query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)

    // 空关键词直接返回空结果，不打数据库
    if (q.length < 1) return { q: '', total: 0, hits: [], synonyms: [], facets: emptyFacets() }

    let spec = await planSearch(q)
    if (!spec.ftsGroups.length && !spec.patterns.length) spec = fallbackSpec(q)

    // 高频词防护：过宽的词直接给提示（可用 &force=1 绕过）
    const force = query.force === '1' || query.force === 'true'
    if (!force) {
      try {
        if (await isTooBroad(spec, q)) {
          return {
            q,
            total: 0,
            hits: [],
            tooBroad: true,
            hint: `查询词「${q}」命中超过 ${BROAD_LIMIT} 条，范围过宽。请加限定词（朝代 / 人物 / 更具体的名词），或加 &force=1 强制返回。`,
            synonyms: spec.synonyms ?? [],
            facets: emptyFacets(),
          }
        }
      } catch (err) {
        // 探测失败不阻断主流程
        console.warn('[search] 过宽探测失败，继续执行：', err?.message || err)
      }
    }

    // hits 与 facets 并行；facets 永不抛错（内部降级）
    const facetTask = fetchFacets(spec)

    let rows
    let usedSpec = spec
    try {
      rows = await fetchHits(spec, limit)
    } catch (err) {
      // tsquery 路径不可用（旧 schema 无 search_tsv 等）：退回纯 trgm/LIKE 口径并重算分面
      console.warn('[search] FTS 路径不可用，回退 LIKE：', err?.message || err)
      usedSpec = fallbackSpec(q)
      rows = await fetchHits(usedSpec, limit)
    }

    const facets = usedSpec === spec ? await facetTask : await fetchFacets(usedSpec)

    const hits = rows
      .map((row) => ({ row, score: scoreHit(row, q) }))
      .sort((a, b) => b.score - a.score || absYear(a.row) - absYear(b.row))
      .slice(0, limit)
      .map(({ row, score }) => ({
        slug: row.slug,
        title: row.title,
        summary: row.summary,
        time_text: formatEventTime(row).text,
        t_start_year: row.t_start_year,
        track: row.track,
        score,
      }))

    return {
      q,
      total: hits.length,
      hits,
      synonyms: usedSpec.synonyms ?? [],
      // 零命中时给出拼写建议（基于 search_vocab 词表 + 编辑距离），帮助改正错字
      suggestions: hits.length === 0 ? await safeSuggest(q) : [],
      facets: facets ?? emptyFacets(),
    }
  }],
]
