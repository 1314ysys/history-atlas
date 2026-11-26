-- ============================================================================
-- 002-partition.sql —— event 表按 t_start_year 声明式范围分区（两套互斥方案）
-- ============================================================================
-- 目标：把 event 变成 PARTITION BY RANGE (t_start_year)，按 500 年一档建分区。
-- 状态：**可执行迁移脚本 + 设计说明**，不在生产库上自动运行。
--       实测数据见 docs/report/partition.md，压测脚本 scripts/partition-dryrun.js。
--
-- 实测环境：PostgreSQL 19.0 (127.0.0.1:5433)，库 history_atlas 现 728 行。
--           event.t_start_year 实测范围 [-1700000, 2022]；
--           分布高度集中在近世：[-5000,1500) 403 行 / [1500,2500) 300 行 / < -5000 仅 10 行。
--
-- ----------------------------------------------------------------------------
-- §0 为什么不能"直接分区"——四条硬约束（先读，再看 SQL）
-- ----------------------------------------------------------------------------
-- C1. PG 要求分区表上的 UNIQUE / PRIMARY KEY **必须包含分区键**。
--     现有 event 有两个：
--       event_pkey      PRIMARY KEY (id)
--       event_slug_key  UNIQUE (slug)
--     分区后必须变成 PRIMARY KEY (id, t_start_year) 与 UNIQUE (slug, t_start_year)。
--     → 后果 1：id 不再全局唯一索引 → 任何只按 id 的连接/点查都要扫全部分区
--               （src/api/person.js 的 `JOIN event e ON e.id = ep.event_id` 属于此类）。
--     → 后果 2：slug 也不再全局唯一 → 见 C3。
--
-- C2. **三张**子表以 event(id) 单列外键引用 event（任务描述只提到两张，实际是三张）：
--       event_claim_event_id_fkey   event_claim (event_id)  ON DELETE CASCADE
--       event_source_event_id_fkey  event_source(event_id)  ON DELETE CASCADE
--       event_person_event_id_fkey  event_person(event_id)  ON DELETE CASCADE
--     分区表的 (id) 不再是唯一键，**这些外键建不起来**（42830 "no unique constraint"）。
--     → 方案 A：子表加 event_year 列，改复合外键 (event_id, event_year)
--     → 方案 B：删掉三张表的外键，改由应用层保证
--
-- C3. slug 的唯一性被削弱。全仓库有 3 处依赖 "slug 唯一"：
--       src/api/event.js        `SELECT * FROM event WHERE slug = $1`        （假设 ≤1 行）
--       src/ingest/router.js    `INSERT ... ON CONFLICT (slug) DO NOTHING`
--       src/ingest/router.js    `INSERT ... ON CONFLICT (slug) DO UPDATE`
--     改成 UNIQUE (slug, t_start_year) 后，`ON CONFLICT (slug)` 会直接**运行期报错**
--     （42P10 "there is no unique or exclusion constraint matching the ON CONFLICT
--     specification"），摄取管线整体中断。这是本迁移最容易被低估的破坏点。
--     （已实测：见 docs/report/partition.md §4 R4。）
--
-- C4. 500 年一档 × 真实跨度 [-1700000, 2022] = 约 3418 个分区，其中绝大多数是空分区。
--     实测：t_start_year < -5000 的事件**只有 10 行**（元谋人 -1700000 … 裴李岗 -7000）。
--     → 正确做法：500 年一档只覆盖正文区间 [-5000, 2500)，深古段用一个溢出分区
--       兜住（event_y_before_m5000），未来段用 event_y_after_2500 兜住。
--       本文件即按此建 15 + 2 = **17 个分区**。
--
-- ----------------------------------------------------------------------------
-- §1 关键修正：**索引/约束名是 schema 级全局命名空间，必须在建新表之前先腾出名字**
-- ----------------------------------------------------------------------------
-- PG 的索引名与表名共用同一个命名空间（都在 pg_class）。旧 event 表上已经存在
--   event_pkey / event_slug_key / event_year_idx / event_track_idx / event_status_idx /
--   event_place_idx / event_fts_idx / event_span_idx / event_timeline_cover_idx /
--   event_title_trgm_idx / event_summary_trgm_idx / event_search_text_trgm_idx
-- 共 12 个全局名。如果先建新索引、后改旧表名，会撞上两种结局：
--
--   (a) `ALTER TABLE event_p ADD CONSTRAINT event_pkey PRIMARY KEY (id, t_start_year)`
--       → [42P07] relation "event_pkey" already exists          ← 硬失败，整个迁移回滚
--   (b) `CREATE INDEX IF NOT EXISTS event_year_idx ON event_p (...)`
--       → NOTICE: relation "event_year_idx" already exists, skipping
--       → **静默跳过，新表一个索引都没有**，而且没有任何报错    ← 最危险
--
-- 上一版 002 就是 (a)，在 A3b / B4 处直接失败（见 docs/report/partition.md §3）。
-- 注意 (b) 比 (a) 更可怕：一旦有人"只把 ADD CONSTRAINT 改个名"来绕过 (a)，
-- 得到的就是一张**没有任何二级索引**的分区表，功能测试全绿、性能全崩。
--
-- 因此本文件的顺序是：**先 rename 旧索引 → 再建新表 → 最后 rename 表**，
-- 且新表的索引一律用**不带 IF NOT EXISTS** 的 `CREATE INDEX`，
-- 让名字冲突变成响亮的报错而不是静默跳过。
--
-- ----------------------------------------------------------------------------
-- §2 执行方式（重要）
-- ----------------------------------------------------------------------------
--   两套方案**互斥**，同一个库上只能跑一套。本文件按如下方式使用：
--
--     手工：psql -v ON_ERROR_STOP=1 -f 002-partition.sql     （一次只能手工选中一套）
--     程序：按 @@PLAN_A_BEGIN / @@PLAN_A_END / @@PLAN_B_BEGIN / @@PLAN_B_END
--           四个标记行（整行只含该标记）切出对应段落执行
--           （scripts/partition-dryrun.js 的 migration-check 阶段即按此切分）。
--           **注意**：文件开头的说明文字里刻意不出现带 "-- " 前缀的完整标记串，
--           否则 indexOf 会先命中注释而不是真正的标记行。
--
--   每套方案各自 BEGIN ... COMMIT 包成一个事务：
--     · 全部成功或全部回滚，不会留下半迁移状态；
--     · 期间 event 持 ACCESS EXCLUSIVE 锁 → 必须有停机窗口（见 §D R7）。
--
--   _partition_migration_state 守卫：一旦某套方案已 apply，另一套会立刻 RAISE EXCEPTION。
-- ============================================================================


