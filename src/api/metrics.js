/**
 * src/api/metrics.js —— Prometheus 指标端点
 *
 *   GET /api/metrics       → Prometheus 文本格式 (text/plain; version=0.0.4)
 *   GET /api/metrics.json  → 同一份快照的 JSON（便于人看 / 排障）
 *
 * 设计约束（"单次采集必须轻量"）：
 *   - 会走文件系统的函数（pg_database_size / pg_total_relation_size / pg_indexes_size /
 *     pg_relation_size）实测在本机 ~80–150 ms（Windows 上每次都要 stat 数据目录里的文件），
 *     因此放进 TTL 缓存（默认 15s），由请求触发后台刷新（stale-while-revalidate）：
 *     命中缓存时单次采集只花 1–5 ms。
 *   - 行数：先看 pg_class.reltuples（零成本），估算行数 < EXACT_COUNT_LIMIT 的表才做
 *     count(*) 精确计数；估算值过大的表直接用 reltuples，避免在大表上扫全表。
 *   - 连接数 / WAL lag：单条 pg_stat_activity / pg_last_wal_* 查询，不扫表。
 *   - 任何子查询失败都降级为注释 + 0，绝不让抓取端点 500。
 *
 * server.js 的约定：handler 拿到 { req, res }，返回值会被 JSON.stringify 后发送；
 * 若 handler 自己 res.end() 了（res.writableEnded === true），server 不再二次发送。
 */

import { db } from '../db/client.js'

/** 必须精确计数的核心表（任务要求） */
const CORE_TABLES = ['event', 'event_claim', 'event_source']
/** schema.sql 里没建、但性能任务可能补上的索引：存在就输出，不存在只打注释 */
const OPTIONAL_INDEXES = ['event_timeline_cover_idx']
/** 尺寸类指标的缓存时长（ms） */
const SIZE_TTL_MS = Number(process.env.ATLAS_METRICS_SIZE_TTL_MS || 15_000)
/** 估算行数超过此值的表不再 count(*)，直接报 reltuples */
const EXACT_COUNT_LIMIT = Number(process.env.ATLAS_METRICS_EXACT_COUNT_LIMIT || 200_000)

/* ------------------------------------------------------------------ *
 * 尺寸采集（重，走 TTL 缓存）
 * ------------------------------------------------------------------ */

/**
 * 一条语句拿全部尺寸信息。json_build_object 里 int8 会编码成 JSON number。
 * 只读 pg_class / pg_namespace / pg_indexes_size / pg_relation_size，不扫表。
 */
const SIZE_SQL = `
SELECT json_build_object(
  'db_name',        current_database(),
  'server_version', current_setting('server_version'),
  'db_size_bytes',  pg_database_size(current_database()),
  'tables', (
    SELECT coalesce(json_agg(json_build_object(
             'name',        c.relname,
             'bytes',       pg_total_relation_size(c.oid),
             'heap_bytes',  pg_relation_size(c.oid),
             'index_bytes', pg_indexes_size(c.oid),
             'est_rows',    c.reltuples::bigint
           ) ORDER BY c.relname), '[]'::json)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
  ),
  'indexes', (
    SELECT coalesce(json_agg(json_build_object(
             'name',  c.relname,
             'table', (SELECT t.relname FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
                        WHERE i.indexrelid = c.oid),
             'bytes', pg_relation_size(c.oid)
           ) ORDER BY c.relname), '[]'::json)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'i'
  )
) AS info`

/** @type {{ at:number, info:any, error:string|null, inflight:Promise<any>|null }} */
const sizeCache = { at: 0, info: null, error: null, inflight: null }

function refreshSizes() {
  if (sizeCache.inflight) return sizeCache.inflight
  sizeCache.inflight = (async () => {
    try {
      const { rows } = await db.query(SIZE_SQL)
      sizeCache.info = rows[0]?.info ?? null
      sizeCache.error = sizeCache.info ? null : 'empty catalog result'
      sizeCache.at = Date.now()
    } catch (err) {
      sizeCache.error = err?.message || String(err)
      // 保留上一次成功的数据；没成功过就让它继续为 null（下次请求重试）
    } finally {
      sizeCache.inflight = null
    }
    return sizeCache
  })()
  return sizeCache.inflight
}

