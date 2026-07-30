import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  insertProvider,
  recordAudit,
  listProviders,
  listAudit,
  createApiKey,
  listApiKeys,
  findApiKeyByToken,
  revokeApiKey,
  countActiveApiKeys,
  insertFeedPoll,
  listFeedPolls,
  latestSuccessfulHash,
  insertTenant,
  listTenants,
  updateTenantPlan,
  upsertGitHubInstallation,
  listGitHubInstallations,
  enqueueJob,
  claimNextJob,
  recoverExpiredJobs,
  listJobs,
  insertAgentRun,
  listAgentRuns,
  insertRepairSession,
  listRepairSessions,
  insertSuppressedPattern,
  listSuppressedPatterns,
  listFindingsForChange,
  createGitHubInstallState,
  consumeGitHubInstallState,
  recordGitHubWebhookDelivery,
  findPrByRepositoryAndNumber,
  insertApiVersionIfAbsent,
} from "./index.js";
import { newId, nowIso } from "@mendpoint/shared";

const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];

afterEach(() => {
  while (dbs.length) {
    const db = dbs.pop();
    try {
      db?.raw.close?.();
    } catch {
      /* ignore */
    }
  }
  while (dirs.length) {
    const d = dirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore lock races on Windows */
      }
    }
  }
});

