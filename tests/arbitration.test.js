import assert from "node:assert/strict";
import test from "node:test";

import { createOverride, evaluateSchedule, ingestTelemetry } from "../src/arbitration.js";
import { explainDecision } from "../src/explain.js";
import { buildHousehold, outcomeFor, telemetryEvent } from "./helpers.js";

test("凌晨场景：节能规则被照护主张压制，老人夜灯不突然熄灭", () => {
  const h = buildHousehold();
  // 21:00 照护规则执行，点亮夜灯与老人房插座
  const evening = evaluateSchedule(h.store, h.res.id, "2026-10-03T21:00:00+08:00");
  assert.equal(outcomeFor(evening, h.devices.hallwayLight.id).status, "executed");
  assert.equal(outcomeFor(evening, h.devices.elderPlug.id).status, "executed");

  // 02:00 室友的节能规则试图切断同一组设备
  const decision = evaluateSchedule(h.store, h.res.id, "2026-10-04T02:00:00+08:00");
  const lightOff = outcomeFor(decision, h.devices.hallwayLight.id);
  assert.equal(lightOff.status, "suppressed");
  assert.equal(lightOff.suppressor.type, "claim");
  assert.equal(lightOff.suppressor.id, h.rules.careRule.id);
  assert.equal(outcomeFor(decision, h.devices.elderPlug.id).status, "suppressed");
  // 无主张冲突的厨房插座正常断电
  assert.equal(outcomeFor(decision, h.devices.kitchenPlug.id).status, "executed");

  // 设备状态：夜灯仍亮，未被突然熄灭
  assert.equal(h.store.getAggregate(h.devices.hallwayLight.id).state.state["light.set"], "on");
  assert.equal(h.store.getAggregate(h.devices.kitchenPlug.id).state.state["plug.set"], "off");

  // 每个结果都有执行回执可查
  const receipts = h.store.aggregatesOfType("execution_receipt");
  assert.equal(receipts.length, decision.outcomes.length + evening.outcomes.length);
});

test("凌晨漏水：安全处置立即关阀并恢复供电，随后压制节能动作", () => {
  const h = buildHousehold();
  evaluateSchedule(h.store, h.res.id, "2026-10-04T02:00:00+08:00");
  assert.equal(h.store.getAggregate(h.devices.kitchenPlug.id).state.state["plug.set"], "off");

  // 03:00 漏水告警：安全规则立即执行
  const { decision } = ingestTelemetry(
    h.store,
    telemetryEvent(h.devices.leakSensor.id, "sensor.leak", "detected", "2026-10-04T03:00:00+08:00"),
  );
  assert.equal(outcomeFor(decision, h.devices.mainValve.id).status, "executed");
  // 安全处置恢复厨房插座供电（安全优先于节能偏好）
  assert.equal(outcomeFor(decision, h.devices.kitchenPlug.id).status, "executed");
  assert.equal(h.store.getAggregate(h.devices.mainValve.id).state.state["valve.actuate"], "close");
  assert.equal(h.store.getAggregate(h.devices.kitchenPlug.id).state.state["plug.set"], "on");
  assert.ok(h.store.events.filter((event) => event.event_type === "ACTION_EXECUTED").length >= 2);

  // 03:05 节能规则试图断厨房插座，被漏水安全主张压制
  const suppressed = evaluateSchedule(h.store, h.res.id, "2026-10-04T03:05:00+08:00");
  const outcome = outcomeFor(suppressed, h.devices.kitchenPlug.id);
  assert.equal(outcome.status, "suppressed");
  assert.equal(outcome.suppressor.type, "claim");
  assert.equal(outcome.suppressor.id, h.rules.safetyRule.id);

  // 04:00 漏水解除 → 安全主张消失，次日同时刻节能动作正常执行
  ingestTelemetry(h.store, telemetryEvent(h.devices.leakSensor.id, "sensor.leak", "clear", "2026-10-04T04:00:00+08:00"));
  const nextDay = evaluateSchedule(h.store, h.res.id, "2026-10-05T03:05:00+08:00");
  assert.equal(outcomeFor(nextDay, h.devices.kitchenPlug.id).status, "executed");
});

