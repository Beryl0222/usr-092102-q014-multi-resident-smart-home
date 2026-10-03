import assert from "node:assert/strict";
import test from "node:test";

import { SmartHomeArbitration } from "../src/domain/app.js";
import { createHttpServer } from "../src/server.js";
import { DEVICE_EVENT_KIND, EVENT_TYPE, PRIORITY_BASIS } from "../src/domain/constants.js";

async function withServer(run) {
  const app = await SmartHomeArbitration.create({ clock: () => new Date("2026-10-03T02:10:00+08:00") });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await run({ base, app });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(base, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function get(base, path, headers = {}) {
  const res = await fetch(base + path, { headers });
  return { status: res.status, body: await res.json() };
}

test("健康检查", async () => {
  await withServer(async ({ base }) => {
    const res = await get(base, "/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });
});

test("HTTP 端到端：登记→规则→漏水事件→关阀→回执可查", async () => {
  await withServer(async ({ base }) => {
    assert.equal((await post(base, "/residences", { residenceId: "r1", name: "公寓" })).status, 201);
    assert.equal((await post(base, "/residences/r1/rooms", { roomId: "bath", name: "卫" })).status, 201);
    assert.equal((await post(base, "/persons", { personId: "p", name: "家长" })).status, 201);
    assert.equal(
      (await post(base, "/memberships", { residenceId: "r1", personId: "p", role: "owner", occupiesRooms: ["bath"] })).status,
      201,
    );
    assert.equal(
      (
        await post(base, "/devices", {
          deviceId: "leak", residenceId: "r1", roomId: "bath",
          capability: "water_leak", actions: ["alert", "clear"], safetyRelated: true,
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await post(base, "/devices", {
          deviceId: "valve", residenceId: "r1", roomId: "bath",
          capability: "valve.shutoff", actions: ["shut", "open"], safetyRelated: true,
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await post(base, "/rules", {
          residenceId: "r1", name: "漏水关阀", ownerPersonId: "p",
          priorityBasis: PRIORITY_BASIS.EMERGENCY_SENSOR_ALERT,
          trigger: { capability: "water_leak", sensorAlerts: ["water_leak"] },
          actions: [{ deviceId: "valve", capability: "valve.shutoff", setState: "shut" }],
        })
      ).status,
      201,
    );

    const evt = {
      event_id: "http-leak-1",
      event_type: EVENT_TYPE.DEVICE_OBSERVED,
      aggregate_type: "device_capability",
      aggregate_id: "leak",
      occurred_at: "2026-10-03T02:10:00+08:00",
      version: 1,
      summary: "漏水告警",
      detail: { kind: DEVICE_EVENT_KIND.SENSOR_ALERT, alert: "water_leak" },
    };
    const decided = await post(base, "/events", evt);
    assert.equal(decided.status, 200);
    assert.ok(decided.body.receipts.some((r) => r.deviceId === "valve" && r.outcome === "executed"));

    // 回执查询（在住成员）
    const receipts = await get(base, "/receipts?residenceId=r1", { "x-person-id": "p" });
    assert.equal(receipts.status, 200);
    assert.ok(receipts.body.receipts.length >= 1);
    assert.match(receipts.body.receipts[0].explanation.short, /已执行/);

    // 非成员查询拒绝
    const denied = await get(base, "/receipts?residenceId=r1", { "x-person-id": "stranger" });
    assert.equal(denied.status, 422);
  });
});

test("不合规信封被拒绝（400 校验错误）", async () => {
  await withServer(async ({ base }) => {
    await post(base, "/residences", { residenceId: "r1", name: "公寓" });
    await post(base, "/devices", {
      deviceId: "d", residenceId: "r1", capability: "x", actions: ["on"],
    });
    const bad = { event_id: "", event_type: "NOPE", aggregate_type: "device_capability", aggregate_id: "d", occurred_at: "not-a-date", version: 0, summary: "" };
    const res = await post(base, "/events", bad);
    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.details.errors));
  });
});

test("循环规则发布返回 422 与诊断", async () => {
  await withServer(async ({ base }) => {
    await post(base, "/residences", { residenceId: "r1", name: "公寓" });
    await post(base, "/residences/r1/rooms", { roomId: "h", name: "厅" });
    await post(base, "/persons", { personId: "p", name: "家长" });
    await post(base, "/memberships", { residenceId: "r1", personId: "p", role: "owner", occupiesRooms: ["h"] });
    await post(base, "/devices", { deviceId: "lamp", residenceId: "r1", roomId: "h", capability: "light", actions: ["on", "off"] });
    await post(base, "/devices", { deviceId: "cam", residenceId: "r1", roomId: "h", capability: "camera", actions: ["on", "off"] });
    await post(base, "/rules", {
      residenceId: "r1", name: "A", ownerPersonId: "p",
      priorityBasis: PRIORITY_BASIS.PERSONAL_PREFERENCE,
      trigger: { capability: "light", states: ["on"] },
      actions: [{ deviceId: "cam", capability: "camera", setState: "off" }],
    });
    const rej = await post(base, "/rules", {
      residenceId: "r1", name: "B", ownerPersonId: "p",
      priorityBasis: PRIORITY_BASIS.PERSONAL_PREFERENCE,
      trigger: { capability: "camera", states: ["off"] },
      actions: [{ deviceId: "lamp", capability: "light", setState: "on" }],
    });
    assert.equal(rej.status, 422);
    assert.ok(rej.body.rejected.cycles.length >= 1);
  });
});

test("审计事件流只回信封与 kind，不回流生活细节", async () => {
  await withServer(async ({ base }) => {
    await post(base, "/residences", { residenceId: "r1", name: "公寓" });
    await post(base, "/residences/r1/rooms", { roomId: "b", name: "卫" });
    await post(base, "/persons", { personId: "p", name: "家长" });
    await post(base, "/memberships", { residenceId: "r1", personId: "p", role: "owner", occupiesRooms: ["b"] });
    await post(base, "/devices", { deviceId: "leak", residenceId: "r1", roomId: "b", capability: "water_leak", actions: ["alert", "clear"], safetyRelated: true });
    await post(base, "/devices", { deviceId: "valve", residenceId: "r1", roomId: "b", capability: "valve.shutoff", actions: ["shut", "open"], safetyRelated: true });
    await post(base, "/rules", {
      residenceId: "r1", name: "关阀", ownerPersonId: "p",
      priorityBasis: PRIORITY_BASIS.EMERGENCY_SENSOR_ALERT,
      trigger: { capability: "water_leak", sensorAlerts: ["water_leak"] },
      actions: [{ deviceId: "valve", capability: "valve.shutoff", setState: "shut" }],
    });
    await post(base, "/events", {
      event_id: "e1", event_type: EVENT_TYPE.DEVICE_OBSERVED, aggregate_type: "device_capability",
      aggregate_id: "leak", occurred_at: "2026-10-03T02:10:00+08:00", version: 1, summary: "漏水",
      detail: { kind: DEVICE_EVENT_KIND.SENSOR_ALERT, alert: "water_leak" },
    });
    const stream = await get(base, "/events?residenceId=r1", { "x-person-id": "p" });
    assert.equal(stream.status, 200);
    for (const e of stream.body.events) {
      assert.ok(e.event_id && e.event_type && e.kind !== undefined);
      assert.ok(!("receipt" in e), "事件流不得携带回执等生活细节");
    }
  });
});
