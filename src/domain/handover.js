/**
 * 控制权与数据交接服务。
 *
 * 覆盖四类情形：搬家 move_out、换租 tenancy_change、转售 resale、云服务退出 cloud_exit。
 *
 * 在交接生效时点（原子串行处理）：
 *  1) 旧住户全部成员关系 accessStatus=revoked 且 validUntil=生效时点 → 即刻失去设备访问；
 *  2) 旧住户拥有的规则停用或转移给后继者；其临时覆盖全部撤销；未完成的离线动作作废；
 *  3) 以旧住户为主体/由其授予的采集同意全部撤回；
 *  4) 生活轨迹数据（回执、同意、覆盖、成员关联）按数据策略导出后从活动库清除：
 *     - export_and_delete：生成去标识化导出包（脱离住房 API，凭交接号+领取令牌取件）；
 *     - delete：直接清除；
 *     - transfer_to_successor：仅移交运营配置（房间/设备/规则），生活数据不交给后继者，
 *       仍向旧住户导出后清除——后继者不能借此获得旧住户完整生活轨迹；
 *  5) 住房配置与设备控制权移交后继者（cloud_exit 则停用整套住房，拒绝新事件）。
 *
 * 全程记录 CONTROL_TRANSFERRED 事件；交接可预约（effectiveAt 未来时间），由 applyDueHandovers 生效。
 */
import {
  AGGREGATE_TYPE,
  DATA_HANDOVER_POLICY,
  DECISION_OUTCOME,
  EVENT_KIND,
  EVENT_TYPE,
  RESIDENCE_ROLES,
  RULE_STATUS,
  TRANSFER_REASON,
} from "./constants.js";
import { DomainError } from "./store.js";
import { newId, toDate } from "./time.js";

export class HandoverService {
  constructor(store, registration, ruleService, clock = () => new Date()) {
    this.store = store;
    this.registration = registration;
    this.ruleService = ruleService;
    this.clock = clock;
  }

