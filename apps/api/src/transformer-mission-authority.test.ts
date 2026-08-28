import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestManifestDependencies, openGraphLearnMemory } from "@mendpoint/graph-learn";
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
import { consultRegaugeGraphDependencies } from "./regauge-plan-consult.js";
import { createAppDbTransformerMissionAuthority } from "./transformer-mission-authority.js";
import {
  TRANSFORMER_WORKSPACE_AUTHORITY_PATH,
  TRANSFORMER_WORKSPACE_AUTHORITY_SCHEMA,
} from "./transformer-workspace-authority.js";

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

function addRepositorySnapshot(
  value: ReturnType<typeof fixture>,
  input: Readonly<{
    repositoryId: string;
    snapshotId: string;
    manifestPath: string;
    packageName: string;
    dependencies?: Readonly<Record<string, string>>;
    authorityText?: string;
  }>,
) {
  const content = `${JSON.stringify({
    name: input.packageName,
    dependencies: input.dependencies ?? {},
  })}\n`;
  const snapshotRoot = join(value.root, input.snapshotId);
  const absoluteManifest = join(snapshotRoot, ...input.manifestPath.split("/"));
  mkdirSync(dirname(absoluteManifest), { recursive: true });
  writeFileSync(absoluteManifest, content);
  if (input.authorityText !== undefined) {
    const absoluteAuthority = join(snapshotRoot, ...TRANSFORMER_WORKSPACE_AUTHORITY_PATH.split("/"));
    mkdirSync(dirname(absoluteAuthority), { recursive: true });
    writeFileSync(absoluteAuthority, input.authorityText);
  }
  insertConnectedRepository(value.db, {
    id: input.repositoryId,
    tenantId: "tenant-a",
    connectionId: "connection-a",
    remoteId: `remote-${input.repositoryId}`,
    owner: "acme",
    name: input.packageName,
    defaultBranch: "main",
    status: "ready",
    createdAt: NOW,
    updatedAt: NOW,
  });
  insertRepositorySnapshot(value.db, {
    id: input.snapshotId,
    tenantId: "tenant-a",
    repositoryId: input.repositoryId,
    requestedRef: "main",
    resolvedSha: sha256(input.repositoryId).slice(0, 40),
    manifestSha256: sha256(`${input.snapshotId}:manifest`),
    storagePath: snapshotRoot,
    fileManifestVersion: 1,
    createdAt: NOW,
    expiresAt: "2026-08-14T16:00:00.000Z",
  });
  insertRepositorySnapshotFiles(value.db, {
    tenantId: "tenant-a",
    snapshotId: input.snapshotId,
    files: [
      {
        path: input.manifestPath,
        mode: "100644",
        kind: "file",
        size: Buffer.byteLength(content),
        sha256: sha256(content),
      },
      ...(input.authorityText === undefined ? [] : [{
        path: TRANSFORMER_WORKSPACE_AUTHORITY_PATH,
        mode: "100644" as const,
        kind: "file" as const,
        size: Buffer.byteLength(input.authorityText),
        sha256: sha256(input.authorityText),
      }]),
    ],
  });
  insertRepositorySnapshotPolicy(value.db, {
    id: `policy-${input.repositoryId}`,
    tenantId: "tenant-a",
    snapshotId: input.snapshotId,
    codeowners: [{ path: ".github/CODEOWNERS", content: "* @platform\n" }],
    ciFiles: [".github/workflows/ci.yml"],
    verificationCommands: ["npm test"],
    protectedBranch: {
      defaultBranch: "main",
      selectedBranch: "main",
      exactCommit: sha256(input.repositoryId).slice(0, 40),
    },
    createdAt: NOW,
  });
  return Object.freeze({ content });
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
      workspacePath: "",
      workspaceAuthority: null,
      workspaceIdentityDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      evidenceRefs: expect.arrayContaining([
        expect.stringMatching(/^repository-snapshot:snapshot-a:workspace:sha256:[a-f0-9]{64}$/),
      ]),
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

  it("keeps separately cloned repositories unmapped without sealed shared-root authority", () => {
    const value = fixture();
    addRepositorySnapshot(value, {
      repositoryId: "repo-separated-shop",
      snapshotId: "snapshot-separated-shop",
      manifestPath: "packages/shop/package.json",
      packageName: "shop",
      dependencies: { billing: "file:../billing" },
    });
    addRepositorySnapshot(value, {
      repositoryId: "repo-separated-billing",
      snapshotId: "snapshot-separated-billing",
      manifestPath: "packages/billing/package.json",
      packageName: "billing",
    });
    const authority = createAppDbTransformerMissionAuthority(value.db);
    const repositoryIds = ["repo-separated-billing", "repo-separated-shop"];
    const planning = repositoryIds.map((repositoryId) =>
      authority.repositories.load("tenant-a", repositoryId, NOW).planning);
    expect(planning.every((repository) => repository.workspaceAuthority === null)).toBe(true);
    const graph = openGraphLearnMemory();
    try {
      for (const repository of planning) {
        ingestManifestDependencies(graph, {
          repoPath: "/unused",
          repoId: repository.id,
          tenantId: "tenant-a",
          observedAt: "2026-08-13T15:59:00.000Z",
          files: Object.entries(repository.files).map(([path, text]) => ({ path, text })),
        });
      }
      const result = consultRegaugeGraphDependencies({
        graph,
        tenantId: "tenant-a",
        evaluatedAt: NOW,
        repositoryIds,
        repositorySnapshots: planning,
      });
      expect(result.repositories.find((repository) =>
        repository.repositoryId === "repo-separated-shop"))
        .toMatchObject({ coverage: "unknown", reason: "dependency_target_unmapped" });
      expect(result.edges).toEqual([]);
    } finally {
      graph.raw.close();
    }
  });

  it("carries exact snapshot workspace authority into every local dependency protocol", () => {
    const value = fixture();
    const sources = [
      ["workspace", "workspace:*"] as const,
      ["file", "file:../billing"] as const,
      ["link", "link:../billing"] as const,
      ["portal", "portal:../billing"] as const,
      ["relative", "../billing"] as const,
    ];
    const definitions = [
      {
        repositoryId: "repo-billing", snapshotId: "snapshot-billing",
        manifestPath: "packages/billing/package.json", packageName: "billing",
        dependencies: {} as Readonly<Record<string, string>>,
      },
      ...sources.map(([name, specifier]) => ({
        repositoryId: `repo-${name}`,
        snapshotId: `snapshot-${name}`,
        manifestPath: `packages/shop-${name}/package.json`,
        packageName: `shop-${name}`,
        dependencies: { billing: specifier },
      })),
      {
        repositoryId: "repo-unmapped", snapshotId: "snapshot-unmapped",
        manifestPath: "packages/shop-unmapped/package.json", packageName: "shop-unmapped",
        dependencies: { missing: "file:../missing" },
      },
    ];
    const authorityText = JSON.stringify({
      schemaVersion: TRANSFORMER_WORKSPACE_AUTHORITY_SCHEMA,
      tenantId: "tenant-a",
      authorityId: "workspace-acme-platform",
      members: definitions.map((definition) => {
        const content = `${JSON.stringify({
          name: definition.packageName,
          dependencies: definition.dependencies,
        })}\n`;
        return {
          repositoryId: definition.repositoryId,
          revision: sha256(definition.repositoryId).slice(0, 40),
          workspacePath: definition.manifestPath.split("/").slice(0, -1).join("/"),
          manifestPath: definition.manifestPath,
          manifestContentDigest: `sha256:${sha256(content)}`,
        };
      }).sort((left, right) => left.repositoryId.localeCompare(right.repositoryId)),
    });
    for (const definition of definitions) addRepositorySnapshot(value, { ...definition, authorityText });

    const repositoryIds = [
      "repo-billing",
      ...sources.map(([name]) => `repo-${name}`),
      "repo-unmapped",
    ].sort();
    const authority = createAppDbTransformerMissionAuthority(value.db);
    const planning = repositoryIds.map((repositoryId) =>
      authority.repositories.load("tenant-a", repositoryId, NOW).planning);
    const restarted = createAppDbTransformerMissionAuthority(value.db);
    const restartedPlanning = repositoryIds.map((repositoryId) =>
      restarted.repositories.load("tenant-a", repositoryId, NOW).planning);
    expect(restartedPlanning).toEqual(planning);
    expect(() => authority.repositories.load("tenant-b", "repo-billing", NOW))
      .toThrow("transformer_mission_repository_not_found");

    const graph = openGraphLearnMemory();
    try {
      for (const repository of planning) {
        ingestManifestDependencies(graph, {
          repoPath: "/unused",
          repoId: repository.id,
          tenantId: "tenant-a",
          observedAt: "2026-08-13T15:59:00.000Z",
          files: Object.entries(repository.files).map(([path, text]) => ({ path, text })),
        });
      }
      const repositorySnapshots = planning;
      const result = consultRegaugeGraphDependencies({
        graph,
        tenantId: "tenant-a",
        evaluatedAt: NOW,
        repositoryIds,
        repositorySnapshots,
      });
      expect(consultRegaugeGraphDependencies({
        graph,
        tenantId: "tenant-a",
        evaluatedAt: NOW,
        repositoryIds,
        repositorySnapshots: restartedPlanning,
      })).toEqual(result);
      for (const [name] of sources) {
        expect(result.repositories.find((repository) => repository.repositoryId === `repo-${name}`))
          .toMatchObject({
            coverage: "complete",
            reason: "manifest_ingest_complete",
            dependsOnRepositoryIds: ["repo-billing"],
          });
      }
      expect(result.repositories.find((repository) => repository.repositoryId === "repo-unmapped"))
        .toMatchObject({ coverage: "unknown", reason: "dependency_target_unmapped" });
      expect(result.edges).toHaveLength(sources.length);
      expect(result.edges.every((edge) => edge.evidenceRefs.some((ref) =>
        ref.startsWith("manifest-resolution:sha256:")))).toBe(true);

      const billing = repositorySnapshots.find((repository) => repository.id === "repo-billing")!;
      const tampered = consultRegaugeGraphDependencies({
        graph,
        tenantId: "tenant-a",
        evaluatedAt: NOW,
        repositoryIds: ["repo-billing"],
        repositorySnapshots: [{ ...billing, workspaceIdentityDigest: `sha256:${"0".repeat(64)}` }],
      });
      expect(tampered.repositories[0]).toMatchObject({
        coverage: "unknown",
        reason: "workspace_snapshot_identity_invalid",
      });
    } finally {
      graph.raw.close();
    }
  });
});
