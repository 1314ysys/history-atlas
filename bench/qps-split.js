#!/usr/bin/env node
/**
 * bench/qps-split.js —— 读写分离（主库 5433 / 逻辑复制从库 5434）实测
 *
 *   node bench/qps-split.js              # 全量：预检 + 串行延迟 + 并发 QPS + 复制延迟 + 一致性窗口
 *   node bench/qps-split.js --preflight   # 只做连通性/复制拓扑预检
 *   node bench/qps-split.js --json        # 结尾额外打印一份机器可读 JSON
 *   node bench/qps-split.js --skip=lag,consistency
 *
 * 设计要点：
 *  1) 入口走真实代码路径：直接取 src/api/search.js 的 routes 里 `/api/search` 的 handler，
 *     以 `handler({ query: { q, limit } })` 调用（不经过 HTTP，排除网络栈噪声）。
 *  2) 主库 vs 副本的分离比较在 SQL 层做：同一段 SQL（= fetchHits 用 buildHitQuery 生成的那条）
 *     分别用 db.query（主库池）与 db.readQuery（副本池，失败回退主库）执行。
 *  3) 并发 1/4/16 各 5 秒（工程约束：单组 ≤5 秒），三条曲线：主库 SQL / 副本 SQL / handler 全链路。
 *  4) 复制延迟：主库 INSERT place 探针（slug 唯一），100ms 轮询从库直到可见，5 轮取中位数/最大值，测完删除。
 *  5) 一致性窗口：主库 UPDATE event.title 加后缀 → 立刻读从库 → 轮询到一致 → 输出窗口毫秒数 → 还原 title。
 *
 * 注意：PG_POOL_MAX / PG_READ_POOL_MAX 在首次查询前写入 process.env。
 *       client.js 的池是惰性创建的（首次 query 时才读 env），因此这里的赋值生效，
 *       并发 16 时不会被默认池上限 4 卡住（否则测的是排队而不是数据库）。
 */
import process from 'node:process'

const POOL_MAX = 16
// 必须在第一次查询前设置；client.js 在 getPool() 里才读取这两个 env
if (!process.env.PG_POOL_MAX) process.env.PG_POOL_MAX = String(POOL_MAX)
if (!process.env.PG_READ_POOL_MAX) process.env.PG_READ_POOL_MAX = String(POOL_MAX)
if (!process.env.PG_MODE && !process.env.DATABASE_URL) {
  // 显式走原生 PG（本项目默认 pg-native 已初始化，这里只是把口径钉死）
  process.env.PG_MODE = 'postgres'
}

const { db, connectionString, replicaConnectionString, getPool } = await import('../src/db/client.js')
const { routes, planSearch, buildHitQuery } = await import('../src/api/search.js')
const pg = (await import('pg')).default

// ---------------------------------------------------------------- 参数
const QUERY = '水运仪象台'
const LIMIT = 20
const SEQ_ITERS = 200
const WARMUP = 20
const CONCS = [1, 4, 16]
const GROUP_MS = 5000
const LAG_ROUNDS = 5
const LAG_POLL_MS = 100
const LAG_FINE_POLL_MS = 2
const LAG_FINE_ROUNDS = 3
const REPL_TIMEOUT_MS = 8000
const CONSISTENCY_TIMEOUT_MS = 8000

const ARGS = new Set(process.argv.slice(2))
const SKIP = new Set(
  (process.argv.find((a) => a.startsWith('--skip=')) || '').slice('--skip='.length).split(',').filter(Boolean),
)

/**
 * handler 的检索读源由 src/api/search.js 的 SEARCH_READ_FROM 决定（默认 primary）。
 * 该 flag 在模块加载时求值，进程内不可切换 —— 所以要比较 handler 两种读源，
 * 请分别用 SEARCH_READ_FROM=primary / replica 各跑一次本脚本。
 */
const HANDLER_SRC = String(process.env.SEARCH_READ_FROM || 'primary').toLowerCase() === 'replica' ? 'replica' : 'primary'
const HANDLER_TAG = `handler 全链路[${HANDLER_SRC}]`

