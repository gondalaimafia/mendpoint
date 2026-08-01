import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalRepoPath,
  repositorySnapshotDestination,
  resolveRepoKey,
} from "./repo-path.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-repos-"));
  roots.push(root);
  mkdirSync(join(root, "tenant-a", "repo-a"), { recursive: true });
  mkdirSync(join(root, "tenant-b", "repo-b"), { recursive: true });
  mkdirSync(join(root, "dev-repo"), { recursive: true });
  return root;
}

describe("consumer repository tenant boundary", () => {
  it("resolves production repositories below the authenticated tenant root", () => {
    const root = fixtureRoot();
    expect(
      resolveRepoKey("repo-a", "tenant-a", {
        NODE_ENV: "production",
        MENDPOINT_REPOS_DIR: root,
      }),
    ).toBe(canonicalRepoPath(join(root, "tenant-a", "repo-a"), "tenant-a", {
      NODE_ENV: "production",
      MENDPOINT_REPOS_DIR: root,
    }));
  });

  it("rejects cross-tenant traversal and the tenant root itself", () => {
    const root = fixtureRoot();
    const env = {
      NODE_ENV: "production",
      MENDPOINT_REPOS_DIR: root,
    };
    expect(() =>
      resolveRepoKey("../tenant-b/repo-b", "tenant-a", env),
    ).toThrow("repo_path_outside_tenant_root");
    expect(() => resolveRepoKey(".", "tenant-a", env)).toThrow(
      "repo_path_outside_tenant_root",
    );
    expect(() => resolveRepoKey("repo-a", "../tenant-b", env)).toThrow(
      "tenant_id_not_path_safe",
    );
  });

  it("preserves the flat fixture layout outside production without allowing root access", () => {
    const root = fixtureRoot();
    const env = {
      NODE_ENV: "test",
      MENDPOINT_REPOS_DIR: root,
    };
    expect(resolveRepoKey("dev-repo", "tenant-a", env)).toBe(
      canonicalRepoPath(join(root, "dev-repo"), "tenant-a", env),
    );
    expect(() => resolveRepoKey(".", "tenant-a", env)).toThrow(
      "repo_path_outside_tenant_root",
    );
  });

  it("allocates tenant isolated snapshot destinations", () => {
    const root = fixtureRoot();
    expect(
      repositorySnapshotDestination("snapshot-1", "tenant-a", {
        NODE_ENV: "production",
        MENDPOINT_REPOS_DIR: root,
      }),
    ).toBe(join(root, "tenant-a", ".mendpoint-snapshots", "snapshot-1"));
    expect(
      repositorySnapshotDestination("snapshot-1", "tenant-a", {
        NODE_ENV: "test",
        MENDPOINT_REPOS_DIR: root,
      }),
    ).toBe(join(root, ".mendpoint-snapshots", "tenant-a", "snapshot-1"));
    expect(() =>
      repositorySnapshotDestination("../escape", "tenant-a", {
        NODE_ENV: "test",
        MENDPOINT_REPOS_DIR: root,
      }),
    ).toThrow("snapshot_id_not_path_safe");
  });
});
