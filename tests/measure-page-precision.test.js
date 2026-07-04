const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

function loadMeasurePage() {
  const pagePath = path.resolve(__dirname, '../pages/measure/measure.js')
  delete require.cache[pagePath]

  const originalPage = global.Page
  let pageConfig
  global.Page = (config) => {
    pageConfig = config
  }

  try {
    require(pagePath)
  } finally {
    global.Page = originalPage
    delete require.cache[pagePath]
  }

  return pageConfig
}

test('precision mode intro falls back to normal while precision is disabled', () => {
  const pageConfig = loadMeasurePage()
  let closedMode = ''
  const ctx = {
    ...pageConfig,
    closeModeIntro(mode) {
      closedMode = mode
    }
  }

  pageConfig.onModeIntroPrecision.call(ctx)

  assert.equal(closedMode, 'normal')
})
