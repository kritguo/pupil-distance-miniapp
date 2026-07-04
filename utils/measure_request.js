const CAMERA_PHOTO_QUALITY = 'normal'
const CLOUD_UPLOAD_IMAGE_QUALITY = 76
const MEASURE_NETWORK_TIMEOUT_MS = 22000
const MEASURE_REQUEST_TIMEOUT_MS = 50000

const STAGE_TITLES = {
  compress: '处理照片...',
  upload: '正在分析，请稍候',
  recognize: '正在分析，请稍候',
  retry: '正在分析，请稍候'
}

const STAGE_TIMEOUT_MS = {
  compress: 8000,
  upload: 14000,
  recognize: 26000,
  retry: 6000
}

const STAGE_TIMEOUT_LABELS = {
  compress: '图片处理',
  upload: '分析',
  recognize: '分析',
  retry: '分析'
}

function isRetryableMeasureTimeout(message, attempt, maxRetries) {
  const retries = typeof maxRetries === 'number' ? maxRetries : 1
  return /超时|timeout|102002/i.test(String(message || '')) && Number(attempt || 0) < retries
}

function createMeasureRequestToken(previousToken, now) {
  const base = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const previous = Number(previousToken || 0)
  return Math.max(previous + 1, base)
}

function isActiveMeasureRequest(activeToken, token) {
  return !!token && activeToken === token
}

function buildMeasureTimeoutMessage(timeoutMs) {
  const seconds = Math.round((timeoutMs || MEASURE_REQUEST_TIMEOUT_MS) / 1000)
  return `测量请求超时（${seconds}秒未返回），请检查网络后重新拍摄。`
}

function getMeasureStageTitle(stage) {
  return STAGE_TITLES[stage] || '处理中...'
}

function getMeasureStageTimeoutMs(stage) {
  return STAGE_TIMEOUT_MS[stage] || 0
}

function buildMeasureStageTimeoutMessage(stage, timeoutMs) {
  const label = STAGE_TIMEOUT_LABELS[stage] || '测量'
  const ms = timeoutMs || getMeasureStageTimeoutMs(stage) || MEASURE_REQUEST_TIMEOUT_MS
  const seconds = Math.round(ms / 1000)
  return `${label}超时（${seconds}秒未返回），请检查网络后重新拍摄。`
}

function normalizeUploadImageQuality(value) {
  const quality = Number(value)
  if (!Number.isFinite(quality)) return CLOUD_UPLOAD_IMAGE_QUALITY
  return Math.max(55, Math.min(CLOUD_UPLOAD_IMAGE_QUALITY, Math.round(quality)))
}

function parseServerData(raw) {
  let data = raw || {}
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch (e) { data = {} }
  }
  return data
}

// 识别完删除云存储里的临时照片（隐私：用完即删）
function cleanupCloudFile(fileID) {
  if (!fileID || !wx.cloud || typeof wx.cloud.deleteFile !== 'function') return
  wx.cloud.deleteFile({ fileList: [fileID], success: () => {}, fail: () => {} })
}

// http 模式：直接 base64 POST（云托管公网域名 / 本地联调 / 自建 VPS）
function measureViaHttp({ cloudAuto, filePath, buildPayload, isActive, onStage, onData, onFail }) {
  wx.getFileSystemManager().readFile({
    filePath,
    encoding: 'base64',
    success: (readRes) => {
      if (!isActive()) return
      onStage('recognize')
      wx.request({
        url: cloudAuto.endpoint,
        method: 'POST',
        timeout: MEASURE_NETWORK_TIMEOUT_MS,
        header: { 'Content-Type': 'application/json' },
        data: buildPayload({ imageBase64: readRes.data }),
        success: (res) => {
          if (!isActive()) return
          if (res && res.statusCode && res.statusCode >= 400) {
            onFail(`服务返回错误(${res.statusCode})：${JSON.stringify(res.data).slice(0, 120)}`)
            return
          }
          onData(parseServerData(res.data))
        },
        fail: (err) => {
          if (!isActive()) return
          console.warn('[Measure] request 失败:', err)
          onFail(`连接失败：${(err && err.errMsg) || JSON.stringify(err).slice(0, 140)}`)
        }
      })
    },
    fail: () => onFail('读取照片失败，请重拍。')
  })
}

// 云托管模式：照片上传云存储 → 取临时链接 → callContainer 只传链接 → 识别后删文件
function measureViaContainer({ cloudAuto, filePath, buildPayload, isActive, onStage, onData, onFail }) {
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
      if (!isActive()) {
        cleanupCloudFile(fileID)
        return
      }
      wx.cloud.getTempFileURL({
        fileList: [fileID],
        success: (urlRes) => {
          if (!isActive()) {
            cleanupCloudFile(fileID)
            return
          }
          const item = urlRes.fileList && urlRes.fileList[0]
          const url = item && item.tempFileURL
          if (!url) {
            cleanupCloudFile(fileID)
            onFail('获取图片链接失败，请重拍。')
            return
          }
          onStage('recognize')
          wx.cloud.callContainer({
            config: { env: cloudAuto.containerEnv || '' },
            path: cloudAuto.path || '/v1/measure',
            method: 'POST',
            timeout: MEASURE_NETWORK_TIMEOUT_MS,
            header: {
              'X-WX-SERVICE': cloudAuto.service,
              'content-type': 'application/json'
            },
            data: buildPayload({ imageUrl: url }),
            success: (res) => {
              cleanupCloudFile(fileID)
              if (!isActive()) return
              if (res && res.statusCode && res.statusCode >= 400) {
                onFail(`服务返回错误(${res.statusCode})：${JSON.stringify(res.data).slice(0, 120)}`)
                return
              }
              onData(parseServerData(res.data))
            },
            fail: (err) => {
              cleanupCloudFile(fileID)
              if (!isActive()) return
              console.warn('[Measure] callContainer 失败:', err)
              onFail(`连接失败：${(err && err.errMsg) || JSON.stringify(err).slice(0, 140)}`)
            }
          })
        },
        fail: (err) => {
          cleanupCloudFile(fileID)
          if (!isActive()) return
          onFail(`获取图片链接失败：${(err && err.errMsg) || ''}`)
        }
      })
    },
    fail: (err) => {
      if (!isActive()) return
      console.warn('[Measure] uploadFile 失败:', err)
      onFail(`分析失败，请重新拍摄：${(err && err.errMsg) || ''}`)
    }
  })
}

// 统一入口：按 cloudAuto.mode 分发 http / container 传输
function sendMeasure(options) {
  const cloudAuto = options.cloudAuto || {}
  const isActive = options.isActive || (() => true)
  const params = { ...options, cloudAuto, isActive }
  if (cloudAuto.mode === 'container') {
    measureViaContainer(params)
  } else {
    measureViaHttp(params)
  }
}

module.exports = {
  CAMERA_PHOTO_QUALITY,
  CLOUD_UPLOAD_IMAGE_QUALITY,
  MEASURE_NETWORK_TIMEOUT_MS,
  MEASURE_REQUEST_TIMEOUT_MS,
  buildMeasureStageTimeoutMessage,
  buildMeasureTimeoutMessage,
  createMeasureRequestToken,
  getMeasureStageTimeoutMs,
  getMeasureStageTitle,
  isActiveMeasureRequest,
  isRetryableMeasureTimeout,
  normalizeUploadImageQuality,
  parseServerData,
  sendMeasure
}
