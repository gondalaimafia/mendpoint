import { createHash } from "node:crypto";
import {
  bindWardenCandidateDeliveryIntent,
  completeJob,
  failJob,
  getAgentRun,
  getWardenCandidateDelivery,
  recordAudit,
  recordWardenCandidateDeliveryFailure,
  recordWardenCandidateDeliverySuccess,
  type AppDb,
  type JobRow,
  type WardenCandidateDeliveryRecord,
  enqueueWardenCiCycle,
} from "@mendpoint/db";
import {
  type ExactDraftDeliveryInput,
  type ExactDraftDeliveryResult,
  type GitHubDelivery,
} from "@mendpoint/github";
import { readWardenApprovalArtifact } from "@mendpoint/agent";
import {
  CandidateReviewEvidenceSchema,
  type CandidateReviewEvidence,
} from "@mendpoint/shared";

const JOB_TYPE = "warden.candidate.deliver";

class WardenCandidateDeliveryFinalizationError extends Error {
  readonly remoteSideEffectUncertain = true;

  constructor(readonly cause: unknown) {
    super("warden_candidate_delivery_finalization_failed");
    this.name = "WardenCandidateDeliveryFinalizationError";
  }
}

export type ResolveWardenCandidateRepository = (input: Readonly<{
  tenantId: string; repositoryId: string; snapshotId: string; baseBranch: string; expectedBaseRevision: string;
}>) => Readonly<{ owner: string; repo: string; baseBranch: string; remoteRepositoryId?: number; installationId?: number }> |
  Promise<Readonly<{ owner: string; repo: string; baseBranch: string; remoteRepositoryId?: number; installationId?: number }>>;

export type WardenCandidateDeliveryWorkerInput = Readonly<{
  db: AppDb;
  job: JobRow;
  github: GitHubDelivery;
  resolveRepository: ResolveWardenCandidateRepository;
  artifactEnv?: NodeJS.ProcessEnv;
  now?: () => string;
  ciReentry?: Readonly<{
    requiredChecks: readonly string[];
    maxCycles: number;
    maxModelCalls: number;
    maximumCostUsd: number;
  }>;
}>;

function parsePayload(job: JobRow): { deliveryId: string; runId: string } {
  let value: unknown;
  try { value = JSON.parse(job.payload_json); } catch { throw new Error("warden_candidate_delivery_payload_invalid"); }
  if (!value || typeof value !== "object") throw new Error("warden_candidate_delivery_payload_invalid");
  const record = value as Record<string, unknown>;
  if (typeof record.deliveryId !== "string" || typeof record.runId !== "string") {
    throw new Error("warden_candidate_delivery_payload_invalid");
  }
  return { deliveryId: record.deliveryId, runId: record.runId };
}

function assertArtifact(delivery: WardenCandidateDeliveryRecord, artifact: Record<string, unknown>) {
  if (artifact.tenantId !== delivery.tenantId || artifact.repositoryId !== delivery.repositoryId ||
    artifact.snapshotId !== delivery.snapshotId || artifact.baseBranch !== delivery.baseBranch ||
    artifact.expectedBaseRevision !== delivery.expectedBaseRevision ||
    artifact.reviewerPrincipalId !== delivery.requesterPrincipalId || artifact.rationale !== delivery.rationale) {
    throw new Error("warden_candidate_delivery_artifact_binding_mismatch");
  }
}

