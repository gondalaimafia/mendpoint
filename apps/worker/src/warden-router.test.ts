import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  enqueueJob,
  getRoutingLedgerForJob,
  recordRoutingExecutorOutcome,
  type AppDb,
} from "@mendpoint/db";
import { ExecutorRegistry, type ExecutorDescriptor } from "@mendpoint/platform";
import {
  runPolicyRoutedWarden,
  type AgentRunResult,
  type WardenAttemptResult,
} from "@mendpoint/agent";
import {
  buildWardenExecutorRegistry,
  createWardenRoutingRuntime,
  synthesizeWardenRun,
  wardenExecutorDescriptor,
  wardenRoutingOutcomeAttribution,
  wardenRoutingRequest,
  type WardenModelRoutingProfile,
  WARDEN_EXECUTOR_ID,
  WARDEN_PROVIDER_ID,
} from "./warden-router.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];

const MODEL_ROUTING_PROFILE: WardenModelRoutingProfile = Object.freeze({
  provider: "openai-compatible",
  model: "model-a",
  endpoint: "https://models.example/v1/chat/completions",
  policyDigest: `sha256:${"a".repeat(64)}`,
  region: "us-central",
  maximumDataClassification: "confidential",
  estimatedCostUsd: 0.25,
});

afterEach(() => {
  while (dbs.length) {
    try {
      dbs.pop()?.raw.close?.();
    } catch {
      /* ignore */
    }
  }
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore Windows lock races */
      }
    }
  }
});

function freshDb(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-warden-router-"));
  dirs.push(dir);
  const db = createDb(join(dir, "t.sqlite"));
  dbs.push(db);
  return db;
}

const PASSED_RUN: AgentRunResult = {
  sessionId: "run-1",
  ok: true,
  goal: "Repair API client",
  steps: [],
  filesChanged: ["src/client.ts"],
  verifier: { command: "npm test", source: "provided", status: "passed", output: "ok" },
  rollback: { performed: false, restoredFiles: [], failedFiles: [] },
  reportMarkdown: "verified",
  stoppedReason: "verify_passed",
  missionPlan: null,
  metrics: {
    durationMs: 1,
    toolCalls: 1,
    verifierCalls: 1,
    model: {
      calls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      timeouts: 0,
      invalidResponses: 0,
      responseBytes: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      provenance: [],
    },
    sourceContext: {
      observedFiles: [],
      observedDirectories: [],
      searches: [],
      observedBytes: 0,
      promptEvidenceBytes: 0,
      truncatedObservations: 0,
      groundedMutations: 0,
      blockedMutations: 0,
      evidenceDigests: [],
    },
  },
};

