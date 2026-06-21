const crypto = require('crypto')

const getQueryStatus = (queryRes) => {
  const raw =
    (queryRes && queryRes.status) ||
    (queryRes && queryRes.order_info && queryRes.order_info.status) ||
    (queryRes && queryRes.order && queryRes.order.status)
  return typeof raw === 'undefined' ? undefined : Number(raw)
}

const isDeliverySuccess = (res) => {
  if (!res || typeof res !== 'object') return false
  if (typeof res.errcode === 'undefined') return !res._raw
  return Number(res.errcode) === 0
}

const isGrantablePaidStatus = (status) => {
  const value = Number(status)
  return value === 2 || value === 3 || value === 4
}

const isDeliveredStatus = (status) => Number(status) === 4

const shouldNotifyDelivery = (status) => {
  const value = Number(status)
  return value === 2 || value === 3
}

const shouldRepairDeliveryOrder = (order) => {
  if (!order || order.status !== 'paid') return false
  return order.deliveryStatus !== 'delivered'
}

const selectRepairDeliveryOrders = (orders, processLimit) => {
  const candidates = (orders || []).filter(shouldRepairDeliveryOrder)
  const safeLimit = Math.min(20, Math.max(1, Number(processLimit) || 5))
  return {
    candidates,
    selected: candidates.slice(0, safeLimit)
  }
}

const parseAdminOpenids = (raw) =>
  String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const REPAIR_OWNER_OPENIDS = ['oxopu3T05C7hP6aF5bppFjvBQmeo']
const REPAIR_TOKEN_SHA256 = 'd9b0e6c3267fc49df70a814c0fcd96338d566e653995efebe887ee77abd77518'

const sha256 = (value) =>
  crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')

const isRepairAdmin = (openid, env, repairToken) => {
  const configured = parseAdminOpenids(env && env.ADMIN_OPENIDS)
  if (openid && (configured.indexOf(openid) !== -1 || REPAIR_OWNER_OPENIDS.indexOf(openid) !== -1)) {
    return true
  }
  if (!repairToken) return false
  const expectedHash = (env && env.ADMIN_REPAIR_TOKEN_SHA256) || REPAIR_TOKEN_SHA256
  return sha256(repairToken) === expectedHash
}

const resolveTargetOpenid = (order, callerOpenid) => {
  const orderOpenid = order && order.openid
  if (callerOpenid && orderOpenid && callerOpenid !== orderOpenid) {
    const err = new Error('ORDER_OWNER_MISMATCH')
    err.code = 'ORDER_OWNER_MISMATCH'
    throw err
  }
  return orderOpenid || callerOpenid || ''
}

// best-effort 取微信支付流水号:wx_payment_order_id 是首选(微信虚拟支付 query_order 的支付单号),
// 其余字段名各版本不一,仅作兜底,取到的值不保证就是微信支付流水号(可能是回显的 order_id),
// 仅供对账参考;取不到返回 ''。详见 docs 说明,上线后用真实 query_order 日志核对字段名再收敛。
const getQueryTransactionId = (queryRes) => {
  const info =
    (queryRes && queryRes.order_info) || (queryRes && queryRes.order) || queryRes || {}
  const raw =
    info.wx_payment_order_id ||
    info.transaction_id ||
    info.wx_order_id ||
    (queryRes && queryRes.transaction_id) ||
    (queryRes && queryRes.wx_payment_order_id) ||
    ''
  return raw ? String(raw) : ''
}

// 付费实时播报:渠道走环境变量,建好哪个填哪个,不配则不播报(永不阻断发权益)。
//   PAY_NOTIFY_WEBHOOK 完整 webhook URL;PAY_NOTIFY_TYPE 可选(wecom/serverchan/text),不填按域名自动识别。
const PAY_NOTIFY_WECOM_HOST = 'qyapi.weixin.qq.com'
const PAY_NOTIFY_SERVERCHAN_HOST = 'ftqq.com'

const resolvePayNotifyConfig = (env) => {
  const url = String((env && env.PAY_NOTIFY_WEBHOOK) || '').trim()
  if (!url) return null
  const explicit = String((env && env.PAY_NOTIFY_TYPE) || '').trim().toLowerCase()
  let type = explicit
  if (!type) {
    if (url.indexOf(PAY_NOTIFY_WECOM_HOST) !== -1) type = 'wecom'
    else if (url.indexOf(PAY_NOTIFY_SERVERCHAN_HOST) !== -1) type = 'serverchan'
    else type = 'text'
  }
  return { url, type }
}

const fenToYuan = (fen) => (Number(fen || 0) / 100).toFixed(2)

const pad2 = (value) => String(value).padStart(2, '0')

// 把毫秒格式化成中国时区(+8)的「MM-DD HH:mm」,纯函数便于单测。
const formatChinaTime = (ms) => {
  const t = Number(ms)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t + 8 * 60 * 60 * 1000)
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}

const payPlanLabel = (order) => {
  const plan = order && (order.plan || order.productId)
  if (plan === 'single' || plan === 'single_pack_3') return '单次测量'
  if (plan === 'annual' || plan === 'annual_member') return '年度会员'
  return String(plan || '未知套餐')
}

// 一条人话播报文本。openid 只露后 6 位,不泄露完整身份。
const buildPayNotifyText = (order) => {
  const o = order || {}
  const lines = [
    '💰 PDgo 新付费',
    `套餐：${payPlanLabel(o)}`,
    `金额：¥${fenToYuan(o.amountFen)}`,
    `订单：${o.outTradeNo || ''}`,
    `用户：…${String(o.openid || '').slice(-6)}`
  ]
  const time = formatChinaTime(o.paidAtMs)
  if (time) lines.push(`时间：${time}`)
  return lines.join('\n')
}

// 按渠道组 POST body(都走 application/json)。
const buildPayNotifyPayload = (config, text) => {
  const type = config && config.type
  if (type === 'wecom') {
    return JSON.stringify({ msgtype: 'text', text: { content: text } })
  }
  if (type === 'serverchan') {
    return JSON.stringify({ title: String(text).split('\n')[0], desp: text })
  }
  return JSON.stringify({ text })
}

// 播报编排(可测):post 由调用方注入(默认走 index.js 的 httpPostJson)。
// 契约:未配置 webhook 或发送失败,都只返回 {sent:false,...},绝不抛错——发权益主流程不受影响。
const deliverPayNotify = async ({ env, order, post }) => {
  const config = resolvePayNotifyConfig(env)
  if (!config) return { sent: false, reason: 'no_config' }
  try {
    const body = buildPayNotifyPayload(config, buildPayNotifyText(order))
    await post(config.url, body)
    return { sent: true }
  } catch (e) {
    return { sent: false, reason: 'send_error', error: '' + e }
  }
}

module.exports = {
  getQueryStatus,
  getQueryTransactionId,
  isDeliverySuccess,
  isDeliveredStatus,
  isGrantablePaidStatus,
  isRepairAdmin,
  resolveTargetOpenid,
  resolvePayNotifyConfig,
  buildPayNotifyText,
  buildPayNotifyPayload,
  deliverPayNotify,
  selectRepairDeliveryOrders,
  shouldNotifyDelivery,
  shouldRepairDeliveryOrder
}
