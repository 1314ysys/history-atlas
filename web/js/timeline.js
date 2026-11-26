/**
 * timeline.js —— 三栏垂直编年时间轴：左粗轴 / 中事件 / 右细轴 + 朝代兴衰色带（原生 Canvas 2D）
 *
 * 视图契约（app.js 依赖，签名不可变更）：createTimeline({ container, onSelect, onRange, onStats })
 *   → { setRange(from, to), getRange(), setFilters({tracks, categories}), refresh(), destroy() }
 *   onSelect(eventLite) / onRange({from,to}) / onStats({count})。
 *
 * 横向分栏（css px；悬浮筛选面板 fixed left:18 width:264 盖住 x≤282，内容从 gutter 起排）：
 *   [0,gutter) 面板占位 | [gutter,+76) 粗轴 | [+20×cols) 朝代带 | [..,cssW-88) 事件列 | [..,cssW) 细轴
 * 纵向：y = (year-from)/(to-from)*plotH，越早越靠上；公元前为负，无公元 0 年。数据：/api/timeline + /api/dynasties。
 */
import { getTimeline, getDynasties } from './api.js';
import { t, getLang, formatYear, formatCentury, formatDecade, formatEventTime, onLangChange } from './i18n.js';
import { palette, withAlpha, onThemeChange } from './theme.js';

/* ---------------- 布局与行为常量 ---------------- */
const YEAR_MIN = -3000, YEAR_MAX = 2100;
const MIN_SPAN = 0.5; // 最小可视跨度（年）：0.5 年才看得见月刻度
const LIMIT = 2000; // 单页上限（API 硬上限）；首屏只取这么多，靠 LOD 渲染视口内的点
const BIN_PX = 6; // LOD 分桶高度（px）
const CLUSTER_MAX = 3; // 桶内 >3 条 → 聚合圆
const HIT_PX = 8; // hover 命中半径下限
const LOAD_DEBOUNCE = 90;
const DPR_MAX = 3;

const GUTTER_WIDE = 290; // 面板占位：left 18 + 宽 264 + 8 留白
const GUTTER_NARROW = 200, GUTTER_BREAK = 900; // 画布 <900px 时压缩留白
const AXIS_W = 76; // 粗时间轴列宽
const DYN_W = 64; // 单个朝代子列宽（水平文字需要宽度）
const FINE_W = 112; // 细时间轴列宽
const EVENTS_MIN = 90; // 单事件列最小宽

const STEP_TIERS = [1000, 500, 250, 100, 50, 25, 10, 5, 1]; // 粗轴步长档位（年）
const COARSE_GAP = 20, FINE_GAP = 24; // 标签最小垂直间距（13px / 10px 字）
const MONTH_TIER_SPAN = 40, YEAR_TIER_SPAN = 300, DECADE_TIER_SPAN = 2000; // 细轴四档阈值
const JITTER = 60, CLUSTER_R_MAX = 22, CN_ONLY = new Set(['cn']); // 无 tracks 过滤时默认只显示中国
const MONO = 'ui-monospace, "SF Mono", Consolas, monospace';
const SANS = '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';

/* ---------------- 纯工具 ---------------- */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** FNV-1a：同一 slug 哈希恒定 → 抖动稳定，同一条事件每帧位置一致 */
function hash32(str) {
  const s = str == null ? '' : String(str);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}
const hashUnit = (s) => hash32(s) / 4294967296; // 稳定归一到 [0,1)

/** 事件起始年；月/日折算成分年，缩到月份级时位置仍然准确 */
function eventYear(ev) {
  const y = Number(ev && ev.t_start_year);
  if (!Number.isFinite(y)) return NaN;
  const m = Number(ev.t_start_month), d = Number(ev.t_start_day);
  let frac = 0;
  if (Number.isFinite(m) && m >= 1 && m <= 12) frac += (m - 1) / 12;
  if (Number.isFinite(d) && d >= 1 && d <= 31) frac += (d - 1) / 365;
  return y + frac;
}
const trackOf = (ev) => (ev && ev.track === 'world' ? 'world' : 'cn');
const dotRadius = (ev) => 2.5 + (hash32(ev && ev.category) % 3) * 0.5; // 2.5~3.5，按类别稳定微调
const dynName = (d) => (getLang() === 'en' ? d.nameEn || d.name || '' : d.name || d.nameEn || '');
/** 朝代年代文字：借 formatEventTime 带上「约 / 传说 / 有争议」等 certainty 修饰 */
const dynTimeText = (d) => formatEventTime({ t_start_year: d.start_year, t_end_year: d.end_year, t_precision: 'year', t_certainty: d.certainty || 'certain' });
/** 月刻度标签：1088-03；公元前 → 前403-05（英文界面 BCE 403-05） */
const monthLabel = (year, month) => `${year < 0 ? t('common.bce') : ''}${year < 0 ? -year : year}-${month < 10 ? `0${month}` : month}`;

/** 粗轴步长：从 [1000…1] 里选一个，使可视范围约 6–8 个刻度（无精确命中时取最接近的档位） */
export function pickCoarseStep(span) {
  const s = Math.max(1e-6, Number(span) || 0);
  const hit = STEP_TIERS.find((step) => s / step >= 6 && s / step <= 8);
  if (hit) return hit;
  let best = STEP_TIERS[0], bestErr = Infinity;
  for (const step of STEP_TIERS) {
    const n = s / step, err = n >= 6 && n <= 8 ? 0 : Math.min(Math.abs(n - 6), Math.abs(n - 8));
    if (err < bestErr) { bestErr = err; best = step; }
  }
  return best;
}

