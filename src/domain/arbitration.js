/**
 * 裁决引擎（品牌无关）。
 *
 * 输入：符合 contracts/domain.schema.json 的设备观测事件（event_type=DEVICE_OBSERVED，
 *       aggregate_type=device_capability），以及居民的临时覆盖请求。
 * 输出：对"抽象能力目标状态"的裁决与执行回执（execution_receipt），
 *       由品牌适配层负责真正下发；本服务不直接控制任何品牌设备。
 *
 * 关键语义：
 *  - 不做"最后一次设置覆盖"：候选动作按 优先级层级 → 适用范围 → 既定顺序 裁决；
 *  - 安全处置(300) 压过普通舒适/节能(100)；老人夜间照明等保护约束(200)阻止"突然切断"；
 *  - 摄像/语音/位置开启必须通过全体受影响成员的同意+限制门禁，未成年人更窄；
 *  - 目标设备离线：裁决结果进入待执行队列；恢复时重新判断条件/同意/成员关系/有效期，
 *    过期或条件不再成立的动作绝不补执行；
 *  - 每次裁决产出可解释回执：为何执行、被谁压制、如何临时覆盖。
 */
import {
  AGGREGATE_TYPE,
  BASIS_TIER,
  COLLECTION_CAPABILITY_VALUES,
  DECISION_OUTCOME,
  DEVICE_EVENT_KIND,
  EVENT_KIND,
  EVENT_TYPE,
  PRIORITY_BASIS,
  PRIORITY_TIERS,
  RULE_SCOPE,
  RULE_STATUS,
} from "./constants.js";
import { DomainError } from "./store.js";
import { validateEvent } from "../validator.js";
import { isNight, newId, toDate } from "./time.js";
import { ruleApplicableAt } from "./rule-service.js";

/** 不同层级动作离线后的默认有效期（毫秒）；安全动作在告警持续时不过期 */
const DEFAULT_TTL_BY_TIER = {
  [PRIORITY_TIERS.COMFORT]: 2 * 60 * 1000,
  [PRIORITY_TIERS.PROTECTION]: 10 * 60 * 1000,
  [PRIORITY_TIERS.SAFETY]: null, // 安全动作：默认持续到告警解除，而非到期
};

/** 夜间照明渐暗的最小缓冲；低于该值视为"突然熄灭" */
const MIN_NIGHT_FADE_MS = 60 * 1000;

/** 默认适配层：只记录裁决，不控制任何真实品牌设备 */
export class RecordingAdapter {
  constructor() {
    this.dispatches = [];
  }

  async dispatch(command) {
    this.dispatches.push(command);
    return { deliveredAt: new Date().toISOString(), adapterRef: `rec-${this.dispatches.length}` };
  }
}

export class ArbitrationEngine {
  constructor(store, registration, rules, { adapter = new RecordingAdapter(), clock = () => new Date() } = {}) {
    this.store = store;
    this.registration = registration;
    this.rules = rules;
    this.adapter = adapter;
    this.clock = clock;
  }

  /**
   * 接收一条设备观测事件并完成裁决（幂等：重复 event_id 不重复执行）。
   */
  async ingestObservation(envelope) {
    const errors = validateEvent(envelope);
    if (errors.length) throw new DomainError("BAD_EVENT_ENVELOPE", "事件信封校验失败", { errors });
    if (envelope.event_type !== EVENT_TYPE.DEVICE_OBSERVED) {
      throw new DomainError("BAD_EVENT_TYPE", `裁决引擎接收的设备事件类型非法：${envelope.event_type}`);
    }
    const device = this.store.get(AGGREGATE_TYPE.DEVICE_CAPABILITY, envelope.aggregate_id);
    if (!device) throw new DomainError("DEVICE_NOT_FOUND", `事件指向未登记设备：${envelope.aggregate_id}`);
    const residence = this.store.get("residence", device.residenceId);
    if (residence?.decommissioned) {
      throw new DomainError("RESIDENCE_DECOMMISSIONED", "住房已随云服务退出停用，拒绝新的设备事件");
    }

    // 重复 event_id 幂等：已见过的观测不重复裁决，返回当时回执
    if (this.store.eventIds.has(envelope.event_id)) {
      const prior = this.store.list(AGGREGATE_TYPE.EXECUTION_RECEIPT, (r) => r.triggerEventId === envelope.event_id);
      return { idempotent: true, receipts: prior };
    }

    // 入库时补充住房归属，便于审计流按住房过滤；信封其余字段保持不变
    const storedEnvelope = {
      ...envelope,
      detail: { ...(envelope.detail || {}), residenceId: device.residenceId },
    };
    await this.store.ingestDeviceEvent(storedEnvelope); // 版本单调 + 幂等

    return this.store.withLock(`arbitrate:${device.residenceId}`, () =>
      this._process(device, storedEnvelope),
    );
  }

