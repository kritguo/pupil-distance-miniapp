const config = require('../../config.js')
const userUtil = require('../../utils/user.js')
const { detectIris } = require('../../utils/mediapipe.js')

const POINT_SIZE = 36
const POINT_CONTAINER_WIDTH = 64
const POINT_CONTAINER_HEIGHT = 88
const POINT_OFFSET_X = (POINT_CONTAINER_WIDTH - POINT_SIZE) / 2
const POINT_OFFSET_Y = 0
const POINT_CENTER_OFFSET_X = POINT_OFFSET_X + POINT_SIZE / 2
const POINT_CENTER_OFFSET_Y = POINT_OFFSET_Y + POINT_SIZE / 2
const LINE_CONTAINER = 44
const CARD_WIDTH_MM = 85.6
const MIN_AUTO_QUALITY_SCORE = 0.8
const MIN_AUTO_IRIS_CONFIDENCE = 0.75
const MIN_AUTO_CARD_CONFIDENCE = 0.65
const MAX_EYE_LEVEL_RATIO = 0.08

const roundToHalf = (value) => Math.round(value * 2) / 2
const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
const isNumber = (value) => typeof value === 'number' && !Number.isNaN(value)
const toNumber = (value) => {
  if (isNumber(value)) return value
  if (typeof value !== 'string') return null
  const matches = value.match(/-?\d+(?:\.\d+)?/g)
  if (!matches || matches.length === 0) return null
  const num = Number(matches[0])
  return Number.isNaN(num) ? null : num
}
const parsePointFromString = (value) => {
  if (typeof value !== 'string') return null
  const matches = value.match(/-?\d+(?:\.\d+)?/g)
  if (!matches || matches.length < 2) return null
  const x = Number(matches[0])
  const y = Number(matches[1])
  if (Number.isNaN(x) || Number.isNaN(y)) return null
  return { x, y }
}
const normalizeIrisPoint = (point) => {
  if (!point) return null
  if (typeof point === 'string') {
    return parsePointFromString(point)
  }
  if (Array.isArray(point) && point.length >= 2) {
    const x = toNumber(point[0])
    const y = toNumber(point[1])
    if (x !== null && y !== null) return { x, y }
  }
  if (typeof point === 'object') {
    const x = toNumber(point.x)
    const y = toNumber(point.y)
    if (x !== null && y !== null) return { x, y }
  }
  return null
}
const normalizeIrisResult = (iris) => {
  if (!iris || typeof iris !== 'object') return null
  const left = normalizeIrisPoint(
    iris.left
    || iris.left_eye_pupil_center
    || (iris.left_eye && iris.left_eye.pupil_center)
  )
  const right = normalizeIrisPoint(
    iris.right
    || iris.right_eye_pupil_center
    || (iris.right_eye && iris.right_eye.pupil_center)
  )
  if (!left || !right) return null
  return { left, right }
}
const normalizeOrientation = (orientation) => {
  const value = (orientation || 'up').toLowerCase()
  const mirrored = value.indexOf('mirror') !== -1
  const base = value.replace('-mirrored', '')
  return { base, mirrored }
}
const getOrientedSize = (width, height, base) => {
  if (base === 'left' || base === 'right') {
    return { width: height, height: width }
  }
  return { width, height }
}
const mapPointByOrientation = (point, width, height, base, mirrored) => {
  if (!point || !isNumber(point.x) || !isNumber(point.y)) return null
  let x = point.x
  let y = point.y
  if (base === 'down') {
    x = width - point.x
    y = height - point.y
  } else if (base === 'left') {
    x = point.y
    y = width - point.x
  } else if (base === 'right') {
    x = height - point.y
    y = point.x
  }
  const oriented = getOrientedSize(width, height, base)
  if (mirrored) {
    x = oriented.width - x
  }
  return { x, y, width: oriented.width, height: oriented.height }
}
const mapLandmarkValue = (value, width, height, base, mirrored) => {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((item) => mapLandmarkValue(item, width, height, base, mirrored))
  }
  if (isNumber(value.x) && isNumber(value.y)) {
    const mapped = mapPointByOrientation(value, width, height, base, mirrored)
    if (!mapped) return value
    return { x: mapped.x, y: mapped.y }
  }
  const next = {}
  Object.keys(value).forEach((key) => {
    next[key] = mapLandmarkValue(value[key], width, height, base, mirrored)
  })
  return next
}
const mapLandmarkByOrientation = (landmark, width, height, base, mirrored) => {
  if (!landmark || typeof landmark !== 'object') return landmark
  const out = {}
  Object.keys(landmark).forEach((key) => {
    out[key] = mapLandmarkValue(landmark[key], width, height, base, mirrored)
  })
  return out
}
const mapRectByOrientation = (rect, width, height, base, mirrored) => {
  if (!rect
    || !isNumber(rect.left)
    || !isNumber(rect.top)
    || !isNumber(rect.width)
    || !isNumber(rect.height)) {
    return rect
  }
  const corners = [
    { x: rect.left, y: rect.top },
    { x: rect.left + rect.width, y: rect.top },
    { x: rect.left + rect.width, y: rect.top + rect.height },
    { x: rect.left, y: rect.top + rect.height }
  ]
    .map((point) => mapPointByOrientation(point, width, height, base, mirrored))
    .filter((point) => point && isNumber(point.x) && isNumber(point.y))
  if (corners.length < 4) {
    return rect
  }
  const xs = corners.map((point) => point.x)
  const ys = corners.map((point) => point.y)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  const right = Math.max(...xs)
  const bottom = Math.max(...ys)
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  }
}
const safePointCenter = (x, y, width, height) => {
  const halfX = POINT_CENTER_OFFSET_X
  const halfY = POINT_CENTER_OFFSET_Y
  return {
    x: clamp(x, halfX, width - (POINT_CONTAINER_WIDTH - halfX)),
    y: clamp(y, halfY, height - (POINT_CONTAINER_HEIGHT - halfY))
  }
}
const safeLineCenter = (x, width) => {
  const half = LINE_CONTAINER / 2
  return clamp(x, half, width - half)
}
const collectEyeContourPoints = (landmark, side) => {
  if (!landmark || typeof landmark !== 'object') return []
  const points = []
  const pointFrom = (value) => {
    if (value && isNumber(value.x) && isNumber(value.y)) {
      points.push({ x: value.x, y: value.y })
    }
  }
  Object.keys(landmark).forEach((key) => {
    if (key.indexOf(`${side}_eye_`) !== 0) return
    const suffix = key.slice(`${side}_eye_`.length)
    if (/^\d+$/.test(suffix)) {
      pointFrom(landmark[key])
      return
    }
    if (suffix.indexOf('eyelid_') === 0) {
      pointFrom(landmark[key])
    }
  })
  const nested = landmark[`${side}_eye`]
  if (nested && typeof nested === 'object') {
    Object.keys(nested).forEach((key) => {
      const suffix = key.replace(`${side}_eye_`, '')
      if (/^\d+$/.test(suffix) || suffix.indexOf('eyelid_') === 0) {
        pointFrom(nested[key])
      }
    })
  }
  return points
}

const buildEyeBox = (landmark, side) => {
  const points = collectEyeContourPoints(landmark, side)
  if (!points.length) return null
  let minX = points[0].x
  let maxX = points[0].x
  let minY = points[0].y
  let maxY = points[0].y
  points.forEach((point) => {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  })
  return {
    left: minX,
    top: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  }
}

const buildEyeCenter = (landmark, side) => {
  const contourPoints = collectEyeContourPoints(landmark, side)
  let contourBox = null
  let contourCenter = null
  if (contourPoints.length) {
    const xs = contourPoints.map((point) => point.x)
    const ys = contourPoints.map((point) => point.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    contourBox = {
      minX,
      maxX,
      minY,
      maxY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY)
    }
    contourCenter = {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2
    }
  }

  const isInContour = (point) => {
    if (!point || !contourBox) return true
    return point.x >= contourBox.minX
      && point.x <= contourBox.maxX
      && point.y >= contourBox.minY
      && point.y <= contourBox.maxY
  }

  const pupilCenter = landmark[`${side}_eye_pupil_center`]
    || (landmark[`${side}_eye`] && landmark[`${side}_eye`][`${side}_eye_pupil_center`])
  if (pupilCenter && isNumber(pupilCenter.x) && isNumber(pupilCenter.y)) {
    return { x: pupilCenter.x, y: pupilCenter.y }
  }

  const pupil = landmark[`${side}_eye_pupil`]
    || (landmark[`${side}_eye`] && landmark[`${side}_eye`][`${side}_eye_pupil`])
  if (pupil && isNumber(pupil.x) && isNumber(pupil.y) && contourBox) {
    if (isInContour(pupil)) {
      const dx = Math.abs(pupil.x - contourCenter.x)
      const dy = Math.abs(pupil.y - contourCenter.y)
      const maxDx = contourBox.width * 0.55
      const maxDy = contourBox.height * 0.55
      if (dx <= maxDx && dy <= maxDy) {
        return { x: pupil.x, y: pupil.y }
      }
      return contourCenter
    }
  }

  const eyeCenter = landmark[`${side}_eye_center`]
    || (landmark[`${side}_eye`] && landmark[`${side}_eye`][`${side}_eye_center`])
  if (eyeCenter && isNumber(eyeCenter.x) && isNumber(eyeCenter.y) && isInContour(eyeCenter)) {
    return { x: eyeCenter.x, y: eyeCenter.y }
  }

  const eyePoints = collectLandmarkPoints(landmark, [`${side}_eye_`])
  if (contourCenter) {
    return contourCenter
  }
  const fallbackCenter = averagePoints(eyePoints)
  if (fallbackCenter) {
    return fallbackCenter
  }
  return null
}

