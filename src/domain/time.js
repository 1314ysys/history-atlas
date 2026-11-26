/**
 * 纪年工具 —— 全系统唯一的时间格式化/解析入口。
 * 约定：公元前为负数（前 403 年 → -403），公元后为正数。
 * 不存在公元 0 年；数据中若出现 0，视为公元前 1 年处理。
 */

export const PRECISIONS = ['day', 'month', 'year', 'decade', 'century', 'millennium', 'unknown']
export const CERTAINTIES = ['certain', 'probable', 'circa', 'disputed', 'legendary']

const CERTAINTY_PREFIX = { circa: '约', probable: '约', legendary: '' }
const CERTAINTY_SUFFIX = { disputed: '（有争议）', legendary: '（传说）' }

/** @param {number} y @returns {number} 规范化年份（0 → -1） */
export function normalizeYear(y) {
  const n = Number(y)
  if (!Number.isFinite(n)) return NaN
  return Math.trunc(n) === 0 ? -1 : Math.trunc(n)
}

/** @param {number} y @returns {string} 例：-403 → 前403年 */
export function formatYear(y) {
  const n = normalizeYear(y)
  if (Number.isNaN(n)) return '年代不明'
  return n < 0 ? `前${-n}年` : `${n}年`
}

/** 世纪：-403 → 前5世纪 */
export function formatCentury(y) {
  const n = normalizeYear(y)
  if (Number.isNaN(n)) return '年代不明'
  const c = Math.ceil(Math.abs(n) / 100)
  return n < 0 ? `前${c}世纪` : `${c}世纪`
}

/** 年代：-403 → 前400年代；2024 → 2020年代 */
export function formatDecade(y) {
  const n = normalizeYear(y)
  if (Number.isNaN(n)) return '年代不明'
  const d = Math.trunc(n / 10) * 10
  return d < 0 ? `前${-d}年代` : `${d}年代`
}

/** 千纪：-3000 → 前4千纪 */
export function formatMillennium(y) {
  const n = normalizeYear(y)
  if (Number.isNaN(n)) return '年代不明'
  const m = Math.ceil(Math.abs(n) / 1000)
  return n < 0 ? `前${m}千纪` : `${m}千纪`
}

function formatYmd(y, m, d) {
  const base = formatYear(y)
  if (!m) return base
  const mm = `${m}月`
  if (!d) return base.replace('年', `年${mm}`)
  return base.replace('年', `年${mm}${d}日`)
}

/**
 * 格式化一个事件的时间。
 * @param {{t_start_year:number,t_start_month?:number,t_start_day?:number,
 *          t_end_year?:number,t_end_month?:number,t_end_day?:number,
 *          t_precision?:string,t_certainty?:string}} ev
 * @returns {{ text:string, sort:number, precision:string, certainty:string }}
 */
export function formatEventTime(ev) {
  const precision = ev.t_precision || 'year'
  const certainty = ev.t_certainty || 'certain'
  const start = normalizeYear(ev.t_start_year)
  const end = ev.t_end_year == null ? null : normalizeYear(ev.t_end_year)

  let text
  if (precision === 'millennium') text = formatMillennium(start)
  else if (precision === 'century') text = formatCentury(start)
  else if (precision === 'decade') text = formatDecade(start)
  else if (precision === 'day' || precision === 'month') {
    text = formatYmd(start, ev.t_start_month, ev.t_start_day)
  } else text = formatYear(start)

  if (end != null && end !== start) {
    const endText = formatYear(end)
    text = `${text}—${endText}`
  }

  const prefix = CERTAINTY_PREFIX[certainty] || ''
  const suffix = CERTAINTY_SUFFIX[certainty] || ''
  return {
    text: `${prefix}${text}${suffix}`,
    sort: start,
    precision,
    certainty,
  }
}

/**
 * 解析用户输入的年份：'前403' / '公元前403' / '-403' / '403年'
 * @param {string} input @returns {number|null}
 */
export function parseYear(input) {
  if (input == null) return null
  const s = String(input).trim()
  if (!s) return null
  const bce = /^(前|公元前|BC|BCE)/i.test(s)
  const digits = s.replace(/[^\d]/g, '')
  if (!digits) return null
  const n = Number(digits)
  if (bce || s.startsWith('-')) return -n
  return n
}

/** 事件时间区间是否与 [from,to] 相交 */
export function overlapsRange(ev, from, to) {
  const s = ev.t_start_year
  const e = ev.t_end_year ?? ev.t_start_year
  return !(e < from || s > to)
}

/** 排序键：start → month → day */
export function sortKey(ev) {
  return [
    ev.t_start_year ?? 0,
    ev.t_start_month ?? 0,
    ev.t_start_day ?? 0,
  ]
}

/** 时间轴缩放档位 */
export const ZOOM_LEVELS = [
  { id: 'millennium', label: '千纪', span: 1000 },
  { id: 'century', label: '世纪', span: 100 },
  { id: 'decade', label: '十年', span: 10 },
]

/** 依当前可见跨度选择档位 */
export function pickZoomLevel(visibleSpan) {
  if (visibleSpan >= 1500) return ZOOM_LEVELS[0]
  if (visibleSpan >= 150) return ZOOM_LEVELS[1]
  return ZOOM_LEVELS[2]
}
