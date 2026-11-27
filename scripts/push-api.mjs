#!/usr/bin/env node
/**
 * scripts/push-api.mjs —— 通过 GitHub API 推送（绕过 github.com 的 HTTPS 阻断）
 *
 * 背景：本机网络对 `github.com` 的 HTTPS 有 SNI 层干扰，`git push` 时通时不通；
 *       但 `api.github.com` 始终可用。本脚本用 Git Data API 完成等价推送。
 *
 * 用法：
 *   node scripts/push-api.mjs --message "提交说明" [--tag v3.4.0] [--dry-run]
 *   node scripts/push-api.mjs -m "fix: xxx" -t v3.4.1
 *
 * 行为：
 *   1. 用 `git hash-object` 算本地文件 blob，与远端 tree 对比，找出新增/修改
 *   2. 上传变动的 blob（已存在的跳过）
 *   3. 基于远端 tree 创建新 tree / commit
 *   4. 更新 main 分支 ref
 *   5. 可选：创建 annotated tag
 *
 * 注意：
 *   · 只处理「新增 / 修改」，不处理删除（删除请单独用 --delete 显式指定）
 *   · 远端是权威版本；本地 git 历史可以落后，以文件内容为准
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const OWNER = '1314ysys'
const REPO = 'history-atlas'
const BRANCH = 'main'

const argv = process.argv.slice(2)
const flag = (names) => {
  for (const n of names) {
    const i = argv.indexOf(n)
    if (i >= 0 && i + 1 < argv.length) {
      const v = argv[i + 1]
      if (v && !v.startsWith('-')) return v
    }
  }
  return null
}
const has = (names) => names.some((n) => argv.includes(n))

const MESSAGE = flag(['--message', '-m'])
const TAG = flag(['--tag', '-t'])
const DRY = has(['--dry-run', '-n'])

if (!MESSAGE) {
  console.error('用法: node scripts/push-api.mjs -m "提交说明" [-t v3.4.0] [--dry-run]')
  console.error(`收到参数: ${JSON.stringify(argv.map((a) => (a.length > 40 ? a.slice(0, 40) + '…' : a)))}`)
  process.exit(1)
}

// 参数回显（便于发现 shell 引号问题）
console.log(`[push] message: ${MESSAGE.split('\n')[0].slice(0, 60)}${MESSAGE.includes('\n') ? ' …' : ''}`)
console.log(`[push] tag: ${TAG ?? '(无)'}${DRY ? ' | dry-run' : ''}`)

const gh = (path, method = 'GET', body) => {
  const args = ['api', '-X', method, path]
  if (body) args.push('--input', '-')
  return JSON.parse(
    execSync(`gh ${args.join(' ')}`, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      input: body ? JSON.stringify(body) : undefined,
    }),
  )
}

/* ---------------- 1. 远端现状 ---------------- */
console.log(`[push] 目标 ${OWNER}/${REPO}@${BRANCH}`)
const ref = gh(`repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
const baseCommit = ref.object.sha
const baseObj = gh(`repos/${OWNER}/${REPO}/git/commits/${baseCommit}`)
console.log(`[push] 远端 HEAD ${baseCommit.slice(0, 7)} — ${baseObj.message.split('\n')[0]}`)

// 拉远端完整 tree（递归）
const remoteTree = gh(`repos/${OWNER}/${REPO}/git/trees/${baseObj.tree.sha}?recursive=1`)
const remoteBlobs = new Map(
  remoteTree.tree.filter((t) => t.type === 'blob').map((t) => [t.path, t.sha]),
)
console.log(`[push] 远端 ${remoteBlobs.size} 个文件`)

/* ---------------- 2. 本地文件对比 ---------------- */
let tracked
try {
  // 已跟踪 + 未跟踪（排除 .gitignore 里的）
  // 只列已跟踪会漏掉新写的文件——第一版就踩过：push-api.mjs 自己没被推上去。
  const a = execSync('git ls-files', { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  const b = execSync('git ls-files --others --exclude-standard', { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
  tracked = [...new Set([...a, ...b])]
} catch {
  console.error('[push] 无法读取 git 文件列表')
  process.exit(1)
}

/**
 * 计算 git blob 的 SHA-1（与 GitHub 存的 sha 同一算法）。
 * git blob 格式：`blob <字节数>\0<内容>`
 *
 * 为什么不用 `git hash-object`：本机 core.autocrlf=true 会做行尾转换，
 * 且即使加 --no-filters，工作区仍是 CRLF 而远端是 LF，两边 sha 必然不同。
 * 统一在归一化（CRLF→LF）之后再算，才能正确判断「内容是否真的变了」。
 */
function blobSha(buf) {
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf8')
  return createHash('sha1').update(header).update(buf).digest('hex')
}

/** 含 NUL 字节视为二进制，原样；否则 CRLF → LF */
function normalizeForPush(buf) {
  if (buf.includes(0)) return buf
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
}

const changed = []
const skipped = []
for (const f of tracked) {
  if (!existsSync(f)) continue
  const raw = readFileSync(f)
  const localSha = blobSha(raw)
  const remoteSha = remoteBlobs.get(f)
  if (remoteSha === localSha) {
    skipped.push(f)
    continue
  }

  // sha 不同，再判断「是不是只有行尾差异」——避免 CRLF/LF 噪声产生无意义提交
  if (remoteSha) {
    try {
      const blob = gh(`repos/${OWNER}/${REPO}/git/blobs/${remoteSha}`)
      const remoteBuf = Buffer.from(blob.content, 'base64')
      const norm = (b) => b.toString('utf8').replace(/\r\n/g, '\n')
      if (norm(raw) === norm(remoteBuf)) {
        skipped.push(f)
        continue
      }
    } catch {
      /* 下载失败就按真变更处理 */
    }
  }
  changed.push({ path: f, sha: localSha, isNew: !remoteSha })
}

// 本地有、远端无（新增）；本地改了（修改）
console.log(
  `[push] 变更 ${changed.length} 个（新增 ${changed.filter((c) => c.isNew).length} / 修改 ${changed.filter((c) => !c.isNew).length}），未变 ${skipped.length} 个`,
)

if (!changed.length) {
  console.log('[push] 没有变更，退出')
  process.exit(0)
}

for (const c of changed.slice(0, 20)) {
  console.log(`  ${c.isNew ? 'A' : 'M'} ${c.path}`)
}
if (changed.length > 20) console.log(`  ... 还有 ${changed.length - 20} 个`)

if (DRY) {
  console.log('[push] --dry-run，不实际推送')
  process.exit(0)
}

/* ---------------- 3. 上传 blob ---------------- */
console.log('[push] 上传 blob…')

const entries = []
for (const c of changed) {
  const raw = readFileSync(c.path)
  if (raw.length > 10 * 1024 * 1024) {
    console.warn(`[push] 跳过超大文件 ${c.path} (${(raw.length / 1048576).toFixed(1)} MB)`)
    continue
  }
  const content = raw
  const blob = gh(`repos/${OWNER}/${REPO}/git/blobs`, 'POST', {
    content: content.toString('base64'),
    encoding: 'base64',
  })
  entries.push({ path: c.path, mode: '100644', type: 'blob', sha: blob.sha })
}

/* ---------------- 4. 建 tree / commit ---------------- */
const newTree = gh(`repos/${OWNER}/${REPO}/git/trees`, 'POST', {
  base_tree: baseObj.tree.sha,
  tree: entries,
})

const newCommit = gh(`repos/${OWNER}/${REPO}/git/commits`, 'POST', {
  message: MESSAGE,
  tree: newTree.sha,
  parents: [baseCommit],
})

/* ---------------- 5. 更新 ref ---------------- */
gh(`repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, 'PATCH', { sha: newCommit.sha })
console.log(`[push] ${BRANCH} -> ${newCommit.sha.slice(0, 7)}`)

/* ---------------- 6. tag ---------------- */
if (TAG) {
  try {
    gh(`repos/${OWNER}/${REPO}/git/refs/tags/${TAG}`, 'DELETE')
    console.log(`[push] 删除已存在的 tag ${TAG}`)
  } catch {
    /* 不存在 */
  }
  const tagObj = gh(`repos/${OWNER}/${REPO}/git/tags`, 'POST', {
    tag: TAG,
    message: `${TAG}: ${MESSAGE.split('\n')[0]}`,
    object: newCommit.sha,
    type: 'commit',
  })
  gh(`repos/${OWNER}/${REPO}/git/refs`, 'POST', {
    ref: `refs/tags/${TAG}`,
    sha: tagObj.sha,
  })
  console.log(`[push] tag ${TAG} -> ${newCommit.sha.slice(0, 7)}`)
}

console.log(`\n[push] 完成: https://github.com/${OWNER}/${REPO}/commit/${newCommit.sha}`)
