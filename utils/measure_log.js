function normalizeMode(mode) {
  return mode === 'precision' ? 'precision' : 'normal'
}

function normalizeQuotaSource(source, forcePurchase) {
  if (forcePurchase) return 'forced_purchase'
  if (['trial', 'free_quota', 'paid', 'annual'].indexOf(source) !== -1) return source
  return 'unknown'
}

function resolveQuotaSource(userInfo, options) {
  const info = userInfo || {}
  const opts = options || {}
  if (opts.forcePurchase) return 'forced_purchase'
  if (opts.isUnlimited || info.status === 'unlimited') return 'annual'
  if ((info.retestCredits || 0) > 0) return 'free_quota'
  if (info.status === 'single' && (info.remainCount || 0) > 0) return 'paid'
  return 'trial'
}

function countConfidence(results) {
  const counts = { high: 0, mid: 0, low: 0, unknown: 0 }
  results.forEach((item) => {
    if (item.confidence === '高') counts.high += 1
    else if (item.confidence === '中') counts.mid += 1
    else if (item.confidence === '低') counts.low += 1
    else counts.unknown += 1
  })
  return counts
}

function toNumberOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function buildMeasureSessionPayload(options) {
  const opts = options || {}
  const results = Array.isArray(opts.results) ? opts.results.filter(Boolean) : []
  if (!results.length) return null

  const first = results[0]
  const last = results[results.length - 1]
  const startTs = first.timestamp || Date.now()
  const endTs = last.timestamp || startTs

  return {
    sessionId: `${startTs}-${endTs}`,
    mode: normalizeMode(opts.mode),
    quotaSource: normalizeQuotaSource(opts.quotaSource, !!opts.forcePurchase),
    forcePurchase: !!opts.forcePurchase,
    totalShots: results.length,
    resultTimestamp: endTs,
    finalConfidence: last.confidence || '',
    confidenceCounts: countConfidence(results),
    pd: {
      totalPd: toNumberOrNull(last.totalPd),
      leftPd: toNumberOrNull(last.leftPd),
      rightPd: toNumberOrNull(last.rightPd),
      nearTotalPd: toNumberOrNull(last.nearTotalPd),
      nearLeftPd: toNumberOrNull(last.nearLeftPd),
      nearRightPd: toNumberOrNull(last.nearRightPd)
    }
  }
}

function logMeasureSession(payload) {
  if (!payload) return
  if (typeof wx === 'undefined' || !wx.cloud || typeof wx.cloud.callFunction !== 'function') {
    return
  }
  wx.cloud.callFunction({
    name: 'logMeasureEvent',
    data: payload,
    success: () => {},
    fail: (err) => console.warn('[measure_log] logMeasureEvent 失败:', err)
  })
}

module.exports = {
  buildMeasureSessionPayload,
  logMeasureSession,
  resolveQuotaSource,
  _test: {
    countConfidence,
    normalizeQuotaSource
  }
}
