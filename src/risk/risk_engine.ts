import { AppConfig, OrderRequest, WalletState } from '../types';
import { KillSwitch } from './kill_switch';
import type {
  EffectiveRuntimeConfig,
  StrategyRuntimePolicy,
} from '../config_runtime/types';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';

interface EffectiveRiskLimits {
  maxPositionUsd?: number;
  maxExposurePerMarketUsd?: number;
  maxExposurePerEventUsd?: number;
  maxOpenPositions?: number;
  maxDailyLossUsd?: number;
  maxDrawdownPct?: number;
  maxOrdersPerMinute?: number;
  maxCancelRate?: number;
  cooldownMsPerMarket?: number;
}

interface AccountRuntimeSnapshot {
  currentExposureUsd: number;
  openOrders: number;
  dailyPnlUsd: number;
  peakEquityUsd: number;
  currentEquityUsd: number;
}

export class RiskEngine {
  private runtimeConfig: EffectiveRuntimeConfig | null = null;
  private readonly strategyPolicyById = new Map<string, StrategyRuntimePolicy>();

  private readonly lastRejectReasonByScope = new Map<string, string>();
  private readonly orderTimestampsByScope = new Map<string, number[]>();
  private readonly cancelStatsByScope = new Map<
    string,
    { submissions: number; cancels: number }
  >();

  // Kept for compatibility with the current codebase
  private readonly walletMle = new Map<string, number>();

  // Transitional global/account snapshot
  private accountRuntimeSnapshot: AccountRuntimeSnapshot = {
    currentExposureUsd: 0,
    openOrders: 0,
    dailyPnlUsd: 0,
    peakEquityUsd: 0,
    currentEquityUsd: 0,
  };

  private globalOrderTimestamps: number[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly killSwitch: KillSwitch,
  ) {}

  /* =========================================================
   * Runtime config integration
   * ======================================================= */

  updateRuntimeConfig(config: EffectiveRuntimeConfig): void {
    this.runtimeConfig = config;
    this.strategyPolicyById.clear();

    for (const strategy of config.strategies) {
      this.strategyPolicyById.set(strategy.strategyRunId, strategy);
    }
  }

  getRuntimeConfig(): EffectiveRuntimeConfig | null {
    return this.runtimeConfig;
  }

  getStrategyPolicy(strategyRunId: string): StrategyRuntimePolicy | undefined {
    return this.strategyPolicyById.get(strategyRunId);
  }

  updateAccountRuntimeSnapshot(
    snapshot: Partial<AccountRuntimeSnapshot>,
  ): void {
    this.accountRuntimeSnapshot = {
      ...this.accountRuntimeSnapshot,
      ...snapshot,
    };
  }

  getLastRejectReason(scopeId: string): string | undefined {
    return this.lastRejectReasonByScope.get(scopeId);
  }

  /* =========================================================
   * Public risk API
   * ======================================================= */

