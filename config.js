// 智能辅助测量配置
// 默认不依赖云端识别，主流程是本地拍照、智能校准提示、手动微调和三次中位数修复。
// 注意：不要把真实 API Key 提交到 GitHub。若后续启用第三方识别，请将密钥放到后端私有环境。

module.exports = {
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
    enabled: false,
    endpoint: '',
    quality: 70
  }
}
