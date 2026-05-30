// 支付与权益同步封装
// 全部走微信云开发云函数：payOrder / getEntitlement / consumeMeasure
// 权益真值在服务端，本地通过 userUtil.applyServerEntitlement 缓存。

const userUtil = require('./user.js')

// 可购买套餐（仅用于前端展示文案，金额以服务端 payOrder 为准）
const PLAN_LABELS = {
  single: '单次套餐（3 次）',
  annual: '年度会员（一年不限次）',
  upgrade: '升级年度会员（补差价）'
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
function consume(resultKey) {
  return new Promise((resolve) => {
    if (!ensureCloud() || !resultKey) {
      resolve(null)
      return
    }
    wx.cloud.callFunction({
      name: 'consumeMeasure',
      data: { resultKey: String(resultKey) },
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

// 发起购买：下单 -> 拉起微信支付 -> 成功后同步权益
// 返回 { ok, ent } 或 { ok:false, code, message }
function purchase(plan) {
  return new Promise((resolve) => {
    if (!ensureCloud()) {
      resolve({ ok: false, code: 'NO_CLOUD', message: '云开发未初始化' })
      return
    }
    wx.showLoading({ title: '正在下单...', mask: true })
    wx.cloud.callFunction({
      name: 'payOrder',
      data: { plan },
      success: (res) => {
        const order = res && res.result
        if (!order || !order.ok || !order.payment) {
          wx.hideLoading()
          resolve({
            ok: false,
            code: (order && order.code) || 'ORDER_FAIL',
            message: (order && order.message) || '下单失败'
          })
          return
        }
        const p = order.payment
        wx.hideLoading()
        wx.requestPayment({
          timeStamp: p.timeStamp,
          nonceStr: p.nonceStr,
          package: p.package,
          signType: p.signType || 'MD5',
          paySign: p.paySign,
          success: () => {
            // 支付成功，回调云函数已异步发放权益；这里轮询同步一次（含一次重试）
            wx.showLoading({ title: '确认支付结果...', mask: true })
            syncEntitlement().then((ent) => {
              const granted = ent && (ent.status === 'unlimited' || ent.remainCount > 0)
              if (granted) {
                wx.hideLoading()
                resolve({ ok: true, ent, outTradeNo: order.outTradeNo })
                return
              }
              // 回调可能稍有延迟，1.2s 后再同步一次
              setTimeout(() => {
                syncEntitlement().then((ent2) => {
                  wx.hideLoading()
                  resolve({ ok: true, ent: ent2 || ent, outTradeNo: order.outTradeNo })
                })
              }, 1200)
            })
          },
          fail: (err) => {
            const cancelled = err && /cancel/i.test(err.errMsg || '')
            resolve({
              ok: false,
              code: cancelled ? 'CANCELLED' : 'PAY_FAIL',
              message: cancelled ? '已取消支付' : '支付未完成'
            })
          }
        })
      },
      fail: (err) => {
        wx.hideLoading()
        console.warn('[pay] payOrder 失败:', err)
        resolve({ ok: false, code: 'ORDER_REQUEST_FAIL', message: '下单请求失败' })
      }
    })
  })
}

module.exports = {
  PLAN_LABELS,
  syncEntitlement,
  consume,
  purchase
}
