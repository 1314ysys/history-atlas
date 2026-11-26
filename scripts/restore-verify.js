#!/usr/bin/env node
/**
 * scripts/restore-verify.js —— 备份恢复演练 / 校验
 *
 *   node scripts/restore-verify.js               # 取最新一份备份
 *   node scripts/restore-verify.js --file=backups/history_atlas-20261124-230321.dump
 *   node scripts/restore-verify.js --keep-temp   # 保留临时库，便于手工进库查看
 *
 * 流程：
 *   1. 选最新备份 → 解压校验（gzip CRC + TOC + sha256）
 *   2. 建临时库 history_atlas_restore_check（先 DROP IF EXISTS ... WITH (FORCE)）
 *   3. 把归档灌进临时库
 *   4. 比对：
 *        - 关键表行数 event / event_claim / event_source（与原库一致）
 *        - 全部表行数（与备份 TOC 一致）
 *        - 每张表的行内容 md5（与原库逐表一致）
 *        - 表结构指纹（列/索引/约束，与原库一致）
 *        - 抽一条事件做字段级比对（title / t_start_year / summary / 关联行数）
 *   5. 无论成功失败都 DROP 临时库，输出 PASS / FAIL 与退出码
 *
 * 安全边界：只操作 history_atlas_restore_check，绝不 DROP / 写入 history_atlas。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import {
  BACKUP_DIR,
  ROOT,
  connParts,
  dbUrl,
  findBinary,
  formatBytes,
  listBackups,
  qi,
  readBackup,
  urlForDatabase,
} from './backup.js'

const TEMP_DB = 'history_atlas_restore_check'
const REQUIRED_TABLES = ['event', 'event_claim', 'event_source']

/* ------------------------------------------------------------------ *
 * 事实采集
 * ------------------------------------------------------------------ */

/**
 * @param {pg.Client} client
 * @returns {Promise<string[]>}
 */
async function listTables(client) {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  )
  return rows.map((r) => r.table_name)
}

/**
 * 每张表的行数 + 行内容 md5（按 t::text 排序，完全确定，与行物理顺序无关）。
 * @param {pg.Client} client
 * @param {string[]} tables
 */
async function tableFacts(client, tables) {
  /** @type {Record<string, {rows:number, md5:string}>} */
  const out = {}
  for (const t of tables) {
    const { rows } = await client.query(
      `SELECT count(*)::bigint AS n,
              md5(coalesce(string_agg(x::text, E'\n' ORDER BY x::text), '')) AS h
         FROM ${qi(t)} x`,
    )
    out[t] = { rows: Number(rows[0].n), md5: rows[0].h }
  }
  return out
}

/**
 * 结构指纹：列定义 / 索引定义 / 约束定义（不含 NOT NULL 约束，列级 NOT NULL 已在列定义里）。
 * @param {pg.Client} client
 */
