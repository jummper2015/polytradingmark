import type { EffectiveRuntimeConfig, RuntimeConfigSubscriber } from './types';

export interface EngineRuntimeConfigTarget {
  updateRuntimeConfig(config: EffectiveRuntimeConfig): Promise<void> | void;
}

export interface RiskRuntimeConfigTarget {
  updateRuntimeConfig(config: EffectiveRuntimeConfig): Promise<void> | void;
}

export interface DashboardRuntimeConfigTarget {
  updateRuntimeConfig(config: EffectiveRuntimeConfig): Promise<void> | void;
}

export interface WalletManagerRuntimeConfigTarget {
  updateRuntimeConfig(config: EffectiveRuntimeConfig): Promise<void> | void;
}

export interface OrderRouterRuntimeConfigTarget {
  updateRuntimeConfig(config: EffectiveRuntimeConfig): Promise<void> | void;
}

export class EngineConfigSubscriber implements RuntimeConfigSubscriber {
  constructor(private readonly engine: EngineRuntimeConfigTarget) {}

  async onConfigUpdated(config: EffectiveRuntimeConfig): Promise<void> {
    await this.engine.updateRuntimeConfig(config);
  }
}

export class RiskEngineConfigSubscriber implements RuntimeConfigSubscriber {
  constructor(private readonly riskEngine: RiskRuntimeConfigTarget) {}

  async onConfigUpdated(config: EffectiveRuntimeConfig): Promise<void> {
    await this.riskEngine.updateRuntimeConfig(config);
  }
}

export class DashboardConfigSubscriber implements RuntimeConfigSubscriber {
  constructor(private readonly dashboard: DashboardRuntimeConfigTarget) {}

  async onConfigUpdated(config: EffectiveRuntimeConfig): Promise<void> {
    await this.dashboard.updateRuntimeConfig(config);
  }
}

export class WalletManagerConfigSubscriber implements RuntimeConfigSubscriber {
  constructor(private readonly walletManager: WalletManagerRuntimeConfigTarget) {}

  async onConfigUpdated(config: EffectiveRuntimeConfig): Promise<void> {
    await this.walletManager.updateRuntimeConfig(config);
  }
}

export class OrderRouterConfigSubscriber implements RuntimeConfigSubscriber {
  constructor(private readonly orderRouter: OrderRouterRuntimeConfigTarget) {}

  async onConfigUpdated(config: EffectiveRuntimeConfig): Promise<void> {
    await this.orderRouter.updateRuntimeConfig(config);
  }
}
