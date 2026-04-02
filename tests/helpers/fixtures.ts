import type { AppConfig } from '../src/types';

export function makeBaseConfig(): any {
  return {
    environment: {
      nodeEnv: 'test',
      enableLiveTrading: false,
      dashboardReadOnly: true,
    },
    polymarket: {
      gammaApi: 'https://gamma-api.polymarket.com',
      clobApi: 'https://clob.polymarket.com',
    },
    account: {
      live: {
        enabled: false,
        venue: 'POLYMARKET',
        accountId: 'polymarket_main',
        label: 'main',
      },
      risk: {
        maxTotalExposureUsd: 5000,
        maxExposurePerEventUsd: 1000,
        maxOpenOrders: 20,
        maxDailyLossUsd: 250,
        maxDrawdownPct: 0.15,
        maxOrdersPerMinute: 20,
      },
    },
    paper: {
      defaultStartingCapitalUsd: 10000,
    },
    services: {
      whales: {
        enabled: false,
        baseUrl: 'http://localhost:8081',
        timeoutMs: 5000,
      },
    },
    strategies: [
      {
        id: 'conv_01',
        key: 'filtered_high_prob_convergence',
        enabled: true,
        mode: 'PAPER',
        allocationUsd: 3000,
        params: {
          minProb: 0.65,
          maxProb: 0.96,
        },
        risk: {
          maxPositionUsd: 250,
          maxExposurePerMarketUsd: 400,
          maxExposurePerEventUsd: 600,
          maxOpenPositions: 5,
          maxDailyLossUsd: 100,
          maxDrawdownPct: 0.1,
          maxOrdersPerMinute: 5,
          maxCancelRate: 0.25,
          cooldownMsPerMarket: 60000,
        },
        universe: {
          minLiquidityUsd: 10000,
          minVolume24h: 10000,
          requireActive: true,
          requireAcceptingOrders: true,
        },
        tags: ['test'],
      },
    ],
    // compat legacy opcional
    wallets: [
      {
        id: 'conv_01',
        mode: 'PAPER',
        strategy: 'filtered_high_prob_convergence',
        capital: 3000,
        riskLimits: {
          maxPositionUsd: 250,
        },
      },
    ],
    strategyConfig: {
      filtered_high_prob_convergence: {
        minProb: 0.65,
        maxProb: 0.96,
      },
    },
  };
}