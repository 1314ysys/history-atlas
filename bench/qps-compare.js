#!/usr/bin/env node
/**
 * bench/qps-compare.js —— 在单个脚本内起三种服务形态、压测、再关掉。
 *
 *   node bench/qps-compare.js
 *
 * A 单进程无缓存      B 单进程 + 响应缓存      C cluster(4) + 响应缓存
 */
import { spawn } from 'node:child_process'
import http from 'node:http'

const QUERIES = ['水运仪象台', '青霉素', '指南针', '造纸', '秦']
const DURATION = 6000
const CONCURRENCIES = [1, 4, 16]

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 })

function request(port, path) {
  return new Promise((resolve, reject) => {
    const t0 = Number(process.hrtime.bigint() / 1000n) / 1000
    const req = http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
      res.resume()
      res.on('end', () => resolve({ ms: Number(process.hrtime.bigint() / 1000n) / 1000 - t0, status: res.statusCode }))
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('timeout')))
  })
}

async function waitReady(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await request(port, '/api/health')
      if (r.status === 200) return true
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

async function load(port, concurrency) {
  const lat = []
  let errors = 0
  const end = Date.now() + DURATION
  let counter = 0
  const worker = async () => {
    while (Date.now() < end) {
      const q = QUERIES[counter++ % QUERIES.length]
      try {
        const r = await request(port, `/api/search?q=${encodeURIComponent(q)}`)
        if (r.status !== 200) errors++
        else lat.push(r.ms)
      } catch {
        errors++
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  lat.sort((a, b) => a - b)
  const p = (x) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(x * lat.length))] : 0)
  return {
    concurrency,
    qps: Math.round(lat.length / (DURATION / 1000)),
    p50: +p(0.5).toFixed(2),
    p95: +p(0.95).toFixed(2),
    p99: +p(0.99).toFixed(2),
    errors,
  }
}

function start(name, cmd, args, env) {
  const child = spawn(cmd, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: 'ignore',
    windowsHide: true,
  })
  return { name, child }
}

const variants = [
  { name: 'A 单进程·无缓存', port: 5181, cmd: process.execPath, args: ['src/server.js'], env: { PORT: '5181' } },
  { name: 'B 单进程·缓存30s', port: 5182, cmd: process.execPath, args: ['src/server.js'], env: { PORT: '5182', CACHE_TTL_MS: '30000' } },
  { name: 'C cluster(4)·缓存30s', port: 5183, cmd: process.execPath, args: ['src/cluster.js'], env: { PORT: '5183', CACHE_TTL_MS: '30000', WEB_CONCURRENCY: '4' } },
]

const results = []
for (const v of variants) {
  const { child } = start(v.name, v.cmd, v.args, v.env)
  const ok = await waitReady(v.port)
  if (!ok) {
    results.push({ ...v, rows: [{ concurrency: '-', qps: 'START FAIL', p50: '-', p95: '-', p99: '-', errors: '-' }] })
    try { child.kill() } catch { /* ignore */ }
    continue
  }
  const rows = []
  for (const c of CONCURRENCIES) rows.push(await load(v.port, c))
  results.push({ ...v, rows })
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 800))
}

console.log('\n=== QPS 对比（/api/search，每组 6 秒）===\n')
console.log('配置'.padEnd(22) + '并发'.padEnd(6) + 'QPS'.padEnd(10) + 'p50'.padEnd(9) + 'p95'.padEnd(9) + 'p99'.padEnd(9) + 'errors')
for (const r of results) {
  for (const row of r.rows) {
    console.log(
      r.name.padEnd(22) +
      String(row.concurrency).padEnd(6) +
      String(row.qps).padEnd(10) +
      String(row.p50).padEnd(9) +
      String(row.p95).padEnd(9) +
      String(row.p99).padEnd(9) +
      String(row.errors),
    )
  }
  console.log('')
}
console.log('JSON:', JSON.stringify(results.map((r) => ({ name: r.name, rows: r.rows }))))
process.exit(0)
