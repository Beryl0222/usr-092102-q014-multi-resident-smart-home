import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  cancelOverride,
  createOverride,
  evaluateSchedule,
  ingestTelemetry,
  setConnectivity,
} from "./arbitration.js";
import {
  addMembership,
  addPrivacyWindow,
  addRoom,
  canAccess,
  canManageMembers,
  createResidence,
  devicesOf,
  getResidence,
  grantConsent,
  registerDevice,
  revokeConsent,
} from "./domain.js";
import { ForbiddenError, NotFoundError } from "./errors.js";
import { explainDecision } from "./explain.js";
import { scopedAudit } from "./privacy.js";
import { createRule, publishRule, retireRule } from "./rules.js";
import { Store } from "./store.js";
import { createTransfer, effectuateTransfer } from "./transfers.js";

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ForbiddenError("请求体必须是 JSON");
  }
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// 成员访问检查：交接生效后旧住户立即被拒绝。
// actorId 为空时视为引导阶段或设备网关通道（生产部署应替换为网关凭证，见 README）。
function requireResidenceAccess(store, actorId, residenceId, now) {
  if (!actorId) return null;
  const member = store.findAggregate(actorId);
  if (!member || member.state.residence_id !== residenceId || !canAccess(store, actorId, now)) {
    throw new ForbiddenError("当前成员无权访问该住房");
  }
  return member;
}

function authorizeMembershipCreation(store, residenceId, actorId, role, now) {
  const existing = store
    .aggregatesOfType("residence_membership")
    .filter((member) => member.state.residence_id === residenceId);
  if (existing.length === 0) {
    if (role !== "owner") throw new ForbiddenError("首位成员必须是产权人");
    return;
  }
  const actor = requireResidenceAccess(store, actorId, residenceId, now);
  if (!actor) throw new ForbiddenError("添加成员需要有效成员身份");
  if (canManageMembers(actor.state)) return;
  if (actor.state.role === "tenant" && ["resident", "guest"].includes(role)) return;
  throw new ForbiddenError("无权添加该角色成员");
}

