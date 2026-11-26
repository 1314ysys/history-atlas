#!/usr/bin/env node
/**
 * scripts/shard-proto.js —— 真实多实例分片原型（3 个独立 PG 实例，按时间区间分片）
 *
 * 为什么要有这个脚本：
 *   docs/report/partition.md 已经证明「单机内的 PARTITION BY RANGE」是负收益——
 *   分区没有减少任何一次磁盘 IO，只增加了规划开销。真正能把读放大摊到多核/多盘的
 *   只有「多实例分片」。本脚本就是最小可信原型：同一台机器上起 3 个 postgres.exe，
 *   各自 10 万行、时间区间互不重叠，然后用 src/db/shard.js 走真实路由验证。
 *
 * 用法：
 *   node scripts/shard-proto.js init      initdb + 启动 3 实例（5441/5442/5443）+ 建库 + 建 schema
 *   node scripts/shard-proto.js start     只启动（已 init 过，比如机器重启后）
 *   node scripts/shard-proto.js seed      按区间灌数据（各 10 万，共 30 万）
 *   node scripts/shard-proto.js verify    SHARD_URLS/SHARD_RANGES 下验证路由与结果合并
 *   node scripts/shard-proto.js status    实例状态 + 数据分布
 *   node scripts/shard-proto.js stop      停掉 3 个分片实例（默认不停，bench 还要用）
 *   node scripts/shard-proto.js all       init + seed + verify
 *
 * 拓扑：
 *   端口 5441  data/pg-shard0  t_start_year ∈ [-5000,  500)
 *   端口 5442  data/pg-shard1  t_start_year ∈ [  500, 1500)
 *   端口 5443  data/pg-shard2  t_start_year ∈ [ 1500, 3000)
 *
 * 注意：本脚本**不碰** 5433（主库）/5434（从库），也不 DROP 任何分片实例。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { makeEventRows, EVENT_COLS } from '../bench/gen.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin')

export const DB_NAME = 'history_atlas'
export const ROWS_PER_SHARD = 100_000
/** gen.js 的标记词步长按这个「逻辑全表规模」算，保证两侧数据完全一致 */
export const TOTAL_CANDIDATES = 300_000

/** 3 个分片实例的拓扑（导出给 bench/shard-compare.js 复用） */
export const SHARDS = [
  { idx: 0, port: 5441, dir: path.join(ROOT, 'data', 'pg-shard0'), from: -5000, to: 500 },
  { idx: 1, port: 5442, dir: path.join(ROOT, 'data', 'pg-shard1'), from: 500, to: 1500 },
  { idx: 2, port: 5443, dir: path.join(ROOT, 'data', 'pg-shard2'), from: 1500, to: 3000 },
]

const exe = (n) => path.join(BIN, `${n}.exe`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ts = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(`[${ts()}]`, ...a)

/** 数据目录对应的日志文件 */
const logFile = (s) => path.join(ROOT, 'data', `pg-shard${s.idx}.log`)

/** 该实例的启动命令（写进报告用） */
export function startCommand(s) {
  return `"${exe('postgres')}" -D "${s.dir}" -p ${s.port}`
}

export function shardUrl(port, db = DB_NAME) {
  return `postgres://postgres@127.0.0.1:${port}/${db}`
}

/** 供 src/db/shard.js 使用的环境变量值 */
export function shardUrls() {
  return SHARDS.map((s) => shardUrl(s.port)).join(',')
}
export function shardRanges() {
  return SHARDS.map((s) => `${s.from}:${s.to}`).join(',')
}

// ---------------------------------------------------------------- 进程管理

function portOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host })
    let done = false
    const fin = (v) => {
      if (done) return
      done = true
      try { sock.destroy() } catch { /* ignore */ }
      resolve(v)
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => fin(true))
    sock.once('timeout', () => fin(false))
    sock.once('error', () => fin(false))
  })
}

export async function waitPort(port, ms = 60_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await portOpen(port)) return true
    await sleep(400)
  }
  return false
}

