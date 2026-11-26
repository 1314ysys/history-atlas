/**
 * bench/gen.js —— 合成事件数据生成器
 *
 * 设计目标：
 *  1) **确定性**：同 (scale, seed) 必然产出完全相同的数据，任何时候重跑结果一致；
 *  2) **可控规模**：事件数 N 由调用方给定，claims / sources 数量按固定比例派生；
 *  3) **可控分布**：年份按「古代稀疏 + 近世密集」双段分布生成，
 *     这样 10 年 / 100 年 / 1000 年窗口的选择率差异是真实可解释的，而不是人造均匀分布；
 *  4) **可检索**：植入 4 个标记词，用于 C 组「命中 1 条 / 命中 ~1000 条 / 无命中 / 中文命中」四档。
 *
 * 所有随机数来自「索引 → 哈希 → [0,1)」，与插入顺序无关，
 * 因此可以只生成 [from, from+count) 这一段而不必先算前面所有行。
 */

/** 事件表插入列顺序（不含 id / t_span：t_span 是 GENERATED） */
export const EVENT_COLS = [
  'slug', 'title', 'track', 'category', 'discipline',
  't_start_year', 't_start_month', 't_start_day',
  't_end_year', 't_end_month', 't_end_day',
  't_precision', 't_certainty',
  'place_slug', 'lat', 'lon',
  'summary', 'search_text', 'status', 'rev',
]

export const CLAIM_COLS = ['event_id', 'statement', 'evidence_level', 'confidence', 'disputed_group', 'adopted', 'rationale', 'sort_order']
export const SOURCE_COLS = ['event_id', 'claim_id', 'source_slug', 'locator', 'quote', 'quote_sha256', 'verified_status', 'verified_at']
export const PERSON_COLS = ['slug', 'name', 'birth_year', 'death_year', 'dynasty']
export const RELATION_COLS = ['from_slug', 'to_slug', 'type', 't_start_year', 't_end_year', 'source_slug']

export const CATEGORIES = [
  'politics', 'military', 'science', 'culture', 'religion',
  'economy', 'disaster', 'diplomacy', 'institution', 'engineering',
  'thought', 'art', 'medicine', 'astronomy', 'geography',
  'agriculture', 'navigation', 'law', 'education', 'transport',
]

const DYNASTIES = [
  '先秦', '秦', '汉', '三国', '晋', '南北朝', '隋', '唐', '五代', '宋',
  '辽', '金', '元', '明', '清', '民国', '古埃及', '古希腊', '罗马', '拜占庭',
  '中世纪欧洲', '近代欧洲', '美洲', '印度', '伊斯兰世界',
]

const CATEGORY_WORDS = [
  '战役', '变法', '发明', '著作', '条约', '起义', '迁都', '地震', '漕运', '科举',
  '营造', '译经', '航海', '疫病', '历法', '铸币', '水利', '边贸', '学潮', '行会',
]

export const PRECISIONS = ['day', 'month', 'year', 'decade', 'century', 'millennium', 'unknown']
export const CERTAINTIES = ['certain', 'probable', 'circa', 'disputed', 'legendary']
export const EVIDENCE_LEVELS = ['A', 'B', 'C', 'D']
export const VERIFY_STATUSES = ['verified', 'unverified', 'mismatch', 'missing']
export const RELATION_TYPES = ['师承', '同僚', '门生', '论敌', '亲属', '同乡', '共事', '书信往来']

/**
 * 植入的检索标记词。
 *  - single   : 全表只出现在 1 条事件里
 *  - thousand : 约 1000 条事件里（小规模时会退化为「全表」）
 *  - miss     : 永远不出现
 *  - zh       : 中文词，用于暴露「无分词/无 trigram」下的中文检索成本
 */
export const MARKERS = {
  single: 'moonorchidxq',
  thousand: 'watermillxq',
  miss: 'zzqqnotfoundxz',
  zh: '水运仪象台',
}

