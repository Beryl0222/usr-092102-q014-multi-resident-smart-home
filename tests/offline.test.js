import assert from "node:assert/strict";
import test from "node:test";

import { CONSENT_SCOPE_KIND, DECISION_OUTCOME, DEVICE_EVENT_KIND, PRIORITY_BASIS } from "../src/domain/constants.js";
import { buildHome, makeClock, observation, receiptFor } from "./helpers/fixtures.js";

test("离线期间安全动作排队，恢复时告警仍在则执行", async () => {
  const clock = makeClock("2026-10-03T02:00:00+08:00");
  const app = await buildHome(clock);
  await app.rules.publishRule({
    residenceId: "res1",
    name: "漏水关阀",
    ownerPersonId: "parent",
    priorityBasis: PRIORITY_BASIS.EMERGENCY_SENSOR_ALERT,
    trigger: { capability: "water_leak", sensorAlerts: ["water_leak"] },
    actions: [{ deviceId: "valve", capability: "valve.shutoff", setState: "shut" }],
  });

  await app.engine.ingestObservation(observation("valve", { kind: DEVICE_EVENT_KIND.OFFLINE, version: 1 }, clock));
  const queued = await app.engine.ingestObservation(
    observation("leak", { kind: DEVICE_EVENT_KIND.SENSOR_ALERT, alert: "water_leak", version: 1 }, clock),
  );
  assert.equal(receiptFor(queued, "valve").outcome, DECISION_OUTCOME.PENDING);

  clock.advance(5 * 60 * 1000);
  const recovered = await app.engine.ingestObservation(
    observation("valve", { kind: DEVICE_EVENT_KIND.RECOVERED, activeAlerts: [], version: 2 }, clock),
  );
  const exec = recovered.receipts.find((r) => r.outcome === DECISION_OUTCOME.EXECUTED);
  assert.ok(exec, "告警持续的安全动作恢复后执行");
  assert.equal(exec.afterOffline, true);
  assert.equal(exec.requestedState, "shut");
});

test("离线舒适动作超过有效期后恢复：过期，绝不补执行", async () => {
  const clock = makeClock("2026-10-03T02:00:00+08:00");
  const app = await buildHome(clock);
  await app.rules.publishRule({
    residenceId: "res1",
    name: "夜间节能插座",
    ownerPersonId: "mate",
    priorityBasis: PRIORITY_BASIS.ENERGY_SAVING,
    trigger: { capability: "hall.switch", states: ["pressed"] },
    actions: [{ deviceId: "outlet", capability: "power.outlet", setState: "off", validForMs: 60_000 }],
    schedule: { kind: "time_window", start: "01:00", end: "05:00" },
  });

  await app.engine.ingestObservation(observation("outlet", { kind: DEVICE_EVENT_KIND.OFFLINE, version: 1 }, clock));
  await app.engine.ingestObservation(observation("hallswitch", { state: "pressed", version: 1 }, clock));

  // 超过动作有效期 + 节能时段后恢复
  clock.set("2026-10-03T05:30:00+08:00");
  const recovered = await app.engine.ingestObservation(
    observation("outlet", { kind: DEVICE_EVENT_KIND.RECOVERED, activeAlerts: [], version: 2 }, clock),
  );
  assert.ok(recovered.receipts.some((r) => r.outcome === DECISION_OUTCOME.EXPIRED), "应判过期");
  assert.deepEqual(app.engine.adapter.dispatches, [], "过期动作不得补下发");
});

test("安全动作在告警解除后恢复：条件不再成立，跳过不执行", async () => {
  const clock = makeClock("2026-10-03T02:00:00+08:00");
  const app = await buildHome(clock);
  await app.rules.publishRule({
    residenceId: "res1",
    name: "漏水关阀",
    ownerPersonId: "parent",
    priorityBasis: PRIORITY_BASIS.EMERGENCY_SENSOR_ALERT,
    trigger: { capability: "water_leak", sensorAlerts: ["water_leak"] },
    actions: [{ deviceId: "valve", capability: "valve.shutoff", setState: "shut" }],
  });

  await app.engine.ingestObservation(observation("valve", { kind: DEVICE_EVENT_KIND.OFFLINE, version: 1 }, clock));
  await app.engine.ingestObservation(
    observation("leak", { kind: DEVICE_EVENT_KIND.SENSOR_ALERT, alert: "water_leak", version: 1 }, clock),
  );
  // 告警解除（源传感器上报清除）
  await app.engine.ingestObservation(
    observation("leak", { kind: DEVICE_EVENT_KIND.SENSOR_ALERT, alert: "water_leak", cleared: true, version: 2 }, clock),
  );
  const recovered = await app.engine.ingestObservation(
    observation("valve", { kind: DEVICE_EVENT_KIND.RECOVERED, activeAlerts: [], version: 2 }, clock),
  );
  assert.ok(recovered.receipts.some((r) => r.outcome === DECISION_OUTCOME.SKIPPED_STALE && r.reason === "alert_cleared"));
  assert.deepEqual(app.engine.adapter.dispatches, []);
});

test("恢复时刻同意已撤回：采集动作被拒绝而不是补执行", async () => {
  const clock = makeClock("2026-10-03T12:00:00+08:00");
  const app = await buildHome(clock);
  await app.registration.registerDevice({
    deviceId: "presence", residenceId: "res1", roomId: "kidroom",
    capability: "kid.presence", actions: ["present", "absent"],
  });
  const consent = await app.registration.grantConsent({
    residenceId: "res1",
    subjectId: "kid",
    grantedById: "parent",
    capabilities: ["camera"],
    scope: { kind: CONSENT_SCOPE_KIND.DEVICE, deviceId: "cam" },
  });
  await app.rules.publishRule({
    residenceId: "res1",
    name: "进入开摄像",
    ownerPersonId: "parent",
    priorityBasis: PRIORITY_BASIS.PERSONAL_PREFERENCE,
    trigger: { capability: "kid.presence", states: ["present"] },
    actions: [{ deviceId: "cam", capability: "camera", setState: "on" }],
  });

  // 摄像头离线；随后存在传感器触发 → 摄像动作排队
  await app.engine.ingestObservation(observation("cam", { kind: DEVICE_EVENT_KIND.OFFLINE, version: 1 }, clock));
  const queued = await app.engine.ingestObservation(observation("presence", { state: "present", version: 1 }, clock));
  assert.ok(receiptFor(queued, "cam").outcome === DECISION_OUTCOME.PENDING);

  // 离线期间监护人撤回同意
  await app.registration.withdrawConsent(consent.id, "parent");
  const recovered = await app.engine.ingestObservation(
    observation("cam", { kind: DEVICE_EVENT_KIND.RECOVERED, activeAlerts: [], version: 2 }, clock),
  );
  assert.ok(
    recovered.receipts.some((r) => r.outcome === DECISION_OUTCOME.DENIED_CONSENT),
    "恢复时重新门禁：撤回立即生效，拒绝补执行",
  );
  assert.deepEqual(app.engine.adapter.dispatches, []);
});
