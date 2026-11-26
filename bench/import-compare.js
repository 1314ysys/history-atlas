#!/usr/bin/env node
/**
 * bench/import-compare.js —— event 表导入：生产写法 vs 关索引批量写法
 *
 *   node bench/import-compare.js            # 默认各 10 万条
 *   node bench/import-compare.js --n=100000
 *   node bench/import-compare.js --only=A   # 只跑一侧（调试用）
 *
 * 两种方式都在**全新的临时库**上跑（库名 <name>_bulk_test，跑完 DROP）：
 *
 *   A 生产写法（src/ingest/router.js / src/seed/index.js 的路径）
 *     · schema.sql 建表 + 全部索引**全程在线**
 *     · 每批 250 行参数化多行 INSERT ... RETURNING id
 *     · 每批一条 UPDATE 回填 search_tsv（unnest 数组参数，等价于生产的逐批回填）
 *
 *   B 本方案（scripts/bulk-import.js）
 *     · 建表后先关掉 event 上全部非唯一索引（保留 pkey / slug unique）
 *     · COPY 探测 → 不可用 → 多行 INSERT 字面量 5000 行/批（放大 20×）
 *     · UNLOGGED 临时表 + 一条 UPDATE ... FROM 全表回填 tsvector
 *     · 最后一次性重建 10 个索引（btree / gin / gist / trgm）
 *
 * 计时口径两侧一致：
 *   导入 = INSERT/COPY 语句本身
 *   回填 = JS 分词 + 写 tsvector 的 UPDATE
 *   建索引 = CREATE INDEX 语句（A 侧为 0：索引已存在，成本摊进写入）
 *   总计 = 从 createFreshDatabase 之后开始，到本次运行所有收尾语句结束（含 ANALYZE）
 */
import {
  applySchema,
  backfillTsv,
  buildIndexes,
  connect,
  createFreshDatabase,
  dropDatabase,
  dropNonUniqueEventIndexes,
  ensureProductionIndexSet,
  fmtInt,
  insertRows,
  now,
  probeCopy,
  tsvFromFields,
} from '../scripts/bulk-import.js'
import { makeEventRows, EVENT_COLS } from './gen.js'

const arg = (k, d) => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
  if (!hit) return d
  if (hit === `--${k}`) return true
  return hit.slice(k.length + 3)
}

const N = Number(arg('n', 100000))
const ONLY = String(arg('only', 'AB')).toUpperCase()
const BATCH_A = Number(arg('batch-a', 250))
const BATCH_B = Number(arg('batch-b', 5000))
const DB_A = 'ha_cmp_prod_bulk_test'
const DB_B = 'ha_cmp_bulk_bulk_test'

/* ---------- 控制台对齐（中文按 2 列宽算，保证表格对齐） ---------- */

/** @param {string} s 显示宽度：CJK / 全角算 2 */
function dw(s) {
  let w = 0
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0)
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    w += wide ? 2 : 1
  }
  return w
}

/** @param {string} s @param {number} w @param {'l'|'r'} [align] */
function padW(s, w, align = 'l') {
  const pad = ' '.repeat(Math.max(0, w - dw(s)))
  return align === 'r' ? pad + String(s) : String(s) + pad
}

/* ---------- A：生产写法 ---------- */

/**
 * 每批 250 行 INSERT + 每批 UPDATE 回填（索引全程在线）。
 * @param {{n:number, db:string, batchRows:number, log:Function}} o
 */
