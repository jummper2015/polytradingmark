import type {
  ConfigChangeRequest,
  ConfigPatchPayload,
  EffectiveRuntimeConfig,
  RuntimeApplyMode,
  RuntimeApplyResult,
  RuntimeConfigPublisher,
  RuntimeConfigSubscriber,
} from './types';

export interface RuntimeApplyInput {
  request?: ConfigChangeRequest;
  previousConfig?: EffectiveRuntimeConfig | null;
  nextConfig: EffectiveRuntimeConfig;
}

export class RuntimeConfigApplier implements RuntimeConfigPublisher {
  private readonly subscribers = new Map<string, RuntimeConfigSubscriber>();
  private lastAppliedConfig: EffectiveRuntimeConfig | null = null;

  registerSubscriber(name: string, subscriber: RuntimeConfigSubscriber): void {
    this.subscribers.set(name, subscriber);
  }

  unregisterSubscriber(name: string): void {
    this.subscribers.delete(name);
  }

  getLastAppliedConfig(): EffectiveRuntimeConfig | null {
    return this.lastAppliedConfig ? this.clone(this.lastAppliedConfig) : null;
  }

  /**
   * Compatibilidad con el bootstrap inicial.
   * Mantiene la interfaz RuntimeConfigPublisher ya definida.
   */
  async publish(config: EffectiveRuntimeConfig): Promise<void> {
    await this.applyBootstrap(config);
  }

  /**
   * Método principal para aplicar cambios runtime con clasificación.
   */
  async applyChange(input: RuntimeApplyInput): Promise<RuntimeApplyResult> {
    const applyMode = this.classifyApplyMode(input.request);
    const requestId = input.request?.requestId ?? 'bootstrap';
    const targetType = input.request?.targetType ?? 'SYSTEM';
    const targetId = input.request?.targetId ?? 'system';

    if (applyMode === 'REJECTED') {
      return {
        requestId,
        targetType,
        targetId,
        applyMode,
        applied: false,
        message: 'Cambio rechazado por política de aplicación runtime.',
      };
    }

    const notifyResult = await this.notifySubscribers(input.nextConfig);

    if (!notifyResult.ok) {
      return {
        requestId,
        targetType,
        targetId,
        applyMode,
        applied: false,
        appliedAt: Date.now(),
        blockedBy: notifyResult.failedSubscribers,
        message: `No se pudo aplicar la config en runtime. Fallaron: ${notifyResult.failedSubscribers.join(', ')}`,
      };
    }

    this.lastAppliedConfig = this.clone(input.nextConfig);

    return {
      requestId,
      targetType,
      targetId,
      applyMode,
      applied: true,
      appliedAt: Date.now(),
      message: this.buildSuccessMessage(applyMode),
    };
  }

  /* =========================================================
   * Bootstrap
   * ======================================================= */

  private async applyBootstrap(config: EffectiveRuntimeConfig): Promise<void> {
    const notifyResult = await this.notifySubscribers(config);

    if (!notifyResult.ok) {
      throw new Error(
        `No se pudo aplicar bootstrap config. Fallaron: ${notifyResult.failedSubscribers.join(', ')}`
      );
    }

    this.lastAppliedConfig = this.clone(config);
  }

  /* =========================================================
   * Classification
   * ======================================================= */

  private classifyApplyMode(
    request?: ConfigChangeRequest,
  ): RuntimeApplyMode {
    if (!request) {
      return 'HOT_APPLY';
    }

    const payload = request.payload;

    // SYSTEM
    if (request.targetType === 'SYSTEM') {
      return 'HOT_APPLY';
    }

    // ACCOUNT
    if (request.targetType === 'ACCOUNT') {
      return 'HOT_APPLY';
    }

    // UNIVERSE
    if (request.targetType === 'UNIVERSE') {
      return 'NEXT_CYCLE';
    }

    // STRATEGY
    if (request.targetType === 'STRATEGY') {
      if (this.isStrategyLifecyclePatch(payload)) {
        switch (payload.action) {
          case 'PAUSE':
          case 'RESUME':
          case 'REDUCE_ONLY_ON':
          case 'REDUCE_ONLY_OFF':
          case 'ENABLE':
          case 'DISABLE':
            return 'HOT_APPLY';

          case 'PROMOTE_TO_LIVE':
          case 'DEMOTE_TO_PAPER':
            return 'REQUIRES_FLAT_POSITIONS';

          default:
            return 'REJECTED';
        }
      }

      if (this.isStrategyAllocationPatch(payload)) {
        return 'NEXT_CYCLE';
      }

      if (this.isStrategyRiskPatch(payload)) {
        return 'HOT_APPLY';
      }

      if (this.isStrategyUniversePatch(payload)) {
        return 'NEXT_CYCLE';
      }

      if (this.isStrategyParamsPatch(payload)) {
        return 'NEXT_CYCLE';
      }
    }

    return 'REJECTED';
  }

  /* =========================================================
   * Subscriber notification
   * ======================================================= */

  private async notifySubscribers(
    config: EffectiveRuntimeConfig,
  ): Promise<{ ok: boolean; failedSubscribers: string[] }> {
    const failedSubscribers: string[] = [];

    for (const [name, subscriber] of this.subscribers.entries()) {
      try {
        await subscriber.onConfigUpdated(this.clone(config));
      } catch (error) {
        failedSubscribers.push(name);
        console.error(`[RuntimeConfigApplier] Subscriber "${name}" falló al aplicar config:`, error);
      }
    }

    return {
      ok: failedSubscribers.length === 0,
      failedSubscribers,
    };
  }

  /* =========================================================
   * Helpers
   * ======================================================= */

  private buildSuccessMessage(mode: RuntimeApplyMode): string {
    switch (mode) {
      case 'HOT_APPLY':
        return 'Configuración aplicada inmediatamente.';
      case 'NEXT_CYCLE':
        return 'Configuración aplicada para el siguiente ciclo runtime.';
      case 'REQUIRES_FLAT_POSITIONS':
        return 'Configuración aplicada bajo condición de estrategia plana.';
      case 'REQUIRES_RESTART':
        return 'La configuración requiere reinicio.';
      default:
        return 'Configuración aplicada.';
    }
  }

  private clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  /* =========================================================
   * Type guards
   * ======================================================= */

  private isStrategyAllocationPatch(
    payload: ConfigPatchPayload,
  ): payload is { allocation: unknown } {
    return 'allocation' in payload;
  }

  private isStrategyRiskPatch(
    payload: ConfigPatchPayload,
  ): payload is { risk: unknown } {
    return (
      'risk' in payload &&
      !('allocation' in payload) &&
      !('params' in payload) &&
      !('universe' in payload) &&
      !('action' in payload)
    );
  }

  private isStrategyUniversePatch(
    payload: ConfigPatchPayload,
  ): payload is { universe: unknown } {
    return 'universe' in payload;
  }

  private isStrategyParamsPatch(
    payload: ConfigPatchPayload,
  ): payload is { params: unknown } {
    return 'params' in payload;
  }

  private isStrategyLifecyclePatch(
    payload: ConfigPatchPayload,
  ): payload is { action: string } {
    return (
      'action' in payload &&
      [
        'PAUSE',
        'RESUME',
        'REDUCE_ONLY_ON',
        'REDUCE_ONLY_OFF',
        'PROMOTE_TO_LIVE',
        'DEMOTE_TO_PAPER',
        'DISABLE',
        'ENABLE',
      ].includes(payload.action)
    );
  }
}
