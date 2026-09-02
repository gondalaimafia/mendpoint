import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import { nowIso } from "@mendpoint/shared";
import { can } from "@mendpoint/platform";
import {
  agentRunToApi,
  enqueueJob,
  enqueueWardenCandidateDelivery,
  enqueueWardenCiUpdate,
  createMissionMutationAuthority,
  getAgentRun,
  getJob,
  getMission,
  getMissionTask,
  getPrincipal,
  getTenantMembership,
  missionTaskIdForJob,
  recordReviewerDirective,
  evaluateMissionExceptions,
  resolveTaskHandoff,
  type SnapshotIdentity,
  getWardenCandidateDeliveryByRun,
  getWardenCiCycle,
  getWardenCiUpdateByRun,
  insertAgentRun,
  listRepositorySnapshots,
  listWardenCiObservations,
  pauseWardenCiCycle,
  rebindWardenCiRepair,
  recordAudit,
  type AgentRunRow,
  type AppDb,
  type MissionMutationAuthorityV1,
} from "@mendpoint/db";
import type { ApiEnv } from "./auth.js";
import {
  mappedErrorResponse,
  type PublicErrorRule,
} from "./error-boundary.js";
import {
  discardWardenCandidate,
  parseWardenCandidateReviewResult,
  sealWardenCandidateApproval,
} from "./warden-candidate.js";
import { isHumanWardenReviewer } from "./warden-review-auth.js";
import { assertDelegatedPrVerificationApprovalAuthority } from "@mendpoint/worker/delegated-pr-verification-job";

type AuditEvent = Omit<Parameters<typeof recordAudit>[1], "tenantId" | "principalId" | "apiKeyId" | "requestId">;
export type WardenCandidateReviewAudit = (c: Context<ApiEnv>, event: AuditEvent) => void;
type ReviewDecision = "approve" | "reject" | "regenerate";

function membershipEvidenceId(tenantId: string, issuer: string, subject: string): string {
  return `membership:${createHash("sha256")
    .update(`${tenantId}\n${issuer}\n${subject}`, "utf8")
    .digest("hex")}`;
}

const REVIEW_INPUT_ERRORS: readonly PublicErrorRule[] = [
  "decision must be approve, reject, or regenerate",
  "review rationale is required",
  "review rationale must be at most 2000 characters",
].map((internalCode) => ({ internalCode, status: 400 as const }));

const WARDEN_REVIEW_ERRORS = [
  ...[
    "warden_candidate_approval_binding_invalid",
    "warden_candidate_approval_conflict",
    "warden_candidate_approval_escape",
    "warden_candidate_approval_too_large",
    "warden_candidate_artifact_escape",
    "warden_candidate_artifact_invalid",
    "warden_candidate_artifact_missing",
    "warden_candidate_binary_file_unsupported",
    "warden_candidate_changed_paths_invalid",
    "warden_candidate_data_root_invalid",
    "warden_candidate_data_root_required",
    "warden_candidate_delivery_binding_mismatch",
    "warden_candidate_delivery_conflict",
    "warden_candidate_delivery_revision_invalid",
    "warden_candidate_delivery_run_invalid",
    "warden_candidate_delivery_run_not_approved",
    "warden_candidate_delivery_seal_invalid",
    "warden_candidate_evidence_root_invalid",
    "warden_candidate_file_too_large",
    "warden_candidate_integrity_failed",
    "warden_candidate_not_ready",
    "warden_candidate_response_too_large",
    "warden_candidate_result_invalid",
    "warden_candidate_review_conflict",
    "warden_candidate_handoff_authority_invalid",
    "warden_candidate_mission_blocked",
    "warden_candidate_mission_product_invalid",
    "warden_candidate_snapshot_binding_mismatch",
    "warden_candidate_source_invalid",
    "warden_candidate_source_job_invalid",
    "warden_candidate_source_job_missing",
    "warden_candidate_symlink_path",
    "warden_candidate_tenant_invalid",
    "warden_candidate_tenant_root_invalid",
    "warden_candidate_tenant_root_escape",
    "warden_candidate_workspace_escape",
    "warden_candidate_workspace_invalid",
    "delegated_pr_verification_authority_invalid",
    "delegated_pr_verification_failed",
    "delegated_pr_verification_pending",
    "warden_ci_update_not_authorized",
    "warden_ci_update_conflict",
    "warden_ci_repair_rebind_not_authorized",
    "warden_ci_budget_exhausted",
    "warden_ci_mutation_in_flight",
  ].map((internalCode) => ({ internalCode, status: 409 as const })),
  { internalCode: "human_review_required", status: 403 },
  { internalCode: "warden_candidate_expired", status: 410 },
] satisfies readonly PublicErrorRule[];

function parseDecision(value: unknown): { decision: ReviewDecision; rationale: string } {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (body.decision !== "approve" && body.decision !== "reject" && body.decision !== "regenerate") {
    throw new Error("decision must be approve, reject, or regenerate");
  }
  if (typeof body.rationale !== "string" || !body.rationale.trim()) throw new Error("review rationale is required");
  const rationale = body.rationale.trim();
  if (rationale.length > 2_000) throw new Error("review rationale must be at most 2000 characters");
  return { decision: body.decision, rationale };
}

