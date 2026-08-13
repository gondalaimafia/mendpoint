import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  insertConnectedRepository,
  insertRepositorySnapshot,
  upsertGitHubInstallation,
  upsertScmConnection,
  type AppDb,
} from "@mendpoint/db";
import { createTransformerDraftRepositoryAuthority } from "./transformer-draft-repository.js";

const opened: Array<{ db: AppDb; root: string }> = [];
const now = "2026-08-13T18:00:00.000Z";

afterEach(() => {
  while (opened.length) {
    const item = opened.pop()!;
    item.db.raw.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

function fixture(authorizedRepositoryId = 200) {
  const root = mkdtempSync(join(tmpdir(), "transformer-draft-repository-"));
  const db = createDb(join(root, "api.sqlite"));
  opened.push({ db, root });
  db.raw.prepare(
    "INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at) VALUES (?, ?, ?, 'enterprise', 'active', 20, ?)",
  ).run("tenant-a", "tenant-a", "Tenant A", now);
  upsertScmConnection(db, {
    id: "connection-a",
    tenantId: "tenant-a",
    provider: "github",
    credentialRef: "github-app://installation/100",
    externalAccountId: "100",
    displayName: "Acme GitHub",
    createdAt: now,
    updatedAt: now,
  });
  insertConnectedRepository(db, {
    id: "repo-a",
    tenantId: "tenant-a",
    connectionId: "connection-a",
    remoteId: "200",
    owner: "acme",
    name: "service",
    defaultBranch: "main",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  });
  insertRepositorySnapshot(db, {
    id: "snapshot-a",
    tenantId: "tenant-a",
    repositoryId: "repo-a",
    requestedRef: "main",
    resolvedSha: "a".repeat(40),
    manifestSha256: "b".repeat(64),
    storagePath: root,
    fileManifestVersion: 1,
    createdAt: now,
    expiresAt: "2026-08-14T18:00:00.000Z",
  });
  upsertGitHubInstallation(db, {
    id: "installation-a",
    installationId: "100",
    accountId: "300",
    accountLogin: "acme",
    tenantId: "tenant-a",
    permissions: { metadata: "read", contents: "write", pull_requests: "write", checks: "read" },
    repositories: [{ id: authorizedRepositoryId, owner: "acme", name: "service" }],
    repositorySelection: "selected",
    createdAt: now,
    updatedAt: now,
  });
  return db;
}

describe("Transformer draft repository authority", () => {
  it("returns only the exact tenant-bound installation, repository, and snapshot", () => {
    const authority = createTransformerDraftRepositoryAuthority(fixture(), {
      GITHUB_APP_ACCOUNT_TENANT_BINDINGS: JSON.stringify({ "300": "tenant-a" }),
    });
    expect(authority({
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      snapshotId: "snapshot-a",
      expectedBaseRevision: "a".repeat(40),
    })).toEqual({
      owner: "acme",
      repo: "service",
      baseBranch: "main",
      installationId: 100,
      remoteRepositoryId: 200,
    });
  });

  it("rejects account binding, repository scope, and snapshot drift", () => {
    const db = fixture();
    const wrongAccount = createTransformerDraftRepositoryAuthority(db, {
      GITHUB_APP_ACCOUNT_TENANT_BINDINGS: JSON.stringify({ "301": "tenant-a" }),
    });
    const input = {
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      snapshotId: "snapshot-a",
      expectedBaseRevision: "a".repeat(40),
    };
    expect(() => wrongAccount(input)).toThrow("transformer_draft_installation_not_authorized");
    const authority = createTransformerDraftRepositoryAuthority(db, {
      GITHUB_APP_ACCOUNT_TENANT_BINDINGS: JSON.stringify({ "300": "tenant-a" }),
    });
    expect(() => authority({ ...input, expectedBaseRevision: "c".repeat(40) }))
      .toThrow("transformer_draft_snapshot_binding_mismatch");
    const wrongRepository = createTransformerDraftRepositoryAuthority(fixture(201), {
      GITHUB_APP_ACCOUNT_TENANT_BINDINGS: JSON.stringify({ "300": "tenant-a" }),
    });
    expect(() => wrongRepository(input)).toThrow("transformer_draft_installation_not_authorized");
  });
});
