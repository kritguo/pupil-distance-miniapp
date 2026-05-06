const jpeg = require('jpeg-js')
const { PNG } = require('pngjs')

const TARGET_RATIO = 85.6 / 53.98  // ≈ 1.586
const TARGET_RATIO_VERTICAL = 53.98 / 85.6  // ≈ 0.63 (竖向放置的卡片)

const decodeImage = (buffer) => {
  if (!buffer || buffer.length < 10) return null
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e
  if (isPng) {
    const png = PNG.sync.read(buffer)
    return { data: png.data, width: png.width, height: png.height }
  }
  const jpg = jpeg.decode(buffer, { useTArray: true })
  if (!jpg || !jpg.data) return null
  return { data: jpg.data, width: jpg.width, height: jpg.height }
}

const resizeRGBA = (src, srcW, srcH, dstW, dstH) => {
  const dst = new Uint8ClampedArray(dstW * dstH * 4)
  const xRatio = srcW / dstW
  const yRatio = srcH / dstH
  for (let y = 0; y < dstH; y += 1) {
    const srcY = Math.min(srcH - 1, Math.floor(y * yRatio))
    for (let x = 0; x < dstW; x += 1) {
      const srcX = Math.min(srcW - 1, Math.floor(x * xRatio))
      const srcIdx = (srcY * srcW + srcX) * 4
      const dstIdx = (y * dstW + x) * 4
      dst[dstIdx] = src[srcIdx]
      dst[dstIdx + 1] = src[srcIdx + 1]
      dst[dstIdx + 2] = src[srcIdx + 2]
      dst[dstIdx + 3] = src[srcIdx + 3]
    }
  }
  return dst
}

const buildGray = (rgba, width, height) => {
  const gray = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i += 1) {
    const idx = i * 4
    const r = rgba[idx]
    const g = rgba[idx + 1]
    const b = rgba[idx + 2]
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
  }
  return gray
}

const sobelEdges = (gray, width, height) => {
  const mag = new Uint16Array(width * height)
  let sum = 0
  let max = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x
      const tl = gray[idx - width - 1]
      const tc = gray[idx - width]
      const tr = gray[idx - width + 1]
      const ml = gray[idx - 1]
      const mr = gray[idx + 1]
      const bl = gray[idx + width - 1]
      const bc = gray[idx + width]
      const br = gray[idx + width + 1]
      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br
      const value = Math.abs(gx) + Math.abs(gy)
      mag[idx] = value
      sum += value
      if (value > max) max = value
    }
  }
  const avg = sum / (width * height)
  let threshold = Math.max(25, avg * 1.6)
  threshold = Math.min(threshold, max * 0.9)
  return { mag, threshold }
}

const dilateEdges = (edges, width, height) => {
  const out = new Uint8Array(edges.length)
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x
      if (edges[idx]) {
        out[idx] = 1
        continue
      }
      let hit = 0
      for (let dy = -1; dy <= 1 && !hit; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue
          const n = idx + dy * width + dx
          if (edges[n]) {
            hit = 1
            break
          }
        }
      }
      out[idx] = hit
    }
  }
  return out
}

const findCardBox = (edges, width, height) => {
  const visited = new Uint8Array(width * height)
  let best = null
  let bestScore = 0
  const minPixels = Math.max(40, Math.floor(width * height * 0.00015))

  const stack = []
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x
      if (!edges[idx] || visited[idx]) continue
      let minX = x
      let maxX = x
      let minY = y
      let maxY = y
      let count = 0
      stack.length = 0
      stack.push(idx)
      visited[idx] = 1
      while (stack.length) {
        const current = stack.pop()
        const cy = Math.floor(current / width)
        const cx = current - cy * width
        count += 1
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        const neighbors = [
          current - 1,
          current + 1,
          current - width,
          current + width
        ]
        for (let i = 0; i < neighbors.length; i += 1) {
          const n = neighbors[i]
          if (n < 0 || n >= edges.length) continue
          if (visited[n] || !edges[n]) continue
          visited[n] = 1
          stack.push(n)
        }
      }
      if (count < minPixels) continue
      const boxW = maxX - minX + 1
      const boxH = maxY - minY + 1
      const area = boxW * boxH
      const areaRatio = area / (width * height)
      if (areaRatio < 0.008 || areaRatio > 0.7) continue
      // 计算实际宽高比
      const actualRatio = boxW / boxH
      // 计算与目标比例的差距（考虑横向和竖向两种情况）
      const diffHorizontal = Math.abs(actualRatio - TARGET_RATIO) / TARGET_RATIO
      const diffVertical = Math.abs(actualRatio - TARGET_RATIO_VERTICAL) / TARGET_RATIO_VERTICAL
      const ratioDiff = Math.min(diffHorizontal, diffVertical)
      // 如果比例差距超过 60%，不太可能是卡片
      if (ratioDiff > 0.6) continue
      // 比例越接近目标，得分越高
      const ratioScore = 1 - ratioDiff
      const fill = count / area
      const score = area * ratioScore * ratioScore * Math.min(fill * 8, 1)  // ratioScore 加倍权重
      if (score > bestScore) {
        bestScore = score
        best = { minX, minY, maxX, maxY }
      }
    }
  }
  return best
}

exports.main = async (event) => {
  let payload = event
  if (typeof event === 'string') {
    try {
      payload = JSON.parse(event)
    } catch (err) {
      payload = {}
    }
  }
  const imageBase64 = payload && (payload.imageBase64 || (payload.data && payload.data.imageBase64))
  if (!imageBase64) {
    return { ok: false, message: 'missing_image' }
  }
  const base64 = imageBase64.includes(',')
    ? imageBase64.split(',', 2)[1]
    : imageBase64
  const buffer = Buffer.from(base64, 'base64')
  const decoded = decodeImage(buffer)
  if (!decoded) {
    return { ok: false, message: 'decode_failed' }
  }
  const originalWidth = decoded.width
  const originalHeight = decoded.height
  let { data, width, height } = decoded
  const maxDim = Math.max(width, height)
  let scale = 1
  if (maxDim > 720) {
    scale = 720 / maxDim
    const targetW = Math.round(width * scale)
    const targetH = Math.round(height * scale)
    data = resizeRGBA(data, width, height, targetW, targetH)
    width = targetW
    height = targetH
  }
  const gray = buildGray(data, width, height)
  const { mag, threshold } = sobelEdges(gray, width, height)
  const edges = new Uint8Array(width * height)
  for (let i = 0; i < mag.length; i += 1) {
    edges[i] = mag[i] >= threshold ? 1 : 0
  }
  const dilated = dilateEdges(edges, width, height)
  const box = findCardBox(dilated, width, height)
  if (!box) {
    console.log('[detectCard] 未找到符合条件的卡片区域')
    return { ok: false, message: 'card_not_found' }
  }
  // 计算识别到的矩形的宽高比，用于调试
  const boxW = box.maxX - box.minX
  const boxH = box.maxY - box.minY
  const detectedRatio = boxW / boxH
  console.log('[detectCard] 识别成功:', {
    boxW,
    boxH,
    ratio: detectedRatio.toFixed(3),
    targetH: TARGET_RATIO.toFixed(3),
    targetV: TARGET_RATIO_VERTICAL.toFixed(3)
  })
  const scaleBackX = originalWidth / width
  const scaleBackY = originalHeight / height
  const left = box.minX * scaleBackX
  const right = box.maxX * scaleBackX
  const top = box.minY * scaleBackY
  const bottom = box.maxY * scaleBackY
  return {
    ok: true,
    corners: [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom }
    ]
  }
}
