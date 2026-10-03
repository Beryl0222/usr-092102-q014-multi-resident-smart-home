import assert from "node:assert/strict";
import test from "node:test";

import { evaluateSchedule, ingestTelemetry, setConnectivity } from "../src/arbitration.js";
import { canAccess, registerDevice } from "../src/domain.js";
import { ValidationError } from "../src/errors.js";
import { createRule, publishRule } from "../src/rules.js";
import { createTransfer, effectuateTransfer } from "../src/transfers.js";
import { buildHousehold, outcomeFor, T0, telemetryEvent } from "./helpers.js";

test("换租交接：旧住户自生效起失去访问权，个人规则停用，数据封存", () => {
  const h = buildHousehold();
  const { roommate, owner } = h.members;
  const transfer = createTransfer(h.store, {
    residence_id: h.res.id,
    kind: "lease_change",
    effective_at: "2026-11-01T00:00:00+08:00",
    outgoing_member_ids: [roommate.id],
    incoming: [{ name: "新租客", role: "tenant" }],
    data_policy: "export_then_delete",
    actor_id: owner.id,
    now: "2026-10-15T10:00:00+08:00",
  });

  // 生效前：旧住户仍有访问权；提前执行交接被拒绝
  assert.equal(canAccess(h.store, roommate.id, "2026-10-31T23:00:00+08:00"), true);
  assert.throws(
    () => effectuateTransfer(h.store, transfer.id, { actor_id: owner.id, now: "2026-10-31T23:00:00+08:00" }),
    ValidationError,
  );

  effectuateTransfer(h.store, transfer.id, { actor_id: owner.id, now: "2026-11-01T00:00:00+08:00" });

  // 旧住户自交接生效起无法再访问设备
  assert.equal(canAccess(h.store, roommate.id, "2026-11-01T00:00:00+08:00"), false);
  // 其节能规则已停用，不再参与裁决
  assert.equal(h.store.getAggregate(h.rules.energyRule.id).state.status, "retired");
  const after = evaluateSchedule(h.store, h.res.id, "2026-11-02T02:00:00+08:00");
  assert.equal(after.outcomes.length, 0, "迁出者的规则不再产生动作");
  // 新租客自生效时刻起获得访问权
  const newcomerId = h.store.getAggregate(transfer.id).state.incoming_member_ids[0];
  assert.equal(canAccess(h.store, newcomerId, "2026-11-01T00:00:00+08:00"), true);
  // 数据交接：生成数据包并封存旧住户轨迹
  assert.equal(h.store.dataPackages.length, 1);
  assert.equal(h.store.dataPackages[0].member_id, roommate.id);
  assert.equal(h.store.dataPackages[0].policy, "export_then_delete");
  assert.ok(h.store.getAggregate(h.res.id).state.sealed_member_ids.includes(roommate.id));
  // CONTROL_TRANSFERRED 事件已登记
  const events = h.store.events.filter((event) => event.event_type === "CONTROL_TRANSFERRED");
  assert.equal(events.length, 1);
  assert.equal(events[0].aggregate_type, "control_transfer");
});

test("搬家交接：安全与照护类规则保留，继续保护留住成员", () => {
  const h = buildHousehold();
  const { owner } = h.members;
  // 户主搬家（安全/照护规则的创建者）
  const transfer = createTransfer(h.store, {
    residence_id: h.res.id,
    kind: "move_out",
    effective_at: "2026-11-01T00:00:00+08:00",
    outgoing_member_ids: [owner.id],
    incoming: [],
    actor_id: owner.id,
    now: "2026-10-15T10:00:00+08:00",
  });
  effectuateTransfer(h.store, transfer.id, { actor_id: owner.id, now: "2026-11-01T00:00:00+08:00" });
  // 安全与照护规则不停用
  assert.equal(h.store.getAggregate(h.rules.safetyRule.id).state.status, "published");
  assert.equal(h.store.getAggregate(h.rules.careRule.id).state.status, "published");
  // 漏水安全处置仍然生效
  const { decision } = ingestTelemetry(
    h.store,
    telemetryEvent(h.devices.leakSensor.id, "sensor.leak", "detected", "2026-11-02T03:00:00+08:00"),
  );
  assert.equal(outcomeFor(decision, h.devices.mainValve.id).status, "executed");
});

test("云服务退出：设备解绑厂商云，排队动作按过期处理", () => {
  const h = buildHousehold();
  const { owner } = h.members;
  // 一台接入厂商云的设备，离线时产生排队动作
  const vendorPlug = registerDevice(h.store, {
    residence_id: h.res.id,
    room_id: h.rooms.kitchen.id,
    label: "厂商云插座",
    capabilities: ["plug.set"],
    integration: "vendor-cloud-x",
  });
  const rule = createRule(h.store, {
    residence_id: h.res.id,
    created_by: owner.id,
    name: "云插座定时",
    priority_class: "comfort",
    trigger: { type: "schedule", at: "01:00" },
    actions: [{ device_id: vendorPlug.id, capability: "plug.set", params: { state: "on" } }],
    now: T0,
  });
  publishRule(h.store, rule.id, { actor_id: owner.id, now: T0 });
  setConnectivity(h.store, vendorPlug.id, "offline", "2026-10-04T00:55:00+08:00");
  const queued = evaluateSchedule(h.store, h.res.id, "2026-10-04T01:00:00+08:00");
  assert.equal(outcomeFor(queued, vendorPlug.id).status, "queued");

  const transfer = createTransfer(h.store, {
    residence_id: h.res.id,
    kind: "cloud_exit",
    effective_at: "2026-10-05T00:00:00+08:00",
    outgoing_member_ids: [],
    incoming: [],
    actor_id: owner.id,
    now: "2026-10-04T12:00:00+08:00",
  });
  effectuateTransfer(h.store, transfer.id, { actor_id: owner.id, now: "2026-10-05T00:00:00+08:00" });

  // 设备解绑厂商云回到本地集成；排队动作过期，不再补执行
  assert.equal(h.store.getAggregate(vendorPlug.id).state.integration, "local");
  const receipt = h.store
    .aggregatesOfType("execution_receipt")
    .find((item) => item.state.device_id === vendorPlug.id);
  assert.equal(receipt.state.status, "expired");
  assert.match(receipt.state.reason, /云服务退出/);
});

test("非产权人/承租人不能发起交接", async () => {
  const h = buildHousehold();
  const { ForbiddenError } = await import("../src/errors.js");
  assert.throws(
    () =>
      createTransfer(h.store, {
        residence_id: h.res.id,
        kind: "move_out",
        effective_at: "2026-11-01T00:00:00+08:00",
        outgoing_member_ids: [],
        actor_id: h.members.elder.id,
        now: T0,
      }),
    ForbiddenError,
  );
});
