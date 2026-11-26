# event 表按 `t_start_year` 分区的可行性与实测报告

| 项 | 值 |
|---|---|
| 日期 | 2026-11-25 |
| 环境 | PostgreSQL 19.0 (x86_64-windows)，127.0.0.1:5433，`shared_buffers=128MB`，`work_mem=4MB`，`autovacuum=on` |
| 生产库现状 | `history_atlas`，`event` **728 行**，普通表，12 个索引，3 个外键指向它 |
| 相关文件 | `src/db/migrations/002-partition.sql`、`scripts/partition-dryrun.js`、本报告 |
| 生产库改动 | **无**。全部实验在 `partition_proto` / `partition_mig_*` 独立库进行，结束后已 DROP |

---

## §1 结论（先看这里）

### 1.1 一句话

**在 50 万 ~ 1 亿量级上，本项目的读写模式下「按 500 年一档分区」不值得做** —— 它不会让任何一条真实查询变快，
却会让所有按 `id` / `slug` 的点查慢 5~10 倍、让宽时间窗查询慢 3~4 倍，并引入外键、序列、`ON CONFLICT` 三处breakage。

### 1.2 关键实测结论

| # | 结论 | 证据 |
|---|---|---|
| 1 | **时间窗查询没有变快，反而变慢** | 100 万行下 10 年窗口 `0.72x`、全时段 `0.24x`（`§3.1`） |
| 2 | **点查退化 5~10 倍** | `WHERE id = ?` 100 万行 `0.52ms → 4.95ms`（`§3.3`）—— 分区后主键不再全局唯一，必须探 17 个分区索引 |
| 3 | **partition pruning 确实生效** | `§3.4`：10 年窗口只扫 1~2 个分区，全时段只扫 15/17 个 |
| 4 | **但 pruning 省不到"页"上** | 时间窗查询由覆盖索引 `event_timeline_cover_idx` 做 index-only scan，`LIMIT 200` 只碰几个索引页——**表再大也只碰这几页**，剪掉分区并不能少读页，只多付了 Append 开销 |
| 5 | **最危险的坑不是外键，是 `t_span` 无法剪枝** | 100 万行 `t_span && int4range(1495,1505)`：**1039ms**（扫全部 17 分区，`shared hit=589631 / read=30447`）vs 普通表 0.59ms（`§3.4` ⑤） |
| 6 | **500 年等宽分档错配了历史数据的分布** | 真实数据 37.77%（275/728）落在 `[1500,2000)` 单个分区里——现代史查询剪完枝仍要扫 38% 的表（`§3.5`） |
| 7 | **索引数量 ×17，体积 +19%** | 204 个物理索引（12×17）；100k 时索引体积 119%；1M 时摊薄到 100.6%（`§3.5`） |
| 8 | **迁移在百万行会撞 autovacuum 死锁** | 首次尝试 `40P01 deadlock detected`；关掉本表 autovacuum 后 58.7s 成功（`§3.6`、`§6 R11`） |

### 1.3 给定明确取舍

| 量级 | 建议 | 理由 |
|---|---|---|
| **≤ 50 万**（含现状 728 行） | **不做** | 单表 + 覆盖索引已是最优；分区纯负收益 |
| **50 万 ~ 1000 万** | **不做** | 实测已覆盖到 100 万：所有查询要么持平要么变慢 |
| **1000 万 ~ 1 亿** | **仍不做**，除非命中下面两条之一 | 查询侧无收益（结论 1/4） |
| 1 亿以上 **且**需要"按时间批量删旧数据/冷热分层" | 可做，但**必须换分档方案** | 见 §7.3 的补救设计 |

> **唯一真正能让分区赚钱的场景是"生命周期管理"** —— 用一个 `DETACH PARTITION` / `DROP TABLE` 秒级清掉一整段历史，
> 替代 `DELETE ... WHERE t_start_year < ?` + `VACUUM`。本项目是**固定的历史语料**（不是按时间持续追加的时序日志），
> 没有这个需求，因此代理指标（查询延迟）全部为负。

---

## §2 方法与可复现

### 2.1 实验设计

为了做**公平 A/B**，脚本没有另写一套 DDL，而是走了这条路径：

```
1. 建库 partition_proto，按生产 schema 建普通表 event（12 个生产索引）
2. 灌 N 条（bench/gen.js，每批 500 行多行 INSERT）
3. 直接执行 002-partition.sql 的方案 B 全文
     → event 变成 17 分区的分区表，原普通表改名 event_legacy
4. 于是：event（分区表） 与 event_legacy（普通表）
        持有**完全相同的数据** + **完全相同的 12 个索引定义**
5. 两表各跑 20 次（预热 3 次），取 p50/p95
```

