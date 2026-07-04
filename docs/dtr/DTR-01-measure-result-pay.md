# DTR-01-measure-result-pay（测量→结果→支付解锁主链路）

Status: detailed
Last updated: 2026-07-04 (v22: iOS 精度复测改为 App 深度相机纯引导——unionid 权益桥建好前不承诺免费/登录同步；首页复测弹窗按平台分支；「请稍候」错别字修正)

## 1. 模块边界

负责：

- 首页进入测量（全平台一律直接进普通拍照，零弹窗；免费复测额度由服务端解锁时自动优先抵扣；不展示普通/精确前置选择）
- 测量页：默认拍照 3 连拍 → 云端虹膜测量 → 质量门控/逃生阀 → 写入批次（不呈现模式选择胶囊/弹层；快门上方常驻白色引导，拍完一张后持续显示继续拍提示；显式 `mode=precision` 仅由结果页精度复测入口进入，并只显示“卡片精准测量”状态）
- 结果页：中位数推荐、波动点阵、PD 常见范围合理性提示、镜片建议、付费解锁、精度复测邀请与额度发放；iOS 用户进入 App 下载 web-view 承接页（统计与镜片规则在 `utils/result_stats.js` / `utils/lens_advice.js`；镜框推荐已于 2026-06-10 下线——云端不产出脸宽）
- 支付：虚拟支付下单签名 → 拉起 → 查单确权 → 权益同步

不负责：

- 个人中心记录的展示与删除（MOD-02）
- 管理后台统计/补单（MOD-03）
- 测量埋点的服务端聚合（MOD-05）

## 2. 节点

