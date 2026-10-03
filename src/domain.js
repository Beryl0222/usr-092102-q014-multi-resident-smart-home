import { ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import { newId } from "./store.js";
import { normalizeWindow, windowContains } from "./windows.js";

// 厂商中立的能力词汇表：后端只按能力裁决，不直接对接任何品牌协议。
// kind=capture 的能力（摄像、语音、位置）受全体受影响成员的同意与隐私时段约束。
export const CAPABILITIES = {
  "valve.actuate": { kind: "actuator", states: ["open", "close"] },
  "switch.set": { kind: "actuator", states: ["on", "off"] },
  "light.set": { kind: "actuator", states: ["on", "off"] },
  "plug.set": { kind: "actuator", states: ["on", "off"] },
  "lock.set": { kind: "actuator", states: ["locked", "unlocked"] },
  "hvac.setpoint": { kind: "actuator" },
  "camera.capture": { kind: "capture", states: ["start", "stop"] },
  "microphone.capture": { kind: "capture", states: ["start", "stop"] },
  "location.report": { kind: "capture" },
  "sensor.leak": { kind: "sensor", states: ["detected", "clear"] },
  "sensor.motion": { kind: "sensor", states: ["detected", "clear"] },
  "sensor.smoke": { kind: "sensor", states: ["detected", "clear"] },
};

export const CAPTURE_KINDS = Object.entries(CAPABILITIES)
  .filter(([, spec]) => spec.kind === "capture")
  .map(([key]) => key);

export const ROLES = ["owner", "tenant", "resident", "guest"];

// ---------- 住房与房间 ----------

export function createResidence(store, { name }) {
  if (!name || typeof name !== "string") throw new ValidationError(["住房名称不能为空"]);
  const id = newId("res");
  store.createAggregate("residence", id, { name, rooms: [], sealed_member_ids: [] });
  return store.getAggregate(id);
}

export function addRoom(store, residenceId, { name }, expectedVersion = null) {
  if (!name) throw new ValidationError(["房间名称不能为空"]);
  const room = { id: newId("room"), name };
  store.mutateAggregate(residenceId, expectedVersion, (state) => {
    state.rooms.push(room);
  });
  return room;
}

export function getResidence(store, residenceId) {
  const residence = store.getAggregate(residenceId);
  if (residence.type !== "residence") throw new NotFoundError(`住房不存在：${residenceId}`);
  return residence;
}

// ---------- 设备能力 ----------

export function registerDevice(store, { residence_id, room_id, label, capabilities, integration = "local" }) {
  const residence = getResidence(store, residence_id);
  if (!residence.state.rooms.some((room) => room.id === room_id)) {
    throw new ValidationError([`房间不存在：${room_id}`]);
  }
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new ValidationError(["设备至少需要一项能力"]);
  }
  for (const capability of capabilities) {
    if (!CAPABILITIES[capability]) throw new ValidationError([`未知能力：${capability}`]);
  }
  const id = newId("dev");
  store.createAggregate("device", id, {
    residence_id,
    room_id,
    label: label ?? id,
    capabilities: [...new Set(capabilities)],
    integration, // 设备当前由哪个集成层落地（local 或某厂商云），裁决层不关心品牌
    connectivity: "online",
    state: {}, // capability -> 最近一次已知状态
  });
  return store.getAggregate(id);
}

export function devicesOf(store, residenceId) {
  return store.aggregatesOfType("device").filter((device) => device.state.residence_id === residenceId);
}

// ---------- 成员（产权/租住/居民/访客） ----------

export function addMembership(
  store,
  { residence_id, name, role, is_minor = false, guardian_id = null, room_ids = [], valid_from, valid_until = null, now },
) {
  getResidence(store, residence_id);
  if (!ROLES.includes(role)) throw new ValidationError([`角色必须是：${ROLES.join("、")}`]);
  if (!name) throw new ValidationError(["成员姓名不能为空"]);
  if (is_minor && !guardian_id) throw new ValidationError(["未成年人必须登记监护人"]);
  if (guardian_id) {
    const guardian = store.findAggregate(guardian_id);
    if (!guardian || guardian.state.residence_id !== residence_id || guardian.state.status !== "active") {
      throw new ValidationError(["监护人必须是该住房的有效成员"]);
    }
  }
  const id = newId("mem");
  store.createAggregate("residence_membership", id, {
    residence_id,
    name,
    role,
    is_minor,
    guardian_id,
    room_ids,
    privacy_windows: [],
    consents: [],
    valid_from: valid_from ?? now,
    valid_until,
    status: "active",
  });
  store.appendEvent({
    event_type: "MEMBERSHIP_CHANGED",
    aggregate_type: "residence_membership",
    aggregate_id: id,
    occurred_at: now,
    version: 1,
    summary: `成员加入：${name}（${role}）`,
    detail: { change: "joined", role, is_minor },
  });
  return store.getAggregate(id);
}