这样 `event_legacy` 就是严格的对照组，且顺带验证了迁移脚本本身能在 100 万行上跑完。
两表在同一个库、同一个会话、同一次运行内交替测量，避免跨机器/跨时间偏差。

> 说明：`bench/gen.js` 的年份分布是「65% 落在 [-5000,1500) + 35% 落在 [1500,2025]」，
> 这使 `[1500,2000)` 一个分区吃下 33% 的数据 —— 与真实数据 37.8% 的偏斜方向一致（`§3.5`），
> 因此本压测对"热点分档"的刻画是偏乐观但方向正确的。

### 2.2 复现命令（**必须分阶段**，每段都在 3 分钟内）

```powershell
cd E:\Deepseek_Harness\worknet\history-atlas

# 100 万行全套（约 115s 灌数 + 66s 迁移 + 32s 压测）
$env:ROWS='1000000'
node scripts\partition-dryrun.js --stage=setup,load      # ~115s
node scripts\partition-dryrun.js --stage=migrate         # ~66s
node scripts\partition-dryrun.js --stage=bench,explain,stats

# 方案 A / B 可执行性验证（自动建库、验证、清理）
node scripts\partition-dryrun.js --stage=migration-check

node scripts\partition-dryrun.js --stage=teardown
```

可调环境变量：`ROWS`（默认 100000）、`BATCH`（500）、`ITERS`（20）、`LIMIT`（200）、`DB`（partition_proto）。

### 2.3 查询形态

主查询对齐真实时间轴接口（走覆盖索引）：

```sql
SELECT slug, title, t_start_year, t_start_month, t_start_day, t_end_year,
       t_precision, t_certainty, track, category, discipline, lat, lon
FROM <t>
WHERE status = 'published' AND t_start_year >= $1 AND t_start_year < $2
ORDER BY t_start_year
LIMIT 200;
```

---

## §3 实测结果

### 3.1 主查询：时间窗 timeline（p50 / p95，ms，各 20 次）

**100,000 行**

| 窗口 | 命中行 | 普通表 p50/p95 | 分区表 p50/p95 | p50 加速 | p95 加速 |
|---|---|---|---|---|---|
| 10 年 `[1495,1505)` | 355 | 2.17 / 3.29 | 2.09 / 2.97 | **1.04x** | 1.11x |
| 100 年 `[1450,1550)` | 3,537 | 1.51 / 2.75 | 2.30 / 3.39 | **0.66x** | 0.81x |
| 全时段 `[-5000,2025)` limit 200 | 91,951 | 1.82 / 2.52 | 6.23 / 8.19 | **0.29x** | 0.31x |

**1,000,000 行**

| 窗口 | 命中行 | 普通表 p50/p95 | 分区表 p50/p95 | p50 加速 | p95 加速 |
|---|---|---|---|---|---|
| 10 年 `[1495,1505)` | 3,520 | 1.99 / 3.36 | 2.76 / 4.38 | **0.72x** | 0.77x |
| 100 年 `[1450,1550)` | 34,823 | 2.19 / 4.39 | 2.28 / 3.68 | **0.96x** | 1.19x |
| 全时段 `[-5000,2025)` limit 200 | 918,999 | 1.43 / 2.08 | 6.03 / 8.86 | **0.24x** | 0.23x |

> **为什么数据量涨 10 倍，普通表的耗时几乎不变（1.82 → 1.43ms）？**
> 因为 `LIMIT 200` + 覆盖索引使这条查询的代价 ≈「在 `t_start_year` 的有序索引上定位起点 + 顺读约 200 条」，
> 与表内总行数近乎无关。**这正是分区无法取胜的根本原因**：pruning 减少的是"要扫的范围"，
> 而这里本来就不需要扫大范围。

### 3.2 对照：同谓词 `COUNT(*)`（无 LIMIT，体现 17 路 Append 的固定开销）

| 窗口 | — | 100k 普通 | 100k 分区 | 100k 加速 | 1M 普通 | 1M 分区 | 1M 加速 |
|---|---|---|---|---|---|---|---|
| 10 年 | 355 / 3,520 | 0.61 | 1.30 | **0.47x** | 1.59 | 7.32 | **0.22x** |
| 100 年 | 3,537 / 34,823 | 1.82 | 6.21 | **0.29x** | 7.34 | 40.87 | **0.18x** |
| 全时段 | 全部 | 87.95 | 81.98 | 1.07x | 259.66 | 374.88 | **0.69x** |

