const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeConfigValue,
  buildAccessTokenUrl,
  getQueryStatus,
  getQueryTransactionId,
  isDeliverySuccess,
  isDeliveredStatus,
  isGrantablePaidStatus,
  resolveTargetOpenid,
  resolvePayNotifyConfig,
  buildPayNotifyText,
  buildPayNotifyPayload,
  deliverPayNotify,
  selectRepairDeliveryOrders,
  shouldNotifyDelivery,
  shouldRepairDeliveryOrder,
  isRepairAdmin
} = require('../cloudfunctions/vpayConfirm/helpers.js')

test('vpayConfirm trims config values and encodes access_token url params', () => {
  assert.equal(normalizeConfigValue('  abc  '), 'abc')
  const url = buildAccessTokenUrl('wx app', 'secret+value')
  assert.match(url, /^https:\/\/api\.weixin\.qq\.com\/cgi-bin\/token\?/)
  assert.match(url, /grant_type=client_credential/)
  assert.match(url, /appid=wx\+app/)
  assert.match(url, /secret=secret%2Bvalue/)
})

test('parses query_order status from supported response shapes', () => {
  assert.equal(getQueryStatus({ status: 2 }), 2)
  assert.equal(getQueryStatus({ order_info: { status: '3' } }), 3)
  assert.equal(getQueryStatus({ order: { status: 4 } }), 4)
  assert.equal(getQueryStatus({ errcode: 0 }), undefined)
})

test('treats only empty or errcode zero delivery responses as successful', () => {
  assert.equal(isDeliverySuccess({ errcode: 0, errmsg: 'ok' }), true)
  assert.equal(isDeliverySuccess({}), true)
  assert.equal(isDeliverySuccess({ errcode: 268490003, errmsg: 'pay_sig invalid' }), false)
})

test('grants only paid virtual goods statuses and recognizes delivered status', () => {
  assert.equal(isGrantablePaidStatus(2), true)
  assert.equal(isGrantablePaidStatus(3), true)
  assert.equal(isGrantablePaidStatus(4), true)
  assert.equal(isGrantablePaidStatus(5), false)
  assert.equal(isGrantablePaidStatus(6), false)
  assert.equal(isDeliveredStatus(3), false)
  assert.equal(isDeliveredStatus(4), true)
})

test('attempts delivery confirmation for paid but undelivered statuses', () => {
  assert.equal(shouldNotifyDelivery(2), true)
  assert.equal(shouldNotifyDelivery(3), true)
  assert.equal(shouldNotifyDelivery(4), false)
  assert.equal(shouldNotifyDelivery(1), false)
})

test('finds paid local orders that still need delivery repair', () => {
  assert.equal(shouldRepairDeliveryOrder({ status: 'paid' }), true)
  assert.equal(shouldRepairDeliveryOrder({ status: 'paid', deliveryStatus: 'failed' }), true)
  assert.equal(shouldRepairDeliveryOrder({ status: 'paid', deliveryStatus: 'delivered' }), false)
  assert.equal(shouldRepairDeliveryOrder({ status: 'pending' }), false)
})

test('selects a small repair batch from a larger paid order scan', () => {
  const out = selectRepairDeliveryOrders(
    [
      { outTradeNo: 'new-ok', status: 'paid', deliveryStatus: 'delivered' },
      { outTradeNo: 'a', status: 'paid' },
      { outTradeNo: 'b', status: 'paid', deliveryStatus: 'failed' },
      { outTradeNo: 'c', status: 'paid' },
      { outTradeNo: 'pending', status: 'pending' }
    ],
    2
  )
  assert.deepEqual(out.selected.map((item) => item.outTradeNo), ['a', 'b'])
  assert.equal(out.candidates.length, 3)
})

test('authorizes repair admin from env or built-in owner openid', () => {
  assert.equal(isRepairAdmin('admin-a', { ADMIN_OPENIDS: 'admin-a,admin-b' }), true)
  assert.equal(isRepairAdmin('user-x', { ADMIN_OPENIDS: 'admin-a,admin-b' }), false)
  assert.equal(isRepairAdmin('oxopu3T05C7hP6aF5bppFjvBQmeo', {}), true)
  assert.equal(
    isRepairAdmin(
      '',
      { ADMIN_REPAIR_TOKEN_SHA256: '4740dd76d6bdc2bbbba0c851a08efe0a135d852e8f4628e662b3c78555b72ca6' },
      'unit-test-repair-token'
    ),
    true
  )
  assert.equal(isRepairAdmin('', {}, 'bad-token'), false)
})

