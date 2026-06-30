// 虚拟支付「查单发权益」云函数(主动查单模式,不依赖消息推送)
// 前端 wx.requestVirtualPayment 成功后调用:查这笔单是否已支付 → 幂等发权益 → 确认发货(防自动退款)。
//
// 需在本函数「配置 → 环境变量」配置(与 vpaySign 同):
//   VPAY_APP_KEY   虚拟支付 appKey(与 VPAY_ENV 对应的沙箱/现网)
//   WX_APP_SECRET  小程序 AppSecret(换 access_token)
//   VPAY_ENV       1=沙箱 / 0=现网。上线前必须显式配置。
//   WX_APP_ID      可选。仅在云控制台手动补单且上下文没有 APPID 时使用。
//
// query_order 返回字段按多层结构兜底解析；生产日志只记录关键状态，避免泄露订单细节。

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const https = require('https')
const http = require('http')
const {
  getQueryStatus,
  getQueryTransactionId,
  isDeliverySuccess,
  isDeliveredStatus,
  isGrantablePaidStatus,
  isRepairAdmin,
  resolveTargetOpenid,
  deliverPayNotify,
  selectRepairDeliveryOrders,
  shouldNotifyDelivery,
  normalizeConfigValue,
  buildAccessTokenUrl
} = require('./helpers.js')

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

// POST JSON 到任意 webhook URL(付费播报用)。独立于微信 xpay 接口。
// 按 URL 协议选 http/https(http:// 配错也不会被静默改写到 443);带超时:webhook 卡住
// 绝不能拖长 vpayConfirm 响应(否则刚付费用户拿不到权益)。
const PAY_NOTIFY_TIMEOUT_MS = 3500
const httpPostJson = (urlString, body) =>
  new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(urlString)
    } catch (e) {
      return reject(e)
    }
    const isHttp = u.protocol === 'http:'
    const lib = isHttp ? http : https
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      port: u.port || (isHttp ? 80 : 443),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }
    const req = lib.request(options, (res) => {
      let buf = ''
      res.on('data', (c) => (buf += c))
      res.on('end', () => resolve({ statusCode: res.statusCode, body: buf }))
    })
    req.setTimeout(PAY_NOTIFY_TIMEOUT_MS, () => req.destroy(new Error('PAY_NOTIFY_TIMEOUT')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })

// 付费实时播报:编排在 helpers.deliverPayNotify(可测),这里只注入真实 post + 落日志。
// 永不抛错,绝不阻断/影响发权益结果。
async function sendPayNotify(env, order) {
  const res = await deliverPayNotify({ env, order, post: httpPostJson })
  if (!res.sent && res.reason === 'send_error') {
    console.warn('[vpayConfirm] pay notify failed:', res.error)
  }
  return res
}

