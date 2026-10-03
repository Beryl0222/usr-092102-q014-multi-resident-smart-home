/**
 * 领域事件信封校验。
 * 与 contracts/domain.schema.json 保持同步：必填字段、枚举、版本与时间格式。
 * 返回错误字符串数组；[] 表示通过。
 */

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

const EVENT_TYPES = new Set([
  "MEMBERSHIP_CHANGED",
  "RULE_PUBLISHED",
  "CONFLICT_DETECTED",
  "ACTION_EXECUTED",
  "CONTROL_TRANSFERRED",
  "DEVICE_OBSERVED",
]);

const AGGREGATE_TYPES = new Set([
  "residence_membership",
  "device_capability",
  "automation_rule",
  "execution_receipt",
]);

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function validateEvent(record) {
  const errors = [];
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return ["事件必须是对象"];
  }
  for (const name of required) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  if ("event_id" in record && (typeof record.event_id !== "string" || record.event_id.length === 0)) {
    errors.push("event_id 必须是非空字符串");
  }
  if ("event_type" in record && !EVENT_TYPES.has(record.event_type)) {
    errors.push(`event_type 不在登记枚举内：${record.event_type}`);
  }
  if ("aggregate_type" in record && !AGGREGATE_TYPES.has(record.aggregate_type)) {
    errors.push(`aggregate_type 不在登记枚举内：${record.aggregate_type}`);
  }
  if ("aggregate_id" in record && (typeof record.aggregate_id !== "string" || record.aggregate_id.length === 0)) {
    errors.push("aggregate_id 必须是非空字符串");
  }
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("occurred_at" in record && (typeof record.occurred_at !== "string" || !ISO_DATE_TIME.test(record.occurred_at))) {
    errors.push("occurred_at 必须是 RFC3339 日期时间字符串");
  }
  if ("summary" in record && (typeof record.summary !== "string" || record.summary.length === 0)) {
    errors.push("summary 必须是非空字符串");
  }
  return errors;
}

export { EVENT_TYPES, AGGREGATE_TYPES };
