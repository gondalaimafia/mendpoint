import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppDb } from "@mendpoint/db";
import {
  bindConsumerRepoSnapshot,
  getScmConnection,
  getScmConnectionHealth,
  insertConnectedRepository,
  insertRepositorySnapshot,
  insertRepositorySnapshotPolicy,
  listConnectedRepositories,
  listRepositorySnapshots,
  listScmConnections,
  revokeScmConnection,
  setScmConnectionHealth,
  updateConnectedRepositoryStatus,
  upsertScmConnection,
} from "@mendpoint/db";
import { createLocalGitRepositorySource } from "@mendpoint/platform";
import { newId, nowIso } from "@mendpoint/shared";
import {
  repositorySnapshotDestination,
  resolveRepoKey,
} from "./repo-path.js";

const PROVIDERS = new Set(["github", "gitlab", "local_git"] as const);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;
const REPOSITORY_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

type ConnectionProvider = "github" | "gitlab" | "local_git";

function requireName(name: string, value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw new Error(`${name}_invalid`);
  }
  return value;
}

function requireRepositoryPart(name: string, value: unknown): string {
  if (
    typeof value !== "string" ||
    value === "." ||
    value === ".." ||
    !REPOSITORY_PART.test(value)
  ) {
    throw new Error(`${name}_invalid`);
  }
  return value;
}

function requireRemoteId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error("remote_id_invalid");
  }
  return value;
}

function parseProvider(value: unknown): ConnectionProvider {
  if (typeof value !== "string" || !PROVIDERS.has(value as ConnectionProvider)) {
    throw new Error("scm_provider_invalid");
  }
  return value as ConnectionProvider;
}

export function registerScmConnection(
  db: AppDb,
  input: {
    tenantId: string;
    provider: unknown;
    credentialRef?: unknown;
    externalAccountId: unknown;
    displayName: unknown;
  },
) {
  const provider = parseProvider(input.provider);
  const externalAccountId = requireName("external_account_id", input.externalAccountId);
  const displayName = requireName("display_name", input.displayName);
  const credentialRef =
    provider === "local_git"
      ? "local://filesystem"
      : typeof input.credentialRef === "string"
        ? input.credentialRef
        : "";
  const at = nowIso();
  const connection = upsertScmConnection(db, {
    id: newId(),
    tenantId: input.tenantId,
    provider,
    credentialRef,
    externalAccountId,
    displayName,
    createdAt: at,
    updatedAt: at,
  });
  setScmConnectionHealth(db, {
    connectionId: connection.id,
    tenantId: input.tenantId,
    configured: true,
    authenticated: provider === "local_git",
    readAccess: false,
    writeAccess: false,
    webhookOk: false,
    ciVisible: false,
    revoked: false,
    errorCode: provider === "local_git" ? "repository_probe_required" : "credential_probe_required",
    checkedAt: at,
  });
  return publicConnection(db, connection, input.tenantId);
}

export function registerConnectedRepository(
  db: AppDb,
  input: {
    tenantId: string;
    connectionId: string;
    remoteId: unknown;
    owner: unknown;
    name: unknown;
    defaultBranch: unknown;
    selectedBranch?: unknown;
    environment?: unknown;
    retentionDays?: unknown;
  },
) {
  const connection = getScmConnection(db, input.connectionId, input.tenantId);
  if (!connection) throw new Error("scm_connection_tenant_mismatch");
  const remoteId = requireRemoteId(input.remoteId);
  if (connection.provider === "local_git") {
    resolveRepoKey(remoteId, input.tenantId);
  }
  const defaultBranch = requireRepositoryPart("default_branch", input.defaultBranch);
  const selectedBranch =
    input.selectedBranch === undefined
      ? defaultBranch
      : requireRepositoryPart("selected_branch", input.selectedBranch);
  const retentionDays = input.retentionDays === undefined ? 30 : Number(input.retentionDays);
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new Error("repository_retention_invalid");
  }
  const at = nowIso();
  return insertConnectedRepository(db, {
    id: newId(),
    tenantId: input.tenantId,
    connectionId: connection.id,
    remoteId,
    owner: requireRepositoryPart("repository_owner", input.owner),
    name: requireRepositoryPart("repository_name", input.name),
    defaultBranch,
    selectedBranch,
    environment:
      input.environment === undefined
        ? "production"
        : requireName("repository_environment", input.environment),
    retentionDays,
    status: "pending",
    createdAt: at,
    updatedAt: at,
  });
}

