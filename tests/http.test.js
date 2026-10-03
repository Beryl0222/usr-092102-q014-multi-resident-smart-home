import assert from "node:assert/strict";
import test from "node:test";

import { buildServer } from "../src/server.js";

async function startServer() {
  const server = buildServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, { body, memberId } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(memberId ? { "x-member-id": memberId } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  return { server, call };
}

test("HTTP 端到端：建模 → 发布 → 裁决 → 解释 → 交接 → 访问切断", async () => {
  const { server, call } = await startServer();
  try {
    // 建模
    const res = (await call("POST", "/residences", { body: { name: "联调测试房" } })).body;
    const room = (await call("POST", `/residences/${res.id}/rooms`, { body: { name: "厨房" } })).body;
    const sensor = (
      await call("POST", `/residences/${res.id}/devices`, {
        body: { room_id: room.id, label: "水浸传感器", capabilities: ["sensor.leak"] },
      })
    ).body;
    const valve = (
      await call("POST", `/residences/${res.id}/devices`, {
        body: { room_id: room.id, label: "总水阀", capabilities: ["valve.actuate"] },
      })
    ).body;
    const owner = (
      await call("POST", `/residences/${res.id}/memberships`, {
        body: { name: "户主", role: "owner", now: "2026-10-03T12:00:00+08:00" },
      })
    ).body;
    const tenant = (
      await call("POST", `/residences/${res.id}/memberships`, {
        memberId: owner.id,
        body: { name: "租客", role: "tenant", now: "2026-10-03T12:00:00+08:00" },
      })
    ).body;

    // 规则与发布（含乐观并发校验）
    const rule = (
      await call("POST", `/residences/${res.id}/rules`, {
        memberId: owner.id,
        body: {
          name: "漏水关阀",
          priority_class: "safety",
          trigger: { type: "device_event", capability: "sensor.leak", match: { state: "detected" } },
          actions: [{ device_id: valve.id, capability: "valve.actuate", params: { state: "close" } }],
          now: "2026-10-03T12:00:00+08:00",
        },
      })
    ).body;
    const stale = await call("POST", `/rules/${rule.id}/publish`, {
      memberId: owner.id,
      body: { expected_version: 99, now: "2026-10-03T12:00:00+08:00" },
    });
    assert.equal(stale.status, 409, "过期版本号应返回 409");
    const published = await call("POST", `/rules/${rule.id}/publish`, {
      memberId: owner.id,
      body: { expected_version: 1, now: "2026-10-03T12:00:00+08:00" },
    });
    assert.equal(published.status, 200);

    // 设备事件触发裁决
    const decision = await call("POST", `/residences/${res.id}/events`, {
      body: {
        event_id: "evt-http-leak-1",
        event_type: "TELEMETRY_REPORTED",
        aggregate_type: "device_capability",
        aggregate_id: sensor.id,
        occurred_at: "2026-10-04T03:00:00+08:00",
        version: 1,
        summary: "厨房漏水",
        detail: { capability: "sensor.leak", state: "detected" },
      },
    });
    assert.equal(decision.status, 200);
    assert.equal(decision.body.outcomes[0].status, "executed");
    // 重传同一事件 → 幂等
    const replay = await call("POST", `/residences/${res.id}/events`, {
      body: {
        event_id: "evt-http-leak-1",
        event_type: "TELEMETRY_REPORTED",
        aggregate_type: "device_capability",
        aggregate_id: sensor.id,
        occurred_at: "2026-10-04T03:00:00+08:00",
        version: 1,
        summary: "厨房漏水",
        detail: { capability: "sensor.leak", state: "detected" },
      },
    });
    assert.equal(replay.body.duplicate, true);

    // 回执与解释
    const receipts = (await call("GET", `/residences/${res.id}/receipts`)).body;
    assert.equal(receipts.length, 1);
    const explanation = (await call("GET", `/decisions/${decision.body.decision_id}/explanation`)).body;
    assert.equal(explanation.outcomes[0].result, "executed");
    assert.equal(explanation.outcomes[0].basis.label, "安全处置");

    // 非法事件被契约校验拒绝
    const invalid = await call("POST", `/residences/${res.id}/events`, { body: { event_id: "bad" } });
    assert.equal(invalid.status, 400);

    // 交接：租客迁出
    const transfer = (
      await call("POST", `/residences/${res.id}/transfers`, {
        memberId: owner.id,
        body: {
          kind: "move_out",
          effective_at: "2026-11-01T00:00:00+08:00",
          outgoing_member_ids: [tenant.id],
          incoming: [],
          now: "2026-10-15T10:00:00+08:00",
        },
      })
    ).body;
    await call("POST", `/transfers/${transfer.id}/effectuate`, {
      memberId: owner.id,
      body: { now: "2026-11-01T00:00:00+08:00" },
    });
    // 旧住户自交接生效起无法再访问设备
    const access = (await call("GET", `/memberships/${tenant.id}/access?at=2026-11-01T00:00:00%2B08:00`)).body;
    assert.equal(access.access, false);
    const forbidden = await call("POST", `/residences/${res.id}/rules`, {
      memberId: tenant.id,
      body: {
        name: "越权规则",
        priority_class: "comfort",
        trigger: { type: "schedule", at: "12:00" },
        actions: [{ device_id: valve.id, capability: "valve.actuate", params: { state: "open" } }],
        now: "2026-11-02T00:00:00+08:00",
      },
    });
    assert.equal(forbidden.status, 403);

    // 视角化审计
    const landlord = (await call("GET", `/residences/${res.id}/audit?perspective=landlord`)).body;
    assert.ok(Array.isArray(landlord.safety_receipts));
    const vendor = (await call("GET", `/residences/${res.id}/audit?perspective=vendor`)).body;
    assert.ok(Array.isArray(vendor.diagnostics));
  } finally {
    server.close();
  }
});