统计类查询是分区唯一"打平"的场景（全时段 100k 时 1.07x），但 100 年窗口反而慢 5 倍 ——
因为分区版要把 2 个分区的计数 `Append` 起来，而普通表一次 index-only scan 就数完了。

### 3.3 附加场景：分区后**注定变差**的访问模式

| 场景 | 100k 普通 → 分区 | 倍率 | 1M 普通 → 分区 | 倍率 |
|---|---|---|---|---|
| `WHERE id = 50001`（主键点查） | 0.53 → 4.00 ms | **0.13x** | 0.52 → 4.95 ms | **0.11x** |
| `WHERE slug = 'ev-50000'`（slug 点查） | 0.46 → 3.13 ms | **0.15x** | 0.66 → 3.32 ms | **0.20x** |
| 无条件 `count(*)` | 9.18 → 11.74 ms | 0.78x | 111.95 → 277.31 ms | **0.40x** |

主键点查慢 7~9 倍的机理：`PRIMARY KEY (id)` 变成 `PRIMARY KEY (id, t_start_year)` 后，
**`id` 上不再有全局唯一索引**，`WHERE id = ?` 必须在 17 个分区上各探一次索引（`Append` + 17 次索引定位），
即使数据只在一个分区里。这是 `§6 R2` 的直接代价。

### 3.4 partition pruning 证据（`EXPLAIN (ANALYZE)`，100 万行）

| # | 查询 | 扫描分区数 | 执行耗时 | 实际扫描对象 |
|---|---|---|---|---|
| ① | 10 年 `[1460,1470)`（单分区内） | **1** | 0.53 ms | `event_y_1000_1500` |
| ② | 10 年 `[1495,1505)`（跨 1500 边界） | **2** | 3.54 ms | `event_y_1000_1500`, `event_y_1500_2000` |
| ③ | 100 年 `[1450,1550)`（跨边界） | **2** | 2.91 ms | 同上 |
| ④ | 全时段 `[-5000,2025)` | **15** | 3.41 ms | 15 个分区（正确排除 `before_m5000`/`after_2500`） |
| ⑤ | **反例**：`t_span && int4range(1495,1505)` | **17** | **1039.33 ms** | 全部 17 个 |
| ⑥ | 对照：同窗口在普通表 | 1 张表 | 0.59 ms | `event_legacy` |

**剪枝确实生效了**。最关键的一段 `EXPLAIN` 原文（②，跨 1500 边界）：

```
Limit  (cost=0.71..751.59 rows=200 width=87) (actual time=0.022..0.333 rows=200.00 loops=1)
  Buffers: shared hit=208 read=1
  ->  Append  (cost=0.71..12788.19 rows=3406 width=87) (actual time=0.022..0.318 rows=200.00 loops=1)
        ->  Index Scan using event_y_1000_1500_t_start_year_idx on event_y_1000_1500 event_1  (actual time=0.021..0.303 rows=200.00 loops=1)
              Index Cond: ((t_start_year >= 1495) AND (t_start_year < 1505))
              Filter: (status = 'published'::entity_status)
              Rows Removed by Filter: 16
              Index Searches: 1
        ->  Index Only Scan using event_y_1500_2000_t_start_year_slug_title_t_start_month_t_s_idx on event_y_1500_2000 event_2  (never executed)
```

注意两点：
1. 只出现 2 个分区的 `Index Scan`，其余 15 个分区**在计划里根本不存在** → 剪枝发生在 plan time；
2. `event_y_1500_2000` 那段是 `(never executed)` —— `LIMIT 200` 在第 1 个分区就满足了，
   第 2 个分区连打开都没打开。**这说明"少扫分区"确实省了工作 —— 只是省下的这点工作在总耗时里占比极小**。

而反例（⑤）才是真正该被警惕的：

```
Limit (actual time=1033.496..1039.499 rows=200.00 loops=1)
  Buffers: shared hit=589631 read=30447 written=1
  ->  Append (actual time=1033.495..1039.482 rows=200.00 loops=1)
        ...  Append 下挂了全部 17 个分区，每个分区都 Index Scan + Filter: (t_span && '[1495,1505)'::int4range)
```

`t_span` 是 `GENERATED ALWAYS AS (int4range(...)) STORED` 生成列，**不能作为分区键**，
所以任何以 `t_span && ...` 表达的区间查询都拿不到剪枝 —— 它会退化成"17 个分区各扫一遍 + 过滤"，
100 万行时是 **1039ms，而普通表 0.59ms（慢 1760 倍）**。同一查询在 10 万行时是 15.27ms，
即**无剪枝路径的代价随总行数线性增长**，而剪枝路径不增长。这也是为什么"要不要分区"必须结合**查询形态**判断，
不能只看"有没有分区"。

