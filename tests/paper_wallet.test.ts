import { describe, expect, it } from 'vitest';
import { PaperWallet } from '../src/wallets/paper_wallet';

describe('PaperWallet', () => {
  it('creates a BUY position and decreases available balance', async () => {
    const wallet = new PaperWallet({
      id: 'paper_01',
      mode: 'PAPER',
      strategy: 'filtered_high_prob_convergence',
      capital: 1000,
      riskLimits: {},
    });

    await wallet.placeOrder({
      marketId: 'mkt_1',
      outcome: 'YES',
      side: 'BUY',
      price: 0.5,
      size: 100,
      strategyRunId: 'conv_01',
      eventId: 'event_1',
    });

    const state = wallet.getState();

    expect(state.availableBalance).toBe(950);
    expect(Array.isArray(state.openPositions)).toBe(true);
    expect(state.openPositions.length).toBe(1);
    expect(state.openPositions[0].marketId).toBe('mkt_1');
    expect(state.openPositions[0].size).toBe(100);
  });

  it('averages price when buying same market/outcome twice', async () => {
    const wallet = new PaperWallet({
      id: 'paper_02',
      capital: 1000,
      strategy: 'momentum',
    });

    await wallet.placeOrder({
      marketId: 'mkt_1',
      outcome: 'YES',
      side: 'BUY',
      price: 0.4,
      size: 100,
    });

    await wallet.placeOrder({
      marketId: 'mkt_1',
      outcome: 'YES',
      side: 'BUY',
      price: 0.6,
      size: 100,
    });

    const state = wallet.getState();
    const pos = state.openPositions[0];

    expect(pos.size).toBe(200);
    expect(pos.avgPrice).toBeCloseTo(0.5, 6);
  });

  it('sells partially and realizes pnl', async () => {
    const wallet = new PaperWallet({
      id: 'paper_03',
      capital: 1000,
      strategy: 'momentum',
    });

    await wallet.placeOrder({
      marketId: 'mkt_2',
      outcome: 'YES',
      side: 'BUY',
      price: 0.4,
      size: 100,
    });

    await wallet.placeOrder({
      marketId: 'mkt_2',
      outcome: 'YES',
      side: 'SELL',
      price: 0.7,
      size: 40,
    });

    const state = wallet.getState();
    const pos = state.openPositions[0];

    expect(pos.size).toBe(60);
    expect(Number(state.realizedPnl)).toBeCloseTo(12, 6);
  });

  it('removes position when fully sold', async () => {
    const wallet = new PaperWallet({
      id: 'paper_04',
      capital: 1000,
      strategy: 'market_making',
    });

    await wallet.placeOrder({
      marketId: 'mkt_3',
      outcome: 'NO',
      side: 'BUY',
      price: 0.3,
      size: 100,
    });

    await wallet.placeOrder({
      marketId: 'mkt_3',
      outcome: 'NO',
      side: 'SELL',
      price: 0.5,
      size: 100,
    });

    const state = wallet.getState();

    expect(state.openPositions.length).toBe(0);
    expect(Number(state.realizedPnl)).toBeCloseTo(20, 6);
  });

  it('updates risk limits and capital allocation', () => {
    const wallet = new PaperWallet({
      id: 'paper_05',
      capital: 1000,
      strategy: 'test',
      riskLimits: { maxPositionUsd: 100 },
    });

    wallet.updateRiskLimits({ maxPositionUsd: 200, maxDailyLossUsd: 50 });
    wallet.setCapitalAllocated(1500);

    const state = wallet.getState();

    expect(state.riskLimits.maxPositionUsd).toBe(200);
    expect(state.riskLimits.maxDailyLossUsd).toBe(50);
    expect(state.capitalAllocated).toBe(1500);
  });
});