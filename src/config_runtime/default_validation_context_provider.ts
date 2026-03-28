import type { EffectiveRuntimeConfig } from './types';
import type { ValidatorContext } from './config_validator';
import type { ValidationContextProvider } from './config_service';
import { WalletManager } from '../wallets/wallet_manager';

export class DefaultValidationContextProvider
  implements ValidationContextProvider
{
  constructor(private readonly walletManager: WalletManager) {}

  async getValidatorContext(
    config: EffectiveRuntimeConfig,
  ): Promise<ValidatorContext> {
    const walletStates =
      typeof this.walletManager.getWalletStates === 'function'
        ? this.walletManager.getWalletStates()
        : [];

    const accountEquityUsd = walletStates.reduce((sum: number, state: any) => {
      const equity =
        Number(state?.currentEquity ?? state?.capitalAllocated ?? 0);
      return sum + (Number.isFinite(equity) ? equity : 0);
    }, 0);

    const accountCurrentExposureUsd = walletStates.reduce(
      (sum: number, state: any) => {
        const exposure = (state?.openPositions ?? []).reduce(
          (inner: number, pos: any) => {
            const size = Number(pos?.size ?? pos?.shares ?? 0);
            const price = Number(pos?.avgPrice ?? pos?.avgEntryPrice ?? 0);
            return inner + Math.abs(size * price);
          },
          0,
        );

        return sum + exposure;
      },
      0,
    );

    const strategyStateById: Record<
      string,
      {
        strategyRunId: string;
        currentExposureUsd: number;
        openPositions: number;
        openOrders: number;
        hasPendingOrders: boolean;
      }
    > = {};

    for (const strategy of config.strategies) {
      const wallet =
        typeof this.walletManager.getWalletForStrategy === 'function'
          ? this.walletManager.getWalletForStrategy(strategy.strategyRunId)
          : this.walletManager.getWallet?.(strategy.strategyRunId);

      const state =
        wallet && typeof wallet.getState === 'function'
          ? wallet.getState()
          : undefined;

      const currentExposureUsd = (state?.openPositions ?? []).reduce(
        (sum: number, pos: any) => {
          const size = Number(pos?.size ?? pos?.shares ?? 0);
          const price = Number(pos?.avgPrice ?? pos?.avgEntryPrice ?? 0);
          return sum + Math.abs(size * price);
        },
        0,
      );

      strategyStateById[strategy.strategyRunId] = {
        strategyRunId: strategy.strategyRunId,
        currentExposureUsd,
        openPositions: Array.isArray(state?.openPositions)
          ? state.openPositions.length
          : 0,
        openOrders: 0,
        hasPendingOrders: false,
      };
    }

    return {
      currentConfig: config,
      accountEquityUsd,
      accountCurrentExposureUsd,
      accountOpenOrders: 0,
      liveTradingEnabled: Boolean(config.account.liveEnabled),
      liveAdapterAvailable: Boolean(process.env.POLYMARKET_API_KEY),
      strategyStateById,
      knownEventSlugs: new Set<string>(),
      knownSeriesSlugs: new Set<string>(),
    };
  }
}
