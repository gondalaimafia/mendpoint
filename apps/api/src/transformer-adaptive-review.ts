import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import { nowIso, WEB_PROXY_RESPONSE_BYTES } from "@mendpoint/shared";
import {
  expireAdaptiveCandidate,
  enqueueAdaptiveDelivery,
  getAdaptiveCandidate,
  getAdaptiveRegenerationByCandidate,
  getAdaptiveDeliveryByCandidate,
  getPrincipal,
  listAdaptiveAttentionCandidates,
  listAdaptiveCandidateHistory,
  recordAudit,
  requestAdaptiveCandidateRegeneration,
  reviewAdaptiveCandidate,
  signOffAdaptiveEscalation,
  type AppDb,
  type AdaptiveCandidateHistoryCursor,
  type TransformerAdaptiveCandidateRecord,
  type TransformerAdaptiveDeliveryRecord,
  type TransformerAdaptiveRegenerationRecord,
} from "@mendpoint/db";
import {
  discardAdaptiveCandidate,
  MAX_ADAPTIVE_REVIEW_TOTAL_BYTES,
  readAdaptiveCandidateArtifact,
} from "@mendpoint/transformer";
import {
  admitRejectedOutcomeLearningRecord,
  rejectedOutcomeCaptureEnabled,
} from "@mendpoint/worker/transformer-learning-rejected";
import { resumeRegaugeMissionTaskAfterReview } from "@mendpoint/worker/regauge-mission-task-claim";
import type { ApiEnv } from "./auth.js";
import {
  internalErrorResponse,
  mappedErrorResponse,
  type PublicErrorRule,
} from "./error-boundary.js";
import { isHumanWardenReviewer } from "./warden-review-auth.js";

/**
 * Transformer adaptive candidate review routes.
 *
 * A converged adaptive fix that DIVERGES from the deterministic recipe output is
 * never auto-promoted. It is surfaced here as a distinct "adaptive candidate"
 * requiring explicit human sign-off — the SAME direct-human rule enforced for
 * Warden review (human principal + human trust record + no apiKeyId). Approval,
 * rejection, and promotion read only the sealed, content-addressed artifact, and
 * the approval response states plainly that what was signed off diverged from the
 * approved recipe output, including the deterministic digest it diverged from and
 * the failing verification that triggered adaptation.
 */

type AdaptiveAuditEvent = Omit<
  Parameters<typeof recordAudit>[1],
  "tenantId" | "principalId" | "apiKeyId" | "requestId"
>;

const MAX_REVIEW_PREVIEW_BYTES = MAX_ADAPTIVE_REVIEW_TOTAL_BYTES * 2;
const EXTERNAL_PROCESSING_AUTHORIZATION_MESSAGE =
  "Explicit customer authorization is required before review feedback can be sent to the configured model.";
const SEMANTIC_CATEGORY_ORDER = [
  "behavior", "tests", "configuration", "dependencies", "security", "documentation", "other",
] as const;

type AdaptiveEvidenceStatus = "verified" | "retention_cleaned" | "corrupt";

const HISTORY_CURSOR_ERRORS = [
  { internalCode: "transformer_adaptive_candidate_history_cursor_invalid", status: 400 },
] satisfies readonly PublicErrorRule[];

const ADAPTIVE_EVIDENCE_CODES = new Set([
  "adaptive_candidate_approval_escape",
  "adaptive_candidate_file_modes_invalid",
  "adaptive_candidate_file_modes_missing",
  "adaptive_candidate_metadata_too_large",
  "adaptive_candidate_preview_binding_mismatch",
  "adaptive_candidate_record_binding_mismatch",
  "adaptive_candidate_review_digest_mismatch",
  "adaptive_candidate_review_evidence_missing",
  "adaptive_candidate_seal_digest_mismatch",
  "adaptive_candidate_seal_invalid",
  "adaptive_candidate_seal_missing",
]);

const ADAPTIVE_EVIDENCE_ERRORS = [...ADAPTIVE_EVIDENCE_CODES].map((internalCode) => ({
  internalCode,
  status: 409 as const,
})) satisfies readonly PublicErrorRule[];

