/**
 * 假采集器 —— 验证 /v1/ingest 的标准化采集通路。
 *
 * 1. 向 POST /v1/ingest/events 投递 30 条合成事件（中国史 + 世界史，年份均为真实年份）；
 * 2. 用同一 batch_id、同一内容再投一次，验证幂等（accepted 应为 0、duplicates 应为 30）；
 * 3. GET /v1/ingest/batches/:batchId 打印批次状态。
 *
 * 用法：先 `npm run dev`，再 `node scripts/fake-collector.js`（或 `npm run collector`）。
 * 环境变量：INGEST_BASE（默认 http://127.0.0.1:5173）、INGEST_TOKEN（默认 dev-token）。
 */

const BASE = (process.env.INGEST_BASE || 'http://127.0.0.1:5173').replace(/\/+$/, '')
const TOKEN = process.env.INGEST_TOKEN || 'dev-token'
const COLLECTOR = 'fake-collector'

/**
 * 30 条合成事件。字段与 src/ingest/schema.js 的校验规则一致；
 * claims / sources / place 只在部分事件上出现，用于覆盖有无可选字段两条路径。
 */
const EVENTS = [
  {
    external_id: 'cn-qin-unification',
    title: '秦统一六国',
    time: { start_year: -221, precision: 'year', certainty: 'certain' },
    track: 'cn',
    category: '政治',
    summary: '秦王政先后灭韩、赵、魏、楚、燕、齐，建立中国历史上第一个中央集权帝国，推行郡县制与书同文、车同轨。',
    place: { name: '咸阳', lat: 34.33, lon: 108.71 },
    claims: [
      { statement: '前221年灭齐，六国归一', evidence_level: 'A', adopted: true },
      { statement: '另有以灭燕（前222年）为统一完成标志的分期说法', evidence_level: 'C' },
    ],
    sources: [
      {
        title: '史记·秦始皇本纪',
        locator: '卷六',
        quote: '二十六年，初并天下',
        retrieved_url: 'https://zh.wikisource.org/wiki/史記/卷006',
      },
    ],
  },
  {
    external_id: 'cn-shang-yang-reform',
    title: '商鞅变法',
    time: { start_year: -356, precision: 'year', certainty: 'probable' },
    track: 'cn',
    category: '制度',
    summary: '秦孝公任用商鞅推行废井田、开阡陌、奖励耕战、编户齐民，秦国由此转强。',
    place: { name: '雍城', lat: 34.52, lon: 107.39 },
    claims: [
      { statement: '变法始于前356年，前350年迁都咸阳后再行第二次变法', evidence_level: 'B', adopted: true },
    ],
  },
  {
    external_id: 'cn-daze-uprising',
    title: '陈胜吴广起义',
    time: { start_year: -209, precision: 'year', certainty: 'certain' },
    track: 'cn',
    category: '军事',
    summary: '戍卒九百人于大泽乡揭竿而起，是中国历史上第一次大规模农民起义。',
    place: { name: '大泽乡', lat: 33.64, lon: 117.05 },
    sources: [{ title: '史记·陈涉世家', locator: '卷四十八', quote: '王侯将相宁有种乎' }],
  },
  {
    external_id: 'cn-zhang-qian-xiyu',
    title: '张骞出使西域',
    time: { start_year: -138, precision: 'year', certainty: 'certain' },
    track: 'cn',
    category: '对外关系',
    summary: '张骞奉汉武帝命出使月氏，前后十三年，打通中原与西域的直接往来，为丝绸之路奠基。',
    place: { name: '长安', lat: 34.27, lon: 108.95 },
  },
  {
    external_id: 'cn-cai-lun-paper',
    title: '蔡伦改进造纸术',
    time: { start_year: 105, precision: 'year', certainty: 'certain' },
    track: 'cn',
    category: '科技',
    summary: '东汉蔡伦以树肤、麻头、敝布、渔网造纸，奏上朝廷，后世称"蔡侯纸"。',
    sources: [{ title: '后汉书·蔡伦传', locator: '卷七十八', quote: '用树肤、麻头及敝布、渔网以为纸' }],
  },
  {
    external_id: 'cn-zhang-heng-seismograph',
    title: '张衡造候风地动仪',
    time: { start_year: 132, precision: 'year', certainty: 'certain' },
    track: 'cn',
    category: '科技',
    summary: '东汉张衡制成候风地动仪，以八龙衔丸感测地震方位，为世界最早的地震验震器记载。',
    place: { name: '洛阳', lat: 34.62, lon: 112.45 },
  },
  {
    external_id: 'cn-water-powered-armillary',
    title: '苏颂建成水运仪象台',
    time: { start_year: 1092, precision: 'year', certainty: 'probable' },
    track: 'cn',
    category: '科技',
    summary: '苏颂、韩公廉在开封建成水运仪象台，以水力驱动浑仪、浑象与报时装置，被视为天文钟先驱。',
    place: { name: '开封', lat: 34.8, lon: 114.31 },
    claims: [
      { statement: '元祐七年（1092）仪象台落成', evidence_level: 'B', adopted: true },
      { statement: '部分构件复原方案仍有争议', evidence_level: 'C' },
    ],
    sources: [{ title: '新仪象法要', locator: '卷上', quote: '以水激轮，轮转而仪象皆动' }],
  },
  {
    external_id: 'cn-keju-jinshi',
    title: '科举进士科创立',
    time: { start_year: 605, precision: 'year', certainty: 'probable' },
    track: 'cn',
    category: '制度',
    summary: '隋炀帝始置进士科，以试策取士，被视为科举制正式确立的标志。',
    place: { name: '洛阳', lat: 34.62, lon: 112.45 },
    claims: [
      { statement: '进士科始于隋大业元年（605）', evidence_level: 'B', adopted: true },
      { statement: '亦有学者主张科举制至唐代方才定型', evidence_level: 'C' },
    ],
  },
  {
    external_id: 'cn-xuanwu-gate',
    title: '玄武门之变',
    time: { start_year: 626, precision: 'year', certainty: 'certain' },
    track: 'cn',
    category: '政治',
    summary: '李世民于长安玄武门伏杀太子李建成、齐王李元吉，随后受禅即位，是为唐太宗。',
    place: { name: '长安', lat: 34.27, lon: 108.95 },
    sources: [{ title: '资治通鉴·唐纪七', locator: '卷一百九十一' }],
  },
  {
    external_id: 'cn-an-lushan-rebellion',
    title: '安史之乱',
    time: { start_year: 755, end_year: 763, precision: 'year', certainty: 'certain' },
    track: 'cn',
    category: '军事',
    summary: '安禄山、史思明相继举兵，唐廷由盛转衰，人口锐减、藩镇割据成形。',
    place: { name: '范阳', lat: 39.48, lon: 115.97 },
    claims: [{ statement: '战乱持续七年余，至763年史朝义自尽始平', evidence_level: 'A', adopted: true }],
  },
  {
    external_id: 'cn-wang-anshi-reform',
    title: '王安石变法',
    time: { start_year: 1069, precision: 'year', certainty: 'certain' },
    track: 'cn',
    category: '制度',
    summary: '宋神宗以王安石为参知政事，推行青苗、募役、方田均税、保甲诸法，引发新旧党争。',
  },
  {
    external_id: 'cn-bi-sheng-movable-type',
    title: '毕昇发明活字印刷',
    time: { start_year: 1041, precision: 'decade', certainty: 'circa' },
    track: 'cn',
    category: '科技',
    summary: '北宋布衣毕昇以胶泥刻字、火烧成活字排版印书，事载沈括《梦溪笔谈》。',
    sources: [{ title: '梦溪笔谈·技艺', locator: '卷十八', quote: '用胶泥刻字，薄如钱唇，每字为一印，火烧令坚' }],
  },
  {
    external_id: 'cn-zheng-he-voyages',
    title: '郑和下西洋',
    time: { start_year: 1405, end_year: 1433, precision: 'year', certainty: 'certain' },
    track: 'cn',
    category: '对外关系',
    summary: '郑和率宝船队七下西洋，最远抵达东非沿岸，是前近代规模最大的远洋航行。',
    place: { name: '太仓刘家港', lat: 31.45, lon: 121.1 },
  },
  {
    external_id: 'cn-zheng-chenggong-taiwan',
    title: '郑成功收复台湾',
    time: { start_year: 1662, precision: 'year', certainty: 'certain' },
    track: 'cn',
    category: '军事',
    summary: '郑成功围热兰遮城九月，荷兰东印度公司守军投降，结束其在台湾三十八年的统治。',
    place: { name: '台南', lat: 22.99, lon: 120.21 },
  },
  {
    external_id: 'cn-opium-war',
    title: '鸦片战争',
    time: { start_year: 1840, end_year: 1842, precision: 'year', certainty: 'certain' },
    track: 'cn',
    category: '军事',
    summary: '英国以虎门销烟为借口出兵，清廷战败签订《南京条约》，中国被迫开埠。',
    place: { name: '广州', lat: 23.13, lon: 113.26 },
    sources: [{ title: '南京条约', locator: '1842年8月29日', quote: '大英商船之在广州、福州、厦门、宁波、上海五处港口贸易' }],
  },
  {
    external_id: 'cn-jiawu-war',
    title: '甲午战争',
    time: { start_year: 1894, end_year: 1895, precision: 'year', certainty: 'certain' },
    track: 'cn',
    category: '军事',
    summary: '中日于黄海、辽东、威海卫交战，北洋水师覆没，清廷签订《马关条约》割台。',
    place: { name: '威海卫', lat: 37.51, lon: 122.12 },
  },
  {
    external_id: 'cn-xinhai-revolution',
    title: '辛亥革命',
    time: { start_year: 1911, precision: 'year', certainty: 'certain' },
    track: 'cn',
    category: '政治',
    summary: '武昌起义引发各省响应，清帝逊位，两千余年帝制终结，中华民国建立。',
    place: { name: '武昌', lat: 30.55, lon: 114.31 },
    claims: [{ statement: '武昌起义爆发于1911年10月10日', evidence_level: 'A', adopted: true }],
  },
  {
    external_id: 'cn-may-fourth',
    title: '五四运动',
    time: { start_year: 1919, precision: 'day', start_month: 5, start_day: 4, certainty: 'certain' },
    track: 'cn',
    category: '社会',
    summary: '北京学生因巴黎和会山东问题游行示威，迅速扩展为全国性爱国运动与新文化高潮。',
    place: { name: '北京', lat: 39.9, lon: 116.4 },
  },
  {
    external_id: 'cn-long-march',
    title: '中国工农红军长征',
    time: { start_year: 1934, end_year: 1936, precision: 'year', certainty: 'certain' },
    track: 'cn',
    category: '军事',
    summary: '中央红军自江西突围，历时两年抵达陕北，行程约二万五千里。',
  },
  {
    external_id: 'cn-northern-song-founded',
    title: '陈桥兵变与北宋建立',
    time: { start_year: 960, precision: 'year', certainty: 'certain' },
    track: 'cn',
    category: '政治',
    summary: '赵匡胤于陈桥驿被拥立为帝，代后周建宋，随后逐步削平南方诸割据政权。',
    place: { name: '开封', lat: 34.8, lon: 114.31 },
  },
  {
    external_id: 'world-hammurabi-code',
    title: '《汉谟拉比法典》颁行',
    time: { start_year: -1754, precision: 'year', certainty: 'circa' },
    track: 'world',
    category: '法律',
    summary: '古巴比伦王汉谟拉比颁刻法典于玄武岩石柱，282 条条文是现存最完整的早期成文法典。',
    place: { name: '巴比伦', lat: 32.54, lon: 44.42 },
    sources: [{ title: '汉谟拉比法典石柱', locator: '卢浮宫 Sb 8', quote: '以眼还眼，以牙还牙' }],
  },
  {
    external_id: 'world-marathon-battle',
    title: '马拉松战役',
    time: { start_year: -490, precision: 'year', certainty: 'certain' },
    track: 'world',
    category: '军事',
    summary: '雅典重装步兵在马拉松平原击退波斯远征军，希腊人保住本土城邦独立。',
    place: { name: '马拉松', lat: 38.15, lon: 23.96 },
  },
  {
    external_id: 'world-alexander-campaign',
    title: '亚历山大东征',
    time: { start_year: -334, end_year: -323, precision: 'year', certainty: 'certain' },
    track: 'world',
    category: '军事',
    summary: '马其顿亚历山大自赫勒斯滂渡海，十年间灭波斯帝国，兵锋至印度河流域。',
    place: { name: '巴比伦', lat: 32.54, lon: 44.42 },
  },
  {
    external_id: 'world-roman-empire',
    title: '罗马帝国建立',
    time: { start_year: -27, precision: 'year', certainty: 'certain' },
    track: 'world',
    category: '政治',
    summary: '元老院授予屋大维"奥古斯都"称号，罗马由共和国转入元首制帝政。',
    place: { name: '罗马', lat: 41.9, lon: 12.5 },
  },
  {
    external_id: 'world-magna-carta',
    title: '《大宪章》签署',
    time: { start_year: 1215, precision: 'day', start_month: 6, start_day: 15, certainty: 'certain' },
    track: 'world',
    category: '法律',
    summary: '英格兰贵族迫使约翰王在兰尼米德签署大宪章，确认王权受法律约束的原则。',
    place: { name: '兰尼米德', lat: 51.44, lon: -0.56 },
    sources: [{ title: 'Magna Carta (1215)', locator: 'clause 39', quote: 'No free man shall be seized or imprisoned ... except by the lawful judgement of his equals' }],
  },
  {
    external_id: 'world-columbus-1492',
    title: '哥伦布抵达美洲',
    time: { start_year: 1492, precision: 'day', start_month: 10, start_day: 12, certainty: 'certain' },
    track: 'world',
    category: '地理',
    summary: '哥伦布船队抵达巴哈马群岛，开启欧洲与美洲的持续接触与随后的殖民时代。',
    place: { name: '瓜纳哈尼岛', lat: 23.6, lon: -74.8 },
  },
  {
    external_id: 'world-gutenberg-press',
    title: '古腾堡活字印刷',
    time: { start_year: 1440, precision: 'decade', certainty: 'circa' },
    track: 'world',
    category: '科技',
    summary: '美因茨的古腾堡以铅合金活字与油性墨印刷，约1455年印成四十二行圣经。',
    place: { name: '美因茨', lat: 50.0, lon: 8.27 },
  },
  {
    external_id: 'world-newton-principia',
    title: '牛顿《自然哲学的数学原理》出版',
    time: { start_year: 1687, precision: 'year', certainty: 'certain' },
    track: 'world',
    category: '科学',
    summary: '提出运动三定律与万有引力定律，建立经典力学的公理化体系。',
    place: { name: '伦敦', lat: 51.51, lon: -0.13 },
  },
  {
    external_id: 'world-french-revolution',
    title: '法国大革命',
    time: { start_year: 1789, precision: 'year', certainty: 'certain' },
    track: 'world',
    category: '政治',
    summary: '三级会议与攻占巴士底狱引发革命，废除封建特权，颁布《人权与公民权宣言》。',
    place: { name: '巴黎', lat: 48.86, lon: 2.35 },
    sources: [{ title: '人权与公民权宣言', locator: '1789年8月26日', quote: '人生来并始终是自由的，在权利上是平等的' }],
  },
  {
    external_id: 'world-apollo-11',
    title: '阿波罗11号载人登月',
    time: { start_year: 1969, precision: 'day', start_month: 7, start_day: 20, certainty: 'certain' },
    track: 'world',
    category: '科技',
    summary: '阿姆斯特朗与奥尔德林登上月球静海，人类首次踏足另一颗天体。',
    place: { name: '静海', lat: 0.67, lon: 23.47 },
  },
]

