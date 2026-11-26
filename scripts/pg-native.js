#!/usr/bin/env node
/**
 * scripts/pg-native.js —— 管理本机原生 PostgreSQL（npm 提供的 Windows 二进制）
 *
 *   node scripts/pg-native.js init     初始化数据目录
 *   node scripts/pg-native.js start    启动（默认端口 5433）
 *   node scripts/pg-native.js stop     停止
 *   node scripts/pg-native.js status   查看状态
 *
 * 数据目录：data/pg-native   日志：data/pg-native.log
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin')
const DATA = path.join(ROOT, 'data', 'pg-native')
const LOG = path.join(ROOT, 'data', 'pg-native.log')
const PORT = process.env.PGPORT || '5433'

const exe = (name) => path.join(BIN, `${name}.exe`)
const run = (name, args, opts = {}) => {
  const r = spawnSync(exe(name), args, { encoding: 'utf8', ...opts })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const cmd = process.argv[2] || 'status'

if (!existsSync(BIN)) {
  console.error(`找不到 PostgreSQL 二进制：${BIN}\n请先 npm install @embedded-postgres/windows-x64`)
  process.exit(1)
}

if (cmd === 'init') {
  if (existsSync(path.join(DATA, 'PG_VERSION'))) {
    console.log(`[pg] 数据目录已存在：${DATA}`)
    process.exit(0)
  }
  mkdirSync(DATA, { recursive: true })
  const r = run('initdb', [
    '-D', DATA,
    '-U', 'postgres',
    '-A', 'trust',
    '-E', 'UTF8',
    '--locale=C',
    '--lc-collate=C',
    '--lc-ctype=C',
  ])
  console.log(r.out.trim().split('\n').slice(-6).join('\n'))
  if (r.code !== 0) process.exit(r.code)
  console.log(`[pg] 初始化完成：${DATA}`)
} else if (cmd === 'start') {
  const r = run('pg_ctl', ['-D', DATA, '-o', `-p ${PORT}`, '-l', LOG, '-w', 'start'])
  console.log(r.out.trim())
  if (r.code !== 0) process.exit(r.code)
  console.log(`[pg] 已启动：postgres://postgres@127.0.0.1:${PORT}/postgres`)
} else if (cmd === 'stop') {
  const r = run('pg_ctl', ['-D', DATA, '-m', 'fast', 'stop'])
  console.log(r.out.trim())
} else {
  const r = run('pg_ctl', ['-D', DATA, 'status'])
  console.log(r.out.trim())
}
