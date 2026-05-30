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
    // 上传压缩质量：调高让虹膜更清晰、直径测量更准（云存储中转无 100KB 限制，可放高）
    quality: 90
  }
}
