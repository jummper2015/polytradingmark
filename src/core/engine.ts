import { Scheduler } from './scheduler';
import { OrderbookStream } from '../data/orderbook_stream';
import { WalletManager } from '../wallets/wallet_manager';
import { OrderRouter } from '../execution/order_router';
import { StrategyInterface } from '../strategies/strategy_interface';
import { STRATEGY_REGISTRY } from '../strategies/registry';
import { AppConfig, MarketData } from '../types';
import type {
  EffectiveRuntimeConfig,
  StrategyRuntimePolicy,
} from '../config_runtime/types';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';

interface StrategyRunner {
  strategy: StrategyInterface;
  strategyKey: string;
  strategyRunId: string;
  walletId: string; // compat bridge: today order routing still uses walletId
  config: Record<string, unknown>;
  mode: 'PAPER' | 'LIVE' | 'DISABLED';
  enabled: boolean;
  executionState: 'ACTIVE' | 'PAUSED' | 'REDUCE_ONLY' | 'STOPPED';
  allocationUsd?: number;
  policy?: StrategyRuntimePolicy;
}

export class Engine {
  private readonly scheduler = new Scheduler();
  private readonly stream: OrderbookStream;

  // Transitional runtime config support
  private runtimeConfig: EffectiveRuntimeConfig | null = null;
  private initialized = false;
  private streamBound = false;

  // Keep runner management, but move internal keying to strategyRunId
  private readonly runners = new Map<string, StrategyRunner>();

  // Keep pause/resume behavior compatible with old dashboard semantics
  private readonly pausedRunnerIds = new Set<string>();

  // Keep old scan/tick counters
  private tickCount = 0;
  private marketUpdateCount = 0;
  private lastScanLog = 0;

  // Prevent overlapping ticks
  private tickRunning = false;

  constructor(
    private readonly config: AppConfig,
    private readonly walletManager: WalletManager,
    private readonly orderRouter: OrderRouter,
  ) {
    this.stream = new OrderbookStream(config.polymarket.gammaApi);
  }

  /* =========================================================
   * Runtime config integration
   * ======================================================= */

  async updateRuntimeConfig(config: EffectiveRuntimeConfig): Promise<void> {
    this.runtimeConfig = config;

    // If engine already initialized, rebuild active runners from runtime config
    if (this.initialized) {
      await this.rebuildRunnersFromRuntimeConfig();
    }
  }

  getRuntimeConfig(): EffectiveRuntimeConfig | null {
    return this.runtimeConfig;
  }

  /* =========================================================
   * Lifecycle
   * ======================================================= */

  async initialize(): Promise<void> {
    if (!this.streamBound) {
      this.stream.on('update', (data: MarketData) => this.handleMarketUpdate(data));
      this.streamBound = true;
    }

    // Transitional behavior:
    // - If runtime config is present, use it.
    // - Otherwise, fall back to the current wallet-based config.
    if (this.hasRuntimeStrategies()) {
      await this.rebuildRunnersFromRuntimeConfig();
    } else {
      await this.initializeLegacyRunners();
    }

    this.initialized = true;
  }

  start(): void {
    this.stream.start();
    this.scheduler.start(() => this.tick());

    logger.info({ runners: this.runners.size }, 'Engine started with LIVE Polymarket data');
    consoleLog.success(
      'ENGINE',
      `Engine started — ${this.runners.size} strategy runners active`,
      {
        runners: this.runners.size,
        strategies: [...new Set(Array.from(this.runners.values()).map((r) => r.strategy.name))],
      },
    );
  }

  stop(): void {
    this.scheduler.stop();
    this.stream.stop();

    logger.info('Engine stopped');
    consoleLog.warn('ENGINE', 'Engine stopped');
  }

  /** Expose the stream so the dashboard can query live market data */
  getStream(): OrderbookStream {
    return this.stream;
  }

  /* =========================================================
   * Runner bootstrap
   * ======================================================= */

  private hasRuntimeStrategies(): boolean {
    return Boolean(this.runtimeConfig?.strategies?.length);
  }

