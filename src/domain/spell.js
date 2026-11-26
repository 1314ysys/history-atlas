/**
 * 拼写容错层（零依赖、纯函数、无副作用、不碰数据库）。
 *
 * 用途：`q=青霉术` 这类错别字查询在 FTS / trgm 都命中不到时，
 * 从 `search_vocab` 词表里找出「最可能是用户想打的那几个词」，回给前端做
 * 「你是不是想找：青霉素」。
 *
 * 两个关键设计
 *   1) **按码位比较**：中文常见字都在 BMP 内，但扩展 B 区以后（如 𠀀 U+20000）是
 *      代理对，用 `str[i]` 会把它劈成两个「半个字符」，编辑距离因此虚高。
 *      这里统一用 `Array.from()` 取码位数组，1 个汉字/1 个代理对字符都算 1 个编辑单位。
 *   2) **剪枝**：编辑距离 ≥ 长度差，所以 `|len(a) - len(b)| > maxDistance` 的候选
 *      必然不可能是答案，直接跳过。词表按码位长度分桶后，只需比较
 *      `len(term) ± maxDistance` 这几个桶，30k 词表的 suggest 也在毫秒级。
 */

/**
 * 字符串 → 码位数组（1 个 emoji / 扩展区汉字 = 1 个元素）。
 * 非字符串入参按「空串」处理，避免 null/undefined 抛错。
 *
 * @param {unknown} s
 * @returns {string[]}
 */
export function toCodePoints(s) {
  if (typeof s !== 'string') return []
  return Array.from(s)
}

/**
 * 标准 Levenshtein 编辑距离（插入 / 删除 / 替换各计 1，无替换代价差异）。
 *
 * 复杂度 O(n·m)，空间 O(min(n,m))（滚动两行）。
 * 按**码位**而非 UTF-16 code unit 比较，中文与代理对字符都算 1 个编辑单位。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 最少编辑次数（a === b 时为 0）
 */
export function levenshtein(a, b) {
  const A = toCodePoints(a)
  const B = toCodePoints(b)
  const n = A.length
  const m = B.length

  // 空串：距离就是另一个串的长度
  if (n === 0) return m
  if (m === 0) return n
  if (a === b) return 0

  // prev 保存上一行，cur 是当前行；列数取 m+1（短串做列更省内存）
  let prev = new Array(m + 1)
  let cur = new Array(m + 1)
  for (let j = 0; j <= m; j++) prev[j] = j

  for (let i = 1; i <= n; i++) {
    cur[0] = i
    const ca = A[i - 1]
    for (let j = 1; j <= m; j++) {
      const cost = ca === B[j - 1] ? 0 : 1
      // 删除 A[i] / 插入 B[j] / 替换
      const del = prev[j] + 1
      const ins = cur[j - 1] + 1
      const sub = prev[j - 1] + cost
      cur[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub)
    }
    const tmp = prev
    prev = cur
    cur = tmp
  }
  return prev[m]
}

/**
 * 候选的排序键（越小越靠前）：
 *   distance 升序 → **前缀相同字符数降序** → 词频降序 → 长度差升序 → 字典序（保证稳定）
 *
 * 为什么要前缀：中文错字多发生在尾部（「蔡论」应为「蔡伦」），
 * 若只按字典序，同编辑距离的「主论/争论」会把正确项挤出 limit。
 * 为什么要词频：同距离同前缀时，常用词更可能是用户想输入的。
 */
function compareCandidate(x, y) {
  if (x.distance !== y.distance) return x.distance - y.distance
  if (x.prefix !== y.prefix) return y.prefix - x.prefix
  if (x.freq !== y.freq) return y.freq - x.freq
  if (x.lenDiff !== y.lenDiff) return x.lenDiff - y.lenDiff
  if (x.term === y.term) return 0
  return x.term < y.term ? -1 : 1
}

/** 两个词从头开始连续相同的码位数 */
function commonPrefixLen(a, b) {
  const A = Array.from(a)
  const B = Array.from(b)
  let i = 0
  const n = Math.min(A.length, B.length)
  while (i < n && A[i] === B[i]) i += 1
  return i
}

