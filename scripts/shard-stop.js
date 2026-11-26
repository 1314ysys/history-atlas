#!/usr/bin/env node
/**
 * scripts/shard-stop.js —— 停止分片实例（保留数据目录，随时可重启）
 *
 *   node scripts/shard-stop.js
 *
 * 只停 5441/5442/5443 三个分片，不动 5433（主库）与 5434（从库）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin')

const SHARDS = [
  { name: 'shard0', dir: path.join(ROOT, 'data', 'pg-shard0'), port: 5441 },
  { name: 'shard1', dir: path.join(ROOT, 'data', 'pg-shard1'), port: 5442 },
  { name: 'shard2', dir: path.join(ROOT, 'data', 'pg-shard2'), port: 5443 },
]

const pgCtl = path.join(BIN, 'pg_ctl.exe')
if (!existsSync(pgCtl)) {
  console.error(`找不到 pg_ctl：${pgCtl}`)
  process.exit(1)
}

for (const s of SHARDS) {
  if (!existsSync(path.join(s.dir, 'PG_VERSION'))) {
    console.log(`[shard-stop] ${s.name}: 数据目录不存在，跳过`)
    continue
  }
  const r = spawnSync(pgCtl, ['-D', s.dir, '-m', 'fast', 'stop'], { encoding: 'utf8' })
  const out = ((r.stdout || '') + (r.stderr || '')).trim()
  const ok = r.status === 0 || /not running|no server running/i.test(out)
  console.log(`[shard-stop] ${s.name} (${s.port}): ${ok ? '已停止' : '失败'} ${ok ? '' : out.split('\n')[0]}`)
}

console.log('\n[shard-stop] 数据目录保留，可用 node scripts/shard-proto.js 重新启动')
