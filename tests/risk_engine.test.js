import { describe, expect, it } from 'vitest';
import { RiskEngine } from '../src/risk/risk_engine';
import { KillSwitch } from '../src/risk/kill_switch';
import { makeBaseConfig } from './helpers/fixtures';

describe('RiskEngine', () => {
  function makeWalletState(overrides: Record<string, any> = {}) {
    return {
      id: 'conv_01',
      walletId: 'conv_01',
      mode: 'PAPER',
      capitalAllocated: 3000,
      availableBalance: 1000,
      openPositions: [],
      realizedPnl: 0,
      dailyPnl: 0,
      peakEquity: 3000,
      currentEquity: 3000,
      drawdownPct: 0,
      riskLimits: {
        maxPositionUsd: 250,
        maxExposurePerMarketUsd: 400,
        maxOpenPositions: 5,
        maxDailyLossUsd: 100,
        maxDrawdownPct: 0.1,
        maxOrdersPerMinute: 10,
      },
      ...overrides,
    };
  }

  function makeOrder(overrides: Record<string, any> = {}) {
    return {
      walletId: 'conv_01',
      strategyRunId: 'conv_01',
      marketId: 'mkt_1',
      outcome: 'YES',
      side: 'BUY',
      price: 0.5,
      size: 100,
      ...overrides,
    };
  }

  it('rejects when kill switch is active', () => {
    const config = makeBaseConfig();
    const killSwitch = new KillSwitch();
    const risk = new RiskEngine(config, killSwitch);

    killSwitch.activate();

    const ok = risk.check(makeOrder(), makeWalletState());
    expect(ok).toBe(false);
  });

  it('rejects buy when available balance is insufficient', () => {
    const config = makeBaseConfig();
    const killSwitch = new KillSwitch();
    const risk = new RiskEngine(config, killSwitch);

    const ok = risk.check(
      makeOrder({ price: 0.8, size: 200 }),
      makeWalletState({ availableBalance: 50 }),
    );

    expect(ok).toBe(false);
  });

  it('rejects order above maxPositionUsd', () => {
    const config = makeBaseConfig();
    const killSwitch = new KillSwitch();
    const risk = new RiskEngine(config, killSwitch);

    const ok = risk.check(
      makeOrder({ price: 1, size: 300 }),
      makeWalletState(),
    );

    expect(ok).toBe(false);
  });

  it('rejects when strategy is paused in runtime config', () => {
    const config = makeBaseConfig();
    const killSwitch = new KillSwitch();
    const risk = new RiskEngine(config, killSwitch);

    risk.updateRuntimeConfig({
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
          executionState: 'PAUSED',
          allocation: { mode: 'FIXED_USD', value: 3000, resolvedUsd: 3000 },
          risk: { maxPositionUsd: 250 },
          universe: {},
          params: {},
          tags: [],
          updatedAt: Date.now(),
        },
      ],
    });

    const ok = risk.check(makeOrder(), makeWalletState());
    expect(ok).toBe(false);
  });

  it('rejects BUY in reduce-only mode', () => {
    const config = makeBaseConfig();
    const killSwitch = new KillSwitch();
    const risk = new RiskEngine(config, killSwitch);

    risk.updateRuntimeConfig({
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
          executionState: 'REDUCE_ONLY',
          allocation: { mode: 'FIXED_USD', value: 3000, resolvedUsd: 3000 },
          risk: { maxPositionUsd: 250 },
          universe: {},
          params: {},
          tags: [],
          updatedAt: Date.now(),
        },
      ],
    });

    const ok = risk.check(makeOrder({ side: 'BUY' }), makeWalletState());
    expect(ok).toBe(false);
  });
});