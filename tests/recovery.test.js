import assert from "node:assert/strict";
import test from "node:test";

import { ingestTelemetry, setConnectivity } from "../src/arbitration.js";
import { buildHousehold, outcomeFor, telemetryEvent } from "./helpers.js";

const leakAt = (h, state, at, eventId) =>
  ingestTelemetry(h.store, telemetryEvent(h.devices.leakSensor.id, "sensor.leak", state, at, eventId));

test("设备离线时动作排队并设有效期，不直接补执行", () => {
  const h = buildHousehold();
  setConnectivity(h.store, h.devices.mainValve.id, "offline", "2026-10-04T02:55:00+08:00");
  const { decision } = leakAt(h, "detected", "2026-10-04T03:00:00+08:00");
  const valve = outcomeFor(decision, h.devices.mainValve.id);
  assert.equal(valve.status, "queued");
  // 排队回执带有有效期（安全规则 ttl=120 秒）
  const receipt = h.store.getAggregate(valve.receipt_id);
  assert.ok(receipt.state.valid_until, "排队回执必须有有效期");
  // 厨房插座在线，正常执行
  assert.equal(outcomeFor(decision, h.devices.kitchenPlug.id).status, "executed");
  // 阀门状态未被直接改写
  assert.notEqual(h.store.getAggregate(h.devices.mainValve.id).state.state["valve.actuate"], "close");
});

test("离线恢复：条件仍有效且未过期 → 重新判断后执行", () => {
  const h = buildHousehold();
  setConnectivity(h.store, h.devices.mainValve.id, "offline", "2026-10-04T02:55:00+08:00");
  leakAt(h, "detected", "2026-10-04T03:00:00+08:00");
  // 60 秒后恢复，漏水仍未解除 → 执行
  const { results } = setConnectivity(h.store, h.devices.mainValve.id, "online", "2026-10-04T03:01:00+08:00");
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "executed");
  assert.equal(h.store.getAggregate(h.devices.mainValve.id).state.state["valve.actuate"], "close");
  const recovered = h.store.events.filter((event) => event.event_type === "ACTION_EXECUTED" && event.detail?.recovered);
  assert.equal(recovered.length, 1);
});

test("离线恢复：触发条件已消失 → 过期，不补执行", () => {
  const h = buildHousehold();
  setConnectivity(h.store, h.devices.mainValve.id, "offline", "2026-10-04T02:55:00+08:00");
  leakAt(h, "detected", "2026-10-04T03:00:00+08:00");
  // 离线期间漏水解除
  leakAt(h, "clear", "2026-10-04T03:00:30+08:00");
  const { results } = setConnectivity(h.store, h.devices.mainValve.id, "online", "2026-10-04T03:01:00+08:00");
  assert.equal(results[0].status, "expired");
  assert.match(results[0].reason, /触发条件已消失/);
  assert.notEqual(h.store.getAggregate(h.devices.mainValve.id).state.state["valve.actuate"], "close");
});

test("离线恢复：超过有效期 → 过期，不补执行", () => {
  const h = buildHousehold();
  setConnectivity(h.store, h.devices.mainValve.id, "offline", "2026-10-04T02:55:00+08:00");
  leakAt(h, "detected", "2026-10-04T03:00:00+08:00");
  // 10 分钟后才恢复，已超过 120 秒有效期
  const { results } = setConnectivity(h.store, h.devices.mainValve.id, "online", "2026-10-04T03:10:00+08:00");
  assert.equal(results[0].status, "expired");
  assert.match(results[0].reason, /超过有效期/);
  assert.notEqual(h.store.getAggregate(h.devices.mainValve.id).state.state["valve.actuate"], "close");
});

test("事件摄取幂等：断网重传不会重复触发", () => {
  const h = buildHousehold();
  const envelope = telemetryEvent(h.devices.leakSensor.id, "sensor.leak", "detected", "2026-10-04T03:00:00+08:00", "evt-dup-1");
  const first = ingestTelemetry(h.store, envelope);
  assert.equal(first.duplicate, false);
  const before = h.store.aggregatesOfType("execution_receipt").length;
  const second = ingestTelemetry(h.store, envelope);
  assert.equal(second.duplicate, true);
  assert.equal(second.decision, null);
  assert.equal(h.store.aggregatesOfType("execution_receipt").length, before, "重复事件不应产生新回执");
});
