const config = require('./config.js')
const pay = require('./utils/pay.js')

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
      // 启动即同步一次服务端权益到本地缓存（openid 由云函数自动获取）
      pay.syncEntitlement()
    }
  },
  globalData: {
    userInfo: null
  }
})