  private async initializeLegacyRunners(): Promise<void> {
    this.runners.clear();
    this.pausedRunnerIds.clear();

    const legacyConfig = this.config as unknown as {
      wallets?: Array<{
        id: string;
        strategy: string;
      }>;
      strategyConfig?: Record<string, Record<string, unknown>>;
    };

    const wallets = legacyConfig.wallets ?? [];
    const strategyConfig = legacyConfig.strategyConfig ?? {};

    for (const wallet of wallets) {
      const runner = this.buildLegacyRunner(
        wallet.id,
        wallet.strategy,
        strategyConfig[wallet.strategy] ?? {},
      );

      if (!runner) continue;

      this.runners.set(runner.strategyRunId, runner);

      const walletState = this.walletManager.getWallet(wallet.id)?.getState();

      consoleLog.info('STRATEGY', `Initialized "${wallet.strategy}" for wallet ${wallet.id}`, {
        walletId: wallet.id,
        strategy: wallet.strategy,
        capital: walletState?.capitalAllocated,
        mode: walletState?.mode,
      });
    }
  }

  private async rebuildRunnersFromRuntimeConfig(): Promise<void> {
    await this.shutdownAllRunners();

    if (!this.runtimeConfig) return;

    for (const policy of this.runtimeConfig.strategies) {
      if (!policy.enabled || policy.mode === 'DISABLED') {
        continue;
      }

      const runner = this.buildRuntimeRunner(policy);
      if (!runner) continue;

      this.runners.set(runner.strategyRunId, runner);

      if (runner.executionState === 'PAUSED') {
        this.pausedRunnerIds.add(runner.strategyRunId);
      }

      // Back-fill cached markets so the strategy has context immediately
      for (const market of this.stream.getAllMarkets()) {
        runner.strategy.onMarketUpdate(market);
      }

      consoleLog.info(
        'STRATEGY',
        `Initialized runtime strategy "${runner.strategyKey}" for ${runner.strategyRunId}`,
        {
          strategyRunId: runner.strategyRunId,
          walletId: runner.walletId,
          strategy: runner.strategyKey,
          mode: runner.mode,
          allocationUsd: runner.allocationUsd,
          cachedMarkets: this.stream.getAllMarkets().length,
        },
      );
    }
  }

  private async shutdownAllRunners(): Promise<void> {
    for (const runner of this.runners.values()) {
      try {
        await runner.strategy.shutdown();
      } catch (error) {
        logger.warn(
          { error, strategyRunId: runner.strategyRunId },
          'Runner shutdown failed during rebuild',
        );
      }
    }

    this.runners.clear();
    this.pausedRunnerIds.clear();
  }

  private buildLegacyRunner(
    walletId: string,
    strategyKey: string,
    cfg: Record<string, unknown>,
  ): StrategyRunner | null {
    const StrategyCtor = STRATEGY_REGISTRY[strategyKey];
    if (!StrategyCtor) {
      logger.warn({ strategy: strategyKey }, 'Unknown strategy; skipping');
      consoleLog.warn('ENGINE', `Unknown strategy "${strategyKey}" — skipping wallet ${walletId}`);
      return null;
    }

    const walletState = this.walletManager.getWallet(walletId)?.getState();
    if (!walletState) {
      logger.warn({ walletId }, 'Wallet state not found; skipping runner');
      return null;
    }

    const strategy = new StrategyCtor();
    strategy.initialize({
      wallet: walletState,
      config: cfg,
    });

    return {
      strategy,
      strategyKey,
      strategyRunId: walletId, // bridge in legacy mode
      walletId,
      config: cfg,
      mode: walletState.mode,
      enabled: true,
      executionState: 'ACTIVE',
    };
  }

