import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, insertPrincipal, type AppDb, type PilotSuccessContractDefinition } from "@mendpoint/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "./auth.js";
import { createPilotSuccessContractRoutes } from "./pilot-success-contracts.js";

const opened: Array<{ db: AppDb; directory: string }> = [];
const NOW = "2026-08-02T12:00:00.000Z";

function definition(): PilotSuccessContractDefinition {
  return {
    providerChange: { provider: "Example Payments", changeClass: "breaking", description: "Move v1 to v2." },
    repositories: [{ owner: "customer", name: "checkout", branch: "main", scope: "adapter and tests" }],
    thresholds: [{ metric: "verified pull requests", operator: "gte", target: 1, unit: "pull requests" }],
    owners: [
      { responsibility: "customer_owner", principalId: "creator-a" },
      { responsibility: "mendpoint_owner", principalId: "creator-a" },
      { responsibility: "technical_reviewer", principalId: "reviewer-a" },
      { responsibility: "privacy_contact", principalId: "creator-a" },
      { responsibility: "rollback_owner", principalId: "creator-a" },
    ],
    supportResponses: [{ severity: "critical", responseMinutes: 30, coverage: "Weekdays UTC" }],
    privacy: {
      dataCategories: ["repository source"], retentionDays: 30, processingRegions: ["us-central"],
      deletionProcedure: "Operator purge with evidence.",
    },
    rollback: {
      trigger: "Critical regression.", procedure: "Close the draft pull request and restore the snapshot.",
      ownerPrincipalId: "creator-a", recoveryMinutes: 60,
    },
    weeklyReview: {
      dayOfWeek: "Wednesday", timeUtc: "16:00", ownerPrincipalId: "creator-a", agenda: ["thresholds"],
    },
    conversionDecision: {
      decisionDueAt: "2026-09-01T16:00:00.000Z", ownerPrincipalId: "creator-a",
      criteria: ["All thresholds pass"],
    },
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-pilot-contract-api-"));
  const db = createDb(join(directory, "api.sqlite"));
  opened.push({ db, directory });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?),
           ('tenant-b', 'tenant-b', 'Tenant B', 'team', 'active', 10, ?)`)
    .run(NOW, NOW);
  for (const [id, tenantId] of [["creator-a", "tenant-a"], ["reviewer-a", "tenant-a"], ["creator-b", "tenant-b"]]) {
    insertPrincipal(db, { id, tenantId, kind: "human", subject: `${id}@example.com`, displayName: id, createdAt: NOW });
  }
  const identities = {
    "owner-a": { id: "human:creator-a", tenantId: "tenant-a", role: "owner" as const, trust: "creator-a" },
    "reviewer-a": { id: "human:reviewer-a", tenantId: "tenant-a", role: "admin" as const, trust: "reviewer-a" },
    "viewer-a": { id: "human:viewer-a", tenantId: "tenant-a", role: "viewer" as const, trust: "creator-a" },
    "owner-b": { id: "human:creator-b", tenantId: "tenant-b", role: "owner" as const, trust: "creator-b" },
  };
  let sequence = 0;
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "") as keyof typeof identities | undefined;
    const identity = token ? identities[token] : undefined;
    if (identity) {
      c.set("principal", { id: identity.id, tenantId: identity.tenantId, role: identity.role });
      c.set("tenantId", identity.tenantId);
      c.set("trustPrincipalId", identity.trust);
      c.set("requestId", c.req.header("X-Request-Id") ?? "request");
    }
    return next();
  });
  app.route("/pilot-success-contracts", createPilotSuccessContractRoutes({
    db,
    now: () => new Date(NOW),
    createId: (kind) => `${kind}-${++sequence}`,
  }));
  return { app, db };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Request-Id": `request-${token}` };
}

describe("pilot success contract API", () => {
  it.each([
    ["provider", "pilot_contract_provider_token_invalid"],
    ["filesystem", "pilot_contract_/customers/acme/private_not_found"],
    ["database", "pilot_contract_SQLITE_CONSTRAINT"],
    ["resource existence", "pilot_contract_repository_not_found"],
  ])("fails unknown %s exceptions closed at the API boundary", async (_kind, sentinel) => {
    const { app, db } = fixture();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(db.raw, "prepare").mockImplementation(() => {
      throw new Error(sentinel);
    });

    const response = await app.request("/pilot-success-contracts", {
      headers: headers("owner-a"),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "internal_error",
      requestId: "request-owner-a",
    });
  });

  it("rejects a missing definition as a validation error", async () => {
    const { app } = fixture();
    const response = await app.request("/pilot-success-contracts", {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({ title: "Incomplete pilot" }),
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "pilot_contract_definition_required" },
    });
  });

  it("creates and reads only within the authenticated tenant", async () => {
    const { app } = fixture();
    const unauthenticated = await app.request("/pilot-success-contracts");
    expect(unauthenticated.status).toBe(401);
    const viewerCreate = await app.request("/pilot-success-contracts", {
      method: "POST", headers: headers("viewer-a"), body: JSON.stringify({ title: "No", definition: definition() }),
    });
    expect(viewerCreate.status).toBe(403);

    const created = await app.request("/pilot-success-contracts", {
      method: "POST",
      headers: { ...headers("owner-a"), "X-Tenant-Id": "tenant-b" },
      body: JSON.stringify({
        title: "Example Payments pilot",
        definition: {
          ...definition(),
          owners: definition().owners.map((owner) => owner.responsibility === "technical_reviewer"
            ? owner : { ...owner, principalId: "current_operator" }),
          rollback: { ...definition().rollback, ownerPrincipalId: "current_operator" },
          weeklyReview: { ...definition().weeklyReview, ownerPrincipalId: "current_operator" },
          conversionDecision: { ...definition().conversionDecision, ownerPrincipalId: "current_operator" },
        },
      }),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { data: { id: string; tenantId: string; version: number } };
    expect(body.data).toMatchObject({ id: "pilot-contract-1", tenantId: "tenant-a", version: 1 });

    const tenantBRead = await app.request(`/pilot-success-contracts/${body.data.id}`, { headers: headers("owner-b") });
    expect(tenantBRead.status).toBe(404);
    const tenantAList = await app.request("/pilot-success-contracts", { headers: headers("owner-a") });
    expect(await tenantAList.json()).toMatchObject({ data: [{ id: "pilot-contract-1", tenantId: "tenant-a" }] });
  });

  it("revises with version fencing and approves only as the assigned reviewer", async () => {
    const { app } = fixture();
    const created = await app.request("/pilot-success-contracts", {
      method: "POST", headers: headers("owner-a"),
      body: JSON.stringify({ title: "Example Payments pilot", definition: definition() }),
    });
    const contractId = ((await created.json()) as { data: { id: string } }).data.id;
    const stale = await app.request(`/pilot-success-contracts/${contractId}/revisions`, {
      method: "POST", headers: headers("owner-a"),
      body: JSON.stringify({ expectedVersion: 2, title: "Stale", definition: definition() }),
    });
    expect(stale.status).toBe(409);
    const revised = await app.request(`/pilot-success-contracts/${contractId}/revisions`, {
      method: "POST", headers: headers("owner-a"),
      body: JSON.stringify({ expectedVersion: 1, title: "Production pilot", definition: definition() }),
    });
    expect(revised.status).toBe(201);
    await expect(revised.json()).resolves.toMatchObject({ data: { version: 2, status: "draft" } });

    const selfApproval = await app.request(`/pilot-success-contracts/${contractId}/versions/2/approvals`, {
      method: "POST", headers: headers("owner-a"), body: JSON.stringify({ rationale: "I approve" }),
    });
    expect(selfApproval.status).toBe(422);
    const approval = await app.request(`/pilot-success-contracts/${contractId}/versions/2/approvals`, {
      method: "POST", headers: headers("reviewer-a"),
      body: JSON.stringify({ rationale: "Scope, thresholds, controls, and conversion criteria are accepted." }),
    });
    expect(approval.status).toBe(201);
    await expect(approval.json()).resolves.toMatchObject({
      data: { version: 2, status: "approved", approval: { reviewerPrincipalId: "reviewer-a" } },
    });
  });
});
