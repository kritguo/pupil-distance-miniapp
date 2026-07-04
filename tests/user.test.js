const test = require('node:test')
const assert = require('node:assert/strict')

const USER_KEY = 'pd_user_info'

const loadUserUtil = (initialInfo) => {
  const storage = {}
  if (initialInfo) storage[USER_KEY] = initialInfo
  global.wx = {
    getStorageSync: (key) => storage[key],
    setStorageSync: (key, value) => { storage[key] = value }
  }
  delete require.cache[require.resolve('../utils/user.js')]
  return require('../utils/user.js')
}

test('treats free precision retest credits as measurement quota', () => {
  const userUtil = loadUserUtil({
    status: 'single_used',
    remainCount: 0,
    retestCredits: 1,
    annualExpireAt: 0
  })

  assert.equal(userUtil.canMeasureFree(), true)
  assert.equal(userUtil.shouldShowPayTip(), false)
  assert.equal(userUtil.getStatusText(), '免费精度复测 1 次')
})
