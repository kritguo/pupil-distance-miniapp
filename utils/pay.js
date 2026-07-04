// 支付与权益同步封装
// 支付走「虚拟支付」：wx.login 拿 code → 云函数 vpaySign 签名 → wx.requestVirtualPayment 拉起。
// 权益由 vpayConfirm 主动查单后发放；前端支付成功后同步 getEntitlement。
// 权益真值在服务端，本地通过 userUtil.applyServerEntitlement 缓存。

const userUtil = require('./user.js')

// 可购买套餐（仅用于前端展示文案，金额/道具以服务端 vpaySign 为准）
const PLAN_LABELS = {
  single: '单次测量（拍 3 张取中位数）',
  annual: '年度会员（一年不限次）'
}

const CONFIRM_RETRY_DELAYS_MS = [800, 1500, 2500]
const RETRYABLE_CONFIRM_CODES = {
  NOT_PAID: true,
  QUERY_FAIL: true,
  NO_STATUS: true,
  TOKEN_FAIL: true,
  CONFIRM_FAIL: true
}

function shouldRetryConfirm(out, attempt) {
  if (attempt >= CONFIRM_RETRY_DELAYS_MS.length) return false
  if (!out) return true
  if (out.ok && out.deliveryOk === false) return true
  return !!(!out.ok && RETRYABLE_CONFIRM_CODES[out.code])
}

function buildVirtualPaymentFailMessage(err) {
  const raw = (err && err.errMsg) || (err ? JSON.stringify(err) : '')
  if (/App Store|暂无法完成充值|充值/i.test(raw)) {
    return '支付未完成：App Store 暂无法完成充值。请检查 Apple ID 付款方式、App 内购买权限、微信/iOS 版本，关闭 VPN 后重试；也可以换一台 iPhone 或换 Apple ID 测试。'
  }
  return '支付未完成：' + (raw || '请稍后重试')
}

function ensureCloud() {
  return !!(wx.cloud && typeof wx.cloud.callFunction === 'function')
}

// 拉取服务端权益并同步到本地缓存，返回 entitlement
function syncEntitlement() {
  return new Promise((resolve) => {
    if (!ensureCloud()) {
      resolve(null)
      return
    }
    wx.cloud.callFunction({
      name: 'getEntitlement',
      success: (res) => {
        const ent = res && res.result
        if (ent && ent.ok) {
          userUtil.applyServerEntitlement(ent)
          resolve(ent)
        } else {
          resolve(ent || null)
        }
      },
      fail: (err) => {
        console.warn('[pay] getEntitlement 失败:', err)
        resolve(null)
      }
    })
  })
}

// 单次套餐用户查看一条新结果时扣 1 次（服务端幂等去重）
// resultKey 用结果时间戳，确保同一结果不会重复扣费
function consume(resultKey, options) {
  return new Promise((resolve) => {
    if (!ensureCloud() || !resultKey) {
      resolve(null)
      return
    }
    wx.cloud.callFunction({
      name: 'consumeMeasure',
      data: {
        resultKey: String(resultKey),
        preferPaid: !!(options && options.preferPaid)
      },
      success: (res) => {
        const out = res && res.result
        if (out && out.ok) {
          userUtil.applyServerEntitlement(out)
        }
        resolve(out || null)
      },
      fail: (err) => {
        console.warn('[pay] consumeMeasure 失败:', err)
        resolve(null)
      }
    })
  })
}

// 为某条「已解锁」结果申请免费精度复测额度（服务端幂等、只对已解锁结果发）
// 返回 { ok, granted, retestCredits } 或 null
function grantRetest(resultKey, reason) {
  return new Promise((resolve) => {
    if (!ensureCloud() || !resultKey) {
      resolve(null)
      return
    }
    wx.cloud.callFunction({
      name: 'grantRetest',
      data: { resultKey: String(resultKey), reason: reason || 'quality' },
      success: (res) => {
        const out = (res && res.result) || null
        if (out && out.ok) {
          userUtil.applyServerEntitlement(out)
        }
        resolve(out)
      },
      fail: (err) => {
        console.warn('[pay] grantRetest 失败:', err)
        resolve(null)
      }
    })
  })
}

function retryConfirmLater(outTradeNo, resolve, attempt) {
  const delay = CONFIRM_RETRY_DELAYS_MS[attempt]
  setTimeout(() => pollEntitlementAfterPay(outTradeNo, resolve, attempt + 1), delay)
}