  /**
   * 创建交接单。
   * {
   *   residenceId, reason, requestedByPersonId,
   *   outgoingPersonIds: [...],          // 离开的成员（cloud_exit 可省略=全体居住成员）
   *   successorPersonId?: string,        // 后继接管人
   *   successorRole?: "owner"|"tenant",
   *   dataPolicy: "export_and_delete"|"delete"|"transfer_to_successor",
   *   effectiveAt?: ISO（默认立即）
   * }
   */
  async scheduleHandover(input) {
    const { residenceId, reason, requestedByPersonId } = input;
    const residence = this.store.get("residence", residenceId);
    if (!residence) throw new DomainError("RESIDENCE_NOT_FOUND", `住房不存在：${residenceId}`);
    if (residence.decommissioned) throw new DomainError("RESIDENCE_DECOMMISSIONED", "住房已随云服务退出停用");
    if (!Object.values(TRANSFER_REASON).includes(reason)) {
      throw new DomainError("INVALID_TRANSFER", `未知交接原因：${reason}`);
    }

    const requesterMemberships = this.registration.activeMemberships(residenceId, requestedByPersonId, this.clock());
    if (requesterMemberships.length === 0) {
      throw new DomainError("NOT_MEMBER", "请求人在该住房无生效成员关系");
    }
    const canInitiate = requesterMemberships.some(
      (m) => m.role === RESIDENCE_ROLES.OWNER || m.role === RESIDENCE_ROLES.TENANT || m.role === RESIDENCE_ROLES.LANDLORD,
    );
    if (!canInitiate) {
      throw new DomainError("FORBIDDEN", "只有业主/租户/房东可以发起控制权交接");
    }
    if (reason === TRANSFER_REASON.CLOUD_EXIT && !requesterMemberships.some((m) => m.role === RESIDENCE_ROLES.OWNER)) {
      throw new DomainError("FORBIDDEN", "云服务退出须由业主发起");
    }

    const policy = input.dataPolicy || DATA_HANDOVER_POLICY.EXPORT_AND_DELETE;
    if (!Object.values(DATA_HANDOVER_POLICY).includes(policy)) {
      throw new DomainError("INVALID_TRANSFER", `未知数据处置策略：${policy}`);
    }

    let outgoing = input.outgoingPersonIds || [];
    if (reason === TRANSFER_REASON.CLOUD_EXIT) {
      outgoing = this.store
        .list(AGGREGATE_TYPE.RESIDENCE_MEMBERSHIP, (m) => m.residenceId === residenceId)
        .filter((m) => m.accessStatus === "active" && m.dataSubject)
        .map((m) => m.personId);
    }
    if (outgoing.length === 0) throw new DomainError("INVALID_TRANSFER", "交接必须指定至少一名离开成员");

    if (input.successorPersonId) {
      const succ = this.store.get("person", input.successorPersonId);
      if (!succ) throw new DomainError("PERSON_NOT_FOUND", "后继接管人未登记");
      if (outgoing.includes(input.successorPersonId)) {
        throw new DomainError("INVALID_TRANSFER", "后继接管人不能同时是离开成员");
      }
    }
    if (policy === DATA_HANDOVER_POLICY.TRANSFER_TO_SUCCESSOR && !input.successorPersonId) {
      throw new DomainError("INVALID_TRANSFER", "转移给后继者必须指定 successorPersonId");
    }

    const now = this.clock();
    const effectiveAt = input.effectiveAt ? toDate(input.effectiveAt) : now;
    const id = newId("trf");
    const record = {
      id,
      kind: "control_transfer",
      residenceId,
      reason,
      dataPolicy: policy,
      requestedByPersonId,
      outgoingPersonIds: [...new Set(outgoing)],
      successorPersonId: input.successorPersonId || null,
      successorRole: input.successorRole || null,
      effectiveAt: effectiveAt.toISOString(),
      status: "scheduled",
      createdAt: now.toISOString(),
      completedAt: null,
      manifest: null,
    };

    const { data } = await this.store.commit({
      aggregateType: "control_transfer",
      aggregateId: id,
      create: true,
      eventType: EVENT_TYPE.CONTROL_TRANSFERRED,
      summary: `交接单已${effectiveAt <= now ? "生效" : "预约"}：${reason}（住房 ${residenceId}）`,
      detail: { kind: EVENT_KIND.HANDOVER_EFFECTIVE, status: "scheduled", transfer: { ...record, version: undefined } },
      mutate: () => record,
    });

    if (effectiveAt <= now) {
      return this.effectuate(id);
    }
    return { transfer: data, effective: false };
  }

