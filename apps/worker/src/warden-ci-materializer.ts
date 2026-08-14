import { mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  getConnectedRepository,
  getScmConnection,
  insertRepositorySnapshot,
  insertRepositorySnapshotFiles,
  insertRepositorySnapshotPolicy,
  type AppDb,
} from "@mendpoint/db";
import type { RepositorySource } from "@mendpoint/platform";
import { newId } from "@mendpoint/shared";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function requiredId(name: string, value: string): string {
  if (!ID.test(value)) throw new Error(`${name}_invalid`);
  return value;
}

function requiredRemoteRepositoryId(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("warden_ci_remote_repository_id_invalid");
  }
  return String(value);
}

function requiredTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error("warden_ci_materialized_at_invalid");
  }
  return value;
}

export type MaterializedWardenCiHead = Readonly<{
  repositoryId: string;
  snapshotId: string;
  revision: string;
  manifestSha256: string;
  root: string;
}>;

/**
 * Materializes an exact immutable failed PR head without moving the consumer
 * repository's active snapshot pointer. The resulting authority is suitable
 * for a separately fenced Warden repair job only.
 */
export async function materializeWardenCiHead(input: Readonly<{
  db: AppDb;
  source: RepositorySource;
  tenantId: string;
  repositoryId: string;
  remoteRepositoryId: number;
  headSha: string;
  repositoriesRoot: string;
  nodeEnv?: string;
  now?: () => string;
}>): Promise<MaterializedWardenCiHead> {
  const tenantId = requiredId("warden_ci_tenant_id", input.tenantId);
  const repositoryId = requiredId("warden_ci_repository_id", input.repositoryId);
  const remoteRepositoryId = requiredRemoteRepositoryId(input.remoteRepositoryId);
  const headSha = input.headSha.toLowerCase();
  if (!SHA.test(headSha)) throw new Error("warden_ci_head_sha_invalid");
  if (!isAbsolute(input.repositoriesRoot)) throw new Error("warden_ci_repositories_root_invalid");

  const repository = getConnectedRepository(input.db, repositoryId, tenantId);
  const connection = repository
    ? getScmConnection(input.db, repository.connection_id, tenantId)
    : undefined;
  if (
    !repository ||
    !connection ||
    repository.status !== "ready" ||
    repository.remote_id !== remoteRepositoryId
  ) {
    throw new Error("warden_ci_repository_authority_mismatch");
  }
  const sourceRepositoryId = connection.provider === "github"
    ? `github:${remoteRepositoryId}`
    : remoteRepositoryId;

  const probe = await input.source.probe();
  if (
    probe.provider !== connection.provider ||
    probe.repositoryId !== sourceRepositoryId
  ) {
    throw new Error("warden_ci_repository_source_mismatch");
  }
  const resolved = await input.source.resolveRef(headSha);
  if (
    resolved.provider !== connection.provider ||
    resolved.repositoryId !== sourceRepositoryId ||
    resolved.requestedRef !== headSha ||
    resolved.sha !== headSha ||
    resolved.observedRef !== null
  ) {
    throw new Error("warden_ci_exact_head_resolution_mismatch");
  }

  const snapshotId = newId();
  const destination = input.nodeEnv === "production"
    ? resolve(input.repositoriesRoot, tenantId, ".mendpoint-snapshots", snapshotId)
    : resolve(input.repositoriesRoot, ".mendpoint-snapshots", tenantId, snapshotId);
  const root = resolve(input.repositoriesRoot);
  const relativeDestination = destination.slice(root.length + 1);
  if (!relativeDestination || relativeDestination.startsWith("..") || isAbsolute(relativeDestination)) {
    throw new Error("warden_ci_snapshot_destination_invalid");
  }
  await mkdir(resolve(destination, ".."), { recursive: true });

  let snapshot;
  try {
    snapshot = await input.source.materialize(resolved, destination);
    if (
      snapshot.provider !== connection.provider ||
      snapshot.repositoryId !== sourceRepositoryId ||
      snapshot.requestedRef !== headSha ||
      snapshot.sha !== headSha ||
      !/^[a-f0-9]{64}$/.test(snapshot.manifestSha256) ||
      snapshot.submodules.length !== 0 ||
      snapshot.lfsPointers.length !== 0
    ) {
      throw new Error("warden_ci_materialized_snapshot_invalid");
    }
    if (await realpath(snapshot.root) !== await realpath(destination)) {
      throw new Error("warden_ci_materialized_snapshot_path_mismatch");
    }
    const discovery = await input.source.discover(snapshot);
    const createdAt = requiredTime((input.now ?? (() => new Date().toISOString()))());
    const expiresAt = new Date(
      Date.parse(createdAt) + repository.retention_days * 24 * 60 * 60 * 1000,
    ).toISOString();

    input.db.raw.exec("BEGIN IMMEDIATE");
    try {
      const stored = insertRepositorySnapshot(input.db, {
        id: snapshotId,
        tenantId,
        repositoryId,
        requestedRef: headSha,
        resolvedSha: headSha,
        manifestSha256: snapshot.manifestSha256,
        storagePath: snapshot.root,
        submodulesPolicy: "reject",
        lfsPolicy: "reject",
        sparsePaths: [...snapshot.sparsePaths],
        fileManifestVersion: 1,
        createdAt,
        expiresAt,
      });
      insertRepositorySnapshotFiles(input.db, {
        tenantId,
        snapshotId,
        files: snapshot.files,
      });
      insertRepositorySnapshotPolicy(input.db, {
        id: newId(),
        tenantId,
        snapshotId,
        codeowners: discovery.codeowners,
        ciFiles: discovery.ci.map((item) => item.path),
        verificationCommands: discovery.verificationCommands.map((item) => item.command),
        protectedBranch: {
          defaultBranch: repository.default_branch,
          selectedBranch: repository.selected_branch,
          exactCommit: headSha,
        },
        createdAt,
      });
      input.db.raw.exec("COMMIT");
      return Object.freeze({
        repositoryId,
        snapshotId: stored.row.id,
        revision: stored.row.resolved_sha,
        manifestSha256: stored.row.manifest_sha256,
        root: stored.row.storage_path,
      });
    } catch (error) {
      if (input.db.raw.isTransaction) input.db.raw.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