/** B 组时间窗口（绝对年份，锚定 1500 年前后这一史料最密集的波段） */
export const WINDOWS = [
  { id: '10y', from: 1495, to: 1505, label: '10 年窗口 [-1495,1505)' },
  { id: '100y', from: 1450, to: 1550, label: '100 年窗口 [1450,1550)' },
  { id: '1000y', from: 1000, to: 2000, label: '1000 年窗口 [1000,2000)' },
  { id: 'full', from: -5000, to: 2025, label: '全时段 [-5000,2025)' },
]

/** B 组「带过滤」版本使用的固定过滤条件 */
export const FILTER = { track: 'cn', categories: ['military', 'science', 'diplomacy'] }

/** 年份分布：65% 落在 [-5000,1500)，35% 落在 [1500,2025] */
const ANCIENT = { lo: -5000, hi: 1500, weight: 0.65 }
const MODERN = { lo: 1500, hi: 2025, weight: 0.35 }

/** 32 位整数散列（splitmix 风格），用于把索引打散成 [0,1) */
function h32(x) {
  let v = x >>> 0
  v = Math.imul(v ^ (v >>> 16), 0x21f0aaad) >>> 0
  v = Math.imul(v ^ (v >>> 15), 0x735a2d97) >>> 0
  return (v ^ (v >>> 15)) >>> 0
}

/**
 * 确定性伪随机数：同一个 (i, salt) 永远得到同一个 [0,1)。
 * @param {number} i @param {number} [salt] @returns {number}
 */