async function runModeA({ n, db, batchRows, log }) {
  await createFreshDatabase(db)
  const client = await connect(db)
  const r = {
    mode: 'A',
    label: 'A 生产写法（250/批 + 每批 UPDATE，索引在线）',
    db,
    n,
    batchRows,
    setupMs: 0,
    dropMs: 0,
    importMs: 0,
    tokenizeMs: 0,
    updateMs: 0,
    analyzeMs: 0,
    indexMs: 0,
    totalMs: 0,
    batches: 0,
    indexesDropped: [],
    copy: null,
    indexes: [],
  }
  const tAll = now()
  try {
    const tSetup = now()
    await applySchema(client) // 表 + schema.sql 的 7 个 event 索引
    await ensureProductionIndexSet(client) // + 001-search 的 3 个 trgm = 生产实际的 10 个
    r.setupMs = now() - tSetup
    log(`[A] 建库建表（含全部 10 个索引，空表）：${fmtInt(r.setupMs)} ms`)

    const cols = EVENT_COLS.join(', ')
    const ncols = EVENT_COLS.length

    for (let off = 0; off < n; off += batchRows) {
      const k = Math.min(batchRows, n - off)
      const rows = makeEventRows(off, k, n)

      const placeholders = rows
        .map((_, ri) => `(${EVENT_COLS.map((_, ci) => `$${ri * ncols + ci + 1}`).join(',')})`)
        .join(',')
      const params = rows.flat()

      const tIns = now()
      const res = await client.query(
        `INSERT INTO event (${cols}) VALUES ${placeholders} RETURNING id`,
        params,
      )
      r.importMs += now() - tIns
      r.batches++

      // 生产口径：先插行，再按 id 回填 tsvector（应用层分词 → 逐批 UPDATE）
      const ids = res.rows.map((x) => x.id)
      const tTok = now()
      const tsvs = rows.map((row) => tsvFromFields([row[1], row[16], row[3], row[4], row[13]]))
      r.tokenizeMs += now() - tTok

      const tUpd = now()
      await client.query(
        `UPDATE event e SET search_tsv = to_tsvector('simple', t.tsv)
           FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS tsv) t
          WHERE e.id = t.id`,
        [ids, tsvs],
      )
      r.updateMs += now() - tUpd

      if (off % 20000 === 0) log(`[A]   ${fmtInt(off + k)}/${fmtInt(n)}`)
    }
    log(`[A] 导入 ${fmtInt(r.importMs)} ms / 回填 ${fmtInt(r.tokenizeMs + r.updateMs)} ms（${r.batches} 批）`)

    const tAn = now()
    await client.query('ANALYZE event')
    r.analyzeMs = now() - tAn

    // A 侧索引由 schema.sql 建好、随写入增量维护，故"建索引"阶段为 0（成本在 importMs 里）
    r.indexMs = 0
    r.totalMs = now() - tAll
    const chk = await client.query('SELECT count(*)::int AS c, count(search_tsv)::int AS t FROM event')
    r.rows = chk.rows[0].c
    r.rowsWithTsv = chk.rows[0].t
  } finally {
    await client.end().catch(() => {})
    await dropDatabase(db).catch((e) => log(`[A] DROP 失败（忽略）：${e.message}`))
  }
  return r
}

/* ---------- B：关索引 + 批量写 + 临时表回填 + 重建索引 ---------- */

/**
 * @param {{n:number, db:string, batchRows:number, log:Function}} o
 */
