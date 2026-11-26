#!/usr/bin/env node
/**
 * bench/qps-cold.js —— 冷路径压测：每次请求带唯一参数，强制缓存未命中，
 * 从而测出「多进程」对真实检索吞吐的贡献。
 *
 *   node bench/qps-cold.js
 */
import { spawn } from 'node:child_process'
import http from 'node:http'

const DURATION = 6000
const CONCURRENCIES = [1, 4, 16]
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 })

let seq = 0
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
  const worker = async () => {
    while (Date.now() < end) {
      // 唯一参数：`&_=<seq>` 会让缓存键不同，强制走到数据库
      const n = seq++
      const q = ['水运', '青霉素', '指南针', '造纸', '秦朝'][n % 5]
      try {
        const r = await request(port, `/api/search?q=${encodeURIComponent(q)}&_=${n}`)
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

function start(args, env) {
  return spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: 'ignore',
    windowsHide: true,
  })
}

const variants = [
  { name: 'A 单进程·缓存开(冷命中)', port: 5191, args: ['src/server.js'], env: { PORT: '5191', CACHE_TTL_MS: '30000' } },
  { name: 'B cluster(4)·缓存开(冷命中)', port: 5192, args: ['src/cluster.js'], env: { PORT: '5192', CACHE_TTL_MS: '30000', WEB_CONCURRENCY: '4' } },
]

const results = []
for (const v of variants) {
  const child = start(v.args, v.env)
  const ok = await waitReady(v.port)
  if (!ok) {
    results.push({ name: v.name, rows: [{ concurrency: '-', qps: 'START FAIL' }] })
    try { child.kill() } catch { /* ignore */ }
    continue
  }
  const rows = []
  for (const c of CONCURRENCIES) rows.push(await load(v.port, c))
  results.push({ name: v.name, rows })
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 900))
}

console.log('\n=== 冷路径 QPS（唯一参数强制缓存未命中，每组 6 秒）===\n')
console.log('配置'.padEnd(28) + '并发'.padEnd(6) + 'QPS'.padEnd(9) + 'p50'.padEnd(8) + 'p95'.padEnd(8) + 'p99'.padEnd(8) + 'errors')
for (const r of results) {
  for (const row of r.rows) {
    console.log(
      r.name.padEnd(28) + String(row.concurrency).padEnd(6) + String(row.qps).padEnd(9) +
      String(row.p50 ?? '-').padEnd(8) + String(row.p95 ?? '-').padEnd(8) +
      String(row.p99 ?? '-').padEnd(8) + String(row.errors ?? '-'),
    )
  }
  console.log('')
}
console.log('JSON:', JSON.stringify(results))
process.exit(0)
