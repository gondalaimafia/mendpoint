import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppDb } from "@mendpoint/db";
import {
  bindConsumerRepoSnapshot,
  getScmConnection,
  getScmConnectionHealth,
  getRepositorySnapshotDeletionStatus,
  insertConnectedRepository,
  insertRepositorySnapshot,
  insertRepositorySnapshotPolicy,
  listConnectedRepositories,
  listExpiredRepositorySnapshots,
  listRepositorySnapshots,
  listScmConnections,
  revokeScmConnection,
  recordRepositorySnapshotDeletion,
  setScmConnectionHealth,
  updateConnectedRepositoryStatus,
  upsertScmConnection,
} from "@mendpoint/db";
import {
  CredentialAccessError,
  RepositorySourceError,
  createGitHubRepositorySource,
  createLocalGitRepositorySource,
  type CredentialBroker,
  type CredentialDescriptor,
  type GitHubRepositoryTransport,
  type RepositorySource,
} from "@mendpoint/platform";
import { newId, nowIso } from "@mendpoint/shared";
import {
  assertRepositorySnapshotPath,
  repositorySnapshotDestination,
  resolveRepoKey,
} from "./repo-path.js";

const PROVIDERS = new Set(["github", "gitlab", "local_git"] as const);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;
const REPOSITORY_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

type ConnectionProvider = "github" | "gitlab" | "local_git";

type ScmConnection = NonNullable<ReturnType<typeof getScmConnection>>;

export type RepositoryConnectionDependencies = Readonly<{
  credentialBroker: CredentialBroker;
  githubTransport?: GitHubRepositoryTransport;
  credentialDescriptor?: (input: {
    connection: ScmConnection;
    tenantId: string;
  }) => CredentialDescriptor;
  actorId?: string;
  requestId?: string;
}>;

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

