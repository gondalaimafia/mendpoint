import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  insertConnectedRepository,
  insertRepositorySnapshot,
  insertRepositorySnapshotFiles,
  upsertScmConnection,
  type AppDb,
} from "@mendpoint/db";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  recipeFilesDigest,
  recipeReference,
  type RecipeFiles,
  type TransformerAttemptLease,
} from "@mendpoint/transformer";
import { loadTransformerRecipeSnapshot } from "./transformer-snapshot-loader.js";

const CREATED_AT = "2026-08-05T10:00:00.000Z";
const OBSERVED_AT = "2026-08-05T12:00:00.000Z";
const EXPIRES_AT = "2026-08-06T12:00:00.000Z";
const REVISION = "a".repeat(40);
const MANIFEST = "b".repeat(64);
const PACKAGE_JSON = `${JSON.stringify({
  name: "transformer-snapshot-fixture",
  private: true,
  engines: { node: ">=18 <19" },
}, null, 2)}\n`;

const roots: string[] = [];
const databases: AppDb[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.raw.close();
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function setup(): { db: AppDb; root: string } {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-transformer-snapshot-"));
  const db = createDb(join(root, "worker.sqlite"));
  roots.push(root);
  databases.push(db);
  return { db, root };
}

function addRepository(db: AppDb, tenantId: string, repositoryId: string): void {
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
    status: "ready",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
}

function writeFiles(root: string, files: Readonly<Record<string, string | Buffer>>): void {
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function addSnapshot(
  db: AppDb,
  input: Readonly<{
    id: string;
    tenantId?: string;
    repositoryId?: string;
    revision?: string;
    manifest?: string;
    storagePath: string;
    createdAt?: string;
    expiresAt?: string;
    modes?: Readonly<Record<string, "100644" | "100755">>;
    persistFiles?: boolean;
  }>,
): void {
  insertRepositorySnapshot(db, {
    id: input.id,
    tenantId: input.tenantId ?? "tenant-a",
    repositoryId: input.repositoryId ?? "repository-a",
    requestedRef: "main",
    resolvedSha: input.revision ?? REVISION,
    manifestSha256: input.manifest ?? MANIFEST,
    storagePath: input.storagePath,
    createdAt: input.createdAt ?? CREATED_AT,
    expiresAt: input.expiresAt ?? EXPIRES_AT,
  });
  if (input.persistFiles === false) return;
  const files: Array<{
    path: string;
    mode: string;
    kind: "file" | "symlink";
    size: number;
    sha256: string;
  }> = [];
  for (const path of [".node-version", ".nvmrc", "Dockerfile", "package.json"]) {
    const target = join(input.storagePath, path);
    let stat;
    try {
      stat = lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      files.push({
        path,
        mode: "120000",
        kind: "symlink",
        size: stat.size,
        sha256: "0".repeat(64),
      });
      continue;
    }
    const content = readFileSync(target);
    files.push({
      path,
      mode: input.modes?.[path] ?? "100644",
      kind: "file",
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  if (files.length) {
    insertRepositorySnapshotFiles(db, {
      tenantId: input.tenantId ?? "tenant-a",
      snapshotId: input.id,
      files,
    });
  }
}

function lease(input: Readonly<{
  tenantId?: string;
  repositoryId?: string;
  revision?: string;
  snapshotId?: string;
  manifest?: string;
  digest: string;
}>): TransformerAttemptLease {
  return {
    type: "execute_recipe",
    tenantId: input.tenantId ?? "tenant-a",
    campaignId: "campaign-a",
    unitId: "unit-a",
    attemptNumber: 1,
    leaseGeneration: 1,
    leaseTokenDigest: `sha256:${"c".repeat(64)}`,
    leaseExpiresAt: EXPIRES_AT,
    startedAt: CREATED_AT,
    snapshot: {
      snapshotId: input.snapshotId ?? "snapshot-a",
      repositoryId: input.repositoryId ?? "repository-a",
      revision: input.revision ?? REVISION,
      manifestSha256: input.manifest ?? MANIFEST,
      digest: input.digest,
      evidenceRefs: ["snapshot:test"],
    },
    candidateRevision: "candidate-a",
    candidateDigest: `sha256:${"e".repeat(64)}`,
    changedPaths: ["package.json"],
    recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
    constraintVersion: 1,
    constraintDigest: `sha256:${"d".repeat(64)}`,
    gateEvidenceRefs: ["gate:test"],
    adaptiveBudgetRemaining: {
      attempts: 1,
      plannerCalls: 8,
      modelCalls: 8,
      inputTokens: 1_000_000,
      outputTokens: 250_000,
      totalTokens: 1_250_000,
      actualCostUsd: 50,
      wallTimeMs: 120_000,
    },
  };
}

describe("Transformer local repository snapshot loader", () => {
  it("does not load another tenant's repository snapshot", () => {
    const { db, root } = setup();
    const snapshotRoot = join(root, "tenant-b-snapshot");
    writeFiles(snapshotRoot, { "package.json": PACKAGE_JSON });
    addRepository(db, "tenant-b", "repository-a");
    addSnapshot(db, {
      id: "snapshot-b",
      tenantId: "tenant-b",
      storagePath: snapshotRoot,
    });

    expect(() => loadTransformerRecipeSnapshot(
      db,
      lease({ digest: recipeFilesDigest({ "package.json": PACKAGE_JSON }) }),
      OBSERVED_AT,
    )).toThrow("transformer_snapshot_missing");
  });

  it("selects the exact revision instead of the latest repository snapshot", () => {
    const { db, root } = setup();
    addRepository(db, "tenant-a", "repository-a");
    const selectedRoot = join(root, "selected");
    const otherRoot = join(root, "other");
    const selected = PACKAGE_JSON.replace("snapshot-fixture", "selected-revision");
    writeFiles(selectedRoot, { "package.json": selected });
    writeFiles(otherRoot, { "package.json": PACKAGE_JSON });
    addSnapshot(db, {
      id: "snapshot-selected",
      revision: REVISION,
      storagePath: selectedRoot,
    });
    addSnapshot(db, {
      id: "snapshot-other",
      revision: "e".repeat(40),
      manifest: "f".repeat(64),
      storagePath: otherRoot,
      createdAt: "2026-08-05T11:00:00.000Z",
    });

    expect(loadTransformerRecipeSnapshot(
      db,
      lease({
        snapshotId: "snapshot-selected",
        digest: recipeFilesDigest({ "package.json": selected }),
      }),
      OBSERVED_AT,
    )).toEqual({
      repositoryId: "repository-a",
      revision: REVISION,
      digest: recipeFilesDigest({ "package.json": selected }),
      files: { "package.json": selected },
      fileModes: { "package.json": "100644" },
    });
  });

  it("rejects an expired exact snapshot", () => {
    const { db, root } = setup();
    addRepository(db, "tenant-a", "repository-a");
    const snapshotRoot = join(root, "expired");
    writeFiles(snapshotRoot, { "package.json": PACKAGE_JSON });
    addSnapshot(db, {
      id: "snapshot-expired",
      storagePath: snapshotRoot,
      expiresAt: OBSERVED_AT,
    });

    expect(() => loadTransformerRecipeSnapshot(
      db,
      lease({
        snapshotId: "snapshot-expired",
        digest: recipeFilesDigest({ "package.json": PACKAGE_JSON }),
      }),
      OBSERVED_AT,
    )).toThrow("transformer_snapshot_expired");
  });

  it("selects the leased snapshot identity when the same revision has multiple manifests", () => {
    const { db, root } = setup();
    addRepository(db, "tenant-a", "repository-a");
    const first = join(root, "first");
    const second = join(root, "second");
    writeFiles(first, { "package.json": PACKAGE_JSON });
    writeFiles(second, { "package.json": PACKAGE_JSON });
    addSnapshot(db, { id: "snapshot-first", storagePath: first });
    addSnapshot(db, {
      id: "snapshot-second",
      manifest: "e".repeat(64),
      storagePath: second,
    });

    expect(loadTransformerRecipeSnapshot(
      db,
      lease({
        snapshotId: "snapshot-first",
        manifest: MANIFEST,
        digest: recipeFilesDigest({ "package.json": PACKAGE_JSON }),
      }),
      OBSERVED_AT,
    )).toEqual({
      repositoryId: "repository-a",
      revision: REVISION,
      digest: recipeFilesDigest({ "package.json": PACKAGE_JSON }),
      files: { "package.json": PACKAGE_JSON },
      fileModes: { "package.json": "100644" },
    });
  });

  it("rejects a leased snapshot whose stored manifest does not match", () => {
    const { db, root } = setup();
    addRepository(db, "tenant-a", "repository-a");
    const snapshotRoot = join(root, "manifest-mismatch");
    writeFiles(snapshotRoot, { "package.json": PACKAGE_JSON });
    addSnapshot(db, { id: "snapshot-a", storagePath: snapshotRoot });

    expect(() => loadTransformerRecipeSnapshot(
      db,
      lease({
        snapshotId: "snapshot-a",
        manifest: "e".repeat(64),
        digest: recipeFilesDigest({ "package.json": PACKAGE_JSON }),
      }),
      OBSERVED_AT,
    )).toThrow("transformer_snapshot_manifest_mismatch");
  });

  it("requires the stored repository manifest digest to be structurally valid", () => {
    const { db, root } = setup();
    addRepository(db, "tenant-a", "repository-a");
    const snapshotRoot = join(root, "invalid-manifest");
    writeFiles(snapshotRoot, { "package.json": PACKAGE_JSON });
    db.raw.prepare(
      `INSERT INTO repository_snapshots
       (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256,
        storage_path, submodules_policy, lfs_policy, sparse_paths_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "snapshot-invalid-manifest",
      "tenant-a",
      "repository-a",
      "main",
      REVISION,
      "not-a-sha256",
      snapshotRoot,
      "reject",
      "reject",
      "[]",
      CREATED_AT,
      EXPIRES_AT,
    );

    expect(() => loadTransformerRecipeSnapshot(
      db,
      lease({
        snapshotId: "snapshot-invalid-manifest",
        digest: recipeFilesDigest({ "package.json": PACKAGE_JSON }),
      }),
      OBSERVED_AT,
    )).toThrow("transformer_snapshot_manifest_invalid");
  });

  it("fails closed for a legacy snapshot without authoritative file manifest rows", () => {
    const { db, root } = setup();
    addRepository(db, "tenant-a", "repository-a");
    const snapshotRoot = join(root, "legacy");
    writeFiles(snapshotRoot, { "package.json": PACKAGE_JSON });
    addSnapshot(db, { id: "snapshot-a", storagePath: snapshotRoot, persistFiles: false });

    expect(() => loadTransformerRecipeSnapshot(
      db,
      lease({ digest: recipeFilesDigest({ "package.json": PACKAGE_JSON }) }),
      OBSERVED_AT,
    )).toThrow("transformer_snapshot_file_manifest_missing");
  });

  it("requires package.json from the recipe input set", () => {
    const { db, root } = setup();
    addRepository(db, "tenant-a", "repository-a");
    const snapshotRoot = join(root, "missing-package");
    writeFiles(snapshotRoot, { ".nvmrc": "18\n" });
    addSnapshot(db, { id: "snapshot-a", storagePath: snapshotRoot });

    expect(() => loadTransformerRecipeSnapshot(
      db,
      lease({ digest: `sha256:${"0".repeat(64)}` }),
      OBSERVED_AT,
    )).toThrow("transformer_snapshot_required_input_missing:package.json");
  });

  it("rejects source drift against the lease allowed-file-set digest", () => {
    const { db, root } = setup();
    addRepository(db, "tenant-a", "repository-a");
    const snapshotRoot = join(root, "drifted");
    writeFiles(snapshotRoot, { "package.json": PACKAGE_JSON });
    addSnapshot(db, { id: "snapshot-a", storagePath: snapshotRoot });

    expect(() => loadTransformerRecipeSnapshot(
      db,
      lease({ digest: `sha256:${"0".repeat(64)}` }),
      OBSERVED_AT,
    )).toThrow("transformer_snapshot_source_drift");
  });

  it("rejects an allowed file symlink that escapes the real snapshot root", () => {
    const { db, root } = setup();
    addRepository(db, "tenant-a", "repository-a");
    const snapshotRoot = join(root, "symlink-snapshot");
    const external = join(root, "outside-package.json");
    mkdirSync(snapshotRoot, { recursive: true });
    writeFileSync(external, PACKAGE_JSON);
    try {
      symlinkSync(external, join(snapshotRoot, "package.json"), "file");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return;
      }
      throw error;
    }
    addSnapshot(db, { id: "snapshot-a", storagePath: snapshotRoot });

    expect(() => loadTransformerRecipeSnapshot(
      db,
      lease({ digest: recipeFilesDigest({ "package.json": PACKAGE_JSON }) }),
      OBSERVED_AT,
    )).toThrow("transformer_snapshot_file_kind_unsupported:package.json");
  });

  it("rejects file size and hash drift against the persisted manifest", () => {
    const { db, root } = setup();
    addRepository(db, "tenant-a", "repository-a");
    const sizeRoot = join(root, "size-drift");
    writeFiles(sizeRoot, { "package.json": PACKAGE_JSON });
    addSnapshot(db, { id: "snapshot-size", storagePath: sizeRoot });
    writeFileSync(join(sizeRoot, "package.json"), `${PACKAGE_JSON} `);
    expect(() => loadTransformerRecipeSnapshot(
      db,
      lease({
        snapshotId: "snapshot-size",
        digest: recipeFilesDigest({ "package.json": PACKAGE_JSON }),
      }),
      OBSERVED_AT,
    )).toThrow("transformer_snapshot_file_size_mismatch:package.json");

    const hashRoot = join(root, "hash-drift");
    writeFiles(hashRoot, { "package.json": PACKAGE_JSON });
    addSnapshot(db, { id: "snapshot-hash", manifest: "e".repeat(64), storagePath: hashRoot });
    const replacement = PACKAGE_JSON.replace("private\": true", "private\":false");
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(PACKAGE_JSON));
    writeFileSync(join(hashRoot, "package.json"), replacement);
    expect(() => loadTransformerRecipeSnapshot(
      db,
      lease({
        snapshotId: "snapshot-hash",
        manifest: "e".repeat(64),
        digest: recipeFilesDigest({ "package.json": replacement }),
      }),
      OBSERVED_AT,
    )).toThrow("transformer_snapshot_file_hash_mismatch:package.json");
  });

  it("returns the persisted executable mode for exact Transformer source files", () => {
    const { db, root } = setup();
    addRepository(db, "tenant-a", "repository-a");
    const snapshotRoot = join(root, "executable");
    writeFiles(snapshotRoot, { "package.json": PACKAGE_JSON });
    addSnapshot(db, {
      id: "snapshot-a",
      storagePath: snapshotRoot,
      modes: { "package.json": "100755" },
    });

    expect(loadTransformerRecipeSnapshot(
      db,
      lease({ digest: recipeFilesDigest({ "package.json": PACKAGE_JSON }) }),
      OBSERVED_AT,
    )).toMatchObject({ fileModes: { "package.json": "100755" } });
  });

  it("rejects an oversized allowed file before reading it", () => {
    const { db, root } = setup();
    addRepository(db, "tenant-a", "repository-a");
    const snapshotRoot = join(root, "oversized");
    writeFiles(snapshotRoot, { "package.json": "x".repeat(5 * 1024 * 1024 + 1) });
    addSnapshot(db, { id: "snapshot-a", storagePath: snapshotRoot });

    expect(() => loadTransformerRecipeSnapshot(
      db,
      lease({ digest: `sha256:${"0".repeat(64)}` }),
      OBSERVED_AT,
    )).toThrow("transformer_snapshot_file_too_large:package.json");
  });

  it("loads normalized optional recipe files without reading or mutating other files", () => {
    const { db, root } = setup();
    addRepository(db, "tenant-a", "repository-a");
    const snapshotRoot = join(root, "complete");
    const rawPackage = `\uFEFF${PACKAGE_JSON.replace(/\n/g, "\r\n")}`;
    const rawSecret = "do not read or change\r\n";
    writeFiles(snapshotRoot, {
      "package.json": rawPackage,
      ".nvmrc": "18\r\n",
      ".node-version": "18.20.4\r\n",
      Dockerfile: "FROM node:18-alpine\r\nWORKDIR /app\r\n",
      "not-allowed.txt": rawSecret,
    });
    addSnapshot(db, { id: "snapshot-a", storagePath: snapshotRoot });
    const expected: RecipeFiles = {
      ".node-version": "18.20.4\n",
      ".nvmrc": "18\n",
      Dockerfile: "FROM node:18-alpine\nWORKDIR /app\n",
      "package.json": PACKAGE_JSON,
    };

    expect(loadTransformerRecipeSnapshot(
      db,
      lease({ digest: recipeFilesDigest(expected) }),
      OBSERVED_AT,
    )).toEqual({
      repositoryId: "repository-a",
      revision: REVISION,
      digest: recipeFilesDigest(expected),
      files: expected,
      fileModes: {
        ".node-version": "100644",
        ".nvmrc": "100644",
        Dockerfile: "100644",
        "package.json": "100644",
      },
    });
    expect(readFileSync(join(snapshotRoot, "package.json"), "utf8")).toBe(rawPackage);
    expect(readFileSync(join(snapshotRoot, "not-allowed.txt"), "utf8")).toBe(rawSecret);
  });
});
