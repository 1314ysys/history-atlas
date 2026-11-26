/**
 * 详情抽屉渲染 —— 事件详情 + 人物生平（纯字符串拼装，外部文本一律先转义）。
 *
 * 契约（app.js 调用，签名不可变更）：
 *   renderDetail(container, payload)              payload = GET /api/event/:slug
 *                                                 → { event, claims[], sources[], persons[], place }
 *   renderPerson(container, payload, handlers)    payload = GET /api/person/:slug
 *                                                 → { person, events[], relations[], meta }
 *   handlers = { onEvent(slug), onPerson(slug), onGraph(slug) }
 *
 * 三条约定：
 *   1. 文案一律走 i18n 的 t()；时间一律由 i18n 的 formatEventTime() / formatYear() 在前端
 *      本地化（后端 payload 里的 time_text 不直接显示，避免切换语言后时间不跟着变）。
 *   2. 颜色全部由 app.css 的 CSS 变量决定，本文件不出现任何色值；样式类名也全部复用
 *      app.css 已有的 .person-head / .person-facts / .rel-row / .event-row / .claim /
 *      .source / .verify / .person-chip / .place / .loc / .btn / .view-placeholder。
 *   3. 不 import app.js（会形成循环依赖）：事件详情里的人物 chip 通过 window.__atlas 跳转。
 *
 * 人物关系的方向语义（后端保证）：
 *   direction === 'out' —— 本人是 person_relation.from_slug，主动指向对方 → 显示 '→'
 *   direction === 'in'  —— 本人是 person_relation.to_slug，被对方指向   → 显示 '←'
 */

import { t, formatYear, formatEventTime } from './i18n.js'

/** 事件轨道 → 文案 key（后端存 cn / world） */
const TRACK_KEY = { cn: 'panel.china', world: 'panel.world' }

/** 史料校验状态 → { 徽标类名, 文案 key } */
const VERIFY = {
  verified: { cls: 'verified', key: 'detail.verified' },
  unverified: { cls: 'unverified', key: 'detail.unverified' },
  mismatch: { cls: 'mismatch', key: 'detail.mismatch' },
  missing: { cls: 'missing', key: 'detail.missing' },
}

/* ---------------- 小工具 ---------------- */

/**
 * HTML 转义（文本与属性通用）。
 * @param {unknown} s @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * 数字归一：空值 / 非数字 → null（0 是合法值）。
 * @param {unknown} v @returns {number|null}
 */
