import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDb,
  insertArtifactManifest,
  insertEvidenceRecord,
  insertPrincipal,
  insertTenant,
  organizationMemoryId,
  type AppDb,
} from "@mendpoint/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiEnv } from "./auth.js";
import { createOrganizationMemoryRoutes } from "./organization-memory-routes.js";
import { requestIdMiddleware } from "./production.js";

const AT = "2026-08-01T00:00:00.000Z";
const directories: string[] = [];
const databases: AppDb[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.raw.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-org-memory-api-"));
  directories.push(dir);
  const db = createDb(join(dir, "org-memory.sqlite"));
  databases.push(db);
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    insertTenant(db, { id: tenantId, slug: tenantId, name: tenantId, createdAt: AT });
    insertPrincipal(db, {
      id: `human-${tenantId}`,
      tenantId,
      kind: "human",
      subject: `user-${tenantId}`,
      displayName: `Human ${tenantId}`,
      createdAt: AT,
    });
  }
  insertPrincipal(db, {
    id: "human-tenant-a-second",
    tenantId: "tenant-a",
    kind: "human",
    subject: "user-tenant-a-second",
    displayName: "Human tenant-a second",
    createdAt: AT,
  });
  insertPrincipal(db, {
    id: "api-key-tenant-a",
    tenantId: "tenant-a",
    kind: "api_key",
    subject: "key-tenant-a",
    displayName: "API key tenant-a",
    createdAt: AT,
  });
  return db;
}

function appWith(db: AppDb, ctx: {
  tenantId: string;
  trustPrincipalId?: string;
  authMethod?: "oidc" | "api_key";
} | null): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  app.use("*", requestIdMiddleware());
  if (ctx) {
    app.use("*", async (c, next) => {
      c.set("principal", { id: `test:${ctx.tenantId}`, tenantId: ctx.tenantId, role: "owner" });
      if (ctx.trustPrincipalId) c.set("trustPrincipalId", ctx.trustPrincipalId);
      c.set("authMethod", ctx.authMethod ?? "oidc");
      if ((ctx.authMethod ?? "oidc") === "oidc") {
        c.set("membershipEvidenceId", `membership:${ctx.trustPrincipalId ?? "missing"}`);
      }
      await next();
    });
  }
  app.route("/organization-memory", createOrganizationMemoryRoutes({ db }));
  return app;
}

function observationEvidence(db: AppDb, input: {
  memoryId: string;
  principalId: string;
  suffix: string;
}): string {
  const content = JSON.stringify({ memoryId: input.memoryId, suffix: input.suffix });
  const sha256 = createHash("sha256").update(content).digest("hex");
  const artifactId = `artifact-${input.suffix}`;
  const evidenceId = `evidence-${input.suffix}`;
  insertArtifactManifest(db, {
    id: artifactId,
    tenantId: "tenant-a",
    kind: "organization_memory_observation",
    schemaVersion: 1,
    sha256,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
    storageRef: `inline:${artifactId}`,
    content,
    producerPrincipalId: input.principalId,
    createdAt: AT,
  });
  insertEvidenceRecord(db, {
    id: evidenceId,
    tenantId: "tenant-a",
    subjectType: "organization_memory_observation",
    subjectId: input.memoryId,
    artifactId,
    producerPrincipalId: input.principalId,
    tool: "mendpoint-organization-memory-observer",
    verdict: "passed",
    createdAt: AT,
  });
  return evidenceId;
}

const createBody = {
  category: "CODING_CONVENTION",
  scope: "tenant",
  subjectKey: "prefer-internal-auth",
  statement: "Prefer the internal auth client over direct OAuth calls",
  reason: "stated in onboarding",
};

