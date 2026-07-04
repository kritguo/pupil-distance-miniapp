const test = require('node:test')
const assert = require('node:assert/strict')
const stats = require('../utils/result_stats.js')

const shot = (totalPd, leftPd, rightPd, extra) => ({
  totalPd,
  leftPd,
  rightPd,
  nearTotalPd: null,
  nearLeftPd: null,
  nearRightPd: null,
  pdBasis: 'far',
  faceWidth: null,
  confidence: '高',
  timestamp: 1,
  ...extra
})

test('buildMedianResult: stable 3-shot session yields 高 confidence median', () => {
  const out = stats.buildMedianResult([
    shot(62, 31, 31),
    shot(63, 31.5, 31.5),
    shot(64, 32, 32)
  ])
  assert.equal(out.leftPd, 31.5)
  assert.equal(out.rightPd, 31.5)
  assert.equal(out.totalPd, 63)        // 左+右 取半舍入
  assert.equal(out.totalSpread, 2)
  assert.equal(out.consistency, '稳定')
  assert.equal(out.confidence, '高')
  assert.equal(out.warning, '')
  assert.equal(out.pdBasis, 'far')
  assert.equal(out.usedCount, 3)
})

test('buildMedianResult: spread in (2,4] downgrades to 一般/中 with retest hint', () => {
  const out = stats.buildMedianResult([
    shot(60, 30, 30),
    shot(62, 31, 31),
    shot(63, 31.5, 31.5)
  ])
  assert.equal(out.consistency, '一般')
  assert.equal(out.confidence, '中')
  assert.match(out.warning, /建议再测一次确认/)
})

test('buildMedianResult: stable but unusually large adult PD is capped at 低', () => {
  const out = stats.buildMedianResult([
    shot(70.5, 35, 35.5),
    shot(71.5, 35.5, 36),
    shot(71.5, 35.5, 36)
  ])
  assert.equal(out.totalPd, 71.5)
  assert.equal(out.totalSpread, 1)
  assert.equal(out.consistency, '稳定')
  assert.equal(out.pdPlausibility, '偏大异常')
  assert.equal(out.confidence, '低')
  assert.match(out.warning, /偏大/)
  assert.match(out.warning, /重新拍 3 张/)
})

test('buildMedianResult: adult PD edge range is capped at 中', () => {
  const out = stats.buildMedianResult([
    shot(68.5, 34, 34.5),
    shot(69, 34.5, 34.5),
    shot(69.5, 34.5, 35)
  ])
  assert.equal(out.totalPd, 69)
  assert.equal(out.consistency, '稳定')
  assert.equal(out.pdPlausibility, '偏大')
  assert.equal(out.confidence, '中')
  assert.match(out.warning, /边缘区间/)
})

test('buildMedianResult: spread > 4 means 波动大/低 and a redo warning', () => {
  const out = stats.buildMedianResult([
    shot(60, 30, 30),
    shot(63, 31.5, 31.5),
    shot(65, 32.5, 32.5)
  ])
  assert.equal(out.consistency, '波动大')
  assert.equal(out.confidence, '低')
  assert.match(out.warning, /相差 5mm/)
})

test('buildMedianResult: needs at least 3 numeric results', () => {
  assert.equal(stats.buildMedianResult([shot(62, 31, 31), shot(63, 31.5, 31.5)]), null)
  assert.equal(stats.buildMedianResult([]), null)
  assert.equal(stats.buildMedianResult(null), null)
})

test('buildMedianResult: 低 shots are excluded only when 3+ better shots exist', () => {
  // 恰好 3 张且含一张「低」：preferred 不足 3，全部使用
  const withLow = stats.buildMedianResult([
    shot(62, 31, 31),
    shot(63, 31.5, 31.5),
    shot(70, 35, 35, { confidence: '低' })
  ])
  assert.equal(withLow.usedCount, 3)
  // 4 张含一张「低」：排除后仍有 3 张，优先用非低
  const fourShots = stats.buildMedianResult([
    shot(62, 31, 31),
    shot(63, 31.5, 31.5),
    shot(64, 32, 32),
    shot(70, 35, 35, { confidence: '低' })
  ])
  assert.equal(fourShots.usedCount, 3)
  assert.equal(fourShots.totalSpread, 2)
})

test('buildSpreadDots maps shots onto a 10%-90% track and highlights the median shot', () => {
  const { dots, maxDiff } = stats.buildSpreadDots(
    [shot(62, 31, 31), shot(63, 31.5, 31.5), shot(64, 32, 32)],
    63
  )
  assert.equal(maxDiff, 2)
  assert.deepEqual(dots.map((d) => d.left), [10, 50, 90])
  assert.deepEqual(dots.map((d) => d.hi), [false, true, false])
})

test('buildSpreadDots: fewer than 2 shots or zero range degrade gracefully', () => {
  assert.deepEqual(stats.buildSpreadDots([shot(62, 31, 31)], 62), { dots: [], maxDiff: 0 })
  const flat = stats.buildSpreadDots([shot(62, 31, 31), shot(62, 31, 31)], 62)
  assert.deepEqual(flat.dots.map((d) => d.left), [50, 50])
  assert.equal(flat.maxDiff, 0)
})

test('resultRecordFields keeps only persisted record fields', () => {
  const fields = stats.resultRecordFields({
    ...shot(63, 31.5, 31.5),
    source: 'cloud_auto',
    measureMode: 'normal'
  })
  assert.deepEqual(Object.keys(fields).sort(), [
    'confidence', 'faceWidth', 'leftPd', 'nearLeftPd', 'nearRightPd',
    'nearTotalPd', 'pdBasis', 'rightPd', 'timestamp', 'totalPd'
  ])
})

test('MEASURE_TARGET_COUNT stays 3 (一次测量 = 拍 3 张取中位数)', () => {
  assert.equal(stats.MEASURE_TARGET_COUNT, 3)
})
