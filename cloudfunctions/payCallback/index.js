const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const YEAR_MS = 365 * 24 * 3600 * 1000

// 与 payOrder 保持一致：每种套餐发放什么权益
const PRICING = {
  single: { fee: 990, grant: 'single' },
  annual: { fee: 1990, grant: 'annual' },
  upgrade: { fee: 1000, grant: 'annual' }
}

// 根据套餐在现有权益上叠加发放
const applyGrant = (user, plan, now) => {
  const next = {
    remainCount: (user && user.remainCount) || 0,
    totalSinglePurchased: (user && user.totalSinglePurchased) || 0,
    annualExpireAt: (user && user.annualExpireAt) || 0,
    consumedResults: (user && user.consumedResults) || []
  }
  const grant = (PRICING[plan] || {}).grant
  if (grant === 'single') {
    next.remainCount += 3
    next.totalSinglePurchased += 3
  } else if (grant === 'annual') {
    const base = Math.max(now, next.annualExpireAt || 0)
    next.annualExpireAt = base + YEAR_MS
  }
  return next
}

exports.main = async (event) => {
  // 云支付回调：event 内含 outTradeNo / resultCode / returnCode / totalFee / transactionId / subOpenid 等
  const outTradeNo = event && event.outTradeNo
  const resultCode = event && event.resultCode
  const transactionId = (event && event.transactionId) || ''

  // 微信要求回调成功必须返回这个结构，否则会重复回调
  const ackSuccess = { errcode: 0, errmsg: 'success' }

  if (!outTradeNo) {
    return { errcode: 1, errmsg: 'missing outTradeNo' }
  }
  // 支付未成功，直接 ack（避免重复回调），但不发放权益
  if (resultCode && resultCode !== 'SUCCESS') {
    return ackSuccess
  }

  const db = cloud.database()
  const now = Date.now()

  try {
    await db.runTransaction(async (transaction) => {
      const orderRes = await transaction.collection('orders').where({ outTradeNo }).get()
      const order = orderRes.data && orderRes.data[0]
      if (!order) {
        // 找不到订单，仍 ack，避免无限重试；记录异常
        throw { _ack: true, reason: 'order_not_found' }
      }
      // 幂等：已处理过就不再发放
      if (order.status === 'paid') {
        throw { _ack: true, reason: 'already_paid' }
      }

      // 金额校验：回调金额必须与下单金额一致
      const expected = (PRICING[order.plan] || {}).fee
      if (event && typeof event.totalFee !== 'undefined' && expected && Number(event.totalFee) !== expected) {
        throw { _ack: true, reason: 'amount_mismatch' }
      }

      // 标记订单已支付
      await transaction.collection('orders').doc(order._id).update({
        data: { status: 'paid', transactionId, payTime: db.serverDate() }
      })

      // 发放权益到 users（doc id = openid，便于幂等 upsert）
      const openid = order.openid
      const userRes = await transaction.collection('users').doc(openid).get().catch(() => null)
      const user = userRes && userRes.data
      const granted = applyGrant(user, order.plan, now)

      if (user) {
        await transaction.collection('users').doc(openid).update({
          data: {
            remainCount: granted.remainCount,
            totalSinglePurchased: granted.totalSinglePurchased,
            annualExpireAt: granted.annualExpireAt,
            updateTime: db.serverDate()
          }
        })
      } else {
        await transaction.collection('users').doc(openid).set({
          data: {
            openid,
            remainCount: granted.remainCount,
            totalSinglePurchased: granted.totalSinglePurchased,
            annualExpireAt: granted.annualExpireAt,
            consumedResults: [],
            createTime: db.serverDate(),
            updateTime: db.serverDate()
          }
        })
      }
    })
    return ackSuccess
  } catch (err) {
    // 事务里主动抛出的“可 ack”情况（已支付/订单不存在/金额不符）
    if (err && err._ack) {
      return ackSuccess
    }
    // 真异常：返回非 0，微信会重试回调
    return { errcode: 1, errmsg: 'process_fail: ' + err }
  }
}
