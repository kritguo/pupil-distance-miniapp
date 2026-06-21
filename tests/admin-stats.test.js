const test = require('node:test')
const assert = require('node:assert/strict')

const {
  authorizeAdminRequest,
  buildAuthStatus,
  extractApiToken,
  formatPaidOrder,
  formatPaidOrders,
  getDayRanges,
  resolveRecentOrdersQuery,
  summarizeAdminStats,
  formatSummaryText
} = require('../cloudfunctions/adminStats/helpers.js')

test('authorizes mini program admin by openid from environment only', () => {
  const env = { ADMIN_OPENIDS: 'admin-a, admin-b', ADMIN_API_TOKEN: 'secret-token' }

  assert.deepEqual(
    authorizeAdminRequest({ event: {}, openid: 'admin-a', env }),
    { authorized: true, authType: 'openid', isAdmin: true }
  )
  assert.deepEqual(
    authorizeAdminRequest({ event: {}, openid: 'user-x', env }),
    { authorized: false, authType: 'none', isAdmin: false }
  )
})

test('builds auth status with caller openid so owner can copy it during setup', () => {
  assert.deepEqual(
    buildAuthStatus({
      openid: 'owner-openid',
      env: { ADMIN_OPENIDS: 'owner-openid', ADMIN_API_TOKEN: 'secret-token' }
    }),
    {
      ok: true,
      openid: 'owner-openid',
      isAdmin: true,
      configured: true,
      apiEnabled: true
    }
  )
})

test('extracts robot api token from bearer header, x-admin-token, query, or body', () => {
  assert.equal(extractApiToken({ headers: { authorization: 'Bearer abc' } }), 'abc')
  assert.equal(extractApiToken({ headers: { 'x-admin-token': 'def' } }), 'def')
  assert.equal(extractApiToken({ queryStringParameters: { token: 'ghi' } }), 'ghi')
  assert.equal(extractApiToken({ body: JSON.stringify({ token: 'jkl' }) }), 'jkl')
})

test('authorizes robot api by token without requiring openid', () => {
  const env = { ADMIN_OPENIDS: 'admin-a', ADMIN_API_TOKEN: 'secret-token' }

  assert.deepEqual(
    authorizeAdminRequest({
      event: { headers: { authorization: 'Bearer secret-token' } },
      openid: '',
      env
    }),
    { authorized: true, authType: 'api_token', isAdmin: false }
  )
  assert.equal(
    authorizeAdminRequest({
      event: { headers: { authorization: 'Bearer wrong-token' } },
      openid: '',
      env
    }).authorized,
    false
  )
})

test('summarizes today and 7-day measurement/payment stats using China day boundary', () => {
  const now = Date.parse('2026-06-01T04:00:00.000Z') // 2026-06-01 12:00 in China
  const todayMorning = new Date('2026-06-01T01:20:00.000Z')
  const todayNoon = new Date('2026-06-01T03:00:00.000Z')
  const yesterday = new Date('2026-05-31T02:00:00.000Z')

  const stats = summarizeAdminStats({
    now,
    orders: [
      { openid: 'u1', status: 'paid', amount: 990, plan: 'single', payTime: todayMorning },
      { openid: 'u2', status: 'paid', amount: 1990, plan: 'annual', payTime: todayNoon, deliveryStatus: 'delivered' },
      { openid: 'u2', status: 'pending', amount: 990, plan: 'single', payTime: todayNoon },
      { openid: 'u3', status: 'paid', amount: 990, plan: 'single', payTime: yesterday },
      { openid: 'u4', status: 'paid', amount: 990, plan: 'single', payTime: todayNoon, deliveryStatus: 'failed' }
    ],
    measureEvents: [
      { openid: 'u1', mode: 'normal', quotaSource: 'trial', createTime: todayMorning },
      { openid: 'u1', mode: 'precision', quotaSource: 'paid', createTime: todayNoon },
      { openid: 'u2', mode: 'precision', quotaSource: 'annual', createTime: todayNoon },
      { openid: 'u3', mode: 'normal', quotaSource: 'trial', createTime: yesterday }
    ],
    users: [
      { openid: 'u1', totalSinglePurchased: 1, annualExpireAt: 0 },
      { openid: 'u2', totalSinglePurchased: 0, annualExpireAt: now + 1000 },
      { openid: 'u3', totalSinglePurchased: 1, annualExpireAt: 0 }
    ]
  })

  assert.equal(stats.today.measurementUsers, 2)
  assert.equal(stats.today.measurementSessions, 3)
  assert.equal(stats.today.paidUsers, 3)
  assert.equal(stats.today.paidOrders, 3)
  assert.equal(stats.today.revenueFen, 3970)
  assert.equal(stats.today.deliveryPending, 2)
  assert.equal(stats.totals.deliveryPending, 3)
  assert.deepEqual(stats.today.modeCounts, { normal: 1, precision: 2, unknown: 0 })
  assert.equal(stats.totals.users, 3)
  assert.equal(stats.totals.annualUsers, 1)
  assert.equal(stats.trend.length, 7)
  assert.equal(stats.trend[6].date, '2026-06-01')
  assert.equal(stats.trend[6].measurementSessions, 3)
})

