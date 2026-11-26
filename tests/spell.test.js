import test from 'node:test'
import assert from 'node:assert/strict'
import { levenshtein, suggest } from '../src/domain/spell.js'
import { facetSql, shapeFacets, emptyFacets, FACET_FIELDS } from '../src/search/facets.js'

/** 纯函数单测：拼写容错层 + 分面整形层都不碰数据库、无外部依赖 */

// ---------------------------------------------------------------- levenshtein

test('levenshtein：插入', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3) // k→s, e→i, +g
  assert.equal(levenshtein('book', 'books'), 1)
  assert.equal(levenshtein('', 'abc'), 3)
})

test('levenshtein：删除', () => {
  assert.equal(levenshtein('books', 'book'), 1)
  assert.equal(levenshtein('abc', ''), 3)
  assert.equal(levenshtein('青霉术', '青霉'), 1) // 删掉「术」
})

test('levenshtein：替换', () => {
  assert.equal(levenshtein('cat', 'cut'), 1)
  assert.equal(levenshtein('青霉素', '青霉术'), 1) // 素 → 术
  assert.equal(levenshtein('秦', '汉'), 1)
  // 非 Damerau：交换相邻两字符算 2（删+插）
  assert.equal(levenshtein('ab', 'ba'), 2)
})

test('levenshtein：空串与相同串', () => {
  assert.equal(levenshtein('', ''), 0)
  assert.equal(levenshtein('abc', 'abc'), 0)
  assert.equal(levenshtein('青霉素', '青霉素'), 0)
  assert.equal(levenshtein(null, ''), 0)
  assert.equal(levenshtein(undefined, 'a'), 1)
  assert.equal(levenshtein(42, '42'), 2) // 非字符串按空串处理 → 距离 = '42' 的长度
})

test('levenshtein：中文按码位计数（不是 UTF-16 code unit）', () => {
  assert.equal(levenshtein('水运仪象台', '水云仪像台'), 2) // 运→云、象→像
  assert.equal(levenshtein('宋', '宋代'), 1)
  // 扩展 B 区字符是代理对：按 code unit 会比出 2 处差异，按码位只有 1 处
  assert.equal(levenshtein('\u{20000}文', '\u{20001}文'), 1)
  // emoji：单个码位
  assert.equal(levenshtein('\u{1F34E}', '\u{1F34F}'), 1)
})

test('levenshtein：对称性与三角不等式的抽样校验', () => {
  const pairs = [
    ['青霉素', '青霉术'],
    ['kitten', 'sitting'],
    ['', '秦'],
    ['水运仪象台', '水运仪'],
    ['DNA', 'dna'],
  ]
  for (const [a, b] of pairs) {
    assert.equal(levenshtein(a, b), levenshtein(b, a), `对称性：${a} / ${b}`)
    assert.ok(levenshtein(a, b) <= Math.max(Array.from(a).length, Array.from(b).length))
  }
  assert.ok(
    levenshtein('青霉素', '青霉菌') <= levenshtein('青霉素', '青霉') + levenshtein('青霉', '青霉菌'),
  )
})

// ---------------------------------------------------------------- suggest

test('suggest：distance 升序 → 前缀匹配 → 词频 → 长度差 → 字典序', () => {
  const vocab = ['青霉素', '青霉', '霉素', '青霉菌', '青霉素钠']
  const got = suggest('青霉术', vocab, { limit: 5 })
  assert.deepEqual(got, [
    { term: '青霉素', distance: 1 }, // 替换「术」→「素」，长度差 0
    { term: '青霉菌', distance: 1 }, // 同样是 1 次替换，长度差 0
    { term: '青霉', distance: 1 }, // 删掉「术」，长度差 1
    // 同为 distance=2 时按「与查询词相同的前缀长度」降序：
    // 「青霉素钠」共享前缀「青霉」(2)，比共享 0 个前缀的「霉素」更可能是用户想输入的
    { term: '青霉素钠', distance: 2 },
    { term: '霉素', distance: 2 },
  ])
  // 返回值只暴露 term/distance，不泄漏内部排序列（prefix/freq/lenDiff）
  for (const hit of got) assert.deepEqual(Object.keys(hit).sort(), ['distance', 'term'])
})

