#!/usr/bin/env node
/**
 * scripts/backup.js —— history_atlas 逻辑备份 + 归档可读性校验 + 保留策略
 *
 * 用法：
 *   node scripts/backup.js                 # 自动选择引擎
 *   node scripts/backup.js --keep=7        # 覆盖保留份数
 *   node scripts/backup.js --engine=logical|pg_dump
 *
 * 引擎：
 *   1) pg_dump（规范首选）：pg_dump -Fc -Z 6 -f backups/history_atlas-<yyyymmdd-HHmmss>.dump -d history_atlas
 *      备份后立即 pg_restore -l <file> 校验归档可读。
 *   2) logical（本机实际使用的回退路径）：本机 @embedded-postgres/windows-x64 只带了
 *      initdb/pg_ctl/postgres（无 pg_dump / pg_restore / psql），因此用 pg 驱动从
 *      catalog 重建 DDL + 逐表数据，生成 gzip(level=6) 的纯 SQL 归档：
 *        - 可直接用 psql 恢复（SET/BEGIN/CREATE TYPE/SEQUENCE/TABLE/INSERT/ALTER/CREATE INDEX/COMMIT）
 *        - 自带 TOC（表 → 行数）与 -- atlas:dump:end 结束标记，可离线校验
 *        - 落盘后重新读回、解压（校验 gzip CRC）、比对 TOC 行数与 sha256
 *
 * 两种引擎产生同名文件；格式记录在同级 <file>.meta.json 里（restore-verify.js 据此选择恢复方式）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import pg from 'pg'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')

export const DEFAULT_DB = 'history_atlas'
export const BACKUP_DIR = process.env.BACKUP_DIR || path.join(ROOT, 'backups')
export const KEEP = Number(process.env.BACKUP_KEEP || 7)
export const GZIP_LEVEL = 6
export const DUMP_VERSION = 1
export const DUMP_MAGIC = 'atlas-logical-dump'
export const SECTION_MARK = '-- atlas:section:'
export const TABLE_MARK = '-- atlas:table:'
export const TOC_MARK = '-- atlas:toc: '
export const END_MARK = '-- atlas:dump:end'
const NAME_RE = /^history_atlas-(\d{8}-\d{6})\.dump$/

/* ------------------------------------------------------------------ *
 * 连接 / 二进制发现
 * ------------------------------------------------------------------ */

export function dbUrl() {
  return (
    process.env.DATABASE_URL ||
    `postgres://postgres@127.0.0.1:${process.env.PGPORT || 5433}/${DEFAULT_DB}`
  )
}

