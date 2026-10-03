import assert from "node:assert/strict";
import test from "node:test";

import { ConflictError, ForbiddenError, ValidationError } from "../src/errors.js";
import { createRule, publishRule, retireRule } from "../src/rules.js";
import { buildHousehold, T0 } from "./helpers.js";

test("发布前识别同级互斥动作并拒绝", () => {
  const h = buildHousehold();
  // 与已发布的「凌晨节能断电」同为 energy 类、时段重叠、目标相反
  const rival = createRule(h.store, {
    residence_id: h.res.id,
    created_by: h.members.roommate.id,
    name: "凌晨插座常开",
    priority_class: "energy",
    trigger: { type: "schedule", at: "02:30" },
    actions: [{ device_id: h.devices.kitchenPlug.id, capability: "plug.set", params: { state: "on" } }],
    now: T0,
  });
  assert.throws(() => publishRule(h.store, rival.id, { actor_id: h.members.roommate.id, now: T0 }), ValidationError);
});

test("跨级互斥允许发布但登记 CONFLICT_DETECTED", () => {
  const h = buildHousehold();
  // 夹具中室友的节能规则与安全/照护规则跨级互斥，发布时已登记
  const conflicts = h.store.events.filter((event) => event.event_type === "CONFLICT_DETECTED");
  assert.ok(conflicts.length >= 2, "应登记节能与安全/照护之间的跨级互斥");
  assert.ok(conflicts.every((event) => event.detail.same_class === false));
});

test("时段不重叠的相反动作不构成互斥", () => {
  const h = buildHousehold();
  // 与照护规则（21:00–07:00 保持老人房插座供电）时段不重叠的午后规则
  const afternoon = createRule(h.store, {
    residence_id: h.res.id,
    created_by: h.members.roommate.id,
    name: "午后断电",
    priority_class: "energy",
    trigger: { type: "schedule", at: "14:00" },
    window: { start: "13:00", end: "15:00" },
    actions: [{ device_id: h.devices.elderPlug.id, capability: "plug.set", params: { state: "off" } }],
    now: T0,
  });
  const published = publishRule(h.store, afternoon.id, { actor_id: h.members.roommate.id, now: T0 });
  assert.equal(published.state.status, "published");
  const conflicts = h.store.events.filter(
    (event) => event.event_type === "CONFLICT_DETECTED" && event.aggregate_id === afternoon.id,
  );
  assert.equal(conflicts.length, 0, "时段不重叠不应登记互斥");
});

test("发布前识别自触发循环", () => {
  const h = buildHousehold();
  const loop = createRule(h.store, {
    residence_id: h.res.id,
    created_by: h.members.owner.id,
    name: "自触发循环",
    priority_class: "comfort",
    trigger: { type: "device_event", capability: "valve.actuate", match: { state: "close" } },
    actions: [{ device_id: h.devices.mainValve.id, capability: "valve.actuate", params: { state: "close" } }],
    now: T0,
  });
  assert.throws(
    () => publishRule(h.store, loop.id, { actor_id: h.members.owner.id, now: T0 }),
    /循环/,
  );
});

test("发布前识别多规则触发循环", () => {
  const h = buildHousehold();
  const { res, devices, members } = h;
  const switchA = devices.kitchenPlug;
  const switchB = devices.elderPlug;
  const ruleA = createRule(h.store, {
    residence_id: res.id,
    created_by: members.owner.id,
    name: "A 开则 B 开",
    priority_class: "comfort",
    trigger: { type: "device_event", capability: "plug.set", device_id: switchA.id, match: { state: "on" } },
    actions: [{ device_id: switchB.id, capability: "plug.set", params: { state: "on" } }],
    now: T0,
  });
  publishRule(h.store, ruleA.id, { actor_id: members.owner.id, now: T0 });
  const ruleB = createRule(h.store, {
    residence_id: res.id,
    created_by: members.owner.id,
    name: "B 开则 A 开",
    priority_class: "comfort",
    trigger: { type: "device_event", capability: "plug.set", device_id: switchB.id, match: { state: "on" } },
    actions: [{ device_id: switchA.id, capability: "plug.set", params: { state: "on" } }],
    now: T0,
  });
  assert.throws(() => publishRule(h.store, ruleB.id, { actor_id: members.owner.id, now: T0 }), /循环/);
});

test("发布权限：未成年人与访客不能发布，居民只能发布舒适/节能类", () => {
  const h = buildHousehold();
  const { res, members, devices } = h;
  const draft = (created_by, priority_class) =>
    createRule(h.store, {
      residence_id: res.id,
      created_by,
      name: `${priority_class} 规则`,
      priority_class,
      trigger: { type: "schedule", at: "12:00" },
      actions: [{ device_id: devices.kitchenPlug.id, capability: "plug.set", params: { state: "on" } }],
      now: T0,
    });
  // 未成年人不能创建规则
  assert.throws(() => draft(members.child.id, "comfort"), ForbiddenError);
  // 居民发布安全类被拒
  const elderSafety = draft(members.elder.id, "safety");
  assert.throws(() => publishRule(h.store, elderSafety.id, { actor_id: members.elder.id, now: T0 }), ForbiddenError);
  // 居民发布舒适类成功
  const elderComfort = draft(members.elder.id, "comfort");
  assert.equal(publishRule(h.store, elderComfort.id, { actor_id: members.elder.id, now: T0 }).state.status, "published");
});

test("乐观并发：携带过期版本号的发布被拒绝", () => {
  const h = buildHousehold();
  const rule = createRule(h.store, {
    residence_id: h.res.id,
    created_by: h.members.owner.id,
    name: "并发测试规则",
    priority_class: "comfort",
    trigger: { type: "schedule", at: "12:00" },
    actions: [{ device_id: h.devices.kitchenPlug.id, capability: "plug.set", params: { state: "on" } }],
    now: T0,
  });
  assert.throws(
    () => publishRule(h.store, rule.id, { actor_id: h.members.owner.id, expected_version: 99, now: T0 }),
    ConflictError,
  );
  // 正确版本号可以发布
  const published = publishRule(h.store, rule.id, {
    actor_id: h.members.owner.id,
    expected_version: 1,
    now: T0,
  });
  assert.equal(published.version, 2);
  // 停用同样需要最新版本
  assert.throws(
    () => retireRule(h.store, rule.id, { actor_id: h.members.owner.id, expected_version: 1, now: T0 }),
    ConflictError,
  );
});
