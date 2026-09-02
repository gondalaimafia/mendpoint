import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDb, insertTenant, listAudit, recordAudit, type AppDb } from "@mendpoint/db";
import type { ApiEnv } from "./auth.js";
import {
  createAuditGovernanceDenialAuditMiddleware,
  createAuditGovernanceRoutes,
} from "./audit-governance-routes.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const at = "2026-08-30T12:00:00.000Z";

beforeEach(() => {
  // `recordAudit` stamps `created_at` from the wall clock with no injection seam,
  // so pin the process clock to the suite's fixed instant. Faking only Date keeps
  // the sqlite/fs work synchronous and untouched.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(at) });
});

afterEach(() => {
  vi.useRealTimers();
  while (dbs.length) dbs.pop()?.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

type AuditInput = Parameters<typeof recordAudit>[1];

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
  let auditSequence = 0;
  // Production `recordAudit`, with a deterministic id so the control plane's own
  // evidence is addressable in assertions.
  const audit = (input: AuditInput) =>
    recordAudit(db, { ...input, id: `audit-event-${++auditSequence}` });
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, nextHandler) => {
    const role = c.req.header("x-role") ?? "owner";
    if (role !== "anonymous") {
      const tenantId = c.req.header("x-tenant") ?? "tenant-a";
      c.set("principal", {
        id: `human:${tenantId}`,
        tenantId,
        role: role as "owner" | "viewer",
      });
    }
    await nextHandler();
  });
  // Mirrors server.ts, which mounts the denial middleware around the auth chain
  // so a refusal that never reaches a handler still leaves evidence.
  app.use("*", createAuditGovernanceDenialAuditMiddleware({ db, audit }));
  app.route("/audit-governance", createAuditGovernanceRoutes({
    db,
    now: () => at,
    createId: () => `generated-${++next}`,
    audit,
  }));
  return { app, db };
}

