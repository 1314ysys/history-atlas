#!/usr/bin/env node
/**
 * bench/run.js —— 性能基准执行器
 *
 * 三种运行方式：
 *   node bench/run.js                       # 编排器：依次跑各规模 → 合并 → results.json / results.csv
 *   node bench/run.js --mode=scale --scale=100000 --dir=<临时PG目录> --out=<partial.json>
 *   node bench/run.js --mode=d --relations=100000 --dir=... --out=...
 *   node bench/run.js --mode=e --dir=... --out=...
 *
 * 硬性约束：
 *   - 绝不使用 data/pg；PG_DATA_DIR 由编排器指向自建临时目录，并在子进程启动前写入 env；
 *   - ARCHIVE_DIR 同样指向临时目录，避免污染项目 storage/archive；
 *   - 被测查询尽量直接调用 src/api/*.js 的真实 route handler，保证测的是产品代码路径。
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, readdir, stat, writeFile, readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SEED_TAG = 'history-atlas-bench-v1'

// ---------------------------------------------------------------- 参数解析
function parseArgs(argv) {
  const out = {}
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (!m) continue
    out[m[1]] = m[2] === undefined ? true : m[2]
  }
  return out
}

const ARGV = parseArgs(process.argv)
const MODE = typeof ARGV.mode === 'string' ? ARGV.mode : 'orchestrate'
const DIR = typeof ARGV.dir === 'string' ? ARGV.dir : null

// 子进程：在任何 src 模块被 import 之前设定数据目录（client.js 在模块加载期读取）
if (DIR) {
  process.env.PG_DATA_DIR = DIR
  process.env.ARCHIVE_DIR = path.join(DIR, 'archive')
}
process.env.PG_DATA_DIR = process.env.PG_DATA_DIR || path.join(os.tmpdir(), 'ha-bench-unset')
process.env.ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.join(os.tmpdir(), 'ha-bench-archive')

// ---------------------------------------------------------------- 小工具
const nowMs = () => Number(process.hrtime.bigint() / 1000000n)
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000)

/** @param {number[]} times */
function summarize(times) {
  if (!times.length) return { n: 0 }
  const s = [...times].sort((a, b) => a - b)
  const q = (p) => {
    if (s.length === 1) return s[0]
    const idx = (s.length - 1) * p
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo)
  }
  const sum = s.reduce((a, b) => a + b, 0)
  return {
    n: s.length,
    min: r3(s[0]),
    p50: r3(q(0.5)),
    p95: r3(q(0.95)),
    p99: r3(q(0.99)),
    max: r3(s[s.length - 1]),
    mean: r3(sum / s.length),
  }
}

/**
 * 重复执行 fn 并统计耗时；超预算提前收工（记录实际 n 与 trimmed 标志）。
 */
async function benchLoop(fn, { warmup = 3, runs = 50, budgetMs = 12000, minRuns = 6 } = {}) {
  for (let i = 0; i < warmup; i++) await fn()
  const times = []
  const t0 = nowMs()
  let extra = null
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint()
    const res = await fn()
    times.push(Number(process.hrtime.bigint() - t) / 1e6)
    if (res && typeof res === 'object' && res.__extra) extra = res.__extra
    if (times.length >= minRuns && nowMs() - t0 > budgetMs) break
  }
  return { ...summarize(times), trimmed: times.length < runs, ...(extra || {}) }
}

/** 目录 du（递归求和） */
async function du(dir) {
  let bytes = 0
  let files = 0
  const walk = async (d) => {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else {
        try {
          const s = await stat(p)
          bytes += s.size
          files++
        } catch { /* 并发删除时忽略 */ }
      }
    }
  }
  await walk(dir)
  return { bytes, files }
}

/** 多行 VALUES 批量插入 */
function multiInsert(table, columns, rows, tail = '') {
  const flat = []
  const tuples = []
  for (const row of rows) {
    const ph = []
    for (const v of row) {
      flat.push(v)
      ph.push(`$${flat.length}`)
    }
    tuples.push(`(${ph.join(',')})`)
  }
  return { sql: `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ${tail}`.trim(), params: flat }
}

