/**
 * 注册服务：管理住房与房间、设备能力、人员、产权/租住关系、可撤回同意。
 *
 * 设计原则：
 *  - 任何访问控制都以"在某时刻有效的成员关系"为前提；
 *  - 房东/物业/厂商不是房屋成员，不进入生活数据流，只在明确授权的设备维护范围内出现；
 *  - 同意是显式、可撤回、带范围与有效期的；未成年人同意必须由监护人授予，且范围更窄。
 */
import {
  AGE_CLASS,
  AGGREGATE_TYPE,
  CONSENT_SCOPE_KIND,
  CONSENT_STATUS,
  EVENT_KIND,
  EVENT_TYPE,
  RESIDENCE_ROLES,
} from "./constants.js";
import { DomainError } from "./store.js";
import { newId, scheduleActiveAt, toDate } from "./time.js";

export class RegistrationService {
  constructor(store, clock = () => new Date()) {
    this.store = store;
    this.clock = clock;
  }

  // ---------- 住房 ----------

  async createResidence({ residenceId, name, timezone = "Asia/Shanghai" }) {
    const id = residenceId || newId("res");
    const { data } = await this.store.commit({
      aggregateType: "residence",
      aggregateId: id,
      eventType: EVENT_TYPE.MEMBERSHIP_CHANGED,
      create: true,
      summary: `登记住房：${name || id}`,
      detail: { kind: EVENT_KIND.MEMBER_ADDED, residenceId: id, residence: { name, timezone } },
      mutate: () => ({ id, kind: "residence", name: name || id, timezone, createdAt: this.clock().toISOString() }),
    });
    return data;
  }

  // ---------- 房间 ----------

  async addRoom({ residenceId, roomId, name, privateFor = null }) {
    this._requireResidence(residenceId);
    const id = roomId || newId("room");
    const { data } = await this.store.commit({
      aggregateType: "room",
      aggregateId: id,
      eventType: EVENT_TYPE.MEMBERSHIP_CHANGED,
      create: true,
      summary: `住房 ${residenceId} 新增房间：${name}`,
      detail: { kind: EVENT_KIND.MEMBER_ADDED, residenceId, room: { name, privateFor } },
      mutate: () => ({
        id,
        kind: "room",
        residenceId,
        name,
        privateFor, // 若为某人的私人房间（如孩子的房间），记录 personId
        createdAt: this.clock().toISOString(),
      }),
    });
    return data;
  }

  listRooms(residenceId) {
    return this.store.list("room", (r) => r.residenceId === residenceId);
  }

  // ---------- 设备能力（品牌无关） ----------

