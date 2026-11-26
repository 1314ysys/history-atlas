#!/usr/bin/env node
/** 打印某个数据库的体积与每事件占用 */
import pg from 'pg'

const dbName = process.argv[2] || 'history_atlas'
const rows = Number(process.argv[3] || 0)
const c = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:${process.env.PGPORT || 5433}/postgres` })
await c.connect()
const r = await c.query(
  'SELECT pg_size_pretty(pg_database_size($1)) AS pretty, pg_database_size($1) AS bytes',
  [dbName],
)
const { pretty, bytes } = r.rows[0]
const per = rows ? `${Math.round(Number(bytes) / rows)} B/事件` : ''
console.log(`${dbName}: ${pretty} (${bytes} bytes) ${per}`)
await c.end()
