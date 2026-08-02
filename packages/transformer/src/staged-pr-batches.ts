import { createHash } from "node:crypto";

const SCHEMA_VERSION = "2026-08-02.v1" as const;
const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_PULL_REQUESTS_PER_WAVE = 20;
const MAX_UNITS = 500;
const MAX_TEXT = 1_000;
const PROVIDERS = new Set<StagedPullRequestProvider>([
  "github",
  "gitlab",
  "bitbucket",
  "azure_devops",
]);

export type StagedPullRequestProvider = "github" | "gitlab" | "bitbucket" | "azure_devops";

export type VerifiedStagedPullRequestUnit = {
  id: string;
  title: string;
  repositoryId: string;
  provider: StagedPullRequestProvider;
  baseBranch: string;
  headBranch: string;
  sourceRevision: string;
  candidateRevision: string;
  dependsOn: string[];
  authorId: string;
  evidenceRefs: string[];
  verification: {
    status: "verified" | "failed" | "unknown";
    artifactDigest: string;
    verifiedRevision: string;
    evidenceRefs: string[];
  };
};

export type StagedPullRequestBatchPlanningInput = {
  plannedAt: string;
  campaign: {
    id: string;
    revision: number;
    blueprintId: string;
    blueprintDigest: string;
    state: "ready" | "draft" | "running" | "paused" | "completed";
  };
  policy: {
    maxDraftPullRequestsPerWave: number;
    advanceOn: "merged" | "approved";
    requiredCheckNames: string[];
    reviewerIds: string[];
    minimumApprovals: number;
    prohibitAuthorApproval: boolean;
    requireConversationResolution: boolean;
    closedWithoutMerge: "halt";
    partialWaveMerge: "halt";
  };
  units: VerifiedStagedPullRequestUnit[];
};

export type StagedPullRequestBatchPlan = Readonly<{
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  digest: string;
  plannedAt: string;
  campaign: Readonly<{
    id: string;
    revision: number;
    blueprintId: string;
    blueprintDigest: string;
  }>;
  policy: Readonly<{
    maxDraftPullRequestsPerWave: number;
    advanceOn: "merged" | "approved";
    requiredCheckNames: readonly string[];
    reviewerIds: readonly string[];
    minimumApprovals: number;
    prohibitAuthorApproval: true;
    requireConversationResolution: true;
    closedWithoutMerge: "halt";
    partialWaveMerge: "halt";
  }>;
  waves: readonly Readonly<{
    id: string;
    ordinal: number;
    prerequisiteWaveIds: readonly string[];
    pullRequests: readonly Readonly<{
      id: string;
      unitId: string;
      title: string;
      repositoryId: string;
      provider: StagedPullRequestProvider;
      baseBranch: string;
      headBranch: string;
      sourceRevision: string;
      candidateRevision: string;
      dependsOn: readonly string[];
      authorId: string;
      evidenceRefs: readonly string[];
      artifactDigest: string;
      requiredCheckNames: readonly string[];
      reviewerIds: readonly string[];
      minimumApprovals: number;
      delivery: Readonly<{ draft: true; autoMerge: false; autoDeploy: false }>;
    }>[];
  }>[];
  automation: Readonly<{
    mayCreateDraftAfterReconciliation: true;
    mayMarkReadyForReview: false;
    mayApprove: false;
    mayMerge: false;
    mayDeploy: false;
  }>;
}>;

export type StagedPullRequestBatchPlanningResult =
  | Readonly<{ decision: "planned"; reasons: readonly []; plan: StagedPullRequestBatchPlan }>
  | Readonly<{ decision: "abstained"; reasons: readonly string[]; plan: null }>;

export type StagedPullRequestObservation = {
  unitId: string;
  provider: StagedPullRequestProvider;
  repositoryId: string;
  state: "draft" | "open" | "merged" | "closed";
  isDraft: boolean;
  baseRevision: string;
  headRevision: string;
  approvals: Array<{
    reviewerId: string;
    headRevision: string;
    state: "approved" | "changes_requested" | "dismissed";
  }>;
  checks: Array<{
    name: string;
    headRevision: string;
    status: "queued" | "running" | "success" | "failure" | "cancelled";
  }>;
  unresolvedConversationCount: number;
  evidenceRefs: string[];
};