-- ============================================================================
-- @@PLAN_A_BEGIN
-- §A  方案 A —— 保外键（复合外键）
-- ============================================================================
-- 适用：要求数据库层面 100% 保证引用完整性（评审、审计、正式上线）
-- 代价：三张子表都要加列 + 回填 + NOT NULL + 重建外键；子表写入路径必须带 event_year
-- 收益：ON DELETE CASCADE 语义保留；ON UPDATE CASCADE 还能在事件改年份时
--       自动把子表的 event_year 一起搬走（这是复合外键白送的一致性）
-- ============================================================================

BEGIN;

-- ---------- A0. 守卫 ----------
CREATE TABLE IF NOT EXISTS _partition_migration_state (
  plan       TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note       TEXT
);

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM _partition_migration_state WHERE plan = 'B') THEN
    RAISE EXCEPTION '本库已应用方案 B（丢外键），不能再跑方案 A。请用备份恢复到干净库后重来。';
  END IF;
  IF to_regclass('public.event') IS NULL THEN
    RAISE EXCEPTION '找不到 public.event，本脚本必须在已有 event 表的库上执行。';
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.event'::regclass) = 'p' THEN
    RAISE EXCEPTION 'public.event 已经是分区表，勿重复执行本迁移。';
  END IF;
END $do$;

-- ---------- A1. 先腾出 12 个全局索引名：旧 event 的索引全部改名为 legacy_<原名> ----------
-- 只改索引名，不改约束名：约束名是 per-table 的（pg_constraint 以 conrelid 为作用域），
-- 不同表可以有同名约束，所以 event_legacy 上继续叫 event_pkey 不会冲突。
DO $do$
DECLARE r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'legacy_event_pkey') THEN
    FOR r IN SELECT indexname FROM pg_indexes
              WHERE schemaname = 'public' AND tablename = 'event'
    LOOP
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', r.indexname, 'legacy_' || r.indexname);
    END LOOP;
  END IF;
END $do$;

-- ---------- A2. 建分区表（结构与 event 一一对应） ----------
-- t_span 仍是 GENERATED ALWAYS STORED（分区表支持生成列，但生成列不能当分区键）。
-- id 暂不给 DEFAULT：先把历史 id 原样搬进来，A9 再接管序列。
CREATE TABLE IF NOT EXISTS event_p (
  id            BIGINT NOT NULL,
  slug          TEXT NOT NULL,
  title         TEXT NOT NULL,
  track         TEXT NOT NULL CHECK (track IN ('cn','world')),
  category      TEXT NOT NULL,
  discipline    TEXT,
  t_start_year  INT  NOT NULL,
  t_start_month SMALLINT,
  t_start_day   SMALLINT,
  t_end_year    INT,
  t_end_month   SMALLINT,
  t_end_day     SMALLINT,
  t_precision   t_precision  NOT NULL DEFAULT 'year',
  t_certainty   t_certainty  NOT NULL DEFAULT 'certain',
  t_span        INT4RANGE GENERATED ALWAYS AS
                (int4range(t_start_year, COALESCE(t_end_year, t_start_year) + 1)) STORED,
  place_slug    TEXT,
  lat           DOUBLE PRECISION,
  lon           DOUBLE PRECISION,
  summary       TEXT,
  search_text   TEXT,
  search_tsv    TSVECTOR,
  status        entity_status NOT NULL DEFAULT 'published',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  rev           INT NOT NULL DEFAULT 1
) PARTITION BY RANGE (t_start_year);

