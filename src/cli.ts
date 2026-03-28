import fs from 'fs';
import path from 'path';
import { Command } from 'commander';

import { loadConfig } from './core/config_loader';
import { WalletManager } from './wallets/wallet_manager';
import { KillSwitch } from './risk/kill_switch';
import { RiskEngine } from './risk/risk_engine';
import { TradeExecutor } from './execution/trade_executor';
import { OrderRouter } from './execution/order_router';
import { Engine } from './core/engine';
import { DashboardServer } from './reporting/dashboard_server';

import { SqliteConfigStore } from './config_runtime/config_store';
import { ConfigValidator } from './config_runtime/config_validator';
import { ConfigService } from './config_runtime/config_service';
import { RuntimeConfigApplier } from './config_runtime/runtime_config_applier';
import { DefaultValidationContextProvider } from './config_runtime/default_validation_context_provider';

import {
  EngineConfigSubscriber,
  RiskEngineConfigSubscriber,
  DashboardConfigSubscriber,
  WalletManagerConfigSubscriber,
  OrderRouterConfigSubscriber,
} from './config_runtime/runtime_subscribers';

import { logger } from './reporting/logs';
import { consoleLog } from './reporting/console_log';

function ensureRuntimeDir(): void {
  const runtimeDir = path.resolve('.runtime');
  if (!fs.existsSync(runtimeDir)) {
    fs.mkdirSync(runtimeDir, { recursive: true });
  }
}

function syncRiskSnapshotFromWallets(
  walletManager: WalletManager,
  riskEngine: RiskEngine,
): void {
  const walletStates =
    typeof walletManager.getWalletStates === 'function'
      ? walletManager.getWalletStates()
      : [];

  const currentExposureUsd = walletStates.reduce((sum: number, state: any) => {
    const exposure = (state?.openPositions ?? []).reduce(
      (inner: number, pos: any) => {
        const size = Number(pos?.size ?? pos?.shares ?? 0);
        const price = Number(pos?.avgPrice ?? pos?.avgEntryPrice ?? 0);
        return inner + Math.abs(size * price);
      },
      0,
    );
    return sum + exposure;
  }, 0);

  const currentEquityUsd = walletStates.reduce((sum: number, state: any) => {
    const equity = Number(state?.currentEquity ?? state?.capitalAllocated ?? 0);
    return sum + (Number.isFinite(equity) ? equity : 0);
  }, 0);

  const peakEquityUsd = walletStates.reduce((sum: number, state: any) => {
    const peak = Number(state?.peakEquity ?? state?.capitalAllocated ?? 0);
    return sum + (Number.isFinite(peak) ? peak : 0);
  }, 0);

  const dailyPnlUsd = walletStates.reduce((sum: number, state: any) => {
    const pnl = Number(state?.dailyPnl ?? 0);
    return sum + (Number.isFinite(pnl) ? pnl : 0);
  }, 0);

  riskEngine.updateAccountRuntimeSnapshot({
    currentExposureUsd,
    openOrders: 0,
    dailyPnlUsd,
    currentEquityUsd,
    peakEquityUsd,
  });
}

async function startSystem(configPath: string) {
  ensureRuntimeDir();

  const config = loadConfig(configPath);

  const walletManager = new WalletManager(config);
  const killSwitch = new KillSwitch();
  const riskEngine = new RiskEngine(config, killSwitch);
  const tradeExecutor = new TradeExecutor();
  const orderRouter = new OrderRouter(walletManager, riskEngine, tradeExecutor);
  const engine = new Engine(config, walletManager, orderRouter);

  // Ajusta el constructor si tu DashboardServer actual usa otra firma.
  const dashboardServer = new DashboardServer(engine as any);

  const configStore = new SqliteConfigStore('.runtime/config.db');
  const configValidator = new ConfigValidator();
  const runtimeApplier = new RuntimeConfigApplier();
  const validationContextProvider =
    new DefaultValidationContextProvider(walletManager);

  runtimeApplier.registerSubscriber(
    'wallet_manager',
    new WalletManagerConfigSubscriber(walletManager),
  );

  runtimeApplier.registerSubscriber(
    'risk_engine',
    new RiskEngineConfigSubscriber(riskEngine),
  );

  runtimeApplier.registerSubscriber(
    'order_router',
    new OrderRouterConfigSubscriber(orderRouter),
  );

  runtimeApplier.registerSubscriber(
    'engine',
    new EngineConfigSubscriber(engine),
  );

  runtimeApplier.registerSubscriber(
    'dashboard',
    new DashboardConfigSubscriber(dashboardServer as any),
  );

  const configService = new ConfigService(
    config,
    configStore,
    configValidator,
    validationContextProvider,
    runtimeApplier,
  );

  // 1) Inicializar config efectiva y publicarla
  await configService.initialize('system');

  // 2) Inicializar wallets después de que ya recibieron runtimeConfig
  await walletManager.initialize();

  // 3) Snapshot básico de cuenta para el risk engine
  syncRiskSnapshotFromWallets(walletManager, riskEngine);

  // 4) Inicializar engine después de wallets + runtime config
  await engine.initialize();

  // 5) Arrancar dashboard
  if (typeof (dashboardServer as any).start === 'function') {
    await (dashboardServer as any).start();
  }

  // 6) Arrancar engine
  engine.start();

  consoleLog.success('BOOT', 'System started successfully', {
    configPath,
    runtimeVersion:
      configService && typeof configService.getEffectiveConfig === 'function'
        ? (await configService.getEffectiveConfig()).version
        : undefined,
    wallets:
      typeof walletManager.getWalletIds === 'function'
        ? walletManager.getWalletIds()
        : [],
    runners:
      typeof engine.listRunners === 'function'
        ? engine.listRunners().map((r: any) => ({
            strategyRunId: r.strategyRunId,
            strategy: r.strategyKey,
            mode: r.mode,
          }))
        : [],
  });

  logger.info('System started successfully');

  return {
    config,
    walletManager,
    killSwitch,
    riskEngine,
    tradeExecutor,
    orderRouter,
    engine,
    dashboardServer,
    configStore,
    configService,
    runtimeApplier,
  };
}

const program = new Command();

program
  .command('start')
  .option('-c, --config <path>', 'Path to config file', 'config.yaml')
  .action(async (opts) => {
    try {
      const app = await startSystem(opts.config);

      const shutdown = async (signal: string) => {
        consoleLog.warn('BOOT', `Shutdown signal received: ${signal}`);

        try {
          if (typeof app.engine?.stop === 'function') {
            await app.engine.stop();
          }

          if (typeof (app.dashboardServer as any)?.stop === 'function') {
            await (app.dashboardServer as any).stop();
          }

          if (typeof app.configStore?.close === 'function') {
            app.configStore.close();
          }
        } finally {
          process.exit(0);
        }
      };

      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      logger.error({ error }, 'System startup failed');
      consoleLog.error('BOOT', `Startup failed: ${msg}`);

      process.exit(1);
    }
  });

program.parseAsync(process.argv);