test("临时覆盖：老人外出时暂停照护主张；安全动作不受覆盖影响", () => {
  const h = buildHousehold();
  // 户主创建针对照护规则的临时覆盖（老人外出，当夜照明主张暂停）
  createOverride(h.store, {
    residence_id: h.res.id,
    member_id: h.members.owner.id,
    rule_ids: [h.rules.careRule.id],
    capabilities: ["light.set"],
    effect: "block",
    starts_at: "2026-10-04T20:00:00+08:00",
    ends_at: "2026-10-05T07:00:00+08:00",
    reason: "老人外出探亲",
    now: "2026-10-04T12:00:00+08:00",
  });
  const night = evaluateSchedule(h.store, h.res.id, "2026-10-05T02:00:00+08:00");
  // 照护主张被覆盖，节能关灯生效
  assert.equal(outcomeFor(night, h.devices.hallwayLight.id).status, "executed");
  // 老人房插座主张未被覆盖（覆盖只针对 light.set），仍被压制
  assert.equal(outcomeFor(night, h.devices.elderPlug.id).status, "suppressed");

  // 针对节能规则的临时覆盖可以拦住节能动作本身
  createOverride(h.store, {
    residence_id: h.res.id,
    member_id: h.members.elder.id,
    device_ids: [h.devices.kitchenPlug.id],
    effect: "block",
    starts_at: "2026-10-06T01:00:00+08:00",
    ends_at: "2026-10-06T05:00:00+08:00",
    reason: "今晚要用厨房电器",
    now: "2026-10-06T00:00:00+08:00",
  });
  const blocked = evaluateSchedule(h.store, h.res.id, "2026-10-06T02:00:00+08:00");
  const kitchen = outcomeFor(blocked, h.devices.kitchenPlug.id);
  assert.equal(kitchen.status, "suppressed");
  assert.equal(kitchen.suppressor.type, "override");

  // 安全动作不受 block 覆盖影响
  createOverride(h.store, {
    residence_id: h.res.id,
    member_id: h.members.owner.id,
    device_ids: [h.devices.mainValve.id],
    effect: "block",
    starts_at: "2026-10-07T02:00:00+08:00",
    ends_at: "2026-10-07T06:00:00+08:00",
    reason: "尝试覆盖安全动作",
    now: "2026-10-07T01:00:00+08:00",
  });
  const { decision } = ingestTelemetry(
    h.store,
    telemetryEvent(h.devices.leakSensor.id, "sensor.leak", "detected", "2026-10-07T03:00:00+08:00"),
  );
  assert.equal(outcomeFor(decision, h.devices.mainValve.id).status, "executed");
});

test("裁决解释：为何执行、被谁压制、怎样临时覆盖", () => {
  const h = buildHousehold();
  evaluateSchedule(h.store, h.res.id, "2026-10-03T21:00:00+08:00");
  const decision = evaluateSchedule(h.store, h.res.id, "2026-10-04T02:00:00+08:00");
  const explanation = explainDecision(h.store, decision.id);

  assert.equal(explanation.outcomes.length, 3);
  const lightOutcome = explanation.outcomes.find((outcome) => outcome.action.device_id === h.devices.hallwayLight.id);
  assert.equal(lightOutcome.result, "suppressed");
  assert.equal(lightOutcome.basis.label, "节能偏好");
  assert.equal(lightOutcome.suppressed_by.label, "老人夜间照明");

  const kitchenOutcome = explanation.outcomes.find((outcome) => outcome.action.device_id === h.devices.kitchenPlug.id);
  assert.equal(kitchenOutcome.result, "executed");

  // 被压制的动作附带临时覆盖建议
  assert.ok(explanation.how_to_override.length >= 1);
  assert.ok(explanation.how_to_override[0].suggestion.includes("临时覆盖"));
  // 解释中可见当前生效的主张
  assert.ok(explanation.active_claims.some((claim) => claim.rule_id === h.rules.careRule.id));
});
