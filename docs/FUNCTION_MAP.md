# 快速测瞳距PDgo 功能地图 (FUNCTION_MAP)

> 产品行为的事实来源。AI/开发者改代码前必须先在这里定位模块，再读 `docs/dtr/` 下对应模块文档。
> 首版只如实映射已核实的链路，未核实部分标 `unmapped`，不编造。

Last updated: 2026-07-04

## 防漂移守则

- 新增/删除页面、云函数、数据集合、云托管接口 → 必须更新本文件。
- 改变用户可见行为 → 必须更新对应模块 DTR（`docs/dtr/DTR-XX-*.md`）。
- 修复历史 bug → 在「历史 bug/回归点」登记状态与回归测试。
- 改完跑 `npm test`（127 个测试，基线全绿，2026-07-05 核实）。

## 1. 页面 / 路由（app.json 注册，7 个）

| 页面 | 路径 | 入口 | 核心依赖 | DTR |
|---|---|---|---|---|
| 测量首页 (tab) | `pages/index/index` | tabBar | `utils/user` `utils/pay` `utils/measure_entry` | `DTR-01` |
| 测量页 | `pages/measure/measure` | 首页「开始测量」/ 结果页重测 | 云托管 `/v1/measure`、`utils/measure_*` | `DTR-01` |
| 结果页 | `pages/result/result` | 测量完成跳转 / 历史记录进入 | `utils/user` `utils/pay`、云函数 consumeMeasure/grantRetest | `DTR-01` |
| App 下载页 | `pages/app-download/app-download` + `web/app-download/index.html` | iOS 结果页「用 App 精度复测」 | `web-view`、`config.appDownload`、H5 App Store 承接页 | `DTR-01` |
| 个人中心 (tab) | `pages/mine/mine` | tabBar | `utils/user` `utils/pay`、adminStats(管理员入口判定) | 未细化 |
| 管理后台 | `pages/admin/admin` | 个人中心隐藏入口 | 云函数 adminStats / vpayConfirm(补单) | 未细化 |
| 卡密激活 | `pages/activate/activate` | — | 无（卡密暂未开放，仅提示弹窗；按决策保留页面） | 未细化 |

## 2. 后端能力

### 2.1 云托管容器（cloud-service/，Python）

| 接口 | 用途 | 调用方 |
|---|---|---|
| `POST /v1/measure` | 虹膜比例尺瞳距测量（普通模式）+ 距离/入框低档质量门控 + 卡片精确校验（精确模式，precision_pd.py） | `pages/measure/measure.js`（container 模式走云存储中转，http 模式直传 base64） |
| `GET /health` | 预热/健康检查（进测量页即预热，规避冷启动） | `measure.js warmUpService()` |

### 2.2 云函数（cloudfunctions/，7 个）

| 云函数 | 用途 | 调用方 | 读写集合 |
|---|---|---|---|
| `getEntitlement` | 拉取服务端权益 | `utils/pay.js` | users (读) |
| `consumeMeasure` | 扣次/解锁结果（幂等） | `utils/pay.js` | users (读写) |
| `grantRetest` | 精度复测额度发放（普通首测解锁赠送；精度复测中/低续发） | `utils/pay.js` | users (读写) |
| `vpaySign` | 虚拟支付下单签名 | `utils/pay.js` | orders (写) |
| `vpayConfirm` | 查单确权、发放权益、补单、首次付费实时播报(webhook)、落库 transactionId | `utils/pay.js`、`pages/admin`(补单) | orders + users (读写) |
| `logMeasureEvent` | 测量会话埋点 | `utils/measure_log.js` | measureEvents (写) |
| `adminStats` | 管理员统计/身份判定/订单明细(`getRecentPaidOrders`) | `pages/admin`、`pages/mine`、机器人 | users/orders/measureEvents (读) |

> 已退役：`detectCard`（v2 卡片定位）于 2026-06-10 删除，功能由云托管 `precision_pd.py` 取代。详见 `docs/dtr/DTR_COVERAGE.md` MOD-99。

## 3. 小程序端模块（utils/）

