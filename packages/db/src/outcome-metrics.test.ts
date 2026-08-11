import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, insertAgentRun, computeOutcomeMetrics, type AppDb } from "./index.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];
const TENANT = "tenant-metrics";

afterEach(() => {
  for (const db of dbs.splice(0)) db.raw.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDb(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-outcome-"));
  dirs.push(dir);
  const db = createDb(join(dir, "outcome.sqlite"));
  dbs.push(db);
  return db;
}

function run(
  db: AppDb,
  id: string,
  status: string,
  createdAt: string,
  finishedAt: string | null,
  tenantId = TENANT,
) {
  insertAgentRun(db, {
    id,
    tenantId,
    goal: "fix",
    repoPath: "/repo",
    status,
    ok: status === "candidate_approved" || status === "candidate_ready",
    steps: 1,
    createdAt,
    finishedAt,
  });
}

function ledgerCost(
  db: AppDb,
  runId: string,
  costUsd: number | null,
  tenantId = TENANT,
) {
  db.raw
    .prepare(
      `INSERT INTO routing_ledger
        (id, tenant_id, job_id, run_id, task_kind, envelope_id, policy_snapshot_id,
         task_snapshot_id, action, total_tokens, cost_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'agent.run', ?, 'policy', 'task', 'execute', 100, ?, ?, ?)`,
    )
    .run(
      `${runId}-ledger`,
      tenantId,
      `${runId}-job`,
      runId,
      `${runId}-env`,
      costUsd,
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    );
}

describe("computeOutcomeMetrics", () => {
  it("computes accepted, human-intervention, cost, and time-to-candidate from recorded data", () => {
    const db = freshDb();
    // Accepted with measured cost.
    run(db, "A", "candidate_approved", "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z");
    ledgerCost(db, "A", 0.05);
    // Accepted, no measured cost.
    run(db, "B", "candidate_approved", "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z");
    // Rejected candidate.
    run(db, "C", "candidate_rejected", "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z");
    // Candidate ready (awaiting review) — time-to-candidate samples.
    run(db, "D", "candidate_ready", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:10.000Z");
    run(db, "E", "candidate_ready", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:30.000Z");
    // Non-candidate-producing.
    run(db, "F", "failed", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:05.000Z");
    run(db, "G", "needs_human", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:05.000Z");
    run(db, "H", "no_action", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:05.000Z");

    const m = computeOutcomeMetrics(db, { tenantId: TENANT });

    expect(m.totalRuns).toBe(8);
    expect(m.candidateProducingRuns).toBe(5);
    expect(m.acceptedCandidates).toBe(2);

    expect(m.acceptedCandidateRate.value).toBeCloseTo(0.4, 10);
    expect(m.acceptedCandidateRate.basis).toBe("measured");

    // Escaped regression is honestly unavailable; proxy is the review-rejection rate.
    expect(m.escapedRegressionRate.value).toBeNull();
    expect(m.escapedRegressionRate.basis).toBe("unavailable");
    expect(m.escapedRegressionRate.nearestProxy.basis).toBe("proxy");
    expect(m.escapedRegressionRate.nearestProxy.value).toBeCloseTo(0.2, 10);

    expect(m.humanInterventionRate.value).toBeCloseTo(6 / 8, 10);

    // Cost per accepted PR averages only the accepted runs with measured cost.
    expect(m.costPerAcceptedPr.value).toBeCloseTo(0.05, 10);
    expect(m.costPerAcceptedPr.acceptedCount).toBe(2);
    expect(m.costPerAcceptedPr.measuredAcceptedCount).toBe(1);
    expect(m.costPerAcceptedPr.note).toBeDefined();

    // Time-to-candidate over candidate_ready runs only; reviewed runs excluded.
    expect(m.timeToCandidate.sampleSize).toBe(2);
    expect(m.timeToCandidate.excludedReviewedRuns).toBe(3);
    expect(m.timeToCandidate.p50Ms).toBe(20000);
    expect(m.timeToCandidate.p95Ms).toBe(29000);

    expect(m.externalBaseline.headToHeadMeasured).toBe(false);
    expect(m.externalBaseline.references.length).toBeGreaterThan(0);
    expect(Object.isFrozen(m)).toBe(true);
  });

  it("returns honest nulls with reasons when there is no data", () => {
    const db = freshDb();
    const m = computeOutcomeMetrics(db, { tenantId: TENANT });
    expect(m.totalRuns).toBe(0);
    expect(m.acceptedCandidateRate.value).toBeNull();
    expect(m.acceptedCandidateRate.reason).toContain("no candidate-producing runs");
    expect(m.humanInterventionRate.value).toBeNull();
    expect(m.costPerAcceptedPr.value).toBeNull();
    expect(m.costPerAcceptedPr.reason).toContain("no accepted candidates");
    expect(m.timeToCandidate.p50Ms).toBeNull();
    expect(m.timeToCandidate.reason).toContain("no runs awaiting review");
  });

  it("returns null cost when accepted candidates have no measured cost", () => {
    const db = freshDb();
    run(db, "A", "candidate_approved", "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z");
    // A routing row exists but cost is unpriced (null) — must not fabricate cost.
    ledgerCost(db, "A", null);
    const m = computeOutcomeMetrics(db, { tenantId: TENANT });
    expect(m.acceptedCandidates).toBe(1);
    expect(m.costPerAcceptedPr.value).toBeNull();
    expect(m.costPerAcceptedPr.reason).toContain("cost was not measured");
  });

  it("scopes to the tenant and honors the time window", () => {
    const db = freshDb();
    run(db, "A", "candidate_approved", "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z");
    run(db, "B", "candidate_rejected", "2026-08-10T00:00:00.000Z", "2026-08-10T01:00:00.000Z");
    run(db, "X", "candidate_approved", "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z", "other-tenant");

    const scoped = computeOutcomeMetrics(db, { tenantId: TENANT });
    expect(scoped.totalRuns).toBe(2);

    const windowed = computeOutcomeMetrics(db, {
      tenantId: TENANT,
      since: "2026-08-05T00:00:00.000Z",
    });
    expect(windowed.totalRuns).toBe(1);
    expect(windowed.candidateProducingRuns).toBe(1);
    expect(windowed.acceptedCandidates).toBe(0);
  });

  it("rejects an invalid window", () => {
    const db = freshDb();
    expect(() =>
      computeOutcomeMetrics(db, {
        tenantId: TENANT,
        since: "2026-08-10T00:00:00.000Z",
        until: "2026-08-01T00:00:00.000Z",
      }),
    ).toThrow("outcome_window_invalid");
    expect(() => computeOutcomeMetrics(db, { tenantId: TENANT, since: "not-a-date" })).toThrow(
      "outcome_since_invalid",
    );
  });
});