  /** 使一份（已到期的）交接单生效 */
  async effectuate(transferId) {
    return this.store.withLock(`handover:${transferId}`, async () => {
      const transfer = this.store.get("control_transfer", transferId);
      if (!transfer) throw new DomainError("TRANSFER_NOT_FOUND", `交接单不存在：${transferId}`);
      if (transfer.status === "effective") return { transfer, effective: true, idempotent: true };
      const at = this.clock();
      if (toDate(transfer.effectiveAt) > at) {
        throw new DomainError("TRANSFER_NOT_DUE", "交接尚未到生效时间");
      }

      const residenceId = transfer.residenceId;
      const outgoing = new Set(transfer.outgoingPersonIds);
      const manifest = {
        transferId,
        residenceId,
        reason: transfer.reason,
        effectiveAt: at.toISOString(),
        revokedMemberships: [],
        suspendedRules: [],
        transferredRules: [],
        withdrawnConsents: [],
        cancelledOverrides: [],
        cancelledPending: [],
        purgedReceipts: 0,
        exports: [],
      };

      // 1) 旧住户成员关系即刻失效
      for (const m of this.store.list(AGGREGATE_TYPE.RESIDENCE_MEMBERSHIP, (x) => x.residenceId === residenceId)) {
        if (!outgoing.has(m.personId)) continue;
        if (m.accessStatus !== "active") continue;
        await this._commitMembershipRevoke(m.id, m.version, at, transfer.reason, manifest);
      }

      // 2) 规则：转移后继者或停用
      for (const rule of this.store.list(AGGREGATE_TYPE.AUTOMATION_RULE, (r) => r.residenceId === residenceId)) {
        if (!outgoing.has(rule.ownerPersonId)) continue;
        if (transfer.dataPolicy === DATA_HANDOVER_POLICY.TRANSFER_TO_SUCCESSOR && transfer.successorPersonId) {
          const { data } = await this.store.commit({
            aggregateType: AGGREGATE_TYPE.AUTOMATION_RULE,
            aggregateId: rule.id,
            expectedVersion: rule.version,
            eventType: EVENT_TYPE.CONTROL_TRANSFERRED,
            summary: `规则随控制权移交：${rule.name}`,
            detail: { kind: EVENT_KIND.HANDOVER_EFFECTIVE, transferred: true, fromPersonId: rule.ownerPersonId, toPersonId: transfer.successorPersonId },
            mutate: (r) => ({ ...r, ownerPersonId: transfer.successorPersonId }),
          });
          void data;
          manifest.transferredRules.push(rule.id);
        } else if (rule.status === RULE_STATUS.ACTIVE) {
          await this.ruleService.suspendRule(rule.id, `control_transfer:${transfer.reason}`);
          manifest.suspendedRules.push(rule.id);
        }
      }

      // 3) 同意撤回：旧住户为主体，或由旧住户代表他人授予（授予人已离开，授权链断裂）
      for (const c of this.store.list("consent", (x) => x.kind === "consent" && x.residenceId === residenceId)) {
        if (outgoing.has(c.subjectId) || outgoing.has(c.grantedById)) {
          await this.store.commit({
            aggregateType: "consent",
            aggregateId: c.id,
            expectedVersion: c.version,
            eventType: EVENT_TYPE.MEMBERSHIP_CHANGED,
            summary: `交接导致采集同意撤回：${c.id}`,
            detail: { kind: EVENT_KIND.CONSENT_WITHDRAWN, reason: "control_transfer", subjectId: c.subjectId },
            mutate: (x) => ({ ...x, status: "withdrawn", withdrawnAt: at.toISOString(), withdrawnReason: "control_transfer" }),
          });
          manifest.withdrawnConsents.push(c.id);
        }
      }

      // 4) 旧住户临时覆盖撤销
      for (const o of this.store.list("manual_override", (x) => x.residenceId === residenceId)) {
        if (outgoing.has(o.personId) && o.status === "active") {
          await this.store.commit({
            aggregateType: "manual_override",
            aggregateId: o.id,
            expectedVersion: o.version,
            eventType: EVENT_TYPE.RULE_PUBLISHED,
            summary: "交接撤销临时覆盖",
            detail: { kind: EVENT_KIND.OVERRIDE_EXPIRED, reason: "control_transfer" },
            mutate: (x) => ({ ...x, status: "cancelled", cancelledReason: "control_transfer" }),
          });
          manifest.cancelledOverrides.push(o.id);
        }
      }

      // 5) 在途离线动作全部作废（设备恢复时绝不补执行旧住户意图）
      for (const p of this.store.list("pending_action", (x) => x.residenceId === residenceId && x.status !== "resolved")) {
        if (outgoing.has(p.candidate?.ownerPersonId) || transfer.reason === TRANSFER_REASON.CLOUD_EXIT) {
          await this.store.commit({
            aggregateType: "pending_action",
            aggregateId: p.id,
            expectedVersion: p.version,
            eventType: EVENT_TYPE.ACTION_EXECUTED,
            summary: "交接作废在途动作",
            detail: { kind: EVENT_KIND.DEVICE_RECOVERED, outcome: DECISION_OUTCOME.EXPIRED, reason: "control_transfer" },
            mutate: (x) => ({ ...x, status: "resolved", resolvedOutcome: DECISION_OUTCOME.EXPIRED, resolvedAt: at.toISOString() }),
          });
          manifest.cancelledPending.push(p.id);
        }
      }

      // 6) 生活轨迹数据导出 + 清除（脱离住房 API 的去标识化导出包）
      const packages = this._buildExportPackages(transfer, at);
      for (const pkg of packages) {
        await this.store.commit({
          aggregateType: "control_transfer",
          aggregateId: pkg.id,
          create: true,
          eventType: EVENT_TYPE.CONTROL_TRANSFERRED,
          summary: `数据交接包生成：${pkg.id}`,
          detail: { kind: EVENT_KIND.DATA_HANDOVER, packageId: pkg.id, intendedFor: pkg.intendedFor, recordCount: pkg.recordCount },
          mutate: () => pkg,
        });
        manifest.exports.push({ packageId: pkg.id, intendedFor: pkg.intendedFor, claimToken: pkg.claimToken, recordCount: pkg.recordCount });
      }
      manifest.purgedReceipts = await this._purgeLifeData(residenceId, outgoing, transfer.reason, at);

      // 7) 后继者接管 / 云退出停用
      if (transfer.reason === TRANSFER_REASON.CLOUD_EXIT) {
        // 清空设备运行态（保留能力配置以便迁移），不残留 lastState/activeAlerts 等生活信息
        const devBucket = this.store.aggregates.get(AGGREGATE_TYPE.DEVICE_CAPABILITY);
        if (devBucket) {
          for (const [id, rec] of [...devBucket.entries()]) {
            if (rec.data.residenceId !== residenceId) continue;
            devBucket.set(id, {
              version: rec.version + 1,
              data: { ...rec.data, online: false, lastState: null, activeAlerts: [], offlineSince: null },
            });
          }
        }
        const residence = this.store.get("residence", residenceId);
        await this.store.commit({
          aggregateType: "residence",
          aggregateId: residenceId,
          expectedVersion: residence.version,
          eventType: EVENT_TYPE.CONTROL_TRANSFERRED,
          summary: "云服务退出：住房停用，拒绝新的设备事件",
          detail: { kind: EVENT_KIND.HANDOVER_EFFECTIVE, decommissioned: true },
          mutate: (r) => ({ ...r, decommissioned: true, decommissionedAt: at.toISOString() }),
        });
      } else if (transfer.successorPersonId) {
        await this._admitSuccessor(transfer, at);
      }

      const completed = await this.store.commit({
        aggregateType: "control_transfer",
        aggregateId: transferId,
        expectedVersion: transfer.version,
        eventType: EVENT_TYPE.CONTROL_TRANSFERRED,
        summary: `交接完成：${transfer.reason}（住房 ${residenceId}），旧住户访问已撤销`,
        detail: { kind: EVENT_KIND.HANDOVER_EFFECTIVE, status: "effective", manifest },
        mutate: (x) => ({ ...x, status: "effective", completedAt: at.toISOString(), manifest }),
      });

      return { transfer: completed.data, manifest, effective: true };
    });
  }

