# App 权益桥（unionid）— 小程序会员/免费额度同步到 iOS App

目标：用户在小程序里付的钱（单次的免费精度复测额度 / 年度会员），在 PDgo iOS App 里用微信登录后能查到并核销。

一句话原理：小程序和 App 绑到**同一个微信开放平台账号**后，两边登录都能拿到同一个 `unionid`；云端 `users` 表落 `unionid`，App 凭它查权益/核销。

## 状态

- ✅ 云端半座桥已建好（本仓库）：unionid 落库 + `appBridge` 云函数（login / entitlement / redeemRetest）
- ⏳ 等 owner：微信开放平台绑定（下面第 1 步）
- ⏳ 等 App 端：接微信登录 OpenSDK + 调下面三个接口
- 🔒 绑定完成并端到端验证前，小程序/H5 文案**不承诺**「登录同步/免费」（有测试断言把关）

## 上线步骤（按顺序）

1. **开放平台绑定（owner，网页操作）**：open.weixin.qq.com → 账号中心 → 绑定「小程序」(wxb70011e77b4c76fc) 和「移动应用」(PDgo iOS App) 到同一开放平台账号。移动应用审核通过后拿到 **AppID/AppSecret（移动应用的，不是小程序的）**。
2. **部署云函数（IDE 右键「上传并部署」）**：`getEntitlement`、`vpayConfirm`（unionid 落库），新函数 `appBridge`。
3. **配 appBridge 环境变量**：
   - `OPEN_APP_ID` = 开放平台移动应用 AppID
   - `OPEN_APP_SECRET` = 移动应用 AppSecret
   - `BRIDGE_SESSION_SECRET` = 32 位以上随机串（会话票据签名密钥，自己生成）
4. **HTTP 网关加路由**：腾讯云 CloudBase 控制台 → HTTP 网关 → 添加路由 `/appBridge` → 云函数 `appBridge`（与 `/adminStats` 同一处配置）。
5. **（建议）数据库索引**：云开发控制台 → users 集合 → 给 `unionid` 建索引（App 查询走它）。
6. **回填生效**：绑定后用户打开一次新版小程序，`getEntitlement` 会把 unionid 写进他的 users 文档；付款时 `vpayConfirm` 也会写。老用户没打开过小程序前，App 登录会返回 `NOT_LINKED`。

## App 端接口契约（给 App 同学）

Base：`POST https://cloud1-0gahgwwra45a0df3-1394475227.ap-shanghai.app.tcloudbase.com/appBridge`，JSON body。

### ① 登录换权益
```json
{ "action": "login", "code": "<WeChat OpenSDK 授权返回的 code>" }
```
成功：
```json
{ "ok": true, "bridgeToken": "v1.xxx.1699999999.mac", "expiresAt": 1699999999,
  "status": "unlimited|single|single_used|none", "isUnlimited": true,
  "annualExpireAt": 0, "retestCredits": 1, "remainCount": 0 }
```
失败 code：`NOT_LINKED`（引导「先在微信打开 PDgo 小程序再回来」）/ `WX_OAUTH_FAIL`（code 无效/过期，重新拉起微信授权）/ `NO_UNIONID`（未完成开放平台绑定）/ `NO_CONFIG`。

### ② 查询权益（token 7 天有效，过期重新 login）
```json
{ "action": "entitlement", "bridgeToken": "..." }
```

### ③ 核销一次深度测量（测量完成时调）
```json
{ "action": "redeemRetest", "bridgeToken": "...", "redeemKey": "<App本次测量的唯一ID>" }
```
- 会员：`{ok:true, redeemed:true, reason:"annual"}`（不扣任何东西）
- 单次额度：`reason:"retest_credit"`，服务端 retestCredits −1（事务原子）
- 同一 `redeemKey` 重复调：`{ok:true, redeemed:false, reason:"already_redeemed"}`（幂等，网络重试安全）
- 没额度：`{ok:false, code:"NO_QUOTA"}` → App 引导回小程序购买

## 安全设计

- 移动应用 AppSecret 只在云函数环境变量，**不进 App 包**；code 换 unionid 在云端完成，客户端无法伪造他人身份。
- `bridgeToken` = HMAC-SHA256 无状态票据（unionid+过期时间），timingSafeEqual 校验，7 天过期。
- 核销幂等（appRedeems 去重，留最近 50 条）；日志只打 unionid 后 6 位。
- 管理员控制台补单不会把管理员的 unionid 写到目标用户（vpayConfirm 里仅本人付款才落）。

## App 端微信登录接入手册（给 iOS 开发照做）

### A. 微信开放平台（owner 网页操作，App 写代码前的前提）

