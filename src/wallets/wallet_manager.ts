import { AppConfig } from '../types';
import type { EffectiveRuntimeConfig } from '../config_runtime/types';
import { PaperWallet } from './paper_wallet';
import { PolymarketWallet } from './polymarket_wallet';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';

type WalletMode = 'PAPER' | 'LIVE' | 'DISABLED';

interface WalletBuildInput {
  id: string;
  mode: WalletMode;
  strategy?: string;
  capital?: number;
  riskLimits?: Record<string, unknown>;
  label?: string;
}

type ManagedWallet = any;

export class WalletManager {
  private readonly wallets = new Map<string, ManagedWallet>();

  // Nuevo soporte runtime
  private runtimeConfig: EffectiveRuntimeConfig | null = null;
  private readonly strategyWalletMap = new Map<string, string>();
  private readonly runtimeManagedWalletIds = new Set<string>();

  private initialized = false;

  constructor(private readonly config: AppConfig) {}

  /* =========================================================
   * Lifecycle
   * ======================================================= */

  async initialize(): Promise<void> {
    if (this.hasRuntimeStrategies()) {
      await this.rebuildFromRuntimeConfig();
    } else {
      await this.initializeLegacyWallets();
    }

    this.initialized = true;
  }

  async updateRuntimeConfig(config: EffectiveRuntimeConfig): Promise<void> {
    this.runtimeConfig = config;

    if (this.initialized) {
      await this.rebuildFromRuntimeConfig();
    }
  }

  getRuntimeConfig(): EffectiveRuntimeConfig | null {
    return this.runtimeConfig;
  }

  /* =========================================================
   * Public API
   * ======================================================= */

  getWallet(id: string): ManagedWallet | undefined {
    return this.wallets.get(id);
  }

  hasWallet(id: string): boolean {
    return this.wallets.has(id);
  }

  getAllWallets(): ManagedWallet[] {
    return Array.from(this.wallets.values());
  }

  getWalletIds(): string[] {
    return Array.from(this.wallets.keys());
  }

  getWalletStates(): any[] {
    return this.getAllWallets()
      .map((wallet) => {
        if (typeof wallet?.getState === 'function') {
          return wallet.getState();
        }
        return undefined;
      })
      .filter(Boolean);
  }

  getWalletIdForStrategy(strategyRunId: string): string | undefined {
    return this.strategyWalletMap.get(strategyRunId);
  }

  getWalletForStrategy(strategyRunId: string): ManagedWallet | undefined {
    const walletId = this.strategyWalletMap.get(strategyRunId);
    if (!walletId) return undefined;
    return this.wallets.get(walletId);
  }

  registerStrategyWallet(strategyRunId: string, walletId: string): void {
    this.strategyWalletMap.set(strategyRunId, walletId);
  }

  removeWallet(id: string): boolean {
    const existed = this.wallets.delete(id);

    if (existed) {
      this.runtimeManagedWalletIds.delete(id);

      for (const [strategyRunId, walletId] of this.strategyWalletMap.entries()) {
        if (walletId === id || strategyRunId === id) {
          this.strategyWalletMap.delete(strategyRunId);
        }
      }

      logger.info({ walletId: id }, 'Wallet removed');
      consoleLog.warn('WALLET', `Wallet removed: ${id}`);
    }

    return existed;
  }

  clear(): void {
    this.wallets.clear();
    this.strategyWalletMap.clear();
    this.runtimeManagedWalletIds.clear();
  }

