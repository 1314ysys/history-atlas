import { readFileSync } from 'node:fs'

const r = JSON.parse(readFileSync('bench/results.json', 'utf8'))

const out = []
const p = (s) => out.push(s)

p('## A 写入')
for (const a of r.a) {
  p(`${a.scale}\tinsert_ms=${a.insert.totalMs}\trows_s=${a.insert.eventRowsPerSec}\tdir=${a.storage?.dirBytes ?? '?'}\tclaims=${a.claims}\tsources=${a.sources}`)
}

p('\n## B 区间查询（索引 = gist？见 f 段）')
const bKeys = [...new Set(r.b.map((x) => `${x.index}|${x.variant}|${x.windowLabel}`))]
for (const k of bKeys) {
  const rows = r.b.filter((x) => `${x.index}|${x.variant}|${x.windowLabel}` === k)
  p(k + ' :: ' + rows.map((x) => `${x.scale}:${x.p50}/${x.p95}/${x.p99}/${x.max}(${x.matches})`).join(' | '))
}

p('\n## C 检索')
for (const c of r.c) p(`${c.scale}\t${c.tier}\t${c.label}\tp50=${c.p50}\tp95=${c.p95}\tp99=${c.p99}\tmatches=${c.matches}`)

p('\n## D 图')
for (const d of r.d) p(`${d.relations}\tpersons=${d.personCount}\tins=${d.personInsertMs}+${d.relationInsertMs}\tnodes=${d.nodes}\tedges=${d.edges}\tbfs_p50=${d.stats?.p50}\tp95=${d.stats?.p95}`)

p('\n## E 压缩')
p(JSON.stringify(r.e).slice(0, 1200))

p('\n## F 索引')
for (const f of r.f) p(`${f.scale}\tgist=${f.withGist}\tnoGist=${f.withoutGist}`)

// log-log 拟合
function fit(points) {
  const pts = points.filter((x) => x[0] > 0 && x[1] > 0)
  if (pts.length < 2) return null
  const n = pts.length
  const xs = pts.map((x) => Math.log(x[0]))
  const ys = pts.map((x) => Math.log(x[1]))
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  const b = num / den
  const a = Math.exp(my - b * mx)
  const ssTot = ys.reduce((s, y) => s + (y - my) ** 2, 0)
  const ssRes = ys.reduce((s, y, i) => s + (y - (Math.log(a) + b * xs[i])) ** 2, 0)
  return { a, b, r2: 1 - ssRes / ssTot }
}

p('\n## 拟合 latency = a * N^b')
const variants = [...new Set(r.b.map((x) => `${x.index}|${x.variant}|${x.windowLabel}`))]
for (const v of variants) {
  const rows = r.b.filter((x) => `${x.index}|${x.variant}|${x.windowLabel}` === v).sort((x, y) => x.scale - y.scale)
  const f = fit(rows.map((x) => [x.scale, x.p50]))
  if (f) p(`${v}\tb=${f.b.toFixed(3)}\ta=${f.a.toExponential(3)}\tR2=${f.r2.toFixed(4)}\tn=${rows.length}`)
}
const cs = {}
for (const c of r.c) {
  const k = c.tier
  ;(cs[k] ||= []).push([c.scale, c.p50])
}
for (const [k, pts] of Object.entries(cs)) {
  const f = fit(pts)
  if (f) p(`search:${k}\tb=${f.b.toFixed(3)}\tR2=${f.r2.toFixed(4)}\tpts=${JSON.stringify(pts)}`)
}
p('graph:\tb=' + (fit(r.d.map((x) => [x.relations, x.stats?.p50]) || [])?.b ?? '?'))

console.log(out.join('\n'))