  check(order: OrderRequest & Record<string, any>, wallet: WalletState): boolean {
    const scopeId = this.resolveScopeId(order, wallet);

    this.lastRejectReasonByScope.delete(scopeId);

    // 1) Global kill switch
    if (this.killSwitch.isActive()) {
      return this.reject(
        scopeId,
        'Kill switch activo: no se permiten nuevas órdenes.',
        { scopeId, marketId: order.marketId },
      );
    }

    // 2) Runtime account kill switch
    if (this.runtimeConfig?.account?.risk?.killSwitch) {
      return this.reject(
        scopeId,
        'Kill switch runtime activo: no se permiten nuevas órdenes.',
        { scopeId, marketId: order.marketId },
      );
    }

    // 3) Resolve strategy policy if present
    const strategyPolicy = this.resolveStrategyPolicy(order, wallet);

    // 4) Execution state checks
    if (strategyPolicy?.executionState === 'STOPPED') {
      return this.reject(
        scopeId,
        'La estrategia está en STOPPED.',
        { scopeId, strategyRunId: strategyPolicy.strategyRunId },
      );
    }

    if (strategyPolicy?.executionState === 'PAUSED') {
      return this.reject(
        scopeId,
        'La estrategia está en PAUSED.',
        { scopeId, strategyRunId: strategyPolicy.strategyRunId },
      );
    }

    // MVP behavior:
    // In REDUCE_ONLY we block BUY orders as a conservative approximation.
    // Exit logic can continue with SELLs if your strategies emit them that way.
    if (
      strategyPolicy?.executionState === 'REDUCE_ONLY' &&
      String(order.side).toUpperCase() === 'BUY'
    ) {
      return this.reject(
        scopeId,
        'La estrategia está en REDUCE_ONLY; no se permiten nuevas entradas BUY.',
        { scopeId, strategyRunId: strategyPolicy.strategyRunId },
      );
    }

    // 5) Resolve effective limits
    const limits = this.resolveEffectiveRiskLimits(order, wallet, strategyPolicy);
    const accountRisk = this.runtimeConfig?.account?.risk ?? {};

    const notionalUsd = this.getOrderNotionalUsd(order);
    const availableBalanceUsd = this.getAvailableBalanceUsd(wallet);

    // 6) Balance check
    if (
      String(order.side).toUpperCase() === 'BUY' &&
      notionalUsd > availableBalanceUsd
    ) {
      return this.reject(
        scopeId,
        `Balance insuficiente. Notional=${notionalUsd.toFixed(2)} > available=${availableBalanceUsd.toFixed(2)}`,
        { scopeId, notionalUsd, availableBalanceUsd },
      );
    }

    // 7) Max position size
    if (
      limits.maxPositionUsd != null &&
      notionalUsd > limits.maxPositionUsd
    ) {
      return this.reject(
        scopeId,
        `La orden excede maxPositionUsd (${limits.maxPositionUsd}).`,
        { scopeId, notionalUsd, maxPositionUsd: limits.maxPositionUsd },
      );
    }

    // 8) Market exposure
    const marketExposureUsd = this.getMarketExposureUsd(wallet, order.marketId);
    if (
      limits.maxExposurePerMarketUsd != null &&
      marketExposureUsd + notionalUsd > limits.maxExposurePerMarketUsd
    ) {
      return this.reject(
        scopeId,
        `La exposición por mercado excede el límite.`,
        {
          scopeId,
          marketId: order.marketId,
          currentExposureUsd: marketExposureUsd,
          orderNotionalUsd: notionalUsd,
          maxExposurePerMarketUsd: limits.maxExposurePerMarketUsd,
        },
      );
    }

    // 9) Event exposure (best effort / transitional)
    const orderEventKey = this.getOrderEventKey(order);
    if (orderEventKey && limits.maxExposurePerEventUsd != null) {
      const eventExposureUsd = this.getEventExposureUsd(wallet, orderEventKey);

      if (eventExposureUsd + notionalUsd > limits.maxExposurePerEventUsd) {
        return this.reject(
          scopeId,
          `La exposición por evento excede el límite.`,
          {
            scopeId,
            eventKey: orderEventKey,
            currentExposureUsd: eventExposureUsd,
            orderNotionalUsd: notionalUsd,
            maxExposurePerEventUsd: limits.maxExposurePerEventUsd,
          },
        );
      }
    }

    // 10) Max open positions
    const openPositions = this.getOpenPositions(wallet);
    const hasPositionAlready = openPositions.some(
      (p: any) =>
        p.marketId === order.marketId &&
        (p.outcome === order.outcome || p.outcome == null),
    );

    if (
      limits.maxOpenPositions != null &&
      !hasPositionAlready &&
      openPositions.length >= limits.maxOpenPositions
    ) {
      return this.reject(
        scopeId,
        `Se alcanzó el máximo de posiciones abiertas (${limits.maxOpenPositions}).`,
        {
          scopeId,
          openPositions: openPositions.length,
          maxOpenPositions: limits.maxOpenPositions,
        },
      );
    }

    // 11) Daily loss
    const dailyLossUsd = this.getDailyLossUsd(wallet);
    const effectiveDailyLossLimit =
      limits.maxDailyLossUsd ?? accountRisk.maxDailyLossUsd;

    if (
      effectiveDailyLossLimit != null &&
      dailyLossUsd >= effectiveDailyLossLimit
    ) {
      return this.reject(
        scopeId,
        `Se alcanzó la pérdida diaria máxima.`,
        {
          scopeId,
          dailyLossUsd,
          maxDailyLossUsd: effectiveDailyLossLimit,
        },
      );
    }

    // 12) Drawdown
    const drawdownPct = this.getDrawdownPct(wallet);
    const effectiveDrawdownLimit =
      limits.maxDrawdownPct ?? accountRisk.maxDrawdownPct;

    if (
      effectiveDrawdownLimit != null &&
      drawdownPct >= effectiveDrawdownLimit
    ) {
      return this.reject(
        scopeId,
        `Se alcanzó el drawdown máximo permitido.`,
        {
          scopeId,
          drawdownPct,
          maxDrawdownPct: effectiveDrawdownLimit,
        },
      );
    }

    // 13) Strategy order rate limit
    if (
      limits.maxOrdersPerMinute != null &&
      !this.withinScopedRateLimit(scopeId, limits.maxOrdersPerMinute)
    ) {
      return this.reject(
        scopeId,
        `Se alcanzó el máximo de órdenes por minuto para la estrategia.`,
        {
          scopeId,
          maxOrdersPerMinute: limits.maxOrdersPerMinute,
        },
      );
    }

    // 14) Account order rate limit
    if (
      accountRisk.maxOrdersPerMinute != null &&
      !this.withinGlobalRateLimit(accountRisk.maxOrdersPerMinute)
    ) {
      return this.reject(
        scopeId,
        `Se alcanzó el máximo global de órdenes por minuto.`,
        {
          scopeId,
          maxOrdersPerMinute: accountRisk.maxOrdersPerMinute,
        },
      );
    }

    // 15) Cancel rate
    if (
      limits.maxCancelRate != null &&
      this.getCancelRate(scopeId) > limits.maxCancelRate
    ) {
      return this.reject(
        scopeId,
        `Cancel rate excedido.`,
        {
          scopeId,
          cancelRate: this.getCancelRate(scopeId),
          maxCancelRate: limits.maxCancelRate,
        },
      );
    }

    // 16) Account total exposure (best effort / transitional)
    if (
      accountRisk.maxTotalExposureUsd != null &&
      this.accountRuntimeSnapshot.currentExposureUsd + notionalUsd >
        accountRisk.maxTotalExposureUsd
    ) {
      return this.reject(
        scopeId,
        `La exposición total de cuenta excede el límite.`,
        {
          scopeId,
          currentExposureUsd: this.accountRuntimeSnapshot.currentExposureUsd,
          orderNotionalUsd: notionalUsd,
          maxTotalExposureUsd: accountRisk.maxTotalExposureUsd,
        },
      );
    }

    // 17) Account open orders (best effort / transitional)
    if (
      accountRisk.maxOpenOrders != null &&
      this.accountRuntimeSnapshot.openOrders >= accountRisk.maxOpenOrders
    ) {
      return this.reject(
        scopeId,
        `Se alcanzó el máximo de órdenes abiertas a nivel cuenta.`,
        {
          scopeId,
          openOrders: this.accountRuntimeSnapshot.openOrders,
          maxOpenOrders: accountRisk.maxOpenOrders,
        },
      );
    }

    // Accepted -> record submission stats
    this.recordOrder(scopeId);
    return true;
  }