-- ---------- A3. 建 17 个分区：500 年一档覆盖 [-5000, 2500) + 两端溢出 ----------
-- 深古溢出：实测只有 10 行（-1700000…-7000）。**不要**给它展开 3400 个空分区。
CREATE TABLE IF NOT EXISTS event_y_before_m5000 PARTITION OF event_p
  FOR VALUES FROM (MINVALUE) TO (-5000);

CREATE TABLE IF NOT EXISTS event_y_m5000_m4500 PARTITION OF event_p FOR VALUES FROM (-5000) TO (-4500);
CREATE TABLE IF NOT EXISTS event_y_m4500_m4000 PARTITION OF event_p FOR VALUES FROM (-4500) TO (-4000);
CREATE TABLE IF NOT EXISTS event_y_m4000_m3500 PARTITION OF event_p FOR VALUES FROM (-4000) TO (-3500);
CREATE TABLE IF NOT EXISTS event_y_m3500_m3000 PARTITION OF event_p FOR VALUES FROM (-3500) TO (-3000);
CREATE TABLE IF NOT EXISTS event_y_m3000_m2500 PARTITION OF event_p FOR VALUES FROM (-3000) TO (-2500);
CREATE TABLE IF NOT EXISTS event_y_m2500_m2000 PARTITION OF event_p FOR VALUES FROM (-2500) TO (-2000);
CREATE TABLE IF NOT EXISTS event_y_m2000_m1500 PARTITION OF event_p FOR VALUES FROM (-2000) TO (-1500);
CREATE TABLE IF NOT EXISTS event_y_m1500_m1000 PARTITION OF event_p FOR VALUES FROM (-1500) TO (-1000);
CREATE TABLE IF NOT EXISTS event_y_m1000_m500  PARTITION OF event_p FOR VALUES FROM (-1000) TO (-500);
CREATE TABLE IF NOT EXISTS event_y_m500_0      PARTITION OF event_p FOR VALUES FROM (-500)  TO (0);
CREATE TABLE IF NOT EXISTS event_y_0_500       PARTITION OF event_p FOR VALUES FROM (0)      TO (500);
CREATE TABLE IF NOT EXISTS event_y_500_1000    PARTITION OF event_p FOR VALUES FROM (500)    TO (1000);
CREATE TABLE IF NOT EXISTS event_y_1000_1500   PARTITION OF event_p FOR VALUES FROM (1000)   TO (1500);
CREATE TABLE IF NOT EXISTS event_y_1500_2000   PARTITION OF event_p FOR VALUES FROM (1500)   TO (2000);
CREATE TABLE IF NOT EXISTS event_y_2000_2500   PARTITION OF event_p FOR VALUES FROM (2000)   TO (2500);

-- 未来溢出：不展开 MAXVALUE 之内的空档。注意这条给的是 [2500, MAXVALUE)，
-- 插入 9000 年不会报错；若希望超界即报错，见 §D R6。
CREATE TABLE IF NOT EXISTS event_y_after_2500  PARTITION OF event_p FOR VALUES FROM (2500) TO (MAXVALUE);

-- ---------- A4. 灌历史数据 ----------
-- 生成列 t_span 不能出现在 INSERT 列表里，必须显式列名。
-- 单条 INSERT ... SELECT 即"一次性复制"；百万级见 §D R2 的批量/停写建议。
INSERT INTO event_p (
  id, slug, title, track, category, discipline,
  t_start_year, t_start_month, t_start_day,
  t_end_year, t_end_month, t_end_day,
  t_precision, t_certainty,
  place_slug, lat, lon, summary, search_text, search_tsv,
  status, created_at, rev
)
SELECT
  id, slug, title, track, category, discipline,
  t_start_year, t_start_month, t_start_day,
  t_end_year, t_end_month, t_end_day,
  t_precision, t_certainty,
  place_slug, lat, lon, summary, search_text, search_tsv,
  status, created_at, rev
FROM event;

-- ---------- A5. 主键 / 唯一（必须含分区键，这是 PG 硬规则） ----------
ALTER TABLE event_p ADD CONSTRAINT event_pkey PRIMARY KEY (id, t_start_year);
-- slug 不再全局唯一；ON CONFLICT (slug) 会失效，见 C3 / §D R4。
ALTER TABLE event_p ADD CONSTRAINT event_slug_year_key UNIQUE (slug, t_start_year);