/** 统一的 HTTP 调用：非 2xx 直接抛错，避免把错误当成功打印 */
async function request(method, pathname, body) {
  const url = `${BASE}${pathname}`
  const headers = { authorization: `Bearer ${TOKEN}` }
  if (body !== undefined) headers['content-type'] = 'application/json'

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    const message = json && json.error ? `${json.error.code}: ${json.error.message}` : text.slice(0, 200)
    throw new Error(`${method} ${pathname} → HTTP ${res.status} (${message})`)
  }
  return json
}

/** 一行结果播报 */
function report(title, r) {
  console.log(
    `  ${title}  accepted=${r.accepted}  rejected=${r.rejected}  duplicates=${r.duplicates}  staged=${r.staged}`,
  )
  if (Array.isArray(r.errors) && r.errors.length) {
    for (const e of r.errors.slice(0, 5)) console.log(`    ! #${e.index} ${e.external_id ?? '-'} ${e.path}: ${e.message}`)
  }
}

function reportBatch(b) {
  console.log(`  batch_id    ${b.batch_id}`)
  console.log(`  status      ${b.status}`)
  console.log(`  accepted    ${b.accepted}`)
  console.log(`  rejected    ${b.rejected}`)
  console.log(`  staged      ${b.staged_count}（pending ${b.pending_count}）`)
  if (Array.isArray(b.errors) && b.errors.length) console.log(`  errors      ${b.errors.length} 条`)
}