  async _process(device, envelope) {
    const at = this.clock();
    const detail = envelope.detail || {};
    const kind = detail.kind || DEVICE_EVENT_KIND.STATE_CHANGE;

    if (kind === DEVICE_EVENT_KIND.HEARTBEAT) return { receipts: [], note: "heartbeat" };

    if (kind === DEVICE_EVENT_KIND.OFFLINE) {
      await this._updateDevice(device.id, (d) => ({ ...d, online: false, offlineSince: at.toISOString() }));
      return { receipts: [], note: "device_offline" };
    }

    if (kind === DEVICE_EVENT_KIND.RECOVERED) {
      await this._updateDevice(device.id, (d) => ({
        ...d,
        online: true,
        offlineSince: null,
        lastState: detail.state ?? d.lastState,
        activeAlerts: detail.activeAlerts ?? d.activeAlerts ?? [],
      }));
      const receipts = await this._drainPending(device, at, envelope);
      return { receipts, note: "device_recovered" };
    }

    // sensor_alert / state_change：更新设备现状
    const observedAlert = kind === DEVICE_EVENT_KIND.SENSOR_ALERT ? detail.alert || detail.capability : null;
    await this._updateDevice(device.id, (d) => {
      const activeAlerts = new Set(d.activeAlerts || []);
      if (observedAlert) {
        if (detail.cleared) activeAlerts.delete(observedAlert);
        else activeAlerts.add(observedAlert);
      }
      return {
        ...d,
        online: true,
        lastState: kind === DEVICE_EVENT_KIND.STATE_CHANGE ? detail.state ?? d.lastState : d.lastState,
        lastObservedAt: at.toISOString(),
        activeAlerts: [...activeAlerts],
      };
    });

    return this._arbitrate(device, envelope, at);
  }

  /**
   * 对一次观测触发的全部规则做匹配，并按目标设备分组裁决。
   */
  async _arbitrate(sourceDevice, envelope, at) {
    const detail = envelope.detail || {};
    const activeRules = this.rules.listActive(sourceDevice.residenceId);
    const candidates = [];

    for (const rule of activeRules) {
      if (!this._ruleMembershipValid(rule, at)) continue;
      if (!ruleApplicableAt(rule, at)) continue;
      if (!this._triggerMatches(rule, sourceDevice, detail)) continue;
      for (const action of rule.actions) {
        candidates.push(this._makeCandidate(rule, action, envelope, at, { source: "rule" }));
      }
    }

    // 按目标设备分组（规则动作）
    const groups = new Map();
    for (const c of candidates) {
      const key = c.action.deviceId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    // 临时覆盖只在两种时机参与，避免无关事件对覆盖设备凭空断言：
    //  (a) 该设备本次已被规则动作涉及（覆盖与规则竞争/压制）；
    //  (b) 上报事件的设备本身存在生效覆盖（外部把它拨离覆盖状态时要拉回）。
    const activeOverrides = this._activeOverrides(sourceDevice.residenceId, at);
    const overrideEligible = new Set(groups.keys());
    overrideEligible.add(sourceDevice.id);
    for (const ov of activeOverrides) {
      if (!overrideEligible.has(ov.deviceId)) continue;
      const action = { deviceId: ov.deviceId, capability: ov.capability, setState: ov.setState, note: ov.reason };
      const virtualRule = {
        id: ov.id,
        name: `临时覆盖（${ov.reason || "居民手动"}）`,
        ownerPersonId: ov.personId,
        priorityBasis: PRIORITY_BASIS.MANUAL_OVERRIDE,
        scope: RULE_SCOPE.PERSONAL,
        schedule: { kind: "always" },
        validity: {},
      };
      if (!groups.has(ov.deviceId)) groups.set(ov.deviceId, []);
      groups.get(ov.deviceId).push(this._makeCandidate(virtualRule, action, envelope, at, { source: "override", override: ov }));
    }

    const receipts = [];
    for (const [deviceId, group] of groups) {
      const target = this.store.get(AGGREGATE_TYPE.DEVICE_CAPABILITY, deviceId);
      if (!target) continue;
      receipts.push(...(await this._decideDevice(target, group, envelope, at)));
    }
    return { receipts };
  }

  /**
   * 单设备裁决：门禁 → 保护约束 → 分层排序 → 互斥兜底 → 下发或排队。
   * 返回该设备相关的全部回执（胜者 + 被压制/被拒绝者）。
   */
  async _decideDevice(device, candidates, envelope, at) {
    const receipts = [];

    // 1) 逐候选做授权与采集同意门禁
    const admitted = [];
    for (const c of candidates) {
      const denial = await this._gate(c, device, at);
      if (denial) {
        receipts.push(await this._receipt(c, device, denial.outcome, at, envelope, { denialReason: denial.reason, denialDetail: denial.detail }));
      } else {
        admitted.push(c);
      }
    }

    // 2) 保护约束：夜间"突然熄灭"老人照明等 → 合成"保持现状"保护候选
    const hold = this._protectionHold(device, admitted, at);
    if (hold) admitted.push(hold);

    // 3) 分层
    const rank = (c) => {
      const tier = BASIS_TIER[c.rule.priorityBasis] ?? 0;
      const scopeRank = c.rule.scope === RULE_SCOPE.RESIDENCE ? 2 : c.rule.scope === RULE_SCOPE.ROOM ? 1 : 0;
      return { tier, scopeRank };
    };
    admitted.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (rb.tier !== ra.tier) return rb.tier - ra.tier;
      if (rb.scopeRank !== ra.scopeRank) return rb.scopeRank - ra.scopeRank;
      return (a.rule.createdAt || "").localeCompare(b.rule.createdAt || "");
    });