/** initdb（幂等：已有 PG_VERSION 就跳过） */
export function initInstance(s) {
  if (existsSync(path.join(s.dir, 'PG_VERSION'))) {
    log(`shard${s.idx}: 数据目录已存在，跳过 initdb（${s.dir}）`)
    return { skipped: true }
  }
  mkdirSync(s.dir, { recursive: true })
  const r = spawnSync(exe('initdb'), [
    '-D', s.dir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8',
    '--locale=C', '--lc-collate=C', '--lc-ctype=C',
  ], { encoding: 'utf8' })
  const out = ((r.stdout || '') + (r.stderr || '')).trim()
  if (r.status !== 0) {
    console.error(out.split('\n').slice(-12).join('\n'))
    throw new Error(`initdb 失败 shard${s.idx}（exit ${r.status}）`)
  }
  log(`shard${s.idx}: initdb 完成 → ${s.dir}`)
  return { skipped: false }
}

/**
 * 启动一个实例。
 * 用 spawn(detached: true) 直接拉起 postgres.exe：会话/父进程退出后实例仍然存活
 * （pg_ctl 也能做到，但这里显式 detached 更便于确认「真的独立」）。
 */
export async function startInstance(s) {
  if (await portOpen(s.port)) {
    log(`shard${s.idx}: 端口 ${s.port} 已在监听，跳过启动`)
    return { started: false, alive: true }
  }
  if (!existsSync(path.join(s.dir, 'PG_VERSION'))) {
    throw new Error(`shard${s.idx} 未初始化（缺 ${path.join(s.dir, 'PG_VERSION')}），先跑 init`)
  }
  const fd = openSync(logFile(s), 'a')
  const child = spawn(exe('postgres'), ['-D', s.dir, '-p', String(s.port)], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  })
  child.unref()
  const alive = await waitPort(s.port, 60_000)
  if (!alive) throw new Error(`shard${s.idx} 启动失败，见 ${logFile(s)}`)
  log(`shard${s.idx}: 已启动 pid=${child.pid} 端口 ${s.port}（detached，父进程退出后仍存活）`)
  return { started: true, alive: true, pid: child.pid }
}

/** 停止（默认不调用；仅 stop 子命令 / 手工清理时用） */
export function stopInstance(s) {
  const r = spawnSync(exe('pg_ctl'), ['-D', s.dir, '-m', 'fast', 'stop'], { encoding: 'utf8' })
  const out = ((r.stdout || '') + (r.stderr || '')).trim()
  log(`shard${s.idx}: ${out.split('\n').slice(-1)[0] || '已停止'}`)
  return out
}

/** pg_ctl status 的原始输出（证明实例在跑） */
export function instanceStatus(s) {
  const r = spawnSync(exe('pg_ctl'), ['-D', s.dir, 'status'], { encoding: 'utf8' })
  return ((r.stdout || '') + (r.stderr || '')).trim().split('\n')[0] || ''
}

// ---------------------------------------------------------------- 建库 / schema

export async function connect(port, db = DB_NAME) {
  const c = new pg.Client({ connectionString: shardUrl(port, db) })
  await c.connect()
  return c
}

/** 建库（幂等） */
export async function ensureDatabase(port, db = DB_NAME) {
  const admin = await connect(port, 'postgres')
  try {
    const r = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db])
    if (!r.rowCount) {
      await admin.query(`CREATE DATABASE "${db}" ENCODING 'UTF8'`)
      log(`端口 ${port}: 已建库 ${db}`)
      return { created: true }
    }
    return { created: false }
  } finally {
    await admin.end()
  }
}

