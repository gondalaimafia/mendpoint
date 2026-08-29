import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  listRepositorySnapshots,
  recordAdaptiveCandidate,
  recordExecutionCostFromRoutingLedger,
  recordTrajectory,
  resolveMissionForRegaugeCampaign,
  type AppDb,
} from "@mendpoint/db";
import {
  classifyReviewTier,
  DEFAULT_REVIEW_TIER_POLICY,
  discardAdaptiveCandidate,
  readAdaptiveCandidateArtifact,
  runTransformerAttempt,
  sealAdaptiveCandidate,
  type RecipeCommandRunner,
  type ReviewTierPolicy,
  type TransformerAttemptCheckpointConfig,
  type TransformerAttemptCoordinatorPort,
  type TransformerVerifiedCandidateCompletion,
  type TransformerPilotExecutionStore,
} from "@mendpoint/transformer";
import { authorizeTransformerWorkerAction } from "@mendpoint/ops";
import { resolveRenamedEnv } from "@mendpoint/shared";
import { assertRegaugePilotMissionPolicy } from "./regauge-pilot-policy.js";
import {
  assignRegaugeMissionTaskOnClaim,
  handoffRegaugeMissionTaskOnReview,
} from "./regauge-mission-task-claim.js";
import {
  discardTransformerAdaptiveModelEvidence,
  persistTransformerAdaptiveModelEvidence,
  type TransformerAdaptiveModelEvidenceSummary,
  type TransformerAdaptivePlannerAdapter,
} from "./transformer-adaptive-planner.js";
import { processTransformerAdaptiveRegenerations } from "./transformer-adaptive-regeneration.js";
import { loadTransformerRecipeSnapshot } from "./transformer-snapshot-loader.js";
import {
  buildRoutedExecutorRegistry,
  runRoutedTransformerAttempt,
  settleTransformerRoutingOutcome,
  transformerExecutorDescriptor,
  transformerRoutingRequest,
} from "./transformer-router.js";

export type TransformerPilotLaneResult = Readonly<{
  enabled: boolean;
  expired: number;
  attempted: number;
  completed: number;
  failed: number;
  stale: number;
  idle: number;
  routingSettled?: number;
  handoff?: number;
  adaptiveModelEvidence?: readonly TransformerAdaptiveModelEvidenceSummary[];
  adaptiveRecovered?: number;
  regenerationBlocked?: number;
  regenerationIndeterminate?: number;
  regenerationScheduled?: number;
  regenerationFailed?: number;
  errors: readonly string[];
  infrastructureError?: string;
}>;

export type TransformerPilotLaneStore = Pick<
  TransformerPilotExecutionStore,
  | "listExpiredAttempts"
  | "listPendingRoutingSettlements"
  | "expireAttempt"
  | "listRunnableCampaigns"
  | "listAdaptiveCandidateHandoffs"
  | "bindRoutingAttempt"
  | "claimNextAttempt"
  | "renewAttemptLease"
  | "assertCurrentAttemptFence"
  | "recordAdaptiveAttemptUsage"
  | "reserveAdaptiveModelCall"
  | "settleAdaptiveModelCall"
  | "recordAdaptiveCandidateHandoff"
  | "markAdaptiveCandidateHandoffImported"
  | "completeAttempt"
  | "recordAttemptFailure"
  | "markRoutingOutcomeSettled"
  | "control"
>;

export type RunTransformerPilotLaneInput = Readonly<{
  db: AppDb;
  store: TransformerPilotLaneStore;
  gateConfig?: string;
  tenantId?: string;
  workerId: string;
  evidenceRoot: string;
  candidateRoot: string;
  tempRoot?: string;
  leaseDurationMs?: number;
  maxCampaigns?: number;
  now?: () => string;
  runId?: string;
  leaseToken?: () => string;
  commandRunner?: RecipeCommandRunner;
  shouldContinue?: () => boolean;
  /** Retention window for durable adaptive candidates awaiting human review. */
  adaptiveCandidateRetentionMs?: number;
  /** Existing private data root used for content-addressed adaptive seals. */
  adaptiveCandidateDataRoot?: string;
  /** Optional tenant-authorized live planner. Absent keeps adaptive repair disabled. */
  adaptivePlannerAdapterForTenant?(
    tenantId: string,
  ): TransformerAdaptivePlannerAdapter | undefined;
  /**
   * Explicit per-campaign authorization for sending source-derived context to
   * the exact external planner destination. Production leaves this absent until
   * a tenant approval contract supplies the evidence reference.
   */
  authorizeAdaptiveExternalProcessing?(input: Readonly<{
    tenantId: string;
    campaignId: string;
    sourceArtifactIds: readonly string[];
    policy: TransformerAdaptivePlannerAdapter["policy"];
  }>): Readonly<{ allowed: boolean; evidenceRef?: string }>;
  /** Test seam for durable adaptive-candidate recording. */
  adaptiveCandidateRecorder?: typeof recordAdaptiveCandidate;
  /**
   * Selective review-tier policy applied to converged adaptive candidates.
   * Absent (the default) leaves tiering DISABLED, so every candidate records as
   * `standard` and follows the existing uniform single-approval review path.
   */
  adaptiveReviewTierPolicy?: ReviewTierPolicy;
  /**
   * Optional tenant-scoped checkpoint provider. Production keeps this absent
   * until a shared coordinator, immutable artifact store, and tenant key are
   * configured. A configured provider must fail closed rather than silently
   * falling back to the legacy attempt path.
   */
  checkpointForCampaign?(scope: Readonly<{
    tenantId: string;
    campaignId: string;
    environment: string;
  }>): TransformerAttemptCheckpointConfig | undefined | PromiseLike<
    TransformerAttemptCheckpointConfig | undefined
  >;
  /** Optional advisory observer. It cannot change attempt completion. */
  onVerifiedCandidateCompleted?(input: TransformerVerifiedCandidateCompletion): void | Promise<void>;
}>;

const ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._,:-]{0,499}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/database is locked|SQLITE_BUSY/i.test(raw)) {
    return "transformer_lane_database_locked";
  }
  return ERROR_CODE.test(raw) ? raw : "transformer_lane_internal_error";
}

function snapshotCheckpointConfig(
  value: unknown,
  leaseDurationMs: number,
): TransformerAttemptCheckpointConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<TransformerAttemptCheckpointConfig>;
  const open = candidate.open;
  const operationTimeoutMs = candidate.operationTimeoutMs;
  if (typeof open !== "function" ||
      (operationTimeoutMs !== undefined &&
        (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 ||
          operationTimeoutMs > Math.max(1, Math.floor(leaseDurationMs / 2))))) {
    return undefined;
  }
  return Object.freeze({
    open: (input) => Reflect.apply(open, value, [input]),
    ...(operationTimeoutMs === undefined ? {} : { operationTimeoutMs }),
  });
}

async function resolveCheckpointProvider(
  provider: NonNullable<RunTransformerPilotLaneInput["checkpointForCampaign"]>,
  scope: Readonly<{ tenantId: string; campaignId: string; environment: string }>,
  leaseDurationMs: number,
): Promise<Readonly<{
  checkpoint?: TransformerAttemptCheckpointConfig;
  errorCode?: string;
}>> {
  const timeoutMs = Math.min(5_000, Math.max(1, Math.floor(leaseDurationMs / 3)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const providedCheckpoint = await Promise.race([
      Promise.resolve().then(() => provider(scope)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("transformer_lane_checkpoint_provider_timeout")),
          timeoutMs,
        );
      }),
    ]);
    const checkpoint = snapshotCheckpointConfig(providedCheckpoint, leaseDurationMs);
    if (!checkpoint) {
      return Object.freeze({
        errorCode: "transformer_lane_checkpoint_provider_invalid",
      });
    }
    return Object.freeze({ checkpoint });
  } catch {
    return Object.freeze({
      errorCode: "transformer_lane_checkpoint_provider_unavailable",
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${sha256(parts.join("\0"))}`;
}

/**
 * Best-effort ReGauge trajectory emit (spec 6.1 / 8.6). A recorded adaptive
 * candidate is the observable output of one ReGauge attempt; persisting a
 * trajectory keyed by the campaign's Mission is what makes a later delivery
 * outcome joinable back to the attempt that produced it — the seam PR #191 could
 * not close, because a ReGauge delivery keys on candidate_id/attempt_id while
 * trajectories key on run_id. The join is
 * regauge_adaptive_deliveries.candidate_id -> regauge_adaptive_candidates.campaign_id
 * -> mission.regauge_campaign_id -> mission.id -> trajectories.mission_id.
 *
 * Mission bookkeeping is metadata: it MUST NEVER abort candidate recording or the
 * lane. Any failure is logged with enough context to diagnose and swallowed
 * (matching the best-effort convention in packages/pipeline/src/index.ts), never
 * a bare catch. `mission_id` is nullable: a campaign created before the Mission
 * primitive was wired resolves to no mission, and the trajectory is written with
 * mission_id NULL rather than fabricating one. `run_id` stays populated with the
 * attempt id so the existing per-attempt key is preserved, not replaced.
 */
function emitRegaugeAdaptiveTrajectory(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    campaignId: string;
    unitId: string;
    attemptId: string;
    candidateId: string;
    family: string | null;
    provider: string | null;
    framework: string | null;
    createdAt: string;
  }>,
): void {
  try {
    const mission = resolveMissionForRegaugeCampaign(db, input.tenantId, input.campaignId);
    recordTrajectory(db, {
      id: stableId(
        "regaugetrajectory",
        input.tenantId,
        input.campaignId,
        input.unitId,
        input.attemptId,
      ),
      tenantId: input.tenantId,
      product: "regauge",
      taskKind: "regauge.adaptive_candidate",
      taskSummary: `Adaptive candidate for unit ${input.unitId}`,
      missionId: mission?.id ?? null,
      runId: input.attemptId,
      finalOutcome: "candidate_review_pending",
      provenance: {
        source: "regauge_pilot_lane",
        candidateId: input.candidateId,
        campaignId: input.campaignId,
        unitId: input.unitId,
        attemptId: input.attemptId,
        family: input.family,
        provider: input.provider,
        framework: input.framework,
        missionLinked: Boolean(mission),
      },
      createdAt: input.createdAt,
    });
    // Attribute this attempt's compute cost to its mission. The ReGauge live
    // launch path binds a real mission (owner principal included), so when one
    // resolves we write a six-way execution-cost row carrying `mission_id`. The
    // model component is derived from the attempt's routing_ledger rows; the
    // other five are recorded UNMEASURED (no meter on this path yet), never a
    // fabricated zero. Without a bound mission there is no owner principal to
    // attribute to, so no cost row is written here (an unbound Surface-A campaign
    // is honestly left unattributed rather than charged to a synthetic actor).
    if (mission) {
      recordExecutionCostFromRoutingLedger(db, {
        tenantId: input.tenantId,
        sourceRunId: input.attemptId,
        executionId: input.attemptId,
        taskId: input.unitId,
        taskClass: "regauge.adaptive_candidate",
        route: "regauge",
        campaignId: input.campaignId,
        missionId: mission.id,
        actorPrincipalId: mission.ownerPrincipalId,
        createdAt: input.createdAt,
      });
    }
  } catch (error) {
    console.error(
      `regauge trajectory emit failed tenant=${input.tenantId} campaign=${input.campaignId} ` +
        `unit=${input.unitId} attempt=${input.attemptId} candidate=${input.candidateId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  }
}

function empty(enabled: boolean): TransformerPilotLaneResult {
  return Object.freeze({
    enabled,
    expired: 0,
    attempted: 0,
    completed: 0,
    failed: 0,
    stale: 0,
    idle: 0,
    errors: Object.freeze([]),
  });
}

function requireLimit(value: number | undefined): number {
  const limit = value ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("transformer_lane_campaign_limit_invalid");
  }
  return limit;
}

function requireLeaseDuration(value: number | undefined): number {
  const duration = value ?? 15 * 60_000;
  if (!Number.isSafeInteger(duration) || duration < 1_000 || duration > 3_600_000) {
    throw new Error("transformer_lane_lease_duration_invalid");
  }
  return duration;
}

const DEFAULT_ADAPTIVE_CANDIDATE_RETENTION_MS = 7 * 24 * 60 * 60_000;

function requireAdaptiveRetention(value: number | undefined): number {
  const retention = value ?? DEFAULT_ADAPTIVE_CANDIDATE_RETENTION_MS;
  if (!Number.isSafeInteger(retention) || retention < 60_000 || retention > 90 * 24 * 60 * 60_000) {
    throw new Error("transformer_lane_adaptive_retention_invalid");
  }
  return retention;
}

function asCoordinator(store: TransformerPilotLaneStore, db: AppDb): TransformerAttemptCoordinatorPort {
  return {
    claimNextAttempt: (input) => {
      const lease = store.claimNextAttempt(input);
      if (!lease) return lease;
      try {
        // Drive the launch-created MissionTask on the same claim that took the
        // lease. Missing/unbound tasks are a no-op; a raced task must not fail
        // an already-claimed attempt.
        assignRegaugeMissionTaskOnClaim(db, {
          tenantId: lease.tenantId,
          campaignId: lease.campaignId,
          repositoryId: lease.snapshot.repositoryId,
          createdAt: lease.startedAt,
        });
      } catch (error) {
        // Observational: the lease is already held, so never fail the claim.
        // Log the code so a driven/absent/revision-conflict/principal-conflict
        // claim is not indistinguishable from a silent no-op.
        console.error(
          `  regauge mission-task claim drive failed campaign=${lease.campaignId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return lease;
    },
    renewAttemptLease: (input) => store.renewAttemptLease(input),
    assertCurrentAttemptFence: (input) => store.assertCurrentAttemptFence(input),
    recordAdaptiveAttemptUsage: (input) => store.recordAdaptiveAttemptUsage(input),
    reserveAdaptiveModelCall: (input) => store.reserveAdaptiveModelCall(input),
    settleAdaptiveModelCall: (input) => store.settleAdaptiveModelCall(input),
    recordAdaptiveCandidateHandoff: (input) => store.recordAdaptiveCandidateHandoff(input),
    completeAttempt: (input) => {
      const completed = store.completeAttempt(input);
      try {
        // Verification passing is still review-first, not delivery. Hand the
        // launch MissionTask to humans on the same complete that closed the
        // lease. Missing/unbound tasks are a no-op; a raced task must not
        // un-complete an already-recorded attempt.
        const repositoryId = completed.units.find((unit) => unit.id === input.unitId)
          ?.snapshot.repositoryId;
        if (repositoryId) {
          handoffRegaugeMissionTaskOnReview(db, {
            tenantId: input.tenantId,
            campaignId: input.campaignId,
            repositoryId,
            createdAt: input.observedAt,
          });
        }
      } catch (error) {
        // Observational: the attempt is already completed, so never un-complete
        // it. Log the code so a driven/absent/revision-conflict/principal-conflict
        // handoff is not indistinguishable from a silent no-op.
        console.error(
          `  regauge mission-task review handoff failed campaign=${input.campaignId} unit=${input.unitId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return completed;
    },
    recordAttemptFailure: (input) => store.recordAttemptFailure(input),
  };
}

export async function runTransformerPilotLaneOnce(
  input: RunTransformerPilotLaneInput,
): Promise<TransformerPilotLaneResult> {
  const rawGate = input.gateConfig?.trim();
  if (!rawGate) return empty(false);
  const now = input.now ?? (() => new Date().toISOString());
  const runId = input.runId ?? randomUUID();
  const maxCampaigns = requireLimit(input.maxCampaigns);
  const leaseDurationMs = requireLeaseDuration(input.leaseDurationMs);
  const adaptiveRetentionMs = requireAdaptiveRetention(input.adaptiveCandidateRetentionMs);
  const reviewTierPolicy = input.adaptiveReviewTierPolicy ?? DEFAULT_REVIEW_TIER_POLICY;
  const createLeaseToken = input.leaseToken ?? (() => randomBytes(32).toString("hex"));
  const errors: string[] = [];
  let expired = 0;
  let attempted = 0;
  let completed = 0;
  let failed = 0;
  let stale = 0;
  let idle = 0;
  let handoff = 0;
  let routingSettled = 0;
  let adaptiveRecovered = 0;
  let regenerationBlocked = 0;
  let regenerationIndeterminate = 0;
  let regenerationScheduled = 0;
  let regenerationFailed = 0;
  const adaptiveModelEvidence: TransformerAdaptiveModelEvidenceSummary[] = [];
  let infrastructureError: string | undefined;

  if (input.shouldContinue?.() !== false) {
    const regeneration = processTransformerAdaptiveRegenerations(input.db, input.store, {
      tenantId: input.tenantId,
      limit: maxCampaigns,
      observedAt: now(),
    });
    regenerationBlocked = regeneration.blocked;
    regenerationIndeterminate = regeneration.indeterminate;
    regenerationScheduled = regeneration.scheduled;
    regenerationFailed = regeneration.failed;
    errors.push(...regeneration.errors);
  }

  const reconcileRoutingSettlements = (): boolean => {
    for (const settlement of input.store.listPendingRoutingSettlements(
      input.tenantId,
      maxCampaigns,
    )) {
      if (input.shouldContinue?.() === false) break;
      try {
        settleTransformerRoutingOutcome({ db: input.db, settlement });
        input.store.markRoutingOutcomeSettled({
          tenantId: settlement.tenantId,
          campaignId: settlement.campaignId,
          unitId: settlement.unitId,
          envelopeId: settlement.envelopeId,
          outcomeIdempotencyKey: settlement.outcome.idempotencyKey,
          observedAt: now(),
          evidenceRefs: Object.freeze([
            ...settlement.outcome.verification.evidenceArtifactIds,
            stableId(
              "tfroutingsettled",
              settlement.tenantId,
              settlement.campaignId,
              settlement.unitId,
              settlement.envelopeId,
            ),
          ]),
          idempotencyKey: stableId(
            "tfroutingsettle",
            settlement.tenantId,
            settlement.campaignId,
            settlement.unitId,
            settlement.envelopeId,
            settlement.outcome.idempotencyKey,
          ),
          gateConfig: rawGate,
        });
        routingSettled++;
      } catch (error) {
        const code = boundedError(error);
        errors.push(code);
        infrastructureError ??= code;
        return false;
      }
    }
    return true;
  };

  // A terminal attempt is authoritative. Settle any App DB routing outcome
  // left behind by a crash before claiming new work, so the completed attempt
  // is never rerun or reported as idle while its routing ledger is incomplete.
  if (!reconcileRoutingSettlements()) {
    return Object.freeze({
      enabled: true,
      expired,
      attempted,
      completed,
      failed,
      stale,
      idle,
      ...(routingSettled ? { routingSettled } : {}),
      errors: Object.freeze([...new Set(errors)].slice(0, 25)),
      ...(infrastructureError ? { infrastructureError } : {}),
    });
  }

  // A fenced handoff is the durable authority after convergence. Re-import its
  // exact sealed artifact before claiming new work so a process death between
  // handoff persistence and the App DB transaction cannot lose the candidate.
  for (const pending of input.store.listAdaptiveCandidateHandoffs(
    input.tenantId,
    maxCampaigns,
    rawGate,
  )) {
    if (input.shouldContinue?.() === false) break;
    try {
      const artifact = readAdaptiveCandidateArtifact({
        tenantId: pending.tenantId,
        path: pending.handoff.sealedPath,
        sha256: pending.handoff.sealedSha256,
        ...(input.adaptiveCandidateDataRoot
          ? { env: { MENDPOINT_DATA_DIR: resolve(input.adaptiveCandidateDataRoot) } }
          : {}),
      });
      if (
        artifact.campaignId !== pending.campaignId ||
        artifact.unitId !== pending.unitId ||
        artifact.attemptId !== pending.handoff.attemptId ||
        artifact.repositoryId !== pending.handoff.repositoryId ||
        artifact.snapshotId !== pending.handoff.snapshotId ||
        artifact.baseBranch !== pending.handoff.baseBranch ||
        artifact.expectedBaseRevision !== pending.handoff.expectedBaseRevision ||
        artifact.divergedFromDigest !== pending.handoff.divergedFromDigest ||
        artifact.candidateDigest !== pending.handoff.candidateDigest ||
        JSON.stringify(artifact.changedPaths) !== JSON.stringify(pending.handoff.changedPaths) ||
        pending.handoff.changedPaths.some((path) =>
          artifact.fileModes[path] !== pending.handoff.fileModes[path]
        )
      ) {
        throw new Error("transformer_adaptive_candidate_handoff_seal_mismatch");
      }
      const recordedCandidate = (input.adaptiveCandidateRecorder ?? recordAdaptiveCandidate)(input.db, {
        tenantId: pending.tenantId,
        campaignId: pending.campaignId,
        unitId: pending.unitId,
        attemptId: pending.handoff.attemptId,
        repositoryId: pending.handoff.repositoryId,
        snapshotId: pending.handoff.snapshotId,
        baseBranch: pending.handoff.baseBranch,
        expectedBaseRevision: pending.handoff.expectedBaseRevision,
        divergedFromDigest: pending.handoff.divergedFromDigest,
        candidateDigest: pending.handoff.candidateDigest,
        failingCommandId: pending.handoff.failingCommandId,
        family: pending.handoff.family ?? null,
        provider: pending.handoff.provider ?? null,
        framework: pending.handoff.framework ?? null,
        sealedPath: pending.handoff.sealedPath,
        sealedSha256: pending.handoff.sealedSha256,
        changedPaths: pending.handoff.changedPaths,
        expiresAt: pending.handoff.expiresAt,
        now: pending.handoff.observedAt,
      });
      input.store.markAdaptiveCandidateHandoffImported({
        tenantId: pending.tenantId,
        campaignId: pending.campaignId,
        unitId: pending.unitId,
        attemptId: pending.handoff.attemptId,
        candidateId: recordedCandidate.id,
        sealedSha256: pending.handoff.sealedSha256,
        observedAt: now(),
        evidenceRefs: Object.freeze([
          ...pending.handoff.evidenceRefs,
          stableId(
            "tfadaptiveimport",
            pending.tenantId,
            pending.campaignId,
            pending.unitId,
            pending.handoff.attemptId,
            pending.handoff.sealedSha256,
          ),
        ]),
        idempotencyKey: stableId(
          "tfadaptiveimport",
          pending.tenantId,
          pending.campaignId,
          pending.unitId,
          pending.handoff.attemptId,
          pending.handoff.sealedSha256,
        ),
        gateConfig: rawGate,
      });
      emitRegaugeAdaptiveTrajectory(input.db, {
        tenantId: pending.tenantId,
        campaignId: pending.campaignId,
        unitId: pending.unitId,
        attemptId: pending.handoff.attemptId,
        candidateId: recordedCandidate.id,
        family: pending.handoff.family ?? null,
        provider: pending.handoff.provider ?? null,
        framework: pending.handoff.framework ?? null,
        createdAt: pending.handoff.observedAt,
      });
      adaptiveRecovered++;
    } catch (error) {
      const code = boundedError(error);
      errors.push(code);
      infrastructureError ??= code;
      break;
    }
  }
  if (infrastructureError) {
    return Object.freeze({
      enabled: true,
      expired,
      attempted,
      completed,
      failed,
      stale,
      idle,
      ...(routingSettled ? { routingSettled } : {}),
      ...(adaptiveRecovered ? { adaptiveRecovered } : {}),
      ...(regenerationBlocked ? { regenerationBlocked } : {}),
      ...(regenerationIndeterminate ? { regenerationIndeterminate } : {}),
      ...(regenerationScheduled ? { regenerationScheduled } : {}),
      ...(regenerationFailed ? { regenerationFailed } : {}),
      errors: Object.freeze([...new Set(errors)].slice(0, 25)),
      infrastructureError,
    });
  }

  const sweepObservedAt = now();
  for (const attempt of input.store.listExpiredAttempts(
    sweepObservedAt,
    input.tenantId,
    maxCampaigns,
    rawGate,
  )) {
    if (input.shouldContinue?.() === false) break;
    const decision = authorizeTransformerWorkerAction(
      { tenantId: attempt.tenantId, environment: attempt.environment },
      rawGate,
    );
    if (!decision.allowed) {
      errors.push(`transformer_lane_expiry_denied:${attempt.campaignId}`);
      continue;
    }
    try {
      input.store.expireAttempt({
        tenantId: attempt.tenantId,
        campaignId: attempt.campaignId,
        unitId: attempt.unitId,
        leaseGeneration: attempt.leaseGeneration,
        observedAt: sweepObservedAt,
        evidenceRefs: Object.freeze([
          ...decision.acceptanceEvidenceRefs,
          stableId(
            "tfexpired",
            attempt.tenantId,
            attempt.campaignId,
            attempt.unitId,
            String(attempt.leaseGeneration),
          ),
        ]),
        idempotencyKey: stableId(
          "tfexpire",
          attempt.tenantId,
          attempt.campaignId,
          attempt.unitId,
          String(attempt.leaseGeneration),
        ),
        gateConfig: rawGate,
      });
      expired++;
    } catch (error) {
      const code = boundedError(error);
      if (!code.includes("not_running") && !code.includes("fence_stale")) {
        errors.push(code);
        infrastructureError ??= code;
      }
    }
  }

  const coordinator = asCoordinator(input.store, input.db);
  // The shared policy router is the dispatcher for every runnable campaign: it
  // decides (execute vs mandatory human handoff), selects the Transformer
  // executor over Warden under the existing filters and breakers, and persists
  // the decision + outcome to the durable routing ledger. The claim, snapshot,
  // lease, and authorization guarantees below are unchanged; the attempt runs
  // through the router's executor port instead of being invoked directly.
  for (const campaign of input.store.listRunnableCampaigns(
    input.tenantId,
    maxCampaigns,
    rawGate,
  )) {
    if (input.shouldContinue?.() === false) break;
    const decision = authorizeTransformerWorkerAction(
      { tenantId: campaign.tenantId, environment: campaign.environment },
      rawGate,
    );
    if (!decision.allowed) {
      errors.push(`transformer_lane_campaign_denied:${campaign.campaignId}`);
      continue;
    }
    let checkpoint: TransformerAttemptCheckpointConfig | undefined;
    if (input.checkpointForCampaign) {
      const resolvedCheckpoint = await resolveCheckpointProvider(
        input.checkpointForCampaign,
        {
          tenantId: campaign.tenantId,
          campaignId: campaign.campaignId,
          environment: campaign.environment,
        },
        leaseDurationMs,
      );
      if (resolvedCheckpoint.errorCode) {
        attempted++;
        failed++;
        errors.push(resolvedCheckpoint.errorCode);
        continue;
      }
      checkpoint = resolvedCheckpoint.checkpoint;
    }
    const adaptiveAdapter = input.adaptivePlannerAdapterForTenant?.(campaign.tenantId);
    let adaptiveAuthorizationEvidenceRef: string | undefined;
    if (adaptiveAdapter) {
      const authorization = input.authorizeAdaptiveExternalProcessing?.({
        tenantId: campaign.tenantId,
        campaignId: campaign.campaignId,
        sourceArtifactIds: campaign.sourceArtifactIds,
        policy: adaptiveAdapter.policy,
      });
      if (
        authorization?.allowed !== true ||
        typeof authorization.evidenceRef !== "string" ||
        !authorization.evidenceRef.trim()
      ) {
        handoff++;
        errors.push(`transformer_adaptive_external_processing_not_authorized:${campaign.campaignId}`);
        continue;
      }
      adaptiveAuthorizationEvidenceRef = authorization.evidenceRef;
    }
    try {
      // Inherited Policy Envelope is an authorization control, not a prompt.
      // Unbound campaigns proceed; a bound Mission with a missing/invalid
      // envelope or an explicit deny must not take a lease.
      assertRegaugePilotMissionPolicy(input.db, {
        tenantId: campaign.tenantId,
        campaignId: campaign.campaignId,
        repositoryId: campaign.repositoryId,
        externalProcessing: Boolean(adaptiveAdapter),
        changedPaths: campaign.changedPaths,
        ...(adaptiveAdapter ? { adaptiveModelId: adaptiveAdapter.policy.model } : {}),
        observedAgainst: { snapshotId: campaign.taskSnapshotId, resolvedSha: campaign.expectedBaseRevision },
        observedAt: now(),
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      errors.push(`transformer_lane_policy_denied:${campaign.campaignId}:${code}`);
      continue;
    }
    const adaptiveProvenanceStart = adaptiveAdapter?.provenance().length ?? 0;
    const adaptiveCostRemaining = 25;
    const externalRoutingProfile = adaptiveAdapter
      ? {
            provider: adaptiveAdapter.policy.provider,
            model: adaptiveAdapter.policy.model,
            deployment: adaptiveAdapter.policy.deployment,
            executionRegion: adaptiveAdapter.policy.executionRegion,
            maximumDataClassification: adaptiveAdapter.policy.maximumDataClassification,
            maximumCostUsd: adaptiveCostRemaining,
          }
      : undefined;
    const transformerDescriptor = transformerExecutorDescriptor(now(), externalRoutingProfile);
    const routedRegistry = buildRoutedExecutorRegistry(now(), externalRoutingProfile);
    const claimKey = stableId(
      "tfclaim",
      input.workerId,
      runId,
      campaign.tenantId,
      campaign.campaignId,
    );
    const routed = await runRoutedTransformerAttempt({
      db: input.db,
      registry: routedRegistry,
      tenantId: campaign.tenantId,
      jobId: campaign.campaignId,
      runId,
      sessionId: runId,
      executorId: transformerDescriptor.executorId,
      ...(adaptiveAdapter ? { providerId: adaptiveAdapter.policy.provider } : {}),
      goal: `Regauge recipe migration for ${campaign.campaignId}`,
      routingRequest: transformerRoutingRequest({
        taskId: campaign.campaignId,
        tenantId: campaign.tenantId,
        campaignId: campaign.campaignId,
        idempotencyKey: claimKey,
        policySnapshotId: stableId(
          "tfpolicy",
          campaign.tenantId,
          campaign.campaignId,
        ),
        sourceArtifactIds: campaign.sourceArtifactIds,
        // Explicit classification ceiling for the internal deterministic lane.
        // The router policy no longer authorizes every classification when no
        // source policy is declared, so the internal lane declares the maximum
        // it is trusted to process locally (no external egress). An adaptive
        // external route overrides this with its own cleared maximum below.
        classification: "confidential",
        ...(adaptiveAdapter
          ? {
              classification: adaptiveAdapter.policy.maximumDataClassification,
              budgetUsd: adaptiveCostRemaining,
              externalProcessingAllowed: true,
              allowedExecutionRegion: adaptiveAdapter.policy.executionRegion,
            }
          : {}),
        decidedAt: new Date(now()),
      }),
      outcomeIdempotencyKey: stableId(
        "tfroute",
        campaign.tenantId,
        campaign.campaignId,
        runId,
      ),
      deferOutcomePersistence: true,
      onPrepared: (prepared) => {
        if (!prepared.dispatch || prepared.action === "human_handoff" || prepared.action === "completed") {
          return;
        }
        input.store.bindRoutingAttempt({
          tenantId: campaign.tenantId,
          campaignId: campaign.campaignId,
          runId,
          envelopeId: prepared.envelopeId,
          outcomeIdempotencyKey: stableId(
            "tfroute",
            campaign.tenantId,
            campaign.campaignId,
            runId,
          ),
          executorId: prepared.dispatch.executorId,
          providerId: prepared.dispatch.providerId,
          observedAt: now(),
          evidenceRefs: Object.freeze([
            ...decision.acceptanceEvidenceRefs,
            stableId(
              "tfroutingbound",
              campaign.tenantId,
              campaign.campaignId,
              prepared.envelopeId,
            ),
          ]),
          idempotencyKey: stableId(
            "tfroutingbind",
            campaign.tenantId,
            campaign.campaignId,
            runId,
            prepared.envelopeId,
          ),
          gateConfig: rawGate,
        });
      },
      runAttempt: () =>
        runTransformerAttempt({
          scope: campaign,
          gateConfig: rawGate,
          coordinator,
          loadExactSource: (lease) => loadTransformerRecipeSnapshot(input.db, lease, now()),
          evidenceRoot: resolve(input.evidenceRoot),
          candidateRoot: resolve(input.candidateRoot),
          ...(input.tempRoot ? { tempRoot: resolve(input.tempRoot) } : {}),
          leaseDurationMs,
          observedAt: () => now(),
          idempotencyKey: (phase, attemptId) =>
            phase === "claim"
              ? claimKey
              : stableId(
                  `tf${phase}`,
                  campaign.tenantId,
                  campaign.campaignId,
                  attemptId ?? "unbound",
                ),
          leaseToken: createLeaseToken,
          ...(input.commandRunner ? { commandRunner: input.commandRunner } : {}),
          ...(checkpoint ? { checkpoint } : {}),
          actualCostUsd: 0,
          ...(adaptiveAdapter ? { adaptiveRepair: { planner: adaptiveAdapter.planner } } : {}),
          // A converged adaptive fix that diverges from the deterministic recipe
          // output is sealed and durably handed off before App DB import. Once the
          // fenced handoff exists its exact artifacts are retained for lane-start
          // recovery; failures before that authority exists clean up their writes.
          onAdaptiveCandidateConverged: async (handoff) => {
            const boundSnapshot = listRepositorySnapshots(
              input.db,
              handoff.tenantId,
              handoff.repositoryId,
            ).find((snapshot) => snapshot.id === handoff.snapshotId);
            if (
              !boundSnapshot ||
              boundSnapshot.resolved_sha !== handoff.expectedBaseRevision
            ) {
              throw new Error("transformer_adaptive_candidate_snapshot_binding_mismatch");
            }
            const observedAt = now();
            const expiresAt = new Date(
              Date.parse(observedAt) + adaptiveRetentionMs,
            ).toISOString();
            const changedFileModes = Object.freeze(Object.fromEntries(
              handoff.changedPaths.map((path) => [path, handoff.fileModes[path]]),
            ));
            const seal = sealAdaptiveCandidate({
              tenantId: handoff.tenantId,
              campaignId: handoff.campaignId,
              unitId: handoff.unitId,
              attemptId: handoff.attemptId,
              repositoryId: handoff.repositoryId,
              snapshotId: handoff.snapshotId,
              baseBranch: boundSnapshot.requested_ref,
              expectedBaseRevision: handoff.expectedBaseRevision,
              divergedFromDigest: handoff.divergedFromDigest,
              candidateDigest: handoff.candidateDigest,
              failingCommandId: handoff.failingCommandId,
              changedPaths: handoff.changedPaths,
              adaptiveChangedPaths: handoff.adaptiveChangedPaths,
              files: handoff.files,
              fileModes: handoff.fileModes,
              review: handoff.review,
              ...(input.adaptiveCandidateDataRoot
                ? { env: { MENDPOINT_DATA_DIR: resolve(input.adaptiveCandidateDataRoot) } }
                : {}),
            });
            let modelEvidence: TransformerAdaptiveModelEvidenceSummary | undefined;
            let handoffRecorded = false;
            try {
              const calls = adaptiveAdapter?.provenance().slice(adaptiveProvenanceStart) ?? [];
              if (!adaptiveAdapter || calls.length === 0) {
                throw new Error("transformer_adaptive_model_evidence_missing");
              }
              modelEvidence = persistTransformerAdaptiveModelEvidence({
                evidenceRoot: resolve(input.evidenceRoot),
                tenantId: handoff.tenantId,
                campaignId: handoff.campaignId,
                unitId: handoff.unitId,
                attemptId: handoff.attemptId,
                policy: adaptiveAdapter.policy,
                calls,
              });
              await coordinator.recordAdaptiveCandidateHandoff({
                tenantId: handoff.tenantId,
                campaignId: handoff.campaignId,
                unitId: handoff.unitId,
                attemptId: handoff.attemptId,
                attemptNumber: handoff.attemptNumber,
                leaseGeneration: handoff.leaseGeneration,
                leaseToken: handoff.leaseToken,
                repositoryId: handoff.repositoryId,
                snapshotId: handoff.snapshotId,
                baseBranch: boundSnapshot.requested_ref,
                expectedBaseRevision: handoff.expectedBaseRevision,
                divergedFromDigest: handoff.divergedFromDigest,
                candidateDigest: handoff.candidateDigest,
                failingCommandId: handoff.failingCommandId,
                changedPaths: handoff.changedPaths,
                fileModes: changedFileModes,
                sealedPath: seal.path,
                sealedSha256: seal.sha256,
                expiresAt,
                observedAt,
                evidenceRefs: Object.freeze([
                  ...decision.acceptanceEvidenceRefs,
                  ...(adaptiveAuthorizationEvidenceRef ? [adaptiveAuthorizationEvidenceRef] : []),
                  modelEvidence.sha256,
                ]),
                idempotencyKey: stableId(
                  "tfadaptivehandoff",
                  handoff.tenantId,
                  handoff.campaignId,
                  handoff.unitId,
                  handoff.attemptId,
                ),
                gateConfig: rawGate,
              });
              handoffRecorded = true;
              // Deterministically classify the required human-review tier from the
              // sealed review evidence. The default policy is disabled, so this is
              // `standard` unless a tier policy is explicitly configured. The tier
              // only raises the required sign-off; every candidate still needs
              // human approval and nothing ever auto-merges.
              const reviewTier = classifyReviewTier(
                {
                  overallRisk: handoff.review.overallRisk,
                  confidence: handoff.review.confidence,
                  changedFileCount: handoff.changedPaths.length,
                  verificationPassed: handoff.review.verification.passed,
                },
                reviewTierPolicy,
              );
              const recordedCandidate = (input.adaptiveCandidateRecorder ?? recordAdaptiveCandidate)(input.db, {
                tenantId: handoff.tenantId,
                campaignId: handoff.campaignId,
                unitId: handoff.unitId,
                attemptId: handoff.attemptId,
                repositoryId: handoff.repositoryId,
                snapshotId: handoff.snapshotId,
                baseBranch: boundSnapshot.requested_ref,
                expectedBaseRevision: handoff.expectedBaseRevision,
                divergedFromDigest: handoff.divergedFromDigest,
                candidateDigest: handoff.candidateDigest,
                failingCommandId: handoff.failingCommandId,
                family: handoff.family,
                provider: handoff.provider,
                framework: handoff.framework,
                sealedPath: seal.path,
                sealedSha256: seal.sha256,
                changedPaths: handoff.changedPaths,
                reviewTier,
                expiresAt,
                now: observedAt,
              });
              input.store.markAdaptiveCandidateHandoffImported({
                tenantId: handoff.tenantId,
                campaignId: handoff.campaignId,
                unitId: handoff.unitId,
                attemptId: handoff.attemptId,
                candidateId: recordedCandidate.id,
                sealedSha256: seal.sha256,
                observedAt,
                evidenceRefs: Object.freeze([
                  ...decision.acceptanceEvidenceRefs,
                  stableId(
                    "tfadaptiveimport",
                    handoff.tenantId,
                    handoff.campaignId,
                    handoff.unitId,
                    handoff.attemptId,
                    seal.sha256,
                  ),
                ]),
                idempotencyKey: stableId(
                  "tfadaptiveimport",
                  handoff.tenantId,
                  handoff.campaignId,
                  handoff.unitId,
                  handoff.attemptId,
                  seal.sha256,
                ),
                gateConfig: rawGate,
              });
              adaptiveModelEvidence.push(modelEvidence);
              emitRegaugeAdaptiveTrajectory(input.db, {
                tenantId: handoff.tenantId,
                campaignId: handoff.campaignId,
                unitId: handoff.unitId,
                attemptId: handoff.attemptId,
                candidateId: recordedCandidate.id,
                family: handoff.family ?? null,
                provider: handoff.provider ?? null,
                framework: handoff.framework ?? null,
                createdAt: observedAt,
              });
            } catch (error) {
              if (!handoffRecorded && modelEvidence?.created) {
                discardTransformerAdaptiveModelEvidence(resolve(input.evidenceRoot), modelEvidence);
              }
              if (!handoffRecorded && seal.created) {
                discardAdaptiveCandidate({
                  tenantId: handoff.tenantId,
                  path: seal.path,
                  sha256: seal.sha256,
                  ...(input.adaptiveCandidateDataRoot
                    ? { env: { MENDPOINT_DATA_DIR: resolve(input.adaptiveCandidateDataRoot) } }
                    : {}),
                });
              }
              throw error;
            }
          },
          ...(input.onVerifiedCandidateCompleted
            ? { onVerifiedCandidateCompleted: input.onVerifiedCandidateCompleted }
            : {}),
        }),
    });
    if (routed.status === "handoff") {
      handoff++;
      errors.push(`transformer_routing_human_handoff:${campaign.campaignId}`);
      continue;
    }
    if (routed.status !== "idle") attempted++;
    if (routed.status === "completed") {
      completed++;
      if (routed.result?.verifierShadowError) errors.push(routed.result.verifierShadowError);
    }
    else if (routed.status === "failed") {
      failed++;
      if (routed.errorCode) errors.push(routed.errorCode);
    } else if (routed.status === "stale") stale++;
    else idle++;
    if (
      (routed.status === "completed" || routed.status === "failed") &&
      !reconcileRoutingSettlements()
    ) {
      break;
    }
  }

  return Object.freeze({
    enabled: true,
    expired,
    attempted,
    completed,
    failed,
    stale,
    idle,
    ...(routingSettled ? { routingSettled } : {}),
    ...(adaptiveRecovered ? { adaptiveRecovered } : {}),
    ...(regenerationBlocked ? { regenerationBlocked } : {}),
    ...(regenerationIndeterminate ? { regenerationIndeterminate } : {}),
    ...(regenerationScheduled ? { regenerationScheduled } : {}),
    ...(regenerationFailed ? { regenerationFailed } : {}),
    ...(handoff ? { handoff } : {}),
    ...(adaptiveModelEvidence.length > 0
      ? { adaptiveModelEvidence: Object.freeze([...adaptiveModelEvidence]) }
      : {}),
    errors: Object.freeze([...new Set(errors)].slice(0, 25)),
    ...(infrastructureError ? { infrastructureError } : {}),
  });
}

export function transformerPilotWorkerPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const override = resolveRenamedEnv(env, "MENDPOINT_REGAUGE_PILOT_DB")?.trim();
  if (override) return resolve(override);
  const dataRoot = env.MENDPOINT_DATA_DIR?.trim();
  return join(dataRoot ? resolve(dataRoot) : join(cwd, "data"), "transformer-pilot.sqlite");
}
