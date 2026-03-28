import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';
import { FillSimulator } from '../paper_trading/fill_simulator';
import { PnlTracker } from '../paper_trading/pnl_tracker';

type WalletMode = 'PAPER' | 'LIVE' | 'DISABLED';

interface PaperWalletConfig {
  id: string;
  mode?: WalletMode;
  strategy?: string;
  capital?: number;
  riskLimits?: Record<string, unknown>;
  label?: string;
}

interface PaperOrderInput {
  marketId: string;
  outcome: string;
  side: string;
  price: number;
  size: number;

  // campos opcionales enriquecidos
  strategyRunId?: string;
  eventId?: string;
  eventSlug?: string;
  seriesSlug?: string;
  question?: string;
  slug?: string;

  [key: string]: unknown;
}

interface PaperPosition {
  marketId: string;
  outcome: string;

  size: number;
  shares?: number;

  avgPrice: number;
  avgEntryPrice?: number;

  realizedPnl?: number;

  eventId?: string;
  eventSlug?: string;
  seriesSlug?: string;
  question?: string;
  slug?: string;

  openedAt?: number;
  updatedAt?: number;

  [key: string]: unknown;
}

interface PaperTradeRecord {
  tradeId: string;
  walletId: string;
  strategy?: string;
  strategyRunId?: string;

  marketId: string;
  outcome: string;
  side: string;

  price: number;
  size: number;
  notional: number;

  realizedPnl?: number;

  eventId?: string;
  eventSlug?: string;
  seriesSlug?: string;
  question?: string;
  slug?: string;

  timestamp: number;
  meta?: Record<string, unknown>;
}

export class PaperWallet {
  private readonly walletId: string;
  private readonly mode: WalletMode;
  private readonly assignedStrategy?: string;

  private capitalAllocated: number;
  private availableBalance: number;
  private realizedPnl = 0;
  private dailyPnl = 0;

  private peakEquity: number;
  private currentEquity: number;
  private drawdownPct = 0;

  private riskLimits: Record<string, unknown>;
  private openPositions: PaperPosition[] = [];
  private tradeHistory: PaperTradeRecord[] = [];

  private label?: string;

  // Mantengo estos módulos porque ya existen en el repo.
  // Los uso de forma tolerante para no depender de una firma exacta.
  private readonly fillSimulator: any;
  private readonly pnlTracker: any;

  constructor(config: PaperWalletConfig) {
    this.walletId = config.id;
    this.mode = 'PAPER';
    this.assignedStrategy = config.strategy;
    this.capitalAllocated = Number(config.capital ?? 10000);
    this.availableBalance = this.capitalAllocated;
    this.peakEquity = this.capitalAllocated;
    this.currentEquity = this.capitalAllocated;
    this.riskLimits = { ...(config.riskLimits ?? {}) };
    this.label = config.label;

    this.fillSimulator = new FillSimulator();
    this.pnlTracker = new PnlTracker();

    logger.info(
      {
        walletId: this.walletId,
        strategy: this.assignedStrategy,
        capital: this.capitalAllocated,
      },
      'PaperWallet initialized',
    );

    consoleLog.info(
      'WALLET',
      `PaperWallet initialized: ${this.walletId}`,
      {
        walletId: this.walletId,
        strategy: this.assignedStrategy,
        capital: this.capitalAllocated,
      },
    );
  }

  /* =========================================================
   * Public API
   * ======================================================= */

  getState(): Record<string, unknown> {
    this.refreshDerivedState();

    return {
      walletId: this.walletId,
      id: this.walletId,
      mode: this.mode,
      assignedStrategy: this.assignedStrategy,
      capitalAllocated: this.capitalAllocated,
      availableBalance: this.availableBalance,
      balance: this.availableBalance,
      openPositions: this.clone(this.openPositions),
      realizedPnl: this.realizedPnl,
      dailyPnl: this.dailyPnl,
      peakEquity: this.peakEquity,
      currentEquity: this.currentEquity,
      drawdownPct: this.drawdownPct,
      riskLimits: { ...this.riskLimits },
      label: this.label,
    };
  }

  getTradeHistory(): PaperTradeRecord[] {
    return this.clone(this.tradeHistory);
  }

  getName(): string {
    return this.label ?? this.walletId;
  }

  setLabel(label: string): void {
    this.label = label;
  }

  updateRiskLimits(nextRiskLimits: Record<string, unknown>): void {
    this.riskLimits = {
      ...this.riskLimits,
      ...nextRiskLimits,
    };
  }

  setCapitalAllocated(nextCapital: number): void {
    if (!Number.isFinite(nextCapital) || nextCapital <= 0) {
      throw new Error('setCapitalAllocated: capital inválido');
    }

    const oldCapital = this.capitalAllocated;
    const delta = nextCapital - oldCapital;

    this.capitalAllocated = nextCapital;
    this.availableBalance += delta;

    // Evitar balance disponible negativo si reduces capital con posiciones abiertas
    if (this.availableBalance < 0) {
      this.availableBalance = 0;
    }

    this.refreshDerivedState();

    logger.info(
      {
        walletId: this.walletId,
        oldCapital,
        newCapital: nextCapital,
        delta,
      },
      'PaperWallet capital updated',
    );

    consoleLog.info(
      'WALLET',
      `Paper capital updated: ${this.walletId}`,
      {
        walletId: this.walletId,
        oldCapital,
        newCapital: nextCapital,
        delta,
      },
    );
  }

