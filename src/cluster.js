#!/usr/bin/env node
/**
 * cluster.js —— 多进程入口：primary fork N 个 worker 共享同一端口，worker 内跑
 * server.js 的 createServer()。附带重启保护与优雅退出。
 *
 * 环境变量：
 *   PORT             监听端口（默认 5173）
 *   HOST             监听地址（默认 127.0.0.1）
 *   WEB_CONCURRENCY  worker 数（默认 Math.min(4, os.cpus().length)）
 *   CACHE_TTL_MS     > 0 启用每 worker 的响应缓存（默认 0 = 关闭）
 *   CACHE_MAX        LRU 条数上限（默认 512）
 *
 * 用法：node src/cluster.js
 */
import cluster from 'node:cluster'
import os from 'node:os'

// Windows 上 Node 默认 SCHED_NONE：所有 worker 竞争同一端口，实际只有一个能 accept，
// 表现为「多 worker 但只有一个在干活」。强制 SCHED_RR 让 primary 轮询分发连接。
if (cluster.isPrimary) {
  cluster.schedulingPolicy = cluster.SCHED_RR
}

const PORT = Number(process.env.PORT || 5173)
const HOST = process.env.HOST || '127.0.0.1'
const DEFAULT_WORKERS = Math.min(4, os.cpus().length)
const WORKERS = Math.max(1, Math.floor(Number(process.env.WEB_CONCURRENCY || DEFAULT_WORKERS) || DEFAULT_WORKERS))
const CACHE_TTL_MS = Math.max(0, Number(process.env.CACHE_TTL_MS || 0) || 0)
const CACHE_MAX = Math.max(1, Math.floor(Number(process.env.CACHE_MAX || 512) || 512))

/** 新 worker 至少活这么久才认为「稳定」，然后清零连败计数 */
const STABLE_MS = 10_000
/** 连续崩溃上限：超过就不再重启，避免 crash loop 打满 CPU */
const MAX_RESTARTS = 5
/** 单个 worker 关停超时（超时则 SIGKILL） */
const SHUTDOWN_TIMEOUT_MS = 5_000

if (cluster.isPrimary) {
  await primary()
} else {
  await workerMain()
}

/* ---------------------------------------------------------------- primary */

async function primary() {
  console.log(`\n  History Atlas v1 (cluster)`)
  console.log(`  http://${HOST}:${PORT}`)
  console.log(`  workers: ${WORKERS} (WEB_CONCURRENCY) | cpus: ${os.cpus().length}`)
  console.log(`  cache: ${CACHE_TTL_MS > 0 ? `ttl=${CACHE_TTL_MS}ms max=${CACHE_MAX}/worker` : 'off'}\n`)

  let consecutiveRestarts = 0
  let shuttingDown = false
  /** @type {Set<import('node:cluster').Worker>} */
  const live = new Set()

  function spawn(slot) {
    const worker = cluster.fork({ WEB_CONCURRENCY: String(WORKERS) })
    live.add(worker)
    worker.__slot = slot ?? worker.id
    // 稳定存活 → 清零连败
    const stableTimer = setTimeout(() => {
      consecutiveRestarts = 0
    }, STABLE_MS)
    stableTimer.unref()

    worker.on('exit', (code, signal) => {
      clearTimeout(stableTimer)
      live.delete(worker)
      if (shuttingDown) return
      consecutiveRestarts++
      console.error(
        `[cluster] worker ${worker.process.pid} exited (code=${code} signal=${signal || '-'}) ` +
          `restart ${consecutiveRestarts}/${MAX_RESTARTS}`,
      )
      if (consecutiveRestarts > MAX_RESTARTS) {
        console.error(`[cluster] too many restarts (>${MAX_RESTARTS}), giving up`)
        shutdown('give-up', 1)
        return
      }
      spawn(worker.__slot)
    })
  }

  for (let i = 0; i < WORKERS; i++) spawn(i + 1)

  /** 逐个 worker 优雅关闭：发 shutdown → 等退出 → 超时 SIGKILL */
  function closeWorker(worker) {
    return new Promise((resolve) => {
      if (!worker.isConnected() && !worker.process) return resolve()
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        console.warn(`[cluster] worker ${worker.process.pid} did not exit in ${SHUTDOWN_TIMEOUT_MS}ms, SIGKILL`)
        try {
          worker.process.kill('SIGKILL')
        } catch { /* ignore */ }
        finish()
      }, SHUTDOWN_TIMEOUT_MS)
      timer.unref()
      worker.once('exit', finish)
      try {
        worker.send({ type: 'shutdown' })
      } catch {
        try { worker.process.kill('SIGTERM') } catch { /* ignore */ }
      }
    })
  }

  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) return
    shuttingDown = true
    const list = [...live]
    console.log(`[cluster] ${signal} received, closing ${list.length} worker(s)...`)
    for (const worker of list) {
      await closeWorker(worker)
      console.log(`[cluster] worker ${worker.process.pid} closed`)
    }
    console.log('[cluster] all workers closed, bye')
    process.exit(exitCode)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

/* ----------------------------------------------------------------- worker */

async function workerMain() {
  const { createServer, CACHE_CONFIG } = await import('./server.js')
  const server = await createServer()

  /** 记录活连接，关停时可强制断开 keep-alive */
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  let closing = false
  function close(signal) {
    if (closing) return
    closing = true
    console.log(`[worker ${process.pid}] ${signal}: closing...`)
    const hardStop = setTimeout(() => {
      for (const s of sockets) s.destroy()
      process.exit(0)
    }, SHUTDOWN_TIMEOUT_MS - 1000)
    hardStop.unref()
    server.close(() => {
      clearTimeout(hardStop)
      process.exit(0)
    })
    server.closeIdleConnections?.()
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, () => {
      console.log(
        `[worker ${process.pid}] listening on ${HOST}:${PORT} | cache ` +
          (CACHE_CONFIG.enabled ? `ttl=${CACHE_CONFIG.ttlMs}ms max=${CACHE_CONFIG.max}` : 'off'),
      )
      resolve()
    })
  })

  process.on('message', (msg) => {
    if (msg && (msg === 'shutdown' || msg.type === 'shutdown')) close('shutdown')
  })
  process.on('SIGINT', () => close('SIGINT'))
  process.on('SIGTERM', () => close('SIGTERM'))
  process.on('disconnect', () => close('disconnect'))
}
