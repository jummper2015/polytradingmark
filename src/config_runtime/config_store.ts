import Database from 'better-sqlite3';

import type {
  AuditLogEntry,
  ConfigChangeRequest,
  ConfigChangeRequestStatus,
  ConfigStore,
  ConfigVersionSnapshot,
  EffectiveRuntimeConfig,
  ValidationError,
  ValidationWarning,
} from './types';

type RowWithJson = Record<string, unknown>;

export class SqliteConfigStore implements ConfigStore {
  private readonly db: Database.Database;

  constructor(private readonly dbPath = '.runtime/config.db') {
    this.db = new Database(this.dbPath);
    this.migrate();
  }

  async getEffectiveConfig(): Promise<EffectiveRuntimeConfig | null> {
    const row = this.db
      .prepare(
        `
        SELECT config_json
        FROM effective_config
        WHERE singleton_id = 1
        `,
      )
      .get() as { config_json: string } | undefined;

    if (!row) return null;
    return this.parseJson<EffectiveRuntimeConfig>(row.config_json);
  }

  async saveEffectiveConfig(config: EffectiveRuntimeConfig): Promise<void> {
    const stmt = this.db.prepare(
      `
      INSERT INTO effective_config (
        singleton_id,
        version,
        config_json,
        updated_at
      )
      VALUES (1, ?, ?, ?)
      ON CONFLICT(singleton_id) DO UPDATE SET
        version = excluded.version,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
      `,
    );

    stmt.run(
      config.version,
      JSON.stringify(config),
      Date.now(),
    );
  }

  async createVersion(snapshot: ConfigVersionSnapshot): Promise<void> {
    const stmt = this.db.prepare(
      `
      INSERT INTO config_versions (
        version,
        source,
        config_json,
        created_at,
        created_by,
        comment
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `,
    );

    stmt.run(
      snapshot.version,
      snapshot.source,
      JSON.stringify(snapshot.config),
      snapshot.createdAt,
      snapshot.createdBy ?? null,
      snapshot.comment ?? null,
    );
  }

  async getVersion(version: number): Promise<ConfigVersionSnapshot | null> {
    const row = this.db
      .prepare(
        `
        SELECT
          version,
          source,
          config_json,
          created_at,
          created_by,
          comment
        FROM config_versions
        WHERE version = ?
        `,
      )
      .get(version) as
      | {
          version: number;
          source: ConfigVersionSnapshot['source'];
          config_json: string;
          created_at: number;
          created_by: string | null;
          comment: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      version: row.version,
      source: row.source,
      config: this.parseJson<EffectiveRuntimeConfig>(row.config_json),
      createdAt: row.created_at,
      createdBy: row.created_by ?? undefined,
      comment: row.comment ?? undefined,
    };
  }

  async listVersions(limit = 50): Promise<ConfigVersionSnapshot[]> {
    const rows = this.db
      .prepare(
        `
        SELECT
          version,
          source,
          config_json,
          created_at,
          created_by,
          comment
        FROM config_versions
        ORDER BY version DESC
        LIMIT ?
        `,
      )
      .all(limit) as Array<{
      version: number;
      source: ConfigVersionSnapshot['source'];
      config_json: string;
      created_at: number;
      created_by: string | null;
      comment: string | null;
    }>;

    return rows.map((row) => ({
      version: row.version,
      source: row.source,
      config: this.parseJson<EffectiveRuntimeConfig>(row.config_json),
      createdAt: row.created_at,
      createdBy: row.created_by ?? undefined,
      comment: row.comment ?? undefined,
    }));
  }

