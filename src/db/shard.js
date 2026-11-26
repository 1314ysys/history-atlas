/**
 * shard.js —— 时间维度水平分片路由层
 *
 * 为什么按时间分片：本项目的核心查询都带时间窗口（区间浏览、按年检索），
 * 而时间是最自然的**无热点**切分维度——每片写入的是不同世纪的数据。
 *
 * 与「分区」的区别（重要）：
 *   · 分区（PARTITION BY RANGE）在同一台 PG 内，实测负收益（见 docs/report/partition.md）
 *   · 分片（sharding）是**多个独立 PG 实例**，能突破单机 CPU/内存/IO 上限
 *
 * 路由规则：按 `t_start_year` 的世纪区间映射到 shard。
 *   shard key = floor(t_start_year / SHARD_SPAN) * SHARD_SPAN
 *
 * 配置（环境变量，任一存在即启用分片）：
 *   SHARD_URLS="postgres://.../ha_s0,postgres://.../ha_s1,..."
 *   SHARD_RANGES="-5000:500,500:1500,1500:3000"   // 与 SHARD_URLS 一一对应
 * 未配置时 `shardingEnabled()` 返回 false，全部走单库（当前行为不变）。
 */
import pg from 'pg'

const RAW_URLS = String(process.env.SHARD_URLS || '').trim()
const RAW_RANGES = String(process.env.SHARD_RANGES || '').trim()

/** @type {{url:string, from:number, to:number, idx:number, pool:pg.Pool|null}[]} */
let shards = []

/** 解析配置；格式非法时整体禁用分片并告警（不抛错，保证服务可用） */
function parseConfig() {
  if (!RAW_URLS) return []
  const urls = RAW_URLS.split(',').map((s) => s.trim()).filter(Boolean)
  const ranges = RAW_RANGES
    ? RAW_RANGES.split(',').map((s) => s.trim()).filter(Boolean)
    : []
  if (!urls.length) return []
  if (ranges.length && ranges.length !== urls.length) {
    console.warn(`[shard] SHARD_RANGES(${ranges.length}) 与 SHARD_URLS(${urls.length}) 数量不一致，禁用分片`)
    return []
  }
  const out = []
  for (let i = 0; i < urls.length; i++) {
    let from = -Infinity
    let to = Infinity
    if (ranges.length) {
      const [a, b] = ranges[i].split(':').map(Number)
      if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b) {
        console.warn(`[shard] 区间非法：${ranges[i]}，禁用分片`)
        return []
      }
      from = a
      to = b
    }
    out.push({ url: urls[i], from, to, idx: i, pool: null })
  }
  // 未给区间时按数量均分到 [-5000, 3000)
  if (!ranges.length && out.length > 1) {
    const lo = -5000
    const hi = 3000
    const step = (hi - lo) / out.length
    out.forEach((s, i) => {
      s.from = lo + step * i
      s.to = i === out.length - 1 ? Infinity : lo + step * (i + 1)
    })
  }
  return out
}

shards = parseConfig()

export function shardingEnabled() {
  return shards.length > 0
}

/** 分片元信息（供 /api/health 与调试展示） */
export function shardInfo() {
  return shards.map((s) => ({
    idx: s.idx,
    from: s.from === -Infinity ? null : s.from,
    to: s.to === Infinity ? null : s.to,
    url: s.url.replace(/\/\/[^@]*@/, '//***@'),
  }))
}

function poolOf(shard) {
  if (!shard.pool) {
    shard.pool = new pg.Pool({
      connectionString: shard.url,
      max: Number(process.env.SHARD_POOL_MAX || 4),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 2000,
      // 关键：分片扇出时禁用片内并行。
      // 每片自己再开 3 个 worker → 3 片 × 3 进程 = 9 进程抢 6 核，造成进程超订。
      // 实测（docs/report/sharding.md §3）：全表计数自由计划 526 ms，
      // 强制串行后 42 ms（快 2.6 倍）。
      options: '-c max_parallel_workers_per_gather=0',
    })
  }
  return shard.pool
}

/**
 * 给定年份落在哪个分片。
 * @param {number} year
 * @returns {typeof shards[number]|null}
 */
export function shardForYear(year) {
  if (!shardingEnabled()) return null
  const y = Number(year)
  if (!Number.isFinite(y)) return null
  return shards.find((s) => y >= s.from && y < s.to) ?? null
}

/**
 * 给定年份区间覆盖哪些分片（可能多个）。
 * @param {number} from
 * @param {number} to
 */
export function shardsForRange(from, to) {
  if (!shardingEnabled()) return []
  const a = Math.min(Number(from), Number(to))
  const b = Math.max(Number(from), Number(to))
  if (!Number.isFinite(a) || !Number.isFinite(b)) return shards.slice()
  return shards.filter((s) => s.to > a && s.from < b)
}

/** 在指定分片上执行查询 */
export async function queryShard(shard, sql, params = []) {
  const res = await poolOf(shard).query(sql, params)
  return { rows: res.rows, rowCount: res.rowCount, shard: shard.idx }
}

/**
 * 扇出查询：并发打到多个分片，合并结果。
 *
 * @param {typeof shards} targets 目标分片
 * @param {string} sql 查询语句（各分片执行同一句）
 * @param {any[]} params
 * @param {{merge?: (rows:any[])=>any[], limit?: number}} [opts]
 * @returns {Promise<{rows:any[], perShard:{idx:number, rows:number, ms:number}[], degraded:string[]}>}
 */
export async function queryShards(targets, sql, params = [], opts = {}) {
  const started = Date.now()
  const perShard = []
  const degraded = []
  const results = await Promise.allSettled(
    targets.map(async (s) => {
      const t0 = Date.now()
      const r = await queryShard(s, sql, params)
      perShard.push({ idx: s.idx, rows: r.rows.length, ms: Date.now() - t0 })
      return r.rows
    }),
  )
  const rows = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') rows.push(...r.value)
    else {
      degraded.push(`shard${targets[i].idx}: ${r.reason?.message || r.reason}`)
      perShard.push({ idx: targets[i].idx, rows: 0, ms: -1 })
    }
  })
  const merged = opts.merge ? opts.merge(rows) : rows
  const final = opts.limit ? merged.slice(0, opts.limit) : merged
  return { rows: final, perShard, degraded, totalMs: Date.now() - started }
}

/** 关闭所有分片连接池 */
export async function closeShards() {
  for (const s of shards) {
    if (s.pool) {
      try { await s.pool.end() } catch { /* ignore */ }
      s.pool = null
    }
  }
}
