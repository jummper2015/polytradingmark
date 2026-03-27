import type {
  AccountRiskLimits,
  JsonMap,
  MarketUniverseConfig,
  RunMode,
  StrategyRiskLimits,
  Venue,
} from '../types';

/* =========================================================
 * Runtime config core enums / aliases
 * ======================================================= */

export type AllocationMode = 'FIXED_USD' | 'PCT_OF_EQUITY';

export type StrategyExecutionState =
  | 'ACTIVE'
  | 'PAUSED'
  | 'REDUCE_ONLY'
  | 'STOPPED';

export type ConfigVersionSource =
  | 'BOOTSTRAP'
  | 'ADMIN_CHANGE'
  | 'ROLLBACK'
  | 'SYSTEM_RECALCULATION';

export type ConfigTargetType =
  | 'ACCOUNT'
  | 'STRATEGY'
  | 'UNIVERSE'
  | 'SYSTEM';

export type ConfigChangeRequestStatus =
  | 'PENDING'
  | 'VALIDATED'
  | 'APPLIED'
  | 'REJECTED'
  | 'ROLLED_BACK';

export type RuntimeApplyMode =
  | 'HOT_APPLY'
  | 'NEXT_CYCLE'
  | 'REQUIRES_FLAT_POSITIONS'
  | 'REQUIRES_RESTART'
  | 'REJECTED';

export type RuntimeControlAction =
  | 'PAUSE'
  | 'RESUME'
  | 'REDUCE_ONLY_ON'
  | 'REDUCE_ONLY_OFF'
  | 'PROMOTE_TO_LIVE'
  | 'DEMOTE_TO_PAPER'
  | 'DISABLE'
  | 'ENABLE'
  | 'KILL_SWITCH_ON'
  | 'KILL_SWITCH_OFF';

/* =========================================================
 * Allocation policy
 * ======================================================= */

export interface AllocationPolicy {
  mode: AllocationMode;
  value: number; // USD si FIXED_USD, porcentaje [0..1] si PCT_OF_EQUITY
  minUsd?: number;
  maxUsd?: number;
  resolvedUsd?: number; // valor efectivo calculado contra equity actual
}

/* =========================================================
 * Runtime-editable policy blocks
 * ======================================================= */

export interface EditableStrategyRiskPolicy extends StrategyRiskLimits {}

export interface EditableAccountRiskPolicy extends AccountRiskLimits {
  killSwitch?: boolean;
  reduceOnlyGlobal?: boolean;
}

export interface StrategyRuntimePolicy {
  strategyRunId: string;
  key: string;
  venue: Venue;

  enabled: boolean;
  mode: RunMode;
  executionState: StrategyExecutionState;

  allocation: AllocationPolicy;
  risk: EditableStrategyRiskPolicy;
  universe?: MarketUniverseConfig;

  tags?: string[];
  params?: JsonMap;

  updatedAt: number;
  updatedBy?: string;
}

export interface AccountRuntimePolicy {
  accountId: string;
  venue: Venue;
  liveEnabled: boolean;

  risk: EditableAccountRiskPolicy;

  updatedAt: number;
  updatedBy?: string;
}

export interface EffectiveRuntimeConfig {
  version: number;
  generatedAt: number;
  source: ConfigVersionSource;

  account: AccountRuntimePolicy;
  strategies: StrategyRuntimePolicy[];

  meta?: JsonMap;
}

/* =========================================================
 * Change request payloads
 * ======================================================= */

export interface StrategyAllocationPatch {
  allocation?: AllocationPolicy;
  reason: string;
}

export interface StrategyRiskPatch {
  risk: Partial<EditableStrategyRiskPolicy>;
  reason: string;
}

export interface StrategyUniversePatch {
  universe: Partial<MarketUniverseConfig>;
  reason: string;
}

export interface StrategyParamsPatch {
  params: JsonMap;
  reason: string;
}

export interface StrategyLifecyclePatch {
  action: Extract<
    RuntimeControlAction,
    | 'PAUSE'
    | 'RESUME'
    | 'REDUCE_ONLY_ON'
    | 'REDUCE_ONLY_OFF'
    | 'PROMOTE_TO_LIVE'
    | 'DEMOTE_TO_PAPER'
    | 'DISABLE'
    | 'ENABLE'
  >;
  reason: string;
}

export interface AccountRiskPatch {
  risk: Partial<EditableAccountRiskPolicy>;
  reason: string;
}

