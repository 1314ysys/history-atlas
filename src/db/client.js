import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const DATA_DIR = process.env.PG_DATA_DIR || path.join(ROOT, 'data', 'pg')
const NATIVE_DIR = path.join(ROOT, 'data', 'pg-native')
const NATIVE_URL = process.env.DATABASE_URL
  || `postgres://postgres@127.0.0.1:${process.env.PGPORT || 5433}/history_atlas`

/**
 * 运行模式：
 *   1) 显式 DATABASE_URL  → 原生 PostgreSQL
 *   2) PG_MODE=pglite     → 强制 PGlite（测试/离线）
 *   3) data/pg-native 已初始化 → 原生 PostgreSQL（本项目默认）
 *   4) 否则               → PGlite
 */
export function nativeMode() {
  if (process.env.DATABASE_URL) return true
  if (process.env.PG_MODE === 'pglite') return false
  return existsSync(path.join(NATIVE_DIR, 'PG_VERSION'))
}

export function connectionString() {
  return process.env.DATABASE_URL || NATIVE_URL
}

/** 只读副本连接串（默认本机 5434 的逻辑复制从库） */
export function replicaConnectionString() {
  return process.env.DATABASE_URL_REPLICA
    || `postgres://postgres@127.0.0.1:${process.env.REPLICA_PORT || 5434}/history_atlas`
}

/** @type {pg.Pool|null} */
let _readPool = null
let _replicaWarned = false

function getReadPool() {
  if (!_readPool) {
    _readPool = new pg.Pool({
      connectionString: replicaConnectionString(),
      max: Number(process.env.PG_READ_POOL_MAX || 4),
      idleTimeoutMillis: 10_000,
      // 副本不可达时不要挂太久：原值 1500ms 会让每个读请求先等 1.5 秒才回退主库
      // （docs/report/read-split.md §6 指出的最大隐患）。300ms 足够覆盖正常的建连耗时。
      connectionTimeoutMillis: 300,
    })
    _readPool.on('error', (e) => {
      if (!_replicaWarned) { console.warn('[db] 副本连接异常，读请求回退主库：', e.message); _replicaWarned = true }
    })
  }
  return _readPool
}

/** @type {PGlite|null} */
let _pg = null
/** @type {pg.Pool|null} */
let _pool = null

export function getPg() {
  if (!_pg) {
    _pg = new PGlite({ dataDir: DATA_DIR })
  }
  return _pg
}

export function getPool() {
  if (!_pool) {
    _pool = new pg.Pool({
      connectionString: connectionString(),
      max: Number(process.env.PG_POOL_MAX || 4),
      idleTimeoutMillis: 10_000,
    })
  }
  return _pool
}

/**
 * 统一 DB 入口。所有模块只通过这里访问数据库。
 * 原生 PG 与 PGlite 的返回形状都是 { rows, ... }，调用方无需区分。
 */
export const db = {
  /** @param {string} sql @param {any[]} [params] */
  async query(sql, params = []) {
    if (nativeMode()) {
      const res = await getPool().query(sql, params)
      return { rows: res.rows, rowCount: res.rowCount, fields: res.fields }
    }
    return getPg().query(sql, params)
  },
  /** 多语句执行（建表脚本用） */
  async exec(sql) {
    if (nativeMode()) {
      await getPool().query(sql)
      return
    }
    return getPg().exec(sql)
  },
  /** 事务：fn 收到一个带 query/exec 的对象 */
  async tx(fn) {
    if (nativeMode()) {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        const api = {
          query: (sql, params = []) => client.query(sql, params),
          exec: (sql) => client.query(sql),
        }
        const out = await fn(api)
        await client.query('COMMIT')
        return out
      } catch (err) {
        try { await client.query('ROLLBACK') } catch { /* ignore */ }
        throw err
      } finally {
        client.release()
      }
    }
    return getPg().transaction(async (tx) => {
      const api = {
        query: (sql, params = []) => tx.query(sql, params),
        exec: (sql) => tx.exec(sql),
      }
      return fn(api)
    })
  },
  /** 只读查询：优先走副本，副本不可达时自动回退主库 */
  async readQuery(sql, params = []) {
    if (!nativeMode()) return this.query(sql, params)
    try {
      const res = await getReadPool().query(sql, params)
      return { rows: res.rows, rowCount: res.rowCount, source: 'replica' }
    } catch (e) {
      if (!_replicaWarned) {
        console.warn('[db] 副本不可用，读请求回退主库：', e.message)
        _replicaWarned = true
      }
      const res = await this.query(sql, params)
      return { ...res, source: 'primary' }
    }
  },

  /** 副本状态：是否配置/可达/落后字节 */
  async replicaStatus() {
    if (!nativeMode()) return { configured: false, reachable: false, lagBytes: null, url: null }
    const url = replicaConnectionString()
    try {
      const c = await getReadPool().connect()
      try {
        const r = await c.query(
          `SELECT pg_last_wal_receive_lsn() AS recv, pg_last_wal_replay_lsn() AS replay`,
        )
        const { recv, replay } = r.rows[0]
        let lagBytes = null
        if (recv && replay) {
          const d = await c.query('SELECT pg_wal_lsn_diff($1, $2)::bigint AS b', [recv, replay])
          lagBytes = Number(d.rows[0].b)
        }
        const n = await c.query('SELECT count(*)::int AS n FROM event')
        return { configured: true, reachable: true, lagBytes, events: n.rows[0].n, url }
      } finally {
        c.release()
      }
    } catch (e) {
      return { configured: true, reachable: false, lagBytes: null, url, error: e.message }
    }
  },

  async close() {
    if (_readPool) {
      await _readPool.end()
      _readPool = null
    }
    if (_pool) {
      await _pool.end()
      _pool = null
    }
    if (_pg) {
      await _pg.close()
      _pg = null
    }
  },
  mode() {
    return nativeMode() ? 'postgres' : 'pglite'
  },
}

export async function tableExists(name) {
  const { rows } = await db.query(`SELECT to_regclass($1) AS t`, [`public.${name}`])
  return Boolean(rows[0]?.t)
}

/** 首次启动建表；已存在则跳过 */
export async function migrate({ force = false } = {}) {
  if (!force && (await tableExists('event'))) return { created: false }
  if (force) {
    await db.exec(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`)
  }
  const sql = await readFile(path.join(HERE, 'schema.sql'), 'utf8')
  await db.exec(sql)
  return { created: true }
}

/** 清空并重建（seed 用） */
export async function resetSchema() {
  await db.exec(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`)
  return migrate({ force: false })
}

export async function schemaVersion() {
  try {
    const { rows } = await db.query(`SELECT value FROM _meta WHERE key = 'schema_version'`)
    return rows[0]?.value ?? null
  } catch {
    return null
  }
}