function regenerationIds(tenantId: string, runId: string) {
  const digest = createHash("sha256").update([tenantId, runId, "regenerate"].join("\0"), "utf8").digest("hex");
  return { jobId: `warden-regenerate-job-${digest.slice(0, 32)}`, runId: `warden-regenerate-run-${digest.slice(32)}` };
}

const HUMAN_HANDOFF_TASK_STATUSES = new Set([
  "human_review_required",
  "human_assigned",
  "human_working",
]);

/**
 * Close an open agent→human handoff when a bound Mission already has a
 * blocking exception. Unbound review skips (never fabricate a Mission).
 * Reject does not call this: that would send the task to `agent_resume`.
 *
 * The reviewed `agent.run` is bridged onto exactly one MissionTask —
 * `missionTaskIdForJob(run.job_id)` (ADR D3). That is not the campaign
 * enrollment/launch task (`fettlerCampaignMissionTaskId` /
 * `regaugeLaunchMissionTaskId`). Resolving the enrollment blocker with this
 * run's rationale would answer a different question. When `jobId` is missing
 * we SKIP (unknown is not "any single blocker"). When the job task is not
 * among the current blockers we also SKIP — we never fall back to a sibling
 * or enrollment exception. The reviewed run's snapshot is passed to the
 * evaluator so a blocker observed against a superseded snapshot is STALE.
 */
export function tryResolveBoundReviewHandoff(
  db: AppDb,
  input: {
    tenantId: string;
    missionId: string | null;
    jobId: string | null;
    current?: SnapshotIdentity;
    runId: string;
    rationale: string;
    authorPrincipalId: string;
    evidence?: readonly string[];
    correlationId: string;
    createdAt: string;
  },
): { exceptionId: string; taskId: string | null } | undefined {
  if (!input.missionId) return undefined;
  const mission = getMission(db, input.tenantId, input.missionId);
  if (!mission) return undefined;
  const jobId = typeof input.jobId === "string" && input.jobId.trim() ? input.jobId : null;
  if (!jobId) {
    console.warn(JSON.stringify({
      event: "warden_review_handoff_resolution_skipped",
      reason: "reviewed_run_job_unknown",
      tenantId: input.tenantId,
      missionId: input.missionId,
      runId: input.runId,
    }));
    return undefined;
  }
  const expectedTaskId = missionTaskIdForJob(jobId);
  const blocking = evaluateMissionExceptions(db, input.tenantId, input.missionId, input.current).blocking;
  const candidates = blocking.filter((exception) => {
    if (exception.taskId !== expectedTaskId) return false;
    const task = getMissionTask(db, input.tenantId, exception.taskId);
    return Boolean(task && HUMAN_HANDOFF_TASK_STATUSES.has(task.status));
  });
  if (candidates.length !== 1) {
    // TELEMETRY GAP (deliberate; follow-up work, not this change): only the
    // blocking-but-unmatched case is reported. When `blocking` is empty this
    // returns silently, and that is the path that always fires in production
    // today, because nothing currently opens a task-bound blocking Mission
    // exception for this resolver to close.
    if (blocking.length > 0) {
      console.warn(JSON.stringify({
        event: "warden_review_handoff_resolution_skipped",
        tenantId: input.tenantId,
        missionId: input.missionId,
        runId: input.runId,
        jobId,
        expectedTaskId,
        blockingCount: blocking.length,
        candidateCount: candidates.length,
      }));
    }
    return undefined;
  }
  const match = candidates[0]!;
  const taskId = match.taskId ?? undefined;
  resolveTaskHandoff(db, {
    tenantId: input.tenantId,
    priorExceptionId: match.id,
    resolutionNote: input.rationale,
    decision: input.rationale,
    scope: `handoff_resolution:${input.runId}`,
    authorPrincipalId: input.authorPrincipalId,
    ...(input.evidence && input.evidence.length > 0 ? { evidence: input.evidence } : {}),
    ...(taskId ? { taskId } : {}),
    correlationId: input.correlationId,
    createdAt: input.createdAt,
  });
  return { exceptionId: match.id, taskId: match.taskId };
}


/**
 * Mint the durable Mission authority for a review that actually resolved the
 * run's own task-bound handoff. A skipped resolution (main's #516 rule: no
 * bound Mission, unknown job, or no single matching blocker on
 * `missionTaskIdForJob(run.job_id)`) mints nothing and the review proceeds
 * unbound, exactly as it does today. This never fabricates authority.
 */
