const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('measure page does not render measurement mode selector while precision is off', () => {
  const wxml = fs.readFileSync(path.resolve(__dirname, '../pages/measure/measure.wxml'), 'utf8')

  assert.doesNotMatch(wxml, /class="mode-switch"/)
  assert.doesNotMatch(wxml, /class="mode-helper"/)
  assert.doesNotMatch(wxml, /class="mode-intro-mask"/)
  assert.doesNotMatch(wxml, /class="glasses-chip"/)
  assert.doesNotMatch(wxml, /modeCopy\.label/)
  assert.doesNotMatch(wxml, /class="cap-sub"/)
  assert.doesNotMatch(wxml, /一次测量需拍 3 张/)
  assert.match(wxml, /class="mode-status">卡片精准测量<\/text>/)
  assert.match(wxml, /class="shot-progress \{\{measureMode === 'precision' \? 'precision' : ''\}\}"/)
  assert.match(wxml, /<view class="capture-guide">\{\{captureNotice \|\| '对准后点击拍照'\}\}<\/view>/)
})

test('precision shot progress is lowered below the WeChat capsule area', () => {
  const wxss = fs.readFileSync(path.resolve(__dirname, '../pages/measure/measure.wxss'), 'utf8')

  assert.match(wxss, /\.top-row\s*\{[\s\S]*?align-items:\s*flex-start;/)
  assert.match(wxss, /\.shot-progress\.precision\s*\{[\s\S]*?padding-top:\s*96rpx;/)
})
