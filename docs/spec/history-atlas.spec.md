# Spec: History Atlas v1（历史事件编年系统）

> 依据 `docs/plan/history-timeline-v1.md`，本文件是其**可执行收敛版**。
> 状态：已冻结（冻结后改动需同步更新本文件）

## 1. Objective

构建一个**可运行**的历史事件编年系统 v1：事件按时间排序，每条可溯源到史料原文并做哈希校验，支持中外对照、地理呈现、人物关系、全文检索、标准化采集接口、可验证快照。

**成功标准（全部可测）**

| # | 条件 | 验证方式 |
|---|---|---|
| 1 | `npm run dev` 后 `http://localhost:5173` 打开可见时间轴 | 浏览器 / curl |
| 2 | 时间轴可拖动、可缩放，渲染 ≥600 条事件 | 目视 + `/api/stats` |
| 3 | 点击事件显示详情：时间（含精度/确定性）、多说法、引文、校验状态 | 目视 |
| 4 | 地图显示事件点位 + 5 个示意疆域切片，随时间联动 | 目视 |
| 5 | 人物关系图可展开 2 跳 | 目视 |
| 6 | 搜索「水运仪象台」返回相关事件 | curl |
| 7 | `POST /v1/ingest/events` 幂等入库到 staging，并可通过 promote 转正式 | `npm run collector` |
| 8 | `npm run snapshot` 产出带 Merkle root 的目录，篡改可检出 | `node scripts/verify-snapshot.js` |
| 9 | `npm test` 全绿 | CI |

## 2. Tech Stack

| 项 | 选型 | 版本 |
|---|---|---|
| 运行时 | Node.js ESM，**零构建** | 24.x |
| 数据库 | **PGlite**（PostgreSQL 18 WASM），生产切同 schema 的 Postgres | 0.5.17 |
| 服务器 | `node:http`，无框架 | — |
| 前端 | 原生 ESM + Canvas 2D，无框架、无打包 | — |
| 地图 | MapLibre GL JS（本地 vendor） | 6.x |
| 压缩 | `node:zlib` zstd（缺失时回退 brotli） | — |
| 测试 | `node:test` | — |

**明确的取舍**：不用 TypeScript（省构建）、不用 React（省打包）、不用 PostGIS（用 lat/lon + 包围盒）、不用 Elasticsearch（PGlite LIKE + 评分）。生产升级路径写在 §9。

## 3. Commands

```bash
npm install                 # 依赖
npm run dev                 # 启动，默认 :5173
npm run seed                # 重建并灌入种子数据
npm run export              # 导出静态时间轴分片到 web/generated/
npm run snapshot            # 生成快照 + Merkle root
npm run collector           # 假采集器，验证 /v1/ingest
npm test                    # 全部测试
```

## 4. Project Structure

```
src/
  db/         schema.sql、client.js（唯一 DB 入口）
  domain/     time.js（纪年格式化/解析）、ids.js
  seed/       index.js + data/*.js（事件/人物/地点/关系/疆域）
  api/        timeline.js event.js search.js map.js graph.js verify.js stats.js
  ingest/     schema.js validate.js router.js
  export/     static.js
  archive/    store.js merkle.js
  server.js   路由表 + 静态服务 + JSON 工具
web/
  index.html  app.css  js/*.js  vendor/（maplibre）  generated/（导出产物）
scripts/      seed.js export-static.js snapshot.js verify-snapshot.js fake-collector.js
tests/        *.test.js
data/         pg/（PGlite 数据目录，gitignore）
storage/      archive/（内容寻址存档，gitignore）
snapshots/    快照产物（gitignore）
```

## 5. Code Style

```js
// 纯函数优先；副作用集中在 db/client.js、server.js、scripts/
import { db } from '../db/client.js'

/** 格式化纪年。@param {number} y @returns {string} */
export function formatYear(y) {
  return y < 0 ? `前${-y}年` : `${y}年`
}

export async function listEvents({ from, to, limit = 500 }) {
  const { rows } = await db.query(
    `SELECT id, title, t_start_year FROM event
      WHERE t_span && int4range($1, $2) ORDER BY t_start_year LIMIT $3`,
    [from, to, limit],
  )
  return rows
}
```

约定：2 空格缩进、单引号、尾逗号、分号；文件名 kebab-case；函数 camelCase；
公开函数写 JSDoc；**所有 SQL 必须参数化**。

## 6. Testing Strategy

- 框架：`node:test` + `node:assert/strict`
- 位置：`tests/*.test.js`
- 层级：单元（time/merkle/validate）+ 集成（API 用 `fetch` 打真实 server）
- 覆盖要求：`domain/time.js` 分支全覆盖；每个 API 至少 1 条 happy path；ingest 幂等 1 条

