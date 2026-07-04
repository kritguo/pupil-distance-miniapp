const test = require('node:test')
const assert = require('node:assert/strict')
const measureRequest = require('../utils/measure_request.js')

const withWx = (mock, fn) => {
  const originalWx = global.wx
  global.wx = mock
  try {
    fn()
  } finally {
    global.wx = originalWx
  }
}

test('parseServerData: parses JSON string, passes object through, degrades to {}', () => {
  assert.deepEqual(measureRequest.parseServerData('{"ok":true}'), { ok: true })
  assert.deepEqual(measureRequest.parseServerData({ ok: 1 }), { ok: 1 })
  assert.deepEqual(measureRequest.parseServerData('not json'), {})
  assert.deepEqual(measureRequest.parseServerData(null), {})
})

test('http mode: reads file as base64, posts payload, parses response', () => {
  let requested = null
  let payloadInput = null
  let stage = null
  let data = null
  withWx({
    getFileSystemManager: () => ({
      readFile: ({ success }) => success({ data: 'BASE64' })
    }),
    request: (options) => {
      requested = options
      options.success({ statusCode: 200, data: '{"ok":true}' })
    }
  }, () => {
    measureRequest.sendMeasure({
      cloudAuto: { mode: 'http', endpoint: 'https://api/v1/measure' },
      filePath: 'tmp.jpg',
      buildPayload: (image) => { payloadInput = image; return { img: image.imageBase64 } },
      isActive: () => true,
      onStage: (s) => { stage = s },
      onData: (d) => { data = d },
      onFail: () => assert.fail('should not fail')
    })
  })
  assert.equal(requested.url, 'https://api/v1/measure')
  assert.equal(requested.method, 'POST')
  assert.deepEqual(payloadInput, { imageBase64: 'BASE64' })
  assert.equal(stage, 'recognize')
  assert.deepEqual(data, { ok: true })
})

test('http mode: server error status surfaces as a fail message', () => {
  let failMsg = null
  withWx({
    getFileSystemManager: () => ({
      readFile: ({ success }) => success({ data: 'BASE64' })
    }),
    request: (options) => options.success({ statusCode: 500, data: { msg: 'boom' } })
  }, () => {
    measureRequest.sendMeasure({
      cloudAuto: { mode: 'http', endpoint: 'https://api' },
      filePath: 'tmp.jpg',
      buildPayload: () => ({}),
      isActive: () => true,
      onStage: () => {},
      onData: () => assert.fail('should not succeed'),
      onFail: (msg) => { failMsg = msg }
    })
  })
  assert.match(failMsg, /服务返回错误\(500\)/)
})

test('http mode: read failure and inactive request short-circuit', () => {
  let failMsg = null
  withWx({
    getFileSystemManager: () => ({
      readFile: ({ fail }) => fail()
    })
  }, () => {
    measureRequest.sendMeasure({
      cloudAuto: { mode: 'http', endpoint: 'https://api' },
      filePath: 'tmp.jpg',
      buildPayload: () => ({}),
      isActive: () => true,
      onStage: () => {},
      onData: () => {},
      onFail: (msg) => { failMsg = msg }
    })
  })
  assert.match(failMsg, /读取照片失败/)

  // 请求已失效（用户已离开/超时）：读完文件不应再发请求
  let requestCalled = false
  withWx({
    getFileSystemManager: () => ({
      readFile: ({ success }) => success({ data: 'BASE64' })
    }),
    request: () => { requestCalled = true }
  }, () => {
    measureRequest.sendMeasure({
      cloudAuto: { mode: 'http', endpoint: 'https://api' },
      filePath: 'tmp.jpg',
      buildPayload: () => ({}),
      isActive: () => false,
      onStage: () => {},
      onData: () => assert.fail('inactive'),
      onFail: () => assert.fail('inactive')
    })
  })
  assert.equal(requestCalled, false)
})

test('container mode: upload → temp url → callContainer → cleanup, payload carries imageUrl', () => {
  const calls = { deleted: null, container: null }
  let payloadInput = null
  let data = null
  withWx({
    cloud: {
      uploadFile: ({ success }) => success({ fileID: 'cloud://f1' }),
      getTempFileURL: ({ success }) => success({ fileList: [{ tempFileURL: 'https://tmp/u.jpg' }] }),
      callContainer: (options) => {
        calls.container = options
        options.success({ statusCode: 200, data: { ok: true } })
      },
      deleteFile: ({ fileList }) => { calls.deleted = fileList }
    }
  }, () => {
    measureRequest.sendMeasure({
      cloudAuto: { mode: 'container', containerEnv: 'env-1', service: 'pd-svc', path: '/v1/measure' },
      filePath: 'tmp.jpg',
      buildPayload: (image) => { payloadInput = image; return { url: image.imageUrl } },
      isActive: () => true,
      onStage: () => {},
      onData: (d) => { data = d },
      onFail: () => assert.fail('should not fail')
    })
  })
  assert.deepEqual(payloadInput, { imageUrl: 'https://tmp/u.jpg' })
  assert.equal(calls.container.header['X-WX-SERVICE'], 'pd-svc')
  assert.equal(calls.container.path, '/v1/measure')
  assert.deepEqual(data, { ok: true })
  // 隐私规则：识别完必须删除云存储临时照片
  assert.deepEqual(calls.deleted, ['cloud://f1'])
})

test('container mode: missing temp url cleans up and fails', () => {
  let deleted = null
  let failMsg = null
  withWx({
    cloud: {
      uploadFile: ({ success }) => success({ fileID: 'cloud://f2' }),
      getTempFileURL: ({ success }) => success({ fileList: [] }),
      callContainer: () => assert.fail('should not call container'),
      deleteFile: ({ fileList }) => { deleted = fileList }
    }
  }, () => {
    measureRequest.sendMeasure({
      cloudAuto: { mode: 'container', service: 'pd-svc' },
      filePath: 'tmp.jpg',
      buildPayload: () => ({}),
      isActive: () => true,
      onStage: () => {},
      onData: () => assert.fail('no data'),
      onFail: (msg) => { failMsg = msg }
    })
  })
  assert.deepEqual(deleted, ['cloud://f2'])
  assert.match(failMsg, /获取图片链接失败/)
})

test('container mode: request turning inactive after upload still deletes the cloud file', () => {
  let deleted = null
  let containerCalled = false
  withWx({
    cloud: {
      uploadFile: ({ success }) => success({ fileID: 'cloud://f3' }),
      getTempFileURL: () => assert.fail('inactive: no url fetch'),
      callContainer: () => { containerCalled = true },
      deleteFile: ({ fileList }) => { deleted = fileList }
    }
  }, () => {
    measureRequest.sendMeasure({
      cloudAuto: { mode: 'container', service: 'pd-svc' },
      filePath: 'tmp.jpg',
      buildPayload: () => ({}),
      isActive: () => false,
      onStage: () => {},
      onData: () => assert.fail('inactive'),
      onFail: () => assert.fail('inactive')
    })
  })
  assert.equal(containerCalled, false)
  assert.deepEqual(deleted, ['cloud://f3'])
})

test('container mode: unavailable wx.cloud fails fast', () => {
  let failMsg = null
  withWx({}, () => {
    measureRequest.sendMeasure({
      cloudAuto: { mode: 'container', service: 'pd-svc' },
      filePath: 'tmp.jpg',
      buildPayload: () => ({}),
      isActive: () => true,
      onStage: () => {},
      onData: () => {},
      onFail: (msg) => { failMsg = msg }
    })
  })
  assert.match(failMsg, /云能力不可用/)
})
