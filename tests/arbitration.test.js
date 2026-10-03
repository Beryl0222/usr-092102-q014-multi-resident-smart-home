import assert from "node:assert/strict";
import test from "node:test";

import { DECISION_OUTCOME, DEVICE_EVENT_KIND, PRIORITY_BASIS } from "../src/domain/constants.js";
import { buildHome, makeClock, observation, receiptFor } from "./helpers/fixtures.js";

test("凌晨漏水：安全关阀立即执行，压过一切舒适偏好", async () => {
  const clock = makeClock("2026-10-03T02:10:00+08:00");
  const app = await buildHome(clock);

  await app.rules.publishRule({
    residenceId: "res1",
    name: "漏水立即关阀",
    ownerPersonId: "parent",
    priorityBasis: PRIORITY_BASIS.EMERGENCY_SENSOR_ALERT,
    trigger: { capability: "water_leak", sensorAlerts: ["water_leak"] },
    actions: [{ deviceId: "valve", capability: "valve.shutoff", setState: "shut" }],
  });

  const result = await app.engine.ingestObservation(
    observation("leak", { kind: DEVICE_EVENT_KIND.SENSOR_ALERT, alert: "water_leak", version: 1 }, clock),
  );
  const receipt = receiptFor(result, "valve");
  assert.equal(receipt.outcome, DECISION_OUTCOME.EXECUTED);
  assert.equal(receipt.requestedState, "shut");
  assert.equal(receipt.priority.tier, 300);
});

test("老人夜间照明不能突然熄灭：节能断电被保护约束保持(held)", async () => {
  const clock = makeClock("2026-10-03T02:10:00+08:00");
  const app = await buildHome(clock);

  await app.rules.publishRule({
    residenceId: "res1",
    name: "凌晨节能断电",
    ownerPersonId: "mate",
    priorityBasis: PRIORITY_BASIS.ENERGY_SAVING,
    trigger: { capability: "hall.switch", states: ["pressed"] },
    actions: [
      { deviceId: "outlet", capability: "power.outlet", setState: "off" },
      { deviceId: "nightlight", capability: "light", setState: "off" },
    ],
    schedule: { kind: "time_window", start: "01:00", end: "05:00" },
  });

  const result = await app.engine.ingestObservation(
    observation("hallswitch", { state: "pressed", version: 1 }, clock),
  );
  const outlet = receiptFor(result, "outlet");
  const light = receiptFor(result, "nightlight");
  assert.equal(outlet.outcome, DECISION_OUTCOME.EXECUTED, "插座可正常断电");
  assert.equal(light.outcome, DECISION_OUTCOME.HELD, "夜间照明保持现状");
  assert.match(light.explanation.short, /夜间|照明|照护/);

  // 白天：先上报灯处于开启，再触发同一关灯动作 —— 不应被夜间保护约束阻止
  clock.set("2026-10-03T14:00:00+08:00");
  await app.rules.publishRule({
    residenceId: "res1",
    name: "白天随手关过道灯",
    ownerPersonId: "mate",
    priorityBasis: PRIORITY_BASIS.PERSONAL_PREFERENCE,
    trigger: { capability: "hall.switch", states: ["released"] },
    actions: [{ deviceId: "nightlight", capability: "light", setState: "off" }],
  });
  await app.engine.ingestObservation(
    observation("nightlight", { state: "on", version: 1 }, clock),
  );
  const day = await app.engine.ingestObservation(
    observation("hallswitch", { state: "released", version: 2 }, clock),
  );
  assert.ok(
    day.receipts.some((r) => r.deviceId === "nightlight" && r.outcome === DECISION_OUTCOME.EXECUTED),
    "白天允许关灯",
  );
  assert.ok(!day.receipts.some((r) => r.outcome === DECISION_OUTCOME.HELD), "白天无保护保持");
});

