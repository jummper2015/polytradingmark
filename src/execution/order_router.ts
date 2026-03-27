import { WalletManager } from '../wallets/wallet_manager';
import { TradeExecutor } from './trade_executor';
import { RiskEngine } from '../risk/risk_engine';
import type { EffectiveRuntimeConfig } from '../config_runtime/types';
import type { OrderRequest } from '../types';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';

export class OrderRouter {
  private runtimeConfig: EffectiveRuntimeConfig | null = null;
  private readonly strategyWalletMap = new Map<string, string>();

  constructor(
    private readonly walletManager: WalletManager,
    private readonly riskEngine: RiskEngine,
    private readonly tradeExecutor: TradeExecutor,
  ) {}

  /* =========================================================
   * Runtime config integration
   * ======================================================= */

  updateRuntimeConfig(config: EffectiveRuntimeConfig): void {
    this.runtimeConfig = config;
    this.rebuildStrategyWalletMap();
  }

  getRuntimeConfig(): EffectiveRuntimeConfig | null {
    return this.runtimeConfig;
  }

  registerStrategyWallet(strategyRunId: string, walletId: string): void {
    this.strategyWalletMap.set(strategyRunId, walletId);
  }

  getWalletIdForStrategy(strategyRunId: string): string | undefined {
    return this.strategyWalletMap.get(strategyRunId);
  }

  private rebuildStrategyWalletMap(): void {
    this.strategyWalletMap.clear();

    if (!this.runtimeConfig) return;

    for (const strategy of this.runtimeConfig.strategies) {
      // Regla transicional:
      // - LIVE -> cuenta principal única
      // - PAPER -> wallet por strategyRunId
      const walletId =
        strategy.mode === 'LIVE'
          ? this.runtimeConfig.account.accountId
          : strategy.strategyRunId;

      this.strategyWalletMap.set(strategy.strategyRunId, walletId);
    }
  }

  /* =========================================================
   * Core routing
   * ======================================================= */

  async route(order: OrderRequest & Record<string, any>): Promise<boolean> {
    const walletId = this.resolveWalletId(order);
    const strategyRunId =
      order.strategyRunId ??
      order.walletId ??
      walletId;

    if (!walletId) {
      logger.warn({ order }, 'Order rejected: no walletId could be resolved');
      consoleLog.warn('ROUTER', 'Order rejected: walletId no resuelto', {
        strategyRunId,
        marketId: order.marketId,
      });
      return false;
    }

    const wallet = this.walletManager.getWallet(walletId);
    if (!wallet) {
      logger.warn({ walletId, order }, 'Order rejected: wallet not found');
      consoleLog.warn('ROUTER', `Order rejected: wallet ${walletId} no encontrada`, {
        walletId,
        strategyRunId,
        marketId: order.marketId,
      });
      return false;
    }

    const walletState =
      typeof wallet.getState === 'function' ? wallet.getState() : undefined;

    if (!walletState) {
      logger.warn({ walletId, order }, 'Order rejected: wallet state not available');
      consoleLog.warn('ROUTER', `Order rejected: wallet state no disponible para ${walletId}`, {
        walletId,
        strategyRunId,
        marketId: order.marketId,
      });
      return false;
    }

    const enrichedOrder = {
      ...order,
      walletId,
      strategyRunId,
    };

    const riskApproved = this.riskEngine.check(enrichedOrder, walletState);

    if (!riskApproved) {
      const reason = this.riskEngine.getLastRejectReason(
        strategyRunId ?? walletId,
      );

      logger.warn(
        {
          walletId,
          strategyRunId,
          marketId: enrichedOrder.marketId,
          outcome: enrichedOrder.outcome,
          side: enrichedOrder.side,
          reason,
        },
        'Order rejected by risk engine',
      );

      consoleLog.warn('RISK', 'Order rejected by risk engine', {
        walletId,
        strategyRunId,
        marketId: enrichedOrder.marketId,
        outcome: enrichedOrder.outcome,
        side: enrichedOrder.side,
        reason,
      });

      return false;
    }

    try {
      const executed = await this.executeOrder(wallet, enrichedOrder);

      if (executed) {
        logger.info(
          {
            walletId,
            strategyRunId,
            marketId: enrichedOrder.marketId,
            outcome: enrichedOrder.outcome,
            side: enrichedOrder.side,
            price: enrichedOrder.price,
            size: enrichedOrder.size,
          },
          'Order routed successfully',
        );

        consoleLog.success(
          'ROUTER',
          `Order routed: ${enrichedOrder.side} ${enrichedOrder.outcome} x${enrichedOrder.size}`,
          {
            walletId,
            strategyRunId,
            marketId: enrichedOrder.marketId,
            price: enrichedOrder.price,
            size: enrichedOrder.size,
          },
        );
      }

      return executed;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      logger.error(
        {
          error,
          walletId,
          strategyRunId,
          marketId: enrichedOrder.marketId,
        },
        'Order routing failed',
      );

      consoleLog.error('ROUTER', `Order routing failed: ${msg}`, {
        walletId,
        strategyRunId,
        marketId: enrichedOrder.marketId,
      });

      return false;
    }
  }

  /* =========================================================
   * Helpers
   * ======================================================= */

  private resolveWalletId(order: OrderRequest & Record<string, any>): string | undefined {
    if (typeof order.walletId === 'string' && order.walletId.trim()) {
      return order.walletId;
    }

    if (typeof order.strategyRunId === 'string' && order.strategyRunId.trim()) {
      return this.strategyWalletMap.get(order.strategyRunId) ?? order.strategyRunId;
    }

    return undefined;
  }

  private async executeOrder(wallet: any, order: OrderRequest & Record<string, any>): Promise<boolean> {
    // Compatibilidad temporal:
    // algunos códigos usan execute(wallet, order)
    // otros podrían usar execute(order, wallet)
    if (typeof (this.tradeExecutor as any)?.execute !== 'function') {
      throw new Error('TradeExecutor.execute no está disponible');
    }

    try {
      const result = await (this.tradeExecutor as any).execute(wallet, order);
      return result !== false;
    } catch (firstError) {
      try {
        const result = await (this.tradeExecutor as any).execute(order, wallet);
        return result !== false;
      } catch {
        throw firstError;
      }
    }
  }
}
