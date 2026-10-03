import { ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import { CAPABILITIES, canPublish, devicesOf, getResidence } from "./domain.js";
import { newId } from "./store.js";
import { normalizeWindow, parseHHMM, windowsOverlap } from "./windows.js";

// 优先级依据：安全处置 > 隐私保护 > 照护需求 > 舒适偏好 > 节能偏好。
// 数值仅用于排序，裁决记录中会同时保存类别与依据说明。
export const PRIORITY_CLASSES = { safety: 100, privacy: 90, care: 80, comfort: 50, energy: 10 };
export const PRIORITY_LABELS = {
  safety: "安全处置",
  privacy: "隐私保护",
  care: "照护需求",
  comfort: "舒适偏好",
  energy: "节能偏好",
};

export function createRule(
  store,
  {
    residence_id,
    created_by,
    name,
    priority_class,
    rank = 0,
    trigger,
    actions,
    window = null,
    maintain = false,
    action_ttl_seconds = 300,
    now,
  },
) {
  getResidence(store, residence_id);
  const creator = store.getAggregate(created_by);
  if (creator.state.residence_id !== residence_id || creator.state.status !== "active") {
    throw new ForbiddenError("只有本住房的有效成员可以创建规则");
  }
  if (creator.state.is_minor) throw new ForbiddenError("未成年人不能创建规则");
  if (creator.state.role === "guest") throw new ForbiddenError("访客不能创建规则");
  if (!PRIORITY_CLASSES[priority_class]) {
    throw new ValidationError([`优先级类别必须是：${Object.keys(PRIORITY_CLASSES).join("、")}`]);
  }
  if (!name) throw new ValidationError(["规则名称不能为空"]);
  if (!Array.isArray(actions) || actions.length === 0) throw new ValidationError(["规则至少需要一个动作"]);
  if (!Number.isInteger(action_ttl_seconds) || action_ttl_seconds < 0) {
    throw new ValidationError(["action_ttl_seconds 必须是非负整数"]);
  }
  const normalizedWindow = normalizeWindow(window, "rule.window");
  validateTrigger(trigger);
  const devices = new Map(devicesOf(store, residence_id).map((device) => [device.id, device.state]));
  for (const action of actions) validateAction(action, devices);
  const id = newId("rule");
  store.createAggregate("automation_rule", id, {
    residence_id,
    created_by,
    name,
    priority_class,
    rank,
    trigger,
    actions,
    window: normalizedWindow,
    maintain, // 维持型规则在适用时段内形成持续主张，压制与其冲突的低优先级动作
    action_ttl_seconds, // 设备离线时动作排队有效期，过期不再补执行
    status: "draft",
    published_at: null,
  });
  return store.getAggregate(id);
}

function validateTrigger(trigger) {
  if (!trigger || !["device_event", "schedule", "window"].includes(trigger.type)) {
    throw new ValidationError(["触发器类型必须是 device_event、schedule 或 window"]);
  }
  if (trigger.type === "device_event" && !CAPABILITIES[trigger.capability]) {
    throw new ValidationError([`触发器引用了未知能力：${trigger.capability}`]);
  }
  if (trigger.type === "schedule") parseHHMM(trigger.at, "trigger.at");
}

function validateAction(action, devices) {
  const device = devices.get(action.device_id);
  if (!device) throw new ValidationError([`动作引用了不存在的设备：${action.device_id}`]);
  if (!device.capabilities.includes(action.capability)) {
    throw new ValidationError([`设备 ${action.device_id} 不具备能力 ${action.capability}`]);
  }
  const spec = CAPABILITIES[action.capability];
  if (spec.states && action.params?.state != null && !spec.states.includes(action.params.state)) {
    throw new ValidationError([`能力 ${action.capability} 不支持状态 ${action.params.state}`]);
  }
}

export function publishedRules(store, residenceId) {
  return store
    .aggregatesOfType("automation_rule")
    .filter((rule) => rule.state.residence_id === residenceId && rule.state.status === "published");
}

// ---------- 发布前静态分析：互斥动作 ----------

// 同设备同能力、目标状态（或设定值）不同即互斥。
export function actionsConflict(a, b) {
  if (a.device_id !== b.device_id || a.capability !== b.capability) return false;
  const stateA = a.params?.state;
  const stateB = b.params?.state;
  if (stateA != null && stateB != null) return stateA !== stateB;
  const setpointA = a.params?.setpoint;
  const setpointB = b.params?.setpoint;
  if (setpointA != null && setpointB != null) return setpointA !== setpointB;
  return false;
}

export function findConflicts(candidate, published) {
  const conflicts = [];
  for (const other of published) {
    if (other.id === candidate.id) continue;
    if (!windowsOverlap(candidate.window, other.window)) continue;
    for (const actionA of candidate.actions) {
      for (const actionB of other.actions) {
        if (actionsConflict(actionA, actionB)) {
          conflicts.push({
            other_rule_id: other.id,
            other_rule_name: other.name,
            device_id: actionA.device_id,
            capability: actionA.capability,
            candidate_params: actionA.params ?? null,
            other_params: actionB.params ?? null,
            same_class: other.priority_class === candidate.priority_class,
          });
        }
      }
    }
  }
  return conflicts;
}

// ---------- 发布前静态分析：触发循环 ----------

// 动作执行后会产生同设备同能力的状态事件，可能触发其他规则。
function producedBy(action) {
  return { device_id: action.device_id, capability: action.capability, state: action.params?.state ?? null };
}

export function triggerMatchesProduced(trigger, produced, devicesById) {
  if (trigger.type !== "device_event" || trigger.capability !== produced.capability) return false;
  if (trigger.device_id && trigger.device_id !== produced.device_id) return false;
  if (trigger.room_id && devicesById.get(produced.device_id)?.room_id !== trigger.room_id) return false;
  if (trigger.match?.state != null && produced.state != null && trigger.match.state !== produced.state) return false;
  return true;
}

// 在规则集合（含候选规则）上检测触发循环，返回循环路径或 null。
export function findCycle(rules, devicesById) {
  const adjacency = new Map(rules.map((rule) => [rule.id, []]));
  for (const source of rules) {
    for (const target of rules) {
      const hits = source.actions.some((action) => triggerMatchesProduced(target.trigger, producedBy(action), devicesById));
      if (hits) adjacency.get(source.id).push(target.id);
    }
  }
  const color = new Map(rules.map((rule) => [rule.id, 0])); // 0=未访问 1=在栈中 2=已完成
  const stack = [];
  let cycle = null;
  const visit = (id) => {
    if (cycle) return;
    color.set(id, 1);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      if (cycle) return;
      if (color.get(next) === 1) {
        cycle = [...stack.slice(stack.indexOf(next)), next];
        return;
      }
      if (color.get(next) === 0) visit(next);
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const rule of rules) {
    if (cycle) break;
    if (color.get(rule.id) === 0) visit(rule.id);
  }
  return cycle;
}

// ---------- 发布与停用 ----------

export function publishRule(store, ruleId, { actor_id, expected_version = null, now }) {
  const aggregate = store.getAggregate(ruleId);
  if (aggregate.type !== "automation_rule") throw new NotFoundError(`规则不存在：${ruleId}`);
  const rule = { id: aggregate.id, ...aggregate.state };
  if (rule.status !== "draft") throw new ValidationError([`规则当前状态为 ${rule.status}，不能发布`]);
  const actor = store.getAggregate(actor_id);
  if (!canPublish(actor.state, rule.priority_class)) {
    throw new ForbiddenError("当前成员无权发布该类规则");
  }
  const published = publishedRules(store, rule.residence_id).map((item) => ({ id: item.id, ...item.state }));
  const devicesById = new Map(devicesOf(store, rule.residence_id).map((device) => [device.id, device.state]));

  // 发布前识别循环：候选规则加入后不得形成触发环
  const cycle = findCycle([...published, rule], devicesById);
  if (cycle) throw new ValidationError([`发布会形成触发循环：${cycle.join(" → ")}`]);

  // 发布前识别互斥动作：同级互斥直接拒绝；跨级互斥登记为 CONFLICT_DETECTED，运行时按优先级裁决
  const conflicts = findConflicts(rule, published);
  const blocking = conflicts.filter((conflict) => conflict.same_class);
  if (blocking.length > 0) {
    throw new ValidationError(
      blocking.map(
        (conflict) =>
          `与规则「${conflict.other_rule_name}」在设备 ${conflict.device_id} 上存在同级互斥动作，请调整适用时段或优先级`,
      ),
    );
  }

  const updated = store.mutateAggregate(ruleId, expected_version, (state) => {
    state.status = "published";
    state.published_at = now;
  });
  store.appendEvent({
    event_type: "RULE_PUBLISHED",
    aggregate_type: "automation_rule",
    aggregate_id: ruleId,
    occurred_at: now,
    version: updated.version,
    summary: `规则发布：${rule.name}（${PRIORITY_LABELS[rule.priority_class]}）`,
    detail: {
      priority_class: rule.priority_class,
      rank: rule.rank,
      maintain: rule.maintain,
      cross_class_conflicts: conflicts,
    },
  });
  for (const conflict of conflicts) {
    store.appendEvent({
      event_type: "CONFLICT_DETECTED",
      aggregate_type: "automation_rule",
      aggregate_id: ruleId,
      occurred_at: now,
      version: updated.version,
      summary: `互斥动作已登记：${rule.name} 与 ${conflict.other_rule_name}（运行时按优先级裁决）`,
      detail: conflict,
    });
  }
  return updated;
}

export function retireRule(store, ruleId, { actor_id, expected_version = null, now }) {
  const aggregate = store.getAggregate(ruleId);
  if (aggregate.type !== "automation_rule") throw new NotFoundError(`规则不存在：${ruleId}`);
  const actor = store.getAggregate(actor_id);
  if (!canPublish(actor.state, aggregate.state.priority_class)) {
    throw new ForbiddenError("当前成员无权停用该类规则");
  }
  return store.mutateAggregate(ruleId, expected_version, (state) => {
    if (state.status !== "published") throw new ValidationError(["只有已发布的规则可以停用"]);
    state.status = "retired";
    state.retired_at = now;
  });
}