/** @param {string} [url] */
export function connParts(url = dbUrl()) {
  const u = new URL(url)
  return {
    user: decodeURIComponent(u.username || 'postgres'),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    host: u.hostname || '127.0.0.1',
    port: Number(u.port || 5433),
    database: decodeURIComponent((u.pathname || '').replace(/^\//, '') || DEFAULT_DB),
  }
}

/**
 * 同实例上指向另一个库的连接串（建/删临时库用）。
 * @param {string} database @param {string} [url]
 */
export function urlForDatabase(database, url = dbUrl()) {
  const p = connParts(url)
  const auth = p.password ? `${encodeURIComponent(p.user)}:${encodeURIComponent(p.password)}` : encodeURIComponent(p.user)
  return `postgres://${auth}@${p.host}:${p.port}/${encodeURIComponent(database)}`
}

/** 本机可能藏 pg_dump 的地方 */
const BIN_DIRS = [
  path.join(ROOT, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin'),
  path.join(ROOT, 'node_modules', '@embedded-postgres', 'linux-x64', 'native', 'bin'),
  'C:\\Program Files\\PostgreSQL\\19\\bin',
  'C:\\Program Files\\PostgreSQL\\18\\bin',
  'C:\\Program Files\\PostgreSQL\\17\\bin',
  '/usr/lib/postgresql/19/bin',
  '/usr/local/bin',
]

/**
 * 找 pg_dump / pg_restore / psql，找不到返回 null。
 * 顺序：显式环境变量（PG_DUMP/PG_RESTORE）> 本机已知目录 > PATH。
 * @param {'pg_dump'|'pg_restore'|'psql'} name
 * @returns {string|null}
 */
export function findBinary(name) {
  /** @type {Record<string,string|undefined>} */
  const envMap = { pg_dump: process.env.PG_DUMP, pg_restore: process.env.PG_RESTORE, psql: process.env.PSQL }
  const fromEnv = envMap[name]
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const exe = process.platform === 'win32' ? `${name}.exe` : name
  for (const dir of BIN_DIRS) {
    const p = path.join(dir, exe)
    if (existsSync(p)) return p
    const plain = path.join(dir, name)
    if (existsSync(plain)) return plain
  }
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' })
  if (which.status === 0) {
    const first = (which.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0]
    if (first && existsSync(first)) return first
  }
  return null
}

/* ------------------------------------------------------------------ *
 * SQL 字面量
 * ------------------------------------------------------------------ */

export const qi = (ident) => `"${String(ident).replace(/"/g, '""')}"`

/**
 * 解析 PostgreSQL 文本数组字面量 `{a,"b c"}`（pg 驱动对 name[] 之类不认识的类型会原样返回字符串）。
 * @param {unknown} value
 * @returns {string[]}
 */
export function parsePgTextArray(value) {
  if (Array.isArray(value)) return value.map(String)
  const s = String(value ?? '')
  if (!s.startsWith('{') || !s.endsWith('}')) return s ? [s] : []
  const body = s.slice(1, -1)
  if (!body) return []
  /** @type {string[]} */
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quoted) {
      if (ch === '\\') {
        cur += body[++i] ?? ''
      } else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/**
 * 生成单行的 SQL 字符串字面量。
 * 普通文本用 '...'（standard_conforming_strings=on，只需把 ' 双写）；
 * 含反斜杠/换行/控制字符时改 E'...'，把换行等转义掉 —— 这样每条 INSERT 都只占一行，
 * 归档可以按行安全地扫描 TOC 与结束标记。
 * @param {string} value
 */
export function sqlLiteral(value) {
  const s = String(value)
  if (!/[\\\u0000-\u001f\u007f]/.test(s)) return `'${s.replace(/'/g, "''")}'`
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '\\') out += '\\\\'
    else if (ch === "'") out += "''"
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f) out += '\\' + code.toString(8).padStart(3, '0')
    else out += ch
  }
  return `E'${out}'`
}

export function formatBytes(n) {
  const v = Number(n || 0)
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / 1024 / 1024).toFixed(2)} MB`
}

/** history_atlas-20261124-230512.dump */
export function dumpFileName(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const stamp =
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  return `history_atlas-${stamp}.dump`
}

/* ------------------------------------------------------------------ *
 * catalog 读取（生成 DDL 用）
 * ------------------------------------------------------------------ */

/** @param {pg.Client} client */
async function readCatalog(client) {
  const tables = (
    await client.query(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
    )
  ).rows.map((r) => r.name)

  const enums = (
    await client.query(
      `SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
        GROUP BY t.typname ORDER BY t.typname`,
    )
  ).rows.map((r) => ({ name: r.name, labels: parsePgTextArray(r.labels) }))

  const columns = (
    await client.query(
      `SELECT c.relname AS table_name,
              a.attname AS column_name,
              format_type(a.atttypid, a.atttypmod) AS col_type,
              a.attnotnull AS not_null,
              a.attgenerated AS generated,
              a.attidentity AS identity,
              pg_get_expr(d.adbin, d.adrelid) AS default_expr,
              a.attnum
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY c.relname, a.attnum`,
    )
  ).rows

  const sequences = (
    await client.query(
      `SELECT sequencename AS name, data_type, start_value, min_value, max_value,
              increment_by, cycle, cache_size
         FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename`,
    )
  ).rows

  const constraints = (
    await client.query(
      `SELECT c.relname AS "table", con.conname AS name, con.contype AS contype,
              pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
        WHERE con.connamespace = 'public'::regnamespace
          AND con.contype IN ('p', 'u', 'c', 'f')
        ORDER BY c.relname, con.conname`,
    )
  ).rows

  // 只取“不是由约束自动创建”的索引（pkey / unique 已经由约束负责）
  const indexes = (
    await client.query(
      `SELECT i.relname AS name, t.relname AS "table", pg_get_indexdef(x.indexrelid) AS def
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_class t ON t.oid = x.indrelid
         JOIN pg_namespace n ON n.oid = i.relnamespace
        WHERE n.nspname = 'public'
          AND NOT EXISTS (
                SELECT 1 FROM pg_constraint con
                 WHERE con.conindid = x.indexrelid AND con.contype IN ('p', 'u', 'x'))
        ORDER BY i.relname`,
    )
  ).rows

  // serial 列 → 序列，用于恢复后校正 nextval
  const serialColumns = (
    await client.query(
      `SELECT c.relname AS table_name, a.attname AS column_name,
              pg_get_serial_sequence(quote_ident(c.relname), a.attname) AS seq
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
          AND pg_get_serial_sequence(quote_ident(c.relname), a.attname) IS NOT NULL
        ORDER BY c.relname, a.attnum`,
    )
  ).rows

  // 扩展（pg_trgm 提供 gin_trgm_ops 等操作符类；不先建扩展，恢复时 CREATE INDEX 会报
  // operator class "gin_trgm_ops" does not exist）
  const extensions = (
    await client.query(
      `SELECT e.extname AS name, n.nspname AS schema, e.extversion AS version
         FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname <> 'plpgsql'
        ORDER BY e.extname`,
    )
  ).rows

  return { tables, enums, columns, sequences, constraints, indexes, serialColumns, extensions }
}

/** @param {any} c */
function columnDdl(c) {
  const bits = [`${qi(c.column_name)} ${c.col_type}`]
  if (c.generated === 's') bits.push(`GENERATED ALWAYS AS (${c.default_expr}) STORED`)
  else if (c.identity === 'a') bits.push('GENERATED ALWAYS AS IDENTITY')
  else if (c.identity === 'd') bits.push('GENERATED BY DEFAULT AS IDENTITY')
  else if (c.default_expr) bits.push(`DEFAULT ${c.default_expr}`)
  if (c.not_null) bits.push('NOT NULL')
  return bits.join(' ')
}

const CONST_ORDER = { u: 1, c: 2, f: 3 }

/* ------------------------------------------------------------------ *
 * 逻辑 dump
 * ------------------------------------------------------------------ */

/**
 * 生成逻辑备份的 SQL 文本。
 * @param {pg.Client} client
 * @param {{db?: string}} [opts]
 * @returns {Promise<{text:string, toc:any, meta:any}>}
 */
export async function dumpLogical(client, { db = DEFAULT_DB } = {}) {
  const created_at = new Date().toISOString()
  const serverVersion = (await client.query(`SELECT current_setting('server_version') AS v`)).rows[0].v
  const cat = await readCatalog(client)

  /** @type {string[]} */
  const lines = []
  /** @type {Record<string, number>} */
  const tocTables = {}
  let statements = 0
  let rowCount = 0

  lines.push(
    `-- ${DUMP_MAGIC} v${DUMP_VERSION}`,
    '-- generated-by: history-atlas/scripts/backup.js',
    `-- created-at: ${created_at}`,
    `-- database: ${db}`,
    `-- server-version: ${serverVersion}`,
    `-- format: plain SQL, gzip level ${GZIP_LEVEL}`,
    '-- restore: gunzip -c <file> | psql -d <target>   或   node scripts/restore-verify.js',
    '',
    "SET client_encoding = 'UTF8';",
    'SET standard_conforming_strings = on;',
    'SET statement_timeout = 0;',
    'SET client_min_messages = warning;',
    'BEGIN;',
    '',
    `${SECTION_MARK}extensions`,
  )

  for (const x of cat.extensions) {
    lines.push(
      `CREATE EXTENSION IF NOT EXISTS ${qi(x.name)}` +
        `${x.schema && x.schema !== 'public' ? ` WITH SCHEMA ${qi(x.schema)}` : ''};`,
    )
    statements++
  }

  lines.push('', `${SECTION_MARK}types`)

  for (const e of cat.enums) {
    lines.push(`CREATE TYPE ${qi(e.name)} AS ENUM (${e.labels.map(sqlLiteral).join(', ')});`)
    statements++
  }

  lines.push('', `${SECTION_MARK}sequences`)
  for (const s of cat.sequences) {
    lines.push(
      `CREATE SEQUENCE ${qi(s.name)} AS ${s.data_type}` +
        ` INCREMENT BY ${s.increment_by} MINVALUE ${s.min_value} MAXVALUE ${s.max_value}` +
        ` START WITH ${s.start_value} CACHE ${s.cache_size}${s.cycle ? ' CYCLE' : ''};`,
    )
    statements++
  }

  lines.push('', `${SECTION_MARK}tables`)
  for (const t of cat.tables) {
    const cols = cat.columns.filter((c) => c.table_name === t)
    const pk = cat.constraints.find((c) => c.table === t && c.contype === 'p')
    const defs = cols.map(columnDdl)
    if (pk) defs.push(`CONSTRAINT ${qi(pk.name)} ${pk.def}`)
    lines.push(`CREATE TABLE ${qi(t)} (`, '  ' + defs.join(',\n  '), ');')
    statements++
  }

  lines.push('', `${SECTION_MARK}data`)
  for (const t of cat.tables) {
    const cols = cat.columns.filter((c) => c.table_name === t && c.generated !== 's')
    if (!cols.length) {
      tocTables[t] = 0
      lines.push(`${TABLE_MARK}${t}:0`)
      continue
    }
    const names = cols.map((c) => c.column_name)
    const select = names.map((n) => `${qi(n)}::text`).join(', ')
    // ::text 取回，避免 pg 驱动把 timestamptz / numeric / 数组转换成 JS 类型时丢精度
    const { rows } = await client.query(`SELECT ${select} FROM ${qi(t)}`)
    tocTables[t] = rows.length
    rowCount += rows.length
    lines.push(`${TABLE_MARK}${t}:${rows.length}`)
    if (!rows.length) continue

    const target = `${qi(t)} (${names.map(qi).join(', ')})`
    const overriding = cols.some((c) => c.identity === 'a') ? ' OVERRIDING SYSTEM VALUE' : ''
    /** @type {string[]} */
    let batch = []
    let batchBytes = 0
    const flush = () => {
      if (!batch.length) return
      lines.push(`INSERT INTO ${target}${overriding} VALUES\n${batch.join(',\n')};`)
      statements++
      batch = []
      batchBytes = 0
    }
    for (const row of rows) {
      const tuple = '(' + names.map((n) => (row[n] === null || row[n] === undefined ? 'NULL' : sqlLiteral(row[n]))).join(', ') + ')'
      batch.push(tuple)
      batchBytes += tuple.length
      if (batch.length >= 200 || batchBytes >= 256 * 1024) flush()
    }
    flush()
  }

  lines.push('', `${SECTION_MARK}constraints`)
  const altering = cat.constraints
    .filter((c) => CONST_ORDER[c.contype])
    .sort((a, b) => CONST_ORDER[a.contype] - CONST_ORDER[b.contype] || a.table.localeCompare(b.table) || a.name.localeCompare(b.name))
  for (const c of altering) {
    // 数据灌完再加 u/c/f，避免外键顺序问题；FK 最后加，数据有问题会在这里炸
    lines.push(`ALTER TABLE ${qi(c.table)} ADD CONSTRAINT ${qi(c.name)} ${c.def};`)
    statements++
  }

  lines.push('', `${SECTION_MARK}indexes`)
  for (const i of cat.indexes) {
    lines.push(`${i.def};`)
    statements++
  }

  lines.push('', `${SECTION_MARK}sequence-state`)
  for (const s of cat.serialColumns) {
    // pg_get_serial_sequence() 返回的是 schema 限定名（public.event_id_seq），
    // 直接塞进 regclass 字面量里不要整体加引号，否则会被当成一个含点的标识符。
    const ref = /^[a-z_][a-z0-9_$]*(\.[a-z_][a-z0-9_$]*)?$/.test(s.seq) ? s.seq : qi(s.seq)
    // 用实际 max(col) 校正序列，避免 last_value 落后的库里恢复后 id 冲突
    lines.push(
      `SELECT setval('${ref.replace(/'/g, "''")}'::regclass,` +
        ` COALESCE((SELECT max(${qi(s.column_name)}) FROM ${qi(s.table_name)}), 1),` +
        ` (SELECT max(${qi(s.column_name)}) FROM ${qi(s.table_name)}) IS NOT NULL);`,
    )
    statements++
  }

  lines.push('', 'COMMIT;')

  const meta = {
    format: 'logical-sql-gzip',
    version: DUMP_VERSION,
    engine: 'builtin-logical',
    database: db,
    server_version: serverVersion,
    created_at,
    gzip_level: GZIP_LEVEL,
    statements,
    row_count: rowCount,
    tables: tocTables,
    extensions: cat.extensions.map((x) => ({ name: x.name, schema: x.schema, version: x.version })),
  }

  const toc = { version: DUMP_VERSION, created_at, database: db, tables: tocTables, row_count: rowCount, statements }
  lines.push('', `${TOC_MARK}${JSON.stringify(toc)}`, END_MARK, '')

  return { text: lines.join('\n'), toc, meta }
}

