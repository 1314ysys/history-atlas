/**
 * 前端引导器（v2）
 *
 * 视图契约：
 *   timeline.js  createTimeline({ container, onSelect, onRange, onStats })
 *                  → { setRange(from,to), getRange(), setFilters({tracks,categories}), refresh(), destroy() }
 *   map.js       createMapView({ container, onSelect })
 *                  → { setSlice({from,to}), destroy() }
 *   graph.js     createGraphView({ container, onSelectPerson })
 *                  → { showHubs(), showPerson(slug), destroy() }
 *   detail.js    renderDetail(container, payload) / renderPerson(container, payload)
 */

import * as api from './api.js'
import { t, getLang, toggleLang, onLangChange, formatYear } from './i18n.js'
import { getTheme, toggleTheme, onThemeChange, applyTheme } from './theme.js'

const $ = (sel) => document.querySelector(sel)

const CATEGORIES = [
  { key: '政治', zh: '政治', en: 'Politics' },
  { key: '军事', zh: '军事', en: 'Military' },
  { key: '科技', zh: '科技', en: 'Technology' },
  { key: '文化', zh: '文化', en: 'Culture' },
  { key: '经济', zh: '经济', en: 'Economy' },
  { key: '社会', zh: '社会', en: 'Society' },
  { key: '外交', zh: '外交', en: 'Foreign' },
]

const state = {
  view: 'timeline',
  range: { from: -3000, to: 2100 },
  tracks: new Set(['cn']),
  cats: new Set(CATEGORIES.map((c) => c.key)),
  selectedSlug: null,
  lastPersonSlug: null,
  views: {},
  modules: {},
  count: 0,
}

/* ---------------- i18n 应用 ---------------- */

const catLabel = (key) => CATEGORIES.find((c) => c.key === key)?.[getLang()] ?? key

function applyI18n() {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n)
  for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh)
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle)
  document.documentElement.setAttribute('lang', getLang() === 'zh' ? 'zh-CN' : 'en')
  $('#btn-lang').textContent = t('app.lang')
  $('#btn-theme').textContent = getTheme() === 'dark' ? '☾' : '☀'
  $('#btn-theme').title = getTheme() === 'dark' ? t('app.theme.dark') : t('app.theme.light')
  renderCatChips()
  syncPanelLabels()
}

/* ---------------- 构建号 / 自适应 / 诊断 ---------------- */

async function renderBuild() {
  try {
    const b = await api.getBuild()
    $('#build').textContent = `b-${b.build}`
  } catch {
    $('#build').textContent = 'b-?'
  }
}

/** 窄屏自动收起筛选面板，把宽度全留给时间轴 */
let panelTouched = false
function autoPanel() {
  const p = $('#panel')
  if (!p || panelTouched) return
  if (window.innerWidth < 1100) p.classList.add('collapsed')
  else p.classList.remove('collapsed')
  const btn = $('#panel-toggle')
  if (btn) btn.textContent = p.classList.contains('collapsed') ? '+' : '−'
}

/** 地址栏带 ?debug=1 时显示实时几何诊断 */
function setupDebug() {
  const flag = new URLSearchParams(location.search)
  if (!flag.has('debug')) return
  const el = document.createElement('div')
  el.id = 'debug'
  document.body.appendChild(el)
  const tick = () => {
    const cv = document.querySelector('#view canvas')
    const cr = cv ? cv.getBoundingClientRect() : null
    const pr = $('#panel') ? $('#panel').getBoundingClientRect() : null
    const de = document.documentElement
    el.textContent = [
      `win   ${window.innerWidth}x${window.innerHeight}   dpr ${window.devicePixelRatio}`,
      `doc   ${de.scrollWidth}   overflow ${de.scrollWidth - window.innerWidth}`,
      cr ? `canvas ${Math.round(cr.width)}x${Math.round(cr.height)}  bmp ${cv.width}x${cv.height}  ratio ${(cv.width / cr.width).toFixed(3)}` : 'canvas none',
      cr ? `right ${Math.round(cr.right)}  gap ${Math.round(window.innerWidth - cr.right)}` : '',
      pr ? `panel ${Math.round(pr.left)},${Math.round(pr.top)}  ${Math.round(pr.width)}x${Math.round(pr.height)}  collapsed=${$('#panel').classList.contains('collapsed')}` : '',
      `build ${$('#build')?.textContent || '-'}`,
      `data  ${window.__atlasTimelineSource || '-'}`,
    ].filter(Boolean).join('\n')
  }
  tick()
  setInterval(tick, 400)
}