/**
 * 取尺寸信息：命中缓存立刻返回；缓存过期先返回旧值并后台刷新；
 * 完全没数据（进程刚起）才同步等一次。
 */
async function getSizes() {
  const age = Date.now() - sizeCache.at
  if (sizeCache.info && age < SIZE_TTL_MS) return sizeCache
  if (sizeCache.info) {
    // stale-while-revalidate：请求不等刷新
    void refreshSizes()
    return sizeCache
  }
  await refreshSizes()
  return sizeCache
}

// 进程启动即预热，避免第一次抓取踩到冷缓存
void refreshSizes()

/* ------------------------------------------------------------------ *
 * 轻量采集
 * ------------------------------------------------------------------ */

/** @param {string[]} notes */
async function collectConnections(notes) {
  try {
    const { rows } = await db.query(`
      SELECT count(*) FILTER (WHERE state = 'active')::int AS active,
             count(*) FILTER (WHERE state = 'idle')::int   AS idle,
             count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_tx
        FROM pg_stat_activity
       WHERE datname = current_database()`)
    const r = rows[0] || {}
    return {
      active: Number(r.active || 0),
      idle: Number(r.idle || 0),
      idle_in_transaction: Number(r.idle_in_tx || 0),
    }
  } catch (err) {
    notes.push(`connections unavailable: ${err?.message || err}`)
    return { active: 0, idle: 0, idle_in_transaction: 0 }
  }
}

/**
 * 复制延迟。单实例（非 standby）上 pg_last_wal_receive_lsn() 为 NULL →
 * pg_wal_lsn_diff 返回 NULL，我们按规范输出 0 并附注释。
 * @param {string[]} notes
 */
async function collectReplicaLag(notes) {
  try {
    const { rows } = await db.query(
      `SELECT pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())::bigint AS lag,
              pg_last_wal_receive_lsn() IS NULL AS no_receive_lsn`,
    )
    const row = rows[0] || {}
    if (row.lag == null) {
      notes.push(
        row.no_receive_lsn
          ? 'replica lag = 0: pg_last_wal_receive_lsn() is NULL (primary, not a standby / no walreceiver)'
          : 'replica lag = 0: no replay/receive LSN available',
      )
      return 0
    }
    return Math.max(0, Number(row.lag))
  } catch (err) {
    notes.push(`replica lag = 0: ${err?.message || err}`)
    return 0
  }
}

const qi = (ident) => `"${String(ident).replace(/"/g, '""')}"`

/**
 * 行数。估算行数足够小的表用 count(*) 精确值，大表用 pg_class.reltuples。
 * 一次 UNION ALL 查询搞定，不做多轮往返。
 * @param {any} sizes
 * @param {string[]} notes
 * @returns {Promise<{table:string, rows:number, exact:boolean}[]>}
 */
async function collectRows(sizes, notes) {
  /** @type {Map<string, number>} */
  const est = new Map()
  for (const t of sizes?.info?.tables || []) est.set(t.name, Number(t.est_rows ?? -1))

  // 核心表永远要精确值（它们决定了 /api/stats 的一致性）；其余表按估算行数决定
  const exact = []
  const estimated = []
  for (const [name, rows] of est) {
    // reltuples 为 -1 表示从未 ANALYZE 过（通常是刚建的小表）→ 直接精确计数
    const unknown = rows < 0
    if (CORE_TABLES.includes(name) || unknown || rows < EXACT_COUNT_LIMIT) exact.push(name)
    else estimated.push({ table: name, rows })
  }

  /** @type {{table:string, rows:number, exact:boolean}[]} */
  const out = []
  if (exact.length) {
    try {
      const sql =
        'SELECT ' +
        exact
          .map((t) => `${sqlLiteralText(t)} AS t, (SELECT count(*) FROM ${qi(t)})::bigint AS n`)
          .join(' UNION ALL ')
      const { rows } = await db.query(sql)
      for (const r of rows) out.push({ table: r.t, rows: Number(r.n || 0), exact: true })
    } catch (err) {
      notes.push(`exact row counts unavailable, falling back to reltuples: ${err?.message || err}`)
      for (const t of exact) {
        const r = est.get(t)
        if (r != null && r >= 0) out.push({ table: t, rows: r, exact: false })
      }
    }
  }
  for (const e of estimated) {
    notes.push(`atlas_rows_total{table="${e.table}"} is a reltuples estimate (>= ${EXACT_COUNT_LIMIT} rows)`)
    out.push({ ...e, exact: false })
  }
  // 缓存失效时 est 为空：至少保证核心表有数
  if (!est.size) {
    try {
      const sql =
        'SELECT ' +
        CORE_TABLES.map((t) => `${sqlLiteralText(t)} AS t, (SELECT count(*) FROM ${qi(t)})::bigint AS n`).join(
          ' UNION ALL ',
        )
      const { rows } = await db.query(sql)
      for (const r of rows) out.push({ table: r.t, rows: Number(r.n || 0), exact: true })
    } catch (err) {
      notes.push(`row counts unavailable: ${err?.message || err}`)
    }
  }
  return out.sort((a, b) => a.table.localeCompare(b.table))
}

