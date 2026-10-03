import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWindow, windowContains, windowsOverlap } from "../src/windows.js";

test("普通时段与全天时段", () => {
  const window = normalizeWindow({ start: "08:00", end: "22:00" });
  assert.equal(windowContains(window, "2026-10-03T08:00:00+08:00"), true);
  assert.equal(windowContains(window, "2026-10-03T21:59:00+08:00"), true);
  assert.equal(windowContains(window, "2026-10-03T22:00:00+08:00"), false);
  assert.equal(windowContains(null, "2026-10-03T03:00:00+08:00"), true, "null 时段表示全天");
});

test("跨午夜时段", () => {
  const night = normalizeWindow({ start: "21:00", end: "07:00" });
  assert.equal(windowContains(night, "2026-10-03T21:30:00+08:00"), true);
  assert.equal(windowContains(night, "2026-10-04T02:00:00+08:00"), true);
  assert.equal(windowContains(night, "2026-10-04T06:59:00+08:00"), true);
  assert.equal(windowContains(night, "2026-10-04T07:00:00+08:00"), false);
  assert.equal(windowContains(night, "2026-10-04T12:00:00+08:00"), false);
});

test("按星期限定的时段", () => {
  const weekday = new Date(Date.UTC(2026, 9, 5)).getUTCDay(); // 2026-10-05
  const window = normalizeWindow({ start: "09:00", end: "18:00", days: [weekday] });
  assert.equal(windowContains(window, "2026-10-05T10:00:00+08:00"), true);
  assert.equal(windowContains(window, "2026-10-06T10:00:00+08:00"), false);
});

test("时段重叠判断", () => {
  const night = { start: "21:00", end: "07:00" };
  assert.equal(windowsOverlap(night, { start: "02:00", end: "03:00" }), true);
  assert.equal(windowsOverlap(night, { start: "08:00", end: "09:00" }), false);
  assert.equal(windowsOverlap(null, { start: "08:00", end: "09:00" }), true, "全天与任何时段重叠");
  assert.equal(
    windowsOverlap({ start: "23:00", end: "01:00", days: [5] }, { start: "00:30", end: "02:00", days: [6] }),
    true,
    "跨午夜延伸到次日，应与次日凌晨时段重叠",
  );
});

test("非法时段被拒绝", () => {
  assert.throws(() => normalizeWindow({ start: "25:00", end: "26:00" }), /HH:MM/);
  assert.throws(() => normalizeWindow({ start: "08:00", end: "08:00" }), /起止时间/);
});