-- ---------- A6. 二级索引（父表建，PG 自动在每个分区上各建一份） ----------
-- 一律**不带** IF NOT EXISTS：名字冲突必须是响亮的 42P07，不能静默跳过。
CREATE INDEX event_year_idx   ON event_p (t_start_year);
CREATE INDEX event_track_idx  ON event_p (track, t_start_year);
CREATE INDEX event_status_idx ON event_p (status);
CREATE INDEX event_place_idx  ON event_p (place_slug);
CREATE INDEX event_fts_idx    ON event_p USING GIN (search_tsv);
CREATE INDEX event_span_idx   ON event_p USING GIST (t_span);
CREATE INDEX event_timeline_cover_idx
  ON event_p (t_start_year)
  INCLUDE (slug, title, t_start_month, t_start_day, t_end_year,
           t_precision, t_certainty, track, category, discipline, lat, lon)
  WHERE status = 'published';
CREATE INDEX event_title_trgm_idx       ON event_p USING GIN (title gin_trgm_ops);
CREATE INDEX event_summary_trgm_idx     ON event_p USING GIN (summary gin_trgm_ops);
CREATE INDEX event_search_text_trgm_idx ON event_p USING GIN (search_text gin_trgm_ops);

-- ---------- A7. 子表加 event_year 并回填（方案 A 的全部代价在这里） ----------
-- 顺序：加可空列 → 回填 → 设 NOT NULL → 扩 event_person 主键 → 建复合外键要用的索引。
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['event_claim','event_source','event_person'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION '方案 A 需要子表 % 存在，但没找到。', t;
    END IF;
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS event_year INT', t);
  END LOOP;
END $do$;

UPDATE event_claim  c SET event_year = e.t_start_year FROM event e WHERE e.id = c.event_id AND c.event_year IS NULL;
UPDATE event_source s SET event_year = e.t_start_year FROM event e WHERE e.id = s.event_id AND s.event_year IS NULL;
UPDATE event_person p SET event_year = e.t_start_year FROM event e WHERE e.id = p.event_id AND p.event_year IS NULL;

ALTER TABLE event_claim  ALTER COLUMN event_year SET NOT NULL;
ALTER TABLE event_source ALTER COLUMN event_year SET NOT NULL;
ALTER TABLE event_person ALTER COLUMN event_year SET NOT NULL;

-- event_person 原主键 (event_id, person_id) 必须扩成含 event_year 的三列，
-- 否则 (event_id, person_id) 在分区后不再是唯一键，复合外键无从引用。
ALTER TABLE event_person DROP CONSTRAINT IF EXISTS event_person_pkey;
ALTER TABLE event_person ADD  CONSTRAINT event_person_pkey PRIMARY KEY (event_id, event_year, person_id);

-- 复合外键的被引用侧要唯一（上面已建）；引用侧也要有索引，否则删改 event 时子表全表扫。
CREATE INDEX event_claim_event_year_idx  ON event_claim  (event_id, event_year);
CREATE INDEX event_source_event_year_idx ON event_source (event_id, event_year);
CREATE INDEX event_person_event_year_idx ON event_person (event_id, event_year);

-- 旧单列外键先摘掉：它们此刻仍挂在（改名前的）event 上，直接换成复合外键会冲突。
ALTER TABLE event_claim  DROP CONSTRAINT IF EXISTS event_claim_event_id_fkey;
ALTER TABLE event_source DROP CONSTRAINT IF EXISTS event_source_event_id_fkey;
ALTER TABLE event_person DROP CONSTRAINT IF EXISTS event_person_event_id_fkey;

-- ---------- A8. 换名：旧表降为 event_legacy，新表接管 event ----------
ALTER TABLE event   RENAME TO event_legacy;
ALTER TABLE event_p RENAME TO event;
-- 分区子表名（event_y_*）不用动：PG 通过 OID 挂接，父表改名不影响子表。

-- ---------- A9. 序列接管 ----------
-- event_id_seq 此刻 OWNED BY event_legacy.id。只把序列推到 max(id) 之后，
-- 并把归属和 DEFAULT 转给新的 event.id —— 顺序必须是 setval → OWNED BY → SET DEFAULT。
SELECT setval('event_id_seq', GREATEST((SELECT COALESCE(MAX(id), 0) FROM event), 1), true);
ALTER SEQUENCE event_id_seq OWNED BY event.id;
ALTER TABLE event ALTER COLUMN id SET DEFAULT nextval('event_id_seq');

-- ---------- A10. 复合外键（这才是"保外键"的核心） ----------
-- ON UPDATE CASCADE 是白送的一致性：事件改 t_start_year 时，
-- PG 会自动把子表的 event_year 一起更新，不会留下"年份对不上"的悬挂行。
ALTER TABLE event_claim
  ADD CONSTRAINT event_claim_event_id_year_fkey
  FOREIGN KEY (event_id, event_year) REFERENCES event (id, t_start_year)
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE event_source
  ADD CONSTRAINT event_source_event_id_year_fkey
  FOREIGN KEY (event_id, event_year) REFERENCES event (id, t_start_year)
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE event_person
  ADD CONSTRAINT event_person_event_id_year_fkey
  FOREIGN KEY (event_id, event_year) REFERENCES event (id, t_start_year)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- A11. 自检：任一不变量不成立就整事务回滚 ----------
ANALYZE event;

DO $do$
DECLARE n_new bigint; n_old bigint; n_part int; n_orphan bigint; n_drift bigint;
BEGIN
  SELECT count(*) INTO n_new FROM event;
  SELECT count(*) INTO n_old FROM event_legacy;
  IF n_new <> n_old THEN
    RAISE EXCEPTION '行数不守恒：新表 % 行 vs 旧表 % 行', n_new, n_old;
  END IF;

  SELECT count(*) INTO n_part
    FROM pg_inherits WHERE inhparent = 'public.event'::regclass;
  IF n_part <> 17 THEN
    RAISE EXCEPTION '分区数应为 17，实际 %', n_part;
  END IF;

  SELECT count(*) INTO n_orphan FROM (
    SELECT c.event_id FROM event_claim c
      WHERE NOT EXISTS (SELECT 1 FROM event e WHERE e.id = c.event_id AND e.t_start_year = c.event_year)
    UNION ALL
    SELECT s.event_id FROM event_source s
      WHERE NOT EXISTS (SELECT 1 FROM event e WHERE e.id = s.event_id AND e.t_start_year = s.event_year)
    UNION ALL
    SELECT p.event_id FROM event_person p
      WHERE NOT EXISTS (SELECT 1 FROM event e WHERE e.id = p.event_id AND e.t_start_year = p.event_year)
  ) u;
  IF n_orphan > 0 THEN
    RAISE EXCEPTION '复合外键语义不成立：% 条子表行找不到 (id,event_year) 父行', n_orphan;
  END IF;

  SELECT count(*) INTO n_drift FROM event_claim c
    JOIN event e ON e.id = c.event_id WHERE c.event_year <> e.t_start_year;
  IF n_drift > 0 THEN
    RAISE EXCEPTION 'event_year 回填漂移：% 行', n_drift;
  END IF;
END $do$;

INSERT INTO _partition_migration_state (plan, note)
  VALUES ('A', '分区表 + 复合外键；event_legacy 保留待回滚')
  ON CONFLICT (plan) DO NOTHING;

COMMIT;

-- ---------- A12. 收尾（确认无误后手工执行，不在本事务内） ----------
--   DROP TABLE event_legacy;   -- 破坏性：先备份，再确认 17 个分区数据完整
-- event_legacy 上的索引名是 legacy_*，DROP 之后自动释放；新表已用 canonical 名，无需改名。
-- @@PLAN_A_END


-- ============================================================================
-- @@PLAN_B_BEGIN
-- §B  方案 B —— 丢外键保简单
-- ============================================================================
-- 适用：原型/早期阶段、能接受"应用层 + 定时体检"补一致性
-- 代价：event_claim / event_source / event_person 会留下孤儿行（ON DELETE CASCADE 消失）
-- 收益：子表零改动（不加列、不重建索引、不停写），迁移窗口最短
-- ============================================================================

BEGIN;

-- ---------- B0. 守卫 ----------
CREATE TABLE IF NOT EXISTS _partition_migration_state (
  plan       TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note       TEXT
);

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM _partition_migration_state WHERE plan = 'A') THEN
    RAISE EXCEPTION '本库已应用方案 A（复合外键），不能再跑方案 B。请用备份恢复到干净库后重来。';
  END IF;
  IF to_regclass('public.event') IS NULL THEN
    RAISE EXCEPTION '找不到 public.event，本脚本必须在已有 event 表的库上执行。';
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.event'::regclass) = 'p' THEN
    RAISE EXCEPTION 'public.event 已经是分区表，勿重复执行本迁移。';
  END IF;
