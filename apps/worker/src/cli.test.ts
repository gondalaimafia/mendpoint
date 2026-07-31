import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  enqueueJob,
  insertConsumer,
  insertConsumerRepo,
  getRepairSession,
  listJobs,
} from "@mendpoint/db";
import { nowIso } from "@mendpoint/shared";
import {
  parseArgs,
  parseIntervalMs,
  parseLeaseMs,
  processJobsOnce,
  resolveWorkerRepoPath,
  retryDelayMs,
  validateWorkerProductionEnv,
  runUnseenVersion,
  writeWorkerHeartbeat,
} from "./cli.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("worker runtime", () => {
  it("validates intervals and applies bounded backoff", () => {
    expect(parseIntervalMs("5000")).toBe(5000);
    expect(() => parseIntervalMs("nope")).toThrow(/integer/i);
    expect(() => parseIntervalMs("999")).toThrow(/between/i);
    expect(retryDelayMs(1, 1000)).toBe(1000);
    expect(retryDelayMs(4, 1000)).toBe(8000);
    expect(retryDelayMs(20, 1000, 10_000)).toBe(10_000);
    expect(parseLeaseMs("900000")).toBe(900_000);
    expect(() => parseLeaseMs("NaN")).toThrow(/JOB_LEASE_MS/);
    expect(parseArgs(["--interval", "2000"]).intervalMs).toBe(2000);
  });

  it("writes an atomic worker heartbeat", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-worker-heartbeat-"));
    dirs.push(dir);
    const heartbeatPath = join(dir, "state", "worker-heartbeat.json");
    writeWorkerHeartbeat(heartbeatPath, {
      ok: true,
      workerId: "worker-test",
      recordedAt: "2026-07-30T00:00:00.000Z",
      jobs: { claimed: 1, succeeded: 1, failed: 0, retried: 0 },
      feedPollingEnabled: true,
      feedPollOk: true,
    });

    expect(JSON.parse(readFileSync(heartbeatPath, "utf8"))).toMatchObject({
      ok: true,
      workerId: "worker-test",
      feedPollOk: true,
    });
    expect(() =>
      writeWorkerHeartbeat("relative.json", {
        ok: true,
        workerId: "worker-test",
        recordedAt: "2026-07-30T00:00:00.000Z",
        jobs: { claimed: 0, succeeded: 0, failed: 0, retried: 0 },
        feedPollingEnabled: false,
        feedPollOk: true,
      }),
    ).toThrow(/absolute/i);
  });

  it("requires production repositories to stay under the configured mount", () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-worker-"));
    dirs.push(parent);
    const allowed = join(parent, "allowed");
    const tenantA = join(allowed, "tenant-a");
    const tenantB = join(allowed, "tenant-b");
    const repo = join(tenantA, "repo");
    const otherTenantRepo = join(tenantB, "repo");
    const outside = join(parent, "outside");
    mkdirSync(repo, { recursive: true });
    mkdirSync(otherTenantRepo, { recursive: true });
    mkdirSync(outside);

    expect(
      resolveWorkerRepoPath(repo, "tenant-a", {
        NODE_ENV: "production",
        MENDPOINT_REPOS_DIR: allowed,
      }),
    ).toBe(repo);
    expect(() =>
      resolveWorkerRepoPath(otherTenantRepo, "tenant-a", {
        NODE_ENV: "production",
        MENDPOINT_REPOS_DIR: allowed,
      }),
    ).toThrow(/tenant repository root/i);
    expect(() =>
      resolveWorkerRepoPath(tenantA, "tenant-a", {
        NODE_ENV: "production",
        MENDPOINT_REPOS_DIR: allowed,
      }),
    ).toThrow(/tenant repository root/i);
    expect(() =>
      resolveWorkerRepoPath(outside, "tenant-a", {
        NODE_ENV: "production",
        MENDPOINT_REPOS_DIR: allowed,
      }),
    ).toThrow(/tenant repository root/i);
    expect(() =>
      resolveWorkerRepoPath(repo, "../tenant-b", {
        NODE_ENV: "production",
        MENDPOINT_REPOS_DIR: allowed,
      }),
    ).toThrow(/path safe/i);
    expect(() =>
      resolveWorkerRepoPath(repo, "tenant-a", { NODE_ENV: "production" }),
    ).toThrow(/MENDPOINT_REPOS_DIR/);
  });

  it("dead letters an unrepairable Warden run without preserving writes", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-worker-job-"));
    dirs.push(parent);
    const repo = join(parent, "repo");
    mkdirSync(repo);
    writeFileSync(
      join(repo, "check.mjs"),
      "process.exit(1);\n",
    );
    const db = createDb(join(parent, "jobs.sqlite"));
    insertConsumer(db, {
      id: "consumer-runtime-test",
      name: "Runtime test",
      githubOwner: "acme",
      githubRepo: "runtime-test",
      tenantId: "tenant_test",
      createdAt: nowIso(),
    });
    insertConsumerRepo(db, {
      id: "repo-runtime-test",
      consumerId: "consumer-runtime-test",
      localPath: repo,
      createdAt: nowIso(),
    });
    enqueueJob(db, {
      id: "job-runtime-test",
      tenantId: "tenant_test",
      type: "agent.run",
      maxAttempts: 2,
      createdAt: nowIso(),
      payload: {
        goal: "inspect an empty fixture",
        consumerId: "consumer-runtime-test",
        verifyCommand: "node check.mjs",
        maxSteps: 1,
      },
    });
    const healthyRepo = join(parent, "healthy-repo");
    mkdirSync(healthyRepo);
    writeFileSync(join(healthyRepo, "check.mjs"), "process.exit(0);\n");
    insertConsumer(db, {
      id: "consumer-runtime-healthy",
      name: "Healthy runtime test",
      githubOwner: "acme",
      githubRepo: "runtime-healthy",
      tenantId: "tenant_test",
      createdAt: new Date(Date.now() + 1).toISOString(),
    });
    insertConsumerRepo(db, {
      id: "repo-runtime-healthy",
      consumerId: "consumer-runtime-healthy",
      localPath: healthyRepo,
      createdAt: nowIso(),
    });
    enqueueJob(db, {
      id: "job-runtime-healthy",
      tenantId: "tenant_test",
      type: "agent.run",
      createdAt: new Date(Date.now() + 1).toISOString(),
      payload: {
        goal: "verify a healthy fixture",
        consumerId: "consumer-runtime-healthy",
        verifyCommand: "node check.mjs",
        maxSteps: 1,
      },
    });

    const result = await processJobsOnce(db, {
      tenantId: "tenant_test",
      workerId: "worker-test",
      leaseMs: 5_000,
    });
    expect(result).toEqual({
      claimed: 2,
      succeeded: 1,
      failed: 1,
      retried: 0,
    });
    const jobs = listJobs(db, 10, "tenant_test");
    expect(jobs.find((job) => job.id === "job-runtime-test")).toMatchObject({
      status: "dead_letter",
      attempts: 1,
      lease_owner: null,
      error_code: "warden_needs_human",
    });
    expect(jobs.find((job) => job.id === "job-runtime-healthy")).toMatchObject({
      status: "done",
      attempts: 1,
      lease_owner: null,
    });
    db.raw.close();
  });

  it("runs a queued repair through verification and persists the recovered session", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-worker-repair-"));
    dirs.push(parent);
    const repo = join(parent, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "client.ts"), "export const oldField = 1;\n");
    writeFileSync(
      join(repo, "check.mjs"),
      "import { readFileSync } from 'node:fs'; const s=readFileSync('client.ts','utf8'); process.exit(s.includes('newField')&&!s.includes('oldField')?0:1);\n",
    );
    const db = createDb(join(parent, "jobs.sqlite"));
    insertConsumer(db, {
      id: "consumer-repair-test",
      name: "Repair runtime test",
      githubOwner: "acme",
      githubRepo: "repair-test",
      tenantId: "tenant_test",
      createdAt: nowIso(),
    });
    insertConsumerRepo(db, {
      id: "repo-repair-test",
      consumerId: "consumer-repair-test",
      localPath: repo,
      createdAt: nowIso(),
    });
    enqueueJob(db, {
      id: "job-repair-test",
      tenantId: "tenant_test",
      type: "repair.run",
      maxAttempts: 5,
      createdAt: nowIso(),
      payload: {
        sessionId: "session-repair-test",
        consumerId: "consumer-repair-test",
        renameMap: { oldField: "newField" },
        maxAttempts: 3,
      },
    });

    await expect(
      processJobsOnce(db, {
        tenantId: "tenant_test",
        workerId: "worker-test",
        leaseMs: 5_000,
      }),
    ).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      failed: 0,
      retried: 0,
    });
    expect(readFileSync(join(repo, "client.ts"), "utf8")).toContain("newField");
    expect(listJobs(db, 10, "tenant_test")[0]).toMatchObject({
      id: "job-repair-test",
      status: "done",
      attempts: 1,
    });
    expect(getRepairSession(db, "session-repair-test", "tenant_test")).toMatchObject({
      status: "verified",
      ok: 1,
    });
    db.raw.close();
  });

  it("marks a watched version seen only after pipeline success", async () => {
    const seen = new Set<string>();
    let attempts = 0;
    const run = async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
      return "ok";
    };
    await expect(runUnseenVersion(seen, "acme:1>2", run)).rejects.toThrow("transient");
    expect(seen.has("acme:1>2")).toBe(false);
    await expect(runUnseenVersion(seen, "acme:1>2", run)).resolves.toBe("ok");
    expect(seen.has("acme:1>2")).toBe(true);
    await expect(runUnseenVersion(seen, "acme:1>2", run)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("requires explicit production delivery and repository configuration", () => {
    expect(validateWorkerProductionEnv({ NODE_ENV: "production" })).toEqual(
      expect.arrayContaining([
        expect.stringContaining("GITHUB_MODE"),
        expect.stringContaining("DATABASE_URL"),
        expect.stringContaining("MENDPOINT_REPOS_DIR"),
      ]),
    );
  });

  it("requires a PAT for real production delivery", () => {
    const repos = mkdtempSync(join(tmpdir(), "mendpoint-worker-repos-"));
    dirs.push(repos);
    const base = {
      NODE_ENV: "production",
      GITHUB_MODE: "real",
      MENDPOINT_DATA_DIR: repos,
      MENDPOINT_REPOS_DIR: repos,
    };
    expect(
      validateWorkerProductionEnv({
        ...base,
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: "private-key",
      }),
    ).toContain("GITHUB_TOKEN is required for real worker delivery");
    expect(
      validateWorkerProductionEnv({
        ...base,
        GITHUB_TOKEN: "fine-grained-pat",
      }),
    ).toEqual([]);
  });
});
