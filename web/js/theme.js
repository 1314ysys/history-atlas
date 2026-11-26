/**
 * 主题（暗色 / 亮色）。颜色一律从 CSS 变量读，Canvas 视图调 palette() 拿当前值。
 * 切换时通过 onThemeChange 通知各视图重绘。
 */

const STORAGE_KEY = 'atlas.theme'
const listeners = new Set()
let theme = 'dark'
let cached = null

function detect() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'dark' || saved === 'light') return saved
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light'
  } catch { /* ignore */ }
  return 'dark'
}

export function getTheme() {
  return theme
}

export function applyTheme(name = theme) {
  document.documentElement.setAttribute('data-theme', name)
  document.documentElement.style.colorScheme = name
}

export function setTheme(name) {
  if (name !== 'dark' && name !== 'light') return
  if (name === theme && cached) return
  theme = name
  cached = null
  applyTheme(name)
  try { localStorage.setItem(STORAGE_KEY, name) } catch { /* ignore */ }
  for (const fn of listeners) {
    try { fn(theme) } catch (e) { console.error(e) }
  }
}

export function toggleTheme() {
  setTheme(theme === 'dark' ? 'light' : 'dark')
}

export function onThemeChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function cssVar(name, fallback = '#888888') {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/**
 * 当前主题的调色板（Canvas 用）。结果按主题缓存。
 * @returns {{bg:string,fg:string,fg2:string,fg3:string,line:string,line2:string,cn:string,world:string,accent:string,ok:string,warn:string,bad:string}}
 */
export function palette() {
  if (cached) return cached
  cached = {
    bg: cssVar('--bg'),
    bg2: cssVar('--bg-2'),
    bg3: cssVar('--bg-3'),
    fg: cssVar('--fg'),
    fg2: cssVar('--fg-2'),
    fg3: cssVar('--fg-3'),
    line: cssVar('--line'),
    line2: cssVar('--line-2'),
    cn: cssVar('--cn'),
    world: cssVar('--world'),
    accent: cssVar('--accent'),
    ok: cssVar('--ok'),
    warn: cssVar('--warn'),
    bad: cssVar('--bad'),
  }
  return cached
}

/** 把 #rrggbb 转成 rgba(...)，Canvas 里做透明度用 */
export function withAlpha(hex, alpha) {
  const h = String(hex || '').trim()
  if (h.startsWith('rgb')) return h
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h)
  if (!m) return `rgba(136,136,136,${alpha})`
  let s = m[1]
  if (s.length === 3) s = s.split('').map((c) => c + c).join('')
  const n = parseInt(s, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

theme = detect()
applyTheme(theme)