async function runModeB({ n, db, batchRows, log }) {
  await createFreshDatabase(db)
  const client = await connect(db)
  const r = {
    mode: 'B',
    label: 'B 本方案（关索引 + 5000/批 + 临时表回填 + 重建索引）',
    db,
    n,
    batchRows,
    setupMs: 0,
    dropMs: 0,
    importMs: 0,
    tokenizeMs: 0,
    updateMs: 0,
    analyzeMs: 0,
    indexMs: 0,
    totalMs: 0,
    batches: 0,
    indexesDropped: [],
    copy: null,
    indexes: [],
  }
  const tAll = now()
  try {
    const tSetup = now()
    await applySchema(client)
    await ensureProductionIndexSet(client) // 与 A 同一起跑线：先有 10 个索引，再一起关掉
    r.setupMs = now() - tSetup
    log(`[B] 建库建表（含全部 10 个索引，空表）：${fmtInt(r.setupMs)} ms`)

    const tDrop = now()
    r.indexesDropped = await dropNonUniqueEventIndexes(client)
    r.dropMs = now() - tDrop
    log(`[B] 关索引：删 ${r.indexesDropped.length} 个非唯一索引（${fmtInt(r.dropMs)} ms）`)

    r.copy = await probeCopy(db)
    log(r.copy.ok
      ? `[B] COPY 探测：可用`
      : `[B] COPY 探测：不可用 —— ${r.copy.error} → 降级多行 INSERT ${batchRows} 行/批`)

    const tIns0 = now()
    const write = await insertRows(client, {
      total: n,
      batchRows,
      log: (d) => { if (d % 20000 === 0) log(`[B]   ${fmtInt(d)}/${fmtInt(n)}`) },
    })
    r.importMs = write.ms
    r.batches = write.batches
    r.sqlBytes = write.sqlBytes
    log(`[B] 导入 ${fmtInt(r.importMs)} ms（${write.batches} 批，SQL ${(write.sqlBytes / 1048576).toFixed(1)} MB，总耗时 ${fmtInt(now() - tIns0)} ms）`)

    const bf = await backfillTsv(client)
    r.tokenizeMs = bf.tokenizeMs + bf.readMs + bf.loadMs
    r.updateMs = bf.updateMs
    r.updated = bf.updated
    log(`[B] 回填 ${fmtInt(bf.ms)} ms（读表 ${fmtInt(bf.readMs)} + 分词 ${fmtInt(bf.tokenizeMs)} + 灌临时表 ${fmtInt(bf.loadMs)} + 1×UPDATE ${fmtInt(bf.updateMs)}）`)

    const tAn = now()
    await client.query('ANALYZE event')
    r.analyzeMs = now() - tAn

    const bk = await buildIndexes(client, {
      log: (name, ms) => log(`[B]   建 ${name} ${fmtInt(ms)} ms`),
    })
    r.indexMs = bk.ms
    r.indexes = bk.indexes
    r.indexBytes = bk.totalBytes

    r.totalMs = now() - tAll
    const chk = await client.query('SELECT count(*)::int AS c, count(search_tsv)::int AS t FROM event')
    r.rows = chk.rows[0].c
    r.rowsWithTsv = chk.rows[0].t
  } finally {
    await client.end().catch(() => {})
    await dropDatabase(db).catch((e) => log(`[B] DROP 失败（忽略）：${e.message}`))
  }
  return r
}

/* ---------- 输出 ---------- */

function resultRow(r) {
  const backfill = r.tokenizeMs + r.updateMs
  return {
    label: r.label,
    importMs: r.importMs,
    backfillMs: backfill,
    indexMs: r.indexMs,
    totalMs: r.totalMs,
    epsTotal: Math.round(r.n / Math.max(r.totalMs / 1000, 0.001)),
    epsImport: Math.round(r.n / Math.max(r.importMs / 1000, 0.001)),
    epsTotalInclIndex: Math.round(r.n / Math.max((r.importMs + backfill) / 1000, 0.001)),
    raw: r,
  }
}

function printTable(rows, n) {
  const head = ['方式', '导入 ms', '回填 ms', '建索引 ms', '总计 ms', 'events/秒', '导入 events/秒']
  const cells = rows.map((x) => [
    x.label,
    fmtInt(x.importMs),
    fmtInt(x.backfillMs),
    fmtInt(x.indexMs),
    fmtInt(x.totalMs),
    fmtInt(x.epsTotal),
    fmtInt(x.epsImport),
  ])
  const widths = head.map((h, i) => Math.max(dw(h), ...cells.map((c) => dw(c[i]))) + 2)
  const line = (arr) => '| ' + arr.map((c, i) => padW(c, widths[i])).join('| ') + '|'
  const sep = '+' + widths.map((w) => '-'.repeat(w + 1)).join('+') + '+'
  const out = []
  out.push(sep)
  out.push(line(head))
  out.push(sep)
  for (const c of cells) out.push(line(c))
  out.push(sep)
  out.push(`（n = ${fmtInt(n)} 条/侧；events/秒 = 端到端含建库/回填/建索引；导入 events/秒 = 仅 INSERT 语句）`)
  return out.join('\n')
}