export function endMembership(store, membershipId, { now, reason = "ended", expected_version = null }) {
  const current = store.getAggregate(membershipId);
  if (current.state.status !== "active") return current;
  const aggregate = store.mutateAggregate(membershipId, expected_version, (state) => {
    state.status = "ended";
    state.valid_until = now;
    // 成员关系结束时，其授予的所有同意一并撤回
    for (const consent of state.consents) {
      if (!consent.revoked_at) consent.revoked_at = now;
    }
  });
  store.appendEvent({
    event_type: "MEMBERSHIP_CHANGED",
    aggregate_type: "residence_membership",
    aggregate_id: membershipId,
    occurred_at: now,
    version: aggregate.version,
    summary: `成员退出：${aggregate.state.name}`,
    detail: { change: reason },
  });
  return aggregate;
}

// ---------- 可撤回同意 ----------

export function grantConsent(
  store,
  membershipId,
  { grantor_id, capability, room_ids = null, window = null, now, expected_version = null },
) {
  const membership = store.getAggregate(membershipId);
  if (membership.state.status !== "active") throw new ForbiddenError("成员关系已结束，无法授予同意");
  const grantor = store.getAggregate(grantor_id);
  if (grantor.state.residence_id !== membership.state.residence_id || grantor.state.status !== "active") {
    throw new ForbiddenError("授权人必须是同一住房的有效成员");
  }
  // 未成年人权限更窄：同意只能由监护人或产权人代为授予
  if (membership.state.is_minor) {
    const isGuardian = grantor_id === membership.state.guardian_id || grantor.state.role === "owner";
    if (!isGuardian) throw new ForbiddenError("未成年人的同意只能由监护人或产权人授予");
  } else if (grantor_id !== membershipId && grantor.state.role !== "owner") {
    throw new ForbiddenError("只能为本人授予同意");
  }
  if (capability !== "*" && !CAPTURE_KINDS.includes(capability)) {
    throw new ValidationError([`同意仅适用于采集类能力（${CAPTURE_KINDS.join("、")}）或 *`]);
  }
  const normalizedWindow = normalizeWindow(window, "consent.window");
  const aggregate = store.mutateAggregate(membershipId, expected_version, (state) => {
    state.consents.push({
      id: newId("con"),
      capability,
      room_ids,
      window: normalizedWindow,
      granted_at: now,
      granted_by: grantor_id,
      revoked_at: null,
    });
  });
  store.appendEvent({
    event_type: "MEMBERSHIP_CHANGED",
    aggregate_type: "residence_membership",
    aggregate_id: membershipId,
    occurred_at: now,
    version: aggregate.version,
    summary: `授予同意：${membership.state.name} → ${capability}`,
    detail: { change: "consent_granted", capability, room_ids, granted_by: grantor_id },
  });
  return aggregate;
}

export function revokeConsent(store, membershipId, consentId, { actor_id, now, expected_version = null }) {
  const membership = store.getAggregate(membershipId);
  const actor = actor_id ? store.findAggregate(actor_id) : null;
  const isSelf = actor_id === membershipId;
  const isGuardian = actor && actor_id === membership.state.guardian_id;
  const isOwner = actor && actor.state.role === "owner" && actor.state.residence_id === membership.state.residence_id;
  if (!isSelf && !isGuardian && !isOwner) {
    throw new ForbiddenError("只有本人、监护人或产权人可以撤回同意");
  }
  const aggregate = store.mutateAggregate(membershipId, expected_version, (state) => {
    const consent = state.consents.find((item) => item.id === consentId);
    if (!consent) throw new NotFoundError(`同意不存在：${consentId}`);
    if (consent.revoked_at) throw new ValidationError(["该同意已撤回"]);
    consent.revoked_at = now;
  });
  store.appendEvent({
    event_type: "MEMBERSHIP_CHANGED",
    aggregate_type: "residence_membership",
    aggregate_id: membershipId,
    occurred_at: now,
    version: aggregate.version,
    summary: `撤回同意：${membership.state.name}`,
    detail: { change: "consent_revoked", consent_id: consentId },
  });
  return aggregate;
}