/** 三栏横向分栏（纯函数）：面板占位 → 粗轴 76 → 朝代带 20×cols → 事件列（≥90px）→ 细轴 88 */
export function computeLayout(width, height, opts = {}) {
  const w = Math.max(1, Math.round(Number(width) || 0)), h = Math.max(1, Math.round(Number(height) || 0));
  const dynCols = Math.max(1, Math.round(Number(opts.dynColumns) || 1));
  const compact = h < 240, top = compact ? 24 : 48;
  const bottom = Math.max(top + 20, h - (compact ? 16 : 34)), plotH = Math.max(1, bottom - top);
  // 面板占位：优先用调用方实测的 gutter（面板右边缘 + 间距），否则退回常量
  const reserve = AXIS_W + DYN_W * dynCols + EVENTS_MIN + FINE_W;
  const fallback = w < GUTTER_BREAK ? GUTTER_NARROW : GUTTER_WIDE;
  const wanted = Number.isFinite(opts.gutter) ? opts.gutter : fallback;
  const gutter = Math.max(0, Math.min(wanted, w - reserve));
  const axisX0 = gutter, axisX1 = axisX0 + AXIS_W, dynX0 = axisX1, dynX1 = dynX0 + DYN_W * dynCols;
  const fineX0 = Math.max(dynX1 + EVENTS_MIN, w - FINE_W), fineX1 = w;
  const avail = Math.max(EVENTS_MIN, fineX0 - dynX1);
  // 事件列：默认中国一列；含 world 时在右侧再加一列，等分且不小于 90px
  const tracks = opts.world ? ['cn', 'world'] : ['cn'];
  let n = tracks.length;
  while (n > 1 && avail / n < EVENTS_MIN) n -= 1;
  const colW = avail / n, lanes = [];
  for (let i = 0; i < n; i += 1) {
    const x0 = dynX1 + i * colW, x1 = i === n - 1 ? dynX1 + avail : x0 + colW;
    lanes.push({ track: tracks[i], x0, x1, cx: (x0 + x1) / 2, w: x1 - x0 });
  }
  return { w, h, compact, top, bottom, plotH, gutter, axisX0, axisX1, dynX0, dynX1, dynW: DYN_W * dynCols, dynColumns: dynCols, fineX0, fineX1, lanes, colW };
}

/** 朝代分列：区间图着色——按 start_year 排序后贪心放进「最早空闲」子列，子列数 = 最大重叠数 */
export function assignDynastyColumns(list) {
  const items = [];
  for (const d of Array.isArray(list) ? list : []) {
    const a = Number(d && d.start_year), b = Number(d && d.end_year);
    if (!Number.isFinite(a)) continue;
    items.push({ d, start: Number.isFinite(b) ? Math.min(a, b) : a, end: Number.isFinite(b) ? Math.max(a, b) : a, order: items.length });
  }
  items.sort((p, q) => p.start - q.start || p.end - q.end || p.order - q.order);
  const colEnd = []; // 每个子列占用到的 end_year
  const rows = items.map((it) => {
    let col = -1;
    for (let i = 0; i < colEnd.length; i += 1) if (colEnd[i] < it.start) { col = i; break; } // 首尾相接可共列
    if (col < 0) { col = colEnd.length; colEnd.push(it.end); } else colEnd[col] = Math.max(colEnd[col], it.end);
    return { d: it.d, start: it.start, end: it.end, col };
  });
  return { rows, columns: Math.max(1, colEnd.length) };
}

/** 细轴精度档位：month / year / decade / century */
export function fineTier(span) {
  const s = Number(span) || 0;
  if (s <= MONTH_TIER_SPAN) return 'month';
  if (s <= YEAR_TIER_SPAN) return 'year';
  return s <= DECADE_TIER_SPAN ? 'decade' : 'century';
}

