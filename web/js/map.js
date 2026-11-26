/**
 * 地图视图 —— 时间切片地图（MapLibre GL，UMD 全局 `maplibregl`，不 import）。
 *
 * 视图语义：不做全时段总览，而是「选中一个时间切片 → 显示该切片内的事件 + 该切片对应的疆域」。
 *   · 切片清单：GET /api/boundaries/list → [{ year, name, note }]，按年份升序构成切片序列
 *   · **切片窗口 = 选中切片年份 ±75 年**（SLICE_WINDOW = 75，本视图的切片窗口定义）
 *   · 疆域：GET /api/boundaries?year=<切片年份>（后端返回最近切片 GeoJSON）
 *   · 事件：GET /api/map/events?from=year-75&to=year+75
 *
 * 契约：createMapView({ container, onSelect }) → { setSlice({ from, to }), destroy() }
 *   初始切片取最接近 setSlice({ from, to }) 中点的切片；无参数时取清单正中那个。
 *
 * 图层（自下而上）：esri 栅格底图 → boundaries-fill → boundaries-line → events-circle
 *   底图：Esri Canvas 栅格，dark 用 World_Dark_Gray_Base、light 用 World_Light_Gray_Base；
 *        主题切换时整实例重建（数据 FC 留在状态里重新灌入），保留当前切片下标。
 */

import * as api from './api.js'
import { palette, withAlpha, getTheme, onThemeChange } from './theme.js'
import { t, formatYear, onLangChange } from './i18n.js'

/** 切片窗口半径：选中切片年份 ±75 年 */
const SLICE_WINDOW = 75
/** 拖动切片条的节流间隔（毫秒） */
const THROTTLE_MS = 150
/**
 * 底图瓦片：高德（AMap）中文注记路网图，无需 API Key。
 * 暗色主题下不做换源，而是用 raster paint 把同一套中文瓦片压暗，
 * 保证「中文注记」在两种主题下都成立。
 * 注：AMap 使用 GCJ-02 坐标，与 WGS-84 有约 500m 偏移；本视图是国家级尺度，可忽略。
 */
const AMAP_SUB = [1, 2, 3, 4]
const BASE_TILES = AMAP_SUB.map(
  (s) => `https://webrd0${s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}`,
)
const BASE_ATTRIBUTION = '© 高德地图 AutoNavi · © OpenStreetMap contributors'
const CENTER = [105, 34]
const ZOOM = 2.9
const EMPTY_FC = () => ({ type: 'FeatureCollection', features: [] })

/** 取整，非法值回退 */
function toInt(v, fallback) {
  const n = Number(v)
  return v == null || v === '' || !Number.isFinite(n) ? fallback : Math.trunc(n)
}

/** 把 /api/boundaries/list 的响应整理成按年份升序的切片数组 */
function normalizeSlices(res) {
  const list = Array.isArray(res?.slices) ? res.slices : []
  const clean = (s) => ({ year: toInt(s?.year, NaN), name: s?.name ?? '', note: s?.note ?? '' })
  return list.map(clean).filter((s) => Number.isFinite(s.year)).sort((a, b) => a.year - b.year)
}

/**
 * @param {{ container: HTMLElement, onSelect?: (ev: any) => void }} opts
 * @returns {{ setSlice: (range?: { from?: number, to?: number }) => Promise<void>, destroy: () => void }}
 */
