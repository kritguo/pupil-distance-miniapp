// App 权益桥：PDgo iOS App 用微信登录 code 换权益视图，并核销免费深度测量额度。
// 调用方式：HTTP 网关路由 /appBridge（POST JSON），也兼容云函数直调。
//
// 需在「配置 → 环境变量」配置：
//   OPEN_APP_ID           微信开放平台「移动应用」AppID（不是小程序 AppID）
//   OPEN_APP_SECRET       移动应用 AppSecret
//   BRIDGE_SESSION_SECRET 会话票据签名密钥（32 位以上随机串）
//
// 前提：小程序与 App 绑定到同一个微信开放平台账号（否则拿不到同源 unionid，接口休眠）。
// actions：
//   login        { code }                    → { ok, bridgeToken, expiresAt, ...entitlement }
//   entitlement  { bridgeToken }             → { ok, ...entitlement }
//   redeemRetest { bridgeToken, redeemKey }  → { ok, redeemed, reason, ...entitlement }

const cloud = require('wx-server-sdk')
const https = require('https')
const {
  buildOAuthAccessTokenUrl,
  buildUserInfoUrl,
  chooseRedeem,
  deriveEntitlement,
  extractUnionid,
  getEventValue,
  maskId,
  normalizeConfigValue,
  signBridgeToken,
  verifyBridgeToken
} = require('./helpers.js')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000
const REDEEM_KEEP = 50

const httpGetJson = (url) =>
  new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
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
    req.setTimeout(8000, () => req.destroy(new Error('WX_OAUTH_TIMEOUT')))
    req.on('error', reject)
  })

const getConfig = () => {
  const appid = normalizeConfigValue(process.env.OPEN_APP_ID)
  const secret = normalizeConfigValue(process.env.OPEN_APP_SECRET)
  const sessionSecret = normalizeConfigValue(process.env.BRIDGE_SESSION_SECRET)
  if (!appid || !secret || !sessionSecret) return null
  return { appid, secret, sessionSecret }
}

async function findUserByUnionid(db, unionid) {
  const res = await db.collection('users').where({ unionid }).limit(1).get()
  return (res && res.data && res.data[0]) || null
}

// code → unionid（oauth 响应优先；没带则 sns/userinfo 兜底）
async function resolveUnionidByCode(config, code) {
  const oauth = await httpGetJson(buildOAuthAccessTokenUrl(config.appid, config.secret, code))
  if (oauth && oauth.errcode) {
    return { ok: false, code: 'WX_OAUTH_FAIL', errcode: Number(oauth.errcode), errmsg: String(oauth.errmsg || '').slice(0, 120) }
  }
  let unionid = extractUnionid(oauth)
  if (!unionid && oauth && oauth.access_token && oauth.openid) {
    const info = await httpGetJson(buildUserInfoUrl(oauth.access_token, oauth.openid)).catch(() => null)
    unionid = extractUnionid(info)
  }
  if (!unionid) return { ok: false, code: 'NO_UNIONID', message: 'App 未绑定开放平台或授权未返回 unionid' }
  return { ok: true, unionid }
}

async function handleLogin(db, config, event, now) {
  const code = normalizeConfigValue(getEventValue(event, 'code', ''))
  if (!code) return { ok: false, code: 'NO_CODE' }

  const resolved = await resolveUnionidByCode(config, code)
  if (!resolved.ok) return resolved

  const user = await findUserByUnionid(db, resolved.unionid)
  if (!user) {
    // 云端还没有这个 unionid：多半是用户没用「绑定开放平台后的新版小程序」打开过
    console.log('[appBridge] login NOT_LINKED:', maskId(resolved.unionid))
    return { ok: false, code: 'NOT_LINKED', message: '请先在微信里打开 PDgo 小程序，再回到 App 登录' }
  }

  const expiresAt = now + TOKEN_TTL_MS
  const bridgeToken = signBridgeToken({ unionid: resolved.unionid, expMs: expiresAt, secret: config.sessionSecret })
  console.log('[appBridge] login ok:', maskId(resolved.unionid))
  return { ok: true, bridgeToken, expiresAt, ...deriveEntitlement(user, now) }
}

async function handleEntitlement(db, config, event, now) {
  const token = verifyBridgeToken(getEventValue(event, 'bridgeToken', ''), config.sessionSecret, now)
  if (!token.ok) return { ok: false, code: token.code }
  const user = await findUserByUnionid(db, token.unionid)
  if (!user) return { ok: false, code: 'NOT_LINKED' }
  return { ok: true, ...deriveEntitlement(user, now) }
}

async function handleRedeemRetest(db, config, event, now) {
  const token = verifyBridgeToken(getEventValue(event, 'bridgeToken', ''), config.sessionSecret, now)
  if (!token.ok) return { ok: false, code: token.code }
  const redeemKey = normalizeConfigValue(getEventValue(event, 'redeemKey', ''))
  if (!redeemKey) return { ok: false, code: 'NO_REDEEM_KEY' }

  const user = await findUserByUnionid(db, token.unionid)
  if (!user || !user._id) return { ok: false, code: 'NOT_LINKED' }

  let outcome = null
  await db.runTransaction(async (transaction) => {
    const fresh = await transaction.collection('users').doc(user._id).get().catch(() => null)
    const doc = fresh && fresh.data
    if (!doc) {
      outcome = { ok: false, code: 'NOT_LINKED' }
      return
    }
    const ent = deriveEntitlement(doc, now)
    const appRedeems = doc.appRedeems || []
    const decision = chooseRedeem({ ent, redeemKey, appRedeems })

    if (decision.type === 'already') {
      outcome = { ok: true, redeemed: false, reason: 'already_redeemed', ...ent }
      return
    }
    if (decision.type === 'none') {
      outcome = { ok: false, redeemed: false, code: 'NO_QUOTA', ...ent }
      return
    }
    const nextRedeems = appRedeems.concat([redeemKey]).slice(-REDEEM_KEEP)
    const patch = { appRedeems: nextRedeems, updateTime: db.serverDate() }
    if (decision.type === 'credit') patch.retestCredits = ent.retestCredits - 1
    await transaction.collection('users').doc(user._id).update({ data: patch })
    const after = deriveEntitlement({ ...doc, ...patch }, now)
    outcome = {
      ok: true,
      redeemed: true,
      reason: decision.type === 'annual' ? 'annual' : 'retest_credit',
      ...after
    }
  })
  console.log('[appBridge] redeem:', maskId(token.unionid), (outcome && (outcome.reason || outcome.code)) || 'unknown')
  return outcome || { ok: false, code: 'UNKNOWN' }
}

exports.main = async (event) => {
  const now = Date.now()
  const config = getConfig()
  if (!config) {
    return { ok: false, code: 'NO_CONFIG', message: '环境变量未配置(OPEN_APP_ID/OPEN_APP_SECRET/BRIDGE_SESSION_SECRET)' }
  }
  const action = String(getEventValue(event || {}, 'action', '') || '')
  const db = cloud.database()

  try {
    if (action === 'login') return await handleLogin(db, config, event || {}, now)
    if (action === 'entitlement') return await handleEntitlement(db, config, event || {}, now)
    if (action === 'redeemRetest') return await handleRedeemRetest(db, config, event || {}, now)
    return { ok: false, code: 'BAD_ACTION' }
  } catch (err) {
    console.error('[appBridge] failed:', action, err)
    return { ok: false, code: 'BRIDGE_FAIL', message: '' + err, serverTime: now }
  }
}
