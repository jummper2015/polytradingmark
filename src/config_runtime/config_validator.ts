import type { MarketUniverseConfig, RunMode } from '../types';
import type {
  AccountRiskPatch,
  AllocationPolicy,
  ConfigChangeRequest,
  ConfigPatchPayload,
  EffectiveRuntimeConfig,
  StrategyAllocationPatch,
  StrategyLifecyclePatch,
  StrategyParamsPatch,
  StrategyRiskPatch,
  StrategyRuntimePolicy,
  StrategyUniversePatch,
  SystemControlPatch,
  ValidationError,
  ValidationResult,
  ValidationWarning,
} from './types';

/* =========================================================
 * Runtime state snapshots used by validation
 * ======================================================= */

export interface StrategyRuntimeStateSnapshot {
  strategyRunId: string;
  currentExposureUsd: number;
  openPositions: number;
  openOrders: number;
  hasPendingOrders: boolean;
}

export interface ValidatorContext {
  currentConfig: EffectiveRuntimeConfig;

  accountEquityUsd: number;
  accountCurrentExposureUsd: number;
  accountOpenOrders: number;

  liveTradingEnabled: boolean;
  liveAdapterAvailable: boolean;

  strategyStateById: Record<string, StrategyRuntimeStateSnapshot>;

  knownEventSlugs?: Set<string>;
  knownSeriesSlugs?: Set<string>;
}

/* =========================================================
 * Validator
 * ======================================================= */

export class ConfigValidator {
  validateChangeRequest(
    request: ConfigChangeRequest,
    ctx: ValidatorContext,
  ): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    if (!request.requestedBy?.trim()) {
      errors.push(this.err('REQUESTOR_REQUIRED', 'requestedBy', 'requestedBy es obligatorio.'));
    }

    if (!request.reason && !('reason' in request.payload)) {
      warnings.push(this.warn('REASON_MISSING', 'payload.reason', 'El cambio debería incluir una razón explícita.'));
    }