// ---------------------------------------------------------------- 工具
const hr = () => Number(process.hrtime.bigint()) / 1e6
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const round = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null)

/** 最近秩百分位（n 很小时也稳定） */
function stats(lat) {
  const a = lat.filter((v) => Number.isFinite(v)).sort((x, y) => x - y)
  const n = a.length
  const p = (q) => (n ? a[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))] : NaN)
  const sum = a.reduce((s, v) => s + v, 0)
  return {
    n,
    min: round(a[0]),
    p50: round(p(0.5)),
    p95: round(p(0.95)),
    p99: round(p(0.99)),
    max: round(a[n - 1]),
    mean: round(n ? sum / n : NaN),
  }
}

function median(xs) {
  const a = [...xs].sort((x, y) => x - y)
  if (!a.length) return NaN
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

function table(headers, rows) {
  const w = headers.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? '').length)))
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ')
  const out = [line(headers), w.map((x) => '-'.repeat(x)).join('  ')]
  for (const r of rows) out.push(line(r))
  return out.join('\n')
}

// ---------------------------------------------------------------- 预检
/** 订阅侧复制位点/时延（逻辑复制专用口径） */
async function subStats() {
  const c = new pg.Client({ connectionString: replicaConnectionString(), connectionTimeoutMillis: 2000 })
  try {
    await c.connect()
    const r = await c.query(
      `SELECT subname,
              pg_wal_lsn_diff(latest_end_lsn, received_lsn)::bigint AS lsn_gap,
              EXTRACT(EPOCH FROM (now() - last_msg_send_time)) * 1000 AS send_age_ms,
              EXTRACT(EPOCH FROM (now() - last_msg_receipt_time)) * 1000 AS recv_age_ms,
              latest_end_lsn::text AS latest_end_lsn, received_lsn::text AS received_lsn
         FROM pg_stat_subscription WHERE subname = $1`,
      [process.env.REPLICA_SUB || 'atlas_sub'],
    )
    const row = r.rows[0]
    if (!row) return null
    return {
      subname: row.subname,
      lsnGapBytes: row.lsn_gap == null ? null : Number(row.lsn_gap),
      sendAgeMs: round(Number(row.send_age_ms)),
      recvAgeMs: round(Number(row.recv_age_ms)),
    }
  } catch (e) {
    return { error: e?.message || String(e) }
  } finally {
    try { await c.end() } catch { /* ignore */ }
  }
}