/* ------------------------------------------------------------------ *
 * 归档校验
 * ------------------------------------------------------------------ */

/**
 * 校验一份已解压的 dump 文本（= pg_restore -l 的等价物：证明归档结构可读且自洽）。
 * @param {string} text
 * @param {{expectedTables?: Record<string, number>}} [opts]
 * @returns {{ok:boolean, errors:string[], toc:any, tables:Record<string,number>, statements:number}}
 */
export function verifyDumpText(text, { expectedTables } = {}) {
  /** @type {string[]} */
  const errors = []
  const trimmed = text.trimEnd()

  if (!trimmed.startsWith(`-- ${DUMP_MAGIC} v${DUMP_VERSION}`)) {
    errors.push(`missing header "${DUMP_MAGIC} v${DUMP_VERSION}"`)
  }
  if (!trimmed.endsWith(END_MARK)) errors.push(`missing end marker "${END_MARK}" (truncated archive?)`)

  let toc = null
  const tocAt = trimmed.lastIndexOf(TOC_MARK)
  if (tocAt < 0) {
    errors.push('missing TOC line')
  } else {
    const line = trimmed.slice(tocAt + TOC_MARK.length).split('\n')[0]
    try {
      toc = JSON.parse(line)
    } catch (err) {
      errors.push(`TOC line is not valid JSON: ${err.message}`)
    }
  }

  if (!toc) {
    return { ok: false, errors, toc: null, tables: {}, statements: 0 }
  }

  const declared = toc.tables || {}
  /** @type {Record<string, number>} */
  const markers = {}
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith(TABLE_MARK)) continue
    const body = line.slice(TABLE_MARK.length)
    const at = body.lastIndexOf(':')
    if (at < 0) {
      errors.push(`malformed table marker: ${line}`)
      continue
    }
    markers[body.slice(0, at)] = Number(body.slice(at + 1))
  }

  const declaredNames = Object.keys(declared)
  const markerNames = Object.keys(markers)
  if (declaredNames.length !== markerNames.length) {
    errors.push(`TOC declares ${declaredNames.length} tables but ${markerNames.length} table markers found`)
  }
  for (const name of declaredNames) {
    if (markers[name] === undefined) errors.push(`table "${name}" in TOC but no data marker`)
    else if (markers[name] !== declared[name]) {
      errors.push(`table "${name}" marker says ${markers[name]} rows, TOC says ${declared[name]}`)
    }
  }
  for (const name of markerNames) {
    if (declared[name] === undefined) errors.push(`data marker for "${name}" missing from TOC`)
  }

  for (const section of ['extensions', 'types', 'sequences', 'tables', 'data', 'constraints', 'indexes', 'sequence-state']) {
    if (!trimmed.includes(`${SECTION_MARK}${section}`)) errors.push(`missing section "${section}"`)
  }
  const bodyLines = trimmed.split('\n')
  if (!bodyLines.includes('BEGIN;')) errors.push('missing BEGIN;')
  if (!bodyLines.includes('COMMIT;')) errors.push('missing COMMIT;')

  if (expectedTables) {
    for (const [name, n] of Object.entries(expectedTables)) {
      if (markers[name] !== n) errors.push(`table "${name}" has ${markers[name] ?? 'no'} rows, expected ${n}`)
    }
  }

  const statements = (trimmed.match(/;\n/g) || []).length
  return { ok: errors.length === 0, errors, toc, tables: markers, statements }
}