END $do$;

-- ---------- B1. 先腾出 12 个全局索引名（见 §1；这是上一版失败的地方） ----------
DO $do$
DECLARE r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'legacy_event_pkey') THEN
    FOR r IN SELECT indexname FROM pg_indexes
              WHERE schemaname = 'public' AND tablename = 'event'
    LOOP
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', r.indexname, 'legacy_' || r.indexname);
    END LOOP;
  END IF;
END $do$;

-- ---------- B2. 建分区表 ----------
CREATE TABLE IF NOT EXISTS event_p (
  id            BIGINT NOT NULL,
  slug          TEXT NOT NULL,
  title         TEXT NOT NULL,
  track         TEXT NOT NULL CHECK (track IN ('cn','world')),
  category      TEXT NOT NULL,
  discipline    TEXT,
  t_start_year  INT  NOT NULL,
  t_start_month SMALLINT,
  t_start_day   SMALLINT,
  t_end_year    INT,
  t_end_month   SMALLINT,
  t_end_day     SMALLINT,
  t_precision   t_precision  NOT NULL DEFAULT 'year',
  t_certainty   t_certainty  NOT NULL DEFAULT 'certain',
  t_span        INT4RANGE GENERATED ALWAYS AS
                (int4range(t_start_year, COALESCE(t_end_year, t_start_year) + 1)) STORED,
  place_slug    TEXT,
  lat           DOUBLE PRECISION,
  lon           DOUBLE PRECISION,
  summary       TEXT,
  search_text   TEXT,
  search_tsv    TSVECTOR,
  status        entity_status NOT NULL DEFAULT 'published',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  rev           INT NOT NULL DEFAULT 1
) PARTITION BY RANGE (t_start_year);

