import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  getRoutingLedgerForJob,
  type AppDb,
} from "@mendpoint/db";
import type { TransformerAttemptRunResult } from "@mendpoint/transformer";
import {
  createWardenRoutingRuntime,
  wardenRoutingRequest,
  WARDEN_EXECUTOR_ID,
} from "./warden-router.js";
import {
  buildRoutedExecutorRegistry,
  runRoutedTransformerAttempt,
  synthesizeTransformerRun,
  transformerExecutorDescriptor,
  transformerRoutingOutcomeAttribution,
  transformerRoutingRequest,
  TRANSFORMER_EXECUTOR_ID,
  TRANSFORMER_PROVIDER_ID,
} from "./transformer-router.js";

const CHECKED_AT = "2026-08-01T12:00:00.000Z";

it("describes an authorized external adaptive route with its real policy and cost ceiling", () => {
  expect(transformerExecutorDescriptor(CHECKED_AT, {
    provider: "openai-compatible",
    model: "model-a",
    deployment: "us-central-primary",
    executionRegion: "us-central",
    maximumDataClassification: "confidential",
    maximumCostUsd: 3.5,
  })).toMatchObject({
    providerId: "openai-compatible",
    kind: "frontier_model",
    version: expect.stringMatching(/^model-a@us-central-primary@sha256:[a-f0-9]{64}$/),
    deployment: "external",
    regions: ["us-central"],
    maximumDataClassification: "confidential",
    estimatedCostUsd: 3.5,
  });
});

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
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-transformer-router-"));
  dirs.push(dir);
  const db = createDb(join(dir, "t.sqlite"));
  dbs.push(db);
  return db;
}

function completedAttempt(): TransformerAttemptRunResult {
  return Object.freeze({
    status: "completed",
    summary: "Transformer candidate verified and durably persisted",
    nextActions: Object.freeze(["Review the durable candidate before draft delivery"]),
    artifacts: Object.freeze([]),
  });
}

function failedAttempt(errorCode = "recipe_execution_failed"): TransformerAttemptRunResult {
  return Object.freeze({
    status: "failed",
    summary: errorCode,
    nextActions: Object.freeze(["Review execution evidence and authorize a fenced retry"]),
    artifacts: Object.freeze([]),
    recoveryCode: "execution_failed",
    errorCode,
  });
}

function transformerRequest(campaignId: string, decidedAt: Date, risk?: "high") {
  return transformerRoutingRequest({
    taskId: campaignId,
    tenantId: "tenant_default",
    campaignId,
    idempotencyKey: `claim-${campaignId}`,
    policySnapshotId: `snapshot-${campaignId}`,
    sourceArtifactIds: [
      `snapshot-${campaignId}`,
      `revision:${"a".repeat(40)}`,
      `manifest:${"b".repeat(64)}`,
      `sha256:${"c".repeat(64)}`,
    ],
    decidedAt,
    ...(risk ? { risk } : {}),
  });
}

