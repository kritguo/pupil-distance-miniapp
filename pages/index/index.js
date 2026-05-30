const userUtil = require('../../utils/user.js')
const pay = require('../../utils/pay.js')

Page({
  data: {
    showPayTip: false,
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
    // 检查是否需要显示付费提示
    if (userUtil.shouldShowPayTip()) {
      this.setData({ showPayTip: true })
    } else {
      this.goMeasure()
    }
  },

  // 关闭付费提示弹窗
  closePayTip() {
    this.setData({ showPayTip: false })
  },

  // 继续测量（关闭弹窗后进入测量）
  continueMeasure() {
    this.setData({ showPayTip: false })
    this.goMeasure()
  },

  noop() {},

  // 跳转测量页
  goMeasure() {
    wx.navigateTo({
      url: '/pages/measure/measure'
    })
  }
})
