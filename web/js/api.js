/** 极简 API 客户端 —— 所有前端请求走这里 */

async function request(path, { method = 'GET', body, headers } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`bad JSON from ${path}: ${text.slice(0, 120)}`)
  }
  if (!res.ok) {
    const msg = data?.error?.message || `${res.status} ${res.statusText}`
    const err = new Error(msg)
    err.status = res.status
    err.code = data?.error?.code
    throw err
  }
  return data
}

const qs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

export const getHealth = () => request('/api/health')
export const getBuild = () => request('/api/build')
export const getStats = () => request('/api/stats')

export const getTimeline = (p) => request(`/api/timeline?${qs(p)}`)
export const getEvent = (slug) => request(`/api/event/${encodeURIComponent(slug)}`)
export const getPerson = (slug) => request(`/api/person/${encodeURIComponent(slug)}`)
export const search = (q, limit = 20) => request(`/api/search?${qs({ q, limit })}`)

export const getMapEvents = (p) => request(`/api/map/events?${qs(p)}`)
export const getBoundaries = (year) => request(`/api/boundaries?${qs({ year })}`)
export const getBoundaryList = () => request('/api/boundaries/list')
export const getDynasties = (p = {}) => request(`/api/dynasties?${qs(p)}`)

export const getPersonGraph = (slug, depth = 2) =>
  request(`/api/person/${encodeURIComponent(slug)}/graph?${qs({ depth })}`)
export const getGraphHubs = (limit = 24) => request(`/api/graph/hubs?${qs({ limit })}`)

export const verifyHash = (sha256) => request(`/api/verify/${encodeURIComponent(sha256)}`)
export const getLatestSnapshot = () => request('/api/snapshot/latest')

export { request }