  /* =========================================================
   * Legacy-compatible telemetry helpers
   * ======================================================= */

  recordCancel(id: string): void {
    const key = id;
    const current = this.cancelStatsByScope.get(key) ?? {
      submissions: 0,
      cancels: 0,
    };

    current.cancels += 1;
    this.cancelStatsByScope.set(key, current);
  }

  getCancelRate(id: string): number {
    const stats = this.cancelStatsByScope.get(id);
    if (!stats || stats.submissions <= 0) return 0;
    return stats.cancels / stats.submissions;
  }

  setWalletMle(id: string, value: number): void {
    this.walletMle.set(id, value);
  }

  getWalletMle(id: string): number | undefined {
    return this.walletMle.get(id);
  }

  /* =========================================================
   * Effective policy resolution
   * ======================================================= */

  private resolveStrategyPolicy(
    order: OrderRequest & Record<string, any>,
    wallet: WalletState,
  ): StrategyRuntimePolicy | undefined {
    const strategyRunId =
      order.strategyRunId ??
      order.walletId ??
      (wallet as any)?.id;

    if (!strategyRunId) return undefined;
    return this.strategyPolicyById.get(strategyRunId);
  }

  private resolveEffectiveRiskLimits(
    order: OrderRequest & Record<string, any>,
    wallet: WalletState,
    strategyPolicy?: StrategyRuntimePolicy,
  ): EffectiveRiskLimits {
    const legacy = this.resolveLegacyRiskLimits(order, wallet);
    const runtimeRisk = strategyPolicy?.risk ?? {};

    return {
      maxPositionUsd:
        runtimeRisk.maxPositionUsd ??
        legacy.maxPositionUsd,

      maxExposurePerMarketUsd:
        runtimeRisk.maxExposurePerMarketUsd ??
        legacy.maxExposurePerMarketUsd,

      maxExposurePerEventUsd:
        runtimeRisk.maxExposurePerEventUsd,

      maxOpenPositions:
        runtimeRisk.maxOpenPositions ??
        legacy.maxOpenPositions,

      maxDailyLossUsd:
        runtimeRisk.maxDailyLossUsd ??
        legacy.maxDailyLossUsd,

      maxDrawdownPct:
        runtimeRisk.maxDrawdownPct ??
        legacy.maxDrawdownPct,

      maxOrdersPerMinute:
        runtimeRisk.maxOrdersPerMinute ??
        legacy.maxOrdersPerMinute,

      maxCancelRate:
        runtimeRisk.maxCancelRate ??
        legacy.maxCancelRate,

      cooldownMsPerMarket:
        runtimeRisk.cooldownMsPerMarket,
    };
  }

