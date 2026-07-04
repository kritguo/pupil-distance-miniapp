const measureMode = require('./measure_mode.js')

// 客户端平台：ios / android / other。systemInfo 可注入便于单测，默认读 wx。
function resolveClientPlatform(systemInfo) {
  try {
    const info = systemInfo
      || (typeof wx !== 'undefined' && wx && typeof wx.getSystemInfoSync === 'function'
        ? wx.getSystemInfoSync()
        : null)
      || {}
    const platform = String(info.platform || '').toLowerCase()
    if (platform.indexOf('ios') >= 0) return 'ios'
    if (platform.indexOf('android') >= 0) return 'android'
  } catch (e) {}
  return 'other'
}

function hasRetestCredit(info) {
  return !!(info && (info.retestCredits || 0) > 0)
}

function shouldPromptRetestChoice(info) {
  if (!hasRetestCredit(info)) return false
  if (info && info.status === 'unlimited') return false
  return true
}

function buildMeasureUrl({ mode, forcePurchase } = {}) {
  const query = []
  if (mode) query.push(`mode=${encodeURIComponent(measureMode.normalizeMeasureMode(mode))}`)
  if (forcePurchase) query.push('forcePurchase=1')
  return '/pages/measure/measure' + (query.length ? `?${query.join('&')}` : '')
}

module.exports = {
  buildMeasureUrl,
  hasRetestCredit,
  resolveClientPlatform,
  shouldPromptRetestChoice
}