  async createChangeRequest(request: ConfigChangeRequest): Promise<void> {
    const stmt = this.db.prepare(
      `
      INSERT INTO config_change_requests (
        request_id,
        target_type,
        target_id,
        payload_json,
        status,
        requested_by,
        requested_at,
        approved_by,
        approved_at,
        validation_errors_json,
        validation_warnings_json,
        effective_at,
        comment
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    stmt.run(
      request.requestId,
      request.targetType,
      request.targetId,
      JSON.stringify(request.payload),
      request.status,
      request.requestedBy,
      request.requestedAt,
      request.approvedBy ?? null,
      request.approvedAt ?? null,
      JSON.stringify(request.validationErrors ?? []),
      JSON.stringify(request.validationWarnings ?? []),
      request.effectiveAt ?? null,
      request.comment ?? null,
    );
  }

  async updateChangeRequestStatus(
    requestId: string,
    status: ConfigChangeRequestStatus,
    validationErrors?: ValidationError[],
    validationWarnings?: ValidationWarning[],
  ): Promise<void> {
    const existing = await this.getChangeRequest(requestId);
    if (!existing) {
      throw new Error(`Change request no encontrado: ${requestId}`);
    }

    const stmt = this.db.prepare(
      `
      UPDATE config_change_requests
      SET
        status = ?,
        validation_errors_json = ?,
        validation_warnings_json = ?
      WHERE request_id = ?
      `,
    );

    stmt.run(
      status,
      JSON.stringify(validationErrors ?? existing.validationErrors ?? []),
      JSON.stringify(validationWarnings ?? existing.validationWarnings ?? []),
      requestId,
    );
  }

  async getChangeRequest(requestId: string): Promise<ConfigChangeRequest | null> {
    const row = this.db
      .prepare(
        `
        SELECT
          request_id,
          target_type,
          target_id,
          payload_json,
          status,
          requested_by,
          requested_at,
          approved_by,
          approved_at,
          validation_errors_json,
          validation_warnings_json,
          effective_at,
          comment
        FROM config_change_requests
        WHERE request_id = ?
        `,
      )
      .get(requestId) as
      | {
          request_id: string;
          target_type: ConfigChangeRequest['targetType'];
          target_id: string;
          payload_json: string;
          status: ConfigChangeRequestStatus;
          requested_by: string;
          requested_at: number;
          approved_by: string | null;
          approved_at: number | null;
          validation_errors_json: string | null;
          validation_warnings_json: string | null;
          effective_at: number | null;
          comment: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      requestId: row.request_id,
      targetType: row.target_type,
      targetId: row.target_id,
      payload: this.parseJson(row.payload_json),
      status: row.status,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      approvedBy: row.approved_by ?? undefined,
      approvedAt: row.approved_at ?? undefined,
      validationErrors: this.parseOptionalJson<ValidationError[]>(row.validation_errors_json) ?? [],
      validationWarnings: this.parseOptionalJson<ValidationWarning[]>(row.validation_warnings_json) ?? [],
      effectiveAt: row.effective_at ?? undefined,
      comment: row.comment ?? undefined,
    };
  }

  async listPendingChangeRequests(): Promise<ConfigChangeRequest[]> {
    const rows = this.db
      .prepare(
        `
        SELECT
          request_id,
          target_type,
          target_id,
          payload_json,
          status,
          requested_by,
          requested_at,
          approved_by,
          approved_at,
          validation_errors_json,
          validation_warnings_json,
          effective_at,
          comment
        FROM config_change_requests
        WHERE status = 'PENDING'
        ORDER BY requested_at ASC
        `,
      )
      .all() as Array<{
      request_id: string;
      target_type: ConfigChangeRequest['targetType'];
      target_id: string;
      payload_json: string;
      status: ConfigChangeRequestStatus;
      requested_by: string;
      requested_at: number;
      approved_by: string | null;
      approved_at: number | null;
      validation_errors_json: string | null;
      validation_warnings_json: string | null;
      effective_at: number | null;
      comment: string | null;
    }>;

    return rows.map((row) => ({
      requestId: row.request_id,
      targetType: row.target_type,
      targetId: row.target_id,
      payload: this.parseJson(row.payload_json),
      status: row.status,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      approvedBy: row.approved_by ?? undefined,
      approvedAt: row.approved_at ?? undefined,
      validationErrors: this.parseOptionalJson<ValidationError[]>(row.validation_errors_json) ?? [],
      validationWarnings: this.parseOptionalJson<ValidationWarning[]>(row.validation_warnings_json) ?? [],
      effectiveAt: row.effective_at ?? undefined,
      comment: row.comment ?? undefined,
    }));
  }

  async appendAuditLog(entry: AuditLogEntry): Promise<void> {
    const stmt = this.db.prepare(
      `
      INSERT INTO audit_log (
        audit_id,
        actor,
        action,
        target_type,
        target_id,
        request_id,
        version_before,
        version_after,
        diff_json,
        result,
        message,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    stmt.run(
      entry.auditId,
      entry.actor,
      entry.action,
      entry.targetType,
      entry.targetId,
      entry.requestId ?? null,
      entry.versionBefore ?? null,
      entry.versionAfter ?? null,
      JSON.stringify(entry.diff ?? []),
      entry.result,
      entry.message ?? null,
      entry.createdAt,
    );
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS effective_config (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        version INTEGER NOT NULL,
        config_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS config_versions (
        version INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT,
        comment TEXT
      );

      CREATE TABLE IF NOT EXISTS config_change_requests (
        request_id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        approved_by TEXT,
        approved_at INTEGER,
        validation_errors_json TEXT,
        validation_warnings_json TEXT,
        effective_at INTEGER,
        comment TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        audit_id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        request_id TEXT,
        version_before INTEGER,
        version_after INTEGER,
        diff_json TEXT,
        result TEXT NOT NULL,
        message TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_config_versions_created_at
        ON config_versions(created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_change_requests_status
        ON config_change_requests(status, requested_at);

      CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
        ON audit_log(created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_audit_log_request_id
        ON audit_log(request_id);
    `);
  }

  private parseJson<T = RowWithJson>(value: string): T {
    return JSON.parse(value) as T;
  }

  private parseOptionalJson<T = RowWithJson>(value: string | null): T | null {
    if (!value) return null;
    return JSON.parse(value) as T;
  }
}
