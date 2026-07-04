// 结果页统计逻辑：3 张取中位数、波动点阵、可信度判级
// 纯函数，从 pages/result/result.js 抽出以便 Node 测试覆盖（用户付费买的就是这套数值）

const { isNumber, roundToHalf } = require('./pd.js')

const MEASURE_TARGET_COUNT = 3
const STABLE_TOTAL_SPREAD_MM = 2
const USABLE_TOTAL_SPREAD_MM = 4
const TYPICAL_TOTAL_PD_MIN_MM = 56
const TYPICAL_TOTAL_PD_MAX_MM = 68
const EDGE_TOTAL_PD_MIN_MM = 54
const EDGE_TOTAL_PD_MAX_MM = 70
const PLAUSIBLE_TOTAL_PD_MIN_MM = 50
const PLAUSIBLE_TOTAL_PD_MAX_MM = 75

// 持久化到记录里的字段（个人中心历史用）
const resultRecordFields = (item) => ({
  totalPd: item.totalPd,
  leftPd: item.leftPd,
  rightPd: item.rightPd,
  nearTotalPd: item.nearTotalPd,
  nearLeftPd: item.nearLeftPd,
  nearRightPd: item.nearRightPd,
  pdBasis: item.pdBasis,
  faceWidth: item.faceWidth,
  confidence: item.confidence,
  timestamp: item.timestamp
})

const median = (values) => {
  const list = values.filter(isNumber).slice().sort((a, b) => a - b)
  if (!list.length) return null
  const mid = Math.floor(list.length / 2)
  if (list.length % 2 === 1) {
    return list[mid]
  }
  return roundToHalf((list[mid - 1] + list[mid]) / 2)
}

const numericResults = (results) => (results || []).filter((item) => item
  && isNumber(item.totalPd)
  && isNumber(item.leftPd)
  && isNumber(item.rightPd))

// 三张总瞳距 → 波动点阵图数据。把每张的总 PD 映射到 10%~90% 轨道位置，标出中位数那张。
const buildSpreadDots = (results, medianTotal) => {
  const vals = numericResults(results).map((r) => r.totalPd)
  if (vals.length < 2) return { dots: [], maxDiff: 0 }
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const range = max - min
  // 离中位数最近的那张标为高亮（只标一张）
  let hiIdx = -1
  if (isNumber(medianTotal)) {
    let best = Infinity
    vals.forEach((v, i) => {
      const d = Math.abs(v - medianTotal)
      if (d < best) { best = d; hiIdx = i }
    })
  }
  const dots = vals.map((v, i) => ({
    id: i,
    pd: v,
    left: range === 0 ? 50 : Math.round(10 + ((v - min) / range) * 80),
    hi: i === hiIdx
  }))
  return { dots, maxDiff: roundToHalf(range) }
}

const spread = (values) => {
  const list = values.filter(isNumber)
  if (list.length < 2) return 0
  return roundToHalf(Math.max(...list) - Math.min(...list))
}

const confidenceRank = { '低': 0, '中': 1, '高': 2 }

const capConfidence = (confidence, cap) => (
  confidenceRank[confidence] <= confidenceRank[cap] ? confidence : cap
)

