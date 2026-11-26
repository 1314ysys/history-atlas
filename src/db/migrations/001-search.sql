-- ============================================================================
-- 001-search.sql —— 检索功能深度迁移：单字索引化 + 同义词表
-- ============================================================================
-- 背景
--   event.search_tsv 是「应用层 bigram → to_tsvector('simple', …)」，只含二元组，
--   因此单字查询（如 q=秦）在 tsquery 里没有可命中的词素，旧实现只能退化为
--   `title ILIKE '%秦%' OR summary ILIKE '%秦%' OR search_text LIKE '%秦%'` 全表扫描。
--
-- 本迁移做两件事：
--   1) pg_trgm + GIN：让「任意短子串」的 ILIKE/LIKE 可以走 Bitmap Index Scan。
--      · title / summary —— 业务查询里直接命中的两列；
--      · search_text     —— 旧 LIKE 兜底的第三条件（title+summary+category+
--                           discipline+place_slug 的小写拼接），不给它建索引的话
--                           「三条件 OR」里仍有不可索引项，规划器依旧会退化为 Seq Scan。
--   2) search_synonym：同义词/别称表，供 src/api/search.js 做查询扩展
--      （TSQUERY 用 OR 组，单字扩展走 trgm ILIKE 分支）。
--
-- 幂等性
--   全部 DDL 使用 IF NOT EXISTS；种子数据用 ON CONFLICT (term) DO UPDATE，
--   因此本文件可反复执行（含在已有库上重跑），不会报错也不会重复插入。
--   文件自带 BEGIN/COMMIT，请整文件执行（scripts/apply-search-migration.js 就是这么做的）。
--
-- 依赖：pg_trgm（扩展文件已存在于本机 PG 19.0）
-- ============================================================================

BEGIN;

-- ---------- 1. 单字/短查询索引化：pg_trgm ----------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- q=秦 这类单字查询的实际谓词：title ILIKE '%秦%'
CREATE INDEX IF NOT EXISTS event_title_trgm_idx
  ON event USING GIN (title gin_trgm_ops);

-- q=秦 的第二个谓词：summary ILIKE '%秦%'
CREATE INDEX IF NOT EXISTS event_summary_trgm_idx
  ON event USING GIN (summary gin_trgm_ops);

-- q=秦 的第三个谓词（保持旧 LIKE 兜底的召回面不变，同时可索引）
CREATE INDEX IF NOT EXISTS event_search_text_trgm_idx
  ON event USING GIN (search_text gin_trgm_ops);

-- ---------- 2. 同义词 / 别称表 ----------

CREATE TABLE IF NOT EXISTS search_synonym (
  id      BIGSERIAL PRIMARY KEY,
  term    TEXT   NOT NULL UNIQUE,
  expands TEXT[] NOT NULL,
  note    TEXT
);

COMMENT ON TABLE  search_synonym        IS '检索同义词/别称表：term 命中的查询会与 expands 做 OR 扩展';
COMMENT ON COLUMN search_synonym.term    IS '查询词规范形（小写、去首尾空白；CJK 无大小写差异）';
COMMENT ON COLUMN search_synonym.expands IS '扩展词数组；≥2 字走 tsquery OR，单字走 trgm ILIKE';
COMMENT ON COLUMN search_synonym.note    IS '史料依据（书名/篇名/年代/实物）';

-- ---------- 3. 同义词种子数据（21 组，每条附史料依据） ----------
-- 覆盖：技术史（造纸/印刷/火药/指南针/铁器/蒸汽机/青霉素）、
--       制度史（科举）、交通与工程（丝路/大运河/长城/都江堰）、
--       事件与实物（郑和/工业革命/甲骨文/活字印刷/火器），
--       以及 4 条反向别名（罗盘/盘尼西林/进士/雕版）让「俗称查正称」也成立。

