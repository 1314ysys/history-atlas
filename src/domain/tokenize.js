/**
 * 中文检索的分词层（零依赖、纯 JS、无副作用）。
 *
 * 设计依据：`docs/plan/history-timeline-v1.md` §0「中文分词：应用层 jieba → 存 token 列；
 * tsvector/GIN」。v1 不引入 jieba（禁新增依赖），用**二元组 bigram** 代替词级切分：
 *
 *   「水运仪象台」→ 水运 / 运仪 / 仪象 / 象台
 *
 * bigram 的好处是「不需要词典」——任何长度 ≥2 的中文子串都必然对应一串相邻 bigram，
 * 所以 `toTsQuery()` 把 bigram 用 `&`（AND）连起来时，语义上等价于「原文包含该子串」，
 * 这正是 LIKE '%q%' 想表达的东西，但可以走 GIN 索引。
 *
 * 单字片段（如「秦」）保留单字；ASCII/数字按 `/[a-z0-9]+/i` 切词并转小写。
 */

/** CJK 码位区间：基本区、扩展 A、兼容表意、扩展 B–I（含 U+30000 之后） */
const CJK_RANGES = [
  [0x3400, 0x4dbf], // 扩展 A
  [0x4e00, 0x9fff], // 基本区
  [0xf900, 0xfaff], // 兼容表意
  [0x20000, 0x2a6df], // 扩展 B
  [0x2a700, 0x2b73f], // 扩展 C
  [0x2b740, 0x2b81f], // 扩展 D
  [0x2b820, 0x2ceaf], // 扩展 E
  [0x2ceb0, 0x2ebef], // 扩展 F
  [0x2f800, 0x2fa1f], // 兼容表意增补
  [0x30000, 0x3134f], // 扩展 G–I
]

/** @param {number} cp 码位 */
function isCJK(cp) {
  for (const [lo, hi] of CJK_RANGES) if (cp >= lo && cp <= hi) return true
  return false
}

const ASCII_WORD = /^[a-z0-9]$/i

/**
 * 词条化：中文（含扩展 A/B 区）连续片段 → 二元组 bigram；ASCII/数字 → 小写单词。
 * 去重（保持首次出现顺序），过滤长度 < 1 的空串。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return []

  const out = []
  /** @type {string[]} 当前 CJK 片段的字符 */
  let cjk = []
  /** @type {string[]} 当前 ASCII 片段 */
  let ascii = []

  const flushAscii = () => {
    if (ascii.length) {
      out.push(ascii.join('').toLowerCase())
      ascii = []
    }
  }
  const flushCjk = () => {
    if (!cjk.length) return
    if (cjk.length === 1) {
      out.push(cjk[0])
    } else {
      for (let i = 0; i + 1 < cjk.length; i++) out.push(cjk[i] + cjk[i + 1])
    }
    cjk = []
  }

  // 用 for...of 按码位迭代，代理对（扩展 B 及以后）不会被劈成两半
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (isCJK(cp)) {
      flushAscii()
      cjk.push(ch)
    } else if (ASCII_WORD.test(ch)) {
      flushCjk()
      ascii.push(ch)
    } else {
      // 标点、空白、其它文字系统：静默断开
      flushCjk()
      flushAscii()
    }
  }
  flushCjk()
  flushAscii()

  const seen = new Set()
  const tokens = []
  for (const t of out) {
    if (typeof t !== 'string' || t.length < 1) continue
    if (seen.has(t)) continue
    seen.add(t)
    tokens.push(t)
  }
  return tokens
}

/**
 * token 列表 → 供 `to_tsvector('simple', $1::text)` 使用的词串（空格分隔）。
 *
 * @param {string[]} tokens
 * @returns {string}
 */
export function toTsv(tokens) {
  if (!Array.isArray(tokens)) return ''
  return tokens.filter((t) => typeof t === 'string' && t.length > 0).join(' ')
}

/**
 * 查询串 → `to_tsquery('simple', $1)` 表达式。
 *
 * 中文 bigram 用 `&` 连接（AND 语义 = 原文包含该子串）；ASCII 用原文（小写）；
 * 单字查询直接返回该字；无 token 时返回 `''`（调用方应据此回退 LIKE）。
 *
 * 注意：tokenize 只产出 `[a-z0-9]` 与 CJK 字符，因此结果里不会出现
 * `& | ! ( ) : ' *` 等 tsquery 元字符，无需额外转义。
 *
 * @param {string} q
 * @returns {string}
 */
export function toTsQuery(q) {
  const tokens = tokenize(q)
  if (tokens.length === 0) return ''
  if (tokens.length === 1) return tokens[0]
  return tokens.join(' & ')
}

export default { tokenize, toTsv, toTsQuery }