    // 4) 顶层互斥兜底（发布期已拦截，这里处理发布后环境变化产生的同级对撞）
    const top = admitted[0];
    if (!top) {
      // 全员被门禁拒绝：已为每个候选记录拒绝回执
      return receipts;
    }
    const topRank = rank(top);
    const ties = admitted.filter((c) => rank(c).tier === topRank.tier && rank(c).scopeRank === topRank.scopeRank);
    const states = new Set(ties.map((c) => c.action.setState));

    if (states.size > 1) {
      // 同层级、同范围、目标状态不同：无法确定性裁决 → 冲突挂起，不做任何下发
      // 已存在同一设备同一状态集的未决冲突时复用，避免重复制造冲突事件
      let conflictEvent = this._findOpenConflict(device, ties);
      if (!conflictEvent) conflictEvent = await this._emitConflict(device, ties, at, envelope);
      for (const c of ties) {
        receipts.push(
          await this._receipt(c, device, DECISION_OUTCOME.CONFLICT, at, envelope, {
            conflictEventId: conflictEvent.event_id,
            peers: ties.map((t) => t.rule.id),
          }),
        );
      }
      return receipts;
    }

    // 保护保持：不改变设备状态；所有请求改变状态的真实候选记为 held（保持现状）
    if (top.virtual?.kind === "protection_hold") {
      const blocked = admitted.filter((c) => !c.virtual && c.action.setState !== top.action.setState);
      for (const c of blocked) {
        receipts.push(
          await this._receipt(c, device, DECISION_OUTCOME.HELD, at, envelope, {
            dispatched: false,
            heldBy: { ruleName: top.rule.name, reason: top.virtual.reason, tier: topRank.tier },
            note: top.virtual.reason,
          }),
        );
      }
      if (blocked.length === 0) {
        receipts.push(
          await this._receipt(top, device, DECISION_OUTCOME.HELD, at, envelope, {
            dispatched: false,
            note: top.virtual.reason,
          }),
        );
      }
      return receipts;
    }

    // 5) 胜者 + 其余被压制者
    const losers = admitted.slice(1).filter((c) => c.action.setState !== top.action.setState);
    const suppressedBy = {
      ruleId: top.rule.id,
      ruleName: top.rule.name,
      priorityBasis: top.rule.priorityBasis,
      tier: topRank.tier,
      ownerPersonId: top.rule.ownerPersonId,
    };
    for (const c of losers) {
      receipts.push(
        await this._receipt(c, device, DECISION_OUTCOME.SUPPRESSED, at, envelope, {
          suppressedBy,
        }),
      );
    }

    // 6) 胜出状态已经成立（如临时覆盖维持中、设备此前已被置成该状态）：维持，不重复下发
    const fresh0 = this.store.get(AGGREGATE_TYPE.DEVICE_CAPABILITY, device.id);
    if (fresh0.lastState === top.action.setState) {
      receipts.push(
        await this._receipt(top, device, DECISION_OUTCOME.MAINTAINED, at, envelope, {
          dispatched: false,
          note: "设备已处于胜出动作要求的状态",
        }),
      );
      return receipts;
    }

    // 7) 下发；离线则排队等待恢复重判
    const fresh = this.store.get(AGGREGATE_TYPE.DEVICE_CAPABILITY, device.id);
    if (!fresh.online) {
      const pending = await this._enqueue(top, fresh, envelope, at);
      receipts.push(
        await this._receipt(top, fresh, DECISION_OUTCOME.PENDING, at, envelope, {
          pendingId: pending.id,
          validUntil: pending.validUntil,
        }),
      );
      return receipts;
    }

