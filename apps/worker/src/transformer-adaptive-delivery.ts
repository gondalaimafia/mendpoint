import { createHash } from "node:crypto";
import {
  bindAdaptiveDeliveryIntent,
  completeJob,
  failJob,
  getAdaptiveCandidate,
  getAdaptiveDelivery,
  getAdaptiveDeliveryByCandidate,
  promoteAdaptiveCandidate,
  recordAudit,
  recordAdaptiveDeliveryFailure,
  recordAdaptiveDeliverySuccess,
  type AppDb,
  type JobRow,
  type TransformerAdaptiveCandidateRecord,
  type TransformerAdaptiveDeliveryRecord,
} from "@mendpoint/db";
import {
  readAdaptiveCandidateArtifact,
  type AdaptiveCandidateArtifact,
} from "@mendpoint/transformer";
import {
  admitApprovedOutcomeContentLearningRecord,
  admitApprovedOutcomeLearningRecord,
} from "./transformer-learning-producer.js";
import { admitTransformerGovernedLearningEvent } from "./transformer-governed-learning-producer.js";
import type { GovernedLearningAdmissionResult } from "./governed-learning-producer.js";
import type {
  ExactDraftDeliveryInput,
  ExactDraftDeliveryResult,
  GitHubDelivery,
} from "@mendpoint/github";

const DELIVERY_JOB_TYPE = "transformer.adaptive.deliver";
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

export type TransformerAdaptiveRepositoryTarget = Readonly<{
  owner: string;
  repo: string;
  baseBranch: string;
}>;

export type ResolveTransformerAdaptiveRepository = (
  input: Readonly<{
    tenantId: string;
    repositoryId: string;
    snapshotId: string;
    baseBranch: string;
    expectedBaseRevision: string;
  }>,
) => TransformerAdaptiveRepositoryTarget | Promise<TransformerAdaptiveRepositoryTarget>;

export type TransformerAdaptiveDeliveryWorkerInput = Readonly<{
  db: AppDb;
  job: JobRow;
  github: GitHubDelivery;
  resolveRepository: ResolveTransformerAdaptiveRepository;
  now?: () => string;
  artifactEnv?: NodeJS.ProcessEnv;
}>;

export type TransformerAdaptiveDeliveryWorkerResult =
  | Readonly<{
      status: "delivered";
      candidateId: string;
      deliveryId: string;
      pullRequestNumber: number;
      pullRequestUrl: string;
      commitSha: string;
    }>
  | Readonly<{
      status: "retry_scheduled" | "delivery_failed";
      candidateId: string;
      deliveryId: string;
      errorCode: string;
    }>;

type FailureClassification = Readonly<{
  retryable: boolean;
  remoteSideEffectUncertain: boolean;
  errorCode: string;
  message: string;
}>;

class TransformerAdaptiveDeliveryFinalizationError extends Error {
  readonly remoteSideEffectUncertain = true;

  constructor(readonly cause: unknown) {
    super("transformer_adaptive_delivery_finalization_failed");
    this.name = "TransformerAdaptiveDeliveryFinalizationError";
  }
}

function requireIsoTimestamp(value: string): string {
  if (new Date(value).toISOString() !== value) {
    throw new Error("transformer_adaptive_delivery_timestamp_invalid");
  }
  return value;
}

