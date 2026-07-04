// 镜片建议领域规则：左右眼 球镜+散光 → 有效度数 → 折射率/面型/膜层
// 纯函数，从 pages/result/result.js 抽出以便 Node 测试覆盖

// 镜片折射率推荐规则
const LENS_INDEX_RULES = [
  { maxDegree: 200, index: '1.56', name: '标准' },
  { maxDegree: 400, index: '1.60', name: '轻薄' },
  { maxDegree: 600, index: '1.67', name: '超薄' },
  { maxDegree: 800, index: '1.71', name: '特薄' },
  { maxDegree: Infinity, index: '1.74', name: '极薄' }
]

// 用途 → 膜层/说明（折射率与面型由度数另算；不再把普通阅读误判为渐进多焦点）
const USAGE_ADVICE = {
  daily:     { name: '日常通用', coating: '加硬膜 + 减反射(绿)膜', note: '日常室内外通用' },
  bluelight: { name: '防蓝光',   coating: '加硬膜 + 防蓝光膜 + 减反射膜', note: '长时间看手机/电脑可选，缓解视疲劳' },
  driving:   { name: '驾驶',     coating: '加硬膜 + 减反射膜 + 偏光/变色(户外)', note: '减少眩光，白天驾驶更清晰' },
  reading:   { name: '阅读办公', coating: '加硬膜 + 减反射膜 + 抗疲劳设计', note: '近距离用眼多；若已老花，请验光后配渐进/双光镜' }
}

// 严谨版镜片建议：校验输入 → 有效度数 → 折射率/面型；返回 { ok, error? , advice? }
const buildLensAdvice = ({ sphL, sphR, cylL, cylR, usage, pd }) => {
  const nL = parseFloat(sphL) || 0
  const nR = parseFloat(sphR) || 0
  const cL = parseFloat(cylL) || 0
  const cR = parseFloat(cylR) || 0

  if (nL <= 0 && nR <= 0) {
    return { ok: false, error: '请至少输入一只眼的度数' }
  }
  if ([nL, nR, cL, cR].some((v) => v < 0 || v > 3000)) {
    return { ok: false, error: '度数请填 0–3000' }
  }

  // 有效度数 = 球镜 + 散光；折射率按更高那只眼来定（镜片越厚越需要高折射率）
  const effL = Math.round(nL + cL)
  const effR = Math.round(nR + cR)
  const maxEff = Math.max(effL, effR)

  let idx = LENS_INDEX_RULES[LENS_INDEX_RULES.length - 1]
  for (const rule of LENS_INDEX_RULES) {
    if (maxEff <= rule.maxDegree) { idx = rule; break }
  }

  const lensShape = maxEff >= 600 ? '双面非球面' : '非球面'
  const usageAdvice = USAGE_ADVICE[usage] || USAGE_ADVICE.daily
  const anisoDiff = Math.abs(effL - effR)

  return {
    ok: true,
    advice: {
      effL,
      effR,
      index: idx.index,
      indexName: idx.name,
      lensShape,
      coating: usageAdvice.coating,
      usageNote: usageAdvice.note,
      pd: pd || null,
      aniso: anisoDiff >= 250,
      anisoDiff,
      disclaimer: '仅供选片参考。实际配镜请以验光单(含散光轴位)和验光师建议为准。'
    }
  }
}

module.exports = {
  buildLensAdvice
}
