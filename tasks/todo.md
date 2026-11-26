# Tasks: History Atlas v1

> 状态：**全部完成**（2026-11-22）

- [x] **T0 基础层**（lead）
  - Acceptance: `src/db/schema.sql` 完整建表；`db.client.js` 可 migrate；`domain/time.js` 可格式化前/后/区间/精度；`server.js` 可起服并挂载 api 路由
  - Verify: `/api/health` → `{"ok":true,"db":"up","schema":"1"}`；`node --test tests/time.test.js` 13/13
  - Files: `src/db/*`, `src/domain/*`, `src/server.js`, `web/index.html`, `web/app.css`, `web/js/app.js`, `web/js/api.js`, `src/seed/index.js`, `src/archive/store.js`

- [x] **T1 种子数据·中国史**（agent: seed-cn）
  - 交付：sources 58 / places 78 / persons 165 / events 325 / relations 116
  - 时间跨度 -1,700,000 → 2022；44 条多说法事件
  - Verify: `npm run seed` → cn=325

- [x] **T2 种子数据·世界史与科技史**（agent: seed-world）
  - 交付：sources 62 / places 126 / persons 123 / world events 233 / tech events 170 / relations 99 / boundaries 7
  - discipline 分布：信息 58 / 医 46 / 工 45 / 农 11 / 军 10
  - Verify: world=403（233+170），boundaries=7

- [x] **T3 采集接口**（agent: ingest）
  - 交付：`/v1/ingest/events`、`/v1/ingest/batches/:id`、`/v1/ingest/batches/:id/promote`
  - 幂等：`sha256(collector + external_id + canonicalJSON)`；重投 accepted=0/duplicates=30
  - Verify: `npm run collector` → 30 → 重投 0；promote 30/0 → 二次 0/30；无 token → 401
  - Tests: 12/12

- [x] **T4 检索 + 静态导出**（agent: search-export）
  - 交付：`/api/search`（五档评分）、`scripts/export-static.js`（62 个分片 / 194 KB）
  - Verify: `q=水运仪象台` → 命中 1 条，score 80；`npm run export` → 728 条 / 62 文件
  - Tests: 5/5

- [x] **T5 时间轴前端**（agent: ui-timeline）
  - 交付：`web/js/timeline.js`（双轨 Canvas、四级刻度、LOD 聚合、拖动/缩放/双击复位、tooltip）
  - lead 修复：刻度两端裁切、聚合圆相互重叠（相邻桶合并）
  - Verify: 浏览器 709 条事件渲染，拖动/缩放无报错

- [x] **T6 地图 + 关系图 + 详情**（agent: ui-map）
  - 交付：`/api/map/events`、`/api/boundaries`、`/api/person/:slug/graph`、`/api/graph/hubs` + `web/js/map.js`、`graph.js`、`detail.js`
  - lead 修复：底图换 Esri Dark Gray（CARTO 需 API Key）、置信度 0% 误显示、`app.js` 人物/事件 slug 混用
  - Verify: 截图 04/05/06 均正常

- [x] **T7 存档 + Merkle + 快照**（agent: archive）
  - 交付：`merkle.js`、`/api/verify/:sha256`、`/api/snapshot/latest`、`scripts/snapshot.js`、`scripts/verify-snapshot.js`
  - Verify: 快照 728 事件 / 737 出处，root `7392108b…`；篡改 1 字节 → `SNAPSHOT FAILED` exit 1；还原 → `SNAPSHOT OK`
  - Tests: 12/12

- [x] **T8 集成验收**（lead）
  - 9 条成功标准全部通过；`node --test` 42/42
  - 修复项：`.detail[hidden]` 未生效（CSS 类覆盖 UA 规则）、favicon 404、`npm test` 脚本在 Node 24 下不可用

---

# v2（2026-11-23）

- [x] **T9 主题与 i18n**（lead）
  - `web/js/theme.js`（CSS 变量驱动 + Canvas palette）、`web/js/i18n.js`（zh/en 词典 + 年份格式化）
  - `app.css` 双主题变量、顶栏两个切换按钮、`data-i18n` 全量扫描
  - 切换语言/主题时重建当前视图，视图内部状态由 `app.state` 保留

- [x] **T10 垂直时间轴 + 悬浮筛选面板**（agent: ui-timeline-v2 + lead）
  - 垂直轴、中国左列 / 世界右列、四级刻度、LOD 聚合与聚合圆合并
  - 悬浮面板：时间范围输入、轨道开关、类别多选、实时计数、重置
  - lead 修复：`setRange` 守卫导致**首次区间等于默认值时不发请求**（页面显示 0 条）

