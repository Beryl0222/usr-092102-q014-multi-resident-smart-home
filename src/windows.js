import { ValidationError } from "./errors.js";

// 时段工具：规则适用时段、同意范围与隐私时段共用 "HH:MM" 每日重复时段，支持跨午夜。
// 时段按住房当地的墙钟时间解释（直接取 ISO 字符串中的时间部分，不做时区换算）。

const MINUTES_PER_DAY = 24 * 60;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]; // 周日起

export function parseHHMM(text, field = "time") {
  if (typeof text !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) {
    throw new ValidationError([`${field} 必须是 HH:MM 格式`]);
  }
  const [hours, minutes] = text.split(":").map(Number);
  return hours * 60 + minutes;
}

// 归一化每日重复时段；window 为 null 表示全天适用。start 与 end 相同视为非法。
export function normalizeWindow(window, field = "window") {
  if (window == null) return null;
  const { start, end, days = ALL_DAYS } = window;
  const startMinutes = parseHHMM(start, `${field}.start`);
  const endMinutes = parseHHMM(end, `${field}.end`);
  if (startMinutes === endMinutes) throw new ValidationError([`${field} 的起止时间不能相同`]);
  if (!Array.isArray(days) || days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new ValidationError([`${field}.days 必须是 0-6 的星期数组`]);
  }
  return { start, end, days: [...new Set(days)].sort((a, b) => a - b) };
}

// 从 ISO 字符串取本地墙钟分钟与星期（按字符串中的日期部分计算）。
export function localParts(isoNow) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(isoNow);
  if (!match) throw new ValidationError([`时间必须是 ISO 格式：${isoNow}`]);
  const [, year, month, day, hours, minutes] = match.map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { minutes: hours * 60 + minutes, weekday };
}

export function windowContains(window, isoNow) {
  if (!window) return true;
  const { minutes, weekday } = localParts(isoNow);
  const start = parseHHMM(window.start);
  const end = parseHHMM(window.end);
  const days = window.days ?? ALL_DAYS;
  if (start < end) return days.includes(weekday) && minutes >= start && minutes < end;
  // 跨午夜：当日 start 之后，或前一日时段延续到当日 end 之前
  if (days.includes(weekday) && minutes >= start) return true;
  return days.includes((weekday + 6) % 7) && minutes < end;
}

function toWeeklyIntervals(window) {
  if (!window) return [[0, 7 * MINUTES_PER_DAY]];
  const start = parseHHMM(window.start);
  const end = parseHHMM(window.end);
  const days = window.days ?? ALL_DAYS;
  const intervals = [];
  for (const day of days) {
    const base = day * MINUTES_PER_DAY;
    if (start < end) {
      intervals.push([base + start, base + end]);
    } else {
      intervals.push([base + start, base + MINUTES_PER_DAY]);
      const nextDay = ((day + 1) % 7) * MINUTES_PER_DAY;
      intervals.push([nextDay, nextDay + end]);
    }
  }
  return intervals;
}

export function windowsOverlap(a, b) {
  const intervalsA = toWeeklyIntervals(a);
  const intervalsB = toWeeklyIntervals(b);
  return intervalsA.some(([s1, e1]) => intervalsB.some(([s2, e2]) => s1 < e2 && s2 < e1));
}