export function createMapView({ container, onSelect } = {}) {
  if (!container) throw new Error('createMapView: container required')

  const ml = globalThis.maplibregl
  if (!ml) {
    // 降级：不抛异常，给可读提示，契约仍然成立
    container.innerHTML =
      `<div class="view-placeholder">${t('map.failed')}：地图库未加载（需要 ` +
      '<code>web/vendor/maplibre-gl.js</code> 暴露全局 <code>maplibregl</code>）</div>'
    return { setSlice: async () => {}, destroy() {} }
  }
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative'

  /* ---------------- 状态 ---------------- */

  let slices = [] // 切片序列（按年份升序）
  let index = -1 // 当前切片下标
  let applied = false // 该下标是否已取数（去重用）
  let hint = null // setSlice 传入的 {from,to}，用于挑初始切片
  let eventCount = 0
  let boundaryOk = null // null=未知 / true=有疆域 / false=缺失
  let bySlug = /** @type {Map<string, any>} */ (new Map())
  let eventsFC = EMPTY_FC()
  let boundariesFC = EMPTY_FC()
  let ticket = 0 // 请求序号：只采用最后一次切片切换的结果
  let slideTimer = null
  let pendingIndex = -1
  let destroyed = false
  let map = null
  let layerReady = false

  /* ---------------- DOM ---------------- */

  const h = (tag, cls, css) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (css) n.style.cssText = css
    return n
  }

  // container 的 `.view > *` 会把子元素拉满，故地图 / 图例 / 切片条都写回自身尺寸
  const el = h('div', '', 'position:absolute;inset:0')
  const legend = h('div', 'map-legend', 'width:auto;height:auto')
  const bar = h('div', 'slicebar', 'width:auto;height:auto')
  container.append(el, legend, bar)

  /** 图例行：返回色块与文案节点，主题 / 语言变化时重绘 */
  function legendRow(shape) {
    const row = h('div')
    const line = 'width:13px;height:2px;border-radius:1px;vertical-align:middle'
    const mark = h('i', '', shape === 'line' ? line : '')
    const text = h('span')
    row.append(mark, text)
    legend.append(row)
    return { mark, text }
  }
  const rowCn = legendRow('dot')
  const rowWorld = legendRow('dot')
  const rowBoundary = legendRow('line')

  // 切片条（底部居中）：名称 · 年份 | 滑杆 | 事件数
  const nameEl = h('span', 'slice-name')
  const sepEl = h('span')
  sepEl.textContent = ' · '
  const yearEl = h('span', 'slice-year')
  const statEl = h('span')
  const slider = h('input')
  Object.assign(slider, { type: 'range', min: '0', max: '0', step: '1', value: '0', disabled: true })
  bar.append(nameEl, sepEl, yearEl, slider, statEl)

  /* ---------------- 文案（全部走 t() / palette()） ---------------- */

  function paintLegend() {
    const p = palette()
    rowCn.mark.style.background = p.cn
    rowWorld.mark.style.background = p.world
    rowBoundary.mark.style.background = withAlpha(p.accent, 0.55)
    rowCn.text.textContent = t('panel.china')
    rowWorld.text.textContent = t('panel.world')
    rowBoundary.text.textContent = t('map.boundary')
  }

  function paintSlicebar() {
    slider.setAttribute('aria-label', t('map.slice'))
    slider.disabled = slices.length < 2
    const slice = slices[index] || null
    if (!slice) {
      nameEl.textContent = t('map.slice')
      yearEl.textContent = '—'
      statEl.textContent = '—'
      return
    }
    nameEl.textContent = slice.name || `${t('map.slice')} ${index + 1}`
    yearEl.textContent = formatYear(slice.year)
    // 右侧：该切片内事件数；疆域缺失时追加提示（不报错）
    statEl.textContent =
      `${eventCount} ${t('map.events')}` + (boundaryOk === false ? ` · ${t('map.noBoundary')}` : '')
    bar.title = slice.note || ''
  }

  paintLegend()
  paintSlicebar()

  /* ---------------- 地图实例 ---------------- */

  function baseStyle() {
    const dark = getTheme() !== 'light'
    const src = { type: 'raster', tiles: BASE_TILES, tileSize: 256, maxzoom: 16, attribution: BASE_ATTRIBUTION }
    const layer = { id: 'esri', type: 'raster', source: 'esri' }
    // 暗色主题：把中文底图整体压暗降饱和，避免白底刺眼
    if (dark) layer.paint = { 'raster-brightness-max': 0.52, 'raster-saturation': -0.45, 'raster-contrast': 0.05 }
    return { version: 8, sources: { esri: src }, layers: [layer] }
  }

  /** 图层未就绪时数据先留在状态里，load 之后统一灌入 */
  function pushData(id, data) {
    if (!map || !layerReady || destroyed) return
    try {
      map.getSource(id)?.setData?.(data)
    } catch (err) {
      console.warn(`[map] setData(${id}) failed:`, err?.message || err)
    }
  }

  function onClick(e) {
    const slug = e?.features?.[0]?.properties?.slug
    const ev = slug ? bySlug.get(slug) : null
    if (ev) onSelect?.(ev)
  }

  const cursor = (on) => () => {
    const c = map?.getCanvas?.()
    if (c) c.style.cursor = on ? 'pointer' : ''
  }

  /** 数据图层：疆域填充 + 疆域描边 + 事件点（颜色全部由 palette() 决定） */
  function addDataLayers(m) {
    const p = palette()
    if (!m.getSource('boundaries')) m.addSource('boundaries', { type: 'geojson', data: boundariesFC })
    if (!m.getLayer('boundaries-fill')) {
      m.addLayer({ id: 'boundaries-fill', type: 'fill', source: 'boundaries',
        paint: { 'fill-color': withAlpha(p.accent, 0.1), 'fill-opacity': 1 } })
    }
    if (!m.getLayer('boundaries-line')) {
      m.addLayer({ id: 'boundaries-line', type: 'line', source: 'boundaries',
        paint: { 'line-color': withAlpha(p.accent, 0.55), 'line-opacity': 1, 'line-width': 1 } })
    }
    if (!m.getSource('events')) m.addSource('events', { type: 'geojson', data: eventsFC })
    if (!m.getLayer('events-circle')) {
      m.addLayer({ id: 'events-circle', type: 'circle', source: 'events',
        paint: {
          'circle-radius': 4,
          // 中国 palette().cn / 世界 palette().world
          'circle-color': ['match', ['get', 'track'], 'cn', p.cn, 'world', p.world, p.fg3],
          'circle-opacity': 0.85,
          'circle-stroke-width': 0.6,
          'circle-stroke-color': withAlpha(p.bg, 0.75),
        } })
    }
    m.on('click', 'events-circle', onClick)
    m.on('mouseenter', 'events-circle', cursor(true))
    m.on('mouseleave', 'events-circle', cursor(false))
  }

  function buildMap() {
    const style = baseStyle()
    const m = new ml.Map({
      container: el, style, center: CENTER, zoom: ZOOM, attributionControl: { compact: true },
    })
    map = m
    layerReady = false
    try {
      // 只读浏览：关旋转，保持北向上
      m.dragRotate?.disable?.()
      m.touchZoomRotate?.disableRotation?.()
    } catch {
      /* 个别版本无此 API */
    }
    let errCount = 0
    m.on('error', (e) => {
      // 底图瓦片失败（离线 / CDN 抖动）只提示前几条，不刷屏
      if (errCount >= 3) return
      errCount++
      console.warn('[map]', e?.error?.message || e)
    })
    m.on('load', () => {
      if (destroyed || map !== m) return
      addDataLayers(m)
      layerReady = true
      pushData('boundaries', boundariesFC)
      pushData('events', eventsFC)
    })
    return m
  }

  /** 主题切换：整实例重建（底图写在 style 里），数据层由状态重灌 */
  function rebuildMap() {
    const prev = map
    map = null
    layerReady = false
    try {
      prev?.remove()
    } catch (err) {
      console.warn('[map] remove failed:', err?.message || err)
    }
    if (!destroyed) buildMap()
  }

  /* ---------------- 数据 ---------------- */

  function applyEvents(res) {
    const list = Array.isArray(res?.events) ? res.events : []
    bySlug = new Map()
    const features = []
    for (const ev of list) {
      const lat = Number(ev?.lat)
      const lon = Number(ev?.lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
      if (ev.slug) bySlug.set(ev.slug, ev)
      const geometry = { type: 'Point', coordinates: [lon, lat] }
      const properties = { slug: ev.slug, title: ev.title, track: ev.track, year: ev.t_start_year }
      features.push({ type: 'Feature', geometry, properties })
    }
    eventCount = features.length
    eventsFC = { type: 'FeatureCollection', features }
    pushData('events', eventsFC)
  }

  function applyBoundaries(res) {
    const features = Array.isArray(res?.features) ? res.features : []
    boundariesFC = { type: 'FeatureCollection', features }
    boundaryOk = features.length > 0 // 缺失时切片条显示 t('map.noBoundary')
    pushData('boundaries', boundariesFC)
  }

  /** 最接近范围中点的切片；无范围参数则取清单正中 */
  function nearestIndex(range) {
    if (!slices.length) return -1
    const from = toInt(range?.from, NaN)
    const to = toInt(range?.to, NaN)
    if (!Number.isFinite(from) || !Number.isFinite(to)) return Math.floor(slices.length / 2)
    const mid = (from + to) / 2
    const gap = (i) => Math.abs(slices[i].year - mid)
    let best = 0
    for (let i = 1; i < slices.length; i++) if (gap(i) < gap(best)) best = i
    return best
  }

  /** 切换切片：并行取疆域 + 事件窗口，任一失败不影响另一层 */
  async function applySlice(target) {
    if (!slices.length) return
    const i = Math.min(Math.max(toInt(target, 0), 0), slices.length - 1)
    if (i === index && applied) return
    index = i
    applied = true
    slider.value = String(i)
    paintSlicebar()

    const { year } = slices[i]
    const myTicket = ++ticket
    const [bRes, eRes] = await Promise.allSettled([
      api.getBoundaries(year),
      api.getMapEvents({ from: year - SLICE_WINDOW, to: year + SLICE_WINDOW }),
    ])
    if (destroyed || myTicket !== ticket) return

    if (bRes.status === 'fulfilled') applyBoundaries(bRes.value)
    else {
      console.warn('[map] boundaries failed:', bRes.reason?.message || bRes.reason)
      applyBoundaries(null) // 视为无疆域，只在切片条提示
    }
    if (eRes.status === 'fulfilled') applyEvents(eRes.value)
    else console.warn('[map] events failed:', eRes.reason?.message || eRes.reason)
    paintSlicebar()
  }

  /** 载入切片清单，然后确定初始切片 */
  async function loadSlices() {
    try {
      slices = normalizeSlices(await api.request('/api/boundaries/list'))
    } catch (err) {
      console.warn('[map] boundaries/list failed:', err?.message || err)
      slices = []
    }
    if (destroyed) return
    slider.max = String(Math.max(slices.length - 1, 0))
    paintSlicebar()
    if (slices.length) await applySlice(nearestIndex(hint))
  }

  /** 外部接口：{ from, to } → 最接近其中点的切片（无参数用清单正中） */
  async function setSlice(range) {
    hint = { from: toInt(range?.from, NaN), to: toInt(range?.to, NaN) }
    if (!slices.length) return // 清单未到：由 loadSlices 统一应用
    await applySlice(nearestIndex(hint))
  }

  /* ---------------- 交互（拖动节流 150ms） ---------------- */

  function scheduleSlide(immediate) {
    pendingIndex = toInt(slider.value, 0)
    if (slideTimer) clearTimeout(slideTimer)
    slideTimer = setTimeout(() => {
      slideTimer = null
      void applySlice(pendingIndex)
    }, immediate ? 0 : THROTTLE_MS)
  }

  slider.addEventListener('input', () => scheduleSlide(false))
  slider.addEventListener('change', () => scheduleSlide(true))

  /* ---------------- 主题 / 语言 ---------------- */

  const offTheme = onThemeChange(() => {
    if (destroyed) return
    rebuildMap() // 保留当前切片下标：事件 / 疆域 FC 原样重灌
    paintLegend()
    paintSlicebar()
  })

  const offLang = onLangChange(() => {
    if (destroyed) return
    paintLegend()
    paintSlicebar()
  })

  /* ---------------- 启动 ---------------- */

  buildMap()
  void loadSlices()

  /* ---------------- 销毁 ---------------- */

  function destroy() {
    destroyed = true
    ticket++
    if (slideTimer) clearTimeout(slideTimer)
    slideTimer = null
    try {
      offTheme()
      offLang()
    } catch {
      /* ignore */
    }
    try {
      map?.remove()
    } catch (err) {
      console.warn('[map] remove failed:', err?.message || err)
    }
    map = null
    layerReady = false
    bySlug = new Map()
    bar.remove()
    legend.remove()
    el.remove()
    if (container) container.innerHTML = ''
  }

  return { setSlice, destroy }
}
