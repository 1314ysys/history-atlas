// 历史疆域示意切片：仅表意，非学术精度。坐标 [经度, 纬度]，环首尾闭合。
export const boundaries = [
  {
    year: -1000,
    name: '西周疆域（示意）',
    note: '示意边界，非学术精度：宗周与成周为中心，诸侯封国散布于黄河中下游',
    geojson: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: '西周' },
          geometry: { type: 'Polygon', coordinates: [[[106, 34], [108, 40], [118, 41], [122, 38], [121, 33], [117, 30], [110, 31], [105, 33], [106, 34]]] },
        },
      ],
    },
  },
  {
    year: -221,
    name: '秦代疆域（示意）',
    note: '示意边界，非学术精度：北至阴山、南抵岭南、东临海',
    geojson: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: '秦' },
          geometry: { type: 'Polygon', coordinates: [[[106, 35], [110, 40], [118, 40], [122, 32], [118, 25], [110, 22], [103, 28], [106, 35]]] },
        },
      ],
    },
  },
  {
    year: 100,
    name: '东汉疆域（示意）',
    note: '示意边界，非学术精度：含河西走廊与西域都护府，南至交趾',
    geojson: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: '汉' },
          geometry: { type: 'Polygon', coordinates: [[[100, 40], [110, 42], [120, 42], [125, 40], [122, 32], [120, 25], [110, 22], [105, 23], [100, 28], [97, 35], [95, 40], [100, 40]]] },
        },
        {
          type: 'Feature',
          properties: { name: '西域都护府（示意）' },
          geometry: { type: 'Polygon', coordinates: [[[74, 39], [82, 44], [90, 45], [95, 41], [88, 37], [80, 36], [74, 38], [74, 39]]] },
        },
      ],
    },
  },
  {
    year: 750,
    name: '唐代疆域（示意）',
    note: '示意边界，非学术精度：天宝年间，含安西四镇与安东都护府方向',
    geojson: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: '唐' },
          geometry: { type: 'Polygon', coordinates: [[[80, 38], [92, 47], [105, 48], [118, 48], [125, 45], [122, 38], [120, 30], [110, 22], [103, 23], [98, 30], [92, 35], [80, 38]]] },
        },
        {
          type: 'Feature',
          properties: { name: '安西四镇（示意）' },
          geometry: { type: 'Polygon', coordinates: [[[70, 40], [80, 44], [88, 45], [92, 42], [86, 37], [78, 36], [70, 38], [70, 40]]] },
        },
      ],
    },
  },
  {
    year: 1300,
    name: '元代疆域（示意）',
    note: '示意边界，非学术精度：元朝本部与岭北行省方向，不含诸汗国实际控制区',
    geojson: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: '元' },
          geometry: { type: 'Polygon', coordinates: [[[70, 45], [85, 52], [100, 53], [120, 52], [130, 48], [130, 40], [122, 32], [118, 25], [110, 20], [100, 22], [92, 28], [85, 35], [78, 38], [70, 42], [70, 45]]] },
        },
      ],
    },
  },
  {
    year: 1600,
    name: '明代疆域（示意）',
    note: '示意边界，非学术精度：两京十三省并辽东都司，未含羁縻诸卫',
    geojson: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: '明' },
          geometry: { type: 'Polygon', coordinates: [[[97, 40], [105, 42], [112, 42], [120, 42], [124, 40], [122, 32], [120, 25], [110, 21], [104, 23], [100, 28], [97, 35], [97, 40]]] },
        },
      ],
    },
  },
  {
    year: 1800,
    name: '清代疆域（示意）',
    note: '示意边界，非学术精度：嘉庆年间版图，含蒙古、新疆与西藏方向',
    geojson: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: '清' },
          geometry: { type: 'Polygon', coordinates: [[[70, 40], [80, 48], [90, 50], [105, 50], [120, 53], [130, 50], [130, 42], [122, 32], [120, 25], [110, 20], [100, 22], [92, 28], [85, 33], [78, 36], [70, 38], [70, 40]]] },
        },
      ],
    },
  },
]