  private resolveLegacyRiskLimits(
    order: OrderRequest & Record<string, any>,
    wallet: WalletState,
  ): EffectiveRiskLimits {
    const stateLimits = (wallet as any)?.riskLimits ?? {};
    const walletId = order.walletId ?? (wallet as any)?.id;

    const appConfigAny = this.config as any;
    const walletConfig =
      appConfigAny?.wallets?.find((w: any) => w.id === walletId) ?? {};

    const cfgLimits =
      walletConfig.riskLimits ??
      walletConfig.risk_limits ??
      {};

    const merged = {
      ...cfgLimits,
      ...stateLimits,
    };

    return {
      maxPositionUsd:
        merged.maxPositionUsd ??
        merged.max_position_usd ??
        merged.maxPositionSize ??
        merged.max_position_size,

      maxExposurePerMarketUsd:
        merged.maxExposurePerMarketUsd ??
        merged.max_exposure_per_market_usd ??
        merged.maxExposurePerMarket ??
        merged.max_exposure_per_market,

      maxOpenPositions:
        merged.maxOpenPositions ??
        merged.max_open_positions ??
        merged.maxOpenTrades ??
        merged.max_open_trades,

      maxDailyLossUsd:
        merged.maxDailyLossUsd ??
        merged.max_daily_loss_usd ??
        merged.maxDailyLoss ??
        merged.max_daily_loss,

      maxDrawdownPct:
        merged.maxDrawdownPct ??
        merged.max_drawdown_pct ??
        merged.maxDrawdown ??
        merged.max_drawdown,

      maxOrdersPerMinute:
        merged.maxOrdersPerMinute ??
        merged.max_orders_per_minute,

      maxCancelRate:
        merged.maxCancelRate ??
        merged.max_cancel_rate,
    };
  }

  /* =========================================================
   * Exposure / state helpers
   * ======================================================= */

  private getAvailableBalanceUsd(wallet: WalletState): number {
    return Number(
      (wallet as any)?.availableBalance ??
        (wallet as any)?.balance ??
        0,
    );
  }

  private getOrderNotionalUsd(order: OrderRequest & Record<string, any>): number {
    const price = Number(order.price ?? 0);
    const size = Number(order.size ?? 0);
    return Math.max(0, price * size);
  }

  private getOpenPositions(wallet: WalletState): any[] {
    const positions = (wallet as any)?.openPositions ?? [];
    if (!Array.isArray(positions)) return [];
    return positions.filter((p) => Number(p?.size ?? p?.shares ?? 0) > 0);
  }

  private getMarketExposureUsd(wallet: WalletState, marketId: string): number {
    return this.getOpenPositions(wallet)
      .filter((p: any) => p.marketId === marketId)
      .reduce((sum: number, p: any) => {
        const size = Number(p.size ?? p.shares ?? 0);
        const price = Number(p.avgPrice ?? p.avgEntryPrice ?? 0);
        return sum + Math.abs(size * price);
      }, 0);
  }