/* ---------------- toast ---------------- */

let toastTimer = null
export function toast(msg, ms = 2200) {
  const el = $('#toast')
  el.textContent = msg
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, ms)
}

/* ---------------- stats ---------------- */

async function renderStats() {
  try {
    const s = await api.getStats()
    const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
    $('#stats').innerHTML = [
      `${t('stats.events')} <b>${fmt(s.events)}</b>`,
      `${t('stats.cn')} <b>${fmt(s.cn)}</b>`,
      `${t('stats.world')} <b>${fmt(s.world)}</b>`,
      `${t('stats.persons')} <b>${fmt(s.persons)}</b>`,
      `${t('stats.verified')} <b>${fmt(s.verified)}</b>`,
    ].join('')
  } catch (err) {
    $('#stats').innerHTML = `<span style="color:var(--bad)">${escapeHtml(err.message)}</span>`
  }
}

/* ---------------- 详情抽屉 ---------------- */

function openDrawer() {
  $('#detail').hidden = false
  document.body.classList.add('drawer-open')
}

function closeDrawer() {
  $('#detail').hidden = true
  document.body.classList.remove('drawer-open')
}

async function openEvent(slug) {
  if (!slug) return
  state.selectedSlug = slug
  const body = $('#detail-body')
  openDrawer()
  body.innerHTML = `<div class="view-placeholder">${t('common.loading')}</div>`
  try {
    const payload = await api.getEvent(slug)
    const mod = await loadModule('detail')
    if (mod?.renderDetail) mod.renderDetail(body, payload)
    else body.innerHTML = `<h2>${escapeHtml(payload.event?.title || '')}</h2>`
    if (payload.persons?.length) state.lastPersonSlug = payload.persons[0].slug
  } catch (err) {
    body.innerHTML = `<div class="view-placeholder">${t('common.error')}：${escapeHtml(err.message)}</div>`
  }
}

async function openPerson(slug) {
  if (!slug) return
  state.lastPersonSlug = slug
  const body = $('#detail-body')
  openDrawer()
  body.innerHTML = `<div class="view-placeholder">${t('common.loading')}</div>`
  try {
    const payload = await api.getPerson(slug)
    const mod = await loadModule('detail')
    if (mod?.renderPerson) {
      mod.renderPerson(body, payload, {
        onEvent: (s) => openEvent(s),
        onPerson: (s) => openPerson(s),
        onGraph: (s) => { closeDrawer(); switchView('graph', { person: s }) },
      })
    } else {
      body.innerHTML = `<h2>${escapeHtml(payload.person?.name || '')}</h2>`
    }
  } catch (err) {
    body.innerHTML = `<div class="view-placeholder">${t('common.error')}：${escapeHtml(err.message)}</div>`
  }
}

/* ---------------- 视图生命周期 ---------------- */

async function loadModule(name) {
  if (state.modules[name] !== undefined) return state.modules[name]
  try {
    const mod = await import(`./${name}.js`)
    state.modules[name] = mod
    return mod
  } catch (err) {
    console.warn(`[app] module ${name}.js unavailable:`, err.message)
    state.modules[name] = null
    return null
  }
}

function destroyViews() {
  for (const v of Object.values(state.views)) {
    try { v?.destroy?.() } catch { /* ignore */ }
  }
  state.views = {}
}