  /**
   * Compatibilidad legacy para alta manual.
   */
  registerWallet(walletConfig: {
    id: string;
    mode?: string;
    strategy?: string;
    capital?: number;
    riskLimits?: Record<string, unknown>;
    risk_limits?: Record<string, unknown>;
  }): boolean {
    if (!walletConfig?.id) {
      logger.warn('registerWallet called without wallet id');
      return false;
    }

    if (this.wallets.has(walletConfig.id)) {
      logger.warn({ walletId: walletConfig.id }, 'Wallet already exists');
      return false;
    }

    const mode = this.normalizeMode(walletConfig.mode);
    const riskLimits = walletConfig.riskLimits ?? walletConfig.risk_limits ?? {};

    const wallet = this.createWallet({
      id: walletConfig.id,
      mode,
      strategy: walletConfig.strategy,
      capital: walletConfig.capital,
      riskLimits,
    });

    if (!wallet) return false;

    this.wallets.set(walletConfig.id, wallet);

    if (walletConfig.strategy) {
      this.strategyWalletMap.set(walletConfig.id, walletConfig.id);
    }

    logger.info(
      {
        walletId: walletConfig.id,
        mode,
        strategy: walletConfig.strategy,
      },
      'Wallet registered',
    );

    consoleLog.success(
      'WALLET',
      `Wallet registered: ${walletConfig.id}`,
      {
        walletId: walletConfig.id,
        mode,
        strategy: walletConfig.strategy,
      },
    );

    return true;
  }

  /* =========================================================
   * Legacy bootstrap
   * ======================================================= */

  private hasRuntimeStrategies(): boolean {
    return Boolean(this.runtimeConfig?.strategies?.length);
  }

  private async initializeLegacyWallets(): Promise<void> {
    const legacyWallets = ((this.config as any)?.wallets ?? []) as Array<{
      id: string;
      mode?: string;
      strategy?: string;
      capital?: number;
      riskLimits?: Record<string, unknown>;
      risk_limits?: Record<string, unknown>;
    }>;

    for (const wallet of legacyWallets) {
      this.registerWallet(wallet);
    }
  }

  /* =========================================================
   * Runtime bootstrap / rebuild
   * ======================================================= */

  private async rebuildFromRuntimeConfig(): Promise<void> {
    if (!this.runtimeConfig) return;

    const desiredWallets = new Map<string, WalletBuildInput>();
    const nextStrategyWalletMap = new Map<string, string>();

    for (const strategy of this.runtimeConfig.strategies) {
      if (!strategy.enabled || strategy.mode === 'DISABLED') {
        continue;
      }

      const walletId =
        strategy.mode === 'LIVE'
          ? this.runtimeConfig.account.accountId
          : strategy.strategyRunId;

      nextStrategyWalletMap.set(strategy.strategyRunId, walletId);

      // Si ya existe una wallet deseada, no la recreamos aquí.
      if (!desiredWallets.has(walletId)) {
        desiredWallets.set(walletId, {
          id: walletId,
          mode: strategy.mode,
          strategy: strategy.key,
          capital: strategy.allocation.resolvedUsd ?? strategy.allocation.value,
          riskLimits: { ...(strategy.risk ?? {}) },
          label:
            strategy.mode === 'LIVE'
              ? this.runtimeConfig.account.accountId
              : strategy.strategyRunId,
        });
      }
    }

    // 1) Eliminar wallets runtime que ya no se necesitan
    for (const walletId of Array.from(this.runtimeManagedWalletIds)) {
      if (!desiredWallets.has(walletId)) {
        this.wallets.delete(walletId);
        this.runtimeManagedWalletIds.delete(walletId);

        logger.info({ walletId }, 'Removed stale runtime-managed wallet');
        consoleLog.warn('WALLET', `Removed stale runtime wallet: ${walletId}`);
      }
    }

    // 2) Crear o actualizar wallets deseadas
    for (const [walletId, buildInput] of desiredWallets.entries()) {
      const existing = this.wallets.get(walletId);

      if (!existing) {
        const wallet = this.createWallet(buildInput);
        if (!wallet) continue;

        this.wallets.set(walletId, wallet);
        this.runtimeManagedWalletIds.add(walletId);

        logger.info(
          {
            walletId,
            mode: buildInput.mode,
            strategy: buildInput.strategy,
          },
          'Runtime-managed wallet created',
        );

        consoleLog.success('WALLET', `Runtime wallet created: ${walletId}`, {
          walletId,
          mode: buildInput.mode,
          strategy: buildInput.strategy,
        });

        continue;
      }

      this.applyWalletRuntimeUpdates(existing, buildInput);
      this.runtimeManagedWalletIds.add(walletId);
    }

    // 3) Reemplazar bindings strategy -> wallet
    this.strategyWalletMap.clear();
    for (const [strategyRunId, walletId] of nextStrategyWalletMap.entries()) {
      this.strategyWalletMap.set(strategyRunId, walletId);
    }
  }

