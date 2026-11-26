/**
 * 中国历代王朝存续区间 —— 时间轴底色带用。
 * 颜色按「时代组」分配，同一组内色调一致，便于一眼看出大分期。
 * 年份为通行学界断代；有争议者在 note 中说明，certainty 标 disputed/legendary。
 */

const G = {
  先秦: '#b08d57',
  秦汉: '#4f6fd4',
  魏晋: '#1f9e9e',
  隋唐: '#d9a227',
  宋元: '#8e5aa8',
  明清: '#c0453a',
  近现代: '#6b7a8f',
}

export const dynasties = [
  { slug: 'xia', name: '夏', name_en: 'Xia', start_year: -2070, end_year: -1600, era_group: '先秦', color: G.先秦, certainty: 'legendary', note: '存在性与年代均有争议，二里头文化归属未定' },
  { slug: 'shang', name: '商', name_en: 'Shang', start_year: -1600, end_year: -1046, era_group: '先秦', color: G.先秦, certainty: 'circa', note: '商代晚期有甲骨文与殷墟实证' },
  { slug: 'western-zhou', name: '西周', name_en: 'Western Zhou', start_year: -1046, end_year: -771, era_group: '先秦', color: G.先秦, certainty: 'circa', note: '克商年有前1046/前1027等多种说法' },
  { slug: 'eastern-zhou', name: '东周', name_en: 'Eastern Zhou', start_year: -770, end_year: -256, era_group: '先秦', color: G.先秦, certainty: 'certain' },
  { slug: 'spring-autumn', name: '春秋', name_en: 'Spring and Autumn', start_year: -770, end_year: -476, era_group: '先秦', color: G.先秦, certainty: 'circa', note: '与东周重叠，为史学分期' },
  { slug: 'warring-states', name: '战国', name_en: 'Warring States', start_year: -475, end_year: -221, era_group: '先秦', color: G.先秦, certainty: 'circa' },
  { slug: 'qin', name: '秦', name_en: 'Qin', start_year: -221, end_year: -207, era_group: '秦汉', color: G.秦汉, certainty: 'certain' },
  { slug: 'western-han', name: '西汉', name_en: 'Western Han', start_year: -202, end_year: 8, era_group: '秦汉', color: G.秦汉, certainty: 'certain' },
  { slug: 'xin', name: '新', name_en: 'Xin', start_year: 9, end_year: 23, era_group: '秦汉', color: G.秦汉, certainty: 'certain' },
  { slug: 'eastern-han', name: '东汉', name_en: 'Eastern Han', start_year: 25, end_year: 220, era_group: '秦汉', color: G.秦汉, certainty: 'certain' },
  { slug: 'three-kingdoms', name: '三国', name_en: 'Three Kingdoms', start_year: 220, end_year: 280, era_group: '魏晋', color: G.魏晋, certainty: 'certain' },
  { slug: 'western-jin', name: '西晋', name_en: 'Western Jin', start_year: 265, end_year: 316, era_group: '魏晋', color: G.魏晋, certainty: 'certain' },
  { slug: 'eastern-jin', name: '东晋', name_en: 'Eastern Jin', start_year: 317, end_year: 420, era_group: '魏晋', color: G.魏晋, certainty: 'certain' },
  { slug: 'northern-southern', name: '南北朝', name_en: 'Northern and Southern', start_year: 420, end_year: 589, era_group: '魏晋', color: G.魏晋, certainty: 'certain' },
  { slug: 'sui', name: '隋', name_en: 'Sui', start_year: 581, end_year: 618, era_group: '隋唐', color: G.隋唐, certainty: 'certain' },
  { slug: 'tang', name: '唐', name_en: 'Tang', start_year: 618, end_year: 907, era_group: '隋唐', color: G.隋唐, certainty: 'certain' },
  { slug: 'five-dynasties', name: '五代十国', name_en: 'Five Dynasties', start_year: 907, end_year: 960, era_group: '隋唐', color: G.隋唐, certainty: 'certain' },
  { slug: 'northern-song', name: '北宋', name_en: 'Northern Song', start_year: 960, end_year: 1127, era_group: '宋元', color: G.宋元, certainty: 'certain' },
  { slug: 'southern-song', name: '南宋', name_en: 'Southern Song', start_year: 1127, end_year: 1279, era_group: '宋元', color: G.宋元, certainty: 'certain' },
  { slug: 'liao', name: '辽', name_en: 'Liao', start_year: 916, end_year: 1125, era_group: '宋元', color: G.宋元, certainty: 'certain', note: '与北宋并立' },
  { slug: 'jin-dynasty', name: '金', name_en: 'Jin', start_year: 1115, end_year: 1234, era_group: '宋元', color: G.宋元, certainty: 'certain', note: '与南宋并立' },
  { slug: 'yuan', name: '元', name_en: 'Yuan', start_year: 1271, end_year: 1368, era_group: '宋元', color: G.宋元, certainty: 'certain' },
  { slug: 'ming', name: '明', name_en: 'Ming', start_year: 1368, end_year: 1644, era_group: '明清', color: G.明清, certainty: 'certain' },
  { slug: 'qing', name: '清', name_en: 'Qing', start_year: 1644, end_year: 1912, era_group: '明清', color: G.明清, certainty: 'certain' },
  { slug: 'roc', name: '中华民国', name_en: 'Republic of China', start_year: 1912, end_year: 1949, era_group: '近现代', color: G.近现代, certainty: 'certain', note: '此处指 1912–1949 大陆时期' },
  { slug: 'prc', name: '中华人民共和国', name_en: "People's Republic of China", start_year: 1949, end_year: 2025, era_group: '近现代', color: G.近现代, certainty: 'certain', note: 'end_year 为数据快照年份' },
]

export default { dynasties }
