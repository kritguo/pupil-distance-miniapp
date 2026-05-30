const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 服务端定价表（金额单位：分）。前端只传 plan，金额一律以这里为准，防止篡改。
const PRICING = {
  single: { fee: 990, body: '瞳距测量·单次套餐(3次)' },
  annual: { fee: 1990, body: '瞳距测量·年度会员(一年不限次)' },
  upgrade: { fee: 1000, body: '瞳距测量·升级年度会员(补差价)' }
}

// 回调云函数名（payCallback）
const CALLBACK_FUNCTION = 'payCallback'

// 生成商户订单号：时间戳 + 随机，确保唯一
const genOutTradeNo = (openid) => {
  const ts = Date.now()
  const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0')
  const tail = (openid || '').slice(-6)
  return `pd${ts}${rand}${tail}`
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) {
    return { ok: false, code: 'NO_OPENID', message: '无法获取用户身份' }
  }

  const plan = event && event.plan
  const pricing = PRICING[plan]
  if (!pricing) {
    return { ok: false, code: 'BAD_PLAN', message: '套餐不存在' }
  }

  const db = cloud.database()
  const outTradeNo = genOutTradeNo(openid)

  // 先落一条 pending 订单，便于对账与回调幂等
  try {
    await db.collection('orders').add({
      data: {
        outTradeNo,
        openid,
        plan,
        amount: pricing.fee,
        status: 'pending',
        transactionId: '',
        createTime: db.serverDate(),
        payTime: null
      }
    })
  } catch (err) {
    return { ok: false, code: 'DB_FAIL', message: '创建订单失败', detail: '' + err }
  }

  // 云开发云支付统一下单（云调用，免证书签名）
  try {
    const res = await cloud.cloudPay.unifiedOrder({
      body: pricing.body,
      outTradeNo,
      spbillCreateIp: '127.0.0.1',
      subMchId: process.env.SUB_MCH_ID,        // 你的微信支付商户号，配在云函数环境变量
      totalFee: pricing.fee,
      envId: cloud.DYNAMIC_CURRENT_ENV,
      functionName: CALLBACK_FUNCTION,
      nonceStr: Math.random().toString(36).slice(2, 18),
      tradeType: 'JSAPI',
      openid
    })

    if (res && res.returnCode === 'SUCCESS' && res.resultCode === 'SUCCESS' && res.payment) {
      return {
        ok: true,
        outTradeNo,
        plan,
        amount: pricing.fee,
        payment: res.payment // { timeStamp, nonceStr, package, signType, paySign }
      }
    }

    // 下单失败，标记订单
    await db.collection('orders').where({ outTradeNo }).update({
      data: { status: 'failed', updateTime: db.serverDate() }
    })
    return {
      ok: false,
      code: 'UNIFIED_ORDER_FAIL',
      message: (res && (res.returnMsg || res.errCodeDes)) || '下单失败',
      detail: res
    }
  } catch (err) {
    await db.collection('orders').where({ outTradeNo }).update({
      data: { status: 'failed', updateTime: db.serverDate() }
    }).catch(() => {})
    return { ok: false, code: 'PAY_EXCEPTION', message: '下单异常', detail: '' + err }
  }
}
