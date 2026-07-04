const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildShotAcceptedNotice,
  buildResultHandlingErrorMessage,
  buildPrecisionRetakeNotice
} = require('../utils/measure_feedback.js')

test('builds an explicit in-page prompt after an accepted shot', () => {
  assert.equal(buildShotAcceptedNotice(1, 3), '已拍 1/3，请继续拍下一张')
  assert.equal(buildShotAcceptedNotice(2, 3), '已拍 2/3，请继续拍下一张')
})

test('builds a friendly fallback when cloud result handling crashes', () => {
  assert.match(buildResultHandlingErrorMessage(), /识别结果处理失败/)
  assert.match(buildResultHandlingErrorMessage(), /重新拍摄/)
})

test('builds concise in-page precision retake guidance', () => {
  assert.match(buildPrecisionRetakeNotice('精确模式需要识别到卡片', 1), /完整卡片/)
  assert.match(buildPrecisionRetakeNotice('卡片边缘不够清晰', 1), /避开反光/)
  assert.match(buildPrecisionRetakeNotice('卡片校验与虹膜结果相差 4.5mm', 1), /与脸平行/)
  assert.match(buildPrecisionRetakeNotice('精确模式需要识别到卡片', 3), /换亮一点/)
})