const ADAPTIVE_REVIEW_ERRORS = [
  ...ADAPTIVE_EVIDENCE_ERRORS,
  ...[
    "transformer_adaptive_candidate_decision_invalid",
    "transformer_adaptive_candidate_not_found",
    "transformer_adaptive_candidate_not_pending",
    "transformer_adaptive_candidate_review_conflict",
    "transformer_adaptive_candidate_review_rationale_invalid",
    "transformer_adaptive_candidate_reviewer_invalid",
    "transformer_adaptive_candidate_lineage_conflict",
    "transformer_adaptive_candidate_blocked",
    "transformer_adaptive_candidate_escalation_required",
    "transformer_adaptive_candidate_escalation_not_required",
    "transformer_adaptive_candidate_escalation_conflict",
    "warden_candidate_delivery_conflict",
    "mission_task_review_transition_invalid",
  ].map((internalCode) => ({ internalCode, status: 409 as const })),
  { internalCode: "transformer_adaptive_candidate_expired", status: 410 },
] satisfies readonly PublicErrorRule[];

export type AdaptiveReviewAudit = (c: Context<ApiEnv>, event: AdaptiveAuditEvent) => void;

function tenantOf(c: Context<ApiEnv>): string | undefined {
  return c.get("principal")?.tenantId;
}

function markExpiredIfDue(
  db: AppDb,
  record: TransformerAdaptiveCandidateRecord,
  tenantId: string,
): boolean {
  if (record.status !== "review_pending") return false;
  if (Date.parse(nowIso()) < Date.parse(record.expiresAt)) return false;
  try {
    expireAdaptiveCandidate(db, { tenantId, id: record.id, observedAt: nowIso() });
  } catch {
    // best effort; a concurrent transition wins and callers re-read state
  }
  return true;
}

function deliveryResponse(delivery: TransformerAdaptiveDeliveryRecord) {
  return {
    id: delivery.id,
    status: delivery.status,
    jobId: delivery.jobId,
    branchName: delivery.branchName,
    baseBranch: delivery.baseBranch,
    baseRevision: delivery.baseRevision,
    commitSha: delivery.commitSha,
    draftPr: delivery.draftPr,
    draftPrNumber: delivery.draftPrNumber,
    draftPrUrl: delivery.draftPrUrl,
    errorCode: delivery.errorCode,
    requestedAt: delivery.requestedAt,
    deliveredAt: delivery.deliveredAt,
  };
}

function regenerationResponse(regeneration: TransformerAdaptiveRegenerationRecord) {
  const externalProcessingAuthorizationRequired = regeneration.status === "pending";
  return {
    id: regeneration.id,
    candidateId: regeneration.candidateId,
    campaignId: regeneration.campaignId,
    unitId: regeneration.unitId,
    reviewerPrincipalId: regeneration.reviewerPrincipalId,
    rationale: regeneration.rationale,
    rationaleDigest: regeneration.rationaleDigest,
    status: regeneration.status,
    attemptCount: regeneration.attemptCount,
    lastErrorCode: regeneration.lastErrorCode,
    externalProcessingAuthorizationRequired,
    authorizationMessage: externalProcessingAuthorizationRequired
      ? EXTERNAL_PROCESSING_AUTHORIZATION_MESSAGE
      : null,
    supersedingCandidateId: regeneration.supersedingCandidateId,
    requestedAt: regeneration.requestedAt,
    scheduledAt: regeneration.scheduledAt,
    completedAt: regeneration.completedAt,
  };
}

function candidateSummary(db: AppDb, tenantId: string, candidate: TransformerAdaptiveCandidateRecord) {
  const delivery = getAdaptiveDeliveryByCandidate(db, tenantId, candidate.id);
  const regeneration = getAdaptiveRegenerationByCandidate(db, tenantId, candidate.id);
  return {
    id: candidate.id,
    kind: candidate.kind,
    status: candidate.status,
    reviewTier: candidate.reviewTier,
    campaignId: candidate.campaignId,
    unitId: candidate.unitId,
    attemptId: candidate.attemptId,
    repositoryId: candidate.repositoryId,
    snapshotId: candidate.snapshotId,
    baseBranch: candidate.baseBranch,
    expectedBaseRevision: candidate.expectedBaseRevision,
    candidateDigest: candidate.candidateDigest,
    divergedFromDigest: candidate.divergedFromDigest,
    failingCommandId: candidate.failingCommandId,
    changedFileCount: candidate.changedPaths.length,
    expiresAt: candidate.expiresAt,
    createdAt: candidate.createdAt,
    reviewedAt: candidate.reviewedAt,
    promotedAt: candidate.promotedAt,
    reviewerPrincipalId: candidate.reviewerPrincipalId,
    reviewDecision: candidate.reviewDecision,
    reviewRationale: candidate.reviewRationale,
    escalationReviewerPrincipalId: candidate.escalationReviewerPrincipalId,
    escalationReviewedAt: candidate.escalationReviewedAt,
    escalationRationale: candidate.escalationRationale,
    escalationSignOffRequired:
      candidate.reviewTier === "escalated" && candidate.escalationReviewerPrincipalId === null,
    supersedesCandidateId: candidate.supersedesCandidateId,
    supersededByCandidateId: candidate.supersededByCandidateId,
    generation: candidate.generation,
    ...(regeneration ? { regeneration: regenerationResponse(regeneration) } : {}),
    ...(delivery ? { delivery: deliveryResponse(delivery) } : {}),
  };
}