async function switchView(name, opts = {}) {
  state.view = name
  document.body.dataset.view = name
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === name)
  })
  $('#panel').hidden = name !== 'timeline'

  const container = $('#view')
  destroyViews()
  container.innerHTML = ''

  const mod = await loadModule(name)
  if (!mod) {
    container.innerHTML = `<div class="view-placeholder">视图模块 <code>${name}.js</code> 尚未实现</div>`
    return
  }

  try {
    if (name === 'timeline' && mod.createTimeline) {
      const v = mod.createTimeline({
        container,
        onSelect: (ev) => openEvent(ev.slug),
        onRange: (r) => { state.range = r; syncPanelLabels() },
        onStats: (s) => {
          state.count = s?.count ?? 0
          state.total = s?.total ?? state.count
          state.loaded = s?.loaded ?? state.count
          // 分页生效时显示「已加载 / 命中总数」，否则只显示可见条数
          $('#view-count').textContent =
            state.total > state.loaded ? `${state.loaded} / ${state.total}` : String(state.count)
        },
      })
      state.views.timeline = v
      v.setFilters?.({ tracks: [...state.tracks], categories: [...state.cats] })
      await v.setRange?.(state.range.from, state.range.to)
    } else if (name === 'map' && mod.createMapView) {
      const v = mod.createMapView({ container, onSelect: (ev) => openEvent(ev.slug) })
      state.views.map = v
      await v.setSlice?.({ from: state.range.from, to: state.range.to })
    } else if (name === 'graph' && mod.createGraphView) {
      let v = null
      v = mod.createGraphView({
        container,
        onSelectPerson: async (node) => {
          if (!node?.slug) return
          await v?.showPerson?.(node.slug)
          await openPerson(node.slug)
        },
      })
      state.views.graph = v
      const target = opts.person || state.lastPersonSlug
      if (target) await v.showPerson?.(target)
      else await v.showHubs?.()
    } else {
      container.innerHTML = `<div class="view-placeholder">模块 ${name}.js 缺少导出</div>`
    }
  } catch (err) {
    console.error(err)
    container.innerHTML = `<div class="view-placeholder">${t('common.error')}：${escapeHtml(err.message)}</div>`
  }
}

/** 语言 / 主题变化后重建当前视图（视图内部状态由 state 保留） */
let rebuildTimer = null
function scheduleRebuild() {
  clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(() => { void switchView(state.view) }, 60)
}

/* ---------------- 搜索 ---------------- */

function wireSearch() {
  const input = $('#search')
  const box = $('#search-results')
  let timer = null
  const hide = () => { box.hidden = true }

  input.addEventListener('input', () => {
    clearTimeout(timer)
    const q = input.value.trim()
    if (!q) { hide(); return }
    timer = setTimeout(async () => {
      try {
        const res = await api.search(q, 12)
        if (!res.hits.length) {
          box.innerHTML = `<div class="search-empty">${t('search.empty')}</div>`
          box.hidden = false
          return
        }
        box.innerHTML = res.hits
          .map(
            (h) => `<div class="search-item" data-slug="${escapeHtml(h.slug)}">
              <div class="t">${escapeHtml(h.title)}</div>
              <div class="m">${escapeHtml(h.time_text || '')}${h.score ? ` · ${h.score.toFixed(0)}` : ''}</div>
              ${h.summary ? `<div class="s">${escapeHtml(h.summary)}</div>` : ''}
            </div>`,
          )
          .join('')
        box.hidden = false
      } catch (err) {
        box.innerHTML = `<div class="search-empty">${t('search.failed')}：${escapeHtml(err.message)}</div>`
        box.hidden = false
      }
    }, 180)
  })

  box.addEventListener('click', (e) => {
    const item = e.target.closest('.search-item')
    if (!item) return
    hide()
    input.value = ''
    openEvent(item.dataset.slug)
  })

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) hide()
  })
}

/* ---------------- 悬浮筛选面板 ---------------- */

function renderCatChips() {
  const box = $('#cat-chips')
  box.innerHTML = CATEGORIES.map(
    (c) => `<button class="chip${state.cats.has(c.key) ? ' on' : ''}" data-cat="${c.key}">${catLabel(c.key)}</button>`,
  ).join('')
}