test('counts today new users from createTime in summary', () => {
  const now = Date.parse('2026-06-01T04:00:00.000Z') // 2026-06-01 12:00 中国
  const todayNoon = new Date('2026-06-01T03:00:00.000Z')
  const yesterday = new Date('2026-05-31T02:00:00.000Z')

  const stats = summarizeAdminStats({
    now,
    orders: [],
    measureEvents: [],
    users: [
      { openid: 'u1', createTime: todayNoon },
      { openid: 'u2', createTime: todayNoon },
      { openid: 'u3', createTime: yesterday },
      { openid: 'u4' } // 无 createTime,不计入任何一天
    ]
  })

  assert.equal(stats.today.newUsers, 2)
  assert.equal(stats.totals.users, 4)
  assert.equal(stats.trend[6].newUsers, 2)
  assert.equal(stats.trend[5].newUsers, 1)
})

test('resolves recent orders query with clamped limit and parsed since', () => {
  assert.deepEqual(resolveRecentOrdersQuery({}), { sinceMs: null, limit: 50 })
  assert.equal(resolveRecentOrdersQuery({ limit: 9999 }).limit, 200)
  assert.equal(resolveRecentOrdersQuery({ limit: 0 }).limit, 50)
  assert.equal(resolveRecentOrdersQuery({ limit: -5 }).limit, 50)
  assert.equal(resolveRecentOrdersQuery({ limit: 10 }).limit, 10)
  assert.equal(
    resolveRecentOrdersQuery({ since: '2026-06-21T00:00:00+08:00' }).sinceMs,
    Date.parse('2026-06-21T00:00:00+08:00')
  )
  assert.equal(resolveRecentOrdersQuery({ since: 1750000000000 }).sinceMs, 1750000000000)
  assert.equal(resolveRecentOrdersQuery({ since: 'not-a-date' }).sinceMs, null)
})

test('formats a paid order into outward DTO with fen and yuan', () => {
  const paidAt = new Date('2026-06-21T12:30:00.000Z')
  const dto = formatPaidOrder({
    _id: 'doc1',
    outTradeNo: 'vp1',
    transactionId: 'wx9',
    amount: 1990,
    status: 'paid',
    plan: 'annual',
    productId: 'annual_member',
    channel: 'virtual',
    openid: 'user-a',
    payTime: paidAt,
    deliveryStatus: 'delivered',
    createTime: new Date('2026-06-21T12:00:00.000Z')
  })
  assert.equal(dto.orderId, 'doc1')
  assert.equal(dto.amountFen, 1990)
  assert.equal(dto.amountYuan, 19.9)
  assert.equal(dto.transactionId, 'wx9')
  assert.equal(dto.channel, 'virtual')
  assert.equal(dto.paidAt, paidAt.toISOString())
  assert.equal(dto.deliveryStatus, 'delivered')
})

test('defaults delivery status to pending for paid order missing it', () => {
  const [dto] = formatPaidOrders([{ outTradeNo: 'vp2', status: 'paid', amount: 990 }])
  assert.equal(dto.deliveryStatus, 'pending')
  assert.equal(dto.transactionId, '')
  assert.equal(dto.amountYuan, 9.9)
  assert.equal(dto.paidAt, null)
  assert.equal(formatPaidOrders(null).length, 0)
})

test('formats concise robot summary text', () => {
  const ranges = getDayRanges({ now: Date.parse('2026-06-01T04:00:00.000Z'), days: 7 })
  const text = formatSummaryText({
    day: ranges[ranges.length - 1],
    today: {
      measurementUsers: 2,
      measurementSessions: 3,
      paidUsers: 1,
      paidOrders: 1,
      revenueFen: 990,
      modeCounts: { normal: 2, precision: 1, unknown: 0 }
    }
  })

  assert.match(text, /2026-06-01/)
  assert.match(text, /测量：2人\/3次/)
  assert.match(text, /付费：1人\/1单\/9.90元/)
  assert.match(text, /普通2/)
  assert.match(text, /精确1/)
})
