import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sha256hex } from '../src/archive/store.js'
import { merkleRoot, ALGORITHM } from '../src/archive/merkle.js'
import {
  SNAPSHOT_DIR,
  buildLeaves,
  compressionExtOf,
  decompressJsonl,
} from './snapshot.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const KINDS = ['events', 'claims', 'sources']

/** @param {string} name @returns {'events'|'claims'|'sources'|null} */
function kindOf(name) {
  return KINDS.find((kind) => String(name).startsWith(kind)) || null
}

/**
 * 解析要校验的日期：位置参数 / --date=YYYY-MM-DD，缺省读 snapshots/latest.json。
 * @param {string[]} argv
 * @returns {Promise<string>}
 */
async function resolveDate(argv) {
  const flag = argv.find((arg) => arg.startsWith('--date='))
  const bare = argv.find((arg) => DATE_RE.test(arg))
  const raw = flag ? flag.slice('--date='.length) : bare
  if (raw) {
    if (!DATE_RE.test(raw)) throw new Error(`invalid date "${raw}", expected YYYY-MM-DD`)
    return raw
  }
  const latest = JSON.parse(await readFile(path.join(SNAPSHOT_DIR, 'latest.json'), 'utf8'))
  if (!latest?.date || !DATE_RE.test(latest.date)) {
    throw new Error(`cannot resolve date: ${path.join(SNAPSHOT_DIR, 'latest.json')} has no valid date`)
  }
  return latest.date
}

/**
 * 严格解析 JSONL。
 * @param {string} text @param {string} name @returns {Record<string, any>[]}
 */
function parseJsonl(text, name) {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  return lines.map((line, i) => {
    try {
      return JSON.parse(line)
    } catch {
      throw new Error(`${name}: invalid JSON on line ${i + 1}`)
    }
  })
}

/**
 * 校验一份快照。
 * @param {string[]} [argv]
 * @returns {Promise<{ ok: boolean, date: string, errors: string[], manifest: any }>}
 */
export async function main(argv = process.argv.slice(2)) {
  /** @type {string[]} */
  const errors = []
  const date = await resolveDate(argv)
  const dir = path.join(SNAPSHOT_DIR, date)
  const relDir = path.relative(ROOT, dir) || dir

  console.log(`[verify] snapshot ${date}  (${relDir})`)

  let manifest
  try {
    manifest = JSON.parse(await readFile(path.join(dir, 'MANIFEST.json'), 'utf8'))
  } catch (err) {
    console.error(`[verify] cannot read MANIFEST.json: ${err.message}`)
    console.log('SNAPSHOT FAILED')
    return { ok: false, date, errors: [`cannot read MANIFEST.json: ${err.message}`], manifest: null }
  }

  if (manifest.date !== date) {
    errors.push(`manifest.date ${manifest.date} != requested ${date}`)
  }
  if (manifest.algorithm !== ALGORITHM) {
    errors.push(`manifest.algorithm ${manifest.algorithm} != ${ALGORITHM}`)
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    errors.push('manifest.files is missing or empty')
  }

  /** @type {Record<string, Record<string, any>[]>} */
  const rowsByKind = {}
  /** @type {Set<string>} */
  const seenKinds = new Set()
  /** 读取/解压失败的类型不再重复报 counts 不符，避免噪声 */
  const failedKinds = new Set()

  for (const file of manifest.files || []) {
    const name = String(file?.name || '')
    const ext = compressionExtOf(name)
    const kind = kindOf(name)
    if (kind) seenKinds.add(kind)

    let buf
    try {
      buf = await readFile(path.join(dir, name))
    } catch (err) {
      errors.push(`${name}: cannot read (${err.code || err.message})`)
      if (kind) failedKinds.add(kind)
      continue
    }

    const actual = sha256hex(buf)
    const hashOk = actual === file.sha256
    const sizeOk = buf.length === file.bytes
    if (!hashOk) errors.push(`${name}: sha256 ${actual} != manifest ${file.sha256}`)
    if (!sizeOk) errors.push(`${name}: ${buf.length} bytes != manifest ${file.bytes} bytes`)

    let rows = null
    try {
      rows = parseJsonl(decompressJsonl(buf, ext), name)
      if (kind) rowsByKind[kind] = rows
    } catch (err) {
      errors.push(`${name}: ${err.message}`)
      if (kind) failedKinds.add(kind)
    }

    const codec = ext ? ext.slice(1) : 'plain'
    console.log(
      `  ${hashOk && sizeOk && rows ? 'OK  ' : 'FAIL'} ${name.padEnd(20)}` +
        `${rows ? `${String(rows.length).padStart(6)} rows` : '  ?     rows'}  ` +
        `${String(buf.length).padStart(8)} bytes  ${codec.padEnd(7)}  sha256 ${actual.slice(0, 16)}…`,
    )
  }

  for (const kind of KINDS) {
    if (!seenKinds.has(kind)) errors.push(`manifest.files is missing ${kind}.jsonl*`)
  }

  const events = rowsByKind.events || []
  const claims = rowsByKind.claims || []
  const sources = rowsByKind.sources || []
  const leaves = buildLeaves({ events, sources })
  const computed = merkleRoot(leaves)

  const counts = manifest.counts || {}
  const countPairs = [
    ['events', events.length],
    ['claims', claims.length],
    ['sources', sources.length],
  ]
  for (const [key, actual] of countPairs) {
    if (failedKinds.has(key)) continue
    if (Number(counts[key]) !== actual) {
      errors.push(`counts.${key} ${counts[key]} != exported ${actual}`)
    }
  }

  let rootFromFile = null
  try {
    rootFromFile = (await readFile(path.join(dir, 'root.txt'), 'utf8')).trim()
  } catch (err) {
    errors.push(`root.txt: cannot read (${err.code || err.message})`)
  }

  if (rootFromFile != null && rootFromFile !== computed) {
    errors.push(`root.txt ${rootFromFile} != recomputed ${computed}`)
  }
  if (manifest.merkle_root !== computed) {
    errors.push(`manifest.merkle_root ${manifest.merkle_root} != recomputed ${computed}`)
  }
  if (Number(manifest.leaf_count) !== leaves.length) {
    errors.push(`manifest.leaf_count ${manifest.leaf_count} != rebuilt ${leaves.length}`)
  }

  console.log(`  root.txt     ${rootFromFile ?? '(missing)'}`)
  console.log(`  recomputed   ${computed}  (${leaves.length} leaves, ${ALGORITHM})`)

  if (errors.length) {
    console.log('')
    for (const err of errors) console.log(`  - ${err}`)
    console.log('\nSNAPSHOT FAILED')
    return { ok: false, date, errors, manifest }
  }

  console.log('\nSNAPSHOT OK')
  return { ok: true, date, errors, manifest }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url

if (isMain) {
  main()
    .then((result) => {
      process.exitCode = result.ok ? 0 : 1
    })
    .catch((err) => {
      console.error('[verify] failed:', err?.stack || err)
      process.exitCode = 1
    })
}
