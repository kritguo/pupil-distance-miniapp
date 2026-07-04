const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildMeasureUrl,
  resolveClientPlatform
} = require('../utils/measure_entry.js')

test('resolves client platform from system info for ios/android branching', () => {
  assert.equal(resolveClientPlatform({ platform: 'iOS' }), 'ios')
  assert.equal(resolveClientPlatform({ platform: 'ios' }), 'ios')
  assert.equal(resolveClientPlatform({ platform: 'android' }), 'android')
  assert.equal(resolveClientPlatform({ platform: 'devtools' }), 'other')
  assert.equal(resolveClientPlatform({}), 'other')
})

test('builds measure urls for explicit precision retest and normal purchase', () => {
  assert.equal(buildMeasureUrl({ mode: 'precision' }), '/pages/measure/measure?mode=precision')
  assert.equal(
    buildMeasureUrl({ mode: 'normal', forcePurchase: true }),
    '/pages/measure/measure?mode=normal&forcePurchase=1'
  )
})
