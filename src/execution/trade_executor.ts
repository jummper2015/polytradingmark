import { OrderRequest } from '../types';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';

interface ExecutableWallet {
  placeOrder(input: {
    marketId: string;
    outcome: string;
    side: string;
    price: number;
    size: number;
  }): Promise<unknown>;

  getState?: () => {
    walletId?: string;
    id?: string;
    mode?: string;
    [key: string]: unknown;
  };
}

export class TradeExecutor {
  /**
   * Compatibilidad transicional:
   * - execute(order, wallet)
   * - execute(wallet, order)
   */
  async execute(
    arg1: OrderRequest | ExecutableWallet,
    arg2: OrderRequest | ExecutableWallet,
  ): Promise<boolean> {
    const { order, wallet } = this.resolveArgs(arg1, arg2);

    const payload = {
      marketId: order.marketId,
      outcome: String(order.outcome),
      side: String(order.side),
      price: Number(order.price),
      size: Number(order.size),
    };

    this.validatePayload(payload);

    try {
      const result = await wallet.placeOrder(payload);

      const walletState =
        typeof wallet.getState === 'function' ? wallet.getState() : undefined;

      logger.info(
        {
          walletId: order.walletId ?? walletState?.walletId ?? walletState?.id,
          strategyRunId: (order as any).strategyRunId,
          marketId: payload.marketId,
          outcome: payload.outcome,
          side: payload.side,
          price: payload.price,
          size: payload.size,
        },
        'TradeExecutor executed order',
      );

      consoleLog.success(
        'EXECUTION',
        `Executed ${payload.side} ${payload.outcome} x${payload.size} @ ${payload.price}`,
        {
          walletId: order.walletId ?? walletState?.walletId ?? walletState?.id,
          strategyRunId: (order as any).strategyRunId,
          marketId: payload.marketId,
          outcome: payload.outcome,
          side: payload.side,
          price: payload.price,
          size: payload.size,
        },
      );

      return result !== false;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      logger.error(
        {
          error,
          walletId: order.walletId,
          strategyRunId: (order as any).strategyRunId,
          marketId: payload.marketId,
        },
        'TradeExecutor failed',
      );

      consoleLog.error(
        'EXECUTION',
        `Execution failed: ${msg}`,
        {
          walletId: order.walletId,
          strategyRunId: (order as any).strategyRunId,
          marketId: payload.marketId,
          outcome: payload.outcome,
          side: payload.side,
          price: payload.price,
          size: payload.size,
        },
      );

      throw error;
    }
  }

  private resolveArgs(
    arg1: OrderRequest | ExecutableWallet,
    arg2: OrderRequest | ExecutableWallet,
  ): { order: OrderRequest; wallet: ExecutableWallet } {
    if (this.isWallet(arg1) && this.isOrder(arg2)) {
      return { wallet: arg1, order: arg2 };
    }

    if (this.isOrder(arg1) && this.isWallet(arg2)) {
      return { order: arg1, wallet: arg2 };
    }

    throw new Error(
      'TradeExecutor.execute requiere (order, wallet) o (wallet, order)',
    );
  }

  private isWallet(value: unknown): value is ExecutableWallet {
    return (
      !!value &&
      typeof value === 'object' &&
      typeof (value as ExecutableWallet).placeOrder === 'function'
    );
  }

  private isOrder(value: unknown): value is OrderRequest {
    return (
      !!value &&
      typeof value === 'object' &&
      typeof (value as OrderRequest).marketId === 'string' &&
      'outcome' in (value as Record<string, unknown>) &&
      'side' in (value as Record<string, unknown>) &&
      'price' in (value as Record<string, unknown>) &&
      'size' in (value as Record<string, unknown>)
    );
  }

  private validatePayload(payload: {
    marketId: string;
    outcome: string;
    side: string;
    price: number;
    size: number;
  }): void {
    if (!payload.marketId?.trim()) {
      throw new Error('TradeExecutor: marketId es obligatorio');
    }

    if (!Number.isFinite(payload.price) || payload.price <= 0) {
      throw new Error('TradeExecutor: price inválido');
    }

    if (!Number.isFinite(payload.size) || payload.size <= 0) {
      throw new Error('TradeExecutor: size inválido');
    }
  }
}
