import assert from "node:assert/strict";
import test from "node:test";

import {
  AGE_CLASS,
  DECISION_OUTCOME,
  EVENT_TYPE,
  PRIORITY_BASIS,
  RESIDENCE_ROLES,
  TRANSFER_REASON,
} from "../src/domain/constants.js";
import { buildHome, makeClock, observation, receiptFor } from "./helpers/fixtures.js";

test("房东不能借普通自动化控制屋内非采集设备", async () => {
  const clock = makeClock("2026-10-03T12:00:00+08:00");
  const app = await buildHome(clock);
  await app.registration.registerPerson({ personId: "lord", name: "房东", ageClass: AGE_CLASS.ADULT });
  await app.registration.addMembership({
    residenceId: "res1", personId: "lord", role: RESIDENCE_ROLES.LANDLORD, occupiesRooms: [],
  });
  await app.rules.publishRule({
    residenceId: "res1",
    name: "房东远程断电",
    ownerPersonId: "lord",
    priorityBasis: PRIORITY_BASIS.ENERGY_SAVING,
    trigger: { capability: "hall.switch", states: ["pressed"] },
    actions: [{ deviceId: "outlet", capability: "power.outlet", setState: "off" }],
  });
  const result = await app.engine.ingestObservation(
    observation("hallswitch", { state: "pressed", version: 1 }, clock),
  );
  const receipt = result.receipts.find((r) => r.priority.ownerPersonId === "lord");
  assert.equal(receipt.outcome, DECISION_OUTCOME.DENIED_AUTHZ);
  assert.deepEqual(app.engine.adapter.dispatches, []);
});

test("两个居民对同一设备先后提出相反覆盖：第二次即挂起冲突，不下发相反状态", async () => {
  const clock = makeClock("2026-10-03T12:00:00+08:00");
  const app = await buildHome(clock);
  const first = await app.engine.requestOverride({
    residenceId: "res1", personId: "parent", deviceId: "outlet", setState: "on", ttlMs: 600_000, reason: "做饭",
  });
  assert.ok(first.receipts.some((r) => r.outcome === DECISION_OUTCOME.EXECUTED && r.requestedState === "on"));

  const second = await app.engine.requestOverride({
    residenceId: "res1", personId: "mate", deviceId: "outlet", setState: "off", ttlMs: 600_000, reason: "省电",
  });
  assert.ok(second.receipts.every((r) => r.outcome === DECISION_OUTCOME.CONFLICT), "相反覆盖应标记冲突");
  // 已下发的 on 不被冲销，但也不会下发 off
  assert.deepEqual(app.engine.adapter.dispatches.map((d) => d.setState), ["on"]);

  // 随后无关事件复用同一未决冲突，不重复制造冲突事件
  await app.engine.ingestObservation(
    observation("hallswitch", { state: "pressed", version: 1 }, clock),
  );
  const conflicts = app.store.events.filter((e) => e.event_type === EVENT_TYPE.CONFLICT_DETECTED);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].detail.states.sort(), ["off", "on"]);
});

test("规则作者搬走后其规则不再驱动设备（成员关系门禁）", async () => {
  const clock = makeClock("2026-10-03T12:00:00+08:00");
  const app = await buildHome(clock);
  await app.registration.registerPerson({ personId: "newowner", name: "新业主", ageClass: AGE_CLASS.ADULT });
  await app.rules.publishRule({
    residenceId: "res1",
    name: "室友断电",
    ownerPersonId: "mate",
    priorityBasis: PRIORITY_BASIS.ENERGY_SAVING,
    trigger: { capability: "hall.switch", states: ["pressed"] },
    actions: [{ deviceId: "outlet", capability: "power.outlet", setState: "off" }],
  });
  await app.handovers.scheduleHandover({
    residenceId: "res1",
    reason: TRANSFER_REASON.MOVE_OUT,
    requestedByPersonId: "parent",
    outgoingPersonIds: ["mate"],
    successorPersonId: "newowner",
    successorRole: RESIDENCE_ROLES.OWNER,
  });
  const result = await app.engine.ingestObservation(
    observation("hallswitch", { state: "pressed", version: 1 }, clock),
  );
  assert.deepEqual(app.engine.adapter.dispatches, [], "搬走者的规则不应再产生控制");
  assert.ok(!result.receipts.some((r) => r.outcome === DECISION_OUTCOME.EXECUTED));
});

test("云服务退出后设备观测事件细节一并脱敏，不残留生活轨迹", async () => {
  const clock = makeClock("2026-10-03T12:00:00+08:00");
  const app = await buildHome(clock);
  await app.engine.ingestObservation(
    observation("hallswitch", { state: "pressed", version: 1 }, clock),
  );
  await app.handovers.scheduleHandover({
    residenceId: "res1",
    reason: TRANSFER_REASON.CLOUD_EXIT,
    requestedByPersonId: "parent",
    outgoingPersonIds: ["parent"],
  });
  const obsEvents = app.store.events.filter((e) => e.event_type === EVENT_TYPE.DEVICE_OBSERVED && e.aggregate_id === "hallswitch");
  assert.ok(obsEvents.length > 0);
  for (const e of obsEvents) {
    assert.equal(e.detail.redacted, true, "观测细节应被脱敏墓碑替代");
    assert.equal(e.detail.state, undefined, "原始状态不应残留");
  }
});

test("访客只能看到本人占用房间的回执，看不到全屋", async () => {
  const clock = makeClock("2026-10-03T12:00:00+08:00");
  const app = await buildHome(clock);
  await app.registration.registerPerson({ personId: "guest", name: "访客", ageClass: AGE_CLASS.ADULT });
  await app.registration.addMembership({
    residenceId: "res1", personId: "guest", role: RESIDENCE_ROLES.GUEST, occupiesRooms: ["living"],
    validUntil: "2026-10-04T12:00:00+08:00",
  });
  await app.rules.publishRule({
    residenceId: "res1",
    name: "家长关阀类（产生卫生间回执）",
    ownerPersonId: "parent",
    priorityBasis: PRIORITY_BASIS.EMERGENCY_SENSOR_ALERT,
    trigger: { capability: "water_leak", sensorAlerts: ["water_leak"] },
    actions: [{ deviceId: "valve", capability: "valve.shutoff", setState: "shut" }],
  });
  await app.engine.ingestObservation(
    observation("leak", { kind: "sensor_alert", alert: "water_leak", version: 1 }, clock),
  );
  const seen = app.engine.queryReceipts({ residenceId: "res1", requesterId: "guest" });
  assert.ok(seen.every((r) => r.roomId !== "bath"), "访客看不到卫生间动作");
});

test("回执解释包含压制依据与覆盖提示", async () => {
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
  const result = await app.engine.ingestObservation(
    observation("leak", { kind: "sensor_alert", alert: "water_leak", version: 1 }, clock),
  );
  const r = receiptFor(result, "valve");
  assert.equal(r.explanation.basis, "紧急安全告警");
  assert.equal(r.overrideHint.ttlSeconds, 1800);
});