// ---------- 个人隐私时段（成员级硬约束） ----------

export function addPrivacyWindow(
  store,
  membershipId,
  { capability, room_ids = null, window, actor_id, now, expected_version = null },
) {
  const membership = store.getAggregate(membershipId);
  if (membership.state.status !== "active") throw new ForbiddenError("成员关系已结束");
  if (capability !== "*" && !CAPTURE_KINDS.includes(capability)) {
    throw new ValidationError([`隐私时段仅适用于采集类能力（${CAPTURE_KINDS.join("、")}）或 *`]);
  }
  const actor = actor_id ? store.findAggregate(actor_id) : null;
  const isOwner = actor && actor.state.role === "owner" && actor.state.residence_id === membership.state.residence_id;
  if (membership.state.is_minor) {
    // 未成年人的隐私时段由监护人或产权人设置
    if (actor_id !== membership.state.guardian_id && !isOwner) {
      throw new ForbiddenError("未成年人的隐私时段只能由监护人或产权人设置");
    }
  } else if (actor_id !== membershipId && !isOwner) {
    throw new ForbiddenError("只能为本人设置隐私时段");
  }
  const normalizedWindow = normalizeWindow(window, "privacy_window");
  if (!normalizedWindow) throw new ValidationError(["隐私时段不能为空"]);
  const aggregate = store.mutateAggregate(membershipId, expected_version, (state) => {
    state.privacy_windows.push({
      id: newId("pw"),
      capability,
      room_ids,
      window: normalizedWindow,
      created_at: now,
      created_by: actor_id,
    });
  });
  store.appendEvent({
    event_type: "MEMBERSHIP_CHANGED",
    aggregate_type: "residence_membership",
    aggregate_id: membershipId,
    occurred_at: now,
    version: aggregate.version,
    summary: `设置隐私时段：${membership.state.name} → ${capability}`,
    detail: { change: "privacy_window_added", capability, room_ids, window: normalizedWindow },
  });
  return aggregate;
}

// ---------- 查询与权限 ----------

export function activeMemberships(store, residenceId, now) {
  const at = Date.parse(now);
  return store
    .aggregatesOfType("residence_membership")
    .filter(
      (member) =>
        member.state.residence_id === residenceId &&
        member.state.status === "active" &&
        Date.parse(member.state.valid_from) <= at &&
        (!member.state.valid_until || at < Date.parse(member.state.valid_until)),
    );
}

// 交接生效后旧住户立即失去访问权：成员关系状态与有效期双重判断。
export function canAccess(store, membershipId, at) {
  const member = store.findAggregate(membershipId);
  if (!member || member.type !== "residence_membership" || member.state.status !== "active") return false;
  const time = Date.parse(at);
  if (time < Date.parse(member.state.valid_from)) return false;
  if (member.state.valid_until && time >= Date.parse(member.state.valid_until)) return false;
  return true;
}

export function hasConsent(memberState, capability, roomId, now) {
  const at = Date.parse(now);
  return memberState.consents.some(
    (consent) =>
      !consent.revoked_at &&
      (consent.capability === "*" || consent.capability === capability) &&
      (consent.room_ids == null || consent.room_ids.includes(roomId)) &&
      Date.parse(consent.granted_at) <= at &&
      windowContains(consent.window, now),
  );
}

export function privacyWindowBlocks(memberState, capability, roomId, now) {
  return memberState.privacy_windows.some(
    (entry) =>
      (entry.capability === "*" || entry.capability === capability) &&
      (entry.room_ids == null || entry.room_ids.includes(roomId)) &&
      windowContains(entry.window, now),
  );
}

// 发布权限：产权人/承租人可发布全部类别；成年居民只能发布舒适/节能类；未成年人与访客不能发布。
export function canPublish(memberState, priorityClass) {
  if (memberState.is_minor) return false;
  if (memberState.role === "owner" || memberState.role === "tenant") return true;
  return memberState.role === "resident" && (priorityClass === "comfort" || priorityClass === "energy");
}

export function canManageMembers(memberState) {
  return memberState.role === "owner" && !memberState.is_minor;
}

export function canManageTransfers(memberState) {
  return (memberState.role === "owner" || memberState.role === "tenant") && !memberState.is_minor;
}

export function canCreateOverride(memberState) {
  return !memberState.is_minor && memberState.role !== "guest";
}
