/**
 * 采集事件的手写极简 JSON Schema 校验器 —— 不引入 ajv / zod。
 *
 * 只做四件事：必填、类型（含长度/范围）、枚举、默认值。
 * 约定：**未知字段一律允许并忽略**（不报错，也不进入规范化结果），
 * 因此 canonicalJSON(规范化结果) 对同一条事件恒定，可作为幂等键的输入。
 */

export const TRACKS = ['cn', 'world']
export const PRECISIONS = ['day', 'month', 'year', 'decade', 'century', 'millennium', 'unknown']
export const CERTAINTIES = ['certain', 'probable', 'circa', 'disputed', 'legendary']
export const EVIDENCE_LEVELS = ['A', 'B', 'C', 'D']

/** 允许的年份区间（前 100 万年 ~ 公元 3000 年） */
export const YEAR_MIN = -1000000
export const YEAR_MAX = 3000

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isInt = (v) => typeof v === 'number' && Number.isInteger(v)
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/** 错误信息里安全地展示一个值 */
function show(v) {
  if (v === undefined) return 'undefined'
  let s
  try {
    s = JSON.stringify(v)
  } catch {
    s = String(v)
  }
  if (s === undefined) s = String(v)
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}

/**
 * 读一个字符串字段（自动 trim）。
 * @returns {string|undefined} 校验失败时返回 undefined 并推入 errors
 */
function readString(errors, path, raw, { required = false, min = 0, max = Infinity } = {}) {
  if (raw === undefined || raw === null) {
    if (required) errors.push({ path, message: 'is required' })
    return undefined
  }
  if (typeof raw !== 'string') {
    errors.push({ path, message: `must be a string (got ${typeOf(raw)})` })
    return undefined
  }
  const s = raw.trim()
  if (s.length < min) {
    errors.push({ path, message: min === 1 ? 'must not be empty' : `must be at least ${min} characters (got ${s.length})` })
    return undefined
  }
  if (s.length > max) {
    errors.push({ path, message: `must be at most ${max} characters (got ${s.length})` })
    return undefined
  }
  return s
}

/** 读一个整数字段，可限定范围 */
function readInt(errors, path, raw, { required = false, min = -Infinity, max = Infinity } = {}) {
  if (raw === undefined || raw === null) {
    if (required) errors.push({ path, message: 'is required' })
    return undefined
  }
  if (!isInt(raw)) {
    errors.push({ path, message: `must be an integer (got ${typeof raw === 'number' ? raw : typeOf(raw)})` })
    return undefined
  }
  if (raw < min || raw > max) {
    errors.push({ path, message: `must be between ${min} and ${max} (got ${raw})` })
    return undefined
  }
  return raw
}

/** 读一个浮点数字段（经纬度用），可限定范围 */
function readNumber(errors, path, raw, { min = -Infinity, max = Infinity } = {}) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    errors.push({ path, message: `must be a finite number (got ${typeOf(raw)})` })
    return undefined
  }
  if (raw < min || raw > max) {
    errors.push({ path, message: `must be between ${min} and ${max} (got ${raw})` })
    return undefined
  }
  return raw
}

/** 读一个布尔字段 */
function readBool(errors, path, raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'boolean') {
    errors.push({ path, message: `must be a boolean (got ${typeOf(raw)})` })
    return undefined
  }
  return raw
}

/**
 * 读一个枚举字段。fallback 为 undefined 表示必填。
 * @param {string[]} allowed
 */
function readEnum(errors, path, raw, allowed, fallback) {
  if (raw === undefined || raw === null) {
    if (fallback === undefined) {
      errors.push({ path, message: `is required, one of ${allowed.join('|')}` })
      return undefined
    }
    return fallback
  }
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    errors.push({ path, message: `must be one of ${allowed.join('|')} (got ${show(raw)})` })
    return undefined
  }
  return raw
}

/**
 * 读一个数组字段，逐项交给 itemFn 归一并校验。
 * @param {(errors:object[], path:string, raw:unknown) => (object|undefined)} itemFn
 */
function readArray(errors, path, raw, itemFn) {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) {
    errors.push({ path, message: `must be an array (got ${typeOf(raw)})` })
    return undefined
  }
  const out = []
  for (let i = 0; i < raw.length; i++) {
    const before = errors.length
    const item = itemFn(errors, `${path}[${i}]`, raw[i])
    if (errors.length === before && item !== undefined) out.push(item)
  }
  return out
}

/** time 子树：start_year 必填，precision/certainty 缺省，日期细分字段可选 */
function normalizeTime(errors, raw) {
  const time = {}
  if (!isObject(raw)) {
    errors.push({ path: 'time', message: 'is required and must be an object like { start_year, precision?, certainty? }' })
    return time
  }

  const startYear = readInt(errors, 'time.start_year', raw.start_year, { required: true, min: YEAR_MIN, max: YEAR_MAX })
  if (startYear !== undefined) time.start_year = startYear

  time.precision = readEnum(errors, 'time.precision', raw.precision, PRECISIONS, 'year')
  time.certainty = readEnum(errors, 'time.certainty', raw.certainty, CERTAINTIES, 'certain')

  // 契约外但合法的细分字段：有则校验范围，无则不出现
  const optional = [
    ['start_month', 1, 12],
    ['start_day', 1, 31],
    ['end_year', YEAR_MIN, YEAR_MAX],
    ['end_month', 1, 12],
    ['end_day', 1, 31],
  ]
  for (const [key, min, max] of optional) {
    const v = readInt(errors, `time.${key}`, raw[key], { min, max })
    if (v !== undefined) time[key] = v
  }
  return time
}

