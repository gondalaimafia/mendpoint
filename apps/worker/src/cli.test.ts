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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  bindConsumerRepoSnapshot,
  enqueueJob,
  enqueueAdaptiveDelivery,
  getAdaptiveCandidate,
  getAdaptiveDeliveryByCandidate,
  getAgentRun,
  getRoutingLedgerForJob,
  insertAgentRun,
  insertConsumer,
  insertConsumerRepo,
  insertConnectedRepository,
  insertRepositorySnapshot,
  insertRepositorySnapshotPolicy,
  recordAdaptiveCandidate,
  retryJob,
  reviewAdaptiveCandidate,
  upsertScmConnection,
  upsertGitHubInstallation,
  getRepairSession,
  listJobs,
} from "@mendpoint/db";
import { nowIso } from "@mendpoint/shared";
import type { AgentPlanner } from "@mendpoint/agent";
import {
  OctokitGitHubDelivery,
  type ExactDraftDeliveryInput,
  type GitHubDelivery,
} from "@mendpoint/github";
import { recipeFilesDigest, sealAdaptiveCandidate } from "@mendpoint/transformer";
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
  transformerAdaptiveGitHubDelivery,
  transformerAdaptiveProductionPorts,
  writeWorkerHeartbeat,
} from "./cli.js";
import { WARDEN_EXECUTOR_ID, WARDEN_PROVIDER_ID } from "./warden-router.js";

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

const PER_CALL_USAGE = Object.freeze({
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
  costUsd: 0.0025,
});

/**
 * A Warden planner that repairs the fixture's `chargess` typo and attaches
 * measured token usage + cost to every plan, so a production model-backed job
 * yields non-null usage the routing ledger can attribute.
 */
