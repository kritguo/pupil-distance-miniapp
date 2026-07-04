const test = require('node:test')
const assert = require('node:assert/strict')

const {
  getPrecisionCardGuideStyle,
  getModeIntroCopy,
  getPrecisionCardIssue,
  isPrecisionModeEnabled,
  isPrecisionRetestEnabled,
  normalizeMeasureMode,
  getMeasureModeCopy
} = require('../utils/measure_mode.js')

test('keeps upfront precision selector off while allowing explicit precision retest', () => {
  assert.equal(isPrecisionModeEnabled(), false)
  assert.equal(isPrecisionRetestEnabled(), true)
  assert.equal(normalizeMeasureMode('precision'), 'precision')
  assert.equal(normalizeMeasureMode('anything-else'), 'normal')
  assert.equal(getMeasureModeCopy('precision').label, '卡片精准测量')
})

test('normal capture copy does not claim an exact 50cm distance', () => {
  const copy = getMeasureModeCopy('normal')
  assert.doesNotMatch(copy.sub, /50\s*cm/i)
  assert.doesNotMatch(copy.help, /50\s*cm/i)
  assert.match(copy.sub, /约一臂距离/)
})

test('applies precision card cross-check for explicit precision retest', () => {
  assert.equal(getPrecisionCardIssue({ card_cross_check: { found: true, diff_mm: 2.5 } }, 'precision'), null)
  assert.match(getPrecisionCardIssue({ card_cross_check: { found: false } }, 'precision'), /需要识别到卡片/)
  assert.match(getPrecisionCardIssue({ card_cross_check: { found: true, diff_mm: 4.5 } }, 'precision'), /相差 4.5mm/)
  assert.equal(getPrecisionCardIssue({ card_cross_check: { found: false } }, 'normal'), null)
})

test('keeps dormant precision intro copy available for a future re-enable', () => {
  const copy = getModeIntroCopy()
  assert.equal(isPrecisionModeEnabled(), false)
  assert.equal(isPrecisionRetestEnabled(), true)
  assert.equal(copy.title, '选择测量方式')
  assert.match(copy.normal.desc, /无需卡片/)
  assert.match(copy.precision.desc, /身份证/)
  assert.match(copy.footer, /免费用精确模式再测一次/)
})

test('places the precision card guide higher and tighter over the forehead', () => {
  const style = getPrecisionCardGuideStyle()
  assert.match(style, /width: 300rpx/)
  assert.match(style, /height: 150rpx/)
  assert.match(style, /top: 28rpx/)
})
