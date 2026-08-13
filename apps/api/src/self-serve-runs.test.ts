/**
 * Self-serve run console (S3).
 *
 * Drives the flag-gated /self-serve/runs read surface with two tenants and asserts:
 *  - the route is inert (404) unless MENDPOINT_SELF_SERVE_WARDEN=1;
 *  - a customer sees ONLY their own tenant's runs in the list and detail;
 *  - a run from another tenant is never listed nor fetchable by id (404);
 *  - the real run model is surfaced: status, target, controls availability, plan,
 *    execution log, verification, changed files, resulting PR (with the real
 *    unified patch) and a review-handoff link;
 *  - a run type lacking a plan/log (a scan) reports honest nulls, never a fake;
 *  - control availability mirrors the existing cancel/retry eligibility.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDb,
  enqueueJob,
  insertAgentRun,
  insertApiChange,
  insertApiVersion,
  insertConsumer,
  insertProvider,
  insertMigrationPr,
  type AppDb,
} from "@mendpoint/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiEnv } from "./auth.js";
import { createSelfServeRunsRoutes } from "./self-serve-runs.js";

const NOW = "2026-08-13T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

afterEach(() => {
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

const identities = {
  "owner-a": { id: "human:owner-a@example.com", tenantId: "tenant-a", role: "owner" as const },
  "owner-b": { id: "human:owner-b@example.com", tenantId: "tenant-b", role: "owner" as const },
} as const;

/** Seed one scan run and one completed Warden run (with a delivered draft PR) for tenant-a. */
function seedTenantA(db: AppDb, cwd: string): void {
  // ── Scan run (no agent run, no plan/log artifact) ──
  enqueueJob(db, {
    id: "scan-job-a1",
    tenantId: "tenant-a",
    type: "pipeline.fanout",
    payload: { providerSlug: "alpha", tenantId: "tenant-a" },
    createdAt: NOW,
  });

  // ── Warden run: consumer + change + migration PR + failed job + agent run + delivery ──
  insertConsumer(db, {
    id: "consumer-a",
    name: "Acme SDK",
    githubOwner: "acme",
    githubRepo: "payments-sdk",
    tenantId: "tenant-a",
    createdAt: NOW,
  });
  insertProvider(db, { id: "provider-alpha", slug: "alpha", name: "Alpha", createdAt: NOW });
  insertApiVersion(db, {
    id: "ver-a1",
    providerId: "provider-alpha",
    versionLabel: "1",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: "alpha", version: "1" } }),
    publishedAt: NOW,
  });
  insertApiVersion(db, {
    id: "ver-a2",
    providerId: "provider-alpha",
    versionLabel: "2",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: "alpha", version: "2" } }),
    publishedAt: NOW,
  });
  insertApiChange(db, {
    id: "change-a",
    providerId: "provider-alpha",
    fromVersionId: "ver-a1",
    toVersionId: "ver-a2",
    risk: "breaking",
    summary: "charge() removed",
    diffJson: "[]",
    createdAt: NOW,
  });
  insertMigrationPr(db, {
    id: "pr-a1",
    changeId: "change-a",
    consumerId: "consumer-a",
    title: "Migrate charge() -> charges.create()",
    body: "auto",
    branchName: "warden/charge",
    status: "draft",
    risk: "breaking",
    patchUnified:
      "diff --git a/src/api/client.ts b/src/api/client.ts\n" +
      "--- a/src/api/client.ts\n+++ b/src/api/client.ts\n" +
      "@@ -1,2 +1,2 @@\n-await pay.charge(total);\n+await pay.charges.create({ amount: total });\n",
    githubPrNumber: 4821,
    githubPrUrl: "https://github.com/acme/payments-sdk/pull/4821",
    createdAt: NOW,
  });

  enqueueJob(db, {
    id: "warden-job-a1",
    tenantId: "tenant-a",
    type: "warden.run",
    payload: { goal: "Fix charge()", consumerId: "consumer-a" },
    createdAt: NOW,
  });
  // A verify-failed run is both cancellable and retriable per the queue rules.
  db.raw
    .prepare("UPDATE jobs SET status = 'failed', error_code = 'verify_failed', finished_at = ? WHERE id = ?")
    .run(NOW, "warden-job-a1");

  insertAgentRun(db, {
    id: "warden-run-a1",
    tenantId: "tenant-a",
    jobId: "warden-job-a1",
    goal: "Fix charge()",
    repoPath: "/work/acme-payments-sdk",
    status: "candidate_ready",
    ok: true,
    steps: 5,
    filesChanged: ["src/api/client.ts"],
    resultJson: JSON.stringify({
      attemptStatus: "succeeded",
      code: "…",
      summary: "Rewrote 1 call site",
      changedPaths: ["src/api/client.ts"],
      verifier: { command: "npm test", source: "config", status: "passed" },
      review: { decision: "approve", rationale: "looks good", reviewedAt: NOW },
    }),
    createdAt: NOW,
    finishedAt: NOW,
  });

  // Delivered draft PR for the Warden run (raw insert — the public delivery path
  // requires a full approval binding not needed for this read-surface test).
  db.raw
    .prepare(
      `INSERT INTO warden_candidate_deliveries
       (id, tenant_id, run_id, job_id, status, repository_id, snapshot_id, base_branch,
        expected_base_revision, sealed_path, sealed_sha256, requester_principal_id, rationale,
        draft_pr, draft_pr_number, draft_pr_url, requested_at, delivered_at, updated_at)
       VALUES (?, ?, ?, ?, 'delivered', ?, ?, 'main', ?, ?, ?, ?, ?, 1, 4821, ?, ?, ?, ?)`,
    )
    .run(
      "delivery-a1",
      "tenant-a",
      "warden-run-a1",
      "delivery-job-a1",
      "repo-acme",
      "snap-1",
      "a".repeat(40),
      "/seal/a1",
      "b".repeat(64),
      "human:owner-a@example.com",
      "approved",
      "https://github.com/acme/payments-sdk/pull/4821",
      NOW,
      NOW,
      NOW,
    );

  // A local plan + trajectory artifact for the Warden run only.
  const runRoot = join(cwd, "runs", "warden-run-a1");
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(
    join(runRoot, "plan.json"),
    JSON.stringify({
      id: "plan-a1",
      kind: "spec_diff",
      title: "Migrate charge()",
      goal: "Fix charge()",
      agent: "warden",
      steps: [
        { id: "s1", title: "Locate call sites", action: "search", successCriteria: [], status: "done" },
        { id: "s2", title: "Rewrite", action: "edit", successCriteria: [], status: "done" },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    }),
    "utf8",
  );
  writeFileSync(
    join(runRoot, "trace.jsonl"),
    JSON.stringify({ ts: NOW, type: "tool", message: "edit src/api/client.ts" }) + "\n",
    "utf8",
  );
}

