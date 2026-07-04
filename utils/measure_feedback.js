function buildShotAcceptedNotice(done, total) {
  return `已拍 ${done}/${total}，请继续拍下一张`
}

function buildResultHandlingErrorMessage() {
  return '识别结果处理失败，请重新拍摄。'
}

function buildPrecisionRetakeNotice(message, failCount) {
  const raw = String(message || '')
  if (Number(failCount || 0) >= 3) {
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

module.exports = {
  buildResultHandlingErrorMessage,
  buildPrecisionRetakeNotice,
  buildShotAcceptedNotice
}
