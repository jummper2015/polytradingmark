import { describe, expect, it } from 'vitest';
import { WalletManager } from '../src/wallets/wallet_manager';
import { makeBaseConfig } from './helpers/fixtures';

describe('WalletManager', () => {
  it('initializes legacy wallets from config', async () => {
    const config = makeBaseConfig();
    const manager = new WalletManager(config);

    await manager.initialize();

    expect(manager.hasWallet('conv_01')).toBe(true);
    expect(manager.getWallet('conv_01')).toBeTruthy();
  });

  it('creates paper wallet per strategyRunId from runtime config', async () => {
    const config = makeBaseConfig();
    const manager = new WalletManager(config);

    await manager.updateRuntimeConfig({
      version: 1,
      generatedAt: Date.now(),
      source: 'BOOTSTRAP',
      account: {
        accountId: 'polymarket_main',
        venue: 'POLYMARKET',
        liveEnabled: false,
        risk: {},
        updatedAt: Date.now(),
      },
      strategies: [
        {
          strategyRunId: 'conv_01',
          key: 'filtered_high_prob_convergence',
          venue: 'POLYMARKET',
          enabled: true,
          mode: 'PAPER',
          executionState: 'ACTIVE',
          allocation: { mode: 'FIXED_USD', value: 3000, resolvedUsd: 3000 },
          risk: { maxPositionUsd: 250 },
          universe: {},
          params: {},
          tags: [],
          updatedAt: Date.now(),
        },
      ],
    });

    await manager.initialize();

    expect(manager.getWalletIdForStrategy('conv_01')).toBe('conv_01');
    expect(manager.getWalletForStrategy('conv_01')).toBeTruthy();
  });

  it('maps multiple LIVE strategies to one live account wallet', async () => {
    const config = makeBaseConfig();
    const manager = new WalletManager(config);

    await manager.updateRuntimeConfig({
      version: 1,
      generatedAt: Date.now(),
      source: 'BOOTSTRAP',
      account: {
        accountId: 'polymarket_main',
        venue: 'POLYMARKET',
        liveEnabled: true,
        risk: {},
        updatedAt: Date.now(),
      },
      strategies: [
        {
          strategyRunId: 'live_01',
          key: 'market_making',
          venue: 'POLYMARKET',
          enabled: true,
          mode: 'LIVE',
          executionState: 'ACTIVE',
          allocation: { mode: 'FIXED_USD', value: 1000, resolvedUsd: 1000 },
          risk: {},
          universe: {},
          params: {},
          tags: [],
          updatedAt: Date.now(),
        },
        {
          strategyRunId: 'live_02',
          key: 'momentum',
          venue: 'POLYMARKET',
          enabled: true,
          mode: 'LIVE',
          executionState: 'ACTIVE',
          allocation: { mode: 'FIXED_USD', value: 1200, resolvedUsd: 1200 },
          risk: {},
          universe: {},
          params: {},
          tags: [],
          updatedAt: Date.now(),
        },
      ],
    });

    process.env.ENABLE_LIVE_TRADING = 'true';
    await manager.initialize();

    expect(manager.getWalletIdForStrategy('live_01')).toBe('polymarket_main');
    expect(manager.getWalletIdForStrategy('live_02')).toBe('polymarket_main');
    expect(manager.getWallet('polymarket_main')).toBeTruthy();
  });
});