  /** 预约到期扫描（服务定时/恢复时调用） */
  async applyDueHandovers(at = this.clock()) {
    const due = this.store
      .list("control_transfer", (t) => t.kind === "control_transfer" && t.status === "scheduled")
      .filter((t) => toDate(t.effectiveAt) <= toDate(at));
    const results = [];
    for (const t of due) {
      results.push(await this.effectuate(t.id));
    }
    return results;
  }

  /**
   * 领取导出包：必须同时提供交接号与领取令牌；领取后标记已领取（一次性）。
   * 交接完成后旧住户已无住房成员关系，不能再走住房 API，但可凭令牌取走自己的数据。
   */
  async claimExport(packageId, claimToken) {
    const pkg = this.store.get("control_transfer", packageId);
    if (!pkg || pkg.kind !== "data_export_package") throw new DomainError("PACKAGE_NOT_FOUND", "导出包不存在");
    if (pkg.claimToken !== claimToken) throw new DomainError("PACKAGE_FORBIDDEN", "领取令牌不正确");
    if (pkg.claimedAt) throw new DomainError("PACKAGE_CLAIMED", "导出包已被领取");
    await this.store.commit({
      aggregateType: "control_transfer",
      aggregateId: packageId,
      expectedVersion: pkg.version,
      eventType: EVENT_TYPE.CONTROL_TRANSFERRED,
      summary: `数据交接包已领取：${packageId}`,
      detail: { kind: EVENT_KIND.DATA_HANDOVER, claimed: true, packageId },
      mutate: (x) => ({ ...x, claimedAt: this.clock().toISOString() }),
    });
    return { packageId, intendedFor: pkg.intendedFor, createdAt: pkg.createdAt, records: pkg.records };
  }