/* ------------------------------------------------------------------ *
 * 备份清单 / 读取
 * ------------------------------------------------------------------ */

export function metaPathOf(file) {
  return `${file}.meta.json`
}

/**
 * 列出备份（新 → 旧）。
 * @param {string} [dir]
 */
export async function listBackups(dir = BACKUP_DIR) {
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const m = NAME_RE.exec(name)
    if (!m) continue
    const file = path.join(dir, name)
    const st = await stat(file).catch(() => null)
    if (!st) continue
    let meta = null
    try {
      meta = JSON.parse(await readFile(metaPathOf(file), 'utf8'))
    } catch {
      meta = null
    }
    out.push({ name, file, bytes: st.size, mtime: st.mtimeMs, stamp: m[1], meta })
  }
  return out.sort((a, b) => b.stamp.localeCompare(a.stamp))
}

/**
 * 读回一份备份：解压 → 结构校验，并返回文本 / TOC / meta。
 * 这一步同时验证 gzip CRC（截断/损坏会在这里抛错）。
 * @param {string} file
 */
export async function readBackup(file) {
  const buf = await readFile(file)
  const meta = JSON.parse(await readFile(metaPathOf(file), 'utf8'))
  if (meta.format !== 'logical-sql-gzip') {
    throw new Error(`archive format "${meta.format}" needs pg_restore, not the builtin reader`)
  }
  const text = gunzipSync(buf).toString('utf8')
  const check = verifyDumpText(text, { expectedTables: meta.tables })
  return { buf, text, meta, check }
}

