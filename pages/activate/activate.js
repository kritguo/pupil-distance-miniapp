const userUtil = require('../../utils/user.js')

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

  onShareAppMessage() {
    return { title: '快速测瞳距PDgo · 正脸拍照，快速测出你的瞳距', path: '/pages/index/index' }
  },
  onShareTimeline() {
    return { title: '快速测瞳距PDgo · 正脸拍照，快速测出你的瞳距' }
  }
})