| ID | 类型 | 名称 | 位置 | 备注 |
|---|---|---|---|---|
| `MOD-01-MEASURE-RESULT-PAY` | module | 主链路 | 本文档 | 模块根 |
| `PAGE-INDEX` | page | 测量首页 | `pages/index` | tab 入口 |
| `PAGE-MEASURE` | page | 测量页 | `pages/measure` | 3 连拍会话；precision 复用卡片拍照屏 |
| `PAGE-RESULT` | page | 结果页 | `pages/result` | 中位数+建议+付费墙 |
| `PAGE-APP-DOWNLOAD` | page | iOS App 下载页 | `pages/app-download` + `web/app-download/index.html` | 小程序 web-view 承接 H5 下载页；H5 负责 App Store 下载与可选打开 App |
| `UI-INDEX-START` | UI | 开始测量按钮 | `pages/index/index.wxml` | 触发 onStart |
| `UI-INDEX-MEMBER-STATUS` | UI | 首页会员状态标识 | `pages/index/index.wxml` | 仅年度会员/不限次数生效时显示；普通用户、单次购买、免费精度复测不显示 |
| `UI-INDEX-PRICING-DETAIL` | UI | 结果解锁价格详情入口 | `pages/index/index.wxml` | 首页弱提示，点击「查看详情」从底部拉起价格说明抽屉，不直接拉起支付 |
| `UI-MEASURE-SHUTTER` | UI | 快门按钮 | `pages/measure/measure.wxml` | 触发 takePhoto |
| `UI-RESULT-PAY` | UI | 付费弹窗（单次/年度） | `pages/result/result.wxml` | × 可真实关闭（2026-06-10 起），默认选中 single；标题下展示已测可信度 |
| `UI-RESULT-UNLOCK-BAR` | UI | 未付费吸底解锁栏「¥9.9 解锁本次结果」 | `pages/result/result.wxml` | 弹窗收起后常驻，触发 openPayModal |
| `UI-RESULT-PRECISION-INVITE` | UI | 付费后精度复测邀请 | `pages/result/result.wxml` | iOS 为 App 深度相机纯引导（不承诺免费/同步）；安卓/其他走卡片精度复测；标题按可信度分级加强；不再展示普通重测话术 |
| `UI-APP-DOWNLOAD-WEBVIEW` | UI | App 下载 web-view | `pages/app-download/app-download.wxml` | 加载配置的 H5 下载页；未配置时显示搜索兜底 |
| `UI-APP-DOWNLOAD-H5` | UI | H5 下载承接页 | `web/app-download/index.html` | 按 single/annual 显示权益，提供 App Store 下载，可选 wx-open-launch-app 打开已安装 App |
| `ACT-INDEX-START` | action | 进入测量 | `pages/index/index.js onStart` | 全平台直接进普通测量，零弹窗（owner 决策：引导只留结果页数字下方小卡片）；免费额度服务端自动优先抵扣 |
| `ACT-INDEX-PRICING-DETAIL` | action | 查看结果解锁说明 | `pages/index/index.js onPricingDetail` | 打开底部抽屉说明单次/年度价格；不进入测量 |
| `ACT-MEASURE-SHOT` | action | 拍一张并测量 | `pages/measure/measure.js takePhoto→preparePhoto` | 串 token 防并发/超时 |
| `ACT-RESULT-PAY` | action | 确认支付 | `pages/result/result.js onPay` | plan: single/annual |
| `ACT-RESULT-PRECISION-RETEST` | action | 精度复测 | `pages/result/result.js onPrecisionRetest` | iOS 直达 App 下载页（无额度前置校验、无阻断弹窗）；安卓/其他本地先保额度+后台补发，进入 `mode=precision` |
| `ACT-APP-DOWNLOAD-STORE` | action | 前往 App Store | H5 下载页 / fallback 提示 | App Store 下载由 H5 承接；小程序 fallback 只提示搜索关键词 |
| `FLOW-MEASURE-SESSION` | flow | 3 连拍会话 | `measure.js requestAutoMeasureServer→applyCloudPdResult→commitShot→finishSession` | 质量门控+逃生阀 |
| `FLOW-RESULT-UNLOCK` | flow | 结果解锁判定 | `result.js initEntitlement→checkPayStatus` | 会员/历史/单次/付费墙四分支 |
| `FLOW-PURCHASE` | flow | 购买 | `utils/pay.js purchase` | vpaySign→requestVirtualPayment→vpayConfirm(重试) |
| `FLOW-RETEST-GRANT` | flow | 精度复测额度发放 | `result.js maybeGrantRetest` / `grantPrecisionRetestInBackground` | 普通付费结果赠送 1 次；精度复测中/低继续发，精度复测高则停止；安卓点击时本地 prime + 后台补发 |
| `API-MEASURE` | API | 测量服务 | 云托管 `POST /v1/measure`（`cloud-service/main.py`） | container 走云存储中转，http 直传 |
| `API-HEALTH` | API | 预热 | 云托管 `GET /health` | onLoad 即预热 |
| `API-CONSUME` | API | 扣次/解锁 | `cloudfunctions/consumeMeasure` | 幂等 |
| `API-ENTITLEMENT` | API | 权益查询 | `cloudfunctions/getEntitlement` | |
| `API-VPAY-SIGN` | API | 下单签名 | `cloudfunctions/vpaySign` | 金额以服务端为准 |
| `API-VPAY-CONFIRM` | API | 查单确权 | `cloudfunctions/vpayConfirm` | 发放权益 |
| `API-GRANT-RETEST` | API | 精度复测额度 | `cloudfunctions/grantRetest` | |
| `API-LOG-EVENT` | API | 会话埋点 | `cloudfunctions/logMeasureEvent` | fire-and-forget |
| `DATA-USERS` | data | 用户权益 | 云 `users` 集合 | 权益真值 |
| `DATA-ORDERS` | data | 订单 | 云 `orders` 集合 | |
| `DATA-EVENTS` | data | 埋点 | 云 `measureEvents` 集合 | |
| `STORE-USER` | store | 权益缓存+批次+记录 | 本地 `pd_user_info` | trialBatch/singleBatch/unlimitedSession |
| `STORE-LATEST` | store | 最近一次结果 | 本地 `latestResult` | 结果页入参 |
| `STORE-CONSENT` | store | 面部数据同意 | 本地 `pd_face_consent` | 首测前必须同意 |
| `RULE-SERVER-TRUTH` | rule | 权益真值在服务端 | `utils/user.js` 头注释 | 本地仅离线兜底 |
| `RULE-CONSUME-IDEMPOTENT` | rule | 扣次幂等 | `consumeMeasure` | 同一结果时间戳不重复扣 |
| `RULE-PRICE-SEMANTICS` | rule | ¥9.9=一次测量(3 张取中位数) | 全局文案 | 不是"3 次包" |
| `RULE-PD-RANGE` | rule | 瞳距 50–80mm 范围外硬性重拍 | `measure.js applyCloudPdResult` | 绝不污染中位数 |
| `RULE-MEASURE-FRAME-DISTANCE` | rule | 普通模式照片需脸部完整入框且距离合适 | 云托管 `validate/assess_quality` + `measure.js getCloudAutoQualityIssue` | 微信端不精确报厘米；用脸框/虹膜像素做保守质量门控，明显太近/太远/裁切则重拍 |
| `RULE-RESULT-PD-PLAUSIBILITY` | rule | 结果可信度需同时看稳定性与常见范围 | `utils/result_stats.js` | 三张稳定只代表一致；总 PD 56–68 才属于常见高可信区，54–56/68–70 最高「中」，50–54/70–75 或更极端最高「低」 |
| `RULE-ESCAPE-VALVE` | rule | 连续 3 次不达标才允许低可信度放行 | `measure.js` ESCAPE_AFTER_FAILS | 防卡死 |
| `RULE-PHOTO-DELETE` | rule | 照片识别完即删 | `utils/measure_request.js cleanupCloudFile` + 云端 | 前端先压缩再临时上传识别，识别后删除云存储临时照片；有测试断言（measure-transport.test.js） |
| `RULE-FACE-CONSENT` | rule | 首测前面部数据同意 | `measure.js ensureFaceConsent` | 不同意则退出 |
| `RULE-PRECISION-MODE-OFF` | rule | 普通/精确前置选择关闭 | `utils/measure_mode.js` | `PRECISION_MODE_ENABLED=false`；测量页不呈现模式胶囊/模式弹层，首页默认普通拍照；precision 页只显示“卡片精准测量”状态 |
| `RULE-PRECISION-RETEST` | rule | 付费后邀请式精度复测 | `result.js` + `measure_mode.js` | `PRECISION_RETEST_ENABLED=true`；显式 `mode=precision` 保留给结果页复测入口；普通首测解锁后也邀请复测 |
| `RULE-IOS-APP-DOWNLOAD` | rule | iOS App 下载承接 | `pages/app-download` + `config.appDownload` | 小程序先进入 web-view 下载页，H5 再引导 App Store；承接文案只讲深度相机卖点，unionid 桥建好前不承诺免费/登录同步（H5 改后需重新发布静态托管）；当前运行地址为 CloudBase 临时域名，pdgoeye.com 备案解析后切正式域名 |
| `RULE-MEASURE-CAPTURE-GUIDE` | rule | 拍照引导稳定显示 | `pages/measure/measure.*` | 快门上方常驻白色引导；拍完 1/2 张后不自动消失，直到下一次拍照或重拍；卡片精准测量顶部进度需下移避开微信胶囊；卡片未识别不弹阻断窗，改为页内提示；处理中统一说“正在分析，请稍候”，不向用户暴露上传/云端等技术词 |
| `RULE-DEV-BYPASS-OFF` | rule | 上线 dev.bypassPay 必须 false | `config.js` | 否则绕过付费墙 |
| `RULE-TRUST-EVIDENCE` | rule | 未付费：可信度与波动点阵形状可见；一切 PD 数值打码 | `result.wxml` | 给质量证据但不泄答案（PD 仅 50–80mm，露任何数位≈送答案） |
| `TEST-SUITE` | test | `npm test`（127 用例） | `tests/*.test.js` | 2026-07-04 全绿 |
| `TEST-CONSUME` | test | 扣次幂等回归 | `tests/consume-measure.test.js` | |
| `TEST-VPAY-CONFIRM` | test | 确权回归 | `tests/vpay-confirm.test.js` | |
| `TEST-MEASURE-PAGE` | test | 测量页精确/UI/请求/传输回归 | `tests/measure-page-*.test.js` `tests/measure-request.test.js` `tests/measure-transport.test.js` | 传输层含「用完即删」断言 |
| `TEST-RESULT-PAYWALL` | test | 付费墙与精度复测邀请回归（真关闭/解锁栏/可信度可见/默认 single/不走普通重测） | `tests/result-page-paywall.test.js` | 覆盖付费后精度复测邀请 |
| `TEST-RESULT-STATS` | test | 中位数/波动/镜片规则回归（16 用例） | `tests/result-stats.test.js` `tests/lens-advice.test.js` | 2026-06-10 补齐（逻辑抽到 utils 后可测） |

