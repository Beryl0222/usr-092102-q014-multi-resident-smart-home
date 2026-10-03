import {
  activeMemberships,
  canCreateOverride,
  CAPABILITIES,
  devicesOf,
  hasConsent,
  privacyWindowBlocks,
} from "./domain.js";
import { ForbiddenError, ValidationError } from "./errors.js";
import { PRIORITY_CLASSES, PRIORITY_LABELS, actionsConflict, publishedRules } from "./rules.js";
import { newId } from "./store.js";
import { localParts, parseHHMM, windowContains } from "./windows.js";

const CAPTURE_SET = new Set(Object.entries(CAPABILITIES).filter(([, spec]) => spec.kind === "capture").map(([key]) => key));

// 优先级依据 = 类别权重 * 1000 + 类内序号，保证类别优先、同类按序号。
function priorityOf(rule) {
  return PRIORITY_CLASSES[rule.priority_class] * 1000 + (rule.rank ?? 0);
}

function byPriorityDesc(a, b) {
  return (
    priorityOf(b.rule) - priorityOf(a.rule) ||
    String(a.rule.published_at ?? "").localeCompare(String(b.rule.published_at ?? "")) ||
    a.rule.id.localeCompare(b.rule.id)
  );
}

// ---------- 临时覆盖 ----------

export function createOverride(
  store,
  {
    residence_id,
    member_id,
    device_ids = [],
    room_ids = [],
    capabilities = [],
    rule_ids = [],
    effect,
    starts_at,
    ends_at,
    reason = "",
    now,
  },
) {
  const member = store.getAggregate(member_id);
  if (member.state.residence_id !== residence_id || member.state.status !== "active") {
    throw new ForbiddenError("只有本住房的有效成员可以创建临时覆盖");
  }
  if (!canCreateOverride(member.state)) {
    throw new ForbiddenError("未成年人与访客不能创建临时覆盖，需由监护人或成年住户安排");
  }
  if (!["block", "allow"].includes(effect)) throw new ValidationError(["effect 必须是 block 或 allow"]);
  if (!starts_at || !ends_at || Number.isNaN(Date.parse(starts_at)) || Number.isNaN(Date.parse(ends_at))) {
    throw new ValidationError(["临时覆盖必须有明确的起止时间"]);
  }
  if (Date.parse(ends_at) <= Date.parse(starts_at)) throw new ValidationError(["结束时间必须晚于开始时间"]);
  if (Date.parse(ends_at) <= Date.parse(now)) throw new ValidationError(["临时覆盖的结束时间必须晚于当前时间"]);
  const devices = devicesOf(store, residence_id);
  for (const deviceId of device_ids) {
    if (!devices.some((device) => device.id === deviceId)) {
      throw new ValidationError([`设备不属于本住房：${deviceId}`]);
    }
  }
  for (const ruleId of rule_ids) {
    const rule = store.findAggregate(ruleId);
    if (!rule || rule.state.residence_id !== residence_id) {
      throw new ValidationError([`规则不属于本住房：${ruleId}`]);
    }
  }
  const id = newId("ovr");
  store.createAggregate("temporary_override", id, {
    residence_id,
    member_id,
    device_ids,
    room_ids,
    capabilities,
    rule_ids, // 定向覆盖：只压制指定规则；为空表示适用于全部非安全类规则
    effect,
    starts_at,
    ends_at,
    reason,
    status: "active",
    created_at: now,
  });
  return store.getAggregate(id);
}

export function cancelOverride(store, overrideId, { actor_id, now, expected_version = null }) {
  const aggregate = store.getAggregate(overrideId);
  if (actor_id !== aggregate.state.member_id) {
    const actor = store.getAggregate(actor_id);
    if (actor.state.role !== "owner" || actor.state.residence_id !== aggregate.state.residence_id) {
      throw new ForbiddenError("只有创建者或产权人可以取消临时覆盖");
    }
  }
  return store.mutateAggregate(overrideId, expected_version, (state) => {
    if (state.status !== "active") throw new ValidationError(["临时覆盖已结束"]);
    state.status = "cancelled";
    state.cancelled_at = now;
  });
}

