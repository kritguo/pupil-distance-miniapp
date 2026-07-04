const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

function loadMeasurePage() {
  const pagePath = path.resolve(__dirname, '../pages/measure/measure.js')
  delete require.cache[pagePath]

  const originalPage = global.Page
  let pageConfig
  global.Page = (config) => {
    pageConfig = config
  }

  try {
    require(pagePath)
  } finally {
    global.Page = originalPage
    delete require.cache[pagePath]
  }

  return pageConfig
}

const USER_KEY = 'pd_user_info'

function buildResult(timestamp, mode = 'precision') {
  return {
    totalPd: 62,
    leftPd: 31,
    rightPd: 31,
    confidence: '高',
    timestamp,
    measureMode: mode
  }
}

test('accepted shot keeps an in-page guide until the next capture', () => {
  const pageConfig = loadMeasurePage()
  const ctx = {
    data: { ...pageConfig.data, totalShots: 3 },
    sessionResults: [],
    setData(patch) {
      Object.assign(this.data, patch)
    },
    showCaptureNotice: pageConfig.showCaptureNotice,
    finishSession() {
      throw new Error('finishSession should not run before three accepted shots')
    }
  }

  pageConfig.onMeasured.call(ctx, { totalPd: 62, leftPd: 31, rightPd: 31 })

  assert.equal(ctx.data.shotIndex, 1)
  assert.equal(ctx.data.detecting, false)
  assert.equal(ctx.data.captureNotice, '已拍 1/3，请继续拍下一张')
})

test('precision card issue stays as an in-page guide instead of a blocking modal', () => {
  const originalWx = global.wx
  let modalShown = false
  global.wx = {
    showModal() { modalShown = true }
  }

  try {
    const pageConfig = loadMeasurePage()
    const ctx = {
      data: { ...pageConfig.data, detecting: true, captureNotice: '' },
      shotFailCount: 0,
      setData(patch) {
        Object.assign(this.data, patch)
      }
    }

    pageConfig.handlePrecisionModeIssue.call(ctx, '精确模式需要识别到卡片。')

    assert.equal(modalShown, false)
    assert.equal(ctx.data.detecting, false)
    assert.match(ctx.data.captureNotice, /完整卡片/)
  } finally {
    global.wx = originalWx
  }
})

test('precision retest session replaces the previous paid batch before result page', () => {
  const originalWx = global.wx
  const storage = {
    [USER_KEY]: {
      status: 'single_used',
      remainCount: 0,
      retestCredits: 1,
      annualExpireAt: 0,
      records: [],
      singleBatch: { id: 'old', results: [buildResult(1, 'normal'), buildResult(2, 'normal'), buildResult(3, 'normal')] },
      trialBatch: { id: 'trial', results: [] },
      unlimitedSession: { id: 'annual', results: [] }
    }
  }
  let navigatedUrl = ''
  global.wx = {
    getStorageSync(key) { return storage[key] },
    setStorageSync(key, value) { storage[key] = value },
    navigateTo({ url }) { navigatedUrl = url }
  }

  try {
    const pageConfig = loadMeasurePage()
    const ctx = {
      data: { ...pageConfig.data, totalShots: 3, measureMode: 'precision' },
      sessionResults: [buildResult(101), buildResult(102), buildResult(103)],
      forcePurchase: false
    }

    pageConfig.finishSession.call(ctx)

    assert.deepEqual(storage[USER_KEY].singleBatch.results.map((item) => item.timestamp), [101, 102, 103])
    assert.equal(storage.latestResult.timestamp, 103)
    assert.equal(navigatedUrl, '/pages/result/result')
  } finally {
    global.wx = originalWx
  }
})

test('trial session replaces stale trial batch before paywall', () => {
  const originalWx = global.wx
  const storage = {
    [USER_KEY]: {
      status: 'none',
      remainCount: 0,
      retestCredits: 0,
      annualExpireAt: 0,
      records: [],
      singleBatch: { id: 'single', results: [] },
      trialBatch: { id: 'old-trial', results: [buildResult(1, 'normal'), buildResult(2, 'normal'), buildResult(3, 'normal')] },
      unlimitedSession: { id: 'annual', results: [] }
    }
  }
  let navigatedUrl = ''
  global.wx = {
    getStorageSync(key) { return storage[key] },
    setStorageSync(key, value) { storage[key] = value },
    navigateTo({ url }) { navigatedUrl = url }
  }

  try {
    const pageConfig = loadMeasurePage()
    const ctx = {
      data: { ...pageConfig.data, totalShots: 3, measureMode: 'normal' },
      sessionResults: [buildResult(201, 'normal'), buildResult(202, 'normal'), buildResult(203, 'normal')],
      forcePurchase: false
    }

    pageConfig.finishSession.call(ctx)

    assert.deepEqual(storage[USER_KEY].trialBatch.results.map((item) => item.timestamp), [201, 202, 203])
    assert.equal(storage.latestResult.timestamp, 203)
    assert.equal(navigatedUrl, '/pages/result/result?trial=1')
  } finally {
    global.wx = originalWx
  }
})
