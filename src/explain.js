import { NotFoundError } from "./errors.js";
import { PRIORITY_LABELS } from "./rules.js";

// 裁决解释：住户可以看到某次自动化为何执行、被谁压制，以及怎样临时覆盖。

export function explainDecision(store, decisionId) {
  const decision = store.decisions.get(decisionId);
  if (!decision) throw new NotFoundError(`裁决记录不存在：${decisionId}`);
  const outcomes = decision.outcomes.map((outcome) => {
    const receipt = store.getAggregate(outcome.receipt_id);
    const rule = store.findAggregate(outcome.rule_id);
    return {
      receipt_id: outcome.receipt_id,
      rule: rule
        ? { id: rule.id, name: rule.state.name, priority_class: rule.state.priority_class, rank: rule.state.rank }
        : { id: outcome.rule_id },
      action: outcome.action,
      result: receipt.state.status,
      reason: receipt.state.reason,
      basis: receipt.state.priority_class
        ? {
            priority_class: receipt.state.priority_class,
            rank: receipt.state.rank,
            label: PRIORITY_LABELS[receipt.state.priority_class],
          }
        : null,
      suppressed_by: receipt.state.suppressor,
    };
  });
  return {
    decision_id: decision.id,
    trigger: decision.trigger,
    now: decision.now,
    active_claims: decision.claims,
    outcomes,
    how_to_override: outcomes
      .filter((outcome) => outcome.result === "suppressed")
      .map((outcome) => overrideSuggestion(outcome))
      .filter(Boolean),
  };
}

function overrideSuggestion(outcome) {
  const suppressor = outcome.suppressed_by;
  if (!suppressor) return null;
  const base = { suppressed_receipt_id: outcome.receipt_id, suppressor };
  switch (suppressor.type) {
    case "claim":
    case "rule":
      if (outcome.basis?.priority_class === "safety") {
        return {
          ...base,
          suggestion: "安全类冲突不能通过临时覆盖解决，请由产权人或承租人调整规则的优先级依据",
          endpoint: "POST /rules/:id/retire 后重新发布",
        };
      }
      return {
        ...base,
        suggestion: "由成年住户创建临时覆盖（effect=block）可暂时压制该非安全类规则或主张",
        endpoint: "POST /residences/:rid/overrides",
      };
    case "consent":
      return {
        ...base,
        suggestion: `由成员「${suppressor.label}」授予对应采集同意；成年成员也可创建 allow 类临时覆盖（仅豁免本人）`,
        endpoint: "POST /memberships/:mid/consents",
      };
    case "privacy_window":
      return {
        ...base,
        suggestion: "该时段为成员隐私时段；成年成员可用 allow 覆盖临时豁免自己的时段，未成年人的隐私时段不可豁免",
        endpoint: "POST /residences/:rid/overrides",
      };
    case "override":
      return {
        ...base,
        suggestion: "取消对应的临时覆盖后动作即可恢复",
        endpoint: "POST /overrides/:id/cancel",
      };
    case "offline":
      return {
        ...base,
        suggestion: "等待设备恢复在线，系统会重新判断动作是否仍然有效，过期动作不会补执行",
        endpoint: "POST /devices/:id/connectivity",
      };
    default:
      return null;
  }
}
