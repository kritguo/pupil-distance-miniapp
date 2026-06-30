// 虚拟支付签名云函数
// 前端 wx.login 拿 code 调本函数 → 返回 requestVirtualPayment 所需的 signData/paySig/signature。
// 安全:appKey / AppSecret / offerId 全部走环境变量,绝不下发前端。
//
// 需要在云函数「配置 → 环境变量」里配置:
//   VPAY_APP_KEY   虚拟支付 appKey(基本配置,分沙箱/现网,先用沙箱)
//   VPAY_OFFER_ID  虚拟支付二级商户号 offerId
//   WX_APP_SECRET  小程序 AppSecret(用 code 换 sessionKey)
//   VPAY_ENV       1=沙箱 / 0=现网(iOS 强制 0)。上线前必须显式配置。
//   WX_APP_ID      可选兜底。云函数上下文没有 APPID 时使用。

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const https = require('https')
const {
  normalizeConfigValue,
  resolveAppid,
  readConfigStatus,
  buildJscode2SessionUrl,
  buildSessionFailResponse
} = require('./helpers.js')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 套餐 → 道具ID + 价格(分) + 发放类型。道具ID 必须与虚拟支付后台「道具管理」里一致。
const PRODUCTS = {
  single: { productId: 'single_pack_3', price: 990, grant: 'single' },
  annual: { productId: 'annual_member', price: 1990, grant: 'annual' }
}

const hmacHex = (key, data) =>
  crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex')

const VPAY_SIGN_BUILD = '2026-06-30-session-diagnostics-v2'

const httpGetText = (url) =>
  new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let buf = ''
      res.on('data', (c) => (buf += c))
      res.on('end', () => resolve(buf))
    })
    req.setTimeout(2500, () => req.destroy(new Error('TIMEOUT')))
    req.on('error', reject)
  })

async function fetchEgressIp() {
  const urls = [
    'https://api.ipify.org?format=json',
    'https://checkip.amazonaws.com'
  ]
  for (const url of urls) {
    try {
      const text = await httpGetText(url)
      const json = text && text.trim().startsWith('{') ? JSON.parse(text) : null
      const ip = (json && json.ip) || String(text || '').trim()
      if (/^[0-9a-fA-F:.]+$/.test(ip)) return ip
    } catch (e) {
      // try next endpoint
    }
  }
  return ''
}

// wx.login 的 code 换 openid + session_key
const jscode2session = (appid, secret, code) =>
  new Promise((resolve, reject) => {
    const url = buildJscode2SessionUrl(appid, secret, code)
    https
      .get(url, (res) => {
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
      .on('error', reject)
  })

const genOutTradeNo = (openid) => {
  const ts = Date.now()
  const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0')
  return `vp${ts}${rand}${(openid || '').slice(-6)}`
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const action = event && event.action
  if (action === 'diagnose') {
    const egressIp = await fetchEgressIp()
    return {
      ok: true,
      code: 'VPAY_SIGN_DIAGNOSE',
      build: VPAY_SIGN_BUILD,
      serverTime: Date.now(),
      cloudEnv: wxContext.ENV || '',
      openidPresent: !!wxContext.OPENID,
      egressIp,
      ...readConfigStatus(process.env, wxContext)
    }
  }

  const openid = wxContext.OPENID
  const appid = resolveAppid(wxContext, process.env)
  if (!openid) return { ok: false, code: 'NO_OPENID' }
  if (!appid) return { ok: false, code: 'NO_APPID', message: '缺少小程序 AppID' }

  const plan = event && event.plan
  const product = PRODUCTS[plan]
  if (!product) return { ok: false, code: 'BAD_PLAN', message: '套餐不存在' }

  const code = event && event.code
  if (!code) return { ok: false, code: 'NO_CODE', message: '缺少登录 code' }

  const APP_KEY = normalizeConfigValue(process.env.VPAY_APP_KEY)
  const APP_SECRET = normalizeConfigValue(process.env.WX_APP_SECRET)
  const OFFER_ID = normalizeConfigValue(process.env.VPAY_OFFER_ID)
  const ENV_RAW = normalizeConfigValue(process.env.VPAY_ENV)
  const ENV_FLAG = Number(ENV_RAW)
  if (!APP_KEY || !APP_SECRET || !OFFER_ID || !/^[01]$/.test(String(ENV_RAW))) {
    return { ok: false, code: 'NO_CONFIG', message: '云函数环境变量未配置或不合法(VPAY_APP_KEY/WX_APP_SECRET/VPAY_OFFER_ID/VPAY_ENV)' }
  }

  // 1) 换 sessionKey
  let sess
  try {
    sess = await jscode2session(appid, APP_SECRET, code)
  } catch (e) {
    return { ok: false, code: 'SESSION_FAIL', message: '微信登录态换取请求失败：' + e }
  }
  if (!sess || !sess.session_key) {
    const out = buildSessionFailResponse(sess)
    console.warn('[vpaySign] jscode2session failed:', out.sessionErrcode, out.sessionErrmsg)
    return out
  }
  const sessionKey = sess.session_key

  // 2) 落 pending 订单(对账 + 发货回调/查单时定位)
  const outTradeNo = genOutTradeNo(openid)
  const db = cloud.database()
  try {
    await db.collection('orders').add({
      data: {
        outTradeNo,
        openid,
        plan,
        productId: product.productId,
        amount: product.price,
        status: 'pending',
        channel: 'virtual',
        createTime: db.serverDate(),
        payTime: null
      }
    })
  } catch (e) {
    return { ok: false, code: 'DB_FAIL', message: '创建订单失败:' + e }
  }

  // 3) 组 signData(签名与下发必须是同一字符串)
  const signObj = {
    offerId: OFFER_ID,
    buyQuantity: 1,
    env: ENV_FLAG,
    currencyType: 'CNY',
    productId: product.productId,
    goodsPrice: product.price,
    outTradeNo,
    attach: plan
  }
  const signData = JSON.stringify(signObj)
  const paySig = hmacHex(APP_KEY, 'requestVirtualPayment&' + signData)
  const signature = hmacHex(sessionKey, signData)

  return {
    ok: true,
    mode: 'short_series_goods',
    signData,
    paySig,
    signature,
    env: ENV_FLAG,
    outTradeNo
  }
}
