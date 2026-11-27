#!/usr/bin/env node
/**
 * scripts/tag-release.mjs —— 给远端当前 HEAD 打 annotated tag
 *
 *   node scripts/tag-release.mjs              # 用 package.json 的 version
 *   node scripts/tag-release.mjs v3.4.0       # 显式指定
 *   node scripts/tag-release.mjs --list       # 列出远端现有 tag
 *
 * 为什么单独一个脚本：命令行传 tag 名时，PowerShell 的多行字符串会把
 * `-t xxx` 吞进 message 参数里（实测踩过），从 package.json 读最稳。
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const OWNER = '1314ysys'
const REPO = 'history-atlas'
const gh = (path, method = 'GET', body) => {
  const args = ['api', '-X', method, path]
  if (body) args.push('--input', '-')
  return JSON.parse(
    execSync(`gh ${args.join(' ')}`, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      input: body ? JSON.stringify(body) : undefined,
    }),
  )
}

if (process.argv.includes('--list')) {
  const tags = gh(`repos/${OWNER}/${REPO}/tags`)
  console.log(`远端 tag（${tags.length} 个）:`)
  for (const t of [...tags].reverse()) {
    console.log(`  ${t.name.padEnd(10)} → ${t.commit.sha.slice(0, 7)}`)
  }
  process.exit(0)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const explicit = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null
const tagName = explicit || `v${pkg.version}`

const ref = gh(`repos/${OWNER}/${REPO}/git/ref/heads/main`)
const headSha = ref.object.sha
const headObj = gh(`repos/${OWNER}/${REPO}/git/commits/${headSha}`)
console.log(`远端 HEAD ${headSha.slice(0, 7)} — ${headObj.message.split('\n')[0]}`)
console.log(`准备打 tag: ${tagName}`)

// 已存在则先删
try {
  gh(`repos/${OWNER}/${REPO}/git/refs/tags/${tagName}`, 'DELETE')
  console.log(`  已删除旧的 ${tagName}`)
} catch {
  /* 不存在 */
}

const tagObj = gh(`repos/${OWNER}/${REPO}/git/tags`, 'POST', {
  tag: tagName,
  message: `${tagName}: ${headObj.message.split('\n')[0]}`,
  object: headSha,
  type: 'commit',
})
gh(`repos/${OWNER}/${REPO}/git/refs`, 'POST', {
  ref: `refs/tags/${tagName}`,
  sha: tagObj.sha,
})
console.log(`✓ ${tagName} → ${headSha.slice(0, 7)}`)
