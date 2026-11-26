import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, toTsv, toTsQuery } from '../src/domain/tokenize.js'

/** 纯函数单测：分词层不触碰数据库、无依赖 */

test('纯中文：连续 CJK 片段产出二元组 bigram', () => {
  assert.deepEqual(tokenize('水运仪象台'), ['水运', '运仪', '仪象', '象台'])
  // 两字词就是它自己
  assert.deepEqual(tokenize('秦朝'), ['秦朝'])
  // 多个 CJK 片段（被标点/ASCII 分隔）各自独立成组
  assert.deepEqual(tokenize('水运仪象台·青霉素'), ['水运', '运仪', '仪象', '象台', '青霉', '霉素'])
})

test('长词组：n 个汉字 → n-1 个 bigram，顺序保持', () => {
  const t = tokenize('北宋水运仪象台')
  assert.deepEqual(t, ['北宋', '宋水', '水运', '运仪', '仪象', '象台'])
  assert.equal(t.length, 7 - 1)
})

test('中英混排：中文 bigram 与 ASCII 单词并存，互不粘连', () => {
  assert.deepEqual(tokenize('青霉素 penicillin'), ['青霉', '霉素', 'penicillin'])
  // 无空格紧邻也切开（不产生跨文字系统的 bigram）
  assert.deepEqual(tokenize('青霉素penicillin'), ['青霉', '霉素', 'penicillin'])
  assert.deepEqual(tokenize('DNA双螺旋'), ['dna', '双螺', '螺旋'])
})

test('标点与空白：只作分隔符，不产出 token 也不产生空串', () => {
  assert.deepEqual(tokenize('甲午战争，1894年。'), ['甲午', '午战', '战争', '1894', '年'])
  assert.deepEqual(tokenize('《新仪象法要》'), ['新仪', '仪象', '象法', '法要'])
  assert.deepEqual(tokenize('  \t\n  '), [])
  assert.deepEqual(tokenize('——！？…'), [])
  for (const t of tokenize('甲午战争，1894年。')) assert.ok(t.length >= 1)
})

test('单字：CJK 单字保留单字，单字母/单数字也保留', () => {
  assert.deepEqual(tokenize('秦'), ['秦'])
  assert.deepEqual(tokenize('秦，汉'), ['秦', '汉'])
  assert.deepEqual(tokenize('a'), ['a'])
  assert.deepEqual(tokenize('7'), ['7'])
})

test('空串与非法入参：一律返回空数组', () => {
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize(null), [])
  assert.deepEqual(tokenize(undefined), [])
  assert.deepEqual(tokenize(42), [])
})

test('大小写：ASCII 统一转小写（CJK 不受影响）', () => {
  assert.deepEqual(tokenize('Water CLOCK'), ['water', 'clock'])
  assert.deepEqual(tokenize('mRNA疫苗'), ['mrna', '疫苗'])
  assert.deepEqual(tokenize('R2D2'), ['r2d2'])
})

test('数字：连续数字作为一个 token，与中文分开', () => {
  assert.deepEqual(tokenize('1894'), ['1894'])
  assert.deepEqual(tokenize('1092年'), ['1092', '年'])
  assert.deepEqual(tokenize('元祐7年'), ['元祐', '7', '年'])
})

test('去重：重复 token 只出现一次（保持首次出现顺序）', () => {
  assert.deepEqual(tokenize('北宋北宋'), ['北宋', '宋北'])
  assert.deepEqual(tokenize('青霉素 青霉素'), ['青霉', '霉素'])
  assert.deepEqual(tokenize('abc ABC abc'), ['abc'])
})

test('扩展 A/B 区 CJK 也走 bigram（代理对不被劈开）', () => {
  // 扩展 A：U+3400 㐀 / U+3401 㐁
  assert.deepEqual(tokenize('\u3400\u3401'), ['\u3400\u3401'])
  // 扩展 B：U+20000 𠀀 / U+20001 𠀁（各占 2 个 UTF-16 码元）
  const extB = '\u{20000}\u{20001}\u{20002}'
  assert.deepEqual(tokenize(extB), ['\u{20000}\u{20001}', '\u{20001}\u{20002}'])
  for (const t of tokenize(extB)) assert.equal([...t].length, 2)
})

test('toTsv：空格连接，可直接喂给 to_tsvector(\'simple\', ...)', () => {
  assert.equal(toTsv(['水运', '运仪', '仪象', '象台']), '水运 运仪 仪象 象台')
  assert.equal(toTsv([]), '')
  assert.equal(toTsv(['青霉素', 'penicillin']), '青霉素 penicillin')
  // 脏输入被清掉，不产生双空格
  assert.equal(toTsv(['a', '', null, undefined, 'b']), 'a b')
  assert.equal(toTsv(null), '')
  // 与 tokenize 串联（seed 的实际用法）
  assert.equal(toTsv(tokenize('水运仪象台')), '水运 运仪 仪象 象台')
})

test('toTsQuery：中文 bigram 用 & 连接（AND 语义）', () => {
  assert.equal(toTsQuery('水运仪象台'), '水运 & 运仪 & 仪象 & 象台')
  assert.equal(toTsQuery('青霉素'), '青霉 & 霉素')
  // 单个 bigram 不需要 &
  assert.equal(toTsQuery('秦朝'), '秦朝')
})

test('toTsQuery：单字查询直接返回该字', () => {
  assert.equal(toTsQuery('秦'), '秦')
  assert.equal(toTsQuery('甲'), '甲')
})

test('toTsQuery：ASCII 用原文（小写），与中文混排时一并 & 连接', () => {
  assert.equal(toTsQuery('Water Clock'), 'water & clock')
  assert.equal(toTsQuery('青霉素penicillin'), '青霉 & 霉素 & penicillin')
  assert.equal(toTsQuery('DNA'), 'dna')
})

test('toTsQuery：空查询/纯标点返回空串（调用方据此回退 LIKE）', () => {
  assert.equal(toTsQuery(''), '')
  assert.equal(toTsQuery('   '), '')
  assert.equal(toTsQuery('——！？'), '')
  assert.equal(toTsQuery(null), '')
  assert.equal(toTsQuery(undefined), '')
})

test('toTsQuery：输出不含 tsquery 元字符（无需转义）', () => {
  const expr = toTsQuery('甲午战争 & | ! ( ) : \' * 1894')
  assert.equal(expr, '甲午 & 午战 & 战争 & 1894')
  assert.doesNotMatch(expr, /[|!():'*]/)
})

test('toTsQuery 与 tokenize 同源：表达式即 token 的 & 连接', () => {
  for (const q of ['水运仪象台', '青霉素penicillin', '元祐7年', '秦']) {
    const tokens = tokenize(q)
    const expected = tokens.length > 1 ? tokens.join(' & ') : (tokens[0] ?? '')
    assert.equal(toTsQuery(q), expected)
  }
})