function exactFiles(artifact: Record<string, unknown>) {
  const entries = (artifact.candidate as Record<string, unknown> | undefined)?.entries;
  const files = artifact.files;
  if (!Array.isArray(entries) || !Array.isArray(files)) throw new Error("warden_candidate_delivery_artifact_invalid");
  const entryByPath = new Map(entries.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("warden_candidate_delivery_artifact_invalid");
    const entry = raw as Record<string, unknown>;
    if (typeof entry.path !== "string" || typeof entry.sha256 !== "string" ||
      typeof entry.executable !== "boolean" || typeof entry.size !== "number") {
      throw new Error("warden_candidate_delivery_artifact_invalid");
    }
    return [entry.path, entry] as const;
  }));
  return Object.freeze(files.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("warden_candidate_delivery_artifact_invalid");
    const file = raw as Record<string, unknown>;
    if (typeof file.path !== "string" || typeof file.after !== "string" || typeof file.afterSha256 !== "string") {
      throw new Error("warden_candidate_delivery_file_deletion_unsupported");
    }
    const entry = entryByPath.get(file.path);
    if (!entry) throw new Error("warden_candidate_delivery_artifact_invalid");
    const bytes = Buffer.from(file.after, "base64");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== file.afterSha256 || digest !== entry.sha256 || bytes.byteLength !== entry.size || bytes.includes(0)) {
      throw new Error("warden_candidate_delivery_file_digest_mismatch");
    }
    return Object.freeze({
      path: file.path,
      content: bytes.toString("utf8"),
      mode: entry.executable ? "100755" as const : "100644" as const,
    });
  }));
}

function reviewEvidence(artifact: Record<string, unknown>): CandidateReviewEvidence {
  const parsed = CandidateReviewEvidenceSchema.safeParse(artifact.reviewEvidence);
  if (!parsed.success) throw new Error("warden_candidate_delivery_review_evidence_invalid");
  return parsed.data;
}

function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function reviewEvidenceBody(review: CandidateReviewEvidence): string[] {
  return [
    "Reviewed change evidence",
    `Summary: ${singleLine(review.summary)}`,
    ...review.edits.flatMap((edit, index) => [
      `Change ${index + 1}: ${edit.path}`,
      `Category: ${edit.category ? singleLine(edit.category) : "not measured"}`,
      `Rationale: ${edit.rationale ? singleLine(edit.rationale) : "not measured"}`,
      `Risk: ${edit.risk ?? "not measured"}`,
      `Confidence: ${edit.confidence === null ? "not measured" : edit.confidence.toFixed(3)}`,
      `Assessment source: ${edit.assessmentSource}`,
      `Verification: ${singleLine(edit.verification.summary)}`,
      `Verification output digests: ${edit.verification.commandOutputSha256.join(", ")}`,
    ]),
    "Objective verification",
    `Summary: ${singleLine(review.verification.summary)}`,
    ...review.verification.commands.flatMap((command, index) => [
      `Command ${index + 1}: ${singleLine(command.command)}`,
      `Result: passed with exit code ${command.exitCode}`,
      `Output digest: ${command.outputSha256}`,
    ]),
  ];
}

function deliveryIntent(
  delivery: WardenCandidateDeliveryRecord,
  artifact: Record<string, unknown>,
  repository: Readonly<{ owner: string; repo: string; baseBranch: string }>,
  report: string | null,
  review: CandidateReviewEvidence,
): ExactDraftDeliveryInput {
  if (repository.baseBranch !== delivery.baseBranch) throw new Error("warden_candidate_delivery_base_branch_mismatch");
  const suffix = createHash("sha256").update(delivery.runId).digest("hex").slice(0, 24);
  const title = `Apply approved Gauge repair ${delivery.runId}`;
  const body = [
    "This draft contains only the exact files approved in Gauge review.",
    "",
    `Review rationale: ${delivery.rationale}`,
    `Reviewer: ${delivery.requesterPrincipalId}`,
    `Repository snapshot: ${delivery.snapshotId}`,
    `Expected base revision: ${delivery.expectedBaseRevision}`,
    `Approval seal: ${delivery.sealedSha256}`,
    "",
    ...reviewEvidenceBody(review),
    ...(report ? ["", "Verification summary:", report.slice(0, 4_000)] : []),
    "",
    "This pull request is a draft. Mendpoint does not merge or deploy it.",
  ].join("\n");
  return Object.freeze({ owner: repository.owner, repo: repository.repo, baseBranch: delivery.baseBranch,
    expectedBaseSha: delivery.expectedBaseRevision, branch: `mendpoint/warden-${suffix}`,
    commitMessage: title, commitDate: delivery.requestedAt, title, body, files: exactFiles(artifact) });
}

