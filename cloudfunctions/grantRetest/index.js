const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 发放「免费精度复测额度」：客户端可为一条【已付费解锁】的结果发 1 个额度。
// 该额度会被 consumeMeasure 在下次测量时优先使用（不扣 remainCount）。
// 产品口径：
//   - 普通首测付费解锁后：赠送 1 次精度复测。
//   - 精度复测仍中/低：继续发精度复测额度，直到测出「高」。
// 相当于 ¥9.9 保证一个可用且用户认可的结果。
// 防滥用：
//   - 只给已在 consumedResults 里的结果发（必须是真付费/解锁过的）；
//   - 同一 resultKey 只发一次（creditGrantedResults 去重，幂等），避免同一结果重复发额度。
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
      if (!user) {
        outcome = { ok: false, reason: 'no_user' }
        return
      }
      const consumed = user.consumedResults || []
      const granted = user.creditGrantedResults || []
      const retestCredits = user.retestCredits || 0

      // 必须是已解锁(付费/额度)的结果
      if (consumed.indexOf(resultKey) === -1) {
        outcome = { ok: false, reason: 'not_unlocked', retestCredits }
        return
      }
      // 已为该结果发过额度 → 幂等返回
      if (granted.indexOf(resultKey) !== -1) {
        outcome = { ok: true, granted: false, reason: 'already_granted', retestCredits }
        return
      }
      const nextGranted = granted.concat([resultKey]).slice(-50)
      const nextCredits = retestCredits + 1
      await transaction.collection('users').doc(openid).update({
        data: {
          retestCredits: nextCredits,
          creditGrantedResults: nextGranted,
          updateTime: db.serverDate()
        }
      })
      outcome = { ok: true, granted: true, reason: 'granted', retestCredits: nextCredits }
    })
    return { serverTime: now, ...(outcome || { ok: false, code: 'UNKNOWN' }) }
  } catch (err) {
    return { ok: false, code: 'DB_FAIL', message: '' + err, serverTime: now }
  }
}
