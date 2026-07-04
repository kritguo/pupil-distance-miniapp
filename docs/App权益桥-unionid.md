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

## 边界与已知事项

- **绑定前一切休眠**：wxContext 没有 UNIONID → 不落库；appBridge 未配 env → `NO_CONFIG`。对现有小程序零影响。
- App 端测量结果目前**不回传**小程序（App 自己存）；只同步"权益"。要回传记录是另一期。
- 老用户需先打开一次新版小程序完成回填，才能在 App 登录成功（`NOT_LINKED` 的产品话术要写好）。