  /* =========================================================
   * Wallet creation / update
   * ======================================================= */

  private createWallet(input: WalletBuildInput): ManagedWallet | undefined {
    if (input.mode === 'DISABLED') {
      return undefined;
    }

    if (input.mode === 'LIVE' && !this.isLiveAllowed()) {
      logger.warn(
        {
          walletId: input.id,
          strategy: input.strategy,
        },
        'LIVE wallet rejected because live trading is not enabled',
      );

      consoleLog.warn(
        'WALLET',
        `LIVE wallet rejected: ${input.id} — live trading is disabled`,
        {
          walletId: input.id,
          strategy: input.strategy,
        },
      );

      return undefined;
    }

    const normalizedConfig = {
      id: input.id,
      mode: input.mode,
      strategy: input.strategy,
      capital: input.capital ?? this.getDefaultPaperCapital(),
      riskLimits: input.riskLimits ?? {},
      label: input.label,
    };

    try {
      if (input.mode === 'LIVE') {
        return new PolymarketWallet(normalizedConfig as any);
      }

      return new PaperWallet(normalizedConfig as any);
    } catch (error) {
      logger.error(
        {
          error,
          walletId: input.id,
          mode: input.mode,
          strategy: input.strategy,
        },
        'Failed to create wallet',
      );

      consoleLog.error(
        'WALLET',
        `Failed to create wallet: ${input.id}`,
        {
          walletId: input.id,
          mode: input.mode,
          strategy: input.strategy,
          error: error instanceof Error ? error.message : String(error),
        },
      );

      return undefined;
    }
  }

  private applyWalletRuntimeUpdates(
    wallet: ManagedWallet,
    input: WalletBuildInput,
  ): void {
    try {
      if (typeof wallet?.updateRiskLimits === 'function') {
        wallet.updateRiskLimits(input.riskLimits ?? {});
      }

      if (typeof wallet?.setCapitalAllocated === 'function' && input.capital != null) {
        wallet.setCapitalAllocated(input.capital);
      }

      if (typeof wallet?.setLabel === 'function' && input.label) {
        wallet.setLabel(input.label);
      }
    } catch (error) {
      logger.warn(
        {
          error,
          walletId: input.id,
        },
        'Failed to apply runtime updates to wallet',
      );
    }
  }

  /* =========================================================
   * Helpers
   * ======================================================= */

  private normalizeMode(mode?: string): WalletMode {
    const normalized = String(mode ?? 'PAPER').toUpperCase();

    if (normalized === 'LIVE') return 'LIVE';
    if (normalized === 'DISABLED') return 'DISABLED';
    return 'PAPER';
  }

  private isLiveAllowed(): boolean {
    // Prioridad 1: runtime config efectiva
    if (this.runtimeConfig) {
      return Boolean(this.runtimeConfig.account.liveEnabled);
    }

    // Fallback legacy
    const yamlFlag = Boolean((this.config as any)?.environment?.enableLiveTrading);
    const envFlag =
      String(process.env.ENABLE_LIVE_TRADING ?? '').toLowerCase() === 'true';

    return yamlFlag && envFlag;
  }

  private getDefaultPaperCapital(): number {
    const paperCapital =
      (this.config as any)?.paper?.defaultStartingCapitalUsd ??
      (this.config as any)?.paper?.default_starting_capital_usd;

    if (typeof paperCapital === 'number' && Number.isFinite(paperCapital)) {
      return paperCapital;
    }

    return 10_000;
  }
}