  async placeOrder(order: PaperOrderInput): Promise<boolean> {
    this.validateOrder(order);

    const fillPrice = this.resolveFillPrice(order);
    const side = String(order.side).toUpperCase();
    const size = Number(order.size);
    const notional = fillPrice * size;

    if (side === 'BUY') {
      if (notional > this.availableBalance) {
        throw new Error(
          `PaperWallet insufficient balance: required=${notional.toFixed(2)} available=${this.availableBalance.toFixed(2)}`
        );
      }

      this.applyBuy(order, fillPrice);
      this.availableBalance -= notional;

      this.tradeHistory.push(
        this.buildTradeRecord(order, fillPrice, size, notional, 0),
      );
    } else if (side === 'SELL') {
      const realizedPnl = this.applySell(order, fillPrice);
      this.availableBalance += notional;
      this.realizedPnl += realizedPnl;
      this.dailyPnl += realizedPnl;

      this.tradeHistory.push(
        this.buildTradeRecord(order, fillPrice, size, notional, realizedPnl),
      );
    } else {
      throw new Error(`PaperWallet unsupported side: ${order.side}`);
    }

    this.refreshDerivedState();

    logger.info(
      {
        walletId: this.walletId,
        strategyRunId: order.strategyRunId,
        marketId: order.marketId,
        outcome: order.outcome,
        side,
        price: fillPrice,
        size,
      },
      'PaperWallet placed order',
    );

    consoleLog.success(
      'PAPER',
      `Paper order executed: ${side} ${order.outcome} x${size} @ ${fillPrice}`,
      {
        walletId: this.walletId,
        strategyRunId: order.strategyRunId,
        marketId: order.marketId,
        outcome: order.outcome,
        side,
        price: fillPrice,
        size,
        availableBalance: this.availableBalance,
        realizedPnl: this.realizedPnl,
      },
    );

    return true;
  }

  /* =========================================================
   * Core order application
   * ======================================================= */

  private applyBuy(order: PaperOrderInput, fillPrice: number): void {
    const existing = this.findPosition(order.marketId, order.outcome);
    const now = Date.now();

    if (!existing) {
      this.openPositions.push({
        marketId: order.marketId,
        outcome: order.outcome,
        size: Number(order.size),
        shares: Number(order.size),
        avgPrice: fillPrice,
        avgEntryPrice: fillPrice,
        realizedPnl: 0,
        eventId: this.asOptionalString(order.eventId),
        eventSlug: this.asOptionalString(order.eventSlug),
        seriesSlug: this.asOptionalString(order.seriesSlug),
        question: this.asOptionalString(order.question),
        slug: this.asOptionalString(order.slug),
        openedAt: now,
        updatedAt: now,
      });
      return;
    }

    const oldSize = Number(existing.size ?? 0);
    const newSize = Number(order.size);
    const totalSize = oldSize + newSize;

    const oldAvg = Number(existing.avgPrice ?? existing.avgEntryPrice ?? 0);
    const weightedAvg =
      totalSize > 0
        ? (oldSize * oldAvg + newSize * fillPrice) / totalSize
        : fillPrice;

    existing.size = totalSize;
    existing.shares = totalSize;
    existing.avgPrice = weightedAvg;
    existing.avgEntryPrice = weightedAvg;
    existing.updatedAt = now;

    // completar metadata si aún no existe
    existing.eventId = existing.eventId ?? this.asOptionalString(order.eventId);
    existing.eventSlug = existing.eventSlug ?? this.asOptionalString(order.eventSlug);
    existing.seriesSlug = existing.seriesSlug ?? this.asOptionalString(order.seriesSlug);
    existing.question = existing.question ?? this.asOptionalString(order.question);
    existing.slug = existing.slug ?? this.asOptionalString(order.slug);
  }

  private applySell(order: PaperOrderInput, fillPrice: number): number {
    const existing = this.findPosition(order.marketId, order.outcome);

    if (!existing) {
      throw new Error(
        `PaperWallet cannot SELL without open position for market=${order.marketId} outcome=${order.outcome}`,
      );
    }

    const heldSize = Number(existing.size ?? existing.shares ?? 0);
    const sellSize = Number(order.size);

    if (sellSize > heldSize) {
      throw new Error(
        `PaperWallet cannot SELL more than current position: sell=${sellSize} held=${heldSize}`,
      );
    }

    const avgEntry = Number(existing.avgPrice ?? existing.avgEntryPrice ?? 0);
    const realizedPnl = this.computeRealizedPnl(avgEntry, fillPrice, sellSize);
    const remaining = heldSize - sellSize;
    const now = Date.now();

    existing.realizedPnl = Number(existing.realizedPnl ?? 0) + realizedPnl;
    existing.updatedAt = now;

    if (remaining <= 0) {
      this.openPositions = this.openPositions.filter(
        (p) => !(p.marketId === order.marketId && p.outcome === order.outcome),
      );
    } else {
      existing.size = remaining;
      existing.shares = remaining;
    }

    return realizedPnl;
  }

