import { randomUUID } from "node:crypto";

import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { validateEvent } from "./validator.js";

export const newId = (prefix) => `${prefix}_${randomUUID()}`;

// 内存事件溯源存储：聚合带版本号，所有变更通过乐观并发控制提交，
// 领域事件符合 contracts/domain.schema.json。
export class Store {
  constructor() {
    this.aggregates = new Map(); // id -> { id, type, version, state }
    this.events = []; // 符合契约的领域事件（含摄取的外部事件）
    this.eventIds = new Set(); // 摄取幂等索引
    this.decisions = new Map(); // decision_id -> 裁决记录（供居民查看解释）
    this.dataPackages = []; // 交接产生的数据包记录
  }

  createAggregate(type, id, state) {
    if (this.aggregates.has(id)) throw new ConflictError(`聚合已存在：${id}`);
    const aggregate = { id, type, version: 1, state };
    this.aggregates.set(id, aggregate);
    return aggregate;
  }

  getAggregate(id) {
    const aggregate = this.aggregates.get(id);
    if (!aggregate) throw new NotFoundError(`聚合不存在：${id}`);
    return aggregate;
  }

  findAggregate(id) {
    return this.aggregates.get(id) ?? null;
  }

  aggregatesOfType(type) {
    return [...this.aggregates.values()].filter((aggregate) => aggregate.type === type);
  }

  // 乐观并发控制：调用方提供期望版本，不一致即拒绝，
  // 并发更新不会互相覆盖（区别于厂商云端的"最后一次写入获胜"）。
  mutateAggregate(id, expectedVersion, mutate) {
    const aggregate = this.getAggregate(id);
    if (expectedVersion != null && expectedVersion !== aggregate.version) {
      throw new ConflictError(`版本冲突：期望 ${expectedVersion}，当前 ${aggregate.version}`);
    }
    const draft = structuredClone(aggregate.state);
    mutate(draft);
    aggregate.state = draft;
    aggregate.version += 1;
    return aggregate;
  }

  // 追加领域事件，写入前按契约自检。
  appendEvent({ event_type, aggregate_type, aggregate_id, occurred_at, version, summary, detail }) {
    const event = { event_id: newId("evt"), event_type, aggregate_type, aggregate_id, occurred_at, version, summary };
    if (detail !== undefined) event.detail = detail;
    const errors = validateEvent(event);
    if (errors.length > 0) throw new ValidationError(errors);
    this.events.push(event);
    this.eventIds.add(event.event_id);
    return event;
  }

  // 摄取外部事件（如设备上报）：先按契约校验，再按 event_id 幂等，断网重传不会重复触发。
  ingestEvent(envelope) {
    const errors = validateEvent(envelope);
    if (errors.length > 0) throw new ValidationError(errors);
    if (this.eventIds.has(envelope.event_id)) return { event: null, duplicate: true };
    this.eventIds.add(envelope.event_id);
    this.events.push(envelope);
    return { event: envelope, duplicate: false };
  }
}