/** DROP 库（bench 清理单库对照用；FORCE 断开残留连接） */
export async function dropDatabase(port, db) {
  const admin = await connect(port, 'postgres')
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`)
  } finally {
    await admin.end()
  }
}

/** 应用 src/db/schema.sql（幂等：event 表已存在就跳过） */
export async function applySchema(port, db = DB_NAME) {
  const c = await connect(port, db)
  try {
    const has = await c.query(`SELECT to_regclass('public.event') AS t`)
    if (has.rows[0].t) {
      log(`端口 ${port}/${db}: schema 已存在，跳过`)
      return { applied: false }
    }
    const ddl = await readFile(path.join(ROOT, 'src', 'db', 'schema.sql'), 'utf8')
    await c.query(ddl)
    log(`端口 ${port}/${db}: schema.sql 已应用`)
    return { applied: true }
  } finally {
    await c.end()
  }
}

// ---------------------------------------------------------------- 数据生成

/**
 * 确定性生成「属于 shard idx 的那 10 万行」。
 *
 * 关键约束：必须真的按区间过滤（不是把每片的 10 万行硬塞）。
 * gen.js 的年份分布是「65% 落在 [-5000,1500) + 35% 落在 [1500,2025]」，
 * 所以 [-5000,500) 占 ~55%、[500,1500) 只占 ~10%、[1500,3000) 占 ~35%。
 * 为了让 shard1 也凑够 10 万，必须扫过约 100 万个候选（约 3 秒），
 * 这正是「按真实分布切片」的代价，也是本原型可信的地方。
 *
 * @param {number} idx 分片序号
 * @returns {Generator<any[][]>} 每批 500 行
 */
export function* shardRowBatches(idx) {
  const s = SHARDS[idx]
  const CHUNK = 5000
  const BATCH = 500
  const MAX_SCAN = 4_000_000
  let produced = 0
  let buf = []
  for (let off = 0; produced < ROWS_PER_SHARD; off += CHUNK) {
    if (off > MAX_SCAN) throw new Error(`shard${idx} 候选池耗尽（只产出 ${produced} 行）`)
    const rows = makeEventRows(off, CHUNK, TOTAL_CANDIDATES)
    for (const r of rows) {
      const y = r[5] // t_start_year
      if (y < s.from || y >= s.to) continue
      buf.push(r)
      produced++
      if (buf.length === BATCH) {
        yield buf
        buf = []
      }
      if (produced >= ROWS_PER_SHARD) break
    }
  }
  if (buf.length) yield buf
}

/** 单条 INSERT 塞多行（500 行 × 20 列 = 10000 参数，远低于 65535 上限） */
export async function insertRows(client, rows) {
  if (!rows.length) return
  const per = EVENT_COLS.length
  const groups = []
  for (let i = 0; i < rows.length; i++) {
    const parts = []
    for (let j = 0; j < per; j++) parts.push(`$${i * per + j + 1}`)
    groups.push(`(${parts.join(',')})`)
  }
  await client.query(
    `INSERT INTO event (${EVENT_COLS.join(', ')}) VALUES ${groups.join(',')}`,
    rows.flat(),
  )
}

/**
 * 往某个库灌 [from,to) 区间的 10 万行（用 idx 选择区间）。
 * @param {number} port @param {string} db @param {number} idx
 */
export async function seedShardInto(port, db, idx) {
  const c = await connect(port, db)
  try {
    // 灌数据阶段关掉同步提交（两侧一致，只影响写入，不影响查询对比）
    await c.query('SET synchronous_commit = off')
    await c.query('TRUNCATE event RESTART IDENTITY CASCADE')
    const t0 = Date.now()
    let n = 0
    for (const batch of shardRowBatches(idx)) {
      await insertRows(c, batch)
      n += batch.length
      if (n % 20_000 === 0) log(`  端口 ${port}: ${n}/${ROWS_PER_SHARD}`)
    }
    await c.query('ANALYZE event')
    log(`端口 ${port}/${db}: 灌入 ${n} 行，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    return { rows: n, ms: Date.now() - t0 }
  } finally {
    await c.end()
  }
}

// ---------------------------------------------------------------- 验证

function pass(name, ok, detail) {
  return { name, ok: !!ok, detail }
}

/**
 * 用 SHARD_URLS / SHARD_RANGES 调 src/db/shard.js，验证：
 *  · shardingEnabled / shardsForRange / shardForYear 的路由正确
 *  · 每片行数、年份区间无越界（无跨片泄漏）
 *  · 跨片 count 合并 == 各片之和 == 30 万
 *  · 跨片分页查询合并后按时间有序（timeline 的核心语义）
 */