  private buildRuntimeRunner(policy: StrategyRuntimePolicy): StrategyRunner | null {
    const StrategyCtor = STRATEGY_REGISTRY[policy.key];
    if (!StrategyCtor) {
      logger.warn({ strategy: policy.key }, 'Unknown runtime strategy; skipping');
      consoleLog.warn(
        'ENGINE',
        `Unknown runtime strategy "${policy.key}" — skipping ${policy.strategyRunId}`,
      );
      return null;
    }

    // Transitional bridge:
    // current StrategyInterface still wants wallet state,
    // so for now we resolve walletId = strategyRunId.
    const walletId = policy.strategyRunId;
    const walletState = this.walletManager.getWallet(walletId)?.getState();

    if (!walletState) {
      logger.warn(
        { strategyRunId: policy.strategyRunId, walletId },
        'No wallet found for runtime strategy; skipping runner',
      );
      consoleLog.warn(
        'ENGINE',
        `Runtime strategy ${policy.strategyRunId} skipped — wallet ${walletId} not found`,
        {
          strategyRunId: policy.strategyRunId,
          walletId,
          strategy: policy.key,
        },
      );
      return null;
    }

    const strategy = new StrategyCtor();
    const mergedConfig: Record<string, unknown> = {
      ...(policy.params ?? {}),
      universe: policy.universe,
      allocationUsd: this.resolveAllocationUsd(policy),
      strategyRunId: policy.strategyRunId,
      mode: policy.mode,
      executionState: policy.executionState,
    };

    strategy.initialize({
      wallet: walletState,
      config: mergedConfig,
    });

    return {
      strategy,
      strategyKey: policy.key,
      strategyRunId: policy.strategyRunId,
      walletId,
      config: mergedConfig,
      mode: policy.mode,
      enabled: policy.enabled,
      executionState: policy.executionState,
      allocationUsd: this.resolveAllocationUsd(policy),
      policy,
    };
  }

  private resolveAllocationUsd(policy: StrategyRuntimePolicy): number {
    return policy.allocation.resolvedUsd ?? policy.allocation.value;
  }

  /* =========================================================
   * Runtime runner management
   * Keep compatibility with the old dashboard-driven methods.
   * ======================================================= */

  /**
   * Add a strategy runner for a wallet created at runtime.
   * Legacy-compatible path.
   */
  addRunner(walletId: string, strategyKey: string): boolean {
    if (this.findRunnerByAnyId(walletId)) {
      logger.warn({ walletId }, 'Runner already exists for wallet/strategyRunId');
      return false;
    }

    const legacyConfig = this.config as unknown as {
      strategyConfig?: Record<string, Record<string, unknown>>;
    };
    const cfg = legacyConfig.strategyConfig?.[strategyKey] ?? {};

    const runner = this.buildLegacyRunner(walletId, strategyKey, cfg);
    if (!runner) return false;

    this.runners.set(runner.strategyRunId, runner);

    // Back-fill cached market data so the strategy can evaluate immediately
    for (const market of this.stream.getAllMarkets()) {
      runner.strategy.onMarketUpdate(market);
    }

    logger.info(
      {
        walletId,
        strategy: strategyKey,
        cachedMarkets: this.stream.getAllMarkets().length,
      },
      `Runtime runner added for wallet ${walletId} (${strategyKey})`,
    );

    consoleLog.success('WALLET', `Runtime runner added: ${walletId} → ${strategyKey}`, {
      walletId,
      strategy: strategyKey,
      cachedMarkets: this.stream.getAllMarkets().length,
    });

    return true;
  }

  /**
   * Remove a runner by walletId or strategyRunId.
   */
  removeRunner(id: string): boolean {
    const runner = this.findRunnerByAnyId(id);
    if (!runner) return false;

    void runner.strategy.shutdown();

    this.runners.delete(runner.strategyRunId);
    this.pausedRunnerIds.delete(runner.strategyRunId);
    this.pausedRunnerIds.delete(runner.walletId);

    logger.info(
      { id, strategyRunId: runner.strategyRunId, walletId: runner.walletId },
      'Runtime runner removed',
    );

    consoleLog.warn('WALLET', `Runner removed: ${id} (${runner.strategy.name})`, {
      id,
      strategyRunId: runner.strategyRunId,
      walletId: runner.walletId,
      strategy: runner.strategy.name,
      remainingRunners: this.runners.size,
    });

    return true;
  }

  /** Number of active strategy runners. */
  getRunnerCount(): number {
    return this.runners.size;
  }

  /** Get all strategy instances matching a strategy name/key. */
  getStrategiesByName(strategyName: string): StrategyInterface[] {
    return Array.from(this.runners.values())
      .filter((r) => r.strategyKey === strategyName || r.strategy.name === strategyName)
      .map((r) => r.strategy);
  }

