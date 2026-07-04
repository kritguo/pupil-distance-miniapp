// 测量页：拍照 → 云端虹膜测量 → 出结果
// 虹膜直径比例尺方案，无需卡片、无需手动校准。云端失败/质量差则提示重拍。

const config = require('../../config.js')
const userUtil = require('../../utils/user.js')
const { buildCloudPdFields, buildMeasurePayload, isNumber } = require('../../utils/pd.js')
const measureModeUtil = require('../../utils/measure_mode.js')
const measureLog = require('../../utils/measure_log.js')
const measureRequest = require('../../utils/measure_request.js')
const measureFeedback = require('../../utils/measure_feedback.js')

const MIN_AUTO_QUALITY_SCORE = 0.8
const ESCAPE_AFTER_FAILS = 3   // 同一张连续不达标 N 次后，才允许以低可信度放行
const MODE_INTRO_KEY = 'pd_measure_mode_intro_seen'

const toNumber = (value) => {
  if (isNumber(value)) return value
  if (typeof value !== 'string') return null
  const matches = value.match(/-?\d+(?:\.\d+)?/g)
  if (!matches || matches.length === 0) return null
  const num = Number(matches[0])
  return Number.isNaN(num) ? null : num
}

Page({
  data: {
    cameraPosition: 'front',
    measureMode: 'normal',
    modeCopy: measureModeUtil.getMeasureModeCopy('normal'),
    precisionModeEnabled: measureModeUtil.isPrecisionRetestEnabled(),
    precisionCardGuideStyle: measureModeUtil.getPrecisionCardGuideStyle(),
    modeIntro: measureModeUtil.getModeIntroCopy(),
    showModeIntro: false,
    captureNotice: '',
    detecting: false,
    shotIndex: 0,      // 已完成的拍摄次数
    totalShots: 3      // 一次会话拍 3 次取中位数
  },

  imageInfo: null,
  sessionResults: [],  // 本次会话累计的 3 次结果
  launchedWithExplicitMode: false,
  forcePurchase: false,
  measureRequestToken: 0,
  measureTimeoutTimer: null,
  measureStageTimeoutTimer: null,

  onLoad(options) {
    const initialMode = measureModeUtil.normalizeMeasureMode(options && options.mode)
    this.launchedWithExplicitMode = !!(options && options.mode)
    this.forcePurchase = !!(options && options.forcePurchase === '1')
    // 每次进入测量页 = 一次全新的 3 连拍会话，清空上一轮残留，避免新旧数据混淆
    this.sessionResults = []
    this.shotFailCount = 0
    this.setData({
      shotIndex: 0,
      measureMode: initialMode,
      modeCopy: measureModeUtil.getMeasureModeCopy(initialMode)
    })
    if (userUtil.isUnlimited()) {
      // 年度会员/dev：每次都是独立一轮，三个批次全部重置
      userUtil.resetUnlimitedSession()
      userUtil.resetTrialBatch()
      userUtil.resetSingleBatch()
    }
    // 进页面即预热云托管容器：用户对准脸的几秒里把它唤醒，规避冷启动超时
    this.warmUpService()
    // 合规：首次测量前确认面部数据使用同意
    this.ensureFaceConsent()
  },

  onUnload() {
    if (this.measureTimeoutTimer) {
      clearTimeout(this.measureTimeoutTimer)
      this.measureTimeoutTimer = null
    }
    this.clearMeasureStageDeadline()
    this.measureRequestToken = 0
  },

  // 面部数据使用同意（首次弹一次，本地记住；不同意则退出测量页）
  ensureFaceConsent() {
    if (wx.getStorageSync('pd_face_consent')) {
      this.showModeIntroOnce()
      return
    }
    wx.showModal({
      title: '面部数据使用说明',
      content: '测量瞳距需要拍摄你的正脸照片。照片仅用于本次瞳距识别，识别完成后即从服务器删除，不会留存或用于其他用途。是否同意并继续？',
      confirmText: '同意并继续',
      cancelText: '不同意',
      success: (res) => {
        if (res.confirm) {
          wx.setStorageSync('pd_face_consent', Date.now())
          this.showModeIntroOnce()
        } else {
          wx.navigateBack()
        }
      }
    })
  },

  showModeIntroOnce() {
    if (!measureModeUtil.isPrecisionModeEnabled()) return
    if (this.launchedWithExplicitMode) return
    if (wx.getStorageSync(MODE_INTRO_KEY)) return
    this.setData({ showModeIntro: true })
  },

  closeModeIntro(mode) {
    wx.setStorageSync(MODE_INTRO_KEY, Date.now())
    this.setData({ showModeIntro: false })
    this.applyMeasureMode(mode)
  },

  onModeIntroNormal() {
    this.closeModeIntro('normal')
  },

  onModeIntroPrecision() {
    if (!measureModeUtil.isPrecisionModeEnabled()) {
      this.closeModeIntro('normal')
      return
    }
    this.closeModeIntro('precision')
  },

  // 预热：给测量容器发个轻量请求把它从缩容(0 实例)状态唤醒。fire-and-forget，失败无所谓。
  warmUpService() {
    const cloudAuto = config.cloudAuto || {}
    if (!cloudAuto.enabled) return
    try {
      if (cloudAuto.mode === 'container' && wx.cloud && typeof wx.cloud.callContainer === 'function') {
        wx.cloud.callContainer({
          config: { env: cloudAuto.containerEnv || '' },
          path: '/health',
          method: 'GET',
          timeout: 20000,
          header: { 'X-WX-SERVICE': cloudAuto.service },
          success: () => {},
          fail: () => {}
        })
      } else if (cloudAuto.endpoint && typeof wx.request === 'function') {
        wx.request({
          url: cloudAuto.endpoint.replace(/\/v1\/measure.*$/, '/health'),
          method: 'GET',
          timeout: 20000,
          success: () => {},
          fail: () => {}
        })
      }
    } catch (e) {}
  },

  goBack() {
    wx.navigateBack()
  },

  switchCamera() {
    this.setData({
      cameraPosition: this.data.cameraPosition === 'front' ? 'back' : 'front'
    })
  },

  applyMeasureMode(mode) {
    const nextMode = measureModeUtil.normalizeMeasureMode(mode)
    this.sessionResults = []
    this.shotFailCount = 0
    this.setData({
      measureMode: nextMode,
      modeCopy: measureModeUtil.getMeasureModeCopy(nextMode),
      shotIndex: 0,
      captureNotice: '',
      detecting: false
    })
  },

  switchMeasureMode(e) {
    if (!measureModeUtil.isPrecisionModeEnabled()) return
    if (this.data.detecting) return
    const nextMode = measureModeUtil.normalizeMeasureMode(e.currentTarget.dataset.mode)
    if (nextMode === this.data.measureMode) return
    if (this.sessionResults.length > 0) {
      wx.showModal({
        title: '切换测量模式',
        content: '切换后需要重新拍 3 张，避免普通模式和精确模式混在同一组结果里。',
        confirmText: '重新开始',
        cancelText: '继续当前',
        success: (res) => {
          if (res.confirm) this.applyMeasureMode(nextMode)
        }
      })
      return
    }
    this.applyMeasureMode(nextMode)
  },

  onHelp() {
    wx.showModal({
      title: '拍摄要点',
      content: this.data.modeCopy.help,
      showCancel: false,
      confirmText: '知道了'
    })
  },

  takePhoto() {
    if (this.data.detecting) return
    this.setData({ detecting: true, captureNotice: '' })
    const ctx = wx.createCameraContext()
    ctx.takePhoto({
      quality: measureRequest.CAMERA_PHOTO_QUALITY,
      success: (res) => this.preparePhoto(res.tempImagePath),
      fail: () => {
        this.setData({ detecting: false })
        wx.showToast({ title: '拍照失败，请重试', icon: 'none' })
      }
    })
  },

  preparePhoto(path) {
    const token = this.beginMeasureRequest()
    this.showMeasureLoading('compress', token)
    this.setData({ detecting: true, captureNotice: '' })
    this.requestAutoMeasureServer(path, 0, token)
  },

  showMeasureLoading(stage, token) {
    wx.showLoading({ title: measureRequest.getMeasureStageTitle(stage), mask: true })
    this.startMeasureStageDeadline(stage, token)
  },

  clearMeasureStageDeadline() {
    if (this.measureStageTimeoutTimer) {
      clearTimeout(this.measureStageTimeoutTimer)
      this.measureStageTimeoutTimer = null
    }
  },

  startMeasureStageDeadline(stage, token) {
    this.clearMeasureStageDeadline()
    const timeoutMs = measureRequest.getMeasureStageTimeoutMs(stage)
    if (!token || !timeoutMs) return
    this.measureStageTimeoutTimer = setTimeout(() => {
      if (!this.isActiveMeasureRequest(token)) return
      this.completeMeasureRequest(token)
      this.handleMeasureFail(measureRequest.buildMeasureStageTimeoutMessage(stage, timeoutMs))
    }, timeoutMs)
  },

  beginMeasureRequest() {
    if (this.measureTimeoutTimer) {
      clearTimeout(this.measureTimeoutTimer)
      this.measureTimeoutTimer = null
    }
    const token = measureRequest.createMeasureRequestToken(this.measureRequestToken)
    this.measureRequestToken = token
    this.measureTimeoutTimer = setTimeout(() => {
      if (!measureRequest.isActiveMeasureRequest(this.measureRequestToken, token)) return
      this.completeMeasureRequest(token)
      this.handleMeasureFail(measureRequest.buildMeasureTimeoutMessage())
    }, measureRequest.MEASURE_REQUEST_TIMEOUT_MS)
    return token
  },

  isActiveMeasureRequest(token) {
    return measureRequest.isActiveMeasureRequest(this.measureRequestToken, token)
  },

  completeMeasureRequest(token) {
    if (!this.isActiveMeasureRequest(token)) return false
    if (this.measureTimeoutTimer) {
      clearTimeout(this.measureTimeoutTimer)
      this.measureTimeoutTimer = null
    }
    this.clearMeasureStageDeadline()
    this.measureRequestToken = 0
    wx.hideLoading()
    this.setData({ detecting: false })
    return true
  },

  // 上传照片到云端测量服务（attempt：当前是第几次尝试，用于冷启动超时自动重试）
  requestAutoMeasureServer(imagePath, attempt, token) {
    attempt = attempt || 0
    token = token || this.measureRequestToken
    const cloudAuto = config.cloudAuto || {}
    if (!cloudAuto.enabled || !cloudAuto.endpoint) {
      this.completeMeasureRequest(token)
      wx.showModal({
        title: '未配置测量服务',
        content: '测量服务未启用，请联系开发者配置后再使用。',
        showCancel: false
      })
      return
    }

    if (!this.isActiveMeasureRequest(token)) return
    this.showMeasureLoading('compress', token)

    const fail = (message) => {
      if (!this.isActiveMeasureRequest(token)) return
      // 冷启动超时：第一次请求其实已把容器唤醒，自动重试一次（不打断、不弹窗）
      if (measureRequest.isRetryableMeasureTimeout(message, attempt)) {
        this.showMeasureLoading('retry', token)
        setTimeout(() => {
          if (this.isActiveMeasureRequest(token)) {
            this.requestAutoMeasureServer(imagePath, attempt + 1, token)
          }
        }, 1500)
        return
      }
      if (this.completeMeasureRequest(token)) this.handleMeasureFail(message)
    }

    const onServerData = (data) => {
      if (!this.completeMeasureRequest(token)) return
      try {
        if (data && data.ok && buildCloudPdFields(data, this.data.measureMode)) {
          this.applyCloudPdResult(data)
        } else {
          this.handleMeasureFail((data && data.message) || '未能识别到人脸，请正对镜头、保证光线充足后重拍。')
        }
      } catch (err) {
        console.error('[Measure] 结果处理异常:', err, data)
        this.handleMeasureFail(measureFeedback.buildResultHandlingErrorMessage())
      }
    }

    wx.compressImage({
      src: imagePath,
      quality: measureRequest.normalizeUploadImageQuality(cloudAuto.quality),
      success: (res) => {
        const compressedPath = res.tempFilePath
        if (!this.isActiveMeasureRequest(token)) return
        this.showMeasureLoading('upload', token)
        // 传输细节（http base64 / 云托管中转+用完即删）在 utils/measure_request.js，已被测试覆盖
        measureRequest.sendMeasure({
          cloudAuto,
          filePath: compressedPath,
          buildPayload: (image) => buildMeasurePayload({
            ...image,
            cameraPosition: this.data.cameraPosition,
            measureMode: this.data.measureMode
          }),
          isActive: () => this.isActiveMeasureRequest(token),
          onStage: (stage) => this.showMeasureLoading(stage, token),
          onData: onServerData,
          onFail: fail
        })
      },
      fail: () => fail('图片处理失败，请重拍。')
    })
  },

  handleMeasureFail(message) {
    // 完整错误打到 console 便于排查；给用户看干净的中文提示，别把云端 trace 糊脸上
    console.warn('[Measure] 失败原始信息:', message)
    const raw = String(message || '')
    let friendly = raw
    if (/超时|timeout|102002/i.test(raw)) {
      friendly = '测量服务响应超时（服务可能正在冷启动）。请稍等几秒，再点「重新拍摄」试一次。'
    } else if (/连接失败|callContainer:fail|request:fail|network|ECONN/i.test(raw)) {
      friendly = '网络连接不稳定，请检查网络后重拍。'
    } else if (raw.length > 90) {
      friendly = raw.slice(0, 90) + '…'
    }
    wx.showModal({
      title: '测量未成功',
      content: friendly,
      confirmText: '重新拍摄',
      showCancel: false,
      success: () => this.retake()
    })
  },

  // 把云端质量校验整理成给用户的提示文案；无问题返回 null
  getCloudAutoQualityIssue(data) {
    const validation = (data && data.validation) || null
    const quality = (data && data.quality) || null
    if (!validation && !quality) return null

    const issues = []
    const score = quality ? toNumber(quality.score) : null
    const irisConfidence = toNumber(data && data.iris && data.iris.confidence)

    if (validation && validation.overall_valid === false) {
      if (validation.eyes_level === false) issues.push('双眼不够水平')
      if (validation.face_frontal === false) issues.push('人脸不够正')
      if (validation.head_straight === false) issues.push('有偏头，请正脸面向镜头')
      if (validation.iris_detected === false) issues.push('虹膜未识别清晰')
      if (validation.face_in_frame === false) issues.push('脸部没有完整入框')
      if (validation.distance_suitable === false) issues.push('距离不合适')
      if (validation.pd_symmetry === false) issues.push('左右单眼瞳距差异过大')
      if (validation.pd_in_range === false) issues.push('瞳距超出常见范围')
      if (!issues.length) issues.push('拍摄质量不佳')
    }
    if (score !== null && score < MIN_AUTO_QUALITY_SCORE) {
      issues.push(`质量分偏低(${Math.round(score * 100)}%)`)
    }

    if (!issues.length) return null
    const suggestion = quality && quality.suggestion
      ? `。${quality.suggestion}`
      : '。建议正对镜头、双眼睁大、光线充足后重拍。'
    return `${issues.slice(0, 3).join('、')}${suggestion}`
  },

  handlePrecisionModeIssue(message) {
    this.shotFailCount = (this.shotFailCount || 0) + 1
    this.setData({
      detecting: false,
      captureNotice: measureFeedback.buildPrecisionRetakeNotice(message, this.shotFailCount)
    })
  },

  // 处理云端返回的瞳距结果（拍照即出结果）
  applyCloudPdResult(data) {
    const pdFields = buildCloudPdFields(data, this.data.measureMode)
    if (!pdFields) {
      this.handleMeasureFail('未能识别到有效瞳距，请正对镜头、保证光线充足后重拍。')
      return
    }
    const { totalPd, leftPd, rightPd } = pdFields

    // 瞳距超出生理范围：检测出错，硬性重拍，绝不放行（不会污染中位数）
    if (totalPd < 50 || totalPd > 80) {
      this.shotFailCount = (this.shotFailCount || 0) + 1
      // 连续多次超范围：给具体排查建议 + 返回出口，避免卡死
      if (this.shotFailCount >= 3) {
        wx.showModal({
          title: '多次未能测准',
          content: '连续几次测得的瞳距都超出正常范围(50–80mm)。多为光线不足、距离不对(约一臂距离)或没摘眼镜所致。建议换光线充足的环境、正对镜头、摘掉眼镜再试。',
          confirmText: '再试一次',
          cancelText: '返回',
          success: (res) => {
            if (res.confirm) this.setData({ detecting: false })
            else wx.navigateBack()
          }
        })
        return
      }
      this.handleMeasureFail(`检测到瞳距 ${totalPd}mm，超出正常范围(50-80mm)，请正对镜头、光线充足后重拍。`)
      return
    }

    const precisionIssue = measureModeUtil.getPrecisionCardIssue(data, this.data.measureMode)
    if (precisionIssue) {
      this.handlePrecisionModeIssue(precisionIssue)
      return
    }

    const qualityIssue = this.getCloudAutoQualityIssue(data)
    if (qualityIssue) {
      this.shotFailCount = (this.shotFailCount || 0) + 1
      if (this.shotFailCount < ESCAPE_AFTER_FAILS) {
        // 严格门控：自动打回重拍，不给放行
        wx.showModal({
          title: '这张不达标',
          content: `${qualityIssue}\n请按提示调整后重拍这一张。`,
          confirmText: '重新拍摄',
          showCancel: false,
          success: () => this.setData({ detecting: false })
        })
      } else {
        // 逃生阀：连续多次不达标，允许以「较低可信度」放行，避免卡死
        wx.showModal({
          title: `已连续 ${this.shotFailCount} 次不达标`,
          content: `${qualityIssue}\n可以继续重拍，或以「较低可信度」先用这一张。`,
          confirmText: '重新拍摄',
          cancelText: '仍要使用',
          success: (res) => {
            if (res.confirm) this.setData({ detecting: false })
            else this.commitShot(pdFields, '低')
          }
        })
      }
      return
    }

    // 合格：按质量分给可信度
    let confidence = '高'
    const qs = data.quality ? toNumber(data.quality.score) : null
    if (qs !== null) {
      confidence = qs >= 0.85 ? '高' : (qs >= MIN_AUTO_QUALITY_SCORE ? '中' : '低')
    }
    this.commitShot(pdFields, confidence)
  },

  // 把一张合格(或逃生阀放行)的结果计入会话
  commitShot(pdFields, confidence) {
    const result = {
      totalPd: pdFields.totalPd,
      leftPd: pdFields.leftPd,
      rightPd: pdFields.rightPd,
      nearTotalPd: pdFields.nearTotalPd,
      nearLeftPd: pdFields.nearLeftPd,
      nearRightPd: pdFields.nearRightPd,
      pdBasis: pdFields.pdBasis,
      faceWidth: null,
      confidence,
      timestamp: Date.now(),
      source: this.data.measureMode === 'precision' ? 'cloud_auto_precision' : 'cloud_auto',
      measureMode: this.data.measureMode
    }
    this.onMeasured(result)
  },

  // 失败/重拍：不计入本次，已完成的次数保留
  retake() {
    this.setData({ detecting: false, captureNotice: '' })
  },

  showCaptureNotice(message) {
    this.setData({ captureNotice: message })
  },

  // 一次拍摄成功后累计到会话；不满 3 次用常驻引导+进度点推进（不打断），满 3 次出中位数结果
  onMeasured(result) {
    this.shotFailCount = 0   // 这一张已通过，下一张失败计数清零
    this.sessionResults.push(result)
    const done = this.sessionResults.length
    if (done < this.data.totalShots) {
      // 不弹模态：点亮进度、解锁快门，快门上方持续提示继续拍下一张
      this.setData({ shotIndex: done, detecting: false })
      this.showCaptureNotice(measureFeedback.buildShotAcceptedNotice(done, this.data.totalShots))
      return
    }
    // 第 3 张完成：进度点全亮，跳结果页
    this.setData({ shotIndex: done })
    this.finishSession()
  },

  // 3 次拍完：存入对应批次（供结果页取中位数），跳转结果页
  finishSession() {
    const results = this.sessionResults.slice(0, this.data.totalShots)
    const isUnlimited = userUtil.isUnlimited()
    const canFree = !this.forcePurchase && userUtil.canMeasureFree()

    if (isUnlimited) {
      results.forEach((r) => userUtil.addUnlimitedSessionResult(r))
    } else if (canFree) {
      userUtil.resetSingleBatch()
      results.forEach((r) => userUtil.addSingleResult(r))
    } else {
      userUtil.resetTrialBatch()
      results.forEach((r) => userUtil.addTrialResult(r))
    }

    const last = results[results.length - 1]
    wx.setStorageSync('latestResult', last)
    measureLog.logMeasureSession(measureLog.buildMeasureSessionPayload({
      results,
      mode: this.data.measureMode,
      quotaSource: measureLog.resolveQuotaSource(userUtil.getUserInfo(), {
        isUnlimited,
        forcePurchase: this.forcePurchase
      }),
      forcePurchase: this.forcePurchase
    }))
    const isTrial = (!isUnlimited && !canFree)
    const query = []
    if (isTrial) query.push('trial=1')
    if (this.forcePurchase) query.push('forcePurchase=1')
    wx.navigateTo({ url: '/pages/result/result' + (query.length ? `?${query.join('&')}` : '') })
  },

  onShareAppMessage() {
    return { title: '快速测瞳距PDgo · 正脸拍照，快速测出你的瞳距', path: '/pages/index/index' }
  },
  onShareTimeline() {
    return { title: '快速测瞳距PDgo · 正脸拍照，快速测出你的瞳距' }
  }
})
