import { readFileSync } from "node:fs";

const schema = JSON.parse(readFileSync(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
const properties = schema.properties ?? {};

// 依据 contracts/domain.schema.json 校验事件信封，返回中文错误列表（空数组表示通过）。
// 校验规则直接读取契约文件，保证代码与契约始终一致。
export function validateEvent(record) {
  if (record == null || typeof record !== "object" || Array.isArray(record)) return ["事件必须是对象"];
  const errors = [];
  for (const name of schema.required ?? []) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  for (const [name, spec] of Object.entries(properties)) {
    if (!(name in record)) continue;
    const value = record[name];
    if (spec.type === "string" && typeof value !== "string") {
      errors.push(`${name} 必须是字符串`);
      continue;
    }
    if (spec.type === "integer" && !Number.isInteger(value)) {
      errors.push(`${name} 必须是整数`);
      continue;
    }
    if (spec.enum && !spec.enum.includes(value)) errors.push(`${name} 必须是：${spec.enum.join("、")}`);
    if (spec.minLength != null && typeof value === "string" && value.length < spec.minLength) errors.push(`${name} 不能为空`);
    if (spec.minimum != null && typeof value === "number" && value < spec.minimum) errors.push(`${name} 不能小于 ${spec.minimum}`);
  }
  if ("occurred_at" in record && typeof record.occurred_at === "string" && Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 必须是合法的日期时间");
  }
  return errors;
}
