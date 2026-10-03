/**
 * 多住户智能家居裁决后端 —— 领域常量与枚举
 *
 * 本模块不直接控制任何具体品牌：所有设备都以抽象能力（capability）描述，
 * 品牌侧通过适配层把自身动作翻译为 capability 状态，裁决后端只产出
 * "对哪个能力做什么" 的裁决结果与回执，由适配层执行。
 */

/** 人员在住房中的身份关系 */
export const RESIDENCE_ROLES = Object.freeze({
  OWNER: "owner", // 产权人（业主自住）
  LANDLORD: "landlord", // 房东（出租后通常不实际居住）
  TENANT: "tenant", // 租户
  HOUSEHOLD: "household", // 共同居住家庭成员
  ROOMMATE: "roommate", // 室友
  GUEST: "guest", // 访客：最窄默认权限，离开即失效
});

/** 成年/未成年；未成年成员采用更窄权限，其自身授予的采集同意一律无效 */
export const AGE_CLASS = Object.freeze({
  ADULT: "adult",
  MINOR: "minor",
});

/**
 * 优先级层级（数值越大越优先）。
 * 裁决不是"最后写入覆盖"，而是按依据类别分层，同层再看适用范围/创建时间。
 *
 * SAFETY(300)     安全处置：漏水关阀、燃气切断、防火防燃气，可压过一切舒适偏好；
 *                 但仍不能绕过采集同意（安全动作本身不应携带摄像/语音/位置采集）。
 * PROTECTION(200) 保护约束：未成年人保护、健康需求（老人夜间照明）、监护人限制、手动覆盖。
 * COMFORT(100)    普通舒适/节能偏好。
 */
export const PRIORITY_TIERS = Object.freeze({
  SAFETY: 300,
  PROTECTION: 200,
  COMFORT: 100,
});

/** 优先级依据 —— 每条规则/动作必须声明"为什么它有这个优先级" */
export const PRIORITY_BASIS = Object.freeze({
  EMERGENCY_SENSOR_ALERT: "emergency_sensor_alert", // 紧急传感告警驱动（如漏水）
  GUARDIAN_RESTRICTION: "guardian_restriction", // 监护人对未成年人的限制
  VULNERABLE_PERSON_NEED: "vulnerable_person_need", // 老幼病等弱势成员需求
  MANUAL_OVERRIDE: "manual_override", // 居民临时手动覆盖
  PERSONAL_PREFERENCE: "personal_preference", // 个人舒适偏好
  ENERGY_SAVING: "energy_saving", // 节能规则
});

/** 优先级依据 → 层级。安全处置始终高于普通舒适偏好。 */
export const BASIS_TIER = Object.freeze({
  [PRIORITY_BASIS.EMERGENCY_SENSOR_ALERT]: PRIORITY_TIERS.SAFETY,
  [PRIORITY_BASIS.GUARDIAN_RESTRICTION]: PRIORITY_TIERS.SAFETY,
  [PRIORITY_BASIS.VULNERABLE_PERSON_NEED]: PRIORITY_TIERS.PROTECTION,
  [PRIORITY_BASIS.MANUAL_OVERRIDE]: PRIORITY_TIERS.PROTECTION,
  [PRIORITY_BASIS.PERSONAL_PREFERENCE]: PRIORITY_TIERS.COMFORT,
  [PRIORITY_BASIS.ENERGY_SAVING]: PRIORITY_TIERS.COMFORT,
});

/** 规则发布层级：全屋规则压过房间/个人规则需有身份依据；个人规则只支配个人空间 */
export const RULE_SCOPE = Object.freeze({
  RESIDENCE: "residence", // 全屋
  ROOM: "room", // 单房间
  PERSONAL: "personal", // 个人（仅支配本人使用的空间/设备）
});

/** 受特殊范围约束的采集类能力（任一缺失生效同意即禁止） */
export const COLLECTION_CAPABILITIES = Object.freeze({
  CAMERA: "camera", // 摄像
  VOICE: "voice", // 语音采集
  LOCATION: "location", // 位置采集
});

export const COLLECTION_CAPABILITY_VALUES = Object.freeze(Object.values(COLLECTION_CAPABILITIES));

/** 判定一个能力状态值是否属于"开启采集" */
export function isCollectionActive(capability, state) {
  return COLLECTION_CAPABILITY_VALUES.includes(capability) && state === "on";
}

/** 同意状态 */
export const CONSENT_STATUS = Object.freeze({
  GRANTED: "granted",
  WITHDRAWN: "withdrawn", // 可撤回；撤回立即生效
});

/** 采集范围同意允许的粒度 */
export const CONSENT_SCOPE_KIND = Object.freeze({
  RESIDENCE: "residence",
  ROOM: "room",
  DEVICE: "device",
});

/**
 * 未成年人默认允许的采集范围上限：
 * 仅本人明确个人空间 + 监护人在场的安全场景由监护人同意；
 * 全屋/共享房间对未成年人的采集默认禁止。
 */
