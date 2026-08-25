/**
 * Agent -> human -> agent handoff, written as durable records (task brief §2, §3,
 * §4).
 *
 * This adds NO new store. It is a thin, tested composition over the three
 * mission record stores that already exist:
 *   - `mission-exceptions.ts`  — the blocker + the specific question being asked;
 *   - `mission-decisions.ts`   — the human's resolution, and rejected approaches,
 *                                as durable decisions with a supersession chain.
 *
 * The design is deliberately small: a handoff WRITES records here; a resume READS
 * the compiled envelope (see `apps/worker/src/mission-context.ts` +
 * `packages/pipeline/src/mission-context-compiler.ts`). Nothing in this module
 * reaches a model, and nothing here stores model reasoning — only the reason for
 * the handoff, the question, evidence references, and the recorded decision.
 *
 * All reviewer- and agent-authored strings that flow through here (`question`,
 * `context`, `directive`, `resolutionNote`) are UNTRUSTED DATA. They are stored
 * verbatim and, downstream, only ever reach a model inside the compiler's
 * untrusted-data fence (`renderInheritedContextSystemBlock`). This module never
 * interprets them as instructions.
 */
import type { AppDb } from "./index.js";
import {
  raiseMissionException,
  resolveMissionException,
  type MissionException,
  type SnapshotIdentity,
} from "./mission-exceptions.js";
import {
  getActiveMissionDecisions,
  recordMissionDecision,
  retractMissionDecision,
  supersedeMissionDecision,
  type MissionDecision,
  type MissionDecisionType,
} from "./mission-decisions.js";
import {
  getMissionTask,
  transitionMissionTask,
  type MissionTask,
  type MissionTaskStatus,
} from "./mission-task.js";

/**
 * Why a task is being handed to a human. An explicit, closed enum: a handoff
 * that cannot name its reason is rejected rather than defaulted (fail closed).
 * "Please review" forces the human to reconstruct the problem; a named reason
 * plus a specific question does not.
 */
export type HandoffReason =
  | "graph_incomplete"
  | "high_risk_change"
  | "ambiguous_requirement"
  | "policy_exception"
  | "verification_failure"
  | "architecture_decision_required";

const HANDOFF_REASONS: ReadonlySet<HandoffReason> = new Set<HandoffReason>([
  "graph_incomplete",
  "high_risk_change",
  "ambiguous_requirement",
  "policy_exception",
  "verification_failure",
  "architecture_decision_required",
]);

function assertHandoffReason(reason: unknown): HandoffReason {
  if (typeof reason !== "string" || !HANDOFF_REASONS.has(reason as HandoffReason)) {
    throw new Error("task_handoff_reason_invalid");
  }
  return reason as HandoffReason;
}

const HUMAN_HANDOFF_STATUSES: ReadonlySet<MissionTaskStatus> = new Set([
  "human_review_required",
  "human_assigned",
  "human_working",
]);

function eventKey(correlationId: string, taskId: string, to: string): string {
  return `${correlationId}:mission-task:${taskId}:${to}`;
}

function transitionBoundTask(
  db: AppDb,
  input: {
    tenantId: string;
    missionId: string;
    taskId: string;
    to: MissionTaskStatus;
    actorPrincipalId: string;
    handoffReason?: string;
    assignedPrincipalId?: string | null;
    correlationId: string;
    causationId?: string | null;
    createdAt: string;
  },
): MissionTask {
  const task = getMissionTask(db, input.tenantId, input.taskId);
  if (!task) throw new Error("mission_task_not_found");
  if (task.missionId !== input.missionId) throw new Error("mission_task_mission_mismatch");
  return transitionMissionTask(db, {
    tenantId: input.tenantId,
    taskId: task.id,
    expectedRevision: task.revision,
    to: input.to,
    actorPrincipalId: input.actorPrincipalId,
    ...(input.assignedPrincipalId !== undefined ? { assignedPrincipalId: input.assignedPrincipalId } : {}),
    ...(input.handoffReason ? { handoffReason: input.handoffReason } : {}),
    eventId: eventKey(input.correlationId, task.id, input.to),
    idempotencyKey: eventKey(input.correlationId, task.id, input.to),
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    createdAt: input.createdAt,
  });
}

