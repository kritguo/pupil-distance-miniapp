const test = require('node:test')
const assert = require('node:assert/strict')
const lens = require('../utils/lens_advice.js')

test('rejects when no eye has a degree', () => {
  const out = lens.buildLensAdvice({ sphL: '', sphR: '', cylL: '', cylR: '', usage: 'daily', pd: 63 })
  assert.equal(out.ok, false)
  assert.match(out.error, /至少输入一只眼/)
})

test('rejects out-of-range degrees', () => {
  const out = lens.buildLensAdvice({ sphL: '3500', sphR: '', cylL: '', cylR: '', usage: 'daily', pd: 63 })
  assert.equal(out.ok, false)
  assert.match(out.error, /0–3000/)
})

test('index picked by the worse eye: sph+cyl 400 → 1.60 轻薄 非球面', () => {
  const out = lens.buildLensAdvice({ sphL: '300', sphR: '200', cylL: '100', cylR: '', usage: 'daily', pd: 63 })
  assert.equal(out.ok, true)
  assert.equal(out.advice.effL, 400)
  assert.equal(out.advice.effR, 200)
  assert.equal(out.advice.index, '1.60')
  assert.equal(out.advice.indexName, '轻薄')
  assert.equal(out.advice.lensShape, '非球面')
  assert.equal(out.advice.pd, 63)
})

test('high degree (650) → 1.71 特薄 双面非球面', () => {
  const out = lens.buildLensAdvice({ sphL: '650', sphR: '600', cylL: '', cylR: '', usage: 'daily', pd: null })
  assert.equal(out.advice.index, '1.71')
  assert.equal(out.advice.lensShape, '双面非球面')
  assert.equal(out.advice.pd, null)
})

test('aniso flagged when effective degrees differ by 250+', () => {
  const out = lens.buildLensAdvice({ sphL: '600', sphR: '300', cylL: '', cylR: '', usage: 'daily', pd: 63 })
  assert.equal(out.advice.aniso, true)
  assert.equal(out.advice.anisoDiff, 300)
})

test('usage maps to coating; unknown usage falls back to daily', () => {
  const blue = lens.buildLensAdvice({ sphL: '200', sphR: '', cylL: '', cylR: '', usage: 'bluelight', pd: 63 })
  assert.match(blue.advice.coating, /防蓝光/)
  const fallback = lens.buildLensAdvice({ sphL: '200', sphR: '', cylL: '', cylR: '', usage: 'nope', pd: 63 })
  assert.match(fallback.advice.coating, /减反射/)
  assert.match(fallback.advice.usageNote, /日常/)
})

test('advice always carries the professional disclaimer', () => {
  const out = lens.buildLensAdvice({ sphL: '200', sphR: '', cylL: '', cylR: '', usage: 'daily', pd: 63 })
  assert.match(out.advice.disclaimer, /验光/)
})