/* ---------------- 视图工厂 ---------------- */
/** 创建三栏垂直时间轴视图。@param {{container?, onSelect?, onRange?, onStats?}} [opts] */
export function createTimeline({ container, onSelect, onRange, onStats } = {}) {
  const host = container || document.body;
  /* --- DOM：canvas + DOM tooltip --- */
  const root = document.createElement('div');
  root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%;cursor:grab;touch-action:none;';
  const tip = document.createElement('div');
  tip.hidden = true;
  tip.style.cssText = 'position:absolute;left:0;top:0;z-index:5;pointer-events:none;max-width:320px;'
    + 'padding:7px 10px;border-radius:8px;box-shadow:var(--shadow);will-change:transform;'
    + `font:12px/1.5 ${SANS};`;
  const tipTitle = document.createElement('div'), tipMeta = document.createElement('div');
  tipTitle.style.cssText = 'font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  tipMeta.style.cssText = `margin-top:2px;font:11px ${MONO};white-space:nowrap;`;
  tip.append(tipTitle, tipMeta);
  root.append(canvas, tip);
  host.appendChild(root);
  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  // 文字一律按整数像素落点：canvas 在分数坐标上渲染会做抗锯齿插值，中文尤其容易发虚
  if (ctx) {
    const rawFillText = ctx.fillText.bind(ctx);
    ctx.fillText = (text, x, y, ...rest) => rawFillText(text, Math.round(x), Math.round(y), ...rest);
    const rawStrokeRect = ctx.strokeRect ? ctx.strokeRect.bind(ctx) : null;
    if (rawStrokeRect) ctx.strokeRect = (x, y, w, h) => rawStrokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
  }
  const raf = (cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 16));
  const caf = (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));
  /* --- 状态 --- */
  const state = { from: YEAR_MIN, to: YEAR_MAX, events: [], loading: false, error: '', selected: null, hover: null, hoverDyn: null, source: 'api', total: 0 };
  const filters = { tracks: null, cats: null }; // null 表示该维度不过滤
  let dynInfo = { rows: [], columns: 1 }; // 朝代分列结果（驱动朝代带宽度）
  let pal = null; // 每次重绘从 palette() 刷新，不缓存成模块常量
  let home = null; // 双击复位目标 = 首次 setRange 的区间
  let layout = null, markers = [], dynRects = [], destroyed = false, hasLoaded = false;
  let cssW = 0, cssH = 0, dpr = 1, rafId = 0, loadTimer = 0, loadToken = 0;
  let waiters = [], drag = null, pointer = { x: -1, y: -1 }, tipKey = null, lastRangeEmit = '';
  /* --- 尺寸、分栏与时间映射 --- */
  /** 实测筛选面板右边缘，作为内容起始 x（不再用硬编码常量猜） */
  function measureGutter() {
    if (typeof document === 'undefined') return 12;
    const p = document.getElementById('panel');
    if (!p || p.hidden || p.classList.contains('collapsed')) return 12;
    const r = p.getBoundingClientRect();
    if (!r.width) return 12;
    return Math.round(r.right) + 12;
  }
  function relayout() {
    layout = computeLayout(cssW, cssH, {
      dynColumns: dynInfo.columns,
      world: !!(filters.tracks && filters.tracks.has('world')),
      gutter: measureGutter(),
    });
  }
  function measure() {
    const r = root.getBoundingClientRect ? root.getBoundingClientRect() : { width: 0, height: 0 };
    cssW = Math.max(0, Math.round(r.width || 0)); cssH = Math.max(0, Math.round(r.height || 0));
    dpr = clamp(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 1, DPR_MAX);
    // 位图尺寸与 CSS 尺寸必须同时显式设定，否则 element 的显示尺寸会跟随位图走，
    // 导致浏览器缩放位图（文字发虚、右侧被裁）。
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // devicePixelRatio 缩放
    relayout();
  }
  const spanYears = () => Math.max(MIN_SPAN, state.to - state.from);
  const yOf = (year) => layout.top + ((year - state.from) / spanYears()) * layout.plotH; // 年份 → y
  const yearAt = (y) => state.from + ((y - layout.top) / Math.max(1, layout.plotH)) * spanYears(); // y → 年份
  function requestRender() {
    if (destroyed || rafId) return; // rAF 节流：一帧最多重绘一次
    rafId = raf(() => { rafId = 0; render(); });
  }
  /** 立即重绘（过滤变化等需要同步生效的场合） */
  function renderNow() {
    if (destroyed) return;
    if (rafId) { caf(rafId); rafId = 0; }
    render();
  }
  /* --- 过滤与可见集 --- */
  function passesFilter(ev) {
    // 未设置 tracks 过滤时按默认单列（中国）处理，保证「画出来的」与 onStats 计数一致
    if (!(filters.tracks || CN_ONLY).has(trackOf(ev))) return false;
    // 类别未知（null）的事件不参与类别过滤，避免静默丢数据
    if (filters.cats && ev.category && !filters.cats.has(ev.category)) return false;
    return true;
  }
  /** 前端过滤 + 与当前区间求交；year 钳到视口边界 */
  function collectVisible() {
    const out = [];
    for (const ev of state.events) {
      if (!passesFilter(ev)) continue;
      const y0 = eventYear(ev);
      if (!Number.isFinite(y0)) continue;
      const y1 = ev.t_end_year == null ? NaN : Number(ev.t_end_year);
      const lo = Number.isFinite(y1) ? Math.min(y0, y1) : y0, hi = Number.isFinite(y1) ? Math.max(y0, y1) : y0;
      if (hi < state.from || lo > state.to) continue; // 与区间不重叠
      out.push({ ev, track: trackOf(ev), year: clamp(y0, state.from, state.to) });
    }
    return out;
  }
  /* --- 刻度 --- */
  /** 粗轴：档位步长下的年份列表（跳过不存在的公元 0 年） */
  function coarseTicks() {
    const step = pickCoarseStep(spanYears()), years = [], start = Math.ceil(state.from / step) * step;
    for (let y = start; y <= state.to && years.length < 400; y += step) if (y !== 0) years.push(y);
    return { step, years };
  }
  /** 细轴：按精度档位生成 { y, label } */
  function fineTicks() {
    const tier = fineTier(spanYears()), out = [], from = state.from, to = state.to;
    if (tier === 'month') { // ≤40 年：逐月，标签 1088-03 / 前403-05
      for (let year = Math.floor(from); year <= Math.ceil(to); year += 1) {
        if (year === 0) continue; // 无公元 0 年
        for (let m = 1; m <= 12; m += 1) {
          const t0 = year + (m - 1) / 12; if (t0 < from || t0 > to) continue;
          out.push({ y: yOf(year + (m - 0.5) / 12), label: monthLabel(year, m) });
        }
      }
    } else if (tier === 'year') {
      for (let y = Math.ceil(from); y <= to; y += 1) if (y !== 0) out.push({ y: yOf(y), label: formatYear(y) });
    } else if (tier === 'decade') {
      for (let y = Math.ceil(from / 10) * 10; y <= to; y += 10) if (y !== 0) out.push({ y: yOf(y), label: formatDecade(y) });
    } else {
      for (let y = Math.ceil(from / 100) * 100; y <= to; y += 100) if (y !== 0) out.push({ y: yOf(y), label: formatCentury(y) });
    }
    return out;
  }
  /* --- 渲染 --- */
  function render() {
    if (destroyed || !ctx) return;
    pal = palette(); // 每次重绘读取当前主题
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, Math.max(1, cssW), Math.max(1, cssH));
    markers = []; dynRects = [];
    if (cssW < 8 || cssH < 8) { reportStats(0); return; } // 容器 0 尺寸：不画也不崩
    relayout();
    const L = layout, visible = collectVisible(), coarse = coarseTicks();
    tip.style.background = withAlpha(pal.bg2, 0.97);
    tip.style.border = `1px solid ${pal.line2}`; tip.style.color = pal.fg;
    tipMeta.style.color = pal.accent;
    drawEraWash(L); // 1. 同期极淡底色（最底层）
    drawGrid(L, coarse); // 2. 粗轴刻度的横向网格线
    drawDynasties(L); // 3. 朝代带
    drawLanes(L); // 4. 事件列底色与列名
    drawCoarseAxis(L, coarse); // 5. 左粗轴
    drawFineAxis(L, fineTicks()); // 6. 右细轴
    buildMarkers(L, visible); // 7. 事件标记
    drawHeader(visible.length);
    drawMarkers();
    drawHint(L);
    if (state.error) drawNotice(`${t('timeline.failed')} · ${state.error}`, pal.bad);
    else if (!visible.length) drawNotice(state.loading ? t('timeline.loading') : t('timeline.empty'), pal.fg3);
    reportStats(visible.length);
  }
  function reportStats(count) {
    if (destroyed || typeof onStats !== 'function') return;
    try { onStats({ count, total: state.total, loaded: state.events.length }); } catch (err) { console.error('[timeline] onStats 异常', err); }
  }
  /** 同期底色：同色区间先合并，避免重叠朝代把透明度叠成一团 */
  function drawEraWash(L) {
    if (!dynInfo.rows.length) return;
    const byColor = new Map();
    for (const row of dynInfo.rows) {
      const key = row.d.color || pal.accent;
      byColor.set(key, (byColor.get(key) || []).concat([[row.start, row.end]]));
    }
    const spans = [];
    for (const [color, list] of byColor) {
      list.sort((a, b) => a[0] - b[0]);
      let cur = null;
      for (const s of list) {
        if (cur && s[0] <= cur[1]) cur[1] = Math.max(cur[1], s[1]);
        else { if (cur) spans.push({ color, span: cur }); cur = [s[0], s[1]]; }
      }
      if (cur) spans.push({ color, span: cur });
    }
    for (const { color, span } of spans) {
      const a = Math.max(span[0], state.from), b = Math.min(span[1], state.to);
      if (b <= a) continue;
      const y0 = Math.max(L.top, yOf(a)), h = Math.max(1, Math.min(L.bottom, yOf(b)) - y0);
      ctx.fillStyle = withAlpha(color, 0.045); ctx.fillRect(L.gutter, y0, Math.max(1, cssW - L.gutter), h);
    }
  }
  /** 横向网格线：从粗轴右缘（gutter）贯穿到画布右缘，绝不穿过悬浮面板背后 */
  function drawGrid(L, ticks) {
    ctx.strokeStyle = withAlpha(pal.line, 0.55); ctx.lineWidth = 1; ctx.beginPath();
    for (const year of ticks.years) {
      const yy = Math.round(yOf(year)) + 0.5; if (yy < L.top || yy > L.bottom) continue;
      ctx.moveTo(L.gutter, yy); ctx.lineTo(Math.max(L.gutter + 1, cssW - 1), yy);
    }
    ctx.stroke();
  }
  /** 朝代带：每个子列 20px，从 start_year 画到 end_year */
  function drawDynasties(L) {
    for (const row of dynInfo.rows) {
      const color = row.d.color || pal.accent, ya = yOf(clamp(row.start, state.from, state.to)), yb = yOf(clamp(row.end, state.from, state.to));
      const top = Math.max(L.top, Math.min(ya, yb)), bottom = Math.min(L.bottom, Math.max(ya, yb));
      if (bottom - top < 0.5) continue;
      const x = L.dynX0 + row.col * DYN_W;
      const hgt = bottom - top;
      ctx.fillStyle = withAlpha(color, state.hoverDyn === row ? 0.44 : 0.28); ctx.fillRect(x, top, DYN_W, hgt);
      ctx.fillStyle = color; // 左右各一条 1px 实色边
      ctx.fillRect(x, top, 1, hgt);
      ctx.fillRect(x + DYN_W - 1, top, 1, hgt);
      drawDynLabel(row, x, top, hgt, color);
      dynRects.push({ x0: x, x1: x + DYN_W, y0: top, y1: bottom, row });
    }
  }
  /**
   * 朝代带文字：水平排列（不旋转）。
   * 头尾常显起讫年代（不依赖悬浮），中间放朝代名；带太矮时逐级省略。
   */
  function drawDynLabel(row, x, top, hgt, color) {
    const cx = x + DYN_W / 2;
    const inner = DYN_W - 8;
    // 1) 头部：起始年
    if (hgt >= 26) {
      ctx.font = `11px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = withAlpha(pal.fg, 0.86);
      ctx.fillText(fitText(formatYear(row.start), inner), cx, top + 3);
    }
    // 2) 尾部：结束年
    if (hgt >= 26) {
      ctx.font = `11px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = withAlpha(pal.fg, 0.86);
      ctx.fillText(fitText(formatYear(row.end), inner), cx, top + hgt - 3);
    }
    // 3) 中间：朝代名（水平），高度足够才放，避免与年代打架
    const label = dynName(row.d);
    if (label && hgt >= 62) {
      ctx.font = `13px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = withAlpha(pal.fg, 0.95);
      ctx.fillText(fitText(label, inner), cx, top + hgt / 2);
    } else if (label && hgt >= 26) {
      // 矮带：名与年代挤在一起，只在带右侧配色条已足够辨识，名放在悬浮提示里
    }
  }
  /** 文字按像素宽度截断（朝代带很窄，宁短勿溢出） */
  function fitText(text, maxPx) {
    if (!ctx || !(maxPx > 12)) return '';
    let s = text;
    while (s.length > 1 && ctx.measureText(`${s}…`).width > maxPx) s = s.slice(0, -1);
    return ctx.measureText(text).width <= maxPx ? text : `${s}…`;
  }
  /** 事件列：淡色底 + 虚线基线 + 列名（i18n） */
  function drawLanes(L) {
    for (const lane of L.lanes) {
      const color = lane.track === 'world' ? pal.world : pal.cn;
      ctx.fillStyle = withAlpha(color, 0.05); ctx.fillRect(lane.x0 + 4, L.top, Math.max(1, lane.w - 8), L.plotH);
      ctx.strokeStyle = withAlpha(color, 0.3); ctx.lineWidth = 1; ctx.setLineDash([5, 5]);
      ctx.beginPath(); ctx.moveTo(Math.round(lane.cx) + 0.5, L.top); ctx.lineTo(Math.round(lane.cx) + 0.5, L.bottom); ctx.stroke();
      ctx.setLineDash([]);
      if (L.compact) continue;
      ctx.font = `13px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = withAlpha(color, 0.92); ctx.fillText(lane.track === 'world' ? t('panel.world') : t('panel.china'), lane.cx, L.top - 16);
    }
  }
  /** 左粗轴：竖线 + 短刻度 + 13px 年份标签（防重叠、去重） */
  function drawCoarseAxis(L, ticks) {
    const x = L.axisX1;
    ctx.strokeStyle = withAlpha(pal.fg3, 0.5); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x - 0.5, L.top - 10); ctx.lineTo(x - 0.5, L.bottom + 8); ctx.stroke();
    ctx.font = `15px ${SANS}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    let lastY = -1e9, lastText = '';
    for (const year of ticks.years) {
      const yy = yOf(year); if (yy < L.top - 1 || yy > L.bottom + 1) continue;
      ctx.strokeStyle = withAlpha(pal.fg3, 0.55);
      ctx.beginPath(); ctx.moveTo(x - 7, Math.round(yy) + 0.5); ctx.lineTo(x, Math.round(yy) + 0.5); ctx.stroke();
      const text = formatYear(year);
      if (yy - lastY < COARSE_GAP || text === lastText) continue;
      ctx.fillStyle = withAlpha(pal.fg, 0.92); ctx.fillText(text, x - 9, yy);
      lastY = yy; lastText = text;
    }
  }
  /** 右细轴：10px 标签右对齐 + 短刻度线，精度随跨度自适应 */
  function drawFineAxis(L, ticks) {
    const x = L.fineX0;
    ctx.strokeStyle = withAlpha(pal.fg3, 0.5); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + 0.5, L.top - 10); ctx.lineTo(x + 0.5, L.bottom + 8); ctx.stroke();
    ctx.font = `12px ${MONO}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    let lastY = -1e9, lastText = '';
    for (const tk of ticks) {
      if (tk.y < L.top || tk.y > L.bottom) continue;
      const yy = Math.round(tk.y) + 0.5;
      ctx.strokeStyle = withAlpha(pal.fg3, 0.45);
      ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + 5, yy); ctx.stroke();
      if (tk.y - lastY < FINE_GAP || tk.label === lastText) continue;
      ctx.fillStyle = withAlpha(pal.fg2, 0.95); ctx.fillText(tk.label, cssW - 14, tk.y);
      lastY = tk.y; lastText = tk.label;
    }
  }
  /** 顶部右角：当前区间与可见条数 */
  function drawHeader(count) {
    const text = `${formatYear(state.from)} — ${formatYear(state.to)} · ${count} ${t('timeline.cluster')}`;
    ctx.font = `12px ${MONO}`; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillStyle = withAlpha(pal.fg3, 0.95); ctx.fillText(text, Math.max(12, cssW - 18), 12);
  }
  /** 左下角操作提示（在粗轴留白区，不压事件列） */
  function drawHint(L) {
    if (L.compact) return;
    ctx.font = `12px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = withAlpha(pal.fg3, 0.8); ctx.fillText(t('timeline.hint'), L.gutter + 4, cssH - 8);
  }
  /** 画布中央的提示 / 错误文字 */
  function drawNotice(text, color) {
    const cx = cssW / 2, cy = (layout.top + layout.bottom) / 2;
    ctx.font = `15px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = Math.min(Math.max(40, cssW - 24), ctx.measureText(text).width + 26);
    ctx.fillStyle = withAlpha(pal.bg, 0.94); ctx.fillRect(cx - w / 2, cy - 14, w, 28);
    ctx.strokeStyle = withAlpha(pal.line2, 0.9); ctx.lineWidth = 1; ctx.strokeRect(cx - w / 2 + 0.5, cy - 13.5, w, 27);
    ctx.fillStyle = color; ctx.fillText(text, cx, cy);
  }
  /* --- LOD：每个事件列按 y 像素分桶（6px）；>3 条聚合成圆 --- */
  function makeCluster(track, lane, items) {
    let sum = 0;
    for (const it of items) sum += it.y;
    const y = sum / items.length;
    const rMax = Math.max(4, Math.min(CLUSTER_R_MAX, lane.w / 2 - 4));
    const r = Math.min(rMax, 6 + Math.log2(Math.max(1, items.length)) * 2.4); // 半径随数量对数增长
    return { key: `c:${track}:${Math.round(y)}:${items.length}`, kind: 'cluster', track, x: lane.cx, y, r, items };
  }
  /** 相邻聚合圆重叠（圆心距 < (r1+r2)*0.85）→ 合并，反复迭代直到稳定 */
  function mergeClusters(track, lane, list) {
    let cur = list.slice();
    for (let pass = 0; pass < 8 && cur.length > 1; pass += 1) {
      const out = [];
      for (const c of cur) {
        const last = out[out.length - 1];
        if (last && Math.hypot(last.y - c.y, last.x - c.x) < (last.r + c.r) * 0.85) out[out.length - 1] = makeCluster(track, lane, last.items.concat(c.items));
        else out.push(c);
      }
      if (out.length === cur.length) break;
      cur = out;
    }
    return cur;
  }
  function buildMarkers(L, visible) {
    const laneOf = new Map(L.lanes.map((l) => [l.track, l])), bins = new Map();
    for (const it of visible) {
      const lane = laneOf.get(it.track);
      if (!lane) continue; // 该轨道当前不显示（列被收起）
      const y = yOf(it.year);
      if (y < L.top - 12 || y > L.bottom + 12) continue; // 视口外丢弃
      const key = `${it.track}:${Math.floor((y - L.top) / BIN_PX)}`;
      if (bins.has(key)) bins.get(key).push({ ev: it.ev, y }); else bins.set(key, [{ ev: it.ev, y }]);
    }
    const clusters = new Map();
    for (const [key, list] of bins) {
      const track = key.slice(0, key.indexOf(':')), lane = laneOf.get(track);
      if (!lane) continue;
      const jitter = Math.max(4, Math.min(JITTER, lane.w * 0.34));
      if (list.length > CLUSTER_MAX) { // 聚合
        if (!clusters.has(track)) clusters.set(track, []);
        clusters.get(track).push(makeCluster(track, lane, list));
        continue;
      }
      for (const it of list) { // 逐条：水平用 slug 哈希做稳定抖动
        const j = hashUnit(it.ev.slug || it.ev.title) * 2 - 1;
        markers.push({ key: `${key}:${it.ev.slug}`, kind: 'dot', track, x: lane.cx + j * jitter, y: it.y, r: dotRadius(it.ev), ev: it.ev });
      }
    }
    for (const [track, list] of clusters) markers.push(...mergeClusters(track, laneOf.get(track), list));
  }
  function drawMarkers() { // 先逐点，后聚合（聚合盖在上层）
    for (let pass = 0; pass < 2; pass += 1) for (const m of markers) if ((m.kind === 'dot') === (pass === 0)) drawMarker(m);
  }
  function drawMarker(m) {
    const base = m.track === 'world' ? pal.world : pal.cn, hot = !!(state.hover && state.hover.key === m.key);
    if (m.kind === 'dot') { // 单条点
      const r = m.r + (hot ? 1.5 : 0);
      ctx.globalAlpha = hot ? 1 : 0.88;
      ctx.fillStyle = hot ? pal.fg : base;
      ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      if (state.selected && m.ev.slug === state.selected) { // 选中态
        ctx.strokeStyle = pal.accent; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(m.x, m.y, r + 3.5, 0, Math.PI * 2); ctx.stroke();
      }
      return;
    }
    const r = m.r + (hot ? 2 : 0); // 聚合圆：半透明填充 + 数量
    ctx.fillStyle = withAlpha(base, hot ? 0.5 : 0.26);
    ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = withAlpha(base, hot ? 1 : 0.78); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, Math.PI * 2); ctx.stroke();
    if (r < 9) return;
    ctx.fillStyle = withAlpha(pal.fg, 0.85); ctx.font = `11px ${MONO}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(m.items.length), m.x, m.y + 0.5);
  }
  /* --- 数据加载 --- */
  function flushWaiters() {
    const list = waiters, range = getRange();
    waiters = [];
    for (const resolve of list) resolve(range);
  }
  function nudgeLoad(delay = LOAD_DEBOUNCE) {
    if (destroyed) return;
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = setTimeout(() => { loadTimer = 0; void load(); }, delay);
  }
  const scheduleLoad = (delay = LOAD_DEBOUNCE) => new Promise((resolve) => { waiters.push(resolve); nudgeLoad(delay); });
  /** 事件与朝代并行拉取：朝代失败不影响事件（Promise.allSettled） */
  /* --- 静态分片优先（设计 §3.3）：浏览读 /generated/，任一步失败回退 API --- */
  const STATIC_BASE = '/generated';
  const WIDE_SPAN = 400; // 跨度超过 400 年直接取 all.json，否则按世纪取块
  let staticIndex = null, staticIndexPromise = null;
  let staticAll = null, staticDyn = null;
  const centuryCache = new Map();

  async function loadIndex() {
    if (staticIndex) return staticIndex;
    if (!staticIndexPromise) {
      staticIndexPromise = fetch(`${STATIC_BASE}/index.json`, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((j) => { staticIndex = j; return j; });
    }
    return staticIndexPromise;
  }
  const staticUrl = (rel) => {
    const v = staticIndex && staticIndex.generated_at ? encodeURIComponent(staticIndex.generated_at) : '0';
    return `${STATIC_BASE}/${rel}?v=${v}`;
  };

  /** @returns {Promise<object[]|null>} null 表示静态不可用 */
  async function loadEventsStatic(from, to) {
    const idx = await loadIndex();
    if (!idx || !idx.files || !idx.files.all) return null;

    if (to - from > WIDE_SPAN || !Array.isArray(idx.centuries) || !idx.centuries.length) {
      if (!staticAll) {
        const r = await fetch(staticUrl(idx.files.all), { cache: 'no-cache' });
        if (!r.ok) return null;
        const j = await r.json();
        if (!Array.isArray(j.events)) return null;
        staticAll = j.events;
      }
      return staticAll.filter((ev) => {
        const s = ev.t_start_year, e = ev.t_end_year == null ? s : ev.t_end_year;
        return !(e < from || s > to);
      });
    }

    const c0 = Math.floor(from / 100), c1 = Math.floor(to / 100);
    const wanted = idx.centuries.filter((c) => c.century >= c0 && c.century <= c1);
    if (!wanted.length) return [];
    const lists = await Promise.all(wanted.map(async (c) => {
      if (centuryCache.has(c.century)) return centuryCache.get(c.century);
      const r = await fetch(staticUrl(c.file), { cache: 'no-cache' });
      if (!r.ok) throw new Error(`静态分片不可用：${c.file}`);
      const j = await r.json();
      const arr = Array.isArray(j.events) ? j.events : [];
      centuryCache.set(c.century, arr);
      return arr;
    }));
    const out = [];
    for (const list of lists) {
      for (const ev of list) {
        const s = ev.t_start_year, e = ev.t_end_year == null ? s : ev.t_end_year;
        if (!(e < from || s > to)) out.push(ev);
      }
    }
    return out;
  }

  async function loadDynastiesStatic(from, to) {
    const idx = await loadIndex();
    if (!idx || !idx.files || !idx.files.dynasties) return null;
    if (!staticDyn) {
      const r = await fetch(staticUrl(idx.files.dynasties), { cache: 'no-cache' });
      if (!r.ok) return null;
      const j = await r.json();
      if (!Array.isArray(j.dynasties)) return null;
      staticDyn = j.dynasties;
    }
    return staticDyn.filter((d) => d.end_year >= from && d.start_year <= to);
  }

  async function load() {
    if (destroyed) return;
    const token = ++loadToken;
    state.loading = true; state.error = '';
    requestRender();
    const from = Math.floor(state.from), to = Math.ceil(state.to);
    try {
      const fetchEvents = async () => {
        try {
          const s = await loadEventsStatic(from, to);
          if (s) { state.source = 'static'; return { events: s }; }
        } catch (e) {
          console.warn('[timeline] 静态分片不可用，回退 API：', e && e.message);
        }
        state.source = 'api';
        return getTimeline({ from, to, limit: LIMIT });
      };
      const fetchDynasties = async () => {
        try {
          const d = await loadDynastiesStatic(from, to);
          if (d) return { dynasties: d };
        } catch (e) {
          console.warn('[timeline] 静态朝代带不可用，回退 API：', e && e.message);
        }
        return getDynasties({ from, to });
      };
      const [evRes, dyRes] = await Promise.allSettled([fetchEvents(), fetchDynasties()]);
      if (destroyed || token !== loadToken) return; // 丢弃过期响应
      if (evRes.status === 'fulfilled' && evRes.value && Array.isArray(evRes.value.events)) {
        state.events = evRes.value.events;
        state.total = Number(evRes.value.total) || state.events.length;
      } else {
        state.events = [];
        const err = evRes.status === 'rejected' ? evRes.reason : null;
        state.error = String((err && err.message) || err || t('common.error'));
      }
      if (dyRes.status === 'fulfilled' && dyRes.value && Array.isArray(dyRes.value.dynasties)) {
        dynInfo = assignDynastyColumns(dyRes.value.dynasties);
      } else if (dyRes.status === 'rejected') {
        console.warn('[timeline] 朝代数据加载失败（事件不受影响）', dyRes.reason);
      }
      tipKey = null; tip.hidden = true;
    } finally {
      if (!destroyed && token === loadToken) {
        state.loading = false; state.hover = null; state.hoverDyn = null; hasLoaded = true;
        try { window.__atlasTimelineSource = state.source; } catch { /* ignore */ }
        requestRender();
        flushWaiters();
      }
    }
  }
  /* --- 区间 --- */
  function applyRange(from, to) {
    let a = Number(from), b = Number(to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (a > b) { const tmp = a; a = b; b = tmp; }
    a = clamp(a, YEAR_MIN, YEAR_MAX); b = clamp(b, YEAR_MIN, YEAR_MAX);
    if (b - a < MIN_SPAN) { // 保持最小跨度
      a = clamp((a + b) / 2 - MIN_SPAN / 2, YEAR_MIN, YEAR_MAX - MIN_SPAN);
      b = a + MIN_SPAN;
    }
    if (a === state.from && b === state.to) return false;
    state.from = a; state.to = b;
    return true;
  }
  const getRange = () => ({ from: state.from, to: state.to });
  function setRange(from, to) {
    if (destroyed) return Promise.resolve(getRange());
    const changed = applyRange(from, to);
    if (!changed && hasLoaded) return Promise.resolve(getRange());
    if (!home) home = getRange(); // 首次区间 = 双击复位目标
    requestRender();
    return scheduleLoad();
  }
  const refresh = () => (destroyed ? Promise.resolve(getRange()) : scheduleLoad(0));
  /** 用户交互导致视口变化 → onRange（按小数去重，避免拖动时抖动刷屏） */
  function emitRange() {
    if (destroyed || typeof onRange !== 'function') return;
    const r = getRange(), sig = `${r.from.toFixed(3)}:${r.to.toFixed(3)}`;
    if (sig === lastRangeEmit) return;
    lastRangeEmit = sig;
    try { onRange({ from: r.from, to: r.to }); } catch (err) { console.error('[timeline] onRange 异常', err); }
  }
  /** 拖动 / 缩放 / 双击统一入口：重绘 + 回报 + 合并请求 */
  function applyView(from, to) {
    if (!applyRange(from, to)) return false;
    requestRender();
    emitRange();
    nudgeLoad();
    return true;
  }
  /** 过滤在前端做：只重绘，不重新请求 */
  function setFilters(next) {
    const f = next || {};
    if (Array.isArray(f.tracks)) filters.tracks = f.tracks.length ? new Set(f.tracks) : null;
    if (Array.isArray(f.categories)) filters.cats = f.categories.length ? new Set(f.categories) : null;
    if (destroyed) return;
    state.hover = null; state.hoverDyn = null; tipKey = null; tip.hidden = true;
    renderNow(); // 立即重绘并回调 onStats
  }
  /* --- 命中测试与 tooltip --- */
  const localPoint = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  function hitMarker(x, y) {
    let best = null, bestD = Infinity;
    for (let i = markers.length - 1; i >= 0; i -= 1) { // 后画的优先
      const m = markers[i], d = Math.hypot(m.x - x, m.y - y);
      if (d <= Math.max(HIT_PX, m.r + 3) && d < bestD) { best = m; bestD = d; }
    }
    return best;
  }
  function hitDynasty(x, y) {
    for (const r of dynRects) if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return r.row;
    return null;
  }
  /** 聚合圆的年代区间（用显示用的 y 反算，和视口一致） */
  function clusterSpan(m) {
    let lo = Infinity, hi = -Infinity;
    for (const it of m.items) {
      if (it.y < lo) lo = it.y;
      if (it.y > hi) hi = it.y;
    }
    return { a: yearAt(lo), b: yearAt(hi) };
  }
  function hoverModel() {
    if (state.hoverDyn) { // 朝代带：名称 + 起讫年（含 certainty 修饰）
      const d = state.hoverDyn.d;
      return { key: `dyn:${d.slug || d.name}`, title: dynName(d), meta: dynTimeText(d) };
    }
    const m = state.hover;
    if (!m) return null;
    if (m.kind === 'dot') return { key: m.key, title: String(m.ev.title || m.ev.slug || ''), meta: formatEventTime(m.ev) };
    const { a, b } = clusterSpan(m), ra = Math.round(a), rb = Math.round(b);
    return { key: m.key, title: `${m.items.length} ${t('timeline.cluster')}`, meta: ra === rb ? formatYear(ra) : `${formatYear(ra)} — ${formatYear(rb)}` };
  }
  function positionTip() {
    const model = hoverModel();
    if (!model || drag || destroyed) { tip.hidden = true; tipKey = null; return; }
    if (tipKey !== model.key) { // 内容只在命中目标变化时更新
      tipTitle.textContent = model.title; tipMeta.textContent = model.meta; tipKey = model.key;
    }
    tip.hidden = false;
    const box = tip.getBoundingClientRect ? tip.getBoundingClientRect() : { width: 0, height: 0 };
    let left = pointer.x + 16, top = pointer.y + 14;
    if (left + box.width + 10 > cssW) left = Math.max(4, pointer.x - box.width - 16);
    if (top + box.height + 10 > cssH) top = Math.max(4, pointer.y - box.height - 14);
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
  function setHover(marker, dynRow) {
    const keyOf = (m, d) => (m ? m.key : d ? `dyn:${d.d.slug || d.d.name}` : null);
    const next = keyOf(marker, dynRow), prev = keyOf(state.hover, state.hoverDyn);
    state.hover = marker || null;
    state.hoverDyn = dynRow || null;
    if (next !== prev) requestRender(); // 只在命中目标变化时重绘
  }
  function pickHoverAt() {
    const dynRow = hitDynasty(pointer.x, pointer.y);
    if (dynRow) setHover(null, dynRow); else setHover(hitMarker(pointer.x, pointer.y), null);
    positionTip();
  }
  /* --- 交互 --- */
  function emitSelect(ev) {
    if (destroyed || !ev || typeof onSelect !== 'function') return;
    try { onSelect(ev); } catch (err) { console.error('[timeline] onSelect 异常', err); }
  }
  /** 放大到 [a,b]（留 5% 余量，至少 MIN_SPAN） */
  function zoomTo(a, b) {
    const pad = Math.max((b - a) * 0.05, MIN_SPAN), span = Math.max(MIN_SPAN, b - a + pad * 2);
    const from = clamp(a - pad, YEAR_MIN, YEAR_MAX - span);
    applyView(from, from + span);
  }
  /** 点击：单点/单条桶 → onSelect；聚合桶或朝代带 → 放大到该范围 */
  function handleClick() {
    const dynRow = hitDynasty(pointer.x, pointer.y);
    if (dynRow) { zoomTo(dynRow.start, dynRow.end); return; }
    const m = hitMarker(pointer.x, pointer.y);
    if (!m) return;
    if (m.kind === 'dot' || m.items.length === 1) {
      const ev = m.kind === 'dot' ? m.ev : m.items[0].ev;
      state.selected = ev.slug;
      requestRender();
      emitSelect(ev);
      return;
    }
    const { a, b } = clusterSpan(m), pad = Math.max((b - a) * 0.5, MIN_SPAN);
    applyView(clamp(a - pad, YEAR_MIN, YEAR_MAX), clamp(b + pad, YEAR_MIN, YEAR_MAX));
  }
  function onPointerDown(e) {
    if (destroyed || e.button !== 0) return;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    pointer = localPoint(e);
    drag = { id: e.pointerId, y: pointer.y, from: state.from, to: state.to, moved: 0 };
    canvas.style.cursor = 'grabbing';
    setHover(null, null);
    positionTip();
  }
  function onPointerMove(e) {
    if (destroyed) return;
    pointer = localPoint(e);
    if (!drag) { pickHoverAt(); return; }
    const dy = pointer.y - drag.y, sp = drag.to - drag.from; // 纵向拖动平移
    drag.moved = Math.max(drag.moved, Math.abs(dy));
    const nf = clamp(drag.from - (dy / Math.max(1, layout.plotH)) * sp, YEAR_MIN, YEAR_MAX - sp);
    applyView(nf, nf + sp);
  }
  function onPointerUp(e) {
    if (!drag) return;
    const moved = drag.moved, id = drag.id;
    drag = null;
    canvas.style.cursor = 'grab';
    try { if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id); } catch { /* 忽略 */ }
    if (moved <= 4) { // 位移很小视为点击
      if (e && e.clientX != null) pointer = localPoint(e);
      handleClick();
      return;
    }
    pickHoverAt();
  }
  function onPointerLeave() {
    if (drag) return;
    setHover(null, null);
    positionTip();
  }
  function onWheel(e) {
    if (destroyed) return;
    e.preventDefault();
    pointer = localPoint(e);
    const anchor = yearAt(pointer.y), oldSpan = spanYears(); // 以鼠标所在年份为锚点
    const unit = e.deltaMode === 1 ? 0.05 : 0.0015;
    const next = clamp(oldSpan * Math.exp((e.deltaY || 0) * unit), MIN_SPAN, YEAR_MAX - YEAR_MIN);
    const nf = clamp(anchor - ((anchor - state.from) / oldSpan) * next, YEAR_MIN, YEAR_MAX - next);
    applyView(nf, nf + next);
    pickHoverAt();
  }
  function onDblClick(e) {
    if (destroyed) return;
    e.preventDefault(); // 双击复位到首次 setRange 的区间
    const target = home || { from: YEAR_MIN, to: YEAR_MAX };
    void setRange(target.from, target.to);
    emitRange();
  }
  /* --- 生命周期 --- */
  function measureAndRender() {
    if (destroyed) return;
    measure();
    requestRender();
  }
  const listeners = [
    ['pointerdown', onPointerDown], ['pointermove', onPointerMove], ['pointerup', onPointerUp],
    ['pointercancel', onPointerUp], ['pointerleave', onPointerLeave],
    ['wheel', onWheel, { passive: false }], ['dblclick', onDblClick],
  ];
  for (const [type, fn, opt] of listeners) canvas.addEventListener(type, fn, opt);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measureAndRender) : null;
  if (ro) ro.observe(root);
  else window.addEventListener('resize', measureAndRender);
  // 主题 / 语言变化：就地重绘（app 也会重建视图，这里兜底并避免闪烁）
  const offTheme = onThemeChange(() => requestRender());
  const offLang = onLangChange(() => { tipKey = null; tip.hidden = true; renderNow(); });
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (rafId) { caf(rafId); rafId = 0; }
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = 0; }
    loadToken += 1;
    if (ro) ro.disconnect();
    window.removeEventListener('resize', measureAndRender);
    for (const [type, fn, opt] of listeners) canvas.removeEventListener(type, fn, opt);
    offTheme();
    offLang();
    state.events = []; state.hover = null; state.hoverDyn = null;
    markers = []; dynRects = []; tipKey = null; tip.hidden = true;
    tip.remove(); canvas.remove(); root.remove();
    flushWaiters(); // 解开等待中的 Promise；此后不再回调 onSelect / onStats
  }
  measure();
  requestRender();
  return { setRange, getRange, setFilters, refresh, destroy };
}