/**
 * 从词表里找与 `term` 的编辑距离 ≤ maxDistance 的候选（错别字纠正用）。
 *
 * 规则
 *   · 只返回 `distance <= maxDistance` 且**不等于原词**的候选（自身永远排除）；
 *   · 排序：distance 升序 → 长度差升序 → 词条字典序（稳定、可复现）；
 *   · 剪枝：|长度差| > maxDistance 的候选直接跳过（分桶后只扫相邻长度桶）；
 *   · 大小写：ASCII 词若与查询词仅大小写不同，视为「同一个词」排除。
 *
 * @param {string} term 用户输入的（可能拼错的）词
 * @param {string[]} vocabulary 词表（字符串数组，重复项自动去重）
 * @param {{maxDistance?: number, limit?: number, weights?: Map<string,number>|Record<string,number>}} [opts]
 *        weights 为可选的词频表（term → 频次），同距离同前缀时高频词优先
 * @returns {{term: string, distance: number}[]} 按可信度降序的候选
 */
export function suggest(term, vocabulary, opts = {}) {
  const needle = typeof term === 'string' ? term.trim() : ''
  if (!needle) return []
  if (!Array.isArray(vocabulary) || vocabulary.length === 0) return []

  const maxDistance = Number.isInteger(opts?.maxDistance) && opts.maxDistance >= 0
    ? opts.maxDistance
    : 2
  const limit = Number.isInteger(opts?.limit) && opts.limit >= 0 ? opts.limit : 3
  if (limit === 0 || maxDistance === 0) return []

  // 词频权重：Map 或普通对象都接受
  const weights = opts?.weights
  const freqOf = (w) => {
    if (!weights) return 0
    if (weights instanceof Map) return weights.get(w) ?? 0
    return weights[w] ?? 0
  }

  const needleCps = Array.from(needle)
  const needleLen = needleCps.length
  const needleLower = needle.toLowerCase()

  // 按码位长度分桶：只跟 |长度差| ≤ maxDistance 的桶比，长词/短词整桶跳过
  /** @type {Map<number, string[]>} */
  const buckets = new Map()
  const seen = new Set()
  for (const raw of vocabulary) {
    if (typeof raw !== 'string') continue
    const word = raw.trim()
    if (!word || seen.has(word)) continue
    seen.add(word)
    const len = Array.from(word).length
    // 剪枝①：长度差已经超过阈值，无论距离怎么算都不可能达标
    if (Math.abs(len - needleLen) > maxDistance) continue
    const bucket = buckets.get(len)
    if (bucket) bucket.push(word)
    else buckets.set(len, [word])
  }

  /** @type {{term:string, distance:number, lenDiff:number, prefix:number, freq:number}[]} 保持升序，长度 ≤ limit */
  const best = []
  const worst = () => best[best.length - 1]

  for (let len = Math.max(0, needleLen - maxDistance); len <= needleLen + maxDistance; len++) {
    const bucket = buckets.get(len)
    if (!bucket) continue
    for (const word of bucket) {
      // 剪枝②：原词（含仅大小写差异）不作为建议
      if (word === needle || word.toLowerCase() === needleLower) continue
      const distance = levenshtein(needle, word)
      if (distance > maxDistance) continue
      const cand = {
        term: word,
        distance,
        lenDiff: Math.abs(len - needleLen),
        prefix: commonPrefixLen(needle, word),
        freq: freqOf(word),
      }

      // 有界插入：装满且不比当前末位更好就丢弃
      if (best.length >= limit && compareCandidate(cand, worst()) >= 0) continue
      let i = best.length
      while (i > 0 && compareCandidate(best[i - 1], cand) > 0) i--
      best.splice(i, 0, cand)
      if (best.length > limit) best.pop()
    }
  }

  return best.map(({ term: t, distance }) => ({ term: t, distance }))
}

export default { levenshtein, suggest, toCodePoints }
