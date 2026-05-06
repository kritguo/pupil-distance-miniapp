const userUtil = require('../../utils/user.js')

Page({
  data: {
    userStatus: 'none',
    isUnlimited: false,
    records: []
  },

  onShow() {
    this.loadData()
  },

  loadData() {
    const info = userUtil.getUserInfo()
    const records = userUtil.getRecords()

    // 格式化时间
    const formattedRecords = records.map(r => ({
      ...r,
      timeStr: this.formatTime(r.time)
    }))

    this.setData({
      userStatus: info.status,
      isUnlimited: info.status === 'unlimited',
      records: formattedRecords
    })
  },

  formatTime(timestamp) {
    const date = new Date(timestamp)
    const month = (date.getMonth() + 1).toString().padStart(2, '0')
    const day = date.getDate().toString().padStart(2, '0')
    const hour = date.getHours().toString().padStart(2, '0')
    const minute = date.getMinutes().toString().padStart(2, '0')
    return `${month}-${day} ${hour}:${minute}`
  },

  viewRecord(e) {
    const record = e.currentTarget.dataset.record
    // 将记录设置为当前结果，跳转到结果页查看
    wx.setStorageSync('latestResult', {
      totalPd: record.totalPd,
      leftPd: record.leftPd,
      rightPd: record.rightPd,
      faceWidth: record.faceWidth,
      confidence: record.confidence,
      timestamp: record.time
    })
    wx.navigateTo({
      url: '/pages/result/result?fromRecord=1'
    })
  },

  goActivate() {
    wx.navigateTo({
      url: '/pages/activate/activate'
    })
  },

  onAbout() {
    wx.showModal({
      title: '关于我们',
      content: '瞳距测量小程序，帮助您测量瞳距和脸宽，获取配镜建议。仅供参考，不替代专业验光。',
      showCancel: false
    })
  }
})
