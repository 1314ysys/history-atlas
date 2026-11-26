/**
 * 人物关系图 —— 纯 Canvas 2D 力导向布局（零依赖：不引 d3 / sigma）。
 *
 * 契约（app.js 调用，签名不可变更）：
 *   createGraphView({ container, onSelectPerson })
 *     → { showHubs(), showPerson(slug), destroy() }
 *   onSelectPerson(node)  点击节点时回调，node = { slug, name, dynasty }
 *
 * 数据：
 *   showHubs()        → GET /api/graph/hubs          { nodes:[{slug,name,dynasty,degree}] }（无边，散点）
 *   showPerson(slug)  → GET /api/person/:slug/graph   { center, nodes:[…], edges:[{from,to,type}] }
 *
 * 力模型：节点间斥力（O(n²)）+ 边弹簧 + 向心力；预热 300 轮后固定，交互只重绘不再迭代。
 * 颜色全部取自 theme.js 的 palette()（由 CSS 变量解析而来），订阅 onThemeChange 重绘。
 * 文案全部走 i18n 的 t()；语言切换时 app.js 会重建视图，这里只负责首帧文案。
 */

import * as api from './api.js'
import { t } from './i18n.js'
import { palette, withAlpha, onThemeChange } from './theme.js'

const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
/** 11px 中文标签 */
const LABEL_FONT = `11px ${FONT_FAMILY}`
const STATUS_FONT = `10px ui-monospace, "SF Mono", Consolas, monospace`

const FORCE = {
  repulsion: 3200, // 斥力强度（除以距离平方）
  maxForce: 24, // 单轮斥力上限，避免初始重合时炸开
  springK: 0.025, // 弹簧系数
  springLen: 80, // 弹簧自然长度（px）
  centerK: 0.012, // 向心力（拉向画布中心）
  damping: 0.55, // 速度阻尼
  cooling: 0.985, // 每轮 alpha 衰减
}
const WARMUP_TICKS = 300
const SETTLE_TICKS = 60
const PADDING = 30
const HIT_SLOP = 5

/** @param {number} n @param {number} lo @param {number} hi @returns {number} */
function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi)
}

/** 半径按连接度数缩放：degree 0 → 3.2px，degree 16 → 11.6px，上限 15px */
function radiusOf(degree) {
  return clamp(3.2 + Math.sqrt(Math.max(0, degree)) * 2.1, 3.2, 15)
}

/**
 * 当前主题下的画布配色（palette() 按主题缓存，切换时自动失效）。
 * @returns {{edge:string,edgeHot:string,node:string,nodeCenter:string,ring:string,label:string,labelHot:string,muted:string}}
 */
function colors() {
  const p = palette()
  return {
    edge: withAlpha(p.fg3, 0.3),
    edgeHot: withAlpha(p.accent, 0.85),
    node: withAlpha(p.fg2, 0.82),
    nodeCenter: p.accent,
    ring: withAlpha(p.accent, 0.7),
    label: p.fg2,
    labelHot: p.fg,
    muted: p.fg3,
  }
}

/**
 * @param {{ container: HTMLElement, onSelectPerson?: (node: {slug:string,name:string,dynasty:string|null}) => void }} opts
 * @returns {{
 *   showHubs: (limit?: number) => Promise<void>,
 *   showPerson: (slug: string, depth?: number) => Promise<void>,
 *   destroy: () => void,
 * }}
 */
