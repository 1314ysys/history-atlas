# History Atlas · 历史事件编年系统

![version](https://img.shields.io/badge/version-3.3.1-blue)
![postgres](https://img.shields.io/badge/PostgreSQL-19.0-336791)
![tests](https://img.shields.io/badge/tests-77%2F77-brightgreen)
![rating](https://img.shields.io/badge/rating-B%2B%20(69.5)-orange)
![query](https://img.shields.io/badge/range%20query-2--4ms-success)
![search](https://img.shields.io/badge/fulltext-5ms-success)
![write](https://img.shields.io/badge/write-7800%20ev%2Fs-success)
![storage](https://img.shields.io/badge/storage-1.94KB%2Fevent-informational)

把零散史料重排成**可按时间浏览、可对照、可溯源**的结构化事件库。

> 存储与检索能力定级：**B+（69.5 / 100）** — 单机千万级以内 A 级，跨入亿级 C 级
> 详见 [docs/report/rating.md](docs/report/rating.md)
>
> **核心性能**（20 万事件实测）：区间查询 **2–4 ms** · 全文检索 **5 ms** ·
> 批量写入 **7,800 ev/s** · 存储 **1.94 KB/事件** · 压缩 **10.1×**
> 完整数据见 [性能量化](#性能量化)

---

## 功能

### 浏览

- **三栏时间轴**：左侧粗时间轴（千纪/世纪）、中间事件列、右侧细时间轴（可细到**月份**）
  - 默认只显示**中国**；勾选「世界」后并列一条世界事件列
  - **朝代兴衰色带**：按时代组分色，重叠政权（辽/金/宋）自动分列
  - 悬浮面板筛选时间范围 / 轨道 / 类别，实时计数
- **按时间切片的地图**：选中某一切片，显示该切片窗口的事件与疆域（高德中文底图）
- **人物关系**：点击节点查看生平 + 相关事件 + 与他人的关系（方向、类型、年份）

### 检索

- **全文检索**：tsvector + GIN，中文 bigram 分词（零依赖，应用层实现）
- **相关性排序**：`ts_rank` + 年份稳定排序
- **同义词扩展**：21 组（造纸↔蔡伦、青霉素↔盘尼西林…），进程内缓存
- **拼写建议**：22,041 词表 + 编辑距离（前缀 + 词频加权），零命中时给出候选
- **分面聚合**：`GROUPING SETS` 一次算 track / category / discipline
- **高频词防护**：命中超 5000 条时返回提示而非硬跑（避免 GIN 位图全量物化）

### 数据

- **溯源**：每条引文落到内容寻址存档（sha256），可校验三态（已核实/未核实/已变更）
- **多说法并存**：同一事件可有多条 `event_claim`，各标证据等级 A–D
- **采集接口**：标准 HTTP `/v1/ingest/*`，幂等 + staging → promote
- **快照**：全量 JSONL + Merkle root，可验证镜像未被篡改

### 运行时

- 主题：暗色 / 亮色切换
- 语言：中文 / English 切换
- 静态分片优先：浏览路径 **0 次数据库查询**，CDN 直出
- cluster 多进程 + 响应缓存

---

## 快速开始

```bash
npm install                 # 依赖（postinstall 自动复制前端库到 web/vendor）
npm run pg:init             # 初始化原生 PostgreSQL（首次）
npm run pg:start            # 启动数据库（5433）
npm run db:create           # 建库 history_atlas
npm run seed                # 灌入 728 条种子事件
npm run db:fts              # 回填 search_tsv + 建 GIN 全文索引
npm run db:index            # 加时间轴覆盖索引
npm run db:spell            # 构建拼写词表（22,041 词）
npm run export              # 导出静态分片（浏览走 CDN，不查库）
npm start                   # http://127.0.0.1:5173（cluster 4 worker + 缓存）
```

> **后四步（db:fts / db:index / db:spell / export）不能省略**：
> 缺 `db:fts` 检索会退化为 LIKE 全表扫；缺 `db:spell` 拼写建议为空；
> 缺 `export` 时间轴会回退到 API 查询（仍可用，但失去「浏览零查库」）。

> `web/vendor/` 已在仓库内保留一份产物（maplibre 848 KB），克隆即可运行；
> 升级 maplibre 后用 `npm run vendor` 刷新。
>
> 种子数据在 `src/seed/data/`（13 个文件，623 KB，含 728 条事件 / 276 人物 / 196 地点 / 26 朝代）。

单进程模式：`npm run start:single`

---

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js 24 ESM | 零构建，无 bundler |
| 数据库 | **原生 PostgreSQL 19.0** | npm 提供 Windows 二进制，无需管理员权限 |
| 检索 | tsvector + GIN / pg_trgm | 中文 bigram 分词在应用层完成 |
| 服务端 | `node:http` + `node:cluster` | 手写路由表，4 worker |
| 前端 | 原生 ESM + Canvas 2D | 无框架、无打包 |
| 地图 | MapLibre GL 4.7（UMD） | 高德中文瓦片 |
| 压缩 | zstd-9 | 10.12× @ 52 MB/s |
| 测试 | `node:test` | 77 项 |

---

## 目录

```
src/
  db/          schema.sql、client.js（唯一 DB 入口）、shard.js（分片路由）
  domain/      time.js（纪年）、tokenize.js（中文 bigram）、spell.js（编辑距离）
  api/         timeline / search / event / person / map / graph / dynasties /
               boundaries / stats / metrics / verify / snapshot
  ingest/      schema / validate / router
  export/      static.js（静态分片导出）
  archive/     store.js（内容寻址）+ merkle.js
  search/      facets.js（分面聚合纯函数）
  seed/        index.js + data/*.js（13 个数据集）
  server.js    路由装配 + 静态服务 + 响应缓存
  cluster.js   多进程入口
  cache.js     LRU + TTL
web/           index.html / app.css / js/*
scripts/       运维与数据脚本（22 个）
bench/         压测脚本（15 个）
tests/         77 项测试
docs/
  spec/        契约
  plan/        实施方案
  report/      性能 / 分区 / 读写分离 / 分片 / 定级 五份报告
tasks/         计划与任务清单
```

---

## 性能量化

> 全部数据为实测（`bench/precise.js` / `scripts/copy-import-parallel.js`），非估算。
> 环境：Windows / Node 24 / PostgreSQL 19.0（原生，非 WASM）
> **测查询延迟时必须停掉应用进程**——否则测的是「数据库 + 应用争用 CPU」的结果。

### 版本演进与提升

| 版本 | 主要变更 | 写入吞吐 | 关键指标 |
|---|---|---:|---|
| v3.0.0 | 基线：PG 19 + tsvector/GIN + 覆盖索引 + 分页早停 | 2,797 ev/s | 区间 5 ms / 检索 4 ms（50 万） |
| v3.0.4 | 修 `loadVocab` 缓存 bug | — | **零命中检索 67 ms → 1 ms** |
| v3.0.6 | 删冗余索引 `event_year_idx` | — | 索引体积 -5% |
| v3.1.0 | COPY 并行导入 | 4,472 ev/s（1.64×） | — |
| **v3.2.0** | **worker 并行预生成 + setval 批量 id** | **7,800 ev/s（2.87×）** | — |

### 存储（20 万事件实测）

| 项 | 值 |
|---|---:|
| **每事件占用** | **1,942 B** |
| 数据库总计 | 370.4 MB |
| ├ event（heap 143.3 + 索引 71.9） | 215.3 MB |
| ├ event_claim | 75.2 MB |
| └ event_source | 71.0 MB |
| **1 TB 可容纳** | **5.53 亿事件** |

**索引明细**（event 表，9 个索引共 71.9 MB）：

| 索引 | 体积 | 用途 |
|---|---:|---|
| `event_fts_idx`（GIN） | 21.2 MB | 全文检索 |
| `event_timeline_cover_idx`（INCLUDE） | 18.9 MB | 时间轴覆盖索引 |
| `event_summary_trgm_idx`（GIN） | 8.0 MB | 摘要模糊匹配 |
| `event_slug_key` | 5.9 MB | 唯一约束 |
| `event_span_idx`（GiST） | 5.7 MB | 区间相交 |
| 其余 4 个 | 8.2 MB | 主键 / 轨道 / 地点 / 状态 |

### 查询延迟（20 万事件，无应用负载）

| 查询 | p50 | p95 | p99 |
|---|---:|---:|---:|
| 区间 10 年 | **4 ms** | 6 ms | 6 ms |
| 区间 100 年 | **4 ms** | 5 ms | 7 ms |
| 区间 500 年 | **4 ms** | 7 ms | 8 ms |
| 区间 全时段 | **2 ms** | 3 ms | 3 ms |
| 区间 100 年 + total | 5 ms | 11 ms | 11 ms |
| 检索·精确词 | **5 ms** | 7 ms | 9 ms |
| 检索·无命中 | **1 ms** | 2 ms | 3 ms |
| 检索·高频词 | 0 ms | 0 ms | 0 ms（`tooBroad` 拦截） |

**关键：区间查询全窗口持平（2–4 ms）** —— 分页早停 + 覆盖索引让延迟与表大小脱钩。

### 规模效应（延迟几乎不随数据量增长）

| 查询 | 5 万 | 20 万 | 50 万 | 增长 |
|---|---:|---:|---:|---:|
| 区间 10 年 | 2 ms | 4 ms | 5 ms | 2.5× |
| 区间 全时段 | 2 ms | 2 ms | 2 ms | **1.0×** |
| 检索 精确词 | 3 ms | 5 ms | 4 ms | 1.3× |
| 存储密度 | 2,114 B | 1,942 B | 1,944 B | 稳定 |

数据量涨 10 倍，延迟只涨 1.3–2.5 倍。

### 写入吞吐

| 方式 | 耗时（20 万） | 吞吐 | 相对 |
|---|---:|---:|---:|
| 逐行 INSERT + UPDATE 回填 | 73,546 ms | 2,719 ev/s | 1.00× |
| COPY + 串行预生成（v3.1.0） | 44,724 ms | 4,472 ev/s | 1.64× |
| **COPY + worker 并行（v3.2.0）** | **~25,600 ms** | **~7,800 ev/s** | **2.87×** |

**v3.2.0 耗时分解**（8 worker）：

| 阶段 | 耗时 | 占比 |
|---|---:|---:|
| 预分配 id（setval） | 25 ms | 0.1% |
| 并行预生成 | 7,936 ms | 28.5% |
| COPY event（含 tsvector） | 9,077 ms | 32.6% |
| 并行 claims/sources | 3,428 ms | 12.3% |
| 重建外键 | 1,642 ms | 5.9% |
| 重建索引 | 5,755 ms | 20.7% |

**最优 worker 数 = 8**（12 核的 2/3）；16 worker 因超订反而慢（8,030 vs 8,593 ev/s）。

### 并发 QPS（`/api/search`）

| 配置 | 冷路径 QPS | 热路径 QPS | p50@16 |
|---|---:|---:|---:|
| 单进程 | 626 | 3,953 | 24.7 ms |
| **cluster(4)** | **1,267** | 3,965 | **11.0 ms** |

冷路径 2.02×（cluster 的真实价值）；热路径已由缓存饱和。

### 压缩（JSONL dump，50 万事件 / 131.6 MB 原始）

| 编码器 | 压缩比 | 压缩吞吐 | 解压吞吐 | 建议 |
|---|---:|---:|---:|---|
| gzip-6 | 8.95× | 77.5 MB/s | 421.8 MB/s | 通用兼容 |
| zstd-3 | 7.82× | **328.2 MB/s** | 351 MB/s | 最快 |
| **zstd-9** | **10.12×** | 44.9 MB/s | **457 MB/s** | **甜点** |
| zstd-19 | 12.87× | 0.9 MB/s | 317 MB/s | 仅离线 |
| brotli-5 | 9.91× | 49.6 MB/s | 406 MB/s | 备选 |

> 合成数据重复度高，压缩比偏乐观 1.5–2×；真实史料按 **4–6×** 规划。

### 优化项与收益汇总

| 优化 | 收益 | 版本 |
|---|---|---|
| tsvector + GIN（替代 `LIKE '%q%'`） | 检索 **1,492 → 4 ms（373×）** | v2 |
| 分页早停 + 覆盖索引 | 区间查询与规模脱钩（2–5 ms 恒定） | v3.0.0 |
| 修 `loadVocab` 缓存条件 | 零命中 **67 → 1 ms（67×）** | v3.0.4 |
| 删冗余索引 `event_year_idx` | 索引体积 -5% | v3.0.6 |
| COPY 并行导入 | 写入 **1.64×** | v3.1.0 |
| setval 批量 id 分配 | **10,207 → 25 ms（408×）** | v3.2.0 |
| worker 并行预生成 | 写入 **1.64× → 2.87×** | v3.2.0 |
| cluster(4) + 响应缓存 | QPS **2.02×（冷）/ 5.4×（热）** | v3.0.0 |
| zstd-9 分块压缩 | **10.1×** | v3.0.0 |

### 已被实测否决的优化

| 优化 | 预期 | 实测 | 原因 |
|---|---|---|---|
| tsvector 内联计算 | 更快 | **0.33×（慢 3 倍）** | 单行 INSERT 的网络往返远超一次 UPDATE |
| 按世纪分区 | 更快 | **0.24–0.29×** | 剪枝省的工作量本就不存在（`LIMIT 200` 只碰几页） |
| 读写分离 | QPS ↑ | **0%（噪声内）** | 瓶颈在单进程 Node，不在 PG |
| 分片（30 万量级） | 更快 | **0.50×** | 扇出成本 > 并行收益 |
| 内联 tsvector + COPY | 省 16s 回填 | **总时间 +15%** | 预生成与 COPY 的增量超过回填的节省 |

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 单机单库 | 分区/读写分离/分片均实测否决，见 `docs/report/` |
| 单表 >1 亿行 | 索引超内存，未验证 |
| 高频词检索 | 454 ms @ 50 万（有 `tooBroad` 防护） |
| 无自动 failover | 主库挂了需手动 promote |
| 拼写仅建议 | 不自动纠正查询 |
| 多语言分词 | 仅中文 bigram + ASCII |
| 数据规模 | 728 条种子数据，非生产数据 |

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/report/rating.md](docs/report/rating.md) | **能力定级（B+ / 69.5）** |
| [docs/report/performance.md](docs/report/performance.md) | 性能基准与优化记录（38 KB） |
| [docs/report/partition.md](docs/report/partition.md) | 分区实测：负收益，否决 |
| [docs/report/read-split.md](docs/report/read-split.md) | 读写分离实测：QPS 收益 0% |
| [docs/report/sharding.md](docs/report/sharding.md) | 分片实测：30 万量级负收益 |
| [docs/spec/history-atlas.spec.md](docs/spec/history-atlas.spec.md) | API 契约与数据模型 |
| [docs/plan/history-timeline-v1.md](docs/plan/history-timeline-v1.md) | 初始技术方案 |

---

## 常用命令

```bash
# 数据库
npm run pg:status / pg:stop
npm run db:fts              # 回填 tsvector + 建 GIN 索引
npm run db:index            # 加覆盖索引
npm run db:spell            # 建拼写词表

# 主从
npm run replica:init / replica:start / replica:setup / replica:status

# 备份
npm run backup
npm run backup:verify       # 恢复到临时库并逐表比对

# 压测
npm run bench:qps           # QPS 三组对比
npm run bench:v2            # 综合压测
npm run bench:paging        # 分页 + 覆盖索引
npm run bench:storage       # 存储 + 压缩

# 数据
npm run export              # 导出静态分片
npm run snapshot            # 生成 Merkle 快照
npm run collector           # 假采集器（验证 ingest）
```

---

## 许可证

未指定。如需开源请自行添加 LICENSE。
