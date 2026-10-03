import assert from "node:assert/strict";
import test from "node:test";

import { createOverride, evaluateSchedule, ingestTelemetry } from "../src/arbitration.js";
import { addMembership, grantConsent, revokeConsent } from "../src/domain.js";
import { ForbiddenError } from "../src/errors.js";
import { createRule, publishRule } from "../src/rules.js";
import { buildHousehold, outcomeFor, T0, telemetryEvent } from "./helpers.js";

function publishCameraRule(h) {
  const rule = createRule(h.store, {
    residence_id: h.res.id,
    created_by: h.members.owner.id,
    name: "移动录像",
    priority_class: "comfort",
    trigger: { type: "device_event", capability: "sensor.motion", device_id: h.devices.childMotion.id, match: { state: "detected" } },
    actions: [{ device_id: h.devices.childCamera.id, capability: "camera.capture", params: { state: "start" } }],
    now: T0,
  });
  publishRule(h.store, rule.id, { actor_id: h.members.owner.id, now: T0 });
  return rule;
}

const motionAt = (h, at) =>
  ingestTelemetry(h.store, telemetryEvent(h.devices.childMotion.id, "sensor.motion", "detected", at));

test("孩子禁止摄像时段必须生效", () => {
  const h = buildHousehold();
  publishCameraRule(h);
  // 22:00 处于孩子隐私时段（19:00–07:00），即使户主规则也被压制
  const night = motionAt(h, "2026-10-04T22:00:00+08:00");
  const outcome = outcomeFor(night.decision, h.devices.childCamera.id);
  assert.equal(outcome.status, "suppressed");
  assert.equal(outcome.suppressor.type, "privacy_window");
  assert.equal(outcome.suppressor.id, h.members.child.id);
});

test("摄像必须满足受影响成员同意：未成年人需监护人同意，可撤回", () => {
  const h = buildHousehold();
  publishCameraRule(h);
  // 10:00 不在隐私时段，但孩子（未成年人）缺少监护人同意
  const morning = motionAt(h, "2026-10-04T10:00:00+08:00");
  const denied = outcomeFor(morning.decision, h.devices.childCamera.id);
  assert.equal(denied.status, "suppressed");
  assert.equal(denied.suppressor.type, "consent");
  assert.match(denied.reason, /监护人/);

  // 未成年人不能为自己授予同意
  assert.throws(
    () => grantConsent(h.store, h.members.child.id, { grantor_id: h.members.child.id, capability: "camera.capture", now: T0 }),
    ForbiddenError,
  );

  // 监护人代为授予（限定儿童房范围）→ 执行
  const granted = grantConsent(h.store, h.members.child.id, {
    grantor_id: h.members.owner.id,
    capability: "camera.capture",
    room_ids: [h.rooms.childRoom.id],
    now: T0,
  });
  const allowed = motionAt(h, "2026-10-04T10:05:00+08:00");
  assert.equal(outcomeFor(allowed.decision, h.devices.childCamera.id).status, "executed");

  // 撤回同意 → 再次压制
  const consent = granted.state.consents.at(-1);
  revokeConsent(h.store, h.members.child.id, consent.id, { actor_id: h.members.owner.id, now: T0 });
  const revoked = motionAt(h, "2026-10-04T10:10:00+08:00");
  assert.equal(outcomeFor(revoked.decision, h.devices.childCamera.id).status, "suppressed");
});

test("位置采集影响全体成员，包括访客；allow 覆盖仅豁免本人", () => {
  const h = buildHousehold();
  const locationRule = createRule(h.store, {
    residence_id: h.res.id,
    created_by: h.members.owner.id,
    name: "在家统计",
    priority_class: "comfort",
    trigger: { type: "device_event", capability: "sensor.motion", device_id: h.devices.hallwayMotion.id, match: { state: "detected" } },
    actions: [{ device_id: h.devices.phoneHub.id, capability: "location.report", params: {} }],
    now: T0,
  });
  publishRule(h.store, locationRule.id, { actor_id: h.members.owner.id, now: T0 });
  const ping = (at) =>
    ingestTelemetry(h.store, telemetryEvent(h.devices.hallwayMotion.id, "sensor.motion", "detected", at));

  // 没有任何成员同意 → 压制
  assert.equal(outcomeFor(ping("2026-10-04T12:00:00+08:00").decision, h.devices.phoneHub.id).status, "suppressed");

  // 户主、室友、孩子（监护人代授）同意；老人用 allow 覆盖豁免自己
  grantConsent(h.store, h.members.owner.id, { grantor_id: h.members.owner.id, capability: "location.report", now: T0 });
  grantConsent(h.store, h.members.roommate.id, { grantor_id: h.members.roommate.id, capability: "location.report", now: T0 });
  grantConsent(h.store, h.members.child.id, { grantor_id: h.members.owner.id, capability: "location.report", now: T0 });
  createOverride(h.store, {
    residence_id: h.res.id,
    member_id: h.members.elder.id,
    capabilities: ["location.report"],
    effect: "allow",
    starts_at: "2026-10-04T00:00:00+08:00",
    ends_at: "2026-10-08T00:00:00+08:00",
    reason: "本人同意本周统计",
    now: T0,
  });
  assert.equal(outcomeFor(ping("2026-10-04T13:00:00+08:00").decision, h.devices.phoneHub.id).status, "executed");

  // 访客到访：位置采集影响全体成员，访客未同意 → 压制
  const guest = addMembership(h.store, {
    residence_id: h.res.id,
    name: "访客",
    role: "guest",
    valid_from: "2026-10-04T18:00:00+08:00",
    now: "2026-10-04T18:00:00+08:00",
  });
  const withGuest = ping("2026-10-04T19:00:00+08:00").decision;
  const guestDenied = outcomeFor(withGuest, h.devices.phoneHub.id);
  assert.equal(guestDenied.status, "suppressed");
  assert.equal(guestDenied.suppressor.id, guest.id);

  // 访客为本人授予同意 → 恢复执行
  grantConsent(h.store, guest.id, { grantor_id: guest.id, capability: "location.report", now: "2026-10-04T19:05:00+08:00" });
  assert.equal(outcomeFor(ping("2026-10-04T19:10:00+08:00").decision, h.devices.phoneHub.id).status, "executed");
});

test("未成年人权限更窄：不能创建规则、临时覆盖，其隐私时段不可被覆盖豁免", () => {
  const h = buildHousehold();
  // 未成年人不能创建临时覆盖
  assert.throws(
    () =>
      createOverride(h.store, {
        residence_id: h.res.id,
        member_id: h.members.child.id,
        capabilities: ["camera.capture"],
        effect: "allow",
        starts_at: "2026-10-04T20:00:00+08:00",
        ends_at: "2026-10-04T23:00:00+08:00",
        now: T0,
      }),
    ForbiddenError,
  );
  // 户主为孩子授予了摄像同意，但隐私时段（19:00–07:00）仍然生效
  grantConsent(h.store, h.members.child.id, {
    grantor_id: h.members.owner.id,
    capability: "camera.capture",
    room_ids: [h.rooms.childRoom.id],
    now: T0,
  });
  publishCameraRule(h);
  const night = motionAt(h, "2026-10-04T21:00:00+08:00");
  assert.equal(outcomeFor(night.decision, h.devices.childCamera.id).status, "suppressed");
});
