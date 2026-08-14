import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  insertConnectedRepository,
  insertRepositorySnapshot,
  recordRepositorySnapshotDeletion,
  upsertScmConnection,
  type AppDb,
  type ConsumerRepo,
} from "@mendpoint/db";
import {
  loadWardenSnapshotBinding,
  loadWardenSnapshotBindingFromAuthority,
} from "./warden-snapshot-loader.js";

const CREATED_AT = "2026-08-05T10:00:00.000Z";
const OBSERVED_AT = "2026-08-05T12:00:00.000Z";
const EXPIRES_AT = "2026-08-06T12:00:00.000Z";
const REVISION = "a".repeat(40);
const MANIFEST = "b".repeat(64);

const roots: string[] = [];
const databases: AppDb[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.raw.close();
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function setup(): { db: AppDb; reposRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-snapshot-"));
  const reposRoot = join(root, "repositories");
  mkdirSync(reposRoot, { recursive: true });
  const db = createDb(join(root, "worker.sqlite"));
  roots.push(root);
  databases.push(db);
  return { db, reposRoot };
}

function addRepository(
  db: AppDb,
  tenantId: string,
  repositoryId: string,
  status: "pending" | "ready" | "degraded" | "revoked" = "ready",
): void {
  const connectionId = `connection-${tenantId}`;
  upsertScmConnection(db, {
    id: connectionId,
    tenantId,
    provider: "local_git",
    credentialRef: `env://${tenantId.toUpperCase().replace(/-/g, "_")}_LOCAL_GIT`,
    externalAccountId: tenantId,
    displayName: tenantId,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  insertConnectedRepository(db, {
    id: repositoryId,
    tenantId,
    connectionId,
    remoteId: `${tenantId}/fixture`,
    owner: tenantId,
    name: "fixture",
    defaultBranch: "main",
    status,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
}

function addSnapshot(
  db: AppDb,
  input: Readonly<{
    id?: string;
    tenantId?: string;
    repositoryId?: string;
    revision?: string;
    manifest?: string;
    storagePath: string;
    expiresAt?: string;
    sparsePaths?: string[];
  }>,
): void {
  insertRepositorySnapshot(db, {
    id: input.id ?? "snapshot-a",
    tenantId: input.tenantId ?? "tenant-a",
    repositoryId: input.repositoryId ?? "repository-a",
    requestedRef: "main",
    resolvedSha: input.revision ?? REVISION,
    manifestSha256: input.manifest ?? MANIFEST,
    storagePath: input.storagePath,
    sparsePaths: input.sparsePaths,
    createdAt: CREATED_AT,
    expiresAt: input.expiresAt ?? EXPIRES_AT,
  });
}

function consumerRepo(
  localPath: string,
  overrides: Partial<ConsumerRepo> = {},
): ConsumerRepo {
  return {
    id: "consumer-repo-a",
    consumer_id: "consumer-a",
    local_path: localPath,
    default_branch: "main",
    scm_connection_id: "connection-tenant-a",
    connected_repository_id: "repository-a",
    snapshot_id: "snapshot-a",
    exact_commit: REVISION,
    created_at: CREATED_AT,
    ...overrides,
  };
}

function productionEnv(reposRoot: string): NodeJS.ProcessEnv {
  return { NODE_ENV: "production", MENDPOINT_REPOS_DIR: reposRoot };
}

function snapshotDirectory(reposRoot: string, tenantId = "tenant-a", name = "snapshot"): string {
  const root = join(reposRoot, tenantId, name);
  mkdirSync(root, { recursive: true });
  return root;
}

describe("Warden snapshot loader", () => {
  it("loads an explicit immutable repair snapshot without changing the consumer binding", () => {
    const { db, reposRoot } = setup();
    const oldRoot = snapshotDirectory(reposRoot, "tenant-a", "old");
    const repairRoot = snapshotDirectory(reposRoot, "tenant-a", "repair");
    addRepository(db, "tenant-a", "repository-a");
    addSnapshot(db, { storagePath: repairRoot });
    const repo = consumerRepo(oldRoot, { snapshot_id: "old-snapshot", exact_commit: "c".repeat(40) });

    const binding = loadWardenSnapshotBindingFromAuthority(
      db,
      "tenant-a",
      repo,
      { repositoryId: "repository-a", snapshotId: "snapshot-a", revision: REVISION, manifestSha256: MANIFEST },
      OBSERVED_AT,
      { env: productionEnv(reposRoot) },
    );

    expect(binding.root).toBe(repairRoot);
    expect(repo).toMatchObject({ local_path: oldRoot, snapshot_id: "old-snapshot", exact_commit: "c".repeat(40) });
  });

  it("rejects an explicit repair snapshot for a different connected repository", () => {
    const { db, reposRoot } = setup();
    const root = snapshotDirectory(reposRoot);
    addRepository(db, "tenant-a", "repository-a");
    addSnapshot(db, { storagePath: root });

    expect(() => loadWardenSnapshotBindingFromAuthority(
      db,
      "tenant-a",
      consumerRepo(root, { connected_repository_id: "repository-b" }),
      { repositoryId: "repository-a", snapshotId: "snapshot-a", revision: REVISION, manifestSha256: MANIFEST },
      OBSERVED_AT,
      { env: productionEnv(reposRoot) },
    )).toThrow("warden_snapshot_repository_mismatch");
  });

  it("returns a frozen exact binding for one active tenant snapshot", () => {
    const { db, reposRoot } = setup();
    const root = snapshotDirectory(reposRoot);
    addRepository(db, "tenant-a", "repository-a");
    addSnapshot(db, { storagePath: root });

    const binding = loadWardenSnapshotBinding(
      db,
      "tenant-a",
      consumerRepo(root),
      OBSERVED_AT,
      { env: productionEnv(reposRoot) },
    );

    expect(binding).toEqual({
      sourceKind: "immutable_snapshot",
      tenantId: "tenant-a",
      repositoryId: "repository-a",
      snapshotId: "snapshot-a",
      revision: REVISION,
      manifestSha256: MANIFEST,
      expiresAt: "2026-08-06T12:00:00.000Z",
      sparsePaths: [],
      root,
    });
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it("does not select a snapshot owned by another tenant", () => {
    const { db, reposRoot } = setup();
    const root = snapshotDirectory(reposRoot, "tenant-b");
    addRepository(db, "tenant-b", "repository-b");
    addSnapshot(db, {
      tenantId: "tenant-b",
      repositoryId: "repository-b",
      storagePath: root,
    });

    expect(() => loadWardenSnapshotBinding(
      db,
      "tenant-a",
      consumerRepo(root, {
        scm_connection_id: "connection-tenant-b",
        connected_repository_id: "repository-b",
      }),
      OBSERVED_AT,
      { env: productionEnv(reposRoot) },
    )).toThrow("warden_repository_not_active");
  });

  it("rejects an expired snapshot at the observation instant", () => {
    const { db, reposRoot } = setup();
    const root = snapshotDirectory(reposRoot);
    addRepository(db, "tenant-a", "repository-a");
    addSnapshot(db, { storagePath: root, expiresAt: OBSERVED_AT });

    expect(() => loadWardenSnapshotBinding(
      db,
      "tenant-a",
      consumerRepo(root),
      OBSERVED_AT,
      { env: productionEnv(reposRoot) },
    )).toThrow("warden_snapshot_expired");
  });

  it("rejects a snapshot whose latest deletion record is deleted", () => {
    const { db, reposRoot } = setup();
    const root = snapshotDirectory(reposRoot);
    addRepository(db, "tenant-a", "repository-a");
    addSnapshot(db, { storagePath: root });
    recordRepositorySnapshotDeletion(db, {
      id: "deletion-a",
      tenantId: "tenant-a",
      snapshotId: "snapshot-a",
      status: "deleted",
      actorPrincipalId: "operator-a",
      createdAt: "2026-08-05T11:00:00.000Z",
    });

    expect(() => loadWardenSnapshotBinding(
      db,
      "tenant-a",
      consumerRepo(root),
      OBSERVED_AT,
      { env: productionEnv(reposRoot) },
    )).toThrow("warden_snapshot_deleted");
  });

  it("keeps a completed deletion terminal even if a later cleanup attempt failed", () => {
    const { db, reposRoot } = setup();
    const root = snapshotDirectory(reposRoot);
    addRepository(db, "tenant-a", "repository-a");
    addSnapshot(db, { storagePath: root });
    recordRepositorySnapshotDeletion(db, {
      id: "deletion-complete",
      tenantId: "tenant-a",
      snapshotId: "snapshot-a",
      status: "deleted",
      actorPrincipalId: "operator-a",
      createdAt: "2026-08-05T11:00:00.000Z",
    });
    recordRepositorySnapshotDeletion(db, {
      id: "deletion-retry-failed",
      tenantId: "tenant-a",
      snapshotId: "snapshot-a",
      status: "failed",
      actorPrincipalId: "operator-a",
      errorCode: "already_removed",
      createdAt: "2026-08-05T11:30:00.000Z",
    });

    expect(() => loadWardenSnapshotBinding(
      db,
      "tenant-a",
      consumerRepo(root),
      OBSERVED_AT,
      { env: productionEnv(reposRoot) },
    )).toThrow("warden_snapshot_deleted");
  });

  it("rejects revision drift from the consumer binding", () => {
    const { db, reposRoot } = setup();
    const root = snapshotDirectory(reposRoot);
    addRepository(db, "tenant-a", "repository-a");
    addSnapshot(db, { storagePath: root });

    expect(() => loadWardenSnapshotBinding(
      db,
      "tenant-a",
      consumerRepo(root, { exact_commit: "c".repeat(40) }),
      OBSERVED_AT,
      { env: productionEnv(reposRoot) },
    )).toThrow("warden_snapshot_revision_mismatch");
  });

  it("rejects a symbolic link snapshot root", () => {
    const { db, reposRoot } = setup();
    const target = snapshotDirectory(reposRoot, "tenant-a", "target");
    const linked = join(reposRoot, "tenant-a", "linked");
    try {
      symlinkSync(target, linked, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return;
      }
      throw error;
    }
    addRepository(db, "tenant-a", "repository-a");
    addSnapshot(db, { storagePath: linked });

    expect(() => loadWardenSnapshotBinding(
      db,
      "tenant-a",
      consumerRepo(linked),
      OBSERVED_AT,
      { env: productionEnv(reposRoot) },
    )).toThrow("warden_snapshot_root_symlink_forbidden");
  });

  it("rejects local path drift from the stored snapshot path", () => {
    const { db, reposRoot } = setup();
    const stored = snapshotDirectory(reposRoot, "tenant-a", "stored");
    const local = snapshotDirectory(reposRoot, "tenant-a", "local");
    addRepository(db, "tenant-a", "repository-a");
    addSnapshot(db, { storagePath: stored });

    expect(() => loadWardenSnapshotBinding(
      db,
      "tenant-a",
      consumerRepo(local),
      OBSERVED_AT,
      { env: productionEnv(reposRoot) },
    )).toThrow("warden_snapshot_local_path_mismatch");
  });

  it("rejects a snapshot root outside the configured tenant repository root", () => {
    const { db, reposRoot } = setup();
    const outside = mkdtempSync(join(tmpdir(), "mendpoint-warden-outside-"));
    roots.push(outside);
    mkdirSync(join(reposRoot, "tenant-a"), { recursive: true });
    addRepository(db, "tenant-a", "repository-a");
    addSnapshot(db, { storagePath: outside });

    expect(() => loadWardenSnapshotBinding(
      db,
      "tenant-a",
      consumerRepo(outside),
      OBSERVED_AT,
      { env: productionEnv(reposRoot) },
    )).toThrow("warden_snapshot_path_escape");
  });

  it("rejects a structurally invalid stored manifest", () => {
    const { db, reposRoot } = setup();
    const root = snapshotDirectory(reposRoot);
    addRepository(db, "tenant-a", "repository-a");
    db.raw.prepare(
      `INSERT INTO repository_snapshots
       (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256,
        storage_path, submodules_policy, lfs_policy, sparse_paths_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "snapshot-a",
      "tenant-a",
      "repository-a",
      "main",
      REVISION,
      "invalid-manifest",
      root,
      "reject",
      "reject",
      "[]",
      CREATED_AT,
      EXPIRES_AT,
    );

    expect(() => loadWardenSnapshotBinding(
      db,
      "tenant-a",
      consumerRepo(root),
      OBSERVED_AT,
      { env: productionEnv(reposRoot) },
    )).toThrow("warden_snapshot_manifest_invalid");
  });

  it("rejects a sparse snapshot until promotion can reverify the full commit", () => {
    const { db, reposRoot } = setup();
    const root = snapshotDirectory(reposRoot);
    addRepository(db, "tenant-a", "repository-a");
    addSnapshot(db, { storagePath: root, sparsePaths: ["src/payments"] });

    expect(() => loadWardenSnapshotBinding(
      db,
      "tenant-a",
      consumerRepo(root),
      OBSERVED_AT,
      { env: productionEnv(reposRoot) },
    )).toThrow("warden_snapshot_sparse_unsupported");
  });

  it("allows explicit legacy local input only outside production", () => {
    const { db, reposRoot } = setup();
    const root = snapshotDirectory(reposRoot, "tenant-a", "legacy");
    const legacy = consumerRepo(root, {
      scm_connection_id: null,
      connected_repository_id: null,
      snapshot_id: null,
      exact_commit: null,
    });

    const binding = loadWardenSnapshotBinding(
      db,
      "tenant-a",
      legacy,
      OBSERVED_AT,
      { allowLegacyLocalSource: true, env: { NODE_ENV: "test" } },
    );
    expect(binding).toEqual({
      sourceKind: "legacy_local",
      tenantId: "tenant-a",
      repositoryId: null,
      snapshotId: null,
      revision: null,
      manifestSha256: null,
      sparsePaths: [],
      root,
    });
    expect(Object.isFrozen(binding)).toBe(true);

    expect(() => loadWardenSnapshotBinding(
      db,
      "tenant-a",
      legacy,
      OBSERVED_AT,
      { allowLegacyLocalSource: true, env: productionEnv(reposRoot) },
    )).toThrow("warden_snapshot_binding_required");
  });
});
