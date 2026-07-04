function cleanString(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength || 80)
}

function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeMode(mode) {
  return mode === 'precision' ? 'precision' : 'normal'
}

function normalizeQuotaSource(source) {
  if (['trial', 'free_quota', 'paid', 'annual', 'forced_purchase'].indexOf(source) !== -1) {
    return source
  }
  return 'unknown'
}

function normalizeConfidence(confidence) {
  if (confidence === '高' || confidence === '中' || confidence === '低') return confidence
  return ''
}

function normalizeConfidenceCounts(counts) {
  const data = counts || {}
  return {
    high: Math.max(0, Number(data.high || 0)),
    mid: Math.max(0, Number(data.mid || 0)),
    low: Math.max(0, Number(data.low || 0)),
    unknown: Math.max(0, Number(data.unknown || 0))
  }
}

function normalizePd(pd) {
  const data = pd || {}
  return {
    totalPd: toNumber(data.totalPd),
    leftPd: toNumber(data.leftPd),
    rightPd: toNumber(data.rightPd),
    nearTotalPd: toNumber(data.nearTotalPd),
    nearLeftPd: toNumber(data.nearLeftPd),
    nearRightPd: toNumber(data.nearRightPd)
  }
}

function throwCode(code) {
  const err = new Error(code)
  err.code = code
  throw err
}

function normalizeMeasureEvent({ event, openid, now }) {
  if (!openid) throwCode('NO_OPENID')
  const data = event || {}
  const sessionId = cleanString(data.sessionId, 80)
  if (!sessionId) throwCode('NO_SESSION_ID')

  return {
    openid,
    sessionId,
    mode: normalizeMode(data.mode),
    quotaSource: normalizeQuotaSource(data.quotaSource),
    forcePurchase: !!data.forcePurchase,
    totalShots: Math.max(0, Number(data.totalShots || 0)),
    resultTimestamp: toNumber(data.resultTimestamp),
    finalConfidence: normalizeConfidence(data.finalConfidence),
    confidenceCounts: normalizeConfidenceCounts(data.confidenceCounts),
    pd: normalizePd(data.pd),
    createTimeMs: Number(now || Date.now()),
    updateTimeMs: Number(now || Date.now())
  }
}

module.exports = {
  normalizeMeasureEvent
}
