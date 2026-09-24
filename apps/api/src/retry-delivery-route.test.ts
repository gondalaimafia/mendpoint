/**
 * POST /migration-prs/:id/retry-delivery (PR #606 D9/D10) driven through the REAL
 * app with API_AUTH=required and a real owner API key. Covers the re-check fixes:
 *   - point 3: the endpoint reopens a terminal github_delivery_abandoned row.
 *   - point 4: a dead-lettered delivery-retry job is RESET to pending (not left
 *     stranded behind its spent, deterministic id), and the response reports it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const NOW = "2026-09-23T12:00:00.000Z";

let app: { request: (input: string, init?: RequestInit) => Promise<Response> };
let db: import("@mendpoint/db").AppDb;
let dbMod: typeof import("@mendpoint/db");
let tempDir: string;
let token = "";

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

const ENV_KEYS = ["MENDPOINT_DATA_DIR", "API_AUTH", "MENDPOINT_APPLICATION_DATA_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tempDir = mkdtempSync(join(tmpdir(), "mendpoint-retry-delivery-route-"));
  process.env.MENDPOINT_DATA_DIR = tempDir;
  process.env.API_AUTH = "required";
  process.env.MENDPOINT_APPLICATION_DATA_KEY ??= "a".repeat(64);

  dbMod = await import("@mendpoint/db");
  const server = (await import("./server.js")) as unknown as { app: typeof app; db: typeof db };
  app = server.app;
  db = server.db;

  const created = dbMod.createTenant(db, {
    tenantId: "tenant-a",
    slug: "tenant-a",
    name: "Tenant A",
    owner: { issuer: "https://issuer.example", subject: "owner-a", email: "a@example.com", displayName: "Owner A" },
    apiKeyId: "key-a",
    createdAt: NOW,
  });
  if (!created.apiKey) throw new Error("createTenant did not return an owner API key");
  token = created.apiKey.token;

  dbMod.insertProvider(db, { id: "provider-r", slug: "acme-r", name: "Acme R", tenantId: null, createdAt: NOW });
  dbMod.insertApiVersion(db, { id: "v1", providerId: "provider-r", versionLabel: "1.0.0", openapiJson: '{"info":{"version":"1.0.0"}}', changelogMd: null, publishedAt: NOW });
  dbMod.insertApiVersion(db, { id: "v2", providerId: "provider-r", versionLabel: "2.0.0", openapiJson: '{"info":{"version":"2.0.0"}}', changelogMd: null, publishedAt: NOW });
  dbMod.insertApiChange(db, { id: "change-r", providerId: "provider-r", fromVersionId: "v1", toVersionId: "v2", risk: "breaking", summary: "s", diffJson: "{}", createdAt: NOW });
  dbMod.insertConsumer(db, { id: "consumer-r", name: "Retry Shop", githubOwner: "org", githubRepo: "retry-shop", installationId: null, tenantId: "tenant-a", createdAt: NOW });
  dbMod.insertConsumerRepo(db, { id: "repo-r", consumerId: "consumer-r", localPath: tempDir, defaultBranch: "main", createdAt: NOW });
}, 60_000);

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { db.raw.close?.(); } catch { /* ignore */ }
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seedPr(id: string, status: string, originFanoutJson: string | null = JSON.stringify({ providerSlug: "acme-r", securityScanAttested: true })): void {
  dbMod.insertMigrationPr(db, {
    id, changeId: "change-r", consumerId: "consumer-r", title: "Retry candidate",
    body: "b", branchName: `mendpoint/${id}`, status, risk: "low", patchUnified: "diff", createdAt: NOW,
    originFanoutJson,
  });
}