function parsePayload(payloadJson: string): string {
  let value: unknown;
  try {
    value = JSON.parse(payloadJson);
  } catch {
    throw new Error("transformer_adaptive_delivery_payload_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("transformer_adaptive_delivery_payload_invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    typeof record.candidateId !== "string" ||
    !record.candidateId.trim()
  ) {
    throw new Error("transformer_adaptive_delivery_payload_invalid");
  }
  return record.candidateId;
}

function assertCandidateArtifactBinding(
  candidate: TransformerAdaptiveCandidateRecord,
  artifact: AdaptiveCandidateArtifact,
): void {
  const expectedPaths = [...candidate.changedPaths].sort();
  const artifactPaths = [...artifact.changedPaths].sort();
  if (
    artifact.tenantId !== candidate.tenantId ||
    artifact.campaignId !== candidate.campaignId ||
    artifact.unitId !== candidate.unitId ||
    artifact.attemptId !== candidate.attemptId ||
    artifact.repositoryId !== candidate.repositoryId ||
    artifact.snapshotId !== candidate.snapshotId ||
    artifact.baseBranch !== candidate.baseBranch ||
    artifact.expectedBaseRevision !== candidate.expectedBaseRevision ||
    artifact.divergedFromDigest !== candidate.divergedFromDigest ||
    artifact.candidateDigest !== candidate.candidateDigest ||
    artifact.failingCommandId !== candidate.failingCommandId ||
    JSON.stringify(artifactPaths) !== JSON.stringify(expectedPaths)
  ) {
    throw new Error("transformer_adaptive_delivery_artifact_binding_mismatch");
  }
}

function assertCandidateDeliveryBinding(
  candidate: TransformerAdaptiveCandidateRecord,
  delivery: TransformerAdaptiveDeliveryRecord,
  job: JobRow,
): void {
  if (
    candidate.status !== "approved" ||
    candidate.reviewDecision !== "approve" ||
    !candidate.reviewerPrincipalId ||
    !candidate.reviewRationale ||
    !candidate.reviewedAt ||
    delivery.status !== "delivery_pending" ||
    delivery.tenantId !== candidate.tenantId ||
    delivery.candidateId !== candidate.id ||
    delivery.jobId !== job.id ||
    delivery.repositoryId !== candidate.repositoryId ||
    delivery.snapshotId !== candidate.snapshotId ||
    delivery.baseBranch !== candidate.baseBranch ||
    delivery.expectedBaseRevision !== candidate.expectedBaseRevision
  ) {
    throw new Error("transformer_adaptive_delivery_binding_mismatch");
  }
}

function githubUrl(
  repository: TransformerAdaptiveRepositoryTarget,
  kind: "commit" | "blob",
  revision: string,
  path?: string,
): string {
  const root = `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  if (kind === "commit") return `${root}/commit/${revision}`;
  const encodedPath = path!.split("/").map(encodeURIComponent).join("/");
  return `${root}/blob/${revision}/${encodedPath}`;
}

function quoteMarkdown(value: string): string {
  return value.split("\n").map((line) => `> ${line}`).join("\n");
}

function markdownCell(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/[\r\n]+/g, " ");
}

function structuredReviewRows(artifact: AdaptiveCandidateArtifact): readonly string[] {
  return Object.freeze(artifact.review.edits.map((edit) =>
    `| \`${markdownCell(edit.path)}\` | ${edit.semanticCategory} | ${edit.risk} | ${edit.confidence}% | ${markdownCell(edit.rationale)} |`,
  ));
}

function exactFiles(artifact: AdaptiveCandidateArtifact) {
  return [...artifact.changedPaths]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => {
      const content = artifact.files[path];
      const mode = artifact.fileModes[path];
      if (
        typeof content !== "string" ||
        (mode !== "100644" && mode !== "100755")
      ) {
        throw new Error("transformer_adaptive_delivery_file_mode_missing");
      }
      return Object.freeze({ path, content, mode });
    });
}

function branchName(candidateId: string): string {
  const suffix = createHash("sha256").update(candidateId, "utf8").digest("hex").slice(0, 24);
  return `mendpoint/transformer-${suffix}`;
}

