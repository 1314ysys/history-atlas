#!/usr/bin/env node
/**
 * scripts/apply-spell.js —— 应用拼写容错迁移（003-spell.sql）+ 由 event 生成词表
 *
 *   node scripts/apply-spell.js                 # 建表/建索引 + 重建词表（默认 freq ≥ 2）
 *   node scripts/apply-spell.js --dry-run       # 只统计、打印将写入多少词，不写库
 *   node scripts/apply-spell.js --min-freq=3    # 收紧词频阈值（表更小）
 *   node scripts/apply-spell.js --max-ngram=4   # 收紧 CJK 窗口长度上限
 *   node scripts/apply-spell.js --max-terms=8000  # 只保留最高频的 N 个词
 *   node scripts/apply-spell.js --prune         # 删掉本轮没再出现的旧词（默认不删）
 *   node scripts/apply-spell.js --no-ddl        # 跳过 003-spell.sql（表已存在时省时间）
 *
 * 词表怎么来的（为什么不在 SQL 里做）
 *   PostgreSQL 没有中文分词器。SQL 里能做的只有正则硬切，切出来的东西不可控；
 *   本项目的中文口径统一在 src/domain/tokenize.js（应用层 bigram），所以：
 *
 *     · tokenize(title) / tokenize(summary)  → 该文档的检索词素（bigram / 单字 / ASCII 整词）
 *     · 另外再取 CJK 连续片段上长度 2..maxNgram 的**所有窗口**（青霉素 / 青霉 / 霉素…），
 *       这样 3 字以上的专名（青霉素、都江堰、水运仪象台）也能进词表，被 suggest() 命中；
 *     · freq 按**出现次数**累加（不是文档频次）：同一个词在 title 与 summary 各出现一次就算 2，
 *       否则只在一条 event 里出现的专名会被 freq ≥ 2 的阈值误杀；
 *     · 只写入 freq ≥ minFreq 的词，控制表大小；写入用 UNNEST 批量 upsert（幂等）。
 *
 * 不删库、不改 schema.sql、不碰 001/002 的既有对象；纯增量 DDL。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../src/db/client.js'
import { tokenize } from '../src/domain/tokenize.js'
import { suggest } from '../src/domain/spell.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const MIGRATION_FILE = path.join(ROOT, 'src', 'db', 'migrations', '003-spell.sql')

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')))
/** @param {string} name @param {number} fallback */
function numFlag(name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  if (!hit) return fallback
  const n = Number.parseInt(hit.slice(name.length + 3), 10)
  return Number.isFinite(n) ? n : fallback
}

const DRY_RUN = flags.has('--dry-run')
const NO_DDL = flags.has('--no-ddl')
const PRUNE = flags.has('--prune')
const MIN_FREQ = Math.max(1, numFlag('min-freq', 2))
const MAX_NGRAM = Math.min(12, Math.max(2, numFlag('max-ngram', 6)))
const MAX_TERMS = Math.max(0, numFlag('max-terms', 0))
const BATCH = Math.min(2000, Math.max(50, numFlag('batch', 500)))

const t0 = performance.now()
const LOG = (s = '') => console.log(s)
const ms = (from) => `${Math.round(performance.now() - from)} ms`
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

