#!/usr/bin/env node
/**
 * scripts/apply-search-migration.js —— 应用 src/db/migrations/*.sql（检索功能深度迁移）
 *
 *   node scripts/apply-search-migration.js            # 应用未应用的迁移（幂等，可反复跑）
 *   node scripts/apply-search-migration.js --force    # 强制重跑（校验和变化后重放 DDL 用）
 *   node scripts/apply-search-migration.js --dry-run  # 只报告将做什么，不写库
 *   node scripts/apply-search-migration.js --verify   # 跳过 DDL，只跑验收（EXPLAIN/分面计时）
 *
 * 设计要点
 *   · 迁移文件自身幂等（IF NOT EXISTS / ON CONFLICT DO UPDATE），所以「重复执行」在两层都成立：
 *     本脚本靠 schema_migration 记账跳过；--force 时直接重放文件也不会报错。
 *   · 每个文件整文件执行（文件内自带 BEGIN/COMMIT），不在外层再包事务，避免嵌套事务警告。
 *   · 结束后做验收：扩展/索引/同义词表 + 三条样例句的 EXPLAIN + 分面聚合耗时。
 *
 * 不删库、不改 schema.sql、不影响运行中的服务（DDL 只加索引与表）。
 */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../src/db/client.js'
import {
  planSearch,
  buildHitQuery,
  buildFacetQuery,
  routes as searchRoutes,
} from '../src/api/search.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const MIGRATIONS_DIR = path.join(ROOT, 'src', 'db', 'migrations')

const argv = new Set(process.argv.slice(2))
const FORCE = argv.has('--force')
const DRY = argv.has('--dry-run')
const VERIFY_ONLY = argv.has('--verify')

const LOG = (s = '') => console.log(s)
const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0]

/** 验收用的三条样例句：单字 / 纯同义词命中 / 同义词 + 单字扩展 */
const SAMPLES = ['秦', '青霉素', '造纸']

/** 与 /api/search 一致：空计划时退回 trgm/LIKE 口径 */
async function specOf(q) {
  const spec = await planSearch(q)
  if (!spec.ftsGroups.length && !spec.patterns.length) {
    return { ftsGroups: [], patterns: [`%${String(q).trim()}%`], synonyms: [] }
  }
  return spec
}

/** 扫描迁移目录：按文件名排序（001-, 002- …） */
async function listMigrations() {
  let names = []
  try {
    names = (await readdir(MIGRATIONS_DIR)).filter((f) => f.toLowerCase().endsWith('.sql'))
  } catch (err) {
    if (err?.code === 'ENOENT') return []
    throw err
  }
  names.sort((a, b) => a.localeCompare(b, 'en'))
  const out = []
  for (const name of names) {
    const file = path.join(MIGRATIONS_DIR, name)
    const sql = await readFile(file, 'utf8')
    out.push({ name, file, sql, checksum: sha256(sql) })
  }
  return out
}

async function ensureBookkeeping() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      filename   TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
}

async function appliedMap() {
  const { rows } = await db.query(`SELECT filename, checksum, applied_at FROM schema_migration`)
  return new Map(rows.map((r) => [r.filename, r]))
}

// ---------------------------------------------------------------- 应用迁移

