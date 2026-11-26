import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

/** 快照目录：默认 <root>/snapshots，可用 SNAPSHOT_DIR 覆盖（测试/演练用） */
export const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || path.join(ROOT, 'snapshots')

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 读取 snapshots/latest.json。
 * @returns {Promise<{date:string, root:string|null}|null>} 不存在或格式不对时返回 null
 */
export async function readLatest() {
  try {
    const raw = await readFile(path.join(SNAPSHOT_DIR, 'latest.json'), 'utf8')
    const data = JSON.parse(raw)
    if (!data || typeof data.date !== 'string' || !DATE_RE.test(data.date)) return null
    return { date: data.date, root: typeof data.root === 'string' ? data.root : null }
  } catch {
    return null
  }
}

export const routes = [
  /**
   * GET /api/snapshot/latest → { date, root, manifest_url }
   * 没有快照时返回全 null（前端据此隐藏「可验证快照」入口）。
   */
  ['GET', '/api/snapshot/latest', async () => {
    const latest = await readLatest()
    if (!latest) return { date: null, root: null, manifest_url: null }

    return {
      date: latest.date,
      root: latest.root,
      manifest_url: `/snapshots/${latest.date}/MANIFEST.json`,
    }
  }],
]
