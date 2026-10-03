import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("样例符合领域约定", async () => {
  const sample = await readJson("../data/sample.json");
  assert.deepEqual(validateEvent(sample), []);
});

test("设备遥测样例符合领域约定", async () => {
  const telemetry = await readJson("../data/telemetry.sample.json");
  assert.deepEqual(validateEvent(telemetry), []);
});

test("校验器拒绝非法枚举与缺失字段", () => {
  assert.ok(validateEvent({}).length >= 7, "空对象应报告全部必填字段");
  const bad = {
    event_id: "e1",
    event_type: "SOMETHING_ELSE",
    aggregate_type: "automation_rule",
    aggregate_id: "r1",
    occurred_at: "2026-10-03T00:00:00+08:00",
    version: 1,
    summary: "非法事件类型",
  };
  assert.ok(validateEvent(bad).some((message) => message.includes("event_type")));
  const badVersion = { ...bad, event_type: "RULE_PUBLISHED", version: 0 };
  assert.ok(validateEvent(badVersion).some((message) => message.includes("version")));
  const badTime = { ...bad, event_type: "RULE_PUBLISHED", occurred_at: "不是时间" };
  assert.ok(validateEvent(badTime).some((message) => message.includes("occurred_at")));
});

test("契约枚举包含运行所需的全部事件类型与聚合类型", async () => {
  const schema = await readJson("../contracts/domain.schema.json");
  for (const eventType of [
    "MEMBERSHIP_CHANGED",
    "RULE_PUBLISHED",
    "CONFLICT_DETECTED",
    "ACTION_EXECUTED",
    "CONTROL_TRANSFERRED",
    "TELEMETRY_REPORTED",
  ]) {
    assert.ok(schema.properties.event_type.enum.includes(eventType), `缺少事件类型 ${eventType}`);
  }
  for (const aggregateType of [
    "residence_membership",
    "device_capability",
    "automation_rule",
    "execution_receipt",
    "control_transfer",
  ]) {
    assert.ok(schema.properties.aggregate_type.enum.includes(aggregateType), `缺少聚合类型 ${aggregateType}`);
  }
});
