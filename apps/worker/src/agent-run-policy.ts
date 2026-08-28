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
 */
import {
  evaluateMissionExceptions,
  getMission,
  raiseMissionException,
  type AppDb,
  type Mission,
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
  observedAt?: string;
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
): void {
  const already = evaluateMissionExceptions(db, mission.tenantId, mission.id).blocking
    .some((item) => item.category === "policy_exception" && item.reason === reason);
  if (already) return;
  raiseMissionException(db, {
    tenantId: mission.tenantId,
    missionId: mission.id,
    reason,
    impact: "Fettler agent.run denied by the inherited Policy Envelope",
    ownerPrincipalId: mission.ownerPrincipalId,
    resolutionPath: "adjust_task_or_rebind_policy_envelope",
    blocking: true,
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
  const observedAt = input.observedAt ?? new Date().toISOString();
  const enforcement = evaluateMissionTaskPolicy(db, {
    tenantId: input.tenantId,
    missionId: mission.id,
    task: agentRunPolicyTask(input),
  });
  if (enforcement.status === "no_envelope") {
    recordPolicyException(db, mission, "mission_policy_envelope_missing", observedAt);
    throw new Error("mission_policy_envelope_missing");
  }
  const reasons = missionPolicyDenialReasons(enforcement);
  if (reasons) {
    recordPolicyException(db, mission, reasons.join(";"), observedAt);
    throw new Error(`mission_policy_denied:${reasons.join(";")}`);
  }
}
