import http from 'node:http'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { migrate, schemaVersion } from './db/client.js'
import { createCache } from './cache.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')
export const WEB_DIR = path.join(ROOT, 'web')

const PORT = Number(process.env.PORT || 5173)
const HOST = process.env.HOST || '127.0.0.1'
const MAX_BODY = 20 * 1024 * 1024

/**
 * 响应缓存配置（按进程，cluster 下每个 worker 各有一份）。
 *   CACHE_TTL_MS  默认 0 = 关闭；> 0 才真正启用
 *   CACHE_MAX     默认 512 条 LRU 上限
 */
const CACHE_TTL_MS = Math.max(0, Number(process.env.CACHE_TTL_MS || 0) || 0)
const CACHE_MAX = Math.max(1, Math.floor(Number(process.env.CACHE_MAX || 512) || 512))
export const CACHE_CONFIG = { ttlMs: CACHE_TTL_MS, max: CACHE_MAX, enabled: CACHE_TTL_MS > 0 }

/** 只缓存这几类只读接口：搜索 / 时间轴 / 王朝带 / 边界 GeoJSON（含 /list） */
const CACHEABLE_PATHS = new Set(['/api/search', '/api/timeline', '/api/dynasties'])

function isCacheablePath(pathname) {
  if (CACHEABLE_PATHS.has(pathname)) return true
  return pathname === '/api/boundaries' || pathname.startsWith('/api/boundaries/')
}

/** key = method + pathname + 排序后的 query（保证 ?a=1&b=2 与 ?b=2&a=1 同键） */
function cacheKeyOf(method, pathname, searchParams) {
  const pairs = [...searchParams.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  )
  const qs = pairs.map(([k, v]) => `${k}=${v}`).join('&')
  return qs ? `${method} ${pathname}?${qs}` : `${method} ${pathname}`
}

/** @type {{method:string, parts:string[], handler:Function}[]} */
const ROUTES = []

/**
 * 注册路由。pattern 形如 '/api/event/:slug'
 */
export function route(method, pattern, handler) {
  ROUTES.push({ method: method.toUpperCase(), parts: pattern.split('/').filter(Boolean), handler })
}

function matchRoute(method, urlParts) {
  for (const r of ROUTES) {
    if (r.method !== method) continue
    if (r.parts.length !== urlParts.length) continue
    const params = {}
    let ok = true
    for (let i = 0; i < r.parts.length; i++) {
      const p = r.parts[i]
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(urlParts[i])
      else if (p !== urlParts[i]) { ok = false; break }
    }
    if (ok) return { handler: r.handler, params }
  }
  return null
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.geojson': 'application/geo+json',
  '.txt': 'text/plain; charset=utf-8',
}

function mimeOf(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { statusCode: 413 })
    chunks.push(chunk)
  }
  if (!chunks.length) return null
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw)
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 })
  }
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
}

/** 直接写出已序列化好的 JSON 字符串（缓存命中路径复用，避免二次 stringify） */
function sendJsonBody(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(body)
}

function sendJson(res, status, payload) {
  sendJsonBody(res, status, JSON.stringify(payload))
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname
  const filePath = path.join(WEB_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''))
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403).end('forbidden')
    return
  }
  try {
    const buf = await readFile(filePath)
    const isAsset = /\.(m?js|css)$/i.test(filePath)
    /** @type {Record<string,string>} */
    const headers = {
      'content-type': mimeOf(filePath),
      // JS/CSS 一律不缓存：改完代码刷新即生效，避免用户看到旧版本
      'cache-control': isAsset
        ? 'no-store, no-cache, must-revalidate'
        : pathname.startsWith('/generated/')
          ? 'public, max-age=60'
          : 'no-cache',
    }
    if (isAsset) headers.pragma = 'no-cache'
    res.writeHead(200, headers)
    res.end(buf)
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error('[server] static failed:', filePath, err.message)
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 not found')
  }
}

const API_MODULES = [
  './api/stats.js',
  './api/timeline.js',
  './api/event.js',
  './api/person.js',
  './api/search.js',
  './api/map.js',
  './api/graph.js',
  './api/boundaries.js',
  './api/dynasties.js',
  './api/verify.js',
  './api/snapshot.js',
  './api/metrics.js',
  './ingest/router.js',
]

