import { randomUUID } from 'crypto';

import type { AppConfig, RunMode, Venue } from '../types';
import { ConfigValidator, type ValidatorContext } from './config_validator';
import { RuntimeConfigApplier } from './runtime_config_applier';
import type {
  AccountRiskPatch,
  ConfigChangeRequest,
  ConfigDiffEntry,
  ConfigPatchPayload,
  ConfigStore,
  ConfigTargetType,
  ConfigVersionSnapshot,
  EffectiveRuntimeConfig,
  StrategyAllocationPatch,
  StrategyLifecyclePatch,
  StrategyParamsPatch,
  StrategyRiskPatch,
  StrategyRuntimePolicy,
  StrategyUniversePatch,
  SystemControlPatch,
  ValidationResult,
} from './types';

/* =========================================================
 * Service contracts
 * ======================================================= */

export interface ValidationContextProvider {
  getValidatorContext(config: EffectiveRuntimeConfig): Promise<ValidatorContext>;
}

export interface CreateChangeRequestInput {
  targetType: ConfigTargetType;
  targetId: string;
  payload: ConfigPatchPayload;
  requestedBy: string;
  comment?: string;
  effectiveAt?: number;
}

export interface ApplyChangeRequestResult {
  request: ConfigChangeRequest;
  validation: ValidationResult;
  config?: EffectiveRuntimeConfig;
  diff: ConfigDiffEntry[];
  published: boolean;
}

/* =========================================================
 * Config service
 * ======================================================= */

export class ConfigService {
  private currentConfig: EffectiveRuntimeConfig | null = null;

constructor(
  private readonly baseConfig: AppConfig,
  private readonly store: ConfigStore,
  private readonly validator: ConfigValidator,
  private readonly contextProvider: ValidationContextProvider,
  private readonly runtimeApplier?: RuntimeConfigApplier,
) {}

  async initialize(actor = 'system'): Promise<EffectiveRuntimeConfig> {
    const stored = await this.store.getEffectiveConfig();

    if (stored) {
      this.currentConfig = stored;
      return stored;
    }

    const bootstrapConfig = this.buildBootstrapConfig(actor);
    const ctx = await this.contextProvider.getValidatorContext(bootstrapConfig);
    const validation = this.validator.validateEffectiveConfig(bootstrapConfig, ctx);

    if (!validation.ok) {
      throw new Error(
        `Bootstrap config inválida: ${validation.errors
          .map((e) => `${e.field}: ${e.message}`)
          .join(' | ')}`,
      );
    }

    await this.store.saveEffectiveConfig(bootstrapConfig);
    await this.store.createVersion({
      version: bootstrapConfig.version,
      source: bootstrapConfig.source,
      config: bootstrapConfig,
      createdAt: bootstrapConfig.generatedAt,
      createdBy: actor,
      comment: 'Bootstrap inicial desde config.yaml',
    });

    await this.store.appendAuditLog({
      auditId: randomUUID(),
      actor,
      action: 'BOOTSTRAP_CONFIG',
      targetType: 'SYSTEM',
      targetId: 'system',
      versionAfter: bootstrapConfig.version,
      result: 'SUCCESS',
      message: 'Configuración inicial creada desde config base.',
      createdAt: Date.now(),
    });

    if (this.runtimeApplier) {
  await this.runtimeApplier.publish(bootstrapConfig);
}

    this.currentConfig = bootstrapConfig;
    return bootstrapConfig;
  }

  async getEffectiveConfig(): Promise<EffectiveRuntimeConfig> {
    if (this.currentConfig) return this.currentConfig;

    const stored = await this.store.getEffectiveConfig();
    if (!stored) {
      return this.initialize();
    }

    this.currentConfig = stored;
    return stored;
  }

