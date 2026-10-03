import assert from "node:assert/strict";
import test from "node:test";

import { addRoom, createResidence, grantConsent } from "../src/domain.js";
import { ConflictError } from "../src/errors.js";
import { Store } from "../src/store.js";
import { buildHousehold, T0 } from "./helpers.js";

test("聚合乐观并发：过期版本号的更新被拒绝，不会互相覆盖", () => {
  const store = new Store();
  const res = createResidence(store, { name: "并发测试房" });
  addRoom(store, res.id, { name: "客厅" }, 1);
  // 版本已变为 2，再用旧版本 1 更新 → 冲突
  assert.throws(() => addRoom(store, res.id, { name: "卧室" }, 1), ConflictError);
  // 携带正确版本号成功
  addRoom(store, res.id, { name: "卧室" }, 2);
  assert.equal(store.getAggregate(res.id).state.rooms.length, 2);
});

test("成员聚合的并发同意操作不会互相覆盖", () => {
  const h = buildHousehold();
  const { owner } = h.members;
  const version = h.store.getAggregate(owner.id).version;
  grantConsent(h.store, owner.id, {
    grantor_id: owner.id,
    capability: "location.report",
    now: T0,
    expected_version: version,
  });
  // 另一个并发请求携带相同的旧版本号 → 冲突，而不是覆盖
  assert.throws(
    () =>
      grantConsent(h.store, owner.id, {
        grantor_id: owner.id,
        capability: "camera.capture",
        now: T0,
        expected_version: version,
      }),
    ConflictError,
  );
  // 读取最新版本后重试成功
  const current = h.store.getAggregate(owner.id).version;
  grantConsent(h.store, owner.id, {
    grantor_id: owner.id,
    capability: "camera.capture",
    now: T0,
    expected_version: current,
  });
  assert.equal(h.store.getAggregate(owner.id).state.consents.length, 2);
});