async function mountApiModules() {
  for (const rel of API_MODULES) {
    const abs = path.join(HERE, rel)
    try {
      const mod = await import(pathToFileURL(abs).href)
      const routes = mod.routes || []
      for (const [method, pattern, handler] of routes) route(method, pattern, handler)
      console.log(`[server] mounted ${rel} (${routes.length} routes)`)
    } catch (err) {
      if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
        console.warn(`[server] skip ${rel} (not implemented yet)`)
      } else {
        console.error(`[server] failed to mount ${rel}:`, err.message)
      }
    }
  }
}

export async function createServer() {
  await migrate()

  // 响应缓存（每进程一份；CACHE_TTL_MS=0 时为 null，全部走原路径）
  const cache = CACHE_TTL_MS > 0 ? createCache({ max: CACHE_MAX, ttlMs: CACHE_TTL_MS }) : null
  if (cache) {
    console.log(`[server] response cache ON (ttl=${CACHE_TTL_MS}ms, max=${CACHE_MAX})`)
  }

  // 构建号：由 web/js/*.js 与 app.css 的 mtime 派生，用于确认浏览器加载的是新代码
  let buildId = null
  route('GET', '/api/build', async () => {
    if (buildId) return { build: buildId }
    try {
      const { readdir, stat } = await import('node:fs/promises')
      const { createHash } = await import('node:crypto')
      const jsDir = path.join(WEB_DIR, 'js')
      const files = (await readdir(jsDir)).filter((f) => f.endsWith('.js'))
      const stamps = []
      for (const f of files.sort()) {
        const s = await stat(path.join(jsDir, f))
        stamps.push(`${f}:${s.mtimeMs}`)
      }
      const cssStat = await stat(path.join(WEB_DIR, 'app.css'))
      stamps.push(`app.css:${cssStat.mtimeMs}`)
      buildId = createHash('sha256').update(stamps.join('|')).digest('hex').slice(0, 8)
    } catch {
      buildId = 'unknown'
    }
    return { build: buildId }
  })

  await mountApiModules()

  // 缓存观测端点（自身不缓存）
  route('GET', '/api/cache/stats', async () => {
    const s = cache ? cache.stats() : { hits: 0, misses: 0, size: 0, hitRate: 0 }
    return {
      hits: s.hits,
      misses: s.misses,
      size: s.size,
      hitRate: s.hitRate,
      ttlMs: CACHE_TTL_MS,
      max: CACHE_MAX,
      enabled: Boolean(cache),
      pid: process.pid,
    }
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization',
      })
      res.end()
      return
    }

    const isApi = pathname.startsWith('/api/') || pathname.startsWith('/v1/')
    if (!isApi) {
      await serveStatic(res, pathname)
      return
    }

    const parts = pathname.split('/').filter(Boolean)
    const hit = matchRoute(req.method, parts)
    if (!hit) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `no route ${req.method} ${pathname}` } })
      return
    }

    // —— 缓存读：仅 GET 且命中白名单路径 ——
    const key = cache && req.method === 'GET' && isCacheablePath(pathname)
      ? cacheKeyOf(req.method, pathname, url.searchParams)
      : null
    if (key) {
      const cached = cache.get(key)
      if (cached !== undefined) {
        sendJsonBody(res, 200, cached)
        return
      }
    }

    try {
      const body = req.method === 'POST' ? await readBody(req) : null
      const query = Object.fromEntries(url.searchParams.entries())
      const result = await hit.handler({ params: hit.params, query, body, req, res })
      if (res.writableEnded) return
      const status = result?.__status || 200
      const payload = JSON.stringify(result ?? { ok: true })
      // —— 缓存写：只存 200 的 JSON 响应体（字符串原样写回）——
      if (key && status === 200) cache.set(key, payload)
      sendJsonBody(res, status, payload)
    } catch (err) {
      const status = err?.statusCode || 500
      if (status >= 500) console.error(`[server] ${req.method} ${pathname}:`, err)
      sendJson(res, status, {
        error: { code: err?.code || 'INTERNAL', message: err?.message || 'internal error' },
      })
    }
  })

  return server
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url

if (isMain) {
  const server = await createServer()
  server.listen(PORT, HOST, () => {
    console.log(`\n  History Atlas v1`)
    console.log(`  http://${HOST}:${PORT}`)
    console.log(`  schema: ${'v1'} | routes: ${ROUTES.length}`)
    console.log(`  cache: ${CACHE_TTL_MS > 0 ? `ttl=${CACHE_TTL_MS}ms max=${CACHE_MAX}` : 'off'}\n`)
  })
  const shutdown = async () => {
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
