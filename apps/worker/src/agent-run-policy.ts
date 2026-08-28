/**
 * Fail-closed Policy Envelope enforcement on the live Fettler `agent.run` path
 * (spec §6.7). Campaign execute (#379) already uses the same primitive. This
 * seam is the busiest executor: a bound Mission must inherit an envelope and
 * the concrete repair/feature attempt must be allowed before `runWardenAttempt`.
 *
 * A job is Mission-bound either by an explicit `missionId` claim OR by a
 * campaign hint (fettler/campaign/regauge) that resolves to a Mission — the
 * same resolver that enrolls the MissionTask (`resolveBoundMissionForJob`). A
 * campaign-bound job enrolls a MissionTask, so its envelope must be evaluated
 * too; gating on `missionId` alone would let a campaign-bound run appear on the
 * Mission timeline with its Policy Envelope never evaluated.
 *
 * Unbound jobs (no claim, no linked campaign) are not evaluated — that
 * enrollment gap stays visible. A claimed missionId with a missing row, a
 * campaign whose FK dangles, a missing envelope, an invalid envelope, or an
 * explicit deny all fail closed.
 */
import { getMission, type AppDb } from "@mendpoint/db";
import {
  evaluateMissionTaskPolicy,
  missionPolicyDenialReasons,
} from "@mendpoint/pipeline";
import type { PolicyRiskClass, PolicyTaskRequest } from "@mendpoint/policy";
import { resolveBoundMissionForJob, type BridgedJob } from "./mission-task-job-bridge.js";

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
  }>,
): void {
  const mission = getMission(db, input.tenantId, input.missionId);
  if (!mission) throw new Error(`mission_not_found:${input.missionId}`);
  const enforcement = evaluateMissionTaskPolicy(db, {
    tenantId: input.tenantId,
    missionId: mission.id,
    task: agentRunPolicyTask(input),
  });
  if (enforcement.status === "no_envelope") {
    throw new Error("mission_policy_envelope_missing");
  }
  const reasons = missionPolicyDenialReasons(enforcement);
  if (reasons) {
    throw new Error(`mission_policy_denied:${reasons.join(";")}`);
  }
}

/**
 * Evaluate the Mission Policy Envelope for an `agent.run` bound to a Mission
 * either by an explicit `missionId` claim OR by a campaign hint. Resolution is
 * delegated to `resolveBoundMissionForJob` — the same resolver that enrolls the
 * job's MissionTask — so enrollment and policy evaluation can never diverge.
 * A no-op only when the job is genuinely unbound; every bound job (however it
 * is bound) has its envelope enforced, and every resolution fault fails closed.
 */
export function assertBoundAgentRunMissionPolicy(
  db: AppDb,
  job: BridgedJob,
  task: Readonly<{
    repositoryId: string;
    branch: string;
    targetPaths: readonly string[];
    useLlm: boolean;
    risk: string;
  }>,
): void {
  const mission = resolveBoundMissionForJob(db, job);
  if (!mission) return;
  assertAgentRunMissionPolicy(db, {
    tenantId: job.tenant_id,
    missionId: mission.id,
    ...task,
  });
}
