import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";

import { Store, ConflictError } from "../src/domain/store.js";
import { EVENT_TYPE } from "../src/domain/constants.js";

test("乐观锁：并发提交同一聚合，只有一个成功，不发生覆盖", async () => {
  const store = new Store();
  await store.commit({
    aggregateType: "person",
    aggregateId: "p1",
    create: true,
    eventType: EVENT_TYPE.MEMBERSHIP_CHANGED,
    summary: "建",
    detail: {},
    mutate: () => ({ id: "p1", v: 0 }),
  });
  const v = store.get("person", "p1").version;

  const attempt = (patch) =>
    store.commit({
      aggregateType: "person",
      aggregateId: "p1",
      expectedVersion: v,
      eventType: EVENT_TYPE.MEMBERSHIP_CHANGED,
      summary: "并发改",
      detail: {},
      mutate: (x) => ({ ...x, ...patch }),
    });
  const results = await Promise.allSettled([attempt({ a: 1 }), attempt({ a: 2 }), attempt({ a: 3 })]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.ok(rejected.every((r) => r.reason instanceof ConflictError));
  // 最终值只来自获胜者，绝不混合
  assert.equal(store.get("person", "p1").version, v + 1);
  assert.equal(store.get("person", "p1").a, fulfilled[0].value.data.a);
});

test("冲突后重读重试可成功（CAS 重试模式）", async () => {
  const store = new Store();
  await store.commit({
    aggregateType: "person",
    aggregateId: "p1",
    create: true,
    eventType: EVENT_TYPE.MEMBERSHIP_CHANGED,
    summary: "建",
    detail: {},
    mutate: () => ({ id: "p1", count: 0 }),
  });

  async function increment(maxTries = 5) {
    for (let i = 0; i < maxTries; i += 1) {
      const cur = store.get("person", "p1");
      try {
        return await store.commit({
          aggregateType: "person",
          aggregateId: "p1",
          expectedVersion: cur.version,
          eventType: EVENT_TYPE.MEMBERSHIP_CHANGED,
          summary: "自增",
          detail: {},
          mutate: (x) => ({ ...x, count: x.count + 1 }),
        });
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
      }
    }
    throw new Error("重试耗尽");
  }
  await Promise.all([increment(), increment(), increment(), increment()]);
  assert.equal(store.get("person", "p1").count, 4);
});

test("设备观测事件版本必须单调，乱序/重放被拒绝", async () => {
  const store = new Store();
  const mk = (version) => ({
    event_id: `dev1-${version}`,
    event_type: "DEVICE_OBSERVED",
    aggregate_type: "device_capability",
    aggregate_id: "dev1",
    occurred_at: new Date().toISOString(),
    version,
    summary: "x",
  });
  await store.ingestDeviceEvent(mk(1));
  // 相同 event_id 幂等返回
  const dup = await store.ingestDeviceEvent({ ...mk(1) });
  assert.equal(dup.version, 1);
  // 不同 event_id 但回退版本 → 拒绝
  await assert.rejects(() => store.ingestDeviceEvent({ ...mk(0), event_id: "dev1-0" }), /版本/);
});

test("持久化：落盘后可重建全部状态", async () => {
  const path = `/tmp/arb-test-${process.pid}-${Date.now()}.json`;
  try {
    const s1 = await Store.create({ persistPath: path });
    await s1.commit({
      aggregateType: "person",
      aggregateId: "p1",
      create: true,
      eventType: EVENT_TYPE.MEMBERSHIP_CHANGED,
      summary: "建",
      detail: {},
      mutate: () => ({ id: "p1", name: "甲" }),
    });
    await s1.ingestDeviceEvent({
      event_id: "d-1",
      event_type: "DEVICE_OBSERVED",
      aggregate_type: "device_capability",
      aggregate_id: "d",
      occurred_at: new Date().toISOString(),
      version: 7,
      summary: "x",
    });

    const s2 = await Store.create({ persistPath: path });
    assert.equal(s2.get("person", "p1").name, "甲");
    // 设备流游标恢复：再写 version=8 可以，version=7 拒绝
    await s2.ingestDeviceEvent({
      event_id: "d-2",
      event_type: "DEVICE_OBSERVED",
      aggregate_type: "device_capability",
      aggregate_id: "d",
      occurred_at: new Date().toISOString(),
      version: 8,
      summary: "x",
    });
    await assert.rejects(
      () =>
        s2.ingestDeviceEvent({
          event_id: "d-old",
          event_type: "DEVICE_OBSERVED",
          aggregate_type: "device_capability",
          aggregate_id: "d",
          occurred_at: new Date().toISOString(),
          version: 7,
          summary: "x",
        }),
      /版本/,
    );
  } finally {
    await rm(path, { force: true });
  }
});
