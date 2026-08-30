export const ROUTER_VALUE_PROOF_VERSION = "2026-08-02.v1" as const;
export const ROUTER_VALUE_MAX_OBSERVATIONS = 10_000;
export const ROUTER_VALUE_MAX_EVIDENCE_REFS_PER_OBSERVATION = 20;

export type RouterValueArm = "baseline" | "candidate";

export type RouterValueObservation = {
  taskId: string;
  arm: RouterValueArm;
  accepted: boolean;
  securityFindings: number;
  costUsd: number;
  latencyMs: number;
  evidenceRefs: string[];
};

export type RouterValueProofContract = {
  version: typeof ROUTER_VALUE_PROOF_VERSION;
  cohort: {
    id: string;
    revision: string;
    digest: string;
    heldOut: boolean;
  };
  policy: {
    latencyP95Ms: number;
    requirePerTaskAcceptanceNonRegression: true;
    requirePerTaskSecurityNonRegression: true;
    requireLowerAcceptedOutputCost: true;
  };
  observations: RouterValueObservation[];
};

export type RouterValueProofReport = {
  version: typeof ROUTER_VALUE_PROOF_VERSION;
  cohortId: string;
  cohortRevision: string;
  cohortDigest: string;
  ok: boolean;
  taskCount: number;
  acceptance: { baseline: number; candidate: number };
  acceptanceRegressionTaskIds: string[];
  securityRegressionTaskIds: string[];
  acceptedOutputCostUsd: { baseline: number; candidate: number };
  acceptedOutputCostRegressionTaskIds: string[];
  candidateLatencyP95Ms: number;
  latencyObjectiveMs: number;
  latencyObjectiveExceededTaskIds: string[];
  evidenceRefs: string[];
};

const ID = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function fail(code: string): never {
  throw new Error(code);
}

function finiteNonnegative(value: number, code: string): void {
  if (!Number.isFinite(value) || value < 0) fail(code);
}

function nearestRank(values: readonly number[], percentile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)]!;
}

function rate(accepted: number, total: number): number {
  return total === 0 ? 0 : accepted / total;
}

function acceptedCost(observations: readonly RouterValueObservation[]): number {
  const accepted = observations.filter((observation) => observation.accepted);
  if (accepted.length === 0) return Number.POSITIVE_INFINITY;
  return accepted.reduce((total, observation) => total + observation.costUsd, 0) /
    accepted.length;
}