function syncPanelLabels() {
  const f = $('#range-from')
  const to = $('#range-to')
  if (document.activeElement !== f) f.value = String(state.range.from)
  if (document.activeElement !== to) to.value = String(state.range.to)
  $('#range-label').textContent = `${formatYear(state.range.from)} – ${formatYear(state.range.to)}`
  document.querySelectorAll('.chip[data-track]').forEach((el) => {
    el.classList.toggle('on', state.tracks.has(el.dataset.track))
  })
  document.querySelectorAll('.chip[data-cat]').forEach((el) => {
    el.classList.toggle('on', state.cats.has(el.dataset.cat))
  })
  $('#view-count').textContent = String(state.count)
}

function applyPanelFilters() {
  const v = state.views.timeline
  v?.setFilters?.({ tracks: [...state.tracks], categories: [...state.cats] })
}

function wirePanel() {
  $('#panel-toggle').addEventListener('click', () => {
    panelTouched = true
    const p = $('#panel')
    p.classList.toggle('collapsed')
    $('#panel-toggle').textContent = p.classList.contains('collapsed') ? '+' : '−'
  })

  const commitRange = () => {
    let from = Number($('#range-from').value)
    let to = Number($('#range-to').value)
    if (!Number.isFinite(from) || !Number.isFinite(to)) return
    if (from > to) [from, to] = [to, from]
    from = Math.max(-3000, Math.min(2100, startYear(from)))
    to = Math.max(-3000, Math.min(2100, startYear(to)))
    if (to - from < 5) to = from + 5
    state.range = { from, to }
    syncPanelLabels()
    void state.views.timeline?.setRange?.(from, to)
  }

  $('#range-from').addEventListener('change', commitRange)
  $('#range-to').addEventListener('change', commitRange)

  $('#cat-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip[data-cat]')
    if (!chip) return
    const k = chip.dataset.cat
    if (state.cats.has(k)) state.cats.delete(k)
    else state.cats.add(k)
    if (!state.cats.size) state.cats.add(k) // 至少留一个
    syncPanelLabels()
    applyPanelFilters()
  })

  document.querySelectorAll('.chip[data-track]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const k = chip.dataset.track
      if (state.tracks.has(k)) state.tracks.delete(k)
      else state.tracks.add(k)
      if (!state.tracks.size) state.tracks.add(k)
      syncPanelLabels()
      applyPanelFilters()
    })
  })

  $('#panel-reset').addEventListener('click', () => {
    state.range = { from: -3000, to: 2100 }
    state.tracks = new Set(['cn'])
    state.cats = new Set(CATEGORIES.map((c) => c.key))
    syncPanelLabels()
    applyPanelFilters()
    void state.views.timeline?.setRange?.(state.range.from, state.range.to)
  })
}

function startYear(y) {
  const n = Math.trunc(Number(y) || 0)
  return n === 0 ? -1 : n
}

/* ---------------- 顶栏 / 抽屉接线 ---------------- */

function wireChrome() {
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab')
    if (btn) void switchView(btn.dataset.view)
  })

  $('#btn-theme').addEventListener('click', () => toggleTheme())
  $('#btn-lang').addEventListener('click', () => toggleLang())

  $('#detail-close').addEventListener('click', closeDrawer)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer()
  })

  onThemeChange(() => {
    applyTheme()
    applyI18n()
    scheduleRebuild()
  })

  onLangChange(() => {
    applyI18n()
    void renderStats()
    scheduleRebuild()
  })
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/* ---------------- boot ---------------- */

async function boot() {
  wireChrome()
  wireSearch()
  wirePanel()
  applyI18n()
  autoPanel()
  await renderBuild()
  setupDebug()
  window.addEventListener('resize', autoPanel)
  await renderStats()
  await switchView('timeline')
}

boot().catch((err) => {
  console.error(err)
  document.body.innerHTML = `<pre style="padding:24px;color:#d45a5a">启动失败：${err.message}</pre>`
})

window.__atlas = { state, openEvent, openPerson, switchView, toast }
