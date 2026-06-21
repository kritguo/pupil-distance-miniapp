const crypto = require('crypto')

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_OFFSET_MINUTES = 8 * 60

function parseAdminOpenids(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function isAdminOpenid(openid, raw) {
  if (!openid) return false
  return parseAdminOpenids(raw).indexOf(String(openid)) !== -1
}

function parseBody(body) {
  if (!body) return {}
  if (typeof body === 'object') return body
  if (typeof body !== 'string') return {}
  try {
    return JSON.parse(body)
  } catch (e) {
    return body
      .split('&')
      .map((pair) => pair.split('='))
      .reduce((acc, pair) => {
        if (!pair[0]) return acc
        acc[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1] || '')
        return acc
      }, {})
  }
}

function getHeader(headers, name) {
  if (!headers || !name) return ''
  const target = String(name).toLowerCase()
  const key = Object.keys(headers).find((item) => String(item).toLowerCase() === target)
  return key ? String(headers[key] || '').trim() : ''
}

function extractBearer(value) {
  const text = String(value || '').trim()
  const match = /^Bearer\s+(.+)$/i.exec(text)
  return match ? match[1].trim() : ''
}

function extractApiToken(event) {
  const headers = (event && (event.headers || event.header)) || {}
  const authToken = extractBearer(getHeader(headers, 'authorization'))
  if (authToken) return authToken

  const headerToken = getHeader(headers, 'x-admin-token')
  if (headerToken) return headerToken

  if (event && event.token) return String(event.token)
  if (event && event.apiToken) return String(event.apiToken)

  const query = (event && event.queryStringParameters) || {}
  if (query.token) return String(query.token)
  if (query.apiToken) return String(query.apiToken)

  const body = parseBody(event && event.body)
  if (body.token) return String(body.token)
  if (body.apiToken) return String(body.apiToken)
  return ''
}

