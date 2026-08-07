import { createHash } from "node:crypto";
import type {
  AdaptiveExternalModelReservation,
  AdaptiveExternalModelSettlement,
} from "./adaptive-loop.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  authorizeTransformerDelivery,
  authorizeTransformerWorkerAction,
} from "@mendpoint/ops";
import {
  assessOrganizationConstraint,
  type OrganizationConstraintContract,
} from "./organization-constraints.js";
import { resolveRecipe, type RecipeFileModes, type RecipeReference } from "./recipe.js";

export const TRANSFORMER_PILOT_EXECUTION_SCHEMA_VERSION = "2026-08-06.v2" as const;

const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const BRANCH = /^(?!\/)(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
const MANIFEST_SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ROUTING_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._,:-]{0,499}$/;
const DEFAULT_LEASE_DURATION_MS = 60_000;
const MIN_LEASE_DURATION_MS = 1_000;
const MAX_LEASE_DURATION_MS = 3_600_000;

export type TransformerAdaptiveAttemptAccounting = Readonly<{
  plannerCalls: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  actualCostUsd: number;
  wallTimeMs: number;
}>;

export type TransformerAdaptiveModelReservation = Readonly<{
  reservationId: string;
  attemptNumber: number;
  leaseGeneration: number;
  leaseTokenDigest: string;
  requestDigest: string;
  provider: string;
  configuredModel: string;
  deployment: string;
  executionRegion: string;
  maximumDataClassification: "public" | "internal" | "confidential" | "restricted";
  endpointHost: string;
  maximumInputTokens: number;
  maximumOutputTokens: number;
  maximumTotalTokens: number;
  maximumCostUsd: number;
  reservedAt: string;
  status: "active" | "succeeded" | "failed" | "over_budget" | "unknown";
  settledAt?: string;
  actualModel?: string;
  bodyRequestId?: string | null;
  headerRequestId?: string | null;
  reportedInputTokens?: number;
  reportedOutputTokens?: number;
  reportedTotalTokens?: number;
  reportedCostUsd?: number | null;
  chargedInputTokens?: number;
  chargedOutputTokens?: number;
  chargedTotalTokens?: number;
  chargedCostUsd?: number;
  errorCode?: string;
}>;

export type TransformerAdaptiveCampaignBudgetCeilings = Readonly<{
  maxAttempts: number;
  maxPlannerCalls: number;
  maxModelCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  maxActualCostUsd: number;
  maxWallTimeMs: number;
}>;

export type TransformerAdaptiveCampaignBudgetTotals = Readonly<{
  attempts: number;
}> & TransformerAdaptiveAttemptAccounting;

export type TransformerAdaptiveBudgetOverride = Readonly<{
  id: string;
  humanActorId: string;
  reason: string;
  observedAt: string;
  evidenceRefs: readonly string[];
  previousCeilings: TransformerAdaptiveCampaignBudgetCeilings;
  nextCeilings: TransformerAdaptiveCampaignBudgetCeilings;
}>;

export type TransformerAdaptiveCampaignBudget = Readonly<{
  ceilings: TransformerAdaptiveCampaignBudgetCeilings;
  totals: TransformerAdaptiveCampaignBudgetTotals;
  overrides: readonly TransformerAdaptiveBudgetOverride[];
}>;

export const DEFAULT_TRANSFORMER_ADAPTIVE_CAMPAIGN_BUDGET: TransformerAdaptiveCampaignBudgetCeilings =
  Object.freeze({
    maxAttempts: 20,
    maxPlannerCalls: 100,
    maxModelCalls: 100,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 250_000,
    maxTotalTokens: 1_250_000,
    maxActualCostUsd: 50,
    maxWallTimeMs: 2 * 60 * 60_000,
  });

const HARD_TRANSFORMER_ADAPTIVE_CAMPAIGN_BUDGET: TransformerAdaptiveCampaignBudgetCeilings =
  Object.freeze({
    maxAttempts: 1_000,
    maxPlannerCalls: 10_000,
    maxModelCalls: 10_000,
    maxInputTokens: 100_000_000,
    maxOutputTokens: 25_000_000,
    maxTotalTokens: 125_000_000,
    maxActualCostUsd: 100_000,
    maxWallTimeMs: 30 * 24 * 60 * 60_000,
  });

export type TransformerPilotUnitState =
  | "pending"
  | "running"
  | "executed"
  | "draft"
  | "accepted"
  | "merged"
  | "failed"
  | "cancelled"
  | "rolled_back";

export type TransformerPilotExceptionCode =
  | "worker_crash"
  | "source_drift"
  | "candidate_drift"
  | "verification_failed"
  | "execution_failed"
  | "head_drift"
  | "ci_failure"
  | "ci_incomplete"
  | "ci_evidence_stale"
  | "review_incomplete"
  | "review_evidence_stale"
  | "review_changes_requested"
  | "conversation_unresolved"
  | "partial_wave_merge"
  | "draft_closed";

export type TransformerAttemptFailureCode =
  | "source_drift"
  | "candidate_drift"
  | "verification_failed"
  | "execution_failed"
  | "worker_crash";

const TRANSFORMER_ATTEMPT_FAILURE_CODES = new Set<TransformerAttemptFailureCode>([
  "source_drift",
  "candidate_drift",
  "verification_failed",
  "execution_failed",
  "worker_crash",
]);

export type TransformerExactSnapshot = Readonly<{
  snapshotId: string;
  repositoryId: string;
  revision: string;
  manifestSha256: string;
  digest: string;
  evidenceRefs: readonly string[];
}>;

export type TransformerPilotUnitInput = Readonly<{
  id: string;
  title: string;
  ownerId: string;
  reviewerIds: readonly string[];
  dependsOn: readonly string[];
  snapshot: TransformerExactSnapshot;
  candidateRevision: string;
  candidateDigest: string;
  recipe: RecipeReference;
  changedPaths: readonly string[];
}>;

export type TransformerPilotCampaignInput = Readonly<{
  tenantId: string;
  organizationId: string;
  environment: string;
  campaignId: string;
  constraints: OrganizationConstraintContract;
  units: readonly TransformerPilotUnitInput[];
  observedAt: string;
  evidenceRefs: readonly string[];
  idempotencyKey: string;
  adaptiveBudget?: Partial<TransformerAdaptiveCampaignBudgetCeilings>;
  gateConfig?: string;
}>;

export type TransformerPilotException = Readonly<{
  id: string;
  code: TransformerPilotExceptionCode;
  unitId?: string;
  ownerId: string;
  dueAction: string;
  state: "open" | "resolved" | "waived";
  openedAt: string;
  closedAt?: string;
  resolution?: string;
  evidenceRefs: readonly string[];
}>;

export type TransformerPilotUnit = Readonly<{
  id: string;
  title: string;
  ownerId: string;
  reviewerIds: readonly string[];
  dependsOn: readonly string[];
  wave: number;
  snapshot: TransformerExactSnapshot;
  candidateRevision: string;
  candidateDigest: string;
  recipe: RecipeReference;
  changedPaths: readonly string[];
  state: TransformerPilotUnitState;
  attemptNumber: number;
  leaseGeneration: number;
  leaseTokenDigest?: string;
  leaseExpiresAt?: string;
  retryAuthorized: boolean;
  executionEvidenceRefs: readonly string[];
  scmEvidenceRefs: readonly string[];
  startedAt?: string;
  executedAt?: string;
  acceptedAt?: string;
  mergedAt?: string;
  verificationPassed?: boolean;
  actualCostUsd?: number;
  adaptiveAccounting: TransformerAdaptiveAttemptAccounting;
  adaptiveModelReservations?: readonly TransformerAdaptiveModelReservation[];
  adaptiveCandidateHandoff?: TransformerAdaptiveCandidateHandoffRecord;
  adaptiveCandidateHandoffHistory?: readonly TransformerAdaptiveCandidateHandoffRecord[];
  regenerationReview?: TransformerRegenerationReview;
  routingSettlement?: TransformerRoutingSettlementRecord;
  reviewerEditLines?: number;
  legacyItemsRemoved?: number;
}>;

export type TransformerPilotCampaign = Readonly<{
  schemaVersion: typeof TRANSFORMER_PILOT_EXECUTION_SCHEMA_VERSION;
  tenantId: string;
  organizationId: string;
  environment: string;
  campaignId: string;
  revision: number;
  state: "running" | "paused" | "cancelled" | "completed" | "rollback_required" | "rolled_back";
  constraintVersion: number;
  constraintDigest: string;
  gateEvidenceRefs: readonly string[];
  units: readonly TransformerPilotUnit[];
  exceptions: readonly TransformerPilotException[];
  adaptiveBudget: TransformerAdaptiveCampaignBudget;
  rollbackPlan?: readonly TransformerRollbackAction[];
  createdAt: string;
  updatedAt: string;
}>;

export type TransformerAttemptLease = Readonly<{
  type: "execute_recipe";
  tenantId: string;
  campaignId: string;
  unitId: string;
  attemptNumber: number;
  leaseGeneration: number;
  leaseTokenDigest: string;
  leaseExpiresAt: string;
  startedAt: string;
  snapshot: TransformerExactSnapshot;
  candidateRevision: string;
  candidateDigest: string;
  changedPaths: readonly string[];
  recipe: RecipeReference;
  constraintVersion: number;
  constraintDigest: string;
  gateEvidenceRefs: readonly string[];
  adaptiveBudgetRemaining: TransformerAdaptiveCampaignBudgetTotals;
  regenerationReview?: TransformerRegenerationReview;
}>;

export type TransformerRoutingOutcomeRecord = Readonly<{
  idempotencyKey: string;
  executorId: string;
  providerId: string;
  outcome: "succeeded" | "failed";
  startedAt: string;
  completedAt: string;
  actualLatencyMs: number;
  actualCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  errorCode?: string;
  verification: Readonly<{
    verdict: "passed" | "failed";
    evidenceArtifactIds: readonly string[];
    verifierId: string;
  }>;
}>;

export type TransformerRoutingSettlementRecord = Readonly<{
  runId: string;
  envelopeId: string;
  outcomeIdempotencyKey: string;
  executorId: string;
  providerId: string;
  boundAt: string;
  evidenceRefs: readonly string[];
  attemptNumber?: number;
  leaseGeneration?: number;
  leaseTokenDigest?: string;
  outcome?: TransformerRoutingOutcomeRecord;
  settledAt?: string;
}>;

export type TransformerPendingRoutingSettlement = Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  runId: string;
  envelopeId: string;
  outcome: TransformerRoutingOutcomeRecord;
}>;

export type TransformerRoutingAttemptBindingInput = Readonly<{
  tenantId: string;
  campaignId: string;
  runId: string;
  envelopeId: string;
  outcomeIdempotencyKey: string;
  executorId: string;
  providerId: string;
  observedAt: string;
  evidenceRefs: readonly string[];
  idempotencyKey: string;
  gateConfig?: string;
}>;

export type TransformerAdaptiveCandidateHandoffRecord = Readonly<{
  candidateId?: string;
  attemptId: string;
  attemptNumber: number;
  leaseGeneration: number;
  leaseTokenDigest: string;
  repositoryId: string;
  snapshotId: string;
  baseBranch: string;
  expectedBaseRevision: string;
  divergedFromDigest: string;
  candidateDigest: string;
  failingCommandId: string | null;
  changedPaths: readonly string[];
  fileModes: RecipeFileModes;
  sealedPath: string;
  sealedSha256: string;
  expiresAt: string;
  observedAt: string;
  evidenceRefs: readonly string[];
  importedAt?: string;
}>;

export type TransformerRegenerationReview = Readonly<{
  candidateId: string;
  reviewerPrincipalId: string;
  rationale: string;
  rationaleDigest: string;
  requestedAt: string;
}>;

export type TransformerAdaptiveCandidateHandoffInput = Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  attemptId: string;
  attemptNumber: number;
  leaseGeneration: number;
  leaseToken: string;
  repositoryId: string;
  snapshotId: string;
  baseBranch: string;
  expectedBaseRevision: string;
  divergedFromDigest: string;
  candidateDigest: string;
  failingCommandId: string | null;
  changedPaths: readonly string[];
  fileModes: RecipeFileModes;
  sealedPath: string;
  sealedSha256: string;
  expiresAt: string;
  observedAt: string;
  evidenceRefs: readonly string[];
  idempotencyKey: string;
  gateConfig?: string;
}>;

export type TransformerPendingAdaptiveCandidateHandoff = Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  environment: string;
  handoff: TransformerAdaptiveCandidateHandoffRecord;
}>;

export type TransformerRunnableCampaign = Readonly<{
  tenantId: string;
  campaignId: string;
  environment: string;
  repositoryId: string;
  taskSnapshotId: string;
  expectedBaseRevision: string;
  sourceArtifactIds: readonly string[];
}>;

export type TransformerExpiredAttempt = Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  leaseGeneration: number;
  environment: string;
}>;