function encodeHistoryCursor(cursor: AdaptiveCandidateHistoryCursor): string {
  return Buffer.from(JSON.stringify({ version: 1, ...cursor }), "utf8").toString("base64url");
}

function decodeHistoryCursor(value: string | undefined): AdaptiveCandidateHistoryCursor | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > 1_024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("transformer_adaptive_candidate_history_cursor_invalid");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      version?: unknown;
      updatedAt?: unknown;
      id?: unknown;
    };
    if (
      parsed.version !== 1 ||
      typeof parsed.updatedAt !== "string" ||
      new Date(parsed.updatedAt).toISOString() !== parsed.updatedAt ||
      typeof parsed.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(parsed.id)
    ) {
      throw new Error("invalid");
    }
    return Object.freeze({ updatedAt: parsed.updatedAt, id: parsed.id });
  } catch {
    throw new Error("transformer_adaptive_candidate_history_cursor_invalid");
  }
}

function reviewResponse(
  record: TransformerAdaptiveCandidateRecord,
  delivery?: TransformerAdaptiveDeliveryRecord,
  regeneration?: TransformerAdaptiveRegenerationRecord,
) {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    reviewTier: record.reviewTier,
    reviewDecision: record.reviewDecision,
    reviewerPrincipalId: record.reviewerPrincipalId,
    reviewedAt: record.reviewedAt,
    escalationReviewerPrincipalId: record.escalationReviewerPrincipalId,
    escalationReviewedAt: record.escalationReviewedAt,
    escalationRationale: record.escalationRationale,
    candidateDigest: record.candidateDigest,
    divergedFromDigest: record.divergedFromDigest,
    failingCommandId: record.failingCommandId,
    changedPaths: record.changedPaths,
    ...(delivery ? { delivery: deliveryResponse(delivery) } : {}),
    ...(regeneration ? { regeneration: regenerationResponse(regeneration) } : {}),
    reviewRationale: record.reviewRationale,
    supersedesCandidateId: record.supersedesCandidateId,
    supersededByCandidateId: record.supersededByCandidateId,
    generation: record.generation,
    statement: record.reviewDecision === "approve"
      ? "Approved an adaptive candidate that diverged from the approved recipe output " +
        `(diverged from deterministic digest ${record.divergedFromDigest}` +
        `${record.failingCommandId ? `, triggered by failing verification ${record.failingCommandId}` : ""}).`
      : record.reviewDecision === "regenerate"
        ? `Regeneration request recorded. ${EXTERNAL_PROCESSING_AUTHORIZATION_MESSAGE}`
        : "Rejected an adaptive candidate that diverged from the approved recipe output.",
  };
}