function activeOverrides(store, residenceId, now) {
  const time = Date.parse(now);
  return store
    .aggregatesOfType("temporary_override")
    .filter(
      (override) =>
        override.state.residence_id === residenceId &&
        override.state.status === "active" &&
        Date.parse(override.state.starts_at) <= time &&
        time < Date.parse(override.state.ends_at),
    )
    .map((override) => ({ id: override.id, ...override.state }));
}

function overrideMatches(override, deviceId, roomId, capability, ruleId = null) {
  const deviceOk =
    (override.device_ids.length === 0 && override.room_ids.length === 0) ||
    override.device_ids.includes(deviceId) ||
    override.room_ids.includes(roomId);
  const capabilityOk = override.capabilities.length === 0 || override.capabilities.includes(capability);
  const ruleOk = override.rule_ids.length === 0 || (ruleId != null && override.rule_ids.includes(ruleId));
  return deviceOk && capabilityOk && ruleOk;
}

// ---------- 触发匹配与条件维持 ----------

function triggerMatchesEvent(trigger, event, devicesById) {
  if (trigger.type !== "device_event") return false;
  if (trigger.capability !== event.capability) return false;
  if (trigger.device_id && trigger.device_id !== event.device_id) return false;
  if (trigger.room_id && devicesById.get(event.device_id)?.room_id !== trigger.room_id) return false;
  if (trigger.match?.state != null && trigger.match.state !== event.state) return false;
  return true;
}

function scheduleMatches(trigger, now) {
  const { minutes, weekday } = localParts(now);
  if (parseHHMM(trigger.at) !== minutes) return false;
  if (trigger.days && !trigger.days.includes(weekday)) return false;
  return true;
}

// 维持型规则的事件条件是否仍然成立（依据设备最新已知状态）。
function conditionHolds(trigger, devicesById) {
  if (trigger.type !== "device_event") return true;
  if (trigger.match?.state == null) return true;
  if (trigger.device_id) {
    return devicesById.get(trigger.device_id)?.state?.[trigger.capability] === trigger.match.state;
  }
  for (const device of devicesById.values()) {
    if (trigger.room_id && device.room_id !== trigger.room_id) continue;
    if (device.capabilities.includes(trigger.capability) && device.state?.[trigger.capability] === trigger.match.state) {
      return true;
    }
  }
  return false;
}

// ---------- 采集约束：摄像、语音、位置必须满足所有受影响成员的范围约束 ----------

function affectedMembers(store, residenceId, deviceState, capability, now) {
  const members = activeMemberships(store, residenceId, now);
  if (capability === "location.report") return members; // 位置采集影响全体成员
  const inRoom = members.filter((member) => member.state.room_ids.includes(deviceState.room_id));
  return inRoom.length > 0 ? inRoom : members; // 未指定居住者的公共区域视为影响全体成员
}

function captureFailures(store, residenceId, device, capability, now, overrides, ruleId = null) {
  const failures = [];
  for (const member of affectedMembers(store, residenceId, device.state, capability, now)) {
    // 成年成员可用 allow 类临时覆盖豁免自己的约束；未成年人的约束不可豁免
    if (!member.state.is_minor) {
      const waived = overrides.some(
        (override) =>
          override.effect === "allow" &&
          override.member_id === member.id &&
          overrideMatches(override, device.id, device.state.room_id, capability, ruleId),
      );
      if (waived) continue;
    }
    if (privacyWindowBlocks(member.state, capability, device.state.room_id, now)) {
      failures.push({
        type: "privacy_window",
        id: member.id,
        label: member.state.name,
        reason: `成员「${member.state.name}」的隐私时段禁止采集`,
      });
      continue;
    }
    if (!hasConsent(member.state, capability, device.state.room_id, now)) {
      failures.push({
        type: "consent",
        id: member.id,
        label: member.state.name,
        reason: member.state.is_minor
          ? `未成年人「${member.state.name}」缺少监护人同意`
          : `成员「${member.state.name}」未授予同意`,
      });
    }
  }
  return failures;
}

// ---------- 回执与裁决记录 ----------

