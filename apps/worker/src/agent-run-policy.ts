/**
 * Fail-closed Policy Envelope enforcement on the live Fettler `agent.run` path
 * (spec §6.7). Campaign execute (#379) already uses the same primitive. This
 * seam is the busiest executor: a bound Mission must inherit an envelope and
 * the concrete repair/feature attempt must be allowed before `runWardenAttempt`.
 *
 * A job is Mission-bound either by an explicit `missionId` claim OR by a
 * campaign hint (fettler/campaign/regauge) that resolves to a Mission. Binding
 * resolution is delegated to `resolveBoundMissionForJob` — the same resolver
 * that enrolls the MissionTask — so the gate and enrollment never disagree
 * about whether a job is bound. A campaign-bound job enrolls a MissionTask, so
 * gating on `missionId` alone would let a campaign-bound run appear on the
 * Mission timeline with its Policy Envelope never evaluated.
 *
 * The failure modes are deliberately asymmetric:
 *   - No binding at all (no claim, no campaign hint) is a no-op — the
 *     enrollment gap stays visible.
 *   - A campaign hint that resolves to NO linked Mission is ALSO a no-op, not a
 *     throw. This is fail-open by design and it is safe precisely because the
 *     same resolver skips an unlinked campaign for enrollment too
 *     (mission-task-job-bridge `resolveBoundMissionForJob`): no MissionTask is
 *     created, so there is no enrolled-but-unevaluated run to guard — the job is
 *     genuinely unbound on both surfaces. Producers attach the hint only when
 *     exactly one Mission-linked campaign covers the repo, so a dangling hint
 *     here means the link was removed after enqueue, at which point unbound is
 *     the truth. (An unparseable payload cannot reach this seam: the handler
 *     already `JSON.parse`d it before calling in. A repo covered by zero or
 *     many campaigns never gets a hint attached, so it arrives as "no binding".)
 *   - An explicit `missionId` claim whose row is missing fails closed
 *     (`mission_task_job_mission_not_found`): an unambiguous binding assertion
 *     must never silently degrade to unbound.
 *   - A resolved Mission with a missing envelope, an invalid envelope, or an
 *     explicit deny fails closed.
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
 * A no-op when the job is unbound: genuinely, or via a campaign hint that
 * resolves to no linked Mission (no MissionTask is enrolled for it either — see
 * the module header for why that is safe). A claimed-but-missing Mission and
 * every envelope failure fail closed.
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
