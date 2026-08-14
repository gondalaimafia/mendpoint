import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import { nowIso } from "@mendpoint/shared";
import {
  agentRunToApi,
  enqueueJob,
  enqueueWardenCandidateDelivery,
  enqueueWardenCiUpdate,
  getAgentRun,
  getJob,
  getPrincipal,
  getWardenCandidateDeliveryByRun,
  getWardenCiCycle,
  getWardenCiUpdateByRun,
  insertAgentRun,
  listRepositorySnapshots,
  listWardenCiObservations,
  pauseWardenCiCycle,
  rebindWardenCiRepair,
  recordAudit,
  type AppDb,
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

type AuditEvent = Omit<Parameters<typeof recordAudit>[1], "tenantId" | "principalId" | "apiKeyId" | "requestId">;
export type WardenCandidateReviewAudit = (c: Context<ApiEnv>, event: AuditEvent) => void;
type ReviewDecision = "approve" | "reject" | "regenerate";

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
    "warden_ci_update_not_authorized",
    "warden_ci_update_conflict",
    "warden_ci_repair_rebind_not_authorized",
    "warden_ci_mutation_in_flight",
  ].map((internalCode) => ({ internalCode, status: 409 as const })),
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

function sourceBinding(db: AppDb, tenantId: string, result: Record<string, unknown>) {
  const source = result.source && typeof result.source === "object" ? result.source as Record<string, unknown> : null;
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
  return Object.freeze({ cycle, observation });
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
    const reviewedAt = clock();
    let binding: ReturnType<typeof sourceBinding> | null = null;
    let ciAuthority: ReturnType<typeof ciRepairAuthority> = null;
    if (body.decision === "approve" || (result.ciFailure && typeof result.ciFailure === "object")) {
      try {
        binding = sourceBinding(db, tenantId, result);
        ciAuthority = ciRepairAuthority(db, tenantId, run.id, result, binding.repositoryId);
        if (body.decision === "approve" && ciAuthority) binding = { ...binding, baseBranch: ciAuthority.cycle.baseBranch };
      }
      catch (error) { return mappedErrorResponse(c, error, WARDEN_REVIEW_ERRORS); }
    }
    let seal: Awaited<ReturnType<typeof sealWardenCandidateApproval>> | null = null;
    if (body.decision === "approve") {
      try {
        seal = await sealApproval({
          tenantId, repoPath: run.repo_path, status: run.status, resultJson: run.result_json,
          baseBranch: binding!.baseBranch, reviewerPrincipalId: principal.id, rationale: body.rationale,
        });
      } catch (error) {
        return mappedErrorResponse(c, error, WARDEN_REVIEW_ERRORS);
      }
    }
    const artifacts = result.artifacts && typeof result.artifacts === "object" ? result.artifacts as Record<string, unknown> : {};
    const status = body.decision === "approve" ? "candidate_approved"
      : body.decision === "reject" ? "candidate_rejected" : "candidate_superseded";
    let response: Record<string, unknown>;
    db.raw.exec("BEGIN IMMEDIATE");
    try {
      run = getAgentRun(db, run.id, tenantId)!;
      if (run.status !== "candidate_ready") throw new Error("warden_candidate_review_conflict");
      let reviewedResult: Record<string, unknown>;
      if (body.decision === "regenerate") {
        if (!run.job_id) throw new Error("warden_candidate_source_job_missing");
        const original = getJob(db, run.job_id, tenantId);
        if (!original || original.type !== "agent.run") throw new Error("warden_candidate_source_job_invalid");
        const originalPayload = JSON.parse(original.payload_json) as Record<string, unknown>;
        const next = regenerationIds(tenantId, run.id);
        const nextPayload = { ...originalPayload, sessionId: next.runId, reviewFeedback: body.rationale,
          supersedesRunId: run.id, reviewerPrincipalId: principal.id };
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
          reviewedAt, reviewerPrincipalId: principal.id },
          ...(seal ? { artifacts: { ...artifacts, approval: { path: seal.path, sha256: seal.sha256 } } } : {}),
          ...(body.decision === "reject" ? { cleanup: { status: "pending", attempts: 0 } } : {}) };
        response = { status };
        if (body.decision === "reject" && ciAuthority) {
          pauseWardenCiCycle(db, { tenantId, cycleId: ciAuthority.cycle.id,
            actorPrincipalId: principal.id, reason: "candidate_rejected", observedAt: reviewedAt });
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
            sealedPath: seal!.path, sealedSha256: seal!.sha256, reviewerPrincipalId: principal.id,
            rationale: body.rationale, observedAt: reviewedAt });
          response = { ...response, update };
        } else {
          const delivery = enqueueWardenCandidateDelivery(db, { tenantId, runId: run.id,
            repositoryId: binding!.repositoryId, snapshotId: binding!.snapshotId, baseBranch: binding!.baseBranch,
            expectedBaseRevision: binding!.revision, sealedPath: seal!.path, sealedSha256: seal!.sha256,
            requesterPrincipalId: principal.id, rationale: body.rationale, now: reviewedAt });
          response = { ...response, delivery };
        }
      }
      audit(c, { actor: "operator", action: body.decision === "approve" ? "agent.candidate.approved"
        : body.decision === "reject" ? "agent.candidate.rejected" : "agent.candidate.regeneration_requested",
        resourceType: "agent_run", resourceId: run.id,
        metadata: { decision: body.decision, rationale: body.rationale, product: "warden",
          reviewerPrincipalId: principal.id, ...response } });
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
