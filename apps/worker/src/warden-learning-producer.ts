import { createHash } from "node:crypto";
import {
  findActiveLearningConsent,
  getAgentRunMeter,
  getTrajectoryByRun,
  recordAudit,
  type AgentRunRow,
  type AppDb,
  type Trajectory,
  type WardenCandidateDeliveryRecord,
} from "@mendpoint/db";
import type { CandidateReviewEvidence } from "@mendpoint/shared";
import type {
  LearningOutcomeStatus,
  LearningProvenanceQualifier,
  LearningRiskClass,
  LearningSignalClass,
  LearningVerificationProducer,
} from "@mendpoint/pipeline";
import { learningLoopEnabled } from "./transformer-learning-outcome.js";
import {
  GOVERNED_LEARNING_PURPOSE,
  admitGovernedLearningOutcome,
  temporalContaminationFree,
  type GovernedLearningAdmissionResult,
} from "./governed-learning-producer.js";
import { deriveOutcomeAttribution } from "./outcome-attribution.js";

export type AdmitWardenGovernedLearningInput = Readonly<{
  db: AppDb;
  delivery: WardenCandidateDeliveryRecord;
  run: AgentRunRow;
  reviewEvidence: CandidateReviewEvidence;
  now: string;
  env?: NodeJS.ProcessEnv;
}>;

const RISK_ORDER: Readonly<Record<string, number>> = Object.freeze({ low: 0, medium: 1, high: 2 });
const RISK_BY_ORDER: readonly LearningRiskClass[] = Object.freeze(["low", "medium", "high"]);
// Control characters the event schema rejects; collapsed to spaces before bounding.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

function boundedLine(value: string, max: number, fallback: string): string {
  const collapsed = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return collapsed.length > 0 ? collapsed : fallback;
}

/** Highest reviewed edit risk, mapped to a learning risk class (default medium). */
function maxRiskClass(review: CandidateReviewEvidence): LearningRiskClass {
  let level = -1;
  for (const edit of review.edits) {
    const risk = edit.risk;
    if (risk && risk in RISK_ORDER) level = Math.max(level, RISK_ORDER[risk]!);
  }
  return level < 0 ? "medium" : RISK_BY_ORDER[level] ?? "medium";
}

