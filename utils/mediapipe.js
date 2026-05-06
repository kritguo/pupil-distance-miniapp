let faceLandmarker = null
let initPromise = null
let lastConfigKey = null
const LOADER_VERSION = 'mp-loader-v3'
console.log('[MP] loader', LOADER_VERSION, 'loaded')

const loadTasksVision = () => {
  try {
    // eslint-disable-next-line global-require
    return require('./vision_bundle.js')
  } catch (err) {
    try {
      // eslint-disable-next-line global-require
      return require('@mediapipe/tasks-vision')
    } catch (innerErr) {
      console.warn('[MP] tasks-vision 本地路径加载失败:', err)
      console.warn('[MP] tasks-vision 未安装:', innerErr)
      return null
    }
  }
}

const buildImageData = (raw) => {
  if (!raw || !raw.data || !raw.width || !raw.height) return null
  if (typeof ImageData !== 'undefined') {
    const buffer = raw.data instanceof Uint8ClampedArray ? raw.data : new Uint8ClampedArray(raw.data)
    return new ImageData(buffer, raw.width, raw.height)
  }
  return raw
}

const buildIrisCenters = (landmarks, width, height) => {
  if (!landmarks || !landmarks.length) return null
  const irisGroups = [
    [468, 469, 470, 471, 472],
    [473, 474, 475, 476, 477]
  ]
  const centers = irisGroups.map((indexes) => {
    const points = indexes
      .map((index) => landmarks[index])
      .filter((point) => point)
    if (!points.length) return null
    const sum = points.reduce(
      (acc, point) => ({
        x: acc.x + point.x * width,
        y: acc.y + point.y * height
      }),
      { x: 0, y: 0 }
    )
    return {
      x: sum.x / points.length,
      y: sum.y / points.length
    }
  })
  if (!centers[0] || !centers[1]) return null
  const left = centers[0].x < centers[1].x ? centers[0] : centers[1]
  const right = centers[0].x < centers[1].x ? centers[1] : centers[0]
  return { left, right }
}

const normalizeModelBuffer = (buffer) => {
  if (!buffer) return null
  if (buffer instanceof Uint8Array) return buffer
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer)
  if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer)
  return null
}

const buildConfigKey = ({ modelPath, modelBuffer, wasmPath }) => {
  const bufferKey = modelBuffer ? 'buffer' : ''
  return `${modelPath || ''}|${bufferKey}|${wasmPath || ''}`
}

const initFaceLandmarker = async ({ modelPath, modelBuffer, wasmPath }) => {
  const configKey = buildConfigKey({ modelPath, modelBuffer, wasmPath })
  if (faceLandmarker && configKey === lastConfigKey) return faceLandmarker
  if (initPromise && configKey === lastConfigKey) return initPromise
  if (configKey !== lastConfigKey) {
    faceLandmarker = null
    initPromise = null
  }
  lastConfigKey = configKey
  if (faceLandmarker) return faceLandmarker
  if (initPromise) return initPromise
  initPromise = new Promise(async (resolve) => {
    const tasksVision = loadTasksVision()
    if (!tasksVision) {
      console.warn('[MP] loader', LOADER_VERSION, 'tasksVision missing')
      resolve(null)
      return
    }
    try {
      if (!wasmPath) {
        console.warn('[MP] wasmPath 为空')
        resolve(null)
        return
      }
      const vision = await tasksVision.FilesetResolver.forVisionTasks(wasmPath)
      const normalizedBuffer = normalizeModelBuffer(modelBuffer)
      const baseOptions = normalizedBuffer
        ? { modelAssetBuffer: normalizedBuffer, delegate: 'CPU' }
        : { modelAssetPath: modelPath, delegate: 'CPU' }
      faceLandmarker = await tasksVision.FaceLandmarker.createFromOptions(vision, {
        baseOptions,
        runningMode: 'IMAGE',
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
        numFaces: 1
      })
      resolve(faceLandmarker)
    } catch (err) {
      console.warn('[MP] 初始化失败:', err)
      resolve(null)
    }
  })
  return initPromise
}

const detectIris = async ({ modelPath, modelBuffer, wasmPath, imageData, width, height }) => {
  const landmarker = await initFaceLandmarker({ modelPath, modelBuffer, wasmPath })
  if (!landmarker) return null
  const input = buildImageData(imageData)
  if (!input) return null
  const result = landmarker.detect(input)
  if (!result || !result.faceLandmarks || !result.faceLandmarks.length) {
    return null
  }
  return buildIrisCenters(result.faceLandmarks[0], width, height)
}

module.exports = {
  detectIris
}