### 3.5 分区分布与体积

**分区数 17**（15 个 500 年档 + 2 个溢出），**空分区 2 个**（`before_m5000`、`after_2500`）。

100 万行时各分区行数（近似）：

| 分区 | 行数 | 体积 |
|---|---|---|
| `event_y_1500_2000` | **333,000** | 239 MB |
| `event_y_m5000_m4500` … `event_y_m500_0`（10 个 500 年古档） | 各 ≈50,000 | 各 33 MB |
| `event_y_0_500` / `_500_1000` / `_1000_1500` | 各 ≈49,800 | 各 33 MB |
| `event_y_2000_2500` | 17,264 | 13 MB |
| `event_y_before_m5000` / `_after_2500` | 0 | 136 kB |

**真实数据（728 行）按同一套 500 年边界的分布** —— 这是"分档方案错配"的硬证据：

| 分档 | 行数 | 占比 |
|---|---|---|
| `[1500,2000)` | **275** | **37.77%** |
| `[1000,1500)` | 104 | 14.29% |
| `[-500,0)` | 101 | 13.87% |
| `[500,1000)` | 76 | 10.44% |
| `[0,500)` | 67 | 9.20% |
| `[2000,2500)` | 25 | 3.43% |
| 其余 10 个档 | 10~23 各 | ≤3.16% |
| `< -5000`（溢出档） | 10 | 1.37% |

> 历史数据的密度随年代接近现代而**指数级上升**，500 年等宽分档会让**一个分区吃下 38% 的数据**。
> 也就是说：即使剪枝完美工作，查"明清以后"仍要扫 38% 的表 —— 剪枝的收益天花板被分档设计锁死了。

**体积对比（分区表 / 普通表）**

| 行数 | 分区表 total / heap / index | 普通表 total / heap / index | total | heap | index |
|---|---|---|---|---|---|
| 100k | 77,127,680 / 36,225,024 / 40,271,872 | 69,992,448 / 36,159,488 / 33,783,808 | **110.19%** | 100.18% | **119.20%** |
| 1M | 718,348,288 / 368,967,680 / 348,725,248 | 715,751,424 / 368,934,912 / 346,677,248 | **100.36%** | 100.01% | **100.59%** |

物理索引数：**204 个**（12 个父索引 × 17 分区）。
分区表的空间开销是**每个分区固定的页/元数据开销**，行数越大越摊薄：10 万行时 +10% total / +19% index，
100 万行时已降到 +0.4% / +0.6%。**所以"分区费空间"这一条在 1 亿量级并不成立，可以忽略。**

### 3.6 装载与迁移耗时

| 阶段 | 100 千行 | 100 万行 |
|---|---|---|
| 多行 INSERT（批 500，`bench/gen.js`） | 6.53 s（15,319 rows/s） | 70.09 s（14,266 rows/s） |
| 建 12 个生产索引 | 2.61 s | 34.52 s |
| **迁移（方案 B 全文）** | **6.91 s** | **58.66 s** |
| 迁移时 `event` 锁 | ACCESS EXCLUSIVE 全程 | ACCESS EXCLUSIVE 全程 |

迁移耗时随行数近似线性；**这段时间整张 `event` 不可读写**（单事务换表），百万行约 1 分钟停机窗口，
1 亿行按线性外推约 **1.6 小时**，不可接受，必须改成"双写 + 分批回填 + 短锁切换"（§7.3）。

### 3.7 两套方案的可执行性验证（`migration-check`，各 2000 行 + 三张子表）

| 指标 | 方案 A（保外键） | 方案 B（丢外键） |
|---|---|---|
| 执行耗时 | 1,013.72 ms | 787.18 ms |
| `event` relkind | `p`（分区表） | `p`（分区表） |
| 分区数 | 17 | 17 |
| `event` 上索引数 | 12 | 12 |
| **指向 `event` 的外键数** | **3** | **0** |
| 行数守恒 | 2000 / 2000 ✅ | 2000 / 2000 ✅ |
| 序列接管（新 id > max old） | `2001 > 2000` ✅ | `2001 > 2000` ✅ |
| `ON CONFLICT (slug)` | **FAIL 42P10** ❌ | **FAIL 42P10** ❌ |
| `ON UPDATE CASCADE`（改年份子表跟随） | **PASS**（1668 → 2368）✅ | 不适用 |
| 插入孤儿 `event_claim` | **REJECTED 23503** ✅ | 允许（无约束） |

---

