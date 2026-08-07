import type { SQLInputValue } from "node:sqlite";
import { isAbsolute } from "node:path";
import type { AppDb } from "./index.js";
import type {
  ConnectedRepositoryRow,
  RepositorySnapshotPolicyRow,
  RepositorySnapshotDeletionRow,
  RepositorySnapshotFileRow,
  RepositorySnapshotRow,
  ScmConnectionHealthRow,
  ScmConnectionRow,
} from "./schema.js";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SECRET_REF = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._/@:-]+$/;
const RAW_SECRET = /^(?:ghp_|github_pat_|glpat-|me_)/;
const PROVIDERS = new Set(["github", "gitlab", "local_git"]);
const REPOSITORY_STATES = new Set(["pending", "ready", "degraded", "revoked"]);

function one<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}

function many<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T[] {
  return db.raw.prepare(sql).all(...params) as T[];
}

function required(name: string, value: string) {
  if (!value.trim()) throw new Error(`${name}_required`);
}

function timestamp(name: string, value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name}_invalid`);
  return parsed;
}

function json(name: string, value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`${name}_invalid`);
  return encoded;
}

function assertCredentialReference(reference: string) {
  if (!SECRET_REF.test(reference) || RAW_SECRET.test(reference)) {
    throw new Error("credential_reference_required");
  }
}

export function upsertScmConnection(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    provider: ScmConnectionRow["provider"];
    credentialRef: string;
    externalAccountId: string;
    displayName: string;
    createdAt: string;
    updatedAt: string;
    revokedAt?: string | null;
  },
): ScmConnectionRow {
  if (!PROVIDERS.has(input.provider)) throw new Error("scm_provider_invalid");
  required("tenant_id", input.tenantId);
  required("external_account_id", input.externalAccountId);
  required("display_name", input.displayName);
  assertCredentialReference(input.credentialRef);
  const byId = one<ScmConnectionRow>(db, `SELECT * FROM scm_connections WHERE id = ?`, [input.id]);
  if (byId && byId.tenant_id !== input.tenantId) {
    throw new Error("scm_connection_tenant_mismatch");
  }
  const existing =
    byId ??
    one<ScmConnectionRow>(
      db,
      `SELECT * FROM scm_connections
       WHERE tenant_id = ? AND provider = ? AND external_account_id = ?`,
      [input.tenantId, input.provider, input.externalAccountId],
    );
  if (existing) {
    if (existing.revoked_at && input.revokedAt !== existing.revoked_at) {
      throw new Error("scm_connection_revocation_immutable");
    }
    db.raw
      .prepare(
        `UPDATE scm_connections
         SET credential_ref = ?, display_name = ?, updated_at = ?, revoked_at = ?
         WHERE id = ? AND tenant_id = ?`,
      )
      .run(
        input.credentialRef,
        input.displayName,
        input.updatedAt,
        existing.revoked_at ?? input.revokedAt ?? null,
        existing.id,
        input.tenantId,
      );
    return one<ScmConnectionRow>(db, `SELECT * FROM scm_connections WHERE id = ?`, [existing.id])!;
  }
  db.raw
    .prepare(
      `INSERT INTO scm_connections
       (id, tenant_id, provider, credential_ref, external_account_id, display_name,
        created_at, updated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId,
      input.provider,
      input.credentialRef,
      input.externalAccountId,
      input.displayName,
      input.createdAt,
      input.updatedAt,
      input.revokedAt ?? null,
    );
  return one<ScmConnectionRow>(db, `SELECT * FROM scm_connections WHERE id = ?`, [input.id])!;
}

