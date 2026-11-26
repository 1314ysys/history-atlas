#!/usr/bin/env node
/**
 * scripts/pg-replica.js —— 用逻辑复制搭一个本机只读副本（无法用 pg_basebackup 时的替代方案）
 *
 *   node scripts/pg-replica.js init     初始化从库数据目录
 *   node scripts/pg-replica.js start    启动从库（默认 5434）
 *   node scripts/pg-replica.js stop     停止
 *   node scripts/pg-replica.js status   复制状态
 *   node scripts/pg-replica.js setup    建库 + 建 schema + 建发布/订阅
 *
 * 说明：内置 PG 二进制只带 initdb / pg_ctl / postgres（无 pg_basebackup），
 *       因此用「逻辑复制」而不是物理流复制。限制见 docs/report/ha.md。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin')
const DATA = path.join(ROOT, 'data', 'pg-standby')
const LOG = path.join(ROOT, 'data', 'pg-standby.log')
const PORT = process.env.REPLICA_PORT || '5434'
const PRIMARY_PORT = process.env.PGPORT || '5433'
const DB = 'history_atlas'

const exe = (n) => path.join(BIN, `${n}.exe`)
const run = (n, args) => {
  const r = spawnSync(exe(n), args, { encoding: 'utf8' })
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() }
}

const cmd = process.argv[2] || 'status'

if (cmd === 'init') {
  if (existsSync(path.join(DATA, 'PG_VERSION'))) {
    console.log(`[replica] 数据目录已存在：${DATA}`)
    process.exit(0)
  }
  const r = run('initdb', ['-D', DATA, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C'])
  console.log(r.out.split('\n').slice(-3).join('\n'))
  if (r.code !== 0) process.exit(r.code)
  console.log(`[replica] 初始化完成：${DATA}`)
} else if (cmd === 'start') {
  const r = run('pg_ctl', ['-D', DATA, '-o', `-p ${PORT}`, '-l', LOG, '-w', '-t', '30', 'start'])
  console.log(r.out)
  console.log(`[replica] 端口 ${PORT}`)
} else if (cmd === 'stop') {
  console.log(run('pg_ctl', ['-D', DATA, '-m', 'fast', 'stop']).out)
} else if (cmd === 'setup') {
  process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${PRIMARY_PORT}/${DB}`
  const { db } = await import('../src/db/client.js')

  // 1) 主库：只发布业务表（排除 schema_migration / search_synonym 这类迁移元数据，
  //    它们不在 schema.sql 里，从库没有对应表会让 CREATE SUBSCRIPTION 失败）
  const BIZ_TABLES = [
    '_meta', 'archive_blob', 'boundary_slice', 'dynasty', 'event', 'event_claim',
    'event_person', 'event_source', 'ingest_batch', 'person', 'person_relation',
    'place', 'source', 'staging_event', 'tech',
    // 检索侧的两张附属表：复制到从库后，检索才能整体走只读副本
    'search_synonym', 'search_vocab',
  ]
  await db.query(`DROP PUBLICATION IF EXISTS atlas_pub`)
  await db.query(`CREATE PUBLICATION atlas_pub FOR TABLE ${BIZ_TABLES.join(', ')}`)
  console.log(`[replica] 已重建发布 atlas_pub（${BIZ_TABLES.length} 张业务表）`)

  // 2) 从库：重建数据库（干净起点），再建 schema
  const pg = (await import('pg')).default
  const admin = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:${PORT}/postgres` })
  await admin.connect()
  // 先删订阅（若存在），否则删库会被依赖阻塞
  try {
    const subs = await admin.query(`SELECT 1 FROM pg_subscription WHERE subname='atlas_sub'`)
    if (subs.rowCount) {
      const subDb = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:${PORT}/${DB}` })
      await subDb.connect()
      await subDb.query('ALTER SUBSCRIPTION atlas_sub DISABLE')
      await subDb.query('ALTER SUBSCRIPTION atlas_sub SET (slot_name = NONE)')
      await subDb.query('DROP SUBSCRIPTION atlas_sub')
      await subDb.end()
      console.log('[replica] 已移除旧订阅')
    }
  } catch { /* 订阅不存在或不可达，忽略 */ }
  await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`)
  await admin.query(`CREATE DATABASE "${DB}" ENCODING 'UTF8'`)
  console.log('[replica] 从库数据库已重建')
  await admin.end()

  const { readFile } = await import('node:fs/promises')
  const ddl = await readFile(path.join(ROOT, 'src', 'db', 'schema.sql'), 'utf8')
  const subClient = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:${PORT}/${DB}` })
  await subClient.connect()
  await subClient.query(ddl)
  // 迁移记录表由 apply-search-migration.js 创建，不在 schema.sql 里；
  // 不加这张表，CREATE SUBSCRIPTION（FOR ALL TABLES）会因为从库缺表而失败。
  await subClient.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      filename   TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
  console.log('[replica] 从库 schema 已建立')
  await subClient.end()

  // 3) 从库：订阅
  const pg2 = (await import('pg')).default
  const sub2 = new pg2.Client({ connectionString: `postgres://postgres@127.0.0.1:${PORT}/${DB}` })
  await sub2.connect()
  const have = await sub2.query(`SELECT 1 FROM pg_subscription WHERE subname='atlas_sub'`)
  if (!have.rowCount) {
    await sub2.query(
      `CREATE SUBSCRIPTION atlas_sub
       CONNECTION 'host=127.0.0.1 port=${PRIMARY_PORT} dbname=${DB} user=postgres'
       PUBLICATION atlas_pub`,
    )
    console.log('[replica] 已创建订阅 atlas_sub（会全量拷贝一次）')
  } else {
    console.log('[replica] 订阅已存在')
  }
  await sub2.end()
  await db.close()
  console.log('[replica] setup 完成')
} else if (cmd === 'status') {
  process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${PRIMARY_PORT}/${DB}`
  const { db } = await import('../src/db/client.js')
  const pub = await db.query(`SELECT count(*)::int AS n FROM pg_publication WHERE pubname='atlas_pub'`)
  const slots = await db.query(`SELECT slot_name, active FROM pg_replication_slots`)
  console.log('发布:', pub.rows[0].n, ' 复制槽:', JSON.stringify(slots.rows))

  const pg = (await import('pg')).default
  try {
    const sub = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:${PORT}/${DB}` })
    await sub.connect()
    const s = await sub.query(`SELECT subname, subenabled FROM pg_subscription`)
    const c = await sub.query(`SELECT count(*)::int AS n FROM event`)
    const st = await sub.query(`SELECT srsubstate, count(*)::int AS n FROM pg_subscription_rel GROUP BY 1`)
    console.log('订阅:', JSON.stringify(s.rows), ' 从库 event 行数:', c.rows[0].n, ' 表状态:', JSON.stringify(st.rows))
    await sub.end()
  } catch (e) {
    console.log('从库不可达:', e.message)
  }
  await db.close()
} else {
  console.log('用法: node scripts/pg-replica.js init|start|stop|setup|status')
}
