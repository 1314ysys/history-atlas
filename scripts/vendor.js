#!/usr/bin/env node
/**
 * scripts/vendor.js —— 从 node_modules 复制第三方前端库到 web/vendor/
 *
 *   npm run vendor
 *
 * 前端是「零构建」的：index.html 直接引用 /vendor/*.js（UMD 全局），
 * 不走打包器。因此 npm install 之后需要把 dist 文件复制到 web/vendor/。
 *
 * 仓库里已包含一份 vendor 产物（克隆即可跑）；本脚本用于升级 maplibre 后刷新。
 */
import { copyFile, mkdir, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = path.join(ROOT, 'web', 'vendor')
const SRC = path.join(ROOT, 'node_modules', 'maplibre-gl', 'dist')

const FILES = [
  ['maplibre-gl.js', 'maplibre-gl.js'],
  ['maplibre-gl.css', 'maplibre-gl.css'],
  ['LICENSE.txt', 'LICENSE-maplibre.txt'],
  ['LICENSE', 'LICENSE-maplibre.txt'],
]

const exists = async (p) => {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

if (!(await exists(SRC))) {
  console.error(`[vendor] 找不到 ${SRC}`)
  console.error('[vendor] 请先运行 npm install')
  process.exit(1)
}

await mkdir(VENDOR, { recursive: true })

let copied = 0
for (const [from, to] of FILES) {
  const src = path.join(SRC, from)
  if (!(await exists(src))) continue
  const dst = path.join(VENDOR, to)
  if (await exists(dst)) {
    // LICENSE 两个候选名只复制一次
    if (to.startsWith('LICENSE')) continue
  }
  await copyFile(src, dst)
  console.log(`[vendor] ${from} -> web/vendor/${to}`)
  copied++
}

if (!copied) {
  console.warn('[vendor] 没有文件被复制（目标已存在或源缺失）')
} else {
  console.log(`[vendor] 完成，共 ${copied} 个文件`)
}
