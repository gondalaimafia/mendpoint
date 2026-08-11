/**
 * Wave 3b — per-agent-run metering entry.
 *
 * Each agent run records one tenant-scoped metering row capturing its outcome,
 * token usage, and MEASURED cost. Cost is sourced from the durable
 * routing_ledger (routing_ledger.run_id = agent_runs.id) and is left null when
 * unmeasured — never fabricated. This row is the outcome-linked metering feed
 * for the customer metrics and any future billing.
 *
 * Note on the entitlement ledger: the MCU reservation/settlement ledger in
 * usage.ts is entitlement-gated (it fails closed when a tenant has no
 * provisioned entitlement). This per-run meter is intentionally decoupled from
 * that gate so metering never blocks or crashes an agent run; the honest-cost
 * rule (null when unmeasured) is preserved here.
 *
 * The recorder runs inside the caller's transaction (the worker persists the
 * run and its routing outcome atomically), so it opens no transaction of its
 * own.
 */
import type { AppDb } from "./index.js";

export type AgentRunMeter = Readonly<{
  tenantId: string;
  runId: string;
  outcome: string;
  createdAt: string;
  candidateReadyAt: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  costMeasured: boolean;
  meteredAt: string;
}>;

type MeterRow = {
  tenant_id: string;
  run_id: string;
  outcome: string;
  created_at: string;
  candidate_ready_at: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  cost_measured: number;
  metered_at: string;
};

function meterFromRow(row: MeterRow): AgentRunMeter {
  return Object.freeze({
    tenantId: row.tenant_id,
    runId: row.run_id,
    outcome: row.outcome,
    createdAt: row.created_at,
    candidateReadyAt: row.candidate_ready_at,
    durationMs: row.duration_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    costMeasured: row.cost_measured === 1,
    meteredAt: row.metered_at,
  });
}

/**
 * Record (or refresh) the metering entry for one agent run. Idempotent per
 * (tenant, run): re-metering updates the outcome and usage while preserving the
 * first-observed candidate-ready timestamp/duration, which the review action
 * would otherwise overwrite on the run row.
 */
export function recordAgentRunMeter(
  db: AppDb,
  input: { tenantId: string; runId: string; meteredAt: string },
): AgentRunMeter {
  const tenantId = input.tenantId.trim();
  const runId = input.runId.trim();
  if (!tenantId) throw new Error("agent_run_meter_tenant_invalid");
  if (!runId) throw new Error("agent_run_meter_run_invalid");
  if (!Number.isFinite(Date.parse(input.meteredAt))) {
    throw new Error("agent_run_meter_metered_at_invalid");
  }

  const run = db.raw
    .prepare(
      `SELECT id, status, created_at, finished_at
       FROM agent_runs WHERE id = ? AND tenant_id = ?`,
    )
    .get(runId, tenantId) as
    | { id: string; status: string; created_at: string; finished_at: string | null }
    | undefined;
  if (!run) throw new Error("agent_run_meter_run_not_found");

  const usage = db.raw
    .prepare(
      `SELECT
         SUM(input_tokens) AS input_tokens,
         SUM(output_tokens) AS output_tokens,
         SUM(total_tokens) AS total_tokens,
         SUM(cost_usd) AS cost_usd,
         SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS measured_rows
       FROM routing_ledger
       WHERE tenant_id = ? AND run_id = ?`,
    )
    .get(tenantId, runId) as {
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
    cost_usd: number | null;
    measured_rows: number | null;
  };

  const costMeasured = (usage.measured_rows ?? 0) > 0;
  const costUsd = costMeasured ? usage.cost_usd : null;
  const candidateReadyAt = run.status === "candidate_ready" ? run.finished_at : null;
  const durationMs =
    candidateReadyAt !== null
      ? (() => {
          const ms = Date.parse(candidateReadyAt) - Date.parse(run.created_at);
          return Number.isFinite(ms) && ms >= 0 ? ms : null;
        })()
      : null;

  db.raw
    .prepare(
      `INSERT INTO agent_run_meters
        (tenant_id, run_id, outcome, created_at, candidate_ready_at, duration_ms,
         input_tokens, output_tokens, total_tokens, cost_usd, cost_measured, metered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, run_id) DO UPDATE SET
         outcome = excluded.outcome,
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         total_tokens = excluded.total_tokens,
         cost_usd = excluded.cost_usd,
         cost_measured = excluded.cost_measured,
         metered_at = excluded.metered_at,
         candidate_ready_at = COALESCE(agent_run_meters.candidate_ready_at, excluded.candidate_ready_at),
         duration_ms = COALESCE(agent_run_meters.duration_ms, excluded.duration_ms)`,
    )
    .run(
      tenantId,
      runId,
      run.status,
      run.created_at,
      candidateReadyAt,
      durationMs,
      usage.input_tokens,
      usage.output_tokens,
      usage.total_tokens,
      costUsd,
      costMeasured ? 1 : 0,
      input.meteredAt,
    );

  return meterFromRow(
    db.raw
      .prepare(`SELECT * FROM agent_run_meters WHERE tenant_id = ? AND run_id = ?`)
      .get(tenantId, runId) as MeterRow,
  );
}

export function getAgentRunMeter(
  db: AppDb,
  tenantId: string,
  runId: string,
): AgentRunMeter | undefined {
  const row = db.raw
    .prepare(`SELECT * FROM agent_run_meters WHERE tenant_id = ? AND run_id = ?`)
    .get(tenantId, runId) as MeterRow | undefined;
  return row ? meterFromRow(row) : undefined;
}

export function listAgentRunMeters(
  db: AppDb,
  tenantId: string,
  limit = 100,
): AgentRunMeter[] {
  const bounded = Math.max(1, Math.min(Math.floor(limit), 1_000));
  return (
    db.raw
      .prepare(
        `SELECT * FROM agent_run_meters
         WHERE tenant_id = ? ORDER BY created_at DESC, run_id DESC LIMIT ?`,
      )
      .all(tenantId, bounded) as MeterRow[]
  ).map(meterFromRow);
}
