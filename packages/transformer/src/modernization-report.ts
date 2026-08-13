import type {
  TransformerPilotCampaign,
  TransformerPilotException,
  TransformerPilotExceptionCode,
  TransformerPilotMetrics,
  TransformerPilotUnit,
  TransformerPilotUnitState,
} from "./pilot-execution.js";

export const MODERNIZATION_REPORT_SCHEMA_VERSION = "2026-08-12.v1" as const;

/**
 * Read-only view of the pilot execution store the report is generated from.
 * {@link TransformerPilotExecutionStore} satisfies this structurally, which keeps
 * the generator a pure function of persisted campaign state.
 */
export interface ModernizationReportSource {
  getCampaign(tenantId: string, campaignId: string): TransformerPilotCampaign | undefined;
  metrics(tenantId: string, campaignId: string): TransformerPilotMetrics;
}

const UNIT_STATES: readonly TransformerPilotUnitState[] = [
  "pending",
  "running",
  "executed",
  "draft",
  "accepted",
  "merged",
  "failed",
  "cancelled",
  "rolled_back",
];

/**
 * Completion is reported through two distinct figures because the pilot store
 * measures completion at two levels that legitimately diverge:
 *  - {@link unitCompletionRate} counts merged units against total units. It is the
 *    stored {@link TransformerPilotMetrics.campaignCompletionRate}, which is forced
 *    to 1 once the campaign itself reaches the "completed" state.
 *  - {@link waveCompletionRate} counts fully-merged waves against total waves. It is
 *    the stored {@link TransformerPilotMetrics.waveCompletionRate}. A wave counts as
 *    complete only when every unit in it is merged, so a wave with some merged units
 *    still contributes 0 here while those merged units already lift the unit rate.
 */
export type ModernizationReportCompletion = Readonly<{
  unitCompletionRate: number;
  waveCompletionRate: number;
  unitsMerged: number;
  unitsTotal: number;
  wavesCompleted: number;
  wavesTotal: number;
  clampedToComplete: boolean;
}>;

export type ModernizationReportSummary = Readonly<{
  tenantId: string;
  organizationId: string;
  campaignId: string;
  environment: string;
  status: TransformerPilotCampaign["state"];
  revision: number;
  startedAt: string;
  updatedAt: string;
  durationMs: number;
  completion: ModernizationReportCompletion;
  actualCostUsd: number | null;
}>;

export type ModernizationReportUnitProgress = Readonly<{
  total: number;
  merged: number;
  inReview: number;
  inProgress: number;
  pending: number;
  failed: number;
  cancelled: number;
  byState: Readonly<Record<TransformerPilotUnitState, number>>;
}>;

export type ModernizationReportWaveProgress = Readonly<{
  wave: number;
  total: number;
  merged: number;
  accepted: number;
  failed: number;
  complete: boolean;
}>;

export type ModernizationReportPullRequests = Readonly<{
  draftsOpen: number;
  accepted: number;
  merged: number;
}>;

export type ModernizationReportRecipeBreakdown = Readonly<{
  recipeId: string;
  recipeVersion: number;
  total: number;
  merged: number;
}>;

export type ModernizationReportProgress = Readonly<{
  units: ModernizationReportUnitProgress;
  waves: Readonly<{
    total: number;
    completed: number;
    byWave: readonly ModernizationReportWaveProgress[];
  }>;
  pullRequests: ModernizationReportPullRequests;
  byRecipe: readonly ModernizationReportRecipeBreakdown[];
}>;

export type ModernizationReportExceptions = Readonly<{
  total: number;
  open: number;
  resolved: number;
  waived: number;
  byCode: Readonly<Partial<Record<TransformerPilotExceptionCode, number>>>;
  register: readonly TransformerPilotException[];
}>;

export type ModernizationReportRisks = Readonly<{
  remainingUnits: number;
  blockedUnits: number;
  blockedRetryAuthorized: number;
  rolledBackUnits: number;
  humanReviewQueue: Readonly<{
    unitsAwaitingReview: number;
    openExceptions: number;
  }>;
}>;

export type ModernizationReportGap = Readonly<{ field: string; reason: string }>;

export type ModernizationReport = Readonly<{
  schemaVersion: typeof MODERNIZATION_REPORT_SCHEMA_VERSION;
  summary: ModernizationReportSummary;
  progress: ModernizationReportProgress;
  exceptions: ModernizationReportExceptions;
  risks: ModernizationReportRisks;
  gaps: readonly ModernizationReportGap[];
  provenance: Readonly<Record<string, string>>;
}>;