## §4 两套方案 DDL 摘要与影响面

两套方案**互斥**，同一个库只能跑一套；都各自包在 `BEGIN ... COMMIT` 单事务内，
失败则整体回滚（实测：100 万行死锁后 `event` 完好无损，回到普通表状态）。

### 4.1 方案 A —— 保外键（复合外键）

**DDL 骨架**

```sql
-- A1 先把旧表的 12 个索引改名为 legacy_*（腾出全局索引名，见 §5）
-- A2 建分区父表
CREATE TABLE event_p ( ... ) PARTITION BY RANGE (t_start_year);
-- A3 建 17 个分区（15 个 500 年档 + 2 个溢出）
CREATE TABLE event_y_1500_2000 PARTITION OF event_p FOR VALUES FROM (1500) TO (2000);
CREATE TABLE event_y_before_m5000 PARTITION OF event_p FOR VALUES FROM (MINVALUE) TO (-5000);
CREATE TABLE event_y_after_2500  PARTITION OF event_p FOR VALUES FROM (2500) TO (MAXVALUE);
-- A5 主键/唯一必须含分区键
ALTER TABLE event_p ADD CONSTRAINT event_pkey          PRIMARY KEY (id, t_start_year);
ALTER TABLE event_p ADD CONSTRAINT event_slug_year_key UNIQUE (slug, t_start_year);
-- A7 子表加 event_year 列 + 回填 + NOT NULL + 扩主键
ALTER TABLE event_person DROP CONSTRAINT event_person_pkey;
ALTER TABLE event_person ADD  CONSTRAINT event_person_pkey PRIMARY KEY (event_id, event_year, person_id);
-- A10 复合外键
ALTER TABLE event_claim ADD CONSTRAINT event_claim_event_id_year_fkey
  FOREIGN KEY (event_id, event_year) REFERENCES event (id, t_start_year)
  ON DELETE CASCADE ON UPDATE CASCADE;
```

**影响面**

| 维度 | 影响 |
|---|---|
| **外键** | 3 张子表（`event_claim` / `event_source` / `event_person`，**不止任务描述里的 2 张**）全部要 `ADD COLUMN event_year` + 回填 + `SET NOT NULL` + 重建为复合外键 |
| **子表主键** | `event_person` 从 `(event_id, person_id)` 扩成 `(event_id, event_year, person_id)`，否则不再是唯一键 |
| **写入路径** | 每条子表 INSERT **必须显式带 `event_year`**，否则 `NOT NULL` 直接报错 → 所有写子表的代码都要改 |
| **一致性红利** | `ON UPDATE CASCADE` 会在事件改年份时自动同步子表 `event_year`（实测 PASS），不留悬挂行 |
| **孤儿行** | 数据库层面**不可能**产生（实测插入孤儿被 `23503` 拒绝） |
| **索引** | 12 个父索引 × 17 分区 = 204 个物理索引；另加 3 个子表复合索引 |
| **序列** | `event_id_seq` 需 `setval` + `OWNED BY event.id` + `SET DEFAULT` 三步（`BIGSERIAL` 不会自动跟着分区表走） |
| **锁表** | 子表 `ALTER/UPDATE` 持 ACCESS EXCLUSIVE；`event` 换名持 ACCESS EXCLUSIVE。**全程单事务**，需停机窗口 |
| **回滚** | 旧表保留为 `event_legacy`，`DROP` 前可回滚；但子表的 `event_year` 列与复合外键需反向迁移 |

### 4.2 方案 B —— 丢外键（应用层保证）

**DDL 骨架**：与 A 相同的 `PARTITION BY RANGE (t_start_year)` + 17 个 `PARTITION OF` + 同样的主键/唯一改造，
但**子表零改动**，只做：

```sql
-- B6 摘掉三张子表的单列外键，退化为普通索引
ALTER TABLE event_claim  DROP CONSTRAINT IF EXISTS event_claim_event_id_fkey;
ALTER TABLE event_source DROP CONSTRAINT IF EXISTS event_source_event_id_fkey;
ALTER TABLE event_person DROP CONSTRAINT IF EXISTS event_person_event_id_fkey;
CREATE INDEX event_claim_event_idx ON event_claim (event_id);   -- 保留，供孤儿行体检
```

**影响面**

