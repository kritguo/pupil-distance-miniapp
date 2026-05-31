const userUtil = require('../../utils/user.js')
const pay = require('../../utils/pay.js')

Page({
  data: {
    userStatus: 'none',
    statusText: ''
  },

  onLoad() {
    this.updateUserStatus()
  },

  onShow() {
    // 同步服务端权益后刷新状态
    pay.syncEntitlement().then(() => this.updateUserStatus())
    this.updateUserStatus()
  },

  updateUserStatus() {
    const info = userUtil.getUserInfo()
    this.setData({
      userStatus: info.status,
      statusText: userUtil.getStatusText()
    })
  },

  onStart() {
    if (userUtil.isUnlimited()) {
      userUtil.resetUnlimitedSession()
    }
    // 首页价格行已说明「一次测量 ¥9.9」，点击直接进入测量页，不再二次弹窗
    this.goMeasure()
  },

  // 跳转测量页
  goMeasure() {
    wx.navigateTo({
      url: '/pages/measure/measure'
    })
  },

  onShareAppMessage() {
    return { title: '快速测瞳距PDgo · 正脸拍照，快速测出你的瞳距', path: '/pages/index/index' }
  },
  onShareTimeline() {
    return { title: '快速测瞳距PDgo · 正脸拍照，快速测出你的瞳距' }
  }
})
