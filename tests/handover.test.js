import assert from "node:assert/strict";
import test from "node:test";

import {
  DECISION_OUTCOME,
  PRIORITY_BASIS,
  RESIDENCE_ROLES,
  RULE_STATUS,
  TRANSFER_REASON,
} from "../src/domain/constants.js";
import { buildHome, makeClock, observation, receiptFor } from "./helpers/fixtures.js";

test("换租交接：旧租户即时失权，规则停用，后继者取得控制权，数据可导出", async () => {
  const clock = makeClock("2026-10-03T12:00:00+08:00");
  const app = await buildHome(clock);
  await app.registration.registerPerson({ personId: "newowner", name: "新业主", ageClass: "adult" });

  await app.rules.publishRule({
    residenceId: "res1",
    name: "室友个人偏好",
    ownerPersonId: "mate",
    priorityBasis: PRIORITY_BASIS.PERSONAL_PREFERENCE,
    trigger: { capability: "hall.switch", states: ["pressed"] },
    actions: [{ deviceId: "outlet", capability: "power.outlet", setState: "off" }],
  });

  const result = await app.handovers.scheduleHandover({
    residenceId: "res1",
    reason: TRANSFER_REASON.TENANCY_CHANGE,
    requestedByPersonId: "parent",
    outgoingPersonIds: ["mate"],
    successorPersonId: "newowner",
    successorRole: RESIDENCE_ROLES.OWNER,
  });
  assert.equal(result.transfer.status, "effective");

  // 旧成员即刻无权
  assert.equal(app.registration.activeMemberships("res1", "mate").length, 0);
  assert.throws(() => app.engine.queryReceipts({ residenceId: "res1", requesterId: "mate" }));

  // 后继者取得业主控制权
  assert.ok(app.registration.activeMemberships("res1", "newowner").some((m) => m.role === RESIDENCE_ROLES.OWNER));

  // 旧成员规则停用
  assert.ok(
    app.store
      .list("automation_rule", (r) => r.residenceId === "res1" && r.ownerPersonId === "mate")
      .every((r) => r.status === RULE_STATUS.SUSPENDED),
  );

  // 数据导出包可凭令牌领取
  const pkg = result.manifest.exports[0];
  assert.ok(pkg.claimToken);
  const claimed = await app.handovers.claimExport(pkg.packageId, pkg.claimToken);
  assert.equal(claimed.intendedFor, "mate");
  assert.ok("records" in claimed);
});

test("转售并把规则移交后继者：规则改挂后继者且继续生效", async () => {
  const clock = makeClock("2026-10-03T12:00:00+08:00");
  const app = await buildHome(clock);
  await app.registration.registerPerson({ personId: "buyer", name: "买家", ageClass: "adult" });

  const pub = await app.rules.publishRule({
    residenceId: "res1",
    name: "全屋漏水关阀",
    ownerPersonId: "parent",
    priorityBasis: PRIORITY_BASIS.EMERGENCY_SENSOR_ALERT,
    trigger: { capability: "water_leak", sensorAlerts: ["water_leak"] },
    actions: [{ deviceId: "valve", capability: "valve.shutoff", setState: "shut" }],
  });

  const result = await app.handovers.scheduleHandover({
    residenceId: "res1",
    reason: TRANSFER_REASON.RESALE,
    requestedByPersonId: "parent",
    outgoingPersonIds: ["parent", "elder", "kid", "mate"],
    successorPersonId: "buyer",
    successorRole: RESIDENCE_ROLES.OWNER,
    dataPolicy: "transfer_to_successor",
  });
  assert.equal(result.transfer.status, "effective");
  const rule = app.store.get("automation_rule", pub.rule.id);
  assert.equal(rule.ownerPersonId, "buyer");
  assert.equal(rule.status, RULE_STATUS.ACTIVE);
  assert.ok(result.manifest.transferredRules.includes(rule.id));
});

