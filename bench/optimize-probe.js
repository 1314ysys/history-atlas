#!/usr/bin/env node
/**
 * bench/optimize-probe.js —— 验证几个优化点的实际收益（小规模快速验证）
 *
 *   node bench/optimize-probe.js --n=50000
 *
 * 验证项：
 *   A. tsvector 内联计算（免 UPDATE 回填）vs 当前两段式
 *   B. 删冗余索引（event_year_idx 被 cover_idx 覆盖）
 *   C. 去掉 ts_rank 排序
 */
import pg from 'pg'

const N = Number((process.argv.find((a) => a.startsWith('--n=')) || '--n=50000').split('=')[1])
const ADMIN = 'postgres://postgres@127.0.0.1:5433/postgres'
const now = () => Number(process.hrtime.bigint() / 1000000n)
const mb = (b) => `${(Number(b) / 1048576).toFixed(1)} MB`

const gen = await import('./gen.js')
const { tokenize, toTsv } = await import('../src/domain/tokenize.js')

const admin = new pg.Client({ connectionString: ADMIN })
await admin.connect()

async function freshDb(name) {
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.query(`CREATE DATABASE "${name}"`)
  const c = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:5433/${name}` })
  await c.connect()
  const { readFile } = await import('node:fs/promises')
  await c.query(await readFile('src/db/schema.sql', 'utf8'))
  return c
}

function multi(cols, rows, per = 250) {
  const parts = []
  const params = []
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per)
    const tuple = []
    for (let ri = 0; ri < chunk.length; ri++) {
      const slots = cols.map((_, ci) => `$${params.length + ri * cols.length + ci + 1}`)
      tuple.push(`(${slots.join(',')})`)
    }
    parts.push(tuple.join(','))
    for (const row of chunk) params.push(...row)
  }
  return { sql: `INSERT INTO event (${cols.join(',')}) VALUES ${parts.join(',')} RETURNING id`, params }
}

/* ---------------- A. 两段式 vs 内联 ---------------- */
console.log('=== A. tsvector 写入方式对比 ===')

// A1: 当前方式（INSERT 20 列 → UPDATE 回填）
{
  const c = await freshDb('ha_opt_a1')
  const t0 = now()
  for (let off = 0; off < N; off += 500) {
    const n = Math.min(500, N - off)
    const rows = gen.makeEventRows(off, n, N)
    const tsvs = rows.map((r) => toTsv(tokenize([r[1], r[16], r[3], r[4], r[13]].filter(Boolean).join(' '))))
    const q = multi(gen.EVENT_COLS, rows)
    const res = await c.query(q.sql, q.params)
    await c.query(
      `UPDATE event e SET search_tsv = to_tsvector('simple', t.tsv)
         FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS tsv) t
        WHERE e.id = t.id`,
      [res.rows.map((r) => r.id), tsvs],
    )
  }
  const a1 = now() - t0
  console.log(`  A1 两段式（INSERT + UPDATE）: ${a1} ms  → ${Math.round(N / (a1 / 1000))} ev/s`)
  await c.end()
  await admin.query(`DROP DATABASE IF EXISTS "ha_opt_a1" WITH (FORCE)`)
  globalThis.__a1 = a1
}

// A2: 内联（单行 INSERT，tsvector 在 VALUES 内算）
{
  const c = await freshDb('ha_opt_a2')
  const t0 = now()
  const cols = [...gen.EVENT_COLS, 'search_tsv']
  for (let off = 0; off < N; off += 500) {
    const n = Math.min(500, N - off)
    const rows = gen.makeEventRows(off, n, N)
    // 逐行插入（多行 VALUES 混表达式会参数类型推断失败）
    for (const r of rows) {
      const tsv = toTsv(tokenize([r[1], r[16], r[3], r[4], r[13]].filter(Boolean).join(' ')))
      const slots = gen.EVENT_COLS.map((_, i) => `$${i + 1}`)
      await c.query(
        `INSERT INTO event (${gen.EVENT_COLS.join(',')}, search_tsv)
         VALUES (${slots.join(',')}, to_tsvector('simple', $${gen.EVENT_COLS.length + 1}::text))`,
        [...r, tsv],
      )
    }
  }
  const a2 = now() - t0
  console.log(`  A2 内联（单行 INSERT，tsvector 在 SQL 内算）: ${a2} ms  → ${Math.round(N / (a2 / 1000))} ev/s`)
  console.log(`     对比 A1：${(globalThis.__a1 / a2).toFixed(2)}× ${a2 < globalThis.__a1 ? '更快' : '更慢'}`)
  await c.end()
  await admin.query(`DROP DATABASE IF EXISTS "ha_opt_a2" WITH (FORCE)`)
}

/* ---------------- B. 冗余索引 ---------------- */
console.log('\n=== B. 索引体积与冗余分析 ===')
{
  const c = await freshDb('ha_opt_b')
  // 灌少量数据以生成索引
  const M = Math.min(N, 50000)
  for (let off = 0; off < M; off += 250) {
    const rows = gen.makeEventRows(off, Math.min(250, M - off), M)
    const q = multi(gen.EVENT_COLS, rows)
    await c.query(q.sql, q.params)
  }
  await c.query(`CREATE INDEX IF NOT EXISTS event_timeline_cover_idx ON event (t_start_year)
    INCLUDE (slug, title, t_start_month, t_start_day, t_end_year,
             t_precision, t_certainty, track, category, discipline, lat, lon)
    WHERE status = 'published'`)
  await c.query('CREATE INDEX IF NOT EXISTS event_fts_idx ON event USING GIN (search_tsv)')
  await c.query('VACUUM ANALYZE event')

  const idx = await c.query(`
    SELECT c.relname AS name, pg_relation_size(c.oid)::bigint AS bytes
      FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
     WHERE i.indrelid = 'event'::regclass ORDER BY bytes DESC`)
  let total = 0
  for (const r of idx.rows) {
    total += Number(r.bytes)
    console.log(`  ${r.name.padEnd(30)} ${(Number(r.bytes) / 1024).toFixed(0).padStart(6)} KB`)
  }
  console.log(`  索引合计: ${(total / 1024).toFixed(0)} KB`)

  // 验证 event_year_idx 是否被 cover_idx 覆盖
  console.log('\n  冗余验证：查询只用 year 排序/过滤时，planner 选哪个索引？')
  const plan = await c.query(`EXPLAIN (COSTS OFF) SELECT slug, title, t_start_year
    FROM event WHERE status='published' AND t_start_year >= 100 AND t_start_year < 200
    ORDER BY t_start_year LIMIT 200`)
  for (const r of plan.rows) console.log('   ', r['QUERY PLAN'])

  // 尝试删 year_idx，看是否还能走 cover_idx
  await c.query('DROP INDEX IF EXISTS event_year_idx')
  const plan2 = await c.query(`EXPLAIN (COSTS OFF) SELECT slug, title, t_start_year
    FROM event WHERE status='published' AND t_start_year >= 100 AND t_start_year < 200
    ORDER BY t_start_year LIMIT 200`)
  console.log('\n  删除 event_year_idx 后的计划：')
  for (const r of plan2.rows) console.log('   ', r['QUERY PLAN'])

  await c.end()
  await admin.query(`DROP DATABASE IF EXISTS "ha_opt_b" WITH (FORCE)`)
}

/* ---------------- C. ts_rank 开销 ---------------- */
console.log('\n=== C. ts_rank 排序开销 ===')
{
  const c = await freshDb('ha_opt_c')
  const M = Math.min(N, 50000)
  for (let off = 0; off < M; off += 250) {
    const rows = gen.makeEventRows(off, Math.min(250, M - off), M)
    const q = multi(gen.EVENT_COLS, rows)
    const res = await c.query(q.sql, q.params)
    const tsvs = rows.map((r) => toTsv(tokenize([r[1], r[16], r[3], r[4], r[13]].filter(Boolean).join(' '))))
    await c.query(
      `UPDATE event e SET search_tsv = to_tsvector('simple', t.tsv)
         FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS tsv) t WHERE e.id = t.id`,
      [res.rows.map((r) => r.id), tsvs],
    )
  }
  await c.query('CREATE INDEX IF NOT EXISTS event_fts_idx ON event USING GIN (search_tsv)')
  await c.query('VACUUM ANALYZE event')

  const q1 = `SELECT slug, title FROM event
     WHERE status='published' AND search_tsv @@ to_tsquery('simple', $1)
     ORDER BY ts_rank(search_tsv, to_tsquery('simple', $1)) DESC, t_start_year LIMIT 20`
  const q2 = `SELECT slug, title FROM event
     WHERE status='published' AND search_tsv @@ to_tsquery('simple', $1)
     ORDER BY t_start_year LIMIT 20`

  const bench = async (sql, label) => {
    for (let i = 0; i < 5; i++) await c.query(sql, ['水运 & 运仪 & 仪象 & 象台'])
    const t = []
    for (let i = 0; i < 30; i++) {
      const a = now()
      await c.query(sql, ['水运 & 运仪 & 仪象 & 象台'])
      t.push(now() - a)
    }
    t.sort((x, y) => x - y)
    const p = (x) => t[Math.floor(x * t.length)].toFixed(2)
    console.log(`  ${label.padEnd(22)} p50=${p(0.5)}ms  p95=${p(0.95)}ms`)
    return Number(p(0.5))
  }
  const withRank = await bench(q1, '带 ts_rank')
  const withoutRank = await bench(q2, '不带 ts_rank（仅年份）')
  console.log(`  差异: ${((withRank / withoutRank - 1) * 100).toFixed(0)}% ${withRank > withoutRank ? '（ts_rank 更慢）' : ''}`)

  await c.end()
  await admin.query(`DROP DATABASE IF EXISTS "ha_opt_c" WITH (FORCE)`)
}

await admin.end()
console.log('\n[probe] 完成')
