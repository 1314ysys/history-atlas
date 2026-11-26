import test from 'node:test'
import assert from 'node:assert/strict'
import { scoreHit } from '../src/api/search.js'

/** 纯函数单测：不连数据库（scoreHit 不触碰 db） */

const Q = '水运仪象台'

test('scoreHit：标题完全等于 q → 100', () => {
  assert.equal(scoreHit({ title: Q, summary: '苏颂主持建造' }, Q), 100)
  // 大小写不敏感
  assert.equal(scoreHit({ title: 'Water Clock' }, 'water clock'), 100)
})

test('scoreHit：标题以 q 开头 → 80', () => {
  assert.equal(scoreHit({ title: '水运仪象台建造始末', summary: '元祐年间' }, Q), 80)
})

test('scoreHit：标题包含 q（非前缀）→ 60', () => {
  assert.equal(scoreHit({ title: '北宋水运仪象台落成', summary: '苏颂' }, Q), 60)
})

test('scoreHit：仅 summary 包含 q → 30', () => {
  assert.equal(scoreHit({ title: '苏颂', summary: '主持建造水运仪象台，著《新仪象法要》' }, Q), 30)
})

test('scoreHit：标题与 summary 均无匹配 → 10（仅 search_text 放行的弱命中兜底）', () => {
  // SQL 的 WHERE 已保证该行在某处命中（search_text），故这里落到最低档 10
  assert.equal(scoreHit({ title: '指南针用于航海', summary: '北宋沈括《梦溪笔谈》' }, Q), 10)
  // 空查询不打分
  assert.equal(scoreHit({ title: Q }, ''), 0)
  assert.equal(scoreHit({ title: Q }, '   '), 0)
})
