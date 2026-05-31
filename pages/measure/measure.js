// 测量页：拍照 → 云端虹膜测量 → 出结果
// 虹膜直径比例尺方案，无需卡片、无需手动校准。云端失败/质量差则提示重拍。

const config = require('../../config.js')
const userUtil = require('../../utils/user.js')
const { buildCloudPdFields, buildMeasurePayload, isNumber } = require('../../utils/pd.js')

const MIN_AUTO_QUALITY_SCORE = 0.8
const ESCAPE_AFTER_FAILS = 3   // 同一张连续不达标 N 次后，才允许以低可信度放行

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
    detecting: false,
    shotIndex: 0,      // 已完成的拍摄次数
    totalShots: 3      // 一次会话拍 3 次取中位数
  },

  imageInfo: null,
  sessionResults: [],  // 本次会话累计的 3 次结果

  onLoad() {
    // 每次进入测量页 = 一次全新的 3 连拍会话，清空上一轮残留，避免新旧数据混淆
    this.sessionResults = []
    this.shotFailCount = 0
    this.setData({ shotIndex: 0 })
    if (userUtil.isUnlimited()) {
      // 年度会员/dev：每次都是独立一轮，三个批次全部重置
      userUtil.resetUnlimitedSession()
      userUtil.resetTrialBatch()
      userUtil.resetSingleBatch()
    }
    // 进页面即预热云托管容器：用户对准脸的几秒里把它唤醒，规避冷启动超时
    this.warmUpService()
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

  onHelp() {
    wx.showModal({
      title: '拍摄要点',
      content: '把脸对准框内、正脸看镜头，手机举到与眼睛同高、约一臂距离（约 50cm）。摘掉眼镜、光线充足、自然睁眼即可，无需手持任何卡片。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  takePhoto() {
    if (this.data.detecting) return
    const ctx = wx.createCameraContext()
    ctx.takePhoto({
      quality: 'high',
      success: (res) => this.preparePhoto(res.tempImagePath),
      fail: () => wx.showToast({ title: '拍照失败，请重试', icon: 'none' })
    })
  },

  preparePhoto(path) {
    wx.showLoading({ title: '识别中...', mask: true })
    this.setData({ detecting: true })
    this.requestAutoMeasureServer(path)
  },

  // 上传照片到云端测量服务（attempt：当前是第几次尝试，用于冷启动超时自动重试）
  requestAutoMeasureServer(imagePath, attempt) {
    attempt = attempt || 0
    const cloudAuto = config.cloudAuto || {}
    if (!cloudAuto.enabled || !cloudAuto.endpoint) {
      wx.hideLoading()
      this.setData({ detecting: false })
      wx.showModal({
        title: '未配置测量服务',
        content: '测量服务未启用，请联系开发者配置后再使用。',
        showCancel: false
      })
      return
    }

    const fail = (message) => {
      // 冷启动超时：第一次请求其实已把容器唤醒，自动重试一次（不打断、不弹窗）
      const isTimeout = /超时|timeout|102002/i.test(String(message))
      if (isTimeout && attempt < 1) {
        wx.showLoading({ title: '服务启动中，重试…', mask: true })
        setTimeout(() => this.requestAutoMeasureServer(imagePath, attempt + 1), 1500)
        return
      }
      wx.hideLoading()
      this.setData({ detecting: false })
      this.handleMeasureFail(message)
    }

    const onServerData = (data) => {
      wx.hideLoading()
      this.setData({ detecting: false })
      if (data && data.ok && buildCloudPdFields(data)) {
        this.applyCloudPdResult(data)
      } else {
        this.handleMeasureFail((data && data.message) || '未能识别到人脸，请正对镜头、保证光线充足后重拍。')
      }
    }

    wx.compressImage({
      src: imagePath,
      quality: cloudAuto.quality || 70,
      success: (res) => {
        const compressedPath = res.tempFilePath
        if (cloudAuto.mode === 'container') {
          // 云托管：照片走云存储中转(callContainer 有 100KB 限制，不能直接传图)
          this.measureViaContainer(cloudAuto, compressedPath, onServerData, fail)
        } else {
          // http：直接 base64 POST 到公网域名/本地服务
          this.measureViaHttp(cloudAuto, compressedPath, onServerData, fail)
        }
      },
      fail: () => fail('图片处理失败，请重拍。')
    })
  },

  parseServerData(raw) {
    let data = raw || {}
    if (typeof data === 'string') {
      try { data = JSON.parse(data) } catch (e) { data = {} }
    }
    return data
  },

  // http 模式：直接 base64 POST（云托管公网域名 / 本地联调 / 自建 VPS）
  measureViaHttp(cloudAuto, filePath, onData, onFail) {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: (readRes) => {
        wx.request({
          url: cloudAuto.endpoint,
          method: 'POST',
          timeout: 30000,
          header: { 'Content-Type': 'application/json' },
          data: buildMeasurePayload({
            imageBase64: readRes.data,
            cameraPosition: this.data.cameraPosition
          }),
          success: (res) => {
            if (res && res.statusCode && res.statusCode >= 400) {
              onFail(`服务返回错误(${res.statusCode})：${JSON.stringify(res.data).slice(0, 120)}`)
              return
            }
            onData(this.parseServerData(res.data))
          },
          fail: (err) => {
            console.warn('[Measure] request 失败:', err)
            onFail(`连接失败：${(err && err.errMsg) || JSON.stringify(err).slice(0, 140)}`)
          }
        })
      },
      fail: () => onFail('读取照片失败，请重拍。')
    })
  },

  // 云托管模式：照片上传云存储 → 取临时链接 → callContainer 只传链接 → 识别后删文件
  measureViaContainer(cloudAuto, filePath, onData, onFail) {
    if (!wx.cloud || typeof wx.cloud.uploadFile !== 'function' || typeof wx.cloud.callContainer !== 'function') {
      onFail('云能力不可用，请重试。')
      return
    }
    const cloudPath = `iris/${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`
    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: (upRes) => {
        const fileID = upRes.fileID
        wx.cloud.getTempFileURL({
          fileList: [fileID],
          success: (urlRes) => {
            const item = urlRes.fileList && urlRes.fileList[0]
            const url = item && item.tempFileURL
            if (!url) {
              this.cleanupCloudFile(fileID)
              onFail('获取图片链接失败，请重拍。')
              return
            }
            wx.cloud.callContainer({
              config: { env: cloudAuto.containerEnv || '' },
              path: cloudAuto.path || '/v1/measure',
              method: 'POST',
              timeout: 30000,
              header: {
                'X-WX-SERVICE': cloudAuto.service,
                'content-type': 'application/json'
              },
              data: buildMeasurePayload({
                imageUrl: url,
                cameraPosition: this.data.cameraPosition
              }),
              success: (res) => {
                this.cleanupCloudFile(fileID)
                if (res && res.statusCode && res.statusCode >= 400) {
                  onFail(`服务返回错误(${res.statusCode})：${JSON.stringify(res.data).slice(0, 120)}`)
                  return
                }
                onData(this.parseServerData(res.data))
              },
              fail: (err) => {
                this.cleanupCloudFile(fileID)
                console.warn('[Measure] callContainer 失败:', err)
                onFail(`连接失败：${(err && err.errMsg) || JSON.stringify(err).slice(0, 140)}`)
              }
            })
          },
          fail: (err) => {
            this.cleanupCloudFile(fileID)
            onFail(`获取图片链接失败：${(err && err.errMsg) || ''}`)
          }
        })
      },
      fail: (err) => {
        console.warn('[Measure] uploadFile 失败:', err)
        onFail(`照片上传失败：${(err && err.errMsg) || ''}`)
      }
    })
  },

  // 识别完删除云存储里的临时照片（隐私：用完即删）
  cleanupCloudFile(fileID) {
    if (!fileID || !wx.cloud || typeof wx.cloud.deleteFile !== 'function') return
    wx.cloud.deleteFile({ fileList: [fileID], success: () => {}, fail: () => {} })
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

  // 处理云端返回的瞳距结果（拍照即出结果）
  applyCloudPdResult(data) {
    const pdFields = buildCloudPdFields(data)
    if (!pdFields) {
      this.handleMeasureFail('未能识别到有效瞳距，请正对镜头、保证光线充足后重拍。')
      return
    }
    const { totalPd, leftPd, rightPd } = pdFields

    // 瞳距超出生理范围：检测出错，硬性重拍，绝不放行（不会污染中位数）
    if (totalPd < 50 || totalPd > 80) {
      this.shotFailCount = (this.shotFailCount || 0) + 1
      this.handleMeasureFail(`检测到瞳距 ${totalPd}mm，超出正常范围(50-80mm)，请正对镜头、光线充足后重拍。`)
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
      source: 'cloud_auto'
    }
    console.log('[Measure] 单次结果:', result)
    this.onMeasured(result)
  },

  // 失败/重拍：不计入本次，已完成的次数保留
  retake() {
    this.setData({ detecting: false })
  },

  // 一次拍摄成功后累计到会话；不满 3 次用轻提示+进度点推进（不打断），满 3 次出中位数结果
  onMeasured(result) {
    this.shotFailCount = 0   // 这一张已通过，下一张失败计数清零
    this.sessionResults.push(result)
    const done = this.sessionResults.length
    if (done < this.data.totalShots) {
      // 不弹模态：点亮进度、解锁快门，给一个非阻塞的轻提示即可继续拍下一张
      this.setData({ shotIndex: done, detecting: false })
      wx.showToast({
        title: `已拍 ${done}/${this.data.totalShots} 张，继续`,
        icon: 'success',
        duration: 1200
      })
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
    const canFree = userUtil.canMeasureFree()

    if (isUnlimited) {
      results.forEach((r) => userUtil.addUnlimitedSessionResult(r))
    } else if (canFree) {
      results.forEach((r) => userUtil.addSingleResult(r))
    } else {
      results.forEach((r) => userUtil.addTrialResult(r))
    }

    const last = results[results.length - 1]
    wx.setStorageSync('latestResult', last)
    const isTrial = (!isUnlimited && !canFree)
    wx.navigateTo({ url: '/pages/result/result' + (isTrial ? '?trial=1' : '') })
  }
})
