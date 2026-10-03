import { addMembership, addPrivacyWindow, addRoom, createResidence, registerDevice } from "../src/domain.js";
import { createRule, publishRule } from "../src/rules.js";
import { Store } from "../src/store.js";

export const T0 = "2026-10-03T12:00:00+08:00";

// 标准家庭夹具：
// - 户主（产权人）、老人（居民）、孩子（未成年人，户主监护）、室友（承租人）
// - 安全规则：漏水 → 关阀并保持厨房插座供电（维持主张）
// - 照护规则：21:00 点亮夜灯与老人房插座，并在 21:00–07:00 维持
// - 节能规则（室友）：02:00 切断同一组设备；03:05 断厨房插座
// - 孩子隐私时段：19:00–07:00 禁止摄像
export function buildHousehold() {
  const store = new Store();
  const res = createResidence(store, { name: "朝阳小区 3-502" });
  const kitchen = addRoom(store, res.id, { name: "厨房" });
  const hallway = addRoom(store, res.id, { name: "走廊" });
  const elderRoom = addRoom(store, res.id, { name: "老人房" });
  const childRoom = addRoom(store, res.id, { name: "儿童房" });

  const leakSensor = registerDevice(store, {
    residence_id: res.id, room_id: kitchen.id, label: "水浸传感器", capabilities: ["sensor.leak"],
  });
  const mainValve = registerDevice(store, {
    residence_id: res.id, room_id: kitchen.id, label: "总水阀", capabilities: ["valve.actuate"],
  });
  const kitchenPlug = registerDevice(store, {
    residence_id: res.id, room_id: kitchen.id, label: "厨房插座", capabilities: ["plug.set"],
  });
  const hallwayLight = registerDevice(store, {
    residence_id: res.id, room_id: hallway.id, label: "走廊夜灯", capabilities: ["light.set"],
  });
  const elderPlug = registerDevice(store, {
    residence_id: res.id, room_id: elderRoom.id, label: "老人房插座", capabilities: ["plug.set"],
  });
  const childCamera = registerDevice(store, {
    residence_id: res.id, room_id: childRoom.id, label: "儿童房摄像头", capabilities: ["camera.capture"],
  });
  const childMotion = registerDevice(store, {
    residence_id: res.id, room_id: childRoom.id, label: "儿童房移动传感器", capabilities: ["sensor.motion"],
  });
  const hallwayMotion = registerDevice(store, {
    residence_id: res.id, room_id: hallway.id, label: "走廊移动传感器", capabilities: ["sensor.motion"],
  });
  const phoneHub = registerDevice(store, {
    residence_id: res.id, room_id: hallway.id, label: "手机中枢", capabilities: ["location.report"],
  });

  const owner = addMembership(store, { residence_id: res.id, name: "户主", role: "owner", now: T0 });
  const elder = addMembership(store, { residence_id: res.id, name: "老人", role: "resident", room_ids: [elderRoom.id], now: T0 });
  const child = addMembership(store, {
    residence_id: res.id, name: "孩子", role: "resident", is_minor: true, guardian_id: owner.id, room_ids: [childRoom.id], now: T0,
  });
  const roommate = addMembership(store, { residence_id: res.id, name: "室友", role: "tenant", now: T0 });

  addPrivacyWindow(store, child.id, {
    capability: "camera.capture",
    window: { start: "19:00", end: "07:00" },
    actor_id: owner.id,
    now: T0,
  });

  const safetyRule = createRule(store, {
    residence_id: res.id,
    created_by: owner.id,
    name: "漏水关阀",
    priority_class: "safety",
    rank: 10,
    trigger: { type: "device_event", capability: "sensor.leak", match: { state: "detected" } },
    actions: [
      { device_id: mainValve.id, capability: "valve.actuate", params: { state: "close" } },
      { device_id: kitchenPlug.id, capability: "plug.set", params: { state: "on" } },
    ],
    maintain: true,
    action_ttl_seconds: 120,
    now: T0,
  });
  publishRule(store, safetyRule.id, { actor_id: owner.id, now: T0 });

  const careRule = createRule(store, {
    residence_id: res.id,
    created_by: owner.id,
    name: "老人夜间照明",
    priority_class: "care",
    rank: 5,
    trigger: { type: "schedule", at: "21:00" },
    window: { start: "21:00", end: "07:00" },
    actions: [
      { device_id: hallwayLight.id, capability: "light.set", params: { state: "on" } },
      { device_id: elderPlug.id, capability: "plug.set", params: { state: "on" } },
    ],
    maintain: true,
    now: T0,
  });
  publishRule(store, careRule.id, { actor_id: owner.id, now: T0 });

  const energyRule = createRule(store, {
    residence_id: res.id,
    created_by: roommate.id,
    name: "凌晨节能断电",
    priority_class: "energy",
    trigger: { type: "schedule", at: "02:00" },
    actions: [
      { device_id: hallwayLight.id, capability: "light.set", params: { state: "off" } },
      { device_id: elderPlug.id, capability: "plug.set", params: { state: "off" } },
      { device_id: kitchenPlug.id, capability: "plug.set", params: { state: "off" } },
    ],
    now: T0,
  });
  publishRule(store, energyRule.id, { actor_id: roommate.id, now: T0 });

  const energyRule2 = createRule(store, {
    residence_id: res.id,
    created_by: roommate.id,
    name: "深夜插座断电",
    priority_class: "energy",
    trigger: { type: "schedule", at: "03:05" },
    actions: [{ device_id: kitchenPlug.id, capability: "plug.set", params: { state: "off" } }],
    now: T0,
  });
  publishRule(store, energyRule2.id, { actor_id: roommate.id, now: T0 });

  return {
    store,
    res,
    rooms: { kitchen, hallway, elderRoom, childRoom },
    devices: { leakSensor, mainValve, kitchenPlug, hallwayLight, elderPlug, childCamera, childMotion, hallwayMotion, phoneHub },
    members: { owner, elder, child, roommate },
    rules: { safetyRule, careRule, energyRule, energyRule2 },
  };
}

export function telemetryEvent(deviceId, capability, state, occurredAt, eventId) {
  return {
    event_id: eventId ?? `evt-${capability}-${state}-${occurredAt}`,
    event_type: "TELEMETRY_REPORTED",
    aggregate_type: "device_capability",
    aggregate_id: deviceId,
    occurred_at: occurredAt,
    version: 1,
    summary: `设备上报：${capability} = ${state}`,
    detail: { capability, state },
  };
}

export function outcomeFor(decision, deviceId) {
  return decision.outcomes.find((outcome) => outcome.action.device_id === deviceId);
}
