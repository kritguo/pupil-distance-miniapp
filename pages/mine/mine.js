const userUtil = require('../../utils/user.js')
const pay = require('../../utils/pay.js')

Page({
  data: {
    userStatus: 'none',
    isUnlimited: false,
    statusText: '',
    remainCount: 0,
    annualExpireText: '',
    records: [],
    visibleRecords: [],     // 折叠后实际渲染的列表
    recordsExpanded: false, // 是否展开全部
    swipeOpenId: null,      // 当前左滑展开删除按钮的记录 id
    recordsCount: 0,
    lastMeasureText: ''
  },

  // 列表超过这个条数就先折叠，给「展开全部 / 收起」开关
  COLLAPSE_LIMIT: 5,

  onShow() {
    // 先同步服务端权益，再渲染
    pay.syncEntitlement().then(() => this.loadData())
    this.loadData()
  },

  loadData() {
    const info = userUtil.getUserInfo()
    const records = userUtil.getRecords()
    const isUnlimited = userUtil.isUnlimited()

    // 格式化时间 + 单眼/可信度展示字段
    const confClassMap = { '高': 'high', '中': 'mid', '低': 'low' }
    const formattedRecords = records.map(r => {
      const timeStr = this.formatTime(r.time)
      const hasEyes = (r.leftPd !== undefined && r.leftPd !== null)
        && (r.rightPd !== undefined && r.rightPd !== null)
      return {
        ...r,
        timeStr,
        shortDate: timeStr.split(' ')[0],
        eyeStr: hasEyes ? `${r.leftPd} / ${r.rightPd}` : '',
        confClass: confClassMap[r.confidence] || 'mid'
      }
    })

    const expanded = this.data.recordsExpanded
    const visibleRecords = expanded
      ? formattedRecords
      : formattedRecords.slice(0, this.COLLAPSE_LIMIT)

    this.setData({
      userStatus: info.status,
      isUnlimited,
      statusText: userUtil.getStatusText(),
      remainCount: info.remainCount || 0,
      annualExpireText: isUnlimited
        ? `有效期至 ${userUtil.formatDate(userUtil.getAnnualExpireAt())}`
        : '',
      records: formattedRecords,
      visibleRecords,
      swipeOpenId: null,
      recordsCount: formattedRecords.length,
      lastMeasureText: formattedRecords.length
        ? `共 ${formattedRecords.length} 次测量 · 最近 ${formattedRecords[0].shortDate}`
        : '还没有测量记录'
    })
  },

  // 展开全部 / 收起
  onToggleRecords() {
    const expanded = !this.data.recordsExpanded
    this.setData({
      recordsExpanded: expanded,
      visibleRecords: expanded ? this.data.records : this.data.records.slice(0, this.COLLAPSE_LIMIT),
      swipeOpenId: null
    })
  },

  // ===== 左滑删除 =====
  onSwipeStart(e) {
    this._touchStartX = e.touches[0].clientX
    this._touchStartY = e.touches[0].clientY
    this._touchDx = 0
  },
  onSwipeMove(e) {
    const dx = e.touches[0].clientX - this._touchStartX
    const dy = e.touches[0].clientY - this._touchStartY
    if (Math.abs(dx) > Math.abs(dy)) this._touchDx = dx
  },
  onSwipeEnd(e) {
    const id = e.currentTarget.dataset.id
    const dx = this._touchDx || 0
    if (dx < -40) {
      this.setData({ swipeOpenId: id })
    } else if (dx > 40) {
      this.setData({ swipeOpenId: null })
    }
    this._touchDx = 0
  },

  onDeleteRecord(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除记录',
      content: '确定删除这条测量记录吗？删除后不可恢复。',
      confirmText: '删除',
      confirmColor: '#e8501a',
      success: (res) => {
        if (!res.confirm) return
        userUtil.deleteRecord(id)
        this.setData({ swipeOpenId: null })
        this.loadData()
      }
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
    // 有左滑展开的删除按钮时，点击先收起、不跳转
    if (this.data.swipeOpenId) {
      this.setData({ swipeOpenId: null })
      return
    }
    const record = e.currentTarget.dataset.record
    // 将记录设置为当前结果，跳转到结果页查看
    wx.setStorageSync('latestResult', {
      totalPd: record.totalPd,
      leftPd: record.leftPd,
      rightPd: record.rightPd,
      nearTotalPd: record.nearTotalPd,
      nearLeftPd: record.nearLeftPd,
      nearRightPd: record.nearRightPd,
      pdBasis: record.pdBasis,
      faceWidth: record.faceWidth,
      confidence: record.confidence,
      name: record.name,
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
      content: '瞳距测量小程序，帮助您测量总瞳距和单眼瞳距，获取配镜参数参考。仅供参考，不替代专业验光。',
      showCancel: false
    })
  },

  onShareAppMessage() {
    return { title: '快速测瞳距PDgo · 正脸拍照，快速测出你的瞳距', path: '/pages/index/index' }
  },
  onShareTimeline() {
    return { title: '快速测瞳距PDgo · 正脸拍照，快速测出你的瞳距' }
  }
})