async function catalogFingerprint(client) {
  const columns = (
    await client.query(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable,
              coalesce(column_default, '') AS column_default,
              is_generated, coalesce(generation_expression, '') AS generation_expression,
              coalesce(character_maximum_length, -1) AS max_len
         FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position`,
    )
  ).rows

  const indexes = (
    await client.query(
      `SELECT indexname, regexp_replace(indexdef, '\\s+', ' ', 'g') AS def
         FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`,
    )
  ).rows

  const constraints = (
    await client.query(
      `SELECT conrelid::regclass::text AS tbl, conname, contype,
              regexp_replace(pg_get_constraintdef(oid), '\\s+', ' ', 'g') AS def
         FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace AND contype <> 'n'
        ORDER BY 1, 2`,
    )
  ).rows

  const canonical = JSON.stringify({ columns, indexes, constraints })
  return {
    md5: createHash('md5').update(canonical).digest('hex'),
    columns: columns.length,
    indexes: indexes.length,
    constraints: constraints.length,
    detail: { columns, indexes, constraints },
  }
}

/**
 * 抽样一条事件（取“引用史料最多”的那条，信息量最大），做字段级比对。
 * @param {pg.Client} client
 */
async function sampleEvent(client) {
  const { rows } = await client.query(
    `SELECT e.id,
            e.slug,
            e.title,
            e.t_start_year,
            e.t_end_year,
            e.track,
            e.category,
            e.status::text AS status,
            e.t_precision::text AS t_precision,
            e.t_certainty::text AS t_certainty,
            e.rev,
            e.created_at,
            md5(coalesce(e.summary, '')) AS summary_md5,
            md5(e.t_span::text) AS span_md5,
            (SELECT count(*)::int FROM event_claim c WHERE c.event_id = e.id) AS claims,
            (SELECT count(*)::int FROM event_source s WHERE s.event_id = e.id) AS sources,
            (SELECT md5(coalesce(string_agg(c2::text, E'\n' ORDER BY c2::text), ''))
               FROM event_claim c2 WHERE c2.event_id = e.id) AS claims_md5,
            (SELECT md5(coalesce(string_agg(s2::text, E'\n' ORDER BY s2::text), ''))
               FROM event_source s2 WHERE s2.event_id = e.id) AS sources_md5
       FROM event e
      ORDER BY (SELECT count(*) FROM event_source s3 WHERE s3.event_id = e.id) DESC, e.id ASC
      LIMIT 1`,
  )
  return rows[0] || null
}

/**
 * @param {pg.Client} client
 * @returns {Promise<Record<string, number>>}
 */
async function countsOf(client) {
  const tables = await listTables(client)
  const facts = await tableFacts(client, tables)
  /** @type {Record<string, number>} */
  const out = {}
  for (const [t, f] of Object.entries(facts)) out[t] = f.rows
  return out
}

/* ------------------------------------------------------------------ *
 * 临时库
 * ------------------------------------------------------------------ */

function assertSafeDbName(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe database name "${name}"`)
  if (name === connParts().database) throw new Error(`refusing to use the source database "${name}" as the temp target`)
}

/** @param {pg.Client} admin @param {string} name */
async function dropDatabase(admin, name) {
  assertSafeDbName(name)
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name])
  await admin.query(`DROP DATABASE IF EXISTS ${qi(name)} WITH (FORCE)`)
}

/**
 * @param {pg.Client} admin @param {string} name
 */
async function createDatabase(admin, name) {
  assertSafeDbName(name)
  await admin.query(`CREATE DATABASE ${qi(name)} TEMPLATE template0 ENCODING 'UTF8'`)
}

/* ------------------------------------------------------------------ *
 * 恢复
 * ------------------------------------------------------------------ */

/**
 * 把归档灌进临时库。
 * @param {{file:string, meta:any, text?:string}} archive
 * @param {string} tempUrl
 * @param {pg.Client} temp
 */
async function restoreArchive(archive, tempUrl, temp) {
  const started = Date.now()
  if (archive.meta.format === 'logical-sql-gzip') {
    // 整份 SQL（SET ... BEGIN ... COMMIT）用简单查询协议一次执行
    await temp.query(archive.text)
    return { elapsedMs: Date.now() - started, statements: archive.meta.statements ?? null, method: 'sql replay' }
  }
  if (archive.meta.format === 'pg_dump-custom') {
    const pgRestore = findBinary('pg_restore')
    if (!pgRestore) throw new Error('archive is pg_dump custom format but pg_restore is not available')
    const conn = connParts(tempUrl)
    const r = spawnSync(
      pgRestore,
      ['-d', tempUrl, '--no-owner', '--no-privileges', '--exit-on-error', archive.file],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PGHOST: conn.host,
          PGPORT: String(conn.port),
          PGUSER: conn.user,
          PGDATABASE: conn.database,
          ...(conn.password ? { PGPASSWORD: conn.password } : {}),
        },
      },
    )
    if (r.status !== 0) throw new Error(`pg_restore failed (${r.status}): ${(r.stderr || r.stdout || '').trim()}`)
    return { elapsedMs: Date.now() - started, statements: archive.meta.entries ?? null, method: 'pg_restore' }
  }
  throw new Error(`unknown archive format "${archive.meta.format}"`)
}

/* ------------------------------------------------------------------ *
 * 比对
 * ------------------------------------------------------------------ */

/**
 * @param {any} opts
 */
