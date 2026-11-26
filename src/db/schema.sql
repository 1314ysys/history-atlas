-- History Atlas v1 schema (PostgreSQL 18 / PGlite)
-- 假定 schema 全新；迁移由 client.js 控制

CREATE TYPE t_precision   AS ENUM ('day','month','year','decade','century','millennium','unknown');
CREATE TYPE t_certainty   AS ENUM ('certain','probable','circa','disputed','legendary');
CREATE TYPE evidence_level AS ENUM ('A','B','C','D');
CREATE TYPE verify_status AS ENUM ('verified','unverified','mismatch','missing');
CREATE TYPE entity_status AS ENUM ('draft','staged','reviewed','published','rejected');

CREATE TABLE _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO _meta (key, value) VALUES ('schema_version', '1');

-- ---------- 史料与存档 ----------

CREATE TABLE source (
  id             BIGSERIAL PRIMARY KEY,
  slug           TEXT UNIQUE NOT NULL,
  title          TEXT NOT NULL,
  author         TEXT,
  era            TEXT,
  kind           TEXT NOT NULL DEFAULT 'text',
  archive_sha256 TEXT,
  license        TEXT,
  retrieved_url  TEXT,
  retrieved_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE archive_blob (
  sha256        TEXT PRIMARY KEY,
  size          BIGINT NOT NULL,
  mime          TEXT,
  storage_key   TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 实体 ----------

CREATE TABLE place (
  id          BIGSERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  aliases     TEXT[] NOT NULL DEFAULT '{}',
  lat         DOUBLE PRECISION,
  lon         DOUBLE PRECISION,
  admin_level SMALLINT,
  parent_slug TEXT,
  note        TEXT
);

CREATE TABLE person (
  id         BIGSERIAL PRIMARY KEY,
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  aliases    TEXT[] NOT NULL DEFAULT '{}',
  birth_year INT,
  death_year INT,
  dynasty    TEXT,
  note       TEXT
);

CREATE TABLE event (
  id           BIGSERIAL PRIMARY KEY,
  slug         TEXT UNIQUE NOT NULL,
  title        TEXT NOT NULL,
  track        TEXT NOT NULL CHECK (track IN ('cn','world')),
  category     TEXT NOT NULL,
  discipline   TEXT,
  t_start_year INT  NOT NULL,
  t_start_month SMALLINT,
  t_start_day  SMALLINT,
  t_end_year   INT,
  t_end_month  SMALLINT,
  t_end_day    SMALLINT,
  t_precision  t_precision NOT NULL DEFAULT 'year',
  t_certainty  t_certainty NOT NULL DEFAULT 'certain',
  t_span       INT4RANGE GENERATED ALWAYS AS
               (int4range(t_start_year, COALESCE(t_end_year, t_start_year) + 1)) STORED,
  place_slug   TEXT,
  lat          DOUBLE PRECISION,
  lon          DOUBLE PRECISION,
  summary      TEXT,
  search_text  TEXT,          -- 应用层小写全文（LIKE 兜底仍用）
  search_tsv   TSVECTOR,      -- 应用层 tokenize→bigram 后 to_tsvector('simple', ...)
  status       entity_status NOT NULL DEFAULT 'published',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  rev          INT NOT NULL DEFAULT 1
);

CREATE TABLE event_claim (
  id             BIGSERIAL PRIMARY KEY,
  event_id       BIGINT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  statement      TEXT NOT NULL,
  evidence_level evidence_level NOT NULL DEFAULT 'C',
  confidence     REAL,
  disputed_group TEXT,
  adopted        BOOLEAN NOT NULL DEFAULT FALSE,
  rationale      TEXT,
  sort_order     INT NOT NULL DEFAULT 0
);

CREATE TABLE event_source (
  id              BIGSERIAL PRIMARY KEY,
  event_id        BIGINT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  claim_id        BIGINT REFERENCES event_claim(id) ON DELETE CASCADE,
  source_slug     TEXT NOT NULL,
  locator         TEXT,
  quote           TEXT,
  quote_sha256    TEXT,
  verified_status verify_status NOT NULL DEFAULT 'unverified',
  verified_at     TIMESTAMPTZ
);

CREATE TABLE event_person (
  event_id  BIGINT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  person_id BIGINT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  role      TEXT,
  PRIMARY KEY (event_id, person_id)
);

CREATE TABLE person_relation (
  id           BIGSERIAL PRIMARY KEY,
  from_slug    TEXT NOT NULL,
  to_slug      TEXT NOT NULL,
  type         TEXT NOT NULL,
  t_start_year INT,
  t_end_year   INT,
  source_slug  TEXT,
  UNIQUE (from_slug, to_slug, type)
);

CREATE TABLE tech (
  id                  BIGSERIAL PRIMARY KEY,
  slug                TEXT UNIQUE NOT NULL,
  name                TEXT NOT NULL,
  category            TEXT NOT NULL,
  first_attested_year INT,
  region              TEXT,
  place_slug          TEXT,
  source_slug         TEXT,
  note                TEXT
);

CREATE TABLE boundary_slice (
  id      BIGSERIAL PRIMARY KEY,
  year    INT NOT NULL,
  name    TEXT NOT NULL,
  geojson JSONB NOT NULL,
  note    TEXT
);

-- 朝代 / 政权存续区间（时间轴底色带用）
CREATE TABLE dynasty (
  id         BIGSERIAL PRIMARY KEY,
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  name_en    TEXT,
  start_year INT NOT NULL,
  end_year   INT NOT NULL,
  era_group  TEXT NOT NULL DEFAULT 'other',  -- 先秦/秦汉/魏晋/隋唐/宋元/明清/近现代
  color      TEXT NOT NULL DEFAULT '#888888',
  certainty  t_certainty NOT NULL DEFAULT 'certain',
  note       TEXT
);

-- ---------- 采集 ----------

CREATE TABLE ingest_batch (
  id          BIGSERIAL PRIMARY KEY,
  batch_id    TEXT UNIQUE NOT NULL,
  collector   TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted    INT NOT NULL DEFAULT 0,
  rejected    INT NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'staged',
  errors      JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE staging_event (
  id          BIGSERIAL PRIMARY KEY,
  batch_id    TEXT NOT NULL REFERENCES ingest_batch(batch_id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  idem_key    TEXT NOT NULL UNIQUE,
  payload     JSONB NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 索引 ----------

-- 注意：不单独建 (t_start_year) 的 btree 索引。
-- event_timeline_cover_idx 已以 t_start_year 为键并 INCLUDE 了所有输出列，
-- 实测（bench/optimize-probe.js）planner 在纯年份过滤/排序时也选 cover_idx，
-- 单独的 event_year_idx 是冗余的（v3.0.6 移除，省约 5% 索引体积）。
CREATE INDEX event_track_idx   ON event (track, t_start_year);
CREATE INDEX event_status_idx  ON event (status);
CREATE INDEX event_fts_idx     ON event USING GIN (search_tsv);

-- 时间轴覆盖索引：让区间查询走 Index Only Scan，避免回表取整行
CREATE INDEX event_timeline_cover_idx
  ON event (t_start_year)
  INCLUDE (slug, title, t_start_month, t_start_day, t_end_year,
           t_precision, t_certainty, track, category, discipline, lat, lon)
  WHERE status = 'published';
CREATE INDEX event_span_idx    ON event USING GIST (t_span);
CREATE INDEX event_place_idx   ON event (place_slug);
CREATE INDEX person_name_idx   ON person (name);
CREATE INDEX rel_from_idx      ON person_relation (from_slug);
CREATE INDEX rel_to_idx        ON person_relation (to_slug);
CREATE INDEX claim_event_idx   ON event_claim (event_id);
CREATE INDEX esource_event_idx ON event_source (event_id);
CREATE INDEX boundary_year_idx ON boundary_slice (year);
CREATE INDEX dynasty_span_idx ON dynasty (start_year, end_year);
