/**
 * scripts/gen-worker.mjs —— 数据生成 worker
 *
 * 由 copy-import-parallel.js 通过 worker_threads 启动。
 * 负责：生成指定区间的事件 / 说法 / 出处，并直接序列化为 CSV 行。
 *
 * 输入（workerData）：
 *   { startIdx, count, total, evIds, claimIds, sourceIds }
 *     evIds     本 worker 分到的 event id（长度 = count）
 *     claimIds  本 worker 可用的 claim id 池（按上限预分配，实际只用前 n 个）
 *     sourceIds 同上
 *
 * 输出（parentPort.postMessage）：
 *   { evCsv, claimCsv, sourceCsv, claimsUsed, sourcesUsed }
 */
import { parentPort, workerData } from 'node:worker_threads'

const gen = await import('../bench/gen.js')
const { tokenize } = await import('../src/domain/tokenize.js')

/** 快速 CSV 序列化（与主脚本保持一致） */
function rowToCsv(arr) {
  let s = ''
  for (let i = 0; i < arr.length; i++) {
    if (i) s += ','
    const v = arr[i]
    if (v === null || v === undefined) {
      s += '\\N'
      continue
    }
    const str = typeof v === 'string' ? v : String(v)
    if (str === '' || /[",\n\r\\]/.test(str) || str !== str.trim()) {
      s += '"' + str.replace(/"/g, '""') + '"'
    } else {
      s += str
    }
  }
  return s + '\n'
}

const { startIdx, count, total, evIds, claimIds, sourceIds } = workerData

/**
 * 生成 tsvector 字面量：`'水运':1 '运仪':2 ...`
 *
 * 为什么不在这里调 to_tsvector：COPY 不支持 SQL 表达式，
 * 而「先 COPY 再 UPDATE 回填」要多花 16 秒（v3 实测）。
 * PG 能直接解析这个字面量格式（已验证 tsquery 查询命中正确）。
 *
 * 用数组 join 而非字符串 += 拼接——后者在 V8 里是 O(n²)。
 */
function toTsvectorLiteral(text) {
  const tokens = tokenize(text)
  if (!tokens.length) return ''
  const seen = new Map()
  let pos = 1
  for (const t of tokens) {
    if (!seen.has(t)) seen.set(t, pos++)
  }
  const parts = []
  for (const [w, p] of seen) parts.push(`'${w}':${p}`)
  return parts.join(' ')
}

// 1. 生成事件行
const evRows = gen.makeEventRows(startIdx, count, total)

// 2. 事件 CSV（含 id 与 search_tsv）
const evCsv = new Array(count)
for (let i = 0; i < count; i++) {
  const r = evRows[i]
  const text = [r[1], r[16], r[3], r[4], r[13]].filter(Boolean).join(' ')
  const tsv = toTsvectorLiteral(text)
  evCsv[i] = rowToCsv([evIds[i], ...r, tsv])
}

// 3. claims（用本 worker 的 event id）
const meta = evRows.map((_, i) => ({ id: evIds[i], idx: startIdx + i }))
const claimRows = gen.makeClaimRows(meta)

// 4. 给 claims 分配 id（从本 worker 的池里按顺序取）
const claimsUsed = claimRows.length
if (claimsUsed > claimIds.length) {
  throw new Error(`worker 分到的 claim id 不足：需要 ${claimsUsed}，只有 ${claimIds.length}`)
}
const claimCsv = new Array(claimsUsed)
const claimIdsByEvent = new Map()
for (let i = 0; i < claimsUsed; i++) {
  const row = claimRows[i]
  const cid = claimIds[i]
  claimCsv[i] = rowToCsv([cid, ...row])
  const list = claimIdsByEvent.get(row[0]) || []
  list.push(cid)
  claimIdsByEvent.set(row[0], list)
}

// 5. sources（用上面分配的 claim id）
const sourceRows = gen.makeSourceRows(meta, claimIdsByEvent)
const sourcesUsed = sourceRows.length
if (sourcesUsed > sourceIds.length) {
  throw new Error(`worker 分到的 source id 不足：需要 ${sourcesUsed}，只有 ${sourceIds.length}`)
}
const sourceCsv = new Array(sourcesUsed)
for (let i = 0; i < sourcesUsed; i++) {
  sourceCsv[i] = rowToCsv([sourceIds[i], ...sourceRows[i]])
}

parentPort.postMessage({ evCsv, claimCsv, sourceCsv, claimsUsed, sourcesUsed })