  async createChangeRequest(input: CreateChangeRequestInput): Promise<ConfigChangeRequest> {
    const request: ConfigChangeRequest = {
      requestId: randomUUID(),
      targetType: input.targetType,
      targetId: input.targetId,
      payload: input.payload,
      status: 'PENDING',
      requestedBy: input.requestedBy,
      requestedAt: Date.now(),
      effectiveAt: input.effectiveAt,
      comment: input.comment,
    };

    await this.store.createChangeRequest(request);

    await this.store.appendAuditLog({
      auditId: randomUUID(),
      actor: input.requestedBy,
      action: 'CREATE_CHANGE_REQUEST',
      targetType: input.targetType,
      targetId: input.targetId,
      requestId: request.requestId,
      result: 'SUCCESS',
      message: this.extractReason(input.payload) ?? 'Solicitud de cambio creada.',
      createdAt: Date.now(),
    });

    return request;
  }

  async submitAndApplyChange(
    input: CreateChangeRequestInput,
    approvedBy?: string,
  ): Promise<ApplyChangeRequestResult> {
    const request = await this.createChangeRequest(input);
    return this.applyChangeRequest(request.requestId, approvedBy ?? input.requestedBy);
  }

  async applyChangeRequest(
    requestId: string,
    approvedBy: string,
  ): Promise<ApplyChangeRequestResult> {
    const request = await this.store.getChangeRequest(requestId);

    if (!request) {
      throw new Error(`Change request no encontrado: ${requestId}`);
    }

    const currentConfig = await this.getEffectiveConfig();
    const ctx = await this.contextProvider.getValidatorContext(currentConfig);

    // Validar request contra el estado actual
    const requestValidation = this.validator.validateChangeRequest(request, ctx);

    if (!requestValidation.ok) {
      await this.store.updateChangeRequestStatus(
        request.requestId,
        'REJECTED',
        requestValidation.errors,
        requestValidation.warnings,
      );

      await this.store.appendAuditLog({
        auditId: randomUUID(),
        actor: approvedBy,
        action: 'APPLY_CHANGE_REQUEST',
        targetType: request.targetType,
        targetId: request.targetId,
        requestId: request.requestId,
        versionBefore: currentConfig.version,
        result: 'FAILURE',
        message: `Request rechazado por validación: ${requestValidation.errors
          .map((e) => `${e.field}: ${e.message}`)
          .join(' | ')}`,
        createdAt: Date.now(),
      });

      return {
        request,
        validation: requestValidation,
        diff: [],
        published: false,
      };
    }

    // Aplicar patch sobre la config efectiva actual
    const candidateConfig = this.applyRequestToConfig(currentConfig, request, approvedBy);

    // Validar coherencia global de la nueva config
    const nextCtx = await this.contextProvider.getValidatorContext(candidateConfig);
    const configValidation = this.validator.validateEffectiveConfig(candidateConfig, nextCtx);

    if (!configValidation.ok) {
      await this.store.updateChangeRequestStatus(
        request.requestId,
        'REJECTED',
        configValidation.errors,
        configValidation.warnings,
      );

      await this.store.appendAuditLog({
        auditId: randomUUID(),
        actor: approvedBy,
        action: 'APPLY_CHANGE_REQUEST',
        targetType: request.targetType,
        targetId: request.targetId,
        requestId: request.requestId,
        versionBefore: currentConfig.version,
        result: 'FAILURE',
        message: `Config resultante inválida: ${configValidation.errors
          .map((e) => `${e.field}: ${e.message}`)
          .join(' | ')}`,
        createdAt: Date.now(),
      });

      return {
        request,
        validation: configValidation,
        diff: [],
        published: false,
      };
    }

const diff = this.buildDiff(currentConfig, candidateConfig);
const finalConfig: EffectiveRuntimeConfig = {
  ...candidateConfig,
  version: currentConfig.version + 1,
  generatedAt: Date.now(),
  source: 'ADMIN_CHANGE',
};

    //await this.store.saveEffectiveConfig(finalConfig);
    // 1) Primero intentar aplicar al runtime
const applyResult = this.runtimeApplier
  ? await this.runtimeApplier.applyChange({
      request,
      previousConfig: currentConfig,
      nextConfig: finalConfig,
    })
  : {
      requestId: request.requestId,
      targetType: request.targetType,
      targetId: request.targetId,
      applyMode: 'HOT_APPLY' as const,
      applied: true,
      appliedAt: Date.now(),
      message: 'Sin runtimeApplier; cambio aceptado localmente.',
    };
/*
    const versionSnapshot: ConfigVersionSnapshot = {
      version: finalConfig.version,
      source: finalConfig.source,
      config: finalConfig,
      createdAt: finalConfig.generatedAt,
      createdBy: approvedBy,
      comment: this.extractReason(request.payload) ?? request.comment,
    };
*/
    // 2) Si el runtime no pudo aplicarla, no persistimos
if (!applyResult.applied) {
  await this.store.updateChangeRequestStatus(
    request.requestId,
    'REJECTED',
    undefined,
    configValidation.warnings,
  );
   // await this.store.createVersion(versionSnapshot);
/*
    await this.store.updateChangeRequestStatus(
      request.requestId,
      'APPLIED',
      undefined,
      [...requestValidation.warnings, ...configValidation.warnings],
    );
*/
    /*
    await this.store.appendAuditLog({
      auditId: randomUUID(),
      actor: approvedBy,
      action: 'APPLY_CHANGE_REQUEST',
      targetType: request.targetType,
      targetId: request.targetId,
      requestId: request.requestId,
      versionBefore: currentConfig.version,
      versionAfter: finalConfig.version,
      diff,
      result: 'SUCCESS',
      message: this.extractReason(request.payload) ?? 'Cambio aplicado.',
      createdAt: Date.now(),
    });
*/
    const applyResult = this.publisher
  ? await this.publisher.applyChange({
      request,
      previousConfig: currentConfig,
      nextConfig: finalConfig,
    })
  : {
      requestId: request.requestId,
      targetType: request.targetType,
      targetId: request.targetId,
      applyMode: 'HOT_APPLY',
      applied: true,
      appliedAt: Date.now(),
      message: 'Sin publisher runtime; cambio aceptado.',
    };

if (!applyResult.applied) {
  await this.store.updateChangeRequestStatus(
    request.requestId,
    'REJECTED',
    undefined,
    [],
  );

  await this.store.appendAuditLog({
    auditId: randomUUID(),
    actor: approvedBy,
    action: 'APPLY_CHANGE_REQUEST',
    targetType: request.targetType,
    targetId: request.targetId,
    requestId: request.requestId,
    versionBefore: currentConfig.version,
    result: 'FAILURE',
    message: applyResult.message ?? 'Falló la aplicación runtime.',
    createdAt: Date.now(),
  });

  return {
    request: {
      ...request,
      status: 'REJECTED',
      approvedBy,
      approvedAt: Date.now(),
    },
    validation: {
      ok: false,
      errors: [],
      warnings: configValidation.warnings,
    },
    diff: [],
    published: false,
  };
}
/*
    this.currentConfig = finalConfig;

    return {
      request: {
        ...request,
        status: 'APPLIED',
        approvedBy,
        approvedAt: Date.now(),
      },
      validation: {
        ok: true,
        errors: [],
        warnings: [...requestValidation.warnings, ...configValidation.warnings],
      },
      config: finalConfig,
      diff,
      published: Boolean(this.publisher),
    };
    */
  }
    // 3) Si el runtime sí la aplicó, recién ahí persistimos
await this.store.saveEffectiveConfig(finalConfig);

const versionSnapshot: ConfigVersionSnapshot = {
  version: finalConfig.version,
  source: finalConfig.source,
  config: finalConfig,
  createdAt: finalConfig.generatedAt,
  createdBy: approvedBy,
  comment: this.extractReason(request.payload) ?? request.comment,
};

await this.store.createVersion(versionSnapshot);

await this.store.updateChangeRequestStatus(
  request.requestId,
  'APPLIED',
  undefined,
  [...requestValidation.warnings, ...configValidation.warnings],
);

  await this.store.appendAuditLog({
  auditId: randomUUID(),
  actor: approvedBy,
  action: 'APPLY_CHANGE_REQUEST',
  targetType: request.targetType,
  targetId: request.targetId,
  requestId: request.requestId,
  versionBefore: currentConfig.version,
  versionAfter: finalConfig.version,
  diff,
  result: 'SUCCESS',
  message:
    applyResult.message ??
    this.extractReason(request.payload) ??
    'Cambio aplicado.',
  createdAt: Date.now(),
});

this.currentConfig = finalConfig;

return {
  request: {
    ...request,
    status: 'APPLIED',
    approvedBy,
    approvedAt: Date.now(),
  },
  validation: {
    ok: true,
    errors: [],
    warnings: [...requestValidation.warnings, ...configValidation.warnings],
  },
  config: finalConfig,
  diff,
  published: Boolean(this.runtimeApplier),
};

  async rollbackToVersion(
    version: number,
    actor: string,
    reason: string,
  ): Promise<EffectiveRuntimeConfig> {
    const target = await this.store.getVersion(version);
    if (!target) {
      throw new Error(`No existe la versión ${version}`);
    }

    const currentConfig = await this.getEffectiveConfig();

    const rollbackConfig: EffectiveRuntimeConfig = {
      ...this.clone(target.config),
      version: currentConfig.version + 1,
      generatedAt: Date.now(),
      source: 'ROLLBACK',
    };

    const ctx = await this.contextProvider.getValidatorContext(rollbackConfig);
    const validation = this.validator.validateEffectiveConfig(rollbackConfig, ctx);

    if (!validation.ok) {
      throw new Error(
        `Rollback inválido: ${validation.errors
          .map((e) => `${e.field}: ${e.message}`)
          .join(' | ')}`,
      );
    }

    const diff = this.buildDiff(currentConfig, rollbackConfig);

    await this.store.saveEffectiveConfig(rollbackConfig);
    await this.store.createVersion({
      version: rollbackConfig.version,
      source: rollbackConfig.source,
      config: rollbackConfig,
      createdAt: rollbackConfig.generatedAt,
      createdBy: actor,
      comment: reason,
    });

    await this.store.appendAuditLog({
      auditId: randomUUID(),
      actor,
      action: 'ROLLBACK_CONFIG',
      targetType: 'SYSTEM',
      targetId: 'system',
      versionBefore: currentConfig.version,
      versionAfter: rollbackConfig.version,
      diff,
      result: 'SUCCESS',
      message: reason,
      createdAt: Date.now(),
    });

 if (this.runtimeApplier) {
  await this.runtimeApplier.publish(rollbackConfig);
}

    this.currentConfig = rollbackConfig;
    return rollbackConfig;
  }

  /* =========================================================
   * Bootstrap mapping
   * ======================================================= */

  private buildBootstrapConfig(actor: string): EffectiveRuntimeConfig {
    const now = Date.now();

    return {
      version: 1,
      generatedAt: now,
      source: 'BOOTSTRAP',
      account: {
        accountId: this.baseConfig.account.live.accountId,
        venue: this.baseConfig.account.live.venue as Venue,
        liveEnabled:
          this.baseConfig.environment.enableLiveTrading &&
          this.baseConfig.account.live.enabled,
        risk: {
          ...(this.baseConfig.account.risk ?? {}),
          killSwitch: false,
          reduceOnlyGlobal: false,
        },
        updatedAt: now,
        updatedBy: actor,
      },
      strategies: this.baseConfig.strategies.map((strategy) => ({
        strategyRunId: strategy.id,
        key: strategy.key,
        venue: 'POLYMARKET',
        enabled: strategy.enabled,
        mode: strategy.mode,
        executionState: this.initialExecutionState(strategy.enabled, strategy.mode),
        allocation: {
          mode: 'FIXED_USD',
          value: strategy.allocationUsd,
          resolvedUsd: strategy.allocationUsd,
        },
        risk: { ...(strategy.risk ?? {}) },
        universe: strategy.universe
          ? { ...strategy.universe }
          : undefined,
        tags: strategy.tags ? [...strategy.tags] : [],
        params: strategy.params ? { ...strategy.params } : {},
        updatedAt: now,
        updatedBy: actor,
      })),
    };
  }

  private initialExecutionState(enabled: boolean, mode: RunMode) {
    if (!enabled || mode === 'DISABLED') return 'STOPPED';
    return 'ACTIVE';
  }

  /* =========================================================
   * Patch application
   * ======================================================= */

  private applyRequestToConfig(
    current: EffectiveRuntimeConfig,
    request: ConfigChangeRequest,
    actor: string,
  ): EffectiveRuntimeConfig {
    const next = this.clone(current);
    const now = Date.now();

    switch (request.targetType) {
      case 'STRATEGY':
      case 'UNIVERSE': {
        const strategy = next.strategies.find(
          (s) => s.strategyRunId === request.targetId,
        );

        if (!strategy) {
          throw new Error(`No existe strategyRunId=${request.targetId}`);
        }

        this.applyStrategyPayload(strategy, request.payload, actor, now);
        break;
      }

      case 'ACCOUNT': {
        this.applyAccountPayload(next, request.payload, actor, now);
        break;
      }

      case 'SYSTEM': {
        this.applySystemPayload(next, request.payload, actor, now);
        break;
      }

      default:
        throw new Error(`targetType no soportado: ${request.targetType}`);
    }

    return next;
  }

  private applyStrategyPayload(
    strategy: StrategyRuntimePolicy,
    payload: ConfigPatchPayload,
    actor: string,
    now: number,
  ): void {
    if (this.isStrategyAllocationPatch(payload)) {
      strategy.allocation = {
        ...payload.allocation,
      };
      strategy.updatedAt = now;
      strategy.updatedBy = actor;
      return;
    }

    if (this.isStrategyRiskPatch(payload)) {
      strategy.risk = {
        ...strategy.risk,
        ...payload.risk,
      };
      strategy.updatedAt = now;
      strategy.updatedBy = actor;
      return;
    }

    if (this.isStrategyUniversePatch(payload)) {
      strategy.universe = {
        ...(strategy.universe ?? {}),
        ...payload.universe,
      };
      strategy.updatedAt = now;
      strategy.updatedBy = actor;
      return;
    }

    if (this.isStrategyParamsPatch(payload)) {
      strategy.params = {
        ...(strategy.params ?? {}),
        ...payload.params,
      };
      strategy.updatedAt = now;
      strategy.updatedBy = actor;
      return;
    }

    if (this.isStrategyLifecyclePatch(payload)) {
      this.applyLifecycleAction(strategy, payload.action);
      strategy.updatedAt = now;
      strategy.updatedBy = actor;
      return;
    }

    throw new Error('Payload de estrategia no soportado.');
  }

  private applyLifecycleAction(
    strategy: StrategyRuntimePolicy,
    action: StrategyLifecyclePatch['action'],
  ): void {
    switch (action) {
      case 'PAUSE':
        strategy.executionState = 'PAUSED';
        return;

      case 'RESUME':
        strategy.executionState = 'ACTIVE';
        return;

      case 'REDUCE_ONLY_ON':
        strategy.executionState = 'REDUCE_ONLY';
        return;

      case 'REDUCE_ONLY_OFF':
        strategy.executionState = 'ACTIVE';
        return;

      case 'ENABLE':
        strategy.enabled = true;
        if (strategy.mode !== 'DISABLED') {
          strategy.executionState = 'ACTIVE';
        }
        return;

      case 'DISABLE':
        strategy.enabled = false;
        strategy.executionState = 'STOPPED';
        return;

      case 'PROMOTE_TO_LIVE':
        strategy.mode = 'LIVE';
        strategy.enabled = true;
        strategy.executionState = 'ACTIVE';
        return;

      case 'DEMOTE_TO_PAPER':
        strategy.mode = 'PAPER';
        strategy.enabled = true;
        strategy.executionState = 'ACTIVE';
        return;

      default:
        throw new Error(`Lifecycle action no soportada: ${String(action)}`);
    }
  }

  private applyAccountPayload(
    config: EffectiveRuntimeConfig,
    payload: ConfigPatchPayload,
    actor: string,
    now: number,
  ): void {
    if (!this.isAccountRiskPatch(payload)) {
      throw new Error('Payload de account no soportado.');
    }

    config.account.risk = {
      ...config.account.risk,
      ...payload.risk,
    };
    config.account.updatedAt = now;
    config.account.updatedBy = actor;
  }

  private applySystemPayload(
    config: EffectiveRuntimeConfig,
    payload: ConfigPatchPayload,
    actor: string,
    now: number,
  ): void {
    if (!this.isSystemControlPatch(payload)) {
      throw new Error('Payload de system no soportado.');
    }

    switch (payload.action) {
      case 'KILL_SWITCH_ON':
        config.account.risk.killSwitch = true;
        break;

      case 'KILL_SWITCH_OFF':
        config.account.risk.killSwitch = false;
        break;

      default:
        throw new Error(`System action no soportada: ${payload.action}`);
    }

    config.account.updatedAt = now;
    config.account.updatedBy = actor;
  }

  /* =========================================================
   * Diff / helpers
   * ======================================================= */

  private buildDiff(
    before: unknown,
    after: unknown,
    prefix = '',
  ): ConfigDiffEntry[] {
    if (this.isPrimitive(before) || this.isPrimitive(after)) {
      if (before !== after) {
        return [
          {
            path: prefix || 'root',
            beforeValue: before,
            afterValue: after,
          },
        ];
      }
      return [];
    }

    if (Array.isArray(before) || Array.isArray(after)) {
      const beforeJson = JSON.stringify(before);
      const afterJson = JSON.stringify(after);

      if (beforeJson !== afterJson) {
        return [
          {
            path: prefix || 'root',
            beforeValue: before,
            afterValue: after,
          },
        ];
      }
      return [];
    }

    const beforeObj = (before ?? {}) as Record<string, unknown>;
    const afterObj = (after ?? {}) as Record<string, unknown>;
    const keys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);

    const diff: ConfigDiffEntry[] = [];

    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      diff.push(...this.buildDiff(beforeObj[key], afterObj[key], path));
    }

