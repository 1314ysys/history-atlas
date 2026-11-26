import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
export const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.join(ROOT, 'storage', 'archive')

/** @param {string|Buffer} data @returns {string} hex sha256 */
export function sha256hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** 两级分桶，避免单目录文件过多 */
export function keyFor(sha) {
  return path.join(sha.slice(0, 2), sha.slice(2, 4), `${sha}.txt`)
}

function absPath(key) {
  return path.join(ARCHIVE_DIR, key)
}

/**
 * 写入一段文本到内容寻址存档。重复内容不会重复写。
 * @param {string} text @returns {Promise<{sha256:string,size:number,key:string,created:boolean}>}
 */
export async function putText(text) {
  const buf = Buffer.from(text, 'utf8')
  const sha = sha256hex(buf)
  const key = keyFor(sha)
  const file = absPath(key)
  try {
    await stat(file)
    return { sha256: sha, size: buf.length, key, created: false }
  } catch {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, buf)
    return { sha256: sha, size: buf.length, key, created: true }
  }
}

/** @param {string} sha @returns {Promise<string|null>} */
export async function getText(sha) {
  try {
    return await readFile(absPath(keyFor(sha)), 'utf8')
  } catch {
    return null
  }
}

/** @param {string} sha */
export async function exists(sha) {
  try {
    const s = await stat(absPath(keyFor(sha)))
    return s.isFile()
  } catch {
    return false
  }
}

/**
 * 校验：存档存在且内容哈希一致，且（可选）原文包含给定片段。
 * @param {string} sha
 * @param {{ quote?: string }} [opts]
 * @returns {Promise<{status:'verified'|'mismatch'|'missing', size?:number}>}
 */
export async function verify(sha, opts = {}) {
  const text = await getText(sha)
  if (text == null) return { status: 'missing' }
  const actual = sha256hex(Buffer.from(text, 'utf8'))
  if (actual !== sha) return { status: 'mismatch' }
  if (opts.quote) {
    const norm = (s) => s.replace(/\s+/g, '')
    if (!norm(text).includes(norm(opts.quote))) return { status: 'mismatch' }
  }
  return { status: 'verified', size: Buffer.byteLength(text, 'utf8') }
}
