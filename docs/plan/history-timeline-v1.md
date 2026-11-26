# 历史事件编年系统 · v1 技术方案

> 依据：`docs/intent/history-timeline.md`（已确认）
> 范围：框架 v1，不含内容采集
> 周期：12 周 / 小团队 2–5 人 / 预算 ≤ $200 月

---

## 0. 一页纸选型

| 层 | 选型 | 关键理由 |
|---|---|---|
| 主数据库 | **PostgreSQL 16** + PostGIS + pgvector | 一套系统同时覆盖时间区间、空间、图、全文四类索引；避免多引擎同步 |
| 中文分词 | **应用层 jieba** → 存 token 列 | 托管 PG 装 `zhparser` 很痛；应用层分词可移植、可换 |
| 模糊匹配兜底 | `pg_trgm` GIN | CJK 子串检索不依赖词典 |
| 浏览分发 | **静态 JSON 分片 + Cloudflare** | 浏览不查库（见 §3.3） |
| 检索服务 | 单个 API 进程（Go / Node / Python 任一） | 只有搜索和写入走它 |
| 对象存储·热 | **Cloudflare R2** | 出流量免费 |
| 对象存储·冷 | Backblaze B2 | $0.006/GB·月，影印件按需取 |
| 压缩 | **zstd -19 分块（1 MB）** | 3.5–4×，解压 1.5 GB/s，可随机访问 |
| 时间轴前端 | **Canvas 2D + LOD 分箱** | 10⁵ 事件流畅；不引入 WebGL 复杂度 |
| 地图前端 | **MapLibre GL JS + 自托管 PMTiles** | 零 tile 授权费，观感达商业级 |
| 人物关系图 | **Sigma.js v3（WebGL）+ graphology** | 万级节点可用 |
| LLM | 外挂 API，只做抽取/翻译/组织 | **不做事实存储** |
| 部署 | 1 台 VPS + 托管 PG + 静态 CDN | 无 K8s、无微服务、无消息队列 |

**不用**：Elasticsearch、Neo4j、ClickHouse、Kafka、Kubernetes、向量数据库作为主索引。

---

## 1. 数据模型

### 1.1 核心表

```
source            史料来源
  id, title, author, era, kind(古籍/论文/档案/器物/网页),
  archive_sha256, license, retrieved_url, retrieved_at

archive_blob      内容寻址存档
  sha256(PK), size, mime, storage_key, first_seen_at

event             事件（唯一的时间轴一等公民）
  id, slug, title, category, discipline,
  t_start_year, t_start_month, t_start_day,
  t_end_year,   t_end_month,   t_end_day,
  t_precision(enum), t_certainty(enum),
  t_span(int4range)  ← 生成列，供 GiST
  place_id, geom(point), summary, status(draft/reviewed/published), rev

event_claim       说法（同一事件的多版本解释）★核心设计
  id, event_id, statement, evidence_level(A/B/C/D),
  confidence, disputed_group, adopted(bool), rationale

event_source      引用（claim → 史料的具体位置）
  id, event_id, claim_id, source_id,
  locator(卷/页/行/段), quote, quote_sha256, verified_status

person / person_relation
  person(id, name, aliases[], birth_year, death_year, dynasty)
  person_relation(id, from_id, to_id, type, t_span, source_id)

place             历史地名（随时间变化）
  id, name, aliases[], geom, admin_level, t_span, parent_id

tech              技术/发明条目
  id, name, category(医/工/农/军/信息), first_attested_year,
  region, place_id, source_id, note
```

### 1.2 为什么 `event_claim` 是核心

历史数据不能存成「一个事件一个结论」。`event_claim` 让同一事件并存多种说法：

| 事件 | claim | 证据等级 | 采纳 |
|---|---|---|---|
| 二里头文化性质 | 夏朝都城 | B | ✅ |
| 二里头文化性质 | 早商或未知政权 | B | ❌ |
| 二里头文化性质 | 无法判定 | C | ❌ |

前端默认展示 `adopted=true`，但**永远提供「其他说法（2）」入口**。这是与百科类产品的根本差异。

### 1.3 分区策略

`event` 与 `event_source` 按 `t_start_year` 每 500 年一个分区（约 6 个活跃分区）。超过 10⁶ 条再考虑按世纪细分。**v1 不做分区**，等 10⁶ 再说——过早分区是负担。

---

## 2. 时间建模（最容易做错的地方）

### 2.1 不要用 timestamp

