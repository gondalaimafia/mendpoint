import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb, insertTenant, recordAudit, type AppDb } from "@mendpoint/db";
import type { ApiEnv } from "./auth.js";
import { createAuditGovernanceRoutes } from "./audit-governance-routes.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const at = "2026-08-30T12:00:00.000Z";

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-audit-routes-"));
  roots.push(root);
  const db = createDb(join(root, "app.sqlite"));
  dbs.push(db);
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    insertTenant(db, { id: tenantId, slug: tenantId, name: tenantId, createdAt: at });
    recordAudit(db, {
      id: `audit-${tenantId}`,
      tenantId,
      actor: "api",
      action: "repository.connected",
      resourceType: "repository",
      resourceId: `repo-${tenantId}`,
      metadata: { token: `secret-${tenantId}` },
    });
  }
  let next = 0;
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, nextHandler) => {
    const tenantId = c.req.header("x-tenant") ?? "tenant-a";
    c.set("principal", {
      id: `human:${tenantId}`,
      tenantId,
      role: (c.req.header("x-role") ?? "owner") as "owner" | "viewer",
    });
    await nextHandler();
  });
  app.route("/audit-governance", createAuditGovernanceRoutes({
    db,
    now: () => at,
    createId: () => `generated-${++next}`,
  }));
  return { app, db };
}

function json(method: string, body: unknown, headers: Record<string, string> = {}) {
  return { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

describe("authenticated audit governance routes", () => {
  it("requires tenant administration for every governance mutation", async () => {
    const { app } = fixture();
    const response = await app.request("/audit-governance/destinations",
      json("POST", { uri: "customer://tenant-a/audit" }, {
        "x-role": "viewer", "Idempotency-Key": "destination-viewer",
      }));
    expect(response.status).toBe(403);
  });

  it("creates a destination, legal hold, and replay-verifiable redacted export", async () => {
    const { app } = fixture();
    const destination = await app.request("/audit-governance/destinations", json("POST", {
      destinationId: "destination-a",
      uri: "customer://tenant-a/security/audit",
    }, { "Idempotency-Key": "destination-create" }));
    expect(destination.status).toBe(201);

    const hold = await app.request("/audit-governance/legal-holds", json("POST", {
      holdId: "hold-a",
      reason: "customer dispute",
      eventIds: ["audit-tenant-a"],
    }, { "Idempotency-Key": "hold-create" }));
    expect(hold.status).toBe(201);
    const retention = await app.request(
      "/audit-governance/retention?at=2035-08-30T13%3A00%3A00.000Z&limit=100",
    );
    expect(retention.status).toBe(200);
    expect(await retention.json()).toMatchObject({
      data: [{ recordId: "audit-tenant-a", disposition: "retain", reason: "legal_hold" }],
    });

    const created = await app.request("/audit-governance/exports", json("POST", {
      exportId: "export-a",
      destinationId: "destination-a",
      redactionProfile: "security",
      limit: 100,
    }, { "Idempotency-Key": "export-create" }));
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { bundle: { records: Array<{ id: string }> } };
    expect(createdBody.bundle.records.map((record) => record.id)).toEqual(["audit-tenant-a"]);
    expect(JSON.stringify(createdBody)).not.toContain("secret-tenant-a");

    const replay = await app.request("/audit-governance/exports/export-a/replay");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, checked: 1 });
  });

  it("keeps export manifests, destinations, and holds tenant scoped", async () => {
    const { app } = fixture();
    await app.request("/audit-governance/destinations", json("POST", {
      destinationId: "destination-a",
      uri: "customer://tenant-a/audit",
    }, { "Idempotency-Key": "destination-create" }));
    await app.request("/audit-governance/exports", json("POST", {
      exportId: "export-a",
      destinationId: "destination-a",
      redactionProfile: "minimal",
    }, { "Idempotency-Key": "export-create" }));

    const crossTenant = { "x-tenant": "tenant-b" };
    expect((await app.request("/audit-governance/exports/export-a", { headers: crossTenant })).status)
      .toBe(404);
    expect((await app.request("/audit-governance/exports/export-a/replay", { headers: crossTenant })).status)
      .toBe(404);
    expect((await (await app.request("/audit-governance/destinations", { headers: crossTenant })).json() as { data: unknown[] }).data)
      .toEqual([]);
    expect((await (await app.request("/audit-governance/legal-holds", { headers: crossTenant })).json() as { data: unknown[] }).data)
      .toEqual([]);
  });

  it("rejects malformed optional identifiers instead of silently replacing or failing internally", async () => {
    const { app } = fixture();
    const invalidDestination = await app.request("/audit-governance/destinations", json("POST", {
      destinationId: "invalid destination",
      uri: "customer://tenant-a/audit",
    }, { "Idempotency-Key": "destination-invalid" }));
    expect(invalidDestination.status).toBe(400);

    const invalidHold = await app.request("/audit-governance/legal-holds", json("POST", {
      holdId: "invalid hold",
      reason: "customer dispute",
      eventIds: ["audit-tenant-a"],
    }, { "Idempotency-Key": "hold-invalid" }));
    expect(invalidHold.status).toBe(400);

    const invalidKey = await app.request("/audit-governance/destinations", json("POST", {
      uri: "customer://tenant-a/audit",
    }, { "Idempotency-Key": "invalid key" }));
    expect(invalidKey.status).toBe(400);
  });
});
