const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

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

// 单次套餐用户查看一条新结果时扣 1 次。
// 幂等：同一个 resultKey(结果时间戳) 只扣一次，避免重复查看重复扣费、也避免本地清缓存白嫖。
exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const now = Date.now()
  if (!openid) {
    return { ok: false, code: 'NO_OPENID', serverTime: now }
  }

  const resultKey = event && event.resultKey ? String(event.resultKey) : ''
  if (!resultKey) {
    return { ok: false, code: 'NO_RESULT_KEY', serverTime: now }
  }

  const db = cloud.database()
  try {
    let outcome = null
    await db.runTransaction(async (transaction) => {
      const userRes = await transaction.collection('users').doc(openid).get().catch(() => null)
      const user = userRes && userRes.data
      const ent = deriveEntitlement(user, now)

      // 年度会员不消耗次数
      if (ent.annualActive) {
        outcome = { ok: true, consumed: false, reason: 'annual', ...ent }
        return
      }
      // 已经为这条结果扣过 → 直接放行，不重复扣
      const consumed = (user && user.consumedResults) || []
      if (consumed.indexOf(resultKey) !== -1) {
        outcome = { ok: true, consumed: false, reason: 'already_unlocked', ...ent }
        return
      }
      // 还有剩余次数 → 扣 1
      if (ent.remainCount > 0) {
        const nextConsumed = consumed.concat([resultKey]).slice(-50)
        const nextRemain = ent.remainCount - 1
        await transaction.collection('users').doc(openid).update({
          data: {
            remainCount: nextRemain,
            consumedResults: nextConsumed,
            updateTime: db.serverDate()
          }
        })
        const after = deriveEntitlement(
          { ...user, remainCount: nextRemain, consumedResults: nextConsumed },
          now
        )
        outcome = { ok: true, consumed: true, reason: 'consumed', ...after }
        return
      }
      // 没有权限
      outcome = { ok: false, consumed: false, reason: 'no_quota', code: 'NO_QUOTA', ...ent }
    })
    return { serverTime: now, ...(outcome || { ok: false, code: 'UNKNOWN' }) }
  } catch (err) {
    return { ok: false, code: 'DB_FAIL', message: '' + err, serverTime: now }
  }
}