function recordOutcome(store, decision, candidate, status, reason, suppressor, now, validUntil = null) {
  const receiptId = newId("rcpt");
  store.createAggregate("execution_receipt", receiptId, {
    decision_id: decision.id,
    residence_id: decision.residence_id,
    rule_id: candidate.rule.id,
    rule_name: candidate.rule.name,
    device_id: candidate.action.device_id,
    capability: candidate.action.capability,
    params: candidate.action.params ?? {},
    priority_class: candidate.rule.priority_class,
    rank: candidate.rule.rank ?? 0,
    status,
    reason,
    suppressor: suppressor ?? null,
    trigger: decision.trigger,
    decided_at: now,
    executed_at: null,
    valid_until: validUntil,
  });
  decision.outcomes.push({
    receipt_id: receiptId,
    rule_id: candidate.rule.id,
    action: candidate.action,
    status,
    reason,
    suppressor: suppressor ?? null,
  });
  return receiptId;
}

function executeAction(store, decision, candidate, now) {
  const receiptId = recordOutcome(store, decision, candidate, "executed", "已执行", null, now);
  // 厂商中立：裁决后端只记录设备的期望状态，具体品牌协议由集成层落地
  store.mutateAggregate(candidate.action.device_id, null, (state) => {
    state.state[candidate.action.capability] = candidate.action.params?.state ?? candidate.action.params ?? null;
  });
  const receipt = store.mutateAggregate(receiptId, null, (state) => {
    state.executed_at = now;
  });
  store.appendEvent({
    event_type: "ACTION_EXECUTED",
    aggregate_type: "execution_receipt",
    aggregate_id: receiptId,
    occurred_at: now,
    version: receipt.version,
    summary: `执行：${candidate.rule.name} → ${candidate.action.capability}`,
    detail: {
      decision_id: decision.id,
      device_id: candidate.action.device_id,
      capability: candidate.action.capability,
      params: candidate.action.params ?? {},
      priority_class: candidate.rule.priority_class,
    },
  });
  return receiptId;
}

// ---------- 裁决主流程 ----------