async function run(opts = {}) {
  const argv = process.argv.slice(2)
  const flag = (name, fallback) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`))
    return hit ? hit.slice(name.length + 3) : fallback
  }
  const dir = opts.dir || flag('dir', BACKUP_DIR)
  const keepTemp = opts.keepTemp ?? argv.includes('--keep-temp')
  const tempDb = opts.tempDb || flag('temp-db', TEMP_DB)
  const explicit = opts.file || flag('file')
  assertSafeDbName(tempDb)

  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []

  // ---- 1. 选备份 ----
  let entry
  if (explicit) {
    const path = explicit.startsWith('/') || /^[A-Za-z]:/.test(explicit) ? explicit : `${ROOT}/${explicit}`
    entry = { file: path, name: path.split(/[/\\]/).pop() }
  } else {
    const all = await listBackups(dir)
    if (!all.length) throw new Error(`no backups in ${dir}; run node scripts/backup.js first`)
    entry = all[0]
  }

  const archive = await readBackup(entry.file)
  const { meta, check, text } = archive
  console.log(`[verify] archive   ${entry.name}  ${formatBytes((meta.bytes ?? text.length))}`)
  if (!check.ok) {
    errors.push(...check.errors.map((e) => `archive: ${e}`))
  } else {
    console.log(
      `[verify] archive   readable: gzip CRC + TOC OK, ${Object.keys(meta.tables || {}).length} tables / ${meta.statements} statements` +
        `${meta.sha256 ? `, sha256 ${String(meta.sha256).slice(0, 12)}…` : ''}`,
    )
  }

  const manifestCounts = /** @type {Record<string, number>} */ (meta.tables || {})

  // ---- 2. 原库事实 ----
  const srcUrl = dbUrl()
  const srcName = connParts(srcUrl).database
  const src = new pg.Client({ connectionString: srcUrl, statement_timeout: 60_000 })
  await src.connect()
  let temp = null
  const admin = new pg.Client({ connectionString: urlForDatabase('postgres', srcUrl), statement_timeout: 60_000 })

  try {
    await admin.connect()

    const srcTables = await listTables(src)
    const srcFacts = await tableFacts(src, srcTables)
    const srcFingerprint = await catalogFingerprint(src)
    const srcSample = await sampleEvent(src)
    const liveCounts = Object.fromEntries(Object.entries(srcFacts).map(([t, f]) => [t, f.rows]))
    console.log(
      `[verify] source    ${srcName}  ${srcTables.length} tables / ${Object.values(liveCounts).reduce((a, b) => a + b, 0)} rows`,
    )

    // ---- 3. 建临时库 ----
    await dropDatabase(admin, tempDb)
    await createDatabase(admin, tempDb)
    console.log(`[verify] temp      ${tempDb} created`)

    temp = new pg.Client({ connectionString: urlForDatabase(tempDb, srcUrl), statement_timeout: 0 })
    await temp.connect()

    // ---- 4. 恢复 ----
    const restored = await restoreArchive({ ...archive, text }, urlForDatabase(tempDb, srcUrl), temp)
    console.log(
      `[verify] restore   ${restored.method}: ${restored.statements ?? '?'} statements in ${restored.elapsedMs} ms`,
    )

    // ---- 5. 临时库事实 ----
    const dstTables = await listTables(temp)
    const dstFacts = await tableFacts(temp, dstTables)
    const dstFingerprint = await catalogFingerprint(temp)
    const dstSample = await sampleEvent(temp)

    // ---- 6. 关键表行数 ----
    for (const t of REQUIRED_TABLES) {
      const want = manifestCounts[t]
      const got = dstFacts[t]?.rows
      const live = liveCounts[t]
      const expected = want ?? live
      const ok = got === expected
      console.log(
        `[verify] rows      ${t.padEnd(13)} restored ${String(got ?? 'MISSING').padStart(5)}  ` +
          `manifest ${String(want ?? 'n/a').padStart(5)}  live ${String(live ?? 'n/a').padStart(5)}  ${ok ? 'OK' : 'MISMATCH'}`,
      )
      if (got === undefined) errors.push(`required table ${t} missing after restore`)
      else if (got !== expected) errors.push(`table ${t}: restored ${got} rows, expected ${expected}`)
    }

    // ---- 7. 全表行数 vs TOC ----
    const missing = Object.keys(manifestCounts).filter((t) => dstFacts[t] === undefined)
    if (missing.length) errors.push(`tables in backup but missing after restore: ${missing.join(', ')}`)
    const countDiffs = Object.keys(manifestCounts).filter(
      (t) => dstFacts[t] !== undefined && dstFacts[t].rows !== manifestCounts[t],
    )
    for (const t of countDiffs) {
      errors.push(`table ${t}: restored ${dstFacts[t].rows} rows, backup TOC says ${manifestCounts[t]}`)
    }
    console.log(
      `[verify] counts    ${Object.keys(manifestCounts).length - countDiffs.length - missing.length}/` +
        `${Object.keys(manifestCounts).length} tables match backup TOC`,
    )

    // ---- 8. 内容 md5 vs 原库 ----
    const shared = Object.keys(srcFacts).filter((t) => dstFacts[t])
    const contentDiffs = shared.filter((t) => dstFacts[t].md5 !== srcFacts[t].md5)
    const onlyInSource = Object.keys(srcFacts).filter((t) => !dstFacts[t])
    console.log(
      `[verify] content   ${shared.length - contentDiffs.length}/${shared.length} tables have identical row-content md5`,
    )

    // ---- 9. 结构指纹 ----
    const schemaEqual =
      srcFingerprint.md5 === dstFingerprint.md5 &&
      srcFingerprint.columns === dstFingerprint.columns &&
      srcFingerprint.indexes === dstFingerprint.indexes &&
      srcFingerprint.constraints === dstFingerprint.constraints
    console.log(
      `[verify] schema    columns ${dstFingerprint.columns}/${srcFingerprint.columns}, ` +
        `indexes ${dstFingerprint.indexes}/${srcFingerprint.indexes}, ` +
        `constraints ${dstFingerprint.constraints}/${srcFingerprint.constraints} ${schemaEqual ? 'OK' : 'DIFF'}`,
    )

    // ---- 10. 抽样事件字段级比对 ----
    if (!srcSample || !dstSample) {
      errors.push('sample event could not be read from one of the databases')
    } else {
      const fields = ['id', 'slug', 'title', 't_start_year', 't_end_year', 'track', 'category', 'status',
        't_precision', 't_certainty', 'rev', 'summary_md5', 'span_md5', 'claims', 'sources', 'claims_md5', 'sources_md5']
      const fieldDiffs = fields.filter((f) => String(srcSample[f]) !== String(dstSample[f]))
      if (String(srcSample.created_at) !== String(dstSample.created_at)) fieldDiffs.push('created_at')
      console.log(
        `[verify] sample    #${dstSample.id} ${dstSample.slug} "${dstSample.title}" ` +
          `t_start_year ${dstSample.t_start_year} ${fieldDiffs.length ? `DIFF ${fieldDiffs.join(',')}` : 'OK'}`,
      )
      for (const f of fieldDiffs) {
        const msg = `sample event field ${f}: restored ${JSON.stringify(dstSample[f])} != source ${JSON.stringify(srcSample[f])}`
        // 备份之后原库若被别的进程改过，内容差异属于预期漂移
        if (contentDiffs.length) warnings.push(msg)
        else errors.push(msg)
      }
    }

    // ---- 11. 区分“真错误”和“备份后原库发生变化” ----
    const liveMatchesManifest = Object.keys(manifestCounts).every((t) => liveCounts[t] === manifestCounts[t])
    if (contentDiffs.length || onlyInSource.length || !schemaEqual) {
      if (liveMatchesManifest) {
        for (const t of contentDiffs) {
          errors.push(`table ${t}: restored row content differs from source (row counts are equal)`)
        }
        for (const t of onlyInSource) errors.push(`table ${t} exists in source but not in backup`)
        if (!schemaEqual) errors.push('restored schema fingerprint differs from source')
      } else {
        const diffs = Object.keys(manifestCounts).filter((t) => liveCounts[t] !== manifestCounts[t])
        warnings.push(
          `source changed after the backup (tables differing from TOC: ${diffs.slice(0, 8).join(', ')}` +
            `${diffs.length > 8 ? ', …' : ''}); content/schema comparison limited to the backup TOC`,
        )
        for (const t of contentDiffs) {
          warnings.push(`table ${t}: restored content differs from the (newer) live source`)
        }
      }
    }
  } finally {
    if (temp) await temp.end().catch(() => {})
    // ---- 12. 清理临时库 ----
    try {
      if (keepTemp) {
        console.log(`[verify] temp      kept for inspection: ${tempDb}`)
      } else {
        await dropDatabase(admin, tempDb)
        console.log(`[verify] temp      ${tempDb} dropped`)
      }
    } catch (err) {
      warnings.push(`could not drop ${tempDb}: ${err.message}`)
    }
    await admin.end().catch(() => {})
    await src.end().catch(() => {})
  }

  for (const w of warnings) console.log(`[verify] WARN      ${w}`)
  for (const e of errors) console.log(`[verify] ERROR     ${e}`)

  const ok = errors.length === 0
  console.log('')
  console.log(ok ? (warnings.length ? 'PASS (with drift warnings)' : 'PASS') : 'FAIL')
  return { ok, errors, warnings }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url

if (isMain) {
  run()
    .then((r) => {
      process.exitCode = r.ok ? 0 : 1
    })
    .catch((err) => {
      console.error('[verify] FAILED:', err?.message || err)
      process.exitCode = 1
    })
}