-- ---------- B3. 17 个分区：与方案 A 完全相同（15 个 500 年档 + 2 个溢出） ----------
CREATE TABLE IF NOT EXISTS event_y_before_m5000 PARTITION OF event_p FOR VALUES FROM (MINVALUE) TO (-5000);
CREATE TABLE IF NOT EXISTS event_y_m5000_m4500 PARTITION OF event_p FOR VALUES FROM (-5000) TO (-4500);
CREATE TABLE IF NOT EXISTS event_y_m4500_m4000 PARTITION OF event_p FOR VALUES FROM (-4500) TO (-4000);
CREATE TABLE IF NOT EXISTS event_y_m4000_m3500 PARTITION OF event_p FOR VALUES FROM (-4000) TO (-3500);
CREATE TABLE IF NOT EXISTS event_y_m3500_m3000 PARTITION OF event_p FOR VALUES FROM (-3500) TO (-3000);
CREATE TABLE IF NOT EXISTS event_y_m3000_m2500 PARTITION OF event_p FOR VALUES FROM (-3000) TO (-2500);
CREATE TABLE IF NOT EXISTS event_y_m2500_m2000 PARTITION OF event_p FOR VALUES FROM (-2500) TO (-2000);
CREATE TABLE IF NOT EXISTS event_y_m2000_m1500 PARTITION OF event_p FOR VALUES FROM (-2000) TO (-1500);
CREATE TABLE IF NOT EXISTS event_y_m1500_m1000 PARTITION OF event_p FOR VALUES FROM (-1500) TO (-1000);
CREATE TABLE IF NOT EXISTS event_y_m1000_m500  PARTITION OF event_p FOR VALUES FROM (-1000) TO (-500);
CREATE TABLE IF NOT EXISTS event_y_m500_0      PARTITION OF event_p FOR VALUES FROM (-500)  TO (0);
CREATE TABLE IF NOT EXISTS event_y_0_500       PARTITION OF event_p FOR VALUES FROM (0)      TO (500);
CREATE TABLE IF NOT EXISTS event_y_500_1000    PARTITION OF event_p FOR VALUES FROM (500)    TO (1000);
CREATE TABLE IF NOT EXISTS event_y_1000_1500   PARTITION OF event_p FOR VALUES FROM (1000)   TO (1500);
CREATE TABLE IF NOT EXISTS event_y_1500_2000   PARTITION OF event_p FOR VALUES FROM (1500)   TO (2000);
CREATE TABLE IF NOT EXISTS event_y_2000_2500   PARTITION OF event_p FOR VALUES FROM (2000)   TO (2500);
CREATE TABLE IF NOT EXISTS event_y_after_2500  PARTITION OF event_p FOR VALUES FROM (2500)   TO (MAXVALUE);

-- ---------- B4. 灌数据 ----------
INSERT INTO event_p (
  id, slug, title, track, category, discipline,
  t_start_year, t_start_month, t_start_day,
  t_end_year, t_end_month, t_end_day,
  t_precision, t_certainty,
  place_slug, lat, lon, summary, search_text, search_tsv,
  status, created_at, rev
)
SELECT
  id, slug, title, track, category, discipline,
  t_start_year, t_start_month, t_start_day,
  t_end_year, t_end_month, t_end_day,
  t_precision, t_certainty,
  place_slug, lat, lon, summary, search_text, search_tsv,
  status, created_at, rev
FROM event;

-- ---------- B5. 主键 / 唯一 / 索引（不含 IF NOT EXISTS，见 §1） ----------
ALTER TABLE event_p ADD CONSTRAINT event_pkey          PRIMARY KEY (id, t_start_year);
ALTER TABLE event_p ADD CONSTRAINT event_slug_year_key UNIQUE (slug, t_start_year);

