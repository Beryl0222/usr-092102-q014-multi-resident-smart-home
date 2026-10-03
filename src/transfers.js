import { addMembership, canManageTransfers, devicesOf, endMembership, getResidence } from "./domain.js";
import { ForbiddenError, ValidationError } from "./errors.js";
import { newId } from "./store.js";

// 搬家、换租、转售、云服务退出：控制权与数据交接。
// 交接生效起，旧住户的成员关系终止、同意撤回、个人规则停用，无法再访问设备。
export const TRANSFER_KINDS = ["move_out", "lease_change", "resale", "cloud_exit"];
export const DATA_POLICIES = ["export_then_delete", "delete", "retain_anonymized"];

export function createTransfer(
  store,
  { residence_id, kind, effective_at, outgoing_member_ids = [], incoming = [], data_policy = "export_then_delete", actor_id, now },
) {
  getResidence(store, residence_id);
  const actor = store.getAggregate(actor_id);
  if (actor.state.residence_id !== residence_id || !canManageTransfers(actor.state)) {
    throw new ForbiddenError("只有产权人或承租人可以发起交接");
  }
  if (!TRANSFER_KINDS.includes(kind)) {
    throw new ValidationError([`交接类型必须是：${TRANSFER_KINDS.join("、")}`]);
  }
  if (!DATA_POLICIES.includes(data_policy)) {
    throw new ValidationError([`数据策略必须是：${DATA_POLICIES.join("、")}`]);
  }
  if (!effective_at || Number.isNaN(Date.parse(effective_at)) || Date.parse(effective_at) <= Date.parse(now)) {
    throw new ValidationError(["交接生效时间必须晚于当前时间"]);
  }
  for (const memberId of outgoing_member_ids) {
    const member = store.getAggregate(memberId);
    if (member.state.residence_id !== residence_id || member.state.status !== "active") {
      throw new ValidationError([`待迁出成员无效：${memberId}`]);
    }
  }
  const id = newId("xfer");
  store.createAggregate("control_transfer", id, {
    residence_id,
    kind,
    effective_at,
    outgoing_member_ids,
    incoming,
    data_policy,
    status: "scheduled",
    created_by: actor_id,
    created_at: now,
    effectuated_at: null,
    incoming_member_ids: [],
  });
  return store.getAggregate(id);
}

export function effectuateTransfer(store, transferId, { actor_id, now }) {
  const aggregate = store.getAggregate(transferId);
  const transfer = aggregate.state;
  if (transfer.status !== "scheduled") throw new ValidationError([`交接当前状态为 ${transfer.status}，不能执行`]);
  if (Date.parse(now) < Date.parse(transfer.effective_at)) {
    throw new ValidationError(["尚未到达交接生效时间"]);
  }
  const actor = store.getAggregate(actor_id);
  if (actor.state.residence_id !== transfer.residence_id || !canManageTransfers(actor.state)) {
    throw new ForbiddenError("只有产权人或承租人可以执行交接");
  }

  const handedOver = [];
  for (const memberId of transfer.outgoing_member_ids) {
    const member = store.getAggregate(memberId);
    if (member.state.status !== "active") continue;
    // 1. 成员关系自生效时刻终止，其授予的同意一并撤回
    endMembership(store, memberId, { now: transfer.effective_at, reason: "control_transferred" });
    // 2. 个人偏好规则（舒适/节能）停用；安全/隐私/照护类规则保留，继续保护留住成员
    const ownRules = store
      .aggregatesOfType("automation_rule")
      .filter((rule) => rule.state.created_by === memberId && rule.state.status === "published");
    for (const rule of ownRules) {
      if (["comfort", "energy"].includes(rule.state.priority_class)) {
        store.mutateAggregate(rule.id, null, (draft) => {
          draft.status = "retired";
          draft.retired_at = transfer.effective_at;
          draft.retire_reason = "创建者迁出";
        });
      }
    }
    // 3. 未结束的临时覆盖取消
    for (const override of store.aggregatesOfType("temporary_override")) {
      if (override.state.member_id === memberId && override.state.status === "active") {
        store.mutateAggregate(override.id, null, (draft) => {
          draft.status = "cancelled";
          draft.cancelled_at = transfer.effective_at;
        });
      }
    }
    // 4. 数据交接：为迁出成员生成数据包记录，并将其个人轨迹封存（新住户与外部角色不可见）
    const receiptCount = store
      .aggregatesOfType("execution_receipt")
      .filter((receipt) => receipt.state.residence_id === transfer.residence_id).length;
    store.dataPackages.push({
      id: newId("pkg"),
      transfer_id: transferId,
      member_id: memberId,
      policy: transfer.data_policy,
      receipt_count: receiptCount,
      consent_count: member.state.consents.length,
      created_at: now,
    });
    handedOver.push(memberId);
  }
  store.mutateAggregate(transfer.residence_id, null, (draft) => {
    draft.sealed_member_ids.push(...handedOver);
  });

  // 5. 新住户自生效时刻起获得成员关系
  const incomingIds = [];
  for (const person of transfer.incoming) {
    const membership = addMembership(store, {
      ...person,
      residence_id: transfer.residence_id,
      valid_from: transfer.effective_at,
      now: transfer.effective_at,
    });
    incomingIds.push(membership.id);
  }

  // 6. 云服务退出：设备解绑厂商云回到本地集成，排队动作按过期处理
  if (transfer.kind === "cloud_exit") {
    for (const device of devicesOf(store, transfer.residence_id)) {
      if (device.state.integration !== "local") {
        store.mutateAggregate(device.id, null, (draft) => {
          draft.integration = "local";
        });
      }
    }
    for (const receipt of store.aggregatesOfType("execution_receipt")) {
      if (receipt.state.residence_id === transfer.residence_id && receipt.state.status === "queued") {
        store.mutateAggregate(receipt.id, null, (draft) => {
          draft.status = "expired";
          draft.reason = "云服务退出，排队动作不再执行";
        });
      }
    }
  }

  const updated = store.mutateAggregate(transferId, null, (draft) => {
    draft.status = "effective";
    draft.effectuated_at = now;
    draft.incoming_member_ids = incomingIds;
  });
  store.appendEvent({
    event_type: "CONTROL_TRANSFERRED",
    aggregate_type: "control_transfer",
    aggregate_id: transferId,
    occurred_at: now,
    version: updated.version,
    summary: `控制权交接生效（${transfer.kind}）：迁出 ${handedOver.length} 人，迁入 ${incomingIds.length} 人`,
    detail: { kind: transfer.kind, outgoing: handedOver, incoming: incomingIds, data_policy: transfer.data_policy },
  });
  return updated;
}