test('resolves repair openid from order while rejecting cross-user caller', () => {
  assert.equal(resolveTargetOpenid({ openid: 'user-a' }, 'user-a'), 'user-a')
  assert.equal(resolveTargetOpenid({ openid: 'user-a' }, ''), 'user-a')
  assert.throws(
    () => resolveTargetOpenid({ openid: 'user-a' }, 'user-b'),
    /ORDER_OWNER_MISMATCH/
  )
})

test('extracts wechat transaction id from query_order shapes, empty when absent', () => {
  assert.equal(getQueryTransactionId({ order_info: { wx_payment_order_id: 'wx123' } }), 'wx123')
  assert.equal(getQueryTransactionId({ order: { wxpay_order_id: 'wxpay123' } }), 'wxpay123')
  assert.equal(getQueryTransactionId({ order: { transaction_id: 'tx456' } }), 'tx456')
  assert.equal(getQueryTransactionId({ wx_payment_order_id: 'top789' }), 'top789')
  assert.equal(getQueryTransactionId({ status: 2 }), '')
  assert.equal(getQueryTransactionId(null), '')
})

test('resolves pay notify config from env and auto-detects channel by host', () => {
  assert.equal(resolvePayNotifyConfig({}), null)
  assert.equal(resolvePayNotifyConfig({ PAY_NOTIFY_WEBHOOK: '   ' }), null)
  assert.deepEqual(
    resolvePayNotifyConfig({ PAY_NOTIFY_WEBHOOK: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x' }),
    { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x', type: 'wecom' }
  )
  assert.equal(
    resolvePayNotifyConfig({ PAY_NOTIFY_WEBHOOK: 'https://sctapi.ftqq.com/KEY.send' }).type,
    'serverchan'
  )
  assert.equal(
    resolvePayNotifyConfig({ PAY_NOTIFY_WEBHOOK: 'https://example.com/hook' }).type,
    'text'
  )
  assert.equal(
    resolvePayNotifyConfig({ PAY_NOTIFY_WEBHOOK: 'https://qyapi.weixin.qq.com/x', PAY_NOTIFY_TYPE: 'text' }).type,
    'text'
  )
})

test('builds human pay notify text with masked openid and china time', () => {
  const text = buildPayNotifyText({
    outTradeNo: 'vp123456',
    openid: 'abcdef-tail99',
    plan: 'single',
    amountFen: 990,
    paidAtMs: Date.parse('2026-06-21T12:30:00.000Z') // 中国时间 20:30
  })
  assert.match(text, /PDgo 新付费/)
  assert.match(text, /单次测量/)
  assert.match(text, /¥9.90/)
  assert.match(text, /vp123456/)
  assert.match(text, /…tail99/)
  assert.match(text, /06-21 20:30/)
  assert.doesNotMatch(text, /abcdef-tail99/) // 不泄露完整 openid
})

test('builds channel-specific notify payloads', () => {
  assert.deepEqual(
    JSON.parse(buildPayNotifyPayload({ type: 'wecom' }, 'a\nb')),
    { msgtype: 'text', text: { content: 'a\nb' } }
  )
  assert.deepEqual(
    JSON.parse(buildPayNotifyPayload({ type: 'serverchan' }, 'title-line\nbody')),
    { title: 'title-line', desp: 'title-line\nbody' }
  )
  assert.deepEqual(JSON.parse(buildPayNotifyPayload({ type: 'text' }, 'hi')), { text: 'hi' })
})

test('deliverPayNotify no-ops without webhook config and never calls post', async () => {
  let called = false
  const res = await deliverPayNotify({
    env: {},
    order: { outTradeNo: 'vp1', amountFen: 990 },
    post: async () => {
      called = true
    }
  })
  assert.deepEqual(res, { sent: false, reason: 'no_config' })
  assert.equal(called, false)
})

test('deliverPayNotify posts to configured webhook and reports sent', async () => {
  const calls = []
  const res = await deliverPayNotify({
    env: { PAY_NOTIFY_WEBHOOK: 'https://qyapi.weixin.qq.com/hook?key=x' },
    order: { outTradeNo: 'vp2', openid: 'abc123456', plan: 'single', amountFen: 990 },
    post: async (url, body) => {
      calls.push({ url, body })
    }
  })
  assert.deepEqual(res, { sent: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://qyapi.weixin.qq.com/hook?key=x')
  assert.match(calls[0].body, /新付费/)
})

test('deliverPayNotify swallows post failure as send_error and never throws', async () => {
  const res = await deliverPayNotify({
    env: { PAY_NOTIFY_WEBHOOK: 'https://example.com/hook' },
    order: { outTradeNo: 'vp3', amountFen: 1990, plan: 'annual' },
    post: async () => {
      throw new Error('boom')
    }
  })
  assert.equal(res.sent, false)
  assert.equal(res.reason, 'send_error')
  assert.match(res.error, /boom/)
})
