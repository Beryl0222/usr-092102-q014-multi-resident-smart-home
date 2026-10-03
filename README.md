# 多住户智能家居裁决

多住户智能家居的**裁决后端**：不直接对接任何品牌协议，只对厂商中立的设备能力进行裁决。同一房屋里的安全告警、照护需求、隐私约束、舒适与节能偏好在这里按明确的优先级依据仲裁，每个决定都有执行回执，每位住户都能看到某次自动化为何执行、被谁压制、怎样临时覆盖。

## 设计要点

- **厂商中立**：设备以能力词汇表描述（`valve.actuate`、`light.set`、`camera.capture`、`sensor.leak` 等），裁决结果只记录期望状态，品牌协议由集成层落地。
- **优先级依据**：安全处置 > 隐私保护 > 照护需求 > 舒适偏好 > 节能偏好，类内再用 `rank` 排序。凌晨漏水关阀这类安全动作永远优先于室友的节能断电。
- **维持主张（maintain）**：规则可以在适用时段内形成持续主张——漏水期间阀门必须关闭、21:00–07:00 老人夜灯必须保持、孩子时段禁止摄像——与其冲突的低优先级动作被压制并记录。
- **采集约束**：摄像、语音、位置采集必须满足**所有受影响成员**的范围约束（同意 + 隐私时段）。未成年人的同意只能由监护人/产权人代授，不能创建规则与临时覆盖，其隐私时段不可被豁免。
- **可撤回同意与临时覆盖**：同意可随时撤回；成年住户可创建有时限的临时覆盖（`block` 压制非安全类规则/主张，`allow` 仅豁免本人的采集约束）。安全类动作不受覆盖影响。
- **并发安全**：所有聚合带版本号，更新必须携带期望版本，冲突返回 409——并发更新不会互相覆盖（区别于厂商云端的"最后一次写入获胜"）。
- **离线恢复不补执行**：设备离线时动作排队并设有效期；恢复时重新判断（是否过期、规则是否停用、时段是否已过、触发条件是否消失、同意与覆盖是否变化），过期动作标记 `expired` 绝不补执行。事件摄取按 `event_id` 幂等，断网重传不会重复触发。
- **交接**：搬家、换租、转售、云服务退出统一走 `control_transfer`：生效时刻起旧住户成员关系终止、同意撤回、个人偏好规则停用、数据打包封存（显示为「前住户」），新住户自生效时刻获得访问权；`cloud_exit` 额外解绑厂商云并将排队动作过期。
- **最小化视角**：居民可见完整裁决轨迹；房东/物业只能看到安全处置（时间粗化到小时）与设备健康；设备厂商只能看到能力级诊断计数——任何角色都借故拿不到完整生活轨迹。

## 目录

- `contracts/domain.schema.json`：领域事件信封及稳定枚举（新增 `TELEMETRY_REPORTED` 事件类型与 `control_transfer` 聚合类型，均为增量扩展）。
- `data/sample.json`、`data/telemetry.sample.json`：联调样例。
- `src/validator.js`：由契约文件驱动的事件校验。
- `src/windows.js`：每日重复时段（支持跨午夜）的包含与重叠判断。
- `src/store.js`：内存事件溯源存储，乐观并发控制，事件幂等摄取。
- `src/domain.js`：住房/房间/设备能力/成员角色/可撤回同意/隐私时段/权限。
- `src/rules.js`：规则模型、优先级依据、发布前循环与互斥检测。
- `src/arbitration.js`：裁决引擎（候选动作 + 维持主张）、临时覆盖、执行回执、离线恢复重判。
- `src/transfers.js`：控制权与数据交接。
- `src/privacy.js`：居民/房东/物业/厂商的视角化审计。
- `src/explain.js`：裁决解释与临时覆盖建议。
- `src/server.js`：HTTP API（`node:http`，零依赖）。

## 本地检查

```bash
npm test        # 运行全部测试
npm start       # 启动 HTTP 服务（默认 :8080）
```

## HTTP API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/residences` | 创建住房 |
| POST | `/residences/:rid/rooms` | 添加房间 |
| GET | `/residences/:rid` | 住房快照（房间/设备/成员/规则/覆盖） |
| POST | `/residences/:rid/devices` | 注册设备（能力词汇表） |
| POST | `/residences/:rid/memberships` | 添加成员（owner/tenant/resident/guest，未成年人需监护人） |
| POST | `/memberships/:mid/consents` | 授予采集同意（可限定房间与时段） |
| POST | `/memberships/:mid/consents/:cid/revoke` | 撤回同意 |
| POST | `/memberships/:mid/privacy-windows` | 设置个人隐私时段 |
| GET | `/memberships/:mid/access?at=` | 查询某时刻是否有访问权 |
| POST | `/residences/:rid/rules` | 创建规则（草稿） |
| POST | `/rules/:id/publish` | 发布（发布前检测循环与互斥；需 `expected_version`） |
| POST | `/rules/:id/retire` | 停用规则 |
| POST | `/residences/:rid/overrides` | 创建临时覆盖（block/allow，可定向规则） |
| POST | `/overrides/:id/cancel` | 取消临时覆盖 |
| POST | `/residences/:rid/events` | 摄取设备事件（须符合契约，`TELEMETRY_REPORTED`） |
| POST | `/residences/:rid/tick` | 触发指定时刻的计划规则（`{"now": "..."}`） |
| POST | `/devices/:id/connectivity` | 设备上下线；上线时对排队动作重新判断 |
| GET | `/residences/:rid/receipts` | 执行回执（可按 `status` 过滤） |
| GET | `/decisions/:id/explanation` | 裁决解释：为何执行、被谁压制、怎样临时覆盖 |
| GET | `/residences/:rid/audit?perspective=` | 视角化审计（resident/landlord/property/vendor） |
| GET | `/residences/:rid/events` | 领域事件日志 |
| POST | `/residences/:rid/transfers` | 发起交接（move_out/lease_change/resale/cloud_exit） |
| POST | `/transfers/:id/effectuate` | 到达生效时间后执行交接 |

## 安全边界说明

本仓库是领域后端骨架：HTTP 层用 `x-member-id` 请求头标识操作者以便演示权限与访问切断语义，设备事件通道（`/events`、`/connectivity`）假定由可信网关调用。生产部署时应替换为真实的成员认证、网关凭证与传输加密，领域内的权限检查（角色、未成年人、同意、交接切断）已在模块层强制执行，不依赖 HTTP 层。
