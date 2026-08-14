import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, getRepositorySnapshotPolicy, listRepositorySnapshots, type AppDb } from "@mendpoint/db";
import type { RepositorySource } from "@mendpoint/platform";
import { materializeWardenCiHead } from "./warden-ci-materializer.js";

const roots: string[] = [];
const databases: AppDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.raw.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Warden CI exact head materializer", () => {
  it("persists an immutable exact head and policy without mutating a consumer repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-ci-materialize-"));
    roots.push(root);
    const db = createDb(join(root, "db.sqlite"));
    databases.push(db);
    db.raw.prepare(`INSERT INTO scm_connections
      (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
      VALUES ('connection-a', 'tenant-a', 'github', 'app://202', '202', 'GitHub', ?, ?)`)
      .run("2026-08-13T12:00:00.000Z", "2026-08-13T12:00:00.000Z");
    db.raw.prepare(`INSERT INTO connected_repositories
      (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
       environment, retention_days, status, created_at, updated_at)
      VALUES ('repo-a', 'tenant-a', 'connection-a', '101', 'acme', 'service', 'main', 'main',
       'production', 30, 'ready', ?, ?)`)
      .run("2026-08-13T12:00:00.000Z", "2026-08-13T12:00:00.000Z");
    const head = "d".repeat(40);
    const source: RepositorySource = {
      provider: "github",
      probe: async () => ({ provider: "github", repositoryId: "github:101", defaultBranch: "main",
        headSha: head, dirty: false, hasSubmodules: false, hasLfsPointers: false }),
      resolveRef: async (ref) => ({ provider: "github", repositoryId: "github:101", requestedRef: ref,
        sha: head, observedRef: null }),
      materialize: async (resolved, destination) => {
        mkdirSync(destination, { recursive: true });
        return { provider: "github", repositoryId: "github:101", requestedRef: resolved.requestedRef,
          sha: head, root: destination, manifestSha256: "e".repeat(64),
          files: [{ path: "package.json", mode: "100644", kind: "file", size: 2,
            sha256: "f".repeat(64) }], submodules: [], lfsPointers: [], sparsePaths: [] };
      },
      discover: async () => ({ codeowners: [], ci: [{ provider: "github_actions", path: ".github/workflows/ci.yml" }],
        verificationCommands: [{ command: "npm test", source: "package.json", kind: "test" }] }),
    };

    const result = await materializeWardenCiHead({ db, source, tenantId: "tenant-a", repositoryId: "repo-a",
      remoteRepositoryId: 101, headSha: head, repositoriesRoot: join(root, "repositories"),
      now: () => "2026-08-13T12:01:00.000Z" });

    expect(result).toMatchObject({ repositoryId: "repo-a", revision: head,
      manifestSha256: "e".repeat(64) });
    expect(listRepositorySnapshots(db, "tenant-a", "repo-a")).toHaveLength(1);
    expect(getRepositorySnapshotPolicy(db, "tenant-a", result.snapshotId)?.verification_commands_json)
      .toContain("npm test");
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM consumer_repos").get()).toEqual({ count: 0 });
  });
});