function chunk(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

// ---------------------------------------------------------------- mode: scale
async function runScale(scale) {
  const gen = await import('./gen.js')
  const { db, migrate, resetSchema } = await import('../src/db/client.js')
  const timelineMod = await import('../src/api/timeline.js')
  const searchMod = await import('../src/api/search.js')
  // routes 结构：['GET', '/api/timeline', handler]
  const timelineHandler = timelineMod.routes.find((r) => r[1] === '/api/timeline')[2]
  const searchHandler = searchMod.routes.find((r) => r[1] === '/api/search')[2]

  const result = { scale, startedAt: new Date().toISOString(), events: 0, claims: 0, sources: 0 }

  // ---------- 建表
  const tBoot = nowMs()
  await resetSchema() // 每档规模都重建 schema，避免复用的临时目录残留上一档数据
  result.bootAndSchemaMs = nowMs() - tBoot

  // ---------- A: 写入吞吐
  const BATCH = 500
  const eventBatchMs = []
  let claimsMs = 0
  let sourcesMs = 0
  let claimsCount = 0
  let sourcesCount = 0
  const tInsert = nowMs()

  for (let off = 0; off < scale; off += BATCH) {
    const n = Math.min(BATCH, scale - off)
    const evRows = gen.makeEventRows(off, n, scale)

    const tb = nowMs()
    const evIns = multiInsert('event', gen.EVENT_COLS, evRows, 'RETURNING id, slug')
    const evRes = await db.query(evIns.sql, evIns.params)
    eventBatchMs.push(nowMs() - tb)

    /** @type {{id:number, idx:number}[]} */
    const events = evRes.rows.map((r) => ({ id: Number(r.id), idx: Number(String(r.slug).slice(3)) }))

    // claims：按 500 行一批插
    const claimRows = gen.makeClaimRows(events)
    const claimIdsByEvent = new Map()
    if (claimRows.length) {
      const tc = nowMs()
      for (const part of chunk(claimRows, 500)) {
        const { sql, params } = multiInsert('event_claim', gen.CLAIM_COLS, part, 'RETURNING id, event_id')
        const res = await db.query(sql, params)
        for (const r of res.rows) {
          const k = Number(r.event_id)
          if (!claimIdsByEvent.has(k)) claimIdsByEvent.set(k, [])
          claimIdsByEvent.get(k).push(Number(r.id))
        }
      }
      claimsMs += nowMs() - tc
      claimsCount += claimRows.length
    }

    // sources：需要真实 claim_id
    const srcRows = gen.makeSourceRows(events, claimIdsByEvent)
    if (srcRows.length) {
      const ts = nowMs()
      for (const part of chunk(srcRows, 500)) {
        const { sql, params } = multiInsert('event_source', gen.SOURCE_COLS, part)
        await db.query(sql, params)
      }
      sourcesMs += nowMs() - ts
      sourcesCount += srcRows.length
    }
  }

  const insertTotalMs = nowMs() - tInsert
  const totalRows = scale + claimsCount + sourcesCount
  const eventMs = eventBatchMs.reduce((a, b) => a + b, 0)
  result.events = scale
  result.claims = claimsCount
  result.sources = sourcesCount
  result.insert = {
    totalMs: insertTotalMs,
    eventMs,
    claimMs: claimsMs,
    sourceMs: sourcesMs,
    eventRowsPerSec: r3((scale / eventMs) * 1000),
    allRowsPerSec: r3((totalRows / insertTotalMs) * 1000),
    eventsPerSec: r3((scale / insertTotalMs) * 1000),
    batchSize: BATCH,
    batchStats: summarize(eventBatchMs),
    batchTimesMs: eventBatchMs.map((x) => r3(x)),
  }

  // ---------- 存储占用
  const sizeRes = await db.query(`
    SELECT c.relname AS name,
           pg_relation_size(c.oid) AS heap,
           pg_indexes_size(c.oid) AS idx,
           pg_total_relation_size(c.oid) AS total
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY pg_total_relation_size(c.oid) DESC`)
  const dbSize = await db.query(`SELECT pg_database_size(current_database()) AS bytes`)
  const spanIdx = await db.query(`SELECT pg_relation_size('event_span_idx') AS b`)
  const duRes = await du(DIR)
  const evSizes = sizeRes.rows.find((r) => r.name === 'event')
  result.storage = {
    dirBytes: duRes.bytes,
    dirFiles: duRes.files,
    pgDatabaseBytes: Number(dbSize.rows[0].bytes),
    eventHeapBytes: Number(evSizes?.heap ?? 0),
    eventIndexBytes: Number(evSizes?.idx ?? 0),
    eventTotalBytes: Number(evSizes?.total ?? 0),
    spanIndexBytes: Number(spanIdx.rows[0].b),
    bytesPerEvent: r3(duRes.bytes / scale),
    bytesPerRow: r3(duRes.bytes / totalRows),
    tables: sizeRes.rows.map((r) => ({
      name: r.name,
      heap: Number(r.heap),
      index: Number(r.idx),
      total: Number(r.total),
    })),
  }

  // ---------- B: 时间区间查询（走真实 route handler）
  const LITE = `slug, title, t_start_year, t_end_year,
    t_start_month, t_start_day, t_precision, t_certainty,
    track, category, discipline, lat, lon`
  const ORDER = `ORDER BY t_start_year, t_start_month NULLS FIRST, t_start_day NULLS FIRST, id LIMIT 5000`
  const PLAIN_SQL = `SELECT ${LITE} FROM event
     WHERE status = 'published' AND t_span && int4range($1::int, $2::int) ${ORDER}`
  const FILTER_SQL = `SELECT ${LITE} FROM event
     WHERE status = 'published' AND t_span && int4range($1::int, $2::int)
       AND track = $3 AND category = ANY($4::text[]) ${ORDER}`

  /** @type {any[]} */
  const bRows = []

  async function plan(sql, params) {
    try {
      const r = await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)
      const p = r.rows[0]['QUERY PLAN'][0]
      return {
        nodeType: p.Plan.NodeType,
        indexName: p.Plan.IndexName ?? null,
        actualRows: p.Plan['Actual Rows'] ?? null,
        actualMs: r3(p['Execution Time']),
      }
    } catch (e) {
      return { error: String(e.message || e).slice(0, 200) }
    }
  }

  async function measureB(indexTag) {
    for (const w of gen.WINDOWS) {
      const tCount = nowMs()
      const cnt = await db.query(
        `SELECT count(*)::int AS n FROM event WHERE status='published' AND t_span && int4range($1::int,$2::int)`,
        [w.from, w.to],
      )
      const countMs = nowMs() - tCount
      const matches = Number(cnt.rows[0].n)

      const plain = await benchLoop(async () => {
        const out = await timelineHandler({ query: { from: String(w.from), to: String(w.to), limit: '5000' } })
        return { __extra: { returned: out.total } }
      }, { runs: 50, budgetMs: 14000, minRuns: 30 })
      bRows.push({ scale, index: indexTag, window: w.id, windowLabel: w.label, variant: 'plain', matches, countMs: r3(countMs), ...plain })

      const tCount2 = nowMs()
      const cnt2 = await db.query(
        `SELECT count(*)::int AS n FROM event WHERE status='published' AND t_span && int4range($1::int,$2::int)
           AND track=$3 AND category = ANY($4::text[])`,
        [w.from, w.to, gen.FILTER.track, gen.FILTER.categories],
      )
      const count2Ms = nowMs() - tCount2

      const filtered = await benchLoop(async () => {
        const r = await db.query(FILTER_SQL, [w.from, w.to, gen.FILTER.track, gen.FILTER.categories])
        return { __extra: { returned: r.rows.length } }
      }, { runs: 50, budgetMs: 14000, minRuns: 30 })
      bRows.push({
        scale, index: indexTag, window: w.id, windowLabel: w.label, variant: 'filtered',
        filter: `${gen.FILTER.track} + ${gen.FILTER.categories.join('/')}`,
        matches: Number(cnt2.rows[0].n), countMs: r3(count2Ms), ...filtered,
      })
    }
  }

  await measureB('gist')

  // ---------- C: 全文检索（走真实 /api/search handler）
  /** @type {any[]} */
  const cRows = []
  const tiers = [
    { id: 'hit1', marker: gen.MARKERS.single, label: '命中 1 条（唯一词）' },
    { id: 'hit1000', marker: gen.MARKERS.thousand, label: '命中约 1000 条（高频词）' },
    { id: 'miss', marker: gen.MARKERS.miss, label: '无命中（不存在的词，必须扫全表）' },
    { id: 'zh', marker: gen.MARKERS.zh, label: '中文命中约 1000 条（无分词）' },
  ]
  for (const t of tiers) {
    const cnt = await db.query(
      `SELECT count(*)::int AS n FROM event
        WHERE status='published' AND (title ILIKE $1 OR summary ILIKE $1 OR search_text LIKE $2)`,
      [`%${t.marker}%`, `%${t.marker.toLowerCase()}%`],
    )
    const matches = Number(cnt.rows[0].n)
    const budget = t.id === 'miss' ? 8000 : 12000
    const stats = await benchLoop(async () => {
      const out = await searchHandler({ query: { q: t.marker, limit: '20' } })
      return { __extra: { returned: out.total } }
    }, { runs: 50, budgetMs: budget, minRuns: 5 })
    cRows.push({ scale, tier: t.id, marker: t.marker, label: t.label, matches, ...stats })
  }

  // ---------- F: GiST 索引的成本与收益
  const withGist = {
    eventIndexBytes: result.storage.eventIndexBytes,
    spanIndexBytes: result.storage.spanIndexBytes,
    plan10y: await plan(PLAIN_SQL, [1495, 1505]),
    planFull: await plan(PLAIN_SQL, [-5000, 2025]),
  }

  await db.exec(`DROP INDEX IF EXISTS event_span_idx`)
  const afterDrop = {
    eventIndexBytes: Number((await db.query(`SELECT pg_indexes_size('event') AS b`)).rows[0].b),
    spanIndexBytes: 0,
    plan10y: await plan(PLAIN_SQL, [1495, 1505]),
    planFull: await plan(PLAIN_SQL, [-5000, 2025]),
  }

  await measureB('nogist')

  result.b = bRows
  result.c = cRows
  result.f = { withGist, withoutGist: afterDrop }

  const pick = (rows, pred) => {
    const r = rows.find(pred)
    return r ? r.p50 : null
  }

  console.log(
    `[scale ${scale}] events=${scale} claims=${claimsCount} sources=${sourcesCount} ` +
    `insert=${(insertTotalMs / 1000).toFixed(1)}s ${r3(totalRows / (insertTotalMs / 1000))}rows/s ` +
    `db=${(duRes.bytes / 1048576).toFixed(1)}MB ` +
    `B10y_p50=${pick(bRows, (x) => x.window === '10y' && x.variant === 'plain' && x.index === 'gist')}ms ` +
    `Bfull_p50=${pick(bRows, (x) => x.window === 'full' && x.variant === 'plain' && x.index === 'gist')}ms ` +
    `C_miss_p50=${pick(cRows, (x) => x.tier === 'miss')}ms`,
  )

  await db.close()
  return result
}