const averagePoints = (points) => {
  if (!points || !points.length) return null
  const sum = points.reduce(
    (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
    { x: 0, y: 0 }
  )
  return {
    x: sum.x / points.length,
    y: sum.y / points.length
  }
}

const collectLandmarkPoints = (landmark, matchers) => {
  const points = []
  const pushPoint = (point) => {
    if (point && isNumber(point.x) && isNumber(point.y)) {
      points.push({ x: point.x, y: point.y })
    }
  }
  const pushValue = (value) => {
    if (!value) return
    if (Array.isArray(value)) {
      value.forEach((item) => pushPoint(item))
      return
    }
    pushPoint(value)
  }

  if (!landmark || typeof landmark !== 'object') {
    return points
  }

  Object.keys(landmark).forEach((key) => {
    if (!matchers.some((matcher) => key.indexOf(matcher) === 0 || key.indexOf(matcher) > -1)) {
      return
    }
    pushValue(landmark[key])
  })

  if (landmark.iris && typeof landmark.iris === 'object') {
    pushValue(landmark.iris.left)
    pushValue(landmark.iris.right)
  }

  return points
}

const flattenLandmark = (landmark) => {
  if (!landmark || typeof landmark !== 'object') return landmark
  const flat = { ...landmark }
  const mergeSection = (key) => {
    const section = landmark[key]
    if (!section || typeof section !== 'object') return
    Object.keys(section).forEach((subKey) => {
      if (flat[subKey]) return
      flat[subKey] = section[subKey]
    })
  }
  ;[
    'left_eye',
    'right_eye',
    'nose',
    'face',
    'left_eyebrow',
    'right_eyebrow',
    'left_eye_eyelid',
    'right_eye_eyelid'
  ].forEach(mergeSection)
  return flat
}

const averageXFromPrefix = (landmark, prefix) => {
  if (!landmark || typeof landmark !== 'object') return null
  const points = []
  Object.keys(landmark).forEach((key) => {
    if (key.indexOf(prefix) !== 0) return
    const point = landmark[key]
    if (point && isNumber(point.x)) {
      points.push(point.x)
    }
  })
  if (!points.length) return null
  const sum = points.reduce((acc, value) => acc + value, 0)
  return sum / points.length
}

const normalizeIrisLandmark = (landmark) => {
  if (!landmark || typeof landmark !== 'object') return landmark
  const normalized = { ...landmark }

  const ensurePupil = (side) => {
    const key = `${side}_eye_pupil`
    const current = normalized[key]
    if (current && isNumber(current.x) && isNumber(current.y)) {
      return
    }
    const pupilCenter = normalized[`${side}_eye_pupil_center`]
    if (pupilCenter && isNumber(pupilCenter.x) && isNumber(pupilCenter.y)) {
      normalized[key] = pupilCenter
      return
    }
    const irisPoints = collectLandmarkPoints(normalized, [
      `${side}_eye_pupil`,
      `${side}_iris`,
      `${side}_eye_iris`,
      `${side}_eye_ball`,
      `${side}_eyeball`
    ])
    const irisCenter = averagePoints(irisPoints)
    if (irisCenter) {
      normalized[key] = irisCenter
    }
  }

  const ensureEyeCenter = (side) => {
    const key = `${side}_eye_center`
    const current = normalized[key]
    if (current && isNumber(current.x) && isNumber(current.y)) {
      return
    }
    const eyePoints = collectLandmarkPoints(normalized, [
      `${side}_eye_`,
      `${side}_eye`,
      `${side}_iris`,
      `${side}_eye_iris`,
      `${side}_eyeball`
    ])
    const eyeCenter = averagePoints(eyePoints)
    if (eyeCenter) {
      normalized[key] = eyeCenter
    }
  }

  ensurePupil('left')
  ensurePupil('right')
  ensureEyeCenter('left')
  ensureEyeCenter('right')
  return normalized
}

const collectAllPoints = (node, points) => {
  if (!node) return
  if (Array.isArray(node)) {
    node.forEach((item) => collectAllPoints(item, points))
    return
  }
  if (typeof node === 'object') {
    if (isNumber(node.x) && isNumber(node.y)) {
      points.push({ x: node.x, y: node.y })
      return
    }
    Object.keys(node).forEach((key) => collectAllPoints(node[key], points))
  }
}

const buildFaceRectFromLandmark = (landmark) => {
  const points = []
  collectAllPoints(landmark, points)
  if (!points.length) return null
  let minX = points[0].x
  let maxX = points[0].x
  let minY = points[0].y
  let maxY = points[0].y
  points.forEach((point) => {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  })
  return {
    left: minX,
    top: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  }
}

const extractFaceRect = (data, landmark) => {
  const rect = data && (data.face_rectangle || (data.face && data.face.face_rectangle))
  if (rect) return rect
  if (data && data.faces && data.faces[0] && data.faces[0].face_rectangle) {
    return data.faces[0].face_rectangle
  }
  return buildFaceRectFromLandmark(landmark)
}

Page({
  data: {
    stage: 'capture',
    step: 0,
    totalSteps: 4,
    stepLabels: ['瞳孔位置', '鼻梁中线', '脸部边缘', '卡片'],
    stepTips: [
      '拖动两个点，对准瞳孔中心',
      '拖动竖线，对准鼻梁中线',
      '拖动两条竖线，对准颧骨外缘（脸最宽处）',
      '拖动两条竖线，对准横放卡片的左右边缘（卡片尽量与屏幕平行）'
    ],
    cameraPosition: 'front',
    windowWidth: 0,
    windowHeight: 0,
    displayWidth: 0,
    displayHeight: 0,
    photoPath: '',
    // Step 0: 瞳孔点
    leftEye: { x: 0, y: 0 },
    rightEye: { x: 0, y: 0 },
    // Step 1: 鼻梁中线
    centerX: 0,
    // Step 2: 脸部边缘
    faceLeftX: 0,
    faceRightX: 0,
    skipFaceWidth: false,
    // Step 3: 银行卡
    cardLeftX: 0,
    cardRightX: 0,
    cardWidthMm: CARD_WIDTH_MM,
    cardOptions: [
      { value: 'bank', label: '银行卡', width: CARD_WIDTH_MM },
      { value: 'id', label: '身份证', width: CARD_WIDTH_MM }
    ],
    selectedCard: 'bank',
    dragFriction: 3,
    dragDamping: 28,
    autoMeasureEnabled: true,
    autoFaceReady: false,
    autoMeasureDone: false,
    detecting: false,
    pupilCanvasWidth: 0,
    pupilCanvasHeight: 0,
    pupilRefineEnabled: false,
    mediaPipeEnabled: !!(config.mediaPipe && config.mediaPipe.enabled)
  },

  // 保存原始图片信息，用于坐标转换
  imageInfo: null,
  cardImageInfo: null,
  dragCache: null,
  cardBase64: null,
  cardAutoResult: null,
  cardAutoApplied: false,
  cardAutoDisabled: false,
  cardAutoFailed: false,
  mediaPipeModelBuffer: null,
  mediaPipeRunning: false,
  pupilCanvasReady: false,

  onLoad() {
    const info = wx.getSystemInfoSync()
    this.setData({
      windowWidth: info.windowWidth,
      windowHeight: info.windowHeight
    })
    this.resetDragCache()
  },

  goBack() {
    wx.navigateBack()
  },

  // 切换前后摄像头
  switchCamera() {
    const newPosition = this.data.cameraPosition === 'front' ? 'back' : 'front'
    this.setData({ cameraPosition: newPosition })
  },

  takePhoto() {
    const ctx = wx.createCameraContext()
    ctx.takePhoto({
      quality: 'high',
      success: (res) => {
        this.preparePhoto(res.tempImagePath)
      },
      fail: () => {
        wx.showToast({
          title: '拍照失败，请重试',
          icon: 'none'
        })
      }
    })
  },

  preparePhoto(path) {
    wx.showLoading({ title: '识别中...' })
    this.setData({ detecting: true })
    this.cardAutoResult = null
    this.cardAutoApplied = false
    this.cardAutoDisabled = false
    this.cardAutoFailed = false
    this.cardBase64 = null
    this.cardImageInfo = null
    this.cloudAutoImageInfo = null
    this.cloudAutoImagePath = null
    this.pupilCanvasReady = false
    this.mediaPipeRunning = false
    this.setData({
      autoMeasureEnabled: true,
      autoFaceReady: false,
      autoMeasureDone: false
    })

    const cloudAuto = config.cloudAuto || {}
    const useCloudAuto = cloudAuto.enabled && !!cloudAuto.endpoint
    this.useCloudAuto = useCloudAuto
    if (!useCloudAuto) {
      this.prepareCardBase64(path)
    }

    wx.getImageInfo({
      src: path,
      success: (info) => {
        this.imageInfo = info
        this.setData({
          pupilCanvasWidth: info.width,
          pupilCanvasHeight: info.height
        })

        // 满屏显示，使用屏幕尺寸
        const displayWidth = this.data.windowWidth
        const displayHeight = this.data.windowHeight

        // 保存显示尺寸，用于后续坐标转换
        this.displaySize = { width: displayWidth, height: displayHeight }

        // 调试：打印图片和显示区域的比例
        const imgRatio = info.width / info.height
        const displayRatio = displayWidth / displayHeight
        console.log('[Photo] 图片信息:', {
          size: `${info.width}x${info.height}`,
          ratio: imgRatio.toFixed(3),
          orientation: info.orientation
        })
        console.log('[Photo] 显示区域:', {
          size: `${displayWidth}x${displayHeight}`,
          ratio: displayRatio.toFixed(3)
        })
        console.log('[Photo] 比例差异:', {
          diff: Math.abs(imgRatio - displayRatio).toFixed(3),
          aspectFillMode: imgRatio > displayRatio ? '高度填满，宽度裁剪' : '宽度填满，高度裁剪'
        })

        if (useCloudAuto) {
          this.requestAutoMeasureServer(path, displayWidth, displayHeight)
        } else {
          this.applyDefaultPoints(displayWidth, displayHeight, path)
          wx.hideLoading()
          this.setData({ detecting: false })
          wx.showToast({
            title: '云端识别未开启，请手动调整',
            icon: 'none'
          })
        }
      },
      fail: () => {
        wx.hideLoading()
        this.setData({ detecting: false })
        wx.showToast({
          title: '读取图片失败',
          icon: 'none'
        })
      }
    })
  },

  requestAutoMeasureServer(imagePath, displayWidth, displayHeight) {
    const cloudAuto = config.cloudAuto || {}
    if (!cloudAuto.enabled || !cloudAuto.endpoint) {
      this.handleCloudAutoFail(imagePath, displayWidth, displayHeight, '云端识别未开启，请手动调整')
      return
    }
    wx.compressImage({
      src: imagePath,
      quality: cloudAuto.quality || 70,
      success: (res) => {
        this.cloudAutoImagePath = res.tempFilePath
        wx.getImageInfo({
          src: res.tempFilePath,
          success: (info) => {
            this.cloudAutoImageInfo = {
              ...info,
              path: res.tempFilePath
            }
            console.log('[CloudAuto] 压缩图信息:', {
              size: `${info.width}x${info.height}`,
              orientation: info.orientation
            })
          },
          fail: (err) => {
            console.warn('[CloudAuto] 读取压缩图信息失败:', err)
            this.cloudAutoImageInfo = null
          },
          complete: () => {
            wx.getFileSystemManager().readFile({
              filePath: res.tempFilePath,
              encoding: 'base64',
              success: (readRes) => {
                wx.request({
                  url: cloudAuto.endpoint,
                  method: 'POST',
                  header: {
                    'Content-Type': 'application/json'
                  },
                  data: {
                    image_base64: readRes.data,
                    card_width_mm: this.data.cardWidthMm,
                    camera_position: this.data.cameraPosition || 'unknown'
                  },
                  success: (serverRes) => {
                    let data = serverRes.data || {}
                    if (typeof data === 'string') {
                      try {
                        data = JSON.parse(data)
                      } catch (err) {
                        console.warn('[CloudAuto] 返回解析失败:', err)
                        data = {}
                      }
                    }
                    const normalizedIris = normalizeIrisResult(data.iris)
                    console.log('[CloudAuto] 返回:', {
                      ok: data.ok,
                      meta: data.meta,
                      hasIris: !!normalizedIris,
                      hasCard: !!(data.card && data.card.corners),
                      hasPd: !!(data.pd && isNumber(data.pd.total))
                    })

                    // 优先使用云端直接返回的瞳距结果（最准确）
                    if (data.ok && data.pd && isNumber(data.pd.total)) {
                      console.log('[CloudAuto] 使用云端计算的瞳距:', data.pd)
                      wx.hideLoading()
                      this.setData({ detecting: false })
                      this.applyCloudPdResult(data)
                      return
                    }

                    // 如果云端返回了瞳孔坐标，就先对齐瞳孔（即使卡片失败也可用）
                    if (normalizedIris) {
                      if (!data.ok) {
                        console.warn('[CloudAuto] 返回 ok=false，但已获取瞳孔坐标，将继续对齐瞳孔')
                      }
                      data.iris = normalizedIris
                      this.applyServerResult(data, displayWidth, displayHeight)
                      wx.hideLoading()
                      this.setData({ detecting: false })
                      return
                    }
                    this.handleCloudAutoFail(imagePath, displayWidth, displayHeight, '云端识别失败，请重试')
                  },
                  fail: (err) => {
                    console.warn('[CloudAuto] 请求失败:', err)
                    this.handleCloudAutoFail(imagePath, displayWidth, displayHeight, '云端识别失败，请重试')
                  }
                })
              },
              fail: (err) => {
                console.warn('[CloudAuto] 读取图片失败:', err)
                this.handleCloudAutoFail(imagePath, displayWidth, displayHeight, '读取图片失败，请重试')
              }
            })
          }
        })
      },
      fail: (err) => {
        console.warn('[CloudAuto] 压缩失败:', err)
        this.handleCloudAutoFail(imagePath, displayWidth, displayHeight, '图片压缩失败，请重试')
      }
    })
  },

  handleCloudAutoFail(imagePath, displayWidth, displayHeight, toastTitle) {
    this.prepareCardBase64(imagePath)
    this.applyDefaultPoints(displayWidth, displayHeight, imagePath)
    wx.hideLoading()
    this.setData({ detecting: false })
    wx.showToast({
      title: toastTitle || '云端识别失败，请手动调整',
      icon: 'none',
      duration: 2000
    })
  },

  applyServerResult(result, displayWidth, displayHeight) {
    const cloudInfo = (this.cloudAutoImageInfo && this.cloudAutoImagePath)
      ? {
        ...this.cloudAutoImageInfo,
        path: this.cloudAutoImagePath
      }
      : (this.cloudAutoImageInfo || null)
    const displayPath = this.cloudAutoImagePath
      || (this.imageInfo && this.imageInfo.path)
      || (cloudInfo && cloudInfo.path)
    const displayInfo = cloudInfo || this.imageInfo || {
      width: (result.meta && result.meta.width) || 0,
      height: (result.meta && result.meta.height) || 0,
      orientation: 'up'
    }
    if (displayPath) {
      this.imageInfo = { ...displayInfo, path: displayPath }
    }
    const imageWidth = displayInfo.width
    const imageHeight = displayInfo.height
    const sourceWidth = (result.meta && result.meta.width) || (cloudInfo && cloudInfo.width) || imageWidth
    const sourceHeight = (result.meta && result.meta.height) || (cloudInfo && cloudInfo.height) || imageHeight
    const sourceOrientation = normalizeOrientation((cloudInfo && cloudInfo.orientation) || displayInfo.orientation)
    const targetOrientation = sourceOrientation
    const sourceOrientedSize = getOrientedSize(sourceWidth, sourceHeight, sourceOrientation.base)
    const targetOrientedSize = sourceOrientedSize
    const scaleOrientedX = 1
    const scaleOrientedY = 1
    const transform = this.calcAspectFitTransform(
      sourceOrientedSize.width,
      sourceOrientedSize.height,
      displayWidth,
      displayHeight
    )
    console.log('[CloudAuto] 映射参数:', {
      source: `${sourceWidth}x${sourceHeight}`,
      target: `${imageWidth}x${imageHeight}`,
      sourceOrientation,
      targetOrientation,
      scaleOrientedX: scaleOrientedX.toFixed(4),
      scaleOrientedY: scaleOrientedY.toFixed(4),
      transform
    })
    const normalizedIris = normalizeIrisResult(result.iris)
    console.log('[CloudAuto] Iris 原始:', JSON.stringify(result.iris))
    console.log('[CloudAuto] Iris 规范:', JSON.stringify(normalizedIris))
    if (!normalizedIris) {
      console.warn('[CloudAuto] iris 结构异常:', result.iris)
      this.handleCloudAutoFail(displayPath || this.imageInfo.path, displayWidth, displayHeight, '瞳孔数据异常，请重试')
      return
    }

    // 优先使用云端返回的归一化坐标（如果有的话）
    const hasNormalizedCoords = result.iris
      && result.iris.left_normalized
      && result.iris.right_normalized
      && isNumber(result.iris.left_normalized.x)
      && isNumber(result.iris.right_normalized.x)

    if (hasNormalizedCoords) {
      console.log('[CloudAuto] 使用归一化坐标')
      const leftNorm = result.iris.left_normalized
      const rightNorm = result.iris.right_normalized

      // 归一化坐标属于原图坐标系，仍需经过 aspectFit 映射，不能直接乘屏幕尺寸。
      const leftX = leftNorm.x * sourceOrientedSize.width * transform.scale - transform.offsetX
      const leftY = leftNorm.y * sourceOrientedSize.height * transform.scale - transform.offsetY
      const rightX = rightNorm.x * sourceOrientedSize.width * transform.scale - transform.offsetX
      const rightY = rightNorm.y * sourceOrientedSize.height * transform.scale - transform.offsetY

      const leftDisplay = safePointCenter(leftX, leftY, displayWidth, displayHeight)
      const rightDisplay = safePointCenter(rightX, rightY, displayWidth, displayHeight)

      console.log('[CloudAuto] 归一化坐标映射:', {
        leftNorm,
        rightNorm,
        leftDisplay,
        rightDisplay,
        displaySize: `${displayWidth}x${displayHeight}`,
        cameraPosition: this.data.cameraPosition
      })

      let screenLeftEye = leftDisplay
      let screenRightEye = rightDisplay
      if (screenLeftEye.x > screenRightEye.x) {
        screenLeftEye = rightDisplay
        screenRightEye = leftDisplay
      }

      const leftEye = this.makePoint(screenLeftEye.x, screenLeftEye.y)
      const rightEye = this.makePoint(screenRightEye.x, screenRightEye.y)
      const noseX = (screenLeftEye.x + screenRightEye.x) / 2

      this.setData({
        stage: 'adjust',
        step: 0,
        photoPath: displayPath || this.imageInfo.path,
        displayWidth,
        displayHeight,
        leftEye,
        rightEye,
        centerX: this.makeLineX(safeLineCenter(noseX, displayWidth)),
        faceLeftX: this.makeLineX(safeLineCenter(displayWidth * 0.1, displayWidth)),
        faceRightX: this.makeLineX(safeLineCenter(displayWidth * 0.9, displayWidth)),
        cardLeftX: this.makeLineX(safeLineCenter(displayWidth * 0.15, displayWidth)),
        cardRightX: this.makeLineX(safeLineCenter(displayWidth * 0.85, displayWidth)),
        autoFaceReady: true
      })
      this.resetDragCache()
      this.prepareCardBase64(displayPath || this.imageInfo.path)
      return
    }

    console.log('[CloudAuto] 使用像素坐标 (复杂映射)')
    const sameOrientation = sourceOrientation.base === targetOrientation.base
      && sourceOrientation.mirrored === targetOrientation.mirrored
    const normalizeCloudPoint = (point) => {
      if (!point || !isNumber(point.x) || !isNumber(point.y)) return null
      let x = point.x
      let y = point.y
      // 云端服务（iris_service/app.py）返回的是像素坐标（已经乘以了width和height）
      // 只有在明确是归一化坐标时才需要缩放
      // 判断标准：x 和 y 都严格在 (0, 1) 之间，且图片尺寸合理
      // 同时要求至少有一个坐标不是常见的中心点值（如0.5），以避免误判
      const looksNormalized = x > 0 && x < 1 && y > 0 && y < 1
      const isLikelyPixels = x > 10 || y > 10 || sourceWidth <= 1 || sourceHeight <= 1

      console.log('[CloudAuto] normalizeCloudPoint:', {
        input: { x, y },
        sourceSize: `${sourceWidth}x${sourceHeight}`,
        looksNormalized,
        isLikelyPixels,
        willScale: looksNormalized && !isLikelyPixels
      })

      if (looksNormalized && !isLikelyPixels) {
        // 看起来是归一化坐标，需要转换为像素坐标
        x *= sourceWidth
        y *= sourceHeight
        console.log('[CloudAuto] 坐标已缩放:', { x, y })
      }
      // 否则已经是像素坐标，直接返回
      return { x, y }
    }
    const mapCloudPoint = (point) => {
      const normalizedPoint = normalizeCloudPoint(point)
      if (!normalizedPoint) return null
      const mapped = mapPointByOrientation(
        normalizedPoint,
        sourceWidth,
        sourceHeight,
        sourceOrientation.base,
        sourceOrientation.mirrored
      )
      if (!mapped) return null
      const mappedX = mapped.x * scaleOrientedX
      const mappedY = mapped.y * scaleOrientedY
      return {
        x: !sameOrientation && targetOrientation.mirrored
          ? (targetOrientedSize.width - mappedX)
          : mappedX,
        y: mappedY
      }
    }
    const sampleY = (normalizedIris.left && isNumber(normalizedIris.left.y))
      ? normalizedIris.left.y
      : ((normalizedIris.right && isNumber(normalizedIris.right.y))
        ? normalizedIris.right.y
        : (sourceHeight / 2))
    const leftRaw = mapCloudPoint(normalizedIris.left)
    const rightRaw = mapCloudPoint(normalizedIris.right)
    if (!leftRaw || !rightRaw) {
      console.warn('[CloudAuto] 坐标映射失败')
      this.handleCloudAutoFail(displayPath || this.imageInfo.path, displayWidth, displayHeight, '坐标映射失败，请重试')
      return
    }

    const leftDisplay = safePointCenter(
      leftRaw.x * transform.scale - transform.offsetX,
      leftRaw.y * transform.scale - transform.offsetY,
      displayWidth,
      displayHeight
    )
    const rightDisplay = safePointCenter(
      rightRaw.x * transform.scale - transform.offsetX,
      rightRaw.y * transform.scale - transform.offsetY,
      displayWidth,
      displayHeight
    )
    console.log('[CloudAuto] Iris 映射后:', JSON.stringify({
      leftRaw,
      rightRaw,
      leftDisplay,
      rightDisplay,
      transform,
      displaySize: `${displayWidth}x${displayHeight}`
    }))

    let screenLeftEye = leftDisplay
    let screenRightEye = rightDisplay
    if (screenLeftEye.x > screenRightEye.x) {
      screenLeftEye = rightDisplay
      screenRightEye = leftDisplay
    }

    const leftEye = this.makePoint(screenLeftEye.x, screenLeftEye.y)
    const rightEye = this.makePoint(screenRightEye.x, screenRightEye.y)

    let noseX = (screenLeftEye.x + screenRightEye.x) / 2
    if (result.face && isNumber(result.face.nose_x)) {
      const noseRaw = mapCloudPoint({ x: result.face.nose_x, y: sampleY })
      if (noseRaw) {
        noseX = noseRaw.x * transform.scale - transform.offsetX
      }
    }

    let faceLeftX = displayWidth * 0.1
    let faceRightX = displayWidth * 0.9
    if (result.face && isNumber(result.face.left_x) && isNumber(result.face.right_x)) {
      const leftFaceRaw = mapCloudPoint({ x: result.face.left_x, y: sampleY })
      const rightFaceRaw = mapCloudPoint({ x: result.face.right_x, y: sampleY })
      if (leftFaceRaw && rightFaceRaw) {
        faceLeftX = leftFaceRaw.x * transform.scale - transform.offsetX
        faceRightX = rightFaceRaw.x * transform.scale - transform.offsetX
      }
    }

    let cardLeftX = this.makeLineX(safeLineCenter(displayWidth * 0.15, displayWidth))
    let cardRightX = this.makeLineX(safeLineCenter(displayWidth * 0.85, displayWidth))
    const hasCardCorners = result.card && Array.isArray(result.card.corners) && result.card.corners.length >= 4
    if (hasCardCorners) {
      const points = result.card.corners
        .map((point) => mapCloudPoint(point))
        .filter((point) => point && isNumber(point.x) && isNumber(point.y))
        .map((point) => ({
          x: point.x * transform.scale - transform.offsetX,
          y: point.y * transform.scale - transform.offsetY
        }))
      if (points.length >= 4) {
        const xs = points.map((point) => point.x)
        const minX = Math.min(...xs)
        const maxX = Math.max(...xs)
        cardLeftX = this.makeLineX(safeLineCenter(minX, displayWidth))
        cardRightX = this.makeLineX(safeLineCenter(maxX, displayWidth))
        this.cardAutoApplied = true
      }
    }

    this.setData({
      stage: 'adjust',
      step: 0,
      photoPath: displayPath || this.imageInfo.path,
      displayWidth,
      displayHeight,
      leftEye,
      rightEye,
      centerX: this.makeLineX(safeLineCenter(noseX, displayWidth)),
      faceLeftX: this.makeLineX(safeLineCenter(faceLeftX, displayWidth)),
      faceRightX: this.makeLineX(safeLineCenter(faceRightX, displayWidth)),
      cardLeftX,
      cardRightX,
      autoFaceReady: true
    })
    this.resetDragCache()
    this.tryApplyCardAuto()
    this.autoMeasureIfReady()
    if (!hasCardCorners) {
      this.prepareCardBase64(displayPath || this.imageInfo.path)
    }
  },

  prepareCardBase64(path) {
    wx.compressImage({
      src: path,
      quality: 60,
      success: (res) => {
        wx.getImageInfo({
          src: res.tempFilePath,
          success: (info) => {
            this.cardImageInfo = info
          },
          complete: () => {
            wx.getFileSystemManager().readFile({
              filePath: res.tempFilePath,
              encoding: 'base64',
              success: (readRes) => {
                this.cardBase64 = readRes.data
                this.detectCardAuto(this.cardBase64)
              }
            })
          }
        })
      },
      fail: () => {
        wx.getImageInfo({
          src: path,
          success: (info) => {
            this.cardImageInfo = info
          },
          complete: () => {
            wx.getFileSystemManager().readFile({
              filePath: path,
              encoding: 'base64',
              success: (readRes) => {
                this.cardBase64 = readRes.data
                this.detectCardAuto(this.cardBase64)
              }
            })
          }
        })
      }
    })
  },

  // 调用 Face++ API 识别人脸
  detectFace(imagePath, displayWidth, displayHeight) {
    const facePlusPlusConfig = config.facePlusPlus || {}
    if (facePlusPlusConfig.enabled === false) {
      console.warn('[Face++] 已禁用，跳过识别')
      this.applyDefaultPoints(displayWidth, displayHeight, imagePath)
      wx.hideLoading()
      this.setData({ detecting: false })
      wx.showToast({
        title: '云端识别失败，请手动调整',
        icon: 'none',
        duration: 2000
      })
      return
    }
    const { apiKey, apiSecret, apiUrl } = config.facePlusPlus
    const denseConfig = config.facePlusPlusDense || {}
    const useDenseOnly = denseConfig.enabled && denseConfig.onlyDense
    console.log('[Face++] 开始识别，API URL:', useDenseOnly ? denseConfig.apiUrl : apiUrl)

    // 读取图片文件转 base64
    wx.getFileSystemManager().readFile({
      filePath: imagePath,
      encoding: 'base64',
      success: (res) => {
        const base64 = res.data
        console.log('[Face++] 图片已转 base64，长度:', base64.length)

        const finalize = () => {
          wx.hideLoading()
          this.setData({ detecting: false })
        }

        if (useDenseOnly) {
          this.requestDenseLandmark({
            apiKey,
            apiSecret,
            base64,
            denseConfig,
            onSuccess: (denseLandmark, denseData) => {
              const flattened = flattenLandmark(denseLandmark)
              const normalized = normalizeIrisLandmark(flattened)
              const leftCheck = buildEyeCenter(normalized, 'left')
              const rightCheck = buildEyeCenter(normalized, 'right')
              if (!leftCheck || !rightCheck) {
                this.requestBaseDetect({
                  base64,
                  imagePath,
                  displayWidth,
                  displayHeight,
                  finalize,
                  toastTitle: '稠密识别偏移，已切回基础识别'
                })
                return
              }
              const faceRect = extractFaceRect(denseData, normalized)
              this.applyFacePoints(normalized, displayWidth, displayHeight, faceRect)
              finalize()
            },
            onFail: () => {
              this.requestBaseDetect({
                base64,
                imagePath,
                displayWidth,
                displayHeight,
                finalize,
                toastTitle: '稠密识别失败，已切回基础识别'
              })
            }
          })
          return
        }

        this.requestBaseDetect({
          base64,
          imagePath,
          displayWidth,
          displayHeight,
          finalize,
          denseConfig
        })
      },
      fail: (err) => {
        console.error('[Face++] 读取图片失败:', err)
        wx.hideLoading()
        this.setData({ detecting: false })
        this.applyDefaultPoints(displayWidth, displayHeight, imagePath)
      }
    })
  },

  requestBaseDetect({ base64, imagePath, displayWidth, displayHeight, finalize, denseConfig, toastTitle }) {
    const { apiKey, apiSecret, apiUrl } = config.facePlusPlus
    wx.request({
      url: apiUrl,
      method: 'POST',
      header: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      data: {
        api_key: apiKey,
        api_secret: apiSecret,
        image_base64: base64,
        return_landmark: 2
      },
      success: (res) => {
        console.log('[Face++] API 返回:', res.data)

        if (res.data.faces && res.data.faces.length > 0) {
          console.log('[Face++] 识别成功，检测到人脸数:', res.data.faces.length)
          const face = res.data.faces[0]
          const landmark = face.landmark
          const faceRect = face.face_rectangle
          const applyLandmark = (nextLandmark) => {
            const flattened = flattenLandmark(nextLandmark || landmark)
            const normalized = normalizeIrisLandmark(flattened)
            this.applyFacePoints(normalized, displayWidth, displayHeight, faceRect)
            finalize()
          }
          if (denseConfig && denseConfig.enabled && denseConfig.apiUrl && !denseConfig.onlyDense) {
            this.requestDenseLandmark({
              apiKey,
              apiSecret,
              base64,
              faceToken: face.face_token,
              denseConfig,
              onSuccess: (denseLandmark) => {
                applyLandmark(denseLandmark)
              },
              onFail: () => {
                applyLandmark(landmark)
              }
            })
          } else {
            applyLandmark(landmark)
          }
          return
        }

        console.log('[Face++] 未检测到人脸')
        this.applyDefaultPoints(displayWidth, displayHeight, imagePath)
        wx.showToast({
          title: toastTitle || '未检测到人脸，请手动调整',
          icon: 'none',
          duration: 2000
        })
        finalize()
      },
      fail: (err) => {
        console.error('[Face++] API 调用失败:', err)
        this.applyDefaultPoints(displayWidth, displayHeight, imagePath)
        wx.showToast({
          title: toastTitle || '识别失败，请手动调整',
          icon: 'none',
          duration: 2000
        })
        finalize()
      }
    })
  },

  requestDenseLandmark({ apiKey, apiSecret, base64, faceToken, denseConfig, onSuccess, onFail }) {
    const payload = {
      api_key: apiKey,
      api_secret: apiSecret
    }

    if (denseConfig.returnLandmark) {
      payload.return_landmark = denseConfig.returnLandmark
    }

    if (denseConfig.useFaceToken && faceToken) {
      payload.face_token = faceToken
    } else {
      payload.image_base64 = base64
    }

    wx.request({
      url: denseConfig.apiUrl,
      method: 'POST',
      header: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      data: payload,
      success: (res) => {
        const data = res.data || {}
        const denseLandmark = data.landmark
          || (data.face && data.face.landmark)
          || (data.faces && data.faces[0] && data.faces[0].landmark)
          || (data.result && data.result.landmark)
          || (data.data && data.data.landmark)
        if (denseLandmark) {
          console.log('[Face++] 稠密关键点返回成功')
          // 调试：打印原始瞳孔坐标
          const lpc = denseLandmark.left_eye_pupil_center
            || (denseLandmark.left_eye && denseLandmark.left_eye.left_eye_pupil_center)
          const rpc = denseLandmark.right_eye_pupil_center
            || (denseLandmark.right_eye && denseLandmark.right_eye.right_eye_pupil_center)
          console.log('[Face++] 原始API返回瞳孔坐标:', {
            left_eye_pupil_center: lpc ? `x=${lpc.x}, y=${lpc.y}` : 'not found',
            right_eye_pupil_center: rpc ? `x=${rpc.x}, y=${rpc.y}` : 'not found'
          })
          // 检查是否有 face_rectangle
          const faceRect = data.face_rectangle
            || (data.face && data.face.face_rectangle)
            || (data.faces && data.faces[0] && data.faces[0].face_rectangle)
          console.log('[Face++] face_rectangle:', faceRect || 'not found')
          // 检查 Face++ 返回的图片尺寸（如果有）
          const imageSize = data.image_id ? null : (data.image_size || data.imageSize || (data.result && data.result.image_size))
          console.log('[Face++] API返回的图片尺寸:', imageSize || '未返回')
          onSuccess && onSuccess(denseLandmark, data)
          return
        }
        console.warn('[Face++] 稠密关键点返回异常:', data)
        onFail && onFail()
      },
      fail: (err) => {
        console.error('[Face++] 稠密关键点调用失败:', err)
        onFail && onFail()
      }
    })
  },

  detectCardAuto(base64) {
    console.log('[Card] detectCardAuto 开始')
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
      console.warn('[Card] 云开发未初始化，无法调用卡片识别')
      this.cardAutoFailed = true
      return
    }
    if (!base64) {
      console.warn('[Card] base64 为空，跳过卡片识别')
      this.cardAutoFailed = true
      return
    }
    console.log('[Card] 调用云函数 detectCard，图片大小:', Math.round(base64.length / 1024), 'KB')
    wx.cloud.callFunction({
      name: 'detectCard',
      data: { imageBase64: base64 },
      success: (res) => {
        const data = res.result || {}
        console.log('[Card] 云函数返回:', data)
        if (data.ok && Array.isArray(data.corners) && data.corners.length >= 4) {
          this.cardAutoResult = data.corners
          this.tryApplyCardAuto()
        } else {
          console.warn('[Card] 自动识别失败:', data)
          if (!this.cardAutoFailed) {
            this.cardAutoFailed = true
            wx.showToast({
              title: '卡片自动识别失败，请手动对齐',
              icon: 'none',
              duration: 1800
            })
          }
        }
      },
      fail: (err) => {
        console.warn('[Card] 云函数识别失败:', err)
        if (!this.cardAutoFailed) {
          this.cardAutoFailed = true
          wx.showToast({
            title: '卡片自动识别失败，请手动对齐',
            icon: 'none',
            duration: 1800
          })
        }
      }
    })
  },

  tryApplyCardAuto() {
    console.log('[Card] tryApplyCardAuto 开始:', {
      hasCardAutoResult: !!this.cardAutoResult,
      cardAutoApplied: this.cardAutoApplied,
      cardAutoDisabled: this.cardAutoDisabled,
      stage: this.data.stage,
      hasImageInfo: !!this.imageInfo
    })
    if (!this.cardAutoResult || this.cardAutoApplied || this.cardAutoDisabled) {
      console.log('[Card] tryApplyCardAuto 跳过：条件不满足')
      return
    }
    if (this.data.stage !== 'adjust' || !this.imageInfo) {
      console.log('[Card] tryApplyCardAuto 跳过：stage不是adjust或没有imageInfo')
      return
    }
    const displayWidth = this.data.displayWidth
    const displayHeight = this.data.displayHeight
    if (!displayWidth || !displayHeight) {
      console.log('[Card] tryApplyCardAuto 跳过：displayWidth或displayHeight为0')
      return
    }

    const cardInfo = this.cardImageInfo || this.imageInfo
    const cardOrientation = normalizeOrientation(cardInfo && cardInfo.orientation)
    const imageOrientation = normalizeOrientation(this.imageInfo && this.imageInfo.orientation)
    const cardOrientedSize = getOrientedSize(cardInfo.width, cardInfo.height, cardOrientation.base)
    const imageOrientedSize = getOrientedSize(
      this.imageInfo.width,
      this.imageInfo.height,
      imageOrientation.base
    )
    const scaleX = imageOrientedSize.width / cardOrientedSize.width
    const scaleY = imageOrientedSize.height / cardOrientedSize.height
    const transform = this.calcAspectFitTransform(
      imageOrientedSize.width,
      imageOrientedSize.height,
      displayWidth,
      displayHeight
    )

    const points = this.cardAutoResult
      .map((point) => mapPointByOrientation(
        point,
        cardInfo.width,
        cardInfo.height,
        cardOrientation.base,
        cardOrientation.mirrored
      ))
      .filter((point) => point && isNumber(point.x) && isNumber(point.y))
      .map((point) => ({
        x: point.x * scaleX,
        y: point.y * scaleY
      }))
      .map((point) => ({
        x: point.x * transform.scale - transform.offsetX,
        y: point.y * transform.scale - transform.offsetY
      }))
    if (points.length < 4) {
      return
    }
    const xs = points.map((point) => point.x)
    const ys = points.map((point) => point.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const width = Math.max(1, maxX - minX)
    const height = Math.max(1, maxY - minY)
    const widthRatio = width / displayWidth
    const heightRatio = height / displayHeight
    const centerY = (minY + maxY) / 2
    const centerYRatio = centerY / displayHeight
    // 银行卡/身份证标准比例约 1.586；自动测量只接受横放。
    const aspectRatio = width / height
    const targetHorizontal = 1.586
    const targetVertical = 1 / 1.586  // ≈ 0.63
    const ratioDiffHorizontal = Math.abs(aspectRatio - targetHorizontal) / targetHorizontal
    const ratioDiffVertical = Math.abs(aspectRatio - targetVertical) / targetVertical
    // 选择更接近的那个
    const ratioDiff = Math.min(ratioDiffHorizontal, ratioDiffVertical)
    const isVerticalCard = ratioDiffVertical < ratioDiffHorizontal

    // 自动计算只接受横放卡片；竖放时水平像素宽度对应短边，会导致比例尺严重错误。
    const validCard = widthRatio >= 0.05        // 允许很小的卡片（远距离拍摄）
      && widthRatio <= 0.95                      // 几乎占满屏幕也可以
      && heightRatio >= 0.015                    // 很扁的卡片也接受
      && heightRatio <= 0.6                      // 提高上限
      && centerYRatio >= 0.05
      && centerYRatio <= 0.6                     // 自动结果只接受上半身/额头附近的卡片
      && !isVerticalCard
      && ratioDiffHorizontal <= 0.35             // 横放卡片允许一定透视变形
    console.log('[Card] 计算:', {
      widthRatio: widthRatio.toFixed(3),
      heightRatio: heightRatio.toFixed(3),
      centerYRatio: centerYRatio.toFixed(3),
      aspectRatio: aspectRatio.toFixed(3),
      ratioDiff: ratioDiff.toFixed(3),
      isVerticalCard,
      validCard
    })
    if (!validCard) {
      console.log('[Card] 卡片验证失败，原因:',
        widthRatio < 0.05 ? 'widthRatio过小(卡片太小)' :
        widthRatio > 0.95 ? 'widthRatio过大(卡片太大)' :
        heightRatio < 0.015 ? 'heightRatio过小' :
        heightRatio > 0.6 ? 'heightRatio过大' :
        centerYRatio < 0.05 || centerYRatio > 0.6 ? '卡片位置离眼部区域过远' :
        isVerticalCard ? '卡片疑似竖放' :
        ratioDiffHorizontal > 0.35 ? `ratioDiff过大(${aspectRatio.toFixed(2)}，不像横放银行卡)` : '未知'
      )
      if (!this.cardAutoFailed) {
        this.cardAutoFailed = true
        wx.showToast({
          title: '卡片自动识别失败，请手动对齐',
          icon: 'none',
          duration: 1800
        })
      }
      return
    }
    console.log('[Card] 卡片验证通过，准备应用自动对齐')

    const cardLeftX = this.makeLineX(safeLineCenter(minX, displayWidth))
    const cardRightX = this.makeLineX(safeLineCenter(maxX, displayWidth))
    this.cardAutoApplied = true
    this.setData({
      cardLeftX,
      cardRightX
    })
    this.resetDragCache()
    // 如果卡片比例有一定偏差，提示用户可能需要微调
    if (ratioDiffHorizontal > 0.15) {
      wx.showToast({
        title: '已自动对齐，建议检查卡片边缘',
        icon: 'none',
        duration: 2000
      })
    } else {
      wx.showToast({
        title: '已自动对齐卡片边缘',
        icon: 'none',
        duration: 1500
      })
    }
    this.autoMeasureIfReady()
  },

  autoMeasureIfReady() {
    console.log('[AutoMeasure] 检查条件:', {
      autoMeasureEnabled: this.data.autoMeasureEnabled,
      autoMeasureDone: this.data.autoMeasureDone,
      autoFaceReady: this.data.autoFaceReady,
      cardAutoApplied: this.cardAutoApplied,
      cardAutoFailed: this.cardAutoFailed,
      stage: this.data.stage
    })
    if (!this.data.autoMeasureEnabled || this.data.autoMeasureDone) {
      console.log('[AutoMeasure] 跳过：autoMeasureEnabled=', this.data.autoMeasureEnabled, 'autoMeasureDone=', this.data.autoMeasureDone)
      return
    }
    if (!this.data.autoFaceReady || !this.cardAutoApplied) {
      console.log('[AutoMeasure] 跳过：等待人脸或卡片识别完成')
      return
    }
    if (this.data.stage !== 'adjust') {
      console.log('[AutoMeasure] 跳过：stage=', this.data.stage)
      return
    }
    console.log('[AutoMeasure] 条件满足，准备自动计算结果')
    this.setData({ autoMeasureDone: true })
    setTimeout(() => {
      this.calculateResult()
    }, 200)
  },

  // 计算 aspectFit 模式下的坐标转换
  // aspectFit 会保持比例完整显示图片，可能有留白
  calcAspectFitTransform(imgWidth, imgHeight, containerWidth, containerHeight) {
    const imgRatio = imgWidth / imgHeight
    const containerRatio = containerWidth / containerHeight

    let scale, offsetX, offsetY

    if (imgRatio > containerRatio) {
      // 图片更宽，宽度填满，上下留白
      scale = containerWidth / imgWidth
      offsetX = 0
      offsetY = -(containerHeight - imgHeight * scale) / 2  // 负值表示需要加上这个偏移
    } else {
      // 图片更高，高度填满，左右留白
      scale = containerHeight / imgHeight
      offsetX = -(containerWidth - imgWidth * scale) / 2  // 负值表示需要加上这个偏移
      offsetY = 0
    }

    return { scale, offsetX, offsetY }
  },

  // 计算 aspectFill 模式下的坐标转换
  // aspectFill 会保持比例填充满容器，可能会裁剪
  calcAspectFillTransform(imgWidth, imgHeight, containerWidth, containerHeight) {
    const imgRatio = imgWidth / imgHeight
    const containerRatio = containerWidth / containerHeight

    let scale, offsetX, offsetY

    if (imgRatio > containerRatio) {
      // 图片更宽，高度填满，宽度被裁剪
      scale = containerHeight / imgHeight
      offsetX = (imgWidth * scale - containerWidth) / 2
      offsetY = 0
    } else {
      // 图片更高，宽度填满，高度被裁剪
      scale = containerWidth / imgWidth
      offsetX = 0
      offsetY = (imgHeight * scale - containerHeight) / 2
    }

    return { scale, offsetX, offsetY }
  },

  // 应用 Face++ 返回的人脸关键点
  applyFacePoints(landmark, displayWidth, displayHeight, faceRect) {
    console.log('[Face++] landmark 关键点:', Object.keys(landmark))
    console.log('[Face++] imageInfo:', {
      width: this.imageInfo && this.imageInfo.width,
      height: this.imageInfo && this.imageInfo.height,
      orientation: this.imageInfo && this.imageInfo.orientation,
      displayWidth,
      displayHeight,
      cameraPosition: this.data.cameraPosition
    })

    const imageWidth = this.imageInfo.width
    const imageHeight = this.imageInfo.height
    const orientation = normalizeOrientation(this.imageInfo && this.imageInfo.orientation)
    const candidates = []
    const addCandidate = (base, mirrored, label) => {
      const key = `${base}-${mirrored ? 'm' : 'n'}`
      if (candidates.some((item) => item.key === key)) return
      candidates.push({ base, mirrored, label, key })
    }
    // 不再区分前置/后置摄像头，统一尝试所有可能的方向
    // 让评分系统自动选择最佳方向
    addCandidate(orientation.base, orientation.mirrored, 'meta')
    addCandidate(orientation.base, !orientation.mirrored, 'meta-flip')
    addCandidate('up', false, 'up')
    addCandidate('up', true, 'up-mirror')

    const computeCandidate = (base, mirrored) => {
      const orientedLandmark = mapLandmarkByOrientation(
        landmark,
        imageWidth,
        imageHeight,
        base,
        mirrored
      )
      const leftEyeLandmarkCenter = buildEyeCenter(orientedLandmark, 'left')
      const rightEyeLandmarkCenter = buildEyeCenter(orientedLandmark, 'right')
      if (!leftEyeLandmarkCenter || !rightEyeLandmarkCenter) {
        return { score: -999, valid: false }
      }
      const leftEyeBox = buildEyeBox(orientedLandmark, 'left')
      const rightEyeBox = buildEyeBox(orientedLandmark, 'right')

      // 调试：打印原始 landmark 中的瞳孔中心坐标
      const rawLeftPupil = landmark.left_eye_pupil_center || (landmark.left_eye && landmark.left_eye.left_eye_pupil_center)
      const rawRightPupil = landmark.right_eye_pupil_center || (landmark.right_eye && landmark.right_eye.right_eye_pupil_center)
      console.log(`[Face++] 候选${base}-${mirrored ? 'm' : 'n'} 原始坐标:`, {
        rawLeftPupil: rawLeftPupil ? `${rawLeftPupil.x.toFixed(0)},${rawLeftPupil.y.toFixed(0)}` : 'null',
        rawRightPupil: rawRightPupil ? `${rawRightPupil.x.toFixed(0)},${rawRightPupil.y.toFixed(0)}` : 'null',
        builtLeft: `${leftEyeLandmarkCenter.x.toFixed(0)},${leftEyeLandmarkCenter.y.toFixed(0)}`,
        builtRight: `${rightEyeLandmarkCenter.x.toFixed(0)},${rightEyeLandmarkCenter.y.toFixed(0)}`
      })

      // 保持 Face++ 的原始标签，不在这里交换
      // Face++ 的 left_eye 是人脸主人的左眼
      // 在正常照片中，人脸主人的左眼应该在屏幕右侧（观看者的右边）
      // 在镜像照片中，人脸主人的左眼会在屏幕左侧
      const leftEyeX = leftEyeLandmarkCenter.x
      const leftEyeY = leftEyeLandmarkCenter.y
      const rightEyeX = rightEyeLandmarkCenter.x
      const rightEyeY = rightEyeLandmarkCenter.y

      const leRight = orientedLandmark.left_eye_right_corner
      const reLeft = orientedLandmark.right_eye_left_corner

      let noseX
      if (orientedLandmark.nose_bridge) {
        noseX = orientedLandmark.nose_bridge.x
      } else if (orientedLandmark.nose_bridge2) {
        noseX = orientedLandmark.nose_bridge2.x
      } else if (orientedLandmark.nose_bridge1) {
        noseX = orientedLandmark.nose_bridge1.x
      } else {
        const noseMidline = averageXFromPrefix(orientedLandmark, 'nose_midline_')
        if (isNumber(noseMidline)) {
          noseX = noseMidline
        } else if (orientedLandmark.nose_tip) {
          noseX = orientedLandmark.nose_tip.x
        } else if (leRight && reLeft && isNumber(leRight.x) && isNumber(reLeft.x)) {
          noseX = (leRight.x + reLeft.x) / 2
        } else {
          noseX = (leftEyeX + rightEyeX) / 2
        }
      }
      if (!isNumber(noseX)) {
        noseX = (leftEyeX + rightEyeX) / 2
      }

      const orientedFaceRect = mapRectByOrientation(
        faceRect,
        imageWidth,
        imageHeight,
        base,
        mirrored
      )
      let faceRectValid = true
      let faceRectScore = 0
      if (orientedFaceRect
        && isNumber(orientedFaceRect.left)
        && isNumber(orientedFaceRect.top)
        && isNumber(orientedFaceRect.width)
        && isNumber(orientedFaceRect.height)) {
        const rectLeft = orientedFaceRect.left
        const rectRight = rectLeft + orientedFaceRect.width
        const rectTop = orientedFaceRect.top
        const rectBottom = rectTop + orientedFaceRect.height
        const eyeYAvgRaw = (leftEyeY + rightEyeY) / 2
        const eyeYRatio = (eyeYAvgRaw - rectTop) / orientedFaceRect.height
        const noseRatio = (noseX - rectLeft) / orientedFaceRect.width
        const eyesInside = leftEyeX >= rectLeft
          && rightEyeX <= rectRight
          && eyeYAvgRaw >= rectTop
          && eyeYAvgRaw <= rectBottom
        if (!eyesInside) {
          faceRectValid = false
        }
        if (eyeYRatio < 0.15 || eyeYRatio > 0.7) {
          faceRectValid = false
        }
        if (noseRatio < 0.25 || noseRatio > 0.75) {
          faceRectValid = false
        }
        const eyeRatioScore = 1 - Math.abs(eyeYRatio - 0.35)
        const noseRatioScore = 1 - Math.abs(noseRatio - 0.5)
        faceRectScore = (eyeRatioScore + noseRatioScore) * 120
      }

      let faceLeftX = null
      let faceRightX = null
      Object.keys(orientedLandmark).forEach((key) => {
        const point = orientedLandmark[key]
        if (!point || !isNumber(point.x)) return
        if (key.indexOf('contour_left') === 0 || key.indexOf('face_contour_left') === 0) {
          faceLeftX = faceLeftX === null ? point.x : Math.min(faceLeftX, point.x)
        }
        if (key.indexOf('contour_right') === 0 || key.indexOf('face_contour_right') === 0) {
          faceRightX = faceRightX === null ? point.x : Math.max(faceRightX, point.x)
        }
      })

      const orientedSize = getOrientedSize(imageWidth, imageHeight, base)
      const transform = this.calcAspectFitTransform(
        orientedSize.width,
        orientedSize.height,
        displayWidth,
        displayHeight
      )

      // 调试：打印 transform 参数
      console.log(`[Face++] 候选${base}-${mirrored ? 'm' : 'n'} transform:`, {
        orientedSize: `${orientedSize.width}x${orientedSize.height}`,
        display: `${displayWidth}x${displayHeight}`,
        scale: transform.scale.toFixed(3),
        offsetX: transform.offsetX.toFixed(1),
        offsetY: transform.offsetY.toFixed(1)
      })

      const leftEyeDisplayCenter = safePointCenter(
        leftEyeX * transform.scale - transform.offsetX,
        leftEyeY * transform.scale - transform.offsetY,
        displayWidth,
        displayHeight
      )
      const rightEyeDisplayCenter = safePointCenter(
        rightEyeX * transform.scale - transform.offsetX,
        rightEyeY * transform.scale - transform.offsetY,
        displayWidth,
        displayHeight
      )

      // 调试：打印显示坐标计算过程
      console.log(`[Face++] 候选${base}-${mirrored ? 'm' : 'n'} 显示坐标计算:`, {
        leftRaw: `${(leftEyeX * transform.scale - transform.offsetX).toFixed(1)},${(leftEyeY * transform.scale - transform.offsetY).toFixed(1)}`,
        leftSafe: `${leftEyeDisplayCenter.x.toFixed(1)},${leftEyeDisplayCenter.y.toFixed(1)}`,
        rightRaw: `${(rightEyeX * transform.scale - transform.offsetX).toFixed(1)},${(rightEyeY * transform.scale - transform.offsetY).toFixed(1)}`,
        rightSafe: `${rightEyeDisplayCenter.x.toFixed(1)},${rightEyeDisplayCenter.y.toFixed(1)}`
      })
      const noseDisplayX = safeLineCenter(
        noseX * transform.scale - transform.offsetX,
        displayWidth
      )

      const eyeDistanceDisplay = Math.abs(rightEyeDisplayCenter.x - leftEyeDisplayCenter.x)
      const eyeYAvg = (leftEyeDisplayCenter.y + rightEyeDisplayCenter.y) / 2
      const eyeYDiff = Math.abs(leftEyeDisplayCenter.y - rightEyeDisplayCenter.y)
      const invalidEyePosition = eyeDistanceDisplay < displayWidth * 0.18
        || eyeDistanceDisplay > displayWidth * 0.7
        || eyeYAvg < displayHeight * 0.12
        || eyeYAvg > displayHeight * 0.65
        || eyeYDiff > displayHeight * 0.12

      let faceLeftDisplayX = isNumber(faceLeftX)
        ? faceLeftX * transform.scale - transform.offsetX
        : displayWidth * 0.1
      let faceRightDisplayX = isNumber(faceRightX)
        ? faceRightX * transform.scale - transform.offsetX
        : displayWidth * 0.9
      faceLeftDisplayX = safeLineCenter(faceLeftDisplayX, displayWidth)
      faceRightDisplayX = safeLineCenter(faceRightDisplayX, displayWidth)

      const noseBetweenEyes = noseDisplayX > Math.min(leftEyeDisplayCenter.x, rightEyeDisplayCenter.x)
        && noseDisplayX < Math.max(leftEyeDisplayCenter.x, rightEyeDisplayCenter.x)

      // 关键判断：Face++ 的 left_eye 按“观看者左侧”输出
      // 如果 leftEyeDisplayCenter.x < rightEyeDisplayCenter.x，说明方向正确
      // 如果相反，说明可能是镜像错误
      const eyeOrderCorrect = leftEyeDisplayCenter.x < rightEyeDisplayCenter.x

      let score = 0
      score += noseBetweenEyes ? 120 : -120
      score += invalidEyePosition ? -400 : 400
      score += faceRectValid ? 160 : -160
      score += faceRectScore
      // 眼睛顺序正确加分，错误扣分（这是区分镜像和非镜像的关键）
      score += eyeOrderCorrect ? 200 : -200
      const eyeCenterYScore = 1 - Math.abs(eyeYAvg / displayHeight - 0.38)
      score += eyeCenterYScore * 80
      const eyeDistanceScore = 1 - Math.abs(eyeDistanceDisplay / displayWidth - 0.42)
      score += eyeDistanceScore * 80

      return {
        score,
        valid: !invalidEyePosition && noseBetweenEyes && faceRectValid,
        orientation: { base, mirrored },
        leftEyeBox,
        rightEyeBox,
        leftEyeDisplayCenter,
        rightEyeDisplayCenter,
        noseDisplayX,
        faceLeftDisplayX,
        faceRightDisplayX,
        leftEyeX,
        leftEyeY,
        rightEyeX,
        rightEyeY,
        noseX,
        transform
      }
    }

    let best = null
    const candidateResults = []
    candidates.forEach((candidate) => {
      const result = computeCandidate(candidate.base, candidate.mirrored)
      candidateResults.push({
        label: candidate.label,
        base: candidate.base,
        mirrored: candidate.mirrored,
        score: result.score,
        valid: result.valid
      })
      if (!best || result.score > best.score) {
        best = result
      }
    })
    console.log('[Face++] 候选方向评分:', candidateResults.map(c => `${c.label}:${c.score.toFixed(0)}(${c.valid ? '有效' : '无效'})`).join(', '))

    if (!best || !best.valid) {
      this.applyFaceRectFallback(displayWidth, displayHeight, this.imageInfo.path, faceRect, '自动对位偏移，请手动微调瞳孔点')
      return
    }

    console.log('[Face++] 选用方向:', best.orientation, '得分:', best.score.toFixed(1))
    console.log('[Face++] Face++坐标 - left_eye:', best.leftEyeX.toFixed(1), best.leftEyeY.toFixed(1), 'right_eye:', best.rightEyeX.toFixed(1), best.rightEyeY.toFixed(1), '鼻梁:', best.noseX.toFixed(1))
    console.log('[Face++] 显示坐标 - left_eye:', best.leftEyeDisplayCenter.x.toFixed(1), best.leftEyeDisplayCenter.y.toFixed(1), 'right_eye:', best.rightEyeDisplayCenter.x.toFixed(1), best.rightEyeDisplayCenter.y.toFixed(1))

    // UI 中：蓝色点（leftEye）应该在屏幕左边，红色点（rightEye）应该在屏幕右边
    // 根据实际显示坐标来决定，而不是 Face++ 的标签
    let screenLeftEye, screenRightEye
    if (best.leftEyeDisplayCenter.x < best.rightEyeDisplayCenter.x) {
      // Face++ 的 left_eye 在屏幕左边
      screenLeftEye = best.leftEyeDisplayCenter
      screenRightEye = best.rightEyeDisplayCenter
    } else {
      // Face++ 的 left_eye 在屏幕右边，需要交换
      screenLeftEye = best.rightEyeDisplayCenter
      screenRightEye = best.leftEyeDisplayCenter
    }
    console.log('[Face++] 屏幕坐标 - 蓝点(左):', screenLeftEye.x.toFixed(1), screenLeftEye.y.toFixed(1), '红点(右):', screenRightEye.x.toFixed(1), screenRightEye.y.toFixed(1))

    let leftEye = this.makePoint(screenLeftEye.x, screenLeftEye.y)
    let rightEye = this.makePoint(screenRightEye.x, screenRightEye.y)
    console.log('[Face++] movable-view 坐标(原始) - leftEye:', leftEye, 'rightEye:', rightEye)

    console.log('[Face++] movable-view 坐标(确认) - leftEye:', leftEye, 'rightEye:', rightEye)
    const centerX = this.makeLineX(best.noseDisplayX)

    const faceLeftXLine = this.makeLineX(best.faceLeftDisplayX)
    const faceRightXLine = this.makeLineX(best.faceRightDisplayX)

    const cardLeftX = this.makeLineX(safeLineCenter(displayWidth * 0.15, displayWidth))
    const cardRightX = this.makeLineX(safeLineCenter(displayWidth * 0.85, displayWidth))

    // 计算人脸框的显示坐标（用于调试）
    let debugFaceRect = null
    if (faceRect && isNumber(faceRect.left) && isNumber(faceRect.top)) {
      const transform = best.transform
      debugFaceRect = {
        left: faceRect.left * transform.scale - transform.offsetX,
        top: faceRect.top * transform.scale - transform.offsetY,
        width: faceRect.width * transform.scale,
        height: faceRect.height * transform.scale
      }
      console.log('[Face++] 调试人脸框:', debugFaceRect)
    }

    const useMediaPipe = this.data.mediaPipeEnabled
      && config.mediaPipe
      && config.mediaPipe.enabled

    this.setData({
      stage: 'adjust',
      step: 0,
      photoPath: this.imageInfo.path,
      displayWidth,
      displayHeight,
      leftEye,
      rightEye,
      centerX,
      faceLeftX: faceLeftXLine,
      faceRightX: faceRightXLine,
      cardLeftX,
      cardRightX,
      debugFaceRect,
      autoFaceReady: !useMediaPipe
    })
    this.resetDragCache()
    console.log('[Face++] 人脸识别成功，autoFaceReady=', !useMediaPipe)
    this.tryApplyCardAuto()
    if (useMediaPipe) {
      this.tryApplyMediaPipeIris(best, displayWidth, displayHeight)
    } else {
      this.autoMeasureIfReady()
      this.refinePupilCenters(best, displayWidth, displayHeight)
    }
  },

  loadMediaPipeModelBuffer() {
    if (this.mediaPipeModelBuffer) {
      return Promise.resolve(this.mediaPipeModelBuffer)
    }
    const mpConfig = config.mediaPipe || {}
    const modelPath = mpConfig.modelPath || 'assets/models/mediapipe/face_landmarker.task'
    return new Promise((resolve) => {
      const fs = wx.getFileSystemManager()
      const userPath = `${wx.env.USER_DATA_PATH}/face_landmarker.task`
      const modelUrl = mpConfig.modelUrl
      const readFrom = (filePath, onFail) => {
        fs.readFile({
          filePath,
          success: (res) => {
            this.mediaPipeModelBuffer = res.data
            resolve(res.data)
          },
          fail: (err) => {
            if (onFail) {
              onFail(err)
            } else {
              console.warn('[MP] 模型读取失败:', filePath, err)
              resolve(null)
            }
          }
        })
      }
      readFrom(userPath, () => {
        if (!modelUrl) {
          console.warn('[MP] 模型读取失败: userPath 无法读取且未配置 modelUrl')
          resolve(null)
          return
        }
        wx.downloadFile({
          url: modelUrl,
          success: (res) => {
            fs.saveFile({
              tempFilePath: res.tempFilePath,
              filePath: userPath,
              success: () => readFrom(userPath),
              fail: (err) => {
                console.warn('[MP] 模型保存失败:', err)
                resolve(null)
              }
            })
          },
          fail: (err) => {
            console.warn('[MP] 模型下载失败:', err)
            resolve(null)
          }
        })
      })
    })
  },

  ensurePupilCanvasReady(callback) {
    if (this.pupilCanvasReady) {
      callback(true)
      return
    }
    if (!this.imageInfo || !this.imageInfo.path) {
      callback(false)
      return
    }
    const canvasWidth = this.data.pupilCanvasWidth
    const canvasHeight = this.data.pupilCanvasHeight
    if (!canvasWidth || !canvasHeight) {
      callback(false)
      return
    }
    const ctx = wx.createCanvasContext('pupilCanvas', this)
    ctx.drawImage(this.imageInfo.path, 0, 0, canvasWidth, canvasHeight)
    ctx.draw(false, () => {
      this.pupilCanvasReady = true
      callback(true)
    })
  },

  getFullImageData() {
    return new Promise((resolve) => {
      this.ensurePupilCanvasReady((ready) => {
        if (!ready) {
          resolve(null)
          return
        }
        const canvasWidth = this.data.pupilCanvasWidth
        const canvasHeight = this.data.pupilCanvasHeight
        wx.canvasGetImageData({
          canvasId: 'pupilCanvas',
          x: 0,
          y: 0,
          width: canvasWidth,
          height: canvasHeight,
          success: (res) => resolve(res),
          fail: (err) => {
            console.warn('[MP] 读取画布失败:', err)
            resolve(null)
          }
        })
      })
    })
  },

  async tryApplyMediaPipeIris(best, displayWidth, displayHeight) {
    if (this.mediaPipeRunning) return
    if (!best || !displayWidth || !displayHeight) {
      this.setData({ autoFaceReady: true })
      this.autoMeasureIfReady()
      return
    }
    if (typeof document === 'undefined') {
      console.warn('[MP] 当前环境无 DOM，跳过 MediaPipe')
      this.setData({ autoFaceReady: true })
      this.autoMeasureIfReady()
      return
    }
    const mpConfig = config.mediaPipe || {}
    const modelPath = mpConfig.modelPath || 'assets/models/mediapipe/face_landmarker.task'
    const wasmPath = mpConfig.wasmPath || 'assets/models/mediapipe/wasm'
    console.log('[MP] tryApplyMediaPipeIris', {
      modelPath,
      wasmPath
    })
    this.mediaPipeRunning = true

    const finishFallback = (reason) => {
      console.warn('[MP] 回退到本地细化:', reason)
      this.mediaPipeRunning = false
      this.setData({ autoFaceReady: true })
      this.refinePupilCenters(best, displayWidth, displayHeight)
      this.autoMeasureIfReady()
    }

    const modelBuffer = await this.loadMediaPipeModelBuffer()
    const imageData = await this.getFullImageData()
    if (!imageData) {
      finishFallback('无法获取图像数据')
      return
    }
    const centers = await detectIris({
      modelPath,
      modelBuffer,
      wasmPath,
      imageData,
      width: imageData.width,
      height: imageData.height
    })
    if (!centers || !centers.left || !centers.right) {
      finishFallback('未检测到瞳孔')
      return
    }
    const leftMapped = mapPointByOrientation(
      centers.left,
      this.imageInfo.width,
      this.imageInfo.height,
      best.orientation.base,
      best.orientation.mirrored
    )
    const rightMapped = mapPointByOrientation(
      centers.right,
      this.imageInfo.width,
      this.imageInfo.height,
      best.orientation.base,
      best.orientation.mirrored
    )
    if (!leftMapped || !rightMapped) {
      finishFallback('坐标映射失败')
      return
    }
    const leftDisplay = safePointCenter(
      leftMapped.x * best.transform.scale - best.transform.offsetX,
      leftMapped.y * best.transform.scale - best.transform.offsetY,
      displayWidth,
      displayHeight
    )
    const rightDisplay = safePointCenter(
      rightMapped.x * best.transform.scale - best.transform.offsetX,
      rightMapped.y * best.transform.scale - best.transform.offsetY,
      displayWidth,
      displayHeight
    )
    let screenLeftEye = leftDisplay
    let screenRightEye = rightDisplay
    if (screenLeftEye.x > screenRightEye.x) {
      screenLeftEye = rightDisplay
      screenRightEye = leftDisplay
    }
    const leftEye = this.makePoint(screenLeftEye.x, screenLeftEye.y)
    const rightEye = this.makePoint(screenRightEye.x, screenRightEye.y)
    this.setData({
      leftEye,
      rightEye,
      autoFaceReady: true
    })
    this.resetDragCache()
    this.mediaPipeRunning = false
    console.log('[MP] Iris 对齐完成')
    this.autoMeasureIfReady()
  },

  refinePupilCenters(best, displayWidth, displayHeight) {
    if (!this.data.pupilRefineEnabled) return
    if (this.pupilRefineRunning) return
    if (!best || !best.leftEyeBox || !best.rightEyeBox) return
    if (!this.imageInfo || !this.imageInfo.path) return
    if (!this.data.pupilCanvasWidth || !this.data.pupilCanvasHeight) return
    if (best.orientation.base !== 'up' || best.orientation.mirrored) return

    this.pupilRefineRunning = true
    const canvasId = 'pupilCanvas'
    const canvasWidth = this.data.pupilCanvasWidth
    const canvasHeight = this.data.pupilCanvasHeight
    this.ensurePupilCanvasReady((ready) => {
      if (!ready) {
        this.pupilRefineRunning = false
        return
      }
      this.refineEyeBox(canvasId, canvasWidth, canvasHeight, best.leftEyeBox, (leftRefined) => {
        this.refineEyeBox(canvasId, canvasWidth, canvasHeight, best.rightEyeBox, (rightRefined) => {
          this.pupilRefineRunning = false
          if (!leftRefined && !rightRefined) return
          let leftDisplay = best.leftEyeDisplayCenter
          let rightDisplay = best.rightEyeDisplayCenter
          if (leftRefined) {
            leftDisplay = safePointCenter(
              leftRefined.x * best.transform.scale - best.transform.offsetX,
              leftRefined.y * best.transform.scale - best.transform.offsetY,
              displayWidth,
              displayHeight
            )
          }
          if (rightRefined) {
            rightDisplay = safePointCenter(
              rightRefined.x * best.transform.scale - best.transform.offsetX,
              rightRefined.y * best.transform.scale - best.transform.offsetY,
              displayWidth,
              displayHeight
            )
          }
          let screenLeftEye = leftDisplay
          let screenRightEye = rightDisplay
          if (screenLeftEye.x > screenRightEye.x) {
            screenLeftEye = rightDisplay
            screenRightEye = leftDisplay
          }
          const leftEye = this.makePoint(screenLeftEye.x, screenLeftEye.y)
          const rightEye = this.makePoint(screenRightEye.x, screenRightEye.y)
          this.setData({ leftEye, rightEye })
          console.log('[Face++] 细化瞳孔完成，更新点位')
        })
      })
    })
  },

  refineEyeBox(canvasId, canvasWidth, canvasHeight, box, callback) {
    if (!box || !isNumber(box.left) || !isNumber(box.top)) {
      callback(null)
      return
    }
    const expand = 0.25
    const extraW = box.width * expand
    const extraH = box.height * expand
    let x = Math.max(0, Math.floor(box.left - extraW / 2))
    let y = Math.max(0, Math.floor(box.top - extraH / 2))
    let width = Math.floor(box.width + extraW)
    let height = Math.floor(box.height + extraH)
    if (x + width > canvasWidth) width = canvasWidth - x
    if (y + height > canvasHeight) height = canvasHeight - y
    if (width <= 4 || height <= 4) {
      callback(null)
      return
    }
    wx.canvasGetImageData({
      canvasId,
      x,
      y,
      width,
      height,
      success: (res) => {
        const center = this.findDarkCenter(res)
        if (!center) {
          callback(null)
          return
        }
        callback({
          x: x + center.x,
          y: y + center.y
        })
      },
      fail: () => callback(null)
    })
  },

  findDarkCenter(imageData) {
    const { data, width, height } = imageData
    if (!data || !width || !height) return null
    const total = width * height
    if (total < 20) return null
    let min = 255
    let max = 0
    const luma = new Uint8Array(total)
    for (let i = 0; i < total; i += 1) {
      const idx = i * 4
      const r = data[idx]
      const g = data[idx + 1]
      const b = data[idx + 2]
      const value = (r * 3 + g * 4 + b) >> 3
      luma[i] = value
      if (value < min) min = value
      if (value > max) max = value
    }
    if (max - min < 12) {
      return { x: width / 2, y: height / 2 }
    }
    const threshold = min + (max - min) * 0.25
    const yStart = Math.floor(height * 0.15)
    const yEnd = Math.floor(height * 0.9)
    let sumX = 0
    let sumY = 0
    let count = 0
    for (let y = yStart; y < yEnd; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = y * width + x
        if (luma[idx] <= threshold) {
          sumX += x
          sumY += y
          count += 1
        }
      }
    }
    if (count < total * 0.01) {
      return null
    }
    return {
      x: sumX / count,
      y: sumY / count
    }
  },

  // 使用默认位置（AI 识别失败时）
  applyDefaultPoints(displayWidth, displayHeight, imagePath) {
    console.log('[Auto] 使用默认位置，autoFaceReady 保持 false')
    const leftEyeCenter = safePointCenter(
      displayWidth * 0.35,
      displayHeight * 0.4,
      displayWidth,
      displayHeight
    )
    const rightEyeCenter = safePointCenter(
      displayWidth * 0.65,
      displayHeight * 0.4,
      displayWidth,
      displayHeight
    )

    const leftEye = this.makePoint(leftEyeCenter.x, leftEyeCenter.y)
    const rightEye = this.makePoint(rightEyeCenter.x, rightEyeCenter.y)
    const centerX = this.makeLineX(safeLineCenter(displayWidth * 0.5, displayWidth))

    // 脸部边缘默认位置
    const faceLeftX = this.makeLineX(safeLineCenter(displayWidth * 0.1, displayWidth))
    const faceRightX = this.makeLineX(safeLineCenter(displayWidth * 0.9, displayWidth))

    // 银行卡
    const cardLeftX = this.makeLineX(safeLineCenter(displayWidth * 0.15, displayWidth))
    const cardRightX = this.makeLineX(safeLineCenter(displayWidth * 0.85, displayWidth))

    this.setData({
      stage: 'adjust',
      step: 0,
      photoPath: imagePath,
      displayWidth,
      displayHeight,
      leftEye,
      rightEye,
      centerX,
      faceLeftX,
      faceRightX,
      cardLeftX,
      cardRightX
    })
    this.resetDragCache()
    this.setData({ autoFaceReady: false })
    this.tryApplyCardAuto()
  },

  applyFaceRectFallback(displayWidth, displayHeight, imagePath, faceRect, toastTitle) {
    if (!faceRect
      || !isNumber(faceRect.left)
      || !isNumber(faceRect.top)
      || !isNumber(faceRect.width)
      || !isNumber(faceRect.height)) {
      this.applyDefaultPoints(displayWidth, displayHeight, imagePath)
      if (toastTitle) {
        wx.showToast({
          title: toastTitle,
          icon: 'none',
          duration: 2000
        })
      }
      return
    }

    const { base, mirrored } = normalizeOrientation(this.imageInfo && this.imageInfo.orientation)
    const orientedSize = getOrientedSize(this.imageInfo.width, this.imageInfo.height, base)
    const mappedRect = mapRectByOrientation(
      faceRect,
      this.imageInfo.width,
      this.imageInfo.height,
      base,
      mirrored
    )
    const faceLeft = mappedRect.left
    const faceTop = mappedRect.top
    const faceWidth = mappedRect.width
    const faceHeight = mappedRect.height

    const leftEyeX = faceLeft + faceWidth * 0.35
    const rightEyeX = faceLeft + faceWidth * 0.65
    const eyeY = faceTop + faceHeight * 0.38
    const noseX = faceLeft + faceWidth * 0.5
    const faceLeftX = faceLeft + faceWidth * 0.06
    const faceRightX = faceLeft + faceWidth * 0.94

    const transform = this.calcAspectFitTransform(
      orientedSize.width,
      orientedSize.height,
      displayWidth,
      displayHeight
    )

    const leftEyeCenter = safePointCenter(
      leftEyeX * transform.scale - transform.offsetX,
      eyeY * transform.scale - transform.offsetY,
      displayWidth,
      displayHeight
    )
    const rightEyeCenter = safePointCenter(
      rightEyeX * transform.scale - transform.offsetX,
      eyeY * transform.scale - transform.offsetY,
      displayWidth,
      displayHeight
    )
    const noseDisplayX = safeLineCenter(
      noseX * transform.scale - transform.offsetX,
      displayWidth
    )

    let faceLeftDisplayX = faceLeftX * transform.scale - transform.offsetX
    let faceRightDisplayX = faceRightX * transform.scale - transform.offsetX
    faceLeftDisplayX = safeLineCenter(faceLeftDisplayX, displayWidth)
    faceRightDisplayX = safeLineCenter(faceRightDisplayX, displayWidth)

    const leftEye = this.makePoint(leftEyeCenter.x, leftEyeCenter.y)
    const rightEye = this.makePoint(rightEyeCenter.x, rightEyeCenter.y)
    const centerX = this.makeLineX(noseDisplayX)
    const faceLeftXLine = this.makeLineX(faceLeftDisplayX)
    const faceRightXLine = this.makeLineX(faceRightDisplayX)
    const cardLeftX = this.makeLineX(safeLineCenter(displayWidth * 0.15, displayWidth))
    const cardRightX = this.makeLineX(safeLineCenter(displayWidth * 0.85, displayWidth))

    this.setData({
      stage: 'adjust',
      step: 0,
      photoPath: imagePath,
      displayWidth,
      displayHeight,
      leftEye,
      rightEye,
      centerX,
      faceLeftX: faceLeftXLine,
      faceRightX: faceRightXLine,
      cardLeftX,
      cardRightX
    })
    this.resetDragCache()
    this.setData({ autoFaceReady: true })
    this.tryApplyCardAuto()
    this.autoMeasureIfReady()

    if (toastTitle) {
      wx.showToast({
        title: toastTitle,
        icon: 'none',
        duration: 2000
      })
    }
  },

  makePoint(x, y) {
    return {
      x: x - POINT_CENTER_OFFSET_X,
      y: y - POINT_CENTER_OFFSET_Y
    }
  },

  makeLineX(x) {
    return x - LINE_CONTAINER / 2
  },

  resetDragCache() {
    this.dragCache = {
      leftEye: null,
      rightEye: null,
      centerX: null,
      faceLeftX: null,
      faceRightX: null,
      cardLeftX: null,
      cardRightX: null
    }
  },

  ensureDragCache() {
    if (!this.dragCache) {
      this.resetDragCache()
    }
  },

  getEffectivePositions() {
    const cache = this.dragCache || {}
    return {
      leftEye: cache.leftEye || this.data.leftEye,
      rightEye: cache.rightEye || this.data.rightEye,
      centerX: isNumber(cache.centerX) ? cache.centerX : this.data.centerX,
      faceLeftX: isNumber(cache.faceLeftX) ? cache.faceLeftX : this.data.faceLeftX,
      faceRightX: isNumber(cache.faceRightX) ? cache.faceRightX : this.data.faceRightX,
      cardLeftX: isNumber(cache.cardLeftX) ? cache.cardLeftX : this.data.cardLeftX,
      cardRightX: isNumber(cache.cardRightX) ? cache.cardRightX : this.data.cardRightX
    }
  },

  syncDragCache() {
    const positions = this.getEffectivePositions()
    this.resetDragCache()
    return {
      leftEye: positions.leftEye,
      rightEye: positions.rightEye,
      centerX: positions.centerX,
      faceLeftX: positions.faceLeftX,
      faceRightX: positions.faceRightX,
      cardLeftX: positions.cardLeftX,
      cardRightX: positions.cardRightX
    }
  },

  onLeftEyeMove(e) {
    if (e.detail.source !== 'touch') return
    this.ensureDragCache()
    this.dragCache.leftEye = { x: e.detail.x, y: e.detail.y }
    if (this.data.autoMeasureEnabled) {
      this.setData({ autoMeasureEnabled: false })
    }
  },

  onRightEyeMove(e) {
    if (e.detail.source !== 'touch') return
    this.ensureDragCache()
    this.dragCache.rightEye = { x: e.detail.x, y: e.detail.y }
    if (this.data.autoMeasureEnabled) {
      this.setData({ autoMeasureEnabled: false })
    }
  },

  onCenterMove(e) {
    if (e.detail.source !== 'touch') return
    this.ensureDragCache()
    this.dragCache.centerX = e.detail.x
    if (this.data.autoMeasureEnabled) {
      this.setData({ autoMeasureEnabled: false })
    }
  },

  onFaceLeftMove(e) {
    if (e.detail.source !== 'touch') return
    this.ensureDragCache()
    this.dragCache.faceLeftX = e.detail.x
    if (this.data.autoMeasureEnabled) {
      this.setData({ autoMeasureEnabled: false })
    }
  },

  onFaceRightMove(e) {
    if (e.detail.source !== 'touch') return
    this.ensureDragCache()
    this.dragCache.faceRightX = e.detail.x
    if (this.data.autoMeasureEnabled) {
      this.setData({ autoMeasureEnabled: false })
    }
  },

  onCardLeftMove(e) {
    if (e.detail.source !== 'touch') return
    this.ensureDragCache()
    this.dragCache.cardLeftX = e.detail.x
    this.cardAutoDisabled = true
    if (this.data.autoMeasureEnabled) {
      this.setData({ autoMeasureEnabled: false })
    }
  },

  onCardRightMove(e) {
    if (e.detail.source !== 'touch') return
    this.ensureDragCache()
    this.dragCache.cardRightX = e.detail.x
    this.cardAutoDisabled = true
    if (this.data.autoMeasureEnabled) {
      this.setData({ autoMeasureEnabled: false })
    }
  },

  prevStep() {
    const nextStep = Math.max(this.data.step - 1, 0)
    const dragData = this.syncDragCache()
    const nextData = { ...dragData, step: nextStep }
    if (nextStep === 2) {
      nextData.skipFaceWidth = false
    }
    this.setData(nextData)
  },

  nextStep() {
    if (this.data.step < this.data.totalSteps - 1) {
      const dragData = this.syncDragCache()
      const nextData = { ...dragData, step: this.data.step + 1 }
      if (this.data.step === 2) {
        nextData.skipFaceWidth = false
      }
      this.setData(nextData)
      return
    }
    this.calculateResult()
  },

  skipFaceWidth() {
    const dragData = this.syncDragCache()
    this.setData({
      ...dragData,
      skipFaceWidth: true,
      step: 3
    })
  },

  onCardTypeChange(e) {
    const selectedCard = e.detail.value
    const option = this.data.cardOptions.find((item) => item.value === selectedCard)
    const nextData = { selectedCard }
    if (option && isNumber(option.width)) {
      nextData.cardWidthMm = option.width
    }
    this.setData(nextData)
  },

  calculateResult() {
    const positions = this.getEffectivePositions()
    // 获取各标记点的中心坐标
    const firstEye = this.getPointCenter(positions.leftEye)
    const secondEye = this.getPointCenter(positions.rightEye)
    const left = firstEye.x <= secondEye.x ? firstEye : secondEye
    const right = firstEye.x <= secondEye.x ? secondEye : firstEye
    const centerLineX = positions.centerX + LINE_CONTAINER / 2

    // 脸部边缘
    const faceLeft = positions.faceLeftX + LINE_CONTAINER / 2
    const faceRight = positions.faceRightX + LINE_CONTAINER / 2

    // 银行卡
    const cardLeft = positions.cardLeftX + LINE_CONTAINER / 2
    const cardRight = positions.cardRightX + LINE_CONTAINER / 2
    const cardDistance = Math.abs(cardRight - cardLeft)
    const eyeDistance = Math.abs(right.x - left.x)
    const eyeYDiff = Math.abs(right.y - left.y)
    const eyeToCard = eyeDistance / cardDistance
    const cardRatio = cardDistance / this.data.displayWidth

    const cardWidthMm = parseFloat(this.data.cardWidthMm)

    if (cardDistance < 10 || eyeDistance < 10) {
      wx.showToast({
        title: '对齐点过近，请重新校准',
        icon: 'none'
      })
      return
    }

    if (!Number.isFinite(eyeToCard)) {
      wx.showToast({
        title: '卡片对齐异常，请重新对准卡片左右边缘',
        icon: 'none'
      })
      this.setData({ step: 3 })
      return
    }
    if (cardRatio < 0.12) {
      wx.showToast({
        title: '卡片在画面中过小，请靠近镜头',
        icon: 'none'
      })
      this.setData({ step: 3 })
      return
    }
    if (eyeYDiff > eyeDistance * MAX_EYE_LEVEL_RATIO) {
      wx.showModal({
        title: '双眼未水平',
        content: '请保持头部水平、手机不要倾斜，双眼中心应在同一水平线上。当前照片会明显影响瞳距精度。',
        confirmText: '重新拍摄',
        cancelText: '手动微调',
        success: (res) => {
          if (res.confirm) {
            this.retake()
            return
          }
          this.setData({ step: 0, autoMeasureEnabled: false })
        }
      })
      return
    }
    const minEyeX = Math.min(left.x, right.x)
    const maxEyeX = Math.max(left.x, right.x)
    if (centerLineX <= minEyeX || centerLineX >= maxEyeX) {
      wx.showToast({
        title: '鼻梁中线需位于双眼之间',
        icon: 'none'
      })
      this.setData({ step: 1 })
      return
    }

    // 计算比例尺：像素 -> 毫米
    const scale = cardWidthMm / cardDistance

    // 瞳距计算
    const leftPd = roundToHalf(Math.abs(centerLineX - left.x) * scale)
    const rightPd = roundToHalf(Math.abs(right.x - centerLineX) * scale)
    const totalPd = roundToHalf(eyeDistance * scale)
    const pdOutOfRange = totalPd < 50 || totalPd > 80

    // 脸宽计算
    let faceWidth = null
    if (!this.data.skipFaceWidth) {
      faceWidth = roundToHalf(Math.abs(faceRight - faceLeft) * scale)
    }

    const confidenceInfo = this.getConfidence(cardDistance, eyeDistance)
    const confidence = confidenceInfo.level

    const result = {
      // 瞳距
      totalPd,
      leftPd,
      rightPd,
      // 脸宽
      faceWidth,
      // 元信息
      cardWidthMm,
      cardType: this.data.selectedCard,
      confidence,
      timestamp: Date.now()
    }

    if (pdOutOfRange) {
      const autoMode = this.data.autoMeasureEnabled
      wx.showModal({
        title: '瞳距异常',
        content: '当前结果偏离常见范围，请检查卡片是否与屏幕平行、左右边缘是否对齐完整。',
        confirmText: '重新拍摄',
        cancelText: autoMode ? '手动微调' : '继续',
        success: (res) => {
          if (res.confirm) {
            this.retake()
            return
          }
          if (autoMode) {
            this.setData({ step: 3, autoMeasureEnabled: false })
            return
          }
          this.saveResultAndGo(result)
        }
      })
      return
    }

    if (confidenceInfo.showModal) {
      const autoMode = this.data.autoMeasureEnabled
      wx.showModal({
        title: '可信度较低',
        content: '建议重新拍摄：正脸居中、光线充足、卡片完整且尽量平行镜头。',
        confirmText: '重新拍摄',
        cancelText: autoMode ? '手动微调' : '继续',
        success: (res) => {
          if (res.confirm) {
            this.retake()
            return
          }
          if (autoMode) {
            this.setData({ step: 0, autoMeasureEnabled: false })
            return
          }
          this.saveResultAndGo(result)
        }
      })
      return
    }

    this.saveResultAndGo(result)
  },

  saveResultAndGo(result) {
    const canFree = userUtil.canMeasureFree()
    const isUnlimited = userUtil.isUnlimited()

    if (!canFree && !isUnlimited) {
      userUtil.addTrialResult(result)
      const count = userUtil.getTrialResults().length
      if (count < 3) {
        wx.showModal({
          title: `已完成 ${count}/3`,
          content: `请继续第 ${count + 1} 次测量，以获取中位数结果。`,
          confirmText: '继续测量',
          showCancel: false,
          success: () => {
            wx.redirectTo({
              url: '/pages/measure/measure'
            })
          }
        })
        return
      }
      wx.setStorageSync('latestResult', result)
      wx.navigateTo({
        url: '/pages/result/result?trial=1'
      })
      return
    }

    wx.setStorageSync('latestResult', result)
    wx.navigateTo({
      url: '/pages/result/result'
    })
  },

  getPointCenter(point) {
    return {
      x: point.x + POINT_CENTER_OFFSET_X,
      y: point.y + POINT_CENTER_OFFSET_Y
    }
  },

  getConfidence(cardDistance, eyeDistance) {
    const cardRatio = cardDistance / this.data.displayWidth
    const eyeToCard = eyeDistance / cardDistance

    const veryLow = cardRatio < 0.12 || eyeToCard < 0.45 || eyeToCard > 1.05
    if (veryLow) {
      return { level: '低', showModal: true }
    }

    if (cardRatio < 0.2 || eyeToCard < 0.5 || eyeToCard > 0.95) {
      return { level: '低', showModal: false }
    }

    if (cardRatio >= 0.24 && cardRatio <= 0.6 && eyeToCard >= 0.6 && eyeToCard <= 0.9) {
      return { level: '高', showModal: false }
    }

    return { level: '中', showModal: false }
  },

  retake() {
    this.setData({
      stage: 'capture',
      step: 0,
      photoPath: '',
      skipFaceWidth: false,
      autoMeasureEnabled: true,
      autoFaceReady: false,
      autoMeasureDone: false
    })
    this.resetDragCache()
    this.cardAutoResult = null
    this.cardAutoApplied = false
    this.cardAutoDisabled = false
    this.cardAutoFailed = false
    this.pupilCanvasReady = false
    this.mediaPipeRunning = false
  },

  getCloudAutoQualityIssue(data) {
    const validation = (data && data.validation) || null
    const quality = (data && data.quality) || null
    if (!validation && !quality) {
      return '自动识别未返回质量校验数据，请手动确认瞳孔、鼻梁和卡片边缘后再出结果。'
    }

    const issues = []
    const score = quality ? toNumber(quality.score) : null
    const irisConfidence = toNumber(
      (quality && quality.iris_confidence)
      || (data && data.iris && data.iris.confidence)
    )
    const cardConfidence = toNumber(
      (quality && quality.card_confidence)
      || (data && data.card && data.card.confidence)
    )

    if (validation && validation.overall_valid === false) {
      if (validation.eyes_level === false) issues.push('双眼不够水平')
      if (validation.face_frontal === false) issues.push('人脸不够正')
      if (validation.card_parallel === false) issues.push('卡片透视变形明显')
      if (validation.card_horizontal === false) issues.push('卡片未横放')
      if (validation.card_near_eyes === false) issues.push('卡片离眼睛平面过远')
      if (validation.pd_symmetry === false) issues.push('左右单眼瞳距差异过大')
      if (validation.pd_in_range === false) issues.push('瞳距超出常见范围')
      if (!issues.length) issues.push('质量校验未通过')
    }

    if (score !== null && score < MIN_AUTO_QUALITY_SCORE) {
      issues.push(`质量分偏低(${Math.round(score * 100)}%)`)
    }
    if (irisConfidence !== null && irisConfidence < MIN_AUTO_IRIS_CONFIDENCE) {
      issues.push('瞳孔定位置信度偏低')
    }
    if (cardConfidence !== null && cardConfidence < MIN_AUTO_CARD_CONFIDENCE) {
      issues.push('卡片边缘识别置信度偏低')
    }

    if (!issues.length) return null
    const suggestion = quality && quality.suggestion
      ? `。${quality.suggestion}`
      : '。建议手动确认点位，或重新拍摄：正脸、双眼水平、卡片横放在眉毛上方并尽量贴近眼睛所在平面。'
    return `${issues.slice(0, 3).join('、')}${suggestion}`
  },

  // 处理云端直接返回的瞳距结果（拍照即出结果）
  applyCloudPdResult(data) {
    const pd = data.pd
    const totalPd = roundToHalf(pd.total)
    const leftPd = isNumber(pd.left) ? roundToHalf(pd.left) : null
    const rightPd = isNumber(pd.right) ? roundToHalf(pd.right) : null
    const qualityIssue = this.getCloudAutoQualityIssue(data)

    // 验证瞳距是否在合理范围内（50-80mm）
    if (totalPd < 50 || totalPd > 80) {
      console.warn('[CloudAuto] 瞳距异常:', totalPd)
      wx.showModal({
        title: '瞳距异常',
        content: `检测到瞳距 ${totalPd}mm，超出正常范围(50-80mm)。可能是卡片识别有误，是否手动调整？`,
        confirmText: '手动调整',
        cancelText: '重新拍摄',
        success: (res) => {
          if (res.confirm) {
            // 进入手动调整流程
            this.setData({ autoMeasureEnabled: false })
            this.applyServerResultForManual(data)
          } else {
            this.retake()
          }
        }
      })
      return
    }

    if (qualityIssue) {
      wx.showModal({
        title: '需要手动确认',
        content: qualityIssue,
        confirmText: '手动微调',
        cancelText: '重新拍摄',
        success: (res) => {
          if (res.confirm) {
            this.setData({ autoMeasureEnabled: false })
            this.applyServerResultForManual(data)
          } else {
            this.retake()
          }
        }
      })
      return
    }

    // 计算可信度
    let confidence = '高'
    const qualityScore = data.quality ? toNumber(data.quality.score) : null
    if (qualityScore !== null) {
      confidence = qualityScore >= 0.85 ? '高' : (qualityScore >= MIN_AUTO_QUALITY_SCORE ? '中' : '低')
    } else if (data.card && isNumber(data.card.confidence)) {
      confidence = data.card.confidence > 0.8 ? '高' : (data.card.confidence > 0.5 ? '中' : '低')
    }

    const result = {
      totalPd,
      leftPd: isNumber(leftPd) ? leftPd : roundToHalf(totalPd / 2),
      rightPd: isNumber(rightPd) ? rightPd : roundToHalf(totalPd / 2),
      faceWidth: data.face && isNumber(data.face.width) ? roundToHalf(data.face.width) : null,
      cardWidthMm: this.data.cardWidthMm,
      cardType: this.data.selectedCard,
      confidence,
      timestamp: Date.now(),
      source: 'cloud_auto'  // 标记来源
    }

    console.log('[CloudAuto] 直接输出结果:', result)
    this.saveResultAndGo(result)
  },

  // 云端返回了数据但需要手动调整时使用
  applyServerResultForManual(data) {
    const displayWidth = this.data.windowWidth
    const displayHeight = this.data.windowHeight
    this.applyServerResult(data, displayWidth, displayHeight)
  }
})