async function preflight() {
  const info = { mode: db.mode(), primary: connectionString(), replica: replicaConnectionString() }
  console.log('\n=== 预检 ===')
  console.log('db.mode()      :', info.mode)
  console.log('主库连接串     :', info.primary)
  console.log('副本连接串     :', info.replica)
  if (info.mode !== 'postgres') {
    throw new Error(`当前是 ${info.mode} 模式，读写分离压测需要原生 PG（主/从各一实例）`)
  }

  const status = await db.replicaStatus()
  console.log('replicaStatus  :', JSON.stringify(status))
  if (!status.reachable) throw new Error(`副本不可达：${status.error || 'unknown'}`)

  // 复制拓扑：发布/订阅/已发布表
  const pub = await db.query(
    `SELECT p.pubname, c.relname
       FROM pg_publication p
       JOIN pg_publication_rel pr ON pr.prpubid = p.oid
       JOIN pg_class c ON c.oid = pr.prrelid
      ORDER BY 1, 2`,
  )
  const pubName = pub.rows[0]?.pubname ?? null
  const pubTables = [...new Set(pub.rows.map((r) => r.relname))]
  console.log('发布            :', pubName || '(none)', '→ 表:', pubTables.join(',') || '(none)')

  const primCounts = await db.query(
    `SELECT (SELECT count(*) FROM event)::int AS events,
            (SELECT count(*) FROM place)::int AS places`,
  )
  const repCounts = await db.readQuery(
    `SELECT (SELECT count(*) FROM event)::int AS events,
            (SELECT count(*) FROM place)::int AS places`,
  )
  console.log('主库行数        :', JSON.stringify(primCounts.rows[0]))
  console.log('副本行数        :', JSON.stringify(repCounts.rows[0]), `(source=${repCounts.source})`)
  if (repCounts.source !== 'replica') throw new Error('readQuery 未命中副本（走了主库回退），无法分离对比')

  const route = routes.find(([m, p]) => m === 'GET' && p === '/api/search')
  if (!route) throw new Error('未在 routes 中找到 GET /api/search')
  console.log('handler        :', 'GET /api/search 已取到（routes 索引 ' + routes.indexOf(route) + '）')
  console.log('handler 读源   :', HANDLER_SRC, '(SEARCH_READ_FROM=' + (process.env.SEARCH_READ_FROM || '未设置→primary') + ')')

  // handler 真实返回（确认不是 tooBroad 早退）
  const t0 = hr()
  const res = await handlerSearch()
  const ms = hr() - t0
  console.log(
    `handler 抽样    : ${round(ms)}ms  total=${res.total}  hits=${res.hits?.length}  tooBroad=${Boolean(res.tooBroad)}  facets.track=${res.facets?.track?.length ?? 0}`,
  )
  if (res.hits?.length) console.log('  首条命中     :', `${res.hits[0].slug} | ${res.hits[0].title} | score=${res.hits[0].score}`)

  // 池上限（有效值）
  console.log('主库池 max      :', getPool().options?.max, ' 副本池 max:', process.env.PG_READ_POOL_MAX)

  // 逻辑复制的订阅侧延迟（replicaStatus().lagBytes 对逻辑订阅恒为 null：
  // 订阅端没有 walreceiver，pg_last_wal_receive_lsn() 为空，必须看 pg_stat_subscription）
  const sub = await subStats()
  if (sub) console.log('订阅延迟        :', JSON.stringify(sub))

  return {
    status,
    pubName,
    pubTables,
    primCounts: primCounts.rows[0],
    repCounts: repCounts.rows[0],
    subscription: sub,
    handlerSample: { ms: round(ms), total: res.total, tooBroad: Boolean(res.tooBroad), firstSlug: res.hits?.[0]?.slug ?? null },
  }
}

// ---------------------------------------------------------------- 真实 handler
const searchRoute = routes.find(([m, p]) => m === 'GET' && p === '/api/search')
const searchHandler = searchRoute?.[2]

function handlerSearch() {
  return searchHandler({ query: { q: QUERY, limit: LIMIT } })
}

// ---------------------------------------------------------------- SQL 两条路径
let sqlPlan = null

async function buildSqlPlan() {
  let spec = await planSearch(QUERY)
  if (!spec.ftsGroups.length && !spec.patterns.length) {
    spec = { ftsGroups: [], patterns: [`%${QUERY}%`], synonyms: [] }
  }
  const { sql, params } = buildHitQuery(spec, LIMIT)
  sqlPlan = { sql, params, spec }
  console.log('\n=== 被测 SQL（= fetchHits 生成的那条）===')
  console.log(sql.replace(/\s+/g, ' ').trim())
  console.log('params:', JSON.stringify(params))
  return sqlPlan
}

const runPrimary = () => db.query(sqlPlan.sql, sqlPlan.params)
const runReplica = () => db.readQuery(sqlPlan.sql, sqlPlan.params)

async function warmup() {
  for (let i = 0; i < WARMUP; i++) {
    await runPrimary()
    await runReplica()
  }
  await handlerSearch()
}

// 1) 串行 200 次
async function seqBench(label, fn, iters = SEQ_ITERS) {
  const lat = []
  const sources = { replica: 0, primary: 0 }
  let rows = null
  const t0all = hr()
  for (let i = 0; i < iters; i++) {
    const t0 = hr()
    const res = await fn()
    lat.push(hr() - t0)
    if (res?.source) sources[res.source] = (sources[res.source] || 0) + 1
    if (!rows) rows = res?.rows?.length ?? 0
  }
  const wall = (hr() - t0all) / 1000
  const s = stats(lat)
  return { label, ...s, qps: round(s.n / wall), rows, sources, wall: round(wall) }
}

