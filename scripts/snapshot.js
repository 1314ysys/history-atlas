import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { db } from '../src/db/client.js'
import { sha256hex } from '../src/archive/store.js'
import { merkleRoot, ALGORITHM } from '../src/archive/merkle.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** 快照根目录：默认 <root>/snapshots，可用 SNAPSHOT_DIR 覆盖（演练/测试不污染仓库） */
export const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || path.join(ROOT, 'snapshots')

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const EVENT_SQL = `SELECT id, slug, title, track, category, discipline,
         t_start_year, t_start_month, t_start_day,
         t_end_year, t_end_month, t_end_day,
         t_precision, t_certainty, place_slug, lat, lon, summary, status, rev, created_at
    FROM event
   ORDER BY id`

const CLAIM_SQL = `SELECT c.id, c.event_id, e.slug AS event_slug, c.statement, c.evidence_level,
         c.confidence, c.disputed_group, c.adopted, c.rationale, c.sort_order
    FROM event_claim c
    JOIN event e ON e.id = c.event_id
   ORDER BY c.id`

const SOURCE_SQL = `SELECT s.id, s.event_id, e.slug AS event_slug, s.claim_id, s.source_slug,
         s.locator, s.quote, s.quote_sha256, s.verified_status, s.verified_at
    FROM event_source s
    JOIN event e ON e.id = s.event_id
   ORDER BY s.id`

// ---------------------------------------------------------------- 序列化

/**
 * 把数据库行转成可 JSON 化的普通对象（Date → ISO，BigInt → Number，undefined → null）。
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
export function jsonSafe(row) {
  /** @type {Record<string, any>} */
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'bigint') out[key] = Number(value)
    else if (value instanceof Date) out[key] = value.toISOString()
    else out[key] = value ?? null
  }
  return out
}

/** @param {Record<string, any>[]} rows @returns {string} JSONL（每行一个对象，末行带换行） */
export function toJsonl(rows) {
  if (!rows.length) return ''
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
}

// ---------------------------------------------------------------- 压缩

/**
 * 压缩 JSONL：优先 zstd（Node 22.15+），缺失时回退 brotli。
 * @param {string} text
 * @returns {{ data: Buffer, ext: '.zst'|'.br', codec: 'zstd'|'brotli' }}
 */
export function compressJsonl(text) {
  const buf = Buffer.from(text, 'utf8')
  if (typeof zlib.zstdCompressSync === 'function') {
    return { data: zlib.zstdCompressSync(buf), ext: '.zst', codec: 'zstd' }
  }
  return { data: zlib.brotliCompressSync(buf), ext: '.br', codec: 'brotli' }
}

/**
 * 按扩展名解压（.zst / .br / 明文 .jsonl）。
 * @param {Buffer} buffer
 * @param {string} ext 形如 '.zst'
 * @returns {string}
 */
export function decompressJsonl(buffer, ext) {
  const e = String(ext || '').toLowerCase()
  if (e === '.zst') return zlib.zstdDecompressSync(buffer).toString('utf8')
  if (e === '.br') return zlib.brotliDecompressSync(buffer).toString('utf8')
  if (e === '.jsonl' || e === '') return buffer.toString('utf8')
  throw new Error(`unknown compression extension: ${ext}`)
}

/** @param {string} name 形如 'events.jsonl.zst' @returns {string} 压缩扩展名（'.zst'/'.br'/''） */
export function compressionExtOf(name) {
  const ext = path.extname(String(name)).toLowerCase()
  return ext === '.zst' || ext === '.br' ? ext : ''
}

// ---------------------------------------------------------------- Merkle 叶子

/**
 * 单条史料引用的叶子：sha256(event_slug | claim_id | source_slug | quote_sha256)。
 * 空值一律当空串（与 spec §8 的拼接规则一致）。
 *
 * 注意：返回的是「叶子内容」（已是 64 位 hex）；merkleRoot 会按自身规则
 * 再对每个内容取一次 sha256 后配对，写入 MANIFEST 的 merkle_root 即该结果。
 * @param {{ event_slug?: string, claim_id?: number|string|null, source_slug?: string, quote_sha256?: string|null }} row
 * @returns {string} 小写 hex
 */
export function sourceLeaf(row) {
  const parts = [
    row.event_slug ?? '',
    row.claim_id ?? '',
    row.source_slug ?? '',
    row.quote_sha256 ?? '',
  ]
  return sha256hex(parts.join('|'))
}

/**
 * 重建 Merkle 叶子列表：有 event_source 用它，否则退化为 event slug 列表。
 * @param {{ events?: Record<string, any>[], sources?: Record<string, any>[] }} data
 * @returns {string[]}
 */