function meteredWardenPlanner(): AgentPlanner {
  return async (input) => {
    const tools = input.recentSteps.map((step) => step.tool);
    if (!tools.includes("read_file")) {
      return {
        call: {
          tool: "read_file",
          args: { path: "client.js" },
          thought: "Inspect the exact client path before editing",
        },
        usage: PER_CALL_USAGE,
      };
    }
    if (!tools.includes("replace_in_file")) {
      return {
        call: {
          tool: "replace_in_file",
          args: { path: "client.js", from: "chargess", to: "charges" },
          thought: "Apply the source grounded path correction",
        },
        usage: PER_CALL_USAGE,
      };
    }
    return {
      call: {
        tool: "run_command",
        args: { command: "node check.mjs" },
        thought: "Verify the candidate",
      },
      usage: PER_CALL_USAGE,
    };
  };
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
  useLlm?: boolean;
}) {
  const { parent, checkBody, snapshotExpiresAt, useLlm = false } = options;
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
      useLlm,
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
      MENDPOINT_WARDEN_EXTERNAL_PROCESSING_ALLOWED: "1",
      MENDPOINT_WARDEN_MODEL_REGION: "us-central",
      MENDPOINT_WARDEN_MODEL_MAXIMUM_DATA_CLASSIFICATION: "confidential",
      MENDPOINT_WARDEN_MODEL_ESTIMATED_COST_USD: "0.25",
      MENDPOINT_WARDEN_MODEL_MAXIMUM_CALL_COST_USD: "1.00",
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
      externalProcessingAllowed: true,
      region: "us-central",
      maximumDataClassification: "confidential",
      estimatedCostUsd: 0.25,
      maximumCallCostUsd: 1,
      policyDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    const {
      MENDPOINT_WARDEN_MODEL_MAXIMUM_CALL_COST_USD: _maximumCallCostUsd,
      ...missingMaximum
    } = env;
    expect(() => resolveWardenModelSourcePolicy("tenant-a", true, missingMaximum))
      .toThrow("warden_model_source_policy_incomplete");
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

  it("requires complete Transformer adaptive model configuration when enabled", () => {
    const repos = mkdtempSync(join(tmpdir(), "mendpoint-worker-adaptive-model-"));
    dirs.push(repos);
    const base = {
      NODE_ENV: "production",
      GITHUB_MODE: "mock",
      MENDPOINT_DATA_DIR: repos,
      MENDPOINT_REPOS_DIR: repos,
      MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_ENABLED: "1",
    };
    expect(validateWorkerProductionEnv(base)).toEqual(expect.arrayContaining([
      expect.stringContaining("MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_TENANTS"),
      expect.stringContaining("MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_PROVIDER"),
      expect.stringContaining("MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_DEPLOYMENT"),
      expect.stringContaining("MENDPOINT_TRANSFORMER_ADAPTIVE_EXTERNAL_PROCESSING_APPROVED"),
      expect.stringContaining("MENDPOINT_TRANSFORMER_ADAPTIVE_EXECUTION_REGION"),
      expect.stringContaining("MENDPOINT_TRANSFORMER_ADAPTIVE_MAX_DATA_CLASSIFICATION"),
      expect.stringContaining("LLM_AGENT_MODEL"),
      expect.stringContaining("LLM_AGENT_URL or OPENAI_BASE_URL"),
      expect.stringContaining("OPENAI_API_KEY or XAI_API_KEY"),
    ]));
    const complete = {
      ...base,
      MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_TENANTS: "tenant-a",
      MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_PROVIDER: "openai-compatible",
      MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_DEPLOYMENT: "us-central-primary",
      MENDPOINT_TRANSFORMER_ADAPTIVE_EXTERNAL_PROCESSING_APPROVED: "1",
      MENDPOINT_TRANSFORMER_ADAPTIVE_EXECUTION_REGION: "us-central1",
      MENDPOINT_TRANSFORMER_ADAPTIVE_MAX_DATA_CLASSIFICATION: "confidential",
      LLM_AGENT_MODEL: "model-a",
      LLM_AGENT_URL: "https://models.example/v1",
      OPENAI_API_KEY: "configured",
    };
    expect(validateWorkerProductionEnv(complete)).toEqual([]);
    const ports = transformerAdaptiveProductionPorts(complete);
    const adapter = ports.adaptivePlannerAdapterForTenant("tenant-a")!;
    expect(ports.authorizeAdaptiveExternalProcessing({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      sourceArtifactIds: ["snapshot-a"],
      policy: adapter.policy,
    })).toEqual({
      allowed: true,
      evidenceRef: `transformer-adaptive-authorization:${adapter.policy.policyDigest}`,
    });
    expect(ports.adaptivePlannerAdapterForTenant("tenant-b")).toBeUndefined();
  });

  it("requires an App for customer delivery and allows PAT only for a disposable canary", () => {
    const repos = mkdtempSync(join(tmpdir(), "mendpoint-worker-repos-"));
    dirs.push(repos);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const base = {
      NODE_ENV: "production",
      GITHUB_MODE: "real",
      MENDPOINT_DEPLOYMENT_CLASS: "customer",
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
      "Complete GitHub App credentials are required for customer production delivery",
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
        MENDPOINT_DEPLOYMENT_CLASS: "disposable_canary",
        GITHUB_TOKEN: "fine-grained-pat",
      }),
    ).toContain("MENDPOINT_TENANT_ID is required for disposable canary PAT delivery");
    expect(
      validateWorkerProductionEnv({
        ...base,
        MENDPOINT_DEPLOYMENT_CLASS: "disposable_canary",
        GITHUB_TOKEN: "fine-grained-pat",
        MENDPOINT_TENANT_ID: "tenant-canary",
      }),
    ).toEqual([]);
  });

  it("allows a PAT canary only for one pinned tenant and exact connected repository", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-worker-pat-pin-"));
    dirs.push(parent);
    const db = createDb(join(parent, "worker.db"));
    upsertScmConnection(db, {
      id: "connection-canary",
      tenantId: "tenant-canary",
      provider: "github",
      credentialRef: "env://GITHUB_TOKEN",
      externalAccountId: "123",
      displayName: "Canary",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    });
    insertConnectedRepository(db, {
      id: "repository-canary",
      tenantId: "tenant-canary",
      connectionId: "connection-canary",
      remoteId: "456",
      owner: "acme",
      name: "canary",
      defaultBranch: "main",
      status: "ready",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    });
    const intent: ExactDraftDeliveryInput = {
      owner: "acme",
      repo: "canary",
      baseBranch: "main",
      expectedBaseSha: "a".repeat(40),
      branch: "mendpoint/transformer-canary",
      commitMessage: "Open approved Transformer candidate",
      commitDate: "2026-08-06T00:00:00.000Z",
      title: "Transformer candidate",
      body: "Exact approved candidate",
      files: [{ path: "package.json", content: "{}\n", mode: "100644" }],
    };
    const result = {
      number: 1,
      url: "https://github.com/acme/canary/pull/1",
      branch: intent.branch,
      title: intent.title,
      draft: true as const,
      baseBranch: intent.baseBranch,
      baseSha: intent.expectedBaseSha,
      commitSha: "b".repeat(40),
    };
    const identity = vi.spyOn(
      OctokitGitHubDelivery.prototype,
      "assertRepositoryIdentity",
    ).mockResolvedValue(undefined);
    const deliver = vi.spyOn(
      OctokitGitHubDelivery.prototype,
      "deliverExactDraft",
    ).mockResolvedValue(result);

    await expect(transformerAdaptiveGitHubDelivery(db, "tenant-canary", {
      NODE_ENV: "production",
      GITHUB_MODE: "real",
      GITHUB_TOKEN: "canary-token",
      MENDPOINT_TENANT_ID: "tenant-canary",
    }).deliverExactDraft(intent)).rejects.toThrow(
      "transformer_adaptive_delivery_pat_disposable_canary_required",
    );

    await expect(transformerAdaptiveGitHubDelivery(db, "tenant-canary", {
      NODE_ENV: "production",
      GITHUB_MODE: "real",
      GITHUB_TOKEN: "canary-token",
      MENDPOINT_DEPLOYMENT_CLASS: "disposable_canary",
      MENDPOINT_TENANT_ID: "tenant-canary",
    }).deliverExactDraft(intent)).resolves.toEqual(result);
    expect(identity).toHaveBeenCalledWith("acme", "canary", 456);
    expect(deliver).toHaveBeenCalledWith(intent);

    insertConnectedRepository(db, {
      id: "repository-canary-second",
      tenantId: "tenant-canary",
      connectionId: "connection-canary",
      remoteId: "789",
      owner: "acme",
      name: "second",
      defaultBranch: "main",
      status: "ready",
      createdAt: "2026-08-06T00:00:01.000Z",
      updatedAt: "2026-08-06T00:00:01.000Z",
    });
    await expect(transformerAdaptiveGitHubDelivery(db, "tenant-canary", {
      NODE_ENV: "production",
      GITHUB_MODE: "real",
      GITHUB_TOKEN: "canary-token",
      MENDPOINT_DEPLOYMENT_CLASS: "disposable_canary",
      MENDPOINT_TENANT_ID: "tenant-canary",
    }).deliverExactDraft(intent)).rejects.toThrow(
      "transformer_adaptive_delivery_pat_repository_not_pinned",
    );
    await expect(transformerAdaptiveGitHubDelivery(db, "tenant-canary", {
      NODE_ENV: "production",
      GITHUB_MODE: "real",
      GITHUB_TOKEN: "canary-token",
      MENDPOINT_DEPLOYMENT_CLASS: "disposable_canary",
      MENDPOINT_TENANT_ID: "tenant-other",
    }).deliverExactDraft(intent)).rejects.toThrow(
      "transformer_adaptive_delivery_pat_tenant_not_pinned",
    );
    db.raw.close();
  });

  it("rejects a GitHub App installation whose repository ID differs from the connection", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-worker-app-binding-"));
    dirs.push(parent);
    const db = createDb(join(parent, "worker.db"));
    upsertScmConnection(db, {
      id: "connection-app",
      tenantId: "tenant-app",
      provider: "github",
      credentialRef: "env://GITHUB_TOKEN",
      externalAccountId: "123",
      displayName: "App",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    });
    insertConnectedRepository(db, {
      id: "repository-app",
      tenantId: "tenant-app",
      connectionId: "connection-app",
      remoteId: "456",
      owner: "acme",
      name: "app-repo",
      defaultBranch: "main",
      status: "ready",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    });
    upsertGitHubInstallation(db, {
      id: "installation-app",
      installationId: "123",
      accountLogin: "acme",
      tenantId: "tenant-app",
      permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        checks: "read",
      },
      repositories: [{ id: 999, owner: "acme", name: "app-repo" }],
      repositorySelection: "selected",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await expect(transformerAdaptiveGitHubDelivery(db, "tenant-app", {
      NODE_ENV: "production",
      GITHUB_MODE: "real",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    }).deliverExactDraft({
      owner: "acme",
      repo: "app-repo",
      baseBranch: "main",
      expectedBaseSha: "a".repeat(40),
      branch: "mendpoint/transformer-app",
      commitMessage: "Open approved Transformer candidate",
      commitDate: "2026-08-06T00:00:00.000Z",
      title: "Transformer candidate",
      body: "Exact approved candidate",
      files: [{ path: "package.json", content: "{}\n", mode: "100644" }],
    })).rejects.toThrow("transformer_adaptive_delivery_installation_invalid");
    db.raw.close();
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

  it("retains an approved Warden candidate at expiry while delivery is unresolved", () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-delivery-retention-"));
    dirs.push(parent);
    const dataRoot = join(parent, "data");
    const tenant = "tenant-delivery-retention";
    const candidateRoot = join(dataRoot, "warden-candidates", tenant);
    const evidenceRoot = join(dataRoot, "warden-evidence", tenant);
    const approvalRoot = join(evidenceRoot, "approvals");
    mkdirSync(candidateRoot, { recursive: true });
    mkdirSync(approvalRoot, { recursive: true });
    const workspace = join(candidateRoot, "workspace");
    const manifest = join(candidateRoot, "manifest.json");
    const evidence = join(evidenceRoot, "evidence.json");
    const approval = join(approvalRoot, "seal.json");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "client.ts"), "export const fixed = true;\n");
    for (const path of [manifest, evidence, approval]) writeFileSync(path, "{}\n");
    const db = createDb(join(parent, "jobs.sqlite"));
    insertWardenLifecycleRun(db, {
      id: "approved-retained",
      tenantId: tenant,
      status: "candidate_approved",
      resultJson: JSON.stringify({
        artifacts: {
          candidateWorkspace: workspace,
          candidateManifest: manifest,
          evidence,
          approval: { path: approval, sha256: `sha256:${"b".repeat(64)}` },
        },
        retention: { expiresAt: "2026-08-06T12:00:00.000Z" },
      }),
    });
    db.raw.prepare(
      `INSERT INTO warden_candidate_deliveries
       (id, tenant_id, run_id, job_id, status, repository_id, snapshot_id, base_branch,
        expected_base_revision, sealed_path, sealed_sha256, requester_principal_id, rationale,
        requested_at, updated_at)
       VALUES ('delivery-retained', ?, 'approved-retained', 'delivery-job-retained', 'delivery_pending',
        'repo-1', 'snapshot-1', 'main', ?, ?, ?, 'human:reviewer@example.com', 'Approved', ?, ?)`,
    ).run(tenant, "a".repeat(40), approval, `sha256:${"b".repeat(64)}`,
      "2026-08-06T11:00:00.000Z", "2026-08-06T11:00:00.000Z");

    maintainWardenArtifactsOnce(
      db,
      { MENDPOINT_DATA_DIR: dataRoot },
      "2026-08-06T12:00:00.000Z",
    );

    expect(getAgentRun(db, "approved-retained", tenant)?.status).toBe("candidate_approved");
    expect(existsSync(workspace)).toBe(true);
    expect(existsSync(manifest)).toBe(true);
    expect(existsSync(evidence)).toBe(true);
    expect(existsSync(approval)).toBe(true);

    db.raw.prepare(
      `UPDATE warden_candidate_deliveries
       SET status = 'delivery_failed', failed_at = ?, updated_at = ?
       WHERE id = 'delivery-retained' AND tenant_id = ?`,
    ).run("2026-08-06T12:00:01.000Z", "2026-08-06T12:00:01.000Z", tenant);
    maintainWardenArtifactsOnce(
      db,
      { MENDPOINT_DATA_DIR: dataRoot },
      "2026-08-06T12:00:01.000Z",
    );
    expect(getAgentRun(db, "approved-retained", tenant)?.status).toBe("candidate_expired");
    expect(existsSync(workspace)).toBe(false);
    expect(existsSync(manifest)).toBe(false);
    expect(existsSync(evidence)).toBe(false);
    expect(existsSync(approval)).toBe(true);
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

  it("never reaps a workspace owned by a durable running Warden job", () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-live-workspace-"));
    dirs.push(parent);
    const dataRoot = join(parent, "data");
    const tenant = "tenant-live-workspace";
    const candidateRoot = join(dataRoot, "warden-candidates", tenant);
    const evidenceRoot = join(dataRoot, "warden-evidence", tenant);
    mkdirSync(candidateRoot, { recursive: true });
    mkdirSync(evidenceRoot, { recursive: true });
    const db = createDb(join(parent, "jobs.sqlite"));
    const jobId = "job-live-workspace";
    enqueueJob(db, {
      id: jobId,
      tenantId: tenant,
      type: "agent.run",
      payload: {},
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    db.raw.prepare(
      `UPDATE jobs SET status = 'running', attempts = 1,
       lease_owner = 'worker-live', lease_expires_at = '2026-08-07T00:00:00.000Z',
       lease_generation = 1 WHERE id = ?`,
    ).run(jobId);
    const liveWorkspace = join(candidateRoot, `${jobId}-private-attempt`);
    const orphanWorkspace = join(candidateRoot, "orphan-private-attempt");
    mkdirSync(liveWorkspace);
    mkdirSync(orphanWorkspace);
    const old = new Date("2026-08-05T00:00:00.000Z");
    utimesSync(liveWorkspace, old, old);
    utimesSync(orphanWorkspace, old, old);

    maintainWardenArtifactsOnce(
      db,
      { MENDPOINT_DATA_DIR: dataRoot, MENDPOINT_WARDEN_ORPHAN_GRACE_MS: "60000" },
      "2026-08-06T00:00:00.000Z",
    );

    expect(existsSync(liveWorkspace)).toBe(true);
    expect(existsSync(orphanWorkspace)).toBe(false);
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

  it("hands off before invoking the model planner when external processing is denied", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-routing-privacy-"));
    dirs.push(parent);
    const fixture = setupWardenSnapshotJob({
      parent,
      checkBody: FAST_CHECK,
      snapshotExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      useLlm: true,
    });
    const planner = vi.fn(meteredWardenPlanner());

    const result = await processJobsOnce(fixture.db, {
      tenantId: "tenant_test",
      workerId: "worker-routing-privacy",
      leaseMs: 30_000,
      wardenPlanner: planner,
      wardenEnv: {
        MENDPOINT_DATA_DIR: fixture.dataRoot,
        MENDPOINT_WARDEN_MODEL_SOURCE_ENABLED: "1",
        MENDPOINT_WARDEN_MODEL_SOURCE_TENANTS: "tenant_test",
        MENDPOINT_WARDEN_MODEL_PROVIDER: "openai-compatible",
        MENDPOINT_WARDEN_EXTERNAL_PROCESSING_ALLOWED: "0",
        MENDPOINT_WARDEN_MODEL_REGION: "us-central",
        MENDPOINT_WARDEN_MODEL_MAXIMUM_DATA_CLASSIFICATION: "confidential",
        MENDPOINT_WARDEN_MODEL_ESTIMATED_COST_USD: "0.25",
        MENDPOINT_WARDEN_MODEL_MAXIMUM_CALL_COST_USD: "1.00",
        LLM_AGENT_MODEL: "model-a",
        LLM_AGENT_URL: "https://models.example/v1",
      },
    });

    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1, retried: 0 });
    expect(planner).not.toHaveBeenCalled();
    const ledger = getRoutingLedgerForJob(fixture.db, "job-warden-snapshot", "tenant_test");
    expect(ledger[0]).toMatchObject({
      action: "human_handoff",
      handoff_reason: "no_eligible_executor",
      task_snapshot_id: "snapshot-warden-a",
    });
    expect(JSON.parse(ledger[0]!.eliminated_json)).toEqual([
      expect.objectContaining({ reasons: expect.arrayContaining(["privacy_disallowed"]) }),
    ]);
    fixture.db.raw.close();
  }, 30_000);

  it("does not apply a routing outcome after the Warden lease transfers", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-routing-stale-fence-"));
    dirs.push(parent);
    const fixture = setupWardenSnapshotJob({
      parent,
      checkBody: FAST_CHECK,
      snapshotExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    let transferred = false;

    const result = await processJobsOnce(fixture.db, {
      tenantId: "tenant_test",
      workerId: "worker-stale",
      leaseMs: 30_000,
      wardenEnv: { MENDPOINT_DATA_DIR: fixture.dataRoot },
      onActiveJob: (active) => {
        if (!active || transferred) return;
        transferred = true;
        fixture.db.raw.prepare(
          `UPDATE jobs
           SET lease_owner = ?, lease_generation = lease_generation + 1, lease_expires_at = ?
           WHERE id = ?`,
        ).run("worker-successor", "2099-01-01T00:00:00.000Z", active.id);
      },
    });

    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1, retried: 0 });
    expect(listJobs(fixture.db, 10, "tenant_test")[0]).toMatchObject({
      status: "running",
      lease_owner: "worker-successor",
      lease_generation: 2,
    });
    expect(getRoutingLedgerForJob(
      fixture.db,
      "job-warden-snapshot",
      "tenant_test",
    )[0]!.outcome).toBeNull();
    expect(fixture.db.raw.prepare(
      "SELECT COUNT(*) AS count FROM routing_outcome_applications",
    ).get()).toEqual({ count: 0 });
    fixture.db.raw.close();
  }, 30_000);

  it("rolls back the completed job transition when routing outcome persistence fails", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-routing-rollback-"));
    dirs.push(parent);
    const fixture = setupWardenSnapshotJob({
      parent,
      checkBody: FAST_CHECK,
      snapshotExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    fixture.db.raw.exec("DROP TABLE routing_outcome_applications");

    await expect(processJobsOnce(fixture.db, {
      tenantId: "tenant_test",
      workerId: "worker-routing-rollback",
      leaseMs: 30_000,
      wardenEnv: { MENDPOINT_DATA_DIR: fixture.dataRoot },
    })).rejects.toThrow("routing_outcome_persistence_failed");

    expect(listJobs(fixture.db, 10, "tenant_test")[0]).toMatchObject({
      status: "running",
      lease_owner: "worker-routing-rollback",
    });
    expect(getRoutingLedgerForJob(
      fixture.db,
      "job-warden-snapshot",
      "tenant_test",
    )[0]!.outcome).toBeNull();
    fixture.db.raw.close();
  }, 30_000);

  it("rolls back the routing outcome when final agent-run persistence fails", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-finalization-rollback-"));
    dirs.push(parent);
    const fixture = setupWardenSnapshotJob({
      parent,
      checkBody: FAST_CHECK,
      snapshotExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    fixture.db.raw.exec(
      `CREATE TRIGGER reject_agent_run_finalization
       BEFORE INSERT ON agent_runs
       WHEN NEW.status = 'candidate_ready'
       BEGIN
         SELECT RAISE(ABORT, 'forced_agent_run_failure');
       END`,
    );

    await expect(processJobsOnce(fixture.db, {
      tenantId: "tenant_test",
      workerId: "worker-run-rollback",
      leaseMs: 30_000,
      wardenEnv: { MENDPOINT_DATA_DIR: fixture.dataRoot },
    })).rejects.toThrow("forced_agent_run_failure");

    expect(listJobs(fixture.db, 10, "tenant_test")[0]).toMatchObject({
      status: "running",
      lease_owner: "worker-run-rollback",
    });
    expect(getRoutingLedgerForJob(
      fixture.db,
      "job-warden-snapshot",
      "tenant_test",
    )[0]!.outcome).toBeNull();
    expect(fixture.db.raw.prepare(
      "SELECT COUNT(*) AS count FROM routing_outcome_applications",
    ).get()).toEqual({ count: 0 });
    fixture.db.raw.close();
  }, 30_000);

  it("finalizes a routed Warden retry under a new lease generation", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-routing-retry-"));
    dirs.push(parent);
    const fixture = setupWardenSnapshotJob({
      parent,
      checkBody: FAST_CHECK,
      snapshotExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      useLlm: true,
    });
    const repairPlanner = meteredWardenPlanner();
    let failFirstExecution = true;
    const planner: AgentPlanner = async (input, options) => {
      if (failFirstExecution) {
        failFirstExecution = false;
        throw new Error("transient planner failure");
      }
      return repairPlanner(input, options);
    };
    const wardenEnv = {
      MENDPOINT_DATA_DIR: fixture.dataRoot,
      MENDPOINT_WARDEN_MODEL_SOURCE_ENABLED: "1",
      MENDPOINT_WARDEN_MODEL_SOURCE_TENANTS: "tenant_test",
      MENDPOINT_WARDEN_MODEL_PROVIDER: "openai-compatible",
      MENDPOINT_WARDEN_EXTERNAL_PROCESSING_ALLOWED: "1",
      MENDPOINT_WARDEN_MODEL_REGION: "us-central",
      MENDPOINT_WARDEN_MODEL_MAXIMUM_DATA_CLASSIFICATION: "confidential",
      MENDPOINT_WARDEN_MODEL_ESTIMATED_COST_USD: "0.25",
      MENDPOINT_WARDEN_MODEL_MAXIMUM_CALL_COST_USD: "1.00",
      LLM_AGENT_MODEL: "model-a",
      LLM_AGENT_URL: "https://models.example/v1",
    };

    const first = await processJobsOnce(fixture.db, {
      tenantId: "tenant_test",
      workerId: "worker-routing-retry-1",
      leaseMs: 30_000,
      maxJobs: 1,
      wardenPlanner: planner,
      wardenEnv,
    });
    expect(first).toEqual({ claimed: 1, succeeded: 0, failed: 1, retried: 0 });
    expect(listJobs(fixture.db, 10, "tenant_test")[0]).toMatchObject({
      status: "dead_letter",
      lease_generation: 1,
    });
    expect(retryJob(fixture.db, "job-warden-snapshot", {
      tenantId: "tenant_test",
      now: "2000-01-01T00:00:00.000Z",
    })).toBe(true);

    const second = await processJobsOnce(fixture.db, {
      tenantId: "tenant_test",
      workerId: "worker-routing-retry-2",
      leaseMs: 30_000,
      maxJobs: 1,
      wardenPlanner: planner,
      wardenEnv,
    });
    expect(second).toEqual({ claimed: 1, succeeded: 1, failed: 0, retried: 0 });
    expect(listJobs(fixture.db, 10, "tenant_test")[0]).toMatchObject({
      status: "done",
      lease_generation: 2,
    });
    const ledger = getRoutingLedgerForJob(
      fixture.db,
      "job-warden-snapshot",
      "tenant_test",
    );
    expect(ledger).toHaveLength(2);
    expect(ledger.map((row) => row.outcome).sort()).toEqual(["failed", "succeeded"]);
    const applications = fixture.db.raw.prepare(
      `SELECT idempotency_key FROM routing_outcome_applications
       WHERE tenant_id = ? AND job_id = ? ORDER BY idempotency_key`,
    ).all("tenant_test", "job-warden-snapshot") as Array<{ idempotency_key: string }>;
    expect(applications.map((row) => row.idempotency_key)).toEqual([
      "job-warden-snapshot:session-warden-snapshot:lease-1:route",
      "job-warden-snapshot:session-warden-snapshot:lease-2:route",
    ]);
    fixture.db.raw.close();
  }, 30_000);

  it("persists measured cost and tokens to the routing ledger for a model backed job", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-ledger-cost-"));
    dirs.push(parent);
    const fixture = setupWardenSnapshotJob({
      parent,
      checkBody: FAST_CHECK,
      snapshotExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      useLlm: true,
    });

    const result = await processJobsOnce(fixture.db, {
      tenantId: "tenant_test",
      workerId: "worker-ledger-cost",
      leaseMs: 30_000,
      wardenPlanner: meteredWardenPlanner(),
      wardenEnv: {
        MENDPOINT_DATA_DIR: fixture.dataRoot,
        MENDPOINT_WARDEN_MODEL_SOURCE_ENABLED: "1",
        MENDPOINT_WARDEN_MODEL_SOURCE_TENANTS: "tenant_test",
        MENDPOINT_WARDEN_MODEL_PROVIDER: "openai-compatible",
        MENDPOINT_WARDEN_EXTERNAL_PROCESSING_ALLOWED: "1",
        MENDPOINT_WARDEN_MODEL_REGION: "us-central",
        MENDPOINT_WARDEN_MODEL_MAXIMUM_DATA_CLASSIFICATION: "confidential",
        MENDPOINT_WARDEN_MODEL_ESTIMATED_COST_USD: "0.25",
        MENDPOINT_WARDEN_MODEL_MAXIMUM_CALL_COST_USD: "1.00",
        LLM_AGENT_MODEL: "model-a",
        LLM_AGENT_URL: "https://models.example/v1",
      },
    });
    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0, retried: 0 });
    expect(getAgentRun(fixture.db, "session-warden-snapshot", "tenant_test")).toMatchObject({
      status: "candidate_ready",
      ok: 1,
    });

    const ledger = getRoutingLedgerForJob(fixture.db, "job-warden-snapshot", "tenant_test");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.outcome).toBe("succeeded");
    expect(ledger[0]).toMatchObject({
      provider_id: "openai-compatible",
      task_snapshot_id: "snapshot-warden-a",
    });
    expect(ledger[0]!.selected_executor_id).toMatch(/^warden-model-[a-f0-9]{64}$/);
    expect(ledger[0]!.policy_snapshot_id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ledger[0]!.policy_snapshot_id).not.toBe("snapshot-warden-a");
    const decision = JSON.parse(ledger[0]!.decision_json) as {
      evaluations: Array<Record<string, unknown>>;
    };
    expect(decision.evaluations).toEqual([
      expect.objectContaining({
        providerId: "openai-compatible",
        executorVersion: expect.stringContaining("model-a"),
        executionRegion: "us-central",
        expectedCostUsd: 0.25,
      }),
    ]);
    // The model-backed run measured usage, so real cost and tokens reach the ledger.
    expect(ledger[0]!.cost_usd).not.toBeNull();
    expect(ledger[0]!.cost_usd).toBeGreaterThan(0);
    expect(ledger[0]!.input_tokens).not.toBeNull();
    expect(ledger[0]!.input_tokens).toBeGreaterThan(0);
    expect(ledger[0]!.output_tokens).not.toBeNull();
    expect(ledger[0]!.output_tokens).toBeGreaterThan(0);
    expect(ledger[0]!.total_tokens).toBe(
      ledger[0]!.input_tokens! + ledger[0]!.output_tokens!,
    );
    fixture.db.raw.close();
  }, 30_000);

  it("persists null cost and tokens to the routing ledger for a heuristic only job", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-warden-ledger-null-"));
    dirs.push(parent);
    const fixture = setupWardenSnapshotJob({
      parent,
      checkBody: FAST_CHECK,
      snapshotExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      useLlm: false,
    });

    const result = await processJobsOnce(fixture.db, {
      tenantId: "tenant_test",
      workerId: "worker-ledger-null",
      leaseMs: 30_000,
      wardenEnv: { MENDPOINT_DATA_DIR: fixture.dataRoot },
    });
    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0, retried: 0 });
    expect(getAgentRun(fixture.db, "session-warden-snapshot", "tenant_test")).toMatchObject({
      status: "candidate_ready",
      ok: 1,
    });

    const ledger = getRoutingLedgerForJob(fixture.db, "job-warden-snapshot", "tenant_test");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.outcome).toBe("succeeded");
    expect(ledger[0]).toMatchObject({
      selected_executor_id: WARDEN_EXECUTOR_ID,
      provider_id: WARDEN_PROVIDER_ID,
      task_snapshot_id: "snapshot-warden-a",
    });
    expect(ledger[0]!.policy_snapshot_id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ledger[0]!.policy_snapshot_id).not.toBe("snapshot-warden-a");
    // A deterministic heuristic-only run made no model call, so the ledger keeps
    // null cost and tokens rather than a fabricated measured zero.
    expect(ledger[0]!.cost_usd).toBeNull();
    expect(ledger[0]!.input_tokens).toBeNull();
    expect(ledger[0]!.output_tokens).toBeNull();
    expect(ledger[0]!.total_tokens).toBeNull();
    fixture.db.raw.close();
  }, 30_000);

  it("drains an approved Transformer adaptive delivery through the exact draft handler", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-transformer-delivery-cli-"));
    dirs.push(parent);
    const dataRoot = join(parent, "data");
    mkdirSync(dataRoot, { recursive: true });
    const db = createDb(join(parent, "worker.db"));
    const files = { "src/client.ts": "export const migrated = true;\n" };
    const candidateDigest = recipeFilesDigest(files);
    const baseRevision = "a".repeat(40);
    const artifactEnv = { MENDPOINT_DATA_DIR: dataRoot } as NodeJS.ProcessEnv;
    upsertScmConnection(db, {
      id: "connection-transformer",
      tenantId: "tenant-transformer",
      provider: "github",
      credentialRef: "env://GITHUB_TOKEN",
      externalAccountId: "123",
      displayName: "Transformer test",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    });
    insertConnectedRepository(db, {
      id: "repository-transformer",
      tenantId: "tenant-transformer",
      connectionId: "connection-transformer",
      remoteId: "456",
      owner: "acme",
      name: "customer",
      defaultBranch: "main",
      selectedBranch: "release",
      status: "ready",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    });
    insertRepositorySnapshot(db, {
      id: "snapshot-transformer",
      tenantId: "tenant-transformer",
      repositoryId: "repository-transformer",
      requestedRef: "main",
      resolvedSha: baseRevision,
      manifestSha256: "d".repeat(64),
      storagePath: join(parent, "snapshot-transformer"),
      createdAt: "2026-08-06T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const seal = sealAdaptiveCandidate({
      tenantId: "tenant-transformer",
      campaignId: "campaign-transformer",
      unitId: "unit-transformer",
      attemptId: "attempt-transformer",
      repositoryId: "repository-transformer",
      snapshotId: "snapshot-transformer",
      baseBranch: "main",
      expectedBaseRevision: baseRevision,
      divergedFromDigest: `sha256:${"c".repeat(64)}`,
      candidateDigest,
      failingCommandId: "verify-tests",
      changedPaths: ["src/client.ts"],
      files,
      fileModes: { "src/client.ts": "100755" },
      review: {
        schemaVersion: 1,
        edits: [{
          path: "src/client.ts",
          changeType: "modify",
          beforeContent: "export const migrated = false;\n",
          beforeDigest: `sha256:${createHash("sha256").update("export const migrated = false;\n").digest("hex")}`,
          beforeMode: "100755",
          afterDigest: `sha256:${createHash("sha256").update(files["src/client.ts"]!).digest("hex")}`,
          afterMode: "100755",
          semanticCategory: "behavior",
          rationale: "Apply the verified client migration behavior.",
          risk: "medium",
          confidence: 92,
        }],
        verification: {
          passed: true,
          commandId: "verify-tests",
          summary: "The objective verification passed on the sealed candidate.",
          outputDigest: `sha256:${createHash("sha256").update("passed").digest("hex")}`,
        },
        overallRisk: "medium",
        confidence: 92,
      },
      env: artifactEnv,
    });
    const candidate = recordAdaptiveCandidate(db, {
      tenantId: "tenant-transformer",
      campaignId: "campaign-transformer",
      unitId: "unit-transformer",
      attemptId: "attempt-transformer",
      repositoryId: "repository-transformer",
      snapshotId: "snapshot-transformer",
      baseBranch: "main",
      expectedBaseRevision: baseRevision,
      divergedFromDigest: `sha256:${"c".repeat(64)}`,
      candidateDigest,
      failingCommandId: "verify-tests",
      sealedPath: seal.path,
      sealedSha256: seal.sha256,
      changedPaths: ["src/client.ts"],
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    reviewAdaptiveCandidate(db, {
      tenantId: "tenant-transformer",
      id: candidate.id,
      decision: "approve",
      reviewerPrincipalId: "reviewer-transformer",
      rationale: "Verified the exact semantic review evidence.",
    });
    enqueueAdaptiveDelivery(db, {
      tenantId: "tenant-transformer",
      candidateId: candidate.id,
      repositoryId: "repository-transformer",
      snapshotId: "snapshot-transformer",
      baseBranch: "main",
      expectedBaseRevision: baseRevision,
      requesterPrincipalId: "reviewer-transformer",
    });
    const github: GitHubDelivery = {
      async deliverExactDraft(input: ExactDraftDeliveryInput) {
        expect(input.baseBranch).toBe("main");
        return {
          number: 19,
          url: "https://github.com/acme/customer/pull/19",
          branch: input.branch,
          title: input.title,
          draft: true,
          baseBranch: input.baseBranch,
          baseSha: input.expectedBaseSha,
          commitSha: "b".repeat(40),
        };
      },
      async createBranch() { throw new Error("unexpected legacy delivery"); },
      async commitFiles() { throw new Error("unexpected legacy delivery"); },
      async openPullRequest() { throw new Error("unexpected legacy delivery"); },
    };

    const result = await processJobsOnce(db, {
      tenantId: "tenant-transformer",
      workerId: "worker-transformer-delivery",
      maxJobs: 1,
      runWardenMaintenance: false,
      wardenEnv: artifactEnv,
      transformerAdaptiveGithub: github,
    });

    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0, retried: 0 });
    expect(getAdaptiveCandidate(db, "tenant-transformer", candidate.id)?.status).toBe("promoted");
    expect(getAdaptiveDeliveryByCandidate(db, "tenant-transformer", candidate.id)).toMatchObject({
      status: "delivered",
      draftPr: true,
      draftPrNumber: 19,
    });
    db.raw.close();
  }, 30_000);
});
