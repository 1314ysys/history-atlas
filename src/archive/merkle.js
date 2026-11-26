import { createHash } from 'node:crypto'

/**
 * 标准二叉 Merkle 树（sha256，两两配对）。
 *
 * 规则（与 spec §8 / 快照清单一致）：
 *  - 叶子先 sha256，得到 64 位小写 hex；
 *  - 父节点 = sha256(left_hex + right_hex)，即两个 hex 字符串按 UTF-8 拼接后再取 sha256；
 *  - 奇数个节点时，最后一个节点与自身配对；
 *  - 空树根固定为 64 个 '0'；
 *  - 只有一个叶子时，根就是该叶子的哈希（不再自配对）；
 *  - 所有输入输出均为小写 hex 字符串。
 */

/** 树的算法标识，写进快照 MANIFEST.json */
export const ALGORITHM = 'sha256-binary-merkle'

/** 空树的根 */
export const EMPTY_ROOT = '0'.repeat(64)

const HEX64 = /^[0-9a-f]{64}$/i

/** @param {string|Buffer|Uint8Array} data @returns {string} 小写 hex sha256 */
function sha256hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** @param {unknown} value @returns {string} */
function toLeafString(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return String(value)
}

/**
 * 单个叶子取哈希。
 * @param {string|Buffer|Uint8Array} leaf @returns {string} 小写 hex
 */
export function leafHash(leaf) {
  return sha256hex(Buffer.from(toLeafString(leaf), 'utf8'))
}

/**
 * 两个 32 字节哈希的父节点。
 * @param {string} left 小写 hex @param {string} right 小写 hex @returns {string} 小写 hex
 */
export function hashPair(left, right) {
  return sha256hex(left + right)
}

/** @param {unknown} leaves @returns {string[]} 叶子哈希层 */
function leafLayer(leaves) {
  if (!Array.isArray(leaves)) throw new TypeError('leaves must be an array')
  return leaves.map(leafHash)
}

/**
 * 把一层节点合成下一层；奇数时最后一个与自身配对。
 * @param {string[]} level @returns {string[]}
 */
function nextLayer(level) {
  const out = []
  for (let i = 0; i < level.length; i += 2) {
    const left = level[i]
    const right = i + 1 < level.length ? level[i + 1] : left
    out.push(hashPair(left, right))
  }
  return out
}

/**
 * 计算 Merkle 根。
 * @param {(string|Buffer|Uint8Array)[]} leaves @returns {string} 64 位小写 hex；空数组返回 64 个 '0'
 */
export function merkleRoot(leaves) {
  let level = leafLayer(leaves)
  if (level.length === 0) return EMPTY_ROOT
  while (level.length > 1) level = nextLayer(level)
  return level[0]
}

/**
 * 生成某个叶子的包含证明（自底向上，position 表示兄弟节点在左还是在右）。
 * @param {(string|Buffer|Uint8Array)[]} leaves
 * @param {number} index
 * @returns {{ root: string, proof: { hash: string, position: 'left'|'right' }[] }}
 */
export function merkleProof(leaves, index) {
  let level = leafLayer(leaves)
  if (!Number.isInteger(index) || index < 0 || index >= level.length) {
    throw new RangeError(`leaf index ${index} out of range (leaves=${level.length})`)
  }

  const proof = []
  let idx = index

  while (level.length > 1) {
    const hasRight = idx + 1 < level.length
    if (idx % 2 === 0) {
      // 左子节点：兄弟在右（末位无右兄弟时，规则是「与自身配对」，故兄弟即自身）
      proof.push({ hash: hasRight ? level[idx + 1] : level[idx], position: 'right' })
    } else {
      proof.push({ hash: level[idx - 1], position: 'left' })
    }
    level = nextLayer(level)
    idx = Math.floor(idx / 2)
  }

  return { root: level[0], proof }
}

/**
 * 用证明校验某叶子是否属于给定根。
 * 任何格式不合法（非 hex、position 未知、proof 非数组）都返回 false，不抛异常。
 * @param {string|Buffer|Uint8Array} leaf
 * @param {{ hash: string, position: 'left'|'right' }[]} proof
 * @param {string} root
 * @returns {boolean}
 */
export function verifyProof(leaf, proof, root) {
  if (typeof root !== 'string' || !HEX64.test(root)) return false
  if (!Array.isArray(proof)) return false

  let cur = leafHash(leaf)
  for (const step of proof) {
    if (!step || typeof step !== 'object') return false
    const hash = step.hash
    const position = step.position
    if (typeof hash !== 'string' || !HEX64.test(hash)) return false
    if (position === 'left') cur = hashPair(hash.toLowerCase(), cur)
    else if (position === 'right') cur = hashPair(cur, hash.toLowerCase())
    else return false
  }

  return cur === root.toLowerCase()
}
