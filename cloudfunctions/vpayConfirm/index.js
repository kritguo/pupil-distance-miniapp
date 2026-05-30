// 虚拟支付「查单发权益」云函数(主动查单模式,不依赖消息推送)
// 前端 wx.requestVirtualPayment 成功后调用:查这笔单是否已支付 → 幂等发权益 → 确认发货(防自动退款)。
//
// 需在本函数「配置 → 环境变量」配置(与 vpaySign 同):
//   VPAY_APP_KEY   虚拟支付 appKey(与 VPAY_ENV 对应的沙箱/现网)
//   WX_APP_SECRET  小程序 AppSecret(换 access_token)
//   VPAY_ENV       1=沙箱 / 0=现网
//
// ⚠️ 待沙箱核对:query_order 返回里 status 的确切层级(已多层兜底 + 打印原始响应)。

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const YEAR_MS = 365 * 24 * 3600 * 1000
const PRODUCT_GRANT = { single_pack_3: 'single', annual_member: 'annual' }

const hmacHex = (key, data) =>
  crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex')

const httpGet = (url) =>
  new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })

// POST JSON 到 api.weixin.qq.com 指定 path,query 里带 access_token + pay_sig
const httpPostXpay = (path, query, body) =>
  new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.weixin.qq.com',
      path: path + '?' + query,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }
    const req = https.request(options, (res) => {
      let buf = ''
      res.on('data', (c) => (buf += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(buf))
        } catch (e) {
          resolve({ _raw: buf })
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })

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
    next.annualExpireAt = Math.max(now, next.annualExpireAt || 0) + YEAR_MS
  }
  return next
}

const deriveEntitlement = (user, now) => {
  const remainCount = (user && user.remainCount) || 0
  const annualExpireAt = (user && user.annualExpireAt) || 0
  const totalSinglePurchased = (user && user.totalSinglePurchased) || 0
  const annualActive = annualExpireAt > now
  let status = 'none'
  if (annualActive) status = 'unlimited'
  else if (remainCount > 0) status = 'single'
  else if (totalSinglePurchased > 0) status = 'single_used'
  return { status, remainCount, annualExpireAt, annualActive, isUnlimited: annualActive }
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const appid = wxContext.APPID
  const now = Date.now()
  if (!openid) return { ok: false, code: 'NO_OPENID' }

  const outTradeNo = event && event.outTradeNo
  if (!outTradeNo) return { ok: false, code: 'NO_ORDER' }

  const APP_KEY = process.env.VPAY_APP_KEY
  const APP_SECRET = process.env.WX_APP_SECRET
  const ENV_FLAG = process.env.VPAY_ENV ? Number(process.env.VPAY_ENV) : 1
  if (!APP_KEY || !APP_SECRET) {
    return { ok: false, code: 'NO_CONFIG', message: '环境变量未配置(VPAY_APP_KEY/WX_APP_SECRET)' }
  }

  // 1) access_token
  let token
  try {
    const tk = await httpGet(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${APP_SECRET}`
    )
    token = tk && tk.access_token
    if (!token) return { ok: false, code: 'NO_TOKEN', detail: tk }
  } catch (e) {
    return { ok: false, code: 'TOKEN_FAIL', message: '' + e }
  }

  // 2) 查单
  let queryRes
  try {
    const body = JSON.stringify({ openid, env: ENV_FLAG, order_id: String(outTradeNo) })
    const paySig = hmacHex(APP_KEY, '/xpay/query_order&' + body)
    queryRes = await httpPostXpay('/xpay/query_order', `access_token=${token}&pay_sig=${paySig}`, body)
  } catch (e) {
    return { ok: false, code: 'QUERY_FAIL', message: '' + e }
  }
  console.log('[vpayConfirm] query_order resp:', JSON.stringify(queryRes))

  const status =
    (queryRes && queryRes.status) ||
    (queryRes && queryRes.order_info && queryRes.order_info.status) ||
    (queryRes && queryRes.order && queryRes.order.status)
  if (typeof status === 'undefined') {
    return { ok: false, code: 'NO_STATUS', detail: queryRes }
  }
  if (Number(status) < 2) {
    return { ok: false, code: 'NOT_PAID', status: Number(status) }
  }

  // 3) 幂等发权益(以 orders 订单状态去重)
  const db = cloud.database()
  try {
    await db.runTransaction(async (transaction) => {
      const orderRes = await transaction.collection('orders').where({ outTradeNo }).get()
      const order = orderRes.data && orderRes.data[0]
      if (order && order.status === 'paid') return // 已发过

      const grant =
        (order && PRODUCT_GRANT[order.productId]) || (order && order.plan) || null
      if (!grant) throw { _ack: true }

      const targetOpenid = (order && order.openid) || openid
      const userRes = await transaction
        .collection('users')
        .doc(targetOpenid)
        .get()
        .catch(() => null)
      const user = userRes && userRes.data
      const granted = applyGrant(user, grant, now)

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
      if (order) {
        await transaction.collection('orders').doc(order._id).update({
          data: { status: 'paid', payTime: db.serverDate() }
        })
      }
    })
  } catch (err) {
    if (!(err && err._ack)) {
      console.error('[vpayConfirm] grant fail:', err)
      return { ok: false, code: 'GRANT_FAIL', message: '' + err }
    }
  }

  // 4) 确认发货(status==2 待发货时),防微信自动退款
  if (Number(status) === 2) {
    try {
      const body2 = JSON.stringify({ order_id: String(outTradeNo), env: ENV_FLAG })
      const paySig2 = hmacHex(APP_KEY, '/xpay/notify_provide_goods&' + body2)
      const dres = await httpPostXpay(
        '/xpay/notify_provide_goods',
        `access_token=${token}&pay_sig=${paySig2}`,
        body2
      )
      console.log('[vpayConfirm] notify_provide_goods resp:', JSON.stringify(dres))
    } catch (e) {
      console.warn('[vpayConfirm] 发货确认异常(不阻断发权益):', e)
    }
  }

  // 5) 返回最新权益
  const finalRes = await db.collection('users').doc(openid).get().catch(() => null)
  const ent = deriveEntitlement(finalRes && finalRes.data, now)
  return { ok: true, serverTime: now, ...ent }
}
