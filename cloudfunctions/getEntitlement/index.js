const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 根据 users 文档计算对外的权益状态
const deriveEntitlement = (user, now) => {
  const remainCount = (user && user.remainCount) || 0
  const annualExpireAt = (user && user.annualExpireAt) || 0
  const totalSinglePurchased = (user && user.totalSinglePurchased) || 0
  const annualActive = annualExpireAt > now

  let status = 'none'
  if (annualActive) {
    status = 'unlimited'
  } else if (remainCount > 0) {
    status = 'single'
  } else if (totalSinglePurchased > 0) {
    status = 'single_used'
  }

  return {
    status,
    remainCount,
    annualExpireAt,
    annualActive,
    isUnlimited: annualActive
  }
}

exports.main = async () => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const now = Date.now()
  if (!openid) {
    return { ok: false, code: 'NO_OPENID', serverTime: now }
  }

  const db = cloud.database()
  try {
    const res = await db.collection('users').doc(openid).get().catch(() => null)
    const user = res && res.data
    const ent = deriveEntitlement(user, now)
    return { ok: true, serverTime: now, ...ent }
  } catch (err) {
    return { ok: false, code: 'DB_FAIL', message: '' + err, serverTime: now }
  }
}