/* ------------------------------------------------------------------ *
 * 保留策略
 * ------------------------------------------------------------------ */

/**
 * 只保留最近 keep 份。
 * @param {number} keep @param {string} [dir]
 * @returns {Promise<{kept:string[], deleted:string[]}>}
 */
export async function pruneBackups(keep = KEEP, dir = BACKUP_DIR) {
  const all = await listBackups(dir)
  const kept = all.slice(0, keep)
  const deleted = []
  for (const entry of all.slice(keep)) {
    await unlink(entry.file).catch(() => {})
    await unlink(metaPathOf(entry.file)).catch(() => {})
    deleted.push(entry.name)
  }
  return { kept: kept.map((e) => e.name), deleted }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function connect(url) {
  const client = new pg.Client({ connectionString: url, statement_timeout: 60_000 })
  await client.connect()
  return client
}

/** pg_dump 引擎（规范首选路径） */
async function backupWithPgDump({ pgDump, pgRestore, db, file }) {
  const started = Date.now()
  const conn = connParts()
  const r = spawnSync(
    pgDump,
    ['-Fc', '-Z', String(GZIP_LEVEL), '-f', file, '-d', db, '--no-owner', '--no-privileges'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PGHOST: conn.host,
        PGPORT: String(conn.port),
        PGUSER: conn.user,
        PGDATABASE: db,
        ...(conn.password ? { PGPASSWORD: conn.password } : {}),
      },
    },
  )
  if (r.status !== 0) {
    throw new Error(`pg_dump failed (${r.status}): ${(r.stderr || r.stdout || '').trim()}`)
  }
  // 立刻用 pg_restore -l 证明归档可读
  const list = spawnSync(pgRestore, ['-l', file], { encoding: 'utf8' })
  if (list.status !== 0) {
    throw new Error(`pg_restore -l failed (${list.status}): ${(list.stderr || list.stdout || '').trim()}`)
  }
  const entries = (list.stdout || '').split(/\r?\n/).filter((l) => /^\d+;/.test(l)).length
  const st = await stat(file)
  return {
    bytes: st.size,
    elapsedMs: Date.now() - started,
    format: 'pg_dump-custom',
    engine: `pg_dump (${pgDump})`,
    verified: `pg_restore -l OK (${entries} TOC entries)`,
    meta: { format: 'pg_dump-custom', engine: pgDump, database: db, created_at: new Date().toISOString(), entries },
  }
}

