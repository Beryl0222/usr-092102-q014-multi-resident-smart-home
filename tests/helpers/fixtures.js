/**
 * 测试共享夹具：构建一个多住户住房（含老人、家长、孩子、节能室友）与典型设备。
 */
import { SmartHomeArbitration } from "../../src/domain/app.js";
import {
  AGE_CLASS,
  COLLECTION_CAPABILITIES,
  DEVICE_EVENT_KIND,
  EVENT_TYPE,
  RESIDENCE_ROLES,
} from "../../src/domain/constants.js";

export function makeClock(startIso = "2026-10-03T02:00:00+08:00") {
  let t = new Date(startIso).getTime();
  return {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
      return new Date(t);
    },
    set: (iso) => {
      t = new Date(iso).getTime();
      return new Date(t);
    },
  };
}

let seq = 0;
export function observation(device, { kind = DEVICE_EVENT_KIND.STATE_CHANGE, state, alert, cleared, activeAlerts, version } = {}, clock) {
  seq += 1;
  return {
    event_id: `evt-${device}-${version ?? seq}`,
    event_type: EVENT_TYPE.DEVICE_OBSERVED,
    aggregate_type: "device_capability",
    aggregate_id: device,
    occurred_at: clock.now().toISOString(),
    version: version ?? seq,
    summary: `观测 ${device}`,
    detail: { kind, state, alert, cleared, activeAlerts },
  };
}

export async function buildHome(clock, { residenceId = "res1" } = {}) {
  const app = await SmartHomeArbitration.create({ clock: clock.now });

  await app.registration.createResidence({ residenceId, name: "测试公寓" });
  await app.registration.addRoom({ residenceId, roomId: "bath", name: "卫生间" });
  await app.registration.addRoom({ residenceId, roomId: "hall", name: "过道" });
  await app.registration.addRoom({ residenceId, roomId: "living", name: "客厅" });
  await app.registration.addRoom({ residenceId, roomId: "kidroom", name: "孩子房间", privateFor: "kid" });

  await app.registration.registerPerson({ personId: "elder", name: "爷爷", ageClass: AGE_CLASS.ADULT, vulnerable: true, tags: ["elderly"] });
  await app.registration.registerPerson({ personId: "parent", name: "家长", ageClass: AGE_CLASS.ADULT });
  await app.registration.registerPerson({ personId: "kid", name: "孩子", ageClass: AGE_CLASS.MINOR, guardianIds: ["parent"] });
  await app.registration.registerPerson({ personId: "mate", name: "室友", ageClass: AGE_CLASS.ADULT });

  await app.registration.addMembership({ residenceId, personId: "elder", role: RESIDENCE_ROLES.HOUSEHOLD, occupiesRooms: ["hall", "living"] });
  await app.registration.addMembership({ residenceId, personId: "parent", role: RESIDENCE_ROLES.OWNER, occupiesRooms: ["living"] });
  await app.registration.addMembership({ residenceId, personId: "kid", role: RESIDENCE_ROLES.HOUSEHOLD, occupiesRooms: ["kidroom"] });
  await app.registration.addMembership({ residenceId, personId: "mate", role: RESIDENCE_ROLES.ROOMMATE, occupiesRooms: ["living"] });

  await app.registration.registerDevice({ deviceId: "leak", residenceId, roomId: "bath", capability: "water_leak", actions: ["alert", "clear"], safetyRelated: true });
  await app.registration.registerDevice({ deviceId: "valve", residenceId, roomId: "bath", capability: "valve.shutoff", actions: ["shut", "open"], safetyRelated: true });
  await app.registration.registerDevice({ deviceId: "nightlight", residenceId, roomId: "hall", capability: "light", actions: ["on", "off"] });
  await app.registration.registerDevice({ deviceId: "hallswitch", residenceId, roomId: "hall", capability: "hall.switch", actions: ["pressed", "released"] });
  await app.registration.registerDevice({ deviceId: "outlet", residenceId, roomId: "living", capability: "power.outlet", actions: ["on", "off"] });
  await app.registration.registerDevice({ deviceId: "cam", residenceId, roomId: "kidroom", capability: COLLECTION_CAPABILITIES.CAMERA, actions: ["on", "off"], collects: "camera" });
  await app.registration.registerDevice({ deviceId: "livingcam", residenceId, roomId: "living", capability: COLLECTION_CAPABILITIES.CAMERA, actions: ["on", "off"], collects: "camera" });

  return app;
}

/** 从裁决结果中取某设备的回执 */
export function receiptFor(result, deviceId) {
  return result.receipts.find((r) => r.deviceId === deviceId);
}