function assertEvidence(intent: ExactDraftDeliveryInput, result: ExactDraftDeliveryResult) {
  if (!result.draft || result.branch !== intent.branch || result.baseBranch !== intent.baseBranch ||
    result.baseSha !== intent.expectedBaseSha || !Number.isSafeInteger(result.number) || result.number < 1 ||
    !/^https:\/\//.test(result.url) || !/^[a-f0-9]{40}$/.test(result.commitSha)) {
    throw new Error("warden_candidate_delivery_evidence_invalid");
  }
}

function intentDigest(intent: ExactDraftDeliveryInput) {
  return `sha256:${createHash("sha256").update(JSON.stringify(intent)).digest("hex")}`;
}

function classifyFailure(error: unknown): Readonly<{
  retryable: boolean;
  remoteSideEffectUncertain: boolean;
  errorCode: string;
  message: string;
}> {
  const status = (error as { status?: unknown } | null)?.status;
  const code = (error as { code?: unknown } | null)?.code;
  const remoteSideEffectUncertain =
    error instanceof WardenCandidateDeliveryFinalizationError ||
    (error as { remoteSideEffectUncertain?: unknown } | null)?.remoteSideEffectUncertain === true ||
    code === "GITHUB_EXACT_DRAFT_REMOTE_SIDE_EFFECT_UNCERTAIN";
  const retryable = remoteSideEffectUncertain || status === 429 ||
    (typeof status === "number" && status >= 500) ||
    (typeof code === "string" && ["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(code.toUpperCase()));
  return Object.freeze({
    retryable,
    remoteSideEffectUncertain,
    errorCode: remoteSideEffectUncertain
      ? "warden_candidate_delivery_remote_side_effect_uncertain"
      : retryable
        ? "warden_candidate_delivery_retryable"
        : "warden_candidate_delivery_terminal",
    message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
  });
}

export async function runWardenCandidateDelivery(input: WardenCandidateDeliveryWorkerInput) {
  if (input.job.type !== JOB_TYPE || input.job.status !== "running" || !input.job.lease_owner || input.job.lease_generation < 1) {
    throw new Error("warden_candidate_delivery_job_invalid");
  }
  const payload = parsePayload(input.job);
  const delivery = getWardenCandidateDelivery(input.db, input.job.tenant_id, payload.deliveryId);
  if (!delivery || delivery.runId !== payload.runId || delivery.jobId !== input.job.id) {
    throw new Error("warden_candidate_delivery_not_found");
  }
  const now = input.now ?? (() => new Date().toISOString());
  try {
    const run = getAgentRun(input.db, payload.runId, input.job.tenant_id);
    if (!run || run.status !== "candidate_approved") throw new Error("warden_candidate_delivery_run_not_approved");
    const artifact = readWardenApprovalArtifact({ tenantId: input.job.tenant_id, path: delivery.sealedPath,
      sha256: delivery.sealedSha256, env: input.artifactEnv });
    assertArtifact(delivery, artifact);
    const reviewedChanges = reviewEvidence(artifact);
    const repository = await input.resolveRepository({ tenantId: delivery.tenantId, repositoryId: delivery.repositoryId,
      snapshotId: delivery.snapshotId, baseBranch: delivery.baseBranch,
      expectedBaseRevision: delivery.expectedBaseRevision });
    const intent = deliveryIntent(delivery, artifact, repository, run.report_md, reviewedChanges);
    bindWardenCandidateDeliveryIntent(input.db, { tenantId: delivery.tenantId, deliveryId: delivery.id,
      intentDigest: intentDigest(intent), branchName: intent.branch, observedAt: now() });
    const remote = await input.github.deliverExactDraft(intent);
    try {
      // Once the remote call returns, GitHub may already contain the draft.
      // Evidence validation and every local finalization setup step therefore
      // belong to the same uncertainty boundary as the durable transaction.
      assertEvidence(intent, remote);
      const completedAt = now();
      input.db.raw.exec("BEGIN IMMEDIATE");
      try {
        recordWardenCandidateDeliverySuccess(input.db, { tenantId: delivery.tenantId, deliveryId: delivery.id,
          branchName: remote.branch, baseRevision: remote.baseSha, commitSha: remote.commitSha,
          draftPrNumber: remote.number, draftPrUrl: remote.url, observedAt: completedAt });
        if (input.ciReentry) {
          if (!repository.remoteRepositoryId || !repository.installationId) {
            throw new Error("warden_ci_repository_identity_required");
          }
          enqueueWardenCiCycle(input.db, {
            tenantId: delivery.tenantId,
            deliveryId: delivery.id,
            repositoryId: delivery.repositoryId,
            remoteRepositoryId: repository.remoteRepositoryId,
            installationId: repository.installationId,
            requiredChecks: input.ciReentry.requiredChecks,
            allowedChangedPaths: reviewedChanges.edits.map((edit) => edit.path),
            maxCycles: input.ciReentry.maxCycles,
            maxModelCalls: input.ciReentry.maxModelCalls,
            maximumCostUsd: input.ciReentry.maximumCostUsd,
            observedAt: completedAt,
          });
        }
        recordAudit(input.db, { id: `warden_delivery_audit_${createHash("sha256").update([delivery.tenantId, delivery.id].join("\0")).digest("hex").slice(0, 32)}`,
          tenantId: delivery.tenantId, actor: "agent", requestId: input.job.id,
          action: "agent.candidate.draft_delivered", resourceType: "agent_run", resourceId: delivery.runId,
          metadata: { deliveryId: delivery.id, repositoryId: delivery.repositoryId, snapshotId: delivery.snapshotId,
            baseBranch: delivery.baseBranch, expectedBaseRevision: delivery.expectedBaseRevision,
            approvalSeal: delivery.sealedSha256, requesterPrincipalId: delivery.requesterPrincipalId,
            reviewEvidenceDigest: `sha256:${createHash("sha256").update(JSON.stringify(reviewedChanges)).digest("hex")}`,
            reviewedChangeCount: reviewedChanges.edits.length,
            branchName: remote.branch, commitSha: remote.commitSha, draftPr: true,
            draftPrNumber: remote.number, draftPrUrl: remote.url } });
        if (!completeJob(input.db, input.job.id, { deliveryId: delivery.id, runId: delivery.runId,
          draftPrNumber: remote.number, draftPrUrl: remote.url, commitSha: remote.commitSha }, completedAt,
        { workerId: input.job.lease_owner, leaseGeneration: input.job.lease_generation })) {
          throw new Error("warden_candidate_delivery_lease_lost");
        }
        input.db.raw.exec("COMMIT");
      } catch (error) {
        if (input.db.raw.isTransaction) input.db.raw.exec("ROLLBACK");
        throw error;
      }
      return Object.freeze({ status: "delivered" as const, runId: delivery.runId, deliveryId: delivery.id,
        pullRequestNumber: remote.number, pullRequestUrl: remote.url, commitSha: remote.commitSha });
    } catch (error) {
      if (error instanceof Error && error.message === "warden_candidate_delivery_lease_lost") throw error;
      throw new WardenCandidateDeliveryFinalizationError(error);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "warden_candidate_delivery_lease_lost") throw error;
    const observedAt = now();
    const failure = classifyFailure(error);
    input.db.raw.exec("BEGIN IMMEDIATE");
    try {
      const failed = failJob(input.db, input.job.id, failure.message, observedAt, { workerId: input.job.lease_owner,
        leaseGeneration: input.job.lease_generation, retryable: failure.retryable,
        retryPastMaxAttempts: failure.remoteSideEffectUncertain,
        errorCode: failure.errorCode });
      if (!failed.applied) throw new Error("warden_candidate_delivery_lease_lost");
      recordWardenCandidateDeliveryFailure(input.db, { tenantId: delivery.tenantId, deliveryId: delivery.id,
        errorCode: failure.errorCode, errorMessage: failure.message,
        terminal: failed.status === "dead_letter", observedAt });
      input.db.raw.exec("COMMIT");
      return Object.freeze({ status: failed.status === "dead_letter" ? "delivery_failed" as const : "retry_scheduled" as const,
        runId: delivery.runId, deliveryId: delivery.id });
    } catch (settlementError) {
      if (input.db.raw.isTransaction) input.db.raw.exec("ROLLBACK");
      throw settlementError;
    }
  }
}
