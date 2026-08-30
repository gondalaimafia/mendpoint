import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  getLatestActualExecutionCostForTaskBeforeAttempt,
  insertPrincipal,
  listActualExecutionCosts,
  recordActualExecutionCost,
  recordExecutionCostFromRoutingLedger,
  recordRoutingDecision,
  recordRoutingOutcome,
  verifyExecutionCostIntegrity,
  type AppDb,
} from "./index.js";

const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];
const at = "2026-08-01T12:00:00.000Z";

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close?.();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-exec-cost-"));
  dirs.push(dir);
  return join(dir, "cost.sqlite");
}

function setupDb(path = tempPath()): AppDb {
  const db = createDb(path);
  dbs.push(db);
  insertPrincipal(db, {
    id: "principal-cost",
    tenantId: "tenant_default",
    kind: "service",
    subject: "cost-recorder",
    displayName: "Cost recorder",
    createdAt: at,
  });
  return db;
}

/** Seed one measured routing_ledger row (decision + settled outcome) for a run. */
function seedRoutingLedger(
  db: AppDb,
  runId: string,
  cost: { costUsd: number | null; inputTokens: number; outputTokens: number },
) {
  const envelopeId = `envelope-${runId}`;
  const routingLedgerId = recordRoutingDecision(db, {
    tenantId: "tenant_default",
    jobId: `job-${runId}`,
    runId,
    taskKind: "regauge.adaptive_candidate",
    envelopeId,
    policySnapshotId: `policy-${runId}`,
    taskSnapshotId: `task-${runId}`,
    action: "route",
    selectedExecutorId: "executor-frontier",
    providerId: "provider-frontier",
    eliminated: [],
    fallback: [],
    breaker: [],
    handoffRequired: false,
    decision: {},
    createdAt: at,
  });
  recordRoutingOutcome(db, {
    tenantId: "tenant_default",
    jobId: `job-${runId}`,
    envelopeId,
    action: "route",
    outcome: "succeeded",
    executorId: "executor-frontier",
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    totalTokens: cost.inputTokens + cost.outputTokens,
    costUsd: cost.costUsd,
    completedAt: at,
    observedAt: at,
  });
  return { jobId: `job-${runId}`, envelopeId, routingLedgerId };
}