export type TransformerDraftAction = Readonly<{
  type: "open_draft";
  unitId: string;
  repositoryId: string;
  expectedBaseRevision: string;
  expectedHeadRevision: string;
  evidenceRefs: readonly string[];
  draft: true;
  autoMerge: false;
  autoDeploy: false;
}>;

export type TransformerRollbackAction = Readonly<{
  type: "close_draft" | "open_revert_draft" | "restore_workspace";
  unitId: string;
  repositoryId: string;
  expectedRevision: string;
  evidenceRefs: readonly string[];
  draft: true;
  autoMerge: false;
  autoDeploy: false;
}>;

export type TransformerScmObservation = Readonly<{
  unitId: string;
  state: "draft" | "merged" | "closed";
  baseRevision: string;
  headRevision: string;
  checks: "success" | "failure" | "running" | "missing";
  checkRevision: string | null;
  approvals: number;
  approvalRevision: string | null;
  conversationsResolved: boolean;
  reviewerEditLines: number;
  legacyItemsRemoved: number;
  evidenceRefs: readonly string[];
}>;

export type TransformerPilotMetrics = Readonly<{
  campaignCompletionRate: number;
  waveCompletionRate: number;
  batchAcceptanceRate: number;
  timeToFirstAcceptedPullRequestMs: number | null;
  openExceptionCount: number;
  verificationPassRate: number | null;
  rollbackRate: number;
  legacyItemsRemoved: number;
  reviewerEditLines: number;
  actualCostUsd: number | null;
}>;

export type TransformerPilotEvent = Readonly<{
  sequence: number;
  tenantId: string;
  campaignId: string;
  campaignRevision: number;
  type: string;
  observedAt: string;
  evidenceRefs: readonly string[];
  payload: Readonly<Record<string, unknown>>;
}>;

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

type StoredCampaign = Mutable<Omit<TransformerPilotCampaign, "units" | "exceptions">> & {
  units: TransformerPilotUnit[];
  exceptions: TransformerPilotException[];
};

type MutationInput = Readonly<{
  tenantId: string;
  campaignId: string;
  observedAt: string;
  evidenceRefs: readonly string[];
  idempotencyKey: string;
}>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex")}`;
}

function leaseTokenDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function expectedAttemptId(input: Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  attemptNumber: number;
  leaseGeneration: number;
}>): string {
  const identity = [
    input.tenantId,
    input.campaignId,
    input.unitId,
    String(input.attemptNumber),
    String(input.leaseGeneration),
  ].join("\0");
  return `tfattempt_${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32)}`;
}

function requireAdaptiveCandidatePaths(
  values: readonly string[],
  allowedPaths: readonly string[],
): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("transformer_pilot_adaptive_candidate_paths_invalid");
  }
  const paths = values.map((value) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("transformer_pilot_adaptive_candidate_paths_invalid");
    }
    return value;
  });
  const canonical = [...new Set(paths)].sort();
  if (
    canonical.length !== paths.length ||
    canonical.some((path, index) => path !== paths[index]) ||
    canonical.some((path) => !allowedPaths.includes(path))
  ) {
    throw new Error("transformer_pilot_adaptive_candidate_paths_invalid");
  }
  return Object.freeze(canonical);
}

function requireAdaptiveCandidateFileModes(
  changedPaths: readonly string[],
  fileModes: RecipeFileModes,
): RecipeFileModes {
  const modePaths = Object.keys(fileModes).sort();
  if (
    changedPaths.length !== modePaths.length ||
    changedPaths.some((path, index) => path !== modePaths[index])
  ) {
    throw new Error("transformer_pilot_adaptive_candidate_file_modes_invalid");
  }
  const normalized: Record<string, "100644" | "100755"> = {};
  for (const path of modePaths) {
    const mode = fileModes[path];
    if (mode !== "100644" && mode !== "100755") {
      throw new Error("transformer_pilot_adaptive_candidate_file_modes_invalid");
    }
    normalized[path] = mode;
  }
  return Object.freeze(normalized);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requireId(value: string, code: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(code);
  return value;
}

function requireBoundedReviewText(value: string | undefined, maximum: number, code: string): string {
  const resolved = typeof value === "string" ? value.trim() : "";
  if (!resolved || resolved.length > maximum || /[\u0000\u000B\u000C\u007F]/u.test(resolved)) {
    throw new Error(code);
  }
  return resolved;
}

function requireTimestamp(value: string): string {
  if (new Date(value).toISOString() !== value) throw new Error("transformer_pilot_observed_at_invalid");
  return value;
}

function requireEvidence(values: readonly string[], code = "transformer_pilot_evidence_required"): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error(code);
  }
  if (new Set(values).size !== values.length) throw new Error(`${code}_duplicate`);
  return [...values].sort();
}

function requireRevision(value: string, code: string): string {
  if (!REVISION.test(value)) throw new Error(code);
  return value;
}

function requireDigest(value: string, code: string): string {
  if (!DIGEST.test(value)) throw new Error(code);
  return value;
}

function requireNonnegative(value: number, code: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(code);
  return value;
}

function routingTerminal(
  unit: TransformerPilotUnit,
  accounting: TransformerAdaptiveAttemptAccounting,
  completedAt: string,
  evidenceRefs: readonly string[],
  outcome: "succeeded" | "failed",
  errorCode?: string,
): TransformerRoutingSettlementRecord | undefined {
  const routing = unit.routingSettlement;
  if (!routing) return undefined;
  if (routing.outcome) {
    throw new Error("transformer_pilot_routing_terminal_conflict");
  }
  if (
    routing.attemptNumber !== unit.attemptNumber ||
    routing.leaseGeneration !== unit.leaseGeneration ||
    routing.leaseTokenDigest !== unit.leaseTokenDigest
  ) {
    throw new Error("transformer_pilot_routing_attempt_mismatch");
  }
  const startedAt = unit.startedAt;
  if (!startedAt) throw new Error("transformer_pilot_routing_started_at_missing");
  const latency = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isSafeInteger(latency) || latency < 0) {
    throw new Error("transformer_pilot_routing_latency_invalid");
  }
  const measured = accounting.modelCalls > 0;
  const safeError = outcome === "failed"
    ? errorCode && ROUTING_ERROR_CODE.test(errorCode) ? errorCode : "transformer_attempt_failed"
    : undefined;
  const terminal: TransformerRoutingOutcomeRecord = Object.freeze({
    idempotencyKey: routing.outcomeIdempotencyKey,
    executorId: routing.executorId,
    providerId: routing.providerId,
    outcome,
    startedAt,
    completedAt,
    actualLatencyMs: latency,
    actualCostUsd: measured ? accounting.actualCostUsd : null,
    inputTokens: measured ? accounting.inputTokens : null,
    outputTokens: measured ? accounting.outputTokens : null,
    totalTokens: measured ? accounting.totalTokens : null,
    ...(safeError ? { errorCode: safeError } : {}),
    verification: Object.freeze({
      verdict: outcome === "succeeded" ? "passed" as const : "failed" as const,
      evidenceArtifactIds: Object.freeze([...evidenceRefs]),
      verifierId: "transformer-attempt-verifier",
    }),
  });
  return Object.freeze({ ...routing, outcome: terminal });
}

function requireBranch(value: string, code: string): string {
  if (
    typeof value !== "string" || !BRANCH.test(value) ||
    value.endsWith("/") || value.endsWith(".lock")
  ) {
    throw new Error(code);
  }
  return value;
}

const ACCOUNTING_KEYS = Object.freeze([
  "plannerCalls",
  "modelCalls",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "actualCostUsd",
  "wallTimeMs",
] as const);

function emptyAdaptiveAccounting(): TransformerAdaptiveAttemptAccounting {
  return Object.freeze({
    plannerCalls: 0,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    actualCostUsd: 0,
    wallTimeMs: 0,
  });
}

function requirePositiveInteger(value: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(code);
  return value;
}

function requirePositiveCost(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error("transformer_pilot_adaptive_budget_cost_invalid");
  }
  return value;
}

function resolveAdaptiveBudgetCeilings(
  input: Partial<TransformerAdaptiveCampaignBudgetCeilings> | undefined,
): TransformerAdaptiveCampaignBudgetCeilings {
  const value = { ...DEFAULT_TRANSFORMER_ADAPTIVE_CAMPAIGN_BUDGET, ...input };
  return Object.freeze({
    maxAttempts: requirePositiveInteger(
      value.maxAttempts,
      HARD_TRANSFORMER_ADAPTIVE_CAMPAIGN_BUDGET.maxAttempts,
      "transformer_pilot_adaptive_budget_attempts_invalid",
    ),
    maxPlannerCalls: requirePositiveInteger(
      value.maxPlannerCalls,
      HARD_TRANSFORMER_ADAPTIVE_CAMPAIGN_BUDGET.maxPlannerCalls,
      "transformer_pilot_adaptive_budget_planner_calls_invalid",
    ),
    maxModelCalls: requirePositiveInteger(
      value.maxModelCalls,
      HARD_TRANSFORMER_ADAPTIVE_CAMPAIGN_BUDGET.maxModelCalls,
      "transformer_pilot_adaptive_budget_model_calls_invalid",
    ),
    maxInputTokens: requirePositiveInteger(
      value.maxInputTokens,
      HARD_TRANSFORMER_ADAPTIVE_CAMPAIGN_BUDGET.maxInputTokens,
      "transformer_pilot_adaptive_budget_input_tokens_invalid",
    ),
    maxOutputTokens: requirePositiveInteger(
      value.maxOutputTokens,
      HARD_TRANSFORMER_ADAPTIVE_CAMPAIGN_BUDGET.maxOutputTokens,
      "transformer_pilot_adaptive_budget_output_tokens_invalid",
    ),
    maxTotalTokens: requirePositiveInteger(
      value.maxTotalTokens,
      HARD_TRANSFORMER_ADAPTIVE_CAMPAIGN_BUDGET.maxTotalTokens,
      "transformer_pilot_adaptive_budget_total_tokens_invalid",
    ),
    maxActualCostUsd: requirePositiveCost(
      value.maxActualCostUsd,
      HARD_TRANSFORMER_ADAPTIVE_CAMPAIGN_BUDGET.maxActualCostUsd,
    ),
    maxWallTimeMs: requirePositiveInteger(
      value.maxWallTimeMs,
      HARD_TRANSFORMER_ADAPTIVE_CAMPAIGN_BUDGET.maxWallTimeMs,
      "transformer_pilot_adaptive_budget_wall_time_invalid",
    ),
  });
}

function requireAdaptiveAccounting(value: unknown): TransformerAdaptiveAttemptAccounting {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("transformer_pilot_adaptive_accounting_missing");
  }
  const raw = value as Record<string, unknown>;
  const integerKeys = ACCOUNTING_KEYS.filter((key) => key !== "actualCostUsd");
  if (
    integerKeys.some((key) => !Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0) ||
    typeof raw.actualCostUsd !== "number" ||
    !Number.isFinite(raw.actualCostUsd) ||
    raw.actualCostUsd < 0 ||
    raw.totalTokens !== (raw.inputTokens as number) + (raw.outputTokens as number) ||
    (raw.modelCalls as number) > (raw.plannerCalls as number)
  ) {
    throw new Error("transformer_pilot_adaptive_accounting_invalid");
  }
  return Object.freeze(Object.fromEntries(
    ACCOUNTING_KEYS.map((key) => [key, raw[key]]),
  ) as unknown as TransformerAdaptiveAttemptAccounting);
}

function requireAdaptiveBudget(state: StoredCampaign): TransformerAdaptiveCampaignBudget {
  const budget = state.adaptiveBudget;
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    throw new Error("transformer_pilot_adaptive_budget_missing");
  }
  const ceilings = resolveAdaptiveBudgetCeilings(budget.ceilings);
  const totalsAccounting = requireAdaptiveAccounting(budget.totals);
  const attempts = budget.totals?.attempts;
  if (!Number.isSafeInteger(attempts) || attempts < 0 || !Array.isArray(budget.overrides)) {
    throw new Error("transformer_pilot_adaptive_budget_invalid");
  }
  return Object.freeze({
    ceilings,
    totals: Object.freeze({ attempts, ...totalsAccounting }),
    overrides: budget.overrides,
  });
}

function activeAdaptiveReservations(state: StoredCampaign): TransformerAdaptiveAttemptAccounting {
  const totals: Mutable<TransformerAdaptiveAttemptAccounting> = {
    plannerCalls: 0,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    actualCostUsd: 0,
    wallTimeMs: 0,
  };
  for (const unit of state.units) {
    for (const reservation of unit.adaptiveModelReservations ?? []) {
      if (reservation.status !== "active") continue;
      totals.plannerCalls += 1;
      totals.modelCalls += 1;
      totals.inputTokens += reservation.maximumInputTokens;
      totals.outputTokens += reservation.maximumOutputTokens;
      totals.totalTokens += reservation.maximumTotalTokens;
      totals.actualCostUsd += reservation.maximumCostUsd;
    }
  }
  return Object.freeze(totals);
}