export function buildLeaves({ events = [], sources = [] } = {}) {
  if (sources.length > 0) return sources.map(sourceLeaf)
  return events.map((row) => String(row.slug))
}

// ---------------------------------------------------------------- 数据读取

/** 表缺失（未 migrate / 未 seed）时按空表处理，其余错误照常抛出 */
async function queryOrEmpty(sql) {
  try {
    const { rows } = await db.query(sql)
    return rows
  } catch (err) {
    if (err?.code === '42P01') {
      console.warn(`[snapshot] table missing, treating as empty: ${err.message}`)
      return []
    }
    throw err
  }
}

async function readSchemaVersion() {
  try {
    const { rows } = await db.query(`SELECT value FROM _meta WHERE key = $1`, ['schema_version'])
    return rows[0]?.value ?? '1'
  } catch {
    return '1'
  }
}

/**
 * 解析快照日期：--date=YYYY-MM-DD / 位置参数 / SNAPSHOT_DATE，默认当天（UTC）。
 * @param {string[]} argv
 * @returns {string}
 */
export function resolveDate(argv = []) {
  const flag = argv.find((arg) => arg.startsWith('--date='))
  const bare = argv.find((arg) => DATE_RE.test(arg))
  const raw = flag ? flag.slice('--date='.length) : (bare || process.env.SNAPSHOT_DATE || '')
  if (!raw) return new Date().toISOString().slice(0, 10)
  if (!DATE_RE.test(raw)) throw new Error(`invalid date "${raw}", expected YYYY-MM-DD`)
  return raw
}

// ---------------------------------------------------------------- 主流程

/**
 * 生成一份快照并写盘。
 * @param {string[]} [argv]
 * @returns {Promise<{dir:string, manifest:Record<string, any>, latest:Record<string, any>}>}
 */
export async function main(argv = process.argv.slice(2)) {
  const startedAt = Date.now()
  const date = resolveDate(argv)

  const events = (await queryOrEmpty(EVENT_SQL)).map(jsonSafe)
  const claims = (await queryOrEmpty(CLAIM_SQL)).map(jsonSafe)
  const sources = (await queryOrEmpty(SOURCE_SQL)).map(jsonSafe)
  const schemaVersion = await readSchemaVersion()

  const leaves = buildLeaves({ events, sources })
  const root = merkleRoot(leaves)

  const dir = path.join(SNAPSHOT_DIR, date)
  await mkdir(dir, { recursive: true })

  /** @type {{ name: string, sha256: string, bytes: number }[]} */
  const files = []
  let compression = null

  for (const [base, rows] of [['events', events], ['claims', claims], ['sources', sources]]) {
    const { data, ext, codec } = compressJsonl(toJsonl(rows))
    compression = codec
    const name = `${base}.jsonl${ext}`
    await writeFile(path.join(dir, name), data)
    files.push({ name, sha256: sha256hex(data), bytes: data.length })
  }

  const manifest = {
    date,
    generated_at: new Date().toISOString(),
    schema_version: schemaVersion,
    counts: { events: events.length, claims: claims.length, sources: sources.length },
    files,
    merkle_root: root,
    leaf_count: leaves.length,
    algorithm: ALGORITHM,
    compression,
  }

  await writeFile(path.join(dir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(path.join(dir, 'root.txt'), `${root}\n`)

  const latest = { date, root, manifest_url: `/snapshots/${date}/MANIFEST.json` }
  await writeFile(path.join(SNAPSHOT_DIR, 'latest.json'), JSON.stringify(latest, null, 2) + '\n')

  const relDir = path.relative(ROOT, dir) || dir
  console.log(`\n[snapshot] ${date} -> ${relDir}  (compression: ${compression})`)
  for (const file of files) {
    const rows = file.name.startsWith('events')
      ? events.length
      : file.name.startsWith('claims')
        ? claims.length
        : sources.length
    console.log(`  ${file.name.padEnd(18)} ${String(rows).padStart(6)} rows  ` +
      `${String(file.bytes).padStart(8)} bytes  sha256 ${file.sha256.slice(0, 16)}…`)
  }
  console.log(`  counts: events=${events.length} claims=${claims.length} sources=${sources.length}`)
  console.log(`  merkle_root: ${root}`)
  console.log(`  leaf_count:  ${leaves.length}  (${ALGORITHM})`)
  console.log(`  latest.json: ${JSON.stringify(latest)}`)
  console.log(`[snapshot] done in ${Date.now() - startedAt}ms\n`)

  return { dir, manifest, latest }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url

if (isMain) {
  main()
    .then(async () => {
      process.exitCode = 0
      await db.close()
    })
    .catch(async (err) => {
      console.error('[snapshot] failed:', err?.stack || err)
      process.exitCode = 1
      await db.close().catch(() => {})
    })
}