| 维度 | 影响 |
|---|---|
| **外键** | 3 个外键全部消失（实测 `fk_to_event = 0`）；`ON DELETE CASCADE` 语义**丢失** → 删事件不再级联清理子表，会留下孤儿行 |
| **子表改动** | **零**（不加列、不重建索引、不停写）→ 迁移窗口最短 |
| **写入路径** | 不变（这正是它"简单"的原因） |
| **孤儿行** | 必须靠应用层 + 定期体检（体检 SQL 见 `002-partition.sql` 的 `§C3`）兜底，否则 `event_claim` 会越长越脏 |
| **索引 / 序列 / 锁表** | 与 A 相同（12×17=204 索引、序列三步接管、换名 ACCESS EXCLUSIVE） |
| **回滚** | 旧表 `event_legacy` 保留；但**外键一旦 DROP 就不在旧表上**，回滚需重新 `ADD CONSTRAINT`（若期间已产生孤儿行则会失败） |

### 4.3 方案对比一览

| 维度 | 方案 A | 方案 B |
|---|---|---|
| 引用完整性 | 数据库保证 ✅ | 应用层保证 ⚠️ |
| 子表改动 | 加列 + 回填 + 换主键 + 换外键 | **无** |
| 写子表代码改动 | 必须带 `event_year` | 无 |
| 迁移耗时（2000 行实测） | 1,014 ms | **787 ms** |
| 迁移耗时（1M 实测） | 未测（估算 ≈70s，含子表回填） | **58.7 s** |
| 停机窗口 | 更长（子表 ACCESS EXCLUSIVE） | 更短（只有换名） |
| 删事件的级联 | 保留 ✅ | **丢失** ❌ |
| 孤儿行风险 | 无 | **高** |
| `ON CONFLICT (slug)` | **坏** ❌ | **坏** ❌ |
| 点查退化 | 坏 ❌ | 坏 ❌ |
| 适用 | 正式上线 / 有审计要求 | 原型 / 能接受定时补一致性 |

> **两套方案都无法解决的问题**：`ON CONFLICT (slug)` 破坏（`§6 R4`）、`id` 点查退化（`§6 R2`）、
> `t_span` 查询无法剪枝（`§6 R10`）。这三条与选 A 还是 B 无关 —— **它们才是"值不值得做"的真正判据**。

---

## §5 上一版 `002-partition.sql` 的三个真实缺陷（已修正）

上一版文件（27.6KB）的分析部分质量很高（三张子表、`ON CONFLICT` 破坏、10 行深古数据等判断均与实测吻合），
但**不可执行**。逐条验证如下：

### 缺陷 1（致命）：索引/约束名是 schema 级全局命名空间，顺序搞反了

旧版在 `A3b` / `B4` 直接对 `event_p` 执行 `ADD CONSTRAINT event_pkey`，而此刻**旧 `event` 表上的
`event_pkey` 索引仍然存在**（改名 `legacy_*` 的动作被排在后面的 `A5`/`B6`）。实测：

```
PLAN A FAILED: [42P07] relation "event_pkey" already exists
PLAN B FAILED: [42P07] relation "event_pkey" already exists
```

两套方案都在第 3~4 步就硬失败。好在整个迁移包在单事务里，**失败即整体回滚，库没有被搞坏**。

### 缺陷 2（更危险）：`CREATE INDEX IF NOT EXISTS` 会**静默**丢掉所有索引

如果有人为了绕过缺陷 1 只把 `ADD CONSTRAINT` 改个名，那么停在 `IF NOT EXISTS` 的索引就变成静默跳过。
隔离复现：

```
notice: relation "event_year_idx" already exists, skipping
notice: relation "event_track_idx" already exists, skipping
indexes actually created on trap_p: []
```

**结果是得到一张没有任何二级索引的分区表，且没有任何报错** —— 功能测试全绿、性能全崩。
修正方式：新表的索引一律用**不带 `IF NOT EXISTS`** 的 `CREATE INDEX`，让名字冲突变成响亮的 `42P07`。

### 缺陷 3：子表外键的 DROP 位置

旧版 `A7` 在 `rename` **之后**才 `DROP CONSTRAINT ... event_claim_event_id_fkey`。约束按 OID 挂在表上，
rename 后它指向的是 `event_legacy`，"在旧表上删约束"语义上是错的（虽然按名字仍能命中）。已改为 rename 之前删。

### 修正后的顺序

```
1. 守卫（已 apply 过另一套方案？event 已分区？）
2. **先把旧 event 的 12 个索引改名为 legacy_***   ← 关键
3. 建 event_p + 17 分区
4. 灌数据
5. 建主键/唯一/12 索引（canonical 名，不带 IF NOT EXISTS）
6. （A：子表加列回填换复合外键 / B：摘外键）
7. rename：event → event_legacy，event_p → event
8. 序列三步接管（setval → OWNED BY → SET DEFAULT）
9. 自检断言（行数守恒 / 分区数=17 / 孤儿行=0 / year 无漂移）→ 任一不成立则整事务回滚
```

