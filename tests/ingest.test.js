import test from 'node:test'
import assert from 'node:assert/strict'
import { validateEvent, canonicalJSON } from '../src/ingest/schema.js'

/** 合法最小事件，用于派生各用例（不依赖数据库） */
const MINIMAL = {
  external_id: 'cn-qin-unification',
  title: '秦统一六国',
  time: { start_year: -221 },
  track: 'cn',
  category: '政治',
}

const pathsOf = (res) => res.errors.map((e) => e.path)

/** 收集一次校验的全部错误路径，便于断言"错在哪" */
function failPaths(ev) {
  const res = validateEvent(ev)
  assert.equal(res.ok, false, `expected invalid, got ${JSON.stringify(res.value)}`)
  assert.ok(Array.isArray(res.errors) && res.errors.length > 0)
  for (const e of res.errors) {
    assert.equal(typeof e.path, 'string')
    assert.equal(typeof e.message, 'string')
    assert.ok(e.message.length > 0)
  }
  return pathsOf(res)
}

// ---------------------------------------------------------------- 合法用例 ×5

test('合法：最小事件，缺省的 precision/certainty 被填为默认值', () => {
  const res = validateEvent(MINIMAL)
  assert.equal(res.ok, true)
  assert.equal(res.value.external_id, 'cn-qin-unification')
  assert.equal(res.value.title, '秦统一六国')
  assert.equal(res.value.track, 'cn')
  assert.equal(res.value.category, '政治')
  assert.equal(res.value.time.start_year, -221)
  assert.equal(res.value.time.precision, 'year')
  assert.equal(res.value.time.certainty, 'certain')
  assert.equal(res.value.summary, undefined)
  assert.equal(res.value.place, undefined)
})

test('合法：含 summary/place/claims/sources 的完整事件', () => {
  const res = validateEvent({
    external_id: 'cn-water-powered-armillary',
    title: '苏颂建成水运仪象台',
    time: { start_year: 1092, precision: 'year', certainty: 'probable' },
    track: 'cn',
    category: '科技',
    summary: '以水力驱动浑仪、浑象与报时装置，被视为天文钟先驱。',
    place: { name: '开封', lat: 34.8, lon: 114.31 },
    claims: [
      { statement: '元祐七年（1092）落成', evidence_level: 'A', adopted: true },
      { statement: '部分构件复原方案仍有争议', evidence_level: 'C' },
    ],
    sources: [
      {
        title: '新仪象法要',
        locator: '卷上',
        quote: '以水激轮，轮转而仪象皆动',
        retrieved_url: 'https://zh.wikisource.org/wiki/新儀象法要',
      },
      { title: '宋史·苏颂传' },
    ],
  })
  assert.equal(res.ok, true)
  assert.equal(res.value.summary, '以水力驱动浑仪、浑象与报时装置，被视为天文钟先驱。')
  assert.deepEqual(res.value.place, { name: '开封', lat: 34.8, lon: 114.31 })
  assert.deepEqual(res.value.claims, [
    { statement: '元祐七年（1092）落成', evidence_level: 'A', adopted: true },
    { statement: '部分构件复原方案仍有争议', evidence_level: 'C' },
  ])
  assert.equal(res.value.sources.length, 2)
  assert.equal(res.value.sources[0].quote, '以水激轮，轮转而仪象皆动')
  assert.equal(res.value.sources[1].locator, undefined)
})

test('合法：年份边界 -1000000 / 3000 均可接受', () => {
  const low = validateEvent({ ...MINIMAL, time: { start_year: -1000000 } })
  const high = validateEvent({ ...MINIMAL, time: { start_year: 3000 } })
  assert.equal(low.ok, true)
  assert.equal(low.value.time.start_year, -1000000)
  assert.equal(high.ok, true)
  assert.equal(high.value.time.start_year, 3000)
})

test('合法：未知字段被忽略，合法的可选时间细分字段被保留', () => {
  const res = validateEvent({
    ...MINIMAL,
    junk: 'x',
    arbitrary: { nested: [1, 2, 3] },
    time: { start_year: 105, start_month: 6, start_day: 15, end_year: 110, timezone: 'Asia/Shanghai' },
    claims: [{ statement: '奏上蔡侯纸', evidence_level: 'B', note: '未知字段' }],
  })
  assert.equal(res.ok, true)
  assert.equal('junk' in res.value, false)
  assert.equal('arbitrary' in res.value, false)
  assert.equal('timezone' in res.value.time, false)
  assert.equal(res.value.time.start_month, 6)
  assert.equal(res.value.time.start_day, 15)
  assert.equal(res.value.time.end_year, 110)
  assert.equal('note' in res.value.claims[0], false)
})

