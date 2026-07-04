const test = require('node:test')
const assert = require('node:assert/strict')

const {
  CAMERA_PHOTO_QUALITY,
  CLOUD_UPLOAD_IMAGE_QUALITY,
  MEASURE_NETWORK_TIMEOUT_MS,
  MEASURE_REQUEST_TIMEOUT_MS,
  buildMeasureStageTimeoutMessage,
  buildMeasureTimeoutMessage,
  createMeasureRequestToken,
  getMeasureStageTimeoutMs,
  getMeasureStageTitle,
  isActiveMeasureRequest,
  isRetryableMeasureTimeout,
  normalizeUploadImageQuality
} = require('../utils/measure_request.js')

test('limits a stuck measurement request with a user-facing timeout', () => {
  assert.equal(MEASURE_REQUEST_TIMEOUT_MS, 50000)
  assert.equal(MEASURE_NETWORK_TIMEOUT_MS, 22000)
  assert.match(buildMeasureTimeoutMessage(), /50秒未返回/)
})

test('retries cloud measurement timeout only once', () => {
  assert.equal(isRetryableMeasureTimeout('callContainer:fail timeout', 0), true)
  assert.equal(isRetryableMeasureTimeout('callContainer:fail timeout', 1), false)
  assert.equal(isRetryableMeasureTimeout('分析失败', 0), false)
})

test('ignores stale callbacks after a newer measurement token starts', () => {
  const first = createMeasureRequestToken(0, 1000)
  const second = createMeasureRequestToken(first, 1001)
  assert.equal(isActiveMeasureRequest(second, first), false)
  assert.equal(isActiveMeasureRequest(second, second), true)
})

test('uses normal photo quality and explicit loading stage titles', () => {
  assert.equal(CAMERA_PHOTO_QUALITY, 'normal')
  assert.equal(CLOUD_UPLOAD_IMAGE_QUALITY, 76)
  assert.equal(normalizeUploadImageQuality(90), 76)
  assert.equal(normalizeUploadImageQuality(40), 55)
  assert.equal(normalizeUploadImageQuality(undefined), 76)
  assert.equal(getMeasureStageTitle('compress'), '处理照片...')
  assert.equal(getMeasureStageTitle('upload'), '正在分析，请稍候')
  assert.equal(getMeasureStageTitle('recognize'), '正在分析，请稍候')
  assert.equal(getMeasureStageTitle('retry'), '正在分析，请稍候')
})

test('sets independent timeouts for every measurement stage', () => {
  assert.equal(getMeasureStageTimeoutMs('compress'), 8000)
  assert.equal(getMeasureStageTimeoutMs('upload'), 14000)
  assert.equal(getMeasureStageTimeoutMs('recognize'), 26000)
  assert.match(buildMeasureStageTimeoutMessage('upload'), /分析超时/)
  assert.match(buildMeasureStageTimeoutMessage('upload'), /14秒未返回/)
})