function requireBranch(name: string, value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    /[\x00-\x20\x7f~^:?*[\\]/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock")
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
  if (provider === "github" && !/^[1-9][0-9]{0,19}$/.test(externalAccountId)) {
    throw new Error("github_installation_id_invalid");
  }
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
  } else if (connection.provider === "github" && !/^[1-9][0-9]{0,19}$/.test(remoteId)) {
    throw new Error("github_repository_id_invalid");
  }
  const defaultBranch = requireBranch("default_branch", input.defaultBranch);
  const selectedBranch =
    input.selectedBranch === undefined
      ? defaultBranch
      : requireBranch("selected_branch", input.selectedBranch);
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
    sparsePaths?: string[];
  },
  dependencies?: RepositoryConnectionDependencies,
) {
  const repository = listConnectedRepositories(db, input.tenantId).find(
    (candidate) => candidate.id === input.repositoryId,
  );
  if (!repository) throw new Error("connected_repository_tenant_mismatch");
  const connection = getScmConnection(db, repository.connection_id, input.tenantId);
  if (!connection) throw new Error("scm_connection_tenant_mismatch");
  if (connection.revoked_at) throw new Error("scm_connection_revoked");
  let source: RepositorySource;
  let liveGitHubMaterialization = false;
  if (connection.provider === "local_git") {
    const sourcePath = resolveRepoKey(repository.remote_id, input.tenantId);
    source = await createLocalGitRepositorySource({
      repositoryPath: sourcePath,
      policy: { sparsePaths: input.sparsePaths },
    });
  } else if (connection.provider === "github") {
    if (!dependencies) throw new Error("github_credential_broker_required");
    let resolvedCredential;
    try {
      const descriptor = dependencies.credentialDescriptor?.({
        connection,
        tenantId: input.tenantId,
      }) ?? githubCredentialDescriptor(connection);
      resolvedCredential = await dependencies.credentialBroker.access(descriptor, {
        actorId: dependencies.actorId ?? "service:repository-snapshot",
        audience: `github:installation:${connection.external_account_id}`,
        purpose: "materialize_read_only_repository_snapshot",
        requestId: dependencies.requestId,
      });
    } catch (error) {
      recordGitHubHealthFailure(db, connection, input.tenantId, credentialErrorCode(error));
      throw new Error(credentialErrorCode(error));
    }
    const transport = dependencies.githubTransport;
    liveGitHubMaterialization = transport === undefined || transport.provenance === "live";
    source = await createGitHubRepositorySource({
      installationId: connection.external_account_id,
      repositoryId: repository.remote_id,
      owner: repository.owner,
      name: repository.name,
      credential: resolvedCredential.secret,
      transport,
      policy: { sparsePaths: input.sparsePaths },
    });
  } else {
    throw new Error("repository_source_not_implemented");
  }

  let probe;
  let resolved;
  try {
    probe = await source.probe();
    resolved = await source.resolveRef(repository.selected_branch);
  } catch (error) {
    if (connection.provider === "github") {
      recordGitHubHealthFailure(db, connection, input.tenantId, sourceErrorCode(error));
    }
    throw error;
  }
  const snapshotId = newId();
  const destination = repositorySnapshotDestination(snapshotId, input.tenantId);
  await mkdir(dirname(destination), { recursive: true });
  let snapshot;
  try {
    snapshot = await source.materialize(resolved, destination);
  } catch (error) {
    if (connection.provider === "github") {
      recordGitHubHealthFailure(db, connection, input.tenantId, sourceErrorCode(error));
    }
    throw error;
  }
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
        sparsePaths: [...snapshot.sparsePaths],
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
        authenticated: connection.provider !== "github" || liveGitHubMaterialization,
        readAccess: connection.provider !== "github" || liveGitHubMaterialization,
        writeAccess: false,
        webhookOk: false,
        ciVisible: discovery.ci.length > 0,
        lastSyncAt: connection.provider !== "github" || liveGitHubMaterialization ? createdAt : null,
        revoked: false,
        errorCode:
          connection.provider === "github" && !liveGitHubMaterialization
            ? "github_snapshot_unproven"
            : discovery.ci.length > 0
              ? null
              : "ci_configuration_not_discovered",
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

export async function purgeExpiredSnapshots(
  db: AppDb,
  input: { tenantId: string; actorPrincipalId: string; at?: string },
) {
  const at = input.at ?? nowIso();
  const expired = listExpiredRepositorySnapshots(db, input.tenantId, at);
  const results: Array<{ snapshotId: string; status: "deleted" | "failed"; errorCode: string | null }> = [];
  for (const snapshot of expired) {
    recordRepositorySnapshotDeletion(db, {
      id: newId(),
      tenantId: input.tenantId,
      snapshotId: snapshot.id,
      status: "planned",
      actorPrincipalId: input.actorPrincipalId,
      createdAt: at,
    });
    try {
      const target = assertRepositorySnapshotPath(
        snapshot.storage_path,
        snapshot.id,
        input.tenantId,
      );
      await makeTreeWritable(target);
      await rm(target, { recursive: true, force: true });
      recordRepositorySnapshotDeletion(db, {
        id: newId(),
        tenantId: input.tenantId,
        snapshotId: snapshot.id,
        status: "deleted",
        actorPrincipalId: input.actorPrincipalId,
        createdAt: at,
      });
      results.push({ snapshotId: snapshot.id, status: "deleted", errorCode: null });
    } catch (error) {
      const errorCode = retentionErrorCode(error);
      recordRepositorySnapshotDeletion(db, {
        id: newId(),
        tenantId: input.tenantId,
        snapshotId: snapshot.id,
        status: "failed",
        actorPrincipalId: input.actorPrincipalId,
        errorCode,
        createdAt: at,
      });
      results.push({ snapshotId: snapshot.id, status: "failed", errorCode });
    }
  }
  return {
    evaluated: expired.length,
    deleted: results.filter((item) => item.status === "deleted").length,
    failed: results.filter((item) => item.status === "failed").length,
    results,
  };
}

export function scmOverview(db: AppDb, tenantId: string) {
  const connectionRows = listScmConnections(db, tenantId);
  const connections = connectionRows.map((connection) =>
    publicConnection(db, connection, tenantId),
  );
  const githubSnapshotsProven = connectionRows.some((connection) => {
    if (connection.provider !== "github") return false;
    const health = getScmConnectionHealth(db, connection.id, tenantId);
    return Boolean(
      health?.authenticated &&
      health.read_access &&
      health.last_sync_at &&
      !health.revoked &&
      !connection.revoked_at,
    );
  });
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
    snapshots: listRepositorySnapshots(db, tenantId, repository.id).map((snapshot) => {
      const deletion = getRepositorySnapshotDeletionStatus(db, tenantId, snapshot.id);
      return {
        id: snapshot.id,
        requestedRef: snapshot.requested_ref,
        exactCommit: snapshot.resolved_sha,
        manifestSha256: snapshot.manifest_sha256,
        createdAt: snapshot.created_at,
        expiresAt: snapshot.expires_at,
        available: deletion?.status !== "deleted",
        retentionStatus: deletion?.status ?? "retained",
      };
    }),
  }));
  return {
    providers: [
      { provider: "local_git", connection: true, snapshots: true, pullRequests: false },
      { provider: "github", connection: true, snapshots: githubSnapshotsProven, pullRequests: false },
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

function githubCredentialDescriptor(connection: ScmConnection): CredentialDescriptor {
  const match = /^([a-z][a-z0-9_-]{0,31}):\/\/(.{1,512})$/i.exec(connection.credential_ref);
  if (!match) throw new Error("github_credential_reference_invalid");
  return {
    credentialId: connection.id,
    secret: { provider: match[1]!.toLowerCase(), id: match[2]! },
    audiences: [`github:installation:${connection.external_account_id}`],
    rotation: {
      generation: 1,
      issuedAt: connection.created_at,
    },
  };
}

function credentialErrorCode(error: unknown): string {
  if (error instanceof CredentialAccessError) return `github_credential_${error.code}`;
  const message = error instanceof Error ? error.message : "";
  return /^github_credential_[a-z0-9_]{1,60}$/.test(message)
    ? message
    : "github_credential_resolution_failed";
}

function sourceErrorCode(error: unknown): string {
  return error instanceof RepositorySourceError
    ? `github_snapshot_${error.code.toLowerCase()}`
    : "github_snapshot_failed";
}

function recordGitHubHealthFailure(
  db: AppDb,
  connection: ScmConnection,
  tenantId: string,
  errorCode: string,
): void {
  setScmConnectionHealth(db, {
    connectionId: connection.id,
    tenantId,
    configured: true,
    authenticated: false,
    readAccess: false,
    writeAccess: false,
    webhookOk: false,
    ciVisible: false,
    revoked: false,
    errorCode,
    checkedAt: nowIso(),
  });
}

async function removeSnapshot(root: string): Promise<void> {
  await makeTreeWritable(root);
  await rm(root, { recursive: true, force: true });
}

async function makeTreeWritable(root: string): Promise<void> {
  const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (stat.isDirectory()) {
    await chmod(root, 0o755);
    for (const entry of await readdir(root)) {
      await makeTreeWritable(join(root, entry));
    }
  } else if (!stat.isSymbolicLink()) {
    await chmod(root, 0o644);
  }
}

function retentionErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "snapshot_purge_failed";
  return /^[a-z0-9_]{1,80}$/.test(message) ? message : "snapshot_purge_failed";
}