/** 内置逻辑引擎（本机实际走这条） */
async function backupWithLogical({ db, file }) {
  const started = Date.now()
  const url = dbUrl()
  const client = await connect(url)
  let text, toc, meta
  try {
    const built = await dumpLogical(client, { db })
    text = built.text
    toc = built.toc
    meta = built.meta
  } finally {
    await client.end()
  }
  const check = verifyDumpText(text, { expectedTables: toc.tables })
  if (!check.ok) throw new Error(`generated dump failed self-check: ${check.errors.join('; ')}`)

  const raw = Buffer.from(text, 'utf8')
  const gz = gzipSync(raw, { level: GZIP_LEVEL })
  const sha256 = createHash('sha256').update(gz).digest('hex')
  await writeFile(file, gz)
  await writeFile(
    metaPathOf(file),
    JSON.stringify(
      {
        ...meta,
        file: path.basename(file),
        bytes: gz.size ?? gz.length,
        raw_bytes: raw.length,
        sha256,
        tables: toc.tables,
        statements: toc.statements,
        row_count: toc.row_count,
      },
      null,
      2,
    ) + '\n',
  )

  // 落盘后重新读回并解压校验（gzip CRC + TOC + sha256）
  const readBack = await readFile(file)
  const readSha = createHash('sha256').update(readBack).digest('hex')
  const inflated = gunzipSync(readBack).toString('utf8')
  const recheck = verifyDumpText(inflated, { expectedTables: toc.tables })
  if (!recheck.ok) throw new Error(`on-disk archive unreadable: ${recheck.errors.join('; ')}`)
  if (readSha !== sha256) throw new Error('on-disk archive sha256 mismatch')
  if (inflated !== text) throw new Error('on-disk archive content differs from generated dump')

  return {
    bytes: readBack.length,
    rawBytes: raw.length,
    elapsedMs: Date.now() - started,
    format: 'logical-sql-gzip',
    engine: 'builtin-logical',
    verified: `gzip CRC + TOC OK, ${Object.keys(toc.tables).length} tables / ${toc.statements} statements / sha256 ${sha256.slice(0, 12)}…`,
    toc,
    meta: { ...meta, sha256 },
  }
}