describe("POST /migration-prs/:id/retry-delivery", () => {
  it("3: reopens a terminal github_delivery_abandoned row and queues a delivery-only retry", async () => {
    seedPr("pr-abandoned", "github_delivery_abandoned");
    const res = await app.request("/migration-prs/pr-abandoned/retry-delivery", { method: "POST", headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "pr-abandoned", status: "delivery_failed", queued: "enqueued" });
    expect(dbMod.getPr(db, "pr-abandoned", "tenant-a")?.status).toBe("delivery_failed");
    const job = dbMod.getJob(db, "pipeline-delivery-retry:pr-abandoned", "tenant-a");
    expect(job?.type).toBe("pipeline.delivery-retry");
    expect(job?.status).toBe("pending");
  });

  it("rejects a status that is not a stuck delivery (409)", async () => {
    seedPr("pr-draft", "draft");
    const res = await app.request("/migration-prs/pr-draft/retry-delivery", { method: "POST", headers: auth() });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "retry_delivery_not_allowed", status: "draft" });
  });

  it("4: resets a dead-lettered delivery-retry job to pending (never stranded behind its spent id) and reports it", async () => {
    seedPr("pr-deadletter", "delivery_failed");
    // A prior delivery-retry job for this row exhausted its attempts and dead-lettered.
    dbMod.enqueueJob(db, { id: "pipeline-delivery-retry:pr-deadletter", tenantId: "tenant-a", type: "pipeline.delivery-retry", payload: { prId: "pr-deadletter" }, maxAttempts: 50, createdAt: NOW });
    db.raw.prepare("UPDATE jobs SET status = 'dead_letter', attempts = 50, error = 'exhausted', dead_at = ? WHERE id = ?").run(NOW, "pipeline-delivery-retry:pr-deadletter");

    const res = await app.request("/migration-prs/pr-deadletter/retry-delivery", { method: "POST", headers: auth() });
    expect(res.status).toBe(200);
    // The endpoint reports the reset (never returns ok while the job stays dead).
    expect(await res.json()).toMatchObject({ ok: true, status: "delivery_failed", queued: "reset" });
    const job = dbMod.getJob(db, "pipeline-delivery-retry:pr-deadletter", "tenant-a");
    expect(job?.status).toBe("pending");
    expect(job?.attempts).toBe(0);
  });

  it("2: a non-replayable row (no artifact, no origin payload) tells the operator to re-run, not queued", async () => {
    seedPr("pr-unreplayable", "delivery_failed", null);
    const res = await app.request("/migration-prs/pr-unreplayable/retry-delivery", { method: "POST", headers: auth() });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      status: "delivery_blocked",
      error: "github_delivery_replay_unavailable",
      action: "rerun_change_required",
    });
    // No delivery-retry job was queued (nothing to replay), and the row is blocked.
    expect(dbMod.getJob(db, "pipeline-delivery-retry:pr-unreplayable", "tenant-a")).toBeUndefined();
    const pr = dbMod.getPr(db, "pr-unreplayable", "tenant-a");
    expect(pr?.status).toBe("delivery_blocked");
    expect(pr?.delivery_error).toBe("github_delivery_replay_unavailable");
  });

  it("1b: an operator retry resets the automatic-replay counter for a fresh budget", async () => {
    seedPr("pr-exhausted", "github_delivery_abandoned");
    // Simulate a row that already exhausted its automatic replays.
    db.raw.prepare("UPDATE migration_prs SET replay_count = 3 WHERE id = ?").run("pr-exhausted");
    const res = await app.request("/migration-prs/pr-exhausted/retry-delivery", { method: "POST", headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "delivery_failed" });
    expect(dbMod.getPr(db, "pr-exhausted", "tenant-a")?.replay_count).toBe(0);
  });

  it("#717: an operator retry clears the stale delivery_error AND advances the replay generation", async () => {
    seedPr("pr-717", "delivery_failed");
    // A prior dead-letter stamped a terminal code on the row.
    db.raw.prepare("UPDATE migration_prs SET delivery_error = 'github_delivery_replay_failed' WHERE id = ?").run("pr-717");
    const before = dbMod.getPr(db, "pr-717", "tenant-a")!.replay_generation;
    const res = await app.request("/migration-prs/pr-717/retry-delivery", { method: "POST", headers: auth() });
    expect(res.status).toBe(200);
    const pr = dbMod.getPr(db, "pr-717", "tenant-a");
    // Clearing the stale code is what keeps the endpoint from reporting a fresh start on a
    // row that still reads terminal (removing the clear leaves this red).
    expect(pr?.delivery_error ?? null).toBeNull();
    // Advancing the generation is what gives the next replay a distinct admission key
    // instead of reusing the spent delivery-replay:<pr>:<gen> key, whose reservation was
    // already released, so settlement no longer fails with mcu_settlement_persistence_failed.
    expect(pr?.replay_generation).toBe(before + 1);
  });
});