test('suggest：weights 词频在同距离同前缀时优先', () => {
  const vocab = ['蔡伦', '蔡侯', '蔡叔']
  const weights = new Map([['蔡伦', 6], ['蔡侯', 1], ['蔡叔', 1]])
  assert.equal(suggest('蔡论', vocab, { limit: 1, weights })[0].term, '蔡伦')
  // 不给权重时退化为字典序，结果仍稳定
  assert.ok(suggest('蔡论', vocab, { limit: 3 }).length === 3)
})

test('suggest：limit 生效且默认 maxDistance=2 / limit=3', () => {
  const vocab = ['青霉素', '青霉菌', '青霉', '霉素', '青霉素钠']
  assert.equal(suggest('青霉术', vocab, { limit: 1 }).length, 1)
  assert.equal(suggest('青霉术', vocab, { limit: 2 }).length, 2)
  // 默认 limit 3
  assert.equal(suggest('青霉术', vocab).length, 3)
  // 默认 maxDistance 2：等长但整词替换 3 次的候选（距离 3）不该出现
  assert.deepEqual(suggest('青霉素', ['硫磺酸']), [])
  // maxDistance 放大后才出现
  assert.deepEqual(suggest('青霉素', ['硫磺酸'], { maxDistance: 3 }), [
    { term: '硫磺酸', distance: 3 },
  ])
})

test('suggest：排除原词、排除仅大小写差异的同形词、排除 distance=0', () => {
  assert.deepEqual(suggest('青霉素', ['青霉素']), [])
  assert.deepEqual(
    suggest('青霉素', ['青霉素', '青霉菌']).map((h) => h.term),
    ['青霉菌'],
  )
  // ASCII：仅大小写不同视为同一个词
  assert.deepEqual(suggest('Penicillin', ['penicillin']), [])
  // maxDistance = 0 时不可能有非自身候选
  assert.deepEqual(suggest('青霉素', ['青霉菌'], { maxDistance: 0 }), [])
})

test('suggest：长度差剪枝（不误杀、也不放过）', () => {
  // 长度差 3 > maxDistance 2：直接跳过（无论内容多像）
  assert.deepEqual(suggest('ab', ['abcde'], { maxDistance: 2 }), [])
  // 长度差 2 == maxDistance 2：保留（边界不被剪掉），距离 2
  assert.deepEqual(suggest('abcd', ['ab'], { maxDistance: 2 }), [{ term: 'ab', distance: 2 }])
  // 长度差 1 但距离超阈值：仍按距离剔除
  assert.deepEqual(suggest('甲乙丙', ['甲乙丙丁'], { maxDistance: 0 }), [])
  assert.deepEqual(suggest('甲乙丙', ['甲乙丙丁'], { maxDistance: 1 }), [
    { term: '甲乙丙丁', distance: 1 },
  ])
})

test('suggest：重复词条去重、非字符串词条与非法入参', () => {
  const dup = suggest('青霉术', ['青霉', '青霉', ' 青霉 ', '', null, 42, {}], { limit: 5 })
  assert.deepEqual(dup, [{ term: '青霉', distance: 1 }])
  assert.deepEqual(suggest('', ['青霉']), [])
  assert.deepEqual(suggest('   ', ['青霉']), [])
  assert.deepEqual(suggest('青霉术', null), [])
  assert.deepEqual(suggest('青霉术', []), [])
  assert.deepEqual(suggest('青霉术', 'not-an-array'), [])
  assert.deepEqual(suggest(null, ['青霉']), [])
})

test('suggest：真实词表规模的稳定性（5000 词、亚秒级）', () => {
  // 构造 5000 个 3 字词：前缀「甲乙」+ 随机第 3 字，确保剪枝路径真被执行
  const vocab = []
  for (let i = 0; i < 5000; i++) vocab.push('甲乙' + String.fromCodePoint(0x4e00 + i))
  vocab.push('青霉术') // 原词本身，必须被排除
  const started = performance.now()
  const hits = suggest('青霉术', vocab, { limit: 3 })
  const elapsed = performance.now() - started
  assert.ok(hits.length <= 3)
  assert.ok(!hits.some((h) => h.term === '青霉术'))
  assert.ok(elapsed < 1000, `suggest 应亚秒级，实际 ${elapsed.toFixed(1)} ms`)
})

