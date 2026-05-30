// 虚拟支付签名云函数
// 前端 wx.login 拿 code 调本函数 → 返回 requestVirtualPayment 所需的 signData/paySig/signature。
// 安全:appKey / AppSecret / offerId 全部走环境变量,绝不下发前端。
//
// 需要在云函数「配置 → 环境变量」里配置:
//   VPAY_APP_KEY   虚拟支付 appKey(基本配置,分沙箱/现网,先用沙箱)
//   VPAY_OFFER_ID  虚拟支付二级商户号 offerId
//   WX_APP_SECRET  小程序 AppSecret(用 code 换 sessionKey)
//   VPAY_ENV       1=沙箱 / 0=现网(iOS 强制 0)。不配默认 1(沙箱)

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 套餐 → 道具ID + 价格(分) + 发放类型。道具ID 必须与虚拟支付后台「道具管理」里一致。
const PRODUCTS = {
  single: { productId: 'single_pack_3', price: 990, grant: 'single' },
  annual: { productId: 'annual_member', price: 1990, grant: 'annual' }
}

const hmacHex = (key, data) =>
  crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex')

// wx.login 的 code 换 openid + session_key
const jscode2session = (appid, secret, code) =>
  new Promise((resolve, reject) => {
    const url =
      'https://api.weixin.qq.com/sns/jscode2session' +
      `?appid=${appid}&secret=${secret}&js_code=${code}&grant_type=authorization_code`
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
  const openid = wxContext.OPENID
  const appid = wxContext.APPID
  if (!openid) return { ok: false, code: 'NO_OPENID' }

  const plan = event && event.plan
  const product = PRODUCTS[plan]
  if (!product) return { ok: false, code: 'BAD_PLAN', message: '套餐不存在' }

  const code = event && event.code
  if (!code) return { ok: false, code: 'NO_CODE', message: '缺少登录 code' }

  const APP_KEY = process.env.VPAY_APP_KEY
  const APP_SECRET = process.env.WX_APP_SECRET
  const OFFER_ID = process.env.VPAY_OFFER_ID
  const ENV_FLAG = process.env.VPAY_ENV ? Number(process.env.VPAY_ENV) : 1
  if (!APP_KEY || !APP_SECRET || !OFFER_ID) {
    return { ok: false, code: 'NO_CONFIG', message: '云函数环境变量未配置(VPAY_APP_KEY/WX_APP_SECRET/VPAY_OFFER_ID)' }
  }

  // 1) 换 sessionKey
  let sess
  try {
    sess = await jscode2session(appid, APP_SECRET, code)
  } catch (e) {
    return { ok: false, code: 'SESSION_FAIL', message: '' + e }
  }
  if (!sess || !sess.session_key) {
    return { ok: false, code: 'SESSION_FAIL', detail: sess }
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