## 3. 关系

```text
PAGE-INDEX
  contains -> UI-INDEX-START
  contains -> UI-INDEX-MEMBER-STATUS
  contains -> UI-INDEX-PRICING-DETAIL
UI-INDEX-START
  triggers -> ACT-INDEX-START
UI-INDEX-PRICING-DETAIL
  triggers -> ACT-INDEX-PRICING-DETAIL
ACT-INDEX-PRICING-DETAIL
  opens -> UI-INDEX-PRICING-DETAIL (bottom sheet)
ACT-INDEX-START
  navigates_to -> PAGE-MEASURE   (mode=normal, forcePurchase 可选；无前置模式选择)

PAGE-MEASURE
  contains -> UI-MEASURE-SHUTTER
  guards   -> RULE-FACE-CONSENT
  guards   -> RULE-PRECISION-MODE-OFF
  guards   -> RULE-PRECISION-RETEST
  guards   -> RULE-MEASURE-CAPTURE-GUIDE
  calls    -> API-HEALTH          (onLoad 预热)
UI-MEASURE-SHUTTER
  triggers -> ACT-MEASURE-SHOT
ACT-MEASURE-SHOT
  enters_flow -> FLOW-MEASURE-SESSION
FLOW-MEASURE-SESSION
  calls  -> API-MEASURE
  guards -> RULE-PD-RANGE
  guards -> RULE-MEASURE-FRAME-DISTANCE
  guards -> RULE-RESULT-PD-PLAUSIBILITY
  guards -> RULE-ESCAPE-VALVE
  guards -> RULE-PHOTO-DELETE
  writes -> STORE-USER            (trial/single/unlimited 批次)
  writes -> STORE-LATEST
  calls  -> API-LOG-EVENT
  covered_by -> TEST-MEASURE-PAGE
FLOW-MEASURE-SESSION
  navigates_to -> PAGE-RESULT

PAGE-RESULT
  reads -> STORE-LATEST
  enters_flow -> FLOW-RESULT-UNLOCK
FLOW-RESULT-UNLOCK
  calls  -> API-ENTITLEMENT
  calls  -> API-CONSUME
  guards -> RULE-SERVER-TRUTH
  guards -> RULE-CONSUME-IDEMPOTENT
  writes -> STORE-USER            (解锁标记/记录)
  covered_by -> TEST-CONSUME
FLOW-RESULT-UNLOCK
  contains -> UI-RESULT-PAY       (未解锁分支)
  contains -> UI-RESULT-UNLOCK-BAR (弹窗收起后)
  contains -> UI-RESULT-PRECISION-INVITE (已解锁分支)
  guards   -> RULE-TRUST-EVIDENCE
UI-RESULT-UNLOCK-BAR
  triggers -> UI-RESULT-PAY       (openPayModal 重新打开)
UI-RESULT-PAY
  covered_by -> TEST-RESULT-PAYWALL
  triggers -> ACT-RESULT-PAY
ACT-RESULT-PAY
  enters_flow -> FLOW-PURCHASE
UI-RESULT-PRECISION-INVITE
  triggers -> ACT-RESULT-PRECISION-RETEST
ACT-RESULT-PRECISION-RETEST
  enters_flow -> FLOW-RETEST-GRANT
  navigates_to -> PAGE-MEASURE    (Android/其他 mode=precision)
  navigates_to -> PAGE-APP-DOWNLOAD (iOS)
PAGE-APP-DOWNLOAD
  contains -> UI-APP-DOWNLOAD-WEBVIEW
UI-APP-DOWNLOAD-WEBVIEW
  contains -> UI-APP-DOWNLOAD-H5
UI-APP-DOWNLOAD-H5
  triggers -> ACT-APP-DOWNLOAD-STORE
FLOW-PURCHASE
  calls  -> API-VPAY-SIGN
  calls  -> API-VPAY-CONFIRM
  writes -> DATA-ORDERS
  writes -> DATA-USERS
  guards -> RULE-PRICE-SEMANTICS
  covered_by -> TEST-VPAY-CONFIRM

FLOW-RETEST-GRANT
  calls  -> API-GRANT-RETEST
  writes -> DATA-USERS
  covered_by -> TEST-SUITE        (tests/pay.test.js 部分覆盖)

结果页统计(utils/result_stats + utils/lens_advice)
  covered_by -> TEST-RESULT-STATS
```

