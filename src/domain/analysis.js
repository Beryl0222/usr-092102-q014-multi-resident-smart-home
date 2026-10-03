/**
 * 发布前静态分析：
 *  1) 循环检测 —— 触发器(能力,状态) → 动作(能力,状态) 的有向图上的环；
 *  2) 互斥动作 —— 同一设备在可重叠条件下被要求进入两个不同状态，
 *     且优先级无法确定性分层时拒绝发布。
 *
 * 分析是保守的：无法证明条件互斥时按"可能同时成立"处理，避免漏报。
 */
import { BASIS_TIER } from "./constants.js";

/** 规则动作的目标设备选择器解析为具体设备（规则发布即绑定设备，保证静态分析精确） */
export function actionDeviceId(action) {
  return action.deviceId || action.deviceSelector?.deviceId || null;
}

/** 动作会把某能力置成的状态 */
export function actionEffect(rule, action) {
  return { capability: action.capability || null, state: action.setState };
}

/** 触发器是否会被"某能力进入某状态"命中 */
function triggerMatches(trigger, capability, state) {
  if (!trigger || trigger.capability !== capability) return false;
  if (!trigger.states || trigger.states.length === 0) return true;
  return trigger.states.includes(state);
}

/**
 * 构造规则间触发图：
 * 边 r1 -> r2 当且仅当 r1 的某个动作把能力 C 置为状态 v，
 * 而 r2 的触发器匹配 (C, v)，且两规则的空间范围可重叠。
 */
export function buildTriggerGraph(rules) {
  const edges = new Map(); // ruleId -> Set(ruleId)
  const add = (from, to) => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  };

  for (const r1 of rules) {
    for (const action of r1.actions || []) {
      const { capability, state } = actionEffect(r1, action);
      if (!capability || state === undefined) continue;
      for (const r2 of rules) {
        if (r2.status && r2.status !== "active") continue;
        if (!triggerMatches(r2.trigger, capability, state)) continue;
        if (!rangesMayOverlap(r1, r2)) continue;
        add(r1.id, r2.id);
      }
    }
  }
  return { edges };
}

/**
 * 找出图中所有环（Tarjan 强连通分量 + 对 SCC 内部给出路径）。
 * 自环（规则动作触发自己）同样报出。
 */
export function findCycles(rules) {
  const active = rules.filter((r) => !r.status || r.status === "active");
  const { edges } = buildTriggerGraph(active);
  const indexOf = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  let idx = 0;

  const strongConnect = (v) => {
    indexOf.set(v, idx);
    low.set(v, idx);
    idx += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) || []) {
      if (!indexOf.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), indexOf.get(w)));
      }
    }
    if (low.get(v) === indexOf.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1 || edges.get(v)?.has(v)) sccs.push(comp);
    }
  };

  for (const r of active) {
    if (!indexOf.has(r.id)) strongConnect(r.id);
  }

  // 为每个 SCC 还原一条具体环路径，便于发布者理解
  return sccs.map((memberIds) => {
    const path = [...memberIds];
    const first = path[0];
    // 追一条边回到起点形成闭环展示
    let cur = path[path.length - 1];
    const closing = [...(edges.get(cur) || [])].find((n) => n === first || memberIds.includes(n));
    if (closing) path.push(closing);
    return {
      ruleIds: memberIds,
      path: describeChain(active, path),
      message: `规则形成触发循环：${path.join(" → ")}（动作链会自我重新触发）`,
    };
  });
}

function describeChain(rules, ids) {
  const byId = new Map(rules.map((r) => [r.id, r]));
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) return id;
    const trig = r.trigger ? `${r.trigger.capability}${r.trigger.states ? `=${r.trigger.states.join("|")}` : ""}` : "∅";
    return `${r.name || r.id}[${trig}]`;
  });
}

/**
 * 互斥动作检测。
 * 对每一对生效规则（含规则自身内的动作对）：
 *  - 目标设备相同；
 *  - 目标状态不同（同一能力单时刻只能有一个状态）；
 *  - 触发条件与适用时段在静态上可能重叠；
 *  - 且优先级层级相同（不同层级由运行时确定性压制，不算互斥死锁）。
 * 满足以上即发布期互斥冲突。
 */