export type StagedPullRequestResumeSnapshot = {
  planDigest: string;
  campaignRevision: number;
  repositoryHeads: Array<{ repositoryId: string; revision: string; evidenceRefs: string[] }>;
  pullRequests: StagedPullRequestObservation[];
};

export type StagedPullRequestDraftAction = Readonly<{
  type: "open_draft";
  waveId: string;
  unitId: string;
  provider: StagedPullRequestProvider;
  repositoryId: string;
  baseBranch: string;
  headBranch: string;
  expectedBaseRevision: string;
  expectedHeadRevision: string;
  planDigest: string;
  evidenceRefs: readonly string[];
  draft: true;
  autoMerge: false;
  autoDeploy: false;
}>;

export type StagedPullRequestResumeDecision = Readonly<{
  decision: "resume" | "wait" | "halted" | "complete";
  waveId: string | null;
  reasons: readonly string[];
  actions: readonly StagedPullRequestDraftAction[];
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
  const body = JSON.stringify(stableValue(value));
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function add(reasons: Set<string>, reason: string): void {
  reasons.add(reason);
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && value.length <= MAX_TEXT;
}

function requireText(value: unknown, reason: string, reasons: Set<string>): value is string {
  if (validText(value)) return true;
  add(reasons, reason);
  return false;
}

function requireUniqueText(values: unknown, reason: string, reasons: Set<string>): values is string[] {
  if (!Array.isArray(values) || !values.length || values.some((value) => !validText(value))) {
    add(reasons, reason);
    return false;
  }
  if (new Set(values).size !== values.length) {
    add(reasons, reason);
    return false;
  }
  return true;
}

function abstain(reasons: Set<string>): StagedPullRequestBatchPlanningResult {
  return deepFreeze({ decision: "abstained", reasons: [...reasons].sort(), plan: null });
}

function dependencyWaves(
  units: readonly VerifiedStagedPullRequestUnit[],
  maximum: number,
  reasons: Set<string>,
): VerifiedStagedPullRequestUnit[][] {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const completed = new Set<string>();
  const remaining = new Set([...byId.keys()]);
  const waves: VerifiedStagedPullRequestUnit[][] = [];
  while (remaining.size) {
    const repositories = new Set<string>();
    const wave = [...remaining]
      .map((id) => byId.get(id)!)
      .filter((unit) => unit.dependsOn.every((dependency) => completed.has(dependency)))
      .sort((left, right) => left.id.localeCompare(right.id))
      .filter((unit) => {
        if (repositories.has(unit.repositoryId) || repositories.size >= maximum) return false;
        repositories.add(unit.repositoryId);
        return true;
      });
    if (!wave.length) {
      add(reasons, `unit_dependency_cycle:${[...remaining].sort().join(",")}`);
      return [];
    }
    waves.push(wave);
    for (const unit of wave) {
      remaining.delete(unit.id);
      completed.add(unit.id);
    }
  }
  return waves;
}

/**
 * Build an immutable staged delivery contract. It does not read or mutate a
 * repository, contact an SCM provider, approve a review, merge, or deploy.
 */
export function planStagedPullRequestBatches(
  input: StagedPullRequestBatchPlanningInput,
): StagedPullRequestBatchPlanningResult {
  const reasons = new Set<string>();
  if (!input || typeof input !== "object") return abstain(new Set(["planning_input_required"]));
  const plannedEpoch = Date.parse(input.plannedAt);
  if (!Number.isFinite(plannedEpoch) || new Date(plannedEpoch).toISOString() !== input.plannedAt) {
    add(reasons, "planned_at_invalid");
  }
  requireText(input.campaign?.id, "campaign_id_required", reasons);
  requireText(input.campaign?.blueprintId, "blueprint_id_required", reasons);
  if (!Number.isSafeInteger(input.campaign?.revision) || input.campaign.revision < 1) {
    add(reasons, "campaign_revision_invalid");
  }
  if (!DIGEST.test(input.campaign?.blueprintDigest ?? "")) add(reasons, "blueprint_digest_invalid");
  if (input.campaign?.state !== "ready") add(reasons, "campaign_ready_required");

  const policy = input.policy;
  const maximum = policy?.maxDraftPullRequestsPerWave;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_PULL_REQUESTS_PER_WAVE) {
    add(reasons, "pull_request_wave_limit_invalid");
  }
  if (policy?.advanceOn !== "merged" && policy?.advanceOn !== "approved") {
    add(reasons, "advance_policy_invalid");
  }
  requireUniqueText(policy?.requiredCheckNames, "required_checks_invalid", reasons);
  requireUniqueText(policy?.reviewerIds, "reviewers_invalid", reasons);
  if (!Number.isSafeInteger(policy?.minimumApprovals) || policy.minimumApprovals < 1) {
    add(reasons, "minimum_approvals_invalid");
  } else if (Array.isArray(policy.reviewerIds) && policy.minimumApprovals > new Set(policy.reviewerIds).size) {
    add(reasons, "review_approval_count_unreachable");
  }
  if (!policy?.prohibitAuthorApproval) add(reasons, "author_approval_prohibition_required");
  if (!policy?.requireConversationResolution) add(reasons, "conversation_resolution_required");
  if (policy?.closedWithoutMerge !== "halt") add(reasons, "closed_pr_halt_required");
  if (policy?.partialWaveMerge !== "halt") add(reasons, "partial_merge_halt_required");

  const units = Array.isArray(input.units) ? input.units : [];
  if (!units.length || units.length > MAX_UNITS) add(reasons, "unit_count_invalid");
  const byId = new Map<string, VerifiedStagedPullRequestUnit>();
  const branches = new Set<string>();
  for (const unit of units) {
    if (!unit || !requireText(unit.id, "unit_id_invalid", reasons)) continue;
    if (byId.has(unit.id)) add(reasons, `unit_id_conflict:${unit.id}`);
    else byId.set(unit.id, unit);
    requireText(unit.title, `unit_title_required:${unit.id}`, reasons);
    requireText(unit.repositoryId, `unit_repository_required:${unit.id}`, reasons);
    if (!PROVIDERS.has(unit.provider)) add(reasons, `unit_provider_invalid:${unit.id}`);
    requireText(unit.baseBranch, `unit_base_branch_required:${unit.id}`, reasons);
    requireText(unit.headBranch, `unit_head_branch_required:${unit.id}`, reasons);
    requireText(unit.authorId, `unit_author_required:${unit.id}`, reasons);
    if (unit.baseBranch === unit.headBranch) add(reasons, `unit_branch_conflict:${unit.id}`);
    const branchKey = `${unit.provider}:${unit.repositoryId}:${unit.headBranch}`;
    if (branches.has(branchKey)) add(reasons, `unit_head_branch_conflict:${unit.id}`);
    branches.add(branchKey);
    if (!REVISION.test(unit.sourceRevision)) add(reasons, `source_revision_invalid:${unit.id}`);
    if (!REVISION.test(unit.candidateRevision)) add(reasons, `candidate_revision_invalid:${unit.id}`);
    if (unit.sourceRevision === unit.candidateRevision) add(reasons, `candidate_revision_unchanged:${unit.id}`);
    if (!Array.isArray(unit.dependsOn)) add(reasons, `unit_dependencies_invalid:${unit.id}`);
    else if (new Set(unit.dependsOn).size !== unit.dependsOn.length) add(reasons, `unit_dependencies_conflict:${unit.id}`);
    requireUniqueText(unit.evidenceRefs, `unit_evidence_required:${unit.id}`, reasons);
    if (unit.verification?.status !== "verified") add(reasons, `unit_not_verified:${unit.id}`);
    if (!DIGEST.test(unit.verification?.artifactDigest ?? "")) add(reasons, `unit_artifact_digest_invalid:${unit.id}`);
    if (unit.verification?.verifiedRevision !== unit.candidateRevision) {
      add(reasons, `verified_revision_mismatch:${unit.id}`);
    }
    requireUniqueText(unit.verification?.evidenceRefs, `unit_verification_evidence_required:${unit.id}`, reasons);
    const independentReviewers = Array.isArray(policy?.reviewerIds)
      ? policy.reviewerIds.filter((reviewerId) => reviewerId !== unit.authorId)
      : [];
    if (policy?.prohibitAuthorApproval && independentReviewers.length < policy.minimumApprovals) {
      add(reasons, `unit_review_approval_count_unreachable:${unit.id}`);
    }
  }
  for (const unit of byId.values()) {
    for (const dependencyId of unit.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (!dependency) add(reasons, `unit_dependency_missing:${unit.id}:${dependencyId}`);
      if (dependencyId === unit.id) add(reasons, `unit_dependency_self:${unit.id}`);
      if (dependency?.repositoryId === unit.repositoryId && unit.sourceRevision !== dependency.candidateRevision) {
        add(reasons, `same_repository_revision_chain_invalid:${unit.id}:${dependencyId}`);
      }
    }
  }
  if (reasons.size) return abstain(reasons);

  const waves = dependencyWaves([...byId.values()], maximum, reasons);
  if (reasons.size) return abstain(reasons);
  const normalizedPolicy = {
    maxDraftPullRequestsPerWave: maximum,
    advanceOn: policy.advanceOn,
    requiredCheckNames: [...policy.requiredCheckNames].sort(),
    reviewerIds: [...policy.reviewerIds].sort(),
    minimumApprovals: policy.minimumApprovals,
    prohibitAuthorApproval: true as const,
    requireConversationResolution: true as const,
    closedWithoutMerge: "halt" as const,
    partialWaveMerge: "halt" as const,
  };
  const waveContracts = waves.map((wave, index) => ({
    id: `wave-${String(index + 1).padStart(3, "0")}`,
    ordinal: index + 1,
    prerequisiteWaveIds: index === 0 ? [] : [`wave-${String(index).padStart(3, "0")}`],
    pullRequests: wave.map((unit) => ({
      id: `draft-pr-${unit.id}`,
      unitId: unit.id,
      title: unit.title,
      repositoryId: unit.repositoryId,
      provider: unit.provider,
      baseBranch: unit.baseBranch,
      headBranch: unit.headBranch,
      sourceRevision: unit.sourceRevision,
      candidateRevision: unit.candidateRevision,
      dependsOn: [...unit.dependsOn].sort(),
      authorId: unit.authorId,
      evidenceRefs: [...new Set([...unit.evidenceRefs, ...unit.verification.evidenceRefs])].sort(),
      artifactDigest: unit.verification.artifactDigest,
      requiredCheckNames: normalizedPolicy.requiredCheckNames,
      reviewerIds: normalizedPolicy.reviewerIds,
      minimumApprovals: normalizedPolicy.minimumApprovals,
      delivery: { draft: true as const, autoMerge: false as const, autoDeploy: false as const },
    })),
  }));
  const body = {
    schemaVersion: SCHEMA_VERSION,
    plannedAt: input.plannedAt,
    campaign: {
      id: input.campaign.id,
      revision: input.campaign.revision,
      blueprintId: input.campaign.blueprintId,
      blueprintDigest: input.campaign.blueprintDigest,
    },
    policy: normalizedPolicy,
    waves: waveContracts,
    automation: {
      mayCreateDraftAfterReconciliation: true as const,
      mayMarkReadyForReview: false as const,
      mayApprove: false as const,
      mayMerge: false as const,
      mayDeploy: false as const,
    },
  };
  const digest = sha256(body);
  const plan = deepFreeze({
    ...body,
    id: `tfpr_${digest.slice("sha256:".length, "sha256:".length + 24)}`,
    digest,
  }) satisfies StagedPullRequestBatchPlan;
  return deepFreeze({ decision: "planned", reasons: [] as [], plan });
}

