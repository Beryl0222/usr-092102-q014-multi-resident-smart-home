import { devicesOf } from "./domain.js";
import { ValidationError } from "./errors.js";

// 视角化审计：房东、物业与设备厂商只能看到与其职责匹配的最小信息，
// 不能借故获得完整生活轨迹；已迁出成员的个人标识被封存为「前住户」。

function receiptsOf(store, residenceId) {
  return store
    .aggregatesOfType("execution_receipt")
    .filter((receipt) => receipt.state.residence_id === residenceId)
    .map((receipt) => ({ id: receipt.id, version: receipt.version, ...receipt.state }));
}

function residenceAggregateIds(store, residenceId) {
  const ids = new Set([residenceId]);
  for (const aggregate of store.aggregates.values()) {
    if (aggregate.state?.residence_id === residenceId) ids.add(aggregate.id);
  }
  return ids;
}

function redactSuppressor(suppressor, sealed) {
  if (!suppressor) return null;
  if (sealed.has(suppressor.id)) return { type: suppressor.type, id: "former-member", label: "前住户" };
  return suppressor;
}

function deviceHealth(store, residenceId) {
  // 不提供设备标签：标签（如「老人房插座」）会暴露家庭构成
  return devicesOf(store, residenceId).map((device) => ({
    device_id: device.id,
    capabilities: device.state.capabilities,
    connectivity: device.state.connectivity,
    integration: device.state.integration,
  }));
}

function deviceDiagnostics(store, residenceId) {
  const receipts = receiptsOf(store, residenceId);
  return devicesOf(store, residenceId).map((device) => {
    const own = receipts.filter((receipt) => receipt.device_id === device.id);
    return {
      device_id: device.id,
      capabilities: device.state.capabilities,
      connectivity: device.state.connectivity,
      executed_count: own.filter((receipt) => receipt.status === "executed").length,
      suppressed_count: own.filter((receipt) => receipt.status === "suppressed").length,
      expired_count: own.filter((receipt) => receipt.status === "expired").length,
    };
  });
}

export function scopedAudit(store, residenceId, perspective) {
  const residence = store.getAggregate(residenceId);
  const sealed = new Set(residence.state.sealed_member_ids);
  const receipts = receiptsOf(store, residenceId);

  // 已迁出成员的姓名在文本中一律替换为「前住户」
  const sealedNames = [];
  for (const memberId of sealed) {
    const member = store.findAggregate(memberId);
    if (member) sealedNames.push(member.state.name);
  }
  const redactText = (text) => {
    if (typeof text !== "string") return text;
    let output = text;
    for (const name of sealedNames) output = output.split(name).join("前住户");
    return output;
  };

  if (perspective === "resident") {
    // 住户可见完整裁决轨迹（为何执行、被谁压制），但已迁出成员仅显示为「前住户」
    const aggregateIds = residenceAggregateIds(store, residenceId);
    return {
      perspective,
      receipts: receipts.map((receipt) => ({
        ...receipt,
        reason: redactText(receipt.reason),
        suppressor: redactSuppressor(receipt.suppressor, sealed),
      })),
      events: store.events
        .filter((event) => aggregateIds.has(event.aggregate_id))
        .map((event) => ({ ...event, summary: redactText(event.summary) })),
    };
  }

  if (perspective === "landlord" || perspective === "property") {
    // 房东/物业：仅安全类处置与设备健康，时间粗化到小时，不出现任何成员身份
    return {
      perspective,
      safety_receipts: receipts
        .filter((receipt) => receipt.priority_class === "safety")
        .map((receipt) => ({
          receipt_id: receipt.id,
          device_id: receipt.device_id,
          capability: receipt.capability,
          status: receipt.status,
          hour: receipt.decided_at?.slice(0, 13) ?? null,
        })),
      device_health: deviceHealth(store, residenceId),
      conflict_count: store.events.filter((event) => event.event_type === "CONFLICT_DETECTED").length,
    };
  }

  if (perspective === "vendor") {
    // 设备厂商：仅设备能力级诊断计数，无成员、房间、规则与轨迹内容
    return { perspective, diagnostics: deviceDiagnostics(store, residenceId) };
  }

  throw new ValidationError([`未知视角：${perspective}`]);
}