/** 5433 偶发不可达时重试 3 次（不 sleep 太久，整体仍在 3 分钟预算内） */
async function withRetry(fn, label, attempts = 3) {
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const transient = /ECONNREFUSED|ETIMEDOUT|ECONNRESET|terminating connection|does not exist/i
        .test(String(err?.message || '')) || err?.code === 'ECONNREFUSED'
      if (i === attempts || !transient) break
      LOG(`[spell] ${label} 第 ${i} 次失败（${err.message}），1s 后重试 …`)
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------- DDL

async function applyDdl() {
  const sql = await readFile(MIGRATION_FILE, 'utf8')
  const started = performance.now()
  await db.exec(sql)
  // 与 scripts/apply-search-migration.js 共用 schema_migration 记账（不存在则建）
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      filename   TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
  await db.query(
    `INSERT INTO schema_migration (filename, checksum) VALUES ($1, $2)
     ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
    [path.basename(MIGRATION_FILE), sha256(sql)],
  )
  LOG(`[ddl] 已应用 ${path.basename(MIGRATION_FILE)}（幂等重跑，${ms(started)}）`)
}

// ---------------------------------------------------------------- 词表统计

const HAN = /\p{Script=Han}/u

/**
 * 取一段文本里的 CJK 连续片段（按码位，代理对不劈开）。
 * 用 Unicode 属性 `\p{Script=Han}`，与 tokenize.js 的 CJK 区间表口径一致（含扩展 B–I）。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function hanRuns(text) {
  /** @type {string[]} */
  const runs = []
  let buf = ''
  for (const ch of text) {
    if (HAN.test(ch)) {
      buf += ch
    } else if (buf) {
      runs.push(buf)
      buf = ''
    }
  }
  if (buf) runs.push(buf)
  return runs
}

/**
 * 统计词频：tokenize() 词素 + CJK 片段上长度 2..maxNgram 的全部窗口（按出现次数累加）。
 *
 * @param {Iterable<{title?:string|null, summary?:string|null}>} rows
 * @param {number} maxNgram
 * @returns {Map<string, number>} term → 出现次数
 */
export function countTerms(rows, maxNgram = 6) {
  /** @type {Map<string, number>} */
  const counts = new Map()
  const bump = (term, n = 1) => {
    if (!term) return
    counts.set(term, (counts.get(term) || 0) + n)
  }

  for (const row of rows) {
    for (const text of [row?.title, row?.summary]) {
      if (typeof text !== 'string' || !text) continue

      // ① tokenize：bigram / 单字 / ASCII 整词（每条文本内已去重，按文档频次计 1）
      for (const token of tokenize(text)) bump(token, 1)

      // ② CJK 窗口：让「青霉素」这类 ≥3 字专名整词进表（按出现次数计）
      for (const run of hanRuns(text)) {
        const cps = Array.from(run)
        const len = cps.length
        if (len < 2) continue
        const upper = Math.min(maxNgram, len)
        for (let n = 2; n <= upper; n++) {
          for (let i = 0; i + n <= len; i++) bump(cps.slice(i, i + n).join(''), 1)
        }
      }
    }
  }
  return counts
}

/** 词频 Map → 待写入的有序数组（freq 降序、term 升序，便于复现与 MAX_TERMS 截断） */
export function selectTerms(counts, minFreq, maxTerms = 0) {
  const picked = []
  for (const [term, freq] of counts) if (freq >= minFreq) picked.push({ term, freq })
  picked.sort((a, b) => b.freq - a.freq || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))
  return maxTerms > 0 ? picked.slice(0, maxTerms) : picked
}

// ---------------------------------------------------------------- 写库

async function upsertTerms(picked, runStart) {
  let written = 0
  const started = performance.now()
  for (let i = 0; i < picked.length; i += BATCH) {
    const chunk = picked.slice(i, i + BATCH)
    await db.query(
      `INSERT INTO search_vocab (term, freq)
       SELECT term, n FROM unnest($1::text[], $2::int[]) AS u(term, n)
       ON CONFLICT (term) DO UPDATE
         SET freq = EXCLUDED.freq, updated_at = now()`,
      [chunk.map((r) => r.term), chunk.map((r) => r.freq)],
    )
    written += chunk.length
    if (written % (BATCH * 10) === 0) {
      LOG(`[write] ${written}/${picked.length} …（${ms(started)}）`)
    }
  }
  LOG(`[write] upsert ${written} 条（${ms(started)}）`)

  if (PRUNE) {
    const { rowCount } = await db.query(
      `DELETE FROM search_vocab WHERE updated_at < $1`,
      [runStart],
    )
    LOG(`[prune] 删除本轮未出现的旧词 ${rowCount ?? 0} 条`)
  }
  return written
}

// ---------------------------------------------------------------- 报告

async function report(minFreq) {
  const stats = (
    await db.query(
      `SELECT count(*)::int AS terms,
              coalesce(sum(freq), 0)::bigint AS hits,
              coalesce(max(freq), 0)::int AS max_freq
         FROM search_vocab`,
    )
  ).rows[0]
  const above = (
    await db.query(`SELECT count(*)::int AS n FROM search_vocab WHERE freq >= $1`, [minFreq])
  ).rows[0].n
  const top = (
    await db.query(`SELECT term, freq FROM search_vocab ORDER BY freq DESC, term LIMIT 12`)
  ).rows

  LOG('')
  LOG(`[report] 词表规模：${stats.terms} 词（总出现次数 ${stats.hits}，最高频 ${stats.max_freq}）`)
  LOG(`[report] 其中 freq ≥ ${minFreq}：${above} 词`)
  LOG(`[report] Top 12：` + top.map((r) => `${r.term}(${r.freq})`).join('  '))
}

/** 用真实词表演示一次 suggest（验收项之一） */
async function demoSuggest(sample = '青霉术') {
  const { rows } = await db.query(
    `SELECT term FROM search_vocab ORDER BY freq DESC, term LIMIT 30000`,
  )
  const vocab = rows.map((r) => r.term)
  const started = performance.now()
  const hits = suggest(sample, vocab, { maxDistance: 2, limit: 5 })
  LOG('')
  LOG(`[demo] suggest(${JSON.stringify(sample)}, vocab[${vocab.length} 词]) 用时 ${ms(started)}`)
  LOG(`[demo] → ${JSON.stringify(hits)}`)
  const exact = rows.find((r) => r.term === '青霉素')
  LOG(`[demo] 「青霉素」在词表中：${exact ? '是' : '否'}`)
  return { vocabSize: vocab.length, hits }
}

// ---------------------------------------------------------------- main

const runStart = new Date()
LOG(`[spell] 模式：${db.mode()}  迁移：${path.basename(MIGRATION_FILE)}`)
LOG(
  `[spell] 参数：min-freq=${MIN_FREQ} max-ngram=${MAX_NGRAM} max-terms=${MAX_TERMS || '不限'}` +
    ` batch=${BATCH}${DRY_RUN ? ' dry-run' : ''}${PRUNE ? ' prune' : ''}`,
)

try {
  if (!NO_DDL && !DRY_RUN) {
    await withRetry(() => applyDdl(), 'applyDdl')
  } else {
    LOG('[ddl] 跳过 DDL' + (DRY_RUN ? '（dry-run）' : '（--no-ddl）'))
  }

  const readStart = performance.now()
  const { rows } = await withRetry(
    () => db.query(`SELECT title, summary FROM event`),
    'read event',
  )
  LOG(`[read] event ${rows.length} 行（${ms(readStart)}）`)

  const collectStart = performance.now()
  const counts = countTerms(rows, MAX_NGRAM)
  LOG(`[count] 候选词 ${counts.size} 个（CJK 窗口 ≤ ${MAX_NGRAM} 字，${ms(collectStart)}）`)

  const picked = selectTerms(counts, MIN_FREQ, MAX_TERMS)
  LOG(`[filter] freq ≥ ${MIN_FREQ} 的词 ${picked.length} 个`)

  let written = 0
  if (DRY_RUN) {
    LOG('[dry-run] 不写库；样例（前 10）：' + picked.slice(0, 10).map((r) => `${r.term}(${r.freq})`).join('  '))
  } else {
    written = await upsertTerms(picked, runStart)
  }

  if (!DRY_RUN) {
    await report(MIN_FREQ)
    await demoSuggest('青霉术')
  }

  LOG('')
  LOG(`[done] 写入 ${written} 词，总耗时 ${ms(t0)}`)
} catch (err) {
  console.error(`[spell] 失败：${err?.message || err}`)
  console.error(
    '[spell] 若为连接错误：请确认 127.0.0.1:5433 的 PostgreSQL 可达' +
      '（本脚本不启动/不重启数据库，也不 DROP 任何库表）',
  )
  process.exitCode = 1
} finally {
  await db.close()
}