    return diff;
  }

  private isPrimitive(value: unknown): boolean {
    return (
      value == null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    );
  }

  private clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private extractReason(payload: ConfigPatchPayload): string | undefined {
    if ('reason' in payload && typeof payload.reason === 'string') {
      return payload.reason;
    }
    return undefined;
  }

  /* =========================================================
   * Type guards
   * ======================================================= */

  private isStrategyAllocationPatch(
    payload: ConfigPatchPayload,
  ): payload is StrategyAllocationPatch {
    return 'allocation' in payload;
  }

  private isStrategyRiskPatch(
    payload: ConfigPatchPayload,
  ): payload is StrategyRiskPatch {
    return 'risk' in payload &&
      !('allocation' in payload) &&
      !('params' in payload) &&
      !('universe' in payload) &&
      !('action' in payload);
  }

  private isStrategyUniversePatch(
    payload: ConfigPatchPayload,
  ): payload is StrategyUniversePatch {
    return 'universe' in payload;
  }

  private isStrategyParamsPatch(
    payload: ConfigPatchPayload,
  ): payload is StrategyParamsPatch {
    return 'params' in payload;
  }

  private isStrategyLifecyclePatch(
    payload: ConfigPatchPayload,
  ): payload is StrategyLifecyclePatch {
    return 'action' in payload &&
      [
        'PAUSE',
        'RESUME',
        'REDUCE_ONLY_ON',
        'REDUCE_ONLY_OFF',
        'PROMOTE_TO_LIVE',
        'DEMOTE_TO_PAPER',
        'DISABLE',
        'ENABLE',
      ].includes(payload.action);
  }

  private isAccountRiskPatch(
    payload: ConfigPatchPayload,
  ): payload is AccountRiskPatch {
    return 'risk' in payload &&
      !('allocation' in payload) &&
      !('params' in payload) &&
      !('universe' in payload) &&
      !('action' in payload);
  }

  private isSystemControlPatch(
    payload: ConfigPatchPayload,
  ): payload is SystemControlPatch {
    return 'action' in payload &&
      ['KILL_SWITCH_ON', 'KILL_SWITCH_OFF'].includes(payload.action);
  }
  private applyStrategyPayload(...) {
  ...
  if (this.isStrategyParamsPatch(payload)) {
    strategy.params = {
      ...(strategy.params ?? {}),
      ...payload.params,
    };
    ...
  }
}
}