function json(method: string, body: unknown, headers: Record<string, string> = {}) {
  return { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

function auditEvents(db: AppDb, tenantId: string) {
  return listAudit(db, tenantId).map((row) => ({
    action: row.action,
    resourceId: row.resource_id,
    metadata: JSON.parse(row.metadata_json ?? "null") as Record<string, unknown> | null,
  }));
}

function eventFor(db: AppDb, tenantId: string, action: string) {
  return auditEvents(db, tenantId).find((event) => event.action === action);
}

describe("authenticated audit governance routes", () => {
  it("requires tenant administration for every governance mutation", async () => {
    const { app, db } = fixture();
    const response = await app.request("/audit-governance/destinations",
      json("POST", { uri: "customer://tenant-a/audit" }, {
        "x-role": "viewer", "Idempotency-Key": "destination-viewer",
      }));
    expect(response.status).toBe(403);

    // The refusal is the evidence the control plane exists to provide.
    expect(eventFor(db, "tenant-a", "audit.governance.denied")).toMatchObject({
      metadata: {
        outcome: "denied",
        failure: "authorization_denied",
        status: 403,
        collection: "destinations",
        role: "viewer",
      },
    });
  });

  it("records an attributable refusal when an unauthenticated caller attempts a mutation", async () => {
    const { app, db } = fixture();
    const response = await app.request("/audit-governance/legal-holds/hold-a/release",
      json("POST", { reason: "no" }, {
        "x-role": "anonymous", "Idempotency-Key": "release-anonymous",
      }));
    expect(response.status).toBe(401);
    expect(eventFor(db, "tenant_unattributed", "audit.governance.denied")).toMatchObject({
      resourceId: "hold-a",
      metadata: {
        outcome: "denied",
        failure: "authentication_denied",
        status: 401,
        collection: "legal-holds",
      },
    });
  });

  it("records the attempt when a mutation is rolled back inside the store transaction", async () => {
    const { app, db } = fixture();
    const first = await app.request("/audit-governance/destinations", json("POST", {
      destinationId: "destination-a",
      uri: "customer://tenant-a/audit",
    }, { "Idempotency-Key": "destination-first" }));
    expect(first.status).toBe(201);

    // Same destination id, different idempotency key: the store throws inside
    // `transaction()`, which rolls back. The attempt must survive the rollback.
    const duplicate = await app.request("/audit-governance/destinations", json("POST", {
      destinationId: "destination-a",
      uri: "customer://tenant-a/audit",
    }, { "Idempotency-Key": "destination-duplicate" }));
    expect(duplicate.status).toBe(409);

    expect(db.raw.prepare(
      "SELECT COUNT(*) AS total FROM audit_export_destination_events WHERE tenant_id = ?",
    ).get("tenant-a")).toEqual({ total: 1 });
    expect(eventFor(db, "tenant-a", "audit.export_destination.denied")).toMatchObject({
      resourceId: "destination-a",
      metadata: { outcome: "denied", failure: "audit_destination_exists", status: 409 },
    });
  });

  it("creates a destination, legal hold, and replay-verifiable redacted export", async () => {
    const { app, db } = fixture();
    const destination = await app.request("/audit-governance/destinations", json("POST", {
      destinationId: "destination-a",
      uri: "customer://tenant-a/security/audit",
    }, { "Idempotency-Key": "destination-create" }));
    expect(destination.status).toBe(201);
    expect(eventFor(db, "tenant-a", "audit.export_destination.registered")).toMatchObject({
      resourceId: "destination-a",
      metadata: { outcome: "allowed", status: 201 },
    });

    const hold = await app.request("/audit-governance/legal-holds", json("POST", {
      holdId: "hold-a",
      reason: "customer dispute",
      eventIds: ["audit-tenant-a"],
    }, { "Idempotency-Key": "hold-create" }));
    expect(hold.status).toBe(201);
    expect(eventFor(db, "tenant-a", "audit.legal_hold.created")).toMatchObject({
      resourceId: "hold-a",
      metadata: { outcome: "allowed", status: 201 },
    });

    const retention = await app.request(
      "/audit-governance/retention?at=2035-08-30T13%3A00%3A00.000Z&limit=100",
    );
    expect(retention.status).toBe(200);
    // Three records now: the seeded event plus the control plane's own two.
    expect(await retention.json()).toMatchObject({
      data: [
        { recordId: "audit-tenant-a", disposition: "retain", reason: "legal_hold" },
        { recordId: "audit-event-1", disposition: "eligible_for_deletion", reason: "retention_elapsed" },
        { recordId: "audit-event-2", disposition: "eligible_for_deletion", reason: "retention_elapsed" },
      ],
    });

    const created = await app.request("/audit-governance/exports", json("POST", {
      exportId: "export-a",
      destinationId: "destination-a",
      redactionProfile: "security",
      limit: 100,
    }, { "Idempotency-Key": "export-create" }));
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { bundle: { records: Array<{ id: string }> } };
    expect(createdBody.bundle.records.map((record) => record.id).sort())
      .toEqual(["audit-event-1", "audit-event-2", "audit-tenant-a"]);
    expect(JSON.stringify(createdBody)).not.toContain("secret-tenant-a");
    expect(eventFor(db, "tenant-a", "audit.export.created")).toMatchObject({
      resourceId: "export-a",
      metadata: { outcome: "allowed", status: 201, recordCount: 3 },
    });

    const replay = await app.request("/audit-governance/exports/export-a/replay");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, checked: 3 });
  });

  it("keeps export manifests, destinations, and holds tenant scoped", async () => {
    const { app } = fixture();
    await app.request("/audit-governance/destinations", json("POST", {
      destinationId: "destination-a",
      uri: "customer://tenant-a/audit",
    }, { "Idempotency-Key": "destination-create" }));
    const hold = await app.request("/audit-governance/legal-holds", json("POST", {
      holdId: "hold-a",
      reason: "customer dispute",
      eventIds: ["audit-tenant-a"],
    }, { "Idempotency-Key": "hold-create" }));
    expect(hold.status).toBe(201);
    await app.request("/audit-governance/exports", json("POST", {
      exportId: "export-a",
      destinationId: "destination-a",
      redactionProfile: "minimal",
    }, { "Idempotency-Key": "export-create" }));

    // The owning tenant sees the hold, so the empty cross-tenant read below is a
    // tenant filter rather than an endpoint that returns nothing for everyone.
    const owned = await (await app.request("/audit-governance/legal-holds")).json() as {
      data: Array<{ hold_id: string }>;
    };
    expect(owned.data.map((row) => row.hold_id)).toEqual(["hold-a"]);

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
    const { app, db } = fixture();
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

    // Every rejected attempt is attributable, including the ones the route
    // refuses before the store is reached.
    expect(auditEvents(db, "tenant-a").map((event) => event.action).sort()).toEqual([
      "audit.export_destination.denied",
      "audit.export_destination.denied",
      "audit.legal_hold.denied",
      "repository.connected",
    ]);
  });
});