const buildPdPlausibility = (totalPd) => {
  if (!isNumber(totalPd)) {
    return { level: 'unknown', confidenceCap: '低', warning: '未能得到有效总瞳距，建议重新测量。' }
  }
  if (totalPd < PLAUSIBLE_TOTAL_PD_MIN_MM || totalPd > PLAUSIBLE_TOTAL_PD_MAX_MM) {
    return {
      level: totalPd > PLAUSIBLE_TOTAL_PD_MAX_MM ? '偏大异常' : '偏小异常',
      confidenceCap: '低',
      warning: `总瞳距 ${totalPd}mm 明显${totalPd > PLAUSIBLE_TOTAL_PD_MAX_MM ? '偏大' : '偏小'}，请重新拍 3 张确认，配镜仍以线下验光为准。`
    }
  }
  if (totalPd < EDGE_TOTAL_PD_MIN_MM || totalPd > EDGE_TOTAL_PD_MAX_MM) {
    return {
      level: totalPd > EDGE_TOTAL_PD_MAX_MM ? '偏大异常' : '偏小异常',
      confidenceCap: '低',
      warning: `总瞳距 ${totalPd}mm 明显${totalPd > EDGE_TOTAL_PD_MAX_MM ? '偏大' : '偏小'}，建议重新拍 3 张；如仍偏离常见范围，请以线下验光为准。`
    }
  }
  if (totalPd < TYPICAL_TOTAL_PD_MIN_MM || totalPd > TYPICAL_TOTAL_PD_MAX_MM) {
    return {
      level: totalPd > TYPICAL_TOTAL_PD_MAX_MM ? '偏大' : '偏小',
      confidenceCap: '中',
      warning: `总瞳距 ${totalPd}mm ${totalPd > TYPICAL_TOTAL_PD_MAX_MM ? '偏大' : '偏小'}，处于成人常见边缘区间，建议再测一次或以线下验光为准。`
    }
  }
  return { level: '常见', confidenceCap: null, warning: '' }
}

const buildMedianResult = (results) => {
  const usable = numericResults(results)
  if (usable.length < MEASURE_TARGET_COUNT) return null
  const preferred = usable.filter((item) => item.confidence !== '低')
  const used = preferred.length >= MEASURE_TARGET_COUNT ? preferred : usable
  const left = median(used.map(r => r.leftPd))
  const right = median(used.map(r => r.rightPd))
  const total = isNumber(left) && isNumber(right)
    ? roundToHalf(left + right)
    : median(used.map(r => r.totalPd))
  const faceWidth = median(used.map(r => r.faceWidth))
  const nearTotalPd = median(used.map(r => r.nearTotalPd))
  const nearLeftPd = median(used.map(r => r.nearLeftPd))
  const nearRightPd = median(used.map(r => r.nearRightPd))
  const totalSpread = spread(used.map(r => r.totalPd))
  const leftSpread = spread(used.map(r => r.leftPd))
  const rightSpread = spread(used.map(r => r.rightPd))
  let consistency = '稳定'
  if (totalSpread > USABLE_TOTAL_SPREAD_MM) {
    consistency = '波动大'
  } else if (totalSpread > STABLE_TOTAL_SPREAD_MM || leftSpread > STABLE_TOTAL_SPREAD_MM || rightSpread > STABLE_TOTAL_SPREAD_MM) {
    consistency = '一般'
  }
  const consistencyConfidence = consistency === '稳定' ? '高' : (consistency === '一般' ? '中' : '低')
  const plausibility = buildPdPlausibility(total)
  const confidence = plausibility.confidenceCap
    ? capConfidence(consistencyConfidence, plausibility.confidenceCap)
    : consistencyConfidence
  const warnings = []
  if (consistency === '波动大') {
    warnings.push(`三张结果最大相差 ${totalSpread}mm，建议按同一姿势重新测量一次（再拍 3 张）`)
  } else if (consistency === '一般') {
    warnings.push(`三次结果最大相差 ${totalSpread}mm，建议再测一次确认`)
  }
  if (plausibility.warning) warnings.push(plausibility.warning)
  return {
    totalPd: total,
    leftPd: left,
    rightPd: right,
    nearTotalPd,
    nearLeftPd,
    nearRightPd,
    pdBasis: used.some(r => r.pdBasis === 'far') ? 'far' : (used[0] && used[0].pdBasis),
    faceWidth,
    confidence,
    usedCount: used.length,
    totalCount: usable.length,
    totalSpread,
    leftSpread,
    rightSpread,
    consistency,
    pdPlausibility: plausibility.level,
    warning: warnings.join('；')
  }
}

module.exports = {
  MEASURE_TARGET_COUNT,
  resultRecordFields,
  buildSpreadDots,
  buildMedianResult
}
