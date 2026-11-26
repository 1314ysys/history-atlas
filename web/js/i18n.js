/**
 * 极简 i18n。仅覆盖界面文案；史料内容（事件标题/摘要）本身仍是中文原文。
 * 用法：import { t, getLang, setLang, onLangChange } from './i18n.js'
 */

const DICT = {
  zh: {
    'app.title': 'History Atlas',
    'app.subtitle': '编年 · 对照 · 溯源',
    'app.theme.dark': '暗色',
    'app.theme.light': '亮色',
    'app.lang': 'EN',

    'nav.timeline': '时间轴',
    'nav.map': '地图',
    'nav.graph': '人物关系',

    'search.placeholder': '搜索事件、人物、地点…（如 水运仪象台）',
    'search.empty': '无匹配结果',
    'search.failed': '搜索失败',

    'stats.events': '事件',
    'stats.cn': '中国',
    'stats.world': '世界',
    'stats.persons': '人物',
    'stats.verified': '已校验',

    'panel.title': '筛选',
    'panel.range': '时间范围',
    'panel.from': '起',
    'panel.to': '止',
    'panel.tracks': '显示轨道',
    'panel.china': '中国',
    'panel.world': '世界',
    'panel.categories': '类别',
    'panel.apply': '应用',
    'panel.reset': '重置',
    'panel.count': '当前视图',
    'panel.unit': '条',
    'panel.hide': '收起',
    'panel.show': '筛选',

    'timeline.loading': '载入中…',
    'timeline.empty': '当前范围内没有事件',
    'timeline.failed': '加载失败',
    'timeline.hint': '拖动平移 · 滚轮缩放 · 双击复位',
    'timeline.cluster': '个事件',

    'map.slice': '时间切片',
    'map.sliceOf': '切片',
    'map.boundary': '疆域（示意）',
    'map.events': '事件',
    'map.noBoundary': '该年代无疆域数据',
    'map.failed': '地图加载失败',

    'graph.hint': '点击节点查看人物生平与关系',
    'graph.hubs': '高频人物',
    'graph.center': '中心',
    'graph.people': '人',
    'graph.links': '条关系',
    'graph.loading': '载入中…',
    'graph.failed': '关系图加载失败',

    'detail.claims': '说法',
    'detail.sources': '史料出处',
    'detail.persons': '相关人物',
    'detail.place': '地点',
    'detail.verified': '已核实',
    'detail.unverified': '未核实',
    'detail.mismatch': '已变更',
    'detail.missing': '缺档',
    'detail.noQuote': '（未附原文）',
    'detail.latlon': '经纬度',

    'person.lifespan': '生卒',
    'person.dynasty': '朝代',
    'person.events': '相关事件',
    'person.relations': '人物关系',
    'person.noEvents': '暂无关联事件',
    'person.noRelations': '暂无关联人物',
    'person.born': '生于',
    'person.died': '卒于',
    'person.unknown': '不详',
    'person.openGraph': '查看关系网',

    'common.close': '关闭',
    'common.loading': '载入中…',
    'common.error': '出错了',
    'common.bce': '前',
    'common.year': '年',
    'common.people': '人',
  },

  en: {
    'app.title': 'History Atlas',
    'app.subtitle': 'Chronology · Comparison · Provenance',
    'app.theme.dark': 'Dark',
    'app.theme.light': 'Light',
    'app.lang': '中文',

    'nav.timeline': 'Timeline',
    'nav.map': 'Map',
    'nav.graph': 'People',

    'search.placeholder': 'Search events, people, places… (e.g. 水运仪象台)',
    'search.empty': 'No matches',
    'search.failed': 'Search failed',

    'stats.events': 'events',
    'stats.cn': 'China',
    'stats.world': 'World',
    'stats.persons': 'people',
    'stats.verified': 'verified',

    'panel.title': 'Filters',
    'panel.range': 'Time range',
    'panel.from': 'From',
    'panel.to': 'To',
    'panel.tracks': 'Tracks',
    'panel.china': 'China',
    'panel.world': 'World',
    'panel.categories': 'Categories',
    'panel.apply': 'Apply',
    'panel.reset': 'Reset',
    'panel.count': 'In view',
    'panel.unit': '',
    'panel.hide': 'Hide',
    'panel.show': 'Filters',

    'timeline.loading': 'Loading…',
    'timeline.empty': 'No events in this range',
    'timeline.failed': 'Load failed',
    'timeline.hint': 'Drag to pan · scroll to zoom · double-click to reset',
    'timeline.cluster': 'events',

    'map.slice': 'Time slice',
    'map.sliceOf': 'Slice',
    'map.boundary': 'Territory (schematic)',
    'map.events': 'events',
    'map.noBoundary': 'No territory data for this era',
    'map.failed': 'Map failed to load',

    'graph.hint': 'Click a node to see biography and relations',
    'graph.hubs': 'Most connected',
    'graph.center': 'Center',
    'graph.people': 'people',
    'graph.links': 'links',
    'graph.loading': 'Loading…',
    'graph.failed': 'Graph failed to load',

    'detail.claims': 'Accounts',
    'detail.sources': 'Sources',
    'detail.persons': 'People',
    'detail.place': 'Place',
    'detail.verified': 'verified',
    'detail.unverified': 'unverified',
    'detail.mismatch': 'changed',
    'detail.missing': 'missing',
    'detail.noQuote': '(no quotation)',
    'detail.latlon': 'Lat/Lon',

    'person.lifespan': 'Lifespan',
    'person.dynasty': 'Dynasty',
    'person.events': 'Events',
    'person.relations': 'Relations',
    'person.noEvents': 'No related events',
    'person.noRelations': 'No related people',
    'person.born': 'b.',
    'person.died': 'd.',
    'person.unknown': 'unknown',
    'person.openGraph': 'Open network',

    'common.close': 'Close',
    'common.loading': 'Loading…',
    'common.error': 'Error',
    'common.bce': 'BCE ',
    'common.year': '',
    'common.people': 'people',
  },
}