test('合法：长度上限处通过（external_id 200 / title 300 / category 40 / summary 4000）', () => {
  const res = validateEvent({
    ...MINIMAL,
    external_id: 'a'.repeat(200),
    title: '题'.repeat(300),
    category: 'c'.repeat(40),
    summary: 's'.repeat(4000),
  })
  assert.equal(res.ok, true)
  assert.equal(res.value.external_id.length, 200)
  assert.equal(res.value.title.length, 300)
  assert.equal(res.value.category.length, 40)
  assert.equal(res.value.summary.length, 4000)
})

// ---------------------------------------------------------------- 非法用例 ×5

test('非法：非对象输入（null / 字符串 / 数组）', () => {
  for (const bad of [null, 'event', 42, []]) {
    const res = validateEvent(bad)
    assert.equal(res.ok, false)
    assert.equal(res.errors[0].path, '')
    assert.match(res.errors[0].message, /must be a JSON object/)
  }
})

test('非法：缺 external_id / title / time 三个必填项', () => {
  const paths = failPaths({ track: 'cn', category: '政治' })
  assert.ok(paths.includes('external_id'), paths.join(','))
  assert.ok(paths.includes('title'))
  assert.ok(paths.includes('time'))
})

test('非法：类型与长度（external_id 非字符串、title 301、category 空）', () => {
  const paths = failPaths({
    external_id: 123,
    title: 'x'.repeat(301),
    time: { start_year: 1 },
    track: 'cn',
    category: '   ',
  })
  assert.ok(paths.includes('external_id'), paths.join(','))
  assert.ok(paths.includes('title'))
  assert.ok(paths.includes('category'))
})

test('非法：time 越界/非整数/枚举错', () => {
  assert.ok(failPaths({ ...MINIMAL, time: { start_year: 3001 } }).includes('time.start_year'))
  assert.ok(failPaths({ ...MINIMAL, time: { start_year: -1000001 } }).includes('time.start_year'))
  assert.ok(failPaths({ ...MINIMAL, time: { start_year: 1.5 } }).includes('time.start_year'))
  assert.ok(failPaths({ ...MINIMAL, time: { start_year: '221' } }).includes('time.start_year'))
  assert.ok(failPaths({ ...MINIMAL, time: { start_year: 1, precision: 'week' } }).includes('time.precision'))
  assert.ok(failPaths({ ...MINIMAL, time: { start_year: 1, certainty: 'unknown' } }).includes('time.certainty'))
})

test('非法：track 枚举、place 经纬度范围、claims/sources 逐项校验', () => {
  const paths = failPaths({
    ...MINIMAL,
    track: 'asia',
    place: { lat: 91, lon: -181 },
    claims: [
      { statement: 'ok', evidence_level: 'E' },
      { evidence_level: 'A' },
      { statement: 'ok', evidence_level: 'A', adopted: 'yes' },
    ],
    sources: [{ title: '只有 title 也合法' }, { locator: '缺 title 应报错' }],
  })
  assert.ok(paths.includes('track'), paths.join(','))
  assert.ok(paths.includes('place.name'))
  assert.ok(paths.includes('place.lat'))
  assert.ok(paths.includes('place.lon'))
  assert.ok(paths.includes('claims[0].evidence_level'))
  assert.ok(paths.includes('claims[1].statement'))
  assert.ok(paths.includes('claims[2].adopted'))
  assert.ok(paths.includes('sources[1].title'))

  // claims / sources 不是数组
  assert.ok(failPaths({ ...MINIMAL, claims: { statement: 'x' } }).includes('claims'))
  assert.ok(failPaths({ ...MINIMAL, sources: 'book' }).includes('sources'))
  // place 不是对象
  assert.ok(failPaths({ ...MINIMAL, place: '开封' }).includes('place'))
})

// ------------------------------------------------------ canonicalJSON（幂等键基础）

test('canonicalJSON：键顺序无关，嵌套结构稳定', () => {
  const a = { z: 1, a: { y: [3, 2, 1], b: 'x' }, m: null }
  const b = { a: { b: 'x', y: [3, 2, 1] }, m: null, z: 1 }
  assert.equal(canonicalJSON(a), canonicalJSON(b))
  assert.equal(canonicalJSON(a), '{"a":{"b":"x","y":[3,2,1]},"m":null,"z":1}')
})

test('canonicalJSON：数组顺序保留，undefined 被丢弃（默认值等价）', () => {
  assert.notEqual(canonicalJSON([1, 2]), canonicalJSON([2, 1]))
  assert.equal(canonicalJSON({ a: 1, b: undefined }), canonicalJSON({ a: 1 }))
  assert.equal(canonicalJSON({ a: 1, b: undefined }), '{"a":1}')
})
