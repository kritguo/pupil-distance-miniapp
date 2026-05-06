const userUtil = require('../../utils/user.js')

const roundToHalf = (value) => Math.round(value * 2) / 2
const isNumber = (value) => typeof value === 'number' && !Number.isNaN(value)
const MEASURE_TARGET_COUNT = 3
const STABLE_TOTAL_SPREAD_MM = 2
const USABLE_TOTAL_SPREAD_MM = 4

const median = (values) => {
  const list = values.filter(isNumber).slice().sort((a, b) => a - b)
  if (!list.length) return null
  const mid = Math.floor(list.length / 2)
  if (list.length % 2 === 1) {
    return list[mid]
  }
  return roundToHalf((list[mid - 1] + list[mid]) / 2)
}

const numericResults = (results) => (results || []).filter((item) => item
  && isNumber(item.totalPd)
  && isNumber(item.leftPd)
  && isNumber(item.rightPd))

const spread = (values) => {
  const list = values.filter(isNumber)
  if (list.length < 2) return 0
  return roundToHalf(Math.max(...list) - Math.min(...list))
}

const buildMedianResult = (results) => {
  const usable = numericResults(results)
  if (usable.length < MEASURE_TARGET_COUNT) return null
  const preferred = usable.filter((item) => item.confidence !== '低')
  const used = preferred.length >= MEASURE_TARGET_COUNT ? preferred : usable
  const left = median(used.map(r => r.leftPd))
  const right = median(used.map(r => r.rightPd))
  const total = isNumber(left) && isNumber(right)
    ? roundToHalf(left + right)
    : median(used.map(r => r.totalPd))
  const faceWidth = median(used.map(r => r.faceWidth))
  const totalSpread = spread(used.map(r => r.totalPd))
  const leftSpread = spread(used.map(r => r.leftPd))
  const rightSpread = spread(used.map(r => r.rightPd))
  let consistency = '稳定'
  if (totalSpread > USABLE_TOTAL_SPREAD_MM) {
    consistency = '波动大'
  } else if (totalSpread > STABLE_TOTAL_SPREAD_MM || leftSpread > STABLE_TOTAL_SPREAD_MM || rightSpread > STABLE_TOTAL_SPREAD_MM) {
    consistency = '一般'
  }
  return {
    totalPd: total,
    leftPd: left,
    rightPd: right,
    faceWidth,
    confidence: consistency === '稳定' ? '高' : (consistency === '一般' ? '中' : '低'),
    usedCount: used.length,
    totalCount: usable.length,
    totalSpread,
    leftSpread,
    rightSpread,
    consistency,
    warning: consistency === '波动大'
      ? `三次结果最大相差 ${totalSpread}mm，建议重新按同一姿势测 3 次`
      : (consistency === '一般'
        ? `三次结果最大相差 ${totalSpread}mm，建议再测一次确认`
        : '')
  }
}

// 镜片折射率推荐规则
const LENS_INDEX_RULES = [
  { maxDegree: 200, index: '1.56', name: '标准' },
  { maxDegree: 400, index: '1.60', name: '轻薄' },
  { maxDegree: 600, index: '1.67', name: '超薄' },
  { maxDegree: 800, index: '1.71', name: '特薄' },
  { maxDegree: Infinity, index: '1.74', name: '极薄' }
]

// 用途推荐
const USAGE_RECOMMENDATIONS = {
  daily: {
    name: '日常通用',
    lensType: '非球面镜片',
    coating: '加硬膜',
    desc: '适合日常生活使用'
  },
  bluelight: {
    name: '防蓝光',
    lensType: '防蓝光镜片',
    coating: '防蓝光膜层',
    desc: '适合长时间使用电子设备'
  },
  driving: {
    name: '驾驶',
    lensType: '偏光镜片',
    coating: '防眩光膜',
    desc: '减少强光刺激，驾驶更安全'
  },
  reading: {
    name: '阅读办公',
    lensType: '渐进多焦点',
    coating: '抗疲劳膜',
    desc: '适合近距离长时间阅读'
  }
}