  // ---------- 内部 ----------

  async _commitMembershipRevoke(id, version, at, reason, manifest) {
    await this.store.commit({
      aggregateType: AGGREGATE_TYPE.RESIDENCE_MEMBERSHIP,
      aggregateId: id,
      expectedVersion: version,
      eventType: EVENT_TYPE.MEMBERSHIP_CHANGED,
      summary: `交接生效：成员访问即刻撤销（${reason}）`,
      detail: { kind: EVENT_KIND.MEMBER_REMOVED, reason: "control_transfer", revokedAt: at.toISOString() },
      mutate: (m) => ({ ...m, accessStatus: "revoked", validUntil: at.toISOString(), revokedReason: "control_transfer" }),
    });
    manifest.revokedMemberships.push(id);
  }

  async _admitSuccessor(transfer, at) {
    const role = transfer.successorRole === RESIDENCE_ROLES.TENANT ? RESIDENCE_ROLES.TENANT : RESIDENCE_ROLES.OWNER;
    const exists = this.registration
      .activeMemberships(transfer.residenceId, transfer.successorPersonId, at)
      .some((m) => m.role === role);
    if (exists) return;
    const membershipId = newId("mbr");
    await this.store.commit({
      aggregateType: AGGREGATE_TYPE.RESIDENCE_MEMBERSHIP,
      aggregateId: membershipId,
      create: true,
      eventType: EVENT_TYPE.MEMBERSHIP_CHANGED,
      summary: `后继者取得住房控制权：${transfer.successorPersonId}（${role}）`,
      detail: { kind: EVENT_KIND.MEMBER_ADDED, viaTransfer: transfer.id, role },
      mutate: () => ({
        id: membershipId,
        kind: "residence_membership",
        residenceId: transfer.residenceId,
        personId: transfer.successorPersonId,
        role,
        ageClass: this.store.get("person", transfer.successorPersonId)?.ageClass || "adult",
        validFrom: at.toISOString(),
        validUntil: null,
        occupiesRooms: [],
        dataSubject: role !== RESIDENCE_ROLES.LANDLORD,
        accessStatus: "active",
        viaTransfer: transfer.id,
        createdAt: at.toISOString(),
      }),
    });
  }

  /**
   * 生成每名离开成员一份的去标识化导出包：
   * 仅含其本人为数据主体的回执/同意/覆盖记录，剥离其他成员标识。
   */
  _buildExportPackages(transfer, at) {
    if (transfer.dataPolicy === DATA_HANDOVER_POLICY.DELETE && transfer.reason !== TRANSFER_REASON.CLOUD_EXIT) {
      return [];
    }
    const packages = [];
    for (const personId of transfer.outgoingPersonIds) {
      const receipts = this.store
        .list(AGGREGATE_TYPE.EXECUTION_RECEIPT, (r) => r.residenceId === transfer.residenceId)
        .filter((r) => r.priority?.ownerPersonId === personId);
      const consents = this.store
        .list("consent", (c) => c.kind === "consent" && c.residenceId === transfer.residenceId && c.subjectId === personId)
        .map(stripInternals);
      const overrides = this.store
        .list("manual_override", (o) => o.residenceId === transfer.residenceId && o.personId === personId)
        .map(stripInternals);
      const receiptRows = receipts.map(stripInternals).map((r) => ({
        decidedAt: r.decidedAt,
        deviceCapability: r.capability,
        requestedState: r.requestedState,
        outcome: r.outcome,
        explanation: r.explanation,
      }));

      const recordCount = receiptRows.length + consents.length + overrides.length;
      // 云退出/直接删除策略：仍提供退出数据包，保障数据可携带
      packages.push({
        id: newId("pkg"),
        kind: "data_export_package",
        transferId: transfer.id,
        residenceId: transfer.residenceId,
        intendedFor: personId,
        claimToken: newId("token"),
        createdAt: at.toISOString(),
        claimedAt: null,
        recordCount,
        records: { receipts: receiptRows, consents, overrides },
      });
    }
    return packages;
  }