## 4. 行为契约

- `RULE-SERVER-TRUTH`：status/remainCount/retestCredits/annualExpireAt 以服务端 users 为准；本地 `pd_user_info` 只做离线兜底与 UI 状态。
- `RULE-CONSUME-IDEMPOTENT`：同一结果时间戳重复 consume 不得重复扣次（网络异常回退本地判断）。
- `RULE-PRICE-SEMANTICS`：所有文案 ¥9.9 = 一次测量（含 3 张取中位数）。
- `RULE-PD-RANGE`：总 PD <50 或 >80mm 视为检测错误，硬性重拍，不入会话；连续 3 次给排查建议+返回出口。
- `RULE-MEASURE-FRAME-DISTANCE`：微信小程序普通模式没有真实深度数据，不宣称测出或要求精确 50cm；前端只提示“约一臂距离”，云端只做低档质量门控：脸部需完整入框，脸框/虹膜像素不能明显太近或太远，不合格自动重拍。
- `RULE-RESULT-PD-PLAUSIBILITY`：结果页可信度不是只看三张是否稳定；总 PD 56–68mm 才允许按稳定性给「高」，54–56/68–70mm 最高「中」，50–54/70–75mm 及更极端最高「低」并提示重测/验光。
- `RULE-ESCAPE-VALVE`：质量不达标自动打回；连续 ≥3 次允许「较低可信度」放行，可信度强制记「低」。
- `RULE-PHOTO-DELETE` + `RULE-FACE-CONSENT`：合规承诺，不得削弱。微信端拍完后先压缩照片，再用云存储临时链接/HTTP base64 交给测量服务识别；云存储中转文件必须在识别完成或请求失效后删除，不留存原图。
- `RULE-PRECISION-MODE-OFF`：普通/精确前置选择关闭；测量页不展示普通/精确模式选择、不展示模式弹层，首页默认进入普通拍照 3 连拍；安卓/其他通过精度复测进入时复用卡片拍照屏，顶部只显示“卡片精准测量”状态。
- `RULE-PRECISION-RETEST`：精度复测是付费后邀请式入口，普通结果无论可信度高低都展示邀请卡（中/低时标题与按钮文案加强）。普通首测付费解锁后服务端赠送 1 次精度复测额度；精度复测结果仍为「中/低」继续赠送，直到测出「高」（对单次用户，精度「高」后邀请卡消失；会员始终可见）。邀请卡只显示当前已付权益的一张，不得做成单次/年度二选一。**安卓/其他**：小程序内用身份证/银行卡卡片辅助校验，显示「免费复测 1 次/会员不限次」，点击直接进卡片精准拍照页，不因额度云端同步慢或失败弹窗阻断（本地先保留 1 次额度，服务端在结果解锁时最终校验/扣减；若后台补发失败导致解锁 NO_QUOTA，结果页自动用上一条已解锁结果幂等补发并重试一次，仍失败才出付费墙——用户不会拍完 3 张才无路可走）。**iOS**：邀请卡为 PDgo App 深度相机**纯引导**（卖点=iPhone 深度相机更精准），点击直达 App 下载承接页，无额度前置校验、无阻断弹窗；unionid 权益桥建好前**不承诺免费或微信登录同步**（测试断言把关）。**首页全平台零弹窗**：有额度直接进普通测量并自动抵扣。**防无限免费循环**——用复测额度解锁的普通结果不再自动续送（maybeGrantRetest 按 consume reason=retest_credit 拦截；精度结果不受限，中/低照常续送到高）。已接受的残余风险：极端用户可循环「结果页点卡片复测(触发服务端补发)→退出→回首页普通测」每轮薅一次免费普通测量——每轮需真实拍 3 张成本高，暂接受；如出现滥用，在服务端 grantRetest 按 creditFunded+reason 加护栏。
- `RULE-IOS-APP-DOWNLOAD`：iOS 不在小程序里直接跳 App Store；结果页按钮先进入 `PAGE-APP-DOWNLOAD`，由 web-view H5 承接“前往 App Store”和搜索兜底。H5 模板在 `web/app-download/index.html`，当前运行 URL 为 `https://cloudbase-4ghz65bm0b8770cd-1373927964.tcloudbaseapp.com/app-download/index.html`（已部署可访问）；正式目标 URL 为 `https://pdgoeye.com/app-download/index.html`，但 `pdgoeye.com` 需备案通过、DNS/HTTPS 生效并配置到小程序后台业务域名后才能切换。App Store 地址为 `https://apps.apple.com/cn/app/%E5%BF%AB%E9%80%9F%E6%B5%8B%E7%9E%B3%E8%B7%9Dpdgo/id6778687480`。若要在微信内网页直接打开已安装 App，还需按微信开放标签规则配置已认证服务号 JS 接口安全域名、开放平台移动应用绑定、App OpenSDK 与 JS-SDK 签名接口。
- `RULE-MEASURE-CAPTURE-GUIDE`：快门上方常驻白色引导。未拍前显示“对准后点击拍照”；拍完第 1/2 张后显示“已拍 x/3，请继续拍下一张”，不做 2 秒后自动消失，也不再叠加底部“三张”说明。卡片精准测量顶部进度单独下移，不能贴近或压到微信胶囊区域；卡片未识别、边缘不清或卡片/虹膜差异过大时，先在快门上方给页内重拍提示，不弹大模态打断；卡片模式下普通质量问题（脸不正/双眼不平等）前 2 次同样页内提示、第 3 次起才进逃生阀弹窗（保留「仍要使用」救济）；卡片连续 5 次未识别时提示可点左上角返回；处理中只给用户看“正在分析，请稍候”，不出现上传、云端识别等技术词。
- `RULE-DEV-BYPASS-OFF`：上线前 `config.js dev.bypassPay` 必须为 false。