export function evaluateRouterValueProof(
  contract: RouterValueProofContract,
): RouterValueProofReport {
  if (contract.version !== ROUTER_VALUE_PROOF_VERSION) fail("router_value_version_invalid");
  if (typeof contract.cohort.heldOut !== "boolean" || contract.cohort.heldOut !== true) {
    fail("router_value_cohort_not_held_out");
  }
  if (!ID.test(contract.cohort.id)) fail("router_value_cohort_id_invalid");
  if (!REVISION.test(contract.cohort.revision)) fail("router_value_revision_invalid");
  if (!DIGEST.test(contract.cohort.digest)) fail("router_value_digest_invalid");
  finiteNonnegative(contract.policy.latencyP95Ms, "router_value_latency_objective_invalid");
  if (
    contract.policy.requirePerTaskAcceptanceNonRegression !== true ||
    contract.policy.requirePerTaskSecurityNonRegression !== true ||
    contract.policy.requireLowerAcceptedOutputCost !== true
  ) {
    fail("router_value_policy_incomplete");
  }
  if (
    !Array.isArray(contract.observations) ||
    contract.observations.length === 0 ||
    contract.observations.length > ROUTER_VALUE_MAX_OBSERVATIONS
  ) {
    fail("router_value_observations_required");
  }

  const byTask = new Map<string, Map<RouterValueArm, RouterValueObservation>>();
  const evidenceRefs = new Set<string>();
  for (const observation of contract.observations) {
    if (!ID.test(observation.taskId)) fail("router_value_task_id_invalid");
    if (observation.arm !== "baseline" && observation.arm !== "candidate") {
      fail("router_value_arm_invalid");
    }
    if (typeof observation.accepted !== "boolean") fail("router_value_acceptance_invalid");
    finiteNonnegative(observation.securityFindings, "router_value_security_invalid");
    if (!Number.isSafeInteger(observation.securityFindings)) fail("router_value_security_invalid");
    finiteNonnegative(observation.costUsd, "router_value_cost_invalid");
    finiteNonnegative(observation.latencyMs, "router_value_latency_invalid");
    if (
      !Array.isArray(observation.evidenceRefs) ||
      observation.evidenceRefs.length === 0 ||
      observation.evidenceRefs.length > ROUTER_VALUE_MAX_EVIDENCE_REFS_PER_OBSERVATION ||
      observation.evidenceRefs.some(
        (reference) =>
          typeof reference !== "string" || !reference.trim() || reference.length > 512,
      )
    ) {
      fail("router_value_evidence_required");
    }
    const arms = byTask.get(observation.taskId) ?? new Map();
    if (arms.has(observation.arm)) fail("router_value_observation_duplicate");
    arms.set(observation.arm, observation);
    byTask.set(observation.taskId, arms);
    for (const reference of observation.evidenceRefs) evidenceRefs.add(reference);
  }
  if ([...byTask.values()].some((arms) => arms.size !== 2)) {
    fail("router_value_task_arms_incomplete");
  }

  const taskIds = [...byTask.keys()].sort();
  const baseline = taskIds.map((taskId) => byTask.get(taskId)!.get("baseline")!);
  const candidate = taskIds.map((taskId) => byTask.get(taskId)!.get("candidate")!);
  const acceptanceRegressionTaskIds = taskIds.filter((taskId) => {
    const arms = byTask.get(taskId)!;
    return arms.get("baseline")!.accepted && !arms.get("candidate")!.accepted;
  });
  const securityRegressionTaskIds = taskIds.filter((taskId) => {
    const arms = byTask.get(taskId)!;
    return arms.get("candidate")!.securityFindings > arms.get("baseline")!.securityFindings;
  });
  const acceptedOutputCostUsd = {
    baseline: acceptedCost(baseline),
    candidate: acceptedCost(candidate),
  };
  const baselineAccepted = baseline.filter((item) => item.accepted);
  const candidateAccepted = candidate.filter((item) => item.accepted);
  const acceptedOutputCostRegressionTaskIds =
    baselineAccepted.length === 0 || candidateAccepted.length === 0
      ? taskIds.filter((taskId) => {
          const arms = byTask.get(taskId)!;
          return !arms.get("baseline")!.accepted || !arms.get("candidate")!.accepted;
        })
      : acceptedOutputCostUsd.candidate >= acceptedOutputCostUsd.baseline
        ? taskIds.filter((taskId) => {
            const item = byTask.get(taskId)!.get("candidate")!;
            return item.accepted && item.costUsd >= acceptedOutputCostUsd.baseline;
          })
        : [];
  const candidateLatencyP95Ms = nearestRank(candidate.map((item) => item.latencyMs), 0.95);
  const latencyObjectiveExceededTaskIds = taskIds.filter(
    (taskId) =>
      byTask.get(taskId)!.get("candidate")!.latencyMs > contract.policy.latencyP95Ms,
  );
  const acceptance = {
    baseline: rate(baseline.filter((item) => item.accepted).length, baseline.length),
    candidate: rate(candidate.filter((item) => item.accepted).length, candidate.length),
  };
  const ok =
    acceptanceRegressionTaskIds.length === 0 &&
    securityRegressionTaskIds.length === 0 &&
    acceptance.candidate >= acceptance.baseline &&
    acceptedOutputCostRegressionTaskIds.length === 0 &&
    candidateLatencyP95Ms <= contract.policy.latencyP95Ms;

  return Object.freeze({
    version: ROUTER_VALUE_PROOF_VERSION,
    cohortId: contract.cohort.id,
    cohortRevision: contract.cohort.revision,
    cohortDigest: contract.cohort.digest,
    ok,
    taskCount: taskIds.length,
    acceptance,
    acceptanceRegressionTaskIds,
    securityRegressionTaskIds,
    acceptedOutputCostUsd,
    acceptedOutputCostRegressionTaskIds,
    candidateLatencyP95Ms,
    latencyObjectiveMs: contract.policy.latencyP95Ms,
    latencyObjectiveExceededTaskIds,
    evidenceRefs: [...evidenceRefs].sort(),
  });
}
