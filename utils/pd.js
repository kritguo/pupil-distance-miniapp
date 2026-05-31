const roundToHalf = (value) => Math.round(value * 2) / 2
const isNumber = (value) => typeof value === 'number' && !Number.isNaN(value)
const DEFAULT_CARD_WIDTH_MM = 85.6
const DEFAULT_SELFIE_DISTANCE_MM = 500

const normalizePdSet = (pd) => {
  if (!pd || !isNumber(pd.total)) return null
  const total = roundToHalf(pd.total)
  return {
    totalPd: total,
    leftPd: isNumber(pd.left) ? roundToHalf(pd.left) : roundToHalf(total / 2),
    rightPd: isNumber(pd.right) ? roundToHalf(pd.right) : roundToHalf(total / 2)
  }
}

const buildCloudPdFields = (data) => {
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
  selfieDistanceMm = DEFAULT_SELFIE_DISTANCE_MM
}) => {
  const payload = {
    card_width_mm: cardWidthMm,
    camera_position: cameraPosition || 'unknown',
    selfie_distance_mm: selfieDistanceMm
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