export async function materializeConnectedRepository(
  db: AppDb,
  input: {
    tenantId: string;
    repositoryId: string;
    consumerRepoId?: string;
  },
) {
  const repository = listConnectedRepositories(db, input.tenantId).find(
    (candidate) => candidate.id === input.repositoryId,
  );
  if (!repository) throw new Error("connected_repository_tenant_mismatch");
  const connection = getScmConnection(db, repository.connection_id, input.tenantId);
  if (!connection) throw new Error("scm_connection_tenant_mismatch");
  if (connection.revoked_at) throw new Error("scm_connection_revoked");
  if (connection.provider !== "local_git") {
    throw new Error("repository_source_not_implemented");
  }

  const sourcePath = resolveRepoKey(repository.remote_id, input.tenantId);
  const source = await createLocalGitRepositorySource({ repositoryPath: sourcePath });
  const probe = await source.probe();
  const resolved = await source.resolveRef(repository.selected_branch);
  const snapshotId = newId();
  const destination = repositorySnapshotDestination(snapshotId, input.tenantId);
  await mkdir(dirname(destination), { recursive: true });
  const snapshot = await source.materialize(resolved, destination);
  try {
    const discovery = await source.discover(snapshot);
    const createdAt = nowIso();
    const expiresAt = new Date(
      Date.parse(createdAt) + repository.retention_days * 24 * 60 * 60 * 1000,
    ).toISOString();
    db.raw.exec("BEGIN IMMEDIATE");
    try {
      const stored = insertRepositorySnapshot(db, {
        id: snapshotId,
        tenantId: input.tenantId,
        repositoryId: repository.id,
        requestedRef: resolved.requestedRef,
        resolvedSha: snapshot.sha,
        manifestSha256: snapshot.manifestSha256,
        storagePath: snapshot.root,
        submodulesPolicy: snapshot.submodules.length ? "pinned" : "reject",
        lfsPolicy: snapshot.lfsPointers.length ? "pointer_only" : "reject",
        sparsePaths: [],
        createdAt,
        expiresAt,
      });
      if (stored.inserted) {
        insertRepositorySnapshotPolicy(db, {
          id: newId(),
          tenantId: input.tenantId,
          snapshotId: stored.row.id,
          codeowners: discovery.codeowners,
          ciFiles: discovery.ci.map((item) => item.path),
          verificationCommands: discovery.verificationCommands.map((item) => item.command),
          protectedBranch: {
            defaultBranch: repository.default_branch,
            selectedBranch: repository.selected_branch,
            exactCommit: stored.row.resolved_sha,
          },
          createdAt,
        });
      }
      if (input.consumerRepoId) {
        bindConsumerRepoSnapshot(db, {
          tenantId: input.tenantId,
          consumerRepoId: input.consumerRepoId,
          connectionId: connection.id,
          connectedRepositoryId: repository.id,
          snapshotId: stored.row.id,
        });
      }
      updateConnectedRepositoryStatus(db, {
        id: repository.id,
        tenantId: input.tenantId,
        status: "ready",
        updatedAt: createdAt,
      });
      setScmConnectionHealth(db, {
        connectionId: connection.id,
        tenantId: input.tenantId,
        configured: true,
        authenticated: true,
        readAccess: true,
        writeAccess: false,
        webhookOk: false,
        ciVisible: discovery.ci.length > 0,
        lastSyncAt: createdAt,
        revoked: false,
        errorCode: discovery.ci.length > 0 ? null : "ci_configuration_not_discovered",
        checkedAt: createdAt,
      });
      db.raw.exec("COMMIT");
      if (!stored.inserted) await removeSnapshot(snapshot.root).catch(() => undefined);
      return {
        snapshot: {
          id: stored.row.id,
          requestedRef: stored.row.requested_ref,
          exactCommit: stored.row.resolved_sha,
          manifestSha256: stored.row.manifest_sha256,
          createdAt: stored.row.created_at,
          expiresAt: stored.row.expires_at,
        },
        constraints: discovery,
        source: {
          provider: probe.provider,
          defaultBranch: probe.defaultBranch,
          headSha: probe.headSha,
          dirty: probe.dirty,
          hasSubmodules: probe.hasSubmodules,
          hasLfsPointers: probe.hasLfsPointers,
        },
        reused: !stored.inserted,
      };
    } catch (error) {
      db.raw.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    await removeSnapshot(snapshot.root);
    throw error;
  }
}

export function revokeConnection(db: AppDb, tenantId: string, connectionId: string) {
  const at = nowIso();
  const connection = revokeScmConnection(db, { id: connectionId, tenantId, revokedAt: at });
  setScmConnectionHealth(db, {
    connectionId,
    tenantId,
    configured: true,
    authenticated: false,
    readAccess: false,
    writeAccess: false,
    webhookOk: false,
    ciVisible: false,
    revoked: true,
    errorCode: "connection_revoked",
    checkedAt: at,
  });
  return publicConnection(db, connection, tenantId);
}

export function scmOverview(db: AppDb, tenantId: string) {
  const connections = listScmConnections(db, tenantId).map((connection) =>
    publicConnection(db, connection, tenantId),
  );
  const repositories = listConnectedRepositories(db, tenantId).map((repository) => ({
    id: repository.id,
    connectionId: repository.connection_id,
    providerRepositoryId: repository.remote_id,
    owner: repository.owner,
    name: repository.name,
    defaultBranch: repository.default_branch,
    selectedBranch: repository.selected_branch,
    environment: repository.environment,
    retentionDays: repository.retention_days,
    status: repository.status,
    snapshots: listRepositorySnapshots(db, tenantId, repository.id).map((snapshot) => ({
      id: snapshot.id,
      requestedRef: snapshot.requested_ref,
      exactCommit: snapshot.resolved_sha,
      manifestSha256: snapshot.manifest_sha256,
      createdAt: snapshot.created_at,
      expiresAt: snapshot.expires_at,
    })),
  }));
  return {
    providers: [
      { provider: "local_git", connection: true, snapshots: true, pullRequests: false },
      { provider: "github", connection: true, snapshots: false, pullRequests: true },
      { provider: "gitlab", connection: true, snapshots: false, pullRequests: false },
    ],
    connections,
    repositories,
  };
}

function publicConnection(
  db: AppDb,
  connection: ReturnType<typeof listScmConnections>[number],
  tenantId: string,
) {
  const health = getScmConnectionHealth(db, connection.id, tenantId);
  return {
    id: connection.id,
    provider: connection.provider,
    externalAccountId: connection.external_account_id,
    displayName: connection.display_name,
    credentialConfigured: Boolean(connection.credential_ref),
    revokedAt: connection.revoked_at,
    health: health
      ? {
          configured: Boolean(health.configured),
          authenticated: Boolean(health.authenticated),
          readAccess: Boolean(health.read_access),
          writeAccess: Boolean(health.write_access),
          webhookOk: Boolean(health.webhook_ok),
          ciVisible: Boolean(health.ci_visible),
          lastSyncAt: health.last_sync_at,
          lastDeliveryAt: health.last_delivery_at,
          revoked: Boolean(health.revoked),
          errorCode: health.error_code,
          checkedAt: health.checked_at,
        }
      : null,
  };
}

async function removeSnapshot(root: string): Promise<void> {
  await chmod(root, 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
