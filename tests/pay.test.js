const test = require('node:test')
const assert = require('node:assert/strict')

const { _test } = require('../utils/pay.js')

test('retries confirm when virtual goods delivery is still pending', () => {
  assert.equal(_test.shouldRetryConfirm({ ok: true, deliveryOk: false }, 0), true)
  assert.equal(_test.shouldRetryConfirm({ ok: true, deliveryOk: false }, 3), false)
})

test('does not retry permanent payment configuration failures', () => {
  assert.equal(_test.shouldRetryConfirm({ ok: false, code: 'NO_CONFIG' }, 0), false)
  assert.equal(_test.shouldRetryConfirm({ ok: false, code: 'ORDER_OWNER_MISMATCH' }, 0), false)
})

test('explains App Store virtual payment failures with actionable checks', () => {
  const message = _test.buildVirtualPaymentFailMessage({
    errMsg: 'requestVirtualPayment:fail App Store 暂无法完成充值，可稍后再试。'
  })
  assert.match(message, /Apple ID/)
  assert.match(message, /App 内购买/)
  assert.match(message, /关闭 VPN/)
})
