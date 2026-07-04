const userUtil = require('../../utils/user.js')
const pay = require('../../utils/pay.js')
const measureEntry = require('../../utils/measure_entry.js')

Page({
  data: {
    userStatus: 'none',
    statusText: '',
    showMembershipStatus: false,
    showPricingDetail: false
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
    const showMembershipStatus = userUtil.isUnlimited()
    this.setData({
      userStatus: info.status,
      showMembershipStatus,
      statusText: showMembershipStatus ? '年会员 · 不限次数' : ''
    })
  },

  onStart() {
    if (this.data.showPricingDetail) {
      this.setData({ showPricingDetail: false })
    }
    if (userUtil.isUnlimited()) {
      userUtil.resetUnlimitedSession()
    }
    // 开始测量 = 直接进普通拍照，全平台零弹窗（owner 决策）。
    // 有免费复测额度时服务端解锁自动优先抵扣；精度复测/App 引导只在结果页数字下方的小卡片。
    this.goMeasure()
  },

  // 跳转测量页
  goMeasure(options) {
    wx.navigateTo({
      url: measureEntry.buildMeasureUrl(options)
    })
  },

  // 「结果解锁 · 查看详情」底部价格说明
  onPricingDetail() {
    this.setData({
      showPricingDetail: true
    })
  },

  closePricingDetail() {
    this.setData({ showPricingDetail: false })
  },

  noop() {},

  onShareAppMessage() {
    return { title: '快速测瞳距PDgo · 正脸拍照，快速测出你的瞳距', path: '/pages/index/index' }
  },
  onShareTimeline() {
    return { title: '快速测瞳距PDgo · 正脸拍照，快速测出你的瞳距' }
  }
})