    const ack = await this.adapter.dispatch({
      deviceId: fresh.id,
      residenceId: fresh.residenceId,
      roomId: fresh.roomId,
      capability: top.action.capability,
      setState: top.action.setState,
      tier: topRank.tier,
      ruleId: top.rule.id,
      ruleName: top.rule.name,
    });
    // 回写目标设备当前状态，避免后续无关事件把同一状态变化重复下发
    await this._updateDevice(fresh.id, (d) => ({ ...d, lastState: top.action.setState, lastCommandAt: at.toISOString() }));
    receipts.push(
      await this._receipt(top, fresh, DECISION_OUTCOME.EXECUTED, at, envelope, {
        adapterRef: ack.adapterRef,
        deliveredAt: ack.deliveredAt,
      }),
    );
    return receipts;
  }

  // ---------- 门禁 ----------

  /** 返回 null 表示通过；否则 {outcome, reason, detail} */
  async _gate(candidate, device, at) {
    const { action, rule } = candidate;

    // 规则作者仍须为生效成员，且为实际在住者：
    // 房东/物业/厂商等非数据主体既不能采集，也不能借普通自动化控制屋内设备
    if (candidate.source !== "override" && rule.ownerPersonId != null) {
      const memberships = this.registration.activeMemberships(device.residenceId, rule.ownerPersonId, at);
      if (memberships.length === 0) {
        return { outcome: DECISION_OUTCOME.DENIED_AUTHZ, reason: "membership_inactive" };
      }
      if (!memberships.some((m) => m.dataSubject)) {
        return { outcome: DECISION_OUTCOME.DENIED_AUTHZ, reason: "non_occupant_control_forbidden" };
      }
    }

    // 采集动作：只有实际居住成员可以发起
    if (COLLECTION_CAPABILITY_VALUES.includes(action.capability) && action.setState === "on") {
      const memberships = this.registration.activeMemberships(device.residenceId, rule.ownerPersonId, at);
      if (!memberships.some((m) => m.dataSubject)) {
        return { outcome: DECISION_OUTCOME.DENIED_AUTHZ, reason: "non_occupant_collection_forbidden" };
      }

      // 受影响成员：房间在住者；全屋范围则全屋数据主体
      const affected = this.registration.affectedMembers(device.residenceId, device.roomId, at);
      const missing = [];
      for (const person of affected) {
        // 1) 硬限制优先（如监护人设置的孩子禁摄像时段）
        const restrictions = this.registration.activeRestrictions(
          device.residenceId,
          person.id,
          action.capability,
          at,
        );
        if (restrictions.length > 0) {
          return {
            outcome: DECISION_OUTCOME.DENIED_CONSENT,
            reason: "collection_restriction_active",
            detail: { subjectId: person.id, restrictionIds: restrictions.map((r) => r.id), ageClass: person.ageClass },
          };
        }
        // 2) 生效同意（设备本身或其所在房间被同一同意范围覆盖）
        const ok =
          this.registration.hasCollectionConsent(device.residenceId, person.id, action.capability, { kind: "device", id: device.id }, at) ||
          (device.roomId &&
            this.registration.hasCollectionConsent(device.residenceId, person.id, action.capability, { kind: "room", id: device.roomId }, at));
        if (!ok) {
          missing.push({ personId: person.id, ageClass: person.ageClass });
        }
      }
      if (missing.length > 0) {
        return { outcome: DECISION_OUTCOME.DENIED_CONSENT, reason: "missing_unanimous_consent", detail: { missing } };
      }
    }
    return null;
  }

  /**
   * 保护约束合成：
   * 夜间、目标房间有需照护成员（如老人）、照明被要求关闭且无足够渐暗缓冲时，
   * 生成一个 PROTECTION 层级的"保持现状"候选，压过节能等舒适动作。
   */
  _protectionHold(device, candidates, at) {
    if (device.capability !== "light" && !device.capability?.startsWith("light")) return null;
    const abruptOff = candidates.find((c) => {
      if (c.action.setState !== "off") return false;
      const fade = c.action.duration?.fadeMs ?? 0;
      return fade < MIN_NIGHT_FADE_MS;
    });
    if (!abruptOff) return null;

    const tz = this.store.get("residence", device.residenceId)?.timezone || "Asia/Shanghai";
    if (!isNight(at, tz)) return null;

    const vulnerableHere = this.registration
      .affectedMembers(device.residenceId, device.roomId, at)
      .some((p) => p.vulnerable || p.tags?.includes("elderly"));
    if (!vulnerableHere) return null;

    return this._makeCandidate(
      {
        id: "protection-night-light",
        name: "保护约束：夜间照明不得突然熄灭",
        ownerPersonId: null,
        priorityBasis: PRIORITY_BASIS.VULNERABLE_PERSON_NEED,
        scope: RULE_SCOPE.ROOM,
        createdAt: "0000", // 保护候选最稳定优先
        schedule: { kind: "always" },
        validity: {},
      },
      { deviceId: device.id, capability: device.capability, setState: device.lastState || "on" },
      null,
      at,
      {
        source: "protection",
        virtual: { kind: "protection_hold", reason: "夜间存在需照护成员，照明只能渐暗，禁止突然切断" },
      },
    );
  }

  // ---------- 离线队列与恢复重判 ----------

  async _enqueue(candidate, device, envelope, at) {
    const tier = BASIS_TIER[candidate.rule.priorityBasis] ?? PRIORITY_TIERS.COMFORT;
    const ttl = candidate.action.validForMs ?? DEFAULT_TTL_BY_TIER[tier];
    const id = newId("pend");
    const pending = {
      id,
      kind: "pending_action",
      residenceId: device.residenceId,
      deviceId: device.id,
      sourceDeviceId: envelope.aggregate_id,
      candidate: serializeCandidate(candidate),
      triggerEventId: envelope.event_id,
      triggerSnapshot: {
        capability: envelope.detail?.capability,
        alert: envelope.detail?.alert || null,
        state: envelope.detail?.state ?? null,
      },
      enqueuedAt: at.toISOString(),
      validUntil: ttl == null ? null : new Date(at.getTime() + ttl).toISOString(),
      persistUntilAlertClears: tier === PRIORITY_TIERS.SAFETY,
    };
    await this.store.commit({
      aggregateType: "pending_action",
      aggregateId: id,
      create: true,
      eventType: EVENT_TYPE.ACTION_EXECUTED,
      summary: `动作离线排队：${device.id} → ${candidate.action.setState}`,
      detail: { kind: EVENT_KIND.DECISION, status: "pending", pending },
      mutate: () => pending,
    });
    return pending;
  }

  /** 设备恢复：重新判断每个排队动作是否仍有效；过期/失效者绝不补执行 */
  async _drainPending(device, at, recoveredEnvelope) {
    const pendings = this.store
      .list("pending_action", (p) => p.residenceId === device.residenceId && p.deviceId === device.id)
      .filter((p) => p.status !== "resolved");
    const receipts = [];

    for (const p of pendings) {
      const candidate = deserializeCandidate(p.candidate);
      const rule = this.store.get(AGGREGATE_TYPE.AUTOMATION_RULE, candidate.ruleId);
      const mark = async (outcome, extra = {}) => {
        await this.store.commit({
          aggregateType: "pending_action",
          aggregateId: p.id,
          expectedVersion: p.version,
          eventType: EVENT_TYPE.ACTION_EXECUTED,
          summary: `离线动作重判：${outcome}`,
          detail: { kind: EVENT_KIND.DEVICE_RECOVERED, outcome, pendingId: p.id, ...extra },
          mutate: (x) => ({ ...x, status: "resolved", resolvedOutcome: outcome, resolvedAt: at.toISOString() }),
        });
        receipts.push(
          await this._receipt(candidate, device, outcome, at, recoveredEnvelope, {
            pendingId: p.id,
            enqueuedAt: p.enqueuedAt,
            ...extra,
          }),
        );
      };

      // (a) 绝对有效期
      if (p.validUntil && toDate(p.validUntil) <= at) {
        await mark(DECISION_OUTCOME.EXPIRED, { reason: "validity_window_elapsed" });
        continue;
      }
      // (b) 规则是否仍生效、作者成员关系是否仍在、规则时段是否仍命中
      if (candidate.source === "override") {
        const ov = this.store.get("manual_override", candidate.ruleId);
        if (!ov || !this._overrideActive(ov, at)) {
          await mark(DECISION_OUTCOME.EXPIRED, { reason: "override_no_longer_active" });
          continue;
        }
      } else {
        if (!rule || rule.status !== RULE_STATUS.ACTIVE) {
          await mark(DECISION_OUTCOME.SKIPPED_STALE, { reason: "rule_no_longer_active" });
          continue;
        }
        if (!this._ruleMembershipValid(rule, at)) {
          await mark(DECISION_OUTCOME.SKIPPED_STALE, { reason: "membership_inactive" });
          continue;
        }
        if (!ruleApplicableAt(rule, at)) {
          await mark(DECISION_OUTCOME.EXPIRED, { reason: "schedule_no_longer_active" });
          continue;
        }
        // 用库中完整规则替换排队时的精简快照，保证后续门禁拥有 residenceId 等字段
        candidate.rule = rule;
      }

      // (c) 触发条件是否仍成立
      const fresh = this.store.get(AGGREGATE_TYPE.DEVICE_CAPABILITY, device.id);
      if (p.persistUntilAlertClears) {
        // 告警状态以源传感设备为准，而不是被驱动的执行器
        const source = this.store.get(AGGREGATE_TYPE.DEVICE_CAPABILITY, p.sourceDeviceId) || fresh;
        const alertActive = (source.activeAlerts || []).includes(p.triggerSnapshot.alert);
        if (!alertActive) {
          await mark(DECISION_OUTCOME.SKIPPED_STALE, { reason: "alert_cleared" });
          continue;
        }
      } else if (fresh.lastState != null && fresh.lastState === candidate.action.setState) {
        await mark(DECISION_OUTCOME.SKIPPED_STALE, { reason: "state_already_holds" });
        continue;
      }

      // (d) 采集门禁在恢复时刻重新判断（撤回/成员变化/禁采时段立即生效）
      const denial = await this._gate(candidate, fresh, at);
      if (denial) {
        await mark(denial.outcome, { reason: denial.reason, denialDetail: denial.detail });
        continue;
      }

      // 仍然有效 → 现在才真正下发（不会补执行已过期动作）
      const ack = await this.adapter.dispatch({
        deviceId: fresh.id,
        residenceId: fresh.residenceId,
        roomId: fresh.roomId,
        capability: candidate.action.capability,
        setState: candidate.action.setState,
        tier: BASIS_TIER[candidate.priorityBasis],
        ruleId: candidate.ruleId,
        ruleName: candidate.ruleName,
        afterOffline: true,
      });
      await mark(DECISION_OUTCOME.EXECUTED, { adapterRef: ack.adapterRef, deliveredAt: ack.deliveredAt, afterOffline: true });
      // 回写恢复后真实生效的状态
      await this._updateDevice(fresh.id, (d) => ({ ...d, lastState: candidate.action.setState, lastCommandAt: at.toISOString() }));
    }
    return receipts;
  }

  // ---------- 临时覆盖 ----------

  /**
   * 居民临时覆盖某设备（如"30 分钟内保持照明"）。
   * 采集类覆盖同样不能绕过同意门禁。返回覆盖记录。
   */
  async requestOverride({ residenceId, personId, deviceId, setState, ttlMs = 30 * 60 * 1000, reason = "" }) {
    const device = this.store.get(AGGREGATE_TYPE.DEVICE_CAPABILITY, deviceId);
    if (!device || device.residenceId !== residenceId) {
      throw new DomainError("DEVICE_NOT_FOUND", "覆盖目标设备不存在于该住房");
    }
    const memberships = this.registration.activeMemberships(residenceId, personId);
    if (memberships.length === 0) throw new DomainError("NOT_MEMBER", "非生效成员不能发起覆盖");
    if (!device.actions.includes(setState)) {
      throw new DomainError("UNSUPPORTED_STATE", `设备不支持状态：${setState}`);
    }
    const at = this.clock();
    const id = newId("ovr");
    const override = {
      id,
      kind: "manual_override",
      residenceId,
      personId,
      deviceId,
      capability: device.capability,
      setState,
      reason,
      createdAt: at.toISOString(),
      validUntil: new Date(at.getTime() + ttlMs).toISOString(),
      status: "active",
    };
    await this.store.commit({
      aggregateType: "manual_override",
      aggregateId: id,
      create: true,
      eventType: EVENT_TYPE.RULE_PUBLISHED,
      summary: `临时覆盖：${personId} 将 ${deviceId} 置为 ${setState}（${reason || "无说明"}）`,
      detail: { kind: EVENT_KIND.OVERRIDE_REQUESTED, override: { ...override, version: undefined }, residenceId },
      mutate: () => override,
    });

    // 立即对目标设备裁决：尽快下发，或暴露与他人覆盖的冲突（不必等待下一次设备事件）
    const receipts = await this._arbitrateOverrideTarget(device, override, at);
    return { override, receipts };
  }

  /** 对"覆盖发起"这一时刻做一次仅含覆盖候选的裁决 */
  async _arbitrateOverrideTarget(device, justAdded, at) {
    const envelope = {
      event_id: `override-trigger:${justAdded.id}`,
      event_type: EVENT_TYPE.RULE_PUBLISHED,
      aggregate_type: AGGREGATE_TYPE.DEVICE_CAPABILITY,
      aggregate_id: device.id,
      occurred_at: at.toISOString(),
      version: 1,
      summary: `临时覆盖触发裁决：${device.id}`,
      detail: { kind: EVENT_KIND.OVERRIDE_REQUESTED, residenceId: device.residenceId },
    };
    const group = this._activeOverrides(device.residenceId, at)
      .filter((ov) => ov.deviceId === device.id)
      .map((ov) => {
        const virtualRule = {
          id: ov.id,
          name: `临时覆盖（${ov.reason || "居民手动"}）`,
          ownerPersonId: ov.personId,
          priorityBasis: PRIORITY_BASIS.MANUAL_OVERRIDE,
          scope: RULE_SCOPE.PERSONAL,
          schedule: { kind: "always" },
          validity: {},
        };
        return this._makeCandidate(
          virtualRule,
          { deviceId: ov.deviceId, capability: ov.capability, setState: ov.setState, note: ov.reason },
          envelope,
          at,
          { source: "override", override: ov },
        );
      });
    if (group.length === 0) return [];
    return this._decideDevice(this.store.get(AGGREGATE_TYPE.DEVICE_CAPABILITY, device.id), group, envelope, at);
  }

  /** 撤销自己的临时覆盖 */
  async cancelOverride(overrideId, personId) {
    const ov = this.store.get("manual_override", overrideId);
    if (!ov) throw new DomainError("OVERRIDE_NOT_FOUND", "覆盖不存在");
    if (ov.personId !== personId) throw new DomainError("FORBIDDEN", "只能撤销本人的临时覆盖");
    const { data } = await this.store.commit({
      aggregateType: "manual_override",
      aggregateId: overrideId,
      expectedVersion: ov.version,
      eventType: EVENT_TYPE.RULE_PUBLISHED,
      summary: `临时覆盖撤销：${overrideId}`,
      detail: { kind: EVENT_KIND.OVERRIDE_EXPIRED },
      mutate: (x) => ({ ...x, status: "cancelled" }),
    });
    return data;
  }

  _activeOverrides(residenceId, at) {
    return this.store
      .list("manual_override", (o) => o.residenceId === residenceId && o.status === "active")
      .filter((o) => this._overrideActive(o, at));
  }

  _overrideActive(o, at) {
    return o.status === "active" && (!o.validUntil || toDate(o.validUntil) > toDate(at));
  }

  // ---------- 回执 ----------

  async _receipt(candidate, device, outcome, at, envelope, extra = {}) {
    const id = newId("rcp");
    const tier = BASIS_TIER[candidate.rule.priorityBasis] ?? null;
    const receipt = {
      id,
      kind: "execution_receipt",
      residenceId: device.residenceId,
      roomId: device.roomId,
      deviceId: device.id,
      capability: candidate.action.capability,
      requestedState: candidate.action.setState,
      outcome,
      decidedAt: at.toISOString(),
      triggerEventId: envelope?.event_id || null,
      rule: candidate.source === "rule" ? { id: candidate.rule.id, name: candidate.rule.name } : null,
      source: candidate.source,
      priority: {
        basis: candidate.rule.priorityBasis,
        tier,
        ownerPersonId: candidate.rule.ownerPersonId,
      },
      explanation: explain(outcome, candidate, device, extra),
      overrideHint: {
        canTemporarilyOverride: candidate.source !== "override",
        ttlSeconds: 1800,
      },
      ...extra,
    };
    const { data } = await this.store.commit({
      aggregateType: AGGREGATE_TYPE.EXECUTION_RECEIPT,
      aggregateId: id,
      create: true,
      eventType: EVENT_TYPE.ACTION_EXECUTED,
      summary: receipt.explanation.short,
      detail: { kind: EVENT_KIND.DECISION, receipt: { ...receipt, version: undefined } },
      mutate: () => receipt,
    });
    return data;
  }

  /** 查找设备上尚未被后续成功裁决解除的同状态集冲突 */
  _findOpenConflict(device, ties) {
    const wantStates = [...new Set(ties.map((c) => c.action.setState))].sort();
    const conflicts = this.store.events
      .filter((e) => e.aggregate_id === device.id && e.event_type === EVENT_TYPE.CONFLICT_DETECTED)
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    for (let i = conflicts.length - 1; i >= 0; i -= 1) {
      const cf = conflicts[i];
      const states = [...(cf.detail?.states || [])].sort();
      if (JSON.stringify(states) !== JSON.stringify(wantStates)) continue;
      // 冲突之后若已有成功下发/维持回执，视为已解除
      const resolvedAfter = this.store
        .list(AGGREGATE_TYPE.EXECUTION_RECEIPT, (r) => r.deviceId === device.id)
        .some((r) => r.decidedAt > cf.occurred_at && (r.outcome === DECISION_OUTCOME.EXECUTED || r.outcome === DECISION_OUTCOME.MAINTAINED));
      return resolvedAfter ? null : cf;
    }
    return null;
  }

  async _emitConflict(device, ties, at, envelope) {
    const priorConflicts = this.store.events.filter(
      (e) => e.aggregate_id === device.id && e.event_type === EVENT_TYPE.CONFLICT_DETECTED,
    ).length;
    const event = {
      event_id: newId("cfx"),
      event_type: EVENT_TYPE.CONFLICT_DETECTED,
      aggregate_type: AGGREGATE_TYPE.DEVICE_CAPABILITY,
      aggregate_id: device.id,
      occurred_at: at.toISOString(),
      version: priorConflicts + 1,
      summary: `设备 ${device.id} 出现同层级互斥动作，挂起待人工裁决`,
      detail: {
        kind: EVENT_KIND.MUTEX_CONFLICT,
        residenceId: device.residenceId,
        states: [...new Set(ties.map((c) => c.action.setState))],
        rules: ties.map((c) => ({ ruleId: c.rule.id, name: c.rule.name, state: c.action.setState, tier: BASIS_TIER[c.rule.priorityBasis] })),
        triggerEventId: envelope?.event_id || null,
      },
    };
    await this.store.appendDomainEvent(event);
    return event;
  }

  // ---------- 查询（访问控制：仅在住数据主体可见） ----------

  /** 查询回执；requesterId 为空表示系统内部调用 */
  queryReceipts({ residenceId, deviceId = null, eventId = null, requesterId = null }) {
    let scopeRooms = null; // null 表示全屋可见
    if (requesterId) {
      const ms = this.registration.activeMemberships(residenceId, requesterId);
      if (ms.length === 0) throw new DomainError("ACCESS_DENIED", "请求者在该住房无生效成员关系");
      if (!ms.some((m) => m.dataSubject)) {
        throw new DomainError("ACCESS_DENIED", "非居住成员无权查看生活数据回执（房东/物业/厂商不可获得生活轨迹）");
      }
      // 业主/租户掌握全屋视图；其余在住者仅限本人占用房间或本人发起/被压制的动作
      const wholeHouse = ms.some((m) => m.role === "owner" || m.role === "tenant");
      if (!wholeHouse) {
        scopeRooms = new Set(ms.flatMap((m) => m.occupiesRooms || []));
      }
    }
    return this.store
      .list(AGGREGATE_TYPE.EXECUTION_RECEIPT, (r) => r.residenceId === residenceId)
      .filter((r) => !deviceId || r.deviceId === deviceId)
      .filter((r) => !eventId || r.triggerEventId === eventId)
      .filter((r) => {
        if (!scopeRooms) return true;
        const ownAction = r.priority?.ownerPersonId === requesterId;
        return ownAction || scopeRooms.has(r.roomId);
      })
      .sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  }

  // ---------- 内部工具 ----------

  _ruleMembershipValid(rule, at) {
    if (rule.ownerPersonId == null) return true; // 系统保护候选
    const ms = this.registration.activeMemberships(rule.residenceId, rule.ownerPersonId, at);
    return ms.length > 0;
  }

  _triggerMatches(rule, sourceDevice, detail) {
    const t = rule.trigger;
    if (!t) return false;
    if (t.capability !== sourceDevice.capability) return false;
    if (t.rooms?.length && (!sourceDevice.roomId || !t.rooms.includes(sourceDevice.roomId))) return false;
    if (detail.kind === DEVICE_EVENT_KIND.SENSOR_ALERT) {
      const alerts = t.sensorAlerts || (t.alert ? [t.alert] : []);
      return alerts.length === 0 || alerts.includes(detail.alert || detail.capability);
    }
    if (detail.kind === DEVICE_EVENT_KIND.STATE_CHANGE) {
      if (!t.states || t.states.length === 0) return true;
      return t.states.includes(detail.state);
    }
    return false;
  }

  _makeCandidate(rule, action, envelope, at, extra = {}) {
    return {
      rule,
      action: { ...action },
      ruleId: rule.id,
      ruleName: rule.name,
      priorityBasis: rule.priorityBasis,
      source: extra.source || "rule",
      virtual: extra.virtual || null,
      override: extra.override || null,
      createdAt: at.toISOString(),
    };
  }

  async _updateDevice(deviceId, fn, attempt = 0) {
    const current = this.store.get(AGGREGATE_TYPE.DEVICE_CAPABILITY, deviceId);
    try {
      return await this.store.commit({
        aggregateType: AGGREGATE_TYPE.DEVICE_CAPABILITY,
        aggregateId: deviceId,
        expectedVersion: current.version,
        eventType: EVENT_TYPE.MEMBERSHIP_CHANGED,
        summary: `设备状态更新：${deviceId}`,
        detail: { kind: EVENT_KIND.DEVICE_STATE_UPDATED, deviceUpdate: true, residenceId: current.residenceId },
        mutate: fn,
      });
    } catch (err) {
      if (err.code === "VERSION_CONFLICT" && attempt < 3) {
        return this._updateDevice(deviceId, fn, attempt + 1);
      }
      throw err;
    }
  }
}

