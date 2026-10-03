import assert from "node:assert/strict";
import test from "node:test";

import { evaluateSchedule, ingestTelemetry } from "../src/arbitration.js";
import { grantConsent } from "../src/domain.js";
import { scopedAudit } from "../src/privacy.js";
import { createRule, publishRule } from "../src/rules.js";
import { createTransfer, effectuateTransfer } from "../src/transfers.js";
import { buildHousehold, T0, telemetryEvent } from "./helpers.js";

test("居民视角：可见完整裁决轨迹与压制原因", () => {
  const h = buildHousehold();
  evaluateSchedule(h.store, h.res.id, "2026-10-04T02:00:00+08:00");
  const view = scopedAudit(h.store, h.res.id, "resident");
  assert.equal(view.receipts.length, 3);
  const suppressed = view.receipts.find((receipt) => receipt.status === "suppressed");
  assert.ok(suppressed.suppressor, "居民应看到被谁压制");
  assert.ok(view.events.some((event) => event.event_type === "RULE_PUBLISHED"));
});

test("房东/物业视角：仅安全处置与设备健康，无个人生活轨迹", () => {
  const h = buildHousehold();
  evaluateSchedule(h.store, h.res.id, "2026-10-04T02:00:00+08:00");
  ingestTelemetry(h.store, telemetryEvent(h.devices.leakSensor.id, "sensor.leak", "detected", "2026-10-04T03:00:00+08:00"));

  for (const perspective of ["landlord", "property"]) {
    const view = scopedAudit(h.store, h.res.id, perspective);
    assert.ok(view.safety_receipts.length >= 1, "应看到漏水等安全处置");
    assert.ok(view.safety_receipts.every((receipt) => !("rule_name" in receipt) && !("suppressor" in receipt)));
    assert.ok(view.device_health.length > 0);
    const serialized = JSON.stringify(view);
    for (const name of ["户主", "老人", "孩子", "室友"]) {
      assert.ok(!serialized.includes(name), `${perspective} 视角不应出现成员姓名 ${name}`);
    }
    assert.ok(!serialized.includes("02:00:00"), "时间应粗化到小时，不暴露精确作息");
  }
});

test("厂商视角：仅设备能力级诊断计数", () => {
  const h = buildHousehold();
  evaluateSchedule(h.store, h.res.id, "2026-10-04T02:00:00+08:00");
  const view = scopedAudit(h.store, h.res.id, "vendor");
  assert.ok(view.diagnostics.length > 0);
  const valve = view.diagnostics.find((item) => item.device_id === h.devices.mainValve.id);
  assert.ok(Array.isArray(valve.capabilities));
  const serialized = JSON.stringify(view);
  for (const keyword of ["户主", "老人", "孩子", "室友", "rule", "consent", "儿童房"]) {
    assert.ok(!serialized.includes(keyword), `厂商视角不应包含 ${keyword}`);
  }
});

test("已迁出成员的个人标识在居民视角中被封存为「前住户」", () => {
  const h = buildHousehold();
  // 构造一条被室友（未同意）压制的采集回执
  const rule = createRule(h.store, {
    residence_id: h.res.id,
    created_by: h.members.owner.id,
    name: "在家统计",
    priority_class: "comfort",
    trigger: { type: "device_event", capability: "sensor.motion", device_id: h.devices.hallwayMotion.id, match: { state: "detected" } },
    actions: [{ device_id: h.devices.phoneHub.id, capability: "location.report", params: {} }],
    now: T0,
  });
  publishRule(h.store, rule.id, { actor_id: h.members.owner.id, now: T0 });
  // 户主、老人、孩子同意；室友不同意 → 回执的 suppressor 指向室友
  grantConsent(h.store, h.members.owner.id, { grantor_id: h.members.owner.id, capability: "location.report", now: T0 });
  grantConsent(h.store, h.members.elder.id, { grantor_id: h.members.elder.id, capability: "location.report", now: T0 });
  grantConsent(h.store, h.members.child.id, { grantor_id: h.members.owner.id, capability: "location.report", now: T0 });
  ingestTelemetry(h.store, telemetryEvent(h.devices.hallwayMotion.id, "sensor.motion", "detected", "2026-10-04T12:00:00+08:00"));

  // 室友迁出并封存
  const transfer = createTransfer(h.store, {
    residence_id: h.res.id,
    kind: "move_out",
    effective_at: "2026-11-01T00:00:00+08:00",
    outgoing_member_ids: [h.members.roommate.id],
    incoming: [],
    actor_id: h.members.owner.id,
    now: "2026-10-15T10:00:00+08:00",
  });
  effectuateTransfer(h.store, transfer.id, { actor_id: h.members.owner.id, now: "2026-11-01T00:00:00+08:00" });

  const view = scopedAudit(h.store, h.res.id, "resident");
  const receipt = view.receipts.find((item) => item.capability === "location.report");
  assert.equal(receipt.suppressor.label, "前住户");
  assert.ok(!JSON.stringify(view.receipts).includes("室友"), "居民视角不应暴露前住户身份");
});
