import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindConsumerRepoSnapshot,
  createDb,
  getConnectedRepository,
  getConsumerRepo,
  getLatestRepositorySnapshot,
  getScmConnectionHealth,
  insertConnectedRepository,
  insertConsumer,
  insertConsumerRepo,
  insertRepositorySnapshot,
  insertRepositorySnapshotPolicy,
  listConnectedRepositories,
  listRepositorySnapshots,
  listScmConnections,
  revokeScmConnection,
  setScmConnectionHealth,
  upsertScmConnection,
} from "./index.js";

const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];
const at = "2026-08-01T12:00:00.000Z";

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close?.();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-repository-"));
  dirs.push(dir);
  const db = createDb(join(dir, "repository.sqlite"));
  dbs.push(db);
  return { db, dir };
}

describe("repository connections", () => {
  it("persists secret references but rejects raw credentials", () => {
    const { db } = setup();
    expect(() =>
      upsertScmConnection(db, {
        id: "connection-raw",
        tenantId: "tenant-a",
        provider: "github",
        credentialRef: "ghp_secret",
        externalAccountId: "acme",
        displayName: "Acme",
        createdAt: at,
        updatedAt: at,
      }),
    ).toThrow("credential_reference_required");
    const connection = upsertScmConnection(db, {
      id: "connection-a",
      tenantId: "tenant-a",
      provider: "github",
      credentialRef: "vault://tenant-a/github/acme",
      externalAccountId: "acme",
      displayName: "Acme GitHub",
      createdAt: at,
      updatedAt: at,
    });
    expect(connection.credential_ref).toBe("vault://tenant-a/github/acme");
    expect(listScmConnections(db, "tenant-a")).toHaveLength(1);
    expect(listScmConnections(db, "tenant-b")).toEqual([]);
    expect(JSON.stringify(listScmConnections(db, "tenant-a"))).not.toContain("ghp_");

    revokeScmConnection(db, {
      id: "connection-a",
      tenantId: "tenant-a",
      revokedAt: "2026-08-01T13:00:00.000Z",
    });
    expect(() =>
      upsertScmConnection(db, {
        id: "connection-a",
        tenantId: "tenant-a",
        provider: "github",
        credentialRef: "vault://tenant-a/github/replacement",
        externalAccountId: "acme",
        displayName: "Acme GitHub",
        createdAt: at,
        updatedAt: "2026-08-01T14:00:00.000Z",
      }),
    ).toThrow("scm_connection_revocation_immutable");
  });

  it("keeps repositories, snapshots, policies, and health tenant scoped", () => {
    const { db, dir } = setup();
    upsertScmConnection(db, {
      id: "connection-a",
      tenantId: "tenant-a",
      provider: "local_git",
      credentialRef: "env://LOCAL_GIT_TEST",
      externalAccountId: "local-a",
      displayName: "Local A",
      createdAt: at,
      updatedAt: at,
    });
    insertConnectedRepository(db, {
      id: "repository-a",
      tenantId: "tenant-a",
      connectionId: "connection-a",
      remoteId: "owner/repo",
      owner: "owner",
      name: "repo",
      defaultBranch: "main",
      selectedBranch: "release",
      status: "ready",
      createdAt: at,
      updatedAt: at,
    });
    expect(getConnectedRepository(db, "repository-a", "tenant-b")).toBeUndefined();
    expect(listConnectedRepositories(db, "tenant-a")).toHaveLength(1);
    expect(() =>
      insertConnectedRepository(db, {
        id: "repository-cross",
        tenantId: "tenant-b",
        connectionId: "connection-a",
        remoteId: "owner/repo",
        owner: "owner",
        name: "repo",
        defaultBranch: "main",
        createdAt: at,
        updatedAt: at,
      }),
    ).toThrow("scm_connection_tenant_mismatch");

    const storagePath = join(dir, "snapshot");
    insertRepositorySnapshot(db, {
      id: "snapshot-a",
      tenantId: "tenant-a",
      repositoryId: "repository-a",
      requestedRef: "release",
      resolvedSha: "a".repeat(40),
      manifestSha256: "b".repeat(64),
      storagePath,
      createdAt: at,
      expiresAt: "2026-09-01T12:00:00.000Z",
    });
    expect(listRepositorySnapshots(db, "tenant-a", "repository-a")).toHaveLength(1);
    expect(listRepositorySnapshots(db, "tenant-b", "repository-a")).toEqual([]);
    expect(getLatestRepositorySnapshot(db, "tenant-a", "repository-a")?.resolved_sha).toBe(
      "a".repeat(40),
    );
    insertRepositorySnapshotPolicy(db, {
      id: "policy-a",
      tenantId: "tenant-a",
      snapshotId: "snapshot-a",
      codeowners: [{ pattern: "*", owners: ["@owner"] }],
      ciFiles: [".github/workflows/ci.yml"],
      verificationCommands: ["npm test"],
      protectedBranch: { branch: "release" },
      createdAt: at,
    });
    expect(() =>
      db.raw
        .prepare("UPDATE repository_snapshots SET requested_ref = 'main' WHERE id = 'snapshot-a'")
        .run(),
    ).toThrow("repository_snapshots_append_only");

    setScmConnectionHealth(db, {
      connectionId: "connection-a",
      tenantId: "tenant-a",
      configured: true,
      authenticated: true,
      readAccess: true,
      writeAccess: false,
      webhookOk: false,
      ciVisible: true,
      revoked: false,
      errorCode: "write_permission_missing",
      checkedAt: at,
    });
    expect(getScmConnectionHealth(db, "connection-a", "tenant-a")).toMatchObject({
      configured: 1,
      authenticated: 1,
      read_access: 1,
      write_access: 0,
      webhook_ok: 0,
      ci_visible: 1,
      error_code: "write_permission_missing",
    });
    expect(getScmConnectionHealth(db, "connection-a", "tenant-b")).toBeUndefined();
    expect(() =>
      setScmConnectionHealth(db, {
        connectionId: "connection-a",
        tenantId: "tenant-a",
        configured: true,
        authenticated: true,
        readAccess: true,
        writeAccess: true,
        webhookOk: true,
        ciVisible: true,
        revoked: true,
        checkedAt: at,
      }),
    ).toThrow("scm_connection_health_revocation_mismatch");
  });

  it("binds a consumer only to an owned exact commit snapshot", () => {
    const { db, dir } = setup();
    upsertScmConnection(db, {
      id: "connection-a",
      tenantId: "tenant-a",
      provider: "local_git",
      credentialRef: "env://LOCAL_GIT_TEST",
      externalAccountId: "local-a",
      displayName: "Local A",
      createdAt: at,
      updatedAt: at,
    });
    insertConnectedRepository(db, {
      id: "repository-a",
      tenantId: "tenant-a",
      connectionId: "connection-a",
      remoteId: "owner/repo",
      owner: "owner",
      name: "repo",
      defaultBranch: "main",
      status: "ready",
      createdAt: at,
      updatedAt: at,
    });
    const storagePath = join(dir, "snapshot");
    insertRepositorySnapshot(db, {
      id: "snapshot-a",
      tenantId: "tenant-a",
      repositoryId: "repository-a",
      requestedRef: "main",
      resolvedSha: "c".repeat(40),
      manifestSha256: "d".repeat(64),
      storagePath,
      createdAt: at,
      expiresAt: "2026-09-01T12:00:00.000Z",
    });
    insertConsumer(db, {
      id: "consumer-a",
      name: "Consumer A",
      githubOwner: "owner",
      githubRepo: "repo",
      tenantId: "tenant-a",
      createdAt: at,
    });
    insertConsumerRepo(db, {
      id: "consumer-repo-a",
      consumerId: "consumer-a",
      localPath: join(dir, "mutable"),
      defaultBranch: "main",
      createdAt: at,
    });
    bindConsumerRepoSnapshot(db, {
      tenantId: "tenant-a",
      consumerRepoId: "consumer-repo-a",
      connectionId: "connection-a",
      connectedRepositoryId: "repository-a",
      snapshotId: "snapshot-a",
    });
    expect(getConsumerRepo(db, "consumer-a", "tenant-a")).toMatchObject({
      local_path: storagePath,
      snapshot_id: "snapshot-a",
      exact_commit: "c".repeat(40),
      scm_connection_id: "connection-a",
      connected_repository_id: "repository-a",
    });
    expect(() =>
      bindConsumerRepoSnapshot(db, {
        tenantId: "tenant-b",
        consumerRepoId: "consumer-repo-a",
        connectionId: "connection-a",
        connectedRepositoryId: "repository-a",
        snapshotId: "snapshot-a",
      }),
    ).toThrow("consumer_repository_tenant_mismatch");
  });
});