export function evaluateTrigger(store, residenceId, trigger, now) {
  const devices = devicesOf(store, residenceId);
  const devicesById = new Map(devices.map((device) => [device.id, device.state]));
  const rules = publishedRules(store, residenceId)
    .map((aggregate) => ({ id: aggregate.id, ...aggregate.state }))
    .filter((rule) => windowContains(rule.window, now));
  const overrides = activeOverrides(store, residenceId, now);

  // 1. 收集本轮候选动作（window 型触发器不产生即时动作，只参与维持主张）
  const candidates = [];
  for (const rule of rules) {
    const fired =
      (trigger.type === "device_event" && triggerMatchesEvent(rule.trigger, trigger, devicesById)) ||
      (trigger.type === "schedule" && rule.trigger.type === "schedule" && scheduleMatches(rule.trigger, now));
    if (!fired) continue;
    for (const action of rule.actions) candidates.push({ rule, action });
  }

  // 2. 收集有效主张：维持型规则在适用时段内持续主张设备状态
  //    （如漏水期间阀门必须关闭、夜间老人照明必须保持、儿童时段禁止摄像）。
  //    非安全类主张可被临时覆盖压制。
  const claims = [];
  for (const rule of rules) {
    if (!rule.maintain) continue;
    if (rule.trigger.type === "device_event" && !conditionHolds(rule.trigger, devicesById)) continue;
    for (const action of rule.actions) {
      const deviceState = devicesById.get(action.device_id);
      const blockedBy =
        rule.priority_class === "safety"
          ? null
          : overrides.find(
              (override) =>
                override.effect === "block" &&
                overrideMatches(override, action.device_id, deviceState?.room_id, action.capability, rule.id),
            );
      if (!blockedBy) claims.push({ rule, action });
    }
  }

  const decision = {
    id: newId("dec"),
    residence_id: residenceId,
    trigger,
    now,
    claims: claims.map((claim) => ({ rule_id: claim.rule.id, rule_name: claim.rule.name, action: claim.action })),
    outcomes: [],
  };

  // 3. 候选之间的互斥：同设备同能力目标不同，高优先级胜出，其余压制并登记冲突
  const groups = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.action.device_id}::${candidate.action.capability}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const survivors = [];
  for (const group of groups.values()) {
    group.sort(byPriorityDesc);
    const winner = group[0];
    survivors.push(winner);
    for (const loser of group.slice(1)) {
      const conflict = actionsConflict(winner.action, loser.action);
      recordOutcome(
        store,
        decision,
        loser,
        "suppressed",
        conflict ? "互斥动作被更高优先级规则压制" : "相同动作已合并执行",
        { type: "rule", id: winner.rule.id, label: winner.rule.name },
        now,
      );
      if (conflict) {
        store.appendEvent({
          event_type: "CONFLICT_DETECTED",
          aggregate_type: "automation_rule",
          aggregate_id: loser.rule.id,
          occurred_at: now,
          version: 1,
          summary: `运行时互斥：${loser.rule.name} 被 ${winner.rule.name} 压制`,
          detail: {
            loser_rule_id: loser.rule.id,
            winner_rule_id: winner.rule.id,
            device_id: loser.action.device_id,
            capability: loser.action.capability,
          },
        });
      }
    }
  }

  // 4. 主张压制候选：优先级不低于候选的相反主张生效
  const finalCandidates = [];
  for (const candidate of survivors) {
    const blocking = claims
      .filter((claim) => actionsConflict(claim.action, candidate.action))
      .sort(byPriorityDesc)[0];
    if (blocking && priorityOf(blocking.rule) >= priorityOf(candidate.rule)) {
      recordOutcome(
        store,
        decision,
        candidate,
        "suppressed",
        `被「${PRIORITY_LABELS[blocking.rule.priority_class]}」主张压制`,
        { type: "claim", id: blocking.rule.id, label: blocking.rule.name },
        now,
      );
      continue;
    }
    finalCandidates.push(candidate);
  }

  // 5. 约束检查与执行
  for (const candidate of finalCandidates) {
    const device = store.getAggregate(candidate.action.device_id);
    // 5a. 采集类能力：必须满足所有受影响成员的范围约束（安全类也不能豁免）
    if (CAPTURE_SET.has(candidate.action.capability)) {
      const failures = captureFailures(store, residenceId, device, candidate.action.capability, now, overrides, candidate.rule.id);
      if (failures.length > 0) {
        recordOutcome(
          store,
          decision,
          candidate,
          "suppressed",
          failures[0].reason,
          { type: failures[0].type, id: failures[0].id, label: failures[0].label },
          now,
        );
        continue;
      }
    }
    // 5b. 临时覆盖：安全类动作不受 block 覆盖影响
    if (candidate.rule.priority_class !== "safety") {
      const blocker = overrides.find(
        (override) =>
          override.effect === "block" &&
          overrideMatches(override, device.id, device.state.room_id, candidate.action.capability, candidate.rule.id),
      );
      if (blocker) {
        recordOutcome(
          store,
          decision,
          candidate,
          "suppressed",
          "被临时覆盖压制",
          { type: "override", id: blocker.id, label: blocker.reason || blocker.id },
          now,
        );
        continue;
      }
    }
    // 5c. 设备离线：动作排队并设有效期，恢复后重新判断，绝不直接补执行
    if (device.state.connectivity !== "online") {
      const validUntil = new Date(Date.parse(now) + candidate.rule.action_ttl_seconds * 1000).toISOString();
      recordOutcome(
        store,
        decision,
        candidate,
        "queued",
        "设备离线，动作排队等待恢复后重新判断",
        { type: "offline", id: device.id, label: device.state.label },
        now,
        validUntil,
      );
      continue;
    }
    // 5d. 执行
    executeAction(store, decision, candidate, now);
  }

  store.decisions.set(decision.id, decision);
  return decision;
}

export function evaluateSchedule(store, residenceId, now) {
  return evaluateTrigger(store, residenceId, { type: "schedule", at: now }, now);
}

// ---------- 设备事件摄取（符合 contracts/domain.schema.json） ----------

export function ingestTelemetry(store, envelope) {
  const { duplicate } = store.ingestEvent(envelope);
  if (duplicate) return { duplicate: true, decision: null };
  if (envelope.event_type !== "TELEMETRY_REPORTED") {
    throw new ValidationError(["设备事件必须使用 TELEMETRY_REPORTED 类型"]);
  }
  if (envelope.aggregate_type !== "device_capability") {
    throw new ValidationError(["设备事件的 aggregate_type 必须是 device_capability"]);
  }
  const device = store.getAggregate(envelope.aggregate_id);
  if (device.type !== "device") throw new ValidationError([`设备不存在：${envelope.aggregate_id}`]);
  const { capability, state } = envelope.detail ?? {};
  if (!capability) throw new ValidationError(["设备事件缺少 detail.capability"]);
  if (!device.state.capabilities.includes(capability)) {
    throw new ValidationError([`设备不具备能力 ${capability}`]);
  }
  store.mutateAggregate(device.id, null, (draft) => {
    draft.state[capability] = state;
  });
  const decision = evaluateTrigger(
    store,
    device.state.residence_id,
    { type: "device_event", device_id: device.id, capability, state },
    envelope.occurred_at,
  );
  return { duplicate: false, decision };
}

