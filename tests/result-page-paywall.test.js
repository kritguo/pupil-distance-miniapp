const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function loadResultPage() {
  const pagePath = path.resolve(__dirname, '../pages/result/result.js')
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

const readResultWxml = () => fs.readFileSync(path.resolve(__dirname, '../pages/result/result.wxml'), 'utf8')

test('default plan is single (¥9.9), matching the homepage price promise', () => {
  const pageConfig = loadResultPage()
  assert.equal(pageConfig.data.selectedPlan, 'single')
})

test('closePayModal really closes the modal without an interrogation dialog', () => {
  const pageConfig = loadResultPage()
  const originalWx = global.wx
  let modalShown = false
  global.wx = {
    showModal() { modalShown = true }
  }

  try {
    let patch = null
    const ctx = {
      ...pageConfig,
      data: { showPayModal: true },
      setData(next) { patch = next }
    }
    pageConfig.closePayModal.call(ctx)
    assert.equal(patch.showPayModal, false)
    assert.equal(modalShown, false)
  } finally {
    global.wx = originalWx
  }
})

test('openPayModal reopens the pay modal from the unlock bar', () => {
  const pageConfig = loadResultPage()
  let patch = null
  const ctx = {
    ...pageConfig,
    data: { showPayModal: false },
    setData(next) { patch = next }
  }
  pageConfig.openPayModal.call(ctx)
  assert.equal(patch.showPayModal, true)
})

test('confidence and spread chart are visible before payment (trust evidence)', () => {
  const wxml = readResultWxml()
  // 可信度不打码：不再有 isPaid 三元
  assert.doesNotMatch(wxml, /isPaid \? displayResult\.confidence/)
  assert.match(wxml, />\{\{displayResult\.confidence\}\}<\/text>/)
  // 波动点阵不再被 isPaid 门控（但点上的 PD 数值仍只给已付费用户看）
  assert.match(wxml, /wx:if="\{\{spreadDots\.length > 1\}\}"/)
  assert.match(wxml, /class="spread-dot-label" wx:if="\{\{isPaid\}\}"/)
})

test('unpaid users get a persistent unlock bar and a teaser of locked content', () => {
  const wxml = readResultWxml()
  assert.match(wxml, /wx:if="\{\{!isPaid && !showPayModal && !empty\}\}"/)
  assert.match(wxml, /bindtap="openPayModal"/)
  assert.match(wxml, /解锁后还可查看/)
})

test('pay modal reassures with the measured confidence level', () => {
  const wxml = readResultWxml()
  assert.match(wxml, /已测出可信度「\{\{displayResult\.confidence\}\}」的结果/)
})

test('paid result invites precision retest instead of ordinary retake', () => {
  const wxml = readResultWxml()
  assert.match(wxml, /class="precision-invite/)
  assert.match(wxml, /bindtap="onPrecisionRetest"/)
  assert.match(wxml, /precisionInvite\.buttonText/)
  assert.match(wxml, /precisionInvite\.planLabel/)
  assert.doesNotMatch(wxml, /权益同步中/)
  assert.doesNotMatch(wxml, /会员不限次/)
  assert.doesNotMatch(wxml, /用普通模式再测一遍/)
  assert.match(wxml, /赠送一次精度复测权益/)
  assert.match(wxml, /精度复测不限次数/)
})

test('precision invite card renders one entitlement branch from dynamic fields only', () => {
  const wxml = readResultWxml()
  const inviteBlock = wxml.match(/<!-- 付费后统一邀请精度复测[\s\S]*?<\/view>\s*<\/view>/)
  assert.ok(inviteBlock, 'precision invite block should exist')
  const block = inviteBlock[0]

  assert.match(block, /precisionInvite\.title/)
  assert.match(block, /precisionInvite\.planLabel/)
  assert.match(block, /precisionInvite\.planType/)
  assert.match(block, /precisionInvite\.desc/)
  assert.match(block, /precisionInvite\.buttonText/)
  assert.doesNotMatch(block, /已含 1 次 App 精度复测/)
  assert.doesNotMatch(block, /可用 App 精度测量/)
  assert.doesNotMatch(block, /单次付费/)
  assert.doesNotMatch(block, /年度会员/)
  assert.doesNotMatch(block, /赠送一次精度复测权益/)
  assert.doesNotMatch(block, /精度复测不限次数/)
})

test('precision invite shows only the paid entitlement plan, not a two-plan choice', () => {
  const pageConfig = loadResultPage()

  const singleCtx = {
    ...pageConfig,
    data: {
      ...pageConfig.data,
      isPaid: true,
      isUnlimited: false,
      fromRecord: false,
      clientPlatform: 'ios',
      result: { timestamp: 31, measureMode: 'normal' },
      displayResult: { confidence: '高' }
    }
  }
  const singlePatch = pageConfig.buildPrecisionInvitePatch.call(singleCtx, singleCtx.data.displayResult)
  assert.equal(singlePatch.showPrecisionInvite, true)
  assert.equal(singlePatch.precisionInvite.planType, 'single')
  assert.equal(singlePatch.precisionInvite.planLabel, '更精准')
  assert.equal(singlePatch.precisionInvite.title, '用 App 深度相机再确认一次')
  assert.equal(singlePatch.precisionInvite.desc, 'PDgo App 用 iPhone 深度相机测量，比照片测量更精准。')
  assert.equal(singlePatch.precisionInvite.buttonText, '了解 App 深度测量')
  // unionid 权益桥建好前，iOS 邀请卡不得承诺免费或登录同步
  assert.doesNotMatch(singlePatch.precisionInvite.desc, /微信登录|自动同步|免费/)

  const weakCtx = {
    ...pageConfig,
    data: {
      ...pageConfig.data,
      isPaid: true,
      isUnlimited: false,
      fromRecord: false,
      clientPlatform: 'ios',
      result: { timestamp: 33, measureMode: 'normal' },
      displayResult: { confidence: '中' }
    }
  }
  const weakPatch = pageConfig.buildPrecisionInvitePatch.call(weakCtx, weakCtx.data.displayResult)
  assert.equal(weakPatch.precisionInvite.title, '建议用 App 深度相机复测')
  assert.equal(weakPatch.precisionInvite.buttonText, '去用 App 深度测量')

  const annualCtx = {
    ...pageConfig,
    data: {
      ...pageConfig.data,
      isPaid: true,
      isUnlimited: true,
      fromRecord: false,
      clientPlatform: 'ios',
      result: { timestamp: 32, measureMode: 'normal' },
      displayResult: { confidence: '高' }
    }
  }
  const annualPatch = pageConfig.buildPrecisionInvitePatch.call(annualCtx, annualCtx.data.displayResult)
  assert.equal(annualPatch.showPrecisionInvite, true)
  assert.equal(annualPatch.precisionInvite.planType, 'annual')
  assert.equal(annualPatch.precisionInvite.planLabel, '会员')
  assert.equal(annualPatch.precisionInvite.title, '用 App 深度相机再确认一次')
  assert.equal(annualPatch.precisionInvite.buttonText, '了解 App 深度测量')
})

test('android precision invite stays in mini program card retest flow', () => {
  const pageConfig = loadResultPage()

  const singleCtx = {
    ...pageConfig,
    data: {
      ...pageConfig.data,
      isPaid: true,
      isUnlimited: false,
      fromRecord: false,
      clientPlatform: 'android',
      result: { timestamp: 41, measureMode: 'normal' },
      displayResult: { confidence: '中' }
    }
  }
  const singlePatch = pageConfig.buildPrecisionInvitePatch.call(singleCtx, singleCtx.data.displayResult)
  assert.equal(singlePatch.showPrecisionInvite, true)
  assert.equal(singlePatch.precisionInvite.target, 'precision_card')
  assert.equal(singlePatch.precisionInvite.planType, 'single')
  assert.equal(singlePatch.precisionInvite.planLabel, '免费复测 1 次')
  assert.equal(singlePatch.precisionInvite.title, '建议用卡片精准确认一次')
  assert.equal(singlePatch.precisionInvite.desc, '照片测量可能存在轻微误差。已为你保留 1 次免费复测，可用身份证或银行卡辅助校验，再确认一遍。')
  assert.equal(singlePatch.precisionInvite.buttonText, '免费用卡片复测')

  const annualCtx = {
    ...pageConfig,
    data: {
      ...pageConfig.data,
      isPaid: true,
      isUnlimited: true,
      fromRecord: false,
      clientPlatform: 'android',
      result: { timestamp: 42, measureMode: 'normal' },
      displayResult: { confidence: '高' }
    }
  }
  const annualPatch = pageConfig.buildPrecisionInvitePatch.call(annualCtx, annualCtx.data.displayResult)
  assert.equal(annualPatch.showPrecisionInvite, true)
  assert.equal(annualPatch.precisionInvite.target, 'precision_card')
  assert.equal(annualPatch.precisionInvite.planType, 'annual')
  assert.equal(annualPatch.precisionInvite.planLabel, '会员不限次')
  assert.equal(annualPatch.precisionInvite.title, '用卡片精准确认一次')
})

test('bottom retake action routes paid current results to precision retest', () => {
  const pageConfig = loadResultPage()
  let precisionCalled = false
  let normalCalled = false
  const ctx = {
    ...pageConfig,
    data: { isPaid: true, fromRecord: false },
    onPrecisionRetest() { precisionCalled = true },
    navigateToMeasure() { normalCalled = true }
  }
  pageConfig.onRetake.call(ctx)
  assert.equal(precisionCalled, true)
  assert.equal(normalCalled, false)
})

test('normal paid result gets a precision retest credit, precision high result does not', async () => {
  const pageConfig = loadResultPage()
  const pay = require('../utils/pay.js')
  const originalGrant = pay.grantRetest
  const calls = []
  pay.grantRetest = (resultKey, reason) => {
    calls.push({ resultKey, reason })
    return Promise.resolve({ ok: true, granted: true, retestCredits: 1 })
  }

  try {
    const normalCtx = {
      ...pageConfig,
      data: {
        isUnlimited: false,
        fromRecord: false,
        result: { timestamp: 11, measureMode: 'normal', confidence: '高' },
        displayResult: { confidence: '高' }
      },
      setData() {}
    }
    await pageConfig.maybeGrantRetest.call(normalCtx)
    assert.deepEqual(calls, [{ resultKey: 11, reason: 'precision_invite' }])

    const precisionCtx = {
      ...pageConfig,
      data: {
        isUnlimited: false,
        fromRecord: false,
        result: { timestamp: 12, measureMode: 'precision', confidence: '高' },
        displayResult: { confidence: '高', pdBasis: 'precision_far' }
      },
      setData() {}
    }
    await pageConfig.maybeGrantRetest.call(precisionCtx)
    assert.equal(calls.length, 1)
  } finally {
    pay.grantRetest = originalGrant
  }
})

test('credit-funded normal unlock does not re-gift a credit (no infinite free loop)', async () => {
  const pageConfig = loadResultPage()
  const pay = require('../utils/pay.js')
  const originalGrant = pay.grantRetest
  let grantCalls = 0
  pay.grantRetest = () => {
    grantCalls += 1
    return Promise.resolve({ ok: true, granted: true, retestCredits: 1 })
  }

  try {
    // 普通结果 + 本次解锁是用复测额度买的单 → 不再续送
    const creditFundedNormalCtx = {
      ...pageConfig,
      lastConsumeReason: 'retest_credit',
      data: {
        isUnlimited: false,
        fromRecord: false,
        result: { timestamp: 91, measureMode: 'normal' },
        displayResult: { confidence: '高' }
      },
      setData() {}
    }
    await pageConfig.maybeGrantRetest.call(creditFundedNormalCtx)
    assert.equal(grantCalls, 0)

    // 精度结果哪怕也是额度买的单，中/低仍继续送（直到高）
    const creditFundedPrecisionCtx = {
      ...pageConfig,
      lastConsumeReason: 'retest_credit',
      data: {
        isUnlimited: false,
        fromRecord: false,
        result: { timestamp: 92, measureMode: 'precision' },
        displayResult: { confidence: '中', pdBasis: 'precision_far' }
      },
      setData() {}
    }
    await pageConfig.maybeGrantRetest.call(creditFundedPrecisionCtx)
    assert.equal(grantCalls, 1)
  } finally {
    pay.grantRetest = originalGrant
  }
})

test('ios precision invite opens app download page directly without credit gate or modal', () => {
  const pageConfig = loadResultPage()
  const pay = require('../utils/pay.js')
  const originalGrant = pay.grantRetest
  const originalWx = global.wx
  let navigatedUrl = ''

  global.wx = {
    getStorageSync() { return {} },
    setStorageSync() {},
    navigateTo({ url }) { navigatedUrl = url },
    showModal() { throw new Error('ios invite must not block with a modal') }
  }
  pay.grantRetest = () => { throw new Error('ios invite must not touch retest credit') }

  try {
    const singleCtx = {
      ...pageConfig,
      data: {
        ...pageConfig.data,
        isUnlimited: false,
        result: { timestamp: 77 },
        precisionInvite: { target: 'ios_app' }
      },
      setData(patch) { Object.assign(this.data, patch) }
    }
    pageConfig.onPrecisionRetest.call(singleCtx)
    assert.equal(navigatedUrl, '/pages/app-download/app-download?plan=single&source=precision_retest')

    const annualCtx = {
      ...pageConfig,
      data: {
        ...pageConfig.data,
        isUnlimited: true,
        result: { timestamp: 78 },
        precisionInvite: { target: 'ios_app' }
      },
      setData(patch) { Object.assign(this.data, patch) }
    }
    pageConfig.onPrecisionRetest.call(annualCtx)
    assert.equal(navigatedUrl, '/pages/app-download/app-download?plan=annual&source=precision_retest')
  } finally {
    pay.grantRetest = originalGrant
    global.wx = originalWx
  }
})

test('ios annual precision invite opens app download page without requesting retest credit', () => {
  const pageConfig = loadResultPage()
  const pay = require('../utils/pay.js')
  const originalGrant = pay.grantRetest
  const originalWx = global.wx
  let navigatedUrl = ''
  let grantCalled = false

  global.wx = {
    navigateTo({ url }) { navigatedUrl = url }
  }
  pay.grantRetest = () => {
    grantCalled = true
    return Promise.resolve(null)
  }

  try {
    const ctx = {
      ...pageConfig,
      data: {
        ...pageConfig.data,
        isUnlimited: true,
        precisionInvite: { target: 'ios_app' }
      }
    }
    pageConfig.onPrecisionRetest.call(ctx)
    assert.equal(grantCalled, false)
    assert.equal(navigatedUrl, '/pages/app-download/app-download?plan=annual&source=precision_retest')
  } finally {
    pay.grantRetest = originalGrant
    global.wx = originalWx
  }
})

test('android single precision invite opens precision card mode, not app download page', async () => {
  const pageConfig = loadResultPage()
  const pay = require('../utils/pay.js')
  const originalGrant = pay.grantRetest
  const originalWx = global.wx
  let navigatedUrl = ''

  global.wx = {
    getStorageSync() {
      return { status: 'single_used', remainCount: 0, retestCredits: 0, annualExpireAt: 0 }
    },
    setStorageSync() {},
    navigateTo({ url }) { navigatedUrl = url },
    showModal() { throw new Error('should not show a modal before opening precision card mode') }
  }
  pay.grantRetest = (resultKey, reason) => {
    assert.equal(resultKey, 88)
    assert.equal(reason, 'precision_card')
    return Promise.resolve({ ok: true, granted: true, retestCredits: 1 })
  }

  try {
    const ctx = {
      ...pageConfig,
      data: {
        ...pageConfig.data,
        isUnlimited: false,
        result: { timestamp: 88 },
        freeRetestReady: false,
        retestRequesting: false,
        precisionInvite: { target: 'precision_card' }
      },
      setData(patch) { Object.assign(this.data, patch) }
    }
    await pageConfig.onPrecisionRetest.call(ctx)
    assert.equal(ctx.data.freeRetestReady, true)
    assert.equal(navigatedUrl, '/pages/measure/measure?mode=precision')
  } finally {
    pay.grantRetest = originalGrant
    global.wx = originalWx
  }
})

test('android precision invite enters camera immediately even when retest grant is still syncing', () => {
  const pageConfig = loadResultPage()
  const pay = require('../utils/pay.js')
  const originalGrant = pay.grantRetest
  const originalWx = global.wx
  let navigatedUrl = ''
  let modalShown = false
  let storedInfo = {
    status: 'single_used',
    remainCount: 0,
    retestCredits: 0,
    annualExpireAt: 0
  }

  global.wx = {
    getStorageSync(key) {
      if (key === 'pd_user_info') return storedInfo
      return null
    },
    setStorageSync(key, value) {
      if (key === 'pd_user_info') storedInfo = value
    },
    navigateTo({ url }) { navigatedUrl = url },
    showModal() { modalShown = true }
  }
  pay.grantRetest = () => Promise.resolve({ ok: false, code: 'SYNCING' })

  try {
    const ctx = {
      ...pageConfig,
      data: {
        ...pageConfig.data,
        isUnlimited: false,
        result: { timestamp: 188 },
        freeRetestReady: false,
        precisionInvite: { target: 'precision_card' }
      },
      setData(patch) { Object.assign(this.data, patch) }
    }
    pageConfig.onPrecisionRetest.call(ctx)
    assert.equal(navigatedUrl, '/pages/measure/measure?mode=precision')
    assert.equal(modalShown, false)
    assert.equal(storedInfo.retestCredits, 1)
    assert.equal(ctx.data.freeRetestReady, true)
  } finally {
    pay.grantRetest = originalGrant
    global.wx = originalWx
  }
})