export const MINOR_MAX_CONSENT = Object.freeze({
  kind: CONSENT_SCOPE_KIND.PERSONAL,
});

/** 回执中的处置结果 */
export const DECISION_OUTCOME = Object.freeze({
  EXECUTED: "executed", // 裁决通过并交付适配层
  SUPPRESSED: "suppressed", // 被更高优先级动作压制
  DENIED_CONSENT: "denied_consent", // 采集同意不足
  DENIED_AUTHZ: "denied_authz", // 成员关系/角色无权
  CONFLICT: "conflict", // 同级互斥且无法裁决，挂起待人工
  EXPIRED: "expired", // 离线恢复重判时动作已过期，不补执行
  SKIPPED_STALE: "skipped_stale", // 条件不再成立
  PENDING: "pending", // 目标设备离线，排队等待恢复时重新判断
  HELD: "held", // 保护约束保持现状，不下发变更（如夜间照明不瞬断）
  MAINTAINED: "maintained", // 设备已处于胜出动作要求的状态，维持现状不重复下发
});

/** 交接（控制权/数据）原因 */
export const TRANSFER_REASON = Object.freeze({
  MOVE_OUT: "move_out", // 搬家
  TENANCY_CHANGE: "tenancy_change", // 换租
  RESALE: "resale", // 转售
  CLOUD_EXIT: "cloud_exit", // 云服务退出
});

/** 交接时对原住户数据的处置 */
export const DATA_HANDOVER_POLICY = Object.freeze({
  EXPORT_AND_DELETE: "export_and_delete", // 打包导出后删除
  TRANSFER_TO_SUCCESSOR: "transfer_to_successor", // 随控制权移交给后继者
  DELETE: "delete", // 直接删除
});

/** 交接生效时点旧住户访问状态 */
export const ACCESS_STATUS = Object.freeze({
  ACTIVE: "active",
  REVOKED: "revoked",
});

/** 规则生命周期状态 */
export const RULE_STATUS = Object.freeze({
  DRAFT: "draft",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  ARCHIVED: "archived",
});

/**
 * 事件类型严格对齐 contracts/domain.schema.json 的五值枚举：
 * 内部更细的事件类别放在事件 detail.kind 中，保证整条事件流都能通过信封校验。
 */
export const EVENT_TYPE = Object.freeze({
  MEMBERSHIP_CHANGED: "MEMBERSHIP_CHANGED",
  RULE_PUBLISHED: "RULE_PUBLISHED",
  CONFLICT_DETECTED: "CONFLICT_DETECTED",
  ACTION_EXECUTED: "ACTION_EXECUTED",
  CONTROL_TRANSFERRED: "CONTROL_TRANSFERRED",
  DEVICE_OBSERVED: "DEVICE_OBSERVED",
});

/** detail.kind —— 五类信封内的细分语义 */
export const EVENT_KIND = Object.freeze({
  // MEMBERSHIP_CHANGED
  MEMBER_ADDED: "member_added",
  MEMBER_REMOVED: "member_removed",
  GUEST_ACCESS_EXPIRED: "guest_access_expired",
  DEVICE_STATE_UPDATED: "device_state_updated",
  CONSENT_GRANTED: "consent_granted",
  CONSENT_WITHDRAWN: "consent_withdrawn",
  // RULE_PUBLISHED
  RULE_CREATED: "rule_created",
  RULE_REJECTED: "rule_rejected",
  RULE_SUSPENDED: "rule_suspended",
  OVERRIDE_REQUESTED: "override_requested",
  OVERRIDE_EXPIRED: "override_expired",
  // CONFLICT_DETECTED
  MUTEX_CONFLICT: "mutex_conflict",
  CYCLE_DETECTED: "cycle_detected",
  // ACTION_EXECUTED
  DECISION: "decision",
  DEVICE_RECOVERED: "device_recovered",
  // CONTROL_TRANSFERRED
  HANDOVER_EFFECTIVE: "handover_effective",
  DATA_HANDOVER: "data_handover",
});

/** 聚合同样与 schema 对齐 */
export const AGGREGATE_TYPE = Object.freeze({
  RESIDENCE_MEMBERSHIP: "residence_membership",
  DEVICE_CAPABILITY: "device_capability",
  AUTOMATION_RULE: "automation_rule",
  EXECUTION_RECEIPT: "execution_receipt",
});

/** 时段类型 */
export const SCHEDULE_KIND = Object.freeze({
  ALWAYS: "always",
  TIME_WINDOW: "time_window", // 每日时间窗，如 22:00-06:00
  CUSTOM: "custom", // 显式时间段列表
});

/** 设备事件（设备上报 → 触发器可匹配的状态条件） */
export const DEVICE_EVENT_KIND = Object.freeze({
  SENSOR_ALERT: "sensor_alert", // 告警类：如 water_leak / gas / smoke
  STATE_CHANGE: "state_change", // 状态变化
  HEARTBEAT: "heartbeat",
  OFFLINE: "offline",
  RECOVERED: "recovered",
});
