const userUtil = require('../../utils/user.js')
const pay = require('../../utils/pay.js')
const measureEntry = require('../../utils/measure_entry.js')
const measureModeUtil = require('../../utils/measure_mode.js')

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
      this.goMeasure()
      return
    }
    const info = userUtil.getUserInfo()
    if (measureEntry.shouldPromptRetestChoice(info)) {
      const precisionRetestEnabled = measureModeUtil.isPrecisionRetestEnabled()
      // iOS：不弹窗不拦截（owner 决策：引导只留结果页小卡片）。直接进普通测量，
      // 复测额度自动当一次免费普通复测；结果页对额度买单的普通结果不再续送，防无限免费循环。
      if (precisionRetestEnabled && measureEntry.resolveClientPlatform() === 'ios') {
        this.goMeasure()
        return
      }
      wx.showModal({
        title: precisionRetestEnabled ? '你还有一次免费精度复测' : '你还有一次免费复测',
        content: precisionRetestEnabled
          ? '可以直接用身份证或银行卡辅助校验，做一次更稳的精度复测；如果想重新购买一组新的测量，也可以重新购买。'
          : '可以直接免费复测；如果想重新购买一组新的测量，也可以重新购买。',
        confirmText: precisionRetestEnabled ? '去精度复测' : '去免费复测',
        cancelText: '重新购买测量',
        success: (res) => {
          if (res.confirm) {
            this.goMeasure({ mode: precisionRetestEnabled ? 'precision' : 'normal' })
          } else {
            this.goMeasure({ mode: 'normal', forcePurchase: true })
          }
        }
      })
      return
    }
    // 测量免费，价格在「结果解锁·查看详情」与结果页 paywall 说明；点击直接进测量页，不二次弹窗
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