export function findMutexConflicts(rules) {
  const active = rules.filter((r) => !r.status || r.status === "active");
  const conflicts = [];

  const consider = (a, b, ruleA, ruleB) => {
    const devA = actionDeviceId(a);
    const devB = actionDeviceId(b);
    if (!devA || !devB || devA !== devB) return;
    const capA = a.capability || ruleA.trigger?.capability;
    const capB = b.capability || ruleB.trigger?.capability;
    if (capA !== capB) return;
    if (a.setState === b.setState) return;
    if (!schedulesMayOverlap(ruleA.schedule, ruleB.schedule)) return;
    if (!rangesMayOverlap(ruleA, ruleB)) return;
    if (!triggersMayCooccur(ruleA.trigger, ruleB.trigger)) return;

    const tierA = BASIS_TIER[ruleA.priorityBasis] ?? 0;
    const tierB = BASIS_TIER[ruleB.priorityBasis] ?? 0;
    if (tierA !== tierB) return; // 层级不同：运行时高层压制低层，确定且可解释

    conflicts.push({
      rules: [ruleA.id, ruleB.id],
      deviceId: devA,
      capability: capA,
      states: [a.setState, b.setState],
      priorityBasis: [ruleA.priorityBasis, ruleB.priorityBasis],
      message:
        `设备 ${devA} 的 ${capA} 被规则 ${ruleA.name || ruleA.id} 与 ${ruleB.name || ruleB.id} ` +
        `同时要求进入 ${a.setState}/${b.setState}，二者优先级层级相同且条件可重叠，无法确定性裁决`,
    });
  };

  for (let i = 0; i < active.length; i += 1) {
    const actsI = active[i].actions || [];
    // 规则内部互斥（含自身矛盾动作）
    for (let x = 0; x < actsI.length; x += 1) {
      for (let y = x + 1; y < actsI.length; y += 1) consider(actsI[x], actsI[y], active[i], active[i]);
    }
    for (let j = i + 1; j < active.length; j += 1) {
      for (const a of actsI) {
        for (const b of active[j].actions || []) consider(a, b, active[i], active[j]);
      }
    }
  }
  return conflicts;
}

/** 规则空间范围是否可能重叠（房间集合有交集或全屋） */
function rangesMayOverlap(r1, r2) {
  const rooms1 = ruleRoomIds(r1);
  const rooms2 = ruleRoomIds(r2);
  if (rooms1 === null || rooms2 === null) return true; // 全屋规则与任何范围重叠
  return rooms1.some((id) => rooms2.includes(id));
}

function ruleRoomIds(rule) {
  if (!rule.scope || rule.scope === "residence") return null;
  const set = new Set();
  if (rule.roomId) set.add(rule.roomId);
  for (const a of rule.actions || []) {
    const rid = a.deviceSelector?.roomId || a.roomId;
    if (rid) set.add(rid);
  }
  if (rule.trigger?.rooms) rule.trigger.rooms.forEach((id) => set.add(id));
  return [...set];
}

function triggersMayCooccur(t1, t2) {
  if (!t1 || !t2) return true;
  if (t1.capability !== t2.capability) return false;
  const s1 = t1.states && t1.states.length ? t1.states : null;
  const s2 = t2.states && t2.states.length ? t2.states : null;
  if (!s1 || !s2) return true;
  return s1.some((s) => s2.includes(s));
}

/**
 * 时段可重叠性（保守判定：不能证明不相交即视为可重叠）。
 */
export function schedulesMayOverlap(s1, s2) {
  const a = normalizeWindows(s1);
  const b = normalizeWindows(s2);
  if (a === null || b === null) return true; // always 与一切重叠
  for (const wa of a) {
    for (const wb of b) {
      if (windowsMayOverlap(wa, wb)) return true;
    }
  }
  return false;
}

/** 归一化为 [{startMin,endMin,weekdays:[0..6]|null}]；无法归一化返回 null（保守） */
function normalizeWindows(schedule) {
  if (!schedule || schedule.kind === "always") return null;
  if (schedule.kind === "time_window") return [normalizeWindow(schedule)].filter(Boolean);
  if (schedule.kind === "custom" && Array.isArray(schedule.windows)) {
    return schedule.windows.map(normalizeWindow).filter(Boolean);
  }
  return null;
}

function normalizeWindow(w) {
  if (!w || typeof w.start !== "string" || typeof w.end !== "string") return null;
  const toMin = (hhmm) => {
    const parts = hhmm.split(":").map(Number);
    if (parts.some(Number.isNaN)) return null;
    return parts[0] * 60 + parts[1];
  };
  const startMin = toMin(w.start);
  const endMin = toMin(w.end);
  if (startMin === null || endMin === null) return null;
  return { startMin, endMin, weekdays: w.weekdays || null };
}

function windowsMayOverlap(a, b) {
  const weekdays =
    !a.weekdays || !b.weekdays ? true : a.weekdays.some((d) => b.weekdays.includes(d));
  if (!weekdays) return false;
  // 把跨午夜窗口展开为若干直线区间
  const segsA = toSegments(a);
  const segsB = toSegments(b);
  return segsA.some((x) => segsB.some((y) => x[0] < y[1] && y[0] < x[1]));
}

function toSegments(w) {
  const { startMin, endMin } = w;
  if (startMin === endMin) return [[0, 24 * 60]];
  if (startMin < endMin) return [[startMin, endMin]];
  return [
    [startMin, 24 * 60],
    [0, endMin],
  ];
}