const REPORT_GAPS: readonly ModernizationReportGap[] = Object.freeze([
  Object.freeze({
    field: "campaign objective (source system to target stack)",
    reason:
      "The pilot execution store persists execution identity (campaignId, organizationId, environment) but not a human objective, source system, or target stack. Those live in the control-plane blueprint and campaign contracts, a separate store.",
  }),
  Object.freeze({
    field: "pull request number and url",
    reason:
      "The pilot execution store models pull request outcomes through unit lifecycle states (executed, draft, accepted, merged) and timestamps. It does not persist per-pull-request numbers or urls.",
  }),
]);

const PROVENANCE: Readonly<Record<string, string>> = Object.freeze({
  "summary.status": "TransformerPilotCampaign.state",
  "summary.revision": "TransformerPilotCampaign.revision",
  "summary.startedAt": "TransformerPilotCampaign.createdAt",
  "summary.updatedAt": "TransformerPilotCampaign.updatedAt",
  "summary.durationMs": "TransformerPilotCampaign.updatedAt minus createdAt (milliseconds)",
  "summary.completion.unitCompletionRate":
    "TransformerPilotMetrics.campaignCompletionRate (merged units / total units, forced to 1 when campaign.state is completed)",
  "summary.completion.waveCompletionRate":
    "TransformerPilotMetrics.waveCompletionRate (waves with every unit merged / total waves)",
  "summary.completion.unitsMerged": "count of TransformerPilotUnit.state === merged",
  "summary.completion.wavesCompleted":
    "count of distinct TransformerPilotUnit.wave values whose units are all merged",
  "summary.actualCostUsd":
    "TransformerPilotMetrics.actualCostUsd (null unless every unit reports actualCostUsd)",
  "progress.units.byState": "TransformerPilotUnit.state",
  "progress.waves": "distinct TransformerPilotUnit.wave; a wave is complete when every unit in it is merged",
  "progress.pullRequests.draftsOpen": "count of TransformerPilotUnit.state === draft",
  "progress.pullRequests.accepted":
    "count of TransformerPilotUnit with acceptedAt or mergedAt (matches TransformerPilotMetrics.batchAcceptanceRate)",
  "progress.pullRequests.merged": "count of TransformerPilotUnit.state === merged",
  "progress.byRecipe": "TransformerPilotUnit.recipe.id and recipe.version",
  "exceptions.register": "TransformerPilotCampaign.exceptions",
  "exceptions.open": "TransformerPilotMetrics.openExceptionCount",
  "risks.remainingUnits":
    "count of TransformerPilotUnit.state not in {merged, cancelled, rolled_back}",
  "risks.blockedUnits": "count of TransformerPilotUnit.state === failed",
  "risks.humanReviewQueue.unitsAwaitingReview":
    "count of TransformerPilotUnit.state in {draft, accepted}",
  "risks.humanReviewQueue.openExceptions": "count of TransformerPilotCampaign.exceptions with state === open",
});

function countByState(units: readonly TransformerPilotUnit[]): Record<TransformerPilotUnitState, number> {
  const counts = Object.fromEntries(UNIT_STATES.map((state) => [state, 0])) as Record<
    TransformerPilotUnitState,
    number
  >;
  for (const unit of units) counts[unit.state] += 1;
  return counts;
}

function waveProgress(units: readonly TransformerPilotUnit[]): ModernizationReportWaveProgress[] {
  const waves = new Map<number, TransformerPilotUnit[]>();
  for (const unit of units) {
    const bucket = waves.get(unit.wave);
    if (bucket) bucket.push(unit);
    else waves.set(unit.wave, [unit]);
  }
  return [...waves.keys()]
    .sort((left, right) => left - right)
    .map((wave) => {
      const members = waves.get(wave)!;
      const merged = members.filter((unit) => unit.state === "merged").length;
      return Object.freeze({
        wave,
        total: members.length,
        merged,
        accepted: members.filter((unit) => unit.state === "accepted").length,
        failed: members.filter((unit) => unit.state === "failed").length,
        complete: members.length > 0 && merged === members.length,
      });
    });
}

function recipeBreakdown(units: readonly TransformerPilotUnit[]): ModernizationReportRecipeBreakdown[] {
  const byRecipe = new Map<string, { recipeId: string; recipeVersion: number; total: number; merged: number }>();
  for (const unit of units) {
    const key = `${unit.recipe.id}@${unit.recipe.version}`;
    const entry = byRecipe.get(key) ?? {
      recipeId: unit.recipe.id,
      recipeVersion: unit.recipe.version,
      total: 0,
      merged: 0,
    };
    entry.total += 1;
    if (unit.state === "merged") entry.merged += 1;
    byRecipe.set(key, entry);
  }
  return [...byRecipe.keys()]
    .sort((left, right) => left.localeCompare(right))
    .map((key) => Object.freeze({ ...byRecipe.get(key)! }));
}

