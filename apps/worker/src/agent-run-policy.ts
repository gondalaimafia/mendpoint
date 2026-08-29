/**
 * Fail-closed Policy Envelope enforcement on the live Fettler `agent.run` path
 * (spec §6.7). Campaign execute (#379) already uses the same primitive. This
 * seam is the busiest executor: a bound Mission must inherit an envelope and
 * the concrete repair/feature attempt must be allowed before `runWardenAttempt`.
 *
 * Unbound jobs (no payload.missionId) are not evaluated here — that enrollment
 * gap stays visible. A claimed missionId with a missing row, missing envelope,
 * invalid envelope, or explicit deny fails closed. Those blockers are also
 * raised as Mission exceptions (category `policy_exception`) so the same deny
 * is not rediscovered on the next `agent.run` (ME-MSN-002).
 *
 * The deny is observed in the context of the exact immutable snapshot this
 * `agent.run` executes against, so the exception is bound to THAT snapshot
 * (`observedAgainst`), threaded from the caller. It must NOT be derived from
 * `mission.snapshotId`: the Fettler enrollment path (warden-campaign-enrollment)
 * creates the Mission with no snapshot scope and never calls `bindMissionScope`
 * (only the ReGauge launch does), so on the live Fettler path `mission.snapshotId`
 * is null. A mission-derived binding would yield no snapshot there and raise the
 * exception unbound — blocking the mission forever, the exact defect this seam
 * exists to avoid. The execution snapshot is always present here (this path is
 * only reached for an immutable snapshot). The exception counts as blocking only
 * while the mission is on that snapshot; once a later `agent.run` runs against a
 * newer snapshot the prior deny is STALE and surfaced for re-affirmation rather
 * than blocking forever. The staleness-against-current-snapshot evaluation is the
 * same one the review handoff resolver applies (apps/api/src/warden-candidate-
 * review.ts passes the run's snapshot as `current`); note that resolver does NOT
 * clear these rows — it filters on `taskId`, which these do not carry — so the
 * only thing that stops one blocking is a snapshot advance. The caller-supplied
 * snapshot/createdAt convention matches apps/worker/src/fettler-mission-task-claim.ts.
 */
import {
  evaluateMissionExceptions,
  getMission,
  raiseMissionException,
  type AppDb,
  type Mission,
  type SnapshotIdentity,
} from "@mendpoint/db";
import {
  evaluateMissionTaskPolicy,
  missionPolicyDenialReasons,
} from "@mendpoint/pipeline";
import type { PolicyRiskClass, PolicyTaskRequest } from "@mendpoint/policy";

const POLICY_RISKS = new Set<PolicyRiskClass>(["low", "medium", "high", "critical"]);

export type AgentRunMissionPolicyInput = Readonly<{
  tenantId: string;
  missionId: string;
  repositoryId: string;
  branch: string;
  targetPaths: readonly string[];
  useLlm: boolean;
  risk: string;
  // The immutable snapshot this agent.run executes against. A raised policy
  // exception is bound to it so it goes stale when the mission moves past it,
  // instead of blocking the mission forever. Threaded from the caller because
  // the Fettler Mission row carries no snapshot scope.
  observedAgainst: SnapshotIdentity;
  // Observation timestamp, taken from the caller's attempt clock. Required so
  // the evidence timestamp is the attempt's, not the worker wall clock.
  observedAt: string;
}>;

export function agentRunPolicyTask(input: {
  repositoryId: string;
  branch: string;
  targetPaths: readonly string[];
  useLlm: boolean;
  risk: string;
}): PolicyTaskRequest {
  const risk = POLICY_RISKS.has(input.risk as PolicyRiskClass)
    ? (input.risk as PolicyRiskClass)
    : "medium";
  return Object.freeze({
    repositoryId: input.repositoryId,
    branch: input.branch,
    targetPaths: Object.freeze([...input.targetPaths]),
    tool: "edit",
    modelClass: input.useLlm ? "llm" : "deterministic",
    externalProcessing: false,
    risk,
    isDeployment: false,
    wantsTrainingCapture: false,
    residency: "default",
  });
}

function recordPolicyException(
  db: AppDb,
  mission: Mission,
  reason: string,
  createdAt: string,
  observedAgainst: SnapshotIdentity,
): void {
  // Dedup against the CURRENT snapshot: a still-blocking policy_exception with
  // the same reason on this snapshot means the deny was already recorded. A
  // matching exception bound to a superseded snapshot is stale here, so a fresh
  // deny on the new snapshot is recorded (and re-affirmed) rather than skipped.
  const already = evaluateMissionExceptions(db, mission.tenantId, mission.id, observedAgainst).blocking
    .some((item) => item.category === "policy_exception" && item.reason === reason);
  if (already) return;
  raiseMissionException(db, {
    tenantId: mission.tenantId,
    missionId: mission.id,
    reason,
    impact: "Fettler agent.run denied by the inherited Policy Envelope",
    ownerPrincipalId: mission.ownerPrincipalId,
    // Truthful resolution: correcting the envelope stops the NEXT attempt from
    // re-denying; this recorded row stops blocking once a later agent.run
    // supersedes this snapshot (it goes stale). There is no taskId-based resolver
    // for these rows, so do not imply one.
    resolutionPath: "rebind_policy_envelope; deny goes stale once a later agent.run supersedes this snapshot",
    blocking: true,
    observedAgainst,
    correlationId: `agent-run-policy:${mission.id}`,
    createdAt,
    category: "policy_exception",
  });
}

export function assertAgentRunMissionPolicy(
  db: AppDb,
  input: AgentRunMissionPolicyInput,
): void {
  const mission = getMission(db, input.tenantId, input.missionId);
  if (!mission) throw new Error(`mission_not_found:${input.missionId}`);
  const enforcement = evaluateMissionTaskPolicy(db, {
    tenantId: input.tenantId,
    missionId: mission.id,
    task: agentRunPolicyTask(input),
  });
  if (enforcement.status === "no_envelope") {
    recordPolicyException(db, mission, "mission_policy_envelope_missing", input.observedAt, input.observedAgainst);
    throw new Error("mission_policy_envelope_missing");
  }
  const reasons = missionPolicyDenialReasons(enforcement);
  if (reasons) {
    recordPolicyException(db, mission, reasons.join(";"), input.observedAt, input.observedAgainst);
    throw new Error(`mission_policy_denied:${reasons.join(";")}`);
  }
}