// 支付成功后：调 vpayConfirm 主动查单发权益和确认发货，再同步本地缓存
function pollEntitlementAfterPay(outTradeNo, resolve, attempt = 0) {
  wx.showLoading({ title: attempt ? '确认发货中...' : '确认支付结果...', mask: true })
  wx.cloud.callFunction({
    name: 'vpayConfirm',
    data: { outTradeNo },
    success: (res) => {
      const out = res && res.result
      if (out && out.ok) userUtil.applyServerEntitlement(out)
      if (shouldRetryConfirm(out, attempt)) {
        retryConfirmLater(outTradeNo, resolve, attempt)
        return
      }
      syncEntitlement().then((ent) => {
        wx.hideLoading()
        const e = ent || out
        const granted = e && (e.status === 'unlimited' || e.remainCount > 0)
        if (!granted && attempt < CONFIRM_RETRY_DELAYS_MS.length) {
          wx.showLoading({ title: '同步权益中...', mask: true })
          retryConfirmLater(outTradeNo, resolve, attempt)
          return
        }
        resolve(
          granted
            ? { ok: true, ent: e, outTradeNo, deliveryOk: !out || out.deliveryOk !== false }
            : {
                ok: false,
                code: 'GRANT_PENDING',
                message: '支付成功，权益确认中，请稍后在「我的」查看',
                outTradeNo
              }
        )
      })
    },
    fail: () => {
      const failed = { ok: false, code: 'CONFIRM_FAIL' }
      if (shouldRetryConfirm(failed, attempt)) {
        retryConfirmLater(outTradeNo, resolve, attempt)
        return
      }
      wx.hideLoading()
      resolve({ ok: false, code: 'CONFIRM_FAIL', message: '支付成功，权益确认失败，请稍后在「我的」重试' })
    }
  })
}

// 发起购买：wx.login 拿 code -> 云函数 vpaySign 签名 -> wx.requestVirtualPayment 拉起 -> 同步权益
// 返回 { ok, ent } 或 { ok:false, code, message }
function purchase(plan) {
  return new Promise((resolve) => {
    if (!ensureCloud()) {
      resolve({ ok: false, code: 'NO_CLOUD', message: '云开发未初始化' })
      return
    }
    if (typeof wx.requestVirtualPayment !== 'function') {
      resolve({ ok: false, code: 'NO_VPAY', message: '当前微信版本不支持虚拟支付，请升级微信后重试' })
      return
    }
    wx.login({
      success: (loginRes) => {
        const code = loginRes && loginRes.code
        if (!code) {
          resolve({ ok: false, code: 'LOGIN_FAIL', message: '微信登录失败' })
          return
        }
        wx.showLoading({ title: '正在下单...', mask: true })
        wx.cloud.callFunction({
          name: 'vpaySign',
          data: { plan, code },
          success: (res) => {
            wx.hideLoading()
            const sign = res && res.result
            if (!sign || !sign.ok) {
              resolve({
                ok: false,
                code: (sign && sign.code) || 'SIGN_FAIL',
                message: (sign && sign.message) || '下单失败'
              })
              return
            }
            wx.requestVirtualPayment({
              mode: sign.mode, // 'short_series_goods'
              signData: sign.signData,
              paySig: sign.paySig,
              signature: sign.signature,
              // 成功为弱确认，权益以服务端发货回调为准
              success: () => pollEntitlementAfterPay(sign.outTradeNo, resolve),
              fail: (err) => {
                console.error('[pay] requestVirtualPayment fail:', JSON.stringify(err))
                const cancelled = err && /cancel/i.test(err.errMsg || '')
                resolve({
                  ok: false,
                  code: cancelled ? 'CANCELLED' : 'PAY_FAIL',
                  message: cancelled ? '已取消支付' : buildVirtualPaymentFailMessage(err)
                })
              }
            })
          },
          fail: (err) => {
            wx.hideLoading()
            console.warn('[pay] vpaySign 失败:', err)
            resolve({ ok: false, code: 'SIGN_REQUEST_FAIL', message: '下单请求失败' })
          }
        })
      },
      fail: () => resolve({ ok: false, code: 'LOGIN_FAIL', message: '微信登录失败' })
    })
  })
}

module.exports = {
  PLAN_LABELS,
  syncEntitlement,
  consume,
  grantRetest,
  purchase,
  _test: {
    shouldRetryConfirm,
    buildVirtualPaymentFailMessage
  }
}
