import {
  lstatSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  getConnectedRepository,
  listRepositorySnapshots,
  type AppDb,
  type ConsumerRepo,
} from "@mendpoint/db";

const SHA256 = /^[a-f0-9]{64}$/;
const EXACT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ACTIVE_REPOSITORY_STATES = new Set(["ready", "degraded"]);

export type ExactWardenSnapshotBinding = Readonly<{
  sourceKind: "immutable_snapshot";
  tenantId: string;
  repositoryId: string;
  snapshotId: string;
  revision: string;
  manifestSha256: string;
  expiresAt: string;
  sparsePaths: readonly string[];
  root: string;
}>;

export type LegacyWardenLocalBinding = Readonly<{
  sourceKind: "legacy_local";
  tenantId: string;
  repositoryId: null;
  snapshotId: null;
  revision: null;
  manifestSha256: null;
  sparsePaths: readonly string[];
  root: string;
}>;

export type WardenSourceBinding = ExactWardenSnapshotBinding | LegacyWardenLocalBinding;

export type WardenSnapshotLoaderOptions = Readonly<{
  allowLegacyLocalSource?: boolean;
  env?: NodeJS.ProcessEnv;
}>;

export type WardenSnapshotAuthority = Readonly<{
  repositoryId: string;
  snapshotId: string;
  revision: string;
  manifestSha256: string;
}>;

function observedInstant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("warden_snapshot_observed_at_invalid");
  return parsed;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

function stat(path: string, invalidCode: string): Stats {
  try {
    return lstatSync(path);
  } catch {
    throw new Error(invalidCode);
  }
}

function realDirectory(
  path: string,
  input: Readonly<{
    invalidCode: string;
    symlinkCode: string;
  }>,
): string {
  if (!path.trim() || !isAbsolute(path)) throw new Error(input.invalidCode);
  const pathStat = stat(path, input.invalidCode);
  if (pathStat.isSymbolicLink()) throw new Error(input.symlinkCode);
  if (!pathStat.isDirectory()) throw new Error(input.invalidCode);
  try {
    return realpathSync(resolve(path));
  } catch {
    throw new Error(input.invalidCode);
  }
}

function safeTenantId(value: string): string {
  if (
    value === "." ||
    value === ".." ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  ) {
    throw new Error("warden_tenant_id_path_invalid");
  }
  return value;
}

function snapshotSparsePaths(value: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("warden_snapshot_sparse_paths_invalid");
  }
  if (!Array.isArray(parsed)) throw new Error("warden_snapshot_sparse_paths_invalid");
  const paths = parsed.map((entry) => {
    if (
      typeof entry !== "string" ||
      !entry ||
      entry.includes("\0") ||
      entry.includes("\\") ||
      entry.startsWith("/") ||
      /^[A-Za-z]:/.test(entry) ||
      entry.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("warden_snapshot_sparse_paths_invalid");
    }
    return entry;
  });
  if (new Set(paths).size !== paths.length) {
    throw new Error("warden_snapshot_sparse_paths_invalid");
  }
  return Object.freeze([...paths].sort());
}

function enforceTenantBoundary(
  root: string,
  tenantId: string,
  env: NodeJS.ProcessEnv,
): void {
  const configured = env.MENDPOINT_REPOS_DIR?.trim();
  if (!configured) {
    if (env.NODE_ENV === "production") {
      throw new Error("warden_repositories_root_required");
    }
    return;
  }
  const repositoriesRoot = realDirectory(configured, {
    invalidCode: "warden_repositories_root_invalid",
    symlinkCode: "warden_repositories_root_symlink_forbidden",
  });
  const tenantRoot = realDirectory(join(repositoriesRoot, safeTenantId(tenantId)), {
    invalidCode: "warden_tenant_repository_root_invalid",
    symlinkCode: "warden_tenant_repository_root_symlink_forbidden",
  });
  if (!isWithin(tenantRoot, root)) throw new Error("warden_snapshot_path_escape");
}

function legacyBinding(
  tenantId: string,
  repo: ConsumerRepo,
  env: NodeJS.ProcessEnv,
): LegacyWardenLocalBinding {
  const root = realDirectory(repo.local_path, {
    invalidCode: "warden_legacy_root_invalid",
    symlinkCode: "warden_legacy_root_symlink_forbidden",
  });
  enforceTenantBoundary(root, tenantId, env);
  return Object.freeze({
    sourceKind: "legacy_local",
    tenantId,
    repositoryId: null,
    snapshotId: null,
    revision: null,
    manifestSha256: null,
    sparsePaths: Object.freeze([]),
    root,
  });
}

