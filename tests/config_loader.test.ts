import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config_loader';
import { cleanupDir, makeTempDir, writeTempFile } from './helpers/temp';

describe('config_loader', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) cleanupDir(tempDir);
    delete process.env.ENABLE_LIVE_TRADING;
  });

  it('loads legacy config and derives strategies', () => {
    tempDir = makeTempDir();

    const yaml = `
environment:
  enable_live_trading: false

polymarket:
  gamma_api: https://gamma-api.polymarket.com
  clob_api: https://clob.polymarket.com

wallets:
  - id: conv_legacy
    mode: PAPER
    strategy: filtered_high_prob_convergence
    capital: 2500
    risk_limits:
      max_position_usd: 200

strategy_config:
  filtered_high_prob_convergence:
    min_prob: 0.65
    max_prob: 0.96
`;

    const file = writeTempFile(tempDir, 'config.yaml', yaml);
    const config = loadConfig(file);

    expect(config.wallets?.length).toBe(1);
    expect(config.wallets?.[0].id).toBe('conv_legacy');

    expect(config.strategies.length).toBe(1);
    expect(config.strategies[0].id).toBe('conv_legacy');
    expect(config.strategies[0].key).toBe('filtered_high_prob_convergence');
    expect(config.strategies[0].allocationUsd).toBe(2500);

    expect(config.strategyConfig?.filtered_high_prob_convergence).toBeTruthy();
  });

  it('loads new config and derives legacy wallets', () => {
    tempDir = makeTempDir();

    const yaml = `
environment:
  enable_live_trading: false
  dashboard_read_only: true

polymarket:
  gamma_api: https://gamma-api.polymarket.com
  clob_api: https://clob.polymarket.com

account:
  live:
    enabled: false
    venue: POLYMARKET
    account_id: polymarket_main

paper:
  default_starting_capital_usd: 10000

strategies:
  - id: conv_01
    key: filtered_high_prob_convergence
    enabled: true
    mode: PAPER
    allocation_usd: 3000
    risk:
      max_position_usd: 250
    params:
      min_prob: 0.65
`;

    const file = writeTempFile(tempDir, 'config.yaml', yaml);
    const config = loadConfig(file);

    expect(config.strategies.length).toBe(1);
    expect(config.strategies[0].id).toBe('conv_01');

    expect(config.wallets?.length).toBe(1);
    expect(config.wallets?.[0].id).toBe('conv_01');
    expect(config.wallets?.[0].mode).toBe('PAPER');

    expect(config.strategyConfig?.filtered_high_prob_convergence).toBeTruthy();
  });

  it('keeps live disabled unless yaml + env are both enabled', () => {
    tempDir = makeTempDir();

    const yaml = `
environment:
  enable_live_trading: true

polymarket:
  gamma_api: https://gamma-api.polymarket.com
  clob_api: https://clob.polymarket.com

account:
  live:
    enabled: true
    venue: POLYMARKET
    account_id: polymarket_main

strategies:
  - id: live_01
    key: market_making
    enabled: true
    mode: LIVE
    allocation_usd: 1000
    params: {}
`;

    const file = writeTempFile(tempDir, 'config.yaml', yaml);

    process.env.ENABLE_LIVE_TRADING = 'false';
    const config1 = loadConfig(file);
    expect(config1.environment.enableLiveTrading).toBe(false);

    process.env.ENABLE_LIVE_TRADING = 'true';
    const config2 = loadConfig(file);
    expect(config2.environment.enableLiveTrading).toBe(true);
  });
});