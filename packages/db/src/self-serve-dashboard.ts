/**
 * S3 — self-serve adoption / outcome / reliability / cost / satisfaction
 * dashboard.
 *
 * A tenant-scoped, read-only aggregation over data we already record, so a
 * customer can measure their own usage without asking us for numbers. It reuses
 * the same durable sources the rest of the product writes to: `consumers` +
 * `monitored_apis` (adoption), `migration_prs` + `agent_runs` + `audit_events`
 * (outcomes), `agent_runs` + `jobs` (reliability), `agent_run_meters` + the MCU
 * usage ledger (cost), and `developer_satisfaction_signals` (satisfaction).
 *
 * Honesty contract (mirrors modernization-report.ts and outcome-metrics.ts):
 *  - Every reported figure traces to a real row/field; see {@link DASHBOARD_PROVENANCE}.
 *  - Counts of connected/monitored state are real (0 is a true "none connected").
 *  - Dimensions with NO faithful source (measured cost when unmeasured, MCU with
 *    no entitlement, verification pass rate, introduced-vs-pre-existing failures,
 *    satisfaction with no responses) are reported `basis: "unavailable"` with a
 *    reason, NEVER as a fabricated or zero-as-real value.
 *  - Connection/monitoring counts are point-in-time state (lifetime); event-based
 *    figures (runs, PRs, outcomes, cost, retries, satisfaction) honor the window.
 */
import type { AppDb } from "./index.js";
import { getUsageSummary } from "./usage.js";
import { summarizeDeveloperSatisfaction, type SatisfactionSummary } from "./developer-satisfaction.js";

export type DashboardWindow = Readonly<{ since: string | null; until: string | null }>;

export type DashboardRateMetric = Readonly<{
  value: number | null;
  numerator: number;
  denominator: number;
  basis: "measured";
  reason?: string;
}>;

export type DashboardUnavailableMetric = Readonly<{
  value: null;
  basis: "unavailable";
  reason: string;
}>;

export type DashboardAdoption = Readonly<{
  reposConnected: number;
  providersMonitored: number;
  monitoredApis: number;
  totalRuns: number;
  activeUsers: number;
  runsByDay: readonly Readonly<{ date: string; runs: number }>[];
  teams: DashboardUnavailableMetric;
}>;

export type DashboardOutcomes = Readonly<{
  prsOpened: number;
  prsMerged: number;
  prsClosed: number;
  prsOpen: number;
  mergeRate: DashboardRateMetric;
  candidatesApproved: number;
  candidatesRejected: number;
  candidateApprovalRate: DashboardRateMetric;
  abstainedRuns: number;
  outOfScopeRuns: number;
}>;

export type DashboardReliability = Readonly<{
  runsSucceeded: number;
  runsFailed: number;
  runSuccessRate: DashboardRateMetric;
  retries: number;
  verificationPassRate: DashboardUnavailableMetric;
  introducedVsPreexistingFailures: DashboardUnavailableMetric;
}>;

export type DashboardCostMeasured = Readonly<{
  totalUsd: number | null;
  perRunUsd: number | null;
  measuredRuns: number;
  totalRuns: number;
  basis: "measured";
  reason?: string;
  note?: string;
}>;

export type DashboardCostMcu =
  | Readonly<{
      basis: "measured";
      consumedMcuMicros: number;
      reservedMcuMicros: number;
      availableMcuMicros: number | null;
      billableMoneyMicros: number | null;
      currency: string | null;
      note: string;
    }>
  | Readonly<{ basis: "unavailable"; reason: string }>;

export type DashboardCost = Readonly<{
  measuredUsd: DashboardCostMeasured;
  mcu: DashboardCostMcu;
}>;

export type SelfServeDashboard = Readonly<{
  tenantId: string;
  window: DashboardWindow;
  adoption: DashboardAdoption;
  outcomes: DashboardOutcomes;
  reliability: DashboardReliability;
  cost: DashboardCost;
  developerSatisfaction: SatisfactionSummary;
  gaps: readonly Readonly<{ field: string; reason: string }>[];
  provenance: Readonly<Record<string, string>>;
  computedAt: string;
}>;