function serializeCandidate(c) {
  return {
    ruleId: c.ruleId,
    ruleName: c.ruleName,
    priorityBasis: c.priorityBasis,
    source: c.source,
    ownerPersonId: c.rule.ownerPersonId ?? null,
    scope: c.rule.scope ?? null,
    action: c.action,
  };
}

function deserializeCandidate(s) {
  return {
    ruleId: s.ruleId,
    ruleName: s.ruleName,
    priorityBasis: s.priorityBasis,
    source: s.source,
    action: s.action,
    rule: {
      id: s.ruleId,
      name: s.ruleName,
      priorityBasis: s.priorityBasis,
      ownerPersonId: s.ownerPersonId ?? null,
      scope: s.scope ?? RULE_SCOPE.PERSONAL,
    },
  };
}

/** 生成人类可读解释（同时给出短摘要与结构化长解释） */
function explain(outcome, candidate, device, extra) {
  const basisText = {
    [PRIORITY_BASIS.EMERGENCY_SENSOR_ALERT]: "紧急安全告警",
    [PRIORITY_BASIS.GUARDIAN_RESTRICTION]: "监护人保护限制",
    [PRIORITY_BASIS.VULNERABLE_PERSON_NEED]: "弱势成员保护",
    [PRIORITY_BASIS.MANUAL_OVERRIDE]: "居民临时覆盖",
    [PRIORITY_BASIS.PERSONAL_PREFERENCE]: "个人舒适偏好",
    [PRIORITY_BASIS.ENERGY_SAVING]: "节能偏好",
  }[candidate.rule.priorityBasis] || candidate.rule.priorityBasis;

  const map = {
    [DECISION_OUTCOME.EXECUTED]: `已执行：${device.id} 的 ${candidate.action.capability} 置为 ${candidate.action.setState}（依据：${basisText}：${candidate.rule.name}）`,
    [DECISION_OUTCOME.SUPPRESSED]: extra.dispatched === false
      ? `未执行：${device.id} 保持现状（${extra.note || "保护约束生效"}）`
      : `被压制：${candidate.rule.name} 要求的 ${candidate.action.setState} 让位于更高优先级规则「${extra.suppressedBy?.ruleName}」（${basisText}）`,
    [DECISION_OUTCOME.DENIED_CONSENT]: `已拒绝：${candidate.action.capability} 开启采集缺少全体受影响成员的有效同意或命中禁采限制（${extra.denialReason || ""}）`,
    [DECISION_OUTCOME.DENIED_AUTHZ]: `已拒绝：发起方无权对该设备执行此动作（${extra.denialReason || ""}）`,
    [DECISION_OUTCOME.CONFLICT]: `已挂起：与同优先级规则互斥，需人工裁决`,
    [DECISION_OUTCOME.EXPIRED]: `未补执行：设备恢复时动作已过期（${extra.reason || ""}）`,
    [DECISION_OUTCOME.SKIPPED_STALE]: `未补执行：设备恢复时触发条件不再成立（${extra.reason || ""}）`,
    [DECISION_OUTCOME.HELD]: `保持现状：${device.id} 未被改变（${extra.note || "保护约束生效"}）`,
    [DECISION_OUTCOME.MAINTAINED]: `维持现状：${device.id} 已处于「${candidate.action.setState}」，无需重复下发`,
    [DECISION_OUTCOME.PENDING]: `已排队：设备离线，动作将在恢复时重新判断有效性`,
  };
  return { short: map[outcome] || `裁决结果：${outcome}`, basis: basisText };
}
