const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeMeasureEvent
} = require('../cloudfunctions/logMeasureEvent/helpers.js')

test('normalizes measurement event before writing to database', () => {
  const doc = normalizeMeasureEvent({
    event: {
      sessionId: '1000-3000',
      mode: 'precision',
      quotaSource: 'paid',
      totalShots: 3,
      resultTimestamp: 3000,
      finalConfidence: '高',
      confidenceCounts: { high: 2, mid: 1, low: 0, unknown: 0 },
      pd: { totalPd: 63.2, leftPd: 31.3, rightPd: 31.9 },
      forcePurchase: false
    },
    openid: 'openid-a',
    now: 1717200000000
  })

  assert.equal(doc.sessionId, '1000-3000')
  assert.equal(doc.openid, 'openid-a')
  assert.equal(doc.mode, 'precision')
  assert.equal(doc.quotaSource, 'paid')
  assert.equal(doc.totalShots, 3)
  assert.equal(doc.resultTimestamp, 3000)
  assert.equal(doc.finalConfidence, '高')
  assert.equal(doc.pd.totalPd, 63.2)
  assert.equal(doc.createTimeMs, 1717200000000)
})

test('rejects events without openid or session id', () => {
  assert.throws(
    () => normalizeMeasureEvent({ event: { sessionId: 's1' }, openid: '', now: 1 }),
    /NO_OPENID/
  )
  assert.throws(
    () => normalizeMeasureEvent({ event: {}, openid: 'openid-a', now: 1 }),
    /NO_SESSION_ID/
  )
})
