import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  ALGORITHM,
  EMPTY_ROOT,
  hashPair,
  leafHash,
  merkleProof,
  merkleRoot,
  verifyProof,
} from '../src/archive/merkle.js'

/** 独立实现的参考哈希，避免「自己验自己」 */
const h = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

test('merkleRoot 空 leaves 返回 64 个 0', () => {
  assert.equal(merkleRoot([]), EMPTY_ROOT)
  assert.equal(merkleRoot([]), '0'.repeat(64))
  assert.equal(merkleRoot([]).length, 64)
  assert.match(merkleRoot([]), /^[0-9a-f]{64}$/)
})

test('merkleRoot 单个 leaf 就是该叶子的 sha256', () => {
  const root = merkleRoot(['solo'])
  assert.equal(root, h('solo'))
  assert.equal(root, leafHash('solo'))
  assert.equal(ALGORITHM, 'sha256-binary-merkle')
})

test('merkleRoot 两个 leaf = sha256(左hex + 右hex)', () => {
  const [a, b] = [h('a'), h('b')]
  assert.equal(merkleRoot(['a', 'b']), h(a + b))
  assert.equal(merkleRoot(['a', 'b']), hashPair(a, b))
})

test('merkleRoot 三个 leaf 时最后一个与自身配对', () => {
  const [a, b, c] = [h('a'), h('b'), h('c')]
  const left = h(a + b)
  const right = h(c + c) // 奇数：c 与自身配对
  assert.equal(merkleRoot(['a', 'b', 'c']), h(left + right))
})

test('merkleRoot 四个 leaf 分两层两两合并', () => {
  const [a, b, c, d] = [h('w'), h('x'), h('y'), h('z')]
  assert.equal(merkleRoot(['w', 'x', 'y', 'z']), h(h(a + b) + h(c + d)))
})

test('merkleProof 三个 leaf 的兄弟方向正确', () => {
  const [a, b, c] = [h('a'), h('b'), h('c')]
  const left = h(a + b)
  const right = h(c + c)
  const root = h(left + right)

  assert.deepEqual(merkleProof(['a', 'b', 'c'], 0), {
    root,
    proof: [
      { hash: b, position: 'right' },
      { hash: right, position: 'right' },
    ],
  })
  assert.deepEqual(merkleProof(['a', 'b', 'c'], 1), {
    root,
    proof: [
      { hash: a, position: 'left' },
      { hash: right, position: 'right' },
    ],
  })
  assert.deepEqual(merkleProof(['a', 'b', 'c'], 2), {
    root,
    proof: [
      { hash: c, position: 'right' },
      { hash: left, position: 'left' },
    ],
  })
})

test('merkleProof 每个下标的证明都能通过 verifyProof（5 叶奇数树）', () => {
  const leaves = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
  const root = merkleRoot(leaves)

  for (let i = 0; i < leaves.length; i++) {
    const { root: proofRoot, proof } = merkleProof(leaves, i)
    assert.equal(proofRoot, root)
    assert.equal(verifyProof(leaves[i], proof, root), true, `leaf ${i} 应通过校验`)
  }
})

test('merkleProof 单叶树 proof 为空且可校验', () => {
  const { root, proof } = merkleProof(['only'], 0)
  assert.deepEqual(proof, [])
  assert.equal(root, h('only'))
  assert.equal(verifyProof('only', proof, root), true)
})

test('篡改 leaf 后 verifyProof 失败', () => {
  const leaves = ['a', 'b', 'c', 'd']
  const { root, proof } = merkleProof(leaves, 2)

  assert.equal(verifyProof('c', proof, root), true)
  assert.equal(verifyProof('c ', proof, root), false)
  assert.equal(verifyProof('C', proof, root), false)
  assert.equal(verifyProof('tampered', proof, root), false)
  // 根被换掉同样失败
  assert.equal(verifyProof('c', proof, h('another-root')), false)
})

test('篡改 proof 内容或方向后 verifyProof 失败', () => {
  const leaves = ['a', 'b', 'c']
  const { root, proof } = merkleProof(leaves, 1)

  const flipped = proof.map((step, i) =>
    i === 0 ? { hash: step.hash, position: 'right' } : step,
  )
  assert.equal(verifyProof('b', flipped, root), false)

  const swapped = proof.map((step, i) =>
    i === 0 ? { hash: h('zzz'), position: step.position } : step,
  )
  assert.equal(verifyProof('b', swapped, root), false)

  // 非法输入一律 false，不抛异常
  assert.equal(verifyProof('b', null, root), false)
  assert.equal(verifyProof('b', [{ hash: 'nope', position: 'left' }], root), false)
  assert.equal(verifyProof('b', [{ hash: h('x'), position: 'up' }], root), false)
  assert.equal(verifyProof('b', proof, 'not-a-hash'), false)
})

test('merkleProof 下标越界抛 RangeError', () => {
  assert.throws(() => merkleProof([], 0), RangeError)
  assert.throws(() => merkleProof(['a'], 1), RangeError)
  assert.throws(() => merkleProof(['a', 'b'], -1), RangeError)
  assert.throws(() => merkleProof(['a', 'b'], 1.5), RangeError)
  assert.throws(() => merkleRoot('not-an-array'), TypeError)
})

test('leafHash 按 UTF-8 计算且输入数组不被修改', () => {
  assert.equal(leafHash('水运仪象台'), h('水运仪象台'))
  assert.equal(leafHash(Buffer.from('水运仪象台', 'utf8')), h('水运仪象台'))

  const leaves = ['a', 'b', 'c']
  const snapshot = [...leaves]
  merkleRoot(leaves)
  merkleProof(leaves, 1)
  assert.deepEqual(leaves, snapshot)
  assert.match(merkleRoot(leaves), /^[0-9a-f]{64}$/)
})
