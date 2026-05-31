const userUtil = require('../../utils/user.js')
const pay = require('../../utils/pay.js')

const roundToHalf = (value) => Math.round(value * 2) / 2
const isNumber = (value) => typeof value === 'number' && !Number.isNaN(value)
const MEASURE_TARGET_COUNT = 3
const STABLE_TOTAL_SPREAD_MM = 2
const USABLE_TOTAL_SPREAD_MM = 4

const resultRecordFields = (item) => ({
  totalPd: item.totalPd,
  leftPd: item.leftPd,
  rightPd: item.rightPd,
  nearTotalPd: item.nearTotalPd,
  nearLeftPd: item.nearLeftPd,
  nearRightPd: item.nearRightPd,
  pdBasis: item.pdBasis,
  faceWidth: item.faceWidth,
  confidence: item.confidence,
  timestamp: item.timestamp
})

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

// 三张总瞳距 → 波动点阵图数据。把每张的总 PD 映射到 10%~90% 轨道位置，标出中位数那张。
const buildSpreadDots = (results, medianTotal) => {
  const vals = numericResults(results).map((r) => r.totalPd)
  if (vals.length < 2) return { dots: [], maxDiff: 0 }
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const range = max - min
  // 离中位数最近的那张标为高亮（只标一张）
  let hiIdx = -1
  if (isNumber(medianTotal)) {
    let best = Infinity
    vals.forEach((v, i) => {
      const d = Math.abs(v - medianTotal)
      if (d < best) { best = d; hiIdx = i }
    })
  }
  const dots = vals.map((v, i) => ({
    id: i,
    pd: v,
    left: range === 0 ? 50 : Math.round(10 + ((v - min) / range) * 80),
    hi: i === hiIdx
  }))
  return { dots, maxDiff: roundToHalf(range) }
}

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
  const nearTotalPd = median(used.map(r => r.nearTotalPd))
  const nearLeftPd = median(used.map(r => r.nearLeftPd))
  const nearRightPd = median(used.map(r => r.nearRightPd))
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
    nearTotalPd,
    nearLeftPd,
    nearRightPd,
    pdBasis: used.some(r => r.pdBasis === 'far') ? 'far' : (used[0] && used[0].pdBasis),
    faceWidth,
    confidence: consistency === '稳定' ? '高' : (consistency === '一般' ? '中' : '低'),
    usedCount: used.length,
    totalCount: usable.length,
    totalSpread,
    leftSpread,
    rightSpread,
    consistency,
    warning: consistency === '波动大'
      ? `三张结果最大相差 ${totalSpread}mm，建议按同一姿势重新测量一次（再拍 3 张）`
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
    measureName: '',   // 测量对象（给谁测的，可编辑、随记录保存）
    freeRetestReady: false, // 本次结果中/低，已发放免费补测额度（下次测量不扣费）
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
    spreadDots: [],
    spreadMaxDiff: 0,
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
      measureName: result.name || '',
      fromRecord,
      trialMode
    })

    // 先同步服务端权益，再检查付费状态
    this.initEntitlement()

    // 自动计算镜框推荐
    this.calcFrameRecommendation(result.faceWidth)

    if (trialMode) {
      this.loadTrialSummary()
    }
  },

  // 同步服务端权益后再检查付费状态
  initEntitlement() {
    pay.syncEntitlement().then(() => {
      this.checkPayStatus()
    })
  },

  // 检查付费状态（在服务端权益同步之后调用）
  checkPayStatus() {
    const { result, fromRecord } = this.data

    // 年度会员：免费查看并保存
    if (userUtil.isUnlimited()) {
      this.setData({ isPaid: true, isUnlimited: true })
      if (!fromRecord && result && result.timestamp) {
        userUtil.addUnlimitedSessionResult(result)
      }
      this.updateProgress()
      if (!fromRecord && result && result.timestamp) {
        this.saveRecord()   // 在中位数算好后再存
      }
      return
    }

    // 从历史记录进入：直接展示
    if (fromRecord) {
      this.setData({ isPaid: true, isUnlimited: false })
      this.updateProgress()
      return
    }

    // 单次/未付费：由服务端判定这条结果能否查看（consume 幂等，不会重复扣费）
    if (result && result.timestamp) {
      pay.consume(result.timestamp).then((out) => {
        if (out === null) {
          // 网络异常：回退本地缓存判断
          const localOk = userUtil.canMeasureFree()
            || userUtil.canViewLatestResult(result.timestamp)
          this.setData({ isPaid: localOk, isUnlimited: false, showPayModal: !localOk })
          if (localOk) { this.updateProgress(); this.saveRecord(); this.maybeGrantRetest() }
          return
        }
        if (out.ok && (out.consumed || out.reason === 'already_unlocked')) {
          userUtil.setLastUnlockedResult(result.timestamp)
          userUtil.addSingleResult(result)
          this.setData({ isPaid: true, isUnlimited: false, showPayModal: false })
          this.updateProgress()
          this.saveRecord()   // 单次结果也存进个人中心
          this.maybeGrantRetest()   // 中/低则发免费补测额度
        } else {
          // 没有次数 / 未购买 -> 付费弹窗
          this.setData({ isPaid: false, showPayModal: true })
        }
      })
      return
    }

    this.setData({ isPaid: false, showPayModal: true })
  },

  loadTrialSummary() {
    const trialResults = userUtil.getTrialResults()
    const paidResults = userUtil.getSingleBatchResults()
    const results = trialResults.length ? trialResults : paidResults
    const medianResult = buildMedianResult(results)
    const displayResult = medianResult || this.data.result
    const spread = buildSpreadDots(results, medianResult && medianResult.totalPd)
    this.setData({
      trialResults: results,
      medianResult,
      medianWarning: medianResult ? medianResult.warning : '',
      medianCount: results.length,
      spreadDots: spread.dots,
      spreadMaxDiff: spread.maxDiff,
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
      const spread = buildSpreadDots(sessionResults, medianResult && medianResult.totalPd)
      const progressText = count >= 3
        ? `已完成 ${count} 次测量，优先使用中位数结果`
        : `已完成 ${count} 次测量，建议至少 3 次取中位数`
      this.setData({
        progressText,
        medianResult,
        medianWarning: medianResult ? medianResult.warning : '',
        medianCount: count,
        spreadDots: spread.dots,
        spreadMaxDiff: spread.maxDiff,
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
    const spread = buildSpreadDots(batchResults, medianResult && medianResult.totalPd)
    const nextMeasureText = count < total
      ? `继续第 ${count + 1} 次测量`
      : (medianResult && medianResult.consistency !== '稳定' ? '再测一次确认' : '再测一次')

    this.setData({
      progressText,
      medianResult,
      medianWarning: medianResult ? medianResult.warning : '',
      medianCount: count,
      spreadDots: spread.dots,
      spreadMaxDiff: spread.maxDiff,
      displayResult,
      displayResultSource: medianResult ? '三次中位数推荐' : '本次测量',
      nextMeasureText
    })
    this.calcFrameRecommendation(displayResult && displayResult.faceWidth)
  },

  // 保存测量记录（存推荐的中位数结果 + 测量对象名字；按会话时间戳去重）
  saveRecord() {
    const { result, displayResult, measureName } = this.data
    if (!result || !result.timestamp) return
    const base = displayResult || result
    const record = resultRecordFields(base)
    record.timestamp = result.timestamp
    record.name = measureName || ''
    userUtil.addRecord(record)
  },

  // 选择付费方案
  selectPlan(e) {
    this.setData({
      selectedPlan: e.currentTarget.dataset.plan
    })
  },

  // 确认支付（真实微信支付）
  onPay() {
    const { selectedPlan, trialMode } = this.data
    const plan = selectedPlan === 'single' ? 'single' : 'annual'

    pay.purchase(plan).then((res) => {
      if (!res || !res.ok) {
        if (res && res.code === 'CANCELLED') return
        wx.showModal({
          title: '支付未成功',
          content: ((res && res.message) || '支付失败') + (res && res.code ? `\n[${res.code}]` : ''),
          showCancel: false
        })
        return
      }
      // 支付成功，权益已由 pay.purchase 同步到本地
      const isUnlimited = userUtil.isUnlimited()
      this.setData({ showPayModal: false, isPaid: true, isUnlimited })

      if (isUnlimited) {
        this.absorbResultsAsUnlimited(trialMode)
      } else {
        this.absorbResultsAsSingle(trialMode)
      }
      wx.showToast({ title: '支付成功', icon: 'success' })
    })
  },

  // 年度会员：把试测/当前结果并入会话与历史
  absorbResultsAsUnlimited(trialMode) {
    const trialResults = trialMode ? userUtil.getTrialResults() : []
    if (trialResults.length) {
      trialResults.forEach((item) => {
        userUtil.addUnlimitedSessionResult(item)
        userUtil.addRecord(resultRecordFields(item))
      })
      userUtil.resetTrialBatch()
    } else if (this.data.result && this.data.result.timestamp) {
      userUtil.addUnlimitedSessionResult(this.data.result)
      this.saveRecord()
    }
    if (trialMode) {
      this.loadTrialSummary()
    } else {
      this.updateProgress()
    }
  },

  // 单次套餐：把试测/当前结果并入三次包，并按结果时间戳逐条向服务端解锁（扣次，幂等）
  absorbResultsAsSingle(trialMode) {
    const results = trialMode
      ? userUtil.getTrialResults()
      : (this.data.result ? [this.data.result] : [])

    const consumeNext = (list, i) => {
      if (i >= list.length) {
        if (trialMode) {
          userUtil.resetTrialBatch()
          this.loadTrialSummary()
        } else {
          this.updateProgress()
        }
        this.saveRecord()   // 付费解锁后存进个人中心
        this.maybeGrantRetest()   // 中/低则发免费补测额度
        this.setData({ isUnlimited: userUtil.isUnlimited() })
        return
      }
      const item = list[i]
      if (!item || !item.timestamp) {
        consumeNext(list, i + 1)
        return
      }
      userUtil.addSingleResult(item)
      pay.consume(item.timestamp).then(() => {
        userUtil.setLastUnlockedResult(item.timestamp)
        consumeNext(list, i + 1)
      })
    }
    consumeNext(results, 0)
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
    const { result, displayResult, displayResultSource, frameRecommendation, lensAdvice, medianResult, isPaid } = this.data
    if (!isPaid) {
      wx.showToast({ title: '请先解锁结果', icon: 'none' })
      return
    }
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

    if (primary.nearTotalPd) {
      lines.push('')
      lines.push('【近用参考】')
      lines.push(`近用总 PD：${primary.nearTotalPd} mm`)
      lines.push(`近用左眼 PD：${primary.nearLeftPd} mm`)
      lines.push(`近用右眼 PD：${primary.nearRightPd} mm`)
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

  // 本次结果可信度中/低 → 申请免费补测额度（下次测量不扣费，直到测出「高」为止）
  // 年度会员本就不限次、从历史进入不发；只对单次付费用户的中/低结果发放
  maybeGrantRetest() {
    const { isUnlimited, fromRecord, result, displayResult } = this.data
    if (isUnlimited || fromRecord || !result || !result.timestamp) return
    const conf = displayResult && displayResult.confidence
    if (conf !== '中' && conf !== '低') return
    pay.grantRetest(result.timestamp).then((out) => {
      if (out && (out.granted || out.reason === 'already_granted')) {
        this.setData({ freeRetestReady: true })
      }
    })
  },

  // 编辑「测量对象」名字（同步到本次结果缓存 + 已保存记录）
  onEditName() {
    const that = this
    wx.showModal({
      title: '标注测量对象',
      editable: true,
      placeholderText: '给谁测的？如：本人 / 妈妈 / 孩子',
      content: this.data.measureName || '',
      success: (res) => {
        if (!res.confirm) return
        const name = (res.content || '').trim().slice(0, 12)
        that.setData({ measureName: name })
        const latest = wx.getStorageSync('latestResult')
        if (latest) {
          latest.name = name
          wx.setStorageSync('latestResult', latest)
        }
        if (that.data.result && that.data.result.timestamp) {
          userUtil.updateRecordName(that.data.result.timestamp, name)
        }
      }
    })
  },

  // 点「已保存于个人中心」横幅 → 跳个人中心查看
  onViewSaved() {
    wx.switchTab({ url: '/pages/mine/mine' })
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
