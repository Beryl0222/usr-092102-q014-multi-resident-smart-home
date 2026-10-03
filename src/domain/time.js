/**
 * 时间与时段工具。
 * 所有裁决都通过 clock() 取当前时间，便于在测试中模拟凌晨、离线恢复等场景。
 */

/** 默认时钟：真实当前时间 */
export function systemClock() {
  return new Date();
}

export function toDate(t) {
  return t instanceof Date ? t : new Date(t);
}

/**
 * 解析 "HH:MM" 为当日分钟数。
 */
function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function tzMinutes(date, tz) {
  // 用 Intl 取指定时区下的当日分钟与星期
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hour = Number(get("hour") === "24" ? "00" : get("hour"));
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { minutes: hour * 60 + Number(get("minute")), dow: dowMap[get("weekday")] };
}

/**
 * 判断时间是否落在调度窗口内。
 *
 * schedule:
 *   { kind: "always" }
 *   { kind: "time_window", start: "22:00", end: "06:00",
 *     weekdays?: [0..6]（省略=每天）, timezone?: "Asia/Shanghai" }
 *     start>end 表示跨午夜窗口。
 *   { kind: "custom", windows: [ {start,end,weekdays?,timezone?} ], not_before?, not_after? }
 *
 * 额外的绝对有效期 not_before / not_after（ISO 字符串）对任意 kind 都适用。
 */
export function scheduleActiveAt(schedule, at = new Date()) {
  if (!schedule || schedule.kind === "always") {
    return absoluteRangeValid(schedule, at);
  }
  if (!absoluteRangeValid(schedule, at)) return false;

  if (schedule.kind === "time_window") {
    return windowActive(schedule, at);
  }
  if (schedule.kind === "custom") {
    return (schedule.windows ?? []).some((w) => windowActive(w, at));
  }
  return false;
}

function absoluteRangeValid(schedule, at) {
  const d = toDate(at);
  if (schedule?.not_before && d < toDate(schedule.not_before)) return false;
  if (schedule?.not_after && d > toDate(schedule.not_after)) return false;
  return true;
}

function windowActive(w, at) {
  const tz = w.timezone || scheduleTimezone(w);
  const { minutes, dow } = tzMinutes(toDate(at), tz);
  if (w.weekdays && !w.weekdays.includes(dow)) return false;
  const start = hhmmToMinutes(w.start);
  const end = hhmmToMinutes(w.end);
  if (start === end) return true; // 00:00-00:00 视为全天
  if (start < end) return minutes >= start && minutes < end;
  // 跨午夜：22:00-06:00
  return minutes >= start || minutes < end;
}

function scheduleTimezone() {
  return process.env.TZ || "Asia/Shanghai";
}

/**
 * 判断某一时刻是否处于"夜间"（用于老人夜间照明等默认保护逻辑）。
 */
export function isNight(at = new Date(), tz = process.env.TZ || "Asia/Shanghai") {
  const { minutes } = tzMinutes(toDate(at), tz);
  return minutes >= 22 * 60 || minutes < 6 * 60;
}

/** 生成带前缀的 ULID 风格 ID（时间有序，足够本地唯一） */
export function newId(prefix = "id") {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${ts}${rand}`;
}