function adaptiveBudgetRemaining(
  budget: TransformerAdaptiveCampaignBudget,
  state?: StoredCampaign,
): TransformerAdaptiveCampaignBudgetTotals {
  const reserved = state ? activeAdaptiveReservations(state) : emptyAdaptiveAccounting();
  return Object.freeze({
    attempts: Math.max(0, budget.ceilings.maxAttempts - budget.totals.attempts),
    plannerCalls: Math.max(0, budget.ceilings.maxPlannerCalls - budget.totals.plannerCalls - reserved.plannerCalls),
    modelCalls: Math.max(0, budget.ceilings.maxModelCalls - budget.totals.modelCalls - reserved.modelCalls),
    inputTokens: Math.max(0, budget.ceilings.maxInputTokens - budget.totals.inputTokens - reserved.inputTokens),
    outputTokens: Math.max(0, budget.ceilings.maxOutputTokens - budget.totals.outputTokens - reserved.outputTokens),
    totalTokens: Math.max(0, budget.ceilings.maxTotalTokens - budget.totals.totalTokens - reserved.totalTokens),
    actualCostUsd: Math.max(0, budget.ceilings.maxActualCostUsd - budget.totals.actualCostUsd - reserved.actualCostUsd),
    wallTimeMs: Math.max(0, budget.ceilings.maxWallTimeMs - budget.totals.wallTimeMs),
  });
}

function assertBudgetAvailableForAttempt(budget: TransformerAdaptiveCampaignBudget, state?: StoredCampaign): void {
  const remaining = adaptiveBudgetRemaining(budget, state);
  for (const [key, value] of Object.entries(remaining)) {
    if (value <= 0) {
      const code = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      throw new Error(`transformer_pilot_adaptive_budget_${code}_exhausted`);
    }
  }
}

function applyAdaptiveAccounting(
  state: StoredCampaign,
  unit: TransformerPilotUnit,
  value: unknown,
): TransformerPilotUnit {
  const budget = requireAdaptiveBudget(state);
  const current = requireAdaptiveAccounting(unit.adaptiveAccounting);
  const next = requireAdaptiveAccounting(value);
  if (ACCOUNTING_KEYS.some((key) => next[key] < current[key])) {
    throw new Error("transformer_pilot_adaptive_accounting_regressed");
  }
  const totals: Mutable<TransformerAdaptiveCampaignBudgetTotals> = {
    ...budget.totals,
  };
  for (const key of ACCOUNTING_KEYS) {
    totals[key] += next[key] - current[key];
  }
  const checks: Array<[number, number, string]> = [
    [totals.plannerCalls, budget.ceilings.maxPlannerCalls, "planner_calls"],
    [totals.modelCalls, budget.ceilings.maxModelCalls, "model_calls"],
    [totals.inputTokens, budget.ceilings.maxInputTokens, "input_tokens"],
    [totals.outputTokens, budget.ceilings.maxOutputTokens, "output_tokens"],
    [totals.totalTokens, budget.ceilings.maxTotalTokens, "total_tokens"],
    [totals.actualCostUsd, budget.ceilings.maxActualCostUsd, "actual_cost_usd"],
    [totals.wallTimeMs, budget.ceilings.maxWallTimeMs, "wall_time_ms"],
  ];
  const exceeded = checks.find(([actual, maximum]) => actual > maximum);
  if (exceeded) {
    throw new Error(`transformer_pilot_adaptive_budget_${exceeded[2]}_exceeded`);
  }
  state.adaptiveBudget = {
    ...budget,
    totals: Object.freeze(totals),
  };
  return { ...unit, adaptiveAccounting: next };
}

function conservativelySettleActiveModelReservations(
  state: StoredCampaign,
  unit: TransformerPilotUnit,
  observedAt: string,
): TransformerPilotUnit {
  let accounted = unit;
  const records = [...(unit.adaptiveModelReservations ?? [])];
  for (let index = 0; index < records.length; index += 1) {
    const reservation = records[index]!;
    if (reservation.status !== "active") continue;
    const next: TransformerAdaptiveAttemptAccounting = Object.freeze({
      ...accounted.adaptiveAccounting,
      plannerCalls: accounted.adaptiveAccounting.plannerCalls + 1,
      modelCalls: accounted.adaptiveAccounting.modelCalls + 1,
      inputTokens: accounted.adaptiveAccounting.inputTokens + reservation.maximumInputTokens,
      outputTokens: accounted.adaptiveAccounting.outputTokens + reservation.maximumOutputTokens,
      totalTokens: accounted.adaptiveAccounting.totalTokens + reservation.maximumTotalTokens,
      actualCostUsd: accounted.adaptiveAccounting.actualCostUsd + reservation.maximumCostUsd,
    });
    accounted = applyAdaptiveAccounting(state, accounted, next);
    records[index] = Object.freeze({
      ...reservation,
      status: "unknown" as const,
      settledAt: observedAt,
      chargedInputTokens: reservation.maximumInputTokens,
      chargedOutputTokens: reservation.maximumOutputTokens,
      chargedTotalTokens: reservation.maximumTotalTokens,
      chargedCostUsd: reservation.maximumCostUsd,
      errorCode: "transformer_adaptive_model_outcome_unknown_after_lease_expiry",
    });
  }
  return { ...accounted, adaptiveModelReservations: Object.freeze(records) };
}

function waves(units: readonly TransformerPilotUnitInput[]): Map<string, number> {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  if (byId.size !== units.length) throw new Error("transformer_pilot_unit_duplicate");
  for (const unit of units) {
    for (const dependency of unit.dependsOn) {
      if (!byId.has(dependency) || dependency === unit.id) throw new Error("transformer_pilot_dependency_invalid");
    }
  }
  const result = new Map<string, number>();
  const remaining = new Set(byId.keys());
  while (remaining.size) {
    const ready = [...remaining].filter((id) => byId.get(id)!.dependsOn.every((dependency) => result.has(dependency))).sort();
    if (!ready.length) throw new Error("transformer_pilot_dependency_cycle");
    for (const id of ready) {
      result.set(id, Math.max(1, ...byId.get(id)!.dependsOn.map((dependency) => result.get(dependency)! + 1)));
      remaining.delete(id);
    }
  }
  return result;
}

function unitById(state: { units: readonly TransformerPilotUnit[] }, unitId: string): TransformerPilotUnit {
  const unit = state.units.find((candidate) => candidate.id === unitId);
  if (!unit) throw new Error("transformer_pilot_unit_not_found");
  return unit;
}

function requireLeaseDuration(value: number | undefined): number {
  const duration = value ?? DEFAULT_LEASE_DURATION_MS;
  if (
    !Number.isSafeInteger(duration) ||
    duration < MIN_LEASE_DURATION_MS ||
    duration > MAX_LEASE_DURATION_MS
  ) {
    throw new Error("transformer_pilot_lease_duration_invalid");
  }
  return duration;
}

function attemptEligible(
  state: { units: readonly TransformerPilotUnit[] },
  unit: TransformerPilotUnit,
): boolean {
  return (
    (unit.state === "pending" || (unit.state === "failed" && unit.retryAuthorized)) &&
    unit.dependsOn.every((dependency) => unitById(state, dependency).state === "merged")
  );
}

function assertAttemptFence(
  state: StoredCampaign,
  input: Readonly<{
    unitId: string;
    leaseGeneration: number;
    leaseToken: string;
    observedAt: string;
  }>,
): void {
  if (state.state !== "running") {
    throw new Error("transformer_pilot_campaign_not_running");
  }
  const unit = unitById(state, input.unitId);
  if (unit.state !== "running") {
    throw new Error("transformer_pilot_attempt_not_running");
  }
  if (
    !Number.isSafeInteger(input.leaseGeneration) ||
    input.leaseGeneration < 1 ||
    typeof input.leaseToken !== "string" ||
    input.leaseToken.length < 24 ||
    unit.leaseGeneration !== input.leaseGeneration ||
    unit.leaseTokenDigest !== leaseTokenDigest(input.leaseToken)
  ) {
    throw new Error("transformer_pilot_fence_stale");
  }
  const observedAt = Date.parse(requireTimestamp(input.observedAt));
  const leaseExpiresAt = Date.parse(unit.leaseExpiresAt ?? "");
  if (!Number.isFinite(leaseExpiresAt) || observedAt >= leaseExpiresAt) {
    throw new Error("transformer_pilot_fence_expired");
  }
}

function requireAttemptFailureCode(value: string): TransformerAttemptFailureCode {
  if (!TRANSFORMER_ATTEMPT_FAILURE_CODES.has(value as TransformerAttemptFailureCode)) {
    throw new Error("transformer_pilot_failure_code_invalid");
  }
  return value as TransformerAttemptFailureCode;
}

function replaceUnit(state: StoredCampaign, next: TransformerPilotUnit): void {
  state.units = state.units.map((unit) => unit.id === next.id ? next : unit);
}

function openedException(
  state: StoredCampaign,
  code: TransformerPilotExceptionCode,
  observedAt: string,
  evidenceRefs: readonly string[],
  unit?: TransformerPilotUnit,
): TransformerPilotException {
  const id = `exception-${String(state.exceptions.length + 1).padStart(4, "0")}`;
  return {
    id,
    code,
    unitId: unit?.id,
    ownerId: unit?.ownerId ?? "campaign-owner",
    dueAction: code === "worker_crash" ? "Authorize a fenced retry" : "Resolve the evidence conflict and resume",
    state: "open",
    openedAt: observedAt,
    evidenceRefs: requireEvidence(evidenceRefs),
  };
}