## 7. API 契约（冻结）

统一返回 JSON；错误 `{ error: { code, message } }`；CORS 全开（只读）。

```
GET  /api/health                      → { ok, db, version }
GET  /api/stats                       → { events, persons, places, claims, sources, verified }
GET  /api/timeline?from&to&track&limit → { from, to, total, events:[EventLite] }
GET  /api/event/:slug                 → { event, claims[], sources[], persons[], place }
GET  /api/search?q&limit              → { q, total, hits:[{slug,title,summary,t_start_year,score}] }
GET  /api/map/events?from&to          → { events:[{slug,title,lat,lon,t_start_year,track}] }
GET  /api/boundaries?year             → GeoJSON FeatureCollection
GET  /api/person/:slug/graph?depth=2  → { nodes:[{id,name}], edges:[{from,to,type}] }
GET  /api/verify/:sha256              → { sha256, status, size, checked_at }
GET  /api/snapshot/latest             → { date, root, manifest_url }

POST /v1/ingest/events                → { batch_id, accepted, rejected, staged, errors[] }
GET  /v1/ingest/batches/:batchId      → { batch_id, status, accepted, rejected, errors[] }
POST /v1/ingest/batches/:batchId/promote → { promoted, skipped }
```

`EventLite = { slug, title, t_start_year, t_end_year, t_precision, t_certainty, track, category, lat, lon }`

**鉴权**：`/v1/ingest/*` 需 `Authorization: Bearer <INGEST_TOKEN>`，默认 `dev-token`。

## 8. Boundaries

**Always**
- SQL 参数化；改动 schema 同步更新 `schema.sql` 与 spec
- 新 API 先加测试
- 时间一律走 `domain/time.js`，禁止散落格式化逻辑

**Ask first**
- 增加 npm 依赖
- 改 API 契约（会打断并行开发）
- 引入构建步骤

**Never**
- 提交 `data/`、`storage/`、`snapshots/`、`.npm-cache/`
- 在 API 层直接拼 SQL 字符串
- 让 LLM 生成 SQL 并执行
- 把 `web/vendor/` 里的第三方库改成自有代码

## 9. 生产升级路径（v1 不做，但要留口）

| v1 | 生产 |
|---|---|
| PGlite | 真 Postgres（同一份 `schema.sql`） |
| lat/lon + 包围盒 | PostGIS `geography(Point)` + GiST |
| `LIKE` + 应用层评分 | `tsvector`/GIN + `pg_trgm` + BM25 |
| 单进程 | 多副本 + 只读连接池 |
| 本地 `storage/archive` | R2/B2 + CDN |

## 10. Open Questions（已决，记录备查）

- **静态优先 vs API**：v1 时间轴走 API（简单可靠），但 `npm run export` 管线照常实现并产出分片，作为 v2 默认路径的证明。
- **历史疆域精度**：仅示意，需在 UI 明确标注「示意，非学术精度」。
- **争议数据**：一律用 `event_claim` 多行并存，不合并。

## 11. 实现偏差记录（v1 实际交付 vs 本 spec）

| 项 | 原计划 | 实际 | 原因 |
|---|---|---|---|
| 技术栈语言 | TypeScript | **纯 JavaScript + JSDoc** | 消除构建步骤，Node 直接跑；生产可平移 |
| 地图底图 | CARTO dark_all | **Esri Dark Gray Canvas** | CARTO 已要求 API Key，Esri 无需密钥 |
| 时间轴数据源 | 静态分片优先 | **API 优先**（分片仍产出） | v1 简化；分片管线已可用，v2 切换即可 |
| 关系图点击语义 | onSelect(事件) | **以人物为中心重新展开** | 图中节点是人物，用事件 slug 会 404 |
| `GET /api/verify/:sha256` | 4 字段 | 多返回 `first_seen_at` | 便于展示首次入档时间，属增量字段 |
| 额外端点 | — | `GET /api/graph/hubs?limit` | 关系图需要默认入口 |
| `tech` 表 | 独立技术条目表 | 建表但 v1 未灌数据 | 科技事件以 `event` + `discipline` 表达，`tech` 留作 v2 |
| `npm test` | `node --test tests/` | **`node --test`** | Node 24 不再接受目录参数 |

**数据现状**：728 条事件（中国 325 / 世界 403）、276 人物、196 地点、914 说法、737 条出处引用，其中 **45 条引文已入内容寻址存档并通过哈希校验**，其余标为「未核实」——这是设计的正常状态，不是缺陷。