  /**
   * 从活动库与事件流清除旧住户生活轨迹。
   * 住房配置/设备/规则运营资产保留，供后继者继续使用。
   */
  async _purgeLifeData(residenceId, outgoing, reason, at) {
    let count = 0;
    const isCloudExit = reason === TRANSFER_REASON.CLOUD_EXIT;

    // 1) 回执聚合物理删除
    const receiptBucket = this.store.aggregates.get(AGGREGATE_TYPE.EXECUTION_RECEIPT);
    if (receiptBucket) {
      for (const [id, rec] of [...receiptBucket.entries()]) {
        if (rec.data.residenceId !== residenceId) continue;
        const related = isCloudExit || outgoing.has(rec.data.priority?.ownerPersonId);
        if (related) {
          receiptBucket.delete(id);
          count += 1;
        }
      }
    }

    // 2) 旧住户的同意/采集限制聚合
    const consentBucket = this.store.aggregates.get("consent");
    if (consentBucket) {
      for (const [id, rec] of [...consentBucket.entries()]) {
        if (rec.data.residenceId !== residenceId) continue;
        if (isCloudExit || outgoing.has(rec.data.subjectId) || outgoing.has(rec.data.grantedById)) {
          consentBucket.delete(id);
          count += 1;
        }
      }
    }

    // 3) 旧住户的临时覆盖聚合
    const overrideBucket = this.store.aggregates.get("manual_override");
    if (overrideBucket) {
      for (const [id, rec] of [...overrideBucket.entries()]) {
        if (rec.data.residenceId !== residenceId) continue;
        if (isCloudExit || outgoing.has(rec.data.personId)) {
          overrideBucket.delete(id);
          count += 1;
        }
      }
    }

    // 4) 历史事件 detail 脱敏（保留信封，抹掉可还原生活轨迹的 detail）
    const redacted = await this.store.redactLifeEvents((e) => {
      if (isCloudExit && e.aggregate_type !== undefined) {
        // 云退出：该住房所有生活类事件 detail 全部脱敏
        return lifeEventTypes.has(e.event_type) && residenceMatches(e, residenceId);
      }
      const personIds = extractPersonIds(e);
      return [...personIds].some((pid) => outgoing.has(pid));
    }, `control_transfer:${reason}`, at.toISOString());

    count += redacted;
    await this.store._persist();
    return count;
  }
}

/** 判定哪些事件的 detail 属于可还原生活轨迹（需脱敏） */
const lifeEventTypes = new Set(["ACTION_EXECUTED", "RULE_PUBLISHED", "DEVICE_OBSERVED"]);

function residenceMatches(event, residenceId) {
  const d = event.detail || {};
  return (
    d.residenceId === residenceId ||
    d.transfer?.residenceId === residenceId ||
    d.pending?.residenceId === residenceId
  );
}

/** 从事件 detail 中抽取涉及的 personId（尽力而为，覆盖主要字段） */
function extractPersonIds(event) {
  const ids = new Set();
  const d = event.detail || {};
  if (d.subjectId) ids.add(d.subjectId);
  if (d.requestedById) ids.add(d.requestedById);
  if (d.fromPersonId) ids.add(d.fromPersonId);
  if (d.toPersonId && event.event_type !== "CONTROL_TRANSFERRED") ids.add(d.toPersonId);
  const receipt = d.receipt || {};
  if (receipt.priority?.ownerPersonId) ids.add(receipt.priority.ownerPersonId);
  if (d.override?.personId) ids.add(d.override.personId);
  if (d.proposed?.ownerPersonId) ids.add(d.proposed.ownerPersonId);
  if (Array.isArray(d.rules)) {
    for (const r of d.rules) if (r.ownerPersonId) ids.add(r.ownerPersonId);
  }
  return ids;
}

function stripInternals(row) {
  const { version, kind, residenceId, roomId, deviceId, ...rest } = row;
  return rest;
}