- [x] **T11 地图时间切片**（agent: ui-map-v2 + lead）
  - 切片清单 API `/api/boundaries/list`；切片窗口 = 选中切片年份 ±75 年
  - 底部切片条滑块、图例、疆域多边形、事件点位、亮/暗底图自动切换
  - lead 修复：亮色主题换 Esri Light Gray；确认部分渲染是重建时序导致，非缺陷

- [x] **T12 人物生平面板**（agent: ui-person + lead）
  - 新增 `GET /api/person/:slug`（人物 + 相关事件 + 带方向的关系）
  - `renderPerson`：姓名/朝代、生卒、关系度数、事件列表、关系列表（`→` 主动 / `←` 被动）
  - lead 修复：`app.js` 把人物 slug 当事件 slug 的契约冲突

- [x] **T13 性能基准与报告**（agent: bench + lead）
  - `bench/gen.js` / `run.js`，实测 1e3/1e4/1e5 三档 + 图 1e6 + 压缩 5 种编码器 + 索引对比
  - lead 修复：分档复用临时目录未重置 schema 导致唯一键冲突（改为每档 `resetSchema()`）
  - 产出 `docs/report/performance.md`：标度律拟合、500ms 临界规模、100 EB 可行性算术


- [x] **T14 三栏时间轴 + 朝代色带**（agent: ui-timeline-v3 + lead）
  - 布局：粗轴 76px（x≥290 避开悬浮面板）→ 朝代带 20px×N → 事件列 → 细轴 88px
  - 朝代带用区间图着色分列：辽/北宋/金 在 1115–1125 三方并存 → **3 列**（严格着色）
  - 细轴四档：≤40 年按月（`1088-03`）、≤300 年按年、≤2000 年按十年、更大按世纪
  - 新增 `dynasty` 表 + `src/seed/data/dynasties.js`（26 条）+ `GET /api/dynasties`
  - 默认轨道改为**仅中国**；勾选世界后并列第二列
  - lead 修复：Set-Content 写入带来 UTF-8 BOM 导致 schema 执行失败（已全量去 BOM）；事件抖动 22→60px 让点云填充列宽

- [x] **T15 字体清晰度 + 右侧裁切修复**（lead）
  - 根因一：Canvas 文字画在分数坐标上被抗锯齿插值（中文尤明显）→ 重写 `ctx.fillText` 把落点取整
  - 根因二：`canvas` 只设位图尺寸、未设 CSS 尺寸，元素显示尺寸跟随位图 → 缩放导致发虚/越界；现显式写 `canvas.style.width/height`
  - 根因三：详情抽屉 `position:fixed` 直接盖住右侧细时间轴 → 改为 `body[data-view=timeline].drawer-open .view{padding-right}` 让画布让出宽度（地图不让，MapLibre 不响应容器变化会裁图）
  - 字号上调：粗轴 13→14、细轴 10→11、轨道名 11→12、聚合数 9→10；细轴列宽 88→100
  - 溢出防护：`body{grid-template-columns:100%}`、顶栏子项 `min-width:0`、≤1240 隐藏副标题、≤1080 隐藏统计（用 `.topbar .stats` 提高优先级规避被后续基础规则覆盖）

- [x] **T17 按设计方案补齐：原生 PostgreSQL + tsvector/GIN**（lead + agent: fts）
  - 数据库：PGlite → **原生 PostgreSQL 19.0**（npm `@embedded-postgres/windows-x64` 二进制，无需管理员）
    - `data/pg-native` 数据目录，端口 5433，`src/db/client.js` 双模式（有原生库走 pg 连接池，否则回退 PGlite）
    - `scripts/pg-native.js` init/start/stop/status、`scripts/create-db.js`
  - 检索：`LIKE '%q%'` → **tsvector + GIN**
    - `src/domain/tokenize.js`：中文 bigram 分词（零依赖），`toTsv` / `toTsQuery`
    - `event.search_tsv` + `event_fts_idx`（GIN）；seed 与 ingest 均写入
    - `src/api/search.js` 主路径 `@@ to_tsquery`，单字/空查询/异常时回退 LIKE
    - `scripts/backfill-fts.js`：不删库回填 728 行（903 ms）
    - EXPLAIN 证据：`Bitmap Index Scan on event_fts_idx`，执行 0.074 ms
  - 测试：59/59 通过（原 42 + tokenize 17）