export async function verify() {
  process.env.SHARD_URLS = shardUrls()
  process.env.SHARD_RANGES = shardRanges()
  const m = await import('../src/db/shard.js')
  const checks = []

  checks.push(pass('shardingEnabled() === true', m.shardingEnabled(), `SHARD_RANGES=${shardRanges()}`))
  const info = m.shardInfo()
  checks.push(pass('shardInfo() 返回 3 片', info.length === 3, JSON.stringify(info.map((x) => [x.idx, x.from, x.to]))))

  // 路由
  const r3 = m.shardsForRange(-5000, 3000)
  checks.push(pass('shardsForRange(-5000,3000) → 3 片', r3.length === 3, `idx=[${r3.map((s) => s.idx).join(',')}]`))

  const y1000 = m.shardForYear(1000)
  checks.push(pass('shardForYear(1000) → shard1', y1000?.idx === 1, `idx=${y1000?.idx}`))
  const yNeg = m.shardForYear(-3000)
  checks.push(pass('shardForYear(-3000) → shard0', yNeg?.idx === 0, `idx=${yNeg?.idx}`))
  const y1800 = m.shardForYear(1800)
  checks.push(pass('shardForYear(1800) → shard2', y1800?.idx === 2, `idx=${y1800?.idx}`))
  const y499 = m.shardForYear(499)
  checks.push(pass('shardForYear(499) → shard0（左闭右开边界）', y499?.idx === 0, `idx=${y499?.idx}`))
  const y500 = m.shardForYear(500)
  checks.push(pass('shardForYear(500) → shard1（区间左闭）', y500?.idx === 1, `idx=${y500?.idx}`))
  const y1500 = m.shardForYear(1500)
  checks.push(pass('shardForYear(1500) → shard2', y1500?.idx === 2, `idx=${y1500?.idx}`))
  const yOut = m.shardForYear(3000)
  checks.push(pass('shardForYear(3000) → null（超出覆盖域）', yOut === null, `返回 ${yOut === null ? 'null' : 'idx=' + yOut.idx}`))

  const single = m.shardsForRange(1000, 1400)
  checks.push(pass('shardsForRange(1000,1400) → 1 片（单片命中）', single.length === 1 && single[0].idx === 1, `idx=[${single.map((s) => s.idx)}]`))
  const two = m.shardsForRange(1400, 1600)
  checks.push(pass('shardsForRange(1400,1600) → 2 片（跨片）', two.length === 2, `idx=[${two.map((s) => s.idx)}]`))
  const empty = m.shardsForRange(4000, 5000)
  checks.push(pass('shardsForRange(4000,5000) → 0 片（域外不扇出）', empty.length === 0, `len=${empty.length}`))

  // 每片行数 / 区间完整性（注意：要传 shard.js 自己的分片对象——它带 url/pool，
  // 不能把本文件的拓扑常量直接喂给 queryShard，否则连接串是 undefined）
  let sum = 0
  const per = []
  for (const s of SHARDS) {
    const target = r3.find((t) => t.idx === s.idx)
    const r = await m.queryShard(target, `SELECT count(*)::int AS n,
        count(DISTINCT slug)::int AS d,
        min(t_start_year)::int AS lo, max(t_start_year)::int AS hi,
        count(*) FILTER (WHERE t_start_year < $1 OR t_start_year >= $2)::int AS leak
      FROM event`, [s.from, s.to])
    const row = r.rows[0]
    per.push({ idx: s.idx, port: s.port, n: row.n, d: row.d, lo: row.lo, hi: row.hi, leak: row.leak })
    sum += row.n
    checks.push(pass(
      `shard${s.idx}: ${row.n} 行、年份 [${row.lo},${row.hi}] 落在 [${s.from},${s.to})`,
      row.n === ROWS_PER_SHARD && row.d === ROWS_PER_SHARD && row.leak === 0 &&
        row.lo >= s.from && row.hi < s.to,
      `n=${row.n} distinct=${row.d} lo=${row.lo} hi=${row.hi} leak=${row.leak}`,
    ))
  }
  checks.push(pass('三片合计 = 300000', sum === 300_000, `sum=${sum}`))

  // 跨片 count 合并
  const targets = m.shardsForRange(-5000, 3000)
  const c = await m.queryShards(targets, 'SELECT count(*)::int AS n FROM event', [], {
    merge: (rows) => [{ n: rows.reduce((s, r) => s + (Number(r.n) || 0), 0) }],
  })
  checks.push(pass(
    'queryShards 合并 count = 300000（扇出 3 片）',
    c.rows[0]?.n === 300_000 && c.perShard.length === 3 && c.degraded.length === 0,
    `n=${c.rows[0]?.n} perShard=${JSON.stringify(c.perShard.map((x) => [x.idx, x.rows, x.ms]))} degraded=${c.degraded.length}`,
  ))

  // 跨片分页查询：与 timeline.js 同一套 SQL/合并/排序
  const LITE = `slug, title, t_start_year, t_end_year, t_start_month, t_start_day,
    t_precision, t_certainty, track, category, discipline, lat, lon`
  const pageSql = `SELECT ${LITE} FROM event
     WHERE status = 'published'
       AND t_start_year >= $1::int - $5::int
       AND t_start_year < $2::int
       AND COALESCE(t_end_year, t_start_year) >= $1::int
       AND ($3::text IS NULL OR track = $3)
     ORDER BY t_start_year, t_start_month NULLS FIRST, t_start_day NULLS FIRST, id
     LIMIT $4 OFFSET $6`
  const spanRow = await m.queryShards(targets, `SELECT COALESCE(max(GREATEST(COALESCE(t_end_year, t_start_year) - t_start_year, 0)), 0)::int AS m
      FROM event WHERE status = 'published'`, [], {
    merge: (rows) => [{ m: Math.max(...rows.map((r) => Number(r.m) || 0)) }],
  })
  const span = spanRow.rows[0].m

  // 边界宽事件：timeline 的谓词是「t_start_year ∈ [from-span, to) 且 t_end_year >= from」，
  // 也就是说起点在**上一片**、但一直跨到本窗口的宽事件也必须算命中。
  // 如果路由只用 shardsForRange(from,to)（只看 t_start_year），这些行会被静默丢掉。
  const COUNT_SQL = `SELECT count(*)::int AS n FROM event
      WHERE status = 'published'
        AND t_start_year >= $1::int - $4::int
        AND t_start_year < $2::int
        AND COALESCE(t_end_year, t_start_year) >= $1::int
        AND ($3::text IS NULL OR track = $3)`
  const sumN = (rows) => [{ n: rows.reduce((s, r) => s + (Number(r.n) || 0), 0) }]
  const W_FROM = 600
  const W_TO = 610
  const narrowTargets = m.shardsForRange(W_FROM, W_TO)
  const wideTargets = m.shardsForRange(W_FROM - span, W_TO)
  const cntOf = async (tg) => (await m.queryShards(tg, COUNT_SQL, [W_FROM, W_TO, null, span], { merge: sumN })).rows[0].n
  const nNarrow = await cntOf(narrowTargets)
  const nWide = await cntOf(wideTargets)
  checks.push(pass(
    `边界宽事件：窗口 [${W_FROM},${W_TO}) 的窄路由会漏行，按 maxSpan(${span}) 扩边即补回`,
    nWide > nNarrow,
    `窄路由 ${narrowTargets.length} 片=${nNarrow} 行；扩边 ${wideTargets.length} 片=${nWide} 行；` +
    `补回 ${nWide - nNarrow} 行（起点在 shard0、跨到 ${W_TO} 之后的宽事件）`,
  ))
  const LIMIT = 200
  // 与 timeline.js 完全一致：每片取 limit+1+offset，合并排序后再本地切片
  const fan = await m.queryShards(targets, pageSql, [-5000, 3000, null, LIMIT + 1, span, 0], {
    merge: (rows) => rows.sort((a, b) =>
      (a.t_start_year - b.t_start_year) ||
      ((a.t_start_month ?? 0) - (b.t_start_month ?? 0)) ||
      ((a.t_start_day ?? 0) - (b.t_start_day ?? 0))),
  })
  const pageRows = fan.rows.slice(0, LIMIT + 1)
  const years = pageRows.map((r) => r.t_start_year)
  const sorted = years.every((y, i) => i === 0 || years[i - 1] <= y)
  const globalMin = Math.min(...per.map((p) => p.lo))
  checks.push(pass(
    '跨片分页（limit 200）合并后按年份非降序，且首行 = 全局最早年份',
    pageRows.length === LIMIT + 1 && sorted && years[0] === globalMin,
    `扇出 ${fan.perShard.length} 片、原始合并 ${fan.rows.length} 行 → 切片 ${pageRows.length} 行；` +
    `firstYear=${years[0]} globalMin=${globalMin} sorted=${sorted}`,
  ))

  // 单片命中时只打 1 片（不该扇出）
  const one = await m.queryShards(m.shardsForRange(1000, 1400), 'SELECT count(*)::int AS n FROM event WHERE t_start_year >= 1000 AND t_start_year < 1400', [], {
    merge: (rows) => [{ n: rows.reduce((s, r) => s + Number(r.n || 0), 0) }],
  })
  checks.push(pass(
    '单片区间 [1000,1400) 只访问 1 片',
    one.perShard.length === 1 && one.rows[0].n > 0,
    `perShard=${JSON.stringify(one.perShard)} n=${one.rows[0].n}`,
  ))

  await m.closeShards()

  // 输出
  console.log('\n=== 分片路由 / 合并验证 ===')
  for (const ch of checks) {
    console.log(`${ch.ok ? 'PASS' : 'FAIL'}  ${ch.name}\n      ${ch.detail}`)
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`)
  console.log('分布:', JSON.stringify(per))
  return { checks, per, failed: failed.length }
}

// ---------------------------------------------------------------- 状态

export async function status() {
  const rows = []
  for (const s of SHARDS) {
    const up = await portOpen(s.port)
    let n = '-', lo = '-', hi = '-', size = '-'
    if (up) {
      try {
        const c = await connect(s.port)
        const r = await c.query(`SELECT count(*)::int AS n, min(t_start_year)::int AS lo,
            max(t_start_year)::int AS hi FROM event`)
        n = r.rows[0].n
        lo = r.rows[0].lo
        hi = r.rows[0].hi
        const sz = await c.query('SELECT pg_size_pretty(pg_database_size($1)) AS s', [DB_NAME])
        size = sz.rows[0].s
        await c.end()
      } catch (e) {
        n = `ERR ${e.message}`
      }
    }
    rows.push({ idx: s.idx, port: s.port, up, range: `[${s.from},${s.to})`, n, lo, hi, size })
  }
  console.log('\n=== 分片实例状态 ===')
  console.log('shard  端口   状态    区间            行数      年份范围        库大小')
  for (const r of rows) {
    console.log(
      `#${r.idx}    ${String(r.port).padEnd(6)} ${(r.up ? 'up' : 'DOWN').padEnd(7)} ` +
      `${r.range.padEnd(16)} ${String(r.n).padEnd(9)} ${String(r.lo + '..' + r.hi).padEnd(15)} ${r.size}`,
    )
  }
  console.log('\n启动命令（父进程退出后仍存活）:')
  for (const s of SHARDS) console.log('  ' + startCommand(s))
  return rows
}

