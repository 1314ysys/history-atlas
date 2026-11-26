/**
 * CLI：导出静态时间轴分片
 *   node scripts/export-static.js   （等价 npm run export）
 *
 * 产物：web/generated/timeline/century-<n>.json + web/generated/index.json
 * 注意：outDir 为相对路径，按当前工作目录解析（npm script 在项目根执行）。
 */
import { db } from '../src/db/client.js'
import { exportStatic } from '../src/export/static.js'

const OUT_DIR = 'web/generated'

const startedAt = Date.now()

try {
  const { files, total, bytes } = await exportStatic({ outDir: OUT_DIR })
  const ms = Date.now() - startedAt
  const kb = (bytes / 1024).toFixed(1)

  console.log('[export] 静态时间轴导出完成')
  console.log(`[export] outDir : ${OUT_DIR}`)
  console.log(`[export] events : ${total}`)
  console.log(`[export] files  : ${files}（含 index.json）`)
  console.log(`[export] bytes  : ${bytes}（${kb} KB）`)
  console.log(`[export] 耗时    : ${ms} ms`)

  await db.close()
  process.exit(0)
} catch (err) {
  console.error('[export] 失败：', err?.message || err)
  await db.close().catch(() => {})
  process.exit(1)
}