function seedTenantB(db: AppDb): void {
  enqueueJob(db, {
    id: "scan-job-b1",
    tenantId: "tenant-b",
    type: "pipeline.fanout",
    payload: { providerSlug: "beta", tenantId: "tenant-b" },
    createdAt: NOW,
  });
}

function fixture(enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-runs-api-"));
  const db = createDb(join(directory, "api.sqlite"));
  opened.push({ db, directory });
  seedTenantA(db, directory);
  seedTenantB(db);

  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "") as
      | keyof typeof identities
      | undefined;
    const principal = token ? identities[token] : undefined;
    if (principal) {
      c.set("principal", principal);
      c.set("requestId", `request-${token}`);
    }
    return next();
  });
  app.route(
    "/self-serve/runs",
    createSelfServeRunsRoutes({ db, enabled, cwd: directory }),
  );
  return { app, db };
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("self-serve run console", () => {
  it("is inert (404) unless the flag is set", async () => {
    const { app } = fixture(false);
    const list = await app.request("/self-serve/runs", { headers: auth("owner-a") });
    expect(list.status).toBe(404);
    const detail = await app.request("/self-serve/runs/scan-job-a1", { headers: auth("owner-a") });
    expect(detail.status).toBe(404);
  });

  it("lists only the caller's own tenant runs with status, target, and controls", async () => {
    const { app } = fixture();
    const res = await app.request("/self-serve/runs", { headers: auth("owner-a") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<Record<string, unknown>> };
    const ids = body.runs.map((r) => r.id).sort();
    expect(ids).toEqual(["scan-job-a1", "warden-job-a1"]);
    // tenant-b's run is never present.
    expect(ids).not.toContain("scan-job-b1");

    const scan = body.runs.find((r) => r.id === "scan-job-a1")!;
    expect(scan.type).toBe("pipeline.fanout");
    expect(scan.status).toBe("pending");
    expect(scan.target).toBe("alpha");
    expect(scan.canCancel).toBe(true); // pending → cancellable
    expect(scan.canRetry).toBe(false);
    expect(scan.retryReason).toBe("Run is still active");
    expect(scan.triggeredBy).toBeNull(); // scans record no actor — honest null

    const warden = body.runs.find((r) => r.id === "warden-job-a1")!;
    expect(warden.status).toBe("failed");
    expect(warden.target).toBe("acme/payments-sdk");
    expect(warden.goal).toBe("Fix charge()");
    expect(warden.agentRunId).toBe("warden-run-a1");
    expect(warden.triggeredBy).toBe("human:owner-a@example.com");
    expect(warden.canCancel).toBe(true); // failed → cancellable
    expect(warden.canRetry).toBe(true); // failed → retriable
  });

  it("returns a Warden run detail assembled from real data: plan, log, verify, PR, review", async () => {
    const { app } = fixture();
    const res = await app.request("/self-serve/runs/warden-job-a1", { headers: auth("owner-a") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: Record<string, unknown>;
      plan: { title: string; steps: Array<{ title: string; status: string }> } | null;
      log: string | null;
      verification: Array<{ name: string; state: string }>;
      changedPaths: string[];
      prs: Array<{ number: number | null; url: string | null; status: string; patchUnified: string | null }>;
      review: { href: string | null; kind: string | null };
    };

    expect(body.plan?.title).toBe("Migrate charge()");
    expect(body.plan?.steps).toHaveLength(2);
    expect(body.log).toContain("Trajectory warden-run-a1");
    expect(body.log).toContain("edit src/api/client.ts");
    expect(body.verification).toContainEqual({ name: "npm test", state: "passed" });
    expect(body.verification).toContainEqual({ name: "review", state: "approve" });
    expect(body.changedPaths).toEqual(["src/api/client.ts"]);

    expect(body.prs).toHaveLength(1);
    expect(body.prs[0]!.number).toBe(4821);
    expect(body.prs[0]!.url).toBe("https://github.com/acme/payments-sdk/pull/4821");
    expect(body.prs[0]!.patchUnified).toContain("charges.create"); // real patch → DiffView
    // The matched PR wins the review handoff.
    expect(body.review).toEqual({ href: "/prs/pr-a1", kind: "pr" });
  });

  it("gives a scan run honest empty states for the data it never produced", async () => {
    const { app } = fixture();
    const res = await app.request("/self-serve/runs/scan-job-a1", { headers: auth("owner-a") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: unknown;
      log: unknown;
      verification: unknown[];
      changedPaths: unknown[];
      prs: unknown[];
      review: { href: string | null; kind: string | null };
    };
    expect(body.plan).toBeNull();
    expect(body.log).toBeNull();
    expect(body.verification).toEqual([]);
    expect(body.changedPaths).toEqual([]);
    expect(body.prs).toEqual([]);
    expect(body.review).toEqual({ href: null, kind: null });
  });

  it("never lists or serves another tenant's run", async () => {
    const { app } = fixture();
    // tenant-b cannot fetch tenant-a's run by id.
    const cross = await app.request("/self-serve/runs/warden-job-a1", { headers: auth("owner-b") });
    expect(cross.status).toBe(404);
    // tenant-b's own list contains only its run.
    const list = await app.request("/self-serve/runs", { headers: auth("owner-b") });
    const body = (await list.json()) as { runs: Array<{ id: string }> };
    expect(body.runs.map((r) => r.id)).toEqual(["scan-job-b1"]);
  });

  it("reports control reasons that mirror cancel/retry eligibility", async () => {
    const { app, db } = fixture();
    db.raw.prepare("UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?").run(NOW, "scan-job-a1");
    const res = await app.request("/self-serve/runs/scan-job-a1", { headers: auth("owner-a") });
    const body = (await res.json()) as { run: Record<string, unknown> };
    expect(body.run.canCancel).toBe(false);
    expect(body.run.cancelReason).toBe("Run already finished");
    expect(body.run.canRetry).toBe(false);
    expect(body.run.retryReason).toBe("Run completed successfully");
  });

  it("requires an authenticated principal", async () => {
    const { app } = fixture();
    const res = await app.request("/self-serve/runs");
    expect(res.status).toBe(401);
  });
});