export function rand01(i, salt = 0) {
  const mix = (Math.imul(i, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0
  return h32(mix) / 4294967296
}

/** @param {number} i @param {number} salt @param {number} n */
function randInt(i, salt, n) {
  return Math.floor(rand01(i, salt) * n)
}

/**
 * 第 i 条事件的起始年份。
 * @param {number} i @returns {number}
 */
export function yearFor(i) {
  const r = rand01(i, 11)
  if (r < ANCIENT.weight) {
    const span = ANCIENT.hi - ANCIENT.lo
    return ANCIENT.lo + randInt(i, 12, span)
  }
  const span = MODERN.hi - MODERN.lo + 1
  return MODERN.lo + randInt(i, 13, span)
}

/**
 * 标记行：这些行强制 status='published'，保证检索档位不受状态过滤影响。
 * @param {number} i @param {number} total
 */
function markersFor(i, total) {
  const strideThousand = Math.max(1, Math.floor(total / 1000))
  const singleAt = Math.floor(total / 2)
  return {
    single: i === singleAt,
    thousand: strideThousand > 0 && i % strideThousand === Math.floor(strideThousand / 2),
    zh: i % Math.max(1, strideThousand) === 0 && i < 1000 * Math.max(1, strideThousand),
  }
}

/** @param {number} i @param {number} total @returns {string} */
function statusFor(i, total) {
  const m = markersFor(i, total)
  if (m.single || m.thousand || m.zh) return 'published'
  const r = rand01(i, 21)
  if (r < 0.92) return 'published'
  if (r < 0.945) return 'draft'
  if (r < 0.97) return 'reviewed'
  if (r < 0.99) return 'rejected'
  return 'staged'
}

/**
 * 生成 [from, from+count) 这一段事件行。
 * @param {number} from @param {number} count @param {number} total 全表规模（决定标记词步长）
 * @returns {any[][]} 每行元素顺序与 EVENT_COLS 一致
 */
export function makeEventRows(from, count, total) {
  const rows = []
  for (let k = 0; k < count; k++) {
    const i = from + k
    const m = markersFor(i, total)
    const dynasty = DYNASTIES[randInt(i, 31, DYNASTIES.length)]
    const word = CATEGORY_WORDS[randInt(i, 32, CATEGORY_WORDS.length)]
    const year = yearFor(i)
    const precision = PRECISIONS[randInt(i, 33, PRECISIONS.length)]
    const hasDay = precision === 'day'
    const hasMonth = hasDay || precision === 'month'

    // 15% 的事件本身跨若干年，让 t_span 不是退化的「单点范围」
    const wide = rand01(i, 34) < 0.15
    let width = 0
    if (wide) width = 1 + randInt(i, 35, 250)
    const endYear = wide ? year + width : null

    const hasPlace = rand01(i, 36) < 0.5
    const placeSlug = hasPlace ? `place-${randInt(i, 37, 4000)}` : null
    const lat = hasPlace ? Number((rand01(i, 38) * 140 - 60).toFixed(4)) : null
    const lon = hasPlace ? Number((rand01(i, 39) * 360 - 180).toFixed(4)) : null

    let suffix = ''
    if (m.single) suffix += ` ${MARKERS.single}`
    if (m.thousand) suffix += ` ${MARKERS.thousand}`
    const zhMark = m.zh ? ` ${MARKERS.zh}` : ''

    const title = `${dynasty}${word}·${i}号${zhMark}${suffix}`
    const summary = `${dynasty}时期${word}纪事第${i}条；参与规模约${randInt(i, 40, 9000)}人，` +
      `史料来源分级${EVIDENCE_LEVELS[randInt(i, 41, 4)]}。${suffix}`
    const searchText = `${title} ${summary}`.toLowerCase().slice(0, 160)

    rows.push([
      `ev-${i}`,
      title,
      rand01(i, 42) < 0.45 ? 'cn' : 'world',
      CATEGORIES[randInt(i, 43, CATEGORIES.length)],
      rand01(i, 44) < 0.3 ? 'tech' : null,
      year,
      hasMonth ? 1 + randInt(i, 45, 12) : null,
      hasDay ? 1 + randInt(i, 46, 28) : null,
      endYear,
      null,
      null,
      precision,
      CERTAINTIES[randInt(i, 47, CERTAINTIES.length)],
      placeSlug,
      lat,
      lon,
      summary,
      searchText,
      statusFor(i, total),
      1 + randInt(i, 48, 4),
    ])
  }
  return rows
}

/**
 * 为一批事件生成 claims（每条 1~3 条）。
 * claim_id 由调用方的 RETURNING 回填（见 run.js），故这里只产出行。
 * @param {{id:number, idx:number}[]} events
 * @returns {any[][]}
 */
export function makeClaimRows(events) {
  const rows = []
  for (const { id, idx } of events) {
    const n = 1 + randInt(idx, 51, 3)
    for (let j = 0; j < n; j++) {
      const salt = 52 + j * 7
      const word = CATEGORY_WORDS[randInt(idx, salt, CATEGORY_WORDS.length)]
      const statement = `第${idx}条事件关于${word}的第${j + 1}种说法——` +
        `${rand01(idx, salt + 1) < 0.5 ? '主流通说' : '少数异说'}，见卷${1 + randInt(idx, salt + 2, 300)}。`
      rows.push([
        id,
        statement,
        EVIDENCE_LEVELS[randInt(idx, salt + 3, 4)],
        Number(rand01(idx, salt + 4).toFixed(3)),
        rand01(idx, salt + 5) < 0.2 ? `g${randInt(idx, salt + 6, 5)}` : null,
        j === 0,
        rand01(idx, salt + 7) < 0.4 ? '与另说互证' : null,
        j,
      ])
    }
  }
  return rows
}

/**
 * 为一批事件生成 sources（每条 1~2 条）。claim_id 由调用方回填。
 * @param {{id:number, idx:number}[]} events
 * @param {Map<number, number[]>} claimIdsByEvent 真实 claim id 列表
 * @returns {any[][]}
 */
export function makeSourceRows(events, claimIdsByEvent) {
  const rows = []
  for (const { id, idx } of events) {
    const n = 1 + randInt(idx, 61, 2)
    const claimIds = claimIdsByEvent.get(id) ?? []
    for (let j = 0; j < n; j++) {
      const salt = 62 + j * 9
      const quote = `「${CATEGORY_WORDS[randInt(idx, salt, CATEGORY_WORDS.length)]}之记载第${idx}条」` +
        `，卷${1 + randInt(idx, salt + 1, 400)}，页${1 + randInt(idx, salt + 2, 900)}。`
      rows.push([
        id,
        claimIds.length ? claimIds[j % claimIds.length] : null,
        `src-${randInt(idx, salt + 3, 2000)}`,
        `p.${1 + randInt(idx, salt + 4, 900)}`,
        quote,
        fakeSha256(idx * 131 + j),
        VERIFY_STATUSES[randInt(idx, salt + 5, 4)],
        rand01(idx, salt + 6) < 0.3 ? '2026-01-01T00:00:00Z' : null,
      ])
    }
  }
  return rows
}

/** 确定性 64 位 hex（不用于安全，只占位） */
function fakeSha256(n) {
  let out = ''
  for (let k = 0; k < 8; k++) out += h32(n * 17 + k * 2654435761).toString(16).padStart(8, '0')
  return out.slice(0, 64)
}

/**
 * 人物行：P 个。
 * @param {number} count @returns {any[][]}
 */
export function makePersons(count) {
  const rows = []
  for (let i = 0; i < count; i++) {
    const dynasty = DYNASTIES[randInt(i, 71, DYNASTIES.length)]
    rows.push([
      `p-${i}`,
      `${dynasty}人物${i}`,
      -800 + randInt(i, 72, 2600),
      -750 + randInt(i, 73, 2600),
      dynasty,
    ])
  }
  return rows
}

/**
 * 关系行：R 条，(from,to,type) 唯一。
 * 前 400 条强制挂在 p-0 上，制造一个高「度数」hub，供 2 跳 BFS 展开。
 * @param {number} count @param {number} personCount @returns {any[][]}
 */
export function makeRelations(count, personCount) {
  const rows = []
  const seen = new Set()
  const push = (a, b, t, i) => {
    if (a === b) return false
    const key = `${a}\u0000${b}\u0000${t}`
    if (seen.has(key)) return false
    seen.add(key)
    rows.push([a, b, t, -500 + randInt(i, 81, 2400), null, `src-${randInt(i, 82, 2000)}`])
    return true
  }

  const hubEdges = Math.min(400, Math.max(4, Math.floor(count / 25)))
  for (let j = 0; j < hubEdges; j++) {
    const target = 1 + randInt(j, 83, Math.max(1, personCount - 1))
    push('p-0', `p-${target}`, RELATION_TYPES[j % RELATION_TYPES.length], j)
  }

  let i = 0
  while (rows.length < count && i < count * 8) {
    const a = randInt(i, 84, personCount)
    const b = randInt(i, 85, personCount)
    push(`p-${a}`, `p-${b}`, RELATION_TYPES[randInt(i, 86, RELATION_TYPES.length)], i)
    i++
  }
  return rows
}

/**
 * 把「事件 + claims + sources」序列化成 JSONL 行（E 组压缩测试用）。
 * @param {number} count
 * @returns {string[]}
 */
export function jsonlLines(count) {
  const lines = []
  for (let i = 0; i < count; i++) {
    const e = makeEventRows(i, 1, count)[0]
    const claimCount = 1 + randInt(i, 51, 3)
    const claims = []
    for (let j = 0; j < claimCount; j++) {
      claims.push({
        statement: `第${i}条事件关于${CATEGORY_WORDS[randInt(i, 52 + j * 7, CATEGORY_WORDS.length)]}的第${j + 1}种说法，见卷${1 + randInt(i, 54 + j * 7, 300)}。`,
        evidence_level: EVIDENCE_LEVELS[randInt(i, 55 + j * 7, 4)],
        confidence: Number(rand01(i, 56 + j * 7).toFixed(3)),
      })
    }
    const sourceCount = 1 + randInt(i, 61, 2)
    const sources = []
    for (let j = 0; j < sourceCount; j++) {
      sources.push({
        source_slug: `src-${randInt(i, 63 + j * 9, 2000)}`,
        locator: `p.${1 + randInt(i, 64 + j * 9, 900)}`,
        quote: `「${CATEGORY_WORDS[randInt(i, 65 + j * 9, CATEGORY_WORDS.length)]}之记载第${i}条」，卷${1 + randInt(i, 66 + j * 9, 400)}。`,
        verified_status: VERIFY_STATUSES[randInt(i, 67 + j * 9, 4)],
      })
    }
    lines.push(JSON.stringify({
      slug: e[0], title: e[1], track: e[2], category: e[3], discipline: e[4],
      t_start_year: e[5], t_start_month: e[6], t_end_year: e[8],
      t_precision: e[11], t_certainty: e[12], place_slug: e[13],
      summary: e[16], search_text: e[17], status: e[18], claims, sources,
    }))
  }
  return lines
}
