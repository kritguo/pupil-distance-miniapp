const userUtil = require('../../utils/user.js')
const pay = require('../../utils/pay.js')
const { MEASURE_TARGET_COUNT, resultRecordFields, buildSpreadDots, buildMedianResult } = require('../../utils/result_stats.js')
const { buildLensAdvice } = require('../../utils/lens_advice.js')
const measureEntry = require('../../utils/measure_entry.js')

const hasUsableRetestCredit = (out) => !!(out && out.ok && (out.granted || (out.retestCredits || 0) > 0))

const buildPrecisionInvite = (platform, confidence, isUnlimited) => {
  const weak = confidence && confidence !== '高'
  if (platform === 'ios') {
    // iOS 只做深度相机卖点引导；unionid 权益桥建好前，不承诺「免费/微信登录自动同步」
    return {
      target: 'ios_app',
      planType: isUnlimited ? 'annual' : 'single',
      planLabel: isUnlimited ? '会员' : '更精准',
      title: weak ? '建议用 App 深度相机复测' : '用 App 深度相机再确认一次',
      desc: 'PDgo App 用 iPhone 深度相机测量，比照片测量更精准。',
      buttonText: weak ? '去用 App 深度测量' : '了解 App 深度测量'
    }
  }
  return {
    target: 'precision_card',
    planType: isUnlimited ? 'annual' : 'single',
    planLabel: isUnlimited ? '会员不限次' : '免费复测 1 次',
    title: weak ? '建议用卡片精准确认一次' : '用卡片精准确认一次',
    desc: isUnlimited
      ? '会员可不限次用身份证或银行卡辅助校验，适合多次复测或给家人使用。'
      : '照片测量可能存在轻微误差。已为你保留 1 次免费复测，可用身份证或银行卡辅助校验，再确认一遍。',
    buttonText: isUnlimited ? '使用卡片精准确认' : '免费用卡片复测'
  }
}

const isPrecisionMeasuredResult = (result, displayResult) => !!(
  (result && result.measureMode === 'precision')
  || (result && result.source === 'cloud_auto_precision')
  || (displayResult && /^precision/.test(String(displayResult.pdBasis || '')))
)