/**
 * Produce a deterministic executive modernization report for a campaign from the
 * real persisted pilot execution state. Every figure traces to a stored field (see
 * {@link ModernizationReport.provenance}); spec-desired figures with no backing data
 * are reported in {@link ModernizationReport.gaps} rather than invented.
 *
 * The store is tenant-scoped, so tenantId accompanies campaignId. Given identical
 * campaign state the output is byte-for-byte identical.
 */
export function generateModernizationReport(
  db: ModernizationReportSource,
  tenantId: string,
  campaignId: string,
): ModernizationReport {
  const campaign = db.getCampaign(tenantId, campaignId);
  if (!campaign) throw new Error("transformer_pilot_campaign_not_found");
  const metrics = db.metrics(tenantId, campaignId);
  const units = campaign.units;
  const exceptions = campaign.exceptions;

  const byState = countByState(units);
  const waves = waveProgress(units);
  const wavesCompleted = waves.filter((wave) => wave.complete).length;

  const byCode: Partial<Record<TransformerPilotExceptionCode, number>> = {};
  for (const exception of exceptions) {
    byCode[exception.code] = (byCode[exception.code] ?? 0) + 1;
  }

  const remainingUnits = units.filter(
    (unit) => unit.state !== "merged" && unit.state !== "cancelled" && unit.state !== "rolled_back",
  ).length;
  const openExceptions = exceptions.filter((exception) => exception.state === "open").length;

  const summary: ModernizationReportSummary = Object.freeze({
    tenantId: campaign.tenantId,
    organizationId: campaign.organizationId,
    campaignId: campaign.campaignId,
    environment: campaign.environment,
    status: campaign.state,
    revision: campaign.revision,
    startedAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    durationMs: Date.parse(campaign.updatedAt) - Date.parse(campaign.createdAt),
    completion: Object.freeze({
      unitCompletionRate: metrics.campaignCompletionRate,
      waveCompletionRate: metrics.waveCompletionRate,
      unitsMerged: byState.merged,
      unitsTotal: units.length,
      wavesCompleted,
      wavesTotal: waves.length,
      clampedToComplete: campaign.state === "completed",
    }),
    actualCostUsd: metrics.actualCostUsd,
  });

  const progress: ModernizationReportProgress = Object.freeze({
    units: Object.freeze({
      total: units.length,
      merged: byState.merged,
      inReview: byState.draft + byState.accepted,
      inProgress: byState.running + byState.executed,
      pending: byState.pending,
      failed: byState.failed,
      cancelled: byState.cancelled + byState.rolled_back,
      byState: Object.freeze(byState),
    }),
    waves: Object.freeze({
      total: waves.length,
      completed: wavesCompleted,
      byWave: Object.freeze(waves),
    }),
    pullRequests: Object.freeze({
      draftsOpen: byState.draft,
      accepted: units.filter((unit) => unit.acceptedAt || unit.mergedAt).length,
      merged: byState.merged,
    }),
    byRecipe: Object.freeze(recipeBreakdown(units)),
  });

  const reportExceptions: ModernizationReportExceptions = Object.freeze({
    total: exceptions.length,
    open: openExceptions,
    resolved: exceptions.filter((exception) => exception.state === "resolved").length,
    waived: exceptions.filter((exception) => exception.state === "waived").length,
    byCode: Object.freeze(byCode),
    register: Object.freeze(exceptions.map((exception) => Object.freeze({ ...exception }))),
  });

  const risks: ModernizationReportRisks = Object.freeze({
    remainingUnits,
    blockedUnits: byState.failed,
    blockedRetryAuthorized: units.filter((unit) => unit.state === "failed" && unit.retryAuthorized).length,
    rolledBackUnits: byState.rolled_back,
    humanReviewQueue: Object.freeze({
      unitsAwaitingReview: byState.draft + byState.accepted,
      openExceptions,
    }),
  });

  return Object.freeze({
    schemaVersion: MODERNIZATION_REPORT_SCHEMA_VERSION,
    summary,
    progress,
    exceptions: reportExceptions,
    risks,
    gaps: REPORT_GAPS,
    provenance: PROVENANCE,
  });
}