/**
 * 跑一次备份。
 * @param {{keep?: number, engine?: 'auto'|'logical'|'pg_dump', dir?: string, db?: string}} [opts]
 */
export async function main(opts = {}) {
  const argv = process.argv.slice(2)
  const flag = (name, fallback) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`))
    return hit ? hit.slice(name.length + 3) : fallback
  }
  const dir = opts.dir || flag('dir', BACKUP_DIR)
  const keep = Number(opts.keep ?? flag('keep', KEEP))
  const db = opts.db || connParts().database
  const engine = opts.engine || flag('engine', process.env.ATLAS_BACKUP_ENGINE || 'auto')

  await mkdir(dir, { recursive: true })

  const pgDump = findBinary('pg_dump')
  const pgRestore = findBinary('pg_restore')
  const usePgDump = engine === 'pg_dump' || (engine === 'auto' && pgDump && pgRestore)

  if (engine === 'pg_dump' && (!pgDump || !pgRestore)) {
    throw new Error('engine=pg_dump requested but pg_dump/pg_restore not found on this machine')
  }

  const file = path.join(dir, dumpFileName())
  console.log(`[backup] engine    ${usePgDump ? `pg_dump (${pgDump})` : 'builtin-logical (pg_dump not found)'}`)
  console.log(`[backup] source    ${dbUrl().replace(/:[^:@/]+@/, ':***@')}`)

  const result = usePgDump
    ? await backupWithPgDump({ pgDump, pgRestore, db, file })
    : await backupWithLogical({ db, file })

  if (usePgDump) {
    await writeFile(
      metaPathOf(file),
      JSON.stringify({ ...result.meta, file: path.basename(file), bytes: result.bytes }, null, 2) + '\n',
    )
  }

  console.log(`[backup] verify    ${result.verified}`)
  console.log(
    `[backup] file      ${path.relative(ROOT, file) || file}  ${formatBytes(result.bytes)}  (${result.elapsedMs} ms)`,
  )

  const { kept, deleted } = await pruneBackups(keep, dir)
  console.log(`[backup] retention kept ${kept.length}/${keep}, deleted ${deleted.length}`)

  const all = await listBackups(dir)
  console.log('[backup] backups   ')
  for (const b of all) {
    const meta = b.meta || {}
    console.log(
      `  ${b.name}  ${formatBytes(b.bytes).padStart(10)}  ${String(meta.row_count ?? '?').padStart(6)} rows  ${meta.format || '?'}`,
    )
  }

  return { file, ...result, kept, deleted, backups: all }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url

if (isMain) {
  main()
    .then(() => {
      process.exitCode = 0
    })
    .catch((err) => {
      console.error('[backup] FAILED:', err?.message || err)
      process.exitCode = 1
    })
}
