#!/usr/bin/env node
/**
 * scripts/qps.js —— 极小 HTTP 压测器（零依赖），用来给 /api/search 打并发、
 * 量化 qps 与 p50/p95/p99。
 *
 * 用法：
 *   node scripts/qps.js --port 5173 --concurrency 16 --duration 8 \
 *        --queries "水运仪象台,印刷术,蒸汽机,文艺复兴"
 *
 * 参数：
 *   --port        服务端口（默认 5173）
 *   --host        服务地址（默认 127.0.0.1）
 *   --concurrency 并发在飞请求数（默认 16）
 *   --duration    压测时长，秒（默认 8；也接受 5000ms / 1m）
 *   --queries     查询词，逗号分隔（默认取几个库里必命中的词）
 *   --queries-file 每行一个查询词的文件（与 --queries 互斥，优先文件）
 *   --path        请求路径（默认 /api/search）
 *   --warmup      预热时长，秒（默认 0；不计入统计）
 *
 * 输出：qps / p50 / p95 / p99 / max / 平均耗时 / 状态码分布 / 平均响应字节数。
 * 非 2xx 计入 errors（不计进 QPS 的分母可疑场景会在输出里显式列出）。
 *
 * 实现要点：keep-alive Agent + N 个紧循环协程，每条请求用 hrtime 计时；
 * 所有耗时为「单请求往返」，不做协调忽略（coordination omission）修正。
 */
import http from 'node:http'
import { readFile } from 'node:fs/promises'

/* --------------------------------------------------------------- arg 解析 */

/** 支持 --k=v / --k v 两种写法；拿不到值的布尔开关为 true */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

/** 时长：8 / 8s / 8000ms / 1m → 毫秒 */
function parseDuration(v, fallbackMs) {
  if (v === undefined || v === true) return fallbackMs
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(v).trim())
  if (!m) return fallbackMs
  const n = Number(m[1])
  const unit = m[2] || 's'
  if (unit === 'ms') return Math.round(n)
  if (unit === 'm') return Math.round(n * 60_000)
  return Math.round(n * 1000)
}

const DEFAULT_QUERIES = ['水运仪象台', '印刷术', '蒸汽机', '文艺复兴', '唐朝', '布匿战争']

const args = parseArgs(process.argv.slice(2))
const HOST = String(args.host || '127.0.0.1')
const PORT = Number(args.port || 5173)
const CONCURRENCY = Math.max(1, Math.min(512, Math.floor(Number(args.concurrency || 16) || 16)))
const DURATION_MS = Math.max(500, parseDuration(args.duration, 8000))
const WARMUP_MS = Math.max(0, parseDuration(args.warmup, 0))
const PATH = String(args.path || '/api/search')

let queries = DEFAULT_QUERIES
if (args['queries-file'] && args['queries-file'] !== true) {
  const raw = await readFile(String(args['queries-file']), 'utf8')
  queries = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
} else if (args.queries && args.queries !== true) {
  queries = String(args.queries).split(',').map((s) => s.trim()).filter(Boolean)
}
if (!queries.length) {
  console.error('[qps] no queries given')
  process.exit(2)
}

/* ---------------------------------------------------------------- 压测器 */

const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY, maxFreeSockets: CONCURRENCY })

let seq = 0
function nextUrl() {
  const q = queries[seq++ % queries.length]
  return `${PATH}?q=${encodeURIComponent(q)}`
}

/** 单请求：resolve { ok, status, ms, bytes } */
function once() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint()
    const req = http.request(
      { host: HOST, port: PORT, path: nextUrl(), method: 'GET', agent },
      (res) => {
        let bytes = 0
        res.on('data', (chunk) => {
          bytes += chunk.length
        })
        res.on('end', () => {
          const ms = Number(process.hrtime.bigint() - t0) / 1e6
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, ms, bytes })
        })
        res.on('error', () => {
          const ms = Number(process.hrtime.bigint() - t0) / 1e6
          resolve({ ok: false, status: 0, ms, bytes: 0 })
        })
      },
    )
    req.on('error', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6
      resolve({ ok: false, status: 0, ms, bytes: 0 })
    })
    req.end()
  })
}

/** 在 windowMs 内保持 concurrency 条在飞，返回该窗口内的样本 */
async function run(windowMs, collect) {
  const latencies = []
  const statuses = new Map()
  let errors = 0
  let bytes = 0
  let done = 0
  const deadline = Date.now() + windowMs

  async function coro() {
    while (Date.now() < deadline) {
      const r = await once()
      done++
      if (collect) {
        latencies.push(r.ms)
        bytes += r.bytes
        statuses.set(r.status, (statuses.get(r.status) || 0) + 1)
        if (!r.ok) errors++
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, coro))
  return { latencies, statuses, errors, bytes, done }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

function summarize(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    n: sorted.length,
    avg: sorted.length ? sum / sorted.length : 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
  }
}

const round = (n, d = 2) => Number(n.toFixed(d))

/* ------------------------------------------------------------------ 主流程 */

console.log(
  `[qps] http://${HOST}:${PORT}${PATH} | concurrency=${CONCURRENCY} duration=${DURATION_MS}ms` +
    `${WARMUP_MS ? ` warmup=${WARMUP_MS}ms` : ''} | queries=${queries.length}`,
)

if (WARMUP_MS > 0) {
  await run(WARMUP_MS, false)
  console.log('[qps] warmup done')
}

const startedAt = Date.now()
const { latencies, statuses, errors, bytes, done } = await run(DURATION_MS, true)
const elapsedMs = Date.now() - startedAt
const s = summarize(latencies)
const qps = s.n / (elapsedMs / 1000)

const statusText = [...statuses.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([code, n]) => `${code || 'ERR'}:${n}`)
  .join(' ')

console.log('')
console.log(`  elapsed   ${(elapsedMs / 1000).toFixed(2)} s`)
console.log(`  requests  ${s.n}  (attempted ${done})`)
console.log(`  qps       ${round(qps, 1)}`)
console.log(`  p50       ${round(s.p50)} ms`)
console.log(`  p95       ${round(s.p95)} ms`)
console.log(`  p99       ${round(s.p99)} ms`)
console.log(`  avg       ${round(s.avg)} ms   max ${round(s.max)} ms`)
console.log(`  errors    ${errors}   status[${statusText}]`)
console.log(`  avg body  ${s.n ? round(bytes / s.n, 0) : 0} B`)
console.log('')

// 便于脚本抓取：末行一行 JSON
console.log(
  JSON.stringify({
    port: PORT,
    concurrency: CONCURRENCY,
    durationMs: elapsedMs,
    qps: round(qps, 1),
    p50: round(s.p50),
    p95: round(s.p95),
    p99: round(s.p99),
    avg: round(s.avg),
    max: round(s.max),
    requests: s.n,
    errors,
    statuses: Object.fromEntries(statuses),
  }),
)

agent.destroy()