Page({
  data: {
    result: null,
    displayResult: null,
    displayResultSource: '本次测量',
    empty: false,
    // 付费相关
    showPayModal: false,
    isPaid: false,
    isUnlimited: false,
    selectedPlan: 'unlimited', // single | unlimited
    fromRecord: false,
    trialMode: false,
    progressText: '',
    medianResult: null,
    medianWarning: '',
    medianCount: 0,
    nextMeasureText: '再测一次',
    trialResults: [],
    // 镜框推荐（基于脸宽自动计算）
    frameRecommendation: null,
    // 镜片建议
    degree: '',
    usageOptions: [
      { value: 'daily', label: '日常通用' },
      { value: 'bluelight', label: '防蓝光' },
      { value: 'driving', label: '驾驶' },
      { value: 'reading', label: '阅读办公' }
    ],
    selectedUsage: 'daily',
    lensAdvice: null
  },

  onLoad(options) {
    const result = wx.getStorageSync('latestResult')
    if (!result) {
      this.setData({ empty: true })
      return
    }
    const fromRecord = options && options.fromRecord === '1'
    const hasTrialResults = userUtil.getTrialResults().length >= 3
    const hasBatchResults = userUtil.getSingleBatchResults().length >= 3
    const trialMode = !fromRecord && ((options && options.trial === '1') || hasTrialResults || hasBatchResults)
    this.setData({
      result,
      displayResult: result,
      displayResultSource: '本次测量',
      fromRecord,
      trialMode
    })

    // 检查付费状态
    this.checkPayStatus()

    // 自动计算镜框推荐
    this.calcFrameRecommendation(result.faceWidth)

    if (trialMode) {
      this.loadTrialSummary()
    }
  },

  // 检查付费状态
  checkPayStatus() {
    const { result, fromRecord } = this.data
    const canFree = userUtil.canMeasureFree()
    const isUnlimited = userUtil.isUnlimited()

    if (canFree) {
      // 已付费用户，直接显示结果
      this.setData({
        isPaid: true,
        isUnlimited: isUnlimited
      })

      // 如果是单次用户，扣减次数
      if (!isUnlimited) {
        if (result && result.timestamp && !userUtil.isLastUnlockedResult(result.timestamp)) {
          userUtil.useMeasureCount()
          userUtil.setLastUnlockedResult(result.timestamp)
          userUtil.addSingleResult(result)
        }
      }

      // 如果是无限用户，保存记录
      if (isUnlimited && !fromRecord) {
        if (result && result.timestamp) {
          userUtil.addUnlimitedSessionResult(result)
        }
        this.saveRecord()
      }
      this.updateProgress()
      return
    } else {
      const canViewLatest = result && result.timestamp && userUtil.canViewLatestResult(result.timestamp)
      if (canViewLatest) {
        this.setData({
          isPaid: true,
          isUnlimited: false,
          showPayModal: false
        })
        this.updateProgress()
        return
      }

      // 未付费，显示付费弹窗
      this.setData({
        showPayModal: true,
        isPaid: false
      })
    }
  },

  loadTrialSummary() {
    const trialResults = userUtil.getTrialResults()
    const paidResults = userUtil.getSingleBatchResults()
    const results = trialResults.length ? trialResults : paidResults
    const medianResult = buildMedianResult(results)
    const displayResult = medianResult || this.data.result
    this.setData({
      trialResults: results,
      medianResult,
      medianWarning: medianResult ? medianResult.warning : '',
      medianCount: results.length,
      displayResult,
      displayResultSource: medianResult ? '三次中位数推荐' : '本次测量',
      progressText: results.length >= MEASURE_TARGET_COUNT
        ? `已完成 ${MEASURE_TARGET_COUNT} 次测量，优先使用中位数结果`
        : ''
    })
    this.calcFrameRecommendation(displayResult && displayResult.faceWidth)
  },

  updateProgress() {
    const { result, isUnlimited, fromRecord } = this.data
    if (!result || fromRecord) return

    if (isUnlimited) {
      const sessionResults = userUtil.getUnlimitedSessionResults()
      const count = sessionResults.length
      const medianResult = buildMedianResult(sessionResults)
      const displayResult = medianResult || result
      const progressText = count >= 3
        ? `已完成 ${count} 次测量，优先使用中位数结果`
        : `已完成 ${count} 次测量，建议至少 3 次取中位数`
      this.setData({
        progressText,
        medianResult,
        medianWarning: medianResult ? medianResult.warning : '',
        medianCount: count,
        displayResult,
        displayResultSource: medianResult ? `${count} 次中位数推荐` : '本次测量',
        nextMeasureText: medianResult && medianResult.consistency !== '稳定' ? '再测一次确认' : '继续测量'
      })
      this.calcFrameRecommendation(displayResult && displayResult.faceWidth)
      return
    }

    const batchResults = userUtil.getSingleBatchResults()
    const count = batchResults.length
    const total = 3
    const progressText = count < total
      ? `已完成 ${count}/${total} 次，建议再测 ${total - count} 次取中位数`
      : `已完成 ${count}/${total} 次测量，优先使用中位数结果`
    const medianResult = count >= total ? buildMedianResult(batchResults) : null
    const displayResult = medianResult || result
    const nextMeasureText = count < total
      ? `继续第 ${count + 1} 次测量`
      : (medianResult && medianResult.consistency !== '稳定' ? '再测一次确认' : '再测一次')

    this.setData({
      progressText,
      medianResult,
      medianWarning: medianResult ? medianResult.warning : '',
      medianCount: count,
      displayResult,
      displayResultSource: medianResult ? '三次中位数推荐' : '本次测量',
      nextMeasureText
    })
    this.calcFrameRecommendation(displayResult && displayResult.faceWidth)
  },

  // 保存测量记录
  saveRecord() {
    const { result } = this.data
    if (result) {
      userUtil.addRecord({
        totalPd: result.totalPd,
        leftPd: result.leftPd,
        rightPd: result.rightPd,
        faceWidth: result.faceWidth,
        confidence: result.confidence,
        timestamp: result.timestamp
      })
    }
  },

  // 选择付费方案
  selectPlan(e) {
    this.setData({
      selectedPlan: e.currentTarget.dataset.plan
    })
  },

  // 确认支付
  onPay() {
    const { selectedPlan, trialMode } = this.data

    // TODO: 实际项目中这里需要调用微信支付接口
    wx.showLoading({ title: '支付中...' })

    setTimeout(() => {
      wx.hideLoading()

      if (selectedPlan === 'single') {
        if (trialMode) {
          userUtil.unlockTrialAsSingle()
        } else {
          userUtil.activateSingle()
          if (this.data.result && this.data.result.timestamp) {
            userUtil.addSingleResult(this.data.result)
            userUtil.setLastUnlockedResult(this.data.result.timestamp)
            userUtil.useMeasureCount()
          }
        }
        this.setData({
          showPayModal: false,
          isPaid: true,
          isUnlimited: false
        })
        if (trialMode) {
          this.loadTrialSummary()
        } else {
          this.updateProgress()
        }
      } else {
        const trialResults = trialMode ? userUtil.getTrialResults() : []
        userUtil.activateUnlimited()
        if (trialResults.length) {
          trialResults.forEach((item) => {
            userUtil.addUnlimitedSessionResult(item)
            userUtil.addRecord({
              totalPd: item.totalPd,
              leftPd: item.leftPd,
              rightPd: item.rightPd,
              faceWidth: item.faceWidth,
              confidence: item.confidence,
              timestamp: item.timestamp
            })
          })
          userUtil.resetTrialBatch()
        } else if (this.data.result && this.data.result.timestamp) {
          userUtil.addUnlimitedSessionResult(this.data.result)
          this.saveRecord()
        }
        this.setData({
          showPayModal: false,
          isPaid: true,
          isUnlimited: true
        })
        if (trialMode) {
          this.loadTrialSummary()
        } else {
          this.updateProgress()
        }
      }

      wx.showToast({ title: '支付成功', icon: 'success' })
    }, 1000)
  },

  // 关闭付费弹窗
  closePayModal() {
    // 未付费不能关闭弹窗，只能返回
    wx.showModal({
      title: '提示',
      content: '需要付费后才能查看结果，是否返回？',
      confirmText: '返回',
      cancelText: '继续付费',
      success: (res) => {
        if (res.confirm) {
          wx.navigateBack()
        }
      }
    })
  },

  // 升级到无限
  onUpgrade() {
    wx.showModal({
      title: '升级确认',
      content: '补 ¥10 即可解锁无限次测量和数据保存功能',
      confirmText: '立即升级',
      success: (res) => {
        if (res.confirm) {
          // TODO: 调用支付接口
          userUtil.upgradeToUnlimited()
          if (this.data.result && this.data.result.timestamp) {
            userUtil.addUnlimitedSessionResult(this.data.result)
          }
          this.saveRecord()
          this.setData({ isUnlimited: true })
          this.updateProgress()
          wx.showToast({ title: '升级成功', icon: 'success' })
        }
      }
    })
  },

  // 基于脸宽计算镜框推荐
  calcFrameRecommendation(faceWidth) {
    if (!faceWidth || faceWidth < 100 || faceWidth > 200) {
      this.setData({ frameRecommendation: null })
      return
    }

    // 镜框总宽一般比脸宽小 5-15mm 为宜
    const minFrameWidth = Math.round(faceWidth - 15)
    const maxFrameWidth = Math.round(faceWidth - 5)

    // 根据脸宽给出脸型描述
    let faceType, desc
    if (faceWidth < 130) {
      faceType = '窄脸'
      desc = '建议选择小框或中小框眼镜'
    } else if (faceWidth < 145) {
      faceType = '中等'
      desc = '大多数镜框都适合，可根据风格选择'
    } else {
      faceType = '宽脸'
      desc = '建议选择大框或宽版镜框'
    }

    this.setData({
      frameRecommendation: {
        faceWidth: Math.round(faceWidth),
        minFrameWidth,
        maxFrameWidth,
        faceType,
        desc
      }
    })
  },

  // 度数输入
  onDegreeInput(e) {
    this.setData({ degree: e.detail.value })
  },

  // 用途选择
  onUsageChange(e) {
    this.setData({ selectedUsage: e.detail.value })
  },

  // 计算镜片建议
  calcLensAdvice() {
    const { degree, selectedUsage } = this.data
    const deg = parseFloat(degree)

    if (!deg || deg < 0 || deg > 2000) {
      wx.showToast({ title: '请输入有效度数(0-2000)', icon: 'none' })
      return
    }

    // 折射率推荐
    let recommendedIndex = LENS_INDEX_RULES[0]
    for (const rule of LENS_INDEX_RULES) {
      if (deg <= rule.maxDegree) {
        recommendedIndex = rule
        break
      }
    }

    // 用途推荐
    const usageInfo = USAGE_RECOMMENDATIONS[selectedUsage]

    this.setData({
      lensAdvice: {
        degree: deg,
        index: recommendedIndex.index,
        indexName: recommendedIndex.name,
        lensType: usageInfo.lensType,
        coating: usageInfo.coating,
        usageDesc: usageInfo.desc
      }
    })
  },

  onCopy() {
    const { result, displayResult, displayResultSource, frameRecommendation, lensAdvice, medianResult } = this.data
    const primary = displayResult || result
    if (!primary) {
      return
    }

    const lines = [
      '【瞳距测量结果】',
      `结果来源：${displayResultSource}`,
      `总瞳距：${primary.totalPd} mm`,
      `左眼 PD：${primary.leftPd} mm`,
      `右眼 PD：${primary.rightPd} mm`
    ]

    if (primary.faceWidth) {
      lines.push('')
      lines.push('【脸部测量】')
      lines.push(`脸宽：${primary.faceWidth} mm`)
    }

    if (medianResult) {
      lines.push('')
      lines.push('【中位数推荐】')
      lines.push(`总瞳距：${medianResult.totalPd} mm`)
      lines.push(`左眼 PD：${medianResult.leftPd} mm`)
      lines.push(`右眼 PD：${medianResult.rightPd} mm`)
      if (medianResult.faceWidth) {
        lines.push(`脸宽：${medianResult.faceWidth} mm`)
      }
    }

    if (frameRecommendation) {
      lines.push('')
      lines.push('【镜框推荐】')
      lines.push(`推荐镜框宽度：${frameRecommendation.minFrameWidth}-${frameRecommendation.maxFrameWidth} mm`)
      lines.push(`脸型：${frameRecommendation.faceType}`)
    }

    if (lensAdvice) {
      lines.push('')
      lines.push('【镜片建议】')
      lines.push(`度数：${lensAdvice.degree}度`)
      lines.push(`推荐折射率：${lensAdvice.index}（${lensAdvice.indexName}）`)
      lines.push(`推荐镜片：${lensAdvice.lensType}`)
      lines.push(`推荐膜层：${lensAdvice.coating}`)
    }

    lines.push('')
    lines.push(`可信度：${primary.confidence}`)

    wx.setClipboardData({
      data: lines.join('\n'),
      success: () => {
        wx.showToast({
          title: '已复制',
          icon: 'success'
        })
      }
    })
  },

  onRetake() {
    wx.navigateTo({
      url: '/pages/measure/measure'
    })
  },

  onBackHome() {
    wx.reLaunch({
      url: '/pages/index/index'
    })
  }
})