function missionAuthorityAfterResolution(
  db: AppDb,
  tenantId: string,
  missionId: string | null,
  resolution: { exceptionId: string; taskId: string | null } | undefined,
  binding: NonNullable<CandidateReviewAuthority["binding"]>,
): MissionMutationAuthorityV1 | null {
  if (!missionId || !resolution) return null;
  const mission = getMission(db, tenantId, missionId);
  if (!mission) throw new Error("warden_candidate_handoff_authority_invalid");
  const task = resolution.taskId ? getMissionTask(db, tenantId, resolution.taskId) ?? null : null;
  if (resolution.taskId && !task) throw new Error("warden_candidate_handoff_authority_invalid");
  return createMissionMutationAuthority({ mission, task, repositoryId: binding.repositoryId,
    snapshotId: binding.snapshotId, resolvedSha: binding.revision });
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceBinding(db: AppDb, tenantId: string, result: Record<string, unknown>) {
  const source = plainObject(result.source) ? result.source : null;
  const repositoryId = typeof source?.repositoryId === "string" ? source.repositoryId : "";
  const snapshotId = typeof source?.snapshotId === "string" ? source.snapshotId : "";
  const revision = typeof source?.revision === "string" ? source.revision : "";
  const snapshot = repositoryId && snapshotId
    ? listRepositorySnapshots(db, tenantId, repositoryId).find((row) => row.id === snapshotId)
    : undefined;
  if (!snapshot || snapshot.resolved_sha !== revision || !snapshot.requested_ref) {
    throw new Error("warden_candidate_snapshot_binding_mismatch");
  }
  return { repositoryId, snapshotId, revision, baseBranch: snapshot.requested_ref };
}

function ciRepairAuthority(db: AppDb, tenantId: string, runId: string, result: Record<string, unknown>, repositoryId: string) {
  if (!result.ciFailure || typeof result.ciFailure !== "object" || Array.isArray(result.ciFailure)) return null;
  const failure = result.ciFailure as Record<string, unknown>;
  const cycleId = typeof failure.cycleId === "string" ? failure.cycleId : "";
  const cycle = cycleId ? getWardenCiCycle(db, tenantId, cycleId) : undefined;
  if (!cycle || cycle.status !== "repair_pending" || cycle.repairRunId !== runId ||
      cycle.repositoryId !== repositoryId || failure.deliveryId !== cycle.deliveryId ||
      failure.pullRequestNumber !== cycle.pullRequestNumber || failure.failedHeadSha !== cycle.currentHeadSha ||
      failure.observationDigest !== cycle.currentObservationDigest) {
    throw new Error("warden_ci_update_not_authorized");
  }
  const observation = listWardenCiObservations(db, tenantId, cycle.id).find((candidate) =>
    candidate.verdict === "failure" && candidate.headSha === cycle.currentHeadSha &&
    candidate.observationDigest === cycle.currentObservationDigest);
  if (!observation || failure.evidenceArtifactId !== observation.evidenceArtifactId ||
      failure.evidenceDigest !== observation.evidenceDigest) throw new Error("warden_ci_update_not_authorized");
  const trigger = failure.trigger === undefined ? "ci_failure" : failure.trigger;
  const reviewFeedbackDigest: string | null = typeof failure.reviewFeedbackDigest === "string"
    ? failure.reviewFeedbackDigest : null;
  if ((trigger !== "ci_failure" && trigger !== "review_feedback") ||
      (trigger === "review_feedback" && (typeof reviewFeedbackDigest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(reviewFeedbackDigest))) ||
      (trigger === "ci_failure" && failure.reviewFeedbackDigest !== undefined && failure.reviewFeedbackDigest !== null)) {
    throw new Error("warden_ci_update_not_authorized");
  }
  return Object.freeze({ cycle, observation, trigger, reviewFeedbackDigest });
}

type CandidateReviewAuthority = Readonly<{
  run: AgentRunRow;
  result: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  candidateDigest: string;
  candidateManifestSha256: string;
  binding: ReturnType<typeof sourceBinding> | null;
  ciAuthority: ReturnType<typeof ciRepairAuthority>;
  sourcePayload: Record<string, unknown> | null;
  missionId: string | null;
  fingerprint: string;
}>;

function parseSourceJobPayload(
  db: AppDb,
  tenantId: string,
  run: AgentRunRow,
  required: boolean,
): { payload: Record<string, unknown>; raw: string } | null {
  if (!run.job_id) {
    if (required) throw new Error("warden_candidate_source_job_missing");
    return null;
  }
  const sourceJob = getJob(db, run.job_id, tenantId);
  if (!sourceJob || sourceJob.type !== "agent.run") {
    if (required) throw new Error("warden_candidate_source_job_invalid");
    return null;
  }
  try {
    const parsed = JSON.parse(sourceJob.payload_json) as unknown;
    if (!plainObject(parsed)) throw new Error("warden_candidate_source_job_invalid");
    return { payload: parsed, raw: sourceJob.payload_json };
  } catch {
    throw new Error("warden_candidate_source_job_invalid");
  }
}

function parseReviewedFiles(run: AgentRunRow): readonly string[] {
  try {
    if (!run.files_changed_json) throw new Error("warden_candidate_review_conflict");
    const parsed = JSON.parse(run.files_changed_json) as unknown;
    if (!Array.isArray(parsed) || parsed.some((path) => typeof path !== "string" || !path.trim())) {
      throw new Error("warden_candidate_review_conflict");
    }
    return Object.freeze(parsed.map((path) => path.trim()));
  } catch (error) {
    if (error instanceof Error && error.message === "warden_candidate_review_conflict") throw error;
    throw new Error("warden_candidate_review_conflict");
  }
}

function candidateReviewAuthority(
  db: AppDb,
  input: { tenantId: string; runId: string; decision: ReviewDecision },
): CandidateReviewAuthority {
  const run = getAgentRun(db, input.runId, input.tenantId);
  if (!run) throw new Error("warden_candidate_review_conflict");
  const result = parseWardenCandidateReviewResult(run.result_json);
  const artifacts = plainObject(result.artifacts) ? result.artifacts : {};
  const candidateDigest = typeof artifacts.candidateDigest === "string" ? artifacts.candidateDigest : "";
  const candidateManifestSha256 = typeof artifacts.candidateManifestSha256 === "string"
    ? artifacts.candidateManifestSha256
    : "";
  const sourceJob = parseSourceJobPayload(db, input.tenantId, run,
    input.decision === "approve" || input.decision === "regenerate");
  const missionValue = sourceJob?.payload.missionId;
  if (missionValue !== undefined && (typeof missionValue !== "string" || !missionValue.trim())) {
    throw new Error("warden_candidate_source_job_invalid");
  }
  const missionId = typeof missionValue === "string" ? missionValue : null;
  const mission = missionId ? getMission(db, input.tenantId, missionId) : undefined;
  if (missionId && !mission) throw new Error("warden_candidate_snapshot_binding_mismatch");
  if (mission && mission.product !== "fettler") throw new Error("warden_candidate_mission_product_invalid");
  if (mission && ["accepted", "rejected", "partial", "failed", "cancelled"].includes(mission.state)) {
    throw new Error("warden_candidate_review_conflict");
  }
  const hasCiFailure = plainObject(result.ciFailure);
  let binding = input.decision === "approve" || hasCiFailure
    ? sourceBinding(db, input.tenantId, result)
    : null;
  const ciAuthority = binding && hasCiFailure
    ? ciRepairAuthority(db, input.tenantId, run.id, result, binding.repositoryId)
    : null;
  if (input.decision === "approve" && binding && ciAuthority) {
    binding = { ...binding, baseBranch: ciAuthority.cycle.baseBranch };
  }
  const reviewedFiles = parseReviewedFiles(run);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    run: {
      id: run.id,
      tenantId: run.tenant_id,
      jobId: run.job_id,
      repoPath: run.repo_path,
      status: run.status,
      resultJson: run.result_json,
      filesChangedJson: run.files_changed_json,
    },
    reviewedFiles,
    sourceJobRaw: sourceJob?.raw ?? null,
    binding,
    candidateDigest,
    candidateManifestSha256,
    mission: mission ? {
      id: mission.id,
      product: mission.product,
      state: mission.state,
      revision: mission.revision,
      repositoryId: mission.repositoryId,
      snapshotId: mission.snapshotId,
    } : null,
    ciAuthority,
  }), "utf8").digest("hex");
  return Object.freeze({ run, result, artifacts, candidateDigest, candidateManifestSha256,
    binding, ciAuthority, sourcePayload: sourceJob?.payload ?? null, missionId, fingerprint });
}