function buildDeliveryIntent(
  candidate: TransformerAdaptiveCandidateRecord,
  delivery: TransformerAdaptiveDeliveryRecord,
  artifact: AdaptiveCandidateArtifact,
  repository: TransformerAdaptiveRepositoryTarget,
): ExactDraftDeliveryInput {
  if (repository.baseBranch !== candidate.baseBranch) {
    throw new Error("transformer_adaptive_delivery_base_branch_mismatch");
  }
  if (
    candidate.reviewDecision !== "approve" ||
    !candidate.reviewerPrincipalId ||
    !candidate.reviewRationale ||
    !candidate.reviewedAt
  ) {
    throw new Error("transformer_adaptive_delivery_review_evidence_missing");
  }
  const title = `Apply approved Regauge candidate ${candidate.id}`;
  const changedPaths = [...candidate.changedPaths].sort((left, right) => left.localeCompare(right));
  const triggeringCheck = candidate.failingCommandId ?? "No failing command was recorded";
  const body = [
    "This draft contains the exact sealed files approved for a Regauge adaptive candidate.",
    "",
    "## Rationale",
    "",
    quoteMarkdown(candidate.reviewRationale),
    "",
    "## Reviewed evidence",
    "",
    `- Candidate: \`${candidate.id}\``,
    `- Reviewed seal: \`${candidate.sealedSha256}\``,
    `- Candidate digest: \`${candidate.candidateDigest}\``,
    `- Deterministic candidate digest: \`${candidate.divergedFromDigest}\``,
    `- Source snapshot: \`${candidate.snapshotId}\``,
    `- Base: \`${candidate.baseBranch}\` at [\`${candidate.expectedBaseRevision}\`](${githubUrl(repository, "commit", candidate.expectedBaseRevision)})`,
    `- Human review: approved by \`${candidate.reviewerPrincipalId}\` at \`${candidate.reviewedAt}\``,
    "- Changed paths at the reviewed base:",
    ...changedPaths.map((path) =>
      `  - [\`${path}\`](${githubUrl(repository, "blob", candidate.expectedBaseRevision, path)})`),
    "",
    "## Structured change evidence",
    "",
    "| Path | Category | Risk | Confidence | Rationale |",
    "| --- | --- | --- | ---: | --- |",
    ...structuredReviewRows(artifact),
    "",
    "## Risk",
    "",
    `- Overall risk: \`${artifact.review.overallRisk}\`.`,
    `- Confidence: \`${artifact.review.confidence}%\`.`,
    `This adaptive result differs from deterministic candidate \`${candidate.divergedFromDigest}\`. Changes are restricted to ${changedPaths.length} reviewed ${changedPaths.length === 1 ? "file" : "files"}. This pull request is a draft and merge remains human controlled.`,
    "",
    "## Verification",
    "",
    "- Result: passed.",
    `- Summary: ${markdownCell(artifact.review.verification.summary)}`,
    `- Command: \`${artifact.review.verification.commandId}\`.`,
    `- Output digest: \`${artifact.review.verification.outputDigest}\`.`,
    `- Adaptive repair converged on candidate digest \`${candidate.candidateDigest}\`.`,
    `- Triggering failed check: \`${triggeringCheck}\`.`,
    "- Delivery reverified the seal SHA, candidate digest, base revision, paths, and contents before creating this draft.",
  ].join("\n");
  return Object.freeze({
    owner: repository.owner,
    repo: repository.repo,
    baseBranch: candidate.baseBranch,
    expectedBaseSha: candidate.expectedBaseRevision,
    branch: branchName(candidate.id),
    commitMessage: title,
    commitDate: delivery.requestedAt,
    title,
    body,
    files: Object.freeze(exactFiles(artifact)),
  });
}