## 5. 数据映射（关键字段）

| 字段 | 来源 | 写入方 | 读取方 | 备注 |
|---|---|---|---|---|
| `result.timestamp` | 拍摄完成时刻 | `measure.js commitShot` | 结果页解锁键 / 记录去重键 | 解锁幂等的身份键 |
| `users.remainCount` | 服务端 | vpayConfirm / consumeMeasure | getEntitlement → 本地缓存 | 单次用户次数 |
| `users.retestCredits` | 服务端 | grantRetest | consumeMeasure 优先消耗 | 免费精度复测 |
| `pd_user_info.trialBatch/singleBatch/unlimitedSession` | 本地 | measure/result 页 | result 页取中位数 | 三种批次互斥使用 |

## 6. 修改流程

改本模块前必读：

1. `docs/FUNCTION_MAP.md`（含受保护边界）
2. 本文档
3. 相关源文件（先读后改，最小改动）

改完：`npm test` 必须全绿；行为变化同步更新本文档与 FUNCTION_MAP。

## 7. 回归检查

- `npm test`：133 用例全绿（基线 2026-07-05）。
- 手动冒烟：未付费拍 3 张 → 出付费墙（默认 single，可 × 收起）→ 收起后见打码报告+吸底解锁栏 → 支付 → 解锁并入个人中心 → 出现精度复测邀请；iOS 进入 App 下载 web-view 页，安卓/其他进入卡片精度复测；精度结果中/低继续给免费精度复测，高则停止续发。
- 改中位数/镜片规则 → 跑 `tests/result-stats.test.js` `tests/lens-advice.test.js`。
