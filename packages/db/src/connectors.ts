/**
 * Storage for self-serve toolchain connectors (S3-connectors).
 *
 * Mirrors the SCM connection storage (`repository.ts`): every read and write is
 * tenant-scoped, cross-tenant access throws `connector_tenant_mismatch`, and
 * revocation is idempotent/immutable. Credentials are stored only as an
 * AES-256-GCM envelope JSON (`credential_envelope`) — never plaintext — and this
 * layer never inspects or logs it.
 */
import type { AppDb } from "./index.js";
import type { ConnectorRow } from "./schema.js";

const KINDS = new Set<ConnectorRow["kind"]>(["ci", "ticketing", "docs"]);
const MODES = new Set<ConnectorRow["mode"]>(["mock", "real"]);
const HEALTH = new Set<ConnectorRow["health_status"]>([
  "unverified",
  "verified",
  "failed",
  "revoked",
]);

function one<T>(db: AppDb, sql: string, params: unknown[] = []): T | undefined {
  return db.raw.prepare(sql).get(...(params as never[])) as T | undefined;
}

function many<T>(db: AppDb, sql: string, params: unknown[] = []): T[] {
  return db.raw.prepare(sql).all(...(params as never[])) as T[];
}

function required(name: string, value: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`connector_${name}_required`);
  }
}

export type RegisterConnectorInput = {
  id: string;
  tenantId: string;
  kind: ConnectorRow["kind"];
  provider: string;
  displayName: string;
  mode: ConnectorRow["mode"];
  credentialEnvelope?: string | null;
  configJson?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Upsert a connector for a tenant, keyed by (tenant, kind, provider,
 * display_name). Registering re-arms verification: health resets to
 * `unverified` until a fresh probe runs. Fails closed on cross-tenant id reuse
 * and on writing to a revoked connector.
 */
export function registerConnector(db: AppDb, input: RegisterConnectorInput): ConnectorRow {
  if (!KINDS.has(input.kind)) throw new Error("connector_kind_invalid");
  if (!MODES.has(input.mode)) throw new Error("connector_mode_invalid");
  required("tenant_id", input.tenantId);
  required("provider", input.provider);
  required("display_name", input.displayName);
  const configJson = input.configJson ?? "{}";

  const byId = one<ConnectorRow>(db, `SELECT * FROM connectors WHERE id = ?`, [input.id]);
  if (byId && byId.tenant_id !== input.tenantId) {
    throw new Error("connector_tenant_mismatch");
  }
  const existing =
    byId ??
    one<ConnectorRow>(
      db,
      `SELECT * FROM connectors
       WHERE tenant_id = ? AND kind = ? AND provider = ? AND display_name = ?`,
      [input.tenantId, input.kind, input.provider, input.displayName],
    );
  if (existing) {
    if (existing.revoked_at) throw new Error("connector_revoked");
    db.raw
      .prepare(
        `UPDATE connectors
         SET mode = ?, credential_envelope = ?, config_json = ?,
             health_status = 'unverified', verified = 0, error_code = NULL,
             last_verified_at = NULL, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
      )
      .run(
        input.mode,
        input.credentialEnvelope ?? null,
        configJson,
        input.updatedAt,
        existing.id,
        input.tenantId,
      );
    return one<ConnectorRow>(db, `SELECT * FROM connectors WHERE id = ?`, [existing.id])!;
  }
  db.raw
    .prepare(
      `INSERT INTO connectors
       (id, tenant_id, kind, provider, display_name, mode, credential_envelope,
        config_json, health_status, verified, error_code, last_verified_at,
        created_at, updated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unverified', 0, NULL, NULL, ?, ?, NULL)`,
    )
    .run(
      input.id,
      input.tenantId,
      input.kind,
      input.provider,
      input.displayName,
      input.mode,
      input.credentialEnvelope ?? null,
      configJson,
      input.createdAt,
      input.updatedAt,
    );
  return one<ConnectorRow>(db, `SELECT * FROM connectors WHERE id = ?`, [input.id])!;
}

export function listConnectors(
  db: AppDb,
  tenantId: string,
  kind?: ConnectorRow["kind"],
): ConnectorRow[] {
  if (kind) {
    return many<ConnectorRow>(
      db,
      `SELECT * FROM connectors WHERE tenant_id = ? AND kind = ? ORDER BY created_at, id`,
      [tenantId, kind],
    );
  }
  return many<ConnectorRow>(
    db,
    `SELECT * FROM connectors WHERE tenant_id = ? ORDER BY created_at, id`,
    [tenantId],
  );
}

export function getConnector(
  db: AppDb,
  id: string,
  tenantId: string,
): ConnectorRow | undefined {
  return one<ConnectorRow>(db, `SELECT * FROM connectors WHERE id = ? AND tenant_id = ?`, [
    id,
    tenantId,
  ]);
}

export type SetConnectorHealthInput = {
  id: string;
  tenantId: string;
  healthStatus: ConnectorRow["health_status"];
  verified: boolean;
  errorCode?: string | null;
  lastVerifiedAt?: string | null;
  updatedAt: string;
};

/** Record the result of a `verifyConnection()` probe, tenant-scoped. */
export function setConnectorHealth(db: AppDb, input: SetConnectorHealthInput): ConnectorRow {
  if (!HEALTH.has(input.healthStatus)) throw new Error("connector_health_invalid");
  const existing = getConnector(db, input.id, input.tenantId);
  if (!existing) throw new Error("connector_tenant_mismatch");
  if (existing.revoked_at) throw new Error("connector_revoked");
  db.raw
    .prepare(
      `UPDATE connectors
       SET health_status = ?, verified = ?, error_code = ?, last_verified_at = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    )
    .run(
      input.healthStatus,
      input.verified ? 1 : 0,
      input.errorCode ?? null,
      input.lastVerifiedAt ?? null,
      input.updatedAt,
      input.id,
      input.tenantId,
    );
  return getConnector(db, input.id, input.tenantId)!;
}

/** Soft-revoke a connector. Idempotent: revocation time is set once. */
export function revokeConnector(
  db: AppDb,
  input: { id: string; tenantId: string; revokedAt: string },
): ConnectorRow {
  const existing = getConnector(db, input.id, input.tenantId);
  if (!existing) throw new Error("connector_tenant_mismatch");
  db.raw
    .prepare(
      `UPDATE connectors
       SET revoked_at = COALESCE(revoked_at, ?), health_status = 'revoked', verified = 0,
           updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    )
    .run(input.revokedAt, input.revokedAt, input.id, input.tenantId);
  return getConnector(db, input.id, input.tenantId)!;
}