CREATE INDEX event_year_idx   ON event_p (t_start_year);
CREATE INDEX event_track_idx  ON event_p (track, t_start_year);
CREATE INDEX event_status_idx ON event_p (status);
CREATE INDEX event_place_idx  ON event_p (place_slug);
CREATE INDEX event_fts_idx    ON event_p USING GIN (search_tsv);
CREATE INDEX event_span_idx   ON event_p USING GIST (t_span);
CREATE INDEX event_timeline_cover_idx
  ON event_p (t_start_year)
  INCLUDE (slug, title, t_start_month, t_start_day, t_end_year,
           t_precision, t_certainty, track, category, discipline, lat, lon)
  WHERE status = 'published';
CREATE INDEX event_title_trgm_idx       ON event_p USING GIN (title gin_trgm_ops);
CREATE INDEX event_summary_trgm_idx     ON event_p USING GIN (summary gin_trgm_ops);
CREATE INDEX event_search_text_trgm_idx ON event_p USING GIN (search_text gin_trgm_ops);

-- ---------- B6. 删掉三张子表的单列外键（方案 B 的全部代价就在这里） ----------
-- 必须**在 rename 之前**删：约束按 OID 挂在 event 上，rename 后会跟着指向 event_legacy，
-- 届时按名字 DROP 虽然仍能命中，但语义上是在拆一张已经没有约束意义的旧表，容易误判。
-- 用 to_regclass 守卫，使本脚本在没有子表的库（如 partition_proto）上也能跑通。
DO $do$
DECLARE t text; cn text;
BEGIN
  FOREACH t IN ARRAY ARRAY['event_claim','event_source','event_person'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      cn := t || '_event_id_fkey';
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, cn);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (event_id)', t || '_event_idx', t);
    END IF;
  END LOOP;
END $do$;
-- 注意：上面保留 event_id 普通索引，孤儿行的定期体检仍要靠它。
-- 孤儿行体检 SQL 见 §C3。

-- ---------- B7. 换名 ----------
ALTER TABLE event   RENAME TO event_legacy;
ALTER TABLE event_p RENAME TO event;

-- ---------- B8. 序列接管 ----------
SELECT setval('event_id_seq', GREATEST((SELECT COALESCE(MAX(id), 0) FROM event), 1), true);
ALTER SEQUENCE event_id_seq OWNED BY event.id;
ALTER TABLE event ALTER COLUMN id SET DEFAULT nextval('event_id_seq');

-- ---------- B9. 自检 ----------
ANALYZE event;

DO $do$
DECLARE n_new bigint; n_old bigint; n_part int; n_fk int;
BEGIN
  SELECT count(*) INTO n_new FROM event;
  SELECT count(*) INTO n_old FROM event_legacy;
  IF n_new <> n_old THEN
    RAISE EXCEPTION '行数不守恒：新表 % 行 vs 旧表 % 行', n_new, n_old;
  END IF;

  SELECT count(*) INTO n_part FROM pg_inherits WHERE inhparent = 'public.event'::regclass;
  IF n_part <> 17 THEN
    RAISE EXCEPTION '分区数应为 17，实际 %', n_part;
  END IF;

  -- 方案 B 的前提就是"没有任何外键再指向 event"
  SELECT count(*) INTO n_fk FROM pg_constraint WHERE confrelid = 'public.event'::regclass;
  IF n_fk <> 0 THEN
    RAISE EXCEPTION '方案 B 执行后仍有 % 个外键指向 event，与设计不符', n_fk;
  END IF;
END $do$;

INSERT INTO _partition_migration_state (plan, note)
  VALUES ('B', '分区表 + 无外键；引用完整性交由应用层')
  ON CONFLICT (plan) DO NOTHING;

COMMIT;

-- ---------- B10. 收尾（确认无误后手工执行） ----------
--   DROP TABLE event_legacy;
-- @@PLAN_B_END


-- ============================================================================
-- §C  迁移后的验证 / 体检 SQL（两套方案通用，全部为只读，可随时手工跑）
-- ============================================================================

-- C1. 行数守恒：新表必须与 event_legacy 一致
--   SELECT (SELECT count(*) FROM event) AS new_cnt,
--          (SELECT count(*) FROM event_legacy) AS old_cnt;

-- C2. 分区清单与行数分布
--   SELECT c.relname AS partition, c.reltuples::bigint AS approx_rows,
--          pg_size_pretty(pg_total_relation_size(c.oid)) AS size
--   FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
--   WHERE i.inhparent = 'event'::regclass ORDER BY 1;

-- C3. 孤儿行体检（方案 B 必跑；方案 A 应恒为 0）
--   SELECT 'event_claim' AS t, count(*) FROM event_claim c
--     WHERE NOT EXISTS (SELECT 1 FROM event e WHERE e.id = c.event_id)
--   UNION ALL
--   SELECT 'event_source', count(*) FROM event_source s
--     WHERE NOT EXISTS (SELECT 1 FROM event e WHERE e.id = s.event_id)
--   UNION ALL
--   SELECT 'event_person', count(*) FROM event_person p
--     WHERE NOT EXISTS (SELECT 1 FROM event e WHERE e.id = p.event_id);