// ---------------------------------------------------------------- mode: d
async function runGraph(relations) {
  const gen = await import('./gen.js')
  const { db, migrate, resetSchema } = await import('../src/db/client.js')
  const graphMod = await import('../src/api/graph.js')

  await resetSchema() // 同上：图规模档也要干净起点

  const personCount = Math.max(50, Math.round(relations / 5))
  const out = { relations, persons: personCount }

  const tPersons = nowMs()
  for (const part of chunk(gen.makePersons(personCount), 500)) {
    const { sql, params } = multiInsert('person', gen.PERSON_COLS, part)
    await db.query(sql, params)
  }
  out.personInsertMs = nowMs() - tPersons

  const tRel = nowMs()
  const relRows = gen.makeRelations(relations, personCount)
  for (const part of chunk(relRows, 500)) {
    const { sql, params } = multiInsert('person_relation', gen.RELATION_COLS, part, 'ON CONFLICT DO NOTHING')
    await db.query(sql, params)
  }
  out.relationInsertMs = nowMs() - tRel
  out.relationRows = relRows.length

  out.relationCount = Number((await db.query(`SELECT count(*)::int AS n FROM person_relation`)).rows[0].n)
  out.personCount = Number((await db.query(`SELECT count(*)::int AS n FROM person`)).rows[0].n)

  // 2 跳 BFS（真实函数，内部逐跳查询）
  const warm = await graphMod.expandPersonGraph('p-0', 2)
  out.nodes = warm ? warm.nodes.length : 0
  out.edges = warm ? warm.edges.length : 0

  const stats = await benchLoop(async () => {
    const g = await graphMod.expandPersonGraph('p-0', 2)
    return { __extra: { nodes: g ? g.nodes.length : 0, edges: g ? g.edges.length : 0 } }
  }, { runs: 30, budgetMs: 12000, minRuns: 5 })

  out.stats = stats

  try {
    const r = await db.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) SELECT from_slug, to_slug, type FROM person_relation
        WHERE from_slug = ANY($1::text[]) OR to_slug = ANY($1::text[])`,
      [['p-0', 'p-1', 'p-2']],
    )
    const p = r.rows[0]['QUERY PLAN'][0]
    out.plan = { nodeType: p.Plan.NodeType, actualMs: r3(p['Execution Time']) }
  } catch (e) {
    out.plan = { error: String(e.message || e).slice(0, 200) }
  }

  out.dirBytes = (await du(DIR)).bytes

  console.log(
    `[graph ${relations}] persons=${out.personCount} relations=${out.relationCount} ` +
    `insert=${((out.personInsertMs + out.relationInsertMs) / 1000).toFixed(1)}s ` +
    `bfs2_p50=${stats.p50}ms nodes=${out.nodes} edges=${out.edges}`,
  )

  await db.close()
  return out
}

// ---------------------------------------------------------------- mode: e
async function runCompression() {
  const zlib = await import('node:zlib')
  const gen = await import('./gen.js')
  const store = await import('../src/archive/store.js')

  const out = { codecs: [], store: {} }

  // ---------- 1e5 条事件的 JSONL（claims / sources 内联，贴近真实存档形态）
  const tGen = nowMs()
  const lines = gen.jsonlLines(100000)
  const buf = Buffer.from(lines.join('\n'), 'utf8')
  out.jsonl = {
    events: 100000,
    lines: lines.length,
    bytes: buf.length,
    genMs: nowMs() - tGen,
    avgBytesPerLine: r3(buf.length / lines.length),
  }

  const codecs = [
    {
      id: 'zstd-3',
      note: 'zstd level 3（zstd 默认档）',
      fn: () => zlib.zstdCompressSync(buf, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }),
      dec: (b) => zlib.zstdDecompressSync(b),
    },
    {
      id: 'zstd-9',
      note: 'zstd level 9',
      fn: () => zlib.zstdCompressSync(buf, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 9 } }),
      dec: (b) => zlib.zstdDecompressSync(b),
    },
    {
      id: 'brotli-5',
      note: 'brotli quality 5',
      fn: () => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }),
      dec: (b) => zlib.brotliDecompressSync(b),
    },
    {
      id: 'brotli-11',
      note: 'brotli quality 11（zlib 默认档）',
      fn: () => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }),
      dec: (b) => zlib.brotliDecompressSync(b),
    },
    {
      id: 'gzip-6',
      note: 'gzip level 6',
      fn: () => zlib.gzipSync(buf, { level: 6 }),
      dec: (b) => zlib.gunzipSync(b),
    },
  ]

  for (const c of codecs) {
    let comp
    let compMs
    try {
      const t = process.hrtime.bigint()
      comp = c.fn()
      compMs = Number(process.hrtime.bigint() - t) / 1e6
    } catch (e) {
      out.codecs.push({ id: c.id, note: c.note, error: String(e.message || e).slice(0, 200) })
      continue
    }
    const t2 = process.hrtime.bigint()
    const back = c.dec(comp)
    const decMs = Number(process.hrtime.bigint() - t2) / 1e6
    out.codecs.push({
      id: c.id,
      note: c.note,
      originalBytes: buf.length,
      compressedBytes: comp.length,
      ratio: r3(buf.length / comp.length),
      savings: r3(1 - comp.length / buf.length),
      compressMs: r3(compMs),
      decompressMs: r3(decMs),
      compressMBps: r3(buf.length / 1048576 / (compMs / 1000)),
      decompressMBps: r3(buf.length / 1048576 / (decMs / 1000)),
      roundTripOk: back.length === buf.length && back.equals(buf),
    })
    console.log(
      `[compress] ${c.id}: ${(buf.length / 1048576).toFixed(1)}MB -> ${(comp.length / 1048576).toFixed(2)}MB ` +
      `(${r3(buf.length / comp.length)}x) c=${compMs.toFixed(0)}ms d=${decMs.toFixed(0)}ms`,
    )
  }

  // ---------- store.js putText / verify：1e4 个小文件
  const N = 10000
  const tPut = nowMs()
  const shas = []
  for (let i = 0; i < N; i++) {
    const body = `史料原文片段第${i}号：${'水运仪象台'.repeat(1 + (i % 3))}，卷${i % 400}，哈希校验用途。`
    const res = await store.putText(body)
    shas.push(res.sha256)
  }
  const putMs = nowMs() - tPut

  const tVer = nowMs()
  let ok = 0
  for (let i = 0; i < N; i++) {
    const v = await store.verify(shas[i], { quote: `第${i}号` })
    if (v.status === 'verified') ok++
  }
  const verifyMs = nowMs() - tVer

  const archiveDu = await du(store.ARCHIVE_DIR)
  out.store = {
    files: N,
    putTextMs: putMs,
    putTextPerFileMs: r3(putMs / N),
    putTextFilesPerSec: r3((N / putMs) * 1000),
    verifyMs,
    verifyPerFileMs: r3(verifyMs / N),
    verifyFilesPerSec: r3((N / verifyMs) * 1000),
    verifiedOk: ok,
    archiveBytes: archiveDu.bytes,
    archiveFiles: archiveDu.files,
    avgBytesPerFile: r3(archiveDu.bytes / N),
    archiveDir: store.ARCHIVE_DIR,
  }

  console.log(
    `[archive] files=${N} put=${(putMs / 1000).toFixed(1)}s (${r3((N / putMs) * 1000)}/s) ` +
    `verify=${(verifyMs / 1000).toFixed(1)}s ok=${ok} bytes=${archiveDu.bytes}`,
  )

  return out
}

// ---------------------------------------------------------------- 编排器
function toCsv(results) {
  const rows = [['group', 'scope', 'variant', 'metric', 'value', 'unit', 'notes']]
  for (const a of results.a) {
    const s = a.scale
    rows.push(['A', String(s), 'insert', 'totalMs', a.insert.totalMs, 'ms', 'event+claim+source 全量插入'])
    rows.push(['A', String(s), 'insert', 'rowsPerSec', a.insert.allRowsPerSec, 'rows/s', '三表合计行'])
    rows.push(['A', String(s), 'insert', 'eventsPerSec', a.insert.eventsPerSec, 'events/s', '仅 event 表'])
    rows.push(['A', String(s), 'storage', 'dirBytes', a.storage.dirBytes, 'bytes', 'PGlite 目录 du'])
    rows.push(['A', String(s), 'storage', 'bytesPerEvent', a.storage.bytesPerEvent, 'bytes/event', '目录 du / 事件数'])
    for (const k of ['p50', 'p95', 'p99', 'max']) {
      rows.push(['A', String(s), 'batch500', `batch.${k}`, a.insert.batchStats[k], 'ms', '每 500 行一批'])
    }
  }
  for (const b of results.b) {
    for (const k of ['p50', 'p95', 'p99', 'max', 'mean']) {
      rows.push(['B', String(b.scale), `${b.window}/${b.variant}/${b.index}`, k, b[k], 'ms', `matches=${b.matches} n=${b.n}`])
    }
  }
  for (const c of results.c) {
    for (const k of ['p50', 'p95', 'p99', 'max', 'mean']) {
      rows.push(['C', String(c.scale), c.tier, k, c[k], 'ms', `matches=${c.matches} n=${c.n}`])
    }
  }
  for (const d of results.d) {
    for (const k of ['p50', 'p95', 'p99', 'max', 'mean']) {
      rows.push(['D', String(d.relationCount), 'bfs2', k, d.stats[k], 'ms', `persons=${d.personCount}`])
    }
    rows.push(['D', String(d.relationCount), 'insert', 'relationInsertMs', d.relationInsertMs, 'ms', `${d.relationRows} 行`])
  }
  if (results.e) {
    for (const c of results.e.codecs || []) {
      if (c.error) continue
      rows.push(['E', String(results.e.jsonl.events), c.id, 'ratio', c.ratio, 'x', c.note])
      rows.push(['E', String(results.e.jsonl.events), c.id, 'compressMs', c.compressMs, 'ms', `${c.originalBytes} bytes`])
      rows.push(['E', String(results.e.jsonl.events), c.id, 'decompressMs', c.decompressMs, 'ms', ''])
      rows.push(['E', String(results.e.jsonl.events), c.id, 'compressMBps', c.compressMBps, 'MB/s', ''])
      rows.push(['E', String(results.e.jsonl.events), c.id, 'decompressMBps', c.decompressMBps, 'MB/s', ''])
    }
    const st = results.e.store
    rows.push(['E', String(st.files), 'store.putText', 'totalMs', st.putTextMs, 'ms', `${st.putTextFilesPerSec} files/s`])
    rows.push(['E', String(st.files), 'store.verify', 'totalMs', st.verifyMs, 'ms', `${st.verifyFilesPerSec} files/s ok=${st.verifiedOk}`])
  }
  for (const f of results.f) {
    rows.push(['F', String(f.scale), 'gist', 'spanIndexBytes', f.withGist.spanIndexBytes, 'bytes', 'event_span_idx 大小'])
    rows.push(['F', String(f.scale), 'gist', 'eventIndexBytes', f.withGist.eventIndexBytes, 'bytes', 'event 全部索引'])
    rows.push(['F', String(f.scale), 'nogist', 'eventIndexBytes', f.withoutGist.eventIndexBytes, 'bytes', 'DROP event_span_idx 后'])
  }
  return rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))).join(',')).join('\n') + '\n'
}

async function orchestrate() {
  const keep = Boolean(ARGV.keep)
  const budgetMs = Number(ARGV.budget || 1200) * 1000
  const t0 = nowMs()
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'ha-bench-'))
  const partialDir = path.join(workDir, 'partials')
  await mkdir(partialDir, { recursive: true })

  console.log(`bench workdir : ${workDir}`)
  console.log(`PG_DATA_DIR   : ${workDir}  (data/pg 不会被触碰)`)

  const cpInfo = os.cpus()
  const pglitePkg = JSON.parse(await readFile(path.join(ROOT, 'node_modules/@electric-sql/pglite/package.json'), 'utf8'))
  const meta = {
    tag: SEED_TAG,
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: cpInfo.length ? cpInfo[0].model.trim() : 'unknown',
    cpuCount: cpInfo.length,
    totalMemBytes: os.totalmem(),
    pglite: pglitePkg.version,
    pgDataDir: workDir,
    touchedDataPg: false,
    ladder: [],
    downgrades: [],
  }

  const child = async (args, timeoutMs, label) => {
    const outFile = path.join(partialDir, `${label}.json`)
    const childArgs = [path.join(HERE, 'run.js'), ...args, `--out=${outFile}`]
    const t = nowMs()
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, childArgs, {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, PG_DATA_DIR: workDir },
        windowsHide: true,
      })
      const timer = setTimeout(() => {
        console.log(`  !! ${label} 超时 ${timeoutMs / 1000}s，终止`)
        try { p.kill('SIGKILL') } catch { /* ignore */ }
      }, timeoutMs)
      p.on('exit', (c) => {
        clearTimeout(timer)
        resolve(c ?? 1)
      })
    })
    const elapsedMs = nowMs() - t
    if (code !== 0) return { label, ok: false, code, elapsedMs }
    return { label, ok: true, elapsedMs, data: JSON.parse(await readFile(outFile, 'utf8')) }
  }

  const results = { meta, a: [], b: [], c: [], d: [], e: null, f: [] }

  // ---------- A/B/C/F: 事件规模阶梯
  const baseLadder = [1000, 10000, 100000]
  const ladder = []

  for (const scale of baseLadder) {
    const r = await child([`--mode=scale`, `--scale=${scale}`, `--dir=${workDir}`], scale >= 100000 ? 360000 : 180000, `scale-${scale}`)
    if (!r.ok) {
      console.log(`  !! scale ${scale} 失败 code=${r.code}，跳过`)
      meta.downgrades.push({ scale, reason: `child failed code=${r.code}` })
      continue
    }
    ladder.push(scale)
    results.a.push(r.data)
    results.b.push(...r.data.b)
    results.c.push(...r.data.c)
    results.f.push({ scale, ...r.data.f })
    console.log(`  - 累计 ${((nowMs() - t0) / 1000).toFixed(0)}s，剩余预算 ${(budgetMs / 1000 - (nowMs() - t0) / 1000).toFixed(0)}s`)
  }

  // 用 1e5 的实测吞吐预测 1e6 是否超时，据此决定是否降级到 5e5
  const last = results.a[results.a.length - 1]
  let bigScale = 1000000
  if (last && last.scale === 100000) {
    const rowsPerSec = last.insert.allRowsPerSec
    const projectedRows = 1000000 * (1 + 2 + 1.5)
    const projectedSec = (projectedRows / rowsPerSec) * 1.35
    console.log(`  预测 1e6 插入耗时约 ${projectedSec.toFixed(0)}s（1e5 实测 ${rowsPerSec} rows/s，取 1.35 劣化系数）`)
    if (projectedSec > 420) {
      bigScale = 500000
      meta.downgrades.push({
        scale: 1000000,
        to: 500000,
        reason: `projected insert ${projectedSec.toFixed(0)}s > 420s threshold`,
        projectedSec: r3(projectedSec),
        basisRowsPerSec: rowsPerSec,
      })
      console.log(`  -> 1e6 预测超 8 分钟阈值，降级为 5e5`)
    }
  }

  const rBig = await child([`--mode=scale`, `--scale=${bigScale}`, `--dir=${workDir}`], 780000, `scale-${bigScale}`)
  if (rBig.ok) {
    ladder.push(bigScale)
    results.a.push(rBig.data)
    results.b.push(...rBig.data.b)
    results.c.push(...rBig.data.c)
    results.f.push({ scale: bigScale, ...rBig.data.f })
  } else {
    console.log(`  !! scale ${bigScale} 失败 code=${rBig.code}`)
    meta.downgrades.push({ scale: bigScale, reason: `child failed code=${rBig.code}` })
  }
  meta.ladder = ladder

  // ---------- D: 图关系规模阶梯
  for (const rel of [10000, 100000, 1000000]) {
    const r = await child([`--mode=d`, `--relations=${rel}`, `--dir=${workDir}`], 420000, `graph-${rel}`)
    if (r.ok) results.d.push(r.data)
    else console.log(`  !! graph ${rel} 失败 code=${r.code}`)
  }

  // ---------- E: 压缩与存档
  const eDir = path.join(workDir, 'arc')
  await mkdir(eDir, { recursive: true })
  const re = await child([`--mode=e`, `--dir=${eDir}`], 420000, 'compress')
  if (re.ok) results.e = re.data
  else console.log(`  !! compress 失败 code=${re.code}`)

  results.meta.finishedAt = new Date().toISOString()
  results.meta.wallMs = nowMs() - t0
  results.meta.wallSec = r3(results.meta.wallMs / 1000)

  await writeFile(path.join(HERE, 'results.json'), JSON.stringify(results, null, 2), 'utf8')
  await writeFile(path.join(HERE, 'results.csv'), toCsv(results), 'utf8')

  console.log(`\n完成: wall=${(results.meta.wallMs / 1000).toFixed(0)}s ladder=${ladder.join(',')}`)
  console.log(`已写入 bench/results.json、bench/results.csv`)

  if (!keep) {
    try {
      await rm(workDir, { recursive: true, force: true })
      console.log('临时数据目录已清理（--keep 可保留）')
    } catch { /* ignore */ }
  } else {
    console.log(`临时数据目录保留：${workDir}`)
  }
}

// ---------------------------------------------------------------- 入口
if (MODE === 'scale') {
  const res = await runScale(Number(ARGV.scale))
  await writeFile(ARGV.out, JSON.stringify(res, null, 2), 'utf8')
} else if (MODE === 'd') {
  const res = await runGraph(Number(ARGV.relations))
  await writeFile(ARGV.out, JSON.stringify(res, null, 2), 'utf8')
} else if (MODE === 'e') {
  const res = await runCompression()
  await writeFile(ARGV.out, JSON.stringify(res, null, 2), 'utf8')
} else {
  await orchestrate()
}
