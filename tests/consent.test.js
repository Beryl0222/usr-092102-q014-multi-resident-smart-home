import assert from "node:assert/strict";
import test from "node:test";

import {
  AGE_CLASS,
  CONSENT_SCOPE_KIND,
  DECISION_OUTCOME,
  DEVICE_EVENT_KIND,
  PRIORITY_BASIS,
  RESIDENCE_ROLES,
} from "../src/domain/constants.js";
import { DomainError } from "../src/domain/store.js";
import { buildHome, makeClock, observation, receiptFor } from "./helpers/fixtures.js";

test("孩子禁摄像时段：监护人限制压过摄像动作（即使已有同意）", async () => {
  const clock = makeClock("2026-10-03T23:00:00+08:00");
  const app = await buildHome(clock);
  await app.registration.registerDevice({
    deviceId: "presence", residenceId: "res1", roomId: "kidroom",
    capability: "kid.presence", actions: ["present", "absent"],
  });

  // 家长对孩子本人房间的设备级摄像同意（监护人授予）
  await app.registration.grantConsent({
    residenceId: "res1",
    subjectId: "kid",
    grantedById: "parent",
    capabilities: ["camera"],
    scope: { kind: CONSENT_SCOPE_KIND.DEVICE, deviceId: "cam" },
  });
  // 但设置 19:00-07:00 禁摄像
  await app.registration.addCollectionRestriction({
    residenceId: "res1",
    subjectId: "kid",
    setByPersonId: "parent",
    capability: "camera",
    schedule: { kind: "time_window", start: "19:00", end: "07:00" },
    reason: "孩子夜间禁摄像",
  });
  await app.rules.publishRule({
    residenceId: "res1",
    name: "夜间看护摄像",
    ownerPersonId: "parent",
    priorityBasis: PRIORITY_BASIS.GUARDIAN_RESTRICTION,
    trigger: { capability: "kid.presence", states: ["present"] },
    actions: [{ deviceId: "cam", capability: "camera", setState: "on" }],
    schedule: { kind: "time_window", start: "22:00", end: "06:00" },
  });

  const night = await app.engine.ingestObservation(
    observation("presence", { state: "present", version: 1 }, clock),
  );
  assert.equal(receiptFor(night, "cam").outcome, DECISION_OUTCOME.DENIED_CONSENT);
  assert.match(receiptFor(night, "cam").explanation.short, /禁采限制|同意/);

  // 次日 10:00：限制解除，且同意仍在 → 摄像可开启
  clock.set("2026-10-03T10:00:00+08:00");
  // 夜间规则只在 22:00-06:00 生效，需要一条全天规则来验证白天门禁放行
  await app.rules.publishRule({
    residenceId: "res1",
    name: "白天进入房间摄像",
    ownerPersonId: "parent",
    priorityBasis: PRIORITY_BASIS.PERSONAL_PREFERENCE,
    trigger: { capability: "kid.presence", states: ["present"] },
    actions: [{ deviceId: "cam", capability: "camera", setState: "on" }],
  });
  const day = await app.engine.ingestObservation(
    observation("presence", { state: "present", version: 2 }, clock),
  );
  assert.equal(receiptFor(day, "cam").outcome, DECISION_OUTCOME.EXECUTED, "白天限制解除且同意有效，应放行");
});

test("采集开启须满足全体受影响成员：客厅缺一人同意即拒绝", async () => {
  const clock = makeClock("2026-10-03T12:00:00+08:00");
  const app = await buildHome(clock);

  // 客厅占有者：elder 与 mate（fixture）；只给 elder 同意
  await app.registration.grantConsent({
    residenceId: "res1",
    subjectId: "elder",
    grantedById: "elder",
    capabilities: ["camera"],
    scope: { kind: CONSENT_SCOPE_KIND.ROOM, roomId: "living" },
  });
  await app.rules.publishRule({
    residenceId: "res1",
    name: "客厅摄像",
    ownerPersonId: "parent",
    priorityBasis: PRIORITY_BASIS.PERSONAL_PREFERENCE,
    trigger: { capability: "camera", states: ["off"] },
    actions: [{ deviceId: "livingcam", capability: "camera", setState: "on" }],
  });

  const result = await app.engine.ingestObservation(
    observation("livingcam", { state: "off", version: 1 }, clock),
  );
  const receipt = receiptFor(result, "livingcam");
  assert.equal(receipt.outcome, DECISION_OUTCOME.DENIED_CONSENT);
  assert.deepEqual(
    receipt.denialDetail.missing.map((m) => m.personId).sort(),
    ["mate", "parent"],
    "未同意的受影响成员都应列入缺失名单（parent 也占有客厅）",
  );

  // 补齐后放行
  await app.registration.grantConsent({
    residenceId: "res1",
    subjectId: "mate",
    grantedById: "mate",
    capabilities: ["camera"],
    scope: { kind: CONSENT_SCOPE_KIND.ROOM, roomId: "living" },
  });
  await app.registration.grantConsent({
    residenceId: "res1",
    subjectId: "parent",
    grantedById: "parent",
    capabilities: ["camera"],
    scope: { kind: CONSENT_SCOPE_KIND.ROOM, roomId: "living" },
  });
  const ok = await app.engine.ingestObservation(
    observation("livingcam", { state: "off", version: 2 }, clock),
  );
  assert.equal(receiptFor(ok, "livingcam").outcome, DECISION_OUTCOME.EXECUTED);
});

