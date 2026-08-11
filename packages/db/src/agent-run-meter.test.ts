import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  insertAgentRun,
  recordAgentRunMeter,
  getAgentRunMeter,
  listAgentRunMeters,
  type AppDb,
} from "./index.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];
const TENANT = "tenant-meter";

afterEach(() => {
  for (const db of dbs.splice(0)) db.raw.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDb(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-meter-"));
  dirs.push(dir);
  const db = createDb(join(dir, "meter.sqlite"));
  dbs.push(db);
  return db;
}

function ledgerCost(db: AppDb, runId: string, costUsd: number | null) {
  db.raw
    .prepare(
      `INSERT INTO routing_ledger
        (id, tenant_id, job_id, run_id, task_kind, envelope_id, policy_snapshot_id,
         task_snapshot_id, action, input_tokens, output_tokens, total_tokens, cost_usd,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, 'agent.run', ?, 'policy', 'task', 'execute', 60, 40, 100, ?,
         '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    )
    .run(`${runId}-l`, TENANT, `${runId}-job`, runId, `${runId}-env`, costUsd);
}

describe("recordAgentRunMeter", () => {
  it("records measured cost and tokens for a candidate-ready run", () => {
    const db = freshDb();
    insertAgentRun(db, {
      id: "run-1",
      tenantId: TENANT,
      goal: "fix",
      repoPath: "/repo",
      status: "candidate_ready",
      ok: true,
      steps: 3,
      createdAt: "2026-08-01T00:00:00.000Z",
      finishedAt: "2026-08-01T00:00:12.000Z",
    });
    ledgerCost(db, "run-1", 0.03);

    const meter = recordAgentRunMeter(db, {
      tenantId: TENANT,
      runId: "run-1",
      meteredAt: "2026-08-01T00:00:12.500Z",
    });
    expect(meter.outcome).toBe("candidate_ready");
    expect(meter.costMeasured).toBe(true);
    expect(meter.costUsd).toBeCloseTo(0.03, 10);
    expect(meter.totalTokens).toBe(100);
    expect(meter.candidateReadyAt).toBe("2026-08-01T00:00:12.000Z");
    expect(meter.durationMs).toBe(12000);
    expect(Object.isFrozen(meter)).toBe(true);
  });

  it("leaves cost null (honest) when the run has no priced routing rows", () => {
    const db = freshDb();
    insertAgentRun(db, {
      id: "run-2",
      tenantId: TENANT,
      goal: "fix",
      repoPath: "/repo",
      status: "failed",
      ok: false,
      steps: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      finishedAt: "2026-08-01T00:00:05.000Z",
    });
    ledgerCost(db, "run-2", null);
    const meter = recordAgentRunMeter(db, {
      tenantId: TENANT,
      runId: "run-2",
      meteredAt: "2026-08-01T00:00:05.500Z",
    });
    expect(meter.costMeasured).toBe(false);
    expect(meter.costUsd).toBeNull();
    expect(meter.candidateReadyAt).toBeNull();
    expect(meter.durationMs).toBeNull();
  });

  it("is idempotent per run and refreshes the outcome while preserving candidate-ready time", () => {
    const db = freshDb();
    insertAgentRun(db, {
      id: "run-3",
      tenantId: TENANT,
      goal: "fix",
      repoPath: "/repo",
      status: "candidate_ready",
      ok: true,
      steps: 2,
      createdAt: "2026-08-01T00:00:00.000Z",
      finishedAt: "2026-08-01T00:00:08.000Z",
    });
    recordAgentRunMeter(db, { tenantId: TENANT, runId: "run-3", meteredAt: "2026-08-01T00:00:08.500Z" });

    // Simulate the review action overwriting the run's finished_at, then re-meter.
    db.raw
      .prepare(`UPDATE agent_runs SET status = 'candidate_approved', finished_at = ? WHERE id = ?`)
      .run("2026-08-01T02:00:00.000Z", "run-3");
    const meter = recordAgentRunMeter(db, {
      tenantId: TENANT,
      runId: "run-3",
      meteredAt: "2026-08-01T02:00:01.000Z",
    });
    expect(meter.outcome).toBe("candidate_approved");
    // First-observed candidate-ready timestamp/duration are preserved.
    expect(meter.candidateReadyAt).toBe("2026-08-01T00:00:08.000Z");
    expect(meter.durationMs).toBe(8000);
    expect(listAgentRunMeters(db, TENANT).length).toBe(1);
  });

  it("scopes lookups to the tenant and rejects unknown runs", () => {
    const db = freshDb();
    expect(() =>
      recordAgentRunMeter(db, { tenantId: TENANT, runId: "missing", meteredAt: "2026-08-01T00:00:00.000Z" }),
    ).toThrow("agent_run_meter_run_not_found");
    expect(getAgentRunMeter(db, TENANT, "missing")).toBeUndefined();
  });
});
