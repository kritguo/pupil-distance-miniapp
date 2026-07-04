const roundToHalf = (value) => Math.round(value * 2) / 2
const isNumber = (value) => typeof value === 'number' && !Number.isNaN(value)
const DEFAULT_CARD_WIDTH_MM = 85.6
const DEFAULT_SELFIE_DISTANCE_MM = 500

const normalizeMeasureMode = (mode) => mode === 'precision' ? 'precision' : 'normal'

const normalizePdSet = (pd) => {
  if (!pd || !isNumber(pd.total)) return null
  const total = roundToHalf(pd.total)
  return {
    totalPd: total,
    leftPd: isNumber(pd.left) ? roundToHalf(pd.left) : roundToHalf(total / 2),
    rightPd: isNumber(pd.right) ? roundToHalf(pd.right) : roundToHalf(total / 2)
  }
}

const buildCloudPdFields = (data, mode) => {
  const measureMode = normalizeMeasureMode(mode)
  if (measureMode === 'precision') {
    const precisionFar = normalizePdSet(data && data.pd_precision_far)
    const precisionMeasured = normalizePdSet(data && data.pd_precision)
    const precisionPrimary = precisionFar || precisionMeasured
    if (precisionPrimary) {
      const precisionNear = normalizePdSet(data && data.pd_precision_near)
      return {
        totalPd: precisionPrimary.totalPd,
        leftPd: precisionPrimary.leftPd,
        rightPd: precisionPrimary.rightPd,
        nearTotalPd: precisionNear ? precisionNear.totalPd : null,
        nearLeftPd: precisionNear ? precisionNear.leftPd : null,
        nearRightPd: precisionNear ? precisionNear.rightPd : null,
        pdBasis: precisionFar ? 'precision_far' : 'precision_measured'
      }
    }
  }

  const far = normalizePdSet(data && data.pd_far)
  const measured = normalizePdSet(data && data.pd)
  const primary = far || measured
  if (!primary) return null

  const near = normalizePdSet(data && data.pd_near)
  return {
    totalPd: primary.totalPd,
    leftPd: primary.leftPd,
    rightPd: primary.rightPd,
    nearTotalPd: near ? near.totalPd : null,
    nearLeftPd: near ? near.leftPd : null,
    nearRightPd: near ? near.rightPd : null,
    pdBasis: far ? 'far' : 'measured'
  }
}

const buildMeasurePayload = ({
  imageBase64,
  imageUrl,
  cameraPosition,
  cardWidthMm = DEFAULT_CARD_WIDTH_MM,
  selfieDistanceMm = DEFAULT_SELFIE_DISTANCE_MM,
  measureMode = 'normal'
}) => {
  const payload = {
    card_width_mm: cardWidthMm,
    camera_position: cameraPosition || 'unknown',
    selfie_distance_mm: selfieDistanceMm,
    measure_mode: normalizeMeasureMode(measureMode)
  }
  if (imageBase64) payload.image_base64 = imageBase64
  if (imageUrl) payload.image_url = imageUrl
  return payload
}

module.exports = {
  buildCloudPdFields,
  buildMeasurePayload,
  isNumber,
  roundToHalf
}