async function apply() {
  await ensureBookkeeping()
  const applied = await appliedMap()
  const files = await listMigrations()

  if (!files.length) {
    LOG('[migrate] 未找到迁移文件（src/db/migrations/*.sql）')
    return { applied: [], skipped: [] }
  }

  const done = []
  const skipped = []
  for (const f of files) {
    const prev = applied.get(f.name)
    if (prev && prev.checksum === f.checksum && !FORCE) {
      skipped.push(f.name)
      LOG(`[migrate] skip ${f.name}（已于 ${prev.applied_at.toISOString()} 应用）`)
      continue
    }
    if (prev && prev.checksum !== f.checksum) {
      LOG(`[migrate] ! ${f.name} 内容与已应用版本不同（${prev.checksum.slice(0, 8)} → ${f.checksum.slice(0, 8)}）`)
      if (!FORCE) {
        skipped.push(f.name)
        LOG('[migrate]   默认跳过；要重放请加 --force')
        continue
      }
    }
    if (DRY) {
      LOG(`[migrate] would apply ${f.name}（${Buffer.byteLength(f.sql, 'utf8')} bytes）`)
      continue
    }
    LOG(`[migrate] apply ${f.name} …`)
    const t0 = Date.now()
    try {
      await db.exec(f.sql)
    } catch (err) {
      console.error(`[migrate] FAILED ${f.name}: ${err.message}`)
      throw err
    }
    await db.query(
      `INSERT INTO schema_migration (filename, checksum) VALUES ($1, $2)
       ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
      [f.name, f.checksum],
    )
    done.push(f.name)
    LOG(`[migrate] ok ${f.name}（${Date.now() - t0} ms）`)
  }
  return { applied: done, skipped }
}

// ---------------------------------------------------------------- 验收

async function showExtensions() {
  const { rows } = await db.query(
    `SELECT extname, extversion FROM pg_extension ORDER BY 1`,
  )
  LOG('  extensions: ' + rows.map((r) => `${r.extname}@${r.extversion}`).join(', '))
}

async function showIndexes() {
  const { rows } = await db.query(
    `SELECT c.relname AS indexname,
            pg_size_pretty(pg_relation_size(c.oid)) AS size
       FROM pg_index x
       JOIN pg_class c ON c.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
      WHERE t.relname = 'event'
        AND t.relnamespace = 'public'::regnamespace
      ORDER BY c.relname`,
  )
  LOG(`  event indexes (${rows.length}):`)
  for (const r of rows) LOG(`    · ${r.indexname.padEnd(30)} ${r.size}`)
}

async function showSynonyms() {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n, sum(cardinality(expands))::int AS terms FROM search_synonym`,
  )
  LOG(`  search_synonym: ${rows[0].n} 组，共 ${rows[0].terms} 个扩展词`)
}

async function explain(label, sql, params) {
  const { rows } = await db.query(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${sql}`, params)
  const lines = rows.map((r) => r['QUERY PLAN'])
  const head = lines.filter((l) => /Scan|BitmapOr|Aggregate|Sort|Limit/.test(l)).slice(0, 6)
  LOG(`  EXPLAIN ${label}:`)
  for (const l of head) LOG('    ' + l.trim())
  return lines
}

async function verify() {
  const row = await one(`SELECT count(*)::int AS n FROM event`)
  LOG(`\n[verify] event 行数：${row.n}`)
  await showExtensions()
  await showIndexes()
  await showSynonyms()

  // 同义词表内容（供人工核对）
  const { rows: syn } = await db.query(`SELECT term, expands FROM search_synonym ORDER BY id`)
  LOG(`  \n  同义词（${syn.length} 组）：`)
  for (const s of syn) LOG(`    ${s.term} ↔ ${(s.expands || []).join(' / ')}`)

  // 三条样例句：单字（trgm 路径）、纯 FTS、带同义词扩展的 FTS
  LOG('\n[verify] 查询计划与结果（谓词由 src/api/search.js 的 planSearch/buildPredicate 生成，与 /api/search 同源）：')
  const handler = searchRoutes.find((r) => r[0] === 'GET' && r[1] === '/api/search')[2]

  for (const q of SAMPLES) {
    const spec = await specOf(q)
    LOG(`\n  ── q=${q}`)
    LOG(`     tsquery 组 : ${spec.ftsGroups.length ? spec.ftsGroups.join('  |  ') : '(无)'}`)
    LOG(`     ILIKE 模式 : ${spec.patterns.length ? spec.patterns.join(' , ') : '(无)'}`)
    LOG(`     同义词扩展 : ${spec.synonyms.length ? spec.synonyms.join(' / ') : '(无)'}`)

    const { sql, params } = buildHitQuery(spec, 20)
    await explain(`q=${q}（hits 形状：ORDER BY 年份 NULLS LAST LIMIT 60）`, sql, params)

    const res = await handler({ query: { q } })
    LOG(`     /api/search → total=${res.total}  synonyms=${JSON.stringify(res.synonyms)}`)
    LOG(
      `     hits  : ` +
        res.hits.slice(0, 3).map((h) => `${h.slug}(${h.score})`).join(', ') +
        (res.hits.length > 3 ? ' …' : ''),
    )
    LOG(
      `     facets: ` +
        ['track', 'category', 'discipline']
          .map((d) => `${d}=${(res.facets?.[d] ?? []).length} 项`)
          .join(' / ') +
        `  例 track=${JSON.stringify((res.facets?.track ?? []).slice(0, 3))}`,
    )
  }

  // 分面聚合的额外耗时：同一 WHERE、无 LIMIT 的全匹配聚合
  LOG('\n[verify] 分面聚合耗时（GROUPING SETS，口径与 hits 相同、无 LIMIT；n=10 取 p50）：')
  for (const q of SAMPLES) {
    const spec = await specOf(q)
    const { sql, params } = buildFacetQuery(spec)
    const times = []
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now()
      await db.query(sql, params)
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    const { rows } = await db.query(sql, params)
    LOG(
      `     q=${q}  分面 p50 = ${times[Math.floor(times.length / 2)].toFixed(3)} ms` +
        `  分组数=${rows.length}`,
    )
  }
}

// ---------------------------------------------------------------- main

LOG(`[migrate] 模式：${db.mode()}`)
try {
  if (!VERIFY_ONLY) {
    const { applied, skipped } = await apply()
    LOG(`\n[migrate] 本次应用 ${applied.length} 个，跳过 ${skipped.length} 个${DRY ? '（dry-run）' : ''}`)
  }
  if (!DRY) await verify()
} finally {
  await db.close()
}