  /* =========================================================
   * Helpers
   * ======================================================= */

  private findPosition(marketId: string, outcome: string): PaperPosition | undefined {
    return this.openPositions.find(
      (p) => p.marketId === marketId && p.outcome === outcome,
    );
  }

  private validateOrder(order: PaperOrderInput): void {
    if (!order?.marketId?.trim()) {
      throw new Error('PaperWallet.placeOrder: marketId es obligatorio');
    }

    if (!order?.outcome?.trim()) {
      throw new Error('PaperWallet.placeOrder: outcome es obligatorio');
    }

    if (!order?.side?.trim()) {
      throw new Error('PaperWallet.placeOrder: side es obligatorio');
    }

    if (!Number.isFinite(Number(order.price)) || Number(order.price) <= 0) {
      throw new Error('PaperWallet.placeOrder: price inválido');
    }

    if (!Number.isFinite(Number(order.size)) || Number(order.size) <= 0) {
      throw new Error('PaperWallet.placeOrder: size inválido');
    }
  }

  private resolveFillPrice(order: PaperOrderInput): number {
    const rawPrice = Number(order.price);

    // Intentar usar FillSimulator del repo si expone alguna firma conocida.
    try {
      if (this.fillSimulator) {
        if (typeof this.fillSimulator.simulate === 'function') {
          const simulated = this.fillSimulator.simulate(order);
          const price =
            simulated?.price ??
            simulated?.fillPrice ??
            simulated?.executedPrice;

          if (Number.isFinite(price)) {
            return Number(price);
          }
        }

        if (typeof this.fillSimulator.simulateFill === 'function') {
          const simulated = this.fillSimulator.simulateFill(order);
          const price =
            simulated?.price ??
            simulated?.fillPrice ??
            simulated?.executedPrice;

          if (Number.isFinite(price)) {
            return Number(price);
          }
        }
      }
    } catch (error) {
      logger.warn(
        {
          error,
          walletId: this.walletId,
          marketId: order.marketId,
        },
        'FillSimulator fallback to raw order price',
      );
    }

    return rawPrice;
  }

  private computeRealizedPnl(entryPrice: number, exitPrice: number, size: number): number {
    try {
      if (this.pnlTracker) {
        if (typeof this.pnlTracker.realize === 'function') {
          const pnl = this.pnlTracker.realize(entryPrice, exitPrice, size);
          if (Number.isFinite(pnl)) return Number(pnl);
        }

        if (typeof this.pnlTracker.computeRealizedPnl === 'function') {
          const pnl = this.pnlTracker.computeRealizedPnl(entryPrice, exitPrice, size);
          if (Number.isFinite(pnl)) return Number(pnl);
        }
      }
    } catch (error) {
      logger.warn(
        {
          error,
          walletId: this.walletId,
        },
        'PnlTracker fallback to local realized PnL calculation',
      );
    }

    return (exitPrice - entryPrice) * size;
  }

  private buildTradeRecord(
    order: PaperOrderInput,
    fillPrice: number,
    size: number,
    notional: number,
    realizedPnl: number,
  ): PaperTradeRecord {
    return {
      tradeId: `paper-${this.walletId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      walletId: this.walletId,
      strategy: this.assignedStrategy,
      strategyRunId: this.asOptionalString(order.strategyRunId),
      marketId: order.marketId,
      outcome: order.outcome,
      side: String(order.side).toUpperCase(),
      price: fillPrice,
      size,
      notional,
      realizedPnl,
      eventId: this.asOptionalString(order.eventId),
      eventSlug: this.asOptionalString(order.eventSlug),
      seriesSlug: this.asOptionalString(order.seriesSlug),
      question: this.asOptionalString(order.question),
      slug: this.asOptionalString(order.slug),
      timestamp: Date.now(),
      meta: {},
    };
  }

  private refreshDerivedState(): void {
    const openNotional = this.openPositions.reduce((sum, p) => {
      const size = Number(p.size ?? p.shares ?? 0);
      const price = Number(p.avgPrice ?? p.avgEntryPrice ?? 0);
      return sum + size * price;
    }, 0);

    this.currentEquity = this.availableBalance + openNotional + this.realizedPnl;

    if (this.currentEquity > this.peakEquity) {
      this.peakEquity = this.currentEquity;
    }

    this.drawdownPct =
      this.peakEquity > 0
        ? Math.max(0, (this.peakEquity - this.currentEquity) / this.peakEquity)
        : 0;
  }

  private asOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  private clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}