export function revokeScmConnection(
  db: AppDb,
  input: { id: string; tenantId: string; revokedAt: string },
): ScmConnectionRow {
  timestamp("revoked_at", input.revokedAt);
  const connection = one<ScmConnectionRow>(
    db,
    `SELECT * FROM scm_connections WHERE id = ? AND tenant_id = ?`,
    [input.id, input.tenantId],
  );
  if (!connection) throw new Error("scm_connection_tenant_mismatch");
  if (connection.revoked_at && connection.revoked_at !== input.revokedAt) {
    throw new Error("scm_connection_revocation_immutable");
  }
  db.raw
    .prepare(
      `UPDATE scm_connections
       SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    )
    .run(input.revokedAt, input.revokedAt, input.id, input.tenantId);
  return one<ScmConnectionRow>(db, `SELECT * FROM scm_connections WHERE id = ?`, [input.id])!;
}

export function listScmConnections(db: AppDb, tenantId: string): ScmConnectionRow[] {
  return many(
    db,
    `SELECT * FROM scm_connections WHERE tenant_id = ? ORDER BY created_at, id`,
    [tenantId],
  );
}

export function getScmConnection(
  db: AppDb,
  id: string,
  tenantId: string,
): ScmConnectionRow | undefined {
  return one(db, `SELECT * FROM scm_connections WHERE id = ? AND tenant_id = ?`, [id, tenantId]);
}

export function insertConnectedRepository(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    connectionId: string;
    remoteId: string;
    owner: string;
    name: string;
    defaultBranch: string;
    selectedBranch?: string;
    environment?: string;
    retentionDays?: number;
    status?: ConnectedRepositoryRow["status"];
    createdAt: string;
    updatedAt: string;
  },
): ConnectedRepositoryRow {
  const connection = one<ScmConnectionRow>(
    db,
    `SELECT * FROM scm_connections WHERE id = ? AND tenant_id = ?`,
    [input.connectionId, input.tenantId],
  );
  if (!connection) throw new Error("scm_connection_tenant_mismatch");
  if (connection.revoked_at) throw new Error("scm_connection_revoked");
  const status = input.status ?? "pending";
  if (!REPOSITORY_STATES.has(status)) throw new Error("repository_status_invalid");
  const retentionDays = input.retentionDays ?? 30;
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) {
    throw new Error("repository_retention_invalid");
  }
  for (const [name, value] of [
    ["remote_id", input.remoteId],
    ["repository_owner", input.owner],
    ["repository_name", input.name],
    ["default_branch", input.defaultBranch],
  ] as const) {
    required(name, value);
  }
  db.raw
    .prepare(
      `INSERT INTO connected_repositories
       (id, tenant_id, connection_id, remote_id, owner, name, default_branch,
        selected_branch, environment, retention_days, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId,
      input.connectionId,
      input.remoteId,
      input.owner,
      input.name,
      input.defaultBranch,
      input.selectedBranch ?? input.defaultBranch,
      input.environment ?? "production",
      retentionDays,
      status,
      input.createdAt,
      input.updatedAt,
    );
  return getConnectedRepository(db, input.id, input.tenantId)!;
}

export function getConnectedRepository(
  db: AppDb,
  id: string,
  tenantId: string,
): ConnectedRepositoryRow | undefined {
  return one(
    db,
    `SELECT * FROM connected_repositories WHERE id = ? AND tenant_id = ?`,
    [id, tenantId],
  );
}

export function listConnectedRepositories(
  db: AppDb,
  tenantId: string,
): ConnectedRepositoryRow[] {
  return many(
    db,
    `SELECT * FROM connected_repositories WHERE tenant_id = ? ORDER BY created_at, id`,
    [tenantId],
  );
}

export function updateConnectedRepositoryStatus(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    status: ConnectedRepositoryRow["status"];
    updatedAt: string;
  },
): ConnectedRepositoryRow {
  if (!REPOSITORY_STATES.has(input.status)) throw new Error("repository_status_invalid");
  const result = db.raw
    .prepare(
      `UPDATE connected_repositories SET status = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    )
    .run(input.status, input.updatedAt, input.id, input.tenantId);
  if (result.changes !== 1) throw new Error("connected_repository_tenant_mismatch");
  return getConnectedRepository(db, input.id, input.tenantId)!;
}

export function insertRepositorySnapshot(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    repositoryId: string;
    requestedRef: string;
    resolvedSha: string;
    manifestSha256: string;
    storagePath: string;
    submodulesPolicy?: RepositorySnapshotRow["submodules_policy"];
    lfsPolicy?: RepositorySnapshotRow["lfs_policy"];
    sparsePaths?: string[];
    fileManifestVersion?: 1;
    reuseSnapshotId?: string;
    createdAt: string;
    expiresAt: string;
  },
): { row: RepositorySnapshotRow; inserted: boolean } {
  const repository = getConnectedRepository(db, input.repositoryId, input.tenantId);
  if (!repository) throw new Error("connected_repository_tenant_mismatch");
  if (!SHA.test(input.resolvedSha) || !/^[a-f0-9]{64}$/.test(input.manifestSha256)) {
    throw new Error("repository_snapshot_hash_invalid");
  }
  const createdAt = timestamp("repository_snapshot_created_at", input.createdAt);
  const expiresAt = timestamp("repository_snapshot_expires_at", input.expiresAt);
  if (expiresAt <= createdAt) {
    throw new Error("repository_snapshot_expiry_invalid");
  }
  required("snapshot_ref", input.requestedRef);
  required("snapshot_storage_path", input.storagePath);
  if (!isAbsolute(input.storagePath)) throw new Error("repository_snapshot_path_invalid");
  if (input.reuseSnapshotId) {
    required("snapshot_reuse_id", input.reuseSnapshotId);
    const existing = one<RepositorySnapshotRow>(
      db,
      `SELECT snapshot.* FROM repository_snapshots snapshot
       WHERE snapshot.id = ? AND snapshot.tenant_id = ? AND snapshot.repository_id = ?
         AND snapshot.requested_ref = ? AND snapshot.resolved_sha = ?
         AND snapshot.manifest_sha256 = ? AND snapshot.file_manifest_version = 1
         AND snapshot.expires_at > ?
         AND COALESCE((
           SELECT deletion.status FROM repository_snapshot_deletions deletion
           WHERE deletion.tenant_id = snapshot.tenant_id
             AND deletion.snapshot_id = snapshot.id
           ORDER BY deletion.created_at DESC, deletion.rowid DESC LIMIT 1
         ), '') NOT IN ('planned', 'deleted')`,
      [
        input.reuseSnapshotId,
        input.tenantId,
        input.repositoryId,
        input.requestedRef,
        input.resolvedSha,
        input.manifestSha256,
        input.createdAt,
      ],
    );
    if (existing) return { row: existing, inserted: false };
  }
  db.raw
    .prepare(
      `INSERT INTO repository_snapshots
       (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256,
        storage_path, submodules_policy, lfs_policy, sparse_paths_json,
        file_manifest_version, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId,
      input.repositoryId,
      input.requestedRef,
      input.resolvedSha,
      input.manifestSha256,
      input.storagePath,
      input.submodulesPolicy ?? "reject",
      input.lfsPolicy ?? "reject",
      json("repository_snapshot_sparse_paths", input.sparsePaths ?? []),
      input.fileManifestVersion ?? 0,
      input.createdAt,
      input.expiresAt,
    );
  return {
    row: one<RepositorySnapshotRow>(db, `SELECT * FROM repository_snapshots WHERE id = ?`, [input.id])!,
    inserted: true,
  };
}

export function listRepositorySnapshots(
  db: AppDb,
  tenantId: string,
  repositoryId: string,
): RepositorySnapshotRow[] {
  return many(
    db,
    `SELECT * FROM repository_snapshots
     WHERE tenant_id = ? AND repository_id = ? ORDER BY created_at DESC, id`,
    [tenantId, repositoryId],
  );
}

export function listRepositorySnapshotReuseCandidates(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    repositoryId: string;
    requestedRef: string;
    resolvedSha: string;
    manifestSha256: string;
    asOf: string;
  }>,
): RepositorySnapshotRow[] {
  required("snapshot_ref", input.requestedRef);
  timestamp("snapshot_reuse_as_of", input.asOf);
  return many(
    db,
    `SELECT snapshot.* FROM repository_snapshots snapshot
     WHERE snapshot.tenant_id = ? AND snapshot.repository_id = ?
       AND snapshot.requested_ref = ? AND snapshot.resolved_sha = ?
       AND snapshot.manifest_sha256 = ? AND snapshot.file_manifest_version = 1
       AND snapshot.expires_at > ?
       AND COALESCE((
         SELECT deletion.status FROM repository_snapshot_deletions deletion
         WHERE deletion.tenant_id = snapshot.tenant_id
           AND deletion.snapshot_id = snapshot.id
         ORDER BY deletion.created_at DESC, deletion.rowid DESC LIMIT 1
       ), '') NOT IN ('planned', 'deleted')
     ORDER BY snapshot.created_at DESC, snapshot.id DESC`,
    [
      input.tenantId,
      input.repositoryId,
      input.requestedRef,
      input.resolvedSha,
      input.manifestSha256,
      input.asOf,
    ],
  );
}

