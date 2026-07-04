function formatMoney(fen) {
  return (Number(fen || 0) / 100).toFixed(2)
}

Page({
  data: {
    loading: true,
    error: '',
    stats: null,
    summaryCards: [],
    trend: [],
    hasDeliveryPending: false,
    repairing: false,
    repairText: '',
    totals: {
      users: 0,
      annualUsers: 0,
      singlePurchasedUsers: 0,
      paidOrders: 0,
      revenueYuan: '0.00',
      deliveryPending: 0
    }
  },

  onLoad() {
    this.loadStats()
  },

  onPullDownRefresh() {
    this.loadStats(() => wx.stopPullDownRefresh())
  },

  loadStats(done) {
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
      this.setData({ loading: false, error: '云开发未初始化' })
      if (done) done()
      return
    }

    this.setData({ loading: true, error: '' })
    wx.cloud.callFunction({
      name: 'adminStats',
      data: { action: 'stats', days: 7 },
      success: (res) => {
        const out = res && res.result
        if (!out || !out.ok) {
          this.setData({
            loading: false,
            error: (out && (out.message || out.code)) || '暂无权限或统计失败'
          })
          return
        }
        this.renderStats(out)
      },
      fail: (err) => {
        this.setData({ loading: false, error: (err && err.errMsg) || '统计请求失败' })
      },
      complete: () => {
        if (done) done()
      }
    })
  },

  renderStats(stats) {
    const today = stats.today || {}
    const totals = stats.totals || {}
    const trend = (stats.trend || []).map((item) => ({
      ...item,
      revenueYuan: formatMoney(item.revenueFen)
    }))

    this.setData({
      loading: false,
      stats,
      summaryCards: [
        { label: '今日测量人数', value: today.measurementUsers || 0, unit: '人' },
        { label: '今日测量次数', value: today.measurementSessions || 0, unit: '次' },
        { label: '今日付费人数', value: today.paidUsers || 0, unit: '人' },
        { label: '今日收入', value: formatMoney(today.revenueFen), unit: '元' }
      ],
      trend,
      hasDeliveryPending: (totals.deliveryPending || 0) > 0,
      totals: {
        users: totals.users || 0,
        annualUsers: totals.annualUsers || 0,
        singlePurchasedUsers: totals.singlePurchasedUsers || 0,
        paidOrders: totals.paidOrders || 0,
        revenueYuan: formatMoney(totals.revenueFen),
        deliveryPending: totals.deliveryPending || 0
      }
    })
  },

  onRefresh() {
    this.loadStats()
  },

  onRepairDeliveries() {
    if (this.data.repairing) return
    wx.showModal({
      title: '补发货确认',
      content: '会扫描最近已支付但未确认发货的订单，并重新通知微信虚拟支付平台确认发货。',
      confirmText: '开始修复',
      success: (res) => {
        if (!res.confirm) return
        this.runDeliveryRepair()
      }
    })
  },

  runDeliveryRepair() {
    this.setData({ repairing: true, repairText: '正在补发货...' })
    wx.cloud.callFunction({
      name: 'vpayConfirm',
      data: { action: 'repairDeliveries', limit: 50 },
      success: (res) => {
        const out = res && res.result
        if (!out || !out.ok) {
          this.setData({
            repairText: (out && (out.message || out.code)) || '补发货失败'
          })
          return
        }
        this.setData({
          repairText: `已扫描 ${out.scanned || 0} 单，需修复 ${out.candidates || 0} 单，成功 ${out.repaired || 0} 单，失败 ${out.failed || 0} 单`
        })
        this.loadStats()
      },
      fail: (err) => {
        this.setData({ repairText: (err && err.errMsg) || '补发货请求失败' })
      },
      complete: () => {
        this.setData({ repairing: false })
      }
    })
  }
})