1. 注册/登录 open.weixin.qq.com（开放平台账号，主体要与小程序一致或同企业）；完成**开发者资质认证**（约 ¥300，以页面为准）——移动应用审核的前提。
2. 管理中心 → 移动应用 → **创建移动应用**：名称与 App Store 一致（快速测瞳距PDgo）、简介、图标；iOS 平台信息填 **Bundle ID**（问 App 开发/App Store Connect 里看）和 **Universal Links**（见 B-0）。提交审核，一般 1~3 个工作日。
3. 审核通过 → 拿到**移动应用 AppID（wx 开头）+ AppSecret** → 填进云函数 `appBridge` 环境变量（OPEN_APP_ID / OPEN_APP_SECRET）。**AppSecret 绝不放进 App 工程。**
4. 管理中心 → 小程序 → **绑定小程序**（wxb70011e77b4c76fc，小程序管理员扫码确认）。绑定完成那一刻起，两边才共享 unionid，云函数里 wxContext.UNIONID 才有值。

### B. iOS 工程配置（App 开发做）

**B-0 Universal Link（微信 SDK 硬性要求）**：需要一个 HTTPS 域名放校验文件 `https://<域名>/.well-known/apple-app-site-association`（JSON，含 `appID = <TeamID>.<BundleID>`）。可用 pdgoeye.com（Universal Link 不要求备案，DNS+HTTPS 通即可）；等不及也可以先用 CloudBase 静态托管域名（把 TeamID+BundleID 发我，AASA 文件我可以直接传上去）。

**B-1 装 SDK**：CocoaPods `pod 'WechatOpenSDK-XCFramework'`（或官方最新分发方式）。

**B-2 Xcode 三处配置**：
- Info.plist → `LSApplicationQueriesSchemes` 加：`weixin`、`weixinULAPI`、`weixinURLParamsAPI`
- URL Types 加一条：URL Scheme = 移动应用 AppID（wx 开头那串）
- Signing & Capabilities → Associated Domains 加：`applinks:<你的UniversalLink域名>`

**B-3 代码骨架（Swift）**：
```swift
// 启动注册（AppDelegate didFinishLaunching）
WXApi.registerApp("wx移动应用AppID", universalLink: "https://<域名>/app/")

// 回调转交（AppDelegate / SceneDelegate 两处）
func application(_ app: UIApplication, open url: URL, options: ...) -> Bool {
  return WXApi.handleOpen(url, delegate: self)
}
func application(_ application: UIApplication, continue userActivity: NSUserActivity, ...) -> Bool {
  return WXApi.handleOpenUniversalLink(userActivity, delegate: self)
}

// 点「微信登录」
let req = SendAuthReq(); req.scope = "snsapi_userinfo"; req.state = UUID().uuidString
WXApi.send(req)

// 收回调：拿 code → 换权益（code 只用一次、5 分钟有效，立刻发给云端）
func onResp(_ resp: BaseResp) {
  guard let auth = resp as? SendAuthResp, auth.errCode == 0, let code = auth.code else { return }
  // POST https://cloud1-0gahgwwra45a0df3-1394475227.ap-shanghai.app.tcloudbase.com/appBridge
  // body: {"action":"login","code": code}
  // 成功 → 保存 bridgeToken(7天) + 展示权益(isUnlimited/retestCredits)
}
```

**B-4 业务时序**：
- 启动/进"我的" → 有 bridgeToken 就 `action=entitlement` 刷新权益；`TOKEN_EXPIRED` → 重新拉微信授权
- 深度测量**完成时** → `action=redeemRetest`，`redeemKey` 用本次测量的 UUID（重试安全，不会重复扣）
- `NOT_LINKED` → 文案：「请先在微信里打开 PDgo 小程序，再回来登录」
- `NO_QUOTA` → 引导回小程序购买（App 内不要出现购买入口，见 C-2）

### C. 两个容易踩的苹果坑（提前知道）

- **C-1 App Store 审核 4.8**：App 一旦加了微信登录这类第三方登录，苹果通常要求同时提供 **Sign in with Apple** 等隐私替代项。建议本次更新一并加上（Apple 登录只做独立账号，不同步小程序权益——两个入口文案区分清楚）。
- **C-2 IAP 红线**：App 里**不要**放"去小程序购买/任何指向微信支付的购买按钮或链接"——数字商品绕过内购是 3.1.1 拒审重灾区。App 只"读取并核销"已有权益；没额度时的文案写成中性的（如"暂无可用次数"），不要在 App 内导购。

### D. 联调验收顺序

1. 云函数三件套部署 + env + 网关路由 `/appBridge`（前文步骤 2~4）
2. 开放平台绑定完成后，**你自己打开一次小程序** → 云开发控制台 users 集合看你的文档出现 `unionid` 字段 = 回填生效
3. App 真机（模拟器没微信）微信登录 → 返回你的会员状态 = 登录链路通
4. App 测一次 → `redeemRetest` 返回 `redeemed:true` 且小程序"我的"里额度同步减少 = 全链路通

## 边界与已知事项

- **绑定前一切休眠**：wxContext 没有 UNIONID → 不落库；appBridge 未配 env → `NO_CONFIG`。对现有小程序零影响。
- App 端测量结果目前**不回传**小程序（App 自己存）；只同步"权益"。要回传记录是另一期。
- 老用户需先打开一次新版小程序完成回填，才能在 App 登录成功（`NOT_LINKED` 的产品话术要写好）。