function backupExecutor(): ExecutorDescriptor {
  return {
    ...wardenExecutorDescriptor("2026-08-01T12:00:00.000Z"),
    executorId: "warden-backup",
    providerId: "mendpoint-backup",
    kind: "adapter",
    version: "warden-backup-1",
    price: {
      version: "warden-backup-price-1",
      currency: "USD",
      effectiveAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function request(overrides: Partial<Parameters<typeof wardenRoutingRequest>[0]> = {}) {
  return wardenRoutingRequest({
    taskId: "job-1",
    tenantId: "tenant_default",
    goal: "Repair API client",
    idempotencyKey: "run-1",
    verifyCommand: "npm test",
    sourceArtifactId: "snapshot-1",
    decidedAt: new Date("2026-08-01T12:00:00.000Z"),
    ...overrides,
  });
}

type AttemptUsage = NonNullable<WardenAttemptResult["agent"]>["usage"];

function succeededAttempt(usage: AttemptUsage): WardenAttemptResult {
  return {
    status: "succeeded",
    summary: "candidate verified",
    nextActions: ["review"],
    changedPaths: ["src/client.ts"],
    agent: {
      sessionId: "run-1",
      ok: true,
      steps: 3,
      stoppedReason: "verify_passed",
      filesChanged: ["src/client.ts"],
      reportMarkdown: "verified",
      toolCalls: 3,
      verifierCalls: 1,
      modelCalls: usage.measured ? 2 : 0,
      modelSuccessfulCalls: usage.measured ? 2 : 0,
      groundedMutations: 1,
      blockedMutations: 0,
      missionPlan: null,
      sourceContext: {
        observedFiles: [],
        observedDirectories: [],
        searches: [],
        observedBytes: 0,
        promptEvidenceBytes: 0,
        truncatedObservations: 0,
        groundedMutations: 1,
        blockedMutations: 0,
        evidenceDigests: [],
      },
      modelSource: {
        authorized: false,
        policyDigest: null,
        provider: null,
        model: null,
        endpoint: null,
      },
      usage,
    },
    artifacts: {
      candidateWorkspace: "/tmp/candidate",
      candidateManifest: "/tmp/manifest.json",
      evidence: "/tmp/evidence.json",
      sourceDigest: "sha256:aa",
      candidateDigest: "sha256:bb",
    },
  };
}

describe("warden routing runtime", () => {
  it("binds feature tasks to a distinct executor capability", () => {
    expect(request({ taskMode: "feature" }).task.requiredCapabilities)
      .toEqual(["warden.feature"]);
    expect(wardenExecutorDescriptor("2026-08-01T12:00:00.000Z").capabilities)
      .toEqual(["warden.repair"]);
    expect(wardenExecutorDescriptor("2026-08-01T12:00:00.000Z", undefined, "feature").capabilities)
      .toEqual(expect.arrayContaining(["warden.repair", "warden.feature"]));
  });

  it("hands off an external model before planner execution when processing is denied", async () => {
    const db = freshDb();
    const runtime = createWardenRoutingRuntime({
      db,
      tenantId: "tenant_default",
      jobId: "job-1",
      runId: "run-1",
      registry: buildWardenExecutorRegistry(
        "2026-08-01T12:00:00.000Z",
        MODEL_ROUTING_PROFILE,
      ),
    });
    const planner = vi.fn(async () => PASSED_RUN);
    const descriptor = wardenExecutorDescriptor(
      "2026-08-01T12:00:00.000Z",
      MODEL_ROUTING_PROFILE,
    );

    const routed = await runPolicyRoutedWarden({
      task: { goal: "Repair API client", repoRoot: "." },
      routingRequest: request({
        modelSource: MODEL_ROUTING_PROFILE,
        externalProcessingAllowed: false,
      }),
      runtime,
      outcomeIdempotencyKey: "job-1:run-1:denied",
      telemetry: () => ({ actualCostUsd: null, verifierId: "warden-attempt-verifier" }),
      executor: {
        executorId: descriptor.executorId,
        providerId: descriptor.providerId,
        run: planner,
      },
    });

    expect(routed.routing.action).toBe("human_handoff");
    expect(routed.run).toBeNull();
    expect(planner).not.toHaveBeenCalled();
    const ledger = getRoutingLedgerForJob(db, "job-1", "tenant_default");
    expect(JSON.parse(ledger[0]!.eliminated_json)).toEqual([
      expect.objectContaining({ reasons: expect.arrayContaining(["privacy_disallowed"]) }),
    ]);
  });

  it("routes an approved tenant model with exact provider and model provenance", () => {
    const db = freshDb();
    const descriptor = wardenExecutorDescriptor(
      "2026-08-01T12:00:00.000Z",
      MODEL_ROUTING_PROFILE,
    );
    const registry = buildWardenExecutorRegistry(
      "2026-08-01T12:00:00.000Z",
      MODEL_ROUTING_PROFILE,
    );
    const runtime = createWardenRoutingRuntime({
      db,
      tenantId: "tenant_default",
      jobId: "job-1",
      runId: "run-1",
      registry,
    });
    const routingRequest = request({
      modelSource: MODEL_ROUTING_PROFILE,
      externalProcessingAllowed: true,
      classification: "internal",
    });
    const prepared = runtime.prepare(routingRequest);

    expect(descriptor).toMatchObject({
      providerId: MODEL_ROUTING_PROFILE.provider,
      deployment: "external",
      regions: [MODEL_ROUTING_PROFILE.region],
      maximumDataClassification: MODEL_ROUTING_PROFILE.maximumDataClassification,
      estimatedCostUsd: MODEL_ROUTING_PROFILE.estimatedCostUsd,
      health: { evidenceRef: MODEL_ROUTING_PROFILE.policyDigest },
    });
    expect(descriptor.version).toContain(MODEL_ROUTING_PROFILE.model);
    expect(descriptor.executorId).not.toBe(WARDEN_EXECUTOR_ID);
    expect(prepared).toMatchObject({
      action: "execute",
      selectedExecutorId: descriptor.executorId,
      dispatch: {
        executorId: descriptor.executorId,
        providerId: MODEL_ROUTING_PROFILE.provider,
      },
    });
    expect(routingRequest.task.inputArtifactIds).toEqual([
      "snapshot-1",
      MODEL_ROUTING_PROFILE.policyDigest,
    ]);
    expect(routingRequest.policy.snapshotId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(routingRequest.policy.snapshotId).not.toBe("snapshot-1");
    expect(routingRequest.policy).toMatchObject({
      privacy: { externalProcessingAllowed: true },
      region: { allowedExecutionRegions: [MODEL_ROUTING_PROFILE.region] },
    });
  });

  it("keeps heuristic fallback internal and excludes model policy artifacts", () => {
    const routingRequest = request();
    const descriptor = wardenExecutorDescriptor("2026-08-01T12:00:00.000Z");

    expect(descriptor).toMatchObject({
      executorId: WARDEN_EXECUTOR_ID,
      providerId: WARDEN_PROVIDER_ID,
      deployment: "internal",
      regions: ["internal"],
      estimatedCostUsd: 0,
    });
    expect(routingRequest.task.inputArtifactIds).toEqual(["snapshot-1"]);
    expect(routingRequest.policy.privacy.externalProcessingAllowed).toBe(false);
    expect(routingRequest.policy.region.allowedExecutionRegions).toEqual(["internal"]);
  });

  it("persists a routing decision for a real queued job", async () => {
    const db = freshDb();
    enqueueJob(db, {
      id: "job-1",
      tenantId: "tenant_default",
      type: "agent.run",
      payload: { goal: "Repair API client" },
      createdAt: "2026-08-01T12:00:00.000Z",
    });
    const runtime = createWardenRoutingRuntime({
      db,
      tenantId: "tenant_default",
      jobId: "job-1",
      runId: "run-1",
      registry: buildWardenExecutorRegistry("2026-08-01T12:00:00.000Z"),
    });

    const routed = await runPolicyRoutedWarden({
      task: { goal: "Repair API client", repoRoot: "." },
      routingRequest: request(),
      runtime,
      outcomeIdempotencyKey: "job-1:run-1:route",
      telemetry: () => ({ actualCostUsd: null, verifierId: "warden-attempt-verifier" }),
      executor: {
        executorId: WARDEN_EXECUTOR_ID,
        providerId: WARDEN_PROVIDER_ID,
        run: async () => PASSED_RUN,
      },
    });

    expect(routed.run).toBe(PASSED_RUN);
    const ledger = getRoutingLedgerForJob(db, "job-1", "tenant_default");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.action).toBe("completed");
    expect(ledger[0]!.selected_executor_id).toBe(WARDEN_EXECUTOR_ID);
    expect(ledger[0]!.provider_id).toBe(WARDEN_PROVIDER_ID);
    expect(ledger[0]!.outcome).toBe("succeeded");
    expect(ledger[0]!.run_id).toBe("run-1");
    expect(ledger[0]!.envelope_id).toBe(routed.routing.envelopeId);
  });

  it("records a fallback selection when the primary executor is unavailable", () => {
    const db = freshDb();
    const registry = new ExecutorRegistry();
    registry.register(wardenExecutorDescriptor("2026-08-01T12:00:00.000Z"));
    registry.register(backupExecutor());
    // Open the primary breaker via three failure outcomes.
    for (let i = 0; i < 3; i += 1) {
      recordRoutingExecutorOutcome(db, {
        tenantId: "tenant_default",
        executorId: WARDEN_EXECUTOR_ID,
        providerId: WARDEN_PROVIDER_ID,
        success: false,
        observedAt: "2026-08-01T12:00:00.000Z",
      });
    }
    const runtime = createWardenRoutingRuntime({
      db,
      tenantId: "tenant_default",
      jobId: "job-1",
      runId: "run-1",
      registry,
    });

    const prepared = runtime.prepare(request());
    expect(prepared.action).toBe("execute");
    expect(prepared.selectedExecutorId).toBe("warden-backup");

    const ledger = getRoutingLedgerForJob(db, "job-1", "tenant_default");
    expect(ledger[0]!.selected_executor_id).toBe("warden-backup");
    const eliminated = JSON.parse(ledger[0]!.eliminated_json) as Array<{
      executorId: string;
      reasons: string[];
    }>;
    const primaryEviction = eliminated.find((e) => e.executorId === WARDEN_EXECUTOR_ID);
    expect(primaryEviction?.reasons).toContain("circuit_open");
  });

  it("attributes cost from an execution outcome", () => {
    const db = freshDb();
    const runtime = createWardenRoutingRuntime({
      db,
      tenantId: "tenant_default",
      jobId: "job-1",
      runId: "run-1",
      registry: buildWardenExecutorRegistry("2026-08-01T12:00:00.000Z"),
    });
    const prepared = runtime.prepare(request());
    runtime.recordOutcome(prepared.envelopeId, {
      idempotencyKey: "job-1:run-1:route",
      executorId: WARDEN_EXECUTOR_ID,
      providerId: WARDEN_PROVIDER_ID,
      outcome: "succeeded",
      startedAt: "2026-08-01T12:00:00.000Z",
      completedAt: "2026-08-01T12:00:02.000Z",
      actualLatencyMs: 2000,
      actualCostUsd: 0.42,
      verification: {
        verdict: "passed",
        evidenceArtifactIds: [],
        verifierId: "warden-attempt-verifier",
      },
    });
    const ledger = getRoutingLedgerForJob(db, "job-1", "tenant_default");
    expect(ledger[0]!.cost_usd).toBe(0.42);
    expect(ledger[0]!.completed_at).toBe("2026-08-01T12:00:02.000Z");
  });

  it("blocks autonomous completion when policy requires human review", async () => {
    const db = freshDb();
    const executor = vi.fn(async () => PASSED_RUN);
    const runtime = createWardenRoutingRuntime({
      db,
      tenantId: "tenant_default",
      jobId: "job-1",
      runId: "run-1",
      registry: buildWardenExecutorRegistry("2026-08-01T12:00:00.000Z"),
    });

    const routed = await runPolicyRoutedWarden({
      task: { goal: "Repair API client", repoRoot: "." },
      routingRequest: request({ risk: "high" }),
      runtime,
      outcomeIdempotencyKey: "job-1:run-1:route",
      telemetry: () => ({ actualCostUsd: null, verifierId: "warden-attempt-verifier" }),
      executor: {
        executorId: WARDEN_EXECUTOR_ID,
        providerId: WARDEN_PROVIDER_ID,
        run: executor,
      },
    });

    expect(routed.run).toBeNull();
    expect(routed.routing.action).toBe("human_handoff");
    expect(executor).not.toHaveBeenCalled();
    const ledger = getRoutingLedgerForJob(db, "job-1", "tenant_default");
    expect(ledger[0]!.handoff_required).toBe(1);
    expect(ledger[0]!.handoff_reason).toBe("high_risk");
  });

  it("opens the breaker after three provider availability failures", () => {
    const db = freshDb();
    const runtime = createWardenRoutingRuntime({
      db,
      tenantId: "tenant_default",
      jobId: "job-1",
      runId: "run-1",
      registry: buildWardenExecutorRegistry("2026-08-01T12:00:00.000Z"),
    });
    // Feed three failed outcomes through the runtime's outcome path.
    for (let i = 0; i < 3; i += 1) {
      const prepared = runtime.prepare(request({
        taskId: `job-breaker-${i}`,
        idempotencyKey: `run-breaker-${i}`,
      }));
      runtime.recordOutcome(prepared.envelopeId, {
        idempotencyKey: `k-${i}`,
        executorId: WARDEN_EXECUTOR_ID,
        providerId: WARDEN_PROVIDER_ID,
        outcome: "failed",
        startedAt: "2026-08-01T12:00:00.000Z",
        completedAt: "2026-08-01T12:00:01.000Z",
        actualLatencyMs: 1000,
        actualCostUsd: null,
        errorCode: "provider_unavailable",
        verification: { verdict: "failed", evidenceArtifactIds: [], verifierId: "v" },
      });
    }
    // The only executor is now circuit-open, so routing hands off.
    const prepared = runtime.prepare(request());
    expect(prepared.action).toBe("human_handoff");
    expect(db.raw.prepare(
      `SELECT consecutive_failures FROM routing_executor_health
       WHERE tenant_id = ? AND scope = 'provider' AND provider_id = ?`,
    ).get("tenant_default", WARDEN_PROVIDER_ID)).toEqual({ consecutive_failures: 3 });
  });

  it("does not open the breaker after three customer verification failures", () => {
    const db = freshDb();
    const runtime = createWardenRoutingRuntime({
      db,
      tenantId: "tenant_default",
      jobId: "job-1",
      runId: "run-1",
      registry: buildWardenExecutorRegistry("2026-08-01T12:00:00.000Z"),
    });
    for (let i = 0; i < 3; i += 1) {
      const prepared = runtime.prepare(request({
        taskId: `job-verification-${i}`,
        idempotencyKey: `run-verification-${i}`,
      }));
      runtime.recordOutcome(prepared.envelopeId, {
        idempotencyKey: `verification-${i}`,
        executorId: WARDEN_EXECUTOR_ID,
        providerId: WARDEN_PROVIDER_ID,
        outcome: "failed",
        startedAt: "2026-08-01T12:00:00.000Z",
        completedAt: "2026-08-01T12:00:01.000Z",
        actualLatencyMs: 1000,
        actualCostUsd: null,
        errorCode: "verification_failed",
        verification: { verdict: "failed", evidenceArtifactIds: [], verifierId: "v" },
      });
    }

    expect(runtime.prepare(request({
      taskId: "job-after-verification",
      idempotencyKey: "run-after-verification",
    })).action).toBe("execute");
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM routing_executor_health WHERE tenant_id = ?",
    ).get("tenant_default")).toEqual({ count: 0 });
    expect(db.raw.prepare(
      `SELECT COUNT(*) AS count FROM routing_ledger
       WHERE tenant_id = ? AND job_id = ? AND outcome = ? AND error_code = ?`,
    ).get("tenant_default", "job-1", "failed", "verification_failed")).toEqual({ count: 3 });
  });

  it("fails closed before execution when breaker state cannot be read", async () => {
    const brokenDb = {
      raw: {
        prepare() {
          throw new Error("database is locked");
        },
        close() {
          /* noop */
        },
      },
    } as unknown as AppDb;
    const runtime = createWardenRoutingRuntime({
      db: brokenDb,
      tenantId: "tenant_default",
      jobId: "job-1",
      runId: "run-1",
      registry: buildWardenExecutorRegistry("2026-08-01T12:00:00.000Z"),
    });

    const execute = vi.fn(async () => PASSED_RUN);
    await expect(runPolicyRoutedWarden({
      task: { goal: "Repair API client", repoRoot: "." },
      routingRequest: request(),
      runtime,
      outcomeIdempotencyKey: "job-1:run-1:route",
      telemetry: () => ({ actualCostUsd: null, verifierId: "warden-attempt-verifier" }),
      executor: {
        executorId: WARDEN_EXECUTOR_ID,
        providerId: WARDEN_PROVIDER_ID,
        run: execute,
      },
    })).rejects.toMatchObject({ code: "routing_breaker_state_unavailable" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed before execution when the routing decision cannot be persisted", async () => {
    const db = freshDb();
    const raw = {
      prepare(sql: string) {
        if (/routing_executor_health/.test(sql)) return db.raw.prepare(sql);
        throw new Error("decision ledger unavailable");
      },
      close() {
        /* owned by freshDb */
      },
    } as unknown as AppDb["raw"];
    const runtime = createWardenRoutingRuntime({
      db: { raw },
      tenantId: "tenant_default",
      jobId: "job-1",
      runId: "run-1",
      registry: buildWardenExecutorRegistry("2026-08-01T12:00:00.000Z"),
    });
    const execute = vi.fn(async () => PASSED_RUN);

    await expect(runPolicyRoutedWarden({
      task: { goal: "Repair API client", repoRoot: "." },
      routingRequest: request(),
      runtime,
      outcomeIdempotencyKey: "job-1:run-1:route",
      telemetry: () => ({ actualCostUsd: null, verifierId: "warden-attempt-verifier" }),
      executor: {
        executorId: WARDEN_EXECUTOR_ID,
        providerId: WARDEN_PROVIDER_ID,
        run: execute,
      },
    })).rejects.toMatchObject({ code: "routing_decision_persistence_failed" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("applies identical routing outcomes exactly once", () => {
    const db = freshDb();
    const runtime = createWardenRoutingRuntime({
      db,
      tenantId: "tenant_default",
      jobId: "job-1",
      runId: "run-1",
      registry: buildWardenExecutorRegistry("2026-08-01T12:00:00.000Z"),
    });
    const prepared = runtime.prepare(request());
    const outcome = {
      idempotencyKey: "outcome-once",
      executorId: WARDEN_EXECUTOR_ID,
      providerId: WARDEN_PROVIDER_ID,
      outcome: "failed" as const,
      startedAt: "2026-08-01T12:00:00.000Z",
      completedAt: "2026-08-01T12:00:01.000Z",
      actualLatencyMs: 1000,
      actualCostUsd: null,
      errorCode: "executor_unavailable",
      verification: { verdict: "failed" as const, evidenceArtifactIds: [], verifierId: "v" },
    };

    runtime.recordOutcome(prepared.envelopeId, outcome);
    runtime.recordOutcome(prepared.envelopeId, outcome);

    const health = db.raw.prepare(
      `SELECT consecutive_failures FROM routing_executor_health
       WHERE tenant_id = ? AND scope = 'executor' AND executor_id = ? AND provider_id = ?`,
    ).get("tenant_default", WARDEN_EXECUTOR_ID, WARDEN_PROVIDER_ID) as
      | { consecutive_failures: number }
      | undefined;
    expect(health?.consecutive_failures).toBe(1);
  });

  it("defers an outcome so an outer job-finalization transaction owns commit and rollback", () => {
    const db = freshDb();
    const runtime = createWardenRoutingRuntime({
      db,
      tenantId: "tenant_default",
      jobId: "job-1",
      runId: "run-1",
      registry: buildWardenExecutorRegistry("2026-08-01T12:00:00.000Z"),
      deferOutcomePersistence: true,
    });
    const prepared = runtime.prepare(request());
    runtime.recordOutcome(prepared.envelopeId, {
      idempotencyKey: "outcome-deferred",
      executorId: WARDEN_EXECUTOR_ID,
      providerId: WARDEN_PROVIDER_ID,
      outcome: "failed",
      startedAt: "2026-08-01T12:00:00.000Z",
      completedAt: "2026-08-01T12:00:01.000Z",
      actualLatencyMs: 1000,
      actualCostUsd: null,
      errorCode: "provider_unavailable",
      verification: { verdict: "failed", evidenceArtifactIds: [], verifierId: "v" },
    });
    expect(getRoutingLedgerForJob(db, "job-1", "tenant_default")[0]!.outcome).toBeNull();

    db.raw.exec("BEGIN IMMEDIATE");
    runtime.applyPendingOutcome();
    db.raw.exec("ROLLBACK");
    expect(getRoutingLedgerForJob(db, "job-1", "tenant_default")[0]!.outcome).toBeNull();
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM routing_outcome_applications",
    ).get()).toEqual({ count: 0 });

    db.raw.exec("BEGIN IMMEDIATE");
    runtime.applyPendingOutcome();
    db.raw.exec("COMMIT");
    runtime.applyPendingOutcome();
    expect(getRoutingLedgerForJob(db, "job-1", "tenant_default")[0]).toMatchObject({
      outcome: "failed",
      error_code: "provider_unavailable",
    });
    expect(db.raw.prepare(
      `SELECT consecutive_failures FROM routing_executor_health
       WHERE tenant_id = ? AND scope = 'provider' AND provider_id = ?`,
    ).get("tenant_default", WARDEN_PROVIDER_ID)).toEqual({ consecutive_failures: 1 });
  });

  it("rejects reuse of an outcome idempotency key with different evidence", () => {
    const db = freshDb();
    const runtime = createWardenRoutingRuntime({
      db,
      tenantId: "tenant_default",
      jobId: "job-1",
      runId: "run-1",
      registry: buildWardenExecutorRegistry("2026-08-01T12:00:00.000Z"),
    });
    const prepared = runtime.prepare(request());
    const outcome = {
      idempotencyKey: "outcome-conflict",
      executorId: WARDEN_EXECUTOR_ID,
      providerId: WARDEN_PROVIDER_ID,
      outcome: "failed" as const,
      startedAt: "2026-08-01T12:00:00.000Z",
      completedAt: "2026-08-01T12:00:01.000Z",
      actualLatencyMs: 1000,
      actualCostUsd: null,
      errorCode: "executor_unavailable",
      verification: { verdict: "failed" as const, evidenceArtifactIds: [], verifierId: "v" },
    };
    runtime.recordOutcome(prepared.envelopeId, outcome);

    expect(() => runtime.recordOutcome(prepared.envelopeId, {
      ...outcome,
      errorCode: "provider_unavailable",
    })).toThrowError(expect.objectContaining({ code: "routing_outcome_idempotency_conflict" }));
  });

  it("records real cost and tokens propagated from the attempt summary", () => {
    const db = freshDb();
    const runtime = createWardenRoutingRuntime({
      db,
      tenantId: "tenant_default",
      jobId: "job-1",
      runId: "run-1",
      registry: buildWardenExecutorRegistry("2026-08-01T12:00:00.000Z"),
    });
    const attempt = succeededAttempt({
      measured: true,
      costUsd: 0.0125,
      promptTokens: 900,
      completionTokens: 150,
      totalTokens: 1050,
    });
    // The synthesized run carries the measured usage to the caller instead of the
    // previously hardcoded zeros.
    const run = synthesizeWardenRun(attempt, "run-1", "Repair API client");
    expect(run.metrics.model.costUsd).toBeCloseTo(0.0125, 10);
    expect(run.metrics.model.promptTokens).toBe(900);
    expect(run.metrics.model.totalTokens).toBe(1050);
    const attribution = wardenRoutingOutcomeAttribution(attempt);
    expect(attribution.costUsd).toBeCloseTo(0.0125, 10);

    const prepared = runtime.prepare(request());
    runtime.recordOutcome(prepared.envelopeId, {
      idempotencyKey: "job-1:run-1:route",
      executorId: WARDEN_EXECUTOR_ID,
      providerId: WARDEN_PROVIDER_ID,
      outcome: "succeeded",
      startedAt: "2026-08-01T12:00:00.000Z",
      completedAt: "2026-08-01T12:00:02.000Z",
      actualLatencyMs: 2000,
      actualCostUsd: attribution.costUsd,
      inputTokens: attribution.inputTokens,
      outputTokens: attribution.outputTokens,
      totalTokens: attribution.totalTokens,
      verification: {
        verdict: "passed",
        evidenceArtifactIds: [],
        verifierId: "warden-attempt-verifier",
      },
    });

    const ledger = getRoutingLedgerForJob(db, "job-1", "tenant_default");
    expect(ledger[0]!.cost_usd).toBeCloseTo(0.0125, 10);
    expect(ledger[0]!.input_tokens).toBe(900);
    expect(ledger[0]!.output_tokens).toBe(150);
    expect(ledger[0]!.total_tokens).toBe(1050);
  });

  it("attributes null cost and tokens for a heuristic only attempt", () => {
    const db = freshDb();
    const runtime = createWardenRoutingRuntime({
      db,
      tenantId: "tenant_default",
      jobId: "job-1",
      runId: "run-1",
      registry: buildWardenExecutorRegistry("2026-08-01T12:00:00.000Z"),
    });
    const attempt = succeededAttempt({
      measured: false,
      costUsd: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
    // No model call was made, so the synthesized run reports a measured zero
    // while the attribution stays null (never a fabricated measured cost).
    const run = synthesizeWardenRun(attempt, "run-1", "Repair API client");
    expect(run.metrics.model.costUsd).toBe(0);
    const attribution = wardenRoutingOutcomeAttribution(attempt);
    expect(attribution.costUsd).toBeNull();
    expect(attribution.inputTokens).toBeNull();
    expect(attribution.totalTokens).toBeNull();

    const prepared = runtime.prepare(request());
    runtime.recordOutcome(prepared.envelopeId, {
      idempotencyKey: "job-1:run-1:route",
      executorId: WARDEN_EXECUTOR_ID,
      providerId: WARDEN_PROVIDER_ID,
      outcome: "succeeded",
      startedAt: "2026-08-01T12:00:00.000Z",
      completedAt: "2026-08-01T12:00:02.000Z",
      actualLatencyMs: 2000,
      actualCostUsd: attribution.costUsd,
      inputTokens: attribution.inputTokens,
      outputTokens: attribution.outputTokens,
      totalTokens: attribution.totalTokens,
      verification: {
        verdict: "passed",
        evidenceArtifactIds: [],
        verifierId: "warden-attempt-verifier",
      },
    });

    const ledger = getRoutingLedgerForJob(db, "job-1", "tenant_default");
    expect(ledger[0]!.cost_usd).toBeNull();
    expect(ledger[0]!.total_tokens).toBeNull();
  });
});