  listRunners(): StrategyRunner[] {
    return Array.from(this.runners.values());
  }

  /* =========================================================
   * Pause / Resume
   * ======================================================= */

  pauseRunner(id: string): boolean {
    const runner = this.findRunnerByAnyId(id);
    if (!runner) return false;

    runner.executionState = 'PAUSED';
    this.pausedRunnerIds.add(runner.strategyRunId);
    this.pausedRunnerIds.add(runner.walletId);

    consoleLog.warn('ENGINE', `Runner paused: ${id}`, {
      id,
      strategyRunId: runner.strategyRunId,
      walletId: runner.walletId,
    });

    return true;
  }

  resumeRunner(id: string): boolean {
    const runner = this.findRunnerByAnyId(id);
    if (!runner) return false;

    runner.executionState = 'ACTIVE';
    this.pausedRunnerIds.delete(runner.strategyRunId);
    this.pausedRunnerIds.delete(runner.walletId);

    consoleLog.success('ENGINE', `Runner resumed: ${id}`, {
      id,
      strategyRunId: runner.strategyRunId,
      walletId: runner.walletId,
    });

    return true;
  }

  isRunnerPaused(id: string): boolean {
    const runner = this.findRunnerByAnyId(id);
    if (!runner) return false;

    return (
      this.pausedRunnerIds.has(runner.strategyRunId) ||
      this.pausedRunnerIds.has(runner.walletId) ||
      runner.executionState === 'PAUSED'
    );
  }

  /**
   * Kept for compatibility with the current dashboard naming.
   */
  getPausedWallets(): Set<string> {
    return new Set(this.pausedRunnerIds);
  }

  /* =========================================================
   * Core loop
   * ======================================================= */

  private async tick(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;

    try {
      this.tickCount++;

      // Periodic summary every ~60 seconds (12 ticks x 5s)
      if (this.tickCount % 12 === 0) {
        consoleLog.debug(
          'ENGINE',
          `Tick #${this.tickCount} — ${this.runners.size} runners, ${this.stream.getAllMarkets().length} cached markets, ${this.marketUpdateCount} updates since last summary`,
        );
        this.marketUpdateCount = 0;
      }

      for (const runner of this.runners.values()) {
        if (!runner.enabled) continue;
        if (runner.executionState === 'STOPPED') continue;
        if (this.isRunnerPaused(runner.strategyRunId)) continue;

        await runner.strategy.onTimer();
        await this.processSignals(runner);
      }
    } finally {
      this.tickRunning = false;
    }
  }

  private handleMarketUpdate(data: MarketData): void {
    this.marketUpdateCount++;

    // Throttle per-market scan logs
    const now = Date.now();
    if (now - this.lastScanLog > 30_000) {
      consoleLog.debug(
        'SCAN',
        `Market update: ${data.marketId?.slice(0, 12)}… — ${data.outcomes?.length ?? 0} outcomes`,
        {
          marketId: data.marketId,
          question: data.question?.slice(0, 80),
        },
      );
      this.lastScanLog = now;
    }

    // Keep old behavior: even paused runners still receive market updates to stay in sync
    for (const runner of this.runners.values()) {
      try {
        runner.strategy.onMarketUpdate(data);
      } catch (error) {
        logger.warn(
          { error, strategyRunId: runner.strategyRunId, marketId: data.marketId },
          'Strategy onMarketUpdate failed',
        );
      }
    }
  }

