const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildMeasureSessionPayload,
  resolveQuotaSource
} = require('../utils/measure_log.js')

const sampleResults = [
  { timestamp: 1000, totalPd: 63.1, leftPd: 31.2, rightPd: 31.9, confidence: '高' },
  { timestamp: 2000, totalPd: 63.4, leftPd: 31.5, rightPd: 31.9, confidence: '中' },
  { timestamp: 3000, totalPd: 63.2, leftPd: 31.3, rightPd: 31.9, confidence: '高' }
]

test('builds one measurement session payload from three accepted shots', () => {
  const payload = buildMeasureSessionPayload({
    results: sampleResults,
    mode: 'precision',
    quotaSource: 'paid',
    forcePurchase: false
  })

  assert.equal(payload.sessionId, '1000-3000')
  assert.equal(payload.mode, 'precision')
  assert.equal(payload.totalShots, 3)
  assert.equal(payload.resultTimestamp, 3000)
  assert.equal(payload.finalConfidence, '高')
  assert.deepEqual(payload.confidenceCounts, { high: 2, mid: 1, low: 0, unknown: 0 })
  assert.deepEqual(payload.pd, {
    totalPd: 63.2,
    leftPd: 31.3,
    rightPd: 31.9,
    nearTotalPd: null,
    nearLeftPd: null,
    nearRightPd: null
  })
})

test('marks forced purchase measurement source separately from free quota', () => {
  const payload = buildMeasureSessionPayload({
    results: sampleResults,
    mode: 'normal',
    quotaSource: 'free_quota',
    forcePurchase: true
  })

  assert.equal(payload.quotaSource, 'forced_purchase')
})

test('resolves quota source from the active entitlement state', () => {
  assert.equal(resolveQuotaSource({ status: 'unlimited' }, { isUnlimited: true }), 'annual')
  assert.equal(resolveQuotaSource({ status: 'single_used', retestCredits: 1 }, {}), 'free_quota')
  assert.equal(resolveQuotaSource({ status: 'single', remainCount: 1 }, {}), 'paid')
  assert.equal(resolveQuotaSource({ status: 'none', remainCount: 0 }, {}), 'trial')
  assert.equal(resolveQuotaSource({ status: 'single', remainCount: 1 }, { forcePurchase: true }), 'forced_purchase')
})
