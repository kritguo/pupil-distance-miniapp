const PRECISION_CARD_DIFF_LIMIT_MM = 3
// 不在首次测量前展示普通/精确选择；精确卡片能力只从结果页/补测入口进入。
const PRECISION_MODE_ENABLED = false
const PRECISION_RETEST_ENABLED = true
const PRECISION_CARD_GUIDE = {
  topRpx: 28,
  widthRpx: 300,
  heightRpx: 150
}

const MODE_COPY = {
  normal: {
    key: 'normal',
    label: '普通模式',
    shortLabel: '普通',
    main: '把瞳孔对准两个圈、双眼对齐横线',
    sub: '举到与眼睛同高 · 约一臂距离 · 摘掉眼镜更准',
    chip: '摘掉眼镜测得更准',
    help: '把脸对准框内、正脸看镜头，手机举到与眼睛同高、保持约一臂距离。摘掉眼镜、光线充足、自然睁眼即可，无需手持任何卡片。'
  },
  precision: {
    key: 'precision',
    label: '卡片精准测量',
    shortLabel: '卡片精准',
    main: '卡片横放眉毛上方，同时拍到双眼',
    sub: '身份证或银行卡贴近额头 · 与脸部平面平行',
    chip: '卡片越靠近眼睛平面越准',
    help: '把身份证或银行卡横放在眉毛上方或额头下沿，尽量贴近脸部，不要离脸太远；卡片和脸部保持平行，同时露出双眼、卡片四角和完整正脸。'
  }
}

const MODE_INTRO_COPY = {
  title: '选择测量方式',
  subtitle: '首次默认普通模式，付费后可做精度复测。',
  normal: {
    label: '普通模式',
    desc: '无需卡片，按提示拍 3 张，适合快速测量。'
  },
  precision: {
    label: '精确模式',
    desc: '用身份证或银行卡辅助校验，适合想更稳一点。'
  },
  footer: '首次先用普通模式，结果不放心可免费用精确模式再测一次。'
}

function normalizeMeasureMode(mode) {
  return mode === 'precision' && PRECISION_RETEST_ENABLED ? 'precision' : 'normal'
}

function isPrecisionModeEnabled() {
  return PRECISION_MODE_ENABLED
}

function isPrecisionRetestEnabled() {
  return PRECISION_RETEST_ENABLED
}

function getMeasureModeCopy(mode) {
  return MODE_COPY[normalizeMeasureMode(mode)]
}

function getModeIntroCopy() {
  return MODE_INTRO_COPY
}

function getPrecisionCardGuideStyle() {
  return [
    `top: ${PRECISION_CARD_GUIDE.topRpx}rpx`,
    `width: ${PRECISION_CARD_GUIDE.widthRpx}rpx`,
    `height: ${PRECISION_CARD_GUIDE.heightRpx}rpx`
  ].join('; ')
}

function toNumber(value) {
  if (typeof value === 'number' && !Number.isNaN(value)) return value
  if (typeof value !== 'string') return null
  const num = Number(value)
  return Number.isNaN(num) ? null : num
}

function getPrecisionCardIssue(data, mode) {
  if (normalizeMeasureMode(mode) !== 'precision') return null
  const card = data && data.card_cross_check
  if (!card || card.found !== true) {
    return '精确模式需要识别到卡片。请把身份证或银行卡横放在眉毛上方，尽量贴近脸部，并让卡片四角完整入镜。'
  }
  const diff = toNumber(card.diff_mm)
  if (diff === null) {
    return '卡片边缘不够清晰，暂时无法完成卡片校验。请擦净镜头、保持光线充足后重拍。'
  }
  if (diff > PRECISION_CARD_DIFF_LIMIT_MM) {
    return `卡片校验与虹膜结果相差 ${diff}mm，说明卡片可能离脸太远或没有与脸部平行。请调整后重拍。`
  }
  return null
}

module.exports = {
  PRECISION_CARD_DIFF_LIMIT_MM,
  PRECISION_MODE_ENABLED,
  PRECISION_RETEST_ENABLED,
  PRECISION_CARD_GUIDE,
  isPrecisionModeEnabled,
  isPrecisionRetestEnabled,
  getPrecisionCardGuideStyle,
  getModeIntroCopy,
  getMeasureModeCopy,
  getPrecisionCardIssue,
  normalizeMeasureMode
}