function safeTokenEqual(expected, actual) {
  if (!expected || !actual) return false
  const left = Buffer.from(String(expected))
  const right = Buffer.from(String(actual))
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function authorizeAdminRequest({ event, openid, env }) {
  const sourceEnv = env || process.env
  if (isAdminOpenid(openid, sourceEnv.ADMIN_OPENIDS)) {
    return { authorized: true, authType: 'openid', isAdmin: true }
  }

  const expectedToken = sourceEnv.ADMIN_API_TOKEN || ''
  const actualToken = extractApiToken(event || {})
  if (safeTokenEqual(expectedToken, actualToken)) {
    return { authorized: true, authType: 'api_token', isAdmin: false }
  }

  return { authorized: false, authType: 'none', isAdmin: false }
}

function buildAuthStatus({ openid, env }) {
  const sourceEnv = env || process.env
  return {
    ok: true,
    openid: openid || '',
    isAdmin: isAdminOpenid(openid, sourceEnv.ADMIN_OPENIDS),
    configured: parseAdminOpenids(sourceEnv.ADMIN_OPENIDS).length > 0,
    apiEnabled: !!sourceEnv.ADMIN_API_TOKEN
  }
}

function toTimestamp(value) {
  if (!value && value !== 0) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date) {
    const ts = value.getTime()
    return Number.isFinite(ts) ? ts : null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function formatLocalDate(ms, offsetMinutes) {
  const local = new Date(ms + offsetMinutes * 60 * 1000)
  return `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}`
}

function getDayRanges(options) {
  const opts = options || {}
  const days = Math.max(1, Number(opts.days || 7))
  const offsetMinutes = Number.isFinite(opts.offsetMinutes)
    ? opts.offsetMinutes
    : DEFAULT_OFFSET_MINUTES
  const now = toTimestamp(opts.now || Date.now())
  const offsetMs = offsetMinutes * 60 * 1000
  const todayStart = Math.floor((now + offsetMs) / DAY_MS) * DAY_MS - offsetMs
  const ranges = []

  for (let i = days - 1; i >= 0; i -= 1) {
    const startMs = todayStart - i * DAY_MS
    const endMs = startMs + DAY_MS
    ranges.push({
      date: formatLocalDate(startMs, offsetMinutes),
      label: formatLocalDate(startMs, offsetMinutes).slice(5),
      startMs,
      endMs
    })
  }
  return ranges
}

function newModeCounts() {
  return { normal: 0, precision: 0, unknown: 0 }
}

function newSourceCounts() {
  return { trial: 0, free_quota: 0, paid: 0, annual: 0, forced_purchase: 0, unknown: 0 }
}

function normalizeMode(mode) {
  if (mode === 'normal' || mode === 'precision') return mode
  return 'unknown'
}

function normalizeSource(source) {
  if (['trial', 'free_quota', 'paid', 'annual', 'forced_purchase'].indexOf(source) !== -1) {
    return source
  }
  return 'unknown'
}

function isDeliveryPending(order) {
  return !!(order && order.status === 'paid' && order.deliveryStatus !== 'delivered')
}

function createBucket(range) {
  return {
    date: range.date,
    label: range.label,
    measurementOpenids: new Set(),
    payerOpenids: new Set(),
    measurementSessions: 0,
    paidOrders: 0,
    revenueFen: 0,
    newUsers: 0,
    modeCounts: newModeCounts(),
    sourceCounts: newSourceCounts()
  }
}

function findBucketIndex(ranges, timestamp) {
  if (timestamp === null) return -1
  return ranges.findIndex((range) => timestamp >= range.startMs && timestamp < range.endMs)
}

function orderPaidAt(order) {
  return toTimestamp(order && (order.payTime || order.updateTime || order.createTime))
}

function eventCreatedAt(event) {
  return toTimestamp(event && (event.createTime || event.createTimeMs || event.eventTime || event.resultTimestamp))
}

function summarizeAdminStats(input) {
  const data = input || {}
  const now = toTimestamp(data.now || Date.now())
  const ranges = getDayRanges({
    now,
    days: data.days || 7,
    offsetMinutes: Number.isFinite(data.offsetMinutes) ? data.offsetMinutes : DEFAULT_OFFSET_MINUTES
  })
  const buckets = ranges.map(createBucket)
  const todayBucket = buckets[buckets.length - 1]

  const orders = Array.isArray(data.orders) ? data.orders : []
  const measureEvents = Array.isArray(data.measureEvents) ? data.measureEvents : []
  const users = Array.isArray(data.users) ? data.users : []

  let totalPaidOrders = 0
  let totalRevenueFen = 0
  let totalDeliveryPending = 0
  orders.forEach((order) => {
    if (!order || order.status !== 'paid') return
    totalPaidOrders += 1
    totalRevenueFen += Number(order.amount || 0)
    if (isDeliveryPending(order)) totalDeliveryPending += 1
    const idx = findBucketIndex(ranges, orderPaidAt(order))
    if (idx < 0) return
    const bucket = buckets[idx]
    bucket.paidOrders += 1
    bucket.revenueFen += Number(order.amount || 0)
    if (isDeliveryPending(order)) bucket.deliveryPending = (bucket.deliveryPending || 0) + 1
    if (order.openid) bucket.payerOpenids.add(order.openid)
  })

  measureEvents.forEach((event) => {
    const idx = findBucketIndex(ranges, eventCreatedAt(event))
    if (idx < 0) return
    const bucket = buckets[idx]
    bucket.measurementSessions += 1
    if (event.openid) bucket.measurementOpenids.add(event.openid)
    bucket.modeCounts[normalizeMode(event.mode)] += 1
    bucket.sourceCounts[normalizeSource(event.quotaSource)] += 1
  })

  users.forEach((user) => {
    const idx = findBucketIndex(ranges, toTimestamp(user && user.createTime))
    if (idx < 0) return
    buckets[idx].newUsers += 1
  })

  const today = {
    measurementUsers: todayBucket.measurementOpenids.size,
    measurementSessions: todayBucket.measurementSessions,
    paidUsers: todayBucket.payerOpenids.size,
    paidOrders: todayBucket.paidOrders,
    revenueFen: todayBucket.revenueFen,
    revenueYuan: Number((todayBucket.revenueFen / 100).toFixed(2)),
    newUsers: todayBucket.newUsers,
    deliveryPending: todayBucket.deliveryPending || 0,
    modeCounts: todayBucket.modeCounts,
    sourceCounts: todayBucket.sourceCounts
  }

  return {
    generatedAt: now,
    day: ranges[ranges.length - 1],
    today,
    totals: {
      users: users.length,
      annualUsers: users.filter((user) => toTimestamp(user.annualExpireAt) > now).length,
      singlePurchasedUsers: users.filter((user) => Number(user.totalSinglePurchased || 0) > 0).length,
      paidOrders: totalPaidOrders,
      revenueFen: totalRevenueFen,
      deliveryPending: totalDeliveryPending,
      measurementSessions: measureEvents.length
    },
    trend: buckets.map((bucket) => ({
      date: bucket.date,
      label: bucket.label,
      measurementUsers: bucket.measurementOpenids.size,
      measurementSessions: bucket.measurementSessions,
      paidUsers: bucket.payerOpenids.size,
      paidOrders: bucket.paidOrders,
      revenueFen: bucket.revenueFen,
      newUsers: bucket.newUsers,
      deliveryPending: bucket.deliveryPending || 0
    }))
  }
}

const RECENT_ORDERS_DEFAULT_LIMIT = 50
const RECENT_ORDERS_MAX_LIMIT = 200

// 解析订单明细查询参数:since 支持 ISO 字符串或毫秒;limit 夹在 [1,200]。
function resolveRecentOrdersQuery(options) {
  const opts = options || {}
  const raw = Number(opts.limit)
  const limit =
    Number.isFinite(raw) && raw > 0
      ? Math.min(RECENT_ORDERS_MAX_LIMIT, Math.floor(raw))
      : RECENT_ORDERS_DEFAULT_LIMIT
  const sinceMs = toTimestamp(opts.since)
  return { sinceMs, limit }
}

// 把一条 orders 文档整理成对外订单 DTO(金额给分也给元,时间给 ISO 也给毫秒)。
function formatPaidOrder(order) {
  const o = order || {}
  const amountFen = Number(o.amount || 0)
  const paidMs = orderPaidAt(o)
  return {
    orderId: o._id ? String(o._id) : '',
    outTradeNo: o.outTradeNo || '',
    transactionId: o.transactionId || '',
    amountFen,
    amountYuan: Number((amountFen / 100).toFixed(2)),
    status: o.status || '',
    plan: o.plan || '',
    productId: o.productId || '',
    channel: o.channel || '',
    openid: o.openid || '',
    paidAt: paidMs === null ? null : new Date(paidMs).toISOString(),
    paidAtMs: paidMs,
    deliveryStatus: o.deliveryStatus || (o.status === 'paid' ? 'pending' : ''),
    createTimeMs: toTimestamp(o.createTime)
  }
}

function formatPaidOrders(rows) {
  return (rows || []).map(formatPaidOrder)
}

function formatMoneyFen(fen) {
  return (Number(fen || 0) / 100).toFixed(2)
}

function formatSummaryText(stats) {
  const today = (stats && stats.today) || {}
  const modeCounts = today.modeCounts || newModeCounts()
  const date = stats && stats.day ? stats.day.date : ''
  return [
    `【PDgo ${date} 数据】`,
    `测量：${today.measurementUsers || 0}人/${today.measurementSessions || 0}次`,
    `付费：${today.paidUsers || 0}人/${today.paidOrders || 0}单/${formatMoneyFen(today.revenueFen)}元`,
    `模式：普通${modeCounts.normal || 0} / 精确${modeCounts.precision || 0}`
  ].join('\n')
}

module.exports = {
  authorizeAdminRequest,
  buildAuthStatus,
  extractApiToken,
  formatPaidOrder,
  formatPaidOrders,
  formatSummaryText,
  getDayRanges,
  isAdminOpenid,
  parseAdminOpenids,
  parseBody,
  resolveRecentOrdersQuery,
  summarizeAdminStats,
  isDeliveryPending,
  toTimestamp
}