describe("transformer routing runtime", () => {
  it("routes a Transformer task to the Transformer executor and persists a ledger row naming it", async () => {
    const db = freshDb();
    const routed = await runRoutedTransformerAttempt({
      db,
      registry: buildRoutedExecutorRegistry(CHECKED_AT),
      tenantId: "tenant_default",
      jobId: "campaign-1",
      runId: "run-1",
      sessionId: "run-1",
      goal: "Transformer recipe migration for campaign-1",
      routingRequest: transformerRequest("campaign-1", new Date(CHECKED_AT)),
      outcomeIdempotencyKey: "campaign-1:run-1:route",
      runAttempt: async () => completedAttempt(),
    });

    expect(routed.status).toBe("completed");
    const ledger = getRoutingLedgerForJob(db, "campaign-1", "tenant_default");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.task_kind).toBe("transformer.attempt");
    expect(ledger[0]!.selected_executor_id).toBe(TRANSFORMER_EXECUTOR_ID);
    expect(ledger[0]!.provider_id).toBe(TRANSFORMER_PROVIDER_ID);
    expect(ledger[0]!.action).toBe("completed");
    expect(ledger[0]!.outcome).toBe("succeeded");
    expect(ledger[0]!.run_id).toBe("run-1");
    // The transformer decision genuinely selected transformer over warden: the
    // warden executor is present in the registry but eliminated by capability.
    const eliminated = JSON.parse(ledger[0]!.eliminated_json) as Array<{
      executorId: string;
      reasons: string[];
    }>;
    const warden = eliminated.find((e) => e.executorId === WARDEN_EXECUTOR_ID);
    expect(warden?.reasons).toContain("capability_missing");
  });

  it("records a deterministic failure without poisoning the availability breaker", async () => {
    const db = freshDb();
    const registry = buildRoutedExecutorRegistry(CHECKED_AT);
    const at = new Date();
    for (let i = 0; i < 3; i += 1) {
      const routed = await runRoutedTransformerAttempt({
        db,
        registry,
        tenantId: "tenant_default",
        jobId: `campaign-${i}`,
        runId: `run-${i}`,
        sessionId: `run-${i}`,
        goal: "migrate",
        routingRequest: transformerRequest(`campaign-${i}`, at),
        outcomeIdempotencyKey: `route-${i}`,
        runAttempt: async () => failedAttempt(),
      });
      expect(routed.status).toBe("failed");
      expect(routed.errorCode).toBe("recipe_execution_failed");
    }

    // The real recovery/error code is persisted against the outcome, not a
    // generic failure string.
    const ledger = getRoutingLedgerForJob(db, "campaign-0", "tenant_default");
    expect(ledger[0]!.outcome).toBe("failed");
    expect(ledger[0]!.error_code).toBe("recipe_execution_failed");

    // Deterministic recipe failures do not imply executor or provider
    // unavailability, so the next route remains eligible.
    const attempt = vi.fn(async () => completedAttempt());
    const blocked = await runRoutedTransformerAttempt({
      db,
      registry,
      tenantId: "tenant_default",
      jobId: "campaign-final",
      runId: "run-final",
      sessionId: "run-final",
      goal: "migrate",
      routingRequest: transformerRequest("campaign-final", at),
      outcomeIdempotencyKey: "route-final",
      runAttempt: attempt,
    });
    expect(blocked.status).toBe("completed");
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("blocks autonomous Transformer execution when policy requires human review", async () => {
    const db = freshDb();
    const attempt = vi.fn(async () => completedAttempt());
    const routed = await runRoutedTransformerAttempt({
      db,
      registry: buildRoutedExecutorRegistry(CHECKED_AT),
      tenantId: "tenant_default",
      jobId: "campaign-1",
      runId: "run-1",
      sessionId: "run-1",
      goal: "migrate",
      routingRequest: transformerRequest("campaign-1", new Date(CHECKED_AT), "high"),
      outcomeIdempotencyKey: "route-1",
      runAttempt: attempt,
    });

    expect(routed.status).toBe("handoff");
    expect(routed.result).toBeNull();
    expect(attempt).not.toHaveBeenCalled();
    const ledger = getRoutingLedgerForJob(db, "campaign-1", "tenant_default");
    expect(ledger[0]!.handoff_required).toBe(1);
    expect(ledger[0]!.handoff_reason).toBe("high_risk");
  });

  it("routes Warden and Transformer independently without cross-contaminating breaker state", async () => {
    const db = freshDb();
    const registry = buildRoutedExecutorRegistry(CHECKED_AT);
    const at = new Date();
    // Open the transformer executor and provider breaker with three attributable
    // availability failures.
    for (let i = 0; i < 3; i += 1) {
      const routed = await runRoutedTransformerAttempt({
        db,
        registry,
        tenantId: "tenant_default",
        jobId: `transformer-${i}`,
        runId: `tr-${i}`,
        sessionId: `tr-${i}`,
        goal: "migrate",
        routingRequest: transformerRequest(`transformer-${i}`, at),
        outcomeIdempotencyKey: `troute-${i}`,
        runAttempt: async () => failedAttempt("provider_unavailable"),
      });
      expect(routed.status).toBe("failed");
    }

    // The transformer executor is now circuit-open, so a transformer task hands
    // off in the same tenant.
    const transformerBlocked = await runRoutedTransformerAttempt({
      db,
      registry,
      tenantId: "tenant_default",
      jobId: "transformer-final",
      runId: "tr-final",
      sessionId: "tr-final",
      goal: "migrate",
      routingRequest: transformerRequest("transformer-final", at),
      outcomeIdempotencyKey: "troute-final",
      runAttempt: async () => completedAttempt(),
    });
    expect(transformerBlocked.status).toBe("handoff");

    // A Warden task in the same tenant and registry is unaffected: its breaker
    // is untouched, so it still routes to the Warden executor.
    const wardenRuntime = createWardenRoutingRuntime({
      db,
      tenantId: "tenant_default",
      jobId: "warden-1",
      runId: "wr-1",
      registry,
    });
    const wardenPrepared = wardenRuntime.prepare(
      wardenRoutingRequest({
        taskId: "warden-1",
        tenantId: "tenant_default",
        goal: "Repair API client",
        idempotencyKey: "wk-1",
        verifyCommand: "npm test",
        policySnapshotId: "wsnapshot-1",
        decidedAt: at,
      }),
    );
    expect(wardenPrepared.action).toBe("execute");
    expect(wardenPrepared.selectedExecutorId).toBe(WARDEN_EXECUTOR_ID);
  });

  it("records honest null cost and tokens for a deterministic Transformer run", async () => {
    const db = freshDb();
    const routed = await runRoutedTransformerAttempt({
      db,
      registry: buildRoutedExecutorRegistry(CHECKED_AT),
      tenantId: "tenant_default",
      jobId: "campaign-1",
      runId: "run-1",
      sessionId: "run-1",
      goal: "migrate",
      routingRequest: transformerRequest("campaign-1", new Date(CHECKED_AT)),
      outcomeIdempotencyKey: "route-1",
      runAttempt: async () => completedAttempt(),
    });

    expect(routed.status).toBe("completed");
    const ledger = getRoutingLedgerForJob(db, "campaign-1", "tenant_default");
    expect(ledger[0]!.cost_usd).toBeNull();
    expect(ledger[0]!.input_tokens).toBeNull();
    expect(ledger[0]!.output_tokens).toBeNull();
    expect(ledger[0]!.total_tokens).toBeNull();
  });
});

describe("transformer result mapping", () => {
  it("maps a completed attempt to a passing run and a failure to its real code", () => {
    const completed = synthesizeTransformerRun(completedAttempt(), "run-1", "migrate");
    expect(completed.ok).toBe(true);
    expect(completed.verifier.status).toBe("passed");
    expect(completed.stoppedReason).toBe("verify_passed");

    const failed = synthesizeTransformerRun(failedAttempt(), "run-1", "migrate");
    expect(failed.ok).toBe(false);
    expect(failed.verifier.status).toBe("failed");
    expect(failed.stoppedReason).toBe("recipe_execution_failed");
  });

  it("attributes null cost for a deterministic run and measured usage when present", () => {
    expect(transformerRoutingOutcomeAttribution(completedAttempt()).costUsd).toBeNull();

    // Defensive optional access: consume an additive adaptive usage summary if
    // the concurrent Transformer change exposes one, without a hard dependency.
    const withUsage = {
      ...completedAttempt(),
      adaptive: {
        usage: {
          measured: true,
          costUsd: 0.02,
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
        },
      },
    } as unknown as TransformerAttemptRunResult;
    const attribution = transformerRoutingOutcomeAttribution(withUsage);
    expect(attribution.costUsd).toBeCloseTo(0.02, 10);
    expect(attribution.inputTokens).toBe(100);
    expect(attribution.outputTokens).toBe(20);
    expect(attribution.totalTokens).toBe(120);
  });
});
