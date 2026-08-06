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
  WARDEN_EXECUTOR_ID,
  WARDEN_PROVIDER_ID,
} from "./warden-router.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];

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
    policySnapshotId: "snapshot-1",
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

  it("flips breaker state from outcome feedback so future routing excludes it", () => {
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
      runtime.recordOutcome(`route-${i}`, {
        idempotencyKey: `k-${i}`,
        executorId: WARDEN_EXECUTOR_ID,
        providerId: WARDEN_PROVIDER_ID,
        outcome: "failed",
        startedAt: "2026-08-01T12:00:00.000Z",
        completedAt: "2026-08-01T12:00:01.000Z",
        actualLatencyMs: 1000,
        actualCostUsd: null,
        errorCode: "executor_unavailable",
        verification: { verdict: "failed", evidenceArtifactIds: [], verifierId: "v" },
      });
    }
    // The only executor is now circuit-open, so routing hands off.
    const prepared = runtime.prepare(request());
    expect(prepared.action).toBe("human_handoff");
  });

  it("does not break job completion when the ledger write fails", async () => {
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

    // The routing decision still executes and completes despite the ledger and
    // breaker writes failing on every call.
    expect(routed.run).toBe(PASSED_RUN);
    expect(routed.routing.action).toBe("completed");
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