function rejectedApproachScopes(run: AgentRunRow, candidateDigest: string): string[] {
  let files: unknown = [];
  try {
    files = run.files_changed_json ? JSON.parse(run.files_changed_json) : [];
  } catch {
    files = [];
  }
  const paths = Array.isArray(files)
    ? [...new Set(files.filter((path): path is string => typeof path === "string" && path.trim().length > 0)
      .map((path) => path.trim()))]
    : [];
  if (paths.length > 0) return paths;
  if (candidateDigest) return [`candidate:${candidateDigest}`];
  return [`reviewer_reject:${run.id}`];
}

function persistRejectedApproachDecisions(db: AppDb, input: {
  tenantId: string;
  run: AgentRunRow;
  rationale: string;
  candidateDigest: string;
  authorPrincipalId: string;
  createdAt: string;
}): void {
  if (!input.run.job_id) return;
  const original = getJob(db, input.run.job_id, input.tenantId);
  if (!original || original.type !== "agent.run") return;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(original.payload_json) as Record<string, unknown>;
  } catch {
    return;
  }
  // Raw `payload.missionId`, deliberately, and the same read every authority
  // reader now uses. This writes a reviewer directive for an already-bound
  // Mission; it grants nothing and gates nothing, so an unbound read here can
  // only mean "record no directive", never "allow a mutation".
  const missionId = typeof payload.missionId === "string" ? payload.missionId : null;
  if (!missionId || !getMission(db, input.tenantId, missionId)) return;
  const evidence = [
    `agent_run:${input.run.id}`,
    ...(input.candidateDigest ? [`candidate:${input.candidateDigest}`] : []),
  ];
  for (const scope of rejectedApproachScopes(input.run, input.candidateDigest)) {
    recordReviewerDirective(db, {
      tenantId: input.tenantId,
      missionId,
      directive: input.rationale,
      scope,
      authorPrincipalId: input.authorPrincipalId,
      evidence,
      correlationId: input.run.id,
      createdAt: input.createdAt,
      decisionType: "other",
    });
  }
}

