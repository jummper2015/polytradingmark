import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigValidator } from '../src/config_runtime/config_validator';
import { ConfigService } from '../src/config_runtime/config_service';
import { SqliteConfigStore } from '../src/config_runtime/config_store';
import { RuntimeConfigApplier } from '../src/config_runtime/runtime_config_applier';
import { DefaultValidationContextProvider } from '../src/config_runtime/default_validation_context_provider';
import { WalletManager } from '../src/wallets/wallet_manager';

import { makeBaseConfig } from './helpers/fixtures';
import { cleanupDir, makeTempDir } from './helpers/temp';

describe('ConfigService', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) cleanupDir(tempDir);
  });

  it('bootstraps effective config and creates version 1', async () => {
    tempDir = makeTempDir();

    const config = makeBaseConfig();
    const walletManager = new WalletManager(config);
    const store = new SqliteConfigStore(path.join(tempDir, 'config.db'));
    const validator = new ConfigValidator();
    const applier = new RuntimeConfigApplier();
    const contextProvider = new DefaultValidationContextProvider(walletManager);

    const service = new ConfigService(
      config,
      store,
      validator,
      contextProvider,
      applier,
    );

    const effective = await service.initialize('test');

    expect(effective.version).toBe(1);

    const saved = await store.getEffectiveConfig();
    expect(saved).toBeTruthy();
    expect(saved?.version).toBe(1);

    const versions = await store.listVersions();
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0].version).toBe(1);

    store.close();
  });

  it('applies a valid strategy risk change and bumps version', async () => {
    tempDir = makeTempDir();

    const config = makeBaseConfig();
    const walletManager = new WalletManager(config);
    const store = new SqliteConfigStore(path.join(tempDir, 'config.db'));
    const validator = new ConfigValidator();
    const applier = new RuntimeConfigApplier();
    const contextProvider = new DefaultValidationContextProvider(walletManager);

    const service = new ConfigService(
      config,
      store,
      validator,
      contextProvider,
      applier,
    );

    await service.initialize('test');

    const result = await service.submitAndApplyChange({
      targetType: 'STRATEGY',
      targetId: 'conv_01',
      requestedBy: 'tester',
      payload: {
        risk: {
          maxPositionUsd: 200,
        },
        reason: 'reduce risk',
      },
    });

    expect(result.validation.ok).toBe(true);
    expect(result.config?.version).toBe(2);

    const saved = await store.getEffectiveConfig();
    expect(saved?.strategies[0].risk.maxPositionUsd).toBe(200);

    store.close();
  });

  it('rejects invalid negative risk change', async () => {
    tempDir = makeTempDir();

    const config = makeBaseConfig();
    const walletManager = new WalletManager(config);
    const store = new SqliteConfigStore(path.join(tempDir, 'config.db'));
    const validator = new ConfigValidator();
    const applier = new RuntimeConfigApplier();
    const contextProvider = new DefaultValidationContextProvider(walletManager);

    const service = new ConfigService(
      config,
      store,
      validator,
      contextProvider,
      applier,
    );

    await service.initialize('test');

    const result = await service.submitAndApplyChange({
      targetType: 'STRATEGY',
      targetId: 'conv_01',
      requestedBy: 'tester',
      payload: {
        risk: {
          maxPositionUsd: -50,
        },
        reason: 'invalid change',
      },
    });

    expect(result.validation.ok).toBe(false);

    const saved = await store.getEffectiveConfig();
    expect(saved?.version).toBe(1);

    store.close();
  });
});