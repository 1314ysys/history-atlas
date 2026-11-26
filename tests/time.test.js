import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatYear,
  formatCentury,
  formatDecade,
  formatMillennium,
  formatEventTime,
  parseYear,
  normalizeYear,
  overlapsRange,
  pickZoomLevel,
} from '../src/domain/time.js'

test('formatYear 处理公元前/后', () => {
  assert.equal(formatYear(-403), '前403年')
  assert.equal(formatYear(1949), '1949年')
  assert.equal(formatYear(0), '前1年', '不存在公元 0 年，归一化为前1年')
  assert.equal(formatYear(Number.NaN), '年代不明')
})

test('normalizeYear 把 0 归一为 -1', () => {
  assert.equal(normalizeYear(0), -1)
  assert.equal(normalizeYear(-221), -221)
  assert.equal(normalizeYear('1949'), 1949)
})

test('formatCentury 边界值', () => {
  assert.equal(formatCentury(-403), '前5世纪')
  assert.equal(formatCentury(100), '1世纪')
  assert.equal(formatCentury(101), '2世纪')
  assert.equal(formatCentury(1900), '19世纪')
  assert.equal(formatCentury(-100), '前1世纪')
})

test('formatDecade 边界值', () => {
  assert.equal(formatDecade(-403), '前400年代')
  assert.equal(formatDecade(2024), '2020年代')
  assert.equal(formatDecade(1999), '1990年代')
})

test('formatMillennium', () => {
  assert.equal(formatMillennium(-3000), '前3千纪')
  assert.equal(formatMillennium(1500), '2千纪')
})

test('formatEventTime 单年', () => {
  const r = formatEventTime({ t_start_year: -221 })
  assert.equal(r.text, '前221年')
  assert.equal(r.sort, -221)
  assert.equal(r.precision, 'year')
  assert.equal(r.certainty, 'certain')
})

test('formatEventTime 精度为世纪/年代', () => {
  assert.equal(formatEventTime({ t_start_year: -500, t_precision: 'century' }).text, '前5世纪')
  assert.equal(formatEventTime({ t_start_year: 1050, t_precision: 'decade' }).text, '1050年代')
})

test('formatEventTime 确定度修饰', () => {
  assert.equal(formatEventTime({ t_start_year: -1046, t_certainty: 'circa' }).text, '约前1046年')
  assert.equal(formatEventTime({ t_start_year: -1046, t_certainty: 'disputed' }).text, '前1046年（有争议）')
  assert.equal(formatEventTime({ t_start_year: -2070, t_certainty: 'legendary' }).text, '前2070年（传说）')
})

test('formatEventTime 区间', () => {
  const r = formatEventTime({ t_start_year: -403, t_end_year: -221 })
  assert.equal(r.text, '前403年—前221年')
})

test('formatEventTime 月日', () => {
  const r = formatEventTime({ t_start_year: 1453, t_start_month: 5, t_start_day: 29, t_precision: 'day' })
  assert.equal(r.text, '1453年5月29日')
})

test('parseYear 多种输入', () => {
  assert.equal(parseYear('前403'), -403)
  assert.equal(parseYear('公元前221年'), -221)
  assert.equal(parseYear('-221'), -221)
  assert.equal(parseYear('1949年'), 1949)
  assert.equal(parseYear(''), null)
  assert.equal(parseYear('abc'), null)
})

test('overlapsRange 区间相交判定', () => {
  assert.equal(overlapsRange({ t_start_year: -221 }, -300, -200), true)
  assert.equal(overlapsRange({ t_start_year: 1949 }, -300, 0), false)
  assert.equal(overlapsRange({ t_start_year: -618, t_end_year: 907 }, 800, 900), true)
})

test('pickZoomLevel 档位选择', () => {
  assert.equal(pickZoomLevel(3000).id, 'millennium')
  assert.equal(pickZoomLevel(400).id, 'century')
  assert.equal(pickZoomLevel(50).id, 'decade')
})
