# DTR Coverage

Last updated: 2026-06-10

| Module ID | 模块 | Status | DTR Doc | 备注 |
|---|---|---|---|---|
| `MOD-01-MEASURE-RESULT-PAY` | 测量→结果→支付解锁主链路 | detailed | `DTR-01-measure-result-pay.md` | 页面/UI/动作/流程/API/数据/规则/测试已映射 |
| `MOD-02-MINE` | 个人中心（记录/权益展示/管理员入口） | mapped | — | 页面与 API 已知，关系未细化 |
| `MOD-03-ADMIN` | 管理后台（统计/补单） | mapped | — | 页面与 API 已知，关系未细化 |
| `MOD-04-ACTIVATE` | 卡密激活（暂未开放，决策保留） | mapped | — | 仅提示弹窗，无后端链路 |
| `MOD-05-MEASURE-EVENTS` | 测量埋点（logMeasureEvent → measureEvents） | mapped | — | 有测试 `tests/measure-log.test.js` `tests/log-measure-event.test.js` |
| `MOD-06-CLOUD-SERVICE` | 云托管测量服务（Python /v1/measure） | mapped | — | 验证工具见 `cloud-service/validation/` |
| `MOD-99-DETECTCARD` | detectCard 云函数（v2 卡片定位，已被 precision_pd.py 取代） | archived | — | 2026-06-10 已删除代码与部署配置；线上函数需在云开发控制台手动删除 |

Status 含义：`unmapped` 未入图 / `mapped` 已列页面与 API 但关系不全 / `detailed` 链路关系已写明 / `archived` 仅存档。
