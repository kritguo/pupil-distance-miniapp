// 智能辅助测量配置
// 默认不依赖云端识别，主流程是本地拍照、智能校准提示、手动微调和三次中位数修复。
// 注意：不要把真实 API Key 提交到 GitHub。若后续启用第三方识别，请将密钥放到后端私有环境。

module.exports = {
  // ⚠️ 测试专用：bypassPay=true 时本地直接当年度会员，不弹付费墙。
  // 本地调试若要跳过付费墙可临时改 true，但提交/上线前必须为 false。
  dev: {
    bypassPay: false
  },
  cloud: {
    envId: 'cloud1-0gahgwwra45a0df3' // 填写你的云开发环境 ID
  },
  facePlusPlus: {
    enabled: false,
    apiKey: '',        // 如需启用 Face++，请在私有环境中配置
    apiSecret: '',     // 如需启用 Face++，请在私有环境中配置
    apiUrl: 'https://api-cn.faceplusplus.com/facepp/v3/detect'
  },
  facePlusPlusDense: {
    enabled: false,
    apiUrl: 'https://api-cn.faceplusplus.com/facepp/v1/face/thousandlandmark',
    returnLandmark: 'all',
    useFaceToken: false,
    onlyDense: true
  },
  mediaPipe: {
    enabled: false,
    modelPath: 'assets/models/mediapipe/face_landmarker.task',
    modelUrl: 'https://storage.googleapis.com/mediapipe-assets/face_landmarker.task',
    wasmPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm'
  },
  cloudAuto: {
    enabled: true,
    // mode: 'container' 走 callContainer+云存储中转(免域名免白名单,生产推荐) ; 'http' 走 wx.request(本地联调/自建VPS)
    mode: 'container',
    // 云托管公网域名。真机需把该域名加入小程序"request合法域名"；开发者工具可勾「不校验合法域名」
    endpoint: 'https://flask-cgpz-263974-4-1394475227.sh.run.tcloudbase.com/v1/measure',
    containerEnv: 'prod-d2gxdl8ua41461f9d',
    service: 'flask-cgpz',
    path: '/v1/measure',
    // 上传压缩质量：前端会再做上限保护，避免真机大图上传卡住。
    quality: 76
  },
  appDownload: {
    // 小程序 web-view 下载页地址。当前先用已部署的 CloudBase 临时域名；
    // pdgoeye.com 备案、DNS 和业务域名配置完成后，再切到 officialDownloadPageUrl。
    downloadPageUrl: 'https://cloudbase-4ghz65bm0b8770cd-1373927964.tcloudbaseapp.com/app-download/index.html',
    officialDownloadPageUrl: 'https://pdgoeye.com/app-download/index.html',
    // iOS App Store 链接由下载页承接；小程序内仅作为兜底展示配置。
    iosUrl: 'https://apps.apple.com/cn/app/%E5%BF%AB%E9%80%9F%E6%B5%8B%E7%9E%B3%E8%B7%9Dpdgo/id6778687480',
    iosSearchKeyword: 'PDgo 测瞳距'
  }
}