-- C4. 剪枝是否生效（关键：谓词必须落在分区键 t_start_year 上）
--   EXPLAIN (ANALYZE, COSTS OFF) SELECT ...
--     FROM event WHERE t_start_year >= 1460 AND t_start_year < 1470;  -- 只扫 1 个分区
--   EXPLAIN (ANALYZE, COSTS OFF) SELECT ...
--     FROM event WHERE t_span && int4range(1460,1470);                -- 扫**全部 17 个**（无剪枝）

-- C5. ON CONFLICT (slug) 是否已失效（方案 A/B 都一样，应报 42P10）
--   INSERT INTO event (slug,title,track,category,t_start_year,status)
--     VALUES ('x','x','cn','politics',1500,'published')
--     ON CONFLICT (slug) DO NOTHING;

-- C6. 子表一致性（方案 A）：event_year 必须等于父行 t_start_year
--   SELECT count(*) FROM event_claim c JOIN event e ON e.id = c.event_id
--    WHERE c.event_year <> e.t_start_year;


-- ============================================================================
-- §D  影响面 & 风险清单（详细实测数据见 docs/report/partition.md）
-- ============================================================================
-- R1 外键：三张子表（不止两张）。方案 A 要加列+回填+NOT NULL+重建，全部持锁；
--         方案 B 直接丢约束，ON DELETE CASCADE 语义消失 → 删事件不再级联清子表，
--         必须补一个定期孤儿行清理任务，否则 event_claim 会越长越脏。
-- R2 主键语义：(id) → (id, t_start_year)。任何 `WHERE id = $1` 或
--         `JOIN event e ON e.id = x` 都无法再走唯一索引，要么扫全部分区（方案 B），
--         要么必须把 event_year 一起带上（方案 A）。涉及 src/api/person.js、
--         src/api/event.js 的多处 id-only 访问。
-- R3 序列：BIGSERIAL 的 event_id_seq 不会随分区自动重建；必须 setval + OWNED BY +
--         SET DEFAULT，否则下一次 INSERT 从 1 开始撞主键。
--         **额外坑**：若不把 OWNED BY 从 event_legacy.id 转走，之后 DROP TABLE
--         event_legacy 会连带 DROP 掉 event_id_seq，新表随即无法插入。
-- R4 slug 唯一性：UNIQUE(slug) → UNIQUE(slug, t_start_year)。
--         `ON CONFLICT (slug)` 在 src/ingest/router.js 运行期直接报 42P10，摄取管线中断。
--         补救：应用层先按 slug 查再按年份定位；或引入 slug_registry 表，
--         把"slug 全局唯一"迁到一张不带分区的表上（推荐）。
-- R5 索引重建：12 个父索引 × 17 个分区 = 200+ 个物理索引。GIN/FTS 每个分区各建一份，
--         写入吞吐下降（GIN 插入比 btree 贵），总体积不一定省。
--         空分区虽然行数为 0，但仍然占 relfilenode 与索引页，元数据开销 ×17。
-- R6 分区边界：本文件给了 [2500, MAXVALUE) 兜底分区，插入任何远期年份都不报错；
--         代价是这个兜底分区会不断膨胀，且"从 DEFAULT/MAXVALUE 分区里搬数据再
--         ATTACH 新分区"需要先扫描搬迁。若想"超界即失败"，把最后一条改成
--         FOR VALUES FROM (2500) TO (3000) 并显式留出未覆盖区间。
-- R7 锁表时间：两套方案都在**单个事务**里换表，期间 event 持 ACCESS EXCLUSIVE。
--         方案 A 另有子表 UPDATE/ALTER（同样 ACCESS EXCLUSIVE）。728 行是毫秒级；
--         百万行以上必须停机窗口，或改用 §D-R8 的"双写 + 分批回填 + 短锁切换"。
-- R8 统计与计划退化：分区表走 Append → 每分区统计单独维护，ANALYZE 成本 × 分区数；
--         跨分区聚合（无谓词 count(*)）变成 17 路扫描，**反而不如单表 Seq Scan**。
--         实测见 docs/report/partition.md §3。
-- R9 复制/备份：逻辑复制按分区逐个同步，订阅端表数 ×17；pg_dump 同理。
-- R10 生成列：t_span 是 STORED 生成列，分区表支持，但它**不能**作为分区键。
--         所以基于 t_span 的 GiST 区间查询（`t_span && int4range(...)`）永远拿不到
--         剪枝收益 —— 这是本设计最大的功能局限，见 docs/report/partition.md §5 结论。
-- ============================================================================
