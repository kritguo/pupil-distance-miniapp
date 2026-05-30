const userUtil = require('../../utils/user.js')
const pay = require('../../utils/pay.js')

Page({
  data: {
    cardKey: '',
    activated: false,
    activateType: '' // single | unlimited
  },

  onInput(e) {
    this.setData({
      cardKey: e.detail.value.trim()
    })
  },

  onActivate() {
    const { cardKey } = this.data
    if (!cardKey) {
      wx.showToast({ title: '请输入卡密', icon: 'none' })
      return
    }

    wx.showLoading({ title: '验证中...' })

    // TODO: 实际项目中这里需要调用后端接口验证卡密
    // 模拟验证逻辑：以 'S' 开头为单次卡密，以 'U' 开头为无限卡密
    setTimeout(() => {
      wx.hideLoading()

      let type = ''
      if (cardKey.toUpperCase().startsWith('S')) {
        type = 'single'
        userUtil.activateSingle()
      } else if (cardKey.toUpperCase().startsWith('U')) {
        type = 'unlimited'
        userUtil.activateUnlimited()
      } else {
        // 模拟：其他卡密视为无效
        wx.showToast({ title: '卡密无效', icon: 'error' })
        return
      }

      this.setData({
        activated: true,
        activateType: type
      })
    }, 1000)
  },

  goMeasure() {
    wx.switchTab({
      url: '/pages/index/index'
    })
  },

  onUpgrade() {
    wx.showModal({
      title: '升级确认',
      content: '补 ¥10 即可解锁年度会员（一年内不限次测量 + 数据保存）',
      confirmText: '立即升级',
      success: (res) => {
        if (!res.confirm) return
        pay.purchase('upgrade').then((payRes) => {
          if (!payRes || !payRes.ok) {
            if (payRes && payRes.code === 'CANCELLED') return
            wx.showToast({ title: (payRes && payRes.message) || '升级失败', icon: 'none' })
            return
          }
          this.setData({ activateType: 'unlimited' })
          wx.showToast({ title: '升级成功', icon: 'success' })
        })
      }
    })
  }
})