const applyGrant = (user, grant, now) => {
  const next = {
    remainCount: (user && user.remainCount) || 0,
    totalSinglePurchased: (user && user.totalSinglePurchased) || 0,
    annualExpireAt: (user && user.annualExpireAt) || 0,
    consumedResults: (user && user.consumedResults) || []
  }
  if (grant === 'single') {
    // ¥9.9 = 一次测量（拍 3 张取中位数）。中/低可信度自动补测；高可信度但用户不认可时可手动补测一次。
    next.remainCount += 1
    next.totalSinglePurchased += 1
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

const getConfig = () => {
  const APP_KEY = normalizeConfigValue(process.env.VPAY_APP_KEY)
  const APP_SECRET = normalizeConfigValue(process.env.WX_APP_SECRET)
  const ENV_RAW = normalizeConfigValue(process.env.VPAY_ENV)
  const ENV_FLAG = Number(ENV_RAW)
  if (!APP_KEY || !APP_SECRET || !/^[01]$/.test(String(ENV_RAW))) {
    const err = new Error('环境变量未配置或不合法(VPAY_APP_KEY/WX_APP_SECRET/VPAY_ENV)')
    err.code = 'NO_CONFIG'
    throw err
  }
  return { APP_KEY, APP_SECRET, ENV_FLAG }
}

async function getAccessToken(appid, APP_SECRET) {
  const tk = await httpGet(buildAccessTokenUrl(appid, APP_SECRET))
  const token = tk && tk.access_token
  if (!token) {
    const err = new Error('NO_TOKEN')
    err.code = 'NO_TOKEN'
    err.detail = tk
    throw err
  }
  return token
}

async function queryVirtualOrder({ APP_KEY, ENV_FLAG, token, openid, outTradeNo }) {
  const body = JSON.stringify({ openid, env: ENV_FLAG, order_id: String(outTradeNo) })
  const paySig = hmacHex(APP_KEY, '/xpay/query_order&' + body)
  return httpPostXpay('/xpay/query_order', `access_token=${token}&pay_sig=${paySig}`, body)
}

async function notifyProvideGoods({ APP_KEY, ENV_FLAG, token, outTradeNo }) {
  const body = JSON.stringify({ order_id: String(outTradeNo), env: ENV_FLAG })
  const paySig = hmacHex(APP_KEY, '/xpay/notify_provide_goods&' + body)
  return httpPostXpay('/xpay/notify_provide_goods', `access_token=${token}&pay_sig=${paySig}`, body)
}

async function markDelivery(db, order, deliveryData) {
  if (!order || !order._id) return
  await db.collection('orders').doc(order._id).update({
    data: { ...deliveryData, updateTime: db.serverDate() }
  })
}

async function confirmDeliveryForOrder({ db, order, status, APP_KEY, ENV_FLAG, token, outTradeNo }) {
  let deliveryAttempted = false
  let deliveryOk = isDeliveredStatus(status)
  let deliveryErrcode = null
  let deliveryErrmsg = ''

  if (shouldNotifyDelivery(status)) {
    deliveryAttempted = true
    try {
      const dres = await notifyProvideGoods({ APP_KEY, ENV_FLAG, token, outTradeNo })
      deliveryOk = isDeliverySuccess(dres)
      deliveryErrcode = dres && typeof dres.errcode !== 'undefined' ? Number(dres.errcode) : null
      deliveryErrmsg = (dres && (dres.errmsg || dres._raw)) || ''
      console.log('[vpayConfirm] notify_provide_goods result:', deliveryErrcode, 'order:', outTradeNo)
    } catch (e) {
      deliveryOk = false
      deliveryErrmsg = '' + e
      console.warn('[vpayConfirm] 发货确认异常(不阻断发权益):', e)
    }
  }

  if (deliveryOk && order && order._id) {
    await markDelivery(db, order, {
      deliveryStatus: 'delivered',
      deliveryErrcode,
      deliveryErrmsg,
      lastDeliveryAttemptTime: db.serverDate(),
      deliverTime: db.serverDate()
    }).catch((e) => console.warn('[vpayConfirm] update delivery status failed:', e))
  } else if (deliveryAttempted && order && order._id) {
    await markDelivery(db, order, {
      deliveryStatus: 'failed',
      deliveryErrcode,
      deliveryErrmsg,
      lastDeliveryAttemptTime: db.serverDate()
    }).catch((e) => console.warn('[vpayConfirm] update delivery status failed:', e))
  }

  return { deliveryAttempted, deliveryOk, deliveryErrcode, deliveryErrmsg }
}

async function repairDeliveries({ db, appid, APP_KEY, APP_SECRET, ENV_FLAG, scanLimit, processLimit }) {
  const token = await getAccessToken(appid, APP_SECRET)
  const res = await db
    .collection('orders')
    .where({ status: 'paid' })
    .orderBy('payTime', 'desc')
    .limit(scanLimit)
    .get()
  const scannedOrders = (res && res.data) || []
  const { candidates, selected: orders } = selectRepairDeliveryOrders(scannedOrders, processLimit)
  const results = []

  for (const order of orders) {
    const outTradeNo = order.outTradeNo
    if (!outTradeNo || !order.openid) {
      results.push({ outTradeNo: outTradeNo || '', ok: false, code: 'BAD_ORDER' })
      continue
    }
    try {
      const queryRes = await queryVirtualOrder({
        APP_KEY,
        ENV_FLAG,
        token,
        openid: order.openid,
        outTradeNo
      })
      const status = getQueryStatus(queryRes)
      if (typeof status === 'undefined') {
        results.push({ outTradeNo, ok: false, code: 'NO_STATUS' })
        continue
      }
      if (!isGrantablePaidStatus(status)) {
        results.push({ outTradeNo, ok: false, code: 'ORDER_NOT_GRANTABLE', orderStatus: Number(status) })
        continue
      }
      const delivery = await confirmDeliveryForOrder({
        db,
        order,
        status,
        APP_KEY,
        ENV_FLAG,
        token,
        outTradeNo
      })
      results.push({ outTradeNo, ok: delivery.deliveryOk, orderStatus: Number(status), ...delivery })
    } catch (err) {
      results.push({ outTradeNo, ok: false, code: err.code || 'REPAIR_FAIL', message: '' + err })
    }
  }

  return {
    scanned: scannedOrders.length,
    candidates: candidates.length,
    processed: orders.length,
    repaired: results.filter((item) => item.deliveryOk).length,
    failed: results.filter((item) => !item.deliveryOk).length,
    results
  }
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const callerOpenid = wxContext.OPENID
  const appid = normalizeConfigValue(wxContext.APPID) || normalizeConfigValue(process.env.WX_APP_ID)
  const now = Date.now()
  const action = event && event.action

  const db = cloud.database()

  if (action === 'repairDeliveries') {
    if (!isRepairAdmin(callerOpenid, process.env, event && event.repairToken)) {
      return { ok: false, code: 'UNAUTHORIZED', message: '无管理员权限' }
    }
    if (!appid) return { ok: false, code: 'NO_APPID' }
    let config
    try {
      config = getConfig()
    } catch (err) {
      return { ok: false, code: err.code || 'NO_CONFIG', message: err.message }
    }
    try {
      const scanLimit = Math.min(100, Math.max(1, Number((event && (event.scanLimit || event.limit)) || 50)))
      const processLimit = Math.min(5, Math.max(1, Number((event && event.processLimit) || 4)))
      const out = await repairDeliveries({ db, appid, scanLimit, processLimit, ...config })
      return { ok: true, serverTime: now, ...out }
    } catch (err) {
      return { ok: false, code: err.code || 'REPAIR_FAIL', message: '' + err, serverTime: now }
    }
  }

  const outTradeNo = event && event.outTradeNo
  if (!outTradeNo) return { ok: false, code: 'NO_ORDER' }

  let order = null
  try {
    const orderRes = await db.collection('orders').where({ outTradeNo }).get()
    order = orderRes.data && orderRes.data[0]
  } catch (e) {
    return { ok: false, code: 'ORDER_QUERY_FAIL', message: '' + e }
  }

  let targetOpenid
  try {
    targetOpenid = resolveTargetOpenid(order, callerOpenid)
  } catch (e) {
    return { ok: false, code: e.code || 'ORDER_OWNER_MISMATCH' }
  }
  if (!targetOpenid) return { ok: false, code: 'NO_OPENID' }
  if (!appid) return { ok: false, code: 'NO_APPID' }

  let config
  try {
    config = getConfig()
  } catch (err) {
    return { ok: false, code: err.code || 'NO_CONFIG', message: err.message }
  }
  const { APP_KEY, APP_SECRET, ENV_FLAG } = config

  // 1) access_token
  let token
  try {
    token = await getAccessToken(appid, APP_SECRET)
  } catch (e) {
    return { ok: false, code: e.code === 'NO_TOKEN' ? 'NO_TOKEN' : 'TOKEN_FAIL', message: '' + e, detail: e.detail }
  }

  // 2) 查单
  let queryRes
  try {
    queryRes = await queryVirtualOrder({ APP_KEY, ENV_FLAG, token, openid: targetOpenid, outTradeNo })
  } catch (e) {
    return { ok: false, code: 'QUERY_FAIL', message: '' + e }
  }
  const status = getQueryStatus(queryRes)
  if (typeof status === 'undefined') {
    console.warn('[vpayConfirm] query_order missing status:', outTradeNo)
    return { ok: false, code: 'NO_STATUS' }
  }
  console.log('[vpayConfirm] query_order status:', Number(status), 'order:', outTradeNo)
  if (Number(status) < 2) {
    return { ok: false, code: 'NOT_PAID', orderStatus: Number(status) }
  }
  if (!isGrantablePaidStatus(status)) {
    return { ok: false, code: 'ORDER_NOT_GRANTABLE', orderStatus: Number(status) }
  }

  // 3) 幂等发权益(以 orders 订单状态去重)
  const transactionId = getQueryTransactionId(queryRes)
  let notifyOrder = null // 仅本次「首次」发放才会被赋值,用于事务后实时播报
  try {
    await db.runTransaction(async (transaction) => {
      notifyOrder = null // 事务可能重试,以最后一次执行为准
      const orderRes = await transaction.collection('orders').where({ outTradeNo }).get()
      const txOrder = orderRes.data && orderRes.data[0]
      if (txOrder && txOrder.status === 'paid') return // 已发过

      const grant =
        (txOrder && PRODUCT_GRANT[txOrder.productId]) || (txOrder && txOrder.plan) || null
      if (!grant) throw { _ack: true }

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
      if (txOrder) {
        const orderUpdate = { status: 'paid', payTime: db.serverDate() }
        if (transactionId) orderUpdate.transactionId = transactionId
        await transaction.collection('orders').doc(txOrder._id).update({ data: orderUpdate })
        notifyOrder = {
          outTradeNo,
          openid: targetOpenid,
          plan: grant,
          productId: txOrder.productId,
          amountFen: Number(txOrder.amount || 0),
          paidAtMs: now
        }
      }
    })
  } catch (err) {
    if (!(err && err._ack)) {
      console.error('[vpayConfirm] grant fail:', err)
      return { ok: false, code: 'GRANT_FAIL', message: '' + err }
    }
  }

  // 4) 确认发货(status 2/3 均可能表示已支付但平台未确认发货),防微信自动退款
  const delivery = await confirmDeliveryForOrder({
    db,
    order,
    status,
    APP_KEY,
    ENV_FLAG,
    token,
    outTradeNo
  })

  // 4.5) 首次发放 → 实时播报(失败不影响结果)
  if (notifyOrder) {
    await sendPayNotify(process.env, notifyOrder).catch(() => {})
  }

  // 5) 返回最新权益
  const finalRes = await db.collection('users').doc(targetOpenid).get().catch(() => null)
  const ent = deriveEntitlement(finalRes && finalRes.data, now)
  return {
    ok: true,
    serverTime: now,
    orderStatus: Number(status),
    ...delivery,
    ...ent
  }
}
