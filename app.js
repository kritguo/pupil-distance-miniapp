const config = require('./config.js')

// app.js
App({
  onLaunch() {
    if (wx.cloud && typeof wx.cloud.init === 'function') {
      const cloudEnv = config.cloud && config.cloud.envId
      const initOptions = { traceUser: true }
      if (cloudEnv) {
        initOptions.env = cloudEnv
      }
      wx.cloud.init(initOptions)
    }
    wx.login({
      success: res => {
        // 发送 res.code 到后台换取 openId, sessionKey, unionId
      }
    })
  },
  globalData: {
    userInfo: null
  }
})