Page({
  data: {
    result: null,
    displayResult: null,
    displayResultSource: '本次测量',
    measureName: '',   // 测量对象（给谁测的，可编辑、随记录保存）
    freeRetestReady: false, // 已为当前付费结果发放免费精度复测额度（下次测量不扣费）
    showManualRetestTip: false, // 旧字段保留给历史入口，当前结果页统一走精度复测邀请
    retestRequesting: false,
    empty: false,
    // 付费相关
    showPayModal: false,
    isPaid: false,
    isUnlimited: false,
    selectedPlan: 'single', // single | unlimited（默认 single，与首页「一次测量 ¥9.9」口径一致）
    fromRecord: false,
    trialMode: false,
    forcePurchase: false,
    progressText: '',
    medianResult: null,
    medianWarning: '',
    medianCount: 0,
    spreadDots: [],
    spreadMaxDiff: 0,
    nextMeasureText: '再测一次',
    clientPlatform: 'other',
    precisionInvite: buildPrecisionInvite('other', ''),
    showPrecisionInvite: false,
    trialResults: [],
    // 镜片建议（按验光单分左右眼：球镜 + 散光选填）
    sphL: '', sphR: '', cylL: '', cylR: '',
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
    const forcePurchase = options && options.forcePurchase === '1'
    const clientPlatform = measureEntry.resolveClientPlatform()
    const hasTrialResults = userUtil.getTrialResults().length >= 3
    const hasBatchResults = userUtil.getSingleBatchResults().length >= 3
    const trialMode = !fromRecord && ((options && options.trial === '1') || hasTrialResults || hasBatchResults)
    this.setData({
      result,
      displayResult: result,
      displayResultSource: '本次测量',
      measureName: result.name || '',
      fromRecord,
      trialMode,
      forcePurchase,
      clientPlatform,
      precisionInvite: buildPrecisionInvite(clientPlatform, result.confidence, false),
      selectedPlan: forcePurchase ? 'single' : this.data.selectedPlan
    })

    // 先同步服务端权益，再检查付费状态
    this.initEntitlement()

    if (trialMode) {
      this.loadTrialSummary()
    }
  },

  onShow() {
    if (!this.data.isPaid || this.data.isUnlimited || this.data.fromRecord) return
    const info = userUtil.getUserInfo()
    if ((info.retestCredits || 0) <= 0 && this.data.freeRetestReady) {
      this.setData({ freeRetestReady: false })
    }
    this.refreshPrecisionInvite()
  },

  buildPrecisionInvitePatch(displayResult, overrides) {
    const state = { ...this.data, ...(overrides || {}) }
    const primary = displayResult || state.displayResult
    const invite = buildPrecisionInvite(state.clientPlatform, primary && primary.confidence, state.isUnlimited)
    const precisionHighDone = isPrecisionMeasuredResult(state.result, primary)
      && primary
      && primary.confidence === '高'
      && !state.isUnlimited
    const showPrecisionInvite = !!(state.isPaid && !state.fromRecord && primary && !precisionHighDone)
    return {
      precisionInvite: invite,
      showPrecisionInvite,
      nextMeasureText: state.fromRecord ? '再测一次' : invite.buttonText
    }
  },

  refreshPrecisionInvite(displayResult) {
    this.setData(this.buildPrecisionInvitePatch(displayResult))
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

    if (this.data.forcePurchase) {
      this.setData({ isPaid: false, isUnlimited: false, showPayModal: true })
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
          this.maybeGrantRetest()   // 普通首测发精度复测额度；精度复测中/低继续发
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
      showManualRetestTip: false,
      progressText: results.length >= MEASURE_TARGET_COUNT
        ? `已完成 ${MEASURE_TARGET_COUNT} 次测量，优先使用中位数结果`
        : '',
      ...this.buildPrecisionInvitePatch(displayResult)
    })
  },

  canShowManualRetestTip(displayResult) {
    const { isPaid, isUnlimited, fromRecord, result } = this.data
    return !!(isPaid
      && !isUnlimited
      && !fromRecord
      && result
      && result.timestamp
      && displayResult
      && displayResult.confidence === '高')
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
        showManualRetestTip: false,
        ...this.buildPrecisionInvitePatch(displayResult)
      })
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
    this.setData({
      progressText,
      medianResult,
      medianWarning: medianResult ? medianResult.warning : '',
      medianCount: count,
      spreadDots: spread.dots,
      spreadMaxDiff: spread.maxDiff,
      displayResult,
      displayResultSource: medianResult ? '三次中位数推荐' : '本次测量',
      showManualRetestTip: false,
      ...this.buildPrecisionInvitePatch(displayResult)
    })
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

  // 单次套餐：把试测/当前结果并入三次包，并用最终结果时间戳向服务端解锁一次（扣次，幂等）
  absorbResultsAsSingle(trialMode) {
    const results = trialMode
      ? userUtil.getTrialResults()
      : (this.data.result ? [this.data.result] : [])

    if (trialMode && results.length) {
      userUtil.resetSingleBatch()
    }
    results.forEach((item) => userUtil.addSingleResult(item))
    const unlockKey = this.data.result && this.data.result.timestamp
    if (!unlockKey) return

    pay.consume(unlockKey, { preferPaid: this.data.forcePurchase }).then(() => {
      userUtil.setLastUnlockedResult(unlockKey)
      if (trialMode) {
        userUtil.resetTrialBatch()
        this.loadTrialSummary()
      } else {
        this.updateProgress()
      }
      this.saveRecord()   // 付费解锁后存进个人中心
      this.maybeGrantRetest()   // 普通首测发精度复测额度；精度复测中/低继续发
      this.setData({ isUnlimited: userUtil.isUnlimited() })
    })
  },

  // 关闭付费弹窗：真实收起，露出打码的报告骨架；吸底解锁栏可随时再次打开
  closePayModal() {
    this.setData({ showPayModal: false })
  },

  // 吸底「解锁」按钮 → 重新打开付费弹窗
  openPayModal() {
    this.setData({ showPayModal: true })
  },

  // 度数/散光输入（左右眼，data-field 指定字段）
  onLensInput(e) {
    const field = e.currentTarget.dataset.field
    if (field) this.setData({ [field]: e.detail.value })
  },

  // 用途选择
  onUsageChange(e) {
    this.setData({ selectedUsage: e.detail.value })
  },

  // 计算镜片建议（规则在 utils/lens_advice.js，已被测试覆盖；页面只管收输入与展示）
  calcLensAdvice() {
    const { sphL, sphR, cylL, cylR, selectedUsage, displayResult, result } = this.data
    const primary = displayResult || result
    const out = buildLensAdvice({
      sphL, sphR, cylL, cylR,
      usage: selectedUsage,
      pd: primary && primary.totalPd
    })
    if (!out.ok) {
      wx.showToast({ title: out.error, icon: 'none' })
      return
    }
    this.setData({ lensAdvice: out.advice })
  },

  onCopy() {
    const { result, displayResult, displayResultSource, lensAdvice, medianResult, isPaid } = this.data
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

    if (lensAdvice) {
      lines.push('')
      lines.push('【镜片建议】')
      lines.push(`有效度数：左 ${lensAdvice.effL} / 右 ${lensAdvice.effR} 度`)
      lines.push(`推荐折射率：${lensAdvice.index}（${lensAdvice.indexName}）`)
      lines.push(`镜片面型：${lensAdvice.lensShape}`)
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

  // 普通首测解锁后 → 赠送一次精度复测；精度复测仍中/低 → 继续发精度复测额度，直到测出「高」。
  // 年度会员本就不限次、从历史进入不发。
  maybeGrantRetest() {
    const { isUnlimited, fromRecord, result, displayResult } = this.data
    if (isUnlimited || fromRecord || !result || !result.timestamp) return
    const primary = displayResult || result
    const isPrecisionResult = isPrecisionMeasuredResult(result, primary)
    const conf = primary && primary.confidence
    if (isPrecisionResult && conf === '高') return
    return pay.grantRetest(result.timestamp, isPrecisionResult ? 'precision_quality' : 'precision_invite').then((out) => {
      if (hasUsableRetestCredit(out)) {
        this.setData({ freeRetestReady: true })
      }
    })
  },

  primeLocalPrecisionRetestCredit() {
    const info = userUtil.getUserInfo()
    if ((info.retestCredits || 0) <= 0) {
      info.retestCredits = 1
      userUtil.saveUserInfo(info)
    }
    this.setData({ freeRetestReady: true })
  },

  grantPrecisionRetestInBackground(reason) {
    const { isUnlimited, result } = this.data
    if (isUnlimited || !result || !result.timestamp) return
    pay.grantRetest(result.timestamp, reason || 'precision_invite').then((out) => {
      if (hasUsableRetestCredit(out)) {
        this.setData({ freeRetestReady: true })
      }
    })
  },

  navigateToAppDownload(plan) {
    const query = [
      `plan=${encodeURIComponent(plan || 'single')}`,
      'source=precision_retest'
    ].join('&')
    wx.navigateTo({ url: `/pages/app-download/app-download?${query}` })
  },

  onPrecisionRetest() {
    if (this.data.precisionInvite.target === 'ios_app') {
      // iOS：纯 App 引导（深度相机卖点），不做额度前置校验、不弹阻断窗，直达下载承接页
      this.navigateToAppDownload(this.data.isUnlimited ? 'annual' : 'single')
      return
    }
    if (this.data.isUnlimited) {
      this.navigateToMeasure('precision')
      return
    }
    this.primeLocalPrecisionRetestCredit()
    this.grantPrecisionRetestInBackground('precision_card')
    this.navigateToMeasure('precision')
  },

  /*
   * 兼容旧入口：页面上不再展示普通重测入口，统一转到精度复测。
   */
  onFreeRetest() {
    this.onPrecisionRetest()
  },

  onManualRetest() {
    this.onPrecisionRetest()
  },

  /*
   * 旧复测申请函数仍保留给测试/历史入口兜底，默认走精度模式。
   */
  requestRetestCredit(reason, targetMode) {
    const { result, retestRequesting } = this.data
    if (!result || !result.timestamp || retestRequesting) return
    this.setData({ retestRequesting: true })
    pay.grantRetest(result.timestamp, reason).then((out) => {
      this.setData({ retestRequesting: false })
      if (hasUsableRetestCredit(out)) {
        this.setData({ freeRetestReady: true, showManualRetestTip: false })
        this.navigateToMeasure(targetMode || 'precision')
        return
      }
      wx.showModal({
        title: '暂时不能免费精度复测',
        content: '这条结果的免费精度复测权益可能已经用完。你仍可以重新测量，但需要重新购买或使用会员次数。',
        showCancel: false,
        confirmText: '知道了'
      })
    })
  },

  navigateToMeasure(mode) {
    wx.navigateTo({ url: measureEntry.buildMeasureUrl({ mode }) })
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
    if (this.data.isPaid && !this.data.fromRecord) {
      this.onPrecisionRetest()
      return
    }
    this.navigateToMeasure('normal')
  },

  onBackHome() {
    wx.reLaunch({
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