function halted(reasons: Set<string>): StagedPullRequestResumeDecision {
  return deepFreeze({ decision: "halted", waveId: null, reasons: [...reasons].sort(), actions: [] });
}

function policyReasons(
  plan: StagedPullRequestBatchPlan,
  pullRequest: StagedPullRequestBatchPlan["waves"][number]["pullRequests"][number],
  observation: StagedPullRequestObservation,
): string[] {
  const reasons: string[] = [];
  const successfulChecks = new Set(observation.checks
    .filter((check) => check.headRevision === pullRequest.candidateRevision && check.status === "success")
    .map((check) => check.name));
  if (pullRequest.requiredCheckNames.some((name) => !successfulChecks.has(name))) {
    reasons.push(`checks_incomplete:${pullRequest.unitId}`);
  }
  const approvals = new Set(observation.approvals
    .filter((approval) => approval.state === "approved")
    .filter((approval) => approval.headRevision === pullRequest.candidateRevision)
    .filter((approval) => pullRequest.reviewerIds.includes(approval.reviewerId))
    .filter((approval) => !plan.policy.prohibitAuthorApproval || approval.reviewerId !== pullRequest.authorId)
    .map((approval) => approval.reviewerId));
  if (approvals.size < pullRequest.minimumApprovals) reasons.push(`reviews_incomplete:${pullRequest.unitId}`);
  if (plan.policy.requireConversationResolution && observation.unresolvedConversationCount !== 0) {
    reasons.push(`conversations_unresolved:${pullRequest.unitId}`);
  }
  return reasons;
}