function intentDigest(intent: ExactDraftDeliveryInput): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(intent), "utf8")
    .digest("hex")}`;
}

function classifyFailure(error: unknown): FailureClassification {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = (rawMessage.trim() || "Regauge adaptive delivery failed").slice(0, 2_000);
  const status = (error as { status?: unknown } | null)?.status;
  const code = (error as { code?: unknown } | null)?.code;
  const remoteSideEffectUncertain =
    (error as { remoteSideEffectUncertain?: unknown } | null)?.remoteSideEffectUncertain === true ||
    code === "GITHUB_EXACT_DRAFT_REMOTE_SIDE_EFFECT_UNCERTAIN";
  const retryable =
    remoteSideEffectUncertain ||
    error instanceof TransformerAdaptiveDeliveryFinalizationError ||
    status === 429 ||
    (typeof status === "number" && status >= 500 && status <= 599) ||
    (typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code.toUpperCase())) ||
    /\b(?:timeout|timed out|temporarily unavailable|rate limit)\b/i.test(message);
  return Object.freeze({
    retryable,
    remoteSideEffectUncertain,
    errorCode: remoteSideEffectUncertain
      ? "transformer_adaptive_delivery_remote_side_effect_uncertain"
      : retryable
      ? "transformer_adaptive_delivery_retryable"
      : "transformer_adaptive_delivery_terminal",
    message,
  });
}

function assertDeliveryEvidence(
  expected: ExactDraftDeliveryInput,
  result: ExactDraftDeliveryResult,
): void {
  if (
    result.draft !== true ||
    result.branch !== expected.branch ||
    result.title !== expected.title ||
    result.baseBranch !== expected.baseBranch ||
    result.baseSha !== expected.expectedBaseSha ||
    // Require a real 40-hex commit id, matching Warden's assertEvidence, so an
    // absent or fabricated commit SHA fails closed instead of being persisted
    // as a delivered success.
    !/^[a-f0-9]{40}$/.test(result.commitSha)
  ) {
    throw new Error("transformer_adaptive_delivery_evidence_mismatch");
  }
}

function inOuterTransaction<T>(db: AppDb, operation: () => T): T {
  if (db.raw.isTransaction) {
    throw new Error("transformer_adaptive_delivery_transaction_already_open");
  }
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.raw.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function settleFailure(
  input: TransformerAdaptiveDeliveryWorkerInput,
  delivery: TransformerAdaptiveDeliveryRecord,
  candidateId: string,
  failure: FailureClassification,
): TransformerAdaptiveDeliveryWorkerResult {
  const observedAt = requireIsoTimestamp((input.now ?? (() => new Date().toISOString()))());
  return inOuterTransaction(input.db, () => {
    const currentJob = input.db.raw
      .prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ? AND tenant_id = ?")
      .get(input.job.id, input.job.tenant_id) as
      | { attempts: number; max_attempts: number }
      | undefined;
    if (!currentJob) throw new Error("transformer_adaptive_delivery_job_missing");
    const terminal =
      !failure.retryable ||
      (!failure.remoteSideEffectUncertain && currentJob.attempts >= currentJob.max_attempts);
    const errorCode = terminal && failure.retryable
      ? "transformer_adaptive_delivery_retry_exhausted"
      : failure.errorCode;
    recordAdaptiveDeliveryFailure(input.db, {
      tenantId: input.job.tenant_id,
      deliveryId: delivery.id,
      jobId: input.job.id,
      workerId: input.job.lease_owner ?? "",
      leaseGeneration: input.job.lease_generation,
      observedAt,
      terminal,
      errorCode,
      errorMessage: failure.message,
    });
    const failed = failJob(input.db, input.job.id, failure.message, observedAt, {
      workerId: input.job.lease_owner ?? "",
      leaseGeneration: input.job.lease_generation,
      retryable: failure.retryable,
      retryPastMaxAttempts: failure.remoteSideEffectUncertain,
      errorCode,
    });
    if (!failed.applied) throw new Error("transformer_adaptive_delivery_lease_lost");
    const expectedStatus = terminal ? "dead_letter" : "pending";
    if (failed.status !== expectedStatus) {
      throw new Error("transformer_adaptive_delivery_failure_state_mismatch");
    }
    return Object.freeze({
      status: terminal ? "delivery_failed" : "retry_scheduled",
      candidateId,
      deliveryId: delivery.id,
      errorCode,
    });
  });
}

/**
 * Deliver one approved adaptive candidate as an exact draft pull request.
 *
 * This function intentionally does not claim or renew jobs. Its caller supplies
 * an already claimed job, while every durable mutation is fenced to that lease.
 */
export async function runTransformerAdaptiveDelivery(
  input: TransformerAdaptiveDeliveryWorkerInput,
): Promise<TransformerAdaptiveDeliveryWorkerResult> {
  if (
    input.job.type !== DELIVERY_JOB_TYPE ||
    input.job.status !== "running" ||
    !input.job.lease_owner ||
    !Number.isSafeInteger(input.job.lease_generation) ||
    input.job.lease_generation < 1
  ) {
    throw new Error("transformer_adaptive_delivery_job_invalid");
  }
  const candidateId = parsePayload(input.job.payload_json);
  const delivery = getAdaptiveDeliveryByCandidate(
    input.db,
    input.job.tenant_id,
    candidateId,
  );
  if (!delivery) throw new Error("transformer_adaptive_delivery_not_found");

  try {
    const candidate = getAdaptiveCandidate(input.db, input.job.tenant_id, candidateId);
    if (!candidate) throw new Error("transformer_adaptive_candidate_not_found");
    assertCandidateDeliveryBinding(candidate, delivery, input.job);

    const artifact = readAdaptiveCandidateArtifact({
      tenantId: input.job.tenant_id,
      path: candidate.sealedPath,
      sha256: candidate.sealedSha256,
      env: input.artifactEnv,
    });
    assertCandidateArtifactBinding(candidate, artifact);

    const repository = await input.resolveRepository({
      tenantId: input.job.tenant_id,
      repositoryId: candidate.repositoryId,
      snapshotId: candidate.snapshotId,
      baseBranch: candidate.baseBranch,
      expectedBaseRevision: candidate.expectedBaseRevision,
    });
    const intent = buildDeliveryIntent(candidate, delivery, artifact, repository);
    const beforeDelivery = requireIsoTimestamp(
      (input.now ?? (() => new Date().toISOString()))(),
    );
    bindAdaptiveDeliveryIntent(input.db, {
      tenantId: input.job.tenant_id,
      deliveryId: delivery.id,
      jobId: input.job.id,
      workerId: input.job.lease_owner,
      leaseGeneration: input.job.lease_generation,
      observedAt: beforeDelivery,
      intentDigest: intentDigest(intent),
      branchName: intent.branch,
      baseBranch: intent.baseBranch,
      baseRevision: intent.expectedBaseSha,
    });

    const result = await input.github.deliverExactDraft(intent);
    try {
      assertDeliveryEvidence(intent, result);
      const completedAt = requireIsoTimestamp(
        (input.now ?? (() => new Date().toISOString()))(),
      );
      const delivered = inOuterTransaction(input.db, () => {
        recordAdaptiveDeliverySuccess(input.db, {
        tenantId: input.job.tenant_id,
        deliveryId: delivery.id,
        jobId: input.job.id,
        workerId: input.job.lease_owner!,
        leaseGeneration: input.job.lease_generation,
        observedAt: completedAt,
        commitSha: result.commitSha,
        branchName: result.branch,
        baseBranch: result.baseBranch,
        baseRevision: result.baseSha,
        draftPr: true,
        draftPrNumber: result.number,
        draftPrUrl: result.url,
      });
      const promoted = promoteAdaptiveCandidate(input.db, {
        tenantId: input.job.tenant_id,
        id: candidate.id,
        now: completedAt,
      });
      if (promoted.status !== "promoted") {
        throw new Error("transformer_adaptive_delivery_candidate_not_promoted");
      }
      recordAudit(input.db, {
        id: `tfadapt_delivery_audit_${createHash("sha256")
          .update([input.job.tenant_id, candidate.id, delivery.id].join("\0"), "utf8")
          .digest("hex")
          .slice(0, 32)}`,
        tenantId: input.job.tenant_id,
        actor: "agent",
        requestId: input.job.id,
        action: "transformer.adaptive_candidate.delivered",
        resourceType: "transformer_adaptive_candidate",
        resourceId: candidate.id,
        metadata: {
          deliveryId: delivery.id,
          repositoryId: candidate.repositoryId,
          snapshotId: candidate.snapshotId,
          baseBranch: candidate.baseBranch,
          expectedBaseRevision: candidate.expectedBaseRevision,
          branchName: result.branch,
          commitSha: result.commitSha,
          draftPr: true,
          draftPrNumber: result.number,
          draftPrUrl: result.url,
          requesterPrincipalId: delivery.requesterPrincipalId,
        },
      });
      if (
        !completeJob(
          input.db,
          input.job.id,
          {
            candidateId: candidate.id,
            deliveryId: delivery.id,
            draftPrNumber: result.number,
            draftPrUrl: result.url,
            commitSha: result.commitSha,
          },
          completedAt,
          {
            workerId: input.job.lease_owner!,
            leaseGeneration: input.job.lease_generation,
          },
        )
      ) {
        throw new Error("transformer_adaptive_delivery_lease_lost");
      }
        return Object.freeze({
          status: "delivered",
          candidateId: candidate.id,
          deliveryId: delivery.id,
          pullRequestNumber: result.number,
          pullRequestUrl: result.url,
          commitSha: result.commitSha,
        });
      });
      // Learning admission runs after the delivery is durably committed and is
      // strictly best-effort: it never throws and default-off it does nothing,
      // so the delivered result and all durable state are unchanged.
      try {
        admitApprovedOutcomeLearningRecord({
          db: input.db,
          tenantId: input.job.tenant_id,
          candidate,
          artifact,
          now: completedAt,
          env: input.artifactEnv ?? process.env,
        });
      } catch {
        /* best-effort: learning admission never affects delivery */
      }
      // Opt-in after-content capture: a SEPARATE record under a SEPARATE consent
      // purpose. Default-off (no content consent) it does nothing, so the delivered
      // result, the approved-outcome record, and the base corpus are unchanged.
      try {
        admitApprovedOutcomeContentLearningRecord({
          db: input.db,
          tenantId: input.job.tenant_id,
          candidate,
          artifact,
          now: completedAt,
          env: input.artifactEnv ?? process.env,
        });
      } catch {
        /* best-effort: after-content admission never affects delivery */
      }
      // Additive governed-flywheel emission under the governed consent purpose. A
      // SECOND, parallel record distinct from the legacy admits above; the legacy
      // path is unchanged. Best-effort and default-off, so delivery is untouched.
      try {
        admitTransformerGovernedLearningEvent({
          db: input.db,
          tenantId: input.job.tenant_id,
          candidate,
          artifact,
          // At the delivery seam the outcome is always null (pending); the producer
          // refuses to admit until it resolves to a terminal outcome (merged as a
          // success, closed_unmerged/reverted as an honestly recorded failure).
          deliveryOutcome: delivery.outcome,
          now: completedAt,
          env: input.artifactEnv ?? process.env,
        });
      } catch (error) {
        // Best-effort: governed learning admission never affects delivery, but a
        // swallowed failure must still be diagnosable.
        console.error(
          `governed learning admission failed candidate=${candidate.id} delivery=${delivery.id}`,
          error instanceof Error ? error.message : error,
        );
      }
      return delivered;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "transformer_adaptive_delivery_lease_lost"
      ) {
        throw error;
      }
      throw new TransformerAdaptiveDeliveryFinalizationError(error);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "transformer_adaptive_delivery_lease_lost"
    ) {
      throw error;
    }
    return settleFailure(input, delivery, candidateId, classifyFailure(error));
  }
}

export type ResolvedOutcomeLearningInput = Readonly<{
  db: AppDb;
  tenantId: string;
  deliveryId: string;
  artifactEnv?: NodeJS.ProcessEnv;
  now?: () => string;
}>;

/**
 * Re-invoke the governed learning producer for a delivered ReGauge adaptive
 * candidate whose pull request has reached a terminal outcome (merged /
 * closed_unmerged), recorded on the delivery row by the GitHub outcome webhook. The
 * delivery seam admits nothing because `delivery.outcome` is null there; this seam
 * reloads the delivered candidate and re-verifies its sealed artifact, then invokes
 * the producer with the observed outcome. The outcome is read only from the
 * delivery row (never inferred), the producer refuses anything but `merged`, and
 * admission is idempotent on the candidate — so a redelivered webhook or retried
 * job admits at most once. Best-effort: it never throws.
 */
export function admitTransformerLearningForResolvedOutcome(
  input: ResolvedOutcomeLearningInput,
): GovernedLearningAdmissionResult {
  const now = input.now ?? (() => new Date().toISOString());
  try {
    const delivery = getAdaptiveDelivery(input.db, input.tenantId, input.deliveryId);
    if (!delivery) return Object.freeze({ admitted: false, reason: "delivery_not_found" });
    const candidate = getAdaptiveCandidate(input.db, input.tenantId, delivery.candidateId);
    if (!candidate) return Object.freeze({ admitted: false, reason: "candidate_not_found" });
    const artifact = readAdaptiveCandidateArtifact({
      tenantId: input.tenantId, path: candidate.sealedPath, sha256: candidate.sealedSha256, env: input.artifactEnv,
    });
    assertCandidateArtifactBinding(candidate, artifact);
    return admitTransformerGovernedLearningEvent({
      db: input.db,
      tenantId: input.tenantId,
      candidate,
      artifact,
      deliveryOutcome: delivery.outcome,
      now: now(),
      env: input.artifactEnv ?? process.env,
    });
  } catch (error) {
    return Object.freeze({
      admitted: false,
      reason: `error:${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
