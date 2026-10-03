/**
 * 存储层：内存聚合 + append-only 事件流，可选 JSON 文件持久化。
 *
 * 并发安全：
 * 1. 每个聚合键有串行提交队列，同一聚合的提交不会交错；
 * 2. 所有写命令携带 expectedVersion（乐观锁/CAS），版本不符抛 ConflictError，
 *    绝不会"最后一次设置覆盖"——调用方必须重读后重试或放弃；
 * 3. 外部设备事件按 (aggregate_id, version) 单调约束，event_id 幂等去重。
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { newId } from "./time.js";

export class ConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ConflictError";
    this.code = "VERSION_CONFLICT";
    this.details = details;
  }
}

export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

const EMPTY = () => ({ version: 0, data: null });

export class Store {
  constructor({ persistPath = null, clock = () => new Date() } = {}) {
    this.persistPath = persistPath;
    this.clock = clock;
    /** aggregate 数据：Map(aggregateType -> Map(id -> {version, data})) */
    this.aggregates = new Map();
    /** append-only 领域事件（含外部设备观测的存档） */
    this.events = [];
    /** 已见 event_id（幂等） */
    this.eventIds = new Set();
    /** 外部设备观测流的版本游标：aggregate_id -> 最后 version（不与内部事件混算） */
    this.deviceHeads = new Map();
    /** 每聚合键的串行队列 */
    this._locks = new Map();
    this._seq = 0;
  }

  static async create(opts = {}) {
    const store = new Store(opts);
    if (opts.persistPath) {
      try {
        const raw = JSON.parse(await readFile(opts.persistPath, "utf8"));
        for (const [t, m] of Object.entries(raw.aggregates || {})) {
          store.aggregates.set(t, new Map(Object.entries(m)));
        }
        store.events = raw.events || [];
        store.eventIds = new Set(store.events.map((e) => e.event_id));
        store._seq = raw.seq || store.events.length;
        if (raw.deviceHeads) {
          store.deviceHeads = new Map(Object.entries(raw.deviceHeads).map(([k, v]) => [k, Number(v)]));
        } else {
          // 仅从外部观测事件恢复设备流游标
          for (const e of store.events) {
            if (e.event_type === "DEVICE_OBSERVED") {
              const head = store.deviceHeads.get(e.aggregate_id) || 0;
              if (e.version > head) store.deviceHeads.set(e.aggregate_id, e.version);
            }
          }
        }
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
    return store;
  }

  /** 枚举聚合类型 */
  static get TYPES() {
    return [
      "residence",
      "room",
      "device_capability",
      "person",
      "residence_membership",
      "consent",
      "automation_rule",
      "manual_override",
      "execution_receipt",
      "control_transfer",
      "pending_action",
    ];
  }

  _bucket(type) {
    let b = this.aggregates.get(type);
    if (!b) {
      b = new Map();
      this.aggregates.set(type, b);
    }
    return b;
  }

  get(type, id) {
    const rec = this.aggregates.get(type)?.get(id);
    return rec ? { ...rec.data, version: rec.version } : null;
  }

  list(type, predicate = null) {
    const b = this.aggregates.get(type);
    if (!b) return [];
    const rows = [...b.values()].map((r) => ({ ...r.data, version: r.version }));
    return predicate ? rows.filter(predicate) : rows;
  }

  eventsFor(aggregateId) {
    return this.events.filter((e) => e.aggregate_id === aggregateId);
  }

  /** 同一聚合键串行化 */
  _withKeyLock(key, fn) {
    const prev = this._locks.get(key) || Promise.resolve();
    const run = prev.then(fn, fn); // 即使前者失败也不阻塞后续
    const tail = run.catch(() => {});
    this._locks.set(key, tail);
    return run;
  }

  /** 对外的串行化原语：裁决按住房键串行，避免两次事件裁决交错写入 */
  withLock(key, fn) {
    return this._withKeyLock(key, fn);
  }

  /**
   * 以 CAS 方式提交一次聚合变更并追加事件。
   *
   * opts:
   *   aggregateType, aggregateId, eventType, summary, detail
   *   expectedVersion: 客户端持有的版本；提供时必须与当前版本一致
   *   create: true 仅允许新建（当前必须 version=0）
   *   mutate(data|null): 返回新数据（不可变风格），返回 undefined 表示中止
   */
  commit(opts) {
    const key = `${opts.aggregateType}:${opts.aggregateId}`;
    return this._withKeyLock(key, () => this._commitLocked(opts));
  }

  async _commitLocked({
    aggregateType,
    aggregateId,
    eventType,
    summary,
    detail = {},
    expectedVersion,
    create = false,
    mutate,
  }) {
    const bucket = this._bucket(aggregateType);
    const current = bucket.get(aggregateId) || EMPTY();

    if (create && current.version !== 0) {
      throw new ConflictError("聚合已存在，禁止重复创建", {
        aggregateType,
        aggregateId,
        currentVersion: current.version,
      });
    }
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new ConflictError("聚合版本已变化，并发更新被拒绝", {
        aggregateType,
        aggregateId,
        expectedVersion,
        currentVersion: current.version,
      });
    }

    const nextData = await mutate(current.data ? { ...current.data } : null);
    if (nextData === undefined) return null;

    const nextVersion = current.version + 1;
    bucket.set(aggregateId, { version: nextVersion, data: nextData });

    const event = {
      event_id: newId("evt"),
      event_type: eventType,
      aggregate_type: mapAggregateType(aggregateType),
      aggregate_id: aggregateId,
      occurred_at: this.clock().toISOString(),
      version: nextVersion,
      summary,
      detail,
    };
    this.events.push(event);
    this.eventIds.add(event.event_id);
    this._seq += 1;
    await this._persist();
    return { data: { ...nextData, version: nextVersion }, event };
  }

  /**
   * 接收外部（设备/网关）事件。信封必须符合 domain.schema.json。
   * 对同一 aggregate_id：
   *  - event_id 相同 → 幂等返回已存事件；
   *  - version 必须严格大于最后版本（防止乱序/重放覆盖）；
   * 设备事件不直接改聚合数据，由裁决引擎消费。
   */
  ingestDeviceEvent(record) {
    const key = `ingest:${record.aggregate_id}`;
    return this._withKeyLock(key, () => this._ingestLocked(record));
  }

  async _ingestLocked(record) {
    if (this.eventIds.has(record.event_id)) {
      return this.events.find((e) => e.event_id === record.event_id);
    }
    const head = this.deviceHeads.get(record.aggregate_id) || 0;
    if (record.version <= head) {
      throw new ConflictError("设备事件版本落后或重复，拒绝覆盖", {
        aggregate_id: record.aggregate_id,
        incoming: record.version,
        last: head,
      });
    }
    const stored = { ...record, ingested_at: this.clock().toISOString() };
    this.events.push(stored);
    this.eventIds.add(stored.event_id);
    this.deviceHeads.set(record.aggregate_id, record.version);
    this._seq += 1;
    await this._persist();
    return stored;
  }

  /**
   * 追加一条系统内部生成的领域事件（不改变聚合版本游标）。
   * 用于冲突事件等"独立事件流"对象。
   */
  async appendDomainEvent(event) {
    const stored = { ...event, ingested_at: this.clock().toISOString() };
    if (stored.event_id && this.eventIds.has(stored.event_id)) return stored;
    this.events.push(stored);
    if (stored.event_id) this.eventIds.add(stored.event_id);
    this._seq += 1;
    await this._persist();
    return stored;
  }

  /**
   * 物理删除一个聚合记录（数据交接/被遗忘权）。
   * 注意：这是对 append-only 事件流中生活数据的刻意例外——调用方必须先完成导出，
   * 并通过 redactLifeEvents 把历史事件 detail 改为脱敏墓碑。
   */
  async purgeAggregate(type, id) {
    const bucket = this.aggregates.get(type);
    if (bucket?.delete(id)) await this._persist();
  }

  /**
   * 将匹配事件的生活数据 detail 改为脱敏墓碑（保留信封用于审计存在性，
   * 但不保留可还原生活轨迹的内容）。matcher(event) 返回 true 即脱敏。
   * 返回脱敏条数。
   */
  async redactLifeEvents(matcher, reason, at = this.clock().toISOString()) {
    let n = 0;
    for (const e of this.events) {
      if (e.detail?.redacted) continue;
      if (matcher(e)) {
        e.detail = { redacted: true, redactedAt: at, reason };
        e.summary = "该事件的生活数据已按交接策略清除";
        n += 1;
      }
    }
    if (n > 0) await this._persist();
    return n;
  }

  async _persist() {
    if (!this.persistPath) return;
    const payload = {
      seq: this._seq,
      persisted_at: this.clock().toISOString(),
      deviceHeads: Object.fromEntries(this.deviceHeads),
      aggregates: Object.fromEntries(
        [...this.aggregates.entries()].map(([t, m]) => [t, Object.fromEntries(m)]),
      ),
      events: this.events,
    };
    const tmp = `${this.persistPath}.tmp`;
    await mkdir(dirname(this.persistPath), { recursive: true });
    await writeFile(tmp, JSON.stringify(payload), "utf8");
    await rename(tmp, this.persistPath);
  }
}

/** 内部聚合类型 → schema 中对外稳定的 aggregate_type */
function mapAggregateType(internal) {
  const map = {
    residence: "residence_membership",
    room: "residence_membership",
    person: "residence_membership",
    residence_membership: "residence_membership",
    device_capability: "device_capability",
    consent: "residence_membership",
    automation_rule: "automation_rule",
    manual_override: "automation_rule",
    execution_receipt: "execution_receipt",
    pending_action: "execution_receipt",
    control_transfer: "residence_membership",
  };
  return map[internal] || "execution_receipt";
}