export interface SystemControlPatch {
  action: Extract<
    RuntimeControlAction,
    'KILL_SWITCH_ON' | 'KILL_SWITCH_OFF'
  >;
  reason: string;
}

export type ConfigPatchPayload =
  | StrategyAllocationPatch
  | StrategyRiskPatch
  | StrategyUniversePatch
  | StrategyParamsPatch
  | StrategyLifecyclePatch
  | AccountRiskPatch
  | SystemControlPatch;

/* =========================================================
 * Change request / versioning
 * ======================================================= */

export interface ConfigChangeRequest {
  requestId: string;

  targetType: ConfigTargetType;
  targetId: string; // strategyRunId, accountId o "system"

  payload: ConfigPatchPayload;

  status: ConfigChangeRequestStatus;

  requestedBy: string;
  requestedAt: number;

  approvedBy?: string;
  approvedAt?: number;

  validationErrors?: ValidationError[];
  validationWarnings?: ValidationWarning[];

  effectiveAt?: number; // si quieres programar el cambio
  comment?: string;
}

export interface ConfigVersionSnapshot {
  version: number;
  source: ConfigVersionSource;

  config: EffectiveRuntimeConfig;

  createdAt: number;
  createdBy?: string;
  comment?: string;
}

/* =========================================================
 * Validation
 * ======================================================= */

export interface ValidationError {
  code: string;
  field: string;
  message: string;
  currentValue?: unknown;
  proposedValue?: unknown;
}

export interface ValidationWarning {
  code: string;
  field: string;
  message: string;
  currentValue?: unknown;
  proposedValue?: unknown;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/* =========================================================
 * Diff / audit
 * ======================================================= */

export interface ConfigDiffEntry {
  path: string; // ej: "strategies.conv_01.risk.max_position_usd"
  beforeValue: unknown;
  afterValue: unknown;
}

export interface AuditLogEntry {
  auditId: string;

  actor: string;
  action: string;

  targetType: ConfigTargetType;
  targetId: string;

  requestId?: string;
  versionBefore?: number;
  versionAfter?: number;

  diff?: ConfigDiffEntry[];

  result: 'SUCCESS' | 'FAILURE';
  message?: string;

  createdAt: number;
}

/* =========================================================
 * Runtime apply result
 * ======================================================= */

export interface RuntimeApplyResult {
  requestId: string;
  targetType: ConfigTargetType;
  targetId: string;

  applyMode: RuntimeApplyMode;
  applied: boolean;

  appliedAt?: number;
  message?: string;

  blockedBy?: string[];
  warnings?: ValidationWarning[];
}

/* =========================================================
 * Read models for admin UI
 * ======================================================= */

export interface StrategyRuntimeSummary {
  strategyRunId: string;
  key: string;

  enabled: boolean;
  mode: RunMode;
  executionState: StrategyExecutionState;

  allocation: AllocationPolicy;

  updatedAt: number;
  updatedBy?: string;
}

export interface AdminConfigOverview {
  version: number;
  generatedAt: number;

  account: AccountRuntimePolicy;
  strategies: StrategyRuntimeSummary[];

  pendingRequests: number;
  lastChangeAt?: number;
}

/* =========================================================
 * Optional repository/service contracts
 * ======================================================= */

export interface ConfigStore {
  getEffectiveConfig(): Promise<EffectiveRuntimeConfig | null>;
  saveEffectiveConfig(config: EffectiveRuntimeConfig): Promise<void>;

  createVersion(snapshot: ConfigVersionSnapshot): Promise<void>;
  getVersion(version: number): Promise<ConfigVersionSnapshot | null>;
  listVersions(limit?: number): Promise<ConfigVersionSnapshot[]>;

  createChangeRequest(request: ConfigChangeRequest): Promise<void>;
  updateChangeRequestStatus(
    requestId: string,
    status: ConfigChangeRequestStatus,
    validationErrors?: ValidationError[],
    validationWarnings?: ValidationWarning[],
  ): Promise<void>;
  getChangeRequest(requestId: string): Promise<ConfigChangeRequest | null>;
  listPendingChangeRequests(): Promise<ConfigChangeRequest[]>;

  appendAuditLog(entry: AuditLogEntry): Promise<void>;
}

export interface RuntimeConfigPublisher {
  publish(config: EffectiveRuntimeConfig): Promise<void>;
}

export interface RuntimeConfigSubscriber {
  onConfigUpdated(config: EffectiveRuntimeConfig): Promise<void>;
}