---

## §6 迁移风险清单

| # | 风险 | 严重度 | 实测/证据 | 缓解 |
|---|---|---|---|---|
| **R1** | 外键：**3 张**子表（不是 2 张） | 高 | `event_claim`/`event_source`/`event_person` 均有 `ON DELETE CASCADE` | 方案 A 复合外键 / 方案 B 应用层兜底 |
| **R2** | 主键语义 `(id) → (id, t_start_year)`，`id` 无全局唯一索引 | **高** | 点查 `0.52 → 4.95 ms`（1M，慢 9.5 倍） | 查询必须带上 `t_start_year`，或建 `id → year` 映射表 |
| **R3** | 序列 `event_id_seq` 不随分区自动重建 | **高** | 未接管则下次 INSERT 从 1 撞主键；若 `OWNED BY` 仍指向 `event_legacy.id`，`DROP TABLE event_legacy` 会**连带删掉序列** | 三步：`setval` → `OWNED BY event.id` → `SET DEFAULT`（实测 `2001 > 2000` PASS） |
| **R4** | `UNIQUE(slug)` → `UNIQUE(slug, t_start_year)`，破坏 `ON CONFLICT (slug)` | **高** | 两方案均 `FAIL 42P10`；`src/ingest/router.js` 两处 UPSERT 会**运行期中断摄取管线** | 引入不分区的 `slug_registry(slug PRIMARY KEY)` 承载全局唯一；或应用层先查后写 |
| **R5** | 索引膨胀 12 → 204 个物理索引 | 中 | 100k +19% 索引体积；1M 摊薄到 +0.6% | 接受；大表可考虑裁剪 trgm/GIN 索引 |
| **R6** | 分区边界：给了 `[2500,MAXVALUE)` 兜底 | 中 | 越界年份不会报错，但兜底分区会无限膨胀；且往 DEFAULT/MAXVALUE 分区塞数据后，再 `ATTACH` 新分区需先扫描搬迁 | 改成显式上界（如 `TO (3000)`），越界即失败 |
| **R7** | 锁表：单事务换表，全程 ACCESS EXCLUSIVE | **高** | 1M 实测 58.7s 不可读写；线性外推到 1 亿 ≈ 1.6 小时 | 停机窗口，或改双写+分批回填+短锁切换 |
| **R8** | 统计/计划退化：ANALYZE 成本 ×17，跨分区聚合变 17 路 Append | 中 | 无条件 `count(*)` 1M：111.95 → 277.31 ms（慢 2.5 倍） | 接受；聚合查询尽量带 `t_start_year` 谓词 |
| **R9** | 复制/备份：逻辑复制与 `pg_dump` 按分区逐个同步，订阅端表数 ×17 | 中 | 结构性 | 用物理备份；逻辑复制需接受 17 倍表数 |
| **R10** | **`t_span`（生成列）不能做分区键 → 区间查询永远不剪枝** | **高** | 1M：`1039ms` vs 普通表 `0.59ms`（**慢 1760 倍**），`shared hit=589631 / read=30447` | 改写查询为 `t_start_year` 谓词；或对 `t_span` 单独建 GiST 且接受无剪枝 |
| **R11** | **autovacuum 与 RENAME 抢锁 → 死锁** | **高** | 1M 首次迁移 `40P01 deadlock detected`（47.6s 后失败）；百万行**必然**撞上，728/10 万行时不会 | 迁移前置 `VACUUM (ANALYZE)` + `ALTER TABLE event SET (autovacuum_enabled=false)` + `lock_timeout`，并准备重试（脚本已实现，重试第 1 次即成功） |

> **R11 详解**（这是本次实测最有价值的运维发现）：
> 迁移事务内 `INSERT ... SELECT` 对 `event` 持 `ACCESS SHARE`，随后 `RENAME` 要升级为 `ACCESS EXCLUSIVE`；
> 同时 autovacuum 在刚灌完 100 万行的 `event` 上持 `ShareUpdateExclusive` 并等待我们持有的索引锁 → 互相等待 → 死锁。
> 因为整个迁移是**单事务**，死锁会**整体回滚**（实测事后 `event` 仍是完好的普通表、100 万行、无分区），
> 所以不会产生半迁移状态，但会让迁移在无人值守时"莫名其妙失败"。

---

## §7 结论与建议

### 7.1 明确取舍

> **不做。** 在 50 万 ~ 1 亿量级上，按 `t_start_year` 500 年一档分区，对本项目是**净负收益**。