describe("db", () => {
  it("upgrades a prior jobs schema before creating tenant indexes", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-db-upgrade-"));
    dirs.push(dir);
    const path = join(dir, "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        error TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      INSERT INTO jobs (id, type, payload_json, created_at)
      VALUES ('legacy-job', 'agent.run', '{}', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const db = createDb(path);
    dbs.push(db);
    const columns = db.raw
      .prepare("PRAGMA table_info(jobs)")
      .all() as Array<{ name: string }>;
    const indexes = db.raw
      .prepare("PRAGMA index_list(jobs)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["tenant_id", "lease_owner", "lease_expires_at"]),
    );
    expect(
      db.raw.prepare("SELECT tenant_id FROM jobs WHERE id = ?").get("legacy-job"),
    ).toEqual({ tenant_id: "tenant_default" });
    expect(indexes.map((index) => index.name)).toContain(
      "jobs_tenant_status_idx",
    );
  });

  it("creates tables and records audit", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-db-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    insertProvider(db, {
      id: newId(),
      slug: "x",
      name: "X",
      website: null,
      createdAt: nowIso(),
    });
    recordAudit(db, {
      tenantId: "tenant_default",
      actor: "test",
      action: "ping",
      resourceType: "system",
    });
    expect(listProviders(db)).toHaveLength(1);
    expect(listAudit(db).some((a) => a.action === "ping")).toBe(true);
  });

  it("api keys hash and revoke", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-keys-"));
    dirs.push(dir);
    const db = createDb(join(dir, "k.sqlite"));
    dbs.push(db);
    const created = createApiKey(db, {
      id: newId(),
      name: "ci",
      tenantId: "t1",
      createdAt: nowIso(),
    });
    expect(created.token.startsWith("me_")).toBe(true);
    expect(findApiKeyByToken(db, created.token)?.tenant_id).toBe("t1");
    expect(findApiKeyByToken(db, "me_nope")).toBeUndefined();
    expect(countActiveApiKeys(db)).toBe(1);
    expect(revokeApiKey(db, created.id, nowIso(), "other-tenant")).toBe(false);
    expect(findApiKeyByToken(db, created.token)).toBeDefined();
    expect(listApiKeys(db, "other-tenant")).toEqual([]);
    expect(listApiKeys(db, "t1")).toHaveLength(1);
    expect(revokeApiKey(db, created.id, nowIso(), "t1")).toBe(true);
    expect(findApiKeyByToken(db, created.token)).toBeUndefined();
    expect(countActiveApiKeys(db)).toBe(0);
  });

  it("feed poll ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-feed-"));
    dirs.push(dir);
    const db = createDb(join(dir, "f.sqlite"));
    dbs.push(db);
    insertFeedPoll(db, {
      id: newId(),
      providerSlug: "acme-payments",
      openapiUrl: "file:x.json",
      contentHash: "abc123",
      versionLabel: "2.0.0",
      status: "new_version",
      polledAt: nowIso(),
    });
    expect(listFeedPolls(db)).toHaveLength(1);
    expect(latestSuccessfulHash(db, "acme-payments")).toBe("abc123");
  });

  it("tenants and github installations", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-tenant-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    // default tenant seeded by migrate
    expect(listTenants(db).some((t) => t.slug === "default")).toBe(true);
    const id = newId();
    insertTenant(db, {
      id,
      slug: "acme-co",
      name: "Acme Co",
      plan: "free",
      createdAt: nowIso(),
    });
    updateTenantPlan(db, id, "pro");
    expect(listTenants(db).find((t) => t.id === id)?.plan).toBe("pro");
    upsertGitHubInstallation(db, {
      id: newId(),
      installationId: "42",
      accountLogin: "acme-co",
      tenantId: id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    expect(listGitHubInstallations(db)).toHaveLength(1);
    expect(listGitHubInstallations(db, id)).toHaveLength(1);
    expect(listGitHubInstallations(db, "tenant_default")).toEqual([]);
    expect(() =>
      upsertGitHubInstallation(db, {
        id: newId(),
        installationId: "42",
        accountLogin: "attacker",
        tenantId: "tenant_default",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }),
    ).toThrow("github_installation_tenant_mismatch");
  });

  it("isolates tenant-owned durable records and findings", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-isolation-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    db.raw.exec("PRAGMA foreign_keys = OFF");
    const at = nowIso();
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      const suffix = tenantId.at(-1)!;
      db.raw
        .prepare(
          `INSERT INTO consumers
           (id, name, github_owner, github_repo, tenant_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(`consumer-${suffix}`, tenantId, `owner-${suffix}`, `repo-${suffix}`, tenantId, at);
      db.raw
        .prepare(
          `INSERT INTO impact_findings
           (id, change_id, consumer_id, file_path, line_start, line_end, symbol, confidence, evidence_json)
           VALUES (?, 'change-1', ?, ?, 1, 1, 'x', 'high', '{}')`,
        )
        .run(`finding-${suffix}`, `consumer-${suffix}`, `secret-${suffix}.ts`);
      enqueueJob(db, {
        id: `job-${suffix}`,
        tenantId,
        type: "agent.run",
        payload: {},
        createdAt: at,
      });
      insertAgentRun(db, {
        id: `agent-${suffix}`,
        tenantId,
        goal: "test",
        repoPath: `C:\\secret-${suffix}`,
        status: "queued",
        ok: false,
        steps: 0,
        createdAt: at,
      });
      insertRepairSession(db, {
        id: `repair-${suffix}`,
        tenantId,
        consumerId: `consumer-${suffix}`,
        repoPath: `C:\\secret-${suffix}`,
        status: "queued",
        attempts: 0,
        editsCount: 0,
        ok: false,
        createdAt: at,
      });
      insertSuppressedPattern(db, {
        id: `suppressed-${suffix}`,
        tenantId,
        consumerId: `consumer-${suffix}`,
        pattern: `secret-${suffix}`,
        createdAt: at,
      });
      recordAudit(db, {
        tenantId,
        actor: "test",
        action: `secret-${suffix}`,
        resourceType: "test",
      });
    }

    expect(listJobs(db, 50, "tenant-a").map((row) => row.id)).toEqual(["job-a"]);
    expect(listAgentRuns(db, 50, "tenant-a").map((row) => row.id)).toEqual(["agent-a"]);
    expect(listRepairSessions(db, 50, "tenant-a").map((row) => row.id)).toEqual([
      "repair-a",
    ]);
    expect(
      listSuppressedPatterns(db, { tenantId: "tenant-a" }).map((row) => row.id),
    ).toEqual(["suppressed-a"]);
    expect(
      listFindingsForChange(db, "change-1", "tenant-a").map((row) => row.file_path),
    ).toEqual(["secret-a.ts"]);
    expect(listAudit(db, "tenant-a").map((row) => row.action)).toEqual(["secret-a"]);
  });

  it("claims jobs atomically and recovers expired leases", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-jobs-"));
    dirs.push(dir);
    const path = join(dir, "t.sqlite");
    const db = createDb(path);
    const peer = createDb(path);
    dbs.push(db, peer);
    enqueueJob(db, {
      id: "job-a",
      tenantId: "tenant-a",
      type: "agent.run",
      payload: {},
      maxAttempts: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const first = claimNextJob(db, ["agent.run"], {
      tenantId: "tenant-a",
      workerId: "worker-a",
      leaseMs: 1_000,
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(first?.lease_owner).toBe("worker-a");
    expect(
      claimNextJob(peer, ["agent.run"], {
        tenantId: "tenant-a",
        workerId: "worker-b",
        now: "2026-01-01T00:00:00.500Z",
      }),
    ).toBeUndefined();

    expect(
      recoverExpiredJobs(db, "2026-01-01T00:00:02.000Z", "tenant-a"),
    ).toBe(1);
    const retried = claimNextJob(peer, ["agent.run"], {
      tenantId: "tenant-a",
      workerId: "worker-b",
      now: "2026-01-01T00:00:03.000Z",
    });
    expect(retried?.attempts).toBe(2);
    expect(retried?.lease_owner).toBe("worker-b");
  });

  it("consumes install state and webhook deliveries once", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-github-state-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    createGitHubInstallState(db, {
      state: "opaque-state",
      tenantId: "tenant-a",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:10:00.000Z",
    });
    expect(
      consumeGitHubInstallState(
        db,
        "opaque-state",
        "tenant-b",
        "2026-01-01T00:01:00.000Z",
      ),
    ).toBe(false);
    expect(
      consumeGitHubInstallState(
        db,
        "opaque-state",
        "tenant-a",
        "2026-01-01T00:01:00.000Z",
      ),
    ).toBe(true);
    expect(
      consumeGitHubInstallState(
        db,
        "opaque-state",
        "tenant-a",
        "2026-01-01T00:02:00.000Z",
      ),
    ).toBe(false);
    expect(recordGitHubWebhookDelivery(db, "delivery-1", "ping", nowIso())).toBe(true);
    expect(recordGitHubWebhookDelivery(db, "delivery-1", "ping", nowIso())).toBe(false);
  });

  it("matches webhook pull requests by repository and number", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-pr-identity-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    db.raw.exec("PRAGMA foreign_keys = OFF");
    const at = nowIso();
    for (const suffix of ["a", "b"]) {
      db.raw
        .prepare(
          `INSERT INTO consumers
           (id, name, github_owner, github_repo, tenant_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(`consumer-${suffix}`, suffix, "acme", `repo-${suffix}`, `tenant-${suffix}`, at);
      db.raw
        .prepare(
          `INSERT INTO migration_prs
           (id, change_id, consumer_id, title, body, branch_name, status, risk, patch_unified,
            github_pr_number, created_at)
           VALUES (?, 'change-1', ?, ?, '', ?, 'open', 'breaking', '', 7, ?)`,
        )
        .run(`pr-${suffix}`, `consumer-${suffix}`, `title-${suffix}`, `branch-${suffix}`, at);
    }
    expect(findPrByRepositoryAndNumber(db, "ACME", "repo-b", 7)?.id).toBe("pr-b");
    expect(findPrByRepositoryAndNumber(db, "acme", "missing", 7)).toBeUndefined();
  });

  it("deduplicates provider versions atomically by content", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-version-content-"));
    dirs.push(dir);
    const path = join(dir, "t.sqlite");
    const db = createDb(path);
    const peer = createDb(path);
    dbs.push(db, peer);
    const at = nowIso();
    insertProvider(db, {
      id: "provider-1",
      slug: "provider-1",
      name: "Provider",
      createdAt: at,
    });
    const first = insertApiVersionIfAbsent(db, {
      id: "version-a",
      providerId: "provider-1",
      versionLabel: "a",
      openapiJson: "{\"openapi\":\"3.1.0\"}",
      publishedAt: at,
    });
    const duplicate = insertApiVersionIfAbsent(peer, {
      id: "version-b",
      providerId: "provider-1",
      versionLabel: "b",
      openapiJson: "{\"openapi\":\"3.1.0\"}",
      publishedAt: at,
    });
    expect(first.inserted).toBe(true);
    expect(duplicate).toEqual({
      inserted: false,
      id: "version-a",
      contentHash: first.contentHash,
    });
    const count = db.raw
      .prepare(`SELECT COUNT(*) AS count FROM api_versions WHERE provider_id = ?`)
      .get("provider-1") as { count: number };
    expect(count.count).toBe(1);
  });
});