// ---------------------------------------------------------------- CLI

async function cmdInit() {
  for (const s of SHARDS) initInstance(s)
  for (const s of SHARDS) await startInstance(s)
  for (const s of SHARDS) {
    await ensureDatabase(s.port)
    await applySchema(s.port)
  }
  log('init 完成：3 个实例已就绪（5441/5442/5443）')
}

async function cmdSeed() {
  for (const s of SHARDS) {
    if (!(await portOpen(s.port))) throw new Error(`shard${s.idx} 端口 ${s.port} 未监听，先 init/start`)
  }
  for (const s of SHARDS) {
    log(`shard${s.idx}: 灌入区间 [${s.from},${s.to})`)
    await seedShardInto(s.port, DB_NAME, s.idx)
  }
  log('seed 完成：30 万行（各 10 万）')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const cmd = process.argv[2] || 'status'
  try {
    if (cmd === 'init') await cmdInit()
    else if (cmd === 'start') {
      for (const s of SHARDS) await startInstance(s)
    } else if (cmd === 'seed') await cmdSeed()
    else if (cmd === 'verify') {
      const r = await verify()
      if (r.failed) process.exitCode = 1
    } else if (cmd === 'status') await status()
    else if (cmd === 'stop') {
      for (const s of SHARDS) stopInstance(s)
    } else if (cmd === 'all') {
      await cmdInit()
      await cmdSeed()
      const r = await verify()
      if (r.failed) process.exitCode = 1
    } else {
      console.log('用法: node scripts/shard-proto.js init|start|seed|verify|status|stop|all')
    }
  } catch (e) {
    console.error('ERROR:', e && e.message ? e.message : String(e))
    if (e && e.stack) console.error(e.stack.split('\n').slice(0, 8).join('\n'))
    process.exitCode = 1
  }
}
