# 配镜参数补齐小程序

这是一个用于测量瞳距（PD）和辅助补齐配镜参数的微信小程序项目。项目通过手机拍照、虹膜/瞳孔定位、银行卡或身份证宽度标定，计算总瞳距、左右单眼瞳距，并基于脸宽给出镜框宽度参考。

> 结果仅供配镜前参考，不替代专业验光或医疗测量。

## 核心功能

- 拍照测量总瞳距、左眼 PD、右眼 PD。
- 使用银行卡/身份证标准宽度作为比例尺。
- 支持云端自动识别：MediaPipe 检测虹膜，OpenCV 检测卡片。
- 支持手动微调瞳孔、鼻梁中线、脸部边缘和卡片边缘。
- 三次测量后自动取中位数作为主推荐结果。
- 显示三次测量波动范围，波动过大时提示继续重测。
- 可计算脸宽，并给出镜框宽度建议。
- 支持试测、单次 3 次测量包、无限测量和历史记录。

## 测量原理

核心公式：

```text
瞳距(mm) = 瞳孔像素距离 * 卡片实际宽度(mm) / 卡片像素宽度
```

当前默认卡片宽度为 `85.6mm`，即银行卡/身份证标准宽度。为了提高可靠性，项目会要求：

- 正脸居中，双眼水平。
- 卡片横放在眉毛上方，尽量贴近额头和眼睛所在平面。
- 手机、脸、卡片尽量互相平行。
- 拍摄距离约 30-40cm。
- 建议连续测量 3 次取中位数。

## 精度策略

项目不是简单输出一次识别结果，而是做了多层拦截：

- 云端自动结果必须通过质量校验，否则进入手动微调或重拍。
- 校验双眼是否水平、人脸是否正对镜头、卡片是否横放、卡片是否接近眼部平面、卡片透视变形是否过大。
- 手动测量阶段会拦截卡片过小、鼻梁中线不在双眼之间、双眼明显不水平等情况。
- 三次测量后使用中位数作为主结果。
- 三次总瞳距最大波动：
  - `<= 2mm`：稳定
  - `2-4mm`：一般，建议再测一次确认
  - `> 4mm`：波动大，建议重新按同一姿势测 3 次

单张普通手机照片无法直接获得卡片和眼睛的前后距离差，因此项目不能承诺验光设备级精度。实际准确性高度依赖拍摄姿势和光线。

## 项目结构

```text
.
├── app.js / app.json / app.wxss          # 微信小程序入口
├── config.js                             # 小程序配置
├── pages/
│   ├── index/                            # 首页
│   ├── measure/                          # 拍照、识别、手动微调、计算
│   ├── result/                           # 结果展示、三次中位数、镜框建议
│   ├── mine/                             # 历史记录 / 用户状态
│   └── activate/                         # 激活 / 付费入口
├── utils/
│   ├── user.js                           # 用户状态、试测/单次/无限测量记录
│   ├── mediapipe.js                      # 小程序端 MediaPipe 封装
│   └── util.js
├── cloudfunctions/
│   └── detectCard/                       # 云函数卡片边缘检测
├── cloud-service/                        # 生产 FastAPI 测量服务
├── server/iris_service/                  # 另一套 FastAPI 虹膜服务
├── assets/models/mediapipe/              # MediaPipe 模型和 wasm 资源
└── images/                               # Tab 图标资源
```

## 小程序端流程

1. 用户拍照。
2. 如果开启云端自动识别，调用 `config.cloudAuto.endpoint`。
3. 云端返回虹膜坐标、卡片边缘、PD 结果和质量校验。
4. 高质量结果直接进入结果页；低质量结果进入手动微调。
5. 用户完成 3 次测量后，结果页优先显示中位数推荐。

## 后端接口

主要接口：

```http
POST /v1/measure
```

请求体：

```json
{
  "image_base64": "base64 image",
  "card_width_mm": 85.6,
  "camera_position": "front"
}
```

响应包含：

- `pd.total`：总瞳距
- `pd.left`：左眼 PD
- `pd.right`：右眼 PD
- `iris`：虹膜/瞳孔坐标
- `card`：卡片角点和置信度
- `validation`：几何质量校验
- `quality`：综合质量评分和重拍建议

## 本地开发

安装依赖：

```bash
npm install
```

使用微信开发者工具打开项目根目录即可预览小程序。

后端本地运行：

```bash
cd cloud-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

然后将 `config.js` 中的 `cloudAuto.endpoint` 指向本地或线上服务。

## 部署

生产后端建议使用 `cloud-service/`：

```bash
cd cloud-service
docker compose up -d --build
```

`cloud-service/README.md` 内有更完整的服务器部署说明。

## 配置说明

`config.js` 中包含：

- `cloud.envId`：微信云开发环境 ID。
- `cloudAuto.endpoint`：云端自动测量接口。
- `mediaPipe`：小程序端 MediaPipe 配置，默认关闭。
- `facePlusPlus`：Face++ 兼容配置，默认关闭。

不要把真实 API Key、Secret 或私有环境变量提交到 GitHub。真实密钥应放在后端环境变量或云函数私有配置里。

## 已验证检查

当前代码通过以下静态检查：

```bash
node -c pages/measure/measure.js
node -c pages/result/result.js
node -c utils/mediapipe.js
node -c cloudfunctions/detectCard/index.js
python3 -m py_compile server/iris_service/app.py cloud-service/main.py
```

## 上线前建议

- 使用真实验光瞳距样本做误差统计。
- 记录每次测量的质量分、三次波动范围和最终中位数误差。
- 线上文案使用“参考值”“建议三次取中位数”，避免宣传为替代专业验光。
- 部署更新后的 `cloud-service`，确保小程序调用的线上接口包含最新质量校验。
