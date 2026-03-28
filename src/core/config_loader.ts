import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

import type { AppConfig } from '../types';

type JsonMap = Record<string, unknown>;

export type TransitionalAppConfig = AppConfig & {
  // Compatibilidad temporal con el diseño viejo
  wallets?: Array<{
    id: string;
    mode: 'PAPER' | 'LIVE' | 'DISABLED';
    strategy: string;
    capital: number;
    riskLimits?: JsonMap;
    risk_limits?: JsonMap;
  }>;
  strategyConfig?: Record<string, JsonMap>;
  whaleTracking?: JsonMap;
};

export function loadConfig(configPath: string): TransitionalAppConfig {
  const absolutePath = path.resolve(configPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Config file not found: ${absolutePath}`);
  }

  const raw = fs.readFileSync(absolutePath, 'utf8');
  const parsed = YAML.parse(raw) ?? {};

  const yamlLiveFlag = getBoolean(
    parsed,
    ['environment.enable_live_trading', 'environment.enableLiveTrading'],
    false,
  );

  const envLiveFlag =
    String(process.env.ENABLE_LIVE_TRADING ?? '').toLowerCase() === 'true';

  // Mantengo la política actual del repo:
  // LIVE solo queda efectivamente habilitado si YAML + env var están activas.
  const effectiveLiveEnabled = yamlLiveFlag && envLiveFlag;

  const environment = {
    nodeEnv: getString(parsed, ['environment.node_env', 'environment.nodeEnv'], 'development') as
      | 'development'
      | 'test'
      | 'production',
    enableLiveTrading: effectiveLiveEnabled,
    dashboardReadOnly: getBoolean(
      parsed,
      ['environment.dashboard_read_only', 'environment.dashboardReadOnly'],
      true,
    ),
  };

  const polymarket = {
    gammaApi: getString(
      parsed,
      ['polymarket.gamma_api', 'polymarket.gammaApi'],
      'https://gamma-api.polymarket.com',
    ),
    clobApi: getString(
      parsed,
      ['polymarket.clob_api', 'polymarket.clobApi'],
      'https://clob.polymarket.com',
    ),
  };

  const account = {
    live: {
      enabled: getBoolean(
        parsed,
        ['account.live.enabled'],
        yamlLiveFlag || hasLegacyLiveWallets(parsed),
      ),
      venue: getString(parsed, ['account.live.venue'], 'POLYMARKET') as 'POLYMARKET',
      accountId: getString(
        parsed,
        ['account.live.account_id', 'account.live.accountId'],
        'polymarket_main',
      ),
      label: getOptionalString(parsed, ['account.live.label']),
    },
    risk: normalizeAccountRisk(
      getObject(parsed, ['account.risk'], {}),
    ),
  };

  const paper = {
    defaultStartingCapitalUsd: getNumber(
      parsed,
      ['paper.default_starting_capital_usd', 'paper.defaultStartingCapitalUsd'],
      10000,
    ),
  };

  const services = {
    whales: normalizeWhaleServiceConfig(parsed),
  };

  // 1) Estrategias nuevas directas
  const strategiesFromNewConfig = normalizeNewStrategies(parsed);

  // 2) Estrategias derivadas del YAML viejo
  const strategiesFromLegacyConfig = normalizeLegacyStrategies(parsed);

  // Prioridad:
  // - si existe strategies[] nuevo y tiene contenido, usarlo
  // - si no, derivarlo desde wallets + strategy_config
  const strategies =
    strategiesFromNewConfig.length > 0
      ? strategiesFromNewConfig
      : strategiesFromLegacyConfig;

  // Compat legacy:
  // - si el YAML ya trae wallets, las normalizamos
  // - si no, generamos wallets legacy desde strategies
  const wallets =
    normalizeLegacyWallets(parsed).length > 0
      ? normalizeLegacyWallets(parsed)
      : buildLegacyWalletsFromStrategies(
          strategies,
          account.live.accountId,
        );

  // Compat legacy:
  // - si strategy_config existe, la normalizamos
  // - si no, la derivamos desde strategies[].params
  const strategyConfig =
    Object.keys(normalizeLegacyStrategyConfig(parsed)).length > 0
      ? normalizeLegacyStrategyConfig(parsed)
      : buildLegacyStrategyConfigFromStrategies(strategies);

  const whaleTracking = getObject(parsed, ['whale_tracking'], {});

  const config: TransitionalAppConfig = {
    environment,
    polymarket,
    account,
    paper,
    services,
    strategies,

    // Compatibilidad temporal
    wallets,
    strategyConfig,
    whaleTracking,
  } as TransitionalAppConfig;

  return config;
}

/* =========================================================
 * New config normalization
 * ======================================================= */

function normalizeNewStrategies(parsed: any): Array<{
  id: string;
  key: string;
  enabled: boolean;
  mode: 'PAPER' | 'LIVE' | 'DISABLED';
  allocationUsd: number;
  params: JsonMap;
  universe?: JsonMap;
  risk?: JsonMap;
  tags?: string[];
}> {
  const strategies = Array.isArray(parsed?.strategies) ? parsed.strategies : [];
  const result: Array<{
    id: string;
    key: string;
    enabled: boolean;
    mode: 'PAPER' | 'LIVE' | 'DISABLED';
    allocationUsd: number;
    params: JsonMap;
    universe?: JsonMap;
    risk?: JsonMap;
    tags?: string[];
  }> = [];

  for (const item of strategies) {
    if (!item || typeof item !== 'object') continue;

    const id = String(item.id ?? '').trim();
    const key = String(item.key ?? '').trim();

    if (!id || !key) continue;

    result.push({
      id,
      key,
      enabled: item.enabled !== false,
      mode: normalizeMode(item.mode),
      allocationUsd: getNumberFromObject(item, ['allocation_usd', 'allocationUsd'], 0),
      params: getObjectFromObject(item, ['params'], {}),
      universe: normalizeUniverse(getObjectFromObject(item, ['universe'], {})),
      risk: normalizeStrategyRisk(getObjectFromObject(item, ['risk'], {})),
      tags: normalizeStringArray(item.tags),
    });
  }

  return result;
}

/* =========================================================
 * Legacy config normalization
 * ======================================================= */

function normalizeLegacyStrategies(parsed: any): Array<{
  id: string;
  key: string;
  enabled: boolean;
  mode: 'PAPER' | 'LIVE' | 'DISABLED';
  allocationUsd: number;
  params: JsonMap;
  universe?: JsonMap;
  risk?: JsonMap;
  tags?: string[];
}> {
  const wallets = normalizeLegacyWallets(parsed);
  const strategyConfig = normalizeLegacyStrategyConfig(parsed);

  return wallets
    .filter((wallet) => wallet.strategy)
    .map((wallet) => ({
      id: wallet.id,
      key: wallet.strategy,
      enabled: wallet.mode !== 'DISABLED',
      mode: wallet.mode,
      allocationUsd: wallet.capital,
      params: strategyConfig[wallet.strategy] ?? {},
      universe: normalizeUniverse(
        getObjectFromObject(strategyConfig[wallet.strategy] ?? {}, ['universe'], {}),
      ),
      risk: normalizeStrategyRisk(wallet.riskLimits ?? wallet.risk_limits ?? {}),
      tags: [],
    }));
}

function normalizeLegacyWallets(parsed: any): Array<{
  id: string;
  mode: 'PAPER' | 'LIVE' | 'DISABLED';
  strategy: string;
  capital: number;
  riskLimits?: JsonMap;
  risk_limits?: JsonMap;
}> {
  const wallets = Array.isArray(parsed?.wallets) ? parsed.wallets : [];

  return wallets
    .filter((w) => w && typeof w === 'object')
    .map((wallet) => {
      const riskLimits = normalizeStrategyRisk(
        getObjectFromObject(wallet, ['risk_limits', 'riskLimits'], {}),
      );

      return {
        id: String(wallet.id ?? '').trim(),
        mode: normalizeMode(wallet.mode),
        strategy: String(wallet.strategy ?? '').trim(),
        capital: getNumberFromObject(wallet, ['capital'], 0),
        riskLimits,
        risk_limits: riskLimits,
      };
    })
    .filter((wallet) => wallet.id && wallet.strategy);
}

function normalizeLegacyStrategyConfig(parsed: any): Record<string, JsonMap> {
  const input = getObject(parsed, ['strategy_config', 'strategyConfig'], {});
  const out: Record<string, JsonMap> = {};

  for (const [key, value] of Object.entries(input)) {
    if (!value || typeof value !== 'object') continue;
    out[key] = { ...(value as JsonMap) };
  }

  return out;
}

/* =========================================================
 * Builders for compatibility
 * ======================================================= */

function buildLegacyWalletsFromStrategies(
  strategies: Array<{
    id: string;
    key: string;
    enabled: boolean;
    mode: 'PAPER' | 'LIVE' | 'DISABLED';
    allocationUsd: number;
    risk?: JsonMap;
  }>,
  liveAccountId: string,
): Array<{
  id: string;
  mode: 'PAPER' | 'LIVE' | 'DISABLED';
  strategy: string;
  capital: number;
  riskLimits?: JsonMap;
  risk_limits?: JsonMap;
}> {
  return strategies.map((strategy) => {
    const walletId =
      strategy.mode === 'LIVE'
        ? liveAccountId
        : strategy.id;

    const riskLimits = normalizeStrategyRisk(strategy.risk ?? {});

    return {
      id: walletId,
      mode: strategy.mode,
      strategy: strategy.key,
      capital: strategy.allocationUsd,
      riskLimits,
      risk_limits: riskLimits,
    };
  });
}

function buildLegacyStrategyConfigFromStrategies(
  strategies: Array<{
    key: string;
    params: JsonMap;
  }>,
): Record<string, JsonMap> {
  const out: Record<string, JsonMap> = {};

  for (const strategy of strategies) {
    out[strategy.key] = { ...(strategy.params ?? {}) };
  }

  return out;
}

/* =========================================================
 * Risk / universe / services normalization
 * ======================================================= */

function normalizeStrategyRisk(input: JsonMap): JsonMap {
  if (!input || typeof input !== 'object') return {};

  return {
    maxPositionUsd: getNumber(input, ['max_position_usd', 'maxPositionUsd'], undefined),
    maxExposurePerMarketUsd: getNumber(
      input,
      ['max_exposure_per_market_usd', 'maxExposurePerMarketUsd'],
      undefined,
    ),
    maxExposurePerEventUsd: getNumber(
      input,
      ['max_exposure_per_event_usd', 'maxExposurePerEventUsd'],
      undefined,
    ),
    maxOpenPositions: getNumber(
      input,
      ['max_open_positions', 'maxOpenPositions', 'max_open_trades', 'maxOpenTrades'],
      undefined,
    ),
    maxDailyLossUsd: getNumber(
      input,
      ['max_daily_loss_usd', 'maxDailyLossUsd', 'max_daily_loss', 'maxDailyLoss'],
      undefined,
    ),
    maxDrawdownPct: getNumber(
      input,
      ['max_drawdown_pct', 'maxDrawdownPct', 'max_drawdown', 'maxDrawdown'],
      undefined,
    ),
    maxOrdersPerMinute: getNumber(
      input,
      ['max_orders_per_minute', 'maxOrdersPerMinute'],
      undefined,
    ),
    maxCancelRate: getNumber(
      input,
      ['max_cancel_rate', 'maxCancelRate'],
      undefined,
    ),
    cooldownMsPerMarket: getNumber(
      input,
      ['cooldown_ms_per_market', 'cooldownMsPerMarket'],
      undefined,
    ),
  };
}

function normalizeAccountRisk(input: JsonMap): JsonMap {
  if (!input || typeof input !== 'object') return {};

  return {
    maxTotalExposureUsd: getNumber(
      input,
      ['max_total_exposure_usd', 'maxTotalExposureUsd'],
      undefined,
    ),
    maxExposurePerEventUsd: getNumber(
      input,
      ['max_exposure_per_event_usd', 'maxExposurePerEventUsd'],
      undefined,
    ),
    maxOpenOrders: getNumber(
      input,
      ['max_open_orders', 'maxOpenOrders'],
      undefined,
    ),
    maxDailyLossUsd: getNumber(
      input,
      ['max_daily_loss_usd', 'maxDailyLossUsd'],
      undefined,
    ),
    maxDrawdownPct: getNumber(
      input,
      ['max_drawdown_pct', 'maxDrawdownPct'],
      undefined,
    ),
    maxOrdersPerMinute: getNumber(
      input,
      ['max_orders_per_minute', 'maxOrdersPerMinute'],
      undefined,
    ),
  };
}

function normalizeUniverse(input: JsonMap): JsonMap {
  if (!input || typeof input !== 'object') return {};

  return {
    allowedMarketIds: getStringArray(
      input,
      ['allowed_market_ids', 'allowedMarketIds'],
      [],
    ),
    allowedEventSlugs: getStringArray(
      input,
      ['allowed_event_slugs', 'allowedEventSlugs'],
      [],
    ),
    allowedSeriesSlugs: getStringArray(
      input,
      ['allowed_series_slugs', 'allowedSeriesSlugs'],
      [],
    ),
    includeKeywords: getStringArray(
      input,
      ['include_keywords', 'includeKeywords'],
      [],
    ),
    excludeKeywords: getStringArray(
      input,
      ['exclude_keywords', 'excludeKeywords'],
      [],
    ),
    minLiquidityUsd: getNumber(
      input,
      ['min_liquidity_usd', 'minLiquidityUsd'],
      undefined,
    ),
    minVolume24h: getNumber(
      input,
      ['min_volume24h', 'minVolume24h'],
      undefined,
    ),
    maxDaysToResolution: getNumber(
      input,
      ['max_days_to_resolution', 'maxDaysToResolution'],
      undefined,
    ),
    requireActive: getBoolean(
      input,
      ['require_active', 'requireActive'],
      true,
    ),
    requireAcceptingOrders: getBoolean(
      input,
      ['require_accepting_orders', 'requireAcceptingOrders'],
      true,
    ),
  };
}

function normalizeWhaleServiceConfig(parsed: any): {
  enabled: boolean;
  baseUrl?: string;
  timeoutMs?: number;
} {
  // Nuevo esquema
  const whalesService = getObject(parsed, ['services.whales'], {});

  if (Object.keys(whalesService).length > 0) {
    return {
      enabled: getBoolean(whalesService, ['enabled'], false),
      baseUrl: getOptionalString(whalesService, ['base_url', 'baseUrl']),
      timeoutMs: getNumber(whalesService, ['timeout_ms', 'timeoutMs'], 5000),
    };
  }

  // Legacy whale_tracking -> adaptación mínima
  const legacy = getObject(parsed, ['whale_tracking'], {});
  return {
    enabled: getBoolean(legacy, ['enabled'], false),
    baseUrl: getOptionalString(legacy, ['base_url', 'baseUrl']),
    timeoutMs: getNumber(legacy, ['timeout_ms', 'timeoutMs'], 5000),
  };
}

/* =========================================================
 * Utilities
 * ======================================================= */

function hasLegacyLiveWallets(parsed: any): boolean {
  const wallets = Array.isArray(parsed?.wallets) ? parsed.wallets : [];
  return wallets.some((w) => String(w?.mode ?? '').toUpperCase() === 'LIVE');
}

function normalizeMode(value: unknown): 'PAPER' | 'LIVE' | 'DISABLED' {
  const mode = String(value ?? 'PAPER').toUpperCase();
  if (mode === 'LIVE') return 'LIVE';
  if (mode === 'DISABLED') return 'DISABLED';
  return 'PAPER';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

function getObject(source: any, paths: string[], fallback: JsonMap): JsonMap {
  for (const path of paths) {
    const value = getByPath(source, path);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as JsonMap;
    }
  }
  return fallback;
}

function getObjectFromObject(source: JsonMap, paths: string[], fallback: JsonMap): JsonMap {
  for (const path of paths) {
    const value = getByPath(source, path);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as JsonMap;
    }
  }
  return fallback;
}

function getString(source: any, paths: string[], fallback: string): string {
  for (const path of paths) {
    const value = getByPath(source, path);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

function getOptionalString(source: any, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = getByPath(source, path);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function getBoolean(source: any, paths: string[], fallback: boolean): boolean {
  for (const path of paths) {
    const value = getByPath(source, path);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
  }
  return fallback;
}

function getNumber(source: any, paths: string[], fallback: number | undefined): number | undefined {
  for (const path of paths) {
    const value = getByPath(source, path);
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

function getNumberFromObject(
  source: JsonMap,
  paths: string[],
  fallback: number,
): number {
  return getNumber(source, paths, fallback) ?? fallback;
}

function getStringArray(source: any, paths: string[], fallback: string[]): string[] {
  for (const path of paths) {
    const value = getByPath(source, path);
    if (Array.isArray(value)) {
      return normalizeStringArray(value);
    }
  }
  return fallback;
}

function getByPath(source: any, path: string): unknown {
  const segments = path.split('.');
  let current = source;

  for (const segment of segments) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}