function stableAuditId(
  action: string,
  record: TransformerAdaptiveCandidateRecord,
  principalId: string,
): string {
  return `tfadapt_audit_${createHash("sha256")
    .update([record.tenantId, record.id, action, principalId].join("\0"), "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function assertArtifactBinding(
  record: TransformerAdaptiveCandidateRecord,
  artifact: ReturnType<typeof readAdaptiveCandidateArtifact>,
): void {
  const expectedPaths = [...record.changedPaths].sort();
  const artifactPaths = [...artifact.changedPaths].sort();
  if (
    artifact.campaignId !== record.campaignId ||
    artifact.unitId !== record.unitId ||
    artifact.attemptId !== record.attemptId ||
    artifact.repositoryId !== record.repositoryId ||
    artifact.snapshotId !== record.snapshotId ||
    artifact.baseBranch !== record.baseBranch ||
    artifact.expectedBaseRevision !== record.expectedBaseRevision ||
    artifact.divergedFromDigest !== record.divergedFromDigest ||
    artifact.candidateDigest !== record.candidateDigest ||
    artifact.failingCommandId !== record.failingCommandId ||
    JSON.stringify(artifactPaths) !== JSON.stringify(expectedPaths)
  ) {
    throw new Error("adaptive_candidate_record_binding_mismatch");
  }
}

function readBoundArtifact(record: TransformerAdaptiveCandidateRecord) {
  const artifact = readAdaptiveCandidateArtifact({
    tenantId: record.tenantId,
    path: record.sealedPath,
    sha256: record.sealedSha256,
  });
  assertArtifactBinding(record, artifact);
  return artifact;
}

function candidatePreview(artifact: ReturnType<typeof readAdaptiveCandidateArtifact>) {
  let totalBytes = 0;
  const omittedPaths: string[] = [];
  const files: Array<{
    path: string;
    action: "write";
    proposedContent: string;
    mode: "100644" | "100755";
    sha256: string;
    bytes: number;
  }> = [];
  const groups = new Map<string, Array<{
    path: string;
    changeType: "add" | "modify";
    beforeContent: string | null;
    afterContent: string;
    beforeDigest: string;
    afterDigest: string;
    beforeMode: "100644" | "100755" | null;
    afterMode: "100644" | "100755";
    rationale: string;
    risk: "low" | "medium" | "high";
    confidence: number;
    bytes: { before: number; after: number };
  }>>();
  for (const edit of artifact.review.edits) {
    const path = edit.path;
    const content = artifact.files[path];
    const mode = artifact.fileModes[path];
    if (
      typeof content !== "string" ||
      (mode !== "100644" && mode !== "100755")
    ) throw new Error("adaptive_candidate_preview_binding_mismatch");
    const beforeBytes = edit.beforeContent === null ? 0 : Buffer.byteLength(edit.beforeContent, "utf8");
    const afterBytes = Buffer.byteLength(content, "utf8");
    totalBytes += beforeBytes + afterBytes;
    if (totalBytes > MAX_REVIEW_PREVIEW_BYTES) {
      omittedPaths.push(path);
      continue;
    }
    files.push({
      path,
      action: "write",
      proposedContent: content,
      mode,
      sha256: edit.afterDigest,
      bytes: afterBytes,
    });
    const group = groups.get(edit.semanticCategory) ?? [];
    group.push({
      path,
      changeType: edit.changeType,
      beforeContent: edit.beforeContent,
      afterContent: content,
      beforeDigest: edit.beforeDigest,
      afterDigest: edit.afterDigest,
      beforeMode: edit.beforeMode,
      afterMode: edit.afterMode,
      rationale: edit.rationale,
      risk: edit.risk,
      confidence: edit.confidence,
      bytes: { before: beforeBytes, after: afterBytes },
    });
    groups.set(edit.semanticCategory, group);
  }
  const semanticGroups = SEMANTIC_CATEGORY_ORDER
    .filter((category) => groups.has(category))
    .map((category) => ({ category, edits: groups.get(category)! }));
  const complete = omittedPaths.length === 0 && files.length === artifact.changedPaths.length;
  return {
    previewComplete: complete,
    reviewEvidenceComplete: complete,
    totalBytes,
    files,
    omittedPaths,
    semanticReview: {
      groups: semanticGroups,
      verification: artifact.review.verification,
      overallRisk: artifact.review.overallRisk,
      confidence: artifact.review.confidence,
    },
  };
}

function emptyPreview(record: TransformerAdaptiveCandidateRecord) {
  return {
    previewComplete: false,
    reviewEvidenceComplete: false,
    totalBytes: 0,
    files: [],
    omittedPaths: record.changedPaths,
    semanticReview: null,
  };
}

function candidateDetailResponse(
  record: TransformerAdaptiveCandidateRecord,
  delivery: TransformerAdaptiveDeliveryRecord | undefined,
  evidenceStatus: AdaptiveEvidenceStatus,
  evidenceErrorCode: string | null,
  artifact?: ReturnType<typeof readAdaptiveCandidateArtifact>,
  regeneration?: TransformerAdaptiveRegenerationRecord,
) {
  const base = {
    id: record.id,
    kind: record.kind,
    status: record.status,
    reviewTier: record.reviewTier,
    campaignId: record.campaignId,
    unitId: record.unitId,
    attemptId: record.attemptId,
    repositoryId: record.repositoryId,
    snapshotId: record.snapshotId,
    baseBranch: record.baseBranch,
    expectedBaseRevision: record.expectedBaseRevision,
    divergedFromDigest: record.divergedFromDigest,
    candidateDigest: record.candidateDigest,
    failingCommandId: record.failingCommandId,
    changedPaths: record.changedPaths,
    changedFileCount: record.changedPaths.length,
    expiresAt: record.expiresAt,
    reviewDecision: record.reviewDecision,
    reviewerPrincipalId: record.reviewerPrincipalId,
    reviewRationale: record.reviewRationale,
    escalationReviewerPrincipalId: record.escalationReviewerPrincipalId,
    escalationReviewedAt: record.escalationReviewedAt,
    escalationRationale: record.escalationRationale,
    escalationSignOffRequired:
      record.reviewTier === "escalated" && record.escalationReviewerPrincipalId === null,
    supersedesCandidateId: record.supersedesCandidateId,
    supersededByCandidateId: record.supersededByCandidateId,
    generation: record.generation,
    ...(regeneration ? { regeneration: regenerationResponse(regeneration) } : {}),
    sealVerified: evidenceStatus === "verified",
    evidenceStatus,
    evidenceErrorCode,
    ...(delivery ? { delivery: deliveryResponse(delivery) } : {}),
  };
  const preview = artifact ? candidatePreview(artifact) : emptyPreview(record);
  const response = { ...base, ...preview };
  if (Buffer.byteLength(JSON.stringify(response), "utf8") <= WEB_PROXY_RESPONSE_BYTES) {
    return response;
  }
  const bounded = {
    ...base,
    previewComplete: false,
    reviewEvidenceComplete: false,
    totalBytes: preview.totalBytes,
    files: [],
    omittedPaths: record.changedPaths,
    semanticReview: null,
  };
  if (Buffer.byteLength(JSON.stringify(bounded), "utf8") > WEB_PROXY_RESPONSE_BYTES) {
    throw new Error("adaptive_candidate_metadata_too_large");
  }
  return bounded;
}

function terminalEvidence(record: TransformerAdaptiveCandidateRecord): Readonly<{
  status: AdaptiveEvidenceStatus;
  errorCode: string | null;
  artifact?: ReturnType<typeof readAdaptiveCandidateArtifact>;
  internalError?: unknown;
}> {
  try {
    return { status: "verified", errorCode: null, artifact: readBoundArtifact(record) };
  } catch (error) {
    const errorCode = error instanceof Error && ADAPTIVE_EVIDENCE_CODES.has(error.message)
      ? error.message
      : null;
    const intentionallyCleaned =
      (
        record.status === "rejected" ||
        record.status === "expired" ||
        (record.status === "superseded" && Date.parse(record.expiresAt) <= Date.now()) ||
        (record.status === "promoted" && Date.parse(record.expiresAt) <= Date.now())
      ) &&
      errorCode === "adaptive_candidate_seal_missing";
    if (!errorCode) {
      return { status: "corrupt", errorCode: null, internalError: error };
    }
    return intentionallyCleaned
      ? { status: "retention_cleaned", errorCode: null }
      : { status: "corrupt", errorCode };
  }
}

export function registerTransformerAdaptiveReviewRoutes(
  app: Hono<ApiEnv>,
  db: AppDb,
  audit: AdaptiveReviewAudit,
  options: Readonly<{
    regenerationGate?: (tenantId: string) => Readonly<{
      allowed: boolean;
      reasons: readonly string[];
    }>;
    /**
     * Environment used to gate opt-in rejected-outcome learning capture. Defaults
     * to process.env; injected in tests. Default-off means the reject path does no
     * extra work and stays byte-identical to today.
     */
    learningEnv?: NodeJS.ProcessEnv;
  }> = {},
): void {
  const mount = (base: string): void => {
  app.get(`${base}/adaptive-candidates`, (c) => {
    const tenantId = tenantOf(c);
    if (!tenantId) return c.json({ error: "unauthorized" }, 401);
    c.header("Cache-Control", "private, no-store, max-age=0");
    c.header("Pragma", "no-cache");
    const campaignId = c.req.query("campaignId")?.trim() || undefined;
    const rawHistoryLimit = c.req.query("historyLimit");
    const historyLimit = rawHistoryLimit === undefined ? 25 : Number(rawHistoryLimit);
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 100) {
      return c.json({ error: "historyLimit must be an integer from 1 to 100" }, 400);
    }
    let historyCursor: AdaptiveCandidateHistoryCursor | undefined;
    try {
      historyCursor = decodeHistoryCursor(c.req.query("historyCursor"));
    } catch (error) {
      return mappedErrorResponse(c, error, HISTORY_CURSOR_ERRORS);
    }
    const attention = listAdaptiveAttentionCandidates(db, tenantId, campaignId)
      .map((listed) => {
      if (markExpiredIfDue(db, listed, tenantId)) {
        listed = getAdaptiveCandidate(db, tenantId, listed.id) ?? listed;
      }
      return listed;
    })
      .filter((listed) => listed.status === "review_pending" || listed.status === "approved")
      .map((listed) => candidateSummary(db, tenantId, listed));
    const historyPage = listAdaptiveCandidateHistory(db, {
      tenantId,
      campaignId,
      limit: historyLimit,
      cursor: historyCursor,
    });
    return c.json({
      attention,
      history: historyPage.records.map((listed) => candidateSummary(db, tenantId, listed)),
      nextHistoryCursor: historyPage.nextCursor
        ? encodeHistoryCursor(historyPage.nextCursor)
        : null,
    });
  });

  app.get(`${base}/adaptive-candidates/:id`, (c) => {
    const tenantId = tenantOf(c);
    if (!tenantId) return c.json({ error: "unauthorized" }, 401);
    let record = getAdaptiveCandidate(db, tenantId, c.req.param("id"));
    if (!record) return c.json({ error: "not found" }, 404);
    c.header("Cache-Control", "private, no-store, max-age=0");
    c.header("Pragma", "no-cache");
    if (markExpiredIfDue(db, record, tenantId)) {
      record = getAdaptiveCandidate(db, tenantId, record.id) ?? record;
    }
    const delivery = getAdaptiveDeliveryByCandidate(db, tenantId, record.id);
    const regeneration = getAdaptiveRegenerationByCandidate(db, tenantId, record.id);
    if (record.status === "review_pending" || record.status === "approved") {
      // Reverify the sealed artifact byte-for-byte; corrupt stored state fails closed.
      try {
        return c.json(candidateDetailResponse(
          record,
          delivery,
          "verified",
          null,
          readBoundArtifact(record),
          regeneration,
        ));
      } catch (error) {
        return mappedErrorResponse(c, error, ADAPTIVE_EVIDENCE_ERRORS);
      }
    }
    const evidence = terminalEvidence(record);
    if (evidence.internalError) return internalErrorResponse(c, evidence.internalError);
    try {
      return c.json(candidateDetailResponse(
        record,
        delivery,
        evidence.status,
        evidence.errorCode,
        evidence.artifact,
        regeneration,
      ));
    } catch (error) {
      return mappedErrorResponse(c, error, ADAPTIVE_EVIDENCE_ERRORS);
    }
  });

  app.post(`${base}/adaptive-candidates/:id/review`, async (c) => {
    const principal = c.get("principal");
    const tenantId = principal?.tenantId;
    if (!tenantId) return c.json({ error: "unauthorized" }, 401);
    const trustPrincipalId = c.get("trustPrincipalId");
    const trustPrincipal = trustPrincipalId
      ? getPrincipal(db, tenantId, trustPrincipalId)
      : undefined;
    if (!isHumanWardenReviewer(principal, trustPrincipal, tenantId, c.get("apiKeyId"))) {
      return c.json({ error: "human_review_required" }, 403);
    }
    const record = getAdaptiveCandidate(db, tenantId, c.req.param("id"));
    if (!record) return c.json({ error: "not found" }, 404);
    const body: { decision?: unknown; rationale?: unknown } = await c.req
      .json<{ decision?: unknown; rationale?: unknown }>()
      .catch(() => ({}));
    if (body.decision !== "approve" && body.decision !== "reject" && body.decision !== "regenerate") {
      return c.json({ error: "decision must be approve, reject, or regenerate" }, 400);
    }
    const rationale = typeof body.rationale === "string" ? body.rationale.trim() : "";
    if (!rationale || rationale.length > 2_000) {
      return c.json({ error: "review rationale is required and must be at most 2000 characters" }, 400);
    }
    if (markExpiredIfDue(db, record, tenantId)) {
      return c.json({ error: "adaptive_candidate_expired" }, 410);
    }
    const idempotentReview =
      (record.status === "approved" || record.status === "rejected" || record.status === "superseded") &&
      record.reviewDecision === body.decision;
    if (record.status !== "review_pending" && !idempotentReview) {
      return c.json({ error: "adaptive candidate is not awaiting review" }, 409);
    }
    if (body.decision === "approve") {
      // The bytes the reviewer signs off must be intact; a tampered seal fails closed.
      try {
        const preview = candidateDetailResponse(
          record,
          getAdaptiveDeliveryByCandidate(db, tenantId, record.id),
          "verified",
          null,
          readBoundArtifact(record),
          getAdaptiveRegenerationByCandidate(db, tenantId, record.id),
        );
        if (!preview.previewComplete || !preview.reviewEvidenceComplete) {
          return c.json({ error: "adaptive_candidate_review_evidence_incomplete" }, 409);
        }
      } catch (error) {
        return mappedErrorResponse(c, error, ADAPTIVE_EVIDENCE_ERRORS);
      }
    }
    if (body.decision === "regenerate") {
      const gate = options.regenerationGate?.(tenantId);
      if (!gate?.allowed) {
        return c.json({
          error: "transformer_adaptive_regeneration_not_authorized",
          reasons: gate?.reasons ?? ["regeneration_gate_unavailable"],
        }, 409);
      }
    }
    let reviewed: TransformerAdaptiveCandidateRecord;
    let delivery: TransformerAdaptiveDeliveryRecord | undefined;
    let regeneration: TransformerAdaptiveRegenerationRecord | undefined;
    db.raw.exec("BEGIN IMMEDIATE");
    try {
      if (body.decision === "regenerate") {
        const requested = requestAdaptiveCandidateRegeneration(db, {
          tenantId,
          id: record.id,
          reviewerPrincipalId: principal.id,
          rationale,
        });
        reviewed = requested.candidate;
        regeneration = requested.regeneration;
      } else {
        reviewed = reviewAdaptiveCandidate(db, {
          tenantId,
          id: record.id,
          decision: body.decision,
          reviewerPrincipalId: principal.id,
          rationale,
        });
      }
      if (reviewed.status === "approved") {
        resumeRegaugeMissionTaskAfterReview(db, {
          tenantId,
          campaignId: reviewed.campaignId,
          repositoryId: reviewed.repositoryId,
          actorPrincipalId: trustPrincipalId!,
          approvalId: reviewed.id,
          createdAt: nowIso(),
        });
        delivery = enqueueAdaptiveDelivery(db, {
          tenantId,
          candidateId: reviewed.id,
          repositoryId: reviewed.repositoryId,
          snapshotId: reviewed.snapshotId,
          baseBranch: reviewed.baseBranch,
          expectedBaseRevision: reviewed.expectedBaseRevision,
          requesterPrincipalId: reviewed.reviewerPrincipalId ?? principal.id,
        });
      }
      if (reviewed.status !== "expired") {
        audit(c, {
          id: stableAuditId(`review:${body.decision}`, reviewed, principal.id),
          actor: "operator",
          action: body.decision === "approve"
            ? "transformer.adaptive_candidate.approved"
            : body.decision === "regenerate"
              ? "transformer.adaptive_candidate.regeneration_requested"
              : "transformer.adaptive_candidate.rejected",
          resourceType: "transformer_adaptive_candidate",
          resourceId: record.id,
          metadata: {
            decision: body.decision,
            product: "transformer",
            kind: "adaptive",
            divergedFromDigest: record.divergedFromDigest,
            candidateDigest: record.candidateDigest,
            baseBranch: record.baseBranch,
            expectedBaseRevision: record.expectedBaseRevision,
            failingCommandId: record.failingCommandId,
            reviewerPrincipalId: principal.id,
            rationale,
            ...(regeneration
              ? {
                  regenerationId: regeneration.id,
                  regenerationStatus: regeneration.status,
                  rationaleDigest: regeneration.rationaleDigest,
                }
              : {}),
            ...(delivery
              ? {
                  deliveryId: delivery.id,
                  deliveryJobId: delivery.jobId,
                  deliveryStatus: delivery.status,
                }
              : {}),
          },
        });
      }
      db.raw.exec("COMMIT");
    } catch (error) {
      if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
      return mappedErrorResponse(c, error, ADAPTIVE_REVIEW_ERRORS);
    }
    if (reviewed.status === "expired") {
      return c.json({ error: "adaptive_candidate_expired" }, 410);
    }
    if (body.decision === "reject") {
      // Opt-in NEGATIVE capture: read the sealed artifact BEFORE it is discarded
      // and admit a redacted, consent-gated rejected-outcome learning record. It is
      // strictly best-effort and never affects the reject/discard flow. Default-off
      // (loop disabled or no rejected-outcome consent) it does nothing, so the
      // reject path and the corpus stay byte-identical to today.
      const learningEnv = options.learningEnv ?? process.env;
      if (rejectedOutcomeCaptureEnabled(learningEnv)) {
        try {
          const rejectedArtifact = readBoundArtifact(record);
          admitRejectedOutcomeLearningRecord({
            db,
            tenantId,
            candidate: reviewed,
            artifact: rejectedArtifact,
            now: nowIso(),
            env: learningEnv,
          });
        } catch {
          /* best-effort: negative capture never affects reject or discard */
        }
      }
      try {
        discardAdaptiveCandidate({
          tenantId,
          path: record.sealedPath,
          sha256: record.sealedSha256,
        });
      } catch (error) {
        return internalErrorResponse(c, error);
      }
    }
    return c.json(
      reviewResponse(reviewed, delivery, regeneration),
      delivery || regeneration ? 202 : 200,
    );
  });

  app.post(`${base}/adaptive-candidates/:id/escalation-sign-off`, async (c) => {
    const principal = c.get("principal");
    const tenantId = principal?.tenantId;
    if (!tenantId) return c.json({ error: "unauthorized" }, 401);
    // The escalation sign-off is itself a direct-human action: same principal
    // rule as approval. It records the second, distinct sign-off an escalated
    // candidate requires; it NEVER approves, delivers, or merges anything.
    const trustPrincipalId = c.get("trustPrincipalId");
    const trustPrincipal = trustPrincipalId
      ? getPrincipal(db, tenantId, trustPrincipalId)
      : undefined;
    if (!isHumanWardenReviewer(principal, trustPrincipal, tenantId, c.get("apiKeyId"))) {
      return c.json({ error: "human_review_required" }, 403);
    }
    const record = getAdaptiveCandidate(db, tenantId, c.req.param("id"));
    if (!record) return c.json({ error: "not found" }, 404);
    const body: { rationale?: unknown } = await c.req
      .json<{ rationale?: unknown }>()
      .catch(() => ({}));
    const rationale = typeof body.rationale === "string" ? body.rationale.trim() : "";
    if (!rationale || rationale.length > 2_000) {
      return c.json({ error: "escalation rationale is required and must be at most 2000 characters" }, 400);
    }
    if (markExpiredIfDue(db, record, tenantId)) {
      return c.json({ error: "adaptive_candidate_expired" }, 410);
    }
    let signed: TransformerAdaptiveCandidateRecord;
    db.raw.exec("BEGIN IMMEDIATE");
    try {
      signed = signOffAdaptiveEscalation(db, {
        tenantId,
        id: record.id,
        reviewerPrincipalId: principal.id,
        rationale,
      });
      if (signed.status !== "expired") {
        audit(c, {
          id: stableAuditId("escalation_sign_off", signed, principal.id),
          actor: "operator",
          action: "transformer.adaptive_candidate.escalation_signed_off",
          resourceType: "transformer_adaptive_candidate",
          resourceId: record.id,
          metadata: {
            product: "transformer",
            kind: "adaptive",
            reviewTier: record.reviewTier,
            divergedFromDigest: record.divergedFromDigest,
            candidateDigest: record.candidateDigest,
            escalationReviewerPrincipalId: principal.id,
            rationale,
          },
        });
      }
      db.raw.exec("COMMIT");
    } catch (error) {
      if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
      return mappedErrorResponse(c, error, ADAPTIVE_REVIEW_ERRORS);
    }
    if (signed.status === "expired") {
      return c.json({ error: "adaptive_candidate_expired" }, 410);
    }
    return c.json({
      id: signed.id,
      kind: signed.kind,
      status: signed.status,
      reviewTier: signed.reviewTier,
      escalationReviewerPrincipalId: signed.escalationReviewerPrincipalId,
      escalationReviewedAt: signed.escalationReviewedAt,
      escalationRationale: signed.escalationRationale,
      escalationSignOffRequired:
        signed.reviewTier === "escalated" && signed.escalationReviewerPrincipalId === null,
      statement:
        "Recorded a second, distinct human escalation sign-off. Human approval by a " +
        "different reviewer is still required before any draft is delivered; nothing auto-merges.",
    });
  });

  app.post(`${base}/adaptive-candidates/:id/promote`, (c) => {
    const principal = c.get("principal");
    const tenantId = principal?.tenantId;
    if (!tenantId) return c.json({ error: "unauthorized" }, 401);
    const trustPrincipalId = c.get("trustPrincipalId");
    const trustPrincipal = trustPrincipalId
      ? getPrincipal(db, tenantId, trustPrincipalId)
      : undefined;
    if (!isHumanWardenReviewer(principal, trustPrincipal, tenantId, c.get("apiKeyId"))) {
      return c.json({ error: "human_promotion_required" }, 403);
    }
    const record = getAdaptiveCandidate(db, tenantId, c.req.param("id"));
    if (!record) return c.json({ error: "not found" }, 404);
    if (markExpiredIfDue(db, record, tenantId)) {
      return c.json({ error: "adaptive_candidate_expired" }, 410);
    }
    const delivery = getAdaptiveDeliveryByCandidate(db, tenantId, record.id);
    if (record.status === "promoted" && delivery?.status === "delivered") {
      return c.json({
        id: record.id,
        kind: record.kind,
        status: record.status,
        candidateDigest: record.candidateDigest,
        promotedAt: record.promotedAt,
        delivery: deliveryResponse(delivery),
      });
    }
    return c.json({
      error: delivery?.status ?? "adaptive_delivery_required",
      message: "Promotion is performed only by the delivery worker after a draft pull request is proven.",
      ...(delivery ? { delivery: deliveryResponse(delivery) } : {}),
    }, 409);
  });
  };
  // Canonical (Regauge) paths plus the legacy /transformer aliases (kept forever
  // for external/legacy callers). Both register the same handlers.
  mount("/regauge");
  mount("/transformer");
}