    switch (request.targetType) {
      case 'STRATEGY':
        this.validateStrategyRequest(request, ctx, errors, warnings);
        break;

      case 'ACCOUNT':
        this.validateAccountRequest(request, ctx, errors, warnings);
        break;

      case 'SYSTEM':
        this.validateSystemRequest(request, ctx, errors, warnings);
        break;

      case 'UNIVERSE':
        this.validateUniverseRequest(request, ctx, errors, warnings);
        break;

      default:
        errors.push(this.err('UNKNOWN_TARGET_TYPE', 'targetType', `targetType no soportado: ${String(request.targetType)}`));
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
    };
  }

  validateEffectiveConfig(config: EffectiveRuntimeConfig, ctx: ValidatorContext): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    if (config.version < 1) {
      errors.push(this.err('INVALID_VERSION', 'version', 'La versión debe ser mayor o igual a 1.'));
    }

    if (!config.account.accountId?.trim()) {
      errors.push(this.err('ACCOUNT_ID_REQUIRED', 'account.accountId', 'accountId es obligatorio.'));
    }

    const liveStrategies = config.strategies.filter(
      (s) => s.enabled && s.mode === 'LIVE',
    );

    if (liveStrategies.length > 0 && !ctx.liveTradingEnabled) {
      errors.push(
        this.err(
          'LIVE_DISABLED',
          'account.liveEnabled',
          'Hay estrategias LIVE pero el trading live no está habilitado.',
        ),
      );
    }

    if (liveStrategies.length > 0 && !ctx.liveAdapterAvailable) {
      errors.push(
        this.err(
          'LIVE_ADAPTER_UNAVAILABLE',
          'account.liveEnabled',
          'Hay estrategias LIVE pero no hay adapter live disponible.',
        ),
      );
    }

    let totalResolvedLiveAllocation = 0;

    for (const strategy of config.strategies) {
      this.validateStrategyPolicy(strategy, ctx, errors, warnings);

      if (strategy.enabled && strategy.mode === 'LIVE') {
        totalResolvedLiveAllocation += this.resolveAllocationUsd(
          strategy.allocation,
          ctx.accountEquityUsd,
        );
      }
    }

    if (
      totalResolvedLiveAllocation > ctx.accountEquityUsd &&
      liveStrategies.length > 0
    ) {
      warnings.push(
        this.warn(
          'LIVE_ALLOCATIONS_EXCEED_EQUITY',
          'strategies',
          `La suma de allocations LIVE (${totalResolvedLiveAllocation.toFixed(
            2,
          )}) supera el equity actual (${ctx.accountEquityUsd.toFixed(2)}).`,
        ),
      );
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
    };
  }

  /* =======================================================
   * Request-level validation
   * ===================================================== */

  private validateStrategyRequest(
    request: ConfigChangeRequest,
    ctx: ValidatorContext,
    errors: ValidationError[],
    warnings: ValidationWarning[],
  ): void {
    const strategy = this.findStrategy(ctx.currentConfig, request.targetId);

    if (!strategy) {
      errors.push(
        this.err(
          'STRATEGY_NOT_FOUND',
          'targetId',
          `No existe la estrategia ${request.targetId}.`,
        ),
      );
      return;
    }

    const payload = request.payload;

    if (this.isStrategyAllocationPatch(payload)) {
      this.validateStrategyAllocationPatch(strategy, payload, ctx, errors, warnings);
      return;
    }

    if (this.isStrategyRiskPatch(payload)) {
      this.validateStrategyRiskPatch(strategy, payload, ctx, errors, warnings);
      return;
    }

    if (this.isStrategyUniversePatch(payload)) {
      this.validateStrategyUniversePatch(strategy, payload, ctx, errors, warnings);
      return;
    }

    if (this.isStrategyParamsPatch(payload)) {
      this.validateStrategyParamsPatch(strategy, payload, errors, warnings);
      return;
    }

    if (this.isStrategyLifecyclePatch(payload)) {
      this.validateStrategyLifecyclePatch(strategy, payload, ctx, errors, warnings);
      return;
    }

    errors.push(this.err('INVALID_STRATEGY_PAYLOAD', 'payload', 'Payload de estrategia no reconocido.'));
  }

  private validateAccountRequest(
    request: ConfigChangeRequest,
    ctx: ValidatorContext,
    errors: ValidationError[],
    warnings: ValidationWarning[],
  ): void {
    const payload = request.payload;

    if (!this.isAccountRiskPatch(payload)) {
      errors.push(this.err('INVALID_ACCOUNT_PAYLOAD', 'payload', 'Payload de account no reconocido.'));
      return;
    }

    const risk = payload.risk;

    this.validatePositiveNumber(risk.maxTotalExposureUsd, 'risk.maxTotalExposureUsd', errors);
    this.validatePositiveNumber(risk.maxExposurePerEventUsd, 'risk.maxExposurePerEventUsd', errors);
    this.validatePositiveInteger(risk.maxOpenOrders, 'risk.maxOpenOrders', errors);
    this.validatePositiveNumber(risk.maxDailyLossUsd, 'risk.maxDailyLossUsd', errors);
    this.validatePct(risk.maxDrawdownPct, 'risk.maxDrawdownPct', errors);
    this.validatePositiveInteger(risk.maxOrdersPerMinute, 'risk.maxOrdersPerMinute', errors);

    if (
      risk.maxExposurePerEventUsd != null &&
      risk.maxTotalExposureUsd != null &&
      risk.maxExposurePerEventUsd > risk.maxTotalExposureUsd
    ) {
      errors.push(
        this.err(
          'EVENT_EXPOSURE_GT_TOTAL',
          'risk.maxExposurePerEventUsd',
          'La exposición por evento no puede superar la exposición total.',
          risk.maxExposurePerEventUsd,
          risk.maxTotalExposureUsd,
        ),
      );
    }

    if (
      risk.maxTotalExposureUsd != null &&
      risk.maxTotalExposureUsd < ctx.accountCurrentExposureUsd
    ) {
      warnings.push(
        this.warn(
          'TOTAL_EXPOSURE_BELOW_CURRENT',
          'risk.maxTotalExposureUsd',
          'El nuevo límite total queda por debajo de la exposición actual. Se aplicará solo para nuevas entradas o requerirá reduce-only.',
          ctx.accountCurrentExposureUsd,
          risk.maxTotalExposureUsd,
        ),
      );
    }

    if (
      risk.maxOpenOrders != null &&
      risk.maxOpenOrders < ctx.accountOpenOrders
    ) {
      warnings.push(
        this.warn(
          'MAX_OPEN_ORDERS_BELOW_CURRENT',
          'risk.maxOpenOrders',
          'El nuevo límite de open orders queda por debajo del estado actual.',
          ctx.accountOpenOrders,
          risk.maxOpenOrders,
        ),
      );
    }
  }

  private validateSystemRequest(
    request: ConfigChangeRequest,
    _ctx: ValidatorContext,
    errors: ValidationError[],
    _warnings: ValidationWarning[],
  ): void {
    const payload = request.payload;

    if (!this.isSystemControlPatch(payload)) {
      errors.push(this.err('INVALID_SYSTEM_PAYLOAD', 'payload', 'Payload de system no reconocido.'));
      return;
    }

    if (!payload.reason?.trim()) {
      errors.push(this.err('REASON_REQUIRED', 'payload.reason', 'La razón del cambio es obligatoria.'));
    }

    const allowed = new Set(['KILL_SWITCH_ON', 'KILL_SWITCH_OFF']);
    if (!allowed.has(payload.action)) {
      errors.push(this.err('INVALID_SYSTEM_ACTION', 'payload.action', `Acción inválida: ${payload.action}`));
    }
  }

  private validateUniverseRequest(
    request: ConfigChangeRequest,
    ctx: ValidatorContext,
    errors: ValidationError[],
    warnings: ValidationWarning[],
  ): void {
    const strategy = this.findStrategy(ctx.currentConfig, request.targetId);

    if (!strategy) {
      errors.push(
        this.err(
          'STRATEGY_NOT_FOUND',
          'targetId',
          `No existe la estrategia ${request.targetId}.`,
        ),
      );
      return;
    }

    const payload = request.payload;
    if (!this.isStrategyUniversePatch(payload)) {
      errors.push(this.err('INVALID_UNIVERSE_PAYLOAD', 'payload', 'Payload de universo no reconocido.'));
      return;
    }

    this.validateStrategyUniversePatch(strategy, payload, ctx, errors, warnings);
  }

  /* =======================================================
   * Strategy patch validation
   * ===================================================== */

  private validateStrategyAllocationPatch(
    strategy: StrategyRuntimePolicy,
    patch: StrategyAllocationPatch,
    ctx: ValidatorContext,
    errors: ValidationError[],
    warnings: ValidationWarning[],
  ): void {
    if (!patch.reason?.trim()) {
      errors.push(this.err('REASON_REQUIRED', 'payload.reason', 'La razón del cambio es obligatoria.'));
    }

    if (!patch.allocation) {
      errors.push(this.err('ALLOCATION_REQUIRED', 'payload.allocation', 'allocation es obligatoria.'));
      return;
    }

    this.validateAllocationPolicy(patch.allocation, 'payload.allocation', ctx, errors);

    const resolvedUsd = this.resolveAllocationUsd(patch.allocation, ctx.accountEquityUsd);
    const strategyState = ctx.strategyStateById[strategy.strategyRunId];

    if (strategyState && resolvedUsd < strategyState.currentExposureUsd) {
      warnings.push(
        this.warn(
          'ALLOCATION_BELOW_CURRENT_EXPOSURE',
          'payload.allocation',
          'La nueva allocation queda por debajo de la exposición actual. Solo debería aplicarse para nuevas entradas o con reduce-only.',
          strategyState.currentExposureUsd,
          resolvedUsd,
        ),
      );
    }

    const projectedLiveAllocation = this.calculateProjectedTotalLiveAllocation(
      ctx.currentConfig,
      ctx.accountEquityUsd,
      strategy.strategyRunId,
      patch.allocation,
      undefined,
    );

    if (
      (strategy.mode === 'LIVE' || (strategy.mode !== 'LIVE' && strategy.enabled && ctx.liveTradingEnabled)) &&
      projectedLiveAllocation > ctx.accountEquityUsd
    ) {
      warnings.push(
        this.warn(
          'PROJECTED_LIVE_ALLOCATION_EXCEEDS_EQUITY',
          'payload.allocation',
          'La suma proyectada de allocations LIVE supera el equity actual.',
          projectedLiveAllocation,
          ctx.accountEquityUsd,
        ),
      );
    }
  }

  private validateStrategyRiskPatch(
    strategy: StrategyRuntimePolicy,
    patch: StrategyRiskPatch,
    ctx: ValidatorContext,
    errors: ValidationError[],
    warnings: ValidationWarning[],
  ): void {
    if (!patch.reason?.trim()) {
      errors.push(this.err('REASON_REQUIRED', 'payload.reason', 'La razón del cambio es obligatoria.'));
    }

    const risk = patch.risk;
    const state = ctx.strategyStateById[strategy.strategyRunId];

    this.validatePositiveNumber(risk.maxPositionUsd, 'payload.risk.maxPositionUsd', errors);
    this.validatePositiveNumber(risk.maxExposurePerMarketUsd, 'payload.risk.maxExposurePerMarketUsd', errors);
    this.validatePositiveNumber(risk.maxExposurePerEventUsd, 'payload.risk.maxExposurePerEventUsd', errors);
    this.validatePositiveInteger(risk.maxOpenPositions, 'payload.risk.maxOpenPositions', errors);
    this.validatePositiveNumber(risk.maxDailyLossUsd, 'payload.risk.maxDailyLossUsd', errors);
    this.validatePct(risk.maxDrawdownPct, 'payload.risk.maxDrawdownPct', errors);
    this.validatePositiveInteger(risk.maxOrdersPerMinute, 'payload.risk.maxOrdersPerMinute', errors);
    this.validatePct(risk.maxCancelRate, 'payload.risk.maxCancelRate', errors);
    this.validatePositiveInteger(risk.cooldownMsPerMarket, 'payload.risk.cooldownMsPerMarket', errors, true);

    if (
      risk.maxExposurePerMarketUsd != null &&
      risk.maxExposurePerEventUsd != null &&
      risk.maxExposurePerMarketUsd > risk.maxExposurePerEventUsd
    ) {
      errors.push(
        this.err(
          'MARKET_EXPOSURE_GT_EVENT',
          'payload.risk.maxExposurePerMarketUsd',
          'La exposición por mercado no puede superar la exposición por evento.',
          risk.maxExposurePerMarketUsd,
          risk.maxExposurePerEventUsd,
        ),
      );
    }

    const effectiveAllocation = this.resolveAllocationUsd(strategy.allocation, ctx.accountEquityUsd);

    if (
      risk.maxPositionUsd != null &&
      risk.maxPositionUsd > effectiveAllocation
    ) {
      errors.push(
        this.err(
          'MAX_POSITION_GT_ALLOCATION',
          'payload.risk.maxPositionUsd',
          'maxPositionUsd no puede superar la allocation efectiva.',
          risk.maxPositionUsd,
          effectiveAllocation,
        ),
      );
    }

    if (
      state &&
      risk.maxOpenPositions != null &&
      risk.maxOpenPositions < state.openPositions
    ) {
      warnings.push(
        this.warn(
          'MAX_OPEN_POSITIONS_BELOW_CURRENT',
          'payload.risk.maxOpenPositions',
          'El nuevo límite de posiciones queda por debajo del número actual de posiciones abiertas.',
          state.openPositions,
          risk.maxOpenPositions,
        ),
      );
    }

    if (
      state &&
      risk.maxExposurePerEventUsd != null &&
      risk.maxExposurePerEventUsd < state.currentExposureUsd
    ) {
      warnings.push(
        this.warn(
          'EVENT_EXPOSURE_BELOW_CURRENT',
          'payload.risk.maxExposurePerEventUsd',
          'El nuevo límite puede quedar por debajo de la exposición actual.',
          state.currentExposureUsd,
          risk.maxExposurePerEventUsd,
        ),
      );
    }
  }

  private validateStrategyUniversePatch(
    _strategy: StrategyRuntimePolicy,
    patch: StrategyUniversePatch,
    ctx: ValidatorContext,
    errors: ValidationError[],
    warnings: ValidationWarning[],
  ): void {
    if (!patch.reason?.trim()) {
      errors.push(this.err('REASON_REQUIRED', 'payload.reason', 'La razón del cambio es obligatoria.'));
    }

    const universe = patch.universe;

    this.validateStringArray(universe.allowedMarketIds, 'payload.universe.allowedMarketIds', errors);
    this.validateStringArray(universe.allowedEventSlugs, 'payload.universe.allowedEventSlugs', errors);
    this.validateStringArray(universe.allowedSeriesSlugs, 'payload.universe.allowedSeriesSlugs', errors);
    this.validateStringArray(universe.includeKeywords, 'payload.universe.includeKeywords', errors);
    this.validateStringArray(universe.excludeKeywords, 'payload.universe.excludeKeywords', errors);

    this.validatePositiveNumber(universe.minLiquidityUsd, 'payload.universe.minLiquidityUsd', errors);
    this.validatePositiveNumber(universe.minVolume24h, 'payload.universe.minVolume24h', errors);
    this.validatePositiveInteger(universe.maxDaysToResolution, 'payload.universe.maxDaysToResolution', errors);

    this.validateNoOverlap(
      universe.includeKeywords,
      universe.excludeKeywords,
      'payload.universe.includeKeywords',
      'payload.universe.excludeKeywords',
      warnings,
      'KEYWORD_OVERLAP',
      'Hay keywords incluidas y excluidas al mismo tiempo.',
    );

    if (ctx.knownEventSlugs && universe.allowedEventSlugs) {
      for (const slug of universe.allowedEventSlugs) {
        if (!ctx.knownEventSlugs.has(slug)) {
          warnings.push(
            this.warn(
              'UNKNOWN_EVENT_SLUG',
              'payload.universe.allowedEventSlugs',
              `No se reconoce el event slug: ${slug}`,
            ),
          );
        }
      }
    }

    if (ctx.knownSeriesSlugs && universe.allowedSeriesSlugs) {
      for (const slug of universe.allowedSeriesSlugs) {
        if (!ctx.knownSeriesSlugs.has(slug)) {
          warnings.push(
            this.warn(
              'UNKNOWN_SERIES_SLUG',
              'payload.universe.allowedSeriesSlugs',
              `No se reconoce el series slug: ${slug}`,
            ),
          );
        }
      }
    }
  }

  private validateStrategyParamsPatch(
    strategy: StrategyRuntimePolicy,
    patch: StrategyParamsPatch,
    errors: ValidationError[],
    warnings: ValidationWarning[],
  ): void {
    if (!patch.reason?.trim()) {
      errors.push(this.err('REASON_REQUIRED', 'payload.reason', 'La razón del cambio es obligatoria.'));
    }

    if (!patch.params || typeof patch.params !== 'object' || Array.isArray(patch.params)) {
      errors.push(this.err('INVALID_PARAMS', 'payload.params', 'params debe ser un objeto.'));
      return;
    }

    if (Object.keys(patch.params).length === 0) {
      warnings.push(
        this.warn(
          'EMPTY_PARAMS_PATCH',
          'payload.params',
          `El patch de params para ${strategy.key} no modifica ninguna clave.`,
        ),
      );
    }

    warnings.push(
      this.warn(
        'GENERIC_PARAMS_VALIDATION',
        'payload.params',
        `Los params de ${strategy.key} solo tienen validación genérica. Conviene agregar un validador específico por estrategia.`,
      ),
    );
  }

  private validateStrategyLifecyclePatch(
    strategy: StrategyRuntimePolicy,
    patch: StrategyLifecyclePatch,
    ctx: ValidatorContext,
    errors: ValidationError[],
    warnings: ValidationWarning[],
  ): void {
    if (!patch.reason?.trim()) {
      errors.push(this.err('REASON_REQUIRED', 'payload.reason', 'La razón del cambio es obligatoria.'));
    }

    const state = ctx.strategyStateById[strategy.strategyRunId];

    switch (patch.action) {
      case 'PAUSE':
      case 'RESUME':
      case 'REDUCE_ONLY_ON':
      case 'REDUCE_ONLY_OFF':
      case 'DISABLE':
      case 'ENABLE':
        return;

      case 'PROMOTE_TO_LIVE':
        if (!ctx.liveTradingEnabled) {
          errors.push(
            this.err(
              'LIVE_TRADING_DISABLED',
              'payload.action',
              'No se puede promover a LIVE si el trading live no está habilitado.',
            ),
          );
        }

        if (!ctx.liveAdapterAvailable) {
          errors.push(
            this.err(
              'LIVE_ADAPTER_UNAVAILABLE',
              'payload.action',
              'No se puede promover a LIVE sin adapter live disponible.',
            ),
          );
        }

        if (!strategy.enabled) {
          errors.push(
            this.err(
              'STRATEGY_DISABLED',
              'payload.action',
              'La estrategia debe estar enabled antes de promoverla a LIVE.',
            ),
          );
        }

        if (state && (state.openPositions > 0 || state.hasPendingOrders)) {
          errors.push(
            this.err(
              'STRATEGY_NOT_FLAT',
              'payload.action',
              'La estrategia debe estar plana y sin órdenes pendientes antes de pasar de PAPER a LIVE.',
            ),
          );
        }

        return;

      case 'DEMOTE_TO_PAPER':
        if (state && (state.openPositions > 0 || state.hasPendingOrders)) {
          warnings.push(
            this.warn(
              'DEMOTION_WITH_OPEN_STATE',
              'payload.action',
              'La estrategia tiene posiciones u órdenes abiertas. Conviene primero poner reduce-only y cerrar exposición.',
            ),
          );
        }
        return;

      default:
        errors.push(
          this.err(
            'INVALID_LIFECYCLE_ACTION',
            'payload.action',
            `Acción no soportada: ${String(patch.action)}`,
          ),
        );
    }
  }

  /* =======================================================
   * Policy-level validation
   * ===================================================== */

  private validateStrategyPolicy(
    strategy: StrategyRuntimePolicy,
    ctx: ValidatorContext,
    errors: ValidationError[],
    warnings: ValidationWarning[],
  ): void {
    if (!strategy.strategyRunId?.trim()) {
      errors.push(this.err('STRATEGY_ID_REQUIRED', 'strategyRunId', 'strategyRunId es obligatorio.'));
    }

    if (!strategy.key?.trim()) {
      errors.push(this.err('STRATEGY_KEY_REQUIRED', 'key', 'key es obligatorio.'));
    }

    this.validateAllocationPolicy(
      strategy.allocation,
      `strategies.${strategy.strategyRunId}.allocation`,
      ctx,
      errors,
    );

    this.validatePositiveNumber(strategy.risk.maxPositionUsd, `strategies.${strategy.strategyRunId}.risk.maxPositionUsd`, errors);
    this.validatePositiveNumber(strategy.risk.maxExposurePerMarketUsd, `strategies.${strategy.strategyRunId}.risk.maxExposurePerMarketUsd`, errors);
    this.validatePositiveNumber(strategy.risk.maxExposurePerEventUsd, `strategies.${strategy.strategyRunId}.risk.maxExposurePerEventUsd`, errors);
    this.validatePositiveInteger(strategy.risk.maxOpenPositions, `strategies.${strategy.strategyRunId}.risk.maxOpenPositions`, errors);
    this.validatePositiveNumber(strategy.risk.maxDailyLossUsd, `strategies.${strategy.strategyRunId}.risk.maxDailyLossUsd`, errors);
    this.validatePct(strategy.risk.maxDrawdownPct, `strategies.${strategy.strategyRunId}.risk.maxDrawdownPct`, errors);
    this.validatePositiveInteger(strategy.risk.maxOrdersPerMinute, `strategies.${strategy.strategyRunId}.risk.maxOrdersPerMinute`, errors);
    this.validatePct(strategy.risk.maxCancelRate, `strategies.${strategy.strategyRunId}.risk.maxCancelRate`, errors);

    const resolved = this.resolveAllocationUsd(strategy.allocation, ctx.accountEquityUsd);

    if (
      strategy.risk.maxPositionUsd != null &&
      strategy.risk.maxPositionUsd > resolved
    ) {
      errors.push(
        this.err(
          'MAX_POSITION_GT_RESOLVED_ALLOCATION',
          `strategies.${strategy.strategyRunId}.risk.maxPositionUsd`,
          'maxPositionUsd no puede superar la allocation resuelta.',
          strategy.risk.maxPositionUsd,
          resolved,
        ),
      );
    }

    if (
      strategy.risk.maxExposurePerMarketUsd != null &&
      strategy.risk.maxExposurePerEventUsd != null &&
      strategy.risk.maxExposurePerMarketUsd > strategy.risk.maxExposurePerEventUsd
    ) {
      errors.push(
        this.err(
          'MARKET_EXPOSURE_GT_EVENT',
          `strategies.${strategy.strategyRunId}.risk.maxExposurePerMarketUsd`,
          'La exposición por mercado no puede superar la exposición por evento.',
          strategy.risk.maxExposurePerMarketUsd,
          strategy.risk.maxExposurePerEventUsd,
        ),
      );
    }

    if (strategy.universe) {
      this.validateUniverseConfig(
        strategy.universe,
        `strategies.${strategy.strategyRunId}.universe`,
        warnings,
        errors,
      );
    }

    if (strategy.mode === 'LIVE' && !ctx.liveTradingEnabled) {
      errors.push(
        this.err(
          'STRATEGY_LIVE_WHILE_DISABLED',
          `strategies.${strategy.strategyRunId}.mode`,
          'La estrategia está en LIVE pero el sistema live no está habilitado.',
        ),
      );
    }
  }

  /* =======================================================
   * Helpers
   * ===================================================== */

  private validateAllocationPolicy(
    allocation: AllocationPolicy,
    field: string,
    ctx: ValidatorContext,
    errors: ValidationError[],
  ): void {
    if (!allocation) {
      errors.push(this.err('ALLOCATION_REQUIRED', field, 'allocation es obligatoria.'));
      return;
    }

    if (allocation.mode !== 'FIXED_USD' && allocation.mode !== 'PCT_OF_EQUITY') {
      errors.push(this.err('INVALID_ALLOCATION_MODE', `${field}.mode`, 'allocation.mode inválido.', allocation.mode));
    }

    if (allocation.mode === 'FIXED_USD') {
      this.validatePositiveNumber(allocation.value, `${field}.value`, errors);
    }

    if (allocation.mode === 'PCT_OF_EQUITY') {
      if (allocation.value == null || allocation.value <= 0 || allocation.value > 1) {
        errors.push(
          this.err(
            'INVALID_ALLOCATION_PCT',
            `${field}.value`,
            'Para PCT_OF_EQUITY, value debe estar entre 0 y 1.',
            allocation.value,
          ),
        );
      }
    }

    this.validatePositiveNumber(allocation.minUsd, `${field}.minUsd`, errors, true);
    this.validatePositiveNumber(allocation.maxUsd, `${field}.maxUsd`, errors, true);

    if (
      allocation.minUsd != null &&
      allocation.maxUsd != null &&
      allocation.minUsd > allocation.maxUsd
    ) {
      errors.push(
        this.err(
          'ALLOCATION_MIN_GT_MAX',
          `${field}.minUsd`,
          'minUsd no puede ser mayor que maxUsd.',
          allocation.minUsd,
          allocation.maxUsd,
        ),
      );
    }

    const resolvedUsd = this.resolveAllocationUsd(allocation, ctx.accountEquityUsd);

    if (resolvedUsd <= 0) {
      errors.push(
        this.err(
          'ALLOCATION_RESOLVES_TO_ZERO',
          field,
          'La allocation resuelta debe ser mayor que cero.',
          resolvedUsd,
        ),
      );
    }
  }

  private validateUniverseConfig(
    universe: MarketUniverseConfig,
    fieldPrefix: string,
    warnings: ValidationWarning[],
    errors: ValidationError[],
  ): void {
    this.validateStringArray(universe.allowedMarketIds, `${fieldPrefix}.allowedMarketIds`, errors);
    this.validateStringArray(universe.allowedEventSlugs, `${fieldPrefix}.allowedEventSlugs`, errors);
    this.validateStringArray(universe.allowedSeriesSlugs, `${fieldPrefix}.allowedSeriesSlugs`, errors);
    this.validateStringArray(universe.includeKeywords, `${fieldPrefix}.includeKeywords`, errors);
    this.validateStringArray(universe.excludeKeywords, `${fieldPrefix}.excludeKeywords`, errors);

    this.validatePositiveNumber(universe.minLiquidityUsd, `${fieldPrefix}.minLiquidityUsd`, errors);
    this.validatePositiveNumber(universe.minVolume24h, `${fieldPrefix}.minVolume24h`, errors);
    this.validatePositiveInteger(universe.maxDaysToResolution, `${fieldPrefix}.maxDaysToResolution`, errors);

    this.validateNoOverlap(
      universe.includeKeywords,
      universe.excludeKeywords,
      `${fieldPrefix}.includeKeywords`,
      `${fieldPrefix}.excludeKeywords`,
      warnings,
      'UNIVERSE_KEYWORD_OVERLAP',
      'Hay keywords repetidas entre include y exclude.',
    );
  }

  private calculateProjectedTotalLiveAllocation(
    config: EffectiveRuntimeConfig,
    equityUsd: number,
    targetStrategyId?: string,
    nextAllocation?: AllocationPolicy,
    nextMode?: RunMode,
  ): number {
    let total = 0;

    for (const strategy of config.strategies) {
      const allocation =
        strategy.strategyRunId === targetStrategyId && nextAllocation
          ? nextAllocation
          : strategy.allocation;

      const mode =
        strategy.strategyRunId === targetStrategyId && nextMode
          ? nextMode
          : strategy.mode;

      if (strategy.enabled && mode === 'LIVE') {
        total += this.resolveAllocationUsd(allocation, equityUsd);
      }
    }

    return total;
  }

  private resolveAllocationUsd(allocation: AllocationPolicy, equityUsd: number): number {
    let resolved =
      allocation.mode === 'FIXED_USD'
        ? allocation.value
        : equityUsd * allocation.value;

    if (allocation.minUsd != null) {
      resolved = Math.max(resolved, allocation.minUsd);
    }

    if (allocation.maxUsd != null) {
      resolved = Math.min(resolved, allocation.maxUsd);
    }

    return resolved;
  }

  private validatePositiveNumber(
    value: number | undefined,
    field: string,
    errors: ValidationError[],
    allowZero = false,
  ): void {
    if (value == null) return;
    if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
      errors.push(
        this.err(
          'INVALID_POSITIVE_NUMBER',
          field,
          allowZero
            ? 'Debe ser un número mayor o igual a 0.'
            : 'Debe ser un número mayor que 0.',
          value,
        ),
      );
    }
  }

  private validatePositiveInteger(
    value: number | undefined,
    field: string,
    errors: ValidationError[],
    allowZero = false,
  ): void {
    if (value == null) return;
    if (!Number.isInteger(value) || (allowZero ? value < 0 : value <= 0)) {
      errors.push(
        this.err(
          'INVALID_POSITIVE_INTEGER',
          field,
          allowZero
            ? 'Debe ser un entero mayor o igual a 0.'
            : 'Debe ser un entero mayor que 0.',
          value,
        ),
      );
    }
  }

  private validatePct(
    value: number | undefined,
    field: string,
    errors: ValidationError[],
  ): void {
    if (value == null) return;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(
        this.err(
          'INVALID_PERCENTAGE',
          field,
          'Debe estar en el rango [0, 1].',
          value,
        ),
      );
    }
  }

  private validateStringArray(
    value: string[] | undefined,
    field: string,
    errors: ValidationError[],
  ): void {
    if (value == null) return;

    if (!Array.isArray(value)) {
      errors.push(this.err('INVALID_ARRAY', field, 'Debe ser un arreglo.'));
      return;
    }

    const seen = new Set<string>();
    for (const item of value) {
      if (typeof item !== 'string' || !item.trim()) {
        errors.push(this.err('INVALID_ARRAY_ITEM', field, 'Todos los elementos deben ser strings no vacíos.', item));
        continue;
      }
      if (seen.has(item.trim())) {
        errors.push(this.err('DUPLICATE_ARRAY_ITEM', field, `Elemento duplicado: ${item}`));
      }
      seen.add(item.trim());
    }
  }

  private validateNoOverlap(
    left: string[] | undefined,
    right: string[] | undefined,
    leftField: string,
    rightField: string,
    warnings: ValidationWarning[],
    code: string,
    message: string,
  ): void {
    if (!left || !right) return;

    const leftSet = new Set(left.map((x) => x.trim()));
    const overlap = right.filter((x) => leftSet.has(x.trim()));

    if (overlap.length > 0) {
      warnings.push(
        this.warn(
          code,
          `${leftField}, ${rightField}`,
          `${message} Overlap: ${overlap.join(', ')}`,
        ),
      );
    }
  }

  private findStrategy(
    config: EffectiveRuntimeConfig,
    strategyRunId: string,
  ): StrategyRuntimePolicy | undefined {
    return config.strategies.find((s) => s.strategyRunId === strategyRunId);
  }

  /* =======================================================
   * Type guards
   * ===================================================== */

  private isStrategyAllocationPatch(payload: ConfigPatchPayload): payload is StrategyAllocationPatch {
    return 'allocation' in payload;
  }

  private isStrategyRiskPatch(payload: ConfigPatchPayload): payload is StrategyRiskPatch {
    return 'risk' in payload && !('action' in payload);
  }

  private isStrategyUniversePatch(payload: ConfigPatchPayload): payload is StrategyUniversePatch {
    return 'universe' in payload;
  }

  private isStrategyParamsPatch(payload: ConfigPatchPayload): payload is StrategyParamsPatch {
    return 'params' in payload;
  }

  private isStrategyLifecyclePatch(payload: ConfigPatchPayload): payload is StrategyLifecyclePatch {
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

  private isAccountRiskPatch(payload: ConfigPatchPayload): payload is AccountRiskPatch {
    return 'risk' in payload && !('allocation' in payload) && !('universe' in payload) && !('params' in payload);
  }

  private isSystemControlPatch(payload: ConfigPatchPayload): payload is SystemControlPatch {
    return 'action' in payload &&
      ['KILL_SWITCH_ON', 'KILL_SWITCH_OFF'].includes(payload.action);
  }

  /* =======================================================
   * Error / warning factories
   * ===================================================== */

  private err(
    code: string,
    field: string,
    message: string,
    currentValue?: unknown,
    proposedValue?: unknown,
  ): ValidationError {
    return { code, field, message, currentValue, proposedValue };
  }

  private warn(
    code: string,
    field: string,
    message: string,
    currentValue?: unknown,
    proposedValue?: unknown,
  ): ValidationWarning {
    return { code, field, message, currentValue, proposedValue };
  }
}