/** place 子树：给出则 name 必填，lat/lon 可选但必须在合法区间 */
function normalizePlace(errors, raw) {
  if (raw === undefined || raw === null) return undefined
  if (!isObject(raw)) {
    errors.push({ path: 'place', message: `must be an object like { name, lat?, lon? } (got ${typeOf(raw)})` })
    return undefined
  }
  const place = {}
  const name = readString(errors, 'place.name', raw.name, { required: true, min: 1, max: 200 })
  if (name !== undefined) place.name = name
  const lat = readNumber(errors, 'place.lat', raw.lat, { min: -90, max: 90 })
  if (lat !== undefined) place.lat = lat
  const lon = readNumber(errors, 'place.lon', raw.lon, { min: -180, max: 180 })
  if (lon !== undefined) place.lon = lon
  return place
}

/** claims[i]：statement 必填，evidence_level 必填枚举，adopted 可选布尔 */
function normalizeClaim(errors, path, raw) {
  if (!isObject(raw)) {
    errors.push({ path, message: `must be an object like { statement, evidence_level, adopted? } (got ${typeOf(raw)})` })
    return undefined
  }
  const claim = {}
  const statement = readString(errors, `${path}.statement`, raw.statement, { required: true, min: 1, max: 2000 })
  if (statement !== undefined) claim.statement = statement
  const evidence = readEnum(errors, `${path}.evidence_level`, raw.evidence_level, EVIDENCE_LEVELS)
  if (evidence !== undefined) claim.evidence_level = evidence
  const adopted = readBool(errors, `${path}.adopted`, raw.adopted)
  if (adopted !== undefined) claim.adopted = adopted
  return claim
}

/** sources[i]：title 必填，locator/quote/retrieved_url 可选字符串 */
function normalizeSource(errors, path, raw) {
  if (!isObject(raw)) {
    errors.push({ path, message: `must be an object like { title, locator?, quote?, retrieved_url? } (got ${typeOf(raw)})` })
    return undefined
  }
  const src = {}
  const title = readString(errors, `${path}.title`, raw.title, { required: true, min: 1, max: 300 })
  if (title !== undefined) src.title = title
  const locator = readString(errors, `${path}.locator`, raw.locator, { max: 500 })
  if (locator !== undefined) src.locator = locator
  const text = readString(errors, `${path}.quote`, raw.quote, { max: 4000 })
  if (text !== undefined) src.quote = text
  const url = readString(errors, `${path}.retrieved_url`, raw.retrieved_url, { max: 1000 })
  if (url !== undefined) src.retrieved_url = url
  return src
}

/**
 * 校验一条采集事件，并返回填充了默认值的规范化结果。
 *
 * 成功：`{ ok: true, value }` —— value 只含已知字段，可直接入库 / 计算幂等键。
 * 失败：`{ ok: false, errors: [{ path, message }] }` —— path 形如 `time.start_year`、`claims[0].evidence_level`。
 *
 * @param {unknown} ev
 * @returns {{ok:true,value:object}|{ok:false,errors:{path:string,message:string}[]}}
 */
export function validateEvent(ev) {
  if (!isObject(ev)) {
    return { ok: false, errors: [{ path: '', message: `event must be a JSON object (got ${typeOf(ev)})` }] }
  }

  const errors = []
  const value = {}

  const externalId = readString(errors, 'external_id', ev.external_id, { required: true, min: 1, max: 200 })
  if (externalId !== undefined) value.external_id = externalId

  const title = readString(errors, 'title', ev.title, { required: true, min: 1, max: 300 })
  if (title !== undefined) value.title = title

  value.time = normalizeTime(errors, ev.time)

  const track = readEnum(errors, 'track', ev.track, TRACKS)
  if (track !== undefined) value.track = track

  const category = readString(errors, 'category', ev.category, { required: true, min: 1, max: 40 })
  if (category !== undefined) value.category = category

  const summary = readString(errors, 'summary', ev.summary, { max: 4000 })
  if (summary !== undefined) value.summary = summary

  const place = normalizePlace(errors, ev.place)
  if (place !== undefined) value.place = place

  const claims = readArray(errors, 'claims', ev.claims, normalizeClaim)
  if (claims !== undefined) value.claims = claims

  const sources = readArray(errors, 'sources', ev.sources, normalizeSource)
  if (sources !== undefined) value.sources = sources

  if (errors.length) return { ok: false, errors }
  return { ok: true, value }
}

/** 递归规范化：对象键按字典序排列，数组保持原顺序 */
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize)
  if (v !== null && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue
      out[k] = canonicalize(v[k])
    }
    return out
  }
  return v
}

/**
 * 稳定 JSON 序列化：同一份数据无论键顺序如何都得到同一字符串。
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJSON(value) {
  return JSON.stringify(canonicalize(value))
}
