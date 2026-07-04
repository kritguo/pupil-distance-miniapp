const config = require('../../config.js')

const normalizePlan = (plan) => plan === 'annual' ? 'annual' : 'single'

function appendQuery(url, params) {
  if (!url) return ''
  const query = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&')
  if (!query) return url
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + query
}

function buildDownloadPageUrl(options) {
  const appDownload = config.appDownload || {}
  return appendQuery(appDownload.downloadPageUrl || '', {
    plan: normalizePlan(options && options.plan),
    source: options && options.source,
    keyword: appDownload.iosSearchKeyword || 'PDgo 测瞳距'
  })
}

// 只讲深度相机卖点；unionid 权益桥建好前不承诺「免费/微信登录自动同步」
function getPlanCopy(plan) {
  if (normalizePlan(plan) === 'annual') {
    return {
      badge: '深度相机 · 更精准',
      title: 'PDgo App 深度测量',
      desc: '用 iPhone 深度相机测量瞳距，比照片测量更精准。'
    }
  }
  return {
    badge: '深度相机 · 更精准',
    title: 'PDgo App 深度复测',
    desc: '用 iPhone 深度相机再确认一次，比照片测量更精准。'
  }
}

Page({
  data: {
    webUrl: '',
    plan: 'single',
    searchKeyword: 'PDgo 测瞳距',
    copy: getPlanCopy('single')
  },

  onLoad(options) {
    const plan = normalizePlan(options && options.plan)
    const appDownload = config.appDownload || {}
    this.setData({
      plan,
      searchKeyword: appDownload.iosSearchKeyword || 'PDgo 测瞳距',
      webUrl: buildDownloadPageUrl({
        plan,
        source: (options && options.source) || 'precision_retest'
      }),
      copy: getPlanCopy(plan)
    })
  },

  onAppStoreHelp() {
    wx.showModal({
      title: 'App 下载说明',
      content: `如果下载页没有自动打开 App Store，请到 App Store 搜索「${this.data.searchKeyword}」。`,
      showCancel: false,
      confirmText: '知道了'
    })
  }
})

module.exports = {
  _test: {
    appendQuery,
    buildDownloadPageUrl,
    getPlanCopy,
    normalizePlan
  }
}