  private getEventExposureUsd(wallet: WalletState, eventKey: string): number {
    return this.getOpenPositions(wallet)
      .filter((p: any) => {
        return (
          p.eventId === eventKey ||
          p.eventSlug === eventKey ||
          p.seriesSlug === eventKey
        );
      })
      .reduce((sum: number, p: any) => {
        const size = Number(p.size ?? p.shares ?? 0);
        const price = Number(p.avgPrice ?? p.avgEntryPrice ?? 0);
        return sum + Math.abs(size * price);
      }, 0);
  }

  private getOrderEventKey(order: OrderRequest & Record<string, any>): string | undefined {
    return order.eventId ?? order.eventSlug ?? order.seriesSlug;
  }

  private getDailyLossUsd(wallet: WalletState): number {
    const dailyPnl =
      Number((wallet as any)?.dailyPnl ?? NaN);

    if (Number.isFinite(dailyPnl)) {
      return dailyPnl < 0 ? Math.abs(dailyPnl) : 0;
    }

    const realizedPnl =
      Number((wallet as any)?.realizedPnl ?? NaN);

    if (Number.isFinite(realizedPnl)) {
      return realizedPnl < 0 ? Math.abs(realizedPnl) : 0;
    }

    return 0;
  }

  private getDrawdownPct(wallet: WalletState): number {
    const directDrawdown =
      Number((wallet as any)?.drawdownPct ?? NaN);

    if (Number.isFinite(directDrawdown)) {
      return Math.max(0, directDrawdown);
    }

    const peakEquity = Number(
      (wallet as any)?.peakEquity ??
        (wallet as any)?.capitalAllocated ??
        (wallet as any)?.startingCapital ??
        0,
    );

    const currentEquity = Number(
      (wallet as any)?.currentEquity ??
        ((wallet as any)?.capitalAllocated ?? 0) +
          ((wallet as any)?.realizedPnl ?? 0),
    );

    if (peakEquity <= 0) return 0;

    const dd = (peakEquity - currentEquity) / peakEquity;
    return Math.max(0, dd);
  }

  /* =========================================================
   * Rate limiting
   * ======================================================= */

  private recordOrder(scopeId: string): void {
    const now = Date.now();

    // per-scope
    const scoped = this.orderTimestampsByScope.get(scopeId) ?? [];
    const nextScoped = this.pruneOldTimestamps([...scoped, now], now);
    this.orderTimestampsByScope.set(scopeId, nextScoped);

    // global
    this.globalOrderTimestamps = this.pruneOldTimestamps(
      [...this.globalOrderTimestamps, now],
      now,
    );

    // submissions for cancel-rate
    const stats = this.cancelStatsByScope.get(scopeId) ?? {
      submissions: 0,
      cancels: 0,
    };
    stats.submissions += 1;
    this.cancelStatsByScope.set(scopeId, stats);
  }

  private withinScopedRateLimit(scopeId: string, maxOrdersPerMinute: number): boolean {
    const now = Date.now();
    const timestamps = this.pruneOldTimestamps(
      this.orderTimestampsByScope.get(scopeId) ?? [],
      now,
    );

    this.orderTimestampsByScope.set(scopeId, timestamps);
    return timestamps.length < maxOrdersPerMinute;
  }

  private withinGlobalRateLimit(maxOrdersPerMinute: number): boolean {
    const now = Date.now();
    this.globalOrderTimestamps = this.pruneOldTimestamps(
      this.globalOrderTimestamps,
      now,
    );

    return this.globalOrderTimestamps.length < maxOrdersPerMinute;
  }

  private pruneOldTimestamps(timestamps: number[], now: number): number[] {
    const oneMinuteAgo = now - 60_000;
    return timestamps.filter((ts) => ts >= oneMinuteAgo);
  }

  /* =========================================================
   * Misc helpers
   * ======================================================= */

  private resolveScopeId(
    order: OrderRequest & Record<string, any>,
    wallet: WalletState,
  ): string {
    return (
      order.strategyRunId ??
      order.walletId ??
      (wallet as any)?.id ??
      'unknown-scope'
    );
  }

  private reject(
    scopeId: string,
    reason: string,
    meta?: Record<string, unknown>,
  ): false {
    this.lastRejectReasonByScope.set(scopeId, reason);

    logger.warn(
      { scopeId, ...meta, reason },
      'Risk check rejected order',
    );

    consoleLog.warn('RISK', reason, {
      scopeId,
      ...meta,
    });

    return false;
  }
}
