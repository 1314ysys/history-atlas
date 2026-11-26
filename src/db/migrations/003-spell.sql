-- ============================================================================
-- 003-spell.sql —— 拼写容错词表（search_vocab）
-- ============================================================================
-- 用途
--   给 src/domain/spell.js 的 suggest() 提供 vocabulary：用户打错字
--   （q=青霉术）时，从词表里找编辑距离 ≤ 2 的真实词（青霉素）回给前端。
--
-- 分工（重要）
--   · **SQL 侧只建表 + 建索引，不做中文分词**。中文没有空格边界，SQL 里能做的
--     只有正则硬切，切出来的东西不可控；本项目的分词口径统一在
--     src/domain/tokenize.js（应用层），因此词表的生成/统计/写入全部在
--     scripts/apply-spell.js 的 Node 侧完成：
--       词条 = tokenize(title/summary) 的 token + CJK 连续片段上长度 2..6 的窗口
--       频次 = 每条 title/summary 中的**出现次数**累加
--       入库 = freq ≥ 2 的词（控制表大小），INSERT … ON CONFLICT DO UPDATE
--   · 本文件只保证「表/索引存在」且可反复执行（幂等）。
--
-- 幂等性
--   全部 DDL 使用 IF NOT EXISTS；文件自带 BEGIN/COMMIT，请整文件执行
--   （scripts/apply-spell.js 就是这么做的）。可在已有库上重跑，不报错、不丢数据。
--
-- 依赖：pg_trgm（001-search.sql 已 CREATE EXTENSION，本文件再保险一次）
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- 1. 词表物化表 ----------

CREATE TABLE IF NOT EXISTS search_vocab (
  term      TEXT PRIMARY KEY,
  freq      INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  search_vocab            IS '拼写建议词表（由 scripts/apply-spell.js 从 event.title/summary 生成，freq ≥ 2）';
COMMENT ON COLUMN search_vocab.term       IS '词条（CJK 为 2..6 字窗口或整段 bigram；ASCII 为小写整词）';
COMMENT ON COLUMN search_vocab.freq       IS '在 event.title/summary 中出现次数（应用层统计，非文档频次）';
COMMENT ON COLUMN search_vocab.updated_at IS '最后一次 upsert 时间';

-- ---------- 2. 索引 ----------

-- 词表自身的模糊查询（运维/调试用：SELECT term FROM search_vocab WHERE term % '青霉术'）
CREATE INDEX IF NOT EXISTS search_vocab_term_trgm_idx
  ON search_vocab USING GIN (term gin_trgm_ops);

-- 取「高频词表」用的加载路径：ORDER BY freq DESC, term LIMIT n —— 走索引免排序
CREATE INDEX IF NOT EXISTS search_vocab_freq_idx
  ON search_vocab (freq DESC, term);

COMMIT;