```
❌ t DATETIME          —— 无法表达公元前、无法表达"约"
❌ daterange           —— 无法表达 ±30 年的不确定度
✅ 拆列 + 精度 + 确定度
```

### 2.2 推荐结构

```sql
t_start_year  INT      -- 公元前用负数（前 1046 = -1046）
t_start_month SMALLINT -- NULL 表示不确定到月
t_start_day   SMALLINT -- NULL 表示不确定到日
t_end_*       -- 同一套，区间事件用
t_precision   ENUM('day','month','year','decade','century','millennium')
t_certainty   ENUM('certain','probable','circa','disputed','legendary')
t_span        INT4RANGE GENERATED ALWAYS AS
              (int4range(t_start_year, COALESCE(t_end_year, t_start_year) + 1))
              STORED
```

### 2.3 排序与展示

```sql
ORDER BY t_start_year, COALESCE(t_start_month,0), COALESCE(t_start_day,0), id
```

展示格式化：

| precision | certainty | 显示 |
|---|---|---|
| year | certain | 前 1046 年 |
| year | circa | 前 1046 年（约） |
| decade | — | 前 1040 年代 |
| century | — | 公元前 11 世纪 |
| year | disputed | 前 1046 年（一说前 1027） |

**不要为了"好看"把刻度做到天**——那是虚假精度，比粗糙更有害。

### 2.4 纪年换算层（v1 只做最小可用）

```
输入：周威烈王二十三年 / 康熙二十三年 / 民国二十六年 / 干支
输出：-403 / 1684 / 1937
```

实现：**年号表 + 干支表 + 换算规则表**（Postgres 两张小表），不靠 LLM。LLM 只用于生成候选，必须人工确认后才入表。

---

## 3. 索引与检索

### 3.1 四类索引

| 维度 | 索引 | 查询形态 |
|---|---|---|
| 时间 | GiST on `t_span` | 「前 500–前 200 年间所有事件」 |
| 空间 | PostGIS GiST on `geom` | 「以咸阳为中心 300 km 内」 |
| 人物图 | B-tree on `(from_id)` + 递归 CTE | 「与苏颂有直接关系的人」 |
| 文本 | GIN on `to_tsvector('simple', tokens)` + `pg_trgm` | 「水运仪象台」 |

### 3.2 中文全文检索的做法

```sql
-- 写入时（应用层 jieba 分词）
tokens = jieba.cut(title || summary)      -- → ["水运","仪象台","苏颂","制造"]
tsv    = to_tsvector('simple', join(tokens,' '))

-- 索引
CREATE INDEX ON event USING GIN (tsv);
CREATE INDEX ON event USING GIN (title gin_trgm_ops);
```

**为什么不用 `zhparser`**：托管 PG 常需自行编译扩展，升级即崩；应用层分词还能随时换模型。

### 3.3 浏览走静态，检索走 API

```
浏览：/timeline/{era}/{zoom}.json  ← 预渲染，CDN 常驻
      /api/event/{id}.json         ← 预渲染
检索：POST /api/search             ← 唯一需要实时查询的入口
```

预渲染粒度：

| 视图 | 粒度 | 单文件大小 |
|---|---|---|
| 全球万年 | 每 100 年 | ~200 KB |
| 单世纪 | 每 10 年 | ~300 KB |
| 单十年 | 逐年 | ~150 KB |

**结论：>95% 的请求不碰数据库。**

### 3.4 检索链路

```
NL 查询
  ↓ LLM 路由（结构化 / 关键词 / 语义）
  ├ 结构化 → SQL 模板（参数化，禁止 LLM 直出 SQL 执行）
  ├ 关键词 → tsvector + trgm，BM25 式排序
  └ 语义   → pgvector（v1 可选，仅作补充）
  ↓ 融合重排（RRF）
  ↓ 返回事件 ID + 摘要 + 引用哈希
```

**禁止**：让 LLM 直接生成 SQL 并执行。用参数化模板 + 槽位填充。

---

## 4. 压缩策略

### 4.1 分层

| 数据 | 策略 | 预期压缩率 |
|---|---|---|
| 数据库内 | `default_toast_compression = lz4` | 1.8–2.2× |
| 引用存档原文 | 按 1 MB 切片，每片独立 `zstd -19` | 3.5–4× |
| 全量 dump | `tar + zstd -19 --long=27` | 4–4.5× |
| JSON API | CDN 层 brotli | 4–6× |
| 图像 | 原格式（JPEG/JPEG2000 已压） | 1× |

