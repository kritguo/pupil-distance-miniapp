# PDgo App 下载承接页

这个目录是小程序 `pages/app-download/app-download` 的 H5 承接页模板。

## 上线流程

1. 把 `index.html` 部署到 HTTPS 域名。当前临时可访问地址：
   `https://cloudbase-4ghz65bm0b8770cd-1373927964.tcloudbaseapp.com/app-download/index.html`
   
   `pdgoeye.com` 备案、DNS、HTTPS 完成后切到正式地址：
   `https://pdgoeye.com/app-download/index.html`
2. 在微信小程序后台把当前使用的域名配置为 `web-view` 业务域名。
3. 在 `config.js` 配置：
   ```js
   appDownload: {
     downloadPageUrl: 'https://cloudbase-4ghz65bm0b8770cd-1373927964.tcloudbaseapp.com/app-download/index.html',
     officialDownloadPageUrl: 'https://pdgoeye.com/app-download/index.html',
     iosUrl: 'https://apps.apple.com/cn/app/%E5%BF%AB%E9%80%9F%E6%B5%8B%E7%9E%B3%E8%B7%9Dpdgo/id6778687480',
     iosSearchKeyword: 'PDgo 测瞳距'
   }
   ```
4. 在 H5 页里配置 App Store 地址：
   ```html
   <script>
     window.PDGO_DOWNLOAD_CONFIG = {
       appStoreUrl: 'https://apps.apple.com/cn/app/%E5%BF%AB%E9%80%9F%E6%B5%8B%E7%9E%B3%E8%B7%9Dpdgo/id6778687480',
       searchKeyword: 'PDgo 测瞳距'
     }
   </script>
   ```
   放在 `index.html` 最底部业务脚本之前即可。

## 已安装 App 的直接打开能力

如果要在微信内网页直接打开已安装的 PDgo App，需要再接微信开放标签：

1. 已认证服务号绑定 H5 域名为 JS 接口安全域名。
2. 微信开放平台里把该域名和 PDgo 移动应用绑定。
3. App 接入微信 OpenSDK。
4. 提供 JS-SDK 签名接口，并在 H5 配置：
   ```js
   window.PDGO_DOWNLOAD_CONFIG = {
     appStoreUrl: 'https://apps.apple.com/cn/app/%E5%BF%AB%E9%80%9F%E6%B5%8B%E7%9E%B3%E8%B7%9Dpdgo/id6778687480',
     wxLaunchAppId: '开放平台移动应用 AppID',
     jsSdkConfigUrl: 'https://pdgoeye.com/api/wechat-js-sign'
   }
   ```

没有配置 `wxLaunchAppId/jsSdkConfigUrl` 时，页面只展示 App Store 下载入口和搜索兜底。
