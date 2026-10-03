import assert from "node:assert/strict";
import test from "node:test";

import { findCycles, findMutexConflicts, schedulesMayOverlap } from "../src/domain/analysis.js";
import { PRIORITY_BASIS, RULE_STATUS } from "../src/domain/constants.js";
import { buildHome, makeClock } from "./helpers/fixtures.js";

function rule(id, { trigger, actions, basis = PRIORITY_BASIS.PERSONAL_PREFERENCE, schedule = { kind: "always" }, status = RULE_STATUS.ACTIVE, roomId = null }) {
  return {
    id,
    name: id,
    status,
    priorityBasis: basis,
    schedule,
    roomId,
    createdAt: `2026-01-01T00:00:0${id.slice(-1)}:00Z`,
    trigger,
    actions,
  };
}

test("检测直接自环：动作触发自己的触发器", () => {
  const rules = [
    rule("r1", {
      trigger: { capability: "light", states: ["off"] },
      actions: [{ deviceId: "d1", capability: "light", setState: "off" }],
    }),
  ];
  // 动作把 light 置为 off，触发器匹配 light=off → 自环
  const cycles = findCycles(rules);
  assert.ok(cycles.length >= 1, "应识别自环");
});

test("检测多规则振荡环：开灯↔关摄像↔开灯", () => {
  const rules = [
    rule("a", {
      trigger: { capability: "light", states: ["on"] },
      actions: [{ deviceId: "cam", capability: "camera", setState: "off" }],
    }),
    rule("b", {
      trigger: { capability: "camera", states: ["off"] },
      actions: [{ deviceId: "lamp", capability: "light", setState: "on" }],
    }),
  ];
  const cycles = findCycles(rules);
  assert.ok(cycles.length >= 1);
  assert.deepEqual(cycles[0].ruleIds.sort(), ["a", "b"]);
});

test("不相连的规则无环", () => {
  const rules = [
    rule("a", {
      trigger: { capability: "water_leak" },
      actions: [{ deviceId: "valve", capability: "valve.shutoff", setState: "shut" }],
      basis: PRIORITY_BASIS.EMERGENCY_SENSOR_ALERT,
    }),
  ];
  assert.equal(findCycles(rules).length, 0);
});

test("互斥：同设备同层级、条件可重叠、目标状态不同", () => {
  const rules = [
    rule("a", {
      trigger: { capability: "switch", states: ["pressed"] },
      actions: [{ deviceId: "valve", capability: "valve.shutoff", setState: "open" }],
      basis: PRIORITY_BASIS.ENERGY_SAVING,
    }),
    rule("b", {
      trigger: { capability: "switch", states: ["pressed"] },
      actions: [{ deviceId: "valve", capability: "valve.shutoff", setState: "shut" }],
      basis: PRIORITY_BASIS.ENERGY_SAVING,
    }),
  ];
  assert.equal(findMutexConflicts(rules).length, 1);
});

test("不同优先级层级不判互斥（运行时确定性压制）", () => {
  const rules = [
    rule("a", {
      trigger: { capability: "water_leak" },
      actions: [{ deviceId: "valve", capability: "valve.shutoff", setState: "shut" }],
      basis: PRIORITY_BASIS.EMERGENCY_SENSOR_ALERT,
    }),
    rule("b", {
      trigger: { capability: "switch", states: ["pressed"] },
      actions: [{ deviceId: "valve", capability: "valve.shutoff", setState: "open" }],
      basis: PRIORITY_BASIS.ENERGY_SAVING,
    }),
  ];
  assert.equal(findMutexConflicts(rules).length, 0);
});

test("时段不相交的同层级动作不判互斥", () => {
  const day = { kind: "time_window", start: "08:00", end: "18:00" };
  const night = { kind: "time_window", start: "18:00", end: "08:00" };
  const rules = [
    rule("a", { trigger: { capability: "switch", states: ["pressed"] }, actions: [{ deviceId: "v", capability: "valve.shutoff", setState: "open" }], schedule: day }),
    rule("b", { trigger: { capability: "switch", states: ["pressed"] }, actions: [{ deviceId: "v", capability: "valve.shutoff", setState: "shut" }], schedule: night }),
  ];
  assert.equal(findMutexConflicts(rules).length, 0);
  assert.equal(schedulesMayOverlap(day, night), false);
});

test("跨午夜窗口重叠可识别（22:00-06:00 与 05:00-07:00）", () => {
  assert.equal(
    schedulesMayOverlap(
      { kind: "time_window", start: "22:00", end: "06:00" },
      { kind: "time_window", start: "05:00", end: "07:00" },
    ),
    true,
  );
});

test("规则发布集成：形成循环的规则被拒绝且不生效", async () => {
  const clock = makeClock();
  const app = await buildHome(clock);
  await app.registration.registerDevice({ deviceId: "lamp", residenceId: "res1", roomId: "hall", capability: "light", actions: ["on", "off"] });
  const first = await app.rules.publishRule({
    residenceId: "res1",
    name: "灯亮关摄像",
    ownerPersonId: "parent",
    priorityBasis: PRIORITY_BASIS.PERSONAL_PREFERENCE,
    trigger: { capability: "light", states: ["on"] },
    actions: [{ deviceId: "cam", capability: "camera", setState: "off" }],
  });
  assert.equal(first.rejected, null);
  const second = await app.rules.publishRule({
    residenceId: "res1",
    name: "摄像关开灯",
    ownerPersonId: "parent",
    priorityBasis: PRIORITY_BASIS.PERSONAL_PREFERENCE,
    trigger: { capability: "camera", states: ["off"] },
    actions: [{ deviceId: "lamp", capability: "light", setState: "on" }],
  });
  assert.ok(second.rejected?.cycles?.length >= 1);
  assert.equal(app.rules.listActive("res1").filter((r) => r.name === "摄像关开灯").length, 0);
});