function formatPercent(rate: number): string {
  if (!Number.isFinite(rate)) return "n/a";
  return `${(rate * 100).toFixed(1)}%`;
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "n/a";
  const minutes = Math.floor(durationMs / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}

function formatCost(cost: number | null): string {
  return cost === null ? "not fully reported" : `$${cost.toFixed(2)}`;
}

/** Render an executive modernization report as human-readable Markdown. Deterministic. */
export function renderModernizationReportMarkdown(report: ModernizationReport): string {
  const { summary, progress, exceptions, risks } = report;
  const lines: string[] = [];

  lines.push(`# Modernization report: ${summary.campaignId}`);
  lines.push("");
  lines.push(`- Status: ${summary.status} (revision ${summary.revision})`);
  lines.push(`- Organization: ${summary.organizationId}`);
  lines.push(`- Environment: ${summary.environment}`);
  lines.push(`- Started: ${summary.startedAt}`);
  lines.push(`- Last updated: ${summary.updatedAt}`);
  lines.push(`- Elapsed: ${formatDuration(summary.durationMs)}`);
  lines.push(`- Recorded cost: ${formatCost(summary.actualCostUsd)}`);
  lines.push("");

  lines.push("## Completion");
  lines.push("");
  lines.push(
    `- Unit completion: ${formatPercent(summary.completion.unitCompletionRate)} ` +
      `(${summary.completion.unitsMerged} of ${summary.completion.unitsTotal} units merged` +
      `${summary.completion.clampedToComplete ? ", reported as complete because the campaign reached the completed state" : ""}).`,
  );
  lines.push(
    `- Wave completion: ${formatPercent(summary.completion.waveCompletionRate)} ` +
      `(${summary.completion.wavesCompleted} of ${summary.completion.wavesTotal} waves fully merged).`,
  );
  lines.push(
    "- These two figures differ by design: a wave counts as complete only when every unit in it is merged, " +
      "so partially merged waves lower the wave rate while their merged units still raise the unit rate.",
  );
  lines.push("");

  lines.push("## Progress");
  lines.push("");
  lines.push(`- Units: ${progress.units.total} total`);
  lines.push(`  - Merged: ${progress.units.merged}`);
  lines.push(`  - In review: ${progress.units.inReview}`);
  lines.push(`  - In progress: ${progress.units.inProgress}`);
  lines.push(`  - Pending: ${progress.units.pending}`);
  lines.push(`  - Failed: ${progress.units.failed}`);
  lines.push(`  - Cancelled or rolled back: ${progress.units.cancelled}`);
  lines.push(
    `- Pull requests: ${progress.pullRequests.draftsOpen} draft, ` +
      `${progress.pullRequests.accepted} accepted, ${progress.pullRequests.merged} merged`,
  );
  lines.push(`- Waves: ${progress.waves.completed} of ${progress.waves.total} complete`);
  for (const wave of progress.waves.byWave) {
    lines.push(
      `  - Wave ${wave.wave}: ${wave.merged} of ${wave.total} merged` +
        `${wave.complete ? " (complete)" : ""}`,
    );
  }
  if (progress.byRecipe.length > 0) {
    lines.push("- By recipe:");
    for (const recipe of progress.byRecipe) {
      lines.push(`  - ${recipe.recipeId} ${recipe.recipeVersion}: ${recipe.merged} of ${recipe.total} merged`);
    }
  }
  lines.push("");

  lines.push("## Exceptions register");
  lines.push("");
  if (exceptions.total === 0) {
    lines.push("- No exceptions recorded.");
  } else {
    lines.push(
      `- ${exceptions.total} total: ${exceptions.open} open, ${exceptions.resolved} resolved, ${exceptions.waived} waived.`,
    );
    for (const exception of exceptions.register) {
      const scope = exception.unitId ? `unit ${exception.unitId}` : "campaign";
      lines.push(
        `  - ${exception.id} [${exception.state}] ${exception.code} (${scope}, owner ${exception.ownerId}): ${exception.dueAction}`,
      );
    }
  }
  lines.push("");

  lines.push("## Risk and remaining work");
  lines.push("");
  lines.push(`- Remaining units: ${risks.remainingUnits}`);
  lines.push(`- Blocked (failed) units: ${risks.blockedUnits} (${risks.blockedRetryAuthorized} retry authorized)`);
  lines.push(`- Rolled back units: ${risks.rolledBackUnits}`);
  lines.push(
    `- Human review queue: ${risks.humanReviewQueue.unitsAwaitingReview} units awaiting review, ` +
      `${risks.humanReviewQueue.openExceptions} open exceptions`,
  );
  lines.push("");

  if (report.gaps.length > 0) {
    lines.push("## Data gaps");
    lines.push("");
    for (const gap of report.gaps) {
      lines.push(`- ${gap.field}: ${gap.reason}`);
    }
    lines.push("");
  }

  lines.push("## Data sources");
  lines.push("");
  for (const [field, source] of Object.entries(report.provenance)) {
    lines.push(`- ${field}: ${source}`);
  }

  return lines.join("\n");
}