function exactBinding(
  db: AppDb,
  tenantId: string,
  repo: ConsumerRepo,
  authority: Readonly<Omit<WardenSnapshotAuthority, "manifestSha256"> & { manifestSha256?: string }>,
  observedAtMs: number,
  env: NodeJS.ProcessEnv,
  requireLocalPathMatch: boolean,
): ExactWardenSnapshotBinding {
  const { repositoryId, snapshotId, revision, manifestSha256 } = authority;
  if (!EXACT_COMMIT.test(revision)) throw new Error("warden_snapshot_revision_invalid");
  if (manifestSha256 !== undefined && !SHA256.test(manifestSha256)) throw new Error("warden_snapshot_manifest_invalid");
  if (repo.connected_repository_id !== repositoryId) throw new Error("warden_snapshot_repository_mismatch");

  const repository = getConnectedRepository(db, repositoryId, tenantId);
  if (!repository || !ACTIVE_REPOSITORY_STATES.has(repository.status)) {
    throw new Error("warden_repository_not_active");
  }
  const matchingIdentity = listRepositorySnapshots(db, tenantId, repositoryId)
    .filter((candidate) => candidate.id === snapshotId);
  if (!matchingIdentity.length) throw new Error("warden_snapshot_missing");
  if (matchingIdentity.length !== 1) throw new Error("warden_snapshot_ambiguous");
  const snapshot = matchingIdentity[0]!;
  if (snapshot.resolved_sha !== revision) throw new Error("warden_snapshot_revision_mismatch");
  if (!SHA256.test(snapshot.manifest_sha256) ||
      (manifestSha256 !== undefined && snapshot.manifest_sha256 !== manifestSha256)) {
    throw new Error("warden_snapshot_manifest_invalid");
  }
  if (snapshot.submodules_policy !== "reject") throw new Error("warden_snapshot_submodules_unsupported");
  const sparsePaths = snapshotSparsePaths(snapshot.sparse_paths_json);
  if (sparsePaths.length) throw new Error("warden_snapshot_sparse_unsupported");
  const expiresAtMs = Date.parse(snapshot.expires_at);
  if (!Number.isFinite(expiresAtMs)) throw new Error("warden_snapshot_expiry_invalid");
  if (expiresAtMs <= observedAtMs) throw new Error("warden_snapshot_expired");
  const deletion = db.raw.prepare(
    `SELECT 1 AS deleted FROM repository_snapshot_deletions
     WHERE tenant_id = ? AND snapshot_id = ? AND status = 'deleted'
     LIMIT 1`,
  ).get(tenantId, snapshotId) as { deleted: number } | undefined;
  if (deletion) throw new Error("warden_snapshot_deleted");
  const root = realDirectory(snapshot.storage_path, {
    invalidCode: "warden_snapshot_root_invalid",
    symlinkCode: "warden_snapshot_root_symlink_forbidden",
  });
  if (requireLocalPathMatch) {
    const localRoot = realDirectory(repo.local_path, {
      invalidCode: "warden_snapshot_local_path_invalid",
      symlinkCode: "warden_snapshot_local_path_symlink_forbidden",
    });
    if (localRoot !== root) throw new Error("warden_snapshot_local_path_mismatch");
  }
  enforceTenantBoundary(root, tenantId, env);
  return Object.freeze({
    sourceKind: "immutable_snapshot",
    tenantId,
    repositoryId,
    snapshotId,
    revision,
    manifestSha256: snapshot.manifest_sha256,
    expiresAt: snapshot.expires_at,
    sparsePaths,
    root,
  });
}

export function loadWardenSnapshotBindingFromAuthority(
  db: AppDb,
  tenantId: string,
  repo: ConsumerRepo,
  authority: WardenSnapshotAuthority,
  observedAt: string,
  options: WardenSnapshotLoaderOptions = {},
): ExactWardenSnapshotBinding {
  return exactBinding(db, tenantId, repo, Object.freeze({ ...authority }), observedInstant(observedAt),
    options.env ?? process.env, false);
}

export function loadWardenSnapshotBinding(
  db: AppDb,
  tenantId: string,
  repo: ConsumerRepo,
  observedAt: string,
  options: WardenSnapshotLoaderOptions = {},
): WardenSourceBinding {
  const observedAtMs = observedInstant(observedAt);
  const env = options.env ?? process.env;
  const identifiers = [
    repo.connected_repository_id,
    repo.snapshot_id,
    repo.exact_commit,
  ];
  const present = identifiers.filter((value) => Boolean(value?.trim())).length;

  if (present !== identifiers.length) {
    if (present !== 0) throw new Error("warden_snapshot_binding_incomplete");
    if (env.NODE_ENV === "production" || !options.allowLegacyLocalSource) {
      throw new Error("warden_snapshot_binding_required");
    }
    return legacyBinding(tenantId, repo, env);
  }

  return exactBinding(db, tenantId, repo, {
    repositoryId: repo.connected_repository_id!,
    snapshotId: repo.snapshot_id!,
    revision: repo.exact_commit!,
  }, observedAtMs, env, true);
}
