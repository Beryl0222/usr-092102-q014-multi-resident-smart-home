/**
 * 应用装配层：把存储、注册、规则、裁决、交接服务组装成一个品牌无关的裁决后端。
 * 不包含任何具体品牌协议；真实硬件由适配层实现 ArbitrationEngine.adapter 接口。
 */
import { Store } from "./store.js";
import { RegistrationService } from "./registration.js";
import { RuleService } from "./rule-service.js";
import { ArbitrationEngine, RecordingAdapter } from "./arbitration.js";
import { HandoverService } from "./handover.js";

export class SmartHomeArbitration {
  constructor({ store, clock = () => new Date(), adapter = null } = {}) {
    this.clock = clock;
    this.store = store || new Store({ clock });
    this.registration = new RegistrationService(this.store, clock);
    this.rules = new RuleService(this.store, this.registration, clock);
    this.engine = new ArbitrationEngine(this.store, this.registration, this.rules, {
      adapter: adapter || new RecordingAdapter(),
      clock,
    });
    this.handovers = new HandoverService(this.store, this.registration, this.rules, clock);
  }

  static async create({ persistPath = null, clock = () => new Date(), adapter = null } = {}) {
    const store = await Store.create({ persistPath, clock });
    return new SmartHomeArbitration({ store, clock, adapter });
  }

  /** 到期交接扫描（可周期性调用） */
  applyDueHandovers() {
    return this.handovers.applyDueHandovers(this.clock());
  }
}

export { Store, RegistrationService, RuleService, ArbitrationEngine, HandoverService, RecordingAdapter };
