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
  createApiKeyFromToken,
  listApiKeys,
  findApiKeyByToken,
  revokeApiKey,
  countActiveApiKeys,
  insertFeedPoll,
  listFeedPolls,
  latestSuccessfulHash,
  feedPollToApi,
  upsertFeedSchedule,
  listFeedSchedules,
  listFeedScheduleWindows,
  claimFeedScheduleWindow,
  completeFeedScheduleWindow,
  getFeedScheduleHealth,
  insertTenant,
  listTenants,
  updateTenantPlan,
  upsertGitHubInstallation,
  listGitHubInstallations,
  enqueueJob,
  claimNextJob,
  renewJobLease,
  completeJob,
  failJob,
  retryJob,
  cancelJob,
  recoverExpiredJobs,
  getJobRecoverySummary,
  jobToApi,
  getJob,
  listJobs,
  insertAgentRun,
  listAgentRuns,
  insertRepairSession,
  getRepairSession,
  listRepairSessions,
  repairSessionToApi,
  agentRunToApi,
  insertSuppressedPattern,
  listSuppressedPatterns,
  listFindingsForChange,
  createGitHubInstallState,
  consumeGitHubInstallState,
  recordGitHubWebhookDelivery,
  completeGitHubWebhookDelivery,
  failGitHubWebhookDelivery,
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
      expect.arrayContaining([
        "tenant_id",
        "lease_owner",
        "lease_expires_at",
        "available_at",
        "lease_generation",
        "error_code",
        "last_error_at",
        "dead_at",
        "cancelled_at",
      ]),
    );
    expect(
      db.raw
        .prepare(
          `SELECT tenant_id, available_at, lease_generation
           FROM jobs WHERE id = ?`,
        )
        .get("legacy-job"),
    ).toEqual({
      tenant_id: "tenant_default",
      available_at: "2026-01-01T00:00:00.000Z",
      lease_generation: 0,
    });
    expect(indexes.map((index) => index.name)).toContain(
      "jobs_tenant_status_idx",
    );
    expect(indexes.map((index) => index.name)).toContain("jobs_due_idx");
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

  it("stores a deployment-provided API key by hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-configured-key-"));
    dirs.push(dir);
    const db = createDb(join(dir, "configured.sqlite"));
    dbs.push(db);
    const token = `me_${"a".repeat(40)}`;
    const created = createApiKeyFromToken(db, {
      id: newId(),
      name: "deployment",
      tenantId: "tenant_default",
      token,
      createdAt: nowIso(),
    });

    expect(created.prefix).toBe(token.slice(0, 10));
    expect(findApiKeyByToken(db, token)?.tenant_id).toBe("tenant_default");
    expect(JSON.stringify(listApiKeys(db))).not.toContain(token);
  });

  it("feed poll ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-feed-"));
    dirs.push(dir);
    const db = createDb(join(dir, "f.sqlite"));
    dbs.push(db);
    const pollId = newId();
    insertFeedPoll(db, {
      id: pollId,
      providerSlug: "acme-payments",
      openapiUrl: "file:x.json",
      contentHash: "abc123",
      versionLabel: "2.0.0",
      status: "new_version",
      polledAt: nowIso(),
      validationEvidence: {
        id: "validation-1",
        source: "catalog",
        format: "json",
        formatStatus: "accepted",
        schemaVersion: "3.1.0",
        schemaStatus: "accepted",
        sizeBytes: 128,
        contentSha256: "a".repeat(64),
        status: "accepted",
        observedAt: "2026-08-02T12:00:00.000Z",
      },
    });
    const polls = listFeedPolls(db);
    expect(polls).toHaveLength(1);
    expect(feedPollToApi(polls[0]!)).toMatchObject({
      id: pollId,
      validation: {
        id: "validation-1",
        source: "catalog",
        schemaVersion: "3.1.0",
        sizeBytes: 128,
        contentSha256: "a".repeat(64),
        status: "accepted",
      },
    });
    expect(latestSuccessfulHash(db, "acme-payments")).toBe("abc123");
    expect(() =>
      db.raw.prepare(`UPDATE feed_validation_evidence SET status = 'rejected' WHERE id = ?`).run(
        "validation-1",
      ),
    ).toThrow("feed_validation_evidence_immutable");
  });

  it("opens a legacy feed poll ledger with null validation evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-feed-legacy-"));
    dirs.push(dir);
    const path = join(dir, "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE feed_polls (
        id TEXT PRIMARY KEY,
        provider_slug TEXT NOT NULL,
        openapi_url TEXT NOT NULL,
        content_hash TEXT,
        version_label TEXT,
        status TEXT NOT NULL,
        error TEXT,
        version_id TEXT,
        pipeline_change_id TEXT,
        polled_at TEXT NOT NULL
      );
      INSERT INTO feed_polls
        (id, provider_slug, openapi_url, status, polled_at)
      VALUES
        ('legacy-poll', 'legacy', 'file:legacy.json', 'error', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();
    const db = createDb(path);
    dbs.push(db);
    expect(feedPollToApi(listFeedPolls(db)[0]!)).toMatchObject({
      id: "legacy-poll",
      validation: null,
    });
  });

  it("claims schedule windows once and recovers stale and failed health", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-feed-schedule-"));
    dirs.push(dir);
    const db = createDb(join(dir, "schedule.sqlite"));
    dbs.push(db);
    const schedule = upsertFeedSchedule(db, {
      id: "schedule-1",
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      intervalMs: 60_000,
      staleAfterMs: 120_000,
      createdAt: "2026-08-02T12:00:00.000Z",
    });
    expect(getFeedScheduleHealth(db, "2026-08-02T12:03:00.001Z")).toMatchObject({
      status: "degraded",
      counts: { stale: 1, failed: 0 },
    });
    const firstWindow = {
      id: "window-1",
      scheduleId: schedule.id,
      windowStartedAt: "2026-08-02T12:03:00.000Z",
      windowEndsAt: "2026-08-02T12:04:00.000Z",
      attemptedAt: "2026-08-02T12:03:01.000Z",
    };
    expect(claimFeedScheduleWindow(db, firstWindow)).toBe(true);
    expect(claimFeedScheduleWindow(db, { ...firstWindow, id: "window-replay" })).toBe(false);
    expect(completeFeedScheduleWindow(db, {
      scheduleId: schedule.id,
      windowStartedAt: firstWindow.windowStartedAt,
      succeeded: false,
      error: "HTTP 503",
      completedAt: "2026-08-02T12:03:02.000Z",
    })).toBe(true);
    expect(listFeedSchedules(db)[0]).toMatchObject({
      alert_state: "failed",
      consecutive_failures: 1,
      last_error: "HTTP 503",
    });

    const recoveryWindow = {
      id: "window-2",
      scheduleId: schedule.id,
      windowStartedAt: "2026-08-02T12:04:00.000Z",
      windowEndsAt: "2026-08-02T12:05:00.000Z",
      attemptedAt: "2026-08-02T12:04:01.000Z",
    };
    expect(claimFeedScheduleWindow(db, recoveryWindow)).toBe(true);
    expect(completeFeedScheduleWindow(db, {
      scheduleId: schedule.id,
      windowStartedAt: recoveryWindow.windowStartedAt,
      succeeded: true,
      completedAt: "2026-08-02T12:04:02.000Z",
    })).toBe(true);
    expect(getFeedScheduleHealth(db, "2026-08-02T12:04:02.000Z")).toMatchObject({
      status: "healthy",
      schedules: [{
        alertState: "healthy",
        lastSuccessAt: "2026-08-02T12:04:02.000Z",
        consecutiveFailures: 0,
        lastError: null,
      }],
    });
    expect(listFeedScheduleWindows(db, schedule.id).map((window) => window.status)).toEqual([
      "failed",
      "succeeded",
    ]);
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
    expect(getJob(db, "job-a", "tenant-a")?.id).toBe("job-a");
    expect(getJob(db, "job-b", "tenant-a")).toBeUndefined();
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
    expect(retried?.lease_generation).toBe(2);
  });

  it("claims only due jobs and reports tenant recovery state", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-jobs-due-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    enqueueJob(db, {
      id: "job-future",
      tenantId: "tenant-a",
      type: "agent.run",
      payload: { secret: "not-for-api" },
      createdAt: "2026-01-01T00:00:00.000Z",
      availableAt: "2026-01-01T00:10:00.000Z",
    });
    enqueueJob(db, {
      id: "job-due",
      tenantId: "tenant-a",
      type: "agent.run",
      payload: {},
      createdAt: "2026-01-01T00:01:00.000Z",
      availableAt: "2026-01-01T00:01:00.000Z",
    });

    const claimed = claimNextJob(db, ["agent.run"], {
      tenantId: "tenant-a",
      workerId: "worker-a",
      now: "2026-01-01T00:02:00.000Z",
    });
    expect(claimed?.id).toBe("job-due");
    expect(
      getJobRecoverySummary(db, "tenant-a", "2026-01-01T00:02:00.000Z"),
    ).toMatchObject({
      pending: 1,
      due: 0,
      scheduled: 1,
      running: 1,
      deadLetter: 0,
    });
  });

  it("counts verified edits as recoveries but excludes already green work", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-jobs-recovered-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    for (const id of ["already-green", "repaired"]) {
      enqueueJob(db, {
        id,
        tenantId: "tenant-a",
        type: "agent.run",
        payload: {},
        createdAt: id === "already-green"
          ? "2026-01-01T00:00:00.000Z"
          : "2026-01-01T00:00:01.000Z",
      });
      const job = claimNextJob(db, ["agent.run"], {
        tenantId: "tenant-a",
        workerId: "worker-a",
        now: "2026-01-01T00:00:02.000Z",
      });
      expect(job?.id).toBe(id);
      expect(
        completeJob(
          db,
          id,
          {
            ok: true,
            filesChanged: id === "repaired" ? ["client.ts"] : [],
            stoppedReason: id === "repaired" ? "verify_passed" : "already_passing",
          },
          "2026-01-01T00:00:03.000Z",
          {
            workerId: "worker-a",
            leaseGeneration: job!.lease_generation,
          },
        ),
      ).toBe(true);
    }

    expect(getJobRecoverySummary(db, "tenant-a")).toMatchObject({
      done: 2,
      recovered: 1,
    });
  });

  it("fences stale workers and renews the current lease holder", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-jobs-fence-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    enqueueJob(db, {
      id: "job-fenced",
      tenantId: "tenant-a",
      type: "agent.run",
      payload: {},
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const first = claimNextJob(db, ["agent.run"], {
      tenantId: "tenant-a",
      workerId: "worker-a",
      leaseMs: 1_000,
      now: "2026-01-01T00:00:00.000Z",
    })!;
    recoverExpiredJobs(db, "2026-01-01T00:00:02.000Z", "tenant-a");
    const second = claimNextJob(db, ["agent.run"], {
      tenantId: "tenant-a",
      workerId: "worker-b",
      leaseMs: 1_000,
      now: "2026-01-01T00:00:03.000Z",
    })!;

    expect(
      renewJobLease(db, first.id, {
        workerId: "worker-a",
        leaseGeneration: first.lease_generation,
        now: "2026-01-01T00:00:03.250Z",
        leaseMs: 2_000,
      }),
    ).toBe(false);
    expect(
      completeJob(db, first.id, { stale: true }, "2026-01-01T00:00:03.250Z", {
        workerId: "worker-a",
        leaseGeneration: first.lease_generation,
      }),
    ).toBe(false);
    expect(
      failJob(db, first.id, "stale failure", "2026-01-01T00:00:03.250Z", {
        workerId: "worker-a",
        leaseGeneration: first.lease_generation,
      }).applied,
    ).toBe(false);
    expect(
      renewJobLease(db, second.id, {
        workerId: "worker-b",
        leaseGeneration: second.lease_generation,
        now: "2026-01-01T00:00:03.500Z",
        leaseMs: 2_000,
      }),
    ).toBe(true);
    expect(
      completeJob(db, second.id, { ok: true }, "2026-01-01T00:00:04.000Z", {
        workerId: "worker-b",
        leaseGeneration: second.lease_generation,
      }),
    ).toBe(true);
    expect(listJobs(db, 10, "tenant-a")[0].status).toBe("done");
  });

  it("dead-letters exhausted jobs and supports explicit retry and cancellation", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-jobs-recovery-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    enqueueJob(db, {
      id: "job-poison",
      tenantId: "tenant-a",
      type: "agent.run",
      payload: { token: "must-not-leak" },
      maxAttempts: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const claimed = claimNextJob(db, ["agent.run"], {
      tenantId: "tenant-a",
      workerId: "worker-a",
      now: "2026-01-01T00:00:00.000Z",
    })!;
    const failed = failJob(
      db,
      claimed.id,
      "remote response included a credential",
      "2026-01-01T00:00:01.000Z",
      {
        workerId: "worker-a",
        leaseGeneration: claimed.lease_generation,
        errorCode: "github 5xx",
      },
    );
    expect(failed).toEqual({
      applied: true,
      status: "dead_letter",
      availableAt: null,
      deadAt: "2026-01-01T00:00:01.000Z",
    });
    const dead = listJobs(db, 10, "tenant-a")[0];
    expect(dead).toMatchObject({
      status: "dead_letter",
      error_code: "github_5xx",
      dead_at: "2026-01-01T00:00:01.000Z",
    });
    const apiJob = jobToApi(dead);
    expect(apiJob).toMatchObject({
      id: "job-poison",
      status: "dead_letter",
      errorCode: "github_5xx",
    });
    expect(apiJob).not.toHaveProperty("payload_json");
    expect(apiJob).not.toHaveProperty("error");
    expect(apiJob).not.toHaveProperty("lease_owner");
    expect(getJobRecoverySummary(db, "tenant-a").deadLetter).toBe(1);

    expect(
      retryJob(db, "job-poison", {
        tenantId: "tenant-a",
        now: "2026-01-01T00:01:00.000Z",
      }),
    ).toBe(true);
    expect(listJobs(db, 10, "tenant-a")[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      dead_at: null,
    });
    expect(
      cancelJob(db, "job-poison", "2026-01-01T00:01:01.000Z", {
        tenantId: "tenant-a",
        reason: "operator cancelled",
      }),
    ).toBe(true);
    const cancelled = listJobs(db, 10, "tenant-a")[0];
    expect(cancelled).toMatchObject({
      status: "cancelled",
      error_code: "job_cancelled",
      cancelled_at: "2026-01-01T00:01:01.000Z",
    });
    expect(
      claimNextJob(db, ["agent.run"], {
        tenantId: "tenant-a",
        now: "2026-01-01T00:02:00.000Z",
      }),
    ).toBeUndefined();
  });

  it("schedules retry backoff durably", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-jobs-backoff-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    enqueueJob(db, {
      id: "job-backoff",
      tenantId: "tenant-a",
      type: "agent.run",
      payload: {},
      maxAttempts: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const claimed = claimNextJob(db, ["agent.run"], {
      tenantId: "tenant-a",
      workerId: "worker-a",
      now: "2026-01-01T00:00:00.000Z",
    })!;
    const failure = failJob(
      db,
      claimed.id,
      "transient",
      "2026-01-01T00:00:01.000Z",
      {
        workerId: "worker-a",
        leaseGeneration: claimed.lease_generation,
        baseDelayMs: 2_000,
        maxDelayMs: 10_000,
      },
    );
    expect(failure).toMatchObject({
      applied: true,
      status: "pending",
      availableAt: "2026-01-01T00:00:03.000Z",
    });
    expect(
      claimNextJob(db, ["agent.run"], {
        tenantId: "tenant-a",
        now: "2026-01-01T00:00:02.999Z",
      }),
    ).toBeUndefined();
    expect(
      claimNextJob(db, ["agent.run"], {
        tenantId: "tenant-a",
        now: "2026-01-01T00:00:03.000Z",
      })?.id,
    ).toBe("job-backoff");
  });

  it("upserts a queued repair session with its completed result", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-repair-upsert-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    insertRepairSession(db, {
      id: "repair-one",
      tenantId: "tenant_default",
      repoPath: "C:\\repo",
      status: "queued",
      attempts: 0,
      editsCount: 0,
      ok: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    insertRepairSession(db, {
      id: "repair-one",
      tenantId: "tenant_default",
      repoPath: "C:\\repo",
      status: "ok",
      attempts: 2,
      editsCount: 1,
      ok: true,
      reportMd: "verified",
      resultJson: "{\"ok\":true}",
      createdAt: "2026-01-01T00:00:05.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
    });

    expect(getRepairSession(db, "repair-one", "tenant_default")).toMatchObject({
      status: "ok",
      attempts: 2,
      edits_count: 1,
      ok: 1,
      report_md: "verified",
      created_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:01:00.000Z",
    });
  });

  it("sanitizes repair and agent results for tenant API responses", () => {
    const repair = repairSessionToApi({
      id: "repair-safe",
      tenant_id: "tenant-a",
      consumer_id: "consumer-a",
      repo_path: "C:\\customer\\private",
      status: "ok",
      attempts: 2,
      edits_count: 1,
      ok: 1,
      report_md: "verified",
      result_json: JSON.stringify({
        jobId: "job-repair",
        stopReason: "verify_passed",
        plans: [{ source: "private source", verifierOutput: "private log" }],
        failureFingerprints: ["failure"],
        actionFingerprints: ["action"],
      }),
      created_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:01:00.000Z",
    });
    const agent = agentRunToApi({
      id: "agent-safe",
      tenant_id: "tenant-a",
      goal: "repair the API call",
      repo_path: "C:\\customer\\private",
      status: "ok",
      ok: 1,
      steps: 3,
      files_changed_json: "[\"src/client.ts\"]",
      report_md: "verified",
      result_json: JSON.stringify({
        jobId: "job-agent",
        stoppedReason: "verify_passed",
        steps: [{ source: "private source" }],
        verifier: {
          command: "node check.mjs",
          source: "discovered",
          status: "passed",
          output: "private log",
        },
        rollback: {
          performed: true,
          restoredFiles: ["private file"],
          failedFiles: [],
        },
      }),
      created_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:01:00.000Z",
    });

    expect(JSON.stringify(repair)).not.toContain("private source");
    expect(JSON.stringify(repair)).not.toContain("private log");
    expect(repair.result).toMatchObject({ planCount: 1, actionCount: 1 });
    expect(JSON.stringify(agent)).not.toContain("private source");
    expect(JSON.stringify(agent)).not.toContain("private log");
    expect(agent.result?.rollback).toEqual({
      performed: true,
      restoredCount: 1,
      failedCount: 0,
    });
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
    expect(
      recordGitHubWebhookDelivery(
        db,
        "delivery-1",
        "ping",
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      recordGitHubWebhookDelivery(
        db,
        "delivery-1",
        "ping",
        "2026-01-01T00:01:00.000Z",
      ),
    ).toBe(false);
    expect(
      recordGitHubWebhookDelivery(
        db,
        "delivery-stale",
        "push",
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      recordGitHubWebhookDelivery(
        db,
        "delivery-stale",
        "push",
        "2026-01-01T00:06:00.000Z",
      ),
    ).toBe(true);
    expect(
      failGitHubWebhookDelivery(
        db,
        "delivery-1",
        "2026-01-01T00:01:01.000Z",
        "transient",
      ),
    ).toBe(true);
    expect(
      recordGitHubWebhookDelivery(
        db,
        "delivery-1",
        "ping",
        "2026-01-01T00:01:02.000Z",
      ),
    ).toBe(true);
    expect(
      completeGitHubWebhookDelivery(
        db,
        "delivery-1",
        "2026-01-01T00:01:03.000Z",
      ),
    ).toBe(true);
    expect(
      recordGitHubWebhookDelivery(
        db,
        "delivery-1",
        "ping",
        "2026-01-01T00:10:00.000Z",
      ),
    ).toBe(false);
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
