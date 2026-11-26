/**
 * cache.js —— 零依赖 LRU + TTL 响应缓存（单进程内存，cluster 下每 worker 各一份）。
 *
 *   const cache = createCache({ max: 512, ttlMs: 30_000 })
 *   cache.set(key, '{"ok":true}')
 *   cache.get(key)        // → 字符串 或 undefined（未命中 / 已过期）
 *   cache.stats()         // → { hits, misses, size, hitRate }
 *
 * 设计取舍：
 *   - 命中时**直接写回原始字符串**，不 reparse/restingify，省一次 JSON 序列化。
 *   - LRU 用 Map 的插入顺序实现：get 命中后 delete + set 把键移到队尾；
 *     set 超容时从队头（最久未使用）淘汰。O(1)，无链表维护成本。
 *   - 过期用惰性删除：get 时检查 expires 并清除；不跑定时器，避免常驻 timer
 *     拖住进程退出（server.close 后能干净落幕）。
 *   - stats 里的 hitRate 是 get() 口径：hits / (hits + misses)。
 */

/**
 * @typedef {{ hits:number, misses:number, size:number, hitRate:number }} CacheStats
 */

/**
 * @param {{ max?:number, ttlMs?:number }} [opts]
 * @returns {{ get:(key:string)=>any, set:(key:string,value:any)=>void, stats:()=>CacheStats, clear:()=>void }}
 */
export function createCache({ max = 512, ttlMs = 30_000 } = {}) {
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 512
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : 0

  /** @type {Map<string, { value:any, expires:number }>} */
  const store = new Map()
  let hits = 0
  let misses = 0

  /** TTL 关闭时永不命中（缓存关闭语义），但仍可安全调用 */
  function get(key) {
    if (ttl <= 0) {
      misses++
      return undefined
    }
    const entry = store.get(key)
    if (entry === undefined) {
      misses++
      return undefined
    }
    if (entry.expires <= Date.now()) {
      store.delete(key)
      misses++
      return undefined
    }
    // LRU：命中后移到队尾
    store.delete(key)
    store.set(key, entry)
    hits++
    return entry.value
  }

  function set(key, value) {
    if (ttl <= 0) return
    if (store.has(key)) store.delete(key)
    store.set(key, { value, expires: Date.now() + ttl })
    while (store.size > cap) {
      const oldest = store.keys().next()
      if (oldest.done) break
      store.delete(oldest.value)
    }
  }

  function stats() {
    const lookups = hits + misses
    return {
      hits,
      misses,
      size: store.size,
      hitRate: lookups === 0 ? 0 : Number((hits / lookups).toFixed(4)),
    }
  }

  function clear() {
    store.clear()
  }

  return { get, set, stats, clear }
}