// ---------- 离线恢复：重新判断排队动作是否仍有效 ----------

export function setConnectivity(store, deviceId, status, now) {
  if (!["online", "offline"].includes(status)) throw new ValidationError(["连接状态必须是 online 或 offline"]);
  store.mutateAggregate(deviceId, null, (draft) => {
    draft.connectivity = status;
  });
  if (status === "online") return recoverDevice(store, deviceId, now);
  return { results: [] };
}

export function recoverDevice(store, deviceId, now) {
  const device = store.getAggregate(deviceId);
  store.mutateAggregate(deviceId, null, (draft) => {
    draft.connectivity = "online";
  });
  const queued = store
    .aggregatesOfType("execution_receipt")
    .filter((receipt) => receipt.state.device_id === deviceId && receipt.state.status === "queued");
  const results = queued.map((receipt) => rejudgeReceipt(store, receipt, now));
  return { device, results };
}

function rejudgeReceipt(store, receipt, now) {
  const state = receipt.state;
  const finish = (status, reason, suppressor = null) => {
    store.mutateAggregate(receipt.id, null, (draft) => {
      draft.status = status;
      draft.reason = reason;
      draft.suppressor = suppressor;
    });
    return { receipt_id: receipt.id, status, reason };
  };
  const expire = (reason) => finish("expired", reason);

  // 恢复时重新判断，过期动作绝不补执行（区别于厂商云端的断网补执行）
  if (state.valid_until && Date.parse(now) > Date.parse(state.valid_until)) {
    return expire("离线恢复时已超过有效期，过期动作不再补执行");
  }
  const ruleAggregate = store.findAggregate(state.rule_id);
  if (!ruleAggregate || ruleAggregate.state.status !== "published") return expire("规则已停用");
  if (!windowContains(ruleAggregate.state.window, now)) return expire("规则适用时段已过");

  const devices = devicesOf(store, state.residence_id);
  const devicesById = new Map(devices.map((item) => [item.id, item.state]));
  if (state.trigger?.type === "device_event") {
    const condition = {
      type: "device_event",
      capability: state.trigger.capability,
      device_id: state.trigger.device_id,
      match: { state: state.trigger.state },
    };
    if (!conditionHolds(condition, devicesById)) return expire("触发条件已消失");
  }

  const device = store.getAggregate(state.device_id);
  const overrides = activeOverrides(store, state.residence_id, now);
  if (CAPTURE_SET.has(state.capability)) {
    const failures = captureFailures(store, state.residence_id, device, state.capability, now, overrides, state.rule_id);
    if (failures.length > 0) {
      return finish("suppressed", failures[0].reason, { type: failures[0].type, id: failures[0].id, label: failures[0].label });
    }
  }
  if (state.priority_class !== "safety") {
    const blocker = overrides.find(
      (override) =>
        override.effect === "block" && overrideMatches(override, device.id, device.state.room_id, state.capability, state.rule_id),
    );
    if (blocker) return finish("suppressed", "被临时覆盖压制", { type: "override", id: blocker.id, label: blocker.reason || blocker.id });
  }

  // 仍然有效：执行并补记回执
  store.mutateAggregate(receipt.id, null, (draft) => {
    draft.status = "executed";
    draft.reason = "离线恢复后重新判断仍然有效，已执行";
    draft.executed_at = now;
  });
  store.mutateAggregate(device.id, null, (draft) => {
    draft.state[state.capability] = state.params?.state ?? state.params ?? null;
  });
  const updated = store.getAggregate(receipt.id);
  store.appendEvent({
    event_type: "ACTION_EXECUTED",
    aggregate_type: "execution_receipt",
    aggregate_id: receipt.id,
    occurred_at: now,
    version: updated.version,
    summary: `恢复后执行：${state.rule_name}`,
    detail: { decision_id: state.decision_id, recovered: true },
  });
  return { receipt_id: receipt.id, status: "executed", reason: "离线恢复后重新判断仍然有效，已执行" };
}
