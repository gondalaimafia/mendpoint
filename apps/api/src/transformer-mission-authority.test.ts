import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  insertConnectedRepository,
  insertPrincipal,
  insertRepositorySnapshot,
  insertRepositorySnapshotFiles,
  insertRepositorySnapshotPolicy,
  putTenantMembership,
  upsertScmConnection,
  type AppDb,
} from "@mendpoint/db";
import { createAppDbTransformerMissionAuthority } from "./transformer-mission-authority.js";

const NOW = "2026-08-13T16:00:00.000Z";
const opened: Array<{ db: AppDb; root: string }> = [];
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-transformer-mission-authority-"));
  const snapshotRoot = join(root, "snapshot");
  mkdirSync(snapshotRoot);
  const files = {
    "package.json": '{"name":"service","engines":{"node":"18.x"}}\n',
    Dockerfile: "FROM node:18-alpine\n",
  };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(snapshotRoot, path), content);
  const db = createDb(join(root, "api.sqlite"));
  opened.push({ db, root });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES (?, ?, ?, 'enterprise', 'active', 20, ?)`,
  ).run("tenant-a", "tenant-a", "Tenant A", NOW);
  const connection = upsertScmConnection(db, {
    id: "connection-a",
    tenantId: "tenant-a",
    provider: "github",
    credentialRef: "github-app://installation/100",
    externalAccountId: "100",
    displayName: "Acme",
    createdAt: NOW,
    updatedAt: NOW,
  });
  insertConnectedRepository(db, {
    id: "repo-a",
    tenantId: "tenant-a",
    connectionId: connection.id,
    remoteId: "200",
    owner: "acme",
    name: "service",
    defaultBranch: "main",
    status: "ready",
    createdAt: NOW,
    updatedAt: NOW,
  });
  insertRepositorySnapshot(db, {
    id: "snapshot-a",
    tenantId: "tenant-a",
    repositoryId: "repo-a",
    requestedRef: "main",
    resolvedSha: "a".repeat(40),
    manifestSha256: "b".repeat(64),
    storagePath: snapshotRoot,
    fileManifestVersion: 1,
    createdAt: NOW,
    expiresAt: "2026-08-14T16:00:00.000Z",
  });
  insertRepositorySnapshotFiles(db, {
    tenantId: "tenant-a",
    snapshotId: "snapshot-a",
    files: Object.entries(files).map(([path, content]) => ({
      path,
      mode: "100644" as const,
      kind: "file" as const,
      size: Buffer.byteLength(content),
      sha256: sha256(content),
    })),
  });
  insertRepositorySnapshotPolicy(db, {
    id: "policy-a",
    tenantId: "tenant-a",
    snapshotId: "snapshot-a",
    codeowners: [{ path: ".github/CODEOWNERS", content: "* @platform\n" }],
    ciFiles: [".github/workflows/ci.yml"],
    verificationCommands: ["npm test"],
    protectedBranch: { defaultBranch: "main", selectedBranch: "main", exactCommit: "a".repeat(40) },
    createdAt: NOW,
  });
  putTenantMembership(db, {
    tenantId: "tenant-a",
    issuer: "https://issuer.example",
    subject: "reviewer-a",
    email: "reviewer@example.com",
    displayName: "Reviewer A",
    role: "engineer",
    status: "active",
    updatedAt: NOW,
  });
  insertPrincipal(db, {
    id: "principal-reviewer-a",
    tenantId: "tenant-a",
    kind: "human",
    subject: "https://issuer.example|reviewer-a",
    displayName: "Reviewer A",
    createdAt: NOW,
  });
  return { db, root, snapshotRoot, files };
}

afterEach(() => {
  while (opened.length) {
    const value = opened.pop()!;
    value.db.raw.close();
    rmSync(value.root, { recursive: true, force: true });
  }
});

describe("production Transformer mission authority", () => {
  it("binds exact snapshot bytes, CODEOWNERS, reviewers, and constraints", () => {
    const value = fixture();
    const authority = createAppDbTransformerMissionAuthority(value.db);
    const repository = authority.repositories.load("tenant-a", "repo-a", NOW);
    expect(repository.planning).toMatchObject({
      id: "repo-a",
      organizationId: "tenant-a",
      revision: "a".repeat(40),
      files: value.files,
      fileEvidence: [
        expect.objectContaining({ path: "Dockerfile", ownerIds: ["github:platform"] }),
        expect.objectContaining({ path: "package.json", ownerIds: ["github:platform"] }),
      ],
    });
    expect(repository.execution.snapshot).toMatchObject({ snapshotId: "snapshot-a", repositoryId: "repo-a" });
    const executionSubset = authority.repositories.load(
      "tenant-a",
      "repo-a",
      NOW,
      ["package.json"],
    );
    expect(executionSubset.execution.files).toEqual({ "package.json": value.files["package.json"] });
    const organization = authority.organizations.load(
      "tenant-a",
      ["repo-a"],
      "api-key:planner-a",
      NOW,
    );
    expect(organization.organization).toMatchObject({
      id: "tenant-a",
      repositoryIds: ["repo-a"],
      humanReviewPolicy: {
        required: true,
        minimumApprovals: 1,
        reviewerIds: ["human:https://issuer.example|reviewer-a"],
        prohibitPlannerApproval: true,
      },
    });
    expect(organization.organization.digest).toBe(organization.constraints.digest);
    expect(organization.constraints.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ repositoryId: "repo-a", pathPattern: "Dockerfile", ownerIds: ["github:platform"] }),
      expect.objectContaining({ repositoryId: "repo-a", pathPattern: "package.json", ownerIds: ["github:platform"] }),
    ]));
  });

  it("fails closed before planning when snapshot bytes drift", () => {
    const value = fixture();
    writeFileSync(join(value.snapshotRoot, "package.json"), "tampered\n");
    const authority = createAppDbTransformerMissionAuthority(value.db);
    expect(() => authority.repositories.load("tenant-a", "repo-a", NOW))
      .toThrow("transformer_mission_snapshot_file_size_mismatch");
  });
});
