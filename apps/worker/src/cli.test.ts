import { createHash, generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  bindConsumerRepoSnapshot,
  enqueueJob,
  getAgentRun,
  insertAgentRun,
  insertConsumer,
  insertConsumerRepo,
  insertConnectedRepository,
  insertRepositorySnapshot,
  insertRepositorySnapshotPolicy,
  upsertScmConnection,
  getRepairSession,
  listJobs,
} from "@mendpoint/db";
import { nowIso } from "@mendpoint/shared";
import {
  parseArgs,
  parseIntervalMs,
  parseLeaseMs,
  parseJobConcurrency,
  classifyJobFailure,
  enqueueFeedPipelineJob,
  processJobsOnce,
  maintainWardenArtifactsOnce,
  resolveWardenModelSourcePolicy,
  resolveWorkerRepoPath,
  retryDelayMs,
  waitForWorkerDelay,
  startIndependentWorkerLanes,
  startConcurrentJobLanes,
  validateWorkerProductionEnv,
  runUnseenVersion,
  transformerPilotHeartbeatAfterFailure,
  transformerPilotHeartbeatAfterResult,
  transformerPilotHeartbeatStarted,
  writeWorkerHeartbeat,
} from "./cli.js";

const dirs: string[] = [];

function snapshotManifest(root: string): string {
  const files: Array<Record<string, unknown>> = [];
  const visit = (directory: string, prefix = ""): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const path = prefix ? `${prefix}/${name}` : name;
      const info = lstatSync(absolute);
      if (info.isDirectory()) {
        visit(absolute, path);
        continue;
      }
      const content = readFileSync(absolute);
      files.push({
        path,
        mode: (info.mode & 0o111) !== 0 ? "100755" : "100644",
        kind: "file",
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  };
  visit(root);
  files.sort((left, right) => String(left.path).localeCompare(String(right.path)));
  return createHash("sha256")
    .update(JSON.stringify({ files, submodules: [], sparsePaths: [] }))
    .digest("hex");
}

const FAST_CHECK =
  "import { path } from './client.js';\nprocess.exit(path === '/v1/charges' ? 0 : 1);\n";

function slowCheck(delayMs: number): string {
  return (
    "import { path } from './client.js';\n" +
    `await new Promise((resolve) => setTimeout(resolve, ${delayMs}));\n` +
    "process.exit(path === '/v1/charges' ? 0 : 1);\n"
  );
}

/**
 * Builds the full exact-snapshot Warden job fixture (connection, repo, snapshot,
 * policy, consumer binding, and a queued agent.run job) so lifecycle tests can
 * exercise the real attempt path without duplicating scaffolding.
 */
function setupWardenSnapshotJob(options: {
  parent: string;
  checkBody: string;
  snapshotExpiresAt: string;
}) {
  const { parent, checkBody, snapshotExpiresAt } = options;
  const snapshotRoot = join(parent, "repositories", "tenant_test", "snapshot-a");
  const dataRoot = join(parent, "data");
  mkdirSync(snapshotRoot, { recursive: true });
  writeFileSync(join(snapshotRoot, "client.js"), "export const path = '/v1/chargess';\n");
  writeFileSync(join(snapshotRoot, "check.mjs"), checkBody);
  const sourceBefore = readFileSync(join(snapshotRoot, "client.js"), "utf8");
  const manifestSha256 = snapshotManifest(snapshotRoot);
  const db = createDb(join(parent, "jobs.sqlite"));
  const at = nowIso();
  const connection = upsertScmConnection(db, {
    id: "connection-warden-snapshot",
    tenantId: "tenant_test",
    provider: "local_git",
    credentialRef: "local://filesystem",
    externalAccountId: "tenant_test",
    displayName: "Tenant test",
    createdAt: at,
    updatedAt: at,
  });
  const repository = insertConnectedRepository(db, {
    id: "repository-warden-snapshot",
    tenantId: "tenant_test",
    connectionId: connection.id,
    remoteId: "tenant_test/fixture",
    owner: "tenant_test",
    name: "fixture",
    defaultBranch: "main",
    status: "ready",
    createdAt: at,
    updatedAt: at,
  });
  const revision = "a".repeat(40);
  insertRepositorySnapshot(db, {
    id: "snapshot-warden-a",
    tenantId: "tenant_test",
    repositoryId: repository.id,
    requestedRef: "main",
    resolvedSha: revision,
    manifestSha256,
    storagePath: snapshotRoot,
    createdAt: at,
    expiresAt: snapshotExpiresAt,
  });
  insertRepositorySnapshotPolicy(db, {
    id: "policy-warden-a",
    tenantId: "tenant_test",
    snapshotId: "snapshot-warden-a",
    codeowners: [],
    ciFiles: [],
    verificationCommands: ["node check.mjs"],
    protectedBranch: { defaultBranch: "main", exactCommit: revision },
    createdAt: at,
  });
  insertConsumer(db, {
    id: "consumer-warden-snapshot",
    name: "Warden snapshot",
    githubOwner: "acme",
    githubRepo: "warden-snapshot",
    tenantId: "tenant_test",
    createdAt: at,
  });
  insertConsumerRepo(db, {
    id: "consumer-repo-warden-snapshot",
    consumerId: "consumer-warden-snapshot",
    localPath: snapshotRoot,
    createdAt: at,
  });
  bindConsumerRepoSnapshot(db, {
    tenantId: "tenant_test",
    consumerRepoId: "consumer-repo-warden-snapshot",
    connectionId: connection.id,
    connectedRepositoryId: repository.id,
    snapshotId: "snapshot-warden-a",
  });
  enqueueJob(db, {
    id: "job-warden-snapshot",
    tenantId: "tenant_test",
    type: "agent.run",
    createdAt: at,
    payload: {
      sessionId: "session-warden-snapshot",
      consumerId: "consumer-warden-snapshot",
      goal: "Fix the API path typo from chargess to charges.",
      errorLog: "HTTP 404 /v1/chargess",
      verifyCommand: "node check.mjs",
      allowedChangedPaths: ["client.js"],
      maxSteps: 20,
      useLlm: false,
    },
  });
  return {
    db,
    snapshotRoot,
    dataRoot,
    candidateRoot: join(dataRoot, "warden-candidates", "tenant_test"),
    evidenceRoot: join(dataRoot, "warden-evidence", "tenant_test"),
    sourceBefore,
  };
}

/** Inserts a Warden lifecycle agent_run row for maintenance tests. */
function insertWardenLifecycleRun(
  db: ReturnType<typeof createDb>,
  row: {
    id: string;
    tenantId: string;
    status: string;
    resultJson: string;
    createdAt?: string;
  },
): void {
  insertAgentRun(db, {
    id: row.id,
    tenantId: row.tenantId,
    jobId: null,
    goal: "lifecycle",
    repoPath: "",
    status: row.status,
    ok: false,
    steps: 0,
    resultJson: row.resultJson,
    createdAt: row.createdAt ?? "2020-01-01T00:00:00.000Z",
    finishedAt: "2020-01-01T00:00:01.000Z",
  });
}

function countAgentRunStatus(
  db: ReturnType<typeof createDb>,
  tenantId: string,
  status: string,
): number {
  return Number(
    (
      db.raw
        .prepare(
          `SELECT COUNT(*) AS c FROM agent_runs WHERE tenant_id = ? AND status = ?`,
        )
        .get(tenantId, status) as { c: number }
    ).c,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("worker runtime", () => {
  it("allows model source only for an explicitly configured tenant and model", () => {
    const env = {
      MENDPOINT_WARDEN_MODEL_SOURCE_ENABLED: "1",
      MENDPOINT_WARDEN_MODEL_SOURCE_TENANTS: "tenant-a,tenant-b",
      MENDPOINT_WARDEN_MODEL_PROVIDER: "openai-compatible",
      LLM_AGENT_MODEL: "model-a",
      LLM_AGENT_URL: "https://models.example/v1",
    };
    expect(resolveWardenModelSourcePolicy("tenant-c", true, env)).toBeUndefined();
    expect(resolveWardenModelSourcePolicy("tenant-a", false, env)).toBeUndefined();
    expect(resolveWardenModelSourcePolicy("tenant-a", true, env)).toMatchObject({
      approved: true,
      tenantId: "tenant-a",
      provider: "openai-compatible",
      model: "model-a",
      endpoint: "https://models.example/v1/chat/completions",
      policyDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it("does not retry permanent GitHub App authorization and scope failures", () => {
    for (const message of [
      "github_app_installation_revoked",
      "github_app_installation_required",
      "github_app_installation_tenant_mismatch",
      "github_app_installation_suspended",
      "github_app_installation_deleted",
      "github_app_repository_not_authorized",
      "github_app_permissions_incomplete",
      "github_app_connection_mismatch",
      "github_app_delivery_mode_mismatch",
    ]) {
      expect(classifyJobFailure(new Error(message))).toMatchObject({
        errorCode: message,
        retryable: false,
      });
    }
    expect(classifyJobFailure(new Error("Bad credentials"))).toMatchObject({
      errorCode: "authorization_failed",
      retryable: false,
    });
    expect(classifyJobFailure(new Error("GitHub request failed with 503"))).toMatchObject({
      errorCode: "transient_dependency",
      retryable: true,
    });
  });

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
    expect(parseJobConcurrency(undefined)).toBe(2);
    expect(parseJobConcurrency("8")).toBe(8);
    expect(() => parseJobConcurrency("9")).toThrow(/between 1 and 8/i);
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

  it("separates Transformer infrastructure health from handled customer failures", () => {
    const initial = {
      enabled: true,
      active: false,
      expired: 0,
      attempted: 0,
      completed: 0,
      failed: 0,
      stale: 0,
      idle: 0,
      errors: [],
    } as const;
    const started = transformerPilotHeartbeatStarted(
      initial,
      "2026-08-05T10:00:00.000Z",
    );
    expect(started).toMatchObject({ enabled: true, active: true });

    const handled = transformerPilotHeartbeatAfterResult(
      started,
      {
        enabled: true,
        expired: 0,
        attempted: 1,
        completed: 0,
        failed: 1,
        stale: 0,
        idle: 0,
        errors: ["recipe_execution_verification_failed:package-engine"],
      },
      "2026-08-05T10:01:00.000Z",
    );
    expect(handled).toMatchObject({
      active: false,
      failed: 1,
      lastSuccessAt: "2026-08-05T10:01:00.000Z",
    });
    expect(handled).not.toHaveProperty("infrastructureError");

    const infrastructureFailure = transformerPilotHeartbeatAfterFailure(
      handled,
      new Error("database is locked"),
      "2026-08-05T10:02:00.000Z",
    );
    expect(infrastructureFailure).toMatchObject({
      enabled: true,
      active: false,
      lastSuccessAt: "2026-08-05T10:01:00.000Z",
      lastRunAt: "2026-08-05T10:02:00.000Z",
      infrastructureError: "transformer_lane_database_locked",
    });
  });

  it("starts job draining without waiting for a slow feed", async () => {
    let releaseFeed!: () => void;
    const slowFeed = new Promise<string>((resolve) => {
      releaseFeed = () => resolve("feed complete");
    });
    const lanes = startIndependentWorkerLanes({
      feeds: () => slowFeed,
      jobs: async () => "job drained",
    });

    await expect(
      Promise.race([
        lanes.jobs,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("job lane was blocked by feed polling")), 250),
        ),
      ]),
    ).resolves.toBe("job drained");
    releaseFeed();
    await expect(lanes.feeds).resolves.toBe("feed complete");
  });

  it("starts independent job lanes so slow work cannot block every tenant", async () => {
    let releaseSlow!: () => void;
    const slow = new Promise<string>((resolve) => {
      releaseSlow = () => resolve("slow complete");
    });
    const started: number[] = [];
    const lanes = startConcurrentJobLanes(2, async (lane) => {
      started.push(lane);
      return lane === 0 ? slow : "fast complete";
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1]);
    releaseSlow();
    await expect(lanes).resolves.toEqual(["slow complete", "fast complete"]);
  });

  it("stops delay and job claiming immediately when service drain begins", async () => {
    const controller = new AbortController();
    const waiting = waitForWorkerDelay(60_000, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();

    const dir = mkdtempSync(join(tmpdir(), "mendpoint-worker-drain-"));
    dirs.push(dir);
    const db = createDb(join(dir, "jobs.sqlite"));
    enqueueJob(db, {
      id: "job-drain-test",
      tenantId: "tenant-a",
      type: "pipeline.fanout",
      createdAt: nowIso(),
      payload: { providerSlug: "acme" },
    });
    await expect(
      processJobsOnce(db, {
        allTenants: true,
        shouldContinue: () => false,
      }),
    ).resolves.toEqual({
      claimed: 0,
      succeeded: 0,
      failed: 0,
      retried: 0,
    });
    expect(listJobs(db, 10, "tenant-a")[0]).toMatchObject({
      id: "job-drain-test",
      status: "pending",
    });
    db.raw.close();
  });

  it("enqueues feed pipeline work idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-worker-feed-job-"));
    dirs.push(dir);
    const db = createDb(join(dir, "jobs.sqlite"));
    const input = {
      tenantId: "tenant_test",
      providerSlug: "stripe",
      contentHash: "hash-1",
      versionId: "version-1",
    };

    const first = enqueueFeedPipelineJob(db, input);
    const replay = enqueueFeedPipelineJob(db, input);
    expect(replay).toBe(first);
    expect(listJobs(db, 10, "tenant_test")).toHaveLength(1);
    expect(listJobs(db, 10, "tenant_test")[0]).toMatchObject({
      id: first,
      type: "pipeline.fanout",
      status: "pending",
    });
    db.raw.close();
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

  it("repairs an exact snapshot only in a private candidate and persists evidence", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-worker-warden-snapshot-"));
    dirs.push(parent);
    const snapshotRoot = join(parent, "repositories", "tenant_test", "snapshot-a");
    const dataRoot = join(parent, "data");
    mkdirSync(snapshotRoot, { recursive: true });
    writeFileSync(join(snapshotRoot, "client.js"), "export const path = '/v1/chargess';\n");
    writeFileSync(
      join(snapshotRoot, "check.mjs"),
      "import { path } from './client.js'; process.exit(path === '/v1/charges' ? 0 : 1);\n",
    );
    const sourceBefore = readFileSync(join(snapshotRoot, "client.js"), "utf8");
    const manifestSha256 = snapshotManifest(snapshotRoot);
    const db = createDb(join(parent, "jobs.sqlite"));
    const at = nowIso();
    const connection = upsertScmConnection(db, {
      id: "connection-warden-snapshot",
      tenantId: "tenant_test",
      provider: "local_git",
      credentialRef: "local://filesystem",
      externalAccountId: "tenant_test",
      displayName: "Tenant test",
      createdAt: at,
      updatedAt: at,
    });
    const repository = insertConnectedRepository(db, {
      id: "repository-warden-snapshot",
      tenantId: "tenant_test",
      connectionId: connection.id,
      remoteId: "tenant_test/fixture",
      owner: "tenant_test",
      name: "fixture",
      defaultBranch: "main",
      status: "ready",
      createdAt: at,
      updatedAt: at,
    });
    const revision = "a".repeat(40);
    const snapshotExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    insertRepositorySnapshot(db, {
      id: "snapshot-warden-a",
      tenantId: "tenant_test",
      repositoryId: repository.id,
      requestedRef: "main",
      resolvedSha: revision,
      manifestSha256,
      storagePath: snapshotRoot,
      createdAt: at,
      expiresAt: snapshotExpiresAt,
    });
    insertRepositorySnapshotPolicy(db, {
      id: "policy-warden-a",
      tenantId: "tenant_test",
      snapshotId: "snapshot-warden-a",
      codeowners: [],
      ciFiles: [],
      verificationCommands: ["node check.mjs"],
      protectedBranch: { defaultBranch: "main", exactCommit: revision },
      createdAt: at,
    });
    insertConsumer(db, {
      id: "consumer-warden-snapshot",
      name: "Warden snapshot",
      githubOwner: "acme",
      githubRepo: "warden-snapshot",
      tenantId: "tenant_test",
      createdAt: at,
    });
    insertConsumerRepo(db, {
      id: "consumer-repo-warden-snapshot",
      consumerId: "consumer-warden-snapshot",
      localPath: snapshotRoot,
      createdAt: at,
    });
    bindConsumerRepoSnapshot(db, {
      tenantId: "tenant_test",
      consumerRepoId: "consumer-repo-warden-snapshot",
      connectionId: connection.id,
      connectedRepositoryId: repository.id,
      snapshotId: "snapshot-warden-a",
    });
    enqueueJob(db, {
      id: "job-warden-snapshot",
      tenantId: "tenant_test",
      type: "agent.run",
      createdAt: at,
      payload: {
        sessionId: "session-warden-snapshot",
        consumerId: "consumer-warden-snapshot",
        goal: "Fix the API path typo from chargess to charges.",
        errorLog: "HTTP 404 /v1/chargess",
        verifyCommand: "node check.mjs",
        allowedChangedPaths: ["client.js"],
        maxSteps: 20,
        useLlm: false,
      },
    });

    const previousDataRoot = process.env.MENDPOINT_DATA_DIR;
    process.env.MENDPOINT_DATA_DIR = dataRoot;
    try {
      const result = await processJobsOnce(db, {
        tenantId: "tenant_test",
        workerId: "worker-warden-snapshot",
        leaseMs: 30_000,
      });
      expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0, retried: 0 });
    } finally {
      if (previousDataRoot === undefined) delete process.env.MENDPOINT_DATA_DIR;
      else process.env.MENDPOINT_DATA_DIR = previousDataRoot;
    }

    expect(readFileSync(join(snapshotRoot, "client.js"), "utf8")).toBe(sourceBefore);
    const run = getAgentRun(db, "session-warden-snapshot", "tenant_test");
    expect(run).toMatchObject({ status: "candidate_ready", ok: 1 });
    const persisted = JSON.parse(run!.result_json!) as {
      artifacts: { candidateWorkspace: string; candidateManifest: string; evidence: string };
      retention: { expiresAt: string };
    };
    expect(persisted.retention.expiresAt).toBe(snapshotExpiresAt);
    expect(readFileSync(join(persisted.artifacts.candidateWorkspace, "client.js"), "utf8"))
      .toContain("/v1/charges");
    expect(existsSync(persisted.artifacts.candidateManifest)).toBe(true);
    expect(existsSync(persisted.artifacts.evidence)).toBe(true);
    db.raw.close();
  });

  it("expires and removes retained Warden artifacts when no jobs are queued", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-worker-warden-maintenance-"));
    dirs.push(parent);
    const dataRoot = join(parent, "data");
    const candidateRoot = join(dataRoot, "warden-candidates", "tenant_test");
    const evidenceRoot = join(dataRoot, "warden-evidence", "tenant_test");
    const workspace = join(candidateRoot, "attempt-a");
    const manifest = join(candidateRoot, "attempt-a.manifest.json");
    const evidence = join(evidenceRoot, "attempt-a.evidence.json");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(evidenceRoot, { recursive: true });
    writeFileSync(join(workspace, "client.js"), "candidate\n");
    writeFileSync(manifest, "{}\n");
    writeFileSync(evidence, "{}\n");
    const db = createDb(join(parent, "jobs.sqlite"));
    insertAgentRun(db, {
      id: "session-expired-maintenance",
      tenantId: "tenant_test",
      jobId: "job-expired-maintenance",
      goal: "expired candidate",
      repoPath: join(parent, "source"),
      status: "candidate_ready",
      ok: true,
      steps: 1,
      filesChanged: ["client.js"],
      resultJson: JSON.stringify({
        artifacts: {
          candidateWorkspace: workspace,
          candidateManifest: manifest,
          evidence,
          sourceDigest: "sha256:source",
          candidateDigest: "sha256:candidate",
        },
        retention: { expiresAt: "2020-01-01T00:00:00.000Z" },
      }),
      createdAt: "2020-01-01T00:00:00.000Z",
      finishedAt: "2020-01-01T00:00:01.000Z",
    });

    await expect(processJobsOnce(db, {
      tenantId: "tenant_test",
      workerId: "worker-maintenance",
      wardenEnv: { MENDPOINT_DATA_DIR: dataRoot },
    })).resolves.toEqual({ claimed: 0, succeeded: 0, failed: 0, retried: 0 });
    expect(existsSync(workspace)).toBe(false);
    expect(existsSync(manifest)).toBe(false);
    expect(existsSync(evidence)).toBe(false);
    const run = getAgentRun(db, "session-expired-maintenance", "tenant_test")!;
    expect(run.status).toBe("candidate_expired");
    expect(JSON.parse(run.result_json!)).toMatchObject({
      artifacts: { candidateWorkspace: null, candidateManifest: null, evidence: null },
      cleanup: { status: "cleaned", attempts: 1 },
    });
    expect(maintainWardenArtifactsOnce(db, { MENDPOINT_DATA_DIR: dataRoot })).toMatchObject({
      expired: 0,
      cleaned: 0,
      cleanupPending: 0,
    });
    db.raw.close();
  });

  it("moves a job bound queued Warden run out of queued on malformed payload", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-worker-warden-malformed-"));
    dirs.push(parent);
    const db = createDb(join(parent, "jobs.sqlite"));
    const at = nowIso();
    insertAgentRun(db, {
      id: "session-malformed",
      tenantId: "tenant_test",
      jobId: "job-malformed",
      goal: "malformed payload",
      repoPath: "",
      status: "queued",
      ok: false,
      steps: 0,
      resultJson: JSON.stringify({ jobId: "job-malformed" }),
      createdAt: at,
    });
    enqueueJob(db, {
      id: "job-malformed",
      tenantId: "tenant_test",
      type: "agent.run",
      payload: {},
      maxAttempts: 1,
      createdAt: at,
    });
    db.raw.prepare("UPDATE jobs SET payload_json = '{' WHERE id = ?").run("job-malformed");

    const drained = await processJobsOnce(db, {
      tenantId: "tenant_test",
      workerId: "worker-malformed",
      wardenEnv: { MENDPOINT_DATA_DIR: join(parent, "data") },
    });
    expect(drained).toEqual({ claimed: 1, succeeded: 0, failed: 1, retried: 0 });
    expect(getAgentRun(db, "session-malformed", "tenant_test")?.status).toBe("failed");
    expect(listJobs(db, 10, "tenant_test")[0]).toMatchObject({ status: "dead_letter" });
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

  it("accepts valid App credentials or a PAT for real production delivery", () => {
    const repos = mkdtempSync(join(tmpdir(), "mendpoint-worker-repos-"));
    dirs.push(repos);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
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
        GITHUB_APP_PRIVATE_KEY: privateKeyPem,
      }),
    ).toEqual([]);
    expect(
      validateWorkerProductionEnv({
        ...base,
        GITHUB_APP_ID: "123",
      }),
    ).toContain(
      "GITHUB_TOKEN or complete GitHub App credentials are required for real worker delivery",
    );
    expect(
      validateWorkerProductionEnv({
        ...base,
        GITHUB_TOKEN: "fine-grained-pat",
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
      }),
    ).toContain(
      "GitHub App credentials must include a positive app ID and a readable RSA private key",
    );
    expect(
      validateWorkerProductionEnv({
        ...base,
        GITHUB_TOKEN: "fine-grained-pat",
      }),
    ).toEqual([]);
  });

  it("expires Warden candidate rows across pages beyond the 100 row limit", () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-rowpage-"));
    dirs.push(parent);
    const dataRoot = join(parent, "data");
    mkdirSync(dataRoot, { recursive: true });
    const dataRootReal = realpathSync(dataRoot);
    const tenant = "tenant-rowpage";
    const candidateRoot = join(dataRootReal, "warden-candidates", tenant);
    const evidenceRoot = join(dataRootReal, "warden-evidence", tenant);
    const db = createDb(join(parent, "jobs.sqlite"));
    const total = 150;
    for (let i = 0; i < total; i++) {
      insertWardenLifecycleRun(db, {
        id: `row-${i}`,
        tenantId: tenant,
        status: "candidate_ready",
        resultJson: JSON.stringify({
          artifacts: {
            candidateWorkspace: join(candidateRoot, `ws-${i}`),
            candidateManifest: join(candidateRoot, `ws-${i}.manifest.json`),
            evidence: join(evidenceRoot, `ev-${i}.json`),
            sourceDigest: "sha256:s",
            candidateDigest: "sha256:c",
          },
          retention: { expiresAt: "2020-01-01T00:00:00.000Z" },
        }),
        createdAt: new Date(1_600_000_000_000 + i).toISOString(),
      });
    }
    const env = { MENDPOINT_DATA_DIR: dataRoot };
    const first = maintainWardenArtifactsOnce(db, env);
    // A single pass is bounded by the 100 row limit, so work must remain.
    expect(first.expired).toBeLessThanOrEqual(100);
    expect(countAgentRunStatus(db, tenant, "candidate_ready")).toBeGreaterThanOrEqual(50);
    for (let i = 0; i < 8 && countAgentRunStatus(db, tenant, "candidate_ready") > 0; i++) {
      maintainWardenArtifactsOnce(db, env);
    }
    expect(countAgentRunStatus(db, tenant, "candidate_ready")).toBe(0);
    expect(countAgentRunStatus(db, tenant, "candidate_expired")).toBe(total);
    db.raw.close();
  });

  it("sweeps Warden tenants across pages beyond the 100 tenant limit", () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-tenantpage-"));
    dirs.push(parent);
    const dataRoot = join(parent, "data");
    mkdirSync(dataRoot, { recursive: true });
    const dataRootReal = realpathSync(dataRoot);
    const db = createDb(join(parent, "jobs.sqlite"));
    const total = 150;
    const tenants = Array.from({ length: total }, (_, i) => `tenant-page-${i}`);
    for (const tenant of tenants) {
      const candidateRoot = join(dataRootReal, "warden-candidates", tenant);
      const evidenceRoot = join(dataRootReal, "warden-evidence", tenant);
      insertWardenLifecycleRun(db, {
        id: `only-${tenant}`,
        tenantId: tenant,
        status: "candidate_ready",
        resultJson: JSON.stringify({
          artifacts: {
            candidateWorkspace: join(candidateRoot, "ws"),
            candidateManifest: join(candidateRoot, "ws.manifest.json"),
            evidence: join(evidenceRoot, "ev.json"),
            sourceDigest: "sha256:s",
            candidateDigest: "sha256:c",
          },
          retention: { expiresAt: "2020-01-01T00:00:00.000Z" },
        }),
      });
    }
    const env = { MENDPOINT_DATA_DIR: dataRoot };
    const readyCount = () =>
      tenants.reduce(
        (sum, tenant) => sum + countAgentRunStatus(db, tenant, "candidate_ready"),
        0,
      );
    const first = maintainWardenArtifactsOnce(db, env);
    // One maintenance pass visits at most 100 tenants.
    expect(first.tenants).toBeLessThanOrEqual(100);
    expect(readyCount()).toBeGreaterThanOrEqual(50);
    for (let i = 0; i < 8 && readyCount() > 0; i++) {
      maintainWardenArtifactsOnce(db, env);
    }
    expect(readyCount()).toBe(0);
    db.raw.close();
  });

  it("removes orphan Warden artifacts after grace while retaining referenced candidates", () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-orphan-"));
    dirs.push(parent);
    const dataRoot = join(parent, "data");
    const tenant = "tenant-orphan";
    const candidateRoot = join(dataRoot, "warden-candidates", tenant);
    const evidenceRoot = join(dataRoot, "warden-evidence", tenant);
    mkdirSync(candidateRoot, { recursive: true });
    mkdirSync(evidenceRoot, { recursive: true });
    const candidateRootReal = realpathSync(candidateRoot);
    const referencedWs = join(candidateRootReal, "referenced-ws");
    const orphanWs = join(candidateRootReal, "orphan-ws");
    mkdirSync(referencedWs);
    mkdirSync(orphanWs);
    const db = createDb(join(parent, "jobs.sqlite"));
    const now = Date.now();
    // A live candidate whose retention has not yet lapsed keeps its workspace referenced.
    insertWardenLifecycleRun(db, {
      id: "referenced-run",
      tenantId: tenant,
      status: "candidate_ready",
      resultJson: JSON.stringify({
        artifacts: {
          candidateWorkspace: referencedWs,
          candidateManifest: null,
          evidence: null,
        },
        retention: { expiresAt: new Date(now + 3 * 3_600_000).toISOString() },
      }),
    });
    const observedAt = new Date(now + 2 * 3_600_000).toISOString();
    maintainWardenArtifactsOnce(db, { MENDPOINT_DATA_DIR: dataRoot }, observedAt);
    expect(existsSync(referencedWs)).toBe(true);
    expect(existsSync(orphanWs)).toBe(false);
    expect(getAgentRun(db, "referenced-run", tenant)?.status).toBe("candidate_ready");
    db.raw.close();
  });

  it("does not let stale historical failed runs protect orphan artifacts", () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-orphan-scope-"));
    dirs.push(parent);
    const dataRoot = join(parent, "data");
    const tenant = "tenant-orphan-scope";
    const candidateRoot = join(dataRoot, "warden-candidates", tenant);
    const evidenceRoot = join(dataRoot, "warden-evidence", tenant);
    mkdirSync(candidateRoot, { recursive: true });
    mkdirSync(evidenceRoot, { recursive: true });
    const candidateRootReal = realpathSync(candidateRoot);
    const protectedWs = join(candidateRootReal, "protected-ws");
    const staleWs = join(candidateRootReal, "stale-ws");
    mkdirSync(protectedWs);
    mkdirSync(staleWs);
    const db = createDb(join(parent, "jobs.sqlite"));
    const now = Date.now();
    // Active candidate lifecycle row => protected.
    insertWardenLifecycleRun(db, {
      id: "protected-run",
      tenantId: tenant,
      status: "candidate_ready",
      resultJson: JSON.stringify({
        artifacts: { candidateWorkspace: protectedWs, candidateManifest: null, evidence: null },
        retention: { expiresAt: new Date(now + 3 * 3_600_000).toISOString() },
      }),
    });
    // Historical failed run pointing at the same kind of path must NOT protect it forever.
    insertWardenLifecycleRun(db, {
      id: "stale-failed-run",
      tenantId: tenant,
      status: "failed",
      resultJson: JSON.stringify({
        artifacts: { candidateWorkspace: staleWs, candidateManifest: null, evidence: null },
      }),
    });
    const observedAt = new Date(now + 2 * 3_600_000).toISOString();
    maintainWardenArtifactsOnce(db, { MENDPOINT_DATA_DIR: dataRoot }, observedAt);
    expect(existsSync(protectedWs)).toBe(true);
    expect(existsSync(staleWs)).toBe(false);
    db.raw.close();
  });

  it("fails closed on invalid candidate JSON and invalid retention expiry", () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-failclosed-"));
    dirs.push(parent);
    const dataRoot = join(parent, "data");
    const tenant = "tenant-failclosed";
    const db = createDb(join(parent, "jobs.sqlite"));
    // Malformed result JSON on an active candidate must not stay candidate_ready.
    insertWardenLifecycleRun(db, {
      id: "malformed-ready",
      tenantId: tenant,
      status: "candidate_ready",
      resultJson: "{ not valid json",
    });
    // A non-parseable expiry timestamp must expire (fail closed), not persist as ready.
    insertWardenLifecycleRun(db, {
      id: "invalid-expiry",
      tenantId: tenant,
      status: "candidate_ready",
      resultJson: JSON.stringify({
        artifacts: { candidateWorkspace: null, candidateManifest: null, evidence: null },
        retention: { expiresAt: "not-a-timestamp" },
      }),
    });
    maintainWardenArtifactsOnce(db, { MENDPOINT_DATA_DIR: dataRoot });
    expect(getAgentRun(db, "malformed-ready", tenant)?.status).toBe("candidate_corrupt");
    const invalid = getAgentRun(db, "invalid-expiry", tenant)!;
    expect(invalid.status).toBe("candidate_expired");
    expect(JSON.parse(invalid.result_json!).retention.invalidExpiry).toBe(true);
    db.raw.close();
  });

  it("keeps candidate eligibility safe when rejected rows carry malformed JSON", () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-eligibility-"));
    dirs.push(parent);
    const dataRoot = join(parent, "data");
    const tenant = "tenant-eligibility";
    const db = createDb(join(parent, "jobs.sqlite"));
    // Malformed JSON on a rejected row: the eligibility CASE must guard json_extract
    // (no SQL error) and still treat the row as eligible => fail closed to corrupt.
    insertWardenLifecycleRun(db, {
      id: "rejected-malformed",
      tenantId: tenant,
      status: "candidate_rejected",
      resultJson: "}{ definitely not json",
    });
    expect(() =>
      maintainWardenArtifactsOnce(db, { MENDPOINT_DATA_DIR: dataRoot }),
    ).not.toThrow();
    expect(getAgentRun(db, "rejected-malformed", tenant)?.status).toBe("candidate_corrupt");
    db.raw.close();
  });

  it("continues processing jobs when Warden maintenance fails", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-maint-fail-"));
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
      id: "consumer-maint-fail",
      name: "Maintenance failure test",
      githubOwner: "acme",
      githubRepo: "maint-fail",
      tenantId: "tenant_test",
      createdAt: nowIso(),
    });
    insertConsumerRepo(db, {
      id: "repo-maint-fail",
      consumerId: "consumer-maint-fail",
      localPath: repo,
      createdAt: nowIso(),
    });
    enqueueJob(db, {
      id: "job-maint-fail",
      tenantId: "tenant_test",
      type: "repair.run",
      maxAttempts: 5,
      createdAt: nowIso(),
      payload: {
        sessionId: "session-maint-fail",
        consumerId: "consumer-maint-fail",
        renameMap: { oldField: "newField" },
        maxAttempts: 3,
      },
    });
    // Point the Warden data dir at a file so maintenance throws before touching jobs.
    const badDataDir = join(parent, "not-a-directory");
    writeFileSync(badDataDir, "x");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      processJobsOnce(db, {
        tenantId: "tenant_test",
        workerId: "worker-maint-fail",
        leaseMs: 5_000,
        wardenEnv: { MENDPOINT_DATA_DIR: badDataDir },
      }),
    ).resolves.toEqual({ claimed: 1, succeeded: 1, failed: 0, retried: 0 });

    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes("Warden maintenance unavailable"),
      ),
    ).toBe(true);
    expect(getRepairSession(db, "session-maint-fail", "tenant_test")).toMatchObject({
      status: "verified",
      ok: 1,
    });
    expect(listJobs(db, 10, "tenant_test")[0]).toMatchObject({
      id: "job-maint-fail",
      status: "done",
    });
    db.raw.close();
  });

  it("reserves both source and evidence bytes against the candidate quota", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-quota-"));
    dirs.push(parent);
    const fixture = setupWardenSnapshotJob({
      parent,
      checkBody: FAST_CHECK,
      snapshotExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    // Quota equals exactly maxSourceBytes. With empty candidate/evidence storage the
    // reservation only exceeds quota because evidence bytes are reserved on top of source.
    const result = await processJobsOnce(fixture.db, {
      tenantId: "tenant_test",
      workerId: "worker-quota",
      leaseMs: 30_000,
      wardenEnv: {
        MENDPOINT_DATA_DIR: fixture.dataRoot,
        MENDPOINT_WARDEN_CANDIDATE_QUOTA_BYTES: String(512 * 1024 * 1024),
      },
    });
    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1, retried: 0 });
    const run = getAgentRun(fixture.db, "session-warden-snapshot", "tenant_test")!;
    expect(run.status).toBe("failed");
    expect(JSON.parse(run.result_json!).code).toBe("warden_candidate_storage_quota_exceeded");
    expect(readFileSync(join(fixture.snapshotRoot, "client.js"), "utf8")).toBe(
      fixture.sourceBefore,
    );
    fixture.db.raw.close();
  });

  it("renews a one-second lease before it expires during a long attempt", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-lease-renew-"));
    dirs.push(parent);
    const fixture = setupWardenSnapshotJob({
      parent,
      // Each verifier run outlasts the 1s lease, so the attempt only survives if the
      // renewal timer (floored at 100ms, not 1000ms) refreshes the lease in time.
      checkBody: slowCheck(1_200),
      snapshotExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const result = await processJobsOnce(fixture.db, {
      tenantId: "tenant_test",
      workerId: "worker-lease-renew",
      leaseMs: 1_000,
      wardenEnv: { MENDPOINT_DATA_DIR: fixture.dataRoot },
    });
    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0, retried: 0 });
    expect(getAgentRun(fixture.db, "session-warden-snapshot", "tenant_test")).toMatchObject({
      status: "candidate_ready",
      ok: 1,
    });
    fixture.db.raw.close();
  }, 30_000);

  it("discards artifacts and fails when the snapshot expires mid-attempt", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-expire-attempt-"));
    dirs.push(parent);
    const fixture = setupWardenSnapshotJob({
      parent,
      // The snapshot is valid when the binding loads but lapses while the slow verifier runs.
      checkBody: slowCheck(1_500),
      snapshotExpiresAt: new Date(Date.now() + 2_000).toISOString(),
    });

    const result = await processJobsOnce(fixture.db, {
      tenantId: "tenant_test",
      workerId: "worker-expire-attempt",
      leaseMs: 30_000,
      wardenEnv: { MENDPOINT_DATA_DIR: fixture.dataRoot },
    });
    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1, retried: 0 });
    const run = getAgentRun(fixture.db, "session-warden-snapshot", "tenant_test")!;
    expect(run.status).toBe("failed");
    expect(JSON.parse(run.result_json!).code).toBe("warden_snapshot_expired_during_attempt");
    // Artifacts produced during the attempt must be discarded on expiry.
    expect(readdirSync(fixture.candidateRoot)).toEqual([]);
    expect(readdirSync(fixture.evidenceRoot)).toEqual([]);
    expect(readFileSync(join(fixture.snapshotRoot, "client.js"), "utf8")).toBe(
      fixture.sourceBefore,
    );
    fixture.db.raw.close();
  }, 30_000);

  it("retains the tenant evidence approvals directory past the orphan grace window", () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-approvals-orphan-"));
    dirs.push(parent);
    const dataRoot = join(parent, "data");
    const tenant = "tenant-approvals";
    const candidateRoot = join(dataRoot, "warden-candidates", tenant);
    const evidenceRoot = join(dataRoot, "warden-evidence", tenant);
    mkdirSync(candidateRoot, { recursive: true });
    mkdirSync(evidenceRoot, { recursive: true });
    const candidateRootReal = realpathSync(candidateRoot);
    const evidenceRootReal = realpathSync(evidenceRoot);
    // A genuinely orphaned workspace of the same age must still be reaped.
    const orphanWs = join(candidateRootReal, "orphan-ws");
    mkdirSync(orphanWs);
    // A sealed approval record under the top-level approvals directory must survive.
    const approvalsDir = join(evidenceRootReal, "approvals");
    mkdirSync(approvalsDir);
    const sealed = join(approvalsDir, `${"a".repeat(64)}.json`);
    writeFileSync(sealed, JSON.stringify({ approved: true }));
    const db = createDb(join(parent, "jobs.sqlite"));
    const now = Date.now();
    // A terminal lifecycle row keeps the tenant in the maintenance rotation without
    // referencing either the orphan workspace or the approvals directory.
    insertWardenLifecycleRun(db, {
      id: "approvals-tenant-run",
      tenantId: tenant,
      status: "failed",
      resultJson: JSON.stringify({ artifacts: {} }),
    });
    // observedAt is two hours ahead so both the orphan and approvals dir (mtime now)
    // are older than the default one hour grace window.
    const observedAt = new Date(now + 2 * 3_600_000).toISOString();
    maintainWardenArtifactsOnce(db, { MENDPOINT_DATA_DIR: dataRoot }, observedAt);
    expect(existsSync(orphanWs)).toBe(false);
    expect(existsSync(approvalsDir)).toBe(true);
    expect(existsSync(sealed)).toBe(true);
    db.raw.close();
  });

  it("treats a candidate_approved approval.path as a referenced artifact", () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-approval-ref-"));
    dirs.push(parent);
    const dataRoot = join(parent, "data");
    const tenant = "tenant-approval-ref";
    const candidateRoot = join(dataRoot, "warden-candidates", tenant);
    const evidenceRoot = join(dataRoot, "warden-evidence", tenant);
    mkdirSync(candidateRoot, { recursive: true });
    mkdirSync(evidenceRoot, { recursive: true });
    const evidenceRootReal = realpathSync(evidenceRoot);
    // A sealed approval record persisted outside the name-exempted approvals directory:
    // only the approval.path reference (not the directory-name exemption) can protect it.
    const sealedRecord = join(evidenceRootReal, "sealed-approval-record");
    mkdirSync(sealedRecord);
    const orphanEvidence = join(evidenceRootReal, "orphan-evidence");
    mkdirSync(orphanEvidence);
    const db = createDb(join(parent, "jobs.sqlite"));
    const now = Date.now();
    insertWardenLifecycleRun(db, {
      id: "approved-run",
      tenantId: tenant,
      status: "candidate_approved",
      resultJson: JSON.stringify({
        artifacts: {
          candidateWorkspace: null,
          candidateManifest: null,
          evidence: null,
          approval: { path: sealedRecord, sha256: "b".repeat(64) },
        },
        // Future expiry keeps the row candidate_approved through expiry maintenance.
        retention: { expiresAt: new Date(now + 24 * 3_600_000).toISOString() },
      }),
    });
    const observedAt = new Date(now + 2 * 3_600_000).toISOString();
    maintainWardenArtifactsOnce(db, { MENDPOINT_DATA_DIR: dataRoot }, observedAt);
    expect(existsSync(sealedRecord)).toBe(true);
    expect(existsSync(orphanEvidence)).toBe(false);
    expect(getAgentRun(db, "approved-run", tenant)?.status).toBe("candidate_approved");
    db.raw.close();
  });

  it("excludes sealed approvals bytes from the candidate storage quota", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-approvals-quota-"));
    dirs.push(parent);
    const fixture = setupWardenSnapshotJob({
      parent,
      checkBody: FAST_CHECK,
      snapshotExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    // Pre-seed a sealed approval record under the tenant evidence approvals directory.
    const approvalsDir = join(fixture.evidenceRoot, "approvals");
    mkdirSync(approvalsDir, { recursive: true });
    const sealed = join(approvalsDir, `${"c".repeat(64)}.json`);
    writeFileSync(sealed, "x".repeat(4096));
    // Quota leaves only 1024 bytes of headroom above the reserved attempt bytes. The
    // 4096 byte approval record would exceed quota if it were counted; the run only
    // succeeds because approvals bytes are excluded from the storage measurement.
    const quotaBytes = 512 * 1024 * 1024 + 512 * 1024 + 1024;
    const result = await processJobsOnce(fixture.db, {
      tenantId: "tenant_test",
      workerId: "worker-approvals-quota",
      leaseMs: 30_000,
      wardenEnv: {
        MENDPOINT_DATA_DIR: fixture.dataRoot,
        MENDPOINT_WARDEN_CANDIDATE_QUOTA_BYTES: String(quotaBytes),
      },
    });
    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0, retried: 0 });
    expect(getAgentRun(fixture.db, "session-warden-snapshot", "tenant_test")).toMatchObject({
      status: "candidate_ready",
      ok: 1,
    });
    expect(existsSync(sealed)).toBe(true);
    fixture.db.raw.close();
  }, 30_000);
});