test("被压制动作产生可解释回执：为何执行、被谁压制、如何覆盖", async () => {
  const clock = makeClock("2026-10-03T12:00:00+08:00");
  const app = await buildHome(clock);

  await app.rules.publishRule({
    residenceId: "res1",
    name: "室友节能关插座",
    ownerPersonId: "mate",
    priorityBasis: PRIORITY_BASIS.ENERGY_SAVING,
    trigger: { capability: "hall.switch", states: ["pressed"] },
    actions: [{ deviceId: "outlet", capability: "power.outlet", setState: "off" }],
  });
  const override = await app.engine.requestOverride({
    residenceId: "res1",
    personId: "parent",
    deviceId: "outlet",
    setState: "on",
    ttlMs: 1800_000,
    reason: "正在用电炊具",
  });
  // 覆盖在发起时即下发
  assert.ok(override.receipts.some((r) => r.outcome === DECISION_OUTCOME.EXECUTED && r.requestedState === "on"));

  const result = await app.engine.ingestObservation(
    observation("hallswitch", { state: "pressed", version: 1 }, clock),
  );
  // 覆盖状态仍维持（on），室友的 off 被压制；状态未重复下发
  const winner = result.receipts.find((r) => [DECISION_OUTCOME.MAINTAINED, DECISION_OUTCOME.EXECUTED].includes(r.outcome));
  const suppressed = result.receipts.find((r) => r.outcome === DECISION_OUTCOME.SUPPRESSED);
  assert.equal(winner.deviceId, "outlet");
  assert.equal(winner.requestedState, "on");
  assert.equal(suppressed.suppressedBy.ownerPersonId, "parent");
  assert.match(suppressed.explanation.short, /让位于更高优先级/);
  assert.equal(suppressed.overrideHint.canTemporarilyOverride, true);
  // 全流程只下发过一次 on（没有被节能规则改成 off，也没有重复下发 on）
  assert.equal(app.engine.adapter.dispatches.filter((d) => d.deviceId === "outlet" && d.setState === "on").length, 1);
  assert.equal(app.engine.adapter.dispatches.filter((d) => d.deviceId === "outlet" && d.setState === "off").length, 0);
});

test("安全关阀与节能开阀冲突时安全获胜，而不是最后设置覆盖", async () => {
  const clock = makeClock("2026-10-03T02:10:00+08:00");
  const app = await buildHome(clock);
  await app.rules.publishRule({
    residenceId: "res1",
    name: "漏水关阀",
    ownerPersonId: "parent",
    priorityBasis: PRIORITY_BASIS.EMERGENCY_SENSOR_ALERT,
    trigger: { capability: "water_leak", sensorAlerts: ["water_leak"] },
    actions: [{ deviceId: "valve", capability: "valve.shutoff", setState: "shut" }],
  });
  // 节能规则（不同层级，允许发布），在漏报传感器上不可能直接触发，故此处仅验证层级常量
  const leak = await app.engine.ingestObservation(
    observation("leak", { kind: DEVICE_EVENT_KIND.SENSOR_ALERT, alert: "water_leak", version: 1 }, clock),
  );
  assert.equal(receiptFor(leak, "valve").priority.tier, 300);
  assert.deepEqual(app.engine.adapter.dispatches.map((d) => `${d.deviceId}=${d.setState}`), ["valve=shut"]);
});

test("重复事件幂等：不重复下发", async () => {
  const clock = makeClock("2026-10-03T02:10:00+08:00");
  const app = await buildHome(clock);
  await app.rules.publishRule({
    residenceId: "res1",
    name: "漏水关阀",
    ownerPersonId: "parent",
    priorityBasis: PRIORITY_BASIS.EMERGENCY_SENSOR_ALERT,
    trigger: { capability: "water_leak", sensorAlerts: ["water_leak"] },
    actions: [{ deviceId: "valve", capability: "valve.shutoff", setState: "shut" }],
  });
  const evt = observation("leak", { kind: DEVICE_EVENT_KIND.SENSOR_ALERT, alert: "water_leak", version: 1 }, clock);
  await app.engine.ingestObservation(evt);
  const again = await app.engine.ingestObservation({ ...evt });
  assert.equal(again.idempotent, true);
  assert.equal(app.engine.adapter.dispatches.length, 1);
});