describe("execution cost attribution", () => {
  it("accounts only the exact terminal executed routing envelopes", () => {
    const db = setupDb();
    const first = seedRoutingLedger(db, "shared-session", {
      costUsd: 0.1,
      inputTokens: 100,
      outputTokens: 20,
    });
    const secondEnvelopeId = "envelope-shared-session-retry";
    const secondRoutingLedgerId = recordRoutingDecision(db, {
      tenantId: "tenant_default",
      jobId: first.jobId,
      runId: "shared-session",
      taskKind: "agent.run",
      envelopeId: secondEnvelopeId,
      policySnapshotId: "policy-retry",
      taskSnapshotId: "task-retry",
      action: "route",
      selectedExecutorId: "executor-frontier",
      providerId: "provider-frontier",
      eliminated: [], fallback: [], breaker: [], handoffRequired: false,
      decision: {}, createdAt: at,
    });
    recordRoutingOutcome(db, {
      tenantId: "tenant_default",
      jobId: first.jobId,
      envelopeId: secondEnvelopeId,
      action: "completed",
      outcome: "succeeded",
      executorId: "executor-frontier",
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      costUsd: 0.2,
      completedAt: at,
      observedAt: at,
    });

    const entry = recordExecutionCostFromRoutingLedger(db, {
      tenantId: "tenant_default",
      routingEvidence: {
        jobId: first.jobId,
        runId: "shared-session",
        envelopeIds: [secondEnvelopeId],
      },
      executionId: "execution-retry-only",
      taskId: "task-retry",
      taskClass: "agent.run",
      route: "fettler",
      actorPrincipalId: "principal-cost",
      createdAt: at,
    });

    expect(entry.modelCostMoneyMicros).toBe(200_000);
    expect(entry.inputTokens).toBe(50);
    expect(entry.measurementProvenance.model).toContain(secondRoutingLedgerId);
    expect(entry.measurementProvenance.model).not.toContain(first.routingLedgerId);
    expect(verifyExecutionCostIntegrity(db, "tenant_default").ok).toBe(true);
    db.raw.prepare("UPDATE routing_ledger SET cost_usd = ? WHERE id = ?")
      .run(0.3, secondRoutingLedgerId);
    expect(verifyExecutionCostIntegrity(db, "tenant_default")).toMatchObject({
      ok: false,
      error: `execution_cost_routing_provenance_digest:${entry.id}`,
    });
  });

  it("rejects routing evidence that is not terminal and executed", () => {
    const db = setupDb();
    recordRoutingDecision(db, {
      tenantId: "tenant_default", jobId: "job-pending", runId: "run-pending",
      taskKind: "agent.run", envelopeId: "envelope-pending", policySnapshotId: "policy",
      taskSnapshotId: "task", action: "route", selectedExecutorId: "executor-frontier",
      providerId: "provider-frontier", eliminated: [], fallback: [], breaker: [],
      handoffRequired: false, decision: {}, createdAt: at,
    });
    recordRoutingOutcome(db, {
      tenantId: "tenant_default",
      jobId: "job-pending",
      envelopeId: "envelope-pending",
      action: "route",
      outcome: "pending",
      executorId: "executor-frontier",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      costUsd: 0.01,
      completedAt: at,
      observedAt: at,
    });
    expect(() => recordExecutionCostFromRoutingLedger(db, {
      tenantId: "tenant_default",
      routingEvidence: {
        jobId: "job-pending",
        runId: "run-pending",
        envelopeIds: ["envelope-pending"],
      },
      executionId: "execution-pending",
      taskId: "task-pending",
      taskClass: "agent.run",
      route: "fettler",
      actorPrincipalId: "principal-cost",
      createdAt: at,
    })).toThrow("execution_cost_routing_evidence_not_terminal");
  });

  it("uses the exact indexed task-attempt lookup for retry lineage", () => {
    const db = setupDb();
    const plan = db.raw.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM actual_execution_cost_entries
       WHERE tenant_id = ? AND task_id = ? AND attempt_number < ?
       ORDER BY attempt_number DESC, entry_sequence DESC LIMIT 1`,
    ).all("tenant_default", "task-retry", 501) as Array<{ detail: string }>;
    expect(plan.some((row) =>
      row.detail.includes("actual_execution_cost_task_attempt_idx")
    )).toBe(true);
    expect(getLatestActualExecutionCostForTaskBeforeAttempt(db, {
      tenantId: "tenant_default",
      taskId: "task-retry",
      attemptNumber: 501,
    })).toBeUndefined();
  });
  it("derives the model component from routing_ledger and marks the other five unmeasured", () => {
    const db = setupDb();
    seedRoutingLedger(db, "run-measured", {
      costUsd: 0.25,
      inputTokens: 1_000,
      outputTokens: 400,
    });

    const entry = recordExecutionCostFromRoutingLedger(db, {
      tenantId: "tenant_default",
      routingEvidence: {
        jobId: "job-run-measured",
        runId: "run-measured",
        envelopeIds: ["envelope-run-measured"],
      },
      executionId: "execution-measured",
      taskId: "unit-1",
      taskClass: "regauge.adaptive_candidate",
      route: "regauge",
      actorPrincipalId: "principal-cost",
      createdAt: at,
    });

    // Model: measured, derived from the ledger's charged cost (0.25 USD -> micros).
    expect(entry.modelCostMeasured).toBe(true);
    expect(entry.modelCostMoneyMicros).toBe(250_000);
    expect(entry.inputTokens).toBe(1_000);
    expect(entry.outputTokens).toBe(400);
    // The other five have no meter on this path: unmeasured, zero micros.
    expect(entry.cacheCostMeasured).toBe(false);
    expect(entry.gpuCostMeasured).toBe(false);
    expect(entry.graphCostMeasured).toBe(false);
    expect(entry.sandboxCostMeasured).toBe(false);
    expect(entry.verificationCostMeasured).toBe(false);
    expect(entry.gpuCostMoneyMicros).toBe(0);
    // Total equals the sum of measured components only.
    expect(entry.totalCostMoneyMicros).toBe(250_000);
    expect(verifyExecutionCostIntegrity(db, "tenant_default").ok).toBe(true);
  });

  it("keeps an unmeasured component distinguishable from a genuinely zero one", () => {
    const db = setupDb();

    // A: a genuinely measured-zero GPU component (measured flag true, 0 micros).
    const measuredZero = recordActualExecutionCost(db, {
      id: "cost-measured-zero",
      tenantId: "tenant_default",
      idempotencyKey: "cost-measured-zero",
      executionId: "execution-measured-zero",
      taskId: "task-a",
      taskClass: "api-migration",
      route: "regauge",
      attemptNumber: 1,
      retryNumber: 0,
      outcomeStatus: "unresolved",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      modelId: "model-a",
      modelPriceVersion: "v1",
      modelCostMoneyMicros: 100,
      cacheCostMoneyMicros: 0,
      gpuMillis: 0,
      gpuCostMoneyMicros: 0,
      graphCostMoneyMicros: 0,
      sandboxCostMoneyMicros: 0,
      verificationCostMoneyMicros: 0,
      currency: "USD",
      actorPrincipalId: "principal-cost",
      createdAt: at,
      gpuCostMeasured: true,
    });

    // B: an unmeasured GPU component (no ledger cost at all -> model also unmeasured).
    seedRoutingLedger(db, "run-nocost", { costUsd: null, inputTokens: 0, outputTokens: 0 });
    const unmeasured = recordExecutionCostFromRoutingLedger(db, {
      tenantId: "tenant_default",
      routingEvidence: {
        jobId: "job-run-nocost",
        runId: "run-nocost",
        envelopeIds: ["envelope-run-nocost"],
      },
      executionId: "execution-unmeasured",
      taskId: "task-b",
      taskClass: "regauge.adaptive_candidate",
      route: "regauge",
      actorPrincipalId: "principal-cost",
      createdAt: at,
    });

    // Both carry gpuCostMoneyMicros === 0, but the flag tells them apart.
    expect(measuredZero.gpuCostMoneyMicros).toBe(0);
    expect(unmeasured.gpuCostMoneyMicros).toBe(0);
    expect(measuredZero.gpuCostMeasured).toBe(true);
    expect(unmeasured.gpuCostMeasured).toBe(false);
    // With no ledger cost, the model component is unmeasured too — an honest
    // "did not measure", not a fabricated zero.
    expect(unmeasured.modelCostMeasured).toBe(false);
    expect(unmeasured.modelCostMoneyMicros).toBe(0);
  });

  it("rejects an unmeasured component that carries a nonzero cost", () => {
    const db = setupDb();
    expect(() =>
      recordActualExecutionCost(db, {
        id: "cost-contradiction",
        tenantId: "tenant_default",
        idempotencyKey: "cost-contradiction",
        executionId: "execution-contradiction",
        taskId: "task-c",
        taskClass: "api-migration",
        route: "regauge",
        attemptNumber: 1,
        retryNumber: 0,
        outcomeStatus: "unresolved",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        modelId: "model-a",
        modelPriceVersion: "v1",
        modelCostMoneyMicros: 0,
        cacheCostMoneyMicros: 0,
        gpuMillis: 0,
        gpuCostMoneyMicros: 42,
        graphCostMoneyMicros: 0,
        sandboxCostMoneyMicros: 0,
        verificationCostMoneyMicros: 0,
        currency: "USD",
        actorPrincipalId: "principal-cost",
        createdAt: at,
        gpuCostMeasured: false,
      }),
    ).toThrow(/gpu_unmeasured_nonzero/);
  });

  it("attributes ReGauge execution cost to its mission and rejects an unknown mission", () => {
    const db = setupDb();
    const mission = createMission(db, {
      id: "mission-regauge-x",
      tenantId: "tenant_default",
      product: "regauge",
      triggerKind: "migration_objective",
      objective: "Migrate consumer to v2",
      ownerPrincipalId: "principal-cost",
      eventId: "event-mission-x",
      idempotencyKey: "mission-x",
      correlationId: "corr-x",
      createdAt: at,
    });

    seedRoutingLedger(db, "run-mission", {
      costUsd: 0.1,
      inputTokens: 100,
      outputTokens: 50,
    });
    const entry = recordExecutionCostFromRoutingLedger(db, {
      tenantId: "tenant_default",
      routingEvidence: {
        jobId: "job-run-mission",
        runId: "run-mission",
        envelopeIds: ["envelope-run-mission"],
      },
      executionId: "execution-mission",
      taskId: "unit-mission",
      taskClass: "regauge.adaptive_candidate",
      route: "regauge",
      campaignId: "campaign-x",
      missionId: mission.id,
      actorPrincipalId: "principal-cost",
      createdAt: at,
    });
    expect(entry.missionId).toBe("mission-regauge-x");

    // A mission id with no row fails closed (FK), never silently drops attribution.
    expect(() =>
      recordExecutionCostFromRoutingLedger(db, {
        tenantId: "tenant_default",
        routingEvidence: {
          jobId: "job-run-mission",
          runId: "run-mission",
          envelopeIds: ["envelope-run-mission"],
        },
        executionId: "execution-mission-bad",
        taskId: "unit-mission",
        taskClass: "regauge.adaptive_candidate",
        route: "regauge",
        missionId: "mission-does-not-exist",
        actorPrincipalId: "principal-cost",
        createdAt: at,
      }),
    ).toThrow();
  });

  it("converges a pre-change volume and keeps the hash chain verifying across the schema change", () => {
    const path = tempPath();

    // 1) Build a PRE-CHANGE volume: the cost table without mission_id, the six
    //    measurement flags, or cost_schema_version, holding one row hashed the
    //    original (version-1) way.
    const seed = createDb(path);
    insertPrincipal(seed, {
      id: "principal-legacy",
      tenantId: "tenant_default",
      kind: "service",
      subject: "legacy-recorder",
      displayName: "Legacy recorder",
      createdAt: at,
    });
    seed.raw.exec("DROP TABLE actual_execution_cost_entries");
    seed.raw.exec(`CREATE TABLE actual_execution_cost_entries (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      idempotency_key TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      campaign_id TEXT,
      task_class TEXT NOT NULL,
      route TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      retry_number INTEGER NOT NULL CHECK (retry_number >= 0),
      fallback_from_execution_id TEXT,
      outcome_status TEXT NOT NULL CHECK (outcome_status IN ('accepted', 'rejected', 'unresolved')),
      accepted_outcome_id TEXT,
      input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
      output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
      cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
      cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
      model_id TEXT NOT NULL,
      model_price_version TEXT NOT NULL,
      model_cost_money_micros INTEGER NOT NULL CHECK (model_cost_money_micros >= 0),
      cache_cost_money_micros INTEGER NOT NULL CHECK (cache_cost_money_micros >= 0),
      gpu_millis INTEGER NOT NULL CHECK (gpu_millis >= 0),
      gpu_cost_money_micros INTEGER NOT NULL CHECK (gpu_cost_money_micros >= 0),
      graph_cost_money_micros INTEGER NOT NULL CHECK (graph_cost_money_micros >= 0),
      sandbox_cost_money_micros INTEGER NOT NULL CHECK (sandbox_cost_money_micros >= 0),
      verification_cost_money_micros INTEGER NOT NULL CHECK (verification_cost_money_micros >= 0),
      total_cost_money_micros INTEGER NOT NULL,
      currency TEXT NOT NULL CHECK (length(currency) = 3),
      actor_principal_id TEXT NOT NULL REFERENCES principals(id),
      entry_sequence INTEGER NOT NULL CHECK (entry_sequence > 0),
      prev_hash TEXT,
      entry_hash TEXT NOT NULL CHECK (length(entry_hash) = 64),
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, idempotency_key),
      UNIQUE (tenant_id, execution_id),
      UNIQUE (tenant_id, entry_sequence)
    )`);

    // The legacy row and its version-1 hash (original field order, no new fields).
    const legacy = {
      id: "cost-legacy",
      tenantId: "tenant_default",
      idempotencyKey: "cost-legacy",
      executionId: "execution-legacy",
      taskId: "task-legacy",
      campaignId: null as string | null,
      taskClass: "api-migration",
      route: "regauge",
      attemptNumber: 1,
      retryNumber: 0,
      fallbackFromExecutionId: null as string | null,
      outcomeStatus: "unresolved" as const,
      acceptedOutcomeId: null as string | null,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      modelId: "model-legacy",
      modelPriceVersion: "v1",
      modelCostMoneyMicros: 700,
      cacheCostMoneyMicros: 0,
      gpuMillis: 0,
      gpuCostMoneyMicros: 0,
      graphCostMoneyMicros: 0,
      sandboxCostMoneyMicros: 0,
      verificationCostMoneyMicros: 0,
      totalCostMoneyMicros: 700,
      currency: "USD",
      actorPrincipalId: "principal-legacy",
      entrySequence: 1,
      previousHash: null as string | null,
      createdAt: at,
    };
    const legacyHash = createHash("sha256")
      .update(JSON.stringify(legacy))
      .digest("hex");
    seed.raw
      .prepare(
        `INSERT INTO actual_execution_cost_entries
         (id, tenant_id, idempotency_key, execution_id, task_id, campaign_id,
          task_class, route, attempt_number, retry_number, fallback_from_execution_id,
          outcome_status, accepted_outcome_id, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, model_id, model_price_version,
          model_cost_money_micros, cache_cost_money_micros, gpu_millis,
          gpu_cost_money_micros, graph_cost_money_micros, sandbox_cost_money_micros,
          verification_cost_money_micros, total_cost_money_micros, currency,
          actor_principal_id, entry_sequence, prev_hash, entry_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        legacy.id, legacy.tenantId, legacy.idempotencyKey, legacy.executionId,
        legacy.taskId, legacy.campaignId, legacy.taskClass, legacy.route,
        legacy.attemptNumber, legacy.retryNumber, legacy.fallbackFromExecutionId,
        legacy.outcomeStatus, legacy.acceptedOutcomeId, legacy.inputTokens,
        legacy.outputTokens, legacy.cacheReadTokens, legacy.cacheWriteTokens,
        legacy.modelId, legacy.modelPriceVersion, legacy.modelCostMoneyMicros,
        legacy.cacheCostMoneyMicros, legacy.gpuMillis, legacy.gpuCostMoneyMicros,
        legacy.graphCostMoneyMicros, legacy.sandboxCostMoneyMicros,
        legacy.verificationCostMoneyMicros, legacy.totalCostMoneyMicros,
        legacy.currency, legacy.actorPrincipalId, legacy.entrySequence,
        legacy.previousHash, legacyHash, legacy.createdAt,
      );
    seed.raw.close?.();

    // 2) Boot on that volume: the additive migration adds the new columns.
    const db = createDb(path);
    dbs.push(db);
    const columns = (
      db.raw.prepare("PRAGMA table_info(actual_execution_cost_entries)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    for (const added of [
      "mission_id",
      "model_cost_measured",
      "gpu_cost_measured",
      "verification_cost_measured",
      "cost_schema_version",
    ]) {
      expect(columns).toContain(added);
    }

    // 3) The legacy (version-1) row still verifies after the schema change.
    expect(verifyExecutionCostIntegrity(db, "tenant_default").ok).toBe(true);

    // 4) Materialize an authentic historical v2 payload (mission + measurement
    // flags, but no provenance in its hash), then append today's v3 writer.
    const writtenV2 = recordActualExecutionCost(db, {
      id: "cost-v2",
      tenantId: "tenant_default",
      idempotencyKey: "cost-v2",
      executionId: "execution-v2",
      taskId: "task-v2",
      taskClass: "api-migration",
      route: "regauge",
      attemptNumber: 1,
      retryNumber: 0,
      outcomeStatus: "unresolved",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      modelId: "model-v2",
      modelPriceVersion: "v1",
      modelCostMoneyMicros: 5,
      cacheCostMoneyMicros: 0,
      gpuMillis: 0,
      gpuCostMoneyMicros: 0,
      graphCostMoneyMicros: 0,
      sandboxCostMoneyMicros: 0,
      verificationCostMoneyMicros: 0,
      currency: "USD",
      actorPrincipalId: "principal-legacy",
      createdAt: at,
      gpuCostMeasured: false,
    });
    const { entryHash: _v3Hash, measurementProvenance: _v3Provenance,
      ...historicalV2Base } = writtenV2;
    const historicalV2 = { ...historicalV2Base, costSchemaVersion: 2 };
    const historicalV2Hash = createHash("sha256")
      .update(JSON.stringify(historicalV2)).digest("hex");
    db.raw.exec("DROP TRIGGER actual_execution_cost_entries_append_only_update");
    db.raw.prepare(`UPDATE actual_execution_cost_entries
      SET cost_schema_version = 2, measurement_provenance_json = '{}', entry_hash = ?
      WHERE id = ?`).run(historicalV2Hash, writtenV2.id);
    recordActualExecutionCost(db, {
      id: "cost-v3", tenantId: "tenant_default", idempotencyKey: "cost-v3",
      executionId: "execution-v3", taskId: "task-v3", taskClass: "api-migration",
      route: "regauge", attemptNumber: 1, retryNumber: 0, outcomeStatus: "unresolved",
      inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      modelId: "model-v3", modelPriceVersion: "v3", modelCostMoneyMicros: 7,
      cacheCostMoneyMicros: 0, gpuMillis: 0, gpuCostMoneyMicros: 0,
      graphCostMoneyMicros: 0, sandboxCostMoneyMicros: 0,
      verificationCostMoneyMicros: 0, currency: "USD",
      actorPrincipalId: "principal-legacy", createdAt: at,
      measurementProvenance: { model: "  invoice:model-v3  " },
    });
    const integrity = verifyExecutionCostIntegrity(db, "tenant_default");
    expect(integrity.ok).toBe(true);
    expect(integrity.checked).toBe(3);
    expect(listActualExecutionCosts(db, "tenant_default")[0]?.measurementProvenance)
      .toEqual({ model: "invoice:model-v3" });
  });
});
