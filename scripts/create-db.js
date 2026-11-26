#!/usr/bin/env node
/** 创建目标数据库（不存在时） */
import pg from 'pg'

const PORT = process.env.PGPORT || '5433'
const DB = process.env.PGDATABASE || 'history_atlas'
const admin = `postgres://postgres@127.0.0.1:${PORT}/postgres`

const client = new pg.Client({ connectionString: admin })
await client.connect()
const r = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB])
if (!r.rowCount) {
  await client.query(`CREATE DATABASE "${DB}" ENCODING 'UTF8'`)
  console.log(`[db] created ${DB}`)
} else {
  console.log(`[db] ${DB} already exists`)
}
await client.end()