INSERT INTO search_synonym (term, expands, note) VALUES
  ('造纸',
   ARRAY['蔡伦','纸张','蔡侯纸','造纸术','纸'],
   '《后汉书·蔡伦传》：用树肤、麻头及敝布、鱼网以为纸；元兴元年奏上，天下称「蔡侯纸」。'),
  ('印刷',
   ARRAY['雕版','活字','毕昇','雕版印刷','活字印刷'],
   '雕版盛于唐（咸通九年《金刚经》为现存最早纪年印本）；庆历间毕昇创活字，见《梦溪笔谈》卷十八。'),
  ('火药',
   ARRAY['火器','突火枪','火炮','火药配方','硝石'],
   '庆历四年（1044）《武经总要》载毒药烟球等火药配方；开庆元年（1259）寿春府造突火枪，见《宋史·兵志》。'),
  ('指南针',
   ARRAY['罗盘','司南','磁针','针盘','磁偏角'],
   '《梦溪笔谈》卷二十四记磁针「常微偏东，不全南也」；朱彧《萍洲可谈》记海船「阴晦观指南针」。'),
  ('青霉素',
   ARRAY['盘尼西林','青霉菌','弗莱明','抗生素'],
   '1928 年弗莱明（A. Fleming）发现青霉素；1940 年代弗洛里与钱恩提纯量产，1945 年诺贝尔生理学或医学奖。'),
  ('蒸汽机',
   ARRAY['蒸汽','瓦特','纽科门','蒸汽动力'],
   '1712 年纽科门（T. Newcomen）大气式蒸汽机用于矿井排水；1769 年瓦特（J. Watt）分离冷凝器专利，热效率大增。'),
  ('铁器',
   ARRAY['冶铁','生铁','铸铁','高炉','铁农具'],
   '战国已见生铁冶铸；汉代高炉与炒钢并兴，《汉书·食货志》载盐铁官营。'),
  ('科举',
   ARRAY['进士','贡举','殿试','明经','科举制'],
   '《通典·选举》载隋大业元年（605）始设进士科；唐增明经、进士，宋以殿试定甲第。'),
  ('丝绸之路',
   ARRAY['丝路','张骞','西域','通西域'],
   '《史记·大宛列传》记张骞「凿空」西域；1877 年李希霍芬（F. von Richthofen）命名 Seidenstraße。'),
  ('郑和下西洋',
   ARRAY['宝船','下西洋','郑和','宣德'],
   '《明史·郑和传》：永乐三年（1405）首航，宣德八年（1433）第七次返航。'),
  ('工业革命',
   ARRAY['产业革命','蒸汽动力','工厂制','机械化'],
   '18 世纪中叶起于英国；瓦特蒸汽机与工厂制度为其技术与组织双支点。'),
  ('长城',
   ARRAY['万里长城','边墙','烽燧','障塞'],
   '秦连接燕、赵旧城，《史记·蒙恬列传》「筑长城，因地形，用险制塞」；明长城东起鸭绿江、西至嘉峪关。'),
  ('大运河',
   ARRAY['运河','漕运','通济渠','永济渠'],
   '《隋书·炀帝纪》载大业元年开通济渠、大业四年开永济渠，贯通南北漕运。'),
  ('甲骨文',
   ARRAY['卜辞','殷墟','甲骨','王懿荣'],
   '1899 年王懿荣识出甲骨文字；殷墟 YH127 坑出土大批卜辞。'),
  ('都江堰',
   ARRAY['李冰','鱼嘴','宝瓶口','飞沙堰'],
   '《史记·河渠书》「蜀守冰凿离碓」；鱼嘴分水、飞沙堰泄洪、宝瓶口引水，三者配套。'),
  ('活字印刷',
   ARRAY['活字','泥活字','毕昇','木活字','铜活字'],
   '毕昇庆历间制泥活字（《梦溪笔谈》卷十八）；元王祯创木活字，明无锡华氏行铜活字。'),
  ('火器',
   ARRAY['火药','火炮','火铳','突火枪'],
   '宋元火器以火药为燃烧/推进剂；元至顺三年（1332）铜火铳为现存最早有铭火铳之一。'),
  -- 反向别名：让「俗称 / 旧译 / 单称」也能查到正称条目
  ('罗盘',
   ARRAY['指南针','磁针','针盘'],
   '罗盘为指南针的航海形态（水浮、旱罗盘），《萍洲可谈》《宣和奉使高丽图经》均有记载。'),
  ('盘尼西林',
   ARRAY['青霉素','抗生素'],
   '盘尼西林系 penicillin 旧译，与青霉素同物。'),
  ('进士',
   ARRAY['科举','殿试','贡举'],
   '进士科为科举常科之一，唐以诗赋取士，宋后殿试定甲第。'),
  ('雕版',
   ARRAY['印刷','雕版印刷','刻本'],
   '雕版即整版雕刻付印，唐咸通九年（868）《金刚经》为现存最早纪年印本。')
ON CONFLICT (term) DO UPDATE
  SET expands = EXCLUDED.expands,
      note    = EXCLUDED.note;

COMMIT;