/** 只用于 SQL 字面量里的常量表名（来自上面的常量数组，非用户输入） */
function sqlLiteralText(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

/* ------------------------------------------------------------------ *
 * 快照
 * ------------------------------------------------------------------ */

/**
 * 采集一份完整快照。所有子查询都会降级，不会抛错。
 * @returns {Promise<any>}
 */
export async function collectMetrics() {
  const t0 = process.hrtime.bigint()
  /** @type {string[]} */
  const notes = []

  const connP = collectConnections(notes)
  const lagP = collectReplicaLag(notes)
  const sizes = await getSizes()
  const rowsP = collectRows(sizes, notes)

  const [connections, replica_lag_bytes, rows] = await Promise.all([connP, lagP, rowsP])

  if (sizes.error) notes.push(`size metrics degraded: ${sizes.error}`)

  const info = sizes.info || {}
  const mem = process.memoryUsage()
  const collectMs = Number((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2))
  const rowsByName = new Map(rows.map((r) => [r.table, r]))

  const tables = (info.tables || []).map((t) => {
    const r = rowsByName.get(t.name)
    return {
      table: t.name,
      size_bytes: Number(t.bytes || 0),
      heap_bytes: Number(t.heap_bytes || 0),
      index_bytes: Number(t.index_bytes || 0),
      est_rows: Number(t.est_rows ?? -1),
      rows: r ? r.rows : Number(t.est_rows ?? 0),
      rows_exact: r ? r.exact : false,
    }
  })

  const indexes = (info.indexes || []).map((i) => ({
    index: i.name,
    table: i.table,
    size_bytes: Number(i.bytes || 0),
  }))

  return {
    ok: true,
    timestamp: new Date().toISOString(),
    db: {
      name: info.db_name || null,
      server_version: info.server_version || null,
      mode: (() => {
        try {
          return db.mode()
        } catch {
          return 'unknown'
        }
      })(),
      size_bytes: Number(info.db_size_bytes || 0),
    },
    tables,
    indexes,
    connections,
    process: {
      uptime_seconds: Math.round(process.uptime()),
      rss_bytes: mem.rss,
      heap_used_bytes: mem.heapUsed,
      node: process.version,
    },
    replica_lag_bytes,
    metrics: {
      collect_ms: collectMs,
      size_cache_age_seconds: sizeCache.at ? Math.round((Date.now() - sizeCache.at) / 100) / 10 : -1,
      size_ttl_seconds: Math.round(SIZE_TTL_MS / 100) / 10,
      degraded: notes.some((n) => /degrad|unavailable/.test(n)),
    },
    notes,
  }
}

/** @param {string} s */
const escLabel = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

/** @param {number} v */
function fmtValue(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '0'
  if (Number.isInteger(v)) return String(v)
  return String(Number(v.toFixed(3)))
}

/**
 * 渲染成 Prometheus 文本格式。
 * @param {any} snap
 * @returns {string}
 */
export function renderPrometheus(snap) {
  /** @type {string[]} */
  const out = []

  /**
   * @param {string} name
   * @param {'gauge'|'counter'} type
   * @param {string} help
   * @param {(string|null)[]} labelSets
   * @param {number[]} values
   */
  const metric = (name, type, help, labelSets, values) => {
    out.push(`# HELP ${name} ${help}`)
    out.push(`# TYPE ${name} ${type}`)
    for (let i = 0; i < values.length; i++) {
      const labels = labelSets[i]
      out.push(labels ? `${name}{${labels}} ${fmtValue(values[i])}` : `${name} ${fmtValue(values[i])}`)
    }
  }

  metric('atlas_db_size_bytes', 'gauge', 'Total size of the history_atlas database in bytes (pg_database_size).', [null], [snap.db.size_bytes])

  metric(
    'atlas_table_size_bytes',
    'gauge',
    'Total on-disk size per table (heap + indexes + toast), bytes.',
    snap.tables.map((t) => `table="${escLabel(t.table)}"`),
    snap.tables.map((t) => t.size_bytes),
  )

  metric(
    'atlas_table_index_size_bytes',
    'gauge',
    'Index-only size per table, bytes.',
    snap.tables.map((t) => `table="${escLabel(t.table)}"`),
    snap.tables.map((t) => t.index_bytes),
  )

  metric(
    'atlas_index_size_bytes',
    'gauge',
    'Size of each index, bytes (one series per existing index).',
    snap.indexes.map((i) => `index="${escLabel(i.index)}",table="${escLabel(i.table || '')}"`),
    snap.indexes.map((i) => i.size_bytes),
  )

  metric(
    'atlas_rows_total',
    'gauge',
    'Row count per table. Exact count(*) for core tables and for tables with <200k estimated rows; pg_class.reltuples estimate otherwise (see comments).',
    snap.tables.map((t) => `table="${escLabel(t.table)}"`),
    snap.tables.map((t) => t.rows),
  )

  metric(
    'atlas_rows_is_estimate',
    'gauge',
    '1 when atlas_rows_total for this table comes from pg_class.reltuples instead of a count(*).',
    snap.tables.map((t) => `table="${escLabel(t.table)}"`),
    snap.tables.map((t) => (t.rows_exact ? 0 : 1)),
  )

  metric(
    'atlas_db_connections',
    'gauge',
    'Connections to this database by state (pg_stat_activity).',
    ['state="active"', 'state="idle"', 'state="idle_in_transaction"'],
    [snap.connections.active, snap.connections.idle, snap.connections.idle_in_transaction],
  )

  metric('atlas_uptime_seconds', 'gauge', 'Node process uptime in seconds.', [null], [snap.process.uptime_seconds])
  metric('atlas_process_rss_bytes', 'gauge', 'Resident set size of the API process (process.memoryUsage().rss).', [null], [snap.process.rss_bytes])
  metric('atlas_process_heap_used_bytes', 'gauge', 'V8 heap used by the API process, bytes.', [null], [snap.process.heap_used_bytes])

  metric(
    'atlas_replica_lag_bytes',
    'gauge',
    'WAL replay lag in bytes = pg_last_wal_receive_lsn() - pg_last_wal_replay_lsn(). 0 when not a standby (no receive LSN).',
    [null],
    [snap.replica_lag_bytes],
  )

  metric('atlas_metrics_collect_seconds', 'gauge', 'Time spent collecting this metrics snapshot, seconds.', [null], [snap.metrics.collect_ms / 1000])
  metric('atlas_metrics_size_cache_age_seconds', 'gauge', 'Age of the cached size block, seconds (-1 = never populated).', [null], [snap.metrics.size_cache_age_seconds])
  metric('atlas_metrics_degraded', 'gauge', '1 when at least one collector had to degrade for this scrape.', [null], [snap.metrics.degraded ? 1 : 0])

  // 人类可读的注释（Prometheus 允许 # 注释）
  for (const note of snap.notes || []) out.push(`# atlas: ${note}`)
  for (const name of OPTIONAL_INDEXES) {
    if (!snap.indexes.some((i) => i.index === name)) out.push(`# atlas: index ${name} absent (not created by this schema)`)
  }
  if (snap.metrics.collect_ms > 20) out.push(`# atlas: slow collection ${snap.metrics.collect_ms}ms (> 20ms budget)`)

  return out.join('\n') + '\n'
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

/** @param {import('node:http').ServerResponse} res */
function sendPrometheus(res, body) {
  res.writeHead(200, {
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(body)
}

export const routes = [
  [
    'GET',
    '/api/metrics',
    async ({ res }) => {
      const snap = await collectMetrics()
      sendPrometheus(res, renderPrometheus(snap))
      // res 已结束，server.js 看到 writableEnded 就不会再发 JSON
      return { __status: 200 }
    },
  ],
  [
    'GET',
    '/api/metrics.json',
    async () => collectMetrics(),
  ],
]