test("同意可撤回且立即生效", async () => {
  const clock = makeClock("2026-10-03T12:00:00+08:00");
  const app = await buildHome(clock);
  const consent = await app.registration.grantConsent({
    residenceId: "res1",
    subjectId: "parent",
    grantedById: "parent",
    capabilities: ["camera"],
    scope: { kind: CONSENT_SCOPE_KIND.ROOM, roomId: "living" },
  });
  // 客厅另有 elder、mate；这里用家长单人占有的 kidroom 不适用，改为对 livingcam 仅家长在场的隔离场景：
  // 直接验证 hasCollectionConsent 语义。
  assert.equal(
    app.registration.hasCollectionConsent("res1", "parent", "camera", { kind: "room", id: "living" }, clock.now()),
    true,
  );
  await app.registration.withdrawConsent(consent.id, "parent");
  assert.equal(
    app.registration.hasCollectionConsent("res1", "parent", "camera", { kind: "room", id: "living" }, clock.now()),
    false,
    "撤回后立即失效",
  );
});

test("未成年人采用更窄权限：本人不能授予，监护人只能授予其私人房间/设备", async () => {
  const app = await buildHome(makeClock());
  await assert.rejects(
    () =>
      app.registration.grantConsent({
        residenceId: "res1",
        subjectId: "kid",
        grantedById: "kid",
        capabilities: ["camera"],
        scope: { kind: CONSENT_SCOPE_KIND.DEVICE, deviceId: "cam" },
      }),
    /未成年人不能自行授予/,
  );
  await assert.rejects(
    () =>
      app.registration.grantConsent({
        residenceId: "res1",
        subjectId: "kid",
        grantedById: "parent",
        capabilities: ["camera"],
        scope: { kind: CONSENT_SCOPE_KIND.RESIDENCE },
      }),
    /不得超过房间/,
  );
  // 监护人误把客厅房间当孩子私人范围也不行
  await assert.rejects(
    () =>
      app.registration.grantConsent({
        residenceId: "res1",
        subjectId: "kid",
        grantedById: "parent",
        capabilities: ["camera"],
        scope: { kind: CONSENT_SCOPE_KIND.ROOM, roomId: "living" },
      }),
    /私人房间/,
  );
  // 正确做法：监护人对孩子本人房间/设备授予，通过
  const ok = await app.registration.grantConsent({
    residenceId: "res1",
    subjectId: "kid",
    grantedById: "parent",
    capabilities: ["camera"],
    scope: { kind: CONSENT_SCOPE_KIND.DEVICE, deviceId: "cam" },
  });
  assert.equal(ok.status, "granted");
});

test("非监护人不能为未成年人设置采集限制", async () => {
  const app = await buildHome(makeClock());
  await assert.rejects(
    () =>
      app.registration.addCollectionRestriction({
        residenceId: "res1",
        subjectId: "kid",
        setByPersonId: "mate",
        capability: "camera",
        schedule: { kind: "time_window", start: "00:00", end: "23:59" },
      }),
    /成年监护人/,
  );
});

test("房东不是数据主体：发起采集被授权门禁拒绝，且看不到生活回执", async () => {
  const clock = makeClock("2026-10-03T12:00:00+08:00");
  const app = await buildHome(clock);
  await app.registration.registerPerson({ personId: "lord", name: "房东", ageClass: AGE_CLASS.ADULT });
  await app.registration.addMembership({
    residenceId: "res1",
    personId: "lord",
    role: RESIDENCE_ROLES.LANDLORD,
    occupiesRooms: [],
  });
  // 房东尝试发布开启客厅摄像的规则并触发
  const pub = await app.rules.publishRule({
    residenceId: "res1",
    name: "房东看房摄像",
    ownerPersonId: "lord",
    priorityBasis: PRIORITY_BASIS.PERSONAL_PREFERENCE,
    trigger: { capability: "camera", states: ["off"] },
    actions: [{ deviceId: "livingcam", capability: "camera", setState: "on" }],
  });
  // 规则可以发布（成员身份允许），但执行采集时被门禁拒绝
  const result = await app.engine.ingestObservation(
    observation("livingcam", { state: "off", version: 1 }, clock),
  );
  const receipt = receiptFor(result, "livingcam");
  // 若房东规则与他人规则同时命中，房东那条必为 denied_authz
  const landlordReceipt = result.receipts.find(
    (r) => r.priority.ownerPersonId === "lord",
  );
  assert.equal(landlordReceipt.outcome, DECISION_OUTCOME.DENIED_AUTHZ);
  assert.match(landlordReceipt.explanation.short, /无权/);
  assert.throws(
    () => app.engine.queryReceipts({ residenceId: "res1", requesterId: "lord" }),
    (e) => e instanceof DomainError && e.code === "ACCESS_DENIED",
  );
  void pub;
  void receipt;
});
