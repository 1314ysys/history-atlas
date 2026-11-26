# History Atlas · 历史事件编年系统

把零散史料重排成**可按时间浏览、可对照、可溯源**的结构化事件库。

> 存储与检索能力定级：**B+（69.5 / 100）** — 单机千万级以内 A 级，跨入亿级 C 级
> 详见 [docs/report/rating.md](docs/report/rating.md)

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
npm install                 # 依赖（postinstall 会自动复制前端库到 web/vendor）
npm run pg:init             # 初始化原生 PostgreSQL（首次）
npm run pg:start            # 启动数据库（5433）
npm run db:create           # 建库 history_atlas
npm run seed                # 灌入 728 条种子事件
npm start                   # http://127.0.0.1:5173（cluster 4 worker + 缓存）
```

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

## 实测性能

### 检索延迟（50 万事件，生产同款谓词）

| 查询 | p50 | p95 |
|---|---:|---:|
| 区间 10 年 | 5 ms | 7 ms |
| 区间 100 年 | 5 ms | 6 ms |
| 区间 全时段 | 2 ms | 3 ms |
| 检索·精确词 | 3 ms | 5 ms |
| 检索·同义词 | 1 ms | 1 ms |

**关键**：区间查询**全窗口持平** —— 分页早停 + 覆盖索引让延迟与表大小脱钩。

### 并发（`/api/search`）

| 配置 | 冷路径 QPS | 热路径 QPS |
|---|---:|---:|
| 单进程 | 626 | 3,953 |
| cluster(4) | **1,267** | 3,965 |

### 存储

| 项 | 值 |
|---|---:|
| 每事件（含说法/出处/5 类索引） | 1,962 B |
| 1 TB 可容纳 | 5.47 亿事件 |
| 压缩 zstd-9 | 10.12× @ 52 MB/s |

### 写入

| 路径 | 吞吐 |
|---|---:|
| 常规 | 2,876 events/s |
| 批量（关索引 + 重建） | 16,017 events/s |

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