// ---------------------------------------------------------------- shapeFacets

test('shapeFacets：空数据与非法入参 → 三个空数组', () => {
  const empty = { track: [], category: [], discipline: [] }
  assert.deepEqual(shapeFacets([]), empty)
  assert.deepEqual(shapeFacets(null), empty)
  assert.deepEqual(shapeFacets(undefined), empty)
  assert.deepEqual(shapeFacets('nope'), empty)
  assert.deepEqual(shapeFacets([null, 42, 'x', {}]), empty)
  assert.deepEqual(emptyFacets(), empty)
})

test('shapeFacets：三组维度 + 丢弃 NULL 桶 + 排序 + 不修改入参', () => {
  const rows = [
    { track: 'cn', category: null, discipline: null, n: 3 },
    { track: 'world', category: null, discipline: null, n: 5 },
    { track: null, category: '技术', discipline: null, n: 4 },
    { track: null, category: '制度', discipline: null, n: 4 },
    { track: null, category: null, discipline: '科技', n: 2 },
    { track: null, category: null, discipline: null, n: 506 }, // discipline IS NULL 桶，丢弃
    { track: null, category: null, discipline: '科技', n: 0 }, // 0 计数，丢弃
  ]
  const snapshot = JSON.parse(JSON.stringify(rows))
  const got = shapeFacets(rows)

  assert.deepEqual(got.track, [
    { value: 'world', count: 5 },
    { value: 'cn', count: 3 },
  ])
  // 同 count 按 value 升序（zh 排序：技术 < 制度）
  assert.deepEqual(got.category, [
    { value: '技术', count: 4 },
    { value: '制度', count: 4 },
  ])
  assert.deepEqual(got.discipline, [{ value: '科技', count: 2 }])
  // 纯函数：入参不被改动、行对象不被复用
  assert.deepEqual(rows, snapshot)
  assert.notEqual(got.track[0], rows[1])
})

test('shapeFacets：兼容 {dim,value,count} 行形状与字符串 count', () => {
  const rows = [
    { dim: 'track', value: 'cn', count: '7' },
    { dim: 'category', value: '技术', count: 2 },
    { dim: 'discipline', value: null, count: 9 },
    { dim: 'unknown', value: 'x', count: 1 },
  ]
  assert.deepEqual(shapeFacets(rows), {
    track: [{ value: 'cn', count: 7 }],
    category: [{ value: '技术', count: 2 }],
    discipline: [],
  })
})

// ---------------------------------------------------------------- facetSql

test('facetSql：GROUPING SETS 一次算三组分面（SQL 形状可拼接）', () => {
  const { sql, fields } = facetSql(`status = 'published' AND (search_tsv @@ to_tsquery('simple', $1))`)
  assert.deepEqual(fields, ['track', 'category', 'discipline'])
  assert.deepEqual(fields, [...FACET_FIELDS])
  // 三行关键形状：选列 / WHERE 拼接 / GROUPING SETS 三元组
  assert.match(sql, /^SELECT track, category, discipline, count\(\*\)::int AS n\n {2}FROM event\n WHERE /)
  assert.ok(sql.includes(`WHERE status = 'published' AND (search_tsv @@ to_tsquery('simple', $1))`))
  assert.ok(sql.trimEnd().endsWith('GROUP BY GROUPING SETS ((track), (category), (discipline))'))
  // 参数占位符原样保留（由调用方按同序传 params）
  assert.ok(sql.includes('$1'))
})

test('facetSql：whereSql 归一化（无参 → TRUE、容忍前导 WHERE 与尾部分号）', () => {
  assert.equal(facetSql().sql, facetSql('').sql)
  assert.ok(facetSql().sql.includes('\n WHERE TRUE\n'))
  assert.ok(facetSql('   ').sql.includes('WHERE TRUE'))
  assert.ok(facetSql("WHERE status = 'published'").sql.includes("WHERE status = 'published'"))
  assert.ok(facetSql("status = 'published';").sql.includes("WHERE status = 'published'\n GROUP BY"))
  // fields 每次返回新数组（调用方随意改，不影响后续调用）
  const a = facetSql('TRUE').fields
  a.push('oops')
  assert.deepEqual(facetSql('TRUE').fields, ['track', 'category', 'discipline'])
})
