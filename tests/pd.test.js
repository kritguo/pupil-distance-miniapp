const test = require('node:test')
const assert = require('node:assert/strict')

const { buildCloudPdFields, buildMeasurePayload } = require('../utils/pd.js')

test('uses far PD as the primary cloud result when available', () => {
  const fields = buildCloudPdFields({
    pd: { total: 61.2, left: 30.4, right: 30.8 },
    pd_far: { total: 63.1, left: 31.4, right: 31.7 },
    pd_near: { total: 60.8, left: 30.2, right: 30.6 }
  })

  assert.deepEqual(fields, {
    totalPd: 63,
    leftPd: 31.5,
    rightPd: 31.5,
    nearTotalPd: 61,
    nearLeftPd: 30,
    nearRightPd: 30.5,
    pdBasis: 'far'
  })
})

test('uses precision weighted PD as the primary result in precision mode', () => {
  const fields = buildCloudPdFields({
    pd: { total: 62.8, left: 31.2, right: 31.6 },
    pd_far: { total: 64.4, left: 32.1, right: 32.3 },
    pd_precision: { total: 63.9, left: 31.6, right: 32.3 },
    pd_precision_far: { total: 65.6, left: 32.4, right: 33.2 },
    pd_precision_near: { total: 63.4, left: 31.3, right: 32.1 }
  }, 'precision')

  assert.deepEqual(fields, {
    totalPd: 65.5,
    leftPd: 32.5,
    rightPd: 33,
    nearTotalPd: 63.5,
    nearLeftPd: 31.5,
    nearRightPd: 32,
    pdBasis: 'precision_far'
  })
})

test('falls back to measured PD when far PD is missing', () => {
  const fields = buildCloudPdFields({
    pd: { total: 61.2, left: 30.4, right: 30.8 }
  })

  assert.deepEqual(fields, {
    totalPd: 61,
    leftPd: 30.5,
    rightPd: 31,
    nearTotalPd: null,
    nearLeftPd: null,
    nearRightPd: null,
    pdBasis: 'measured'
  })
})

test('includes an explicit selfie distance in cloud measure payloads', () => {
  assert.deepEqual(buildMeasurePayload({
    imageBase64: 'abc123',
    imageUrl: 'https://example.test/photo.jpg',
    cameraPosition: 'front',
    measureMode: 'precision'
  }), {
    image_base64: 'abc123',
    image_url: 'https://example.test/photo.jpg',
    card_width_mm: 85.6,
    camera_position: 'front',
    selfie_distance_mm: 500,
    measure_mode: 'precision'
  })
})