// 2) 定长并发压测
async function loadBench(label, fn, concurrency, ms = GROUP_MS) {
  const lat = []
  let errors = 0
  const end = Date.now() + ms
  const t0all = hr()
  const worker = async () => {
    while (Date.now() < end) {
      const t0 = hr()
      try {
        await fn()
        lat.push(hr() - t0)
      } catch {
        errors++
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  const wall = (hr() - t0all) / 1000
  const s = stats(lat)
  return { label, concurrency, ...s, qps: round(lat.length / wall), errors, wall: round(wall) }
}

// ---------------------------------------------------------------- 复制延迟
async function replicationLag({ rounds = LAG_ROUNDS, pollMs = LAG_POLL_MS, fine = true } = {}) {
  const prim = new pg.Client({ connectionString: connectionString() })
  const repl = new pg.Client({ connectionString: replicaConnectionString() })
  await prim.connect()
  await repl.connect()
  const tag = `bench-probe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const rows = []
  try {
    const measure = async (roundIdx, pollMsUsed) => {
      const slug = `${tag}-${roundIdx}`
      const t0 = hr()
      await prim.query('INSERT INTO place (slug, name) VALUES ($1, $2)', [slug, `探针 ${slug}`])
      const insertMs = hr() - t0
      let seen = false
      let waited = 0
      let firstSeenMs = null
      while (waited <= REPL_TIMEOUT_MS) {
        const r = await repl.query('SELECT 1 FROM place WHERE slug = $1', [slug])
        if (r.rowCount > 0) {
          seen = true
          firstSeenMs = hr() - t0
          break
        }
        await sleep(pollMsUsed)
        waited += pollMsUsed
      }
      return { round: roundIdx, slug, pollMs: pollMsUsed, seen, insertMs: round(insertMs), lagMs: round(firstSeenMs) }
    }

    // 规定口径：100ms 轮询，5 轮
    for (let i = 1; i <= rounds; i++) rows.push(await measure(i, pollMs))
    // 附加口径：细轮询，用于看穿 100ms 量化（结论以规定口径为准）
    const detail = []
    if (fine) for (let i = 1; i <= LAG_FINE_ROUNDS; i++) detail.push(await measure(1000 + i, LAG_FINE_POLL_MS))

    return { rows, fine: detail, tag }
  } finally {
    // 清理探针（主库删除 → 逻辑复制同步到副本）
    try {
      await prim.query(`DELETE FROM place WHERE slug LIKE $1`, [`${tag}%`])
    } catch { /* ignore */ }
    await prim.end()
    await repl.end()
  }
}

// ---------------------------------------------------------------- 一致性窗口
/** 单轮：UPDATE event.title → 立刻读副本 → 轮询到一致 → 还原 */
async function consistencyWindowOnce(prim, repl, { slugHint = null, pollMs = 2 } = {}) {
  const pick = slugHint
    ? await prim.query(`SELECT id, slug, title FROM event WHERE slug = $1`, [slugHint])
    : await prim.query(
        `SELECT id, slug, title FROM event WHERE status = 'published' AND title IS NOT NULL ORDER BY id LIMIT 1`,
      )
  if (!pick.rowCount) throw new Error('找不到可用于一致性测试的 event 行')
  const { id, slug: evSlug, title: original } = pick.rows[0]

  const suffix = `·probe${Date.now().toString().slice(-6)}`
  const updated = `${original}${suffix}`

  const t0 = hr()
  await prim.query('UPDATE event SET title = $1 WHERE id = $2', [updated, id])
  const commitMs = hr() - t0

  // 立刻读副本（第一次尝试）
  const first = await repl.query('SELECT title FROM event WHERE id = $1', [id])
  const immediate = first.rows[0]?.title ?? null
  const staleOnFirstRead = immediate !== updated
  const firstReadMs = hr() - t0

  // 轮询到一致
  let windowMs = null
  let polls = 0
  while (hr() - t0 < CONSISTENCY_TIMEOUT_MS) {
    const r = await repl.query('SELECT title FROM event WHERE id = $1', [id])
    polls++
    if ((r.rows[0]?.title ?? null) === updated) {
      windowMs = hr() - t0
      break
    }
    await sleep(pollMs)
  }

  // 还原 title，并确认副本已回到原值
  await prim.query('UPDATE event SET title = $1 WHERE id = $2', [original, id])
  let restoreMs = null
  const t1 = hr()
  while (hr() - t1 < CONSISTENCY_TIMEOUT_MS) {
    const r = await repl.query('SELECT title FROM event WHERE id = $1', [id])
    if ((r.rows[0]?.title ?? null) === original) {
      restoreMs = hr() - t1
      break
    }
    await sleep(pollMs)
  }
  const check = await prim.query('SELECT title FROM event WHERE id = $1', [id])

  return {
    slug: evSlug,
    id,
    originalTitle: original,
    updatedTitle: updated,
    commitMs: round(commitMs),
    staleOnFirstRead,
    immediateValue: immediate,
    firstReadMs: round(firstReadMs),
    windowMs: round(windowMs),
    polls,
    restoreMs: round(restoreMs),
    restored: check.rows[0]?.title === original,
  }
}

async function consistencyWindow(rounds = 1) {
  const prim = new pg.Client({ connectionString: connectionString() })
  const repl = new pg.Client({ connectionString: replicaConnectionString() })
  await prim.connect()
  await repl.connect()
  try {
    // 优先拿检索真实命中的第一条，保证"写后读"对检索路径有意义
    let slug = null
    try {
      const res = await handlerSearch()
      slug = res.hits?.[0]?.slug ?? null
    } catch { /* ignore */ }

    const list = []
    for (let i = 0; i < rounds; i++) list.push(await consistencyWindowOnce(prim, repl, { slugHint: slug }))
    if (rounds === 1) return list[0]

    const wins = list.map((x) => x.windowMs).filter(Number.isFinite)
    return {
      rounds,
      detail: list,
      staleRounds: list.filter((x) => x.staleOnFirstRead).length,
      windowMedianMs: round(median(wins)),
      windowMaxMs: round(Math.max(...wins)),
      windowMinMs: round(Math.min(...wins)),
      allRestored: list.every((x) => x.restored),
    }
  } finally {
    await prim.end()
    await repl.end()
  }
}

// ---------------------------------------------------------------- 主流程
async function main() {
  console.log('=== read-split bench ===')
  console.log(`query=${QUERY} limit=${LIMIT} seqIters=${SEQ_ITERS} concs=${CONCS.join('/')} group=${GROUP_MS}ms`)

  const pf = await preflight()
  if (ARGS.has('--preflight')) {
    console.log('\n(--preflight) 预检完成')
    await db.close()
    return
  }

  await buildSqlPlan()
  await warmup()

  const out = { query: QUERY, limit: LIMIT, preflight: pf, seq: {}, load: {}, lag: null, consistency: null }

  const distArg = process.argv.find((a) => a === '--dist' || a.startsWith('--dist='))
  if (distArg) {
    // 分布模式：用更多轮次 + 细轮询看真实分布（规定口径的 5×100ms 会量化）
    const N = Math.max(1, Math.min(50, Number(distArg.split('=')[1] || 20)))
    console.log(`\n=== 复制延迟分布（${N} 轮，5ms 细轮询）===`)
    const lag = await replicationLag({ rounds: N, pollMs: 5, fine: false })
    const lags = lag.rows.filter((r) => r.seen).map((r) => r.lagMs)
    const ls = stats(lags)
    console.log('全部样本(ms):', JSON.stringify(lags))
    console.log(`可见 ${lags.length}/${lag.rows.length}  p50=${ls.p50} p95=${ls.p95} max=${ls.max} mean=${ls.mean}`)

    console.log(`\n=== 一致性窗口分布（${N} 轮）===`)
    const cw = await consistencyWindow(N)
    console.log('窗口样本(ms):', JSON.stringify(cw.detail.map((d) => d.windowMs)))
    console.log(
      `stale read 出现 ${cw.staleRounds}/${cw.rounds} 轮；窗口 p50=${cw.windowMedianMs} ms  min=${cw.windowMinMs}  max=${cw.windowMaxMs}  全部还原=${cw.allRestored}`,
    )
    await db.close()
    if (ARGS.has('--json')) console.log('\n===JSON===\n' + JSON.stringify({ lag: ls, lags, consistency: cw }, null, 2))
    return
  }

  if (ARGS.has('--interleave-handler')) {
    // handler 端到端 A/B，且必须"同进程、同窗口"——跨进程分组跑会被机器抖动吃掉（实测同模式同并发可差 82%）。
    // 做法：用带 query 的 import 让模块被求值两次，两次之间翻转 SEARCH_READ_FROM，
    // 得到两个独立的 search.js 实例（各有自己的同义词/过宽/词表缓存），共享同一组连接池。
    console.log('\n=== handler 端到端配对交错（primary vs replica，同窗口逐次交替）===')
    const saved = process.env.SEARCH_READ_FROM
    process.env.SEARCH_READ_FROM = 'primary'
    const modP = await import('../src/api/search.js?read=primary')
    process.env.SEARCH_READ_FROM = 'replica'
    const modR = await import('../src/api/search.js?read=replica')
    if (saved === undefined) delete process.env.SEARCH_READ_FROM
    else process.env.SEARCH_READ_FROM = saved

    const pick = (mod) => mod.routes.find(([m, p]) => m === 'GET' && p === '/api/search')[2]
    const hP = pick(modP)
    const hR = pick(modR)
    const call = (h) => h({ query: { q: QUERY, limit: LIMIT } })
    // 热身两侧（各自第一次会打 count / 同义词查询）
    for (let i = 0; i < 5; i++) { await call(hP); await call(hR) }

    const rows = []
    const ratios = []
    for (const c of CONCS) {
      const lp = []
      const lr = []
      const end = Date.now() + GROUP_MS
      let errors = 0
      const worker = async () => {
        while (Date.now() < end) {
          const t1 = hr()
          try { await call(hP); lp.push(hr() - t1) } catch { errors++ }
          const t2 = hr()
          try { await call(hR); lr.push(hr() - t2) } catch { errors++ }
        }
      }
      await Promise.all(Array.from({ length: c }, worker))
      const sp = stats(lp)
      const sr = stats(lr)
      rows.push(['handler·primary', c, sp.p50, sp.p95, sp.p99, sp.mean, sp.n])
      rows.push(['handler·replica', c, sr.p50, sr.p95, sr.p99, sr.mean, sr.n])
      const r50 = round(sr.p50 / sp.p50, 2)
      const r95 = round(sr.p95 / sp.p95, 2)
      ratios.push({ concurrency: c, p50Ratio: r50, p95Ratio: r95, sampleRatio: round(sr.n / sp.n, 2), errors })
      console.log(`并发 ${String(c).padStart(2)}：p50 ${sp.p50}→${sr.p50} ms (${r50}x)  p95 ${sp.p95}→${sr.p95} ms (${r95}x)  样本比 ${round(sr.n / sp.n, 2)}x  errors=${errors}`)
    }
    console.log(table(['路径', '并发', 'p50', 'p95', 'p99', 'mean', 'n'], rows))
    out.interleavedHandler = ratios
    await db.close()
    return
  }

  if (ARGS.has('--interleave')) {
    // 配对交错：同一个 5s 窗口内，每次迭代先跑主库再跑副本，两组样本共享同一时刻的机器状态，
    // 直接抵消 VM 抖动/热漂移（分组跑 A 再跑 B 会被这种漂移污染，见 --aa）
    console.log('\n=== 配对交错 A/B（同窗口、逐次交替，各并发 5s）===')
    const rows = []
    const ratios = []
    for (const c of CONCS) {
      const lp = []
      const lr = []
      const end = Date.now() + GROUP_MS
      let errors = 0
      const worker = async () => {
        while (Date.now() < end) {
          const t1 = hr()
          try { await runPrimary(); lp.push(hr() - t1) } catch { errors++ }
          const t2 = hr()
          try { await runReplica(); lr.push(hr() - t2) } catch { errors++ }
        }
      }
      await Promise.all(Array.from({ length: c }, worker))
      const sp = stats(lp)
      const sr = stats(lr)
      const wall = GROUP_MS / 1000
      rows.push([`主库`, c, round(lp.length / wall), sp.p50, sp.p95, sp.p99, sp.mean, sp.n])
      rows.push([`副本`, c, round(lr.length / wall), sr.p50, sr.p95, sr.p99, sr.mean, sr.n])
      const r50 = round(sr.p50 / sp.p50, 2)
      const r95 = round(sr.p95 / sp.p95, 2)
      ratios.push({ concurrency: c, p50Ratio: r50, p95Ratio: r95, qpsRatio: round(sr.n / sp.n, 2), errors })
      console.log(`并发 ${String(c).padStart(2)}：p50 ${sp.p50}→${sr.p50} ms (${r50}x)  p95 ${sp.p95}→${sr.p95} ms (${r95}x)  样本比 ${round(sr.n / sp.n, 2)}x  errors=${errors}`)
    }
    console.log(table(['路径', '并发', 'QPS', 'p50', 'p95', 'p99', 'mean', 'n'], rows))
    out.interleaved = ratios
    await db.close()
    return
  }

  if (ARGS.has('--aa')) {
    // A/A 基线：同一路径（主库）连跑两组，用它的比值波动衡量 A/B = 副本/主库 的可信度
    console.log('\n=== A/A 基线（主库跑两遍 vs 副本跑两遍，看方法噪声）===')
    const rows = []
    const sums = {}
    for (const c of CONCS) {
      const p1 = await loadBench('主库#1', runPrimary, c)
      const p2 = await loadBench('主库#2', runPrimary, c)
      const r1 = await loadBench('副本#1', runReplica, c)
      const r2 = await loadBench('副本#2', runReplica, c)
      for (const x of [p1, p2, r1, r2]) rows.push(x)
      sums[c] = {
        primary1: p1.qps, primary2: p2.qps, replica1: r1.qps, replica2: r2.qps,
        aaRatio: round(p2.qps / p1.qps, 2),
        abRatio1: round(r1.qps / p1.qps, 2),
        abRatio2: round(r2.qps / p1.qps, 2),
        p95: [p1.p95, p2.p95, r1.p95, r2.p95],
      }
    }
    console.log(table(['路径', '并发', 'QPS', 'p50', 'p95', 'p99', 'errors'], rows.map((r) => [r.label, r.concurrency, r.qps, r.p50, r.p95, r.p99, r.errors])))
    for (const c of CONCS) {
      const s = sums[c]
      console.log(`并发 ${String(c).padStart(2)}：主库#1=${s.primary1} #2=${s.primary2} / 副本#1=${s.replica1} #2=${s.replica2}  |  A/A=${s.aaRatio}x  A/B=${s.abRatio1}x,${s.abRatio2}x`)
    }
    out.aa = sums
    await db.close()
    return
  }

  if (!SKIP.has('seq')) {
    console.log('\n=== A/B 串行延迟（各 200 次，已热身 20 次）===')
    const a = await seqBench('主库 db.query', runPrimary)
    const b = await seqBench('副本 db.readQuery', runReplica)
    out.seq = { primary: a, replica: b }
    console.log(
      table(
        ['路径', 'n', 'p50', 'p95', 'p99', 'max', 'QPS', 'rows', 'source'],
        [
          [a.label, a.n, a.p50, a.p95, a.p99, a.max, a.qps, a.rows, `primary=${a.sources.primary}`],
          [b.label, b.n, b.p50, b.p95, b.p99, b.max, b.qps, b.rows, `replica=${b.sources.replica} primary=${b.sources.primary}`],
        ],
      ),
    )
    console.log(`副本/主库 p50 比 = ${round(b.p50 / a.p50, 2)}x，QPS 比 = ${round(b.qps / a.qps, 2)}x`)
  }

  if (!SKIP.has('load')) {
    console.log(`\n=== 并发压测（每组 ${GROUP_MS / 1000}s；SQL 层为主库 vs 副本，另附 handler 全链路）===`)
    const loadRows = []
    for (const c of CONCS) {
      const p = await loadBench(`SQL·主库`, runPrimary, c)
      const r = await loadBench(`SQL·副本`, runReplica, c)
      const h = await loadBench(HANDLER_TAG, handlerSearch, c)
      out.load[c] = { primary: p, replica: r, handler: h }
      for (const x of [p, r, h]) loadRows.push(x)
    }
    console.log(
      table(
        ['路径', '并发', 'QPS', 'p50', 'p95', 'p99', 'mean', 'n', 'errors'],
        loadRows.map((r) => [r.label, r.concurrency, r.qps, r.p50, r.p95, r.p99, r.mean, r.n, r.errors]),
      ),
    )
    for (const c of CONCS) {
      const { primary: p, replica: r } = out.load[c]
      console.log(`并发 ${String(c).padStart(2)}：副本/主库 QPS = ${round(r.qps / p.qps, 2)}x，p95 = ${p.p95} → ${r.p95} ms`)
    }
  }

  if (!SKIP.has('lag')) {
    console.log('\n=== 复制延迟（主库 INSERT place 探针 → 从库 100ms 轮询）===')
    const lag = await replicationLag()
    out.lag = lag
    const ok = lag.rows.filter((r) => r.seen)
    const lags = ok.map((r) => r.lagMs)
    console.log(
      table(
        ['轮次', 'pollMs', '可见', 'INSERT ms', '可见耗时 ms'],
        lag.rows.map((r) => [r.round, r.pollMs, r.seen, r.insertMs, r.lagMs]),
      ),
    )
    console.log(
      `100ms 组：中位数 ${round(median(lags), 1)} ms，最大值 ${round(Math.max(...lags), 1)} ms，可见 ${ok.length}/${lag.rows.length}`,
    )
    const fineLags = lag.fine.filter((r) => r.seen).map((r) => r.lagMs)
    console.log(
      `  2ms 细测组（仅看穿量化）：${JSON.stringify(fineLags)} ms，中位数 ${round(median(fineLags), 1)} ms`,
    )
    out.lagSummary = {
      pollMs: LAG_POLL_MS,
      rounds: lag.rows.length,
      visible: ok.length,
      medianMs: round(median(lags), 1),
      maxMs: round(Math.max(...lags), 1),
      fineMedianMs: round(median(fineLags), 1),
      fineMaxMs: round(Math.max(...fineLags), 1),
    }
  }

  if (!SKIP.has('consistency')) {
    console.log('\n=== 一致性窗口（主库 UPDATE event.title → 立即读从库）===')
    const cw = await consistencyWindow()
    out.consistency = cw
    console.log(JSON.stringify(cw, null, 2))
    console.log(
      cw.staleOnFirstRead
        ? `窗口：写后立即读从库读到旧值，${cw.windowMs} ms 后一致（stale read 成立）`
        : `窗口：写后立即读从库已是最新值（本次未捕捉到 stale read），轮询口径窗口 ${cw.windowMs} ms`,
    )
    console.log(`还原：${cw.restored ? 'OK' : '失败'}（restoreMs=${cw.restoreMs}）`)
  }

  await db.close()

  if (ARGS.has('--json')) {
    console.log('\n===JSON===')
    console.log(JSON.stringify(out, null, 2))
  }
  console.log('\n完成。')
}

main().catch(async (e) => {
  console.error('\n[bench] 失败：', e?.stack || e?.message || e)
  try { await db.close() } catch { /* ignore */ }
  process.exit(1)
})