function num(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 年份文本：缺失显示「不详」，其余交给 t() 感知的 formatYear()（zh 前403年 / en 403 BCE）。
 * @param {unknown} v @returns {string}
 */
function yearText(v) {
  const n = num(v)
  return n == null ? t('person.unknown') : formatYear(n)
}

/**
 * 小节标题：`<h3>文案 (数量)</h3>`；数量为 null 时不带计数。
 * @param {string} key i18n key @param {number|null} [count] @returns {string}
 */
function sectionTitle(key, count) {
  const label = escapeHtml(t(key))
  return count == null ? `<h3>${label}</h3>` : `<h3>${label} (${count})</h3>`
}

/**
 * 空态占位（复用 .view-placeholder）。
 * @param {string} text @returns {string}
 */
function emptyBox(text) {
  return `<div class="view-placeholder">${escapeHtml(text)}</div>`
}

/**
 * app.js 把 { openEvent, openPerson, switchView, toast } 挂在 window.__atlas 上，
 * 这里读它而不是 import app.js（避免循环依赖）。
 * @returns {{ openEvent?: Function, openPerson?: Function } | null}
 */
function atlas() {
  if (typeof window !== 'undefined' && window.__atlas) return window.__atlas
  return globalThis.__atlas || null
}

/* ---------------- 事件详情：分块渲染 ---------------- */

/**
 * 一条说法：statement + 证据等级徽标 + 取舍理由 / 置信度。
 * @param {any} claim @returns {string}
 */
function renderClaim(claim) {
  const adopted = claim?.adopted ? ' adopted' : ''
  const level = escapeHtml(claim?.evidence_level || '—')

  const tail = []
  if (claim?.rationale) tail.push(escapeHtml(claim.rationale))
  const confidence = num(claim?.confidence)
  if (confidence != null && confidence > 0) tail.push(`${Math.round(confidence * 100)}%`)

  return `<div class="claim${adopted}">
  <div class="st">${escapeHtml(claim?.statement || '')}</div>
  <div class="lv"><span class="badge">${level}</span>${tail.length ? tail.join(' · ') : ''}</div>
</div>`
}

/**
 * 一条史料出处：source_slug + locator + 原文引用 + 校验徽标。
 * @param {any} src @returns {string}
 */
function renderSource(src) {
  const badge = VERIFY[src?.verified_status] || VERIFY.unverified
  const quote = String(src?.quote ?? '').trim()
  const quoteHtml = quote
    ? `<blockquote>${escapeHtml(quote)}</blockquote>`
    : `<blockquote>${escapeHtml(t('detail.noQuote'))}</blockquote>`
  const locator = src?.locator ? ` · ${escapeHtml(src.locator)}` : ''

  return `<div class="source">
  <div class="loc">${escapeHtml(src?.source_slug || '—')}${locator}</div>
  ${quoteHtml}
  <span class="verify ${badge.cls}">${escapeHtml(t(badge.key))}</span>
</div>`
}

/**
 * 一个人物 chip。
 * @param {any} person @returns {string}
 */
function renderChip(person) {
  const name = person?.name || person?.slug || ''
  const extra = [person?.dynasty, person?.role].filter(Boolean).join(' · ')
  const title = extra ? ` title="${escapeHtml(extra)}"` : ''
  return `<span class="person-chip" data-slug="${escapeHtml(person?.slug || '')}"${title}>${escapeHtml(name)}</span>`
}

/**
 * 地点小节：名称 + slug + 经纬度（缺失显示「不详」）+ 备注。
 * @param {any} place @returns {string}
 */
function renderPlace(place) {
  const lat = num(place?.lat)
  const lon = num(place?.lon)
  const hasCoords = lat != null && lon != null

  const rows = []
  if (place?.slug) rows.push(escapeHtml(place.slug))
  const coord = hasCoords ? `${lat.toFixed(4)}, ${lon.toFixed(4)}` : t('person.unknown')
  rows.push(`${escapeHtml(t('detail.latlon'))} ${escapeHtml(coord)}`)
  if (place?.note) rows.push(escapeHtml(place.note))

  return `<div class="place">
  <div>${escapeHtml(place?.name || place?.slug || '')}</div>
  ${rows.map((r) => `<div class="loc">${r}</div>`).join('\n  ')}
</div>`
}

/* ---------------- 人物面板：分块渲染 ---------------- */

/**
 * 一条相关事件：时间（前端本地化）+ 标题，整行可点。
 * @param {any} ev @returns {string}
 */
function renderEventRow(ev) {
  const slug = ev?.slug || ''
  const title = ev?.title || ev?.slug || ''
  const time = formatEventTime(ev)
  return `<div class="event-row" data-slug="${escapeHtml(slug)}" role="button" tabindex="0">
  <div class="ev-time">${escapeHtml(time)}</div>
  <div>${escapeHtml(title)}</div>
</div>`
}

/**
 * 一条人物关系：类型徽标 + 对方姓名（可点）+ 起始年份 + 方向箭头。
 * @param {any} rel @returns {string}
 */
function renderRelationRow(rel) {
  const other = rel?.other || {}
  const type = rel?.type || ''
  const arrow = rel?.direction === 'out' ? '→' : rel?.direction === 'in' ? '←' : ''
  const year = num(rel?.t_start_year)
  const yearHtml = year == null ? '' : `<span class="rel-dir">${escapeHtml(formatYear(year))}</span>`
  // margin-left:auto 仅做右对齐（不含任何颜色），让方向标记落在行尾
  return `<div class="rel-row">
  <span class="rel-type">${escapeHtml(type)}</span>
  <span class="rel-name" data-slug="${escapeHtml(other.slug || '')}" role="button" tabindex="0">${escapeHtml(other.name || other.slug || '')}</span>${yearHtml}
  <span class="rel-dir" style="margin-left:auto">${arrow}</span>
</div>`
}

/* ---------------- 交互绑定（一次委托，覆盖所有行） ---------------- */

/**
 * 在容器上挂事件委托：事件行 → onEvent，关系姓名 → onPerson，
 * [data-graph] 按钮 → onGraph，.person-chip → window.__atlas.openPerson。
 * @param {HTMLElement} container
 * @param {{ onEvent?: Function, onPerson?: Function, onGraph?: Function }} handlers
 */
function bindActions(container, handlers) {
  const call = (fn, slug) => {
    if (typeof fn !== 'function' || !slug) return
    try {
      fn(slug)
    } catch (err) {
      console.error('[detail] 回调失败：', err)
    }
  }

  /** @param {any} e @param {string} sel @returns {any|null} */
  const closest = (e, sel) => {
    const el = e?.target
    return el && typeof el.closest === 'function' ? el.closest(sel) : null
  }

  const activate = (e) => {
    const graphBtn = closest(e, '[data-graph]')
    if (graphBtn) return call(handlers?.onGraph, graphBtn.dataset?.slug)

    const nameEl = closest(e, '.rel-name')
    if (nameEl) return call(handlers?.onPerson, nameEl.dataset?.slug)

    const row = closest(e, '.event-row')
    if (row) return call(handlers?.onEvent, row.dataset?.slug)

    const chip = closest(e, '.person-chip')
    if (chip) return atlas()?.openPerson?.(chip.dataset?.slug)
    return undefined
  }

  container.onclick = activate
  container.onkeydown = (e) => {
    if (e?.key !== 'Enter' && e?.key !== ' ') return
    if (!closest(e, '[role="button"]')) return
    e.preventDefault?.()
    activate(e)
  }
}

/* ---------------- 公开：事件详情 ---------------- */

/**
 * 渲染事件详情到容器（覆盖原内容）。
 * @param {HTMLElement} container @param {any} payload GET /api/event/:slug 的返回
 */
export function renderDetail(container, payload) {
  if (!container) return
  const ev = payload?.event || {}
  const claims = Array.isArray(payload?.claims) ? payload.claims : []
  const sources = Array.isArray(payload?.sources) ? payload.sources : []
  const persons = Array.isArray(payload?.persons) ? payload.persons : []
  const place = payload?.place || null

  const track = TRACK_KEY[ev.track] ? t(TRACK_KEY[ev.track]) : ev.track || ''
  const metaBits = [track, ev.category || '', ev.discipline || ''].filter(Boolean).map(escapeHtml)

  const parts = []
  parts.push(`<h2>${escapeHtml(ev.title || ev.slug || '—')}</h2>`)
  if (num(ev.t_start_year) != null) {
    parts.push(`<div class="time">${escapeHtml(formatEventTime(ev))}</div>`)
  }
  parts.push(`<div class="meta">${metaBits.length ? metaBits.join(' · ') : '—'}</div>`)
  if (ev.summary) parts.push(`<div class="summary">${escapeHtml(ev.summary)}</div>`)

  if (claims.length) {
    parts.push(sectionTitle('detail.claims', claims.length))
    parts.push(claims.map(renderClaim).join('\n'))
  }

  if (sources.length) {
    parts.push(sectionTitle('detail.sources', sources.length))
    parts.push(sources.map(renderSource).join('\n'))
  }

  if (persons.length) {
    parts.push(sectionTitle('detail.persons', persons.length))
    parts.push(persons.map(renderChip).join(''))
  }

  if (place) {
    parts.push(sectionTitle('detail.place'))
    parts.push(renderPlace(place))
  }

  container.innerHTML = parts.join('\n')
  bindActions(container, {})
}

/* ---------------- 公开：人物生平 ---------------- */

/**
 * 渲染人物生平 + 关系列表到容器（覆盖原内容）。
 *
 * 结构：.person-head（姓名/朝代）→ .person-facts（生/卒/关系度数）
 *      → 相关事件（.event-row 列表，空态 person.noEvents）
 *      → 人物关系（.rel-row 列表，空态 person.noRelations）
 *      → 底部「查看关系网」按钮。
 *
 * @param {HTMLElement} container
 * @param {any} payload GET /api/person/:slug 的返回
 * @param {{ onEvent?: Function, onPerson?: Function, onGraph?: Function }} [handlers]
 */
export function renderPerson(container, payload, handlers = {}) {
  if (!container) return
  const person = payload?.person || {}
  const events = Array.isArray(payload?.events) ? payload.events : []
  const relations = Array.isArray(payload?.relations) ? payload.relations : []
  const degree = num(payload?.meta?.degree) ?? num(person.degree) ?? relations.length

  const parts = []

  // 1. 头部：姓名 + 朝代
  const dyn = person.dynasty ? `<span class="person-dyn">${escapeHtml(person.dynasty)}</span>` : ''
  parts.push(`<div class="person-head">
  <span class="person-name">${escapeHtml(person.name || person.slug || '')}</span>
  ${dyn}
</div>`)

  // 2. 生卒 + 关系度数
  parts.push(`<dl class="person-facts">
  <dt>${escapeHtml(t('person.born'))}</dt><dd>${escapeHtml(yearText(person.birth_year))}</dd>
  <dt>${escapeHtml(t('person.died'))}</dt><dd>${escapeHtml(yearText(person.death_year))}</dd>
  <dt>${escapeHtml(t('person.relations'))}</dt><dd>${degree} ${escapeHtml(t('common.people'))}</dd>
</dl>`)

  // 3. 相关事件
  parts.push(sectionTitle('person.events', events.length))
  parts.push(events.length ? events.map(renderEventRow).join('\n') : emptyBox(t('person.noEvents')))

  // 4. 人物关系
  parts.push(sectionTitle('person.relations', relations.length))
  parts.push(
    relations.length ? relations.map(renderRelationRow).join('\n') : emptyBox(t('person.noRelations')),
  )

  // 5. 底部：打开关系网
  parts.push(
    `<button class="btn" type="button" data-graph="${escapeHtml(person.slug || '')}" style="margin-top:18px;width:100%">${escapeHtml(t('person.openGraph'))}</button>`,
  )

  container.innerHTML = parts.join('\n')
  bindActions(container, handlers)
}
