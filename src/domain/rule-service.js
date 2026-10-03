/**
 * 规则发布服务。
 *
 * 规则结构（品牌无关）：
 * {
 *   id, residenceId, name, ownerPersonId,
 *   scope: "residence"|"room"|"personal", roomId?,
 *   priorityBasis: PRIORITY_BASIS.*,
 *   trigger: { capability, states?: [...], sensorAlerts?: ["water_leak",...], rooms?: [roomId] },
 *   actions: [ { deviceId, capability, setState, duration?: {maxMs, fadeMs?} } ],
 *   schedule: { ...时段 },                // 规则适用时段
 *   validity: { notBefore?, notAfter? },  // 绝对有效期
 *   status,
 *   createdAt, publishedAt
 * }
 *
 * 发布前必须通过循环与互斥静态分析；失败返回 RULE_REJECTED 事件与结构化诊断。
 */
import {
  AGGREGATE_TYPE,
  EVENT_KIND,
  EVENT_TYPE,
  PRIORITY_BASIS,
  RULE_SCOPE,
  RULE_STATUS,
} from "./constants.js";
import { DomainError } from "./store.js";
import { findCycles, findMutexConflicts } from "./analysis.js";
import { newId, scheduleActiveAt, toDate } from "./time.js";

export class RuleService {
  constructor(store, registration, clock = () => new Date()) {
    this.store = store;
    this.registration = registration;
    this.clock = clock;
  }

  /**
   * 发布（或更新）规则。
   * 传入 ruleId 表示更新已有规则，需带 expectedVersion。
   * 返回 { rule, rejected: null } 或 { rejected: diagnostics }（规则不生效）。
   */
  async publishRule(input, expectedVersion = undefined) {
    const rule = this._normalize(input);

    // 作者须为住房当前生效成员；个人规则只能支配本人范围
    const memberships = this.registration.activeMemberships(rule.residenceId, rule.ownerPersonId);
    if (memberships.length === 0) {
      throw new DomainError("NOT_MEMBER", "规则发布者在该住房无生效成员关系");
    }
    if (rule.scope === RULE_SCOPE.PERSONAL) {
      const ownRooms = new Set(memberships.flatMap((m) => m.occupiesRooms || []));
      for (const action of rule.actions) {
        const dev = this.store.get(AGGREGATE_TYPE.DEVICE_CAPABILITY, action.deviceId);
        if (!dev) throw new DomainError("DEVICE_NOT_FOUND", `动作目标设备不存在：${action.deviceId}`);
        if (dev.roomId && !ownRooms.has(dev.roomId)) {
          throw new DomainError("SCOPE_FORBIDDEN", "个人规则只能支配本人使用空间内的设备");
        }
      }
    }

    // 动作目标设备/状态合法性
    for (const action of rule.actions) {
      const dev = this.store.get(AGGREGATE_TYPE.DEVICE_CAPABILITY, action.deviceId);
      if (!dev) throw new DomainError("DEVICE_NOT_FOUND", `动作目标设备不存在：${action.deviceId}`);
      if (dev.residenceId !== rule.residenceId) {
        throw new DomainError("DEVICE_WRONG_RESIDENCE", "不能对其他住房的设备发布规则");
      }
      if (!dev.actions.includes(action.setState)) {
        throw new DomainError("UNSUPPORTED_STATE", `设备 ${action.deviceId} 不支持状态 ${action.setState}`);
      }
      action.capability = action.capability || dev.capability;
    }

    // 与全部生效规则一起做静态分析（先放候选集，分析后再决定是否落库）
    const candidate = { ...rule, status: RULE_STATUS.ACTIVE, id: rule.id, publishedAt: this.clock().toISOString() };
    const others = this.store
      .list(AGGREGATE_TYPE.AUTOMATION_RULE, (r) => r.residenceId === rule.residenceId)
      .filter((r) => r.status === RULE_STATUS.ACTIVE && r.id !== rule.id);
    const analysisSet = [...others, candidate];

    const cycles = findCycles(analysisSet);
    const mutex = findMutexConflicts(analysisSet);
    if (cycles.length > 0 || mutex.length > 0) {
      const diagnostics = { cycles, mutex };
      // 记录拒绝事件（聚合仍挂在候选规则 id 上，便于审计"为何没发出去"）
      await this.store.commit({
        aggregateType: AGGREGATE_TYPE.AUTOMATION_RULE,
        aggregateId: rule.id,
        eventType: EVENT_TYPE.RULE_PUBLISHED,
        expectedVersion,
        summary: `规则发布被拒绝：${rule.name}`,
        detail: { kind: EVENT_KIND.RULE_REJECTED, diagnostics, proposed: candidate },
        // 拒绝时不新建生效聚合；若为更新则保留旧版本
        mutate: (existing) => {
          if (!existing && expectedVersion === undefined) {
            // 保留一份 rejected 草稿，可见但绝不参与裁决
            return { ...candidate, status: RULE_STATUS.DRAFT, rejected: diagnostics };
          }
          if (existing) return { ...existing, lastRejection: diagnostics };
          return undefined;
        },
      });
      return { rule: this.store.get(AGGREGATE_TYPE.AUTOMATION_RULE, rule.id), rejected: diagnostics };
    }

    const { data } = await this.store.commit({
      aggregateType: AGGREGATE_TYPE.AUTOMATION_RULE,
      aggregateId: rule.id,
      eventType: EVENT_TYPE.RULE_PUBLISHED,
      expectedVersion,
      summary: `规则发布：${rule.name}`,
      detail: { kind: EVENT_KIND.RULE_CREATED, rule: { ...candidate, version: undefined } },
      mutate: (existing) => ({
        ...(existing || {}),
        ...candidate,
        rejected: undefined,
        lastRejection: undefined,
        createdAt: existing?.createdAt || candidate.publishedAt,
      }),
    });
    return { rule: data, rejected: null };
  }

