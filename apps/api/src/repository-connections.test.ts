import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  getConsumerRepo,
  getRepositorySnapshotPolicy,
  insertConsumer,
  insertConsumerRepo,
  listRepositorySnapshots,
  type AppDb,
} from "@mendpoint/db";
import {
  materializeConnectedRepository,
  purgeExpiredSnapshots,
  registerConnectedRepository,
  registerScmConnection,
  revokeConnection,
  scmOverview,
} from "./repository-connections.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const previousReposDir = process.env.MENDPOINT_REPOS_DIR;
const previousNodeEnv = process.env.NODE_ENV;

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-connection-"));
  roots.push(root);
  const repositoryPath = join(root, "customer-repo");
  mkdirSync(join(repositoryPath, ".github", "workflows"), { recursive: true });
  git(repositoryPath, "init", "-b", "main");
  git(repositoryPath, "config", "user.name", "Mendpoint Test");
  git(repositoryPath, "config", "user.email", "test@mendpoint.invalid");
  writeFileSync(join(repositoryPath, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  writeFileSync(join(repositoryPath, ".github", "CODEOWNERS"), "* @customer\n");
  writeFileSync(join(repositoryPath, ".github", "workflows", "ci.yml"), "jobs:\n  test:\n    steps:\n      - run: npm test\n");
  git(repositoryPath, "add", "--all");
  git(repositoryPath, "commit", "-m", "customer fixture");
  process.env.MENDPOINT_REPOS_DIR = root;
  process.env.NODE_ENV = "test";
  const db = createDb(join(root, "connections.sqlite"));
  dbs.push(db);
  return { root, repositoryPath, db, sha: git(repositoryPath, "rev-parse", "HEAD") };
}

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  process.env.MENDPOINT_REPOS_DIR = previousReposDir;
  process.env.NODE_ENV = previousNodeEnv;
  while (roots.length) {
    const root = roots.pop();
    if (root) {
      chmodSync(root, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("repository connection service", () => {
  it("materializes, discovers, persists, and binds an exact tenant snapshot", async () => {
    const { db, root, sha } = fixture();
    const connection = registerScmConnection(db, {
      tenantId: "tenant-a",
      provider: "local_git",
      externalAccountId: "local-customer",
      displayName: "Customer repository",
    });
    const repository = registerConnectedRepository(db, {
      tenantId: "tenant-a",
      connectionId: connection.id,
      remoteId: "customer-repo",
      owner: "customer",
      name: "service",
      defaultBranch: "main",
      retentionDays: 14,
    });
    insertConsumer(db, {
      id: "consumer-a",
      name: "Customer",
      githubOwner: "customer",
      githubRepo: "service",
      tenantId: "tenant-a",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    insertConsumerRepo(db, {
      id: "consumer-repo-a",
      consumerId: "consumer-a",
      localPath: join(root, "customer-repo"),
      defaultBranch: "main",
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    const result = await materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: repository.id,
      consumerRepoId: "consumer-repo-a",
    });

    expect(result.snapshot.exactCommit).toBe(sha);
    expect(JSON.stringify(result)).not.toContain(root);
    expect(result.constraints.codeowners[0]?.content).toBe("* @customer\n");
    expect(result.constraints.ci[0]?.provider).toBe("github_actions");
    expect(getConsumerRepo(db, "consumer-a", "tenant-a")).toMatchObject({
      snapshot_id: result.snapshot.id,
      exact_commit: sha,
    });
    expect(getRepositorySnapshotPolicy(db, "tenant-a", result.snapshot.id)).toBeDefined();
    const overview = scmOverview(db, "tenant-a");
    expect(JSON.stringify(overview)).not.toContain("local://filesystem");
    expect(overview.connections[0]?.health).toMatchObject({
      authenticated: true,
      readAccess: true,
      writeAccess: false,
      ciVisible: true,
    });
    expect(overview.repositories[0]?.snapshots[0]?.exactCommit).toBe(sha);
    expect(scmOverview(db, "tenant-b")).toMatchObject({ connections: [], repositories: [] });

    const storedPath = listRepositorySnapshots(db, "tenant-a", repository.id)[0]!.storage_path;
    expect(existsSync(storedPath)).toBe(true);
    await expect(
      purgeExpiredSnapshots(db, {
        tenantId: "tenant-b",
        actorPrincipalId: "service:retention",
        at: "2027-08-01T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ evaluated: 0, deleted: 0 });
    await expect(
      purgeExpiredSnapshots(db, {
        tenantId: "tenant-a",
        actorPrincipalId: "service:retention",
        at: "2027-08-01T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ evaluated: 1, deleted: 1, failed: 0 });
    expect(existsSync(storedPath)).toBe(false);
    expect(scmOverview(db, "tenant-a").repositories[0]?.snapshots[0]).toMatchObject({
      available: false,
      retentionStatus: "deleted",
    });
  });

  it("revokes a connection without exposing or reactivating its credential", () => {
    const { db } = fixture();
    const connection = registerScmConnection(db, {
      tenantId: "tenant-a",
      provider: "github",
      credentialRef: "vault://tenant-a/github/customer",
      externalAccountId: "customer",
      displayName: "Customer GitHub",
    });
    const revoked = revokeConnection(db, "tenant-a", connection.id);
    expect(revoked).toMatchObject({
      credentialConfigured: true,
      health: { revoked: true, authenticated: false },
    });
    expect(JSON.stringify(revoked)).not.toContain("vault://");
  });
});
