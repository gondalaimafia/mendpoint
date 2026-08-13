import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createDb,
  insertConnectedRepository,
  insertPrincipal,
  insertRepositorySnapshot,
  insertRepositorySnapshotFiles,
  listArtifactManifests,
  listDomainEvents,
  listEvidenceRecords,
  recordRepositorySnapshotDeletion,
  upsertScmConnection,
  type AppDb,
} from "@mendpoint/db";
import type { ApiEnv } from "./auth.js";
import { registerLegacyBehaviorRoutes } from "./legacy-behavior.js";

const CREATED_AT = "2026-08-12T12:00:00.000Z";
const EXPIRES_AT = "2026-08-13T12:00:00.000Z";
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(enabled: boolean) {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-legacy-api-"));
  roots.push(root);
  const db = createDb(join(root, "api.sqlite"));
  databases.push(db);
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?),
            ('tenant-b', 'tenant-b', 'Tenant B', 'team', 'active', 10, ?)`,
  ).run(CREATED_AT, CREATED_AT);
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    insertPrincipal(db, {
      id: `principal-${tenantId}`,
      tenantId,
      kind: "human",
      subject: `${tenantId}@example.com`,
      displayName: tenantId,
      createdAt: CREATED_AT,
    });
  }
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    const tenantId = c.req.header("X-Test-Tenant");
    if (tenantId === "tenant-a" || tenantId === "tenant-b") {
      c.set("principal", { id: `${tenantId}@example.com`, tenantId, role: (c.req.header("X-Test-Role") ?? "owner") as "owner" | "viewer" });
      c.set("trustPrincipalId", `principal-${tenantId}`);
      c.set("requestId", `request-${tenantId}`);
    }
    return next();
  });
  registerLegacyBehaviorRoutes(app, db, {
    enabled,
    now: () => "2026-08-12T13:00:00.000Z",
  });
  return { app, db, root };
}

function seedSnapshot(
  db: AppDb,
  root: string,
  input: Readonly<{
    tenantId?: string;
    repositoryId?: string;
    snapshotId?: string;
    files?: Readonly<Record<string, string>>;
  }> = {},
): void {
  const tenantId = input.tenantId ?? "tenant-a";
  const repositoryId = input.repositoryId ?? "repository-a";
  const snapshotId = input.snapshotId ?? "snapshot-a";
  const snapshotRoot = join(root, `${tenantId}-${snapshotId}`);
  const files = input.files ?? {
    "src/payment.ts": [
      "export function calculatePayment(amount: number): number {",
      "  return amount;",
      "}",
    ].join("\n"),
    "src/payment.test.ts": "test(\"preserves authorized total\", () => expect(calculatePayment(4)).toBe(4));\n",
    "schema/payment.graphql": "type Payment {\n  amount: Int!\n}\n",
  };
  upsertScmConnection(db, {
    id: `connection-${tenantId}`,
    tenantId,
    provider: "local_git",
    credentialRef: `env://${tenantId.toUpperCase().replaceAll("-", "_")}_LOCAL_GIT`,
    externalAccountId: tenantId,
    displayName: tenantId,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  insertConnectedRepository(db, {
    id: repositoryId,
    tenantId,
    connectionId: `connection-${tenantId}`,
    remoteId: `${tenantId}/legacy-app`,
    owner: tenantId,
    name: "legacy-app",
    defaultBranch: "main",
    status: "ready",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  const manifestRows: Array<{
    path: string;
    mode: "100644";
    kind: "file";
    size: number;
    sha256: string;
  }> = [];
  for (const [path, content] of Object.entries(files)) {
    const target = join(snapshotRoot, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    const bytes = readFileSync(target);
    manifestRows.push({ path, mode: "100644", kind: "file", size: bytes.length, sha256: sha256(bytes) });
  }
  insertRepositorySnapshot(db, {
    id: snapshotId,
    tenantId,
    repositoryId,
    requestedRef: "main",
    resolvedSha: REVISION,
    manifestSha256: MANIFEST,
    storagePath: snapshotRoot,
    fileManifestVersion: 1,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
  });
  insertRepositorySnapshotFiles(db, { tenantId, snapshotId, files: manifestRows });
}

const requestBody = {
  repositoryId: "repository-a",
  snapshotId: "snapshot-a",
  title: "Legacy payment behavior",
  targetSystem: "Mendpoint Transformer",
};

describe("legacy behavior API", () => {
  it("is authenticated and default off without persisting partial state", async () => {
    const { app, db, root } = fixture(false);
    seedSnapshot(db, root);

    const unauthorized = await app.request("/transformer/legacy-behavior/extractions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    expect(unauthorized.status).toBe(401);

    const disabled = await app.request("/transformer/legacy-behavior/extractions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Tenant": "tenant-a" },
      body: JSON.stringify(requestBody),
    });
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toEqual({ error: "legacy_behavior_extraction_disabled" });
    expect(listArtifactManifests(db, "tenant-a")).toEqual([]);
    expect(listDomainEvents(db, "tenant-a")).toEqual([]);
  });

  it("extracts observable code, test, and schema behavior from an immutable snapshot and persists a draft", async () => {
    const { app, db, root } = fixture(true);
    seedSnapshot(db, root);

    const response = await app.request("/transformer/legacy-behavior/extractions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Tenant": "tenant-a" },
      body: JSON.stringify(requestBody),
    });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    const created = await response.json() as any;
    expect(created).toMatchObject({
      status: "draft",
      snapshot: { id: "snapshot-a", repositoryId: "repository-a", revision: REVISION },
      automation: { mayWriteRepository: false, mayPublish: false },
    });
    expect(created.graph.nodeCount).toBeGreaterThanOrEqual(3);
    expect(created.documentation.excludedStatementCount).toBe(0);

    const artifacts = listArtifactManifests(db, "tenant-a");
    expect(artifacts.map((artifact) => artifact.kind).sort()).toEqual([
      "legacy-behavior-documentation-draft",
      "legacy-behavior-graph",
      "legacy-behavior-snapshot-evidence",
    ]);
    expect(artifacts.every((artifact) => artifact.producer_principal_id === "principal-tenant-a")).toBe(true);
    expect(listEvidenceRecords(db, "tenant-a", "repository_snapshot", "snapshot-a")).toHaveLength(1);
    expect(listEvidenceRecords(db, "tenant-a", "legacy_behavior_graph", created.graph.id)).toHaveLength(1);
    expect(listDomainEvents(db, "tenant-a", "legacy_behavior_extraction", created.id)).toHaveLength(1);

    const retrieval = await app.request(`/transformer/legacy-behavior/extractions/${created.id}`, {
      headers: { "X-Test-Tenant": "tenant-a" },
    });
    expect(retrieval.status).toBe(200);
    const found = await retrieval.json() as any;
    expect(found.status).toBe("draft");
    expect(found.documentation.markdown).toContain("Function calculatePayment");
    expect(found.documentation.markdown).toContain("Test preserves authorized total");
    expect(found.documentation.markdown).toContain("GraphQL type Payment");
    expect(found.documentation.markdown).toContain("snapshot\\://repository-a/snapshot-a/src/payment.ts:1");
    expect(found.graph.nodes.every((node: any) => node.provenance.every((item: any) => item.state === "active"))).toBe(true);
  });

  it("rejects read-only extraction without persisting authority records", async () => {
    const { app, db, root } = fixture(true);
    seedSnapshot(db, root);
    const response = await app.request("/transformer/legacy-behavior/extractions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Tenant": "tenant-a", "X-Test-Role": "viewer" },
      body: JSON.stringify(requestBody),
    });
    expect(response.status).toBe(403);
    expect(listArtifactManifests(db, "tenant-a")).toEqual([]);
    expect(listEvidenceRecords(db, "tenant-a", "repository_snapshot", "snapshot-a")).toEqual([]);
    expect(listDomainEvents(db, "tenant-a")).toEqual([]);
  });

  it("fails closed on snapshot content tampering without persisting artifacts", async () => {
    const { app, db, root } = fixture(true);
    seedSnapshot(db, root);
    writeFileSync(
      join(root, "tenant-a-snapshot-a", "src", "payment.ts"),
      [
        "export function calculatePaymenx(amount: number): number {",
        "  return amount;",
        "}",
      ].join("\n"),
    );

    const response = await app.request("/transformer/legacy-behavior/extractions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Tenant": "tenant-a" },
      body: JSON.stringify(requestBody),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "legacy_behavior_snapshot_file_hash_mismatch" });
    expect(listArtifactManifests(db, "tenant-a")).toEqual([]);
  });

  it("does not reveal or load another tenant's snapshot", async () => {
    const { app, db, root } = fixture(true);
    seedSnapshot(db, root);

    const response = await app.request("/transformer/legacy-behavior/extractions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Tenant": "tenant-b" },
      body: JSON.stringify(requestBody),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "repository_snapshot_not_found" });
    expect(listArtifactManifests(db, "tenant-b")).toEqual([]);
  });

  it("does not load a snapshot whose authoritative deletion is planned", async () => {
    const { app, db, root } = fixture(true);
    seedSnapshot(db, root);
    recordRepositorySnapshotDeletion(db, {
      id: "deletion-a",
      tenantId: "tenant-a",
      snapshotId: "snapshot-a",
      status: "planned",
      actorPrincipalId: "principal-tenant-a",
      createdAt: "2026-08-12T12:30:00.000Z",
    });

    const response = await app.request("/transformer/legacy-behavior/extractions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Tenant": "tenant-a" },
      body: JSON.stringify(requestBody),
    });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "legacy_behavior_snapshot_unavailable" });
    expect(listArtifactManifests(db, "tenant-a")).toEqual([]);
  });

  it("preflights file limits before reading or persisting snapshot content", async () => {
    const { app, db, root } = fixture(true);
    seedSnapshot(db, root, { files: { "src/oversized.ts": `export const value = 1;\n${"x".repeat(300_000)}` } });

    const response = await app.request("/transformer/legacy-behavior/extractions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Tenant": "tenant-a" },
      body: JSON.stringify(requestBody),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "legacy_behavior_snapshot_file_limit_exceeded" });
    expect(listArtifactManifests(db, "tenant-a")).toEqual([]);
  });

  it("detects persisted graph corruption during retrieval", async () => {
    const { app, db, root } = fixture(true);
    seedSnapshot(db, root);
    const response = await app.request("/transformer/legacy-behavior/extractions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Tenant": "tenant-a" },
      body: JSON.stringify(requestBody),
    });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    const created = await response.json() as any;
    db.raw.exec("DROP TRIGGER artifact_manifests_append_only_update");
    db.raw.prepare(
      "UPDATE artifact_manifests SET content_text = '{}' WHERE tenant_id = ? AND kind = ?",
    ).run("tenant-a", "legacy-behavior-graph");

    const retrieval = await app.request(`/transformer/legacy-behavior/extractions/${created.id}`, {
      headers: { "X-Test-Tenant": "tenant-a" },
    });
    expect(retrieval.status).toBe(409);
    expect(await retrieval.json()).toEqual({ error: "legacy_behavior_persisted_artifact_corrupt" });
  });

  it("rejects a replacement draft even when its artifact hash and size are recomputed", async () => {
    const { app, db, root } = fixture(true);
    seedSnapshot(db, root);
    const response = await app.request("/transformer/legacy-behavior/extractions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Tenant": "tenant-a" },
      body: JSON.stringify(requestBody),
    });
    expect(response.status).toBe(201);
    const created = await response.json() as any;
    const replacement = "# Replaced draft\n\nThis did not come from the authenticated graph.\n";
    db.raw.exec("DROP TRIGGER artifact_manifests_append_only_update");
    db.raw.prepare(
      `UPDATE artifact_manifests SET content_text = ?, sha256 = ?, size_bytes = ?
       WHERE tenant_id = ? AND kind = ?`,
    ).run(
      replacement,
      sha256(replacement),
      Buffer.byteLength(replacement),
      "tenant-a",
      "legacy-behavior-documentation-draft",
    );

    const retrieval = await app.request(`/transformer/legacy-behavior/extractions/${created.id}`, {
      headers: { "X-Test-Tenant": "tenant-a" },
    });
    expect(retrieval.status).toBe(409);
    expect(await retrieval.json()).toEqual({ error: "legacy_behavior_persisted_artifact_corrupt" });
  });

  it("rejects rewritten evidence authority during retrieval", async () => {
    const { app, db, root } = fixture(true);
    seedSnapshot(db, root);
    const response = await app.request("/transformer/legacy-behavior/extractions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Tenant": "tenant-a" },
      body: JSON.stringify(requestBody),
    });
    expect(response.status).toBe(201);
    const created = await response.json() as any;
    db.raw.exec("DROP TRIGGER evidence_records_append_only_update");
    db.raw.prepare(
      "UPDATE evidence_records SET tool = 'rewritten-tool' WHERE id = ?",
    ).run(created.evidence.graphEvidenceRecordId);

    const retrieval = await app.request(`/transformer/legacy-behavior/extractions/${created.id}`, {
      headers: { "X-Test-Tenant": "tenant-a" },
    });
    expect(retrieval.status).toBe(409);
    expect(await retrieval.json()).toEqual({ error: "legacy_behavior_persisted_artifact_corrupt" });
  });
});