test("旧住户交接生效后无法再控制设备：其覆盖被撤销、动作被判无权", async () => {
  const clock = makeClock("2026-10-03T12:00:00+08:00");
  const app = await buildHome(clock);
  await app.registration.registerPerson({ personId: "newowner", name: "新业主", ageClass: "adult" });

  await app.engine.requestOverride({
    residenceId: "res1",
    personId: "mate",
    deviceId: "outlet",
    setState: "on",
    reason: "做饭",
  });

  await app.handovers.scheduleHandover({
    residenceId: "res1",
    reason: TRANSFER_REASON.MOVE_OUT,
    requestedByPersonId: "parent",
    outgoingPersonIds: ["mate"],
    successorPersonId: "newowner",
    successorRole: RESIDENCE_ROLES.OWNER,
  });

  // 覆盖记录被撤销
  assert.ok(
    app.store.list("manual_override", (o) => o.residenceId === "res1" && o.personId === "mate").every((o) => o.status === "cancelled"),
  );
  // 旧成员不能再发起覆盖
  await assert.rejects(
    () => app.engine.requestOverride({ residenceId: "res1", personId: "mate", deviceId: "outlet", setState: "off" }),
    /非生效成员/,
  );
});

test("云服务退出：住房停用拒绝新事件，生活数据被清除，配置资产保留", async () => {
  const clock = makeClock("2026-10-03T12:00:00+08:00");
  const app = await buildHome(clock);
  await app.rules.publishRule({
    residenceId: "res1",
    name: "开关断插座",
    ownerPersonId: "mate",
    priorityBasis: PRIORITY_BASIS.ENERGY_SAVING,
    trigger: { capability: "hall.switch", states: ["pressed"] },
    actions: [{ deviceId: "outlet", capability: "power.outlet", setState: "off" }],
  });
  // 产生生活回执
  await app.engine.ingestObservation(observation("hallswitch", { state: "pressed", version: 1 }, clock));
  assert.ok(app.store.list("execution_receipt", (r) => r.residenceId === "res1").length > 0);

  const result = await app.handovers.scheduleHandover({
    residenceId: "res1",
    reason: TRANSFER_REASON.CLOUD_EXIT,
    requestedByPersonId: "parent",
    outgoingPersonIds: ["parent"],
    dataPolicy: "export_and_delete",
  });
  assert.equal(result.transfer.status, "effective");

  // 住房停用
  assert.equal(app.store.get("residence", "res1").decommissioned, true);
  // 新设备事件被拒绝
  await assert.rejects(
    () => app.engine.ingestObservation(observation("hallswitch", { state: "pressed", version: 2 }, clock)),
    /停用/,
  );
  // 生活回执已清除
  assert.equal(app.store.list("execution_receipt", (r) => r.residenceId === "res1").length, 0);
  // 设备/房间配置仍在（便于迁移到其他后端）
  assert.ok(app.registration.listDevices("res1").length > 0);
  // 生成了退出数据包
  assert.ok(result.manifest.exports.length >= 1);
});

test("预约交接未到生效时间不撤权，到期扫描后生效", async () => {
  const clock = makeClock("2026-10-03T12:00:00+08:00");
  const app = await buildHome(clock);
  await app.registration.registerPerson({ personId: "newowner", name: "新业主", ageClass: "adult" });

  const scheduled = await app.handovers.scheduleHandover({
    residenceId: "res1",
    reason: TRANSFER_REASON.TENANCY_CHANGE,
    requestedByPersonId: "parent",
    outgoingPersonIds: ["mate"],
    successorPersonId: "newowner",
    successorRole: RESIDENCE_ROLES.OWNER,
    effectiveAt: "2026-11-01T00:00:00+08:00",
  });
  assert.equal(scheduled.transfer.status, "scheduled");
  assert.ok(app.registration.activeMemberships("res1", "mate").length > 0, "未到期仍有访问权");

  // 提前生效被拒绝
  await assert.rejects(() => app.handovers.effectuate(scheduled.transfer.id), /尚未到生效时间/);

  clock.set("2026-11-01T00:01:00+08:00");
  const done = await app.applyDueHandovers();
  assert.equal(done.length, 1);
  assert.equal(app.registration.activeMemberships("res1", "mate").length, 0);
});
