/**
 * HTTP 适配层（零第三方依赖）。
 *
 * 这是品牌无关裁决后端的对外接口：接收注册、规则、同意、覆盖、交接请求，
 * 以及符合 contracts/domain.schema.json 的设备观测事件。
 * 真正的设备控制不在本进程内——裁决通过 engine.adapter（适配层）下发。
 *
 * 身份约定：受访问控制的接口通过 `x-person-id` 头表明请求居民；
 * 生产部署应由网关把认证主体映射到该头，此处不绑定任何厂商账号体系。
 */
import { createServer } from "node:http";

import { ConflictError, DomainError } from "./domain/store.js";

export function createHttpServer(app) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      await route(app, req, res, url);
    } catch (err) {
      sendError(res, err);
    }
  });
}

async function route(app, req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (method === "GET" && pathname === "/health") {
    return json(res, 200, { ok: true, service: "multi-resident-smart-home-arbitration", time: app.clock().toISOString() });
  }

  // 注册类
  if (method === "POST" && pathname === "/residences") {
    const b = await readJson(req);
    return json(res, 201, await app.registration.createResidence(b));
  }
  let m = match(method, "POST", pathname, /^\/residences\/([^/]+)\/rooms$/);
  if (m) {
    const b = await readJson(req);
    return json(res, 201, await app.registration.addRoom({ residenceId: m[1], ...b }));
  }
  if (method === "POST" && pathname === "/devices") {
    const b = await readJson(req);
    return json(res, 201, await app.registration.registerDevice(b));
  }
  if (method === "POST" && pathname === "/persons") {
    const b = await readJson(req);
    return json(res, 201, await app.registration.registerPerson(b));
  }
  if (method === "POST" && pathname === "/memberships") {
    const b = await readJson(req);
    return json(res, 201, await app.registration.addMembership(b));
  }

  // 同意与采集限制
  if (method === "POST" && pathname === "/consents") {
    const b = await readJson(req);
    return json(res, 201, await app.registration.grantConsent(b));
  }
  m = match(method, "POST", pathname, /^\/consents\/([^/]+)\/withdraw$/);
  if (m) {
    const b = await readJson(req);
    return json(res, 200, await app.registration.withdrawConsent(m[1], b.requestedByPersonId));
  }
  if (method === "POST" && pathname === "/restrictions") {
    const b = await readJson(req);
    return json(res, 201, await app.registration.addCollectionRestriction(b));
  }

  // 规则
  if (method === "POST" && pathname === "/rules") {
    const b = await readJson(req);
    const expected = req.headers["x-expected-version"];
    const result = await app.rules.publishRule(b, expected ? Number(expected) : undefined);
    return json(res, result.rejected ? 422 : 201, result);
  }
  if (method === "GET" && pathname === "/rules") {
    const residenceId = requireQuery(url, "residenceId");
    return json(res, 200, { rules: app.rules.listActive(residenceId) });
  }

  // 设备观测事件（核心入口）
  if (method === "POST" && pathname === "/events") {
    const envelope = await readJson(req);
    const result = await app.engine.ingestObservation(envelope);
    return json(res, 200, result);
  }

  // 临时覆盖
  if (method === "POST" && pathname === "/overrides") {
    const b = await readJson(req);
    return json(res, 201, await app.engine.requestOverride(b));
  }  m = match(method, "POST", pathname, /^\/overrides\/([^/]+)\/cancel$/);
  if (m) {
    const b = await readJson(req);
    return json(res, 200, await app.engine.cancelOverride(m[1], b.personId));
  }

  // 交接
  if (method === "POST" && pathname === "/handovers") {
    const b = await readJson(req);
    const result = await app.handovers.scheduleHandover(b);
    return json(res, 201, result);
  }
  m = match(method, "POST", pathname, /^\/handovers\/([^/]+)\/effectuate$/);
  if (m) {
    return json(res, 200, await app.handovers.effectuate(m[1]));
  }
  m = match(method, "POST", pathname, /^\/exports\/([^/]+)\/claim$/);
  if (m) {
    const b = await readJson(req);
    return json(res, 200, await app.handovers.claimExport(m[1], b.claimToken));
  }
  if (method === "POST" && pathname === "/handovers/run-due") {
    return json(res, 200, { results: await app.applyDueHandovers() });
  }

  // 回执查询（访问受控：仅在住数据主体）
  if (method === "GET" && pathname === "/receipts") {
    const residenceId = requireQuery(url, "residenceId");
    const requesterId = req.headers["x-person-id"] || url.searchParams.get("requesterId") || null;
    const receipts = app.engine.queryReceipts({
      residenceId,
      deviceId: url.searchParams.get("deviceId"),
      eventId: url.searchParams.get("eventId"),
      requesterId,
    });
    return json(res, 200, { receipts });
  }

  // 审计事件流（仅返回信封 + kind，不回流生活细节，防止三方拼轨迹）
  if (method === "GET" && pathname === "/events") {
    const residenceId = requireQuery(url, "residenceId");
    const requesterId = req.headers["x-person-id"] || url.searchParams.get("requesterId");
    app.engine.queryReceipts({ residenceId, requesterId }); // 复用访问控制
    const events = app.store.events
      .filter((e) => eventResidence(e) === residenceId)
      .map((e) => ({
        event_id: e.event_id,
        event_type: e.event_type,
        aggregate_type: e.aggregate_type,
        aggregate_id: e.aggregate_id,
        occurred_at: e.occurred_at,
        version: e.version,
        summary: e.summary,
        kind: e.detail?.kind,
      }));
    return json(res, 200, { events });
  }

  return json(res, 404, { error: "not_found", path: pathname });
}

function eventResidence(e) {
  const d = e.detail || {};
  return (
    d.residenceId ||
    d.transfer?.residenceId ||
    d.pending?.residenceId ||
    d.override?.residenceId ||
    d.rule?.residenceId ||
    d.proposed?.residenceId ||
    d.receipt?.residenceId ||
    null
  );
}

function match(actual, expected, pathname, re) {
  if (actual !== expected) return null;
  return pathname.match(re);
}

function requireQuery(url, name) {
  const v = url.searchParams.get(name);
  if (!v) throw new DomainError("BAD_REQUEST", `缺少查询参数：${name}`);
  return v;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new DomainError("BAD_JSON", "请求体不是合法 JSON");
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function sendError(res, err) {
  if (err instanceof DomainError || err?.name === "DomainError") {
    const status = err.code === "BAD_REQUEST" || err.code.startsWith("BAD_") ? 400 : 422;
    return json(res, status, { error: err.code, message: err.message, details: err.details });
  }
  if (err instanceof ConflictError || err?.code === "VERSION_CONFLICT") {
    return json(res, 409, { error: "VERSION_CONFLICT", message: err.message, details: err.details });
  }
  // eslint-disable-next-line no-console
  console.error("[arbitration] 未处理错误：", err);
  return json(res, 500, { error: "internal_error", message: "服务器内部错误" });
}