export class TransformerPilotExecutionStore {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tf_pilot_campaigns (
        tenant_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, campaign_id)
      );
      CREATE TABLE IF NOT EXISTS tf_pilot_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        campaign_revision INTEGER NOT NULL,
        type TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tf_pilot_idempotency (
        tenant_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        result_revision INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS tf_pilot_claim_results (
        tenant_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        lease_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, idempotency_key)
      );
      CREATE TRIGGER IF NOT EXISTS tf_pilot_events_no_update BEFORE UPDATE ON tf_pilot_events
      BEGIN SELECT RAISE(ABORT, 'transformer_pilot_events_append_only'); END;
      CREATE TRIGGER IF NOT EXISTS tf_pilot_events_no_delete BEFORE DELETE ON tf_pilot_events
      BEGIN SELECT RAISE(ABORT, 'transformer_pilot_events_append_only'); END;
      CREATE TRIGGER IF NOT EXISTS tf_pilot_idempotency_no_update BEFORE UPDATE ON tf_pilot_idempotency
      BEGIN SELECT RAISE(ABORT, 'transformer_pilot_idempotency_append_only'); END;
      CREATE TRIGGER IF NOT EXISTS tf_pilot_idempotency_no_delete BEFORE DELETE ON tf_pilot_idempotency
      BEGIN SELECT RAISE(ABORT, 'transformer_pilot_idempotency_append_only'); END;
      CREATE TRIGGER IF NOT EXISTS tf_pilot_claim_results_no_update BEFORE UPDATE ON tf_pilot_claim_results
      BEGIN SELECT RAISE(ABORT, 'transformer_pilot_claim_results_append_only'); END;
      CREATE TRIGGER IF NOT EXISTS tf_pilot_claim_results_no_delete BEFORE DELETE ON tf_pilot_claim_results
      BEGIN SELECT RAISE(ABORT, 'transformer_pilot_claim_results_append_only'); END;
    `);
  }

  close(): void {
    this.db.close();
  }

  getCampaign(tenantId: string, campaignId: string): TransformerPilotCampaign | undefined {
    const row = this.db.prepare(
      "SELECT body_json FROM tf_pilot_campaigns WHERE tenant_id = ? AND campaign_id = ?",
    ).get(requireId(tenantId, "transformer_pilot_tenant_invalid"), requireId(campaignId, "transformer_pilot_campaign_invalid")) as { body_json: string } | undefined;
    return row ? deepFreeze(JSON.parse(row.body_json) as TransformerPilotCampaign) : undefined;
  }

  listEvents(tenantId: string, campaignId: string): TransformerPilotEvent[] {
    const rows = this.db.prepare(
      "SELECT * FROM tf_pilot_events WHERE tenant_id = ? AND campaign_id = ? ORDER BY sequence",
    ).all(tenantId, campaignId) as Array<Record<string, unknown>>;
    return rows.map((row) => deepFreeze({
      sequence: row.sequence as number,
      tenantId: row.tenant_id as string,
      campaignId: row.campaign_id as string,
      campaignRevision: row.campaign_revision as number,
      type: row.type as string,
      observedAt: row.observed_at as string,
      evidenceRefs: JSON.parse(row.evidence_refs_json as string) as string[],
      payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
    }));
  }

  listRunnableCampaigns(
    tenantId?: string,
    limit = 25,
    gateConfig?: string,
  ): TransformerRunnableCampaign[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("transformer_pilot_campaign_limit_invalid");
    }
    const rows = tenantId === undefined
      ? this.db.prepare("SELECT body_json FROM tf_pilot_campaigns").all()
      : this.db.prepare(
        "SELECT body_json FROM tf_pilot_campaigns WHERE tenant_id = ?",
      ).all(requireId(tenantId, "transformer_pilot_tenant_invalid"));
    const runnable = (rows as Array<{ body_json: string }>)
      .map((row) => JSON.parse(row.body_json) as TransformerPilotCampaign)
      .filter((campaign) =>
        campaign.state === "running" &&
        !campaign.units.some((unit) => unit.state === "running") &&
        campaign.units.some((unit) => attemptEligible(campaign, unit)) &&
        (gateConfig === undefined || authorizeTransformerWorkerAction({
          tenantId: campaign.tenantId,
          environment: campaign.environment,
        }, gateConfig).allowed)
      )
      .sort((left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.tenantId.localeCompare(right.tenantId) ||
        left.campaignId.localeCompare(right.campaignId)
      )
      .slice(0, limit)
      .map((campaign) => {
        const unit = campaign.units
          .filter((candidate) => attemptEligible(campaign, candidate))
          .sort((left, right) => left.wave - right.wave || left.id.localeCompare(right.id))[0]!;
        return {
          tenantId: campaign.tenantId,
          campaignId: campaign.campaignId,
          environment: campaign.environment,
          repositoryId: unit.snapshot.repositoryId,
          taskSnapshotId: unit.snapshot.snapshotId,
          expectedBaseRevision: unit.snapshot.revision,
          sourceArtifactIds: Object.freeze([
            unit.snapshot.snapshotId,
            `revision:${unit.snapshot.revision}`,
            `manifest:${unit.snapshot.manifestSha256}`,
            unit.snapshot.digest,
          ]),
        };
      });
    return deepFreeze(runnable);
  }

  listAdaptiveCandidateHandoffs(
    tenantId?: string,
    limit = 25,
    gateConfig?: string,
  ): TransformerPendingAdaptiveCandidateHandoff[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("transformer_pilot_campaign_limit_invalid");
    }
    const rows = tenantId === undefined
      ? this.db.prepare("SELECT body_json FROM tf_pilot_campaigns").all()
      : this.db.prepare(
        "SELECT body_json FROM tf_pilot_campaigns WHERE tenant_id = ?",
      ).all(requireId(tenantId, "transformer_pilot_tenant_invalid"));
    return (rows as Array<{ body_json: string }>)
      .map((row) => JSON.parse(row.body_json) as TransformerPilotCampaign)
      .filter((campaign) =>
        gateConfig === undefined || authorizeTransformerWorkerAction({
          tenantId: campaign.tenantId,
          environment: campaign.environment,
        }, gateConfig).allowed
      )
      .flatMap((campaign) => campaign.units
        .filter((unit) =>
          unit.adaptiveCandidateHandoff !== undefined &&
          unit.adaptiveCandidateHandoff.importedAt === undefined
        )
        .map((unit) => ({
          tenantId: campaign.tenantId,
          campaignId: campaign.campaignId,
          unitId: unit.id,
          environment: campaign.environment,
          handoff: unit.adaptiveCandidateHandoff!,
        })))
      .sort((left, right) =>
        left.handoff.observedAt.localeCompare(right.handoff.observedAt) ||
        left.tenantId.localeCompare(right.tenantId) ||
        left.campaignId.localeCompare(right.campaignId) ||
        left.unitId.localeCompare(right.unitId)
      )
      .slice(0, limit)
      .map((value) => deepFreeze(value));
  }

  listPendingRoutingSettlements(
    tenantId?: string,
    limit = 25,
  ): TransformerPendingRoutingSettlement[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("transformer_pilot_routing_settlement_limit_invalid");
    }
    const rows = tenantId === undefined
      ? this.db.prepare("SELECT body_json FROM tf_pilot_campaigns").all()
      : this.db.prepare(
        "SELECT body_json FROM tf_pilot_campaigns WHERE tenant_id = ?",
      ).all(requireId(tenantId, "transformer_pilot_tenant_invalid"));
    const pending = (rows as Array<{ body_json: string }>)
      .map((row) => JSON.parse(row.body_json) as TransformerPilotCampaign)
      .flatMap((campaign) => campaign.units.flatMap((unit) => {
        const routing = unit.routingSettlement;
        if (!routing?.outcome || routing.settledAt) return [];
        return [{
          tenantId: campaign.tenantId,
          campaignId: campaign.campaignId,
          unitId: unit.id,
          runId: routing.runId,
          envelopeId: routing.envelopeId,
          outcome: routing.outcome,
        }];
      }))
      .sort((left, right) =>
        left.outcome.completedAt.localeCompare(right.outcome.completedAt) ||
        left.tenantId.localeCompare(right.tenantId) ||
        left.campaignId.localeCompare(right.campaignId) ||
        left.unitId.localeCompare(right.unitId)
      )
      .slice(0, limit);
    return deepFreeze(pending);
  }

  listExpiredAttempts(
    observedAt: string,
    tenantId?: string,
    limit = 25,
    gateConfig?: string,
  ): TransformerExpiredAttempt[] {
    const observedAtMs = Date.parse(requireTimestamp(observedAt));
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("transformer_pilot_attempt_limit_invalid");
    }
    const rows = tenantId === undefined
      ? this.db.prepare("SELECT body_json FROM tf_pilot_campaigns").all()
      : this.db.prepare(
        "SELECT body_json FROM tf_pilot_campaigns WHERE tenant_id = ?",
      ).all(requireId(tenantId, "transformer_pilot_tenant_invalid"));
    const expired = (rows as Array<{ body_json: string }>)
      .map((row) => JSON.parse(row.body_json) as TransformerPilotCampaign)
      .filter((campaign) =>
        campaign.state === "running" &&
        (gateConfig === undefined || authorizeTransformerWorkerAction({
          tenantId: campaign.tenantId,
          environment: campaign.environment,
        }, gateConfig).allowed)
      )
      .flatMap((campaign) => campaign.units
        .filter((unit) => {
          const expiresAt = Date.parse(unit.leaseExpiresAt ?? "");
          return unit.state === "running" &&
            (!Number.isFinite(expiresAt) || observedAtMs >= expiresAt);
        })
        .map((unit) => ({ campaign, unit })))
      .sort((left, right) =>
        String(left.unit.leaseExpiresAt ?? "").localeCompare(
          String(right.unit.leaseExpiresAt ?? ""),
        ) ||
        left.campaign.tenantId.localeCompare(right.campaign.tenantId) ||
        left.campaign.campaignId.localeCompare(right.campaign.campaignId) ||
        left.unit.id.localeCompare(right.unit.id)
      )
      .slice(0, limit)
      .map(({ campaign, unit }) => ({
        tenantId: campaign.tenantId,
        campaignId: campaign.campaignId,
        unitId: unit.id,
        leaseGeneration: unit.leaseGeneration,
        environment: campaign.environment,
      }));
    return deepFreeze(expired);
  }

  createCampaign(input: TransformerPilotCampaignInput): TransformerPilotCampaign {
    requireId(input.tenantId, "transformer_pilot_tenant_invalid");
    requireId(input.organizationId, "transformer_pilot_organization_invalid");
    requireId(input.environment, "transformer_pilot_environment_invalid");
    requireId(input.campaignId, "transformer_pilot_campaign_invalid");
    requireId(input.idempotencyKey, "transformer_pilot_idempotency_invalid");
    requireTimestamp(input.observedAt);
    const evidenceRefs = requireEvidence(input.evidenceRefs);
    if (!Array.isArray(input.units) || input.units.length === 0 || input.units.length > 500) {
      throw new Error("transformer_pilot_units_invalid");
    }
    if (input.constraints.tenantId !== input.tenantId || input.constraints.organizationId !== input.organizationId) {
      throw new Error("transformer_pilot_constraint_scope_mismatch");
    }
    const gate = authorizeTransformerWorkerAction({ tenantId: input.tenantId, environment: input.environment }, input.gateConfig);
    if (!gate.allowed) throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
    const adaptiveBudgetCeilings = resolveAdaptiveBudgetCeilings(input.adaptiveBudget);
    const waveById = waves(input.units);
    const units = input.units.map((candidate): TransformerPilotUnit => {
      requireId(candidate.id, "transformer_pilot_unit_invalid");
      requireId(candidate.ownerId, "transformer_pilot_owner_invalid");
      requireEvidence(candidate.reviewerIds, "transformer_pilot_reviewers_required");
      requireId(candidate.snapshot.snapshotId, "transformer_pilot_snapshot_invalid");
      requireRevision(candidate.snapshot.revision, "transformer_pilot_source_revision_invalid");
      if (!MANIFEST_SHA256.test(candidate.snapshot.manifestSha256)) {
        throw new Error("transformer_pilot_snapshot_manifest_invalid");
      }
      requireRevision(candidate.candidateRevision, "transformer_pilot_candidate_revision_invalid");
      requireDigest(candidate.snapshot.digest, "transformer_pilot_source_digest_invalid");
      requireDigest(candidate.candidateDigest, "transformer_pilot_candidate_digest_invalid");
      requireEvidence(candidate.snapshot.evidenceRefs, "transformer_pilot_snapshot_evidence_required");
      if (!candidate.changedPaths.length) throw new Error("transformer_pilot_changed_paths_required");
      const decisions = candidate.changedPaths.map((path: string) => assessOrganizationConstraint(input.constraints, {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        repositoryId: candidate.snapshot.repositoryId,
        path,
        action: "change",
      }));
      const denied = decisions.filter((decision: ReturnType<typeof assessOrganizationConstraint>) => !decision.allowed);
      if (denied.length) throw new Error(`transformer_pilot_constraint_denied:${candidate.id}:${denied.flatMap((decision: ReturnType<typeof assessOrganizationConstraint>) => decision.reasons).join(",")}`);
      return {
        ...clone(candidate),
        wave: waveById.get(candidate.id)!,
        state: "pending",
        attemptNumber: 0,
        leaseGeneration: 0,
        retryAuthorized: false,
        executionEvidenceRefs: [],
        scmEvidenceRefs: [],
        adaptiveAccounting: emptyAdaptiveAccounting(),
      };
    });
    const state: StoredCampaign = {
      schemaVersion: TRANSFORMER_PILOT_EXECUTION_SCHEMA_VERSION,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      environment: input.environment,
      campaignId: input.campaignId,
      revision: 1,
      state: "running",
      constraintVersion: input.constraints.version,
      constraintDigest: input.constraints.digest,
      gateEvidenceRefs: [...gate.acceptanceEvidenceRefs],
      units,
      exceptions: [],
      adaptiveBudget: {
        ceilings: adaptiveBudgetCeilings,
        totals: { attempts: 0, ...emptyAdaptiveAccounting() },
        overrides: [],
      },
      createdAt: input.observedAt,
      updatedAt: input.observedAt,
    };
    const requestDigest = sha256(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.idempotentReplay(input.tenantId, input.idempotencyKey, "campaign.created", requestDigest, input.campaignId);
      if (replay) {
        this.db.exec("COMMIT");
        return replay;
      }
      if (this.getCampaign(input.tenantId, input.campaignId)) throw new Error("transformer_pilot_campaign_exists");
      this.db.prepare("INSERT INTO tf_pilot_campaigns VALUES (?, ?, ?, ?)")
        .run(input.tenantId, input.campaignId, 1, JSON.stringify(state));
      this.insertEvent(state, "campaign.created", input.observedAt, evidenceRefs, {
        constraintDigest: state.constraintDigest,
        unitCount: units.length,
        adaptiveBudgetCeilings,
      });
      this.insertIdempotency(input.tenantId, input.idempotencyKey, "campaign.created", requestDigest, input.campaignId, 1);
      this.db.exec("COMMIT");
      return deepFreeze(clone(state));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  bindRoutingAttempt(
    input: TransformerRoutingAttemptBindingInput,
  ): TransformerPilotCampaign {
    requireId(input.runId, "transformer_pilot_routing_run_invalid");
    requireId(input.envelopeId, "transformer_pilot_routing_envelope_invalid");
    requireId(
      input.outcomeIdempotencyKey,
      "transformer_pilot_routing_outcome_idempotency_invalid",
    );
    requireId(input.executorId, "transformer_pilot_routing_executor_invalid");
    requireId(input.providerId, "transformer_pilot_routing_provider_invalid");
    const campaign = this.mustGet(input.tenantId, input.campaignId);
    const gate = authorizeTransformerWorkerAction(
      { tenantId: input.tenantId, environment: campaign.environment },
      input.gateConfig,
    );
    if (!gate.allowed) {
      throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
    }
    const record: TransformerRoutingSettlementRecord = Object.freeze({
      runId: input.runId,
      envelopeId: input.envelopeId,
      outcomeIdempotencyKey: input.outcomeIdempotencyKey,
      executorId: input.executorId,
      providerId: input.providerId,
      boundAt: input.observedAt,
      evidenceRefs: requireEvidence(input.evidenceRefs),
    });
    return this.mutate(input, "routing.attempt_bound", record, (state) => {
      if (state.state !== "running" || state.units.some((unit) => unit.state === "running")) {
        throw new Error("transformer_pilot_routing_attempt_not_bindable");
      }
      const eligible = state.units
        .filter((unit) => attemptEligible(state, unit))
        .sort((left, right) => left.wave - right.wave || left.id.localeCompare(right.id))[0];
      if (!eligible) throw new Error("transformer_pilot_routing_attempt_not_bindable");
      if (eligible.routingSettlement && !eligible.routingSettlement.settledAt) {
        throw new Error("transformer_pilot_routing_settlement_pending");
      }
      replaceUnit(state, { ...eligible, routingSettlement: record });
    });
  }

  claimNextAttempt(input: MutationInput & {
    leaseToken: string;
    leaseDurationMs?: number;
    gateConfig?: string;
  }): TransformerAttemptLease | null {
    if (!input.leaseToken || input.leaseToken.length < 24) throw new Error("transformer_pilot_lease_token_invalid");
    const observedAt = requireTimestamp(input.observedAt);
    const evidenceRefs = requireEvidence(input.evidenceRefs);
    requireId(input.idempotencyKey, "transformer_pilot_idempotency_invalid");
    const leaseDurationMs = requireLeaseDuration(input.leaseDurationMs);
    const leaseExpiresAt = new Date(Date.parse(observedAt) + leaseDurationMs).toISOString();
    const tokenDigest = leaseTokenDigest(input.leaseToken);
    const request = {
      leaseTokenDigest: tokenDigest,
      leaseDurationMs,
      leaseExpiresAt,
    };
    const requestDigest = sha256(request);
    const leaseFrom = (
      state: StoredCampaign,
      unit: TransformerPilotUnit,
    ): TransformerAttemptLease => {
      const budget = requireAdaptiveBudget(state);
      return deepFreeze({
        type: "execute_recipe",
        tenantId: state.tenantId,
        campaignId: state.campaignId,
        unitId: unit.id,
        attemptNumber: unit.attemptNumber,
        leaseGeneration: unit.leaseGeneration,
        leaseTokenDigest: unit.leaseTokenDigest!,
        leaseExpiresAt: unit.leaseExpiresAt!,
        startedAt: unit.startedAt!,
        snapshot: unit.snapshot,
        candidateRevision: unit.candidateRevision,
        candidateDigest: unit.candidateDigest,
        changedPaths: unit.changedPaths,
        recipe: unit.recipe,
        constraintVersion: state.constraintVersion,
        constraintDigest: state.constraintDigest,
        gateEvidenceRefs: state.gateEvidenceRefs,
        adaptiveBudgetRemaining: adaptiveBudgetRemaining(budget, state),
        ...(unit.regenerationReview ? { regenerationReview: unit.regenerationReview } : {}),
      });
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.idempotentReplay(
        input.tenantId,
        input.idempotencyKey,
        "attempt.claimed",
        requestDigest,
        input.campaignId,
      );
      if (replay) {
        const row = this.db.prepare(
          "SELECT lease_json FROM tf_pilot_claim_results WHERE tenant_id = ? AND idempotency_key = ?",
        ).get(input.tenantId, input.idempotencyKey) as { lease_json: string } | undefined;
        if (!row) {
          const replayState = clone(replay) as StoredCampaign;
          const replayUnit = replayState.units.find(
            (unit) =>
              unit.state === "running" &&
              unit.leaseTokenDigest === tokenDigest &&
              unit.startedAt === observedAt,
          );
          if (!replayUnit) throw new Error("transformer_pilot_claim_replay_invalid");
          this.db.exec("COMMIT");
          return leaseFrom(replayState, replayUnit);
        }
        const claimedLease = JSON.parse(row.lease_json) as TransformerAttemptLease;
        if (
          claimedLease.tenantId !== input.tenantId ||
          claimedLease.campaignId !== input.campaignId ||
          claimedLease.leaseTokenDigest !== tokenDigest
        ) {
          throw new Error("transformer_pilot_claim_replay_invalid");
        }
        this.db.exec("COMMIT");
        return deepFreeze(claimedLease);
      }
      const state = this.mustGet(input.tenantId, input.campaignId);
      const gate = authorizeTransformerWorkerAction(
        { tenantId: input.tenantId, environment: state.environment },
        input.gateConfig,
      );
      if (!gate.allowed) throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
      if (state.state !== "running" || state.units.some((unit) => unit.state === "running")) {
        this.db.exec("COMMIT");
        return null;
      }
      const eligible = state.units
        .filter((unit) => attemptEligible(state, unit))
        .sort((left, right) => left.wave - right.wave || left.id.localeCompare(right.id))[0];
      if (!eligible) {
        this.db.exec("COMMIT");
        return null;
      }
      const budget = requireAdaptiveBudget(state);
      assertBudgetAvailableForAttempt(budget, state);
      state.adaptiveBudget = {
        ...budget,
        totals: {
          ...budget.totals,
          attempts: budget.totals.attempts + 1,
        },
      };
      const updated: TransformerPilotUnit = {
        ...eligible,
        state: "running",
        attemptNumber: eligible.attemptNumber + 1,
        leaseGeneration: eligible.leaseGeneration + 1,
        leaseTokenDigest: tokenDigest,
        leaseExpiresAt,
        retryAuthorized: false,
        startedAt: observedAt,
        adaptiveAccounting: emptyAdaptiveAccounting(),
        ...(eligible.routingSettlement
          ? {
              routingSettlement: Object.freeze({
                ...eligible.routingSettlement,
                attemptNumber: eligible.attemptNumber + 1,
                leaseGeneration: eligible.leaseGeneration + 1,
                leaseTokenDigest: tokenDigest,
              }),
            }
          : {}),
      };
      replaceUnit(state, updated);
      state.revision += 1;
      state.updatedAt = observedAt;
      this.db.prepare("UPDATE tf_pilot_campaigns SET revision = ?, body_json = ? WHERE tenant_id = ? AND campaign_id = ?")
        .run(state.revision, JSON.stringify(state), state.tenantId, state.campaignId);
      this.insertEvent(state, "attempt.claimed", observedAt, evidenceRefs, {
        ...request,
        unitId: updated.id,
        adaptiveBudgetRemaining: adaptiveBudgetRemaining(requireAdaptiveBudget(state), state),
      });
      this.insertIdempotency(
        state.tenantId,
        input.idempotencyKey,
        "attempt.claimed",
        requestDigest,
        state.campaignId,
        state.revision,
      );
      const claimedLease = leaseFrom(state, updated);
      this.db.prepare("INSERT INTO tf_pilot_claim_results VALUES (?, ?, ?)")
        .run(state.tenantId, input.idempotencyKey, JSON.stringify(claimedLease));
      this.db.exec("COMMIT");
      return claimedLease;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  assertCurrentAttemptFence(input: Readonly<{
    tenantId: string;
    campaignId: string;
    unitId: string;
    leaseGeneration: number;
    leaseToken: string;
    observedAt: string;
  }>): void {
    const state = this.mustGet(input.tenantId, input.campaignId);
    assertAttemptFence(state, input);
  }

  recordAdaptiveAttemptUsage(input: MutationInput & {
    unitId: string;
    leaseGeneration: number;
    leaseToken: string;
    accounting: TransformerAdaptiveAttemptAccounting;
    gateConfig?: string;
  }): TransformerPilotCampaign {
    const campaign = this.mustGet(input.tenantId, input.campaignId);
    const gate = authorizeTransformerWorkerAction(
      { tenantId: input.tenantId, environment: campaign.environment },
      input.gateConfig,
    );
    if (!gate.allowed) {
      throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
    }
    return this.mutate(
      input,
      "attempt.adaptive_usage_recorded",
      {
        unitId: input.unitId,
        leaseGeneration: input.leaseGeneration,
        leaseTokenDigest: leaseTokenDigest(input.leaseToken),
        accounting: input.accounting,
      },
      (state) => {
        assertAttemptFence(state, input);
        const unit = unitById(state, input.unitId);
        replaceUnit(state, applyAdaptiveAccounting(state, unit, input.accounting));
      },
    );
  }

  reserveAdaptiveModelCall(input: MutationInput & {
    unitId: string;
    leaseGeneration: number;
    leaseToken: string;
    reservation: AdaptiveExternalModelReservation;
    gateConfig?: string;
  }): TransformerAdaptiveAttemptAccounting {
    const reservation = input.reservation;
    requireId(reservation.reservationId, "transformer_pilot_model_reservation_id_invalid");
    requireDigest(reservation.requestDigest, "transformer_pilot_model_reservation_digest_invalid");
    for (const value of [
      reservation.provider,
      reservation.configuredModel,
      reservation.deployment,
      reservation.executionRegion,
      reservation.endpointHost,
    ]) {
      if (typeof value !== "string" || !value.trim() || value.length > 500) {
        throw new Error("transformer_pilot_model_reservation_provenance_invalid");
      }
    }
    const integerBounds = [
      reservation.maximumInputTokens,
      reservation.maximumOutputTokens,
      reservation.maximumTotalTokens,
    ];
    if (
      integerBounds.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      reservation.maximumTotalTokens !==
        reservation.maximumInputTokens + reservation.maximumOutputTokens ||
      !Number.isFinite(reservation.maximumCostUsd) || reservation.maximumCostUsd < 0
    ) {
      throw new Error("transformer_pilot_model_reservation_bound_invalid");
    }
    const campaign = this.mustGet(input.tenantId, input.campaignId);
    const gate = authorizeTransformerWorkerAction(
      { tenantId: input.tenantId, environment: campaign.environment },
      input.gateConfig,
    );
    if (!gate.allowed) throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
    const updated = this.mutate(
      input,
      "attempt.adaptive_model_reserved",
      {
        unitId: input.unitId,
        leaseGeneration: input.leaseGeneration,
        leaseTokenDigest: leaseTokenDigest(input.leaseToken),
        reservation,
      },
      (state) => {
        assertAttemptFence(state, input);
        const unit = unitById(state, input.unitId);
        const records = [...(unit.adaptiveModelReservations ?? [])];
        if (records.length >= 500) throw new Error("transformer_pilot_model_reservation_limit");
        if (records.some((record) => record.reservationId === reservation.reservationId)) {
          throw new Error("transformer_pilot_model_reservation_conflict");
        }
        const remaining = adaptiveBudgetRemaining(requireAdaptiveBudget(state), state);
        const checks: Array<[number, number, string]> = [
          [1, remaining.plannerCalls, "planner_calls"],
          [1, remaining.modelCalls, "model_calls"],
          [reservation.maximumInputTokens, remaining.inputTokens, "input_tokens"],
          [reservation.maximumOutputTokens, remaining.outputTokens, "output_tokens"],
          [reservation.maximumTotalTokens, remaining.totalTokens, "total_tokens"],
          [reservation.maximumCostUsd, remaining.actualCostUsd, "actual_cost_usd"],
        ];
        const exceeded = checks.find(([requested, available]) => requested > available);
        if (exceeded) {
          throw new Error(`transformer_pilot_adaptive_budget_${exceeded[2]}_exhausted`);
        }
        records.push(Object.freeze({
          ...reservation,
          attemptNumber: unit.attemptNumber,
          leaseGeneration: unit.leaseGeneration,
          leaseTokenDigest: leaseTokenDigest(input.leaseToken),
          reservedAt: input.observedAt,
          status: "active" as const,
        }));
        replaceUnit(state, { ...unit, adaptiveModelReservations: Object.freeze(records) });
      },
    );
    return requireAdaptiveAccounting(unitById(updated as StoredCampaign, input.unitId).adaptiveAccounting);
  }

  settleAdaptiveModelCall(input: MutationInput & {
    unitId: string;
    leaseGeneration: number;
    leaseToken: string;
    settlement: AdaptiveExternalModelSettlement;
    gateConfig?: string;
  }): TransformerAdaptiveAttemptAccounting {
    requireId(input.settlement.reservationId, "transformer_pilot_model_reservation_id_invalid");
    const campaign = this.mustGet(input.tenantId, input.campaignId);
    const gate = authorizeTransformerWorkerAction(
      { tenantId: input.tenantId, environment: campaign.environment },
      input.gateConfig,
    );
    if (!gate.allowed) throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
    const updated = this.mutate(
      input,
      "attempt.adaptive_model_settled",
      {
        unitId: input.unitId,
        leaseGeneration: input.leaseGeneration,
        leaseTokenDigest: leaseTokenDigest(input.leaseToken),
        settlement: input.settlement,
      },
      (state) => {
        assertAttemptFence(state, input);
        const unit = unitById(state, input.unitId);
        const records = [...(unit.adaptiveModelReservations ?? [])];
        const index = records.findIndex((record) => record.reservationId === input.settlement.reservationId);
        if (index < 0 || records[index]!.status !== "active") {
          throw new Error("transformer_pilot_model_reservation_not_active");
        }
        const reservation = records[index]!;
        const reportedInput = input.settlement.inputTokens;
        const reportedOutput = input.settlement.outputTokens;
        const reportedTotal = input.settlement.totalTokens;
        const reportedCost = input.settlement.costUsd;
        const completeMeasured =
          Number.isSafeInteger(reportedInput) && reportedInput! >= 0 &&
          Number.isSafeInteger(reportedOutput) && reportedOutput! >= 0 &&
          Number.isSafeInteger(reportedTotal) && reportedTotal === reportedInput! + reportedOutput! &&
          typeof reportedCost === "number" && Number.isFinite(reportedCost) && reportedCost >= 0;
        const withinReservation = completeMeasured &&
          reportedInput! <= reservation.maximumInputTokens &&
          reportedOutput! <= reservation.maximumOutputTokens &&
          reportedTotal! <= reservation.maximumTotalTokens &&
          reportedCost! <= reservation.maximumCostUsd;
        const exact = input.settlement.status === "succeeded" && withinReservation;
        const chargedInputTokens = exact ? reportedInput! : reservation.maximumInputTokens;
        const chargedOutputTokens = exact ? reportedOutput! : reservation.maximumOutputTokens;
        const chargedTotalTokens = exact ? reportedTotal! : reservation.maximumTotalTokens;
        const chargedCostUsd = exact ? reportedCost! : reservation.maximumCostUsd;
        const nextAccounting: TransformerAdaptiveAttemptAccounting = Object.freeze({
          ...unit.adaptiveAccounting,
          plannerCalls: unit.adaptiveAccounting.plannerCalls + 1,
          modelCalls: unit.adaptiveAccounting.modelCalls + 1,
          inputTokens: unit.adaptiveAccounting.inputTokens + chargedInputTokens,
          outputTokens: unit.adaptiveAccounting.outputTokens + chargedOutputTokens,
          totalTokens: unit.adaptiveAccounting.totalTokens + chargedTotalTokens,
          actualCostUsd: unit.adaptiveAccounting.actualCostUsd + chargedCostUsd,
        });
        const accounted = applyAdaptiveAccounting(state, unit, nextAccounting);
        records[index] = Object.freeze({
          ...reservation,
          status: exact
            ? "succeeded"
            : input.settlement.status === "succeeded"
              ? "over_budget"
              : input.settlement.status,
          settledAt: input.observedAt,
          ...(input.settlement.actualModel ? { actualModel: input.settlement.actualModel } : {}),
          ...(input.settlement.bodyRequestId !== undefined ? { bodyRequestId: input.settlement.bodyRequestId } : {}),
          ...(input.settlement.headerRequestId !== undefined ? { headerRequestId: input.settlement.headerRequestId } : {}),
          ...(reportedInput !== undefined ? { reportedInputTokens: reportedInput } : {}),
          ...(reportedOutput !== undefined ? { reportedOutputTokens: reportedOutput } : {}),
          ...(reportedTotal !== undefined ? { reportedTotalTokens: reportedTotal } : {}),
          ...(reportedCost !== undefined ? { reportedCostUsd: reportedCost } : {}),
          chargedInputTokens,
          chargedOutputTokens,
          chargedTotalTokens,
          chargedCostUsd,
          ...(input.settlement.errorCode ? { errorCode: input.settlement.errorCode } : {}),
        });
        replaceUnit(state, { ...accounted, adaptiveModelReservations: Object.freeze(records) });
      },
    );
    return requireAdaptiveAccounting(unitById(updated as StoredCampaign, input.unitId).adaptiveAccounting);
  }

  recordAdaptiveCandidateHandoff(
    input: TransformerAdaptiveCandidateHandoffInput,
  ): TransformerPilotCampaign {
    requireId(input.unitId, "transformer_pilot_unit_invalid");
    requireId(input.attemptId, "transformer_pilot_adaptive_candidate_attempt_invalid");
    requireId(input.repositoryId, "transformer_pilot_adaptive_candidate_repository_invalid");
    requireId(input.snapshotId, "transformer_pilot_adaptive_candidate_snapshot_invalid");
    requireBranch(
      input.baseBranch,
      "transformer_pilot_adaptive_candidate_base_branch_invalid",
    );
    requireRevision(
      input.expectedBaseRevision,
      "transformer_pilot_adaptive_candidate_expected_base_invalid",
    );
    requireDigest(
      input.divergedFromDigest,
      "transformer_pilot_adaptive_candidate_diverged_digest_invalid",
    );
    requireDigest(
      input.candidateDigest,
      "transformer_pilot_adaptive_candidate_digest_invalid",
    );
    if (input.divergedFromDigest === input.candidateDigest) {
      throw new Error("transformer_pilot_adaptive_candidate_not_divergent");
    }
    if (
      !Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1 ||
      !Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration < 1
    ) {
      throw new Error("transformer_pilot_adaptive_candidate_attempt_invalid");
    }
    if (input.failingCommandId !== null) {
      requireId(
        input.failingCommandId,
        "transformer_pilot_adaptive_candidate_failing_command_invalid",
      );
    }
    const campaign = this.mustGet(input.tenantId, input.campaignId);
    const gate = authorizeTransformerWorkerAction(
      { tenantId: input.tenantId, environment: campaign.environment },
      input.gateConfig,
    );
    if (!gate.allowed) {
      throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
    }
    const unit = unitById(campaign, input.unitId);
    const changedPaths = requireAdaptiveCandidatePaths(
      input.changedPaths,
      resolveRecipe(unit.recipe).allowedPaths,
    );
    const fileModes = requireAdaptiveCandidateFileModes(changedPaths, input.fileModes);
    if (typeof input.sealedPath !== "string" || !input.sealedPath.trim() || input.sealedPath.length > 4_000) {
      throw new Error("transformer_pilot_adaptive_candidate_seal_path_invalid");
    }
    requireDigest(
      input.sealedSha256,
      "transformer_pilot_adaptive_candidate_seal_digest_invalid",
    );
    const expiresAt = requireTimestamp(input.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(requireTimestamp(input.observedAt))) {
      throw new Error("transformer_pilot_adaptive_candidate_expiry_invalid");
    }
    const record: TransformerAdaptiveCandidateHandoffRecord = Object.freeze({
      attemptId: input.attemptId,
      attemptNumber: input.attemptNumber,
      leaseGeneration: input.leaseGeneration,
      leaseTokenDigest: leaseTokenDigest(input.leaseToken),
      repositoryId: input.repositoryId,
      snapshotId: input.snapshotId,
      baseBranch: input.baseBranch,
      expectedBaseRevision: input.expectedBaseRevision,
      divergedFromDigest: input.divergedFromDigest,
      candidateDigest: input.candidateDigest,
      failingCommandId: input.failingCommandId,
      changedPaths,
      fileModes,
      sealedPath: input.sealedPath,
      sealedSha256: input.sealedSha256,
      expiresAt,
      observedAt: input.observedAt,
      evidenceRefs: requireEvidence(input.evidenceRefs),
    });
    return this.mutate(
      input,
      "attempt.adaptive_candidate_handoff",
      record,
      (state) => {
        assertAttemptFence(state, input);
        const current = unitById(state, input.unitId);
        if (
          current.attemptNumber !== input.attemptNumber ||
          input.attemptId !== expectedAttemptId({
            tenantId: state.tenantId,
            campaignId: state.campaignId,
            unitId: current.id,
            attemptNumber: current.attemptNumber,
            leaseGeneration: current.leaseGeneration,
          })
        ) {
          throw new Error("transformer_pilot_adaptive_candidate_attempt_mismatch");
        }
        if (
          current.snapshot.repositoryId !== input.repositoryId ||
          current.snapshot.snapshotId !== input.snapshotId ||
          current.snapshot.revision !== input.expectedBaseRevision
        ) {
          throw new Error("transformer_pilot_adaptive_candidate_source_mismatch");
        }
        if (current.candidateDigest !== input.divergedFromDigest) {
          throw new Error("transformer_pilot_adaptive_candidate_digest_mismatch");
        }
        if (current.adaptiveCandidateHandoff) {
          throw new Error("transformer_pilot_adaptive_candidate_handoff_conflict");
        }
        replaceUnit(state, { ...current, adaptiveCandidateHandoff: record });
      },
    );
  }

  markAdaptiveCandidateHandoffImported(input: MutationInput & {
    unitId: string;
    attemptId: string;
    candidateId: string;
    sealedSha256: string;
    gateConfig?: string;
  }): TransformerPilotCampaign {
    requireId(input.unitId, "transformer_pilot_unit_invalid");
    requireId(input.attemptId, "transformer_pilot_adaptive_candidate_attempt_invalid");
    const candidateId = requireId(
      input.candidateId,
      "transformer_pilot_regeneration_candidate_invalid",
    );
    requireDigest(
      input.sealedSha256,
      "transformer_pilot_adaptive_candidate_seal_digest_invalid",
    );
    const campaign = this.mustGet(input.tenantId, input.campaignId);
    const gate = authorizeTransformerWorkerAction(
      { tenantId: input.tenantId, environment: campaign.environment },
      input.gateConfig,
    );
    if (!gate.allowed) {
      throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
    }
    return this.mutate(
      input,
      "attempt.adaptive_candidate_imported",
      {
        unitId: input.unitId,
        attemptId: input.attemptId,
        candidateId,
        sealedSha256: input.sealedSha256,
      },
      (state) => {
        const unit = unitById(state, input.unitId);
        const handoff = unit.adaptiveCandidateHandoff;
        if (
          !handoff ||
          handoff.attemptId !== input.attemptId ||
          handoff.sealedSha256 !== input.sealedSha256
        ) {
          throw new Error("transformer_pilot_adaptive_candidate_handoff_mismatch");
        }
        if (
          handoff.importedAt &&
          (handoff.importedAt !== input.observedAt || handoff.candidateId !== candidateId)
        ) {
          throw new Error("transformer_pilot_adaptive_candidate_import_conflict");
        }
        replaceUnit(state, {
          ...unit,
          adaptiveCandidateHandoff: Object.freeze({
            ...handoff,
            candidateId,
            importedAt: input.observedAt,
          }),
        });
      },
    );
  }

  completeAttempt(input: MutationInput & {
    unitId: string;
    leaseGeneration: number;
    leaseToken: string;
    sourceRevision: string;
    sourceDigest: string;
    candidateRevision: string;
    candidateDigest: string;
    verificationPassed: boolean;
    actualCostUsd: number;
    accounting: TransformerAdaptiveAttemptAccounting;
    gateConfig?: string;
  }): TransformerPilotCampaign {
    requireRevision(input.sourceRevision, "transformer_pilot_source_revision_invalid");
    requireDigest(input.sourceDigest, "transformer_pilot_source_digest_invalid");
    requireRevision(input.candidateRevision, "transformer_pilot_candidate_revision_invalid");
    requireDigest(input.candidateDigest, "transformer_pilot_candidate_digest_invalid");
    requireNonnegative(input.actualCostUsd, "transformer_pilot_cost_invalid");
    const campaign = this.mustGet(input.tenantId, input.campaignId);
    const gate = authorizeTransformerWorkerAction(
      { tenantId: input.tenantId, environment: campaign.environment },
      input.gateConfig,
    );
    if (!gate.allowed) throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
    return this.mutate(input, "attempt.completed", {
      ...input,
      leaseToken: leaseTokenDigest(input.leaseToken),
    }, (state) => {
      const unit = unitById(state, input.unitId);
      assertAttemptFence(state, input);
      if (unit.snapshot.revision !== input.sourceRevision || unit.snapshot.digest !== input.sourceDigest) {
        throw new Error("transformer_pilot_source_drift");
      }
      if (unit.candidateRevision !== input.candidateRevision || unit.candidateDigest !== input.candidateDigest) {
        throw new Error("transformer_pilot_candidate_drift");
      }
      if (!input.verificationPassed) throw new Error("transformer_pilot_verification_failed");
      const accounted = applyAdaptiveAccounting(state, unit, input.accounting);
      const executionEvidenceRefs = requireEvidence(input.evidenceRefs);
      const routingSettlement = routingTerminal(
        accounted,
        input.accounting,
        input.observedAt,
        executionEvidenceRefs,
        "succeeded",
      );
      replaceUnit(state, {
        ...accounted,
        state: "executed",
        verificationPassed: true,
        actualCostUsd: input.actualCostUsd,
        executedAt: input.observedAt,
        executionEvidenceRefs,
        ...(routingSettlement ? { routingSettlement } : {}),
      });
    });
  }

  recordAttemptFailure(input: MutationInput & {
    unitId: string;
    leaseGeneration: number;
    leaseToken: string;
    code: TransformerAttemptFailureCode;
    errorCode?: string;
    accounting: TransformerAdaptiveAttemptAccounting;
    gateConfig?: string;
  }): TransformerPilotCampaign {
    const code = requireAttemptFailureCode(input.code);
    const campaign = this.mustGet(input.tenantId, input.campaignId);
    const gate = authorizeTransformerWorkerAction(
      { tenantId: input.tenantId, environment: campaign.environment },
      input.gateConfig,
    );
    if (!gate.allowed) {
      throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
    }
    return this.mutate(
      input,
      "attempt.failed",
      {
        unitId: input.unitId,
        leaseGeneration: input.leaseGeneration,
        leaseTokenDigest: leaseTokenDigest(input.leaseToken),
        code,
        errorCode: input.errorCode ?? code,
        accounting: input.accounting,
      },
      (state) => {
        assertAttemptFence(state, input);
        const unit = unitById(state, input.unitId);
        const accounted = applyAdaptiveAccounting(state, unit, input.accounting);
        const routingSettlement = routingTerminal(
          accounted,
          input.accounting,
          input.observedAt,
          requireEvidence(input.evidenceRefs),
          "failed",
          input.errorCode ?? code,
        );
        replaceUnit(state, {
          ...accounted,
          state: "failed",
          retryAuthorized: false,
          ...(routingSettlement ? { routingSettlement } : {}),
        });
        state.state = "paused";
        state.exceptions.push(
          openedException(state, code, input.observedAt, input.evidenceRefs, unit),
        );
      },
    );
  }

  markRoutingOutcomeSettled(input: MutationInput & {
    unitId: string;
    envelopeId: string;
    outcomeIdempotencyKey: string;
    gateConfig?: string;
  }): TransformerPilotCampaign {
    requireId(input.unitId, "transformer_pilot_unit_invalid");
    requireId(input.envelopeId, "transformer_pilot_routing_envelope_invalid");
    requireId(
      input.outcomeIdempotencyKey,
      "transformer_pilot_routing_outcome_idempotency_invalid",
    );
    const campaign = this.mustGet(input.tenantId, input.campaignId);
    const gate = authorizeTransformerWorkerAction(
      { tenantId: input.tenantId, environment: campaign.environment },
      input.gateConfig,
    );
    if (!gate.allowed) {
      throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
    }
    return this.mutate(
      input,
      "routing.outcome_settled",
      {
        unitId: input.unitId,
        envelopeId: input.envelopeId,
        outcomeIdempotencyKey: input.outcomeIdempotencyKey,
      },
      (state) => {
        const unit = unitById(state, input.unitId);
        const routing = unit.routingSettlement;
        if (!routing?.outcome) {
          throw new Error("transformer_pilot_routing_terminal_missing");
        }
        if (
          routing.envelopeId !== input.envelopeId ||
          routing.outcomeIdempotencyKey !== input.outcomeIdempotencyKey
        ) {
          throw new Error("transformer_pilot_routing_settlement_mismatch");
        }
        if (routing.settledAt) {
          throw new Error("transformer_pilot_routing_settlement_conflict");
        }
        replaceUnit(state, {
          ...unit,
          routingSettlement: Object.freeze({ ...routing, settledAt: input.observedAt }),
        });
      },
    );
  }

  expireAttempt(input: MutationInput & {
    unitId: string;
    leaseGeneration: number;
    gateConfig?: string;
  }): TransformerPilotCampaign {
    const campaign = this.mustGet(input.tenantId, input.campaignId);
    const gate = authorizeTransformerWorkerAction(
      { tenantId: input.tenantId, environment: campaign.environment },
      input.gateConfig,
    );
    if (!gate.allowed) {
      throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
    }
    return this.mutate(
      input,
      "attempt.expired",
      {
        unitId: input.unitId,
        leaseGeneration: input.leaseGeneration,
        observedAt: input.observedAt,
        evidenceRefs: input.evidenceRefs,
      },
      (state) => {
        if (state.state !== "running") {
          throw new Error("transformer_pilot_campaign_not_running");
        }
        const unit = unitById(state, input.unitId);
        if (unit.state !== "running") {
          throw new Error("transformer_pilot_attempt_not_running");
        }
        if (
          !Number.isSafeInteger(input.leaseGeneration) ||
          input.leaseGeneration < 1 ||
          unit.leaseGeneration !== input.leaseGeneration
        ) {
          throw new Error("transformer_pilot_fence_stale");
        }
        const observedAt = Date.parse(requireTimestamp(input.observedAt));
        const leaseExpiresAt = Date.parse(unit.leaseExpiresAt ?? "");
        if (Number.isFinite(leaseExpiresAt) && observedAt < leaseExpiresAt) {
          throw new Error("transformer_pilot_fence_not_expired");
        }
        const accounted = conservativelySettleActiveModelReservations(state, unit, input.observedAt);
        replaceUnit(state, {
          ...accounted,
          state: "failed",
          retryAuthorized: false,
        });
        state.state = "paused";
        state.exceptions.push(
          openedException(
            state,
            "worker_crash",
            input.observedAt,
            input.evidenceRefs,
            unit,
          ),
        );
      },
    );
  }

  authorizeCurrentWaveDrafts(input: MutationInput & {
    gateConfig?: string;
    productionDeliveryApprovalRefs?: readonly string[];
  }): readonly TransformerDraftAction[] {
    const state = this.mustGet(input.tenantId, input.campaignId);
    const gate = authorizeTransformerDelivery({
      tenantId: state.tenantId,
      environment: state.environment,
      productionDeliveryApprovalRefs: input.productionDeliveryApprovalRefs,
    }, input.gateConfig);
    if (!gate.allowed) throw new Error(`transformer_pilot_delivery_denied:${gate.reasons.join(",")}`);
    if (state.state !== "running") throw new Error("transformer_pilot_campaign_not_running");
    const wave = Math.min(...state.units.filter((unit) => unit.state !== "merged" && unit.state !== "cancelled" && unit.state !== "rolled_back").map((unit) => unit.wave));
    const current = state.units.filter((unit) => unit.wave === wave);
    if (!current.length || current.some((unit) => unit.state !== "executed")) {
      throw new Error("transformer_pilot_wave_execution_incomplete");
    }
    const actions = current.map((unit): TransformerDraftAction => ({
      type: "open_draft",
      unitId: unit.id,
      repositoryId: unit.snapshot.repositoryId,
      expectedBaseRevision: unit.snapshot.revision,
      expectedHeadRevision: unit.candidateRevision,
      evidenceRefs: [...new Set([...unit.executionEvidenceRefs, ...gate.acceptanceEvidenceRefs])].sort(),
      draft: true,
      autoMerge: false,
      autoDeploy: false,
    }));
    this.mutate(input, "delivery.drafts_authorized", { wave, actionUnitIds: actions.map((action) => action.unitId) }, (draft) => {
      draft.units = draft.units.map((unit) => unit.wave === wave ? { ...unit, state: "draft" as const } : unit);
    });
    return deepFreeze(actions);
  }

  reconcileWave(input: MutationInput & {
    wave: number;
    observations: readonly TransformerScmObservation[];
    gateConfig?: string;
  }): TransformerPilotCampaign {
    const campaign = this.mustGet(input.tenantId, input.campaignId);
    const gate = authorizeTransformerWorkerAction(
      { tenantId: input.tenantId, environment: campaign.environment },
      input.gateConfig,
    );
    if (!gate.allowed) throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
    return this.mutate(input, "delivery.wave_reconciled", { wave: input.wave, observations: input.observations }, (state) => {
      if (state.state !== "running") throw new Error("transformer_pilot_campaign_not_running");
      const units = state.units.filter((unit) => unit.wave === input.wave);
      if (!units.length || input.observations.length !== units.length) throw new Error("transformer_pilot_wave_observation_incomplete");
      const byId = new Map(input.observations.map((observation) => [observation.unitId, observation]));
      if (byId.size !== units.length || units.some((unit) => !byId.has(unit.id))) throw new Error("transformer_pilot_wave_observation_scope_invalid");
      const failures: Array<{ code: TransformerPilotExceptionCode; unit?: TransformerPilotUnit; evidenceRefs: readonly string[] }> = [];
      const merged = input.observations.filter((observation) => observation.state === "merged");
      if (merged.length > 0 && merged.length < units.length) {
        failures.push({ code: "partial_wave_merge", evidenceRefs: input.observations.flatMap((observation) => observation.evidenceRefs) });
      }
      for (const unit of units) {
        const observation = byId.get(unit.id)!;
        requireEvidence(observation.evidenceRefs, "transformer_pilot_scm_evidence_required");
        requireNonnegative(observation.approvals, "transformer_pilot_approvals_invalid");
        requireNonnegative(observation.reviewerEditLines, "transformer_pilot_reviewer_delta_invalid");
        requireNonnegative(observation.legacyItemsRemoved, "transformer_pilot_legacy_delta_invalid");
        if (observation.baseRevision !== unit.snapshot.revision) failures.push({ code: "source_drift", unit, evidenceRefs: observation.evidenceRefs });
        if (observation.headRevision !== unit.candidateRevision) failures.push({ code: "head_drift", unit, evidenceRefs: observation.evidenceRefs });
        if (observation.state === "closed") failures.push({ code: "draft_closed", unit, evidenceRefs: observation.evidenceRefs });
        if (observation.checks === "failure") failures.push({ code: "ci_failure", unit, evidenceRefs: observation.evidenceRefs });
        if (!observation.conversationsResolved) failures.push({ code: "conversation_unresolved", unit, evidenceRefs: observation.evidenceRefs });
        if (observation.state === "merged") {
          if (observation.checks === "running" || observation.checks === "missing") {
            failures.push({ code: "ci_incomplete", unit, evidenceRefs: observation.evidenceRefs });
          } else if (observation.checkRevision !== unit.candidateRevision) {
            failures.push({ code: "ci_evidence_stale", unit, evidenceRefs: observation.evidenceRefs });
          }
          if (observation.approvals < 1) {
            failures.push({ code: "review_incomplete", unit, evidenceRefs: observation.evidenceRefs });
          } else if (observation.approvalRevision !== unit.candidateRevision) {
            failures.push({ code: "review_evidence_stale", unit, evidenceRefs: observation.evidenceRefs });
          }
        }
      }
      state.units = state.units.map((unit) => {
        if (unit.wave !== input.wave) return unit;
        const observation = byId.get(unit.id)!;
        const accepted =
          observation.baseRevision === unit.snapshot.revision &&
          observation.headRevision === unit.candidateRevision &&
          observation.checks === "success" &&
          observation.checkRevision === unit.candidateRevision &&
          observation.approvals >= 1 &&
          observation.approvalRevision === unit.candidateRevision &&
          observation.conversationsResolved;
        const merged = observation.state === "merged" && accepted;
        return {
          ...unit,
          state: merged
            ? "merged" as const
            : observation.state === "merged" && unit.state === "accepted"
              ? "accepted" as const
              : accepted
                ? "accepted" as const
                : "draft" as const,
          acceptedAt: accepted ? unit.acceptedAt ?? input.observedAt : unit.acceptedAt,
          mergedAt: merged ? input.observedAt : unit.mergedAt,
          scmEvidenceRefs: requireEvidence(observation.evidenceRefs),
          reviewerEditLines: observation.reviewerEditLines,
          legacyItemsRemoved: observation.legacyItemsRemoved,
        };
      });
      if (failures.length) {
        state.state = "paused";
        for (const failure of failures) {
          if (!state.exceptions.some((exception) => exception.state === "open" && exception.code === failure.code && exception.unitId === failure.unit?.id)) {
            state.exceptions.push(openedException(state, failure.code, input.observedAt, failure.evidenceRefs, failure.unit));
          }
        }
        return;
      }
      if (state.units.every((unit) => unit.state === "merged")) state.state = "completed";
    });
  }

  recordWorkerCrash(input: MutationInput & {
    unitId: string;
    leaseGeneration: number;
    leaseToken: string;
    accounting: TransformerAdaptiveAttemptAccounting;
    gateConfig?: string;
  }): TransformerPilotCampaign {
    return this.recordAttemptFailure({ ...input, code: "worker_crash" });
  }

  increaseAdaptiveBudget(input: MutationInput & {
    humanActorId: string;
    reason: string;
    ceilings: Partial<TransformerAdaptiveCampaignBudgetCeilings>;
  }): TransformerPilotCampaign {
    requireId(input.humanActorId, "transformer_pilot_budget_override_actor_invalid");
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (!reason || reason.length > 1_000) {
      throw new Error("transformer_pilot_budget_override_reason_invalid");
    }
    if (!input.ceilings || typeof input.ceilings !== "object" || Array.isArray(input.ceilings)) {
      throw new Error("transformer_pilot_budget_override_invalid");
    }
    const suppliedKeys = Object.keys(input.ceilings) as Array<keyof TransformerAdaptiveCampaignBudgetCeilings>;
    const validKeys = new Set(Object.keys(DEFAULT_TRANSFORMER_ADAPTIVE_CAMPAIGN_BUDGET));
    if (!suppliedKeys.length || suppliedKeys.some((key) => !validKeys.has(key))) {
      throw new Error("transformer_pilot_budget_override_invalid");
    }
    return this.mutate(
      input,
      "adaptive_budget.increased",
      {
        humanActorId: input.humanActorId,
        reason,
        ceilings: input.ceilings,
      },
      (state) => {
        const budget = requireAdaptiveBudget(state);
        const nextCeilings = resolveAdaptiveBudgetCeilings({
          ...budget.ceilings,
          ...input.ceilings,
        });
        if (suppliedKeys.some((key) => nextCeilings[key] <= budget.ceilings[key])) {
          throw new Error("transformer_pilot_budget_override_not_increase");
        }
        if (budget.overrides.length >= 1_000) {
          throw new Error("transformer_pilot_budget_override_limit");
        }
        const override: TransformerAdaptiveBudgetOverride = {
          id: `adaptive-budget-override-${String(budget.overrides.length + 1).padStart(4, "0")}`,
          humanActorId: input.humanActorId,
          reason,
          observedAt: input.observedAt,
          evidenceRefs: requireEvidence(input.evidenceRefs),
          previousCeilings: budget.ceilings,
          nextCeilings,
        };
        state.adaptiveBudget = {
          ceilings: nextCeilings,
          totals: budget.totals,
          overrides: [...budget.overrides, override],
        };
      },
    );
  }

  control(input: MutationInput & {
    action:
      | "pause"
      | "resume"
      | "cancel"
      | "authorize_retry"
      | "authorize_regeneration"
      | "resolve_exception"
      | "waive_exception";
    unitId?: string;
    exceptionId?: string;
    resolution?: string;
    candidateId?: string;
    reviewerPrincipalId?: string;
    rationale?: string;
    rationaleDigest?: string;
  }): TransformerPilotCampaign {
    return this.mutate(input, `campaign.${input.action}`, input, (state) => {
      if (input.action === "pause") {
        if (state.state !== "running") throw new Error("transformer_pilot_pause_invalid");
        state.state = "paused";
      } else if (input.action === "cancel") {
        if (state.state === "completed" || state.state === "rolled_back") throw new Error("transformer_pilot_cancel_invalid");
        state.state = "cancelled";
        state.units = state.units.map((unit) => ["merged", "rolled_back"].includes(unit.state) ? unit : { ...unit, state: "cancelled" as const });
      } else if (input.action === "authorize_regeneration") {
        const unit = unitById(state, requireId(input.unitId!, "transformer_pilot_unit_invalid"));
        const exceptionId = requireId(
          input.exceptionId!,
          "transformer_pilot_exception_invalid",
        );
        const candidateId = requireId(
          input.candidateId!,
          "transformer_pilot_regeneration_candidate_invalid",
        );
        const reviewerPrincipalId = requireBoundedReviewText(
          input.reviewerPrincipalId,
          200,
          "transformer_pilot_regeneration_reviewer_invalid",
        );
        const rationale = requireBoundedReviewText(
          input.rationale,
          2_000,
          "transformer_pilot_regeneration_rationale_invalid",
        );
        const rationaleDigest = requireDigest(
          input.rationaleDigest!,
          "transformer_pilot_regeneration_rationale_digest_invalid",
        );
        if (state.state !== "paused" || unit.state !== "failed") {
          throw new Error("transformer_pilot_regeneration_state_invalid");
        }
        const unitExceptions = state.exceptions.filter(
          (exception) => exception.state === "open" && exception.unitId === unit.id,
        );
        const originatingException = unitExceptions[0];
        if (
          unitExceptions.length !== 1 ||
          originatingException?.id !== exceptionId ||
          !["verification_failed", "worker_crash"].includes(originatingException.code)
        ) {
          throw new Error("transformer_pilot_regeneration_exception_missing");
        }
        if (state.exceptions.some(
          (exception) => exception.state === "open" && exception.unitId !== unit.id,
        )) {
          throw new Error("transformer_pilot_regeneration_resume_blocked");
        }
        const archivedHandoff = unit.adaptiveCandidateHandoff;
        if (!archivedHandoff?.importedAt) {
          throw new Error("transformer_pilot_regeneration_handoff_not_imported");
        }
        if (candidateId !== archivedHandoff.candidateId) {
          throw new Error("transformer_pilot_regeneration_candidate_binding_mismatch");
        }
        const handoffHistory = [
          ...(unit.adaptiveCandidateHandoffHistory ?? []),
          archivedHandoff,
        ];
        if (handoffHistory.length > 1_000) {
          throw new Error("transformer_pilot_regeneration_history_exhausted");
        }
        const { adaptiveCandidateHandoff: _archived, ...withoutActiveHandoff } = unit;
        replaceUnit(state, {
          ...withoutActiveHandoff,
          retryAuthorized: true,
          adaptiveCandidateHandoffHistory: Object.freeze(handoffHistory),
          regenerationReview: Object.freeze({
            candidateId,
            reviewerPrincipalId,
            rationale,
            rationaleDigest,
            requestedAt: requireTimestamp(input.observedAt),
          }),
        });
        state.exceptions = state.exceptions.map((exception) =>
          exception.id === exceptionId
            ? {
                ...exception,
                state: "resolved" as const,
                closedAt: input.observedAt,
                resolution: rationale,
                evidenceRefs: [...new Set([...exception.evidenceRefs, ...input.evidenceRefs])].sort(),
              }
            : exception
        );
        state.state = "running";
      } else if (input.action === "authorize_retry") {
        const unit = unitById(state, requireId(input.unitId!, "transformer_pilot_unit_invalid"));
        if (unit.state !== "failed") throw new Error("transformer_pilot_retry_invalid");
        replaceUnit(state, { ...unit, retryAuthorized: true });
      } else if (input.action === "resolve_exception" || input.action === "waive_exception") {
        const exceptionId = requireId(input.exceptionId!, "transformer_pilot_exception_invalid");
        if (!input.resolution?.trim()) throw new Error("transformer_pilot_resolution_required");
        const current = state.exceptions.find((exception) => exception.id === exceptionId);
        if (!current || current.state !== "open") throw new Error("transformer_pilot_exception_not_open");
        state.exceptions = state.exceptions.map((exception) => exception.id === exceptionId ? {
          ...exception,
          state: input.action === "resolve_exception" ? "resolved" as const : "waived" as const,
          closedAt: input.observedAt,
          resolution: input.resolution!.trim(),
          evidenceRefs: [...new Set([...exception.evidenceRefs, ...input.evidenceRefs])].sort(),
        } : exception);
      } else {
        if (state.state !== "paused" || state.exceptions.some((exception) => exception.state === "open")) {
          throw new Error("transformer_pilot_resume_blocked");
        }
        state.state = "running";
      }
    });
  }

  planRollback(input: MutationInput): readonly TransformerRollbackAction[] {
    const state = this.mustGet(input.tenantId, input.campaignId);
    const actions = [...state.units]
      .sort((left, right) => right.wave - left.wave || right.id.localeCompare(left.id))
      .flatMap((unit): TransformerRollbackAction[] => {
        const evidenceRefs = [...new Set([...unit.executionEvidenceRefs, ...unit.scmEvidenceRefs, ...input.evidenceRefs])].sort();
        if (unit.state === "merged") return [{
          type: "open_revert_draft", unitId: unit.id, repositoryId: unit.snapshot.repositoryId,
          expectedRevision: unit.candidateRevision, evidenceRefs, draft: true, autoMerge: false, autoDeploy: false,
        }];
        if (unit.state === "draft" || unit.state === "accepted") return [{
          type: "close_draft", unitId: unit.id, repositoryId: unit.snapshot.repositoryId,
          expectedRevision: unit.candidateRevision, evidenceRefs, draft: true, autoMerge: false, autoDeploy: false,
        }];
        if (unit.state === "executed" || unit.state === "failed" || unit.state === "running") return [{
          type: "restore_workspace", unitId: unit.id, repositoryId: unit.snapshot.repositoryId,
          expectedRevision: unit.snapshot.revision, evidenceRefs, draft: true, autoMerge: false, autoDeploy: false,
        }];
        return [];
      });
    if (!actions.length) throw new Error("transformer_pilot_rollback_plan_empty");
    const planned = this.mutate(input, "rollback.planned", { actions }, (draft) => {
      if (draft.state === "rolled_back") throw new Error("transformer_pilot_already_rolled_back");
      draft.state = "rollback_required";
      draft.rollbackPlan = actions;
    });
    return deepFreeze(clone(planned.rollbackPlan!));
  }

  getRollbackPlan(tenantId: string, campaignId: string): readonly TransformerRollbackAction[] {
    const state = this.mustGet(tenantId, campaignId);
    if (state.state !== "rollback_required" || !state.rollbackPlan?.length) {
      throw new Error("transformer_pilot_rollback_plan_not_found");
    }
    return deepFreeze(clone(state.rollbackPlan));
  }

  metrics(tenantId: string, campaignId: string): TransformerPilotMetrics {
    const state = this.mustGet(tenantId, campaignId);
    const waves = new Set(state.units.map((unit) => unit.wave));
    const completedWaves = [...waves].filter((wave) => state.units.filter((unit) => unit.wave === wave).every((unit) => unit.state === "merged"));
    const accepted = state.units.filter((unit) => unit.acceptedAt || unit.mergedAt);
    const verified = state.units.filter((unit) => unit.verificationPassed !== undefined);
    const firstAcceptedAt = accepted.map((unit) => unit.acceptedAt ?? unit.mergedAt!).sort()[0];
    return deepFreeze({
      campaignCompletionRate: state.state === "completed" ? 1 : state.units.filter((unit) => unit.state === "merged").length / state.units.length,
      waveCompletionRate: completedWaves.length / waves.size,
      batchAcceptanceRate: accepted.length / state.units.length,
      timeToFirstAcceptedPullRequestMs: firstAcceptedAt ? Date.parse(firstAcceptedAt) - Date.parse(state.createdAt) : null,
      openExceptionCount: state.exceptions.filter((exception) => exception.state === "open").length,
      verificationPassRate: verified.length ? verified.filter((unit) => unit.verificationPassed).length / verified.length : null,
      rollbackRate: state.units.filter((unit) => unit.state === "rolled_back").length / state.units.length,
      legacyItemsRemoved: state.units.reduce((sum, unit) => sum + (unit.legacyItemsRemoved ?? 0), 0),
      reviewerEditLines: state.units.reduce((sum, unit) => sum + (unit.reviewerEditLines ?? 0), 0),
      actualCostUsd: state.units.every((unit) => unit.actualCostUsd !== undefined)
        ? state.units.reduce((sum, unit) => sum + unit.actualCostUsd!, 0)
        : null,
    });
  }

  private mustGet(tenantId: string, campaignId: string): StoredCampaign {
    const state = this.getCampaign(tenantId, campaignId);
    if (!state) throw new Error("transformer_pilot_campaign_not_found");
    return clone(state) as StoredCampaign;
  }

  private mutate(
    input: MutationInput,
    scope: string,
    request: unknown,
    update: (state: StoredCampaign) => void,
  ): TransformerPilotCampaign {
    requireTimestamp(input.observedAt);
    const evidenceRefs = requireEvidence(input.evidenceRefs);
    requireId(input.idempotencyKey, "transformer_pilot_idempotency_invalid");
    const requestDigest = sha256(request);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.idempotentReplay(input.tenantId, input.idempotencyKey, scope, requestDigest, input.campaignId);
      if (replay) {
        this.db.exec("COMMIT");
        return replay;
      }
      const state = this.mustGet(input.tenantId, input.campaignId);
      update(state);
      state.revision += 1;
      state.updatedAt = input.observedAt;
      this.db.prepare("UPDATE tf_pilot_campaigns SET revision = ?, body_json = ? WHERE tenant_id = ? AND campaign_id = ?")
        .run(state.revision, JSON.stringify(state), state.tenantId, state.campaignId);
      this.insertEvent(state, scope, input.observedAt, evidenceRefs, request as Record<string, unknown>);
      this.insertIdempotency(state.tenantId, input.idempotencyKey, scope, requestDigest, state.campaignId, state.revision);
      this.db.exec("COMMIT");
      return deepFreeze(clone(state));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private idempotentReplay(
    tenantId: string,
    idempotencyKey: string,
    scope: string,
    requestDigest: string,
    campaignId: string,
  ): TransformerPilotCampaign | undefined {
    const row = this.db.prepare(
      "SELECT scope, request_digest, campaign_id FROM tf_pilot_idempotency WHERE tenant_id = ? AND idempotency_key = ?",
    ).get(tenantId, idempotencyKey) as { scope: string; request_digest: string; campaign_id: string } | undefined;
    if (!row) return undefined;
    if (row.scope !== scope || row.request_digest !== requestDigest || row.campaign_id !== campaignId) {
      throw new Error("transformer_pilot_idempotency_conflict");
    }
    return this.getCampaign(tenantId, campaignId);
  }

  private insertEvent(
    state: StoredCampaign,
    type: string,
    observedAt: string,
    evidenceRefs: readonly string[],
    payload: Record<string, unknown>,
  ): void {
    this.db.prepare("INSERT INTO tf_pilot_events (tenant_id, campaign_id, campaign_revision, type, observed_at, evidence_refs_json, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(state.tenantId, state.campaignId, state.revision, type, observedAt, JSON.stringify(evidenceRefs), JSON.stringify(payload));
  }

  private insertIdempotency(
    tenantId: string,
    key: string,
    scope: string,
    requestDigest: string,
    campaignId: string,
    resultRevision: number,
  ): void {
    this.db.prepare("INSERT INTO tf_pilot_idempotency VALUES (?, ?, ?, ?, ?, ?)")
      .run(tenantId, key, scope, requestDigest, campaignId, resultRevision);
  }
}
