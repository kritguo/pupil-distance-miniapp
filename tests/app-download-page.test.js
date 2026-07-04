const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function loadAppDownloadPage() {
  const pagePath = path.resolve(__dirname, '../pages/app-download/app-download.js')
  delete require.cache[pagePath]

  const originalPage = global.Page
  let pageConfig
  global.Page = (config) => {
    pageConfig = config
  }

  try {
    const mod = require(pagePath)
    return { pageConfig, mod }
  } finally {
    global.Page = originalPage
    delete require.cache[pagePath]
  }
}

test('app download page is registered and uses web-view as the iOS download bridge', () => {
  const appJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../app.json'), 'utf8'))
  const wxml = fs.readFileSync(path.resolve(__dirname, '../pages/app-download/app-download.wxml'), 'utf8')

  assert.ok(appJson.pages.includes('pages/app-download/app-download'))
  assert.match(wxml, /<web-view wx:if="\{\{webUrl\}\}" src="\{\{webUrl\}\}"><\/web-view>/)
  assert.match(wxml, /知道了/)
  assert.match(wxml, /App Store 搜索/)
  assert.doesNotMatch(wxml, /复制下载链接/)
})

test('app download helper appends plan and source to configured web download page', () => {
  const config = require('../config.js')
  const original = { ...(config.appDownload || {}) }
  config.appDownload.downloadPageUrl = 'https://download.example.com/pdgo'
  config.appDownload.iosSearchKeyword = 'PDgo 测瞳距'

  try {
    const { mod } = loadAppDownloadPage()
    assert.equal(
      mod._test.buildDownloadPageUrl({ plan: 'annual', source: 'precision_retest' }),
      'https://download.example.com/pdgo?plan=annual&source=precision_retest&keyword=PDgo%20%E6%B5%8B%E7%9E%B3%E8%B7%9D'
    )
    assert.equal(mod._test.getPlanCopy('annual').badge, '深度相机 · 更精准')
    assert.equal(mod._test.getPlanCopy('single').badge, '深度相机 · 更精准')
    // unionid 权益桥建好前，下载承接文案不得承诺免费或登录同步
    assert.doesNotMatch(mod._test.getPlanCopy('annual').desc, /微信登录|自动同步|免费/)
    assert.doesNotMatch(mod._test.getPlanCopy('single').desc, /微信登录|自动同步|免费/)
  } finally {
    config.appDownload = original
  }
})

test('production app download config uses the live bridge page and keeps pdgoeye as official target', () => {
  const config = require('../config.js')
  const html = fs.readFileSync(path.resolve(__dirname, '../web/app-download/index.html'), 'utf8')
  const appStoreUrl = 'https://apps.apple.com/cn/app/%E5%BF%AB%E9%80%9F%E6%B5%8B%E7%9E%B3%E8%B7%9Dpdgo/id6778687480'

  assert.equal(
    config.appDownload.downloadPageUrl,
    'https://cloudbase-4ghz65bm0b8770cd-1373927964.tcloudbaseapp.com/app-download/index.html'
  )
  assert.equal(config.appDownload.officialDownloadPageUrl, 'https://pdgoeye.com/app-download/index.html')
  assert.equal(config.appDownload.iosUrl, appStoreUrl)
  assert.match(html, new RegExp(appStoreUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(html, /download\.example\.com/)
})

test('web app download template keeps the App Store flow and optional open-app tag', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../web/app-download/index.html'), 'utf8')
  const readme = fs.readFileSync(path.resolve(__dirname, '../web/app-download/README.md'), 'utf8')

  assert.match(html, /wx-open-launch-app/)
  assert.match(html, /PDGO_DOWNLOAD_CONFIG/)
  assert.match(html, /appStoreUrl/)
  assert.match(html, /App Store 搜索/)
  assert.match(html, /plan === 'annual'/)
  assert.doesNotMatch(html, /复制下载链接/)
  assert.match(readme, /业务域名/)
  assert.match(readme, /JS 接口安全域名/)
  assert.match(readme, /微信开放平台/)
})
