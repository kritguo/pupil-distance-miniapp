// 虚拟支付「发货回调」云函数
// 绑定方式:微信公众平台 → 虚拟支付/开发设置 → 消息推送,把 xpay_goods_deliver_notify 事件推到本云函数。
// 职责:收到「现金购道具成功」推送 → 幂等发放权益到 users 集合 → 返回 ErrCode:0(否则微信会重推/退款)。
//
// ⚠️ 待沙箱核对:推送事件的确切字段名(下面做了多写法兜底 + 打印原始 event 便于联调)。

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const YEAR_MS = 365 * 24 * 3600 * 1000

// 道具ID → 发放类型。必须与虚拟支付后台「道具管理」里的道具ID一致。
const PRODUCT_GRANT = {
  single_pack_3: 'single',
  annual_member: 'annual'
}

// 在现有权益上叠加发放(与旧 payCallback 逻辑一致)
const applyGrant = (user, grant, now) => {
  const next = {
    remainCount: (user && user.remainCount) || 0,
    totalSinglePurchased: (user && user.totalSinglePurchased) || 0,
    annualExpireAt: (user && user.annualExpireAt) || 0,
    consumedResults: (user && user.consumedResults) || []
  }
  if (grant === 'single') {
    next.remainCount += 3
    next.totalSinglePurchased += 3
  } else if (grant === 'annual') {
    const base = Math.max(now, next.annualExpireAt || 0)
    next.annualExpireAt = base + YEAR_MS
  }
  return next
}

// 从推送事件里尽量稳地取字段(不同环境字段大小写/命名可能不同)
const pick = (obj, keys) => {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k]
  }
  return undefined
}

exports.main = async (event) => {
  console.log('[vpayNotify] raw event:', JSON.stringify(event))

  const ack = { ErrCode: 0, ErrMsg: 'success' }

  // 事件体可能在 event 顶层,也可能裹在某层里;做一次浅层兜底
  const e = event || {}
  const evtType = pick(e, ['Event', 'event', 'MsgType', 'msgType'])
  const outTradeNo = pick(e, ['OutTradeNo', 'out_trade_no', 'OrderId', 'order_id'])
  const productId = pick(e, ['ProductId', 'product_id', 'GoodsId', 'goods_id'])
  const openid = pick(e, ['OpenId', 'openid', 'OpenID', 'FromUserName'])

  // 只处理发货(现金购道具成功)事件;其它事件(退款/投诉)先 ack 不处理
  if (evtType && String(evtType).indexOf('xpay_goods_deliver') === -1) {
    return ack
  }

  if (!outTradeNo || !openid) {
    console.warn('[vpayNotify] 缺少 outTradeNo/openid,无法发权益,先 ack')
    return ack
  }

  const grant = productId ? PRODUCT_GRANT[productId] : null
  const db = cloud.database()
  const now = Date.now()

  try {
    await db.runTransaction(async (transaction) => {
      // 用订单做幂等:找到 pending 订单则置 paid 并发权益;已 paid 则跳过
      const orderRes = await transaction
        .collection('orders')
        .where({ outTradeNo })
        .get()
      const order = orderRes.data && orderRes.data[0]

      // 优先用订单里记录的 plan/productId 推导发放,回调字段缺失也能发对
      const effectiveGrant =
        grant ||
        (order && PRODUCT_GRANT[order.productId]) ||
        (order && order.plan) // plan 本身就是 'single'/'annual'

      if (order && order.status === 'paid') {
        return // 幂等:已处理
      }
      if (!effectiveGrant) {
        throw { _ack: true, reason: 'unknown_product' }
      }

      const targetOpenid = (order && order.openid) || openid

      // 发权益
      const userRes = await transaction
        .collection('users')
        .doc(targetOpenid)
        .get()
        .catch(() => null)
      const user = userRes && userRes.data
      const granted = applyGrant(user, effectiveGrant, now)

      if (user) {
        await transaction.collection('users').doc(targetOpenid).update({
          data: {
            remainCount: granted.remainCount,
            totalSinglePurchased: granted.totalSinglePurchased,
            annualExpireAt: granted.annualExpireAt,
            updateTime: db.serverDate()
          }
        })
      } else {
        await transaction.collection('users').doc(targetOpenid).set({
          data: {
            openid: targetOpenid,
            remainCount: granted.remainCount,
            totalSinglePurchased: granted.totalSinglePurchased,
            annualExpireAt: granted.annualExpireAt,
            consumedResults: [],
            createTime: db.serverDate(),
            updateTime: db.serverDate()
          }
        })
      }

      // 标记订单已支付(没有 pending 订单也不阻断发货)
      if (order) {
        await transaction.collection('orders').doc(order._id).update({
          data: { status: 'paid', payTime: db.serverDate() }
        })
      }
    })
    return ack
  } catch (err) {
    if (err && err._ack) return ack
    console.error('[vpayNotify] 处理失败:', err)
    // 返回非 0 让微信重推
    return { ErrCode: 1, ErrMsg: 'process_fail' }
  }
}