  /** 停用规则（交接/作者撤权时使用） */
  async suspendRule(ruleId, reason, expectedVersion = undefined) {
    const rule = this.store.get(AGGREGATE_TYPE.AUTOMATION_RULE, ruleId);
    if (!rule) return null;
    const { data } = await this.store.commit({
      aggregateType: AGGREGATE_TYPE.AUTOMATION_RULE,
      aggregateId: ruleId,
      eventType: EVENT_TYPE.RULE_PUBLISHED,
      expectedVersion: expectedVersion ?? rule.version,
      summary: `规则停用：${rule.name}（${reason}）`,
      detail: { kind: EVENT_KIND.RULE_SUSPENDED, reason },
      mutate: (r) => ({ ...r, status: RULE_STATUS.SUSPENDED, suspendedReason: reason }),
    });
    return data;
  }

  listActive(residenceId) {
    return this.store.list(AGGREGATE_TYPE.AUTOMATION_RULE, (r) => r.residenceId === residenceId && r.status === RULE_STATUS.ACTIVE);
  }

  _normalize(input) {
    if (!input.residenceId) throw new DomainError("INVALID_RULE", "规则缺少 residenceId");
    if (!input.ownerPersonId) throw new DomainError("INVALID_RULE", "规则缺少 ownerPersonId");
    if (!input.trigger || !input.trigger.capability) throw new DomainError("INVALID_RULE", "规则缺少 trigger.capability");
    if (!Array.isArray(input.actions) || input.actions.length === 0) {
      throw new DomainError("INVALID_RULE", "规则至少包含一个动作");
    }
    if (!Object.values(PRIORITY_BASIS).includes(input.priorityBasis)) {
      throw new DomainError("INVALID_RULE", `规则缺少有效的 priorityBasis：${input.priorityBasis}`);
    }
    const now = this.clock();
    return {
      id: input.ruleId || input.id || newId("rule"),
      residenceId: input.residenceId,
      name: input.name || input.id || "未命名规则",
      ownerPersonId: input.ownerPersonId,
      scope: input.scope || RULE_SCOPE.RESIDENCE,
      roomId: input.roomId || null,
      priorityBasis: input.priorityBasis,
      trigger: input.trigger,
      actions: input.actions.map((a) => ({ ...a })),
      schedule: input.schedule || { kind: "always" },
      validity: input.validity || {},
      createdAt: input.createdAt || now.toISOString(),
    };
  }
}

/** 规则在 at 时刻是否处于适用时段与有效期 */
export function ruleApplicableAt(rule, at) {
  const t = toDate(at);
  const v = rule.validity || {};
  if (v.notBefore && t < toDate(v.notBefore)) return false;
  if (v.notAfter && t > toDate(v.notAfter)) return false;
  return scheduleActiveAt(rule.schedule, t);
}