function normalizedSnapshotFiles(
  files: readonly Readonly<{
    path: string;
    mode: string;
    kind: string;
    size: number;
    sha256: string;
  }>[],
): Array<Omit<RepositorySnapshotFileRow, "snapshot_id" | "tenant_id">> {
  const seen = new Set<string>();
  return files.map((file) => {
    const path = file.path;
    const segments = path.split("/");
    if (file.kind !== "file" && file.kind !== "symlink") {
      throw new Error("repository_snapshot_file_kind_invalid");
    }
    if (
      !path || path.trim() !== path || path.includes("\\") || path.includes("\0") ||
      isAbsolute(path) || segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error("repository_snapshot_file_path_invalid");
    }
    if (seen.has(path)) throw new Error("repository_snapshot_file_path_duplicate");
    seen.add(path);
    if (
      (file.kind === "file" && file.mode !== "100644" && file.mode !== "100755") ||
      (file.kind === "symlink" && file.mode !== "120000")
    ) {
      throw new Error("repository_snapshot_file_mode_invalid");
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error("repository_snapshot_file_size_invalid");
    }
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error("repository_snapshot_file_hash_invalid");
    }
    return {
      path,
      mode: file.mode as RepositorySnapshotFileRow["mode"],
      kind: file.kind as RepositorySnapshotFileRow["kind"],
      size: file.size,
      sha256: file.sha256,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export function insertRepositorySnapshotFiles(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    snapshotId: string;
    files: readonly Readonly<{
      path: string;
      mode: string;
      kind: string;
      size: number;
      sha256: string;
    }>[];
  }>,
): Readonly<{ rows: RepositorySnapshotFileRow[]; inserted: boolean }> {
  const snapshot = one<RepositorySnapshotRow>(
    db,
    `SELECT * FROM repository_snapshots WHERE id = ? AND tenant_id = ?`,
    [input.snapshotId, input.tenantId],
  );
  if (!snapshot) throw new Error("repository_snapshot_tenant_mismatch");
  const files = normalizedSnapshotFiles(input.files);
  const existing = listRepositorySnapshotFiles(db, input.tenantId, input.snapshotId);
  if (existing.length) {
    const exact = existing.length === files.length && existing.every((row, index) => {
      const file = files[index];
      return file !== undefined && row.path === file.path && row.mode === file.mode &&
        row.kind === file.kind && row.size === file.size && row.sha256 === file.sha256;
    });
    if (!exact) throw new Error("repository_snapshot_file_manifest_conflict");
    return Object.freeze({ rows: existing, inserted: false });
  }
  if (!files.length) return Object.freeze({ rows: [], inserted: false });

  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const statement = db.raw.prepare(
      `INSERT INTO repository_snapshot_files
       (snapshot_id, tenant_id, path, mode, kind, size, sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const file of files) {
      statement.run(
        input.snapshotId,
        input.tenantId,
        file.path,
        file.mode,
        file.kind,
        file.size,
        file.sha256,
      );
    }
    if (ownsTransaction) db.raw.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
  return Object.freeze({
    rows: listRepositorySnapshotFiles(db, input.tenantId, input.snapshotId),
    inserted: true,
  });
}

export function listRepositorySnapshotFiles(
  db: AppDb,
  tenantId: string,
  snapshotId: string,
): RepositorySnapshotFileRow[] {
  return many(
    db,
    `SELECT * FROM repository_snapshot_files
     WHERE tenant_id = ? AND snapshot_id = ? ORDER BY path`,
    [tenantId, snapshotId],
  );
}

export function getLatestRepositorySnapshot(
  db: AppDb,
  tenantId: string,
  repositoryId: string,
): RepositorySnapshotRow | undefined {
  return one(
    db,
    `SELECT * FROM repository_snapshots
     WHERE tenant_id = ? AND repository_id = ?
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [tenantId, repositoryId],
  );
}

export function insertRepositorySnapshotPolicy(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    snapshotId: string;
    codeowners: unknown;
    ciFiles: string[];
    verificationCommands: string[];
    protectedBranch: unknown;
    createdAt: string;
  },
): RepositorySnapshotPolicyRow {
  const snapshot = one<RepositorySnapshotRow>(
    db,
    `SELECT * FROM repository_snapshots WHERE id = ? AND tenant_id = ?`,
    [input.snapshotId, input.tenantId],
  );
  if (!snapshot) throw new Error("repository_snapshot_tenant_mismatch");
  db.raw
    .prepare(
      `INSERT INTO repository_snapshot_policies
       (id, tenant_id, snapshot_id, codeowners_json, ci_files_json,
        verification_commands_json, protected_branch_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId,
      input.snapshotId,
      json("repository_snapshot_codeowners", input.codeowners),
      json("repository_snapshot_ci_files", input.ciFiles),
      json("repository_snapshot_verification_commands", input.verificationCommands),
      json("repository_snapshot_protected_branch", input.protectedBranch),
      input.createdAt,
    );
  return one<RepositorySnapshotPolicyRow>(
    db,
    `SELECT * FROM repository_snapshot_policies WHERE id = ?`,
    [input.id],
  )!;
}

export function getRepositorySnapshotPolicy(
  db: AppDb,
  tenantId: string,
  snapshotId: string,
): RepositorySnapshotPolicyRow | undefined {
  return one(
    db,
    `SELECT * FROM repository_snapshot_policies WHERE tenant_id = ? AND snapshot_id = ?`,
    [tenantId, snapshotId],
  );
}

export function listExpiredRepositorySnapshots(
  db: AppDb,
  tenantId: string,
  asOf: string,
): RepositorySnapshotRow[] {
  timestamp("snapshot_expiry_as_of", asOf);
  return many(
    db,
    `SELECT s.* FROM repository_snapshots s
     WHERE s.tenant_id = ? AND s.expires_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM repository_snapshot_deletions d
         WHERE d.tenant_id = s.tenant_id AND d.snapshot_id = s.id AND d.status = 'deleted'
       )
     ORDER BY s.expires_at, s.id`,
    [tenantId, asOf],
  );
}

export function recordRepositorySnapshotDeletion(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    snapshotId: string;
    status: RepositorySnapshotDeletionRow["status"];
    actorPrincipalId: string;
    errorCode?: string | null;
    createdAt: string;
  },
): RepositorySnapshotDeletionRow {
  const snapshot = one<RepositorySnapshotRow>(
    db,
    `SELECT * FROM repository_snapshots WHERE id = ? AND tenant_id = ?`,
    [input.snapshotId, input.tenantId],
  );
  if (!snapshot) throw new Error("repository_snapshot_tenant_mismatch");
  if (!["planned", "deleted", "failed"].includes(input.status)) {
    throw new Error("repository_snapshot_deletion_status_invalid");
  }
  required("snapshot_deletion_actor", input.actorPrincipalId);
  timestamp("snapshot_deletion_created_at", input.createdAt);
  db.raw
    .prepare(
      `INSERT INTO repository_snapshot_deletions
       (id, tenant_id, snapshot_id, status, actor_principal_id, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId,
      input.snapshotId,
      input.status,
      input.actorPrincipalId,
      input.errorCode ?? null,
      input.createdAt,
    );
  return one<RepositorySnapshotDeletionRow>(
    db,
    `SELECT * FROM repository_snapshot_deletions WHERE id = ?`,
    [input.id],
  )!;
}

export function getRepositorySnapshotDeletionStatus(
  db: AppDb,
  tenantId: string,
  snapshotId: string,
): RepositorySnapshotDeletionRow | undefined {
  return one(
    db,
    `SELECT * FROM repository_snapshot_deletions
     WHERE tenant_id = ? AND snapshot_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [tenantId, snapshotId],
  );
}

export function bindConsumerRepoSnapshot(
  db: AppDb,
  input: {
    tenantId: string;
    consumerRepoId: string;
    connectionId: string;
    connectedRepositoryId: string;
    snapshotId: string;
  },
) {
  const owned = one<{ id: string }>(
    db,
    `SELECT r.id FROM consumer_repos r
     JOIN consumers c ON c.id = r.consumer_id
     WHERE r.id = ? AND c.tenant_id = ?`,
    [input.consumerRepoId, input.tenantId],
  );
  if (!owned) throw new Error("consumer_repository_tenant_mismatch");
  const snapshot = one<RepositorySnapshotRow>(
    db,
    `SELECT s.* FROM repository_snapshots s
     JOIN connected_repositories r ON r.id = s.repository_id
     WHERE s.id = ? AND s.tenant_id = ? AND r.id = ? AND r.connection_id = ?`,
    [
      input.snapshotId,
      input.tenantId,
      input.connectedRepositoryId,
      input.connectionId,
    ],
  );
  if (!snapshot) throw new Error("repository_snapshot_binding_mismatch");
  db.raw
    .prepare(
      `UPDATE consumer_repos
       SET local_path = ?, scm_connection_id = ?, connected_repository_id = ?,
           snapshot_id = ?, exact_commit = ?
       WHERE id = ?`,
    )
    .run(
      snapshot.storage_path,
      input.connectionId,
      input.connectedRepositoryId,
      input.snapshotId,
      snapshot.resolved_sha,
      input.consumerRepoId,
    );
}

export function setScmConnectionHealth(
  db: AppDb,
  input: {
    connectionId: string;
    tenantId: string;
    configured: boolean;
    authenticated: boolean;
    readAccess: boolean;
    writeAccess: boolean;
    webhookOk: boolean;
    ciVisible: boolean;
    lastSyncAt?: string | null;
    lastDeliveryAt?: string | null;
    revoked: boolean;
    errorCode?: string | null;
    checkedAt: string;
  },
): ScmConnectionHealthRow {
  const connection = one<ScmConnectionRow>(
    db,
    `SELECT * FROM scm_connections WHERE id = ? AND tenant_id = ?`,
    [input.connectionId, input.tenantId],
  );
  if (!connection) throw new Error("scm_connection_tenant_mismatch");
  const revoked = connection.revoked_at !== null;
  if (input.revoked !== revoked) throw new Error("scm_connection_health_revocation_mismatch");
  db.raw
    .prepare(
      `INSERT INTO scm_connection_health
       (connection_id, tenant_id, configured, authenticated, read_access, write_access,
        webhook_ok, ci_visible, last_sync_at, last_delivery_at, revoked, error_code, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET
         configured = excluded.configured,
         authenticated = excluded.authenticated,
         read_access = excluded.read_access,
         write_access = excluded.write_access,
         webhook_ok = excluded.webhook_ok,
         ci_visible = excluded.ci_visible,
         last_sync_at = excluded.last_sync_at,
         last_delivery_at = excluded.last_delivery_at,
         revoked = excluded.revoked,
         error_code = excluded.error_code,
         checked_at = excluded.checked_at
       WHERE scm_connection_health.tenant_id = excluded.tenant_id`,
    )
    .run(
      input.connectionId,
      input.tenantId,
      Number(input.configured),
      Number(input.authenticated),
      Number(input.readAccess),
      Number(input.writeAccess),
      Number(input.webhookOk),
      Number(input.ciVisible),
      input.lastSyncAt ?? null,
      input.lastDeliveryAt ?? null,
      Number(revoked),
      input.errorCode ?? null,
      input.checkedAt,
    );
  return getScmConnectionHealth(db, input.connectionId, input.tenantId)!;
}

export function getScmConnectionHealth(
  db: AppDb,
  connectionId: string,
  tenantId: string,
): ScmConnectionHealthRow | undefined {
  return one(
    db,
    `SELECT * FROM scm_connection_health WHERE connection_id = ? AND tenant_id = ?`,
    [connectionId, tenantId],
  );
}
