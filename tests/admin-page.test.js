const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function loadAdminPage() {
  const pagePath = path.resolve(__dirname, '../pages/admin/admin.js')
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

test('admin trend rows render payment users and revenue amount only', () => {
  const wxml = fs.readFileSync(path.resolve(__dirname, '../pages/admin/admin.wxml'), 'utf8')

  assert.match(wxml, /付款 \{\{item\.paidUsers\}\}人/)
  assert.match(wxml, /\{\{item\.revenueYuan\}\}元/)
  assert.doesNotMatch(wxml, /测量 \{\{item\.measurementUsers\}\}人\/\{\{item\.measurementSessions\}\}次/)
  assert.doesNotMatch(wxml, /付费 \{\{item\.paidUsers\}\}人\/\{\{item\.paidOrders\}\}单/)
})

test('admin renderStats formats revenue yuan for trend amount display', () => {
  const pageConfig = loadAdminPage()
  let rendered
  const ctx = {
    setData(data) {
      rendered = data
    }
  }

  pageConfig.renderStats.call(ctx, {
    today: {},
    totals: {},
    trend: [{ label: '06-02', paidUsers: 3, paidOrders: 3, revenueFen: 2970 }]
  })

  assert.equal(rendered.trend[0].paidUsers, 3)
  assert.equal(rendered.trend[0].revenueYuan, '29.70')
})

test('admin user order card uses clearer payment labels and hides repair action when empty', () => {
  const wxml = fs.readFileSync(path.resolve(__dirname, '../pages/admin/admin.wxml'), 'utf8')

  assert.match(wxml, /当前年度会员/)
  assert.match(wxml, /买过单次的人/)
  assert.match(wxml, /近7天收入/)
  assert.match(wxml, /待补发货/)
  assert.match(wxml, /wx:if="\{\{hasDeliveryPending\}\}"/)
  assert.doesNotMatch(wxml, /7天支付订单/)
  assert.doesNotMatch(wxml, /未确认发货/)
})

test('admin renderStats exposes delivery pending state for conditional repair UI', () => {
  const pageConfig = loadAdminPage()
  let rendered
  const ctx = {
    setData(data) {
      rendered = data
    }
  }

  pageConfig.renderStats.call(ctx, {
    today: {},
    totals: { deliveryPending: 0 },
    trend: []
  })
  assert.equal(rendered.hasDeliveryPending, false)

  pageConfig.renderStats.call(ctx, {
    today: {},
    totals: { deliveryPending: 2 },
    trend: []
  })
  assert.equal(rendered.hasDeliveryPending, true)
})