/** Minimum reviewed edit confidence in [0,1], or null when none is measured. */
function minConfidence(review: CandidateReviewEvidence): number | null {
  const values = review.edits
    .map((edit) => edit.confidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return null;
  return Math.min(1, Math.max(0, Math.min(...values)));
}

/**
 * Derive the verification VERDICT's authority from what the review evidence
 * actually records, rather than asserting `deterministically_verified` as a
 * literal. A HARD verdict would require a deterministic command that genuinely ran
 * and passed AND every reviewed edit assessed by an independent verifier, so a
 * model's own opinion can never be laundered into a deterministic label.
 *
 * BOTH conditions are degenerate on every PRODUCTION path today, so this function
 * returns SOFT for every real Warden event. This is a fact about the system, not a
 * runtime accident, and is stated plainly here so the code is not read as a live
 * discrimination of a capability that does not exist:
 *
 *   - `independentlyAssessed` is UNSATISFIABLE in production. No code writes
 *     `assessmentSource: "verifier"`. Production Warden agents emit V2 review
 *     evidence (`CandidateReviewEvidenceV2Schema`, packages/shared), whose
 *     `assessmentSource` enum is `["planner", "heuristic"]` — "verifier" is not a
 *     valid V2 value. The runtime stamps intents only "model"/"heuristic"
 *     (packages/agent/src/types.ts), which the attempt engine maps to
 *     "planner"/"heuristic" (packages/agent/src/attempt-engine.ts). The V1 schema's
 *     enum does list "verifier", but nothing constructs V1 evidence carrying it. No
 *     independent verifier grades Warden edits — that capability does not exist.
 *   - `deterministic` is TAUTOLOGICAL. `ReviewedVerificationCommandSchema` types
 *     `ok` as `z.literal(true)` and `exitCode` as `z.literal(0)`, so a failed
 *     command cannot parse into the evidence at all; a passing command is the only
 *     representable state and the comparison carries no discriminating information.
 *     (This is the same schema-level absence of failure that makes the
 *     `VerificationOutcome` `"failed"` state unreachable — see the call sites'
 *     defect-3 note and outcome-attribution.ts.)
 *
 * The HARD branch is retained ONLY as forward-compatible recognition, honestly
 * labelled: if an independent verifier is ever wired in and records
 * `assessmentSource: "verifier"` (on V1 evidence, or a widened V2 enum), this
 * yields the hard authority it would then deserve. It cannot fire today. This
 * mirrors the house pattern of `classifyGraphContextDelivery` below, whose
 * `recorded_present` state is likewise documented as unreachable on the Fettler
 * path today but reported honestly if it ever occurs.
 */
export function deriveWardenVerificationAuthority(review: CandidateReviewEvidence): Readonly<{
  signalClass: LearningSignalClass;
  producedBy: LearningVerificationProducer;
  producerModelId: string | null;
}> {
  // Tautological in production (schema types ok/exitCode as the literals true/0);
  // kept as the forward-compatible half of the hard condition. See the header.
  const deterministic = review.verification.commands.length > 0
    && review.verification.commands.every((command) => command.ok === true && command.exitCode === 0);
  // Unsatisfiable in production: no path emits `assessmentSource: "verifier"` (V2
  // forbids the value; nothing constructs V1 evidence carrying it). See the header.
  const independentlyAssessed = review.edits.length > 0
    && review.edits.every((edit) => edit.assessmentSource === "verifier");
  if (deterministic && independentlyAssessed) {
    return Object.freeze({ signalClass: "hard" as const, producedBy: "sandbox_command" as const, producerModelId: null });
  }
  return Object.freeze({ signalClass: "soft" as const, producedBy: "model_verifier" as const, producerModelId: null });
}

/**
 * Which of the three states an event's `references.graphContextArtifactId: null`
 * actually means. The stored field is a single null carrying two facts about the
 * world that must not be conflated (spec 17.4.2): a missed relationship cannot be
 * blamed on the model until Mendpoint has confirmed the relationship "was supplied
 * to the model", and a null reference alone cannot tell "no graph context was
 * supplied" from "we captured nothing about this run".
 *
 *   - `recorded_absent`  — a trajectory for the run WAS captured and it carries no
 *     graph-context reference. The null is a FACT: this run supplied no graph
 *     context to the model. (The common case today: the Fettler agent has no graph
 *     tool, so no run supplies graph context — see this file's PR / the graph-
 *     context finding in docs.)
 *   - `recorded_present` — a trajectory was captured AND it carries a graph-context
 *     reference, yet the event's field is null. That is the context-compiler
 *     failure mode: context reached the run but was never threaded onto the event.
 *     It cannot occur on the Fettler path today; the classifier reports it honestly
 *     if it ever does, rather than silently reading as "absent".
 *   - `unrecorded`       — no trajectory for the run could be resolved. The null is
 *     NOT a fact about what was supplied; it is missing observation. A reader must
 *     not attribute a missed relationship to the model from this state.
 */
export type GraphContextDelivery = "recorded_absent" | "recorded_present" | "unrecorded";

/**
 * A trajectory context ref self-identifies as graph context with `kind:
 * "graph_context"`. No such ref is produced on the Fettler path today (the agent
 * has no graph tool), so this is forward-compatible: it recognizes the shape a
 * future graph-wired agent would record without inventing one now.
 */
function hasGraphContextRef(contextRefs: readonly unknown[]): boolean {
  return contextRefs.some(
    (ref) =>
      typeof ref === "object" &&
      ref !== null &&
      (ref as { kind?: unknown }).kind === "graph_context",
  );
}

/**
 * Classify what a null `graphContextArtifactId` means for a run, from the run's
 * captured trajectory (or its absence). Pure; the caller resolves the trajectory.
 */
export function classifyGraphContextDelivery(
  trajectory: Trajectory | undefined,
): GraphContextDelivery {
  if (!trajectory) return "unrecorded";
  return hasGraphContextRef(trajectory.contextRefs) ? "recorded_present" : "recorded_absent";
}

/**
 * Make an admitted event's null `graphContextArtifactId` interpretable by
 * resolving the run's trajectory and recording, durably and idempotently, which of
 * the three {@link GraphContextDelivery} states the null represents — WITHOUT
 * populating the field itself (there is no graph context to reference) and WITHOUT
 * inventing a placeholder id.
 *
 * Strictly best-effort: it never throws and never affects admission. A failure to
 * resolve the trajectory or write the audit is logged with enough context to
 * diagnose and swallowed. The audit id is deterministic on the event id, so a
 * re-admission (idempotent upstream) records the same attribution once.
 */
/**
 * Resolve the run's captured trajectory without ever throwing into the admission
 * path. A trajectory lookup failure is observation we do not have, not a reason to
 * block admission or to attribute a missed relationship to the model — the caller
 * treats `undefined` as {@link GraphContextDelivery} `unrecorded`, the honest
 * third state. Tenant-scoped by {@link getTrajectoryByRun}.
 */
function resolveRunTrajectory(
  db: AppDb,
  tenantId: string,
  runId: string,
): Trajectory | undefined {
  try {
    return getTrajectoryByRun(db, tenantId, runId);
  } catch (error) {
    console.error(
      `warden trajectory resolution failed tenant=${tenantId} run=${runId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function recordGraphContextAttribution(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    runId: string;
    eventId: string;
    requesterPrincipalId: string;
    trajectory: Trajectory | undefined;
  }>,
): void {
  try {
    const trajectory = input.trajectory;
    const delivery = classifyGraphContextDelivery(trajectory);
    recordAudit(db, {
      id: `audit-learning-graphctx-${input.eventId}`,
      tenantId: input.tenantId,
      actor: "worker",
      principalId: input.requesterPrincipalId,
      action: "learning.graph_context_attribution",
      resourceType: "learning_event",
      resourceId: input.eventId,
      metadata: {
        eventId: input.eventId,
        runId: input.runId,
        // The trajectory the run was resolved to, or null when none was captured.
        // A reader tells "no graph context supplied" (recorded_absent, non-null
        // trajectoryId) from "not recorded" (unrecorded, null trajectoryId).
        trajectoryId: trajectory?.id ?? null,
        graphContextDelivery: delivery,
        // The event field stays null; this record only interprets that null.
        graphContextArtifactId: null,
      },
    });
  } catch (error) {
    console.error(
      `warden graph-context attribution failed tenant=${input.tenantId} run=${input.runId} ` +
        `event=${input.eventId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Admit a delivered, human-approved, deterministically verified Warden (Fettler)
 * repair as a governed learning event. This runs at the delivery-success seam,
 * where an approved candidate has become a real draft pull request, so the outcome
 * is both reviewer-approved and objectively verified.
 *
 * Best-effort and default-off: the learning loop flag gates it, an absent governed
 * consent skips it, and every other failure is swallowed by
 * {@link admitGovernedLearningOutcome}. It never affects delivery.
 */
export function admitWardenGovernedLearningEvent(
  input: AdmitWardenGovernedLearningInput,
): GovernedLearningAdmissionResult {
  const env = input.env ?? process.env;
  if (!learningLoopEnabled(env)) return Object.freeze({ admitted: false, reason: "disabled" });
  const { db, delivery, run, reviewEvidence } = input;
  // Terminal-outcome gate. A delivered draft PR has no verified outcome yet, so
  // admitting any record at delivery would fabricate an outcome the PR never
  // reached — and learning_records is append-only, so it could never be retracted.
  // Admit only a TERMINAL outcome: a null outcome is "pending" (no decision yet)
  // and is skipped. A merged outcome is a positive result; a closed_unmerged or
  // reverted outcome is a negative result. Both terminal outcomes are now admitted
  // so the corpus carries real outcome variance, but every non-success outcome is
  // recorded honestly (see the branching below) and can never train weights: it
  // carries no verification authority, so its verdict is `inconclusive`, which caps
  // its evidence strength at "insufficient" and keeps it off the model_weight path.
  //
  // NOTE: this producer runs at the delivery seam, where `outcome` is always null,
  // so it still no-ops here until admission is re-invoked at outcome resolution.
  // That re-invocation belongs to the corpus pipeline (see the PR body) and is not
  // wired here; the widened gate makes the producer ready for it.
  if (delivery.outcome === null) {
    return Object.freeze({ admitted: false, reason: "outcome_pending" });
  }
  // A merged PR is the positive, corrected outcome; a closed_unmerged repair
  // failed to be accepted, and a reverted one was accepted then rolled back. Each
  // maps to the honest `observedOutcome.status` member, never a success value.
  const succeeded = delivery.outcome === "merged";
  const outcomeStatus: LearningOutcomeStatus =
    delivery.outcome === "merged" ? "corrected" : delivery.outcome === "reverted" ? "rolled_back" : "failed";
  try {
    const consent = findActiveLearningConsent(db, {
      tenantId: delivery.tenantId,
      purpose: GOVERNED_LEARNING_PURPOSE,
      at: input.now,
    });
    if (!consent) return Object.freeze({ admitted: false, reason: "no_active_consent" });

    const meter = getAgentRunMeter(db, delivery.tenantId, delivery.runId);
    const snapshotDigest = `sha256:${createHash("sha256")
      .update([delivery.tenantId, delivery.repositoryId, delivery.snapshotId, delivery.expectedBaseRevision].join("\0"), "utf8")
      .digest("hex")}`;

    const authority = deriveWardenVerificationAuthority(reviewEvidence);
    // Derive `deterministically_verified` from the recorded authority instead of
    // asserting it: a soft verdict keeps only `reviewer_accepted`. A non-success
    // outcome keeps only `reviewer_accepted` too — the repair was reviewer-approved
    // at delivery, but its correctness was never established (it was not merged), so
    // `deterministically_verified`/`merged_and_verified` would be a false claim.
    const provenanceQualifiers: readonly LearningProvenanceQualifier[] =
      succeeded && authority.signalClass === "hard"
        ? ["deterministically_verified", "reviewer_accepted"]
        : ["reviewer_accepted"];

    // Resolve the run's trajectory ONCE (never throwing into admission) so both the
    // attribution derivation and the graph-context audit read the same observation.
    const trajectory = resolveRunTrajectory(db, delivery.tenantId, run.id);
    // The VerificationOutcome this seam can honestly attest is `not_verified`, and
    // it is passed as such rather than derived from `authority.signalClass`. Three
    // reasons, none of which a reassuring default may paper over:
    //
    //   - `signalClass` ("hard" | "soft") answers WHO produced a signal
    //     (sandbox_command vs model_verifier), NOT WHAT it concluded. Mapping it to
    //     a VerificationOutcome ("verified" | "failed" | "not_verified") conflates
    //     an authority axis with a conclusion axis — that conflation is defect (3).
    //     And in production `signalClass` is always "soft" anyway
    //     (deriveWardenVerificationAuthority above: no path emits "verifier").
    //   - `"verified"` requires objective verification to have concluded the model's
    //     action correct. No independent verifier assesses Warden edits (they are
    //     model-self-selected: assessmentSource "planner"/"heuristic"), and the
    //     deterministic command's "passed" is tautological (schema forbids a failed
    //     command), so nothing here establishes `verified`.
    //   - `"failed"` is structurally UNREPRESENTABLE: ReviewedVerificationCommandSchema
    //     types ok/exitCode as the literals true/0, so a failed verification cannot
    //     parse into the evidence at all. The widened admission gate now admits
    //     non-merged terminal outcomes, but their terminal fate is recorded in
    //     `observedOutcome.status` (`failed`/`rolled_back`), never as a verification
    //     `"failed"` — this seam observes no objective failure signal. `"failed"` is
    //     therefore never passed — see outcome-attribution.ts, whose
    //     `failed`/`retrieval` branches stay dormant.
    //
    // So `deriveOutcomeAttribution` receives `not_verified` and returns `none`
    // (undetermined) for every production Warden event: high precision, fail closed,
    // never a fabricated `model_behavior`. `contextDelivery` is still resolved and
    // recorded honestly (it does not change `none`, but a `not_verified` outcome
    // makes it moot regardless — the deriver short-circuits `not_verified` to
    // `none`). Admitting non-merged outcomes is now done (the owner's decision, this
    // change); making failure representable and mapping a terminal failure to a
    // VerificationOutcome remain, so until the outcome-resolution re-invocation and
    // that mapping land this cannot discriminate and every admitted outcome routes
    // to `no_action`.
    const attribution = deriveOutcomeAttribution({
      verification: "not_verified",
      contextDelivery: classifyGraphContextDelivery(trajectory),
    });

    const admission = admitGovernedLearningOutcome({
      db,
      tenantId: delivery.tenantId,
      consentId: consent.id,
      residencyRegion: consent.residency_region,
      product: "fettler",
      sourceObjectType: "fettler_agent_run",
      sourceObjectId: run.id,
      repositoryId: delivery.repositoryId,
      taskType: "api_remediation",
      capability: "remediation_generation",
      specialization: {
        provider: null,
        framework: null,
        language: null,
        runtime: null,
        migrationFamily: "api_remediation",
        riskClass: maxRiskClass(reviewEvidence),
      },
      execution: {
        modelId: null,
        adapterId: null,
        routerDecisionId: `warden_route_${run.id}`,
        fallback: false,
      },
      predictionSummary: boundedLine(reviewEvidence.summary, 4000, "Apply the reviewed Warden repair."),
      outcome: {
        // Record the honest terminal outcome, never forced to a success value: a
        // merged repair is `corrected`, a reverted one `rolled_back`, a
        // closed_unmerged one `failed`.
        status: outcomeStatus,
        summary: succeeded
          ? boundedLine(reviewEvidence.verification.summary, 4000, "The repair passed objective verification.")
          : boundedLine(delivery.rationale, 4000, "The delivered repair was not accepted."),
        attribution,
      },
      // The candidate was reviewer-approved before delivery; the terminal fate
      // above is a downstream outcome, not a review rejection, so the review
      // decision stays `accepted` for both paths (the admission gate binds it to
      // accepted/modified/merged).
      reviewerDecision: "accepted",
      // A correction is substantive only on the success path, and only when the
      // reviewed repair actually carries verified code edits (not asserting `true`).
      // A non-success outcome established no substantive correction — the repair was
      // not accepted — so it is `false`: the conservative not-established value,
      // which also keeps a failure off the model_weight path in `classify`.
      correctionSubstantive: succeeded && reviewEvidence.edits.length > 0,
      // Attest contamination-freedom from the temporal determination this producer
      // can genuinely make, not a literal: the outcome was observed before
      // admission. A malformed/future timestamp fails closed at the admission gate.
      contaminationFree: temporalContaminationFree(delivery.requestedAt, input.now),
      // Confidence is a prediction-time value present regardless of outcome, so it
      // is recorded on both paths: a failed outcome with a recorded confidence is
      // precisely the calibration signal a failure teaches. Nulling it would erase
      // real signal, not add honesty.
      confidence: minConfidence(reviewEvidence),
      // A merged repair carries its correctness-verification authority; a
      // non-success outcome carries the explicit not-observed state (null): its
      // repair correctness was never objectively verified, so no producer is
      // synthesized and the derived verdict stays `inconclusive`.
      verificationAuthority: succeeded ? authority : null,
      economics: {
        inputTokens: meter?.inputTokens ?? 0,
        outputTokens: meter?.outputTokens ?? 0,
        latencyMs: meter?.durationMs ?? 0,
        costUsd: meter?.costUsd ?? 0,
      },
      sourceClass: "design_partner_verified",
      provenanceQualifiers,
      mayLeaveTenantBoundary: false,
      revision: delivery.expectedBaseRevision,
      snapshotDigest,
      scenarioId: null,
      syntheticFamilyId: null,
      reviewerPrincipalId: delivery.requesterPrincipalId,
      reviewRationale: boundedLine(delivery.rationale, 512, "Approved in Warden review."),
      observedAt: delivery.requestedAt,
      now: input.now,
    });

    // Make the admitted event's null graphContextArtifactId interpretable: record,
    // durably, whether the run was captured and carried no graph context vs. was
    // never captured at all. Best-effort and isolated — it never alters admission.
    if (admission.admitted && admission.eventId) {
      recordGraphContextAttribution(db, {
        tenantId: delivery.tenantId,
        runId: run.id,
        eventId: admission.eventId,
        requesterPrincipalId: delivery.requesterPrincipalId,
        trajectory,
      });
    }

    return admission;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Object.freeze({ admitted: false, reason: `error:${message}` });
  }
}
