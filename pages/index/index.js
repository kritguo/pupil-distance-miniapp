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
      // iOS：精度复测的载体是 PDgo App(深度相机)，小程序内不提供卡片流程；
      // 也不提供「免费普通重测」——普通解锁会再次赠送额度，会形成无限免费循环。
      if (precisionRetestEnabled && measureEntry.resolveClientPlatform() === 'ios') {
        wx.showModal({
          title: '想更精准？',
          content: 'PDgo App 用 iPhone 深度相机测量，比照片测量更精准。如果现在就要在小程序里再测一组，需要重新购买。',
          confirmText: '看看 App',
          cancelText: '重新购买',
          success: (res) => {
            if (res.confirm) {
              wx.navigateTo({ url: '/pages/app-download/app-download?plan=single&source=home_retest' })
            } else {
              this.goMeasure({ mode: 'normal', forcePurchase: true })
            }
          }
        })
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
