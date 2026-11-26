import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { db } from '../db/client.js'

/**
 * EventLite 列 —— 与 src/api/timeline.js 的 LITE_COLUMNS 保持一致。
 * 契约见 spec §7：EventLite = { slug, title, t_start_year, t_end_year,
 * t_precision, t_certainty, track, category, lat, lon }（+ 月/日/学科便于排序渲染）。
 */
const LITE_COLUMNS = `slug, title, t_start_year, t_end_year,
  t_start_month, t_start_day, t_precision, t_certainty,
  track, category, discipline, lat, lon`

const TIMELINE_DIR = 'timeline'

/** 世纪分桶编号：floor(year / 100)，负数合法（前 403 年 → -5） */
export function centuryOf(year) {
  const y = Number(year)
  return Math.floor((Number.isFinite(y) ? y : 0) / 100)
}

/** 分片文件名：century-<n>.json，负数也合法，如 century--5.json */
export function shardName(century) {
  return `century-${century}.json`
}

/**
 * 导出静态时间轴分片到 outDir（浏览走静态，检索才走 API）。
 *
 * 产出：
 *   <outDir>/timeline/all.json          { count, events:[EventLite] }       宽视图一次取全量
 *   <outDir>/timeline/century-<n>.json  { century, from, to, count, events } 窄视图按世纪取块
 *   <outDir>/dynasties.json             { count, dynasties:[...] }           朝代带
 *   <outDir>/index.json                 { generated_at, total, files:{all,dynasties}, centuries:[...] }
 *
 * @param {{ outDir: string }} opts
 */
export async function exportStatic({ outDir }) {
  if (!outDir) throw new Error('exportStatic: outDir is required')

  const [{ rows }, dyn] = await Promise.all([
    db.query(
      `SELECT ${LITE_COLUMNS}
         FROM event
        WHERE status = 'published'
        ORDER BY t_start_year,
                 t_start_month NULLS FIRST,
                 t_start_day NULLS FIRST,
                 id`,
    ),
    db.query(
      `SELECT slug, name, name_en, start_year, end_year, era_group, color, certainty
         FROM dynasty ORDER BY start_year`,
    ),
  ])

  /** @type {Map<number, object[]>} */
  const buckets = new Map()
  for (const ev of rows) {
    const century = centuryOf(ev.t_start_year)
    if (!buckets.has(century)) buckets.set(century, [])
    buckets.get(century).push(ev)
  }

  await mkdir(path.join(outDir, TIMELINE_DIR), { recursive: true })

  let files = 0
  let bytes = 0
  const write = async (rel, obj) => {
    const body = JSON.stringify(obj)
    await writeFile(path.join(outDir, rel), body, 'utf8')
    files++
    bytes += Buffer.byteLength(body, 'utf8')
    return Buffer.byteLength(body, 'utf8')
  }

  // 1) 宽视图：全量一次取
  const allBytes = await write(`${TIMELINE_DIR}/all.json`, { count: rows.length, events: rows })

  // 2) 窄视图：按世纪分块
  const centuries = []
  for (const century of [...buckets.keys()].sort((a, b) => a - b)) {
    const events = buckets.get(century)
    const from = century * 100
    const to = from + 99
    const name = shardName(century)
    const relPath = `${TIMELINE_DIR}/${name}`
    await write(relPath, { century, from, to, count: events.length, events })
    centuries.push({ century, from, to, count: events.length, file: relPath })
  }

  // 3) 朝代带
  await write('dynasties.json', { count: dyn.rows.length, dynasties: dyn.rows })

  // 4) 索引（generated_at 兼作缓存版本号）
  const generatedAt = new Date().toISOString()
  await write('index.json', {
    generated_at: generatedAt,
    total: rows.length,
    files: {
      all: `${TIMELINE_DIR}/all.json`,
      dynasties: 'dynasties.json',
      allBytes,
    },
    centuries,
  })

  return { files, total: rows.length, bytes, generatedAt }
}