const STORAGE_KEY = 'atlas.lang'
let lang = 'zh'
const listeners = new Set()

function detect() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'zh' || saved === 'en') return saved
    const nav = (navigator.language || '').toLowerCase()
    return nav.startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'zh'
  }
}

lang = detect()

export function getLang() {
  return lang
}

export function setLang(next) {
  if (next !== 'zh' && next !== 'en') return
  if (next === lang) return
  lang = next
  try { localStorage.setItem(STORAGE_KEY, next) } catch { /* ignore */ }
  document.documentElement.setAttribute('lang', next === 'zh' ? 'zh-CN' : 'en')
  for (const fn of listeners) {
    try { fn(lang) } catch (e) { console.error(e) }
  }
}

export function toggleLang() {
  setLang(lang === 'zh' ? 'en' : 'zh')
}

export function onLangChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * 取文案。缺 key 时回退中文，再回退 key 本身。
 * @param {string} key
 * @param {Record<string, string|number>} [vars] 形如 { n: 3 } 替换 {n}
 */
export function t(key, vars) {
  let s = DICT[lang]?.[key] ?? DICT.zh[key] ?? key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
  return s
}

/** 年份的本地化写法：zh → 前403年，en → 403 BCE */
export function formatYear(y) {
  if (y == null || Number.isNaN(Number(y))) return t('person.unknown')
  const n = Math.trunc(Number(y))
  if (n < 0) return lang === 'zh' ? `前${-n}年` : `${-n} BCE`
  return lang === 'zh' ? `${n}年` : `${n}`
}

/** 世纪 / 年代的本地化写法 */
export function formatCentury(y) {
  const n = Math.trunc(Number(y))
  const c = Math.ceil(Math.abs(n) / 100)
  if (n < 0) return lang === 'zh' ? `前${c}世纪` : `${c}th c. BCE`
  return lang === 'zh' ? `${c}世纪` : `${c}th c.`
}

export function formatDecade(y) {
  const n = Math.trunc(Number(y))
  const d = Math.trunc(n / 10) * 10
  if (d < 0) return lang === 'zh' ? `前${-d}年代` : `${-d}s BCE`
  return lang === 'zh' ? `${d}年代` : `${d}s`
}

/** 依精度与确定度渲染事件时间，与后端 domain/time.js 语义保持一致 */
export function formatEventTime(ev) {
  const precision = ev?.t_precision || 'year'
  const certainty = ev?.t_certainty || 'certain'
  const start = ev?.t_start_year
  const end = ev?.t_end_year

  let base
  if (precision === 'millennium') base = lang === 'zh' ? `${Math.ceil(Math.abs(start) / 1000)}千纪` : `${Math.ceil(Math.abs(start) / 1000)}th mill.`
  else if (precision === 'century') base = formatCentury(start)
  else if (precision === 'decade') base = formatDecade(start)
  else base = formatYear(start)

  if (end != null && end !== start) base = `${base} — ${formatYear(end)}`

  if (certainty === 'circa' || certainty === 'probable') base = lang === 'zh' ? `约${base}` : `c. ${base}`
  if (certainty === 'disputed') base = lang === 'zh' ? `${base}（有争议）` : `${base} (disputed)`
  if (certainty === 'legendary') base = lang === 'zh' ? `${base}（传说）` : `${base} (legend)`
  return base
}