/**
 * Reconcile a stored plan with an immutable SCM observation. The result is a
 * deterministic authorization proposal. Callers must recheck revisions before
 * executing an open_draft action.
 */
export function reconcileStagedPullRequestResume(
  plan: StagedPullRequestBatchPlan,
  snapshot: StagedPullRequestResumeSnapshot,
): StagedPullRequestResumeDecision {
  const integrity = new Set<string>();
  const planBody = {
    schemaVersion: plan.schemaVersion,
    plannedAt: plan.plannedAt,
    campaign: plan.campaign,
    policy: plan.policy,
    waves: plan.waves,
    automation: plan.automation,
  };
  const calculatedDigest = sha256(planBody);
  if (calculatedDigest !== plan.digest || plan.id !== `tfpr_${calculatedDigest.slice(7, 31)}`) {
    add(integrity, "plan_integrity_invalid");
  }
  if (snapshot.planDigest !== plan.digest) add(integrity, "plan_digest_drift");
  if (snapshot.campaignRevision !== plan.campaign.revision) add(integrity, "campaign_revision_drift");
  const plannedPullRequests = new Map(plan.waves.flatMap((wave) => wave.pullRequests)
    .map((pullRequest) => [pullRequest.unitId, pullRequest]));
  const observed = new Map<string, StagedPullRequestObservation>();
  for (const item of snapshot.pullRequests) {
    const expected = plannedPullRequests.get(item.unitId);
    if (!expected) {
      add(integrity, `unplanned_pr_observation:${item.unitId}`);
      continue;
    }
    if (observed.has(item.unitId)) add(integrity, `duplicate_pr_observation:${item.unitId}`);
    observed.set(item.unitId, item);
    if (item.provider !== expected.provider || item.repositoryId !== expected.repositoryId) {
      add(integrity, `pr_scope_drift:${item.unitId}`);
    }
    if (item.baseRevision !== expected.sourceRevision) add(integrity, `pr_base_revision_drift:${item.unitId}`);
    if (item.headRevision !== expected.candidateRevision) add(integrity, `pr_head_revision_drift:${item.unitId}`);
    if (!item.evidenceRefs.length) add(integrity, `pr_observation_evidence_required:${item.unitId}`);
    if ((item.state === "draft" || item.state === "open") && (!item.isDraft || item.state === "open")) {
      add(integrity, `draft_mode_violated:${item.unitId}`);
    }
    if (!Number.isSafeInteger(item.unresolvedConversationCount) || item.unresolvedConversationCount < 0) {
      add(integrity, `conversation_count_invalid:${item.unitId}`);
    }
  }
  const heads = new Map<string, StagedPullRequestResumeSnapshot["repositoryHeads"][number]>();
  for (const head of snapshot.repositoryHeads) {
    if (heads.has(head.repositoryId)) add(integrity, `repository_head_conflict:${head.repositoryId}`);
    heads.set(head.repositoryId, head);
    if (!REVISION.test(head.revision) || !head.evidenceRefs.length) {
      add(integrity, `repository_head_evidence_invalid:${head.repositoryId}`);
    }
  }
  if (integrity.size) return halted(integrity);

  for (let waveIndex = 0; waveIndex < plan.waves.length; waveIndex++) {
    const wave = plan.waves[waveIndex]!;
    const waveObservations = wave.pullRequests.map((pullRequest) => observed.get(pullRequest.unitId));
    for (const observation of waveObservations) {
      if (observation?.state === "closed") return halted(new Set([`closed_without_merge:${observation.unitId}`]));
    }
    const mergedCount = waveObservations.filter((observation) => observation?.state === "merged").length;
    if (mergedCount > 0 && mergedCount < wave.pullRequests.length) {
      return halted(new Set([`partial_wave_merge:${wave.id}`]));
    }
    const explicitFailures = new Set<string>();
    for (const pullRequest of wave.pullRequests) {
      const observation = observed.get(pullRequest.unitId);
      if (!observation) continue;
      if (observation.checks.some((check) =>
        check.headRevision === pullRequest.candidateRevision &&
        pullRequest.requiredCheckNames.includes(check.name) &&
        (check.status === "failure" || check.status === "cancelled"))) {
        add(explicitFailures, `check_failed:${pullRequest.unitId}`);
      }
      if (observation.approvals.some((approval) =>
        approval.headRevision === pullRequest.candidateRevision && approval.state === "changes_requested")) {
        add(explicitFailures, `review_changes_requested:${pullRequest.unitId}`);
      }
    }
    if (explicitFailures.size) return halted(explicitFailures);
    const gateReasons = wave.pullRequests.flatMap((pullRequest, index) => {
      const observation = waveObservations[index];
      if (!observation) return [`pr_not_opened:${pullRequest.unitId}`];
      const evidenceReasons = policyReasons(plan, pullRequest, observation);
      const stateSatisfied = plan.policy.advanceOn === "merged"
        ? observation.state === "merged"
        : observation.state === "merged" || observation.state === "draft";
      if (!stateSatisfied) evidenceReasons.push(`advance_state_incomplete:${pullRequest.unitId}`);
      return evidenceReasons;
    });
    if (!gateReasons.length) continue;

    const futureUnitIds = new Set(plan.waves.slice(waveIndex + 1)
      .flatMap((futureWave) => futureWave.pullRequests.map((pullRequest) => pullRequest.unitId)));
    const outOfSequence = [...observed.keys()].filter((unitId) => futureUnitIds.has(unitId)).sort();
    if (outOfSequence.length) {
      return halted(new Set(outOfSequence.map((unitId) => `future_wave_observation:${unitId}`)));
    }

    const missing = wave.pullRequests.filter((pullRequest) => !observed.has(pullRequest.unitId));
    if (missing.length) {
      const drift = new Set<string>();
      const actions: StagedPullRequestDraftAction[] = [];
      for (const pullRequest of missing) {
        const head = heads.get(pullRequest.repositoryId);
        if (!head) add(drift, `repository_head_missing:${pullRequest.repositoryId}`);
        else if (head.revision !== pullRequest.sourceRevision) {
          add(drift, `repository_revision_drift:${pullRequest.repositoryId}`);
        }
        actions.push({
          type: "open_draft",
          waveId: wave.id,
          unitId: pullRequest.unitId,
          provider: pullRequest.provider,
          repositoryId: pullRequest.repositoryId,
          baseBranch: pullRequest.baseBranch,
          headBranch: pullRequest.headBranch,
          expectedBaseRevision: pullRequest.sourceRevision,
          expectedHeadRevision: pullRequest.candidateRevision,
          planDigest: plan.digest,
          evidenceRefs: pullRequest.evidenceRefs,
          draft: true,
          autoMerge: false,
          autoDeploy: false,
        });
      }
      if (drift.size) return halted(drift);
      return deepFreeze({ decision: "resume", waveId: wave.id, reasons: [] as string[], actions });
    }
    return deepFreeze({
      decision: "wait",
      waveId: wave.id,
      reasons: [...new Set(gateReasons)].sort(),
      actions: [],
    });
  }
  return deepFreeze({ decision: "complete", waveId: null, reasons: [] as string[], actions: [] });
}
