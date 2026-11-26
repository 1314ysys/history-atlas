#!/usr/bin/env node
/**
 * scripts/drop-redundant-index.js —— 删除冗余索引 event_year_idx
 *
 *   node scripts/drop-redundant-index.js --dry-run
 *   node scripts/drop-redundant-index.js --apply
 *
 * 依据：bench/optimize-probe.js 实测，planner 在纯年份过滤/排序时
 * 都选 event_timeline_cover_idx，event_year_idx 从未被使用。
 */
import { db } from '../src/db/client.js'

const APPLY = process.argv.includes('--apply')
const IDX = 'event_year_idx'

const exists = await db.query(
  `SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'i'`,
  [IDX],
)
if (!exists.rowCount) {
  console.log(`[drop-idx] ${IDX} 不存在，无需处理`)
  await db.close()
  process.exit(0)
}

const size = await db.query(`SELECT pg_relation_size($1)::bigint AS v`, [IDX])
console.log(`[drop-idx] ${IDX} 当前占用 ${(Number(size.rows[0].v) / 1024).toFixed(0)} KB`)

// 先验证 cover_idx 能承担
const plan = await db.query(
  `EXPLAIN (COSTS OFF) SELECT slug, title, t_start_year FROM event
    WHERE status='published' AND t_start_year >= 100 AND t_start_year < 200
    ORDER BY t_start_year LIMIT 200`,
)
const planText = plan.rows.map((r) => r['QUERY PLAN']).join('\n')
const usesCover = /event_timeline_cover_idx/.test(planText)
console.log(`[drop-idx] 当前计划${usesCover ? '已使用' : '未使用'} cover_idx`)
if (!usesCover) {
  console.log('[drop-idx] 警告：计划未走 cover_idx，请人工确认后再删')
  if (!APPLY) {
    console.log('[drop-idx] dry-run 结束')
    await db.close()
    process.exit(0)
  }
}

if (!APPLY) {
  console.log('[drop-idx] dry-run：将执行 DROP INDEX CONCURRENTLY ' + IDX)
  await db.close()
  process.exit(0)
}

console.log(`[drop-idx] 执行 DROP INDEX CONCURRENTLY ${IDX}…`)
await db.exec(`DROP INDEX CONCURRENTLY IF EXISTS ${IDX}`)
console.log('[drop-idx] 已删除')

// 删后再验证
const plan2 = await db.query(
  `EXPLAIN (COSTS OFF) SELECT slug, title, t_start_year FROM event
    WHERE status='published' AND t_start_year >= 100 AND t_start_year < 200
    ORDER BY t_start_year LIMIT 200`,
)
console.log('[drop-idx] 删除后计划：')
for (const r of plan2.rows) console.log('   ', r['QUERY PLAN'])

await db.close()
