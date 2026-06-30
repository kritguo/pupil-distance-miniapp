const DEFAULT_APP_ID = 'wxb70011e77b4c76fc'

const normalizeConfigValue = (value) => String(value || '').trim()

const resolveAppid = (wxContext, env) =>
  normalizeConfigValue(wxContext && wxContext.APPID) ||
  normalizeConfigValue(env && env.WX_APP_ID) ||
  DEFAULT_APP_ID

const readConfigStatus = (env, wxContext) => {
  const envRaw = normalizeConfigValue(env && env.VPAY_ENV)
  return {
    appid: resolveAppid(wxContext, env),
    hasWxAppIdEnv: !!normalizeConfigValue(env && env.WX_APP_ID),
    hasVpayAppKey: !!normalizeConfigValue(env && env.VPAY_APP_KEY),
    hasWxAppSecret: !!normalizeConfigValue(env && env.WX_APP_SECRET),
    hasVpayOfferId: !!normalizeConfigValue(env && env.VPAY_OFFER_ID),
    vpayEnvRaw: envRaw,
    vpayEnvValid: /^[01]$/.test(envRaw),
    vpayEnvFlag: /^[01]$/.test(envRaw) ? Number(envRaw) : null
  }
}

const buildJscode2SessionUrl = (appid, secret, code) => {
  const params = new URLSearchParams({
    appid: normalizeConfigValue(appid),
    secret: normalizeConfigValue(secret),
    js_code: normalizeConfigValue(code),
    grant_type: 'authorization_code'
  })
  return 'https://api.weixin.qq.com/sns/jscode2session?' + params.toString()
}

const SESSION_FAIL_HINTS = {
  40013: '小程序 AppID 不合法或为空',
  40029: 'wx.login code 无效，常见原因是 AppID、云开发环境或 AppSecret 不匹配',
  40125: 'WX_APP_SECRET 与当前小程序 AppID 不匹配',
  40164: '云函数出口 IP 不在微信公众平台接口 IP 白名单中',
  40163: 'wx.login code 已被使用，请重新进入页面后再支付'
}

const extractInvalidIp = (errmsg) => {
  const match = String(errmsg || '').match(/invalid ip\s+([0-9a-fA-F:.]+)/)
  return match ? match[1] : ''
}

const buildSessionFailResponse = (sessionResult) => {
  const rawCode = sessionResult && sessionResult.errcode
  const errcode = typeof rawCode === 'undefined' ? null : Number(rawCode)
  const errmsg = String((sessionResult && sessionResult.errmsg) || '').slice(0, 160)
  const invalidIp = errcode === 40164 ? extractInvalidIp(errmsg) : ''
  const hint =
    (Number.isFinite(errcode) && SESSION_FAIL_HINTS[errcode]) ||
    '微信登录态换取失败，请检查小程序 AppSecret、AppID 与云开发环境是否匹配'
  const suffix = Number.isFinite(errcode) ? `（微信返回 ${errcode}）` : ''
  const action = invalidIp
    ? `，本次出口 IP ${invalidIp}；若 IP 每次变化，请关闭 AppSecret IP 白名单或改用固定公网出口`
    : ''
  return {
    ok: false,
    code: 'SESSION_FAIL',
    message: hint + suffix + action,
    sessionErrcode: Number.isFinite(errcode) ? errcode : undefined,
    sessionErrmsg: errmsg || undefined,
    invalidIp: invalidIp || undefined
  }
}

module.exports = {
  DEFAULT_APP_ID,
  normalizeConfigValue,
  resolveAppid,
  readConfigStatus,
  buildJscode2SessionUrl,
  extractInvalidIp,
  buildSessionFailResponse
}