### 4.2 为什么是分块 zstd 而不是 seekable frame

每块一个独立 `.zst` 文件，索引 `(blob_sha256, block_no, offset, length, uncompressed_len)` 存在 Postgres。

- 单块解压 < 1 ms
- 块可独立放对象存储，天然可缓存
- 不依赖 seekable 格式的生态支持

### 4.3 明确不用

- ❌ `cmix` / `nncp`（8–9×，但 1–2 KB/s，无法实时）
- ❌ `xz` 单文件（随机访问差）
- ❌ 加密压缩（先压后加，别用加密容器的内置压缩）

---

## 5. 前端渲染

### 5.1 时间轴：Canvas 2D + LOD

```
视口 = [t_min, t_max]，屏幕宽 W
每个事件 → (t_start_year → x 坐标)
重叠 → 按行分箱（bin packing）
密度 > 阈值 → 聚合为一个簇（"前 500–前 400：47 件事"）
```

- 10⁴ 事件：Canvas 2D 直接画，60fps
- 10⁵–10⁶：加四叉树 + 视口裁剪，仍是 Canvas 2D
- **不上 WebGL**，除非确认超过 10⁶ 且确有需要

中外对照：双轨布局（左轨中国 / 右轨世界），共享时间轴，中间连线表示同期事件。

### 5.2 地图：MapLibre + 自托管 PMTiles

```
basemap:  protomaps 构建 z0–14（约 20–50 GB）→ R2 → PMTiles
overlay:  历史疆域 GeoJSON（按时间切片，5–10 个切片）
          + 事件点位（随视口加载）
```

- 零 tile 授权费，观感接近商业地图
- 历史疆域**必须**标注「示意，非学术精度」，并在图例里写明数据来源
- 时间滑块联动：拖动时间轴 → 疆域图层切换

### 5.3 人物关系图：Sigma.js

- WebGL 渲染，万级节点可交互
- 边按关系类型着色，时间过滤用 `t_span` 裁剪
- 默认只展开 2 跳，避免毛球

---

## 6. LLM 介入点

| # | 位置 | 做什么 | 不做什么 |
|---|---|---|---|
| 1 | 采集抽取 | 文本 → 事件候选（NER + 时间表达式 + 关系） | 不得直接入库，只进 staging |
| 2 | 纪年换算 | 生成候选换算 | 不得作为权威，需人工确认入表 |
| 3 | 查询理解 | NL → 槽位（时间/地点/人物/类别） | 不得直接生成 SQL 执行 |
| 4 | 答案组织 | 检索结果 → 自然语言 | **每个断言必须挂 event_id + quote_sha256** |
| 5 | 引用核对 | 比对 quote 与存档原文 | 不匹配即拒绝展示 |

### 硬规则

```
无出处 → 不给答案
出处未校验 → 标「未核实」
校验失败 → 标「已变更」并隐藏原文
```

### 明确不做

- ❌ 用 LLM 权重存事实
- ❌ 用向量库当唯一索引（冷门条目必然召不回）
- ❌ 让 LLM「综合」多个矛盾说法（必须并列，不融合）

---

## 7. 采集接口规范（v1 只定协议，不实现采集）

```http
POST /v1/ingest/events
Authorization: Bearer <collector-key>
Idempotency-Key: <sha256 of body>

{
  "collector": "manual-import-v1",
  "batch_id": "2026-11-22-a",
  "events": [{
    "external_id": "ctext:zztj:周纪一:1",
    "title": "三家分晋",
    "time": {"start_year": -403, "precision": "year", "certainty": "certain"},
    "category": "politics",
    "place": {"name": "晋阳", "lat": 37.75, "lon": 112.55},
    "claims": [{"statement": "...", "evidence_level": "A"}],
    "sources": [{
      "title": "资治通鉴", "locator": "周纪一·威烈王二十三年",
      "quote": "初命晋大夫魏斯、赵籍、韩虔为诸侯。",
      "retrieved_url": "https://..."
    }]
  }]
}
```

响应：

```json
{"accepted": 12, "rejected": 1, "staged": true,
 "review_url": "/admin/staging/batch/2026-11-22-a",
 "errors": [{"external_id": "...", "code": "TIME_INVALID"}]}
```

流程：`staging → 人工审核 → published`。**任何采集器都不能直接写生产表。**