  /**
   * capability 例子：valve.shutoff（可关断阀门）、light、camera、voice、
   * location、power.outlet、gas.shutoff、smoke.alarm、water.leak ...
   * actions: 该能力支持的目标状态集合，如 ["on","off"] 或 ["shut","open"]。
   * mutexGroups: 声明在同一设备上互斥的能力（如阀门的 open/shut），用于静态分析兜底。
   */
  async registerDevice({
    residenceId,
    roomId = null,
    deviceId,
    brand = null, // 仅记录适配层代号，不绑定控制协议
    capability,
    actions,
    safetyRelated = false,
    collects = null, // 若为采集设备："camera"|"voice"|"location"
    mutexWith = [],
  }) {
    this._requireResidence(residenceId);
    if (roomId) this._requireRoom(residenceId, roomId);
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new DomainError("INVALID_DEVICE", "设备能力必须声明非空 actions 状态集合");
    }
    const id = deviceId || newId("dev");
    const { data } = await this.store.commit({
      aggregateType: AGGREGATE_TYPE.DEVICE_CAPABILITY,
      aggregateId: id,
      eventType: EVENT_TYPE.MEMBERSHIP_CHANGED,
      create: true,
      summary: `登记设备能力 ${capability}：${id}`,
      detail: { kind: EVENT_KIND.MEMBER_ADDED, residenceId, roomId, capability },
      mutate: () => ({
        id,
        kind: "device_capability",
        residenceId,
        roomId,
        brand,
        capability,
        actions,
        safetyRelated,
        collects,
        mutexWith,
        online: true,
        lastState: null,
        createdAt: this.clock().toISOString(),
      }),
    });
    return data;
  }

  /** 设备移动房间 */
  async moveDevice(deviceId, roomId, expectedVersion) {
    const dev = this._requireDevice(deviceId);
    this._requireRoom(dev.residenceId, roomId);
    return this._commitDevice(deviceId, expectedVersion, (d) => ({ ...d, roomId }), {
      kind: EVENT_KIND.MEMBER_ADDED,
      roomId,
    }, `设备 ${deviceId} 移至房间 ${roomId}`);
  }

  listDevices(residenceId) {
    return this.store.list(AGGREGATE_TYPE.DEVICE_CAPABILITY, (d) => d.residenceId === residenceId);
  }

  // ---------- 人员 ----------

  async registerPerson({ personId, name, ageClass = AGE_CLASS.ADULT, guardianIds = [], vulnerable = false, tags = [] }) {
    if (!Object.values(AGE_CLASS).includes(ageClass)) {
      throw new DomainError("INVALID_PERSON", `未知 ageClass：${ageClass}`);
    }
    const id = personId || newId("person");
    const { data } = await this.store.commit({
      aggregateType: "person",
      aggregateId: id,
      eventType: EVENT_TYPE.MEMBERSHIP_CHANGED,
      create: true,
      summary: `登记人员：${name}（${ageClass}${vulnerable ? "，需照护" : ""}）`,
      detail: { kind: EVENT_KIND.MEMBER_ADDED, person: { name, ageClass, vulnerable } },
      mutate: () => ({
        id,
        kind: "person",
        name,
        ageClass,
        guardianIds,
        vulnerable,
        tags,
        createdAt: this.clock().toISOString(),
      }),
    });
    return data;
  }

  // ---------- 成员关系（产权/租住/居住/访客） ----------

  /**
   * 建立成员关系。有效期 [validFrom, validUntil)：
   *  - 租约/访客天然有到期时间；
   *  - 交接时旧成员关系的 validUntil 被设为交接生效时点，此后判定均无效。
   * dataSubject: 标记该成员是否为设备数据可识别的生活数据主体（实际居住者=true）。
   * 房东（不居住）默认为 false —— 无权获取屋内生活轨迹。
   */
  async addMembership({
    residenceId,
    personId,
    role,
    validFrom = null,
    validUntil = null,
    dataSubject = null,
    occupiesRooms = [],
  }) {
    this._requireResidence(residenceId);
    const person = this._requirePerson(personId);
    if (!Object.values(RESIDENCE_ROLES).includes(role)) {
      throw new DomainError("INVALID_ROLE", `未知居住角色：${role}`);
    }
    const id = newId("mbr");
    // 实际居住/在场者（含访客）是生活数据主体；不居住的房东默认不是。
    const isOccupant = role !== RESIDENCE_ROLES.LANDLORD;
    const subject = dataSubject === null ? isOccupant : dataSubject;
    const { data } = await this.store.commit({
      aggregateType: AGGREGATE_TYPE.RESIDENCE_MEMBERSHIP,
      aggregateId: id,
      eventType: EVENT_TYPE.MEMBERSHIP_CHANGED,
      create: true,
      summary: `${person.name} 以 ${role} 身份加入住房 ${residenceId}`,
      detail: { kind: EVENT_KIND.MEMBER_ADDED, residenceId, personId, role },
      mutate: () => ({
        id,
        kind: "residence_membership",
        residenceId,
        personId,
        role,
        ageClass: person.ageClass,
        validFrom: validFrom ? toDate(validFrom).toISOString() : null,
        validUntil: validUntil ? toDate(validUntil).toISOString() : null,
        occupiesRooms,
        dataSubject: subject,
        accessStatus: "active",
        createdAt: this.clock().toISOString(),
      }),
    });
    return data;
  }

  /**
   * 返回某人在某住房于 at 时刻"生效中"的成员关系（可有多个角色，取最新）。
   */
  activeMemberships(residenceId, personId, at = this.clock()) {
    const t = toDate(at);
    return this.store
      .list(AGGREGATE_TYPE.RESIDENCE_MEMBERSHIP, (m) => m.residenceId === residenceId && m.personId === personId)
      .filter((m) => m.accessStatus === "active")
      .filter((m) => !m.validFrom || toDate(m.validFrom) <= t)
      .filter((m) => !m.validUntil || toDate(m.validUntil) > t);
  }

  /**
   * 住房内在 at 时刻生效的数据主体成员（实际居住/在场者）。
   * 不传 roomId 返回全屋；传入 roomId 时：
   *  - 显式占有该房间（occupiesRooms）的成员即为受影响者；
   *  - 若没有任何占有记录（如未登记房间归属的共享区域），保守地视为全屋在住者受影响。
   */
  affectedMembers(residenceId, roomId = null, at = this.clock()) {
    const t = toDate(at);
    const active = this.store
      .list(AGGREGATE_TYPE.RESIDENCE_MEMBERSHIP, (m) => m.residenceId === residenceId)
      .filter((m) => m.accessStatus === "active" && m.dataSubject)
      .filter((m) => !m.validFrom || toDate(m.validFrom) <= t)
      .filter((m) => !m.validUntil || toDate(m.validUntil) > t);

    let memberships = active;
    if (roomId) {
      const occupiers = active.filter((m) => (m.occupiesRooms || []).includes(roomId));
      memberships = occupiers.length > 0 ? occupiers : active;
    }
    return memberships.map((m) => this.store.get("person", m.personId)).filter(Boolean);
  }

  // ---------- 监护人采集限制（如：孩子在某时段禁止摄像） ----------

  /**
   * 对某数据主体设置采集限制（硬禁止，优先于同意）。
   * 未成年人限制须由监护人设置；成年人可对自身设置。
   * 命中生效限制时，即使存在同意，采集动作也必须拒绝。
   */
  async addCollectionRestriction({ residenceId, subjectId, setByPersonId, capability, schedule, reason = "" }) {
    this._requireResidence(residenceId);
    const subject = this._requirePerson(subjectId);
    const setter = this._requirePerson(setByPersonId);
    this._requireActiveMembership(residenceId, setByPersonId);
    if (subject.ageClass === AGE_CLASS.MINOR) {
      if (!subject.guardianIds.includes(setByPersonId) || setter.ageClass !== AGE_CLASS.ADULT) {
        throw new DomainError("RESTRICTION_FORBIDDEN", "未成年人的采集限制只能由其成年监护人设置");
      }
    } else if (subjectId !== setByPersonId) {
      throw new DomainError("RESTRICTION_FORBIDDEN", "成年人的采集限制只能由本人设置");
    }
    if (!schedule || schedule.kind === "always") {
      throw new DomainError("INVALID_RESTRICTION", "采集限制须声明适用时段 schedule");
    }
    const id = newId("rstr");
    const { data } = await this.store.commit({
      aggregateType: "consent",
      aggregateId: id,
      eventType: EVENT_TYPE.MEMBERSHIP_CHANGED,
      create: true,
      summary: `对 ${subject.name} 设置 ${capability} 禁采时段`,
      detail: { kind: EVENT_KIND.CONSENT_WITHDRAWN, restriction: true, subjectId, capability, schedule },
      mutate: () => ({
        id,
        kind: "collection_restriction",
        residenceId,
        subjectId,
        setByPersonId,
        capability,
        schedule,
        reason,
        active: true,
        createdAt: this.clock().toISOString(),
      }),
    });
    return data;
  }

  /** 某主体在 at 时刻命中的生效采集限制列表 */
  activeRestrictions(residenceId, subjectId, capability, at = this.clock()) {
    const t = toDate(at);
    return this.store
      .list("consent", (c) => c.kind === "collection_restriction")
      .filter((c) => c.residenceId === residenceId && c.subjectId === subjectId && c.active)
      .filter((c) => c.capability === capability)
      .filter((c) => scheduleActiveAt(c.schedule, t));
  }

  // ---------- 可撤回同意 ----------

  /**
   * 授予采集同意。
   *  - subjectId：被采集人（数据主体）；
   *  - grantedById：实际作出同意表示的人；未成年人必须由监护人授予；
   *  - scope：{ kind: residence|room|device, roomId?/deviceId? }；
   *  - capabilities：["camera","voice","location"] 子集；
   *  - schedule：可选时段（如"仅工作日白天"），不填=随时；
   *  - validUntil：可选绝对到期时间。
   */
  async grantConsent({
    residenceId,
    subjectId,
    grantedById,
    capabilities,
    scope,
    schedule = null,
    validUntil = null,
  }) {
    this._requireResidence(residenceId);
    const subject = this._requirePerson(subjectId);
    this._requireActiveMembership(residenceId, grantedById);

    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      throw new DomainError("INVALID_CONSENT", "同意必须覆盖至少一种采集能力");
    }
    if (!scope || !Object.values(CONSENT_SCOPE_KIND).includes(scope.kind)) {
      throw new DomainError("INVALID_CONSENT", "同意缺少有效范围 scope");
    }

    // 未成年人窄权限：不能由本人授予；必须由监护人授予，且范围不得超过 personal 空间
    if (subject.ageClass === AGE_CLASS.MINOR) {
      if (grantedById === subjectId) {
        throw new DomainError("MINOR_CONSENT", "未成年人不能自行授予采集同意，须由监护人作出");
      }
      const guardian = this._requirePerson(grantedById);
      if (guardian.ageClass !== AGE_CLASS.ADULT || !subject.guardianIds.includes(grantedById)) {
        throw new DomainError("MINOR_CONSENT", "未成年人的采集同意只能由其成年监护人授予");
      }
      if (scope.kind !== CONSENT_SCOPE_KIND.DEVICE && scope.kind !== CONSENT_SCOPE_KIND.ROOM) {
        throw new DomainError("MINOR_CONSENT", "对未成年人的采集范围不得超过房间/其个人设备");
      }
      // 房间范围只能是未成年人本人的私人房间
      if (scope.kind === CONSENT_SCOPE_KIND.ROOM) {
        const room = this.store.get("room", scope.roomId);
        if (!room || room.privateFor !== subjectId) {
          throw new DomainError("MINOR_CONSENT", "对未成年人的房间级采集同意仅限其本人私人房间");
        }
      }
    }

    const id = newId("cns");
    const { data } = await this.store.commit({
      aggregateType: "consent",
      aggregateId: id,
      eventType: EVENT_TYPE.MEMBERSHIP_CHANGED,
      create: true,
      summary: `${subject.name} 获授采集同意：${capabilities.join("/")} @ ${scope.kind}`,
      detail: { kind: EVENT_KIND.CONSENT_GRANTED, residenceId, subjectId, capabilities, scope },
      mutate: () => ({
        id,
        kind: "consent",
        residenceId,
        subjectId,
        grantedById,
        capabilities,
        scope,
        schedule,
        status: CONSENT_STATUS.GRANTED,
        validUntil: validUntil ? toDate(validUntil).toISOString() : null,
        createdAt: this.clock().toISOString(),
        withdrawnAt: null,
      }),
    });
    return data;
  }

  /** 撤回同意：立即生效（下一次裁决即不可用）。数据主体本人或其监护人可撤回。 */
  async withdrawConsent(consentId, requestedById) {
    const consent = this.store.get("consent", consentId);
    if (!consent) throw new DomainError("CONSENT_NOT_FOUND", `同意不存在：${consentId}`);
    if (consent.subjectId !== requestedById) {
      const requester = this._requirePerson(requestedById);
      const subject = this._requirePerson(consent.subjectId);
      if (requester.ageClass !== AGE_CLASS.ADULT || !subject.guardianIds.includes(requestedById)) {
        throw new DomainError("CONSENT_FORBIDDEN", "只有数据主体本人或其监护人可以撤回该同意");
      }
    }
    const { data } = await this.store.commit({
      aggregateType: "consent",
      aggregateId: consentId,
      eventType: EVENT_TYPE.MEMBERSHIP_CHANGED,
      expectedVersion: consent.version,
      summary: `采集同意撤回：${consentId}`,
      detail: { kind: EVENT_KIND.CONSENT_WITHDRAWN, subjectId: consent.subjectId, requestedById },
      mutate: (c) => ({ ...c, status: CONSENT_STATUS.WITHDRAWN, withdrawnAt: this.clock().toISOString() }),
    });
    return data;
  }

  /**
   * 判断 subjectId 在 at 时刻、于 scopeTarget（房间或设备）上，
   * 对指定采集能力是否存在生效同意（且时段命中）。
   */
  hasCollectionConsent(residenceId, subjectId, capability, target, at = this.clock()) {
    const t = toDate(at);
    const consents = this.store.list("consent", (c) => c.residenceId === residenceId && c.subjectId === subjectId);
    return consents.some((c) => {
      if (c.status !== CONSENT_STATUS.GRANTED) return false;
      if (!c.capabilities.includes(capability)) return false;
      if (c.validUntil && toDate(c.validUntil) <= t) return false;
      if (c.schedule && !scheduleActiveAt(c.schedule, t)) return false;
      return scopeCovers(c.scope, target);
    });
  }

  // ---------- 内部校验 ----------

  _requireResidence(residenceId) {
    const r = this.store.get("residence", residenceId);
    if (!r) throw new DomainError("RESIDENCE_NOT_FOUND", `住房不存在：${residenceId}`);
    return r;
  }

  _requireRoom(residenceId, roomId) {
    const room = this.store.get("room", roomId);
    if (!room || room.residenceId !== residenceId) {
      throw new DomainError("ROOM_NOT_FOUND", `房间不存在于该住房：${roomId}`);
    }
    return room;
  }

  _requireDevice(deviceId) {
    const d = this.store.get(AGGREGATE_TYPE.DEVICE_CAPABILITY, deviceId);
    if (!d) throw new DomainError("DEVICE_NOT_FOUND", `设备不存在：${deviceId}`);
    return d;
  }

  _requirePerson(personId) {
    const p = this.store.get("person", personId);
    if (!p) throw new DomainError("PERSON_NOT_FOUND", `人员不存在：${personId}`);
    return p;
  }

  _requireActiveMembership(residenceId, personId) {
    const ms = this.activeMemberships(residenceId, personId);
    if (ms.length === 0) {
      throw new DomainError("NOT_MEMBER", `人员 ${personId} 在住房 ${residenceId} 无生效成员关系`);
    }
    return ms;
  }
}

/** scope 是否覆盖目标 {kind:'room'|'device', id} */
export function scopeCovers(scope, target) {
  if (scope.kind === CONSENT_SCOPE_KIND.RESIDENCE) return true;
  if (scope.kind === CONSENT_SCOPE_KIND.ROOM) return target.kind === "room" && target.id === scope.roomId;
  if (scope.kind === CONSENT_SCOPE_KIND.DEVICE) return target.kind === "device" && target.id === scope.deviceId;
  return false;
}