判定依据（按重要性排序）：

1. **它解决不了本项目的瓶颈。** 时间轴查询已经由 `event_timeline_cover_idx (t_start_year) INCLUDE(...) WHERE status='published'`
   做 index-only scan，`LIMIT 200` 只碰几个索引页，**代价与表大小无关**（实测 100k → 1M，普通表 1.82 → 1.43ms）。
   分区剪掉的是"不需要扫的范围"，而这里本来就不需要扫大范围。
2. **它明确损害高频访问路径。** `id` / `slug` 点查慢 7~9 倍（`§3.3`），这是 API 层最常见的访问模式。
3. **它引入两处功能性 breakage。** `ON CONFLICT (slug)` 报 `42P10` 会**直接中断摄取管线**（`§6 R4`）；
   `DELETE` 不再级联清子表（方案 B）。
4. **它的收益天花板被分档设计锁死。** 真实数据 37.77% 落在 `[1500,2000)` 一个分区里（`§3.5`），
   距今越近数据越密 —— 500 年等宽分档对历史数据是**结构性错配**。
5. **它最危险的坑刚好命中本项目的查询习惯。** `t_span && int4range(...)` 是历史区间查询的自然写法，
   而它在分区表上慢 1760 倍（`§3.4` ⑤）。

### 7.2 如果只是为了"性能"，替代方案更划算

| 诉求 | 推荐做法（成本远低于分区） |
|---|---|
| 时间轴查询更快 | 已有覆盖索引；如需再压，可把 `INCLUDE` 列裁剪到真正返回的列，或做 `LIMIT` 上的 keyset 分页 |
| 点查更快 | 保持 `PRIMARY KEY (id)` 全局唯一（分区后拿不回来） |
| 全文检索更快 | 调 GIN 索引参数（`fastupdate`/`gin_pending_list_limit`），与分区无关 |
| 宽范围聚合更快 | 物化视图 / 汇总表，比 17 路 Append 有效得多 |
| 老数据归档 | 建 `event_archive` 同构表 + 批量 `DELETE ... RETURNING` 搬迁，避免分区带来的全部副作用 |

### 7.3 如果将来确实要上（1 亿+ 且有保留策略），必须改这四件事

1. **换成非均匀分档**：`[-3000, 2100)` 按 100 年一档，更古的（`< -3000`）**合成一个**溢出分区，
   更近的 `[1900, 2100)` 按 10~20 年一档。要按真实分布定边界，让**每个分区行数大致相等**，
   而不是"每 500 年一个"。目标：最大分区不超过全表的 3~5%。
2. **保住 slug 全局唯一**：新建不分区的小表 `slug_registry(slug TEXT PRIMARY KEY, event_id BIGINT, t_start_year INT)`，
   把 `ON CONFLICT` 迁到它上面，事件表只做普通 INSERT。
3. **保住 id 点查**：同样用 `id_registry(id BIGINT PRIMARY KEY, t_start_year INT)`，或在应用层把
   `id → t_start_year` 缓存起来，让点查能带上分区键。否则点查永远是 17 路探查。
4. **迁移改成不停机**：`CREATE TABLE ... PARTITION BY` → 建触发器双写 → 分批回填（每批 1 万行、独立事务）
   → 短暂 `lock_timeout` 内换名 → 校验后拆双写。**不要**沿用 002 的单事务换表（1 亿行 ≈1.6 小时锁表）。
   并且**务必**按 `§6 R11` 关掉 autovacuum + 加重试。

### 7.4 现状交付建议

- `src/db/migrations/002-partition.sql` 保留为**设计稿 + 可执行迁移脚本**，但**不要在 `history_atlas` 上执行**；
  文件头的 §0/§1 已写清四类硬约束与命名空间陷阱，可直接用于评审。
- `scripts/partition-dryrun.js` 作为**可复现的决策证据生成器**长期保留：
  将来若数据量或查询形态变化（例如真的涨到 1 亿、或引入了保留策略），重跑一遍即可重新判定，无需重新论证。
- 生产库 `history_atlas` 本次**零改动**（实测复核：728 行、12 索引、3 外键、0 个分区表、无 `_partition_migration_state`）。

---

## 附：本次实测的完整性复核

```
history_atlas:  event 728 行，t_start_year ∈ [-1700000, 2022]
                pg_partitioned_table 计数 = 0
                event 索引 12 个，指向 event 的外键 3 个
                子表：event_claim 914 / event_source 737 / event_person 402
                _partition_migration_state 不存在
实验库:         partition_proto / partition_mig_a / partition_mig_b / partition_migtest 全部已 DROP
```