/**
 * Open an agent -> human handoff (task brief §2). Records a BLOCKING mission
 * exception that carries the explicit reason and the SPECIFIC question the agent
 * is asking, so the human resolves a precise decision rather than reconstructing
 * the whole problem. Binding the exception to the snapshot it was observed
 * against means that if the mission later moves past that snapshot the exception
 * goes STALE (surfaced for re-affirmation) instead of silently blocking forever.
 *
 * The agent's work-so-far is preserved by reference (trajectory, diff digest,
 * evidence) on the resolution decision, not by copying reasoning here.
 */
export function openTaskHandoff(
  db: AppDb,
  input: {
    tenantId: string;
    missionId: string;
    reason: HandoffReason;
    /** The specific question the human must answer. Required and non-empty. */
    question: string;
    /** What the agent concluded / why this blocks (the impact). Required. */
    context: string;
    ownerPrincipalId: string;
    /**
     * When present: (1) persisted as the exception annotation, and (2) the
     * shared MissionTask is transitioned agent_working → human_review_required
     * in the same transaction as the blocker. Absent keeps the pre-task-engine
     * record-only path.
     */
    taskId?: string;
    observedAgainst?: SnapshotIdentity;
    correlationId: string;
    causationId?: string | null;
    createdAt: string;
  },
): MissionException {
  const reason = assertHandoffReason(input.reason);
  if (typeof input.question !== "string" || !input.question.trim()) {
    throw new Error("task_handoff_question_required");
  }
  // The stored blocker reason carries the enum AND the question as data. The
  // mission-exceptions store bounds and control-character-checks it.
  const statement = `[${reason}] ${input.question.trim()}`;
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const exception = raiseMissionException(db, {
      tenantId: input.tenantId,
      missionId: input.missionId,
      reason: statement,
      impact: input.context,
      ownerPrincipalId: input.ownerPrincipalId,
      resolutionPath: "await_human_resolution",
      blocking: true,
      ...(input.observedAgainst ? { observedAgainst: input.observedAgainst } : {}),
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
      createdAt: input.createdAt,
      category: reason,
      ...(input.taskId ? { taskId: input.taskId } : {}),
    });
    if (input.taskId) {
      const task = getMissionTask(db, input.tenantId, input.taskId);
      if (!task) throw new Error("mission_task_not_found");
      if (task.missionId !== input.missionId) throw new Error("mission_task_mission_mismatch");
      if (task.status !== "agent_working" && task.status !== "human_review_required") {
        throw new Error("task_handoff_task_not_agent_working");
      }
      transitionBoundTask(db, {
        tenantId: input.tenantId,
        missionId: input.missionId,
        taskId: input.taskId,
        to: "human_review_required",
        actorPrincipalId: input.ownerPrincipalId,
        handoffReason: reason,
        correlationId: input.correlationId,
        causationId: input.causationId ?? null,
        createdAt: input.createdAt,
      });
    }
    if (owns) db.raw.exec("COMMIT");
    return exception;
  } catch (error) {
    if (owns) db.raw.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Resolve an agent -> human handoff and hand back to the agent (task brief §3,
 * §4). Atomically: closes the blocking exception (so the same question is not
 * asked again) AND records the human's resolution as a durable mission decision
 * (so a later task inherits the answer). The decision's `scope` is the subject
 * the answer governs; a later decision on the same subject can supersede it when
 * circumstances change.
 */
export function resolveTaskHandoff(
  db: AppDb,
  input: {
    tenantId: string;
    priorExceptionId: string;
    /** How the blocker was closed (recorded on the exception chain). */
    resolutionNote: string;
    /** The durable decision the resolution establishes. */
    decision: string;
    /** The subject the decision governs (contends under precedence by subject). */
    scope: string;
    authorPrincipalId: string;
    /** References to the evidence the decision rests on (never reasoning). */
    evidence?: readonly string[];
    /**
     * When present, the shared MissionTask is transitioned to `agent_resume`
     * in the same transaction as the exception close + decision write.
     */
    taskId?: string;
    correlationId: string;
    causationId?: string | null;
    createdAt: string;
  },
): { exception: MissionException; decision: MissionDecision } {
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const exception = resolveMissionException(db, {
      tenantId: input.tenantId,
      priorExceptionId: input.priorExceptionId,
      resolutionNote: input.resolutionNote,
      actorPrincipalId: input.authorPrincipalId,
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
      createdAt: input.createdAt,
    });
    const decision = recordMissionDecision(db, {
      tenantId: input.tenantId,
      missionId: exception.missionId,
      decision: input.decision,
      scope: input.scope,
      authorPrincipalId: input.authorPrincipalId,
      ...(input.evidence ? { evidence: input.evidence } : {}),
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
      createdAt: input.createdAt,
      decisionType: "exception_resolution",
    });
    if (input.taskId) {
      const task = getMissionTask(db, input.tenantId, input.taskId);
      if (!task) throw new Error("mission_task_not_found");
      if (task.missionId !== exception.missionId) throw new Error("mission_task_mission_mismatch");
      if (task.status !== "agent_resume" && !HUMAN_HANDOFF_STATUSES.has(task.status)) {
        throw new Error("task_handoff_task_not_human_owned");
      }
      transitionBoundTask(db, {
        tenantId: input.tenantId,
        missionId: exception.missionId,
        taskId: input.taskId,
        to: "agent_resume",
        actorPrincipalId: input.authorPrincipalId,
        correlationId: input.correlationId,
        causationId: input.causationId ?? null,
        createdAt: input.createdAt,
      });
    }
    if (owns) db.raw.exec("COMMIT");
    return { exception, decision };
  } catch (error) {
    if (owns) db.raw.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Record a reviewer directive as a durable mission decision (task brief §4). The
 * regenerate path uses this so each review cycle's guidance survives as an
 * ACTIVE decision the next cycle inherits — instead of only the latest cycle's
 * rationale reaching the next run by string concatenation. Give distinct
 * `scope`s to distinct directives so they all stay active (a shared scope makes
 * a later decision supersede an earlier one only when you explicitly supersede).
 */
export function recordReviewerDirective(
  db: AppDb,
  input: {
    tenantId: string;
    missionId: string;
    directive: string;
    scope: string;
    authorPrincipalId: string;
    evidence?: readonly string[];
    correlationId: string;
    causationId?: string | null;
    createdAt: string;
    /** Closed-set label from §8.19. Omitted persists as null. */
    decisionType?: MissionDecisionType | null;
  },
): MissionDecision {
  return recordMissionDecision(db, {
    tenantId: input.tenantId,
    missionId: input.missionId,
    decision: input.directive,
    scope: input.scope,
    authorPrincipalId: input.authorPrincipalId,
    ...(input.evidence ? { evidence: input.evidence } : {}),
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    createdAt: input.createdAt,
    decisionType: input.decisionType ?? null,
  });
}

const REVIEWER_CANDIDATE_DIGEST = /^[a-f0-9]{64}$/;

export function reviewerDirectiveScope(candidateDigest: string): string {
  const normalized = candidateDigest.trim().toLowerCase();
  if (!REVIEWER_CANDIDATE_DIGEST.test(normalized)) {
    throw new Error("reviewer_directive_candidate_digest_invalid");
  }
  return `reviewer_directive:candidate:${normalized}`;
}

function sameEvidence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((ref, index) => ref === right[index]);
}

/**
 * Record the current human directive for one durable candidate identity. This
 * is deliberately narrower than a generic MissionDecision replacement: only
 * verification decisions carrying both the exact candidate and an agent-run
 * reference are reviewer directives. Foreign policy or architecture decisions
 * on the same textual scope are never superseded.
 *
 * Legacy data may contain multiple active reviewer heads because the generic
 * record primitive permits independent roots. Reconcile those heads in stable
 * creation/id order, retracting every duplicate before replacing the newest
 * head. The entire read/reconcile/write sequence owns one IMMEDIATE transaction
 * unless its caller already owns the transaction.
 */
export function replaceReviewerDirective(
  db: AppDb,
  input: {
    tenantId: string;
    missionId: string;
    directive: string;
    candidateDigest: string;
    sourceRunId: string;
    authorPrincipalId: string;
    correlationId: string;
    causationId?: string | null;
    createdAt: string;
  },
): MissionDecision {
  const directive = input.directive.trim();
  const candidateDigest = input.candidateDigest.trim().toLowerCase();
  const sourceRunId = input.sourceRunId.trim();
  if (!sourceRunId) throw new Error("reviewer_directive_source_run_invalid");
  const scope = reviewerDirectiveScope(candidateDigest);
  const candidateEvidence = `candidate:${candidateDigest}`;
  const evidence = [`agent_run:${sourceRunId}`, candidateEvidence] as const;
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const heads = getActiveMissionDecisions(db, input.tenantId, input.missionId).filter((decision) =>
      decision.scope === scope &&
      decision.decisionType === "verification" &&
      decision.evidence.includes(candidateEvidence) &&
      decision.evidence.some((ref) => ref.startsWith("agent_run:") && ref.length > "agent_run:".length));
    // createdAt records the first write; it is not part of the semantic operation
    // identity because a transport retry observes a new wall-clock time.
    const replay = heads.find((decision) =>
      decision.decision === directive &&
      decision.authorPrincipalId === input.authorPrincipalId &&
      sameEvidence(decision.evidence, evidence));
    // Authority follows the newest legitimate active head, even when a delayed
    // transport retry semantically matches an older legacy duplicate.
    const survivor = heads.at(-1);
    for (const head of heads) {
      if (head.id === survivor?.id) continue;
      retractMissionDecision(db, {
        tenantId: input.tenantId,
        priorDecisionId: head.id,
        rationale: `Duplicate reviewer directive reconciled for ${scope}`,
        authorPrincipalId: input.authorPrincipalId,
        correlationId: input.correlationId,
        causationId: input.causationId ?? null,
        createdAt: input.createdAt,
      });
    }
    const value = replay && survivor ? survivor : (survivor
      ? supersedeMissionDecision(db, {
          tenantId: input.tenantId,
          priorDecisionId: survivor.id,
          decision: directive,
          scope,
          authorPrincipalId: input.authorPrincipalId,
          evidence,
          correlationId: input.correlationId,
          causationId: input.causationId ?? null,
          createdAt: input.createdAt,
          decisionType: "verification",
        })
      : recordReviewerDirective(db, {
          tenantId: input.tenantId,
          missionId: input.missionId,
          directive,
          scope,
          authorPrincipalId: input.authorPrincipalId,
          evidence,
          correlationId: input.correlationId,
          causationId: input.causationId ?? null,
          createdAt: input.createdAt,
          decisionType: "verification",
        }));
    if (owns) db.raw.exec("COMMIT");
    return value;
  } catch (error) {
    if (owns) db.raw.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Revise a prior decision because circumstances genuinely changed (task brief §4
 * escape hatch). This supersedes the prior decision — the prior drops out of the
 * active set so it stops being enforced — and REQUIRES non-empty evidence for
 * the change, so revision is a deliberate, evidenced act rather than a silent
 * reversal. Suppression of a rejected approach is therefore never absolute: new
 * conflicting evidence lets an agent revisit it.
 */
export function reviseDecisionOnNewEvidence(
  db: AppDb,
  input: {
    tenantId: string;
    priorDecisionId: string;
    decision: string;
    scope: string;
    authorPrincipalId: string;
    /** The new evidence that justifies revisiting. Required and non-empty. */
    evidence: readonly string[];
    correlationId: string;
    causationId?: string | null;
    createdAt: string;
  },
): MissionDecision {
  if (!Array.isArray(input.evidence) || input.evidence.length < 1) {
    throw new Error("task_handoff_revision_evidence_required");
  }
  return supersedeMissionDecision(db, {
    tenantId: input.tenantId,
    priorDecisionId: input.priorDecisionId,
    decision: input.decision,
    scope: input.scope,
    authorPrincipalId: input.authorPrincipalId,
    evidence: input.evidence,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    createdAt: input.createdAt,
  });
}
