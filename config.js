// Face++ API 配置
// 注意：不要把真实 API Key 提交到 GitHub。正式上线请将密钥放到云函数或后端环境变量。

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
    enabled: true,
    endpoint: 'https://api.domchao.site/v1/measure',
    quality: 70
  }
}