describe("Organization Memory API routes", () => {
  it("requires authentication", async () => {
    const db = fixture();
    const res = await appWith(db, null).request("/organization-memory", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("creates an explicit memory and lists it, tenant derived from the principal", async () => {
    const db = fixture();
    const app = appWith(db, { tenantId: "tenant-a", trustPrincipalId: "human-tenant-a" });
    const created = await app.request("/organization-memory", {
      method: "POST",
      body: JSON.stringify(createBody),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { memory: { status: string; tenantId: string; memoryId: string } };
    expect(createdBody.memory.status).toBe("ACTIVE");
    expect(createdBody.memory.tenantId).toBe("tenant-a");

    const list = await app.request("/organization-memory?status=ACTIVE", { method: "GET" });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { memories: Array<{ memoryId: string }> };
    expect(listBody.memories).toHaveLength(1);
    expect(listBody.memories[0]!.memoryId).toBe(createdBody.memory.memoryId);
  });

  it("does not leak memory across tenants", async () => {
    const db = fixture();
    const appA = appWith(db, { tenantId: "tenant-a", trustPrincipalId: "human-tenant-a" });
    await appA.request("/organization-memory", { method: "POST", body: JSON.stringify(createBody) });

    const appB = appWith(db, { tenantId: "tenant-b", trustPrincipalId: "human-tenant-b" });
    const list = await appB.request("/organization-memory", { method: "GET" });
    const listBody = (await list.json()) as { memories: unknown[] };
    expect(listBody.memories).toHaveLength(0);
  });

  it("records an observation, then disables it, and exposes provenance", async () => {
    const db = fixture();
    const app = appWith(db, { tenantId: "tenant-a", trustPrincipalId: "human-tenant-a" });
    const observed = await app.request("/organization-memory/observations", {
      method: "POST",
      body: JSON.stringify({
        category: "MIGRATION_PREFERENCE",
        scope: "tenant",
        subjectKey: "batch-small",
        statement: "Keep migration batches small",
        observationFingerprint: "obs-1",
        source: "reviewer_correction",
      }),
    });
    expect(observed.status).toBe(201);
    const memoryId = ((await observed.json()) as { memory: { memoryId: string; status: string } }).memory.memoryId;

    const disabled = await app.request(`/organization-memory/${memoryId}/disable`, {
      method: "POST",
      body: JSON.stringify({ reason: "not a real pattern" }),
    });
    expect(disabled.status).toBe(200);
    expect(((await disabled.json()) as { memory: { status: string } }).memory.status).toBe("DISABLED");

    const provenance = await app.request(`/organization-memory/${memoryId}/provenance`, { method: "GET" });
    const provBody = (await provenance.json()) as { provenance: unknown[] };
    expect(provBody.provenance).toHaveLength(2);
  });

  it("blocks activating a lone observation through the API", async () => {
    const db = fixture();
    const app = appWith(db, { tenantId: "tenant-a", trustPrincipalId: "human-tenant-a" });
    const observed = await app.request("/organization-memory/observations", {
      method: "POST",
      body: JSON.stringify({
        category: "TESTING_REQUIREMENT",
        scope: "tenant",
        subjectKey: "e2e-required",
        statement: "E2E tests required",
        observationFingerprint: "obs-1",
        source: "repeated_verified_behavior",
      }),
    });
    const memoryId = ((await observed.json()) as { memory: { memoryId: string } }).memory.memoryId;
    const activate = await app.request(`/organization-memory/${memoryId}/activate`, {
      method: "POST",
      body: JSON.stringify({ reason: "premature" }),
    });
    expect(activate.status).toBe(409);
    expect(((await activate.json()) as { error: string }).error).toBe(
      "organization_memory_activation_blocked_insufficient_corroboration",
    );
  });

  it("requires a trust principal to create", async () => {
    const db = fixture();
    const app = appWith(db, { tenantId: "tenant-a" });
    const res = await app.request("/organization-memory", { method: "POST", body: JSON.stringify(createBody) });
    expect(res.status).toBe(401);
  });

  it("rejects API key authority for human-only memory mutations", async () => {
    const db = fixture();
    const app = appWith(db, {
      tenantId: "tenant-a",
      trustPrincipalId: "api-key-tenant-a",
      authMethod: "api_key",
    });
    const res = await app.request("/organization-memory", {
      method: "POST",
      body: JSON.stringify(createBody),
    });
    expect(res.status).toBe(401);
    const rows = db.raw.prepare("SELECT COUNT(*) AS count FROM organization_memory").get() as { count: number };
    expect(rows.count).toBe(0);
  });

  it("does not count two observations from the same principal as independent corroboration", async () => {
    const db = fixture();
    const memoryId = organizationMemoryId({
      tenantId: "tenant-a",
      category: "CODING_CONVENTION",
      scope: "tenant",
      subjectKey: "same-observer",
    });
    const evidenceOne = observationEvidence(db, {
      memoryId,
      principalId: "human-tenant-a",
      suffix: "same-observer-one",
    });
    const evidenceTwo = observationEvidence(db, {
      memoryId,
      principalId: "human-tenant-a",
      suffix: "same-observer-two",
    });
    const app = appWith(db, { tenantId: "tenant-a", trustPrincipalId: "human-tenant-a" });
    const body = {
      category: "CODING_CONVENTION",
      scope: "tenant",
      subjectKey: "same-observer",
      statement: "Use the internal auth client",
      source: "repeated_verified_behavior",
    };
    expect((await app.request("/organization-memory/observations", {
      method: "POST",
      body: JSON.stringify({ ...body, observationFingerprint: "caller-one", sourceRefs: [evidenceOne] }),
    })).status).toBe(201);
    const second = await app.request("/organization-memory/observations", {
      method: "POST",
      body: JSON.stringify({ ...body, observationFingerprint: "caller-two", sourceRefs: [evidenceTwo] }),
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe("organization_memory_observation_not_independent");
  });

  it("rejects contradictory observations instead of validating the first statement", async () => {
    const db = fixture();
    const memoryId = organizationMemoryId({
      tenantId: "tenant-a",
      category: "CODING_CONVENTION",
      scope: "tenant",
      subjectKey: "auth-client",
    });
    const firstEvidence = observationEvidence(db, {
      memoryId,
      principalId: "human-tenant-a",
      suffix: "contradiction-one",
    });
    const secondEvidence = observationEvidence(db, {
      memoryId,
      principalId: "human-tenant-a-second",
      suffix: "contradiction-two",
    });
    const firstApp = appWith(db, { tenantId: "tenant-a", trustPrincipalId: "human-tenant-a" });
    const secondApp = appWith(db, { tenantId: "tenant-a", trustPrincipalId: "human-tenant-a-second" });
    await firstApp.request("/organization-memory/observations", {
      method: "POST",
      body: JSON.stringify({
        category: "CODING_CONVENTION",
        scope: "tenant",
        subjectKey: "auth-client",
        statement: "Always use the internal auth client",
        observationFingerprint: "caller-one",
        source: "repeated_verified_behavior",
        sourceRefs: [firstEvidence],
      }),
    });
    const contradictory = await secondApp.request("/organization-memory/observations", {
      method: "POST",
      body: JSON.stringify({
        category: "CODING_CONVENTION",
        scope: "tenant",
        subjectKey: "auth-client",
        statement: "Never use the internal auth client",
        observationFingerprint: "caller-two",
        source: "reviewer_correction",
        sourceRefs: [secondEvidence],
      }),
    });
    expect(contradictory.status).toBe(409);
    expect(((await contradictory.json()) as { error: string }).error).toBe("organization_memory_observation_conflict");
  });

  it("rejects an observation whose evidence reference is not authoritative", async () => {
    const db = fixture();
    const app = appWith(db, { tenantId: "tenant-a", trustPrincipalId: "human-tenant-a" });
    const result = await app.request("/organization-memory/observations", {
      method: "POST",
      body: JSON.stringify({
        category: "CODING_CONVENTION",
        scope: "tenant",
        subjectKey: "missing-evidence",
        statement: "Use the internal auth client",
        observationFingerprint: "caller-value",
        source: "repeated_verified_behavior",
        sourceRefs: ["evidence-does-not-exist"],
      }),
    });
    expect(result.status).toBe(400);
    expect(((await result.json()) as { error: string }).error).toBe("organization_memory_evidence_invalid");
  });
});