async function main() {
  const t0 = now()
  process.stdout.write(`\n[compare] n=${fmtInt(N)}/侧  A=${DB_A}  B=${DB_B}\n`)
  process.stdout.write(`[compare] 通过 pg 连接 127.0.0.1:5433（原生 PG，trust）\n\n`)

  const results = []
  const log = (m) => process.stdout.write(`${m}\n`)

  try {
    if (ONLY.includes('A')) results.push(await runModeA({ n: N, db: DB_A, batchRows: BATCH_A, log }))
    if (ONLY.includes('B')) results.push(await runModeB({ n: N, db: DB_B, batchRows: BATCH_B, log }))
  } finally {
    // 兜底清理（runModeX 内部已各自 DROP，这里再保一次）
    for (const db of [DB_A, DB_B]) {
      try { await dropDatabase(db) } catch { /* ignore */ }
    }
  }

  const rows = results.map(resultRow)
  process.stdout.write('\n')
  process.stdout.write('='.repeat(100) + '\n')
  process.stdout.write('  导入方式对比（同一份确定性合成数据 bench/gen.js，各 ' + fmtInt(N) + ' 行）\n')
  process.stdout.write('='.repeat(100) + '\n')
  process.stdout.write(printTable(rows, N) + '\n')

  // 明细
  process.stdout.write('\n分项明细\n')
  for (const x of rows) {
    const r = x.raw
    process.stdout.write(`  ${r.label}\n`)
    process.stdout.write(`    建库+建表 ${fmtInt(r.setupMs)} ms | 关索引 ${fmtInt(r.dropMs)} ms（删 ${r.indexesDropped.length} 个）` +
      ` | 导入 ${fmtInt(r.importMs)} ms（${r.batches} 批×${r.batchRows}）` +
      ` | 回填 ${fmtInt(r.tokenizeMs)} + ${fmtInt(r.updateMs)} ms | ANALYZE ${fmtInt(r.analyzeMs)} ms` +
      ` | 建索引 ${fmtInt(r.indexMs)} ms\n`)
    process.stdout.write(`    行数 ${fmtInt(r.rows)}，search_tsv 已填 ${fmtInt(r.rowsWithTsv)}\n`)
    if (r.copy === false || r.copy?.ok === false) {
      process.stdout.write(`    COPY：不可用（${r.copy.error}）\n`)
    }
  }

  // 结论
  const a = rows.find((x) => x.raw.mode === 'A')
  const b = rows.find((x) => x.raw.mode === 'B')
  if (a && b) {
    const speed = a.totalMs / b.totalMs
    const importSpeed = a.importMs / b.importMs
    process.stdout.write('\n对比结论\n')
    process.stdout.write(`  总计：A ${fmtInt(a.totalMs)} ms → B ${fmtInt(b.totalMs)} ms，加速 ${speed.toFixed(2)}×\n`)
    process.stdout.write(`  导入：A ${fmtInt(a.importMs)} ms → B ${fmtInt(b.importMs)} ms，加速 ${importSpeed.toFixed(2)}×\n`)
    process.stdout.write(`  端到端吞吐：A ${fmtInt(a.epsTotal)} → B ${fmtInt(b.epsTotal)} events/s` +
      `（${(b.epsTotal / Math.max(a.epsTotal, 1)).toFixed(2)}×）\n`)
    process.stdout.write(`  B 的索引重建占总耗时 ${((b.indexMs / b.totalMs) * 100).toFixed(1)}%，` +
      `回填占 ${((b.backfillMs / b.totalMs) * 100).toFixed(1)}%，导入占 ${((b.importMs / b.totalMs) * 100).toFixed(1)}%\n`)
    if (b.raw.indexes?.length) {
      const sorted = [...b.raw.indexes].sort((x, y) => y.ms - x.ms)
      process.stdout.write(`  B 最贵的三个索引：${sorted.slice(0, 3).map((i) => `${i.name} ${fmtInt(i.ms)}ms`).join('，')}\n`)
    }
  }
  process.stdout.write(`\n[compare] 临时库已 DROP，总用时 ${fmtInt(now() - t0)} ms\n`)
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`[compare] 失败：${err?.stack || err}\n`)
    process.exit(1)
  },
)