export function registerWardenCandidateReviewRoutes(
  app: Hono<ApiEnv>,
  db: AppDb,
  audit: WardenCandidateReviewAudit,
  options: {
    now?: () => string;
    sealApproval?: typeof sealWardenCandidateApproval;
  } = {},
): void {
  const clock = options.now ?? nowIso;
  const sealApproval = options.sealApproval ?? sealWardenCandidateApproval;
  const requireHuman = (c: Context<ApiEnv>) => {
    const principal = c.get("principal");
    if (!principal) return null;
    const trustId = c.get("trustPrincipalId");
    const trust = trustId ? getPrincipal(db, principal.tenantId, trustId) : undefined;
    return isHumanWardenReviewer(principal, trust, principal.tenantId, c.get("apiKeyId"))
      ? principal : null;
  };

  app.get("/agent/ci-cycles/:id", (c) => {
    const principal = requireHuman(c);
    if (!principal) return c.json({ error: c.get("principal") ? "human_review_required" : "authenticated_principal_required" },
      c.get("principal") ? 403 : 401);
    const cycle = getWardenCiCycle(db, principal.tenantId, c.req.param("id"));
    if (!cycle) return c.json({ error: "not found" }, 404);
    return c.json({ cycle, observations: listWardenCiObservations(db, principal.tenantId, cycle.id),
      update: cycle.repairRunId ? getWardenCiUpdateByRun(db, principal.tenantId, cycle.repairRunId) ?? null : null });
  });

  app.post("/agent/ci-cycles/:id/pause", async (c) => {
    const principal = requireHuman(c);
    if (!principal) return c.json({ error: c.get("principal") ? "human_review_required" : "authenticated_principal_required" },
      c.get("principal") ? 403 : 401);
    const body = await c.req.json<unknown>().catch(() => null);
    const reason = body && typeof body === "object" && typeof (body as Record<string, unknown>).reason === "string"
      ? String((body as Record<string, unknown>).reason).trim() : "";
    if (!reason) return c.json({ error: "pause reason is required" }, 400);
    if (reason.length > 2_000) return c.json({ error: "pause reason must be at most 2000 characters" }, 400);
    try {
      const cycle = pauseWardenCiCycle(db, { tenantId: principal.tenantId, cycleId: c.req.param("id"),
        actorPrincipalId: principal.id, reason, observedAt: clock() });
      audit(c, { actor: "operator", action: "agent.ci_cycle.paused", resourceType: "warden_ci_cycle",
        resourceId: cycle.id, metadata: { reason, product: "warden", actorPrincipalId: principal.id } });
      return c.json({ cycle });
    } catch (error) {
      if (error instanceof Error && error.message === "warden_ci_cycle_not_found") {
        return c.json({ error: "not found" }, 404);
      }
      return mappedErrorResponse(c, error, [
        { internalCode: "warden_ci_cycle_terminal", status: 409 },
        { internalCode: "warden_ci_mutation_in_flight", status: 409 },
        { internalCode: "warden_ci_pause_actor_invalid", status: 400 },
        { internalCode: "warden_ci_pause_reason_invalid", status: 400 },
      ]);
    }
  });

  app.post("/agent/runs/:id/candidate/review", async (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
    const tenantId = principal.tenantId;
    const trustId = c.get("trustPrincipalId");
    const trust = trustId ? getPrincipal(db, tenantId, trustId) : undefined;
    if (!isHumanWardenReviewer(principal, trust, tenantId, c.get("apiKeyId"))) {
      return c.json({ error: "human_review_required" }, 403);
    }
    const issuer = trust?.audience ?? "";
    const subjectPrefix = issuer ? `${issuer}|` : "";
    const subject = trust?.subject.startsWith(subjectPrefix) ? trust.subject.slice(subjectPrefix.length) : "";
    const membership = issuer && subject ? getTenantMembership(db, tenantId, issuer, subject) : undefined;
    const approvalMembershipEvidenceId = issuer && subject
      ? membershipEvidenceId(tenantId, issuer, subject)
      : "";
    if (c.get("authMethod") !== "oidc" || !membership || membership.status !== "active" ||
        c.get("membershipEvidenceId") !== approvalMembershipEvidenceId) {
      return c.json({ error: "human_review_required" }, 403);
    }
    let body: { decision: ReviewDecision; rationale: string };
    try { body = parseDecision(await c.req.json<unknown>().catch(() => null)); }
    catch (error) { return mappedErrorResponse(c, error, REVIEW_INPUT_ERRORS); }
    let run = getAgentRun(db, c.req.param("id"), tenantId);
    if (!run) return c.json({ error: "not found" }, 404);
    let result: Record<string, unknown>;
    try { result = parseWardenCandidateReviewResult(run.result_json); }
    catch (error) { return mappedErrorResponse(c, error, WARDEN_REVIEW_ERRORS); }
    const prior = result.review && typeof result.review === "object" ? result.review as Record<string, unknown> : null;
    if (prior?.decision === body.decision && prior.rationale === body.rationale) {
      if (body.decision === "regenerate" && typeof prior.supersedingRunId === "string" && typeof prior.supersedingJobId === "string") {
        return c.json({ status: run.status, supersedingRunId: prior.supersedingRunId, supersedingJobId: prior.supersedingJobId, replayed: true }, 202);
      }
      return c.json({ ...agentRunToApi(run), delivery: getWardenCandidateDeliveryByRun(db, tenantId, run.id) ?? null,
        update: getWardenCiUpdateByRun(db, tenantId, run.id) ?? null });
    }
    if (run.status !== "candidate_ready") return c.json({ error: "candidate is not awaiting review" }, 409);
    let initialAuthority: CandidateReviewAuthority;
    try { initialAuthority = candidateReviewAuthority(db, { tenantId, runId: run.id, decision: body.decision }); }
    catch (error) { return mappedErrorResponse(c, error, WARDEN_REVIEW_ERRORS); }
    run = initialAuthority.run;
    result = initialAuthority.result;
    let binding = initialAuthority.binding;
    let ciAuthority = initialAuthority.ciAuthority;
    let artifacts = initialAuthority.artifacts;
    let candidateDigest = initialAuthority.candidateDigest;
    let candidateManifestSha256 = initialAuthority.candidateManifestSha256;
    let seal: Awaited<ReturnType<typeof sealWardenCandidateApproval>> | null = null;
    if (body.decision === "approve") {
      if (!candidateDigest || !candidateManifestSha256) {
        return mappedErrorResponse(c, new Error("warden_candidate_approval_binding_invalid"), WARDEN_REVIEW_ERRORS);
      }
      if (!run.job_id) {
        return mappedErrorResponse(c, new Error("warden_candidate_source_job_missing"), WARDEN_REVIEW_ERRORS);
      }
      try {
        assertDelegatedPrVerificationApprovalAuthority(db, {
          tenantId, runId: run.id, sourceJobId: run.job_id, candidateDigest,
        });
      } catch (error) {
        return mappedErrorResponse(c, error, WARDEN_REVIEW_ERRORS);
      }
      try {
        seal = await sealApproval({
          tenantId, repoPath: run.repo_path, status: run.status, resultJson: run.result_json,
          baseBranch: binding!.baseBranch, reviewerPrincipalId: trustId!, rationale: body.rationale,
        });
      } catch (error) {
        return mappedErrorResponse(c, error, WARDEN_REVIEW_ERRORS);
      }
    }
    const status = body.decision === "approve" ? "candidate_approved"
      : body.decision === "reject" ? "candidate_rejected" : "candidate_superseded";
    let response: Record<string, unknown>;
    db.raw.exec("BEGIN IMMEDIATE");
    try {
      const reviewedAt = clock();
      // The reviewed run's own source snapshot, read from its recorded result.
      // Available on regenerate as well as approve, unlike `binding`, which is
      // only computed for approve/CI. Passed to the exception evaluator so a
      // blocker observed against a superseded snapshot reads as STALE.
      const reviewedSource = plainObject(result.source) ? result.source : null;
      const reviewedSnapshot: SnapshotIdentity | undefined =
        typeof reviewedSource?.snapshotId === "string" && typeof reviewedSource?.revision === "string"
          ? { snapshotId: reviewedSource.snapshotId, resolvedSha: reviewedSource.revision }
          : undefined;
      const currentTrust = trustId ? getPrincipal(db, tenantId, trustId) : undefined;
      const currentMembership = issuer && subject ? getTenantMembership(db, tenantId, issuer, subject) : undefined;
      const reviewedAtMs = Date.parse(reviewedAt);
      const principalCreatedAtMs = currentTrust ? Date.parse(currentTrust.created_at) : Number.NaN;
      const currentPrincipalActive = Boolean(currentTrust && currentTrust.kind === "human" &&
        currentTrust.tenant_id === tenantId && currentTrust.audience === issuer &&
        currentTrust.subject === `${issuer}|${subject}` && currentTrust.revoked_at === null &&
        Number.isFinite(principalCreatedAtMs) && principalCreatedAtMs <= reviewedAtMs &&
        (!currentTrust.expires_at || Date.parse(currentTrust.expires_at) > reviewedAtMs));
      if (!Number.isFinite(reviewedAtMs) || new Date(reviewedAtMs).toISOString() !== reviewedAt ||
           !currentPrincipalActive ||
           !currentMembership || currentMembership.status !== "active" ||
           !can({ id: principal.id, tenantId, role: currentMembership.role }, "plan:edit") ||
           c.get("authMethod") !== "oidc" ||
          c.get("membershipEvidenceId") !== approvalMembershipEvidenceId) {
        throw new Error("human_review_required");
      }
      const currentAuthority = candidateReviewAuthority(db, { tenantId, runId: run.id, decision: body.decision });
      if (currentAuthority.fingerprint !== initialAuthority.fingerprint) {
        throw new Error("warden_candidate_review_conflict");
      }
      run = currentAuthority.run;
      result = currentAuthority.result;
      binding = currentAuthority.binding;
      ciAuthority = currentAuthority.ciAuthority;
      artifacts = currentAuthority.artifacts;
      candidateDigest = currentAuthority.candidateDigest;
      candidateManifestSha256 = currentAuthority.candidateManifestSha256;
      if (run.status !== "candidate_ready") throw new Error("warden_candidate_review_conflict");
      if (body.decision === "approve") {
        if (!run.job_id) throw new Error("warden_candidate_source_job_missing");
        assertDelegatedPrVerificationApprovalAuthority(db, {
          tenantId, runId: run.id, sourceJobId: run.job_id, candidateDigest,
        });
      }
      let reviewedResult: Record<string, unknown>;
      let missionAuthority: MissionMutationAuthorityV1 | null = null;
      if (body.decision === "regenerate") {
        if (!run.job_id || !currentAuthority.sourcePayload) throw new Error("warden_candidate_source_job_missing");
        const originalPayload = currentAuthority.sourcePayload;
        const next = regenerationIds(tenantId, run.id);
        // First real caller of the mission decision store. When this regenerate is
        // part of a formal mission, record the reviewer's directive as a durable
        // ACTIVE decision so EVERY prior cycle's guidance survives for the resumed
        // run to inherit through the compiled envelope — not only the latest
        // cycle's rationale by string concatenation. Scoped by the superseded run
        // so distinct cycles stay distinct active decisions. The rationale is
        // untrusted reviewer text: stored as data, and it only ever reaches a
        // model inside the compiler's untrusted-data fence. A Fettler repair with
        // no mission bound skips this — the mission is never fabricated.
        const regenerateMissionId = currentAuthority.missionId;
        if (regenerateMissionId) {
          recordReviewerDirective(db, {
            tenantId,
            missionId: regenerateMissionId,
            directive: body.rationale,
            scope: `reviewer_directive:${run.id}`,
            authorPrincipalId: trustId!,
            evidence: [`agent_run:${run.id}`, ...(candidateDigest ? [`candidate:${candidateDigest}`] : [])],
            correlationId: next.runId,
            createdAt: reviewedAt,
            decisionType: "verification",
          });
          const resolution = tryResolveBoundReviewHandoff(db, {
            tenantId,
            missionId: regenerateMissionId,
            jobId: run.job_id,
            ...(reviewedSnapshot ? { current: reviewedSnapshot } : {}),
            runId: run.id,
            rationale: body.rationale,
            authorPrincipalId: trustId!,
            evidence: [`agent_run:${run.id}`, ...(candidateDigest ? [`candidate:${candidateDigest}`] : [])],
            correlationId: next.runId,
            createdAt: reviewedAt,
          });
          // Authority needs the exact validated repository/snapshot binding. A
          // regenerate with no such binding resolves the handoff but mints no
          // authority, leaving the successor unbound exactly as main leaves it.
          missionAuthority = binding
            ? missionAuthorityAfterResolution(db, tenantId, regenerateMissionId, resolution, binding)
            : null;
        }
        const nextPayload = { ...originalPayload, sessionId: next.runId, reviewFeedback: body.rationale,
          supersedesRunId: run.id, reviewerPrincipalId: principal.id,
          ...(missionAuthority ? { missionId: missionAuthority.missionId, missionAuthority } : {}) };
        enqueueJob(db, { id: next.jobId, tenantId, type: "agent.run", payload: nextPayload, createdAt: reviewedAt });
        insertAgentRun(db, { id: next.runId, tenantId, jobId: next.jobId, goal: run.goal, repoPath: run.repo_path,
          status: "queued", ok: false, steps: 0, filesChanged: [], reportMd: null,
          resultJson: JSON.stringify({ jobId: next.jobId, product: "warden", supersedesRunId: run.id,
            regenerationFeedback: body.rationale, reviewerPrincipalId: principal.id }),
          createdAt: reviewedAt, finishedAt: null });
        if (ciAuthority) {
          rebindWardenCiRepair(db, { tenantId, cycleId: ciAuthority.cycle.id,
            currentRepairRunId: run.id, nextRepairRunId: next.runId, nextRepairJobId: next.jobId,
            observedAt: reviewedAt });
        }
        reviewedResult = { ...result, review: { decision: body.decision, rationale: body.rationale,
          reviewedAt, reviewerPrincipalId: principal.id, supersedingRunId: next.runId, supersedingJobId: next.jobId },
          supersededByRunId: next.runId, cleanup: { status: "pending", attempts: 0 } };
        response = { status, supersedingRunId: next.runId, supersedingJobId: next.jobId };
      } else {
        reviewedResult = { ...result, review: { decision: body.decision, rationale: body.rationale,
          reviewedAt, reviewerPrincipalId: body.decision === "approve" ? trustId! : principal.id,
          ...(body.decision === "approve" ? {
            trustPrincipalId: trustId!,
            authMethod: "oidc",
            membershipEvidenceId: approvalMembershipEvidenceId,
          } : {}) },
          ...(seal ? { artifacts: { ...artifacts, approval: { path: seal.path, sha256: seal.sha256 } } } : {}),
          ...(body.decision === "reject" ? { cleanup: { status: "pending", attempts: 0 } } : {}) };
        response = { status };
        if (body.decision === "reject") {
          persistRejectedApproachDecisions(db, {
            tenantId,
            run,
            rationale: body.rationale,
            candidateDigest,
            authorPrincipalId: trustId!,
            createdAt: reviewedAt,
          });
          if (ciAuthority) {
            pauseWardenCiCycle(db, { tenantId, cycleId: ciAuthority.cycle.id,
              actorPrincipalId: principal.id, reason: "candidate_rejected", observedAt: reviewedAt });
          }
        }
        if (body.decision === "approve") {
          if (!binding) throw new Error("warden_candidate_snapshot_binding_mismatch");
          const resolution = tryResolveBoundReviewHandoff(db, {
            tenantId,
            missionId: currentAuthority.missionId,
            jobId: run.job_id,
            ...(reviewedSnapshot ? { current: reviewedSnapshot } : {}),
            runId: run.id,
            rationale: body.rationale,
            authorPrincipalId: trustId!,
            evidence: [`agent_run:${run.id}`, ...(candidateDigest ? [`candidate:${candidateDigest}`] : [])],
            correlationId: run.id,
            createdAt: reviewedAt,
          });
          missionAuthority = missionAuthorityAfterResolution(db, tenantId, currentAuthority.missionId,
            resolution, binding);
          if (currentAuthority.missionId && evaluateMissionExceptions(db, tenantId,
            currentAuthority.missionId, { snapshotId: binding.snapshotId, resolvedSha: binding.revision }).missionBlocked) {
            throw new Error("warden_candidate_mission_blocked");
          }
        }
      }
      const updated = db.raw.prepare(
        `UPDATE agent_runs SET status = ?, result_json = ?, finished_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'candidate_ready'`,
      ).run(status, JSON.stringify(reviewedResult), reviewedAt, run.id, tenantId);
      if (Number(updated.changes) !== 1) throw new Error("warden_candidate_review_conflict");
      if (body.decision === "approve") {
        if (ciAuthority) {
          const update = enqueueWardenCiUpdate(db, { tenantId, cycleId: ciAuthority.cycle.id,
            repairRunId: run.id, expectedHeadSha: ciAuthority.cycle.currentHeadSha,
            expectedFeedbackDigest: ciAuthority.reviewFeedbackDigest,
            sealedPath: seal!.path, sealedSha256: seal!.sha256, reviewerPrincipalId: trustId!,
            rationale: body.rationale, observedAt: reviewedAt,
            ...(missionAuthority ? { missionAuthority } : {}) });
          response = { ...response, update };
        } else {
          const delivery = enqueueWardenCandidateDelivery(db, { tenantId, runId: run.id,
            repositoryId: binding!.repositoryId, snapshotId: binding!.snapshotId, baseBranch: binding!.baseBranch,
            expectedBaseRevision: binding!.revision, sealedPath: seal!.path, sealedSha256: seal!.sha256,
            requesterPrincipalId: trustId!, rationale: body.rationale, now: reviewedAt,
            ...(missionAuthority ? { missionAuthority } : {}) });
          response = { ...response, delivery };
        }
      }
      audit(c, { actor: "operator", action: body.decision === "approve" ? "agent.candidate.approved"
        : body.decision === "reject" ? "agent.candidate.rejected" : "agent.candidate.regeneration_requested",
        resourceType: "agent_run", resourceId: run.id,
        metadata: { decision: body.decision, rationale: body.rationale, product: "warden",
          reviewerPrincipalId: body.decision === "approve" ? trustId! : principal.id,
          ...(body.decision === "approve" ? {
            trustPrincipalId: trustId!,
            authMethod: "oidc",
            membershipEvidenceId: approvalMembershipEvidenceId,
            reviewedAt,
            candidateDigest,
            candidateManifestSha256,
          } : {}),
          ...response } });
      db.raw.exec("COMMIT");
    } catch (error) {
      if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
      // Never unlink a content-addressed seal from a losing review. A concurrent
      // committed winner may reference the same path; offline reconciliation is
      // the only component allowed to reap unreferenced approval artifacts.
      return mappedErrorResponse(c, error, WARDEN_REVIEW_ERRORS);
    }
    if (body.decision === "reject" || body.decision === "regenerate") {
      try {
        discardWardenCandidate({ tenantId, status: "candidate_ready", resultJson: run.result_json });
        db.raw.prepare(
          `UPDATE agent_runs SET result_json = json_set(result_json, '$.cleanup.status', 'cleaned', '$.cleanup.cleanedAt', ?)
           WHERE id = ? AND tenant_id = ?`,
        ).run(clock(), run.id, tenantId);
      } catch { /* durable pending cleanup is retried by maintenance */ }
    }
    return c.json(response, body.decision === "approve" || body.decision === "regenerate" ? 202 : 200);
  });
}
