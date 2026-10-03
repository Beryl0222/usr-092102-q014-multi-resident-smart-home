# 多住户智能家居裁决后端

品牌无关的多住户智能家居**裁决后端**。它不直接控制任何具体品牌的设备，只对
"哪个抽象能力应当进入什么状态" 作出可解释、可审计的裁决并产出执行回执；真实硬件
由品牌适配层（实现 `adapter.dispatch`）落地。

## 它解决什么

同一房屋里多个人的自动化可能在同一时刻、对同一组设备提出相反要求：

- 凌晨漏水告警要求**立刻关阀**；
- 老人起夜，过道照明**不能突然熄灭**；
- 孩子**禁止摄像的时段**必须生效；
- 室友的节能规则正要切断同一组插座；
- 厂商云端按"最后一次设置覆盖"，断网恢复后还会**补执行已经过期的动作**。

本后端用一套确定性规则替代"最后写入覆盖"：

1. **优先级分层裁决**：安全处置(300) > 保护约束(200) > 舒适/节能(100)。
   同层级再看适用范围与既定顺序；同级且目标状态互斥时**不下发任何动作**，
   产出 `CONFLICT_DETECTED` 等待人工裁决，而不是猜一个结果。
2. **发布前静态分析**：规则发布时检测触发器→动作图中的**循环**（含振荡环、自环）
   与同层级**互斥动作**（保守的时段/空间可重叠判定），拒绝发布并返回结构化诊断。
3. **并发不覆盖**：每个聚合带版本号，提交走 CAS 乐观锁，版本不符即 `409`，
   调用方重读重试；设备事件按 `(aggregate_id, version)` 单调入库、`event_id` 幂等。
4. **采集一致同意**：开启 camera/voice/location 必须满足**所有受影响成员**
   （房间在住者）的生效同意；监护人可设置硬禁采时段（压过同意）；同意可撤回且
   **立即生效**；未成年人同意只能由监护人授予，范围不得超过其私人房间/设备。
5. **弱势成员保护**：夜间对需照护成员（如老人）房间的照明，若动作是无渐暗缓冲的
   突然关闭，自动合成保护约束保持现状（回执 `held`）。
6. **离线恢复重判**：设备离线时动作进入待执行队列并带有效期；恢复时重新判断
   规则/成员关系/同意/时段/触发条件是否仍成立——过期或条件消失的动作**绝不补执行**。
   安全动作持续到源告警解除，而非按固定 TTL 过期。
7. **控制权与数据交接**：搬家、换租、转售、云服务退出通过交接单完成：生效时点
   原子撤销旧住户访问、撤回其同意链、停用或移交其规则、作废在途动作；生活轨迹
   导出为凭令牌领取的去标识化数据包后从活动库与事件细节中清除，住房配置资产保留。
   **旧住户自交接生效起无法再访问设备。** 房东/物业/厂商不是数据主体，看不到生活回执。

## 目录

```
contracts/domain.schema.json  领域事件信封（含新增 DEVICE_OBSERVED 设备观测类型）
src/validator.js              信封校验
src/domain/
  constants.js                枚举：角色/优先级层级/采集能力/交接原因/回执结果
  time.js                     时段（跨午夜窗口）、夜间判定、可注入时钟
  store.js                    聚合存储 + append-only 事件流 + CAS + JSON 持久化
  registration.js             住房/房间/设备能力/人员/成员关系/同意/采集限制
  analysis.js                 发布前循环与互斥静态分析（Tarjan SCC + 时段重叠）
  rule-service.js             规则发布（发布前校验）与停用
  arbitration.js              裁决引擎：匹配→门禁→保护→分层→互斥→下发/排队/重判
  handover.js                 控制权与数据交接
  app.js                      装配层
src/server.js                 零依赖 HTTP API
bin/server.js                 启动入口
tests/                        node:test 测试（44 项）
data/sample.json              领域联调样例
```

## 运行

```bash
npm test          # 全部测试
npm start         # 启动 HTTP 服务（默认 :8080，ARBITRATION_PORT / ARBITRATION_DB 可配）
```

服务零第三方依赖，仅需 Node ≥ 20。`ARBITRATION_DB` 指向的 JSON 文件原子落盘，
删除即回到空库（演示用存储；生产可替换 `Store` 实现而不动领域代码）。

## 关键 API

| 方法 & 路径 | 说明 |
| --- | --- |
| `POST /residences` `/rooms` `/devices` `/persons` `/memberships` | 登记住房拓扑、抽象设备能力、人员与产权/租住关系 |
| `POST /consents` · `POST /consents/:id/withdraw` | 授予/撤回采集同意（带范围、时段、有效期） |
| `POST /restrictions` | 监护人采集限制（如孩子禁摄像时段，硬禁止优先于同意） |
| `POST /rules` | 发布规则；循环/互斥时返回 `422` 与诊断 |
| `POST /events` | 接收符合 `domain.schema.json` 的设备观测事件，返回裁决与回执 |
| `POST /overrides` · `/overrides/:id/cancel` | 居民临时覆盖（带 TTL），采集类覆盖同样过同意门禁 |
| `POST /handovers` · `/handovers/:id/effectuate` · `POST /handovers/run-due` | 预约/生效/扫描交接 |
| `POST /exports/:id/claim` | 旧住户凭交接令牌领取本人数据导出包 |
| `GET /receipts?residenceId=` | 回执查询（按角色收窄；`x-person-id` 标识请求居民） |
| `GET /events?residenceId=` | 审计事件流，只回信封与 `kind`，不回流生活细节 |

设备观测事件示例（信封字段以 schema 为准）：

```json
{
  "event_id": "leak-0001",
  "event_type": "DEVICE_OBSERVED",
  "aggregate_type": "device_capability",
  "aggregate_id": "leak-sensor-bath",
  "occurred_at": "2026-10-03T02:10:00+08:00",
  "version": 1,
  "summary": "卫生间漏水告警",
  "detail": { "kind": "sensor_alert", "alert": "water_leak" }
}
```

回执（`execution_receipt`）回答居民关心的三个问题：**为何执行**
（`priority.basis` + `explanation`）、**被谁压制**（`suppressedBy`）、
**怎样临时覆盖**（`overrideHint`）。

## 设计约束

- 设备只以抽象能力登记（`valve.shutoff`、`light`、`camera`、`power.outlet` …），
  品牌字段仅作适配层代号，不参与裁决。
- 不居住的房东、物业与厂商默认不是数据主体：不能发起采集，也查询不到生活回执。
- 裁决按住房键串行；写冲突走乐观锁重试，不靠"最后设置覆盖"。
- 时间全部经由可注入时钟获取，凌晨时段、离线恢复、预约交接均可确定性测试。