export function createGraphView({ container, onSelectPerson, onSelect } = {}) {
  if (!container) throw new Error('createGraphView: container required')
  const select = onSelectPerson || onSelect
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative'

  /* ---------------- DOM ---------------- */

  const wrap = document.createElement('div')
  wrap.style.cssText = 'position:absolute;inset:0;overflow:hidden'
  container.appendChild(wrap)

  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'display:block;width:100%;height:100%;cursor:default'
  wrap.appendChild(canvas)

  // 顶部提示条（颜色走 CSS 变量，不写死）
  const hint = document.createElement('div')
  hint.style.cssText = [
    'position:absolute',
    'left:14px',
    'top:14px',
    'z-index:2',
    'padding:7px 11px',
    'border-radius:8px',
    'background:var(--panel-bg)',
    'border:1px solid var(--line-2)',
    'color:var(--fg-2)',
    `font:11px/1.5 ${FONT_FAMILY}`,
    'pointer-events:none',
    'backdrop-filter:blur(4px)',
  ].join(';')
  hint.textContent = t('graph.hint')
  wrap.appendChild(hint)

  // 底部状态：人数 / 关系数
  const status = document.createElement('div')
  status.style.cssText = [
    'position:absolute',
    'left:14px',
    'bottom:14px',
    'z-index:2',
    'color:var(--fg-3)',
    `font:${STATUS_FONT}`,
    'line-height:1.5',
    'pointer-events:none',
  ].join(';')
  status.textContent = t('graph.loading')
  wrap.appendChild(status)

  /* ---------------- 状态 ---------------- */

  const ctx = canvas.getContext('2d')

  /** @type {{slug:string,name:string,dynasty:string|null,degree:number,r:number,x:number,y:number,vx:number,vy:number}[]} */
  let nodes = []
  /** @type {{type:string,a:number,b:number}[]} */
  let edges = []
  /** @type {string|null} */
  let centerSlug = null
  /** @type {any} */
  let hovered = null
  let emptyText = t('graph.loading')

  let width = 0
  let height = 0
  let dpr = 1
  let destroyed = false
  let loadTicket = 0

  /* ---------------- 尺寸 / DPR ---------------- */

  function resize() {
    const rect = container.getBoundingClientRect()
    width = Math.max(1, Math.round(rect.width || wrap.clientWidth || 1))
    height = Math.max(1, Math.round(rect.height || wrap.clientHeight || 1))
    dpr = Math.min(globalThis.devicePixelRatio || 1, 3)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /* ---------------- 力模型 ---------------- */

  function seedPositions() {
    const n = nodes.length
    if (!n) return
    const cx = width / 2
    const cy = height / 2
    const radius = Math.max(40, Math.min(width, height) * 0.34)
    const golden = Math.PI * (3 - Math.sqrt(5)) // 黄金角，散点初始分布均匀
    nodes.forEach((node, i) => {
      if (centerSlug && node.slug === centerSlug) {
        node.x = cx
        node.y = cy
      } else {
        const ang = i * golden
        const rad = radius * Math.sqrt((i + 1) / n)
        node.x = cx + Math.cos(ang) * rad
        node.y = cy + Math.sin(ang) * rad
      }
      node.vx = 0
      node.vy = 0
    })
  }

  /**
   * 迭代力导向布局：斥力 + 弹簧 + 向心力，alpha 冷却。
   * @param {number} ticks
   */
  function simulate(ticks = WARMUP_TICKS) {
    const n = nodes.length
    if (!n || width < 2 || height < 2) return

    const cx = width / 2
    const cy = height / 2
    const maxX = Math.max(PADDING, width - PADDING)
    const maxY = Math.max(PADDING, height - PADDING)
    let alpha = 1

    for (let step = 0; step < ticks; step++) {
      // 斥力：两两相斥（n 已限流，O(n²) 足够）
      for (let i = 0; i < n; i++) {
        const a = nodes[i]
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j]
          let dx = b.x - a.x
          let dy = b.y - a.y
          let d2 = dx * dx + dy * dy
          if (d2 < 0.01) {
            dx = (Math.random() - 0.5) * 2
            dy = (Math.random() - 0.5) * 2
            d2 = dx * dx + dy * dy || 0.01
          }
          const d = Math.sqrt(d2)
          const f = Math.min(FORCE.repulsion / d2, FORCE.maxForce)
          const ux = (dx / d) * f
          const uy = (dy / d) * f
          a.vx -= ux
          a.vy -= uy
          b.vx += ux
          b.vy += uy
        }
      }

      // 弹簧：每条边把两端拉向理想长度
      for (const e of edges) {
        const a = nodes[e.a]
        const b = nodes[e.b]
        if (!a || !b) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const d = Math.hypot(dx, dy) || 0.01
        const f = (d - FORCE.springLen) * FORCE.springK
        const ux = (dx / d) * f
        const uy = (dy / d) * f
        a.vx += ux
        a.vy += uy
        b.vx -= ux
        b.vy -= uy
      }

      // 向心力 + 积分（中心人物钉在画布中央）
      for (const node of nodes) {
        if (centerSlug && node.slug === centerSlug) {
          node.x = cx
          node.y = cy
          node.vx = 0
          node.vy = 0
          continue
        }
        node.vx += (cx - node.x) * FORCE.centerK
        node.vy += (cy - node.y) * FORCE.centerK
        node.vx *= FORCE.damping
        node.vy *= FORCE.damping
        node.x = clamp(node.x + node.vx * alpha, PADDING, maxX)
        node.y = clamp(node.y + node.vy * alpha, PADDING, maxY)
      }

      alpha *= FORCE.cooling
    }
  }

  /* ---------------- 绘制 ---------------- */

  function drawEmpty() {
    if (!ctx) return
    ctx.font = `12px ${FONT_FAMILY}`
    ctx.fillStyle = colors().muted
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(emptyText, width / 2, height / 2)
  }

  function draw() {
    if (!ctx || destroyed) return
    const c = colors()
    ctx.clearRect(0, 0, width, height)

    if (!nodes.length) {
      drawEmpty()
      return
    }

    // 边：细线；悬停节点相连的边高亮
    ctx.lineWidth = 1
    for (const e of edges) {
      const a = nodes[e.a]
      const b = nodes[e.b]
      if (!a || !b) continue
      const hot = hovered != null && (hovered === a || hovered === b)
      ctx.strokeStyle = hot ? c.edgeHot : c.edge
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }

    // 节点 + 11px 标签
    ctx.font = LABEL_FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const node of nodes) {
      const isCenter = centerSlug != null && node.slug === centerSlug
      const isHover = node === hovered

      ctx.beginPath()
      ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2)
      ctx.fillStyle = isCenter || isHover ? c.nodeCenter : c.node
      ctx.fill()

      if (isCenter || isHover) {
        ctx.lineWidth = 1.4
        ctx.strokeStyle = c.ring
        ctx.stroke()
      }

      ctx.fillStyle = isHover ? c.labelHot : c.label
      ctx.fillText(node.name, node.x, node.y + node.r + 3)
    }
  }

  /* ---------------- 数据 ---------------- */

  /**
   * 用 API 结果重建图并预布局（一次性预热，之后只重绘）。
   * @param {{ rawNodes?: any[], rawEdges?: any[], center?: {slug:string,name:string}|null }} data
   */
  function applyData({ rawNodes = [], rawEdges = [], center = null }) {
    const degreeOf = new Map()
    for (const e of rawEdges) {
      if (!e) continue
      degreeOf.set(e.from, (degreeOf.get(e.from) || 0) + 1)
      degreeOf.set(e.to, (degreeOf.get(e.to) || 0) + 1)
    }

    centerSlug = center?.slug || null
    nodes = []
    const seen = new Set()
    for (const raw of rawNodes) {
      if (!raw || !raw.slug || seen.has(raw.slug)) continue
      seen.add(raw.slug)
      const explicit = Number(raw.degree)
      const degree = Number.isFinite(explicit) ? explicit : degreeOf.get(raw.slug) || 0
      nodes.push({
        slug: raw.slug,
        name: raw.name || raw.slug,
        dynasty: raw.dynasty ?? null,
        degree,
        r: radiusOf(degree),
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
      })
    }

    const index = new Map(nodes.map((n, i) => [n.slug, i]))
    edges = []
    for (const raw of rawEdges) {
      if (!raw) continue
      const a = index.get(raw.from)
      const b = index.get(raw.to)
      if (a == null || b == null || a === b) continue
      edges.push({ type: raw.type || '', a, b })
    }

    hovered = null
    canvas.style.cursor = 'default'
    canvas.title = ''
    seedPositions()
    simulate(WARMUP_TICKS)
    draw()
  }

  /** @param {any} err */
  function fail(err) {
    nodes = []
    edges = []
    hovered = null
    emptyText = `${t('graph.failed')}：${err?.message || err}`
    status.textContent = t('graph.failed')
    draw()
  }

  /** @param {string} text */
  function setLoading(text) {
    status.textContent = text
    if (!nodes.length) {
      emptyText = text
      draw()
    }
  }

  /** 人数 / 关系数（底部状态） */
  function refreshStatus(prefix = '') {
    const bits = [`${nodes.length} ${t('graph.people')}`]
    if (edges.length) bits.push(`${edges.length} ${t('graph.links')}`)
    status.textContent = prefix ? `${prefix} · ${bits.join(' · ')}` : bits.join(' · ')
  }

  /**
   * 关系枢纽视图：度数最高的一批人物，节点之间不画边（散点）。
   * @param {number} [limit]
   */
  async function showHubs(limit = 24) {
    const ticket = ++loadTicket
    setLoading(t('graph.loading'))
    try {
      const data = await api.getGraphHubs(limit)
      if (destroyed || ticket !== loadTicket) return
      const list = Array.isArray(data?.nodes) ? data.nodes : []
      emptyText = t('person.noRelations')
      applyData({ rawNodes: list, rawEdges: [], center: null })
      if (list.length) {
        refreshStatus(t('graph.hubs'))
      } else {
        status.textContent = t('person.noRelations')
      }
    } catch (err) {
      if (destroyed || ticket !== loadTicket) return
      fail(err)
    }
  }

  /**
   * 以某人为中心展开关系网（默认 2 跳）。
   * @param {string} slug @param {number} [depth]
   */
  async function showPerson(slug, depth = 2) {
    if (!slug) return showHubs()
    const ticket = ++loadTicket
    setLoading(t('graph.loading'))
    try {
      const data = await api.getPersonGraph(slug, depth)
      if (destroyed || ticket !== loadTicket) return
      const center = data?.center || { slug, name: slug }
      emptyText = t('person.noRelations')
      applyData({
        rawNodes: Array.isArray(data?.nodes) ? data.nodes : [],
        rawEdges: Array.isArray(data?.edges) ? data.edges : [],
        center,
      })
      if (nodes.length > 1 || edges.length) {
        refreshStatus(center.name)
      } else {
        status.textContent = `${center.name} · ${t('person.noRelations')}`
      }
    } catch (err) {
      if (destroyed || ticket !== loadTicket) return
      fail(err)
    }
  }

  /* ---------------- 交互 ---------------- */

  /** @param {MouseEvent} e */
  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  /** @param {number} x @param {number} y */
  function hitTest(x, y) {
    let found = null
    let best = Infinity
    for (const node of nodes) {
      const d = Math.hypot(node.x - x, node.y - y)
      if (d <= node.r + HIT_SLOP && d < best) {
        best = d
        found = node
      }
    }
    return found
  }

  /** @param {MouseEvent} e */
  function onMouseMove(e) {
    if (destroyed) return
    const { x, y } = pointerPos(e)
    const hit = hitTest(x, y)
    if (hit === hovered) return
    hovered = hit
    canvas.style.cursor = hit ? 'pointer' : 'default'
    canvas.title = hit ? (hit.dynasty ? `${hit.name}（${hit.dynasty}）` : hit.name) : ''
    draw()
  }

  function onMouseLeave() {
    if (destroyed || !hovered) return
    hovered = null
    canvas.style.cursor = 'default'
    canvas.title = ''
    draw()
  }

  /** @param {MouseEvent} e */
  function onClick(e) {
    if (destroyed) return
    const { x, y } = pointerPos(e)
    const hit = hitTest(x, y)
    if (!hit) return
    select?.({ slug: hit.slug, name: hit.name, dynasty: hit.dynasty })
  }

  canvas.addEventListener('mousemove', onMouseMove)
  canvas.addEventListener('mouseleave', onMouseLeave)
  canvas.addEventListener('click', onClick)

  /* ---------------- 主题 / 尺寸 ---------------- */

  // 主题切换：palette() 缓存已失效 → 直接重绘（app.js 也可能重建整个视图，两条路都安全）
  const offTheme = onThemeChange(() => {
    if (destroyed) return
    hint.textContent = t('graph.hint')
    draw()
  })

  let observer = null
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => {
      if (destroyed) return
      const prevW = width
      const prevH = height
      resize()
      if (!nodes.length) {
        draw()
        return
      }
      // 按新旧尺寸等比挪动已算好的坐标，再小幅收敛
      if (prevW > 1 && prevH > 1) {
        const sx = width / prevW
        const sy = height / prevH
        for (const node of nodes) {
          node.x *= sx
          node.y *= sy
          node.vx = 0
          node.vy = 0
        }
      }
      simulate(SETTLE_TICKS)
      draw()
    })
    observer.observe(container)
  }

  resize()
  seedPositions()
  draw()

  /* ---------------- 销毁 ---------------- */

  function destroy() {
    if (destroyed) return
    destroyed = true
    loadTicket++
    offTheme?.()
    observer?.disconnect()
    observer = null
    canvas.removeEventListener('mousemove', onMouseMove)
    canvas.removeEventListener('mouseleave', onMouseLeave)
    canvas.removeEventListener('click', onClick)
    nodes = []
    edges = []
    hovered = null
    centerSlug = null
    hint.remove()
    status.remove()
    canvas.remove()
    wrap.remove()
    if (container) container.innerHTML = ''
  }

  return { showHubs, showPerson, destroy }
}