function isoOrNull(name: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name}_invalid`);
  }
  return value;
}

function rate(numerator: number, denominator: number, emptyReason: string): DashboardRateMetric {
  if (denominator === 0) {
    return Object.freeze({ value: null, numerator, denominator, basis: "measured", reason: emptyReason });
  }
  return Object.freeze({ value: numerator / denominator, numerator, denominator, basis: "measured" });
}

const DASHBOARD_GAPS: readonly Readonly<{ field: string; reason: string }>[] = Object.freeze([
  Object.freeze({
    field: "reliability.verificationPassRate",
    reason:
      "Verification runs (baseline vs post-edit) are computed transiently inside the campaign executor and gate a candidate before delivery; no per-run pass/fail count is persisted in a queryable table, so a truthful rate cannot be aggregated yet.",
  }),
  Object.freeze({
    field: "reliability.introducedVsPreexistingFailures",
    reason:
      "The introduced-vs-pre-existing failure comparison exists only in the in-memory WardenVerificationComparison during execution; it is not written to a durable per-run row, so it cannot be summed across runs here.",
  }),
  Object.freeze({
    field: "adoption.teams",
    reason:
      "The schema models tenants, principals, and memberships but has no team grouping, so active-teams cannot be counted. Active users are reported instead, from distinct audit-event principals.",
  }),
]);

const DASHBOARD_PROVENANCE: Readonly<Record<string, string>> = Object.freeze({
  "adoption.reposConnected": "count of consumers WHERE tenant_id = tenant (lifetime state)",
  "adoption.providersMonitored":
    "count of DISTINCT monitored_apis.provider_id joined to consumers of the tenant (lifetime state)",
  "adoption.monitoredApis": "count of monitored_apis joined to consumers of the tenant (lifetime state)",
  "adoption.totalRuns": "count of agent_runs WHERE tenant_id = tenant, within window (agent_runs.created_at)",
  "adoption.activeUsers":
    "count of DISTINCT audit_events.principal_id (non-null) WHERE tenant_id = tenant, within window",
  "adoption.runsByDay": "agent_runs grouped by substr(created_at,1,10), within window",
  "outcomes.prsOpened/prsMerged/prsClosed/prsOpen":
    "migration_prs.status joined to consumers of the tenant, within window (migration_prs.created_at)",
  "outcomes.mergeRate": "migration_prs merged / (merged + closed), within window",
  "outcomes.candidatesApproved": "count of agent_runs.status = 'candidate_approved', within window",
  "outcomes.candidatesRejected": "count of agent_runs.status = 'candidate_rejected', within window",
  "outcomes.candidateApprovalRate": "candidate_approved / (candidate_approved + candidate_rejected), within window",
  "outcomes.abstainedRuns":
    "count of audit_events.action = 'warden.pilot.abstained' WHERE tenant_id = tenant, within window",
  "outcomes.outOfScopeRuns": "count of agent_runs.status = 'no_action', within window",
  "reliability.runsSucceeded": "count of agent_runs.ok = 1, within window",
  "reliability.runsFailed": "count of agent_runs.status IN ('failed','error'), within window",
  "reliability.runSuccessRate": "runsSucceeded / (runsSucceeded + runsFailed), within window",
  "reliability.retries": "count of jobs WHERE tenant_id = tenant AND attempts > 1, within window (jobs.created_at)",
  "cost.measuredUsd":
    "SUM(agent_run_meters.cost_usd) over rows with cost_measured = 1, WHERE tenant_id = tenant, within window; per-run averaged over measured runs only",
  "cost.mcu":
    "getUsageSummary(tenant): usage_ledger_entries consumed/reserved deltas against the active entitlement (running ledger balance, not windowed); unavailable when no entitlement is provisioned",
  "developerSatisfaction":
    "developer_satisfaction_signals.rating WHERE tenant_id = tenant, within window; unavailable when no signals captured",
});

type WindowSql = { clause: (column: string) => string; params: string[] };

function buildWindow(since: string | null, until: string | null): WindowSql {
  return {
    clause(column: string): string {
      let sql = "";
      if (since !== null) sql += ` AND ${column} >= ?`;
      if (until !== null) sql += ` AND ${column} < ?`;
      return sql;
    },
    get params(): string[] {
      const p: string[] = [];
      if (since !== null) p.push(since);
      if (until !== null) p.push(until);
      return p;
    },
  };
}

function count(db: AppDb, sql: string, params: (string | number)[]): number {
  return (db.raw.prepare(sql).get(...params) as { c: number }).c;
}

function computeAdoption(db: AppDb, tenantId: string, w: WindowSql): DashboardAdoption {
  const reposConnected = count(db, `SELECT COUNT(*) AS c FROM consumers WHERE tenant_id = ?`, [tenantId]);
  const providersMonitored = count(
    db,
    `SELECT COUNT(DISTINCT m.provider_id) AS c FROM monitored_apis m
     JOIN consumers c ON c.id = m.consumer_id WHERE c.tenant_id = ?`,
    [tenantId],
  );
  const monitoredApis = count(
    db,
    `SELECT COUNT(*) AS c FROM monitored_apis m
     JOIN consumers c ON c.id = m.consumer_id WHERE c.tenant_id = ?`,
    [tenantId],
  );
  const totalRuns = count(
    db,
    `SELECT COUNT(*) AS c FROM agent_runs WHERE tenant_id = ?${w.clause("created_at")}`,
    [tenantId, ...w.params],
  );
  const activeUsers = count(
    db,
    `SELECT COUNT(DISTINCT principal_id) AS c FROM audit_events
     WHERE tenant_id = ? AND principal_id IS NOT NULL${w.clause("created_at")}`,
    [tenantId, ...w.params],
  );
  const runsByDay = (
    db.raw
      .prepare(
        `SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS runs FROM agent_runs
         WHERE tenant_id = ?${w.clause("created_at")}
         GROUP BY date ORDER BY date`,
      )
      .all(tenantId, ...w.params) as Array<{ date: string; runs: number }>
  ).map((r) => Object.freeze({ date: r.date, runs: r.runs }));

  return Object.freeze({
    reposConnected,
    providersMonitored,
    monitoredApis,
    totalRuns,
    activeUsers,
    runsByDay: Object.freeze(runsByDay),
    teams: Object.freeze({
      value: null,
      basis: "unavailable",
      reason: DASHBOARD_GAPS.find((g) => g.field === "adoption.teams")!.reason,
    }),
  });
}

function computeOutcomes(db: AppDb, tenantId: string, w: WindowSql): DashboardOutcomes {
  const prRows = db.raw
    .prepare(
      `SELECT pr.status AS status, COUNT(*) AS c FROM migration_prs pr
       JOIN consumers c ON c.id = pr.consumer_id
       WHERE c.tenant_id = ?${w.clause("pr.created_at")}
       GROUP BY pr.status`,
    )
    .all(tenantId, ...w.params) as Array<{ status: string; c: number }>;
  let prsMerged = 0;
  let prsClosed = 0;
  let prsOpen = 0;
  let prsOpened = 0;
  for (const row of prRows) {
    prsOpened += row.c;
    if (row.status === "merged") prsMerged += row.c;
    else if (row.status === "closed") prsClosed += row.c;
    else if (row.status === "open" || row.status === "draft") prsOpen += row.c;
  }

  const approved = count(
    db,
    `SELECT COUNT(*) AS c FROM agent_runs WHERE tenant_id = ? AND status = 'candidate_approved'${w.clause("created_at")}`,
    [tenantId, ...w.params],
  );
  const rejected = count(
    db,
    `SELECT COUNT(*) AS c FROM agent_runs WHERE tenant_id = ? AND status = 'candidate_rejected'${w.clause("created_at")}`,
    [tenantId, ...w.params],
  );
  const abstained = count(
    db,
    `SELECT COUNT(*) AS c FROM audit_events
     WHERE tenant_id = ? AND action = 'warden.pilot.abstained'${w.clause("created_at")}`,
    [tenantId, ...w.params],
  );
  const outOfScope = count(
    db,
    `SELECT COUNT(*) AS c FROM agent_runs WHERE tenant_id = ? AND status = 'no_action'${w.clause("created_at")}`,
    [tenantId, ...w.params],
  );

  return Object.freeze({
    prsOpened,
    prsMerged,
    prsClosed,
    prsOpen,
    mergeRate: rate(prsMerged, prsMerged + prsClosed, "no resolved PRs in window"),
    candidatesApproved: approved,
    candidatesRejected: rejected,
    candidateApprovalRate: rate(approved, approved + rejected, "no reviewed candidates in window"),
    abstainedRuns: abstained,
    outOfScopeRuns: outOfScope,
  });
}

function computeReliability(db: AppDb, tenantId: string, w: WindowSql): DashboardReliability {
  const runsSucceeded = count(
    db,
    `SELECT COUNT(*) AS c FROM agent_runs WHERE tenant_id = ? AND ok = 1${w.clause("created_at")}`,
    [tenantId, ...w.params],
  );
  const runsFailed = count(
    db,
    `SELECT COUNT(*) AS c FROM agent_runs
     WHERE tenant_id = ? AND status IN ('failed', 'error')${w.clause("created_at")}`,
    [tenantId, ...w.params],
  );
  const retries = count(
    db,
    `SELECT COUNT(*) AS c FROM jobs WHERE tenant_id = ? AND attempts > 1${w.clause("created_at")}`,
    [tenantId, ...w.params],
  );

  return Object.freeze({
    runsSucceeded,
    runsFailed,
    runSuccessRate: rate(runsSucceeded, runsSucceeded + runsFailed, "no succeeded or failed runs in window"),
    retries,
    verificationPassRate: Object.freeze({
      value: null,
      basis: "unavailable",
      reason: DASHBOARD_GAPS.find((g) => g.field === "reliability.verificationPassRate")!.reason,
    }),
    introducedVsPreexistingFailures: Object.freeze({
      value: null,
      basis: "unavailable",
      reason: DASHBOARD_GAPS.find((g) => g.field === "reliability.introducedVsPreexistingFailures")!.reason,
    }),
  });
}

function computeCost(
  db: AppDb,
  tenantId: string,
  w: WindowSql,
  computedAt: string,
): DashboardCost {
  const meter = db.raw
    .prepare(
      `SELECT
         COUNT(*) AS total_runs,
         SUM(CASE WHEN cost_measured = 1 THEN 1 ELSE 0 END) AS measured_runs,
         SUM(CASE WHEN cost_measured = 1 THEN cost_usd ELSE 0 END) AS total_usd
       FROM agent_run_meters WHERE tenant_id = ?${w.clause("created_at")}`,
    )
    .get(tenantId, ...w.params) as {
    total_runs: number;
    measured_runs: number | null;
    total_usd: number | null;
  };
  const measuredRuns = meter.measured_runs ?? 0;
  const totalRuns = meter.total_runs ?? 0;
  let measuredUsd: DashboardCostMeasured;
  if (measuredRuns === 0) {
    measuredUsd = Object.freeze({
      totalUsd: null,
      perRunUsd: null,
      measuredRuns: 0,
      totalRuns,
      basis: "measured",
      reason:
        totalRuns === 0
          ? "no metered runs in window"
          : "cost was not measured for any run in window; unmeasured runs are excluded rather than counted as zero",
    });
  } else {
    const totalUsd = meter.total_usd ?? 0;
    measuredUsd = Object.freeze({
      totalUsd,
      perRunUsd: totalUsd / measuredRuns,
      measuredRuns,
      totalRuns,
      basis: "measured",
      ...(measuredRuns < totalRuns
        ? {
            note:
              `Averaged over the ${measuredRuns} of ${totalRuns} metered runs with measured cost; ` +
              "runs with unmeasured cost are excluded rather than counted as zero.",
          }
        : {}),
    });
  }

  // The MCU usage ledger is a running balance against the active entitlement, not
  // a windowed event stream, so it is reported as-of computedAt. When the tenant
  // has no provisioned entitlement it is honestly unavailable, never zero.
  const usage = getUsageSummary(db, tenantId, computedAt);
  const mcu: DashboardCostMcu = usage.entitlement
    ? Object.freeze({
        basis: "measured",
        consumedMcuMicros: usage.consumedMcuMicros,
        reservedMcuMicros: usage.reservedMcuMicros,
        availableMcuMicros: usage.availableMcuMicros,
        billableMoneyMicros: usage.billableMoneyMicros,
        currency: usage.currency,
        note: "Running usage-ledger balance against the active entitlement; reflects all time, not the selected window.",
      })
    : Object.freeze({
        basis: "unavailable",
        reason:
          "No usage entitlement is provisioned for this tenant, so MCU consumption and billable cost cannot be reported. The entitlement ledger fails closed rather than showing an unmetered zero.",
      });

  return Object.freeze({ measuredUsd, mcu });
}

/**
 * Compute the tenant-scoped self-serve dashboard. Given identical rows and window
 * the output is deterministic except for computedAt. Every figure traces to a
 * stored field (see {@link SelfServeDashboard.provenance}); dimensions with no
 * faithful source are reported unavailable, never fabricated.
 */
export function computeSelfServeDashboard(
  db: AppDb,
  input: { tenantId: string; since?: string | null; until?: string | null },
): SelfServeDashboard {
  const tenantId = input.tenantId.trim();
  if (!tenantId) throw new Error("dashboard_tenant_invalid");
  const since = isoOrNull("dashboard_since", input.since);
  const until = isoOrNull("dashboard_until", input.until);
  if (since !== null && until !== null && Date.parse(until) <= Date.parse(since)) {
    throw new Error("dashboard_window_invalid");
  }
  const w = buildWindow(since, until);
  const computedAt = new Date().toISOString();

  return Object.freeze({
    tenantId,
    window: Object.freeze({ since, until }),
    adoption: computeAdoption(db, tenantId, w),
    outcomes: computeOutcomes(db, tenantId, w),
    reliability: computeReliability(db, tenantId, w),
    cost: computeCost(db, tenantId, w, computedAt),
    developerSatisfaction: summarizeDeveloperSatisfaction(db, { tenantId, since, until }),
    gaps: DASHBOARD_GAPS,
    provenance: DASHBOARD_PROVENANCE,
    computedAt,
  });
}

function csvCell(value: string | number | null | undefined): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

/**
 * Flatten a computed dashboard into a provenance-annotated CSV a customer can
 * pull for their own reporting. One row per metric: dimension, metric, value,
 * basis, source. Unavailable dimensions render an empty value with their basis,
 * never a fabricated number. The values match the JSON export exactly.
 */
export function exportSelfServeDashboardCsv(dashboard: SelfServeDashboard): string {
  const p = dashboard.provenance;
  const source = (key: string): string => p[key] ?? "";
  const rows: Array<[string, string, string | number | null, string, string]> = [
    ["adoption", "reposConnected", dashboard.adoption.reposConnected, "measured", source("adoption.reposConnected")],
    ["adoption", "providersMonitored", dashboard.adoption.providersMonitored, "measured", source("adoption.providersMonitored")],
    ["adoption", "monitoredApis", dashboard.adoption.monitoredApis, "measured", source("adoption.monitoredApis")],
    ["adoption", "totalRuns", dashboard.adoption.totalRuns, "measured", source("adoption.totalRuns")],
    ["adoption", "activeUsers", dashboard.adoption.activeUsers, "measured", source("adoption.activeUsers")],
    ["adoption", "teams", null, dashboard.adoption.teams.basis, source("adoption.teams") || dashboard.adoption.teams.reason],
    ["outcomes", "prsOpened", dashboard.outcomes.prsOpened, "measured", source("outcomes.prsOpened/prsMerged/prsClosed/prsOpen")],
    ["outcomes", "prsMerged", dashboard.outcomes.prsMerged, "measured", source("outcomes.prsOpened/prsMerged/prsClosed/prsOpen")],
    ["outcomes", "prsClosed", dashboard.outcomes.prsClosed, "measured", source("outcomes.prsOpened/prsMerged/prsClosed/prsOpen")],
    ["outcomes", "prsOpen", dashboard.outcomes.prsOpen, "measured", source("outcomes.prsOpened/prsMerged/prsClosed/prsOpen")],
    ["outcomes", "mergeRate", dashboard.outcomes.mergeRate.value, dashboard.outcomes.mergeRate.basis, source("outcomes.mergeRate")],
    ["outcomes", "candidatesApproved", dashboard.outcomes.candidatesApproved, "measured", source("outcomes.candidatesApproved")],
    ["outcomes", "candidatesRejected", dashboard.outcomes.candidatesRejected, "measured", source("outcomes.candidatesRejected")],
    ["outcomes", "candidateApprovalRate", dashboard.outcomes.candidateApprovalRate.value, dashboard.outcomes.candidateApprovalRate.basis, source("outcomes.candidateApprovalRate")],
    ["outcomes", "abstainedRuns", dashboard.outcomes.abstainedRuns, "measured", source("outcomes.abstainedRuns")],
    ["outcomes", "outOfScopeRuns", dashboard.outcomes.outOfScopeRuns, "measured", source("outcomes.outOfScopeRuns")],
    ["reliability", "runsSucceeded", dashboard.reliability.runsSucceeded, "measured", source("reliability.runsSucceeded")],
    ["reliability", "runsFailed", dashboard.reliability.runsFailed, "measured", source("reliability.runsFailed")],
    ["reliability", "runSuccessRate", dashboard.reliability.runSuccessRate.value, dashboard.reliability.runSuccessRate.basis, source("reliability.runSuccessRate")],
    ["reliability", "retries", dashboard.reliability.retries, "measured", source("reliability.retries")],
    ["reliability", "verificationPassRate", null, dashboard.reliability.verificationPassRate.basis, dashboard.reliability.verificationPassRate.reason],
    ["reliability", "introducedVsPreexistingFailures", null, dashboard.reliability.introducedVsPreexistingFailures.basis, dashboard.reliability.introducedVsPreexistingFailures.reason],
    ["cost", "measuredTotalUsd", dashboard.cost.measuredUsd.totalUsd, dashboard.cost.measuredUsd.basis, source("cost.measuredUsd")],
    ["cost", "measuredPerRunUsd", dashboard.cost.measuredUsd.perRunUsd, dashboard.cost.measuredUsd.basis, source("cost.measuredUsd")],
    [
      "cost",
      "mcuConsumedMicros",
      dashboard.cost.mcu.basis === "measured" ? dashboard.cost.mcu.consumedMcuMicros : null,
      dashboard.cost.mcu.basis,
      dashboard.cost.mcu.basis === "measured" ? source("cost.mcu") : dashboard.cost.mcu.reason,
    ],
    [
      "cost",
      "mcuBillableMoneyMicros",
      dashboard.cost.mcu.basis === "measured" ? dashboard.cost.mcu.billableMoneyMicros : null,
      dashboard.cost.mcu.basis,
      dashboard.cost.mcu.basis === "measured" ? source("cost.mcu") : dashboard.cost.mcu.reason,
    ],
    [
      "developerSatisfaction",
      "averageRating",
      dashboard.developerSatisfaction.averageRating,
      dashboard.developerSatisfaction.basis,
      source("developerSatisfaction"),
    ],
    [
      "developerSatisfaction",
      "responses",
      dashboard.developerSatisfaction.responses,
      dashboard.developerSatisfaction.basis,
      source("developerSatisfaction"),
    ],
  ];
  const header = "dimension,metric,value,basis,source";
  const lines = rows.map((r) => r.map(csvCell).join(","));
  return [header, ...lines].join("\n");
}