async function main() {
  const batchId = `fake-${Date.now()}`
  const payload = { collector: COLLECTOR, batch_id: batchId, events: EVENTS }

  console.log(`\n[collector] ${COLLECTOR} → ${BASE}`)
  console.log(`[collector] 投递 ${EVENTS.length} 条合成事件，batch_id=${batchId}\n`)

  const first = await request('POST', '/v1/ingest/events', payload)
  report('第 1 次投递      ', first)

  // 同一 batch_id、同一内容重复投递：期望 accepted=0、duplicates=30
  const second = await request('POST', '/v1/ingest/events', payload)
  report('第 2 次投递（重投）', second)

  const batch = await request('GET', `/v1/ingest/batches/${encodeURIComponent(batchId)}`)
  console.log('\n[collector] GET /v1/ingest/batches/:batchId')
  reportBatch(batch)

  const problems = []
  if (first.accepted !== EVENTS.length) problems.push(`首投 accepted=${first.accepted}，期望 ${EVENTS.length}`)
  if (first.duplicates !== 0) problems.push(`首投 duplicates=${first.duplicates}，期望 0`)
  if (second.accepted !== 0) problems.push(`重投 accepted=${second.accepted}，期望 0`)
  if (second.duplicates !== EVENTS.length) problems.push(`重投 duplicates=${second.duplicates}，期望 ${EVENTS.length}`)
  if (batch.pending_count !== EVENTS.length) problems.push(`pending_count=${batch.pending_count}，期望 ${EVENTS.length}`)
  if (batch.staged_count !== EVENTS.length) problems.push(`staged_count=${batch.staged_count}，期望 ${EVENTS.length}`)

  console.log('')
  if (problems.length) {
    for (const p of problems) console.log(`  ✗ ${p}`)
    console.log('\n[collector] 幂等校验失败\n')
    process.exitCode = 1
    return
  }
  console.log(`  ✓ 幂等校验通过：重投 ${EVENTS.length} 条，新增 0 条，库里仍是 ${batch.staged_count} 条 pending`)
  console.log(`\n[collector] 下一步（把 staging 提升为正式 event）：`)
  console.log(`  curl -X POST ${BASE}/v1/ingest/batches/${batchId}/promote -H "Authorization: Bearer ${TOKEN}"\n`)
}

try {
  await main()
} catch (err) {
  console.error(`\n[collector] 失败：${err.message}`)
  if (err.cause && (err.cause.code || err.cause.message)) {
    console.error(`[collector] 原因：${err.cause.code || err.cause.message}`)
  }
  console.error('[collector] 提示：先在本机启动服务（npm run dev，默认 5173），再运行本脚本\n')
  process.exitCode = 1
}