export function buildApp(store = new Store()) {
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // ---------- 住房、房间、设备 ----------
  route("POST", /^\/residences$/, ({ body }) => createResidence(store, body));
  route("POST", /^\/residences\/([^/]+)\/rooms$/, ({ params: [rid], body }) =>
    addRoom(store, rid, body, body.expected_version ?? null),
  );
  route("GET", /^\/residences\/([^/]+)$/, ({ params: [rid] }) => {
    const residence = getResidence(store, rid);
    return {
      ...residence.state,
      id: residence.id,
      version: residence.version,
      devices: devicesOf(store, rid).map((device) => ({ id: device.id, version: device.version, ...device.state })),
      memberships: store
        .aggregatesOfType("residence_membership")
        .filter((member) => member.state.residence_id === rid)
        .map((member) => ({ id: member.id, version: member.version, ...member.state })),
      rules: store
        .aggregatesOfType("automation_rule")
        .filter((rule) => rule.state.residence_id === rid)
        .map((rule) => ({ id: rule.id, version: rule.version, ...rule.state })),
      overrides: store
        .aggregatesOfType("temporary_override")
        .filter((override) => override.state.residence_id === rid)
        .map((override) => ({ id: override.id, version: override.version, ...override.state })),
    };
  });
  route("POST", /^\/residences\/([^/]+)\/devices$/, ({ params: [rid], body, actorId, now }) => {
    requireResidenceAccess(store, actorId, rid, now);
    return registerDevice(store, { ...body, residence_id: rid });
  });

  // ---------- 成员、同意、隐私时段 ----------
  route("POST", /^\/residences\/([^/]+)\/memberships$/, ({ params: [rid], body, actorId, now }) => {
    authorizeMembershipCreation(store, rid, actorId, body.role, now);
    return addMembership(store, { ...body, residence_id: rid, now });
  });
  route("POST", /^\/memberships\/([^/]+)\/consents$/, ({ params: [mid], body, actorId, now }) =>
    grantConsent(store, mid, {
      ...body,
      grantor_id: body.grantor_id ?? actorId,
      now,
      expected_version: body.expected_version ?? null,
    }),
  );
  route("POST", /^\/memberships\/([^/]+)\/consents\/([^/]+)\/revoke$/, ({ params: [mid, cid], body, actorId, now }) =>
    revokeConsent(store, mid, cid, { actor_id: actorId, now, expected_version: body.expected_version ?? null }),
  );
  route("POST", /^\/memberships\/([^/]+)\/privacy-windows$/, ({ params: [mid], body, actorId, now }) =>
    addPrivacyWindow(store, mid, { ...body, actor_id: actorId, now, expected_version: body.expected_version ?? null }),
  );
  route("GET", /^\/memberships\/([^/]+)\/access$/, ({ params: [mid], query }) => ({
    membership_id: mid,
    at: query.get("at"),
    access: canAccess(store, mid, query.get("at") ?? new Date().toISOString()),
  }));

  // ---------- 规则 ----------
  route("POST", /^\/residences\/([^/]+)\/rules$/, ({ params: [rid], body, actorId, now }) => {
    requireResidenceAccess(store, actorId, rid, now);
    return createRule(store, { ...body, residence_id: rid, created_by: body.created_by ?? actorId, now });
  });
  route("POST", /^\/rules\/([^/]+)\/publish$/, ({ params: [ruleId], body, actorId, now }) =>
    publishRule(store, ruleId, {
      actor_id: body.actor_id ?? actorId,
      expected_version: body.expected_version ?? null,
      now,
    }),
  );
  route("POST", /^\/rules\/([^/]+)\/retire$/, ({ params: [ruleId], body, actorId, now }) =>
    retireRule(store, ruleId, {
      actor_id: body.actor_id ?? actorId,
      expected_version: body.expected_version ?? null,
      now,
    }),
  );

  // ---------- 临时覆盖 ----------
  route("POST", /^\/residences\/([^/]+)\/overrides$/, ({ params: [rid], body, actorId, now }) => {
    requireResidenceAccess(store, actorId, rid, now);
    return createOverride(store, { ...body, residence_id: rid, member_id: body.member_id ?? actorId, now });
  });
  route("POST", /^\/overrides\/([^/]+)\/cancel$/, ({ params: [oid], body, actorId, now }) =>
    cancelOverride(store, oid, { actor_id: body.actor_id ?? actorId, now, expected_version: body.expected_version ?? null }),
  );

  // ---------- 事件摄取与裁决 ----------
  route("POST", /^\/residences\/([^/]+)\/events$/, ({ body }) => {
    const result = ingestTelemetry(store, body);
    return {
      duplicate: result.duplicate,
      decision_id: result.decision?.id ?? null,
      outcomes: result.decision?.outcomes ?? [],
    };
  });
  route("POST", /^\/residences\/([^/]+)\/tick$/, ({ params: [rid], body, now }) => {
    const decision = evaluateSchedule(store, rid, body.now ?? now);
    return { decision_id: decision.id, outcomes: decision.outcomes };
  });
  route("POST", /^\/devices\/([^/]+)\/connectivity$/, ({ params: [did], body, now }) =>
    setConnectivity(store, did, body.status, now),
  );

  // ---------- 回执、解释、审计 ----------
  route("GET", /^\/residences\/([^/]+)\/receipts$/, ({ params: [rid], query }) => {
    const status = query.get("status");
    return store
      .aggregatesOfType("execution_receipt")
      .filter((receipt) => receipt.state.residence_id === rid && (!status || receipt.state.status === status))
      .map((receipt) => ({ id: receipt.id, version: receipt.version, ...receipt.state }));
  });
  route("GET", /^\/decisions\/([^/]+)\/explanation$/, ({ params: [did] }) => explainDecision(store, did));
  route("GET", /^\/residences\/([^/]+)\/audit$/, ({ params: [rid], query }) =>
    scopedAudit(store, rid, query.get("perspective") ?? "resident"),
  );
  route("GET", /^\/residences\/([^/]+)\/events$/, ({ params: [rid] }) => {
    const ids = new Set([rid]);
    for (const aggregate of store.aggregates.values()) {
      if (aggregate.state?.residence_id === rid) ids.add(aggregate.id);
    }
    return store.events.filter((event) => ids.has(event.aggregate_id));
  });

  // ---------- 控制权与数据交接 ----------
  route("POST", /^\/residences\/([^/]+)\/transfers$/, ({ params: [rid], body, actorId, now }) =>
    createTransfer(store, { ...body, residence_id: rid, actor_id: body.actor_id ?? actorId, now }),
  );
  route("POST", /^\/transfers\/([^/]+)\/effectuate$/, ({ params: [tid], body, actorId, now }) =>
    effectuateTransfer(store, tid, { actor_id: body.actor_id ?? actorId, now }),
  );

  return async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    const body = req.method === "GET" || req.method === "HEAD" ? {} : await readJson(req);
    const now = body.now ?? url.searchParams.get("now") ?? new Date().toISOString();
    const actorId = req.headers["x-member-id"] ?? body.actor_id ?? null;
    try {
      for (const { method, pattern, handler: handle } of routes) {
        if (method !== req.method) continue;
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        const result = await handle({ params: match.slice(1), query: url.searchParams, body, actorId, now });
        send(res, 200, result ?? {});
        return;
      }
      throw new NotFoundError(`路由不存在：${req.method} ${url.pathname}`);
    } catch (error) {
      send(res, error.status ?? 500, { error: error.message, errors: error.errors });
    }
  };
}

export function buildServer(store = new Store()) {
  return createServer(buildApp(store));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  buildServer().listen(port, () => {
    console.log(`多住户智能家居裁决后端已启动：http://localhost:${port}`);
  });
}
