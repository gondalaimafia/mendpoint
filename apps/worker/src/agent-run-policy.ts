/**
 * Fail-closed Policy Envelope enforcement on the live Fettler `agent.run` path
 * (spec §6.7). Campaign execute (#379) already uses the same primitive. This
 * seam is the busiest executor: a bound Mission must inherit an envelope and
 * the concrete repair/feature attempt must be allowed before `runWardenAttempt`.
 *
 * Unbound jobs (no payload.missionId) are not evaluated here — that enrollment
 * gap stays visible. A claimed missionId with a missing row, missing envelope,
 * invalid envelope, or explicit deny fails closed.
 */
import { getMission, type AppDb } from "@mendpoint/db";
import {
  evaluateMissionTaskPolicy,
  missionPolicyDenialReasons,
} from "@mendpoint/pipeline";
import type { PolicyRiskClass, PolicyTaskRequest } from "@mendpoint/policy";

const POLICY_RISKS = new Set<PolicyRiskClass>(["low", "medium", "high", "critical"]);

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

export function assertAgentRunMissionPolicy(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    missionId: string;
    repositoryId: string;
    branch: string;
    targetPaths: readonly string[];
    useLlm: boolean;
    risk: string;
    observedAt: string;
  }>,
): void {
  const mission = getMission(db, input.tenantId, input.missionId);
  if (!mission) throw new Error(`mission_not_found:${input.missionId}`);
  const enforcement = evaluateMissionTaskPolicy(db, {
    tenantId: input.tenantId,
    missionId: mission.id,
    task: agentRunPolicyTask(input),
    observedAt: input.observedAt,
  });
  if (enforcement.status === "no_envelope") {
    throw new Error("mission_policy_envelope_missing");
  }
  const reasons = missionPolicyDenialReasons(enforcement);
  if (reasons) {
    throw new Error(`mission_policy_denied:${reasons.join(";")}`);
  }
}