「假采集器」作为验收工具：随机生成 1000 条符合 schema 的事件 + 故意制造 5 条时间矛盾。

---

## 8. 可验证引用与快照

### 8.1 三级校验状态

| 状态 | 条件 | 前端表现 |
|---|---|---|
| 已核实 | `sha256(quote)` == 存档原文对应片段 | ✅ 绿色 |
| 未核实 | 有 quote 但未存档 | ⚠️ 黄色 |
| 已变更 | 存档哈希不匹配 / 原文已下架 | ❌ 红色 + 隐藏 |

### 8.2 每日 Merkle root

```
leaf   = sha256(event_id || claim_id || quote_sha256 || source_sha256)
root   = Merkle(所有 leaves)
发布：/snapshot/2026-11-22/root.txt + 全量 dump 的 sha256
```

任何人下载 dump 后可自行复算 root，验证镜像未被篡改。**这就是「多节点分发」的实际形态**——不是 P2P 传输，是可验证的镜像。

### 8.3 dump 产物

```
snapshot-2026-11-22/
  events.jsonl.zst
  claims.jsonl.zst
  sources.jsonl.zst
  archive/           # 按 sha256 前缀分桶
  MANIFEST.json      # 各文件 sha256 + 总 root
```

---

## 9. 里程碑（12 周）

| 周 | 交付 | 验收 |
|---|---|---|
| **W1–3** | 数据模型 + 迁移 + 时间模型 + 500 条种子数据 + 静态导出器 | `curl /timeline/-500/1.json` 返回正确 JSON |
| **W4–6** | 时间轴 Canvas 渲染（LOD）+ 事件详情页 + 搜索 API | 拖时间轴 60fps，搜索命中率 >80% |
| **W7–9** | MapLibre + PMTiles + 历史疆域示意层 + Sigma.js 关系图 | 地图与时间轴联动无卡顿 |
| **W10–11** | 引用存档 + 哈希校验 + Merkle root + dump 脚本 | 篡改一条 quote 能被检出 |
| **W12** | 采集接口 + 假采集器 + 文档 + 部署 + 压测 | 第三方按文档 1 小时内接进来 |

**关键路径**：W1–3 的时间模型。做错了 W7 之后会全面返工。

---

## 10. 成本（v1 实际，不含 20 TB 冷层）

| 项 | 规格 | 月成本 |
|---|---|---|
| 托管 Postgres | Neon Launch / Supabase Pro | $19–25 |
| VPS（API + 渲染） | Hetzner CX22 | $5 |
| R2（热文本 + tiles） | 100 GB + 出流量免费 | $1.5 |
| Cloudflare CDN | 免费额度 | $0 |
| LLM API | 抽取 + 查询 | $20–50 |
| 域名 / 监控 | — | $5 |
| **合计** | | **$50–85** |

冷层（20 TB 影印件）延后：接 B2 后 **+$120/月**，等真有内容再说。

**对比：自建 P2P 传输层 = 3–6 人月开发 + 持续运维。按任何人力成本折算，够付本方案 5–10 年。**

---

## 11. 明确不做（防止范围蔓延）

- 用户账号、编辑权限、众编流程
- 移动端原生 App
- 学术级历史疆域边界
- 图像 OCR、全文图像检索
- 多语言界面
- 实时协作编辑
- 自研地图瓦片、自研图数据库

---

## 12. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 时间模型设计不足，后期返工 | 高 | W1 先写 20 条极端 case（公元前、跨朝代、传说、无日期）做验证 |
| 中文分词在托管 PG 上受限 | 中 | 应用层分词，DB 只存 token |
| 历史疆域数据永远不够 | 中 | 明确标「示意」，v1 只做 5 个切片 |
| Canvas 自研渲染工作量大 | 中 | 先做最小可用（点 + 聚合），不追求视觉炫技 |
| 引用再抓取被反爬 | 低 | 以存档哈希为准，再抓取只作 bonus |
| 冷门数据无人校验 | 高 | v1 不解决；框架只提供能力，靠后续专家机制 |

---

## 13. 第一步（本周可动）

1. 建 `events` / `event_claims` / `sources` 三张表 + 时间字段
2. 手写 20 条极端 case 种子数据（公元前 / 跨年 / 传说 / 无日期 / 三说法并存）
3. 跑通 `SELECT ... ORDER BY t_start_year` 并导出 JSON
4. **先不做前端**——用 `curl` 看到正确的 JSON 就算这一周成功