  private async processSignals(runner: StrategyRunner): Promise<void> {
    const signals = await runner.strategy.generateSignals();

    if (signals.length > 0) {
      consoleLog.info(
        'SIGNAL',
        `[${runner.strategy.name}] Generated ${signals.length} signal(s) for wallet ${runner.walletId}`,
        {
          walletId: runner.walletId,
          strategyRunId: runner.strategyRunId,
          strategy: runner.strategy.name,
          signals: signals.map((s: any) => ({
            market: s.marketId.slice(0, 12) + '…',
            outcome: s.outcome,
            side: s.side,
            confidence: Number((s.confidence ?? 0).toFixed(3)),
            edge: Number((s.edge ?? 0).toFixed(4)),
          })),
        },
      );
    }

    const orders = await runner.strategy.sizePositions(signals);

    if (orders.length > 0) {
      consoleLog.info(
        'ORDER',
        `[${runner.strategy.name}] Sized ${orders.length} order(s) for wallet ${runner.walletId}`,
        {
          walletId: runner.walletId,
          strategyRunId: runner.strategyRunId,
          strategy: runner.strategy.name,
          orders: orders.map((o: any) => ({
            market: o.marketId.slice(0, 12) + '…',
            outcome: o.outcome,
            side: o.side,
            price: o.price,
            size: o.size,
          })),
        },
      );
    }

    // Entry/new orders
    for (const rawOrder of orders) {
      const order = this.enrichOrder(rawOrder, runner);

      // MVP behavior for REDUCE_ONLY:
      // skip entry/new orders, but still allow managePositions + exit orders below
      if (runner.executionState === 'REDUCE_ONLY') {
        continue;
      }

      try {
        const executed = await this.orderRouter.route(order);

        if (executed) {
          runner.strategy.notifyFill(order);

          consoleLog.success(
            'FILL',
            `[${runner.strategy.name}] Executed ${order.side} ${order.outcome} ×${order.size} @ $${order.price.toFixed(4)}`,
            {
              walletId: order.walletId,
              strategyRunId: runner.strategyRunId,
              strategy: order.strategy,
              marketId: order.marketId,
              outcome: order.outcome,
              side: order.side,
              price: order.price,
              size: order.size,
              cost: Number((order.price * order.size).toFixed(4)),
            },
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        consoleLog.error('ORDER', `[${runner.strategy.name}] Order failed: ${msg}`, {
          walletId: order.walletId,
          strategyRunId: runner.strategyRunId,
          marketId: order.marketId,
          error: msg,
        });
      }
    }

    // Manage open positions
    await runner.strategy.managePositions();

    /* ── Route exit orders produced by managePositions() ── */
    const exitOrders = runner.strategy.drainExitOrders();

    if (exitOrders.length > 0) {
      consoleLog.info(
        'ORDER',
        `[${runner.strategy.name}] ${exitOrders.length} exit order(s) for wallet ${runner.walletId}`,
        {
          walletId: runner.walletId,
          strategyRunId: runner.strategyRunId,
          strategy: runner.strategy.name,
          exits: exitOrders.map((o: any) => ({
            market: o.marketId.slice(0, 12) + '…',
            outcome: o.outcome,
            side: o.side,
            price: o.price,
            size: o.size,
          })),
        },
      );
    }

    for (const rawExitOrder of exitOrders) {
      const exitOrder = this.enrichOrder(rawExitOrder, runner);

      try {
        const executed = await this.orderRouter.route(exitOrder);

        if (executed) {
          consoleLog.success(
            'FILL',
            `[${runner.strategy.name}] Exited ${exitOrder.outcome} ×${exitOrder.size} @ $${exitOrder.price.toFixed(4)}`,
            {
              walletId: exitOrder.walletId,
              strategyRunId: runner.strategyRunId,
              strategy: exitOrder.strategy,
              marketId: exitOrder.marketId,
              outcome: exitOrder.outcome,
              side: exitOrder.side,
              price: exitOrder.price,
              size: exitOrder.size,
            },
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        consoleLog.error('ORDER', `[${runner.strategy.name}] Exit order failed: ${msg}`, {
          walletId: exitOrder.walletId,
          strategyRunId: runner.strategyRunId,
          marketId: exitOrder.marketId,
          error: msg,
        });
      }
    }
  }

  /* =========================================================
   * Helpers
   * ======================================================= */

  private enrichOrder(rawOrder: any, runner: StrategyRunner): any {
    return {
      ...rawOrder,
      walletId: rawOrder.walletId ?? runner.walletId,
      strategy: rawOrder.strategy ?? runner.strategy.name,
      strategyRunId: rawOrder.strategyRunId ?? runner.strategyRunId,
    };
  }

  private findRunnerByAnyId(id: string): StrategyRunner | undefined {
    return (
      this.runners.get(id) ??
      Array.from(this.runners.values()).find(
        (r) => r.walletId === id || r.strategyRunId === id,
      )
    );
  }
}
