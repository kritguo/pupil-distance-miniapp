const cloud = require('wx-server-sdk')
const {
  authorizeAdminRequest,
  buildAuthStatus,
  formatPaidOrders,
  formatSummaryText,
  getDayRanges,
  parseBody,
  resolveRecentOrdersQuery,
  summarizeAdminStats
} = require('./helpers.js')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const PAGE_SIZE = 100
const MAX_SCAN = 2000

function getEventValue(event, key, fallback) {
  if (event && typeof event[key] !== 'undefined') return event[key]
  const query = (event && event.queryStringParameters) || {}
  if (typeof query[key] !== 'undefined') return query[key]
  const body = parseBody(event && event.body)
  if (typeof body[key] !== 'undefined') return body[key]
  return fallback
}

async function fetchAll(query, maxScan) {
  const max = maxScan || MAX_SCAN
  let skip = 0
  let rows = []

  try {
    while (rows.length < max) {
      const res = await query.skip(skip).limit(PAGE_SIZE).get()
      const data = (res && res.data) || []
      rows = rows.concat(data)
      if (data.length < PAGE_SIZE) break
      skip += PAGE_SIZE
    }
  } catch (err) {
    const raw = String((err && (err.errMsg || err.message)) || err || '')
    if (/collection.*not.*exist|collection.*not.*found|COLLECTION_NOT_EXIST/i.test(raw)) {
      return { rows: [], truncated: false, missingCollection: true }
    }
    throw err
  }

  return {
    rows: rows.slice(0, max),
    truncated: rows.length >= max
  }
}

function getMeasureEventKey(row) {
  if (!row) return ''
  if (row._id) return String(row._id)
  if (row.openid && row.sessionId) return `${row.openid}:${row.sessionId}`
  return ''
}

function mergeMeasureEvents(groups) {
  const rows = []
  const seen = new Set()
  const sourceGroups = groups || []

  sourceGroups.forEach((group) => {
    const groupRows = (group && group.rows) || []
    groupRows.forEach((row) => {
      const key = getMeasureEventKey(row)
      if (key && seen.has(key)) return
      if (key) seen.add(key)
      rows.push(row)
    })
  })

  return rows
}

// 订单明细:读现有 orders 集合(已支付),按支付时间倒序。鉴权复用 authorizeAdminRequest。
// 口径:since 过滤与排序都按 payTime。正常支付链路在发权益事务里必写 payTime(vpayConfirm),
// 故 paid 单都带 payTime;仅控制台手工补单可能缺 payTime,那种单不会出现在本明细里
// (但仍计入 stats 汇总,因 stats 的 orderPaidAt 有 payTime||updateTime||createTime 兜底)。
async function fetchRecentPaidOrders(event) {
  const db = cloud.database()
  const _ = db.command
  const { sinceMs, limit } = resolveRecentOrdersQuery({
    since: getEventValue(event || {}, 'since', null),
    limit: getEventValue(event || {}, 'limit', null)
  })
  const where =
    sinceMs === null
      ? { status: 'paid' }
      : { status: 'paid', payTime: _.gte(new Date(sinceMs)) }
  try {
    const res = await db
      .collection('orders')
      .where(where)
      .orderBy('payTime', 'desc')
      .limit(limit)
      .get()
    const rows = (res && res.data) || []
    return {
      ok: true,
      count: rows.length,
      limit,
      since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
      orders: formatPaidOrders(rows)
    }
  } catch (err) {
    const raw = String((err && (err.errMsg || err.message)) || err || '')
    if (/collection.*not.*exist|collection.*not.*found|COLLECTION_NOT_EXIST/i.test(raw)) {
      return { ok: true, count: 0, limit, orders: [] }
    }
    console.error('[adminStats] getRecentPaidOrders failed:', err)
    return { ok: false, code: 'DB_FAIL', message: '' + err }
  }
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const action = getEventValue(event || {}, 'action', 'stats')

  if (action === 'auth') {
    return buildAuthStatus({ openid, env: process.env })
  }

  const auth = authorizeAdminRequest({ event: event || {}, openid, env: process.env })
  if (!auth.authorized) {
    return { ok: false, code: 'UNAUTHORIZED', message: '无管理员权限' }
  }

  if (action === 'getRecentPaidOrders') {
    return fetchRecentPaidOrders(event || {})
  }

  const now = Date.now()
  const days = Math.min(30, Math.max(1, Number(getEventValue(event || {}, 'days', 7))))
  const ranges = getDayRanges({ now, days })
  const startDate = new Date(ranges[0].startMs)
  const endDate = new Date(ranges[ranges.length - 1].endMs)
  const startMs = ranges[0].startMs
  const endMs = ranges[ranges.length - 1].endMs

  const db = cloud.database()
  const _ = db.command
  try {
    const [measureDateRes, measureMsRes, orderRes, userRes] = await Promise.all([
      fetchAll(
        db.collection('measureEvents').where({
          createTime: _.gte(startDate).and(_.lt(endDate))
        })
      ),
      fetchAll(
        db.collection('measureEvents').where({
          createTimeMs: _.gte(startMs).and(_.lt(endMs))
        })
      ),
      fetchAll(
        db.collection('orders').where({
          status: 'paid',
          payTime: _.gte(startDate).and(_.lt(endDate))
        })
      ),
      fetchAll(db.collection('users'))
    ])

    const stats = summarizeAdminStats({
      now,
      days,
      measureEvents: mergeMeasureEvents([measureDateRes, measureMsRes]),
      orders: orderRes.rows,
      users: userRes.rows
    })
    const truncated = measureDateRes.truncated || measureMsRes.truncated || orderRes.truncated || userRes.truncated

    return {
      ok: true,
      authType: auth.authType,
      isAdmin: auth.isAdmin,
      apiEnabled: !!process.env.ADMIN_API_TOKEN,
      truncated,
      summaryText: formatSummaryText(stats),
      ...stats
    }
  } catch (err) {
    console.error('[adminStats] query failed:', err)
    return { ok: false, code: 'DB_FAIL', message: '' + err }
  }
}
