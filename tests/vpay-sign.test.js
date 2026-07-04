const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_APP_ID,
  normalizeConfigValue,
  resolveAppid,
  readConfigStatus,
  buildJscode2SessionUrl,
  extractInvalidIp,
  buildSessionFailResponse
} = require('../cloudfunctions/vpaySign/helpers.js')

test('vpaySign trims config values and falls back to the project appid', () => {
  assert.equal(normalizeConfigValue('  abc  '), 'abc')
  assert.equal(resolveAppid({ APPID: ' wx-from-context ' }, {}), 'wx-from-context')
  assert.equal(resolveAppid({}, { WX_APP_ID: ' wx-from-env ' }), 'wx-from-env')
  assert.equal(resolveAppid({}, {}), DEFAULT_APP_ID)
})

test('vpaySign exposes safe config diagnostics without secrets', () => {
  const status = readConfigStatus(
    {
      WX_APP_ID: ' wx-env ',
      VPAY_APP_KEY: ' key ',
      WX_APP_SECRET: ' secret ',
      VPAY_OFFER_ID: ' offer ',
      VPAY_ENV: ' 0 '
    },
    {}
  )
  assert.deepEqual(status, {
    appid: 'wx-env',
    hasWxAppIdEnv: true,
    hasVpayAppKey: true,
    hasWxAppSecret: true,
    hasVpayOfferId: true,
    vpayEnvRaw: '0',
    vpayEnvValid: true,
    vpayEnvFlag: 0
  })
})

test('vpaySign builds an encoded jscode2session url', () => {
  const url = buildJscode2SessionUrl('wx app', 'secret+value', 'code/with+chars')
  assert.match(url, /^https:\/\/api\.weixin\.qq\.com\/sns\/jscode2session\?/)
  assert.match(url, /appid=wx\+app/)
  assert.match(url, /secret=secret%2Bvalue/)
  assert.match(url, /js_code=code%2Fwith%2Bchars/)
  assert.match(url, /grant_type=authorization_code/)
})

test('vpaySign surfaces actionable session failure details', () => {
  const out = buildSessionFailResponse({
    errcode: 40125,
    errmsg: 'invalid appsecret rid: abc'
  })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'SESSION_FAIL')
  assert.equal(out.sessionErrcode, 40125)
  assert.match(out.message, /WX_APP_SECRET/)
  assert.match(out.message, /40125/)
})

test('vpaySign extracts 40164 invalid ip for whitelist setup', () => {
  const errmsg = 'invalid ip 43.136.12.34 ipv6 ::ffff:43.136.12.34, not in whitelist rid: abc'
  assert.equal(extractInvalidIp(errmsg), '43.136.12.34')
  const out = buildSessionFailResponse({ errcode: 40164, errmsg })
  assert.equal(out.invalidIp, '43.136.12.34')
  assert.match(out.message, /IP 白名单/)
  assert.match(out.message, /43\.136\.12\.34/)
})
