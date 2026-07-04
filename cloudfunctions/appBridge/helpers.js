const crypto = require('crypto')

const normalizeConfigValue = (value) => String(value || '').trim()

// HTTP 网关会把 JSON 放在 event.body(字符串)；小程序内调试则直接是 event 字段
function parseBody(body) {
  if (!body) return {}
  if (typeof body === 'object') return body
  if (typeof body !== 'string') return {}
  try {
    return JSON.parse(body)
  } catch (e) {
    return {}
  }
}

function getEventValue(event, key, fallback) {
  if (event && typeof event[key] !== 'undefined') return event[key]
  const body = parseBody(event && event.body)
  if (typeof body[key] !== 'undefined') return body[key]
  const query = (event && event.queryStringParameters) || {}
  if (typeof query[key] !== 'undefined') return query[key]
  return fallback
}

// 用 App 端 WeChat OpenSDK 拿到的 code 换 access_token(+unionid)。secret 只存云函数环境变量。
function buildOAuthAccessTokenUrl(appid, secret, code) {
  const params = new URLSearchParams({
    appid: normalizeConfigValue(appid),
    secret: normalizeConfigValue(secret),
    code: normalizeConfigValue(code),
    grant_type: 'authorization_code'
  })
  return 'https://api.weixin.qq.com/sns/oauth2/access_token?' + params.toString()
}

// oauth 响应没带 unionid 时兜底查用户信息(绑定开放平台后该接口必带 unionid)
function buildUserInfoUrl(accessToken, openid) {
  const params = new URLSearchParams({
    access_token: normalizeConfigValue(accessToken),
    openid: normalizeConfigValue(openid)
  })
  return 'https://api.weixin.qq.com/sns/userinfo?' + params.toString()
}

function extractUnionid(res) {
  const raw = res && res.unionid
  return raw ? String(raw) : ''
}

// —— 无状态会话票据：HMAC(unionid + 过期时间)，App 登录后带着它查权益/核销 ——
const TOKEN_VERSION = 'v1'

function signBridgeToken({ unionid, expMs, secret }) {
  const payload = `${TOKEN_VERSION}.${Buffer.from(String(unionid), 'utf8').toString('base64url')}.${Number(expMs)}`
  const mac = crypto.createHmac('sha256', String(secret)).update(payload, 'utf8').digest('base64url')
  return `${payload}.${mac}`
}

function verifyBridgeToken(token, secret, nowMs) {
  const parts = String(token || '').split('.')
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return { ok: false, code: 'BAD_TOKEN' }
  const payload = parts.slice(0, 3).join('.')
  const expected = crypto.createHmac('sha256', String(secret)).update(payload, 'utf8').digest('base64url')
  const actual = parts[3]
  const left = Buffer.from(expected)
  const right = Buffer.from(String(actual))
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return { ok: false, code: 'BAD_TOKEN' }
  }
  const expMs = Number(parts[2])
  if (!Number.isFinite(expMs) || Number(nowMs) >= expMs) return { ok: false, code: 'TOKEN_EXPIRED' }
  let unionid = ''
  try {
    unionid = Buffer.from(parts[1], 'base64url').toString('utf8')
  } catch (e) {
    return { ok: false, code: 'BAD_TOKEN' }
  }
  if (!unionid) return { ok: false, code: 'BAD_TOKEN' }
  return { ok: true, unionid, expMs }
}

// 与 getEntitlement/consumeMeasure 同口径的权益视图(云函数彼此独立部署，各带一份)
function deriveEntitlement(user, now) {
  const remainCount = (user && user.remainCount) || 0
  const annualExpireAt = (user && user.annualExpireAt) || 0
  const totalSinglePurchased = (user && user.totalSinglePurchased) || 0
  const retestCredits = (user && user.retestCredits) || 0
  const annualActive = annualExpireAt > now
  let status = 'none'
  if (annualActive) status = 'unlimited'
  else if (remainCount > 0) status = 'single'
  else if (totalSinglePurchased > 0) status = 'single_used'
  return { status, remainCount, annualExpireAt, annualActive, isUnlimited: annualActive, retestCredits }
}

// App 核销一次深度测量的判定：会员放行不扣；有额度扣 1；同一 redeemKey 幂等。
function chooseRedeem({ ent, redeemKey, appRedeems }) {
  const redeemed = Array.isArray(appRedeems) ? appRedeems : []
  if (redeemKey && redeemed.indexOf(redeemKey) !== -1) return { type: 'already' }
  if (ent && ent.annualActive) return { type: 'annual' }
  if (ent && ent.retestCredits > 0) return { type: 'credit' }
  return { type: 'none' }
}

const maskId = (value) => `…${String(value || '').slice(-6)}`

module.exports = {
  buildOAuthAccessTokenUrl,
  buildUserInfoUrl,
  chooseRedeem,
  deriveEntitlement,
  extractUnionid,
  getEventValue,
  maskId,
  normalizeConfigValue,
  parseBody,
  signBridgeToken,
  verifyBridgeToken
}