| 模块 | 职责 | 备注 |
|---|---|---|
| `utils/user.js` | 用户权益/批次缓存（真值在服务端，本地兜底） | 388 行，超 300 行红线但主题单一 |
| `utils/pay.js` | 支付与权益同步封装（vpaySign → requestVirtualPayment → vpayConfirm 重试） | |
| `utils/pd.js` | 瞳距字段解析/请求载荷构建 | 有测试 |
| `utils/result_stats.js` | 结果页统计：3 张取中位数/波动点阵/可信度判级 | 有测试（2026-06-10 从 result.js 抽出） |
| `utils/lens_advice.js` | 镜片建议规则：有效度数→折射率/面型/膜层 | 有测试（2026-06-10 从 result.js 抽出） |
| `utils/measure_mode.js` | 普通/精确模式文案、前置选择关闭、精度复测入口与精确卡片校验提示 | 有测试 |
| `utils/measure_request.js` | 测量请求常量/超时/重试判定 + http/云托管传输层（含临时图用完即删） | 有测试（传输层 2026-06-10 从 measure.js 下沉） |
| `utils/measure_log.js` | 测量埋点载荷构建与上报 | 有测试 |
| `utils/measure_feedback.js` | 拍摄反馈文案 | 有测试 |
| `utils/measure_entry.js` | 首页进入测量的 URL/复测选择/客户端平台判定(ios/android) | 有测试 |
| `utils/mediapipe.js` `utils/vision_bundle.js` | 本地视觉能力（现走云端，使用情况 unmapped） | 未核实 |

## 4. 数据

| 存储 | 位置 | 关键字段/键 |
|---|---|---|
| `users` 集合 | 云数据库 | status / remainCount / retestCredits / annualExpireAt（权益真值） |
| `orders` 集合 | 云数据库 | 虚拟支付订单 |
| `measureEvents` 集合 | 云数据库 | 测量会话埋点 |
| 本地 Storage | 小程序端 | `pd_user_info`（权益缓存+批次+记录）、`latestResult`、`pd_face_consent`、`pd_measure_mode_intro_seen` |

## 5. 受保护边界

| 边界 | 文件/模块 | 原因 | 允许的改动 |
|---|---|---|---|
| 支付确权链路 | `utils/pay.js`、`cloudfunctions/vpaySign`、`cloudfunctions/vpayConfirm` | 钱与权益发放 | 带回归证明的 bug 修复 |
| 扣次幂等 | `cloudfunctions/consumeMeasure` | 不可重复扣费 | 同上（`tests/consume-measure.test.js` 护栏） |
| 价格口径 | 全局文案 | ¥9.9 = 一次测量（拍 3 张取中位数），不是"3 次包" | 文案改动需全局一致 |
| 面部隐私 | `measure.js cleanupCloudFile` + 云端删图 + 首测同意弹窗 | 合规承诺「识别完即删」 | 不得削弱 |
| dev 旁路 | `config.js dev.bypassPay` | 开着会绕过付费墙 | 上线前必须为 false |

## 6. 已知缺口 / 历史风险点

| 项 | 状态 | 说明 |
|---|---|---|
| 结果页统计逻辑零测试 | closed (2026-06-10) | 已抽到 `utils/result_stats.js` + `utils/lens_advice.js`，新增 16 个测试（result-stats/lens-advice.test.js） |
| 超 300 行文件 | open | `measure.js`(593，已从 714 减) `result.js`(556，已从 774 减) `vpayConfirm/index.js`(480，加了播报/流水号，近 500 红线，下次动它时把 httpPostJson 抽成独立 http 模块) `user.js`(388) `adminStats/helpers.js`(361，单一主题:统计/订单纯函数)。两个页面剩余均为页面级状态机+UI 处理，再拆收益递减 |
| `detectCard` 无调用方 | closed (2026-06-10) | 已删除代码与部署配置；线上函数待控制台手动删除 |
| `isNumber/roundToHalf` 三处重复定义 | open (减为 2 处) | result.js 已改用 pd.js 导出；user.js 仍有本地 isNumber |
| 镜框推荐永不渲染（地图-代码漂移） | closed (2026-06-10) | 已下线死 UI（删卡片+`calcFrameRecommendation`+onCopy 段落）。脸宽字段保留在记录 schema；如需复活，云端 `main.py` 补人脸宽度输出即可，旧实现在 git 历史 |
