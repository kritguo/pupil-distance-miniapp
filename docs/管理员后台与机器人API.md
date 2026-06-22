# 管理员后台与机器人 API

## 云函数环境变量

只在 `adminStats` 云函数配置，不要写进前端代码。

- `ADMIN_OPENIDS`: 管理员 openid，多个用英文逗号分隔。
- `ADMIN_API_TOKEN`: 机器人接口 token，建议用 32 位以上随机字符串。

未配置 `ADMIN_OPENIDS` 时，个人中心不会显示「管理员后台」入口。

## 需要部署的云函数

- `adminStats`: 管理员鉴权、后台统计、机器人 API。
- `logMeasureEvent`: 用户完成 3 张测量后记录 1 条测量会话。

本次统计会读取：

- `measureEvents`: 测量人数、测量次数、普通/精确模式占比。
- `orders`: 已支付订单、付费人数、收入。
- `users`: 用户总数、年度会员数、单次付费用户数。

`measureEvents` 是新增表，只有上线新版本后完成的测量才会进入这张表，历史测量无法反推。

## 外部调用方式（本环境 `cloud1-0gahgwwra45a0df3` = 微信原生云开发）

本环境在微信开发者工具的云开发控制台里**没有「HTTP访问服务」**，所以外部服务（如 Hermes 销售推送 Agent）**不走 HTTP 触发器 URL，走微信官方 `invokecloudfunction`**：

1. 拿 access_token（缓存 2 小时，过期再拿）：
   `GET https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=<APPID>&secret=<AppSecret>`
2. 调函数（参数放 body，名字与下文 query 参数一致）：
   `POST https://api.weixin.qq.com/tcb/invokecloudfunction?access_token=<token>&env=cloud1-0gahgwwra45a0df3&name=adminStats`
   body：`{"action":"getRecentPaidOrders","limit":50,"token":"<ADMIN_API_TOKEN>"}`
3. 返回 `{"errcode":0,"resp_data":"<JSON字符串>"}`，把 `resp_data` 再 `JSON.parse` 得到 `{ok:true,orders:[...]}`。

要点：鉴权 token 从 body 的 `token` 字段读（`action`/`limit`/`since` 同样从 body 读）；access_token IP 白名单若开启需把调用方出口 IP 加白名单（当前关闭，无需配）。轮询去重用 `orders[].outTradeNo`，首启把现有单标记为已播报、之后只播新单。

> 部署/访问这套环境的更多坑见记忆 `cetongju-cloud-deploy-access`。下面 `curl ... https://<HTTP触发器地址>` 的写法**仅当你另在腾讯云网页控制台配了 HTTP访问服务时**才适用；纯微信原生云开发用上面的 invokecloudfunction。

## 机器人调用（参数与返回字段，两种传输通用）

若已配 HTTP访问服务（否则参数同样适用于 invokecloudfunction 的 body）：

```bash
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  "https://<你的云函数HTTP触发器地址>?action=stats&days=7"
```

返回 JSON 里包含：

- `summaryText`: 可直接发给你的日报文本。
- `today.measurementUsers`: 今日测量人数。
- `today.measurementSessions`: 今日测量次数。
- `today.paidUsers`: 今日付费人数。
- `today.paidOrders`: 今日付费订单数。
- `today.revenueFen`: 今日收入，单位分。
- `today.newUsers`: 今日新增用户数（按 `users.createTime`）。
- `trend`: 近 7 天趋势（每天含 `newUsers`）。

## 订单明细：`action=getRecentPaidOrders`

读现有 `orders` 集合的已支付订单，按支付时间倒序，用于对账 / 补播 / 查历史。鉴权与 `stats` 相同（openid 或 `ADMIN_API_TOKEN`）。

```bash
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  "https://<HTTP触发器地址>?action=getRecentPaidOrders&since=2026-06-21T00:00:00+08:00&limit=50"
```

- `since`（可选）：ISO 字符串或毫秒时间戳，按 `payTime >= since` 过滤；不传则取最近的。
- `limit`（可选）：默认 50，最大 200。

返回 `orders[]`，每条含：`orderId`、`outTradeNo`、`transactionId`、`amountFen`/`amountYuan`、`status`、`plan`/`productId`、`channel`、`openid`、`paidAt`(ISO)/`paidAtMs`、`deliveryStatus`、`createTimeMs`。

> 这是明细接口，含 `openid`，务必只对带 token 的管理员调用方开放，别暴露给前端。

口径与字段说明：

- `since` 过滤与排序都按 `payTime`。正常支付链路发权益时必写 `payTime`，所以 paid 单都带；仅云控制台**手工补单**可能缺 `payTime`，那种单不会出现在本明细里（但仍计入 `stats` 汇总，因 stats 有 `payTime||updateTime||createTime` 兜底）。需要全口径对账时以 `stats` 汇总数为准。
- `transactionId` 是**尽力而为**的微信支付流水号（优先取 `wx_payment_order_id`），上线后请用真实 `query_order` 日志核对字段名再收敛；可能为空或为回显单号，仅供对账参考，勿当唯一支付凭证。

## 付费实时播报（vpayConfirm 环境变量）

在 **`vpayConfirm`** 云函数配环境变量后，每笔订单「首次发权益成功」会推一条到群机器人，做到「有人付费立刻知道」。不配则不播报，永不影响发权益。

- `PAY_NOTIFY_WEBHOOK`: 完整 webhook URL（企业微信群机器人 / Server酱 / 任意 URL）。
- `PAY_NOTIFY_TYPE`（可选）: `wecom` / `serverchan` / `text`。不填按 URL 域名自动识别（`qyapi.weixin.qq.com`→wecom，`ftqq.com`→serverchan，其它→text）。

播报文本只露 openid 后 6 位，不泄露完整身份。

> 注：测瞳距实际采用 **Hermes 轮询 `getRecentPaidOrders`** 方案（见上文 invokecloudfunction），未启用本 webhook 播报；本节代码已就绪，供日后需要「推模式」时启用。
