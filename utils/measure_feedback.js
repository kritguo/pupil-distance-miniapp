function buildShotAcceptedNotice(done, total) {
  return `已拍 ${done}/${total}，请继续拍下一张`
}

function buildResultHandlingErrorMessage() {
  return '识别结果处理失败，请重新拍摄。'
}

function buildPrecisionRetakeNotice(message, failCount) {
  const raw = String(message || '')
  const fails = Number(failCount || 0)
  if (fails >= 5) {
    return '多次没识别到卡片，可点左上角返回，换个光线好的地方再试'
  }
  if (fails >= 3) {
    return '卡片仍没识别清楚，换亮一点或换张卡片再拍'
  }
  if (/相差|离脸太远|平行/.test(raw)) {
    return '卡片贴近额头并与脸平行后再拍'
  }
  if (/边缘|清晰|反光/.test(raw)) {
    return '卡片边缘不够清楚，避开反光后再拍'
  }
  return '卡片四角没识别清楚，露出完整卡片后再拍'
}

// 卡片模式下普通质量问题(脸不正/双眼不平等)也走页内提示：取第一个问题点，短句给出动作。
function buildPrecisionQualityNotice(message) {
  const raw = String(message || '')
  const first = raw.split(/[、。]/)[0]
  return `${first || '这张质量不够'}，调整后再拍这一张`
}

module.exports = {
  buildResultHandlingErrorMessage,
  buildPrecisionRetakeNotice,
  buildPrecisionQualityNotice,
  buildShotAcceptedNotice
}
