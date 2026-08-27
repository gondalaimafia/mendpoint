import { createHash } from "node:crypto";
import { redactSourceForModel } from "@mendpoint/agent";
import {
  assertMissionMutationAuthority,
  completeJob,
  enqueueJob,
  failJob,
  getAgentRun,
  getJob,
  getPrincipal,
  getWardenCandidateDelivery,
  getWardenCiCycle,
  insertArtifactManifest,
  insertEvidenceRecord,
  pauseWardenCiCycle,
  recordWardenCiObservation,
  type AppDb,
  type JobRow,
} from "@mendpoint/db";
import {
  EXACT_DRAFT_OBSERVATION_EVIDENCE_VERSION,
  ExactDraftCheckResult,
  ExactDraftFailure,
  ExactDraftObservation,
  type ExactDraftObservationEvidenceV1,
  ExactDraftObservationInput,
} from "@mendpoint/github";
import { assertDelegatedPrVerificationApprovalAuthority,
  type DelegatedPrVerificationApprovalAuthority } from "./delegated-pr-verification-job.js";

const JOB_TYPE = "warden.candidate.observe";
export const WARDEN_CANDIDATE_CLEANUP_JOB_TYPE = "warden.candidate.cleanup";
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAX_FIELD_CHARS = 2_000;
const MAX_REVIEW_FEEDBACK_BYTES = 64 * 1_024;
const MAX_EVIDENCE_BYTES = 128 * 1_024;
const REVIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const REVIEWER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export type WardenCandidateObservationInput = Readonly<{
  db: AppDb;
  job: JobRow;
  observe: (input: ExactDraftObservationInput) => Promise<ExactDraftObservation>;
  persistEvidence: (bytes: Uint8Array) => Promise<Readonly<{ artifactId: string; digest: string }>>;
  resolveRepository: (input: Readonly<{
    tenantId: string;
    repositoryId: string;
    installationId: number;
    remoteRepositoryId: number;
  }>) => Readonly<{ owner: string; repo: string }> | Promise<Readonly<{ owner: string; repo: string }>>;
  now?: () => string;
}>;

function parsePayload(job: JobRow): Readonly<{ cycleId: string; deliveryId: string }> {
  let value: unknown;
  try { value = JSON.parse(job.payload_json); } catch { throw new Error("warden_ci_observation_payload_invalid"); }
  if (!value || typeof value !== "object") throw new Error("warden_ci_observation_payload_invalid");
  const record = value as Record<string, unknown>;
  if (typeof record.cycleId !== "string" || typeof record.deliveryId !== "string") {
    throw new Error("warden_ci_observation_payload_invalid");
  }
  return Object.freeze({ cycleId: record.cycleId, deliveryId: record.deliveryId });
}

function assertJob(job: JobRow): void {
  if (job.type !== JOB_TYPE || job.status !== "running" || !job.lease_owner || job.lease_generation < 1) {
    throw new Error("warden_ci_observation_job_invalid");
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validRepositoryPath(value: string): boolean {
  return value.length > 0 && value.length <= 1_000 && !value.startsWith("/") && !value.endsWith("/") &&
    !value.includes("\\") && !value.includes("//") && value.split("/").every((part) =>
      part.length > 0 && part !== "." && part !== ".." && !/[\u0000-\u001f]/.test(part));
}

type RequiredDelegatedAuthority = Extract<DelegatedPrVerificationApprovalAuthority, { required: true }>;

function persistCanonicalObservation(input: Readonly<{ db: AppDb; tenantId: string; observationId: string;
  artifactId: string; observationDigest: string; bytes: Uint8Array; authority: RequiredDelegatedAuthority;
  observedAt: string }>): void {
  if (!input.db.raw.isTransaction) throw new Error("warden_ci_observation_transaction_required");
  const principal = getPrincipal(input.db, input.tenantId, input.authority.candidateProducerPrincipalId);
  if (!principal || principal.kind !== "service" || principal.created_at > input.observedAt ||
      principal.revoked_at && principal.revoked_at <= input.observedAt ||
      principal.expires_at && principal.expires_at <= input.observedAt ||
      !REVISION.test(input.authority.candidateProducerVersion)) {
    throw new Error("warden_ci_observation_producer_invalid");
  }
  const content = Buffer.from(input.bytes).toString("utf8");
  insertArtifactManifest(input.db, { id: input.artifactId, tenantId: input.tenantId,
    kind: "delegated_pr_github_observation", schemaVersion: 1,
    sha256: input.observationDigest.slice("sha256:".length),
    mediaType: "application/vnd.mendpoint.github-exact-draft-observation+json",
    sizeBytes: Buffer.byteLength(content, "utf8"), storageRef: `sqlite://${input.artifactId}`,
    content, producerPrincipalId: input.authority.candidateProducerPrincipalId, createdAt: input.observedAt });
  const evidenceId = `evidence_github_observation_${createHash("sha256")
    .update([input.tenantId, input.observationId, input.artifactId, input.observationDigest].join("\0"), "utf8")
    .digest("hex").slice(0, 40)}`;
  insertEvidenceRecord(input.db, { id: evidenceId, tenantId: input.tenantId,
    subjectType: "delegated_pr_github_observation", subjectId: input.observationId,
    artifactId: input.artifactId, inputArtifactId: input.authority.candidateArtifactId,
    producerPrincipalId: input.authority.candidateProducerPrincipalId, tool: "mendpoint-exact-github-observer",
    toolVersion: input.authority.candidateProducerVersion, commitSha: input.authority.candidateProducerVersion,
    verdict: "passed", createdAt: input.observedAt });
}

function cleanupJobId(input: Readonly<{
  tenantId: string;
  cycleId: string;
  headSha: string;
  observationDigest: string;
}>): string {
  return `wardencicleanupjob_${createHash("sha256")
    .update([input.tenantId, input.cycleId, input.headSha, input.observationDigest].join("\0"), "utf8")
    .digest("hex").slice(0, 32)}`;
}

function enqueueDelegatedCleanupHandoff(input: Readonly<{
  db: AppDb;
  tenantId: string;
  cycleId: string;
  deliveryId: string;
  observationId: string;
  headSha: string;
  observationDigest: string;
  evidenceArtifactId: string;
  evidenceBytes: Uint8Array;
  observedAt: string;
}>): string | null {
  if (!input.db.raw.isTransaction) throw new Error("warden_ci_cleanup_transaction_required");
  const delivery = getWardenCandidateDelivery(input.db, input.tenantId, input.deliveryId);
  const run = delivery ? getAgentRun(input.db, delivery.runId, input.tenantId) : undefined;
  let result: Record<string, unknown> | null = null;
  try { result = run?.result_json ? JSON.parse(run.result_json) as Record<string, unknown> : null; }
  catch { throw new Error("warden_ci_cleanup_run_invalid"); }
  const artifacts = result?.artifacts && typeof result.artifacts === "object" && !Array.isArray(result.artifacts)
    ? result.artifacts as Record<string, unknown>
    : null;
  const candidateDigest = typeof artifacts?.candidateDigest === "string" ? artifacts.candidateDigest : "";
  if (!delivery || delivery.status !== "delivered" || !run?.job_id || !result) {
    throw new Error("warden_ci_cleanup_run_invalid");
  }
  const authority = assertDelegatedPrVerificationApprovalAuthority(input.db, {
    tenantId: input.tenantId,
    runId: run.id,
    sourceJobId: run.job_id,
    candidateDigest,
  });
  if (!authority.required) return null;
  persistCanonicalObservation({ db: input.db, tenantId: input.tenantId,
    observationId: input.observationId, artifactId: input.evidenceArtifactId,
    observationDigest: input.observationDigest, bytes: input.evidenceBytes, authority,
    observedAt: input.observedAt });
  const id = cleanupJobId(input);
  const payload = {
    schemaVersion: 1,
    cycleId: input.cycleId,
    deliveryId: input.deliveryId,
    observationId: input.observationId,
    headSha: input.headSha,
    observationDigest: input.observationDigest,
  };
  const payloadJson = JSON.stringify(payload);
  const existing = getJob(input.db, id, input.tenantId);
  if (existing) {
    if (existing.type !== WARDEN_CANDIDATE_CLEANUP_JOB_TYPE || existing.payload_json !== payloadJson ||
        existing.max_attempts !== 20 || existing.created_at !== input.observedAt ||
        existing.available_at !== input.observedAt) {
      throw new Error("warden_ci_cleanup_job_conflict");
    }
    return id;
  }
  enqueueJob(input.db, {
    id,
    tenantId: input.tenantId,
    type: WARDEN_CANDIDATE_CLEANUP_JOB_TYPE,
    payload,
    maxAttempts: 20,
    createdAt: input.observedAt,
  });
  return id;
}

function resultMap(observation: ExactDraftObservation): ReadonlyMap<string, ExactDraftCheckResult> {
  const result = new Map<string, ExactDraftCheckResult>();
  for (const check of observation.checkResults) {
    if (result.has(check.identity) || !observation.checkIdentities.includes(check.identity)) {
      throw new Error("warden_ci_required_checks_ambiguous");
    }
    result.set(check.identity, check);
  }
  if (new Set(observation.checkIdentities).size !== observation.checkIdentities.length ||
      result.size !== observation.checkIdentities.length) {
    throw new Error("warden_ci_required_checks_ambiguous");
  }
  return result;
}

function requiredResults(
  observation: ExactDraftObservation,
  requiredChecks: readonly string[],
): readonly ExactDraftCheckResult[] {
  const byIdentity = resultMap(observation);
  const results = requiredChecks.map((identity) => byIdentity.get(identity));
  if (results.some((result) => result === undefined)) throw new Error("warden_ci_required_checks_missing");
  return Object.freeze((results as ExactDraftCheckResult[]).map((result) => Object.freeze({ ...result })));
}

function redact(value: string | null): string | null {
  if (value === null) return null;
  const result = redactSourceForModel(value, MAX_FIELD_CHARS);
  if (result.excluded) throw new Error("warden_ci_failure_evidence_unsafe");
  return result.text;
}

function failureIdentity(failure: ExactDraftFailure): string {
  return failure.kind === "check_run"
    ? `check:${failure.publisherId}:${failure.name}`
    : `status:${failure.name}`;
}

function safeFailures(
  observation: ExactDraftObservation,
  requiredChecks: readonly string[],
): readonly ExactDraftFailure[] {
  const required = new Set(requiredChecks);
  return Object.freeze(observation.failures
    .filter((failure) => required.has(failureIdentity(failure)))
    .map((failure) => Object.freeze({
      kind: failure.kind,
      id: failure.id,
      publisherId: failure.publisherId,
      name: redact(failure.name)!,
      state: failure.state,
      title: redact(failure.title),
      summary: redact(failure.summary),
      text: redact(failure.text),
      detailsUrl: failure.detailsUrl,
    }))
    .sort((left, right) => compareCodeUnits(`${left.kind}\0${left.name}\0${left.id}`, `${right.kind}\0${right.name}\0${right.id}`)));
}

function evidenceBytes(input: Readonly<{
  tenantId: string;
  cycleId: string;
  deliveryId: string;
  repositoryId: string;
  remoteRepositoryId: number;
  installationId: number;
  pullRequestNumber: number;
  baseBranch: string;
  branchName: string;
  baseRevision: string;
  headRevision: string;
  matchingOpenDrafts: number;
  changedPaths: readonly string[];
  remoteTreeSha: string;
  verdict: "success" | "failure";
  trigger: "checks_passed" | "ci_failure" | "review_feedback";
  requiredResults: readonly ExactDraftCheckResult[];
  failures: readonly ExactDraftFailure[];
  reviewFeedback: ExactDraftObservation["reviewFeedback"];
  reviewFeedbackDigest: string | null;
  evidenceRefs: readonly string[];
  observedAt: string;
  observation: ExactDraftObservation;
}>): Uint8Array {
  const document: ExactDraftObservationEvidenceV1 = {
    schemaVersion: EXACT_DRAFT_OBSERVATION_EVIDENCE_VERSION,
    tenantId: input.tenantId,
    cycleId: input.cycleId,
    deliveryId: input.deliveryId,
    repositoryId: input.repositoryId,
    remoteRepositoryId: input.remoteRepositoryId,
    installationId: input.installationId,
    pullRequestNumber: input.pullRequestNumber,
    baseBranch: input.baseBranch,
    branchName: input.branchName,
    baseRevision: input.baseRevision,
    headRevision: input.headRevision,
    matchingOpenDrafts: input.matchingOpenDrafts,
    changedPaths: [...input.changedPaths].sort(compareCodeUnits),
    remoteTreeSha: input.remoteTreeSha,
    verdict: input.verdict,
    trigger: input.trigger,
    requiredResults: [...input.requiredResults].sort((left, right) => compareCodeUnits(left.identity, right.identity)),
    failures: input.failures,
    reviewFeedback: input.reviewFeedback,
    reviewFeedbackDigest: input.reviewFeedbackDigest,
    evidenceRefs: [...input.evidenceRefs].sort(compareCodeUnits),
    observedAt: input.observedAt,
    observation: input.observation,
  };
  return Buffer.from(JSON.stringify(document), "utf8");
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function safeWardenReviewFeedback(observation: ExactDraftObservation): ExactDraftObservation["reviewFeedback"] {
  const feedback = observation.reviewFeedback;
  if (!feedback || (feedback.verdict !== "none" && feedback.verdict !== "changes_requested") ||
      !Array.isArray(feedback.changeRequests) || !Array.isArray(feedback.comments) ||
      feedback.changeRequests.length + feedback.comments.length > 50 ||
      (feedback.verdict === "none" && (feedback.changeRequests.length > 0 || feedback.comments.length > 0)) ||
      (feedback.verdict === "changes_requested" && feedback.changeRequests.length + feedback.comments.length === 0)) {
    throw new Error("warden_ci_review_feedback_invalid");
  }
  const changeRequests = feedback.changeRequests.map((review) => {
    if (!REVIEW_ID.test(review.id) || !REVIEWER.test(review.reviewer) ||
        review.commitRevision !== observation.headRevision ||
        !canonicalTimestamp(review.submittedAt) ||
        (review.body !== null && typeof review.body !== "string")) {
      throw new Error("warden_ci_review_feedback_invalid");
    }
    return Object.freeze({
      id: review.id,
      reviewer: review.reviewer,
      commitRevision: review.commitRevision,
      body: redact(review.body),
      submittedAt: review.submittedAt,
    });
  });
  const comments = feedback.comments.map((comment) => {
    if (!REVIEW_ID.test(comment.id) || !REVIEW_ID.test(comment.threadId) || !REVIEWER.test(comment.reviewer) ||
        comment.commitRevision !== observation.headRevision || !validRepositoryPath(comment.path) ||
        (comment.line !== null && (!Number.isSafeInteger(comment.line) || comment.line < 1)) ||
        !canonicalTimestamp(comment.createdAt) || !canonicalTimestamp(comment.updatedAt)) {
      throw new Error("warden_ci_review_feedback_invalid");
    }
    return Object.freeze({
      id: comment.id,
      threadId: comment.threadId,
      reviewer: comment.reviewer,
      commitRevision: comment.commitRevision,
      body: redact(comment.body)!,
      path: comment.path,
      line: comment.line,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    });
  });
  changeRequests.sort((left, right) => compareCodeUnits(String(left.id), String(right.id)));
  comments.sort((left, right) => compareCodeUnits(`${left.threadId}\0${left.id}`, `${right.threadId}\0${right.id}`));
  const result = Object.freeze({
    verdict: feedback.verdict,
    changeRequests: Object.freeze(changeRequests),
    comments: Object.freeze(comments),
  });
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_REVIEW_FEEDBACK_BYTES) {
    throw new Error("warden_ci_review_feedback_limit");
  }
  return result;
}

export function wardenReviewFeedbackDigest(observation: ExactDraftObservation): string | null {
  const feedback = safeWardenReviewFeedback(observation);
  return feedback.verdict === "changes_requested"
    ? `sha256:${createHash("sha256").update(JSON.stringify(feedback), "utf8").digest("hex")}`
    : null;
}

export async function runWardenCandidateObservation(input: WardenCandidateObservationInput) {
  assertJob(input.job);
  const payload = parsePayload(input.job);
  const cycle = getWardenCiCycle(input.db, input.job.tenant_id, payload.cycleId);
  if (!cycle || cycle.deliveryId !== payload.deliveryId || cycle.observationJobId !== input.job.id ||
      cycle.status !== "observation_pending") {
    throw new Error("warden_ci_observation_cycle_invalid");
  }
  const repository = await input.resolveRepository({
    tenantId: cycle.tenantId,
    repositoryId: cycle.repositoryId,
    installationId: cycle.installationId,
    remoteRepositoryId: cycle.remoteRepositoryId,
  });
  const observation = await input.observe({
    owner: repository.owner,
    repo: repository.repo,
    pullRequestNumber: cycle.pullRequestNumber,
    expectedBaseBranch: cycle.baseBranch,
    expectedBaseSha: cycle.baseRevision,
    expectedHeadBranch: cycle.branchName,
    expectedHeadSha: cycle.currentHeadSha,
    expectedRepositoryId: cycle.remoteRepositoryId,
    expectedInstallationId: cycle.installationId,
    requireExactDraft: true,
    includeDeliveryEvidence: true,
    includeCommitStatuses: false,
  });
  if (observation.state !== "draft" || observation.baseRevision !== cycle.baseRevision ||
      observation.headRevision !== cycle.currentHeadSha || observation.checkRevision !== cycle.currentHeadSha ||
      observation.repositoryId !== cycle.remoteRepositoryId || observation.installationId !== cycle.installationId ||
      observation.matchingOpenDrafts !== 1 || !REVISION.test(observation.remoteTreeSha ?? "") ||
      !Array.isArray(observation.changedPaths) || observation.changedPaths.length === 0 ||
      observation.changedPaths.some((path) => !validRepositoryPath(path)) ||
      new Set(observation.changedPaths).size !== observation.changedPaths.length) {
    throw new Error("warden_ci_observation_authority_mismatch");
  }
  const changedPaths = Object.freeze([...(observation.changedPaths ?? [])]);
  const remoteTreeSha = observation.remoteTreeSha!;
  const checks = requiredResults(observation, cycle.requiredChecks);
  const now = input.now ?? (() => new Date().toISOString());
  const observedAt = now();
  if (checks.some((check) => check.state === "running")) {
    if (input.job.attempts >= input.job.max_attempts) {
      input.db.raw.exec("BEGIN IMMEDIATE");
      try {
        pauseWardenCiCycle(input.db, { tenantId: cycle.tenantId, cycleId: cycle.id,
          actorPrincipalId: "warden-ci-system", reason: "required_checks_poll_exhausted", observedAt });
        if (!completeJob(input.db, input.job.id, { cycleId: cycle.id, status: "poll_exhausted" }, observedAt,
          { workerId: input.job.lease_owner!, leaseGeneration: input.job.lease_generation })) {
          throw new Error("warden_ci_observation_lease_lost");
        }
        input.db.raw.exec("COMMIT");
      } catch (error) {
        if (input.db.raw.isTransaction) input.db.raw.exec("ROLLBACK");
        throw error;
      }
      return Object.freeze({ status: "poll_exhausted" as const, cycleId: cycle.id });
    }
    const failed = failJob(input.db, input.job.id, "warden_ci_checks_running", observedAt, {
      workerId: input.job.lease_owner!,
      leaseGeneration: input.job.lease_generation,
      retryable: true,
      baseDelayMs: 30_000,
      maxDelayMs: 300_000,
      errorCode: "warden_ci_checks_running",
    });
    if (!failed.applied || failed.status !== "pending") throw new Error("warden_ci_observation_lease_lost");
    return Object.freeze({ status: "retry_scheduled" as const, cycleId: cycle.id, availableAt: failed.availableAt });
  }
  const reviewFeedback = safeWardenReviewFeedback(observation);
  const reviewFeedbackDigest = wardenReviewFeedbackDigest(observation);
  const checksPassed = checks.every((check) => check.state === "success");
  const trigger = !checksPassed ? "ci_failure" as const
    : reviewFeedback.verdict === "changes_requested" ? "review_feedback" as const
      : "checks_passed" as const;
  const verdict = trigger === "checks_passed" ? "success" as const : "failure" as const;
  const failures = safeFailures(observation, cycle.requiredChecks);
  const durableObservation: ExactDraftObservation = Object.freeze({ ...observation,
    checkIdentities: Object.freeze(checks.map((check) => check.identity)),
    checkResults: Object.freeze(checks.map((check) => Object.freeze({ ...check }))),
    failures: Object.freeze(failures.map((failure) => Object.freeze({ ...failure }))),
    reviewFeedback, changedPaths, remoteTreeSha,
    evidenceRefs: Object.freeze([...observation.evidenceRefs].sort(compareCodeUnits)) });
  const bytes = evidenceBytes({
    tenantId: cycle.tenantId,
    cycleId: cycle.id,
    deliveryId: cycle.deliveryId,
    repositoryId: cycle.repositoryId,
    remoteRepositoryId: cycle.remoteRepositoryId,
    installationId: cycle.installationId,
    pullRequestNumber: cycle.pullRequestNumber,
    baseBranch: cycle.baseBranch,
    branchName: cycle.branchName,
    baseRevision: cycle.baseRevision,
    headRevision: cycle.currentHeadSha,
    matchingOpenDrafts: 1,
    changedPaths,
    remoteTreeSha,
    verdict,
    trigger,
    requiredResults: checks,
    failures,
    reviewFeedback,
    reviewFeedbackDigest,
    evidenceRefs: observation.evidenceRefs,
    observedAt,
    observation: durableObservation,
  });
  if (bytes.byteLength > MAX_EVIDENCE_BYTES) throw new Error("warden_ci_observation_evidence_limit");
  const observationDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const persisted = await input.persistEvidence(bytes);
  if (!persisted.artifactId || persisted.artifactId.length > 200 || persisted.digest !== observationDigest ||
      !SHA256.test(persisted.digest)) {
    throw new Error("warden_ci_observation_evidence_mismatch");
  }
  if (cycle.missionAuthority) {
    assertMissionMutationAuthority(input.db, cycle.tenantId, cycle.missionAuthority, {
      allowClaimedTask: true,
      requireNoBlocking: true,
    });
  }
  input.db.raw.exec("BEGIN IMMEDIATE");
  try {
    const saved = recordWardenCiObservation(input.db, {
      tenantId: cycle.tenantId,
      cycleId: cycle.id,
      headSha: cycle.currentHeadSha,
      verdict,
      observationDigest,
      evidenceArtifactId: persisted.artifactId,
      evidenceDigest: persisted.digest,
      observedAt,
    });
    if (trigger === "checks_passed") {
      enqueueDelegatedCleanupHandoff({
        db: input.db,
        tenantId: cycle.tenantId,
        cycleId: cycle.id,
        deliveryId: cycle.deliveryId,
        observationId: saved.id,
        headSha: cycle.currentHeadSha,
        observationDigest,
        evidenceArtifactId: persisted.artifactId,
        evidenceBytes: bytes,
        observedAt,
      });
    }
    const completed = completeJob(input.db, input.job.id, {
      cycleId: cycle.id,
      deliveryId: cycle.deliveryId,
      observationId: saved.id,
      observationDigest,
      verdict,
    }, observedAt, { workerId: input.job.lease_owner!, leaseGeneration: input.job.lease_generation });
    if (!completed) throw new Error("warden_ci_observation_lease_lost");
    input.db.raw.exec("COMMIT");
  } catch (error) {
    if (input.db.raw.isTransaction) input.db.raw.exec("ROLLBACK");
    throw error;
  }
  return Object.freeze({
    status: trigger === "checks_passed" ? "checks_passed" as const
      : trigger === "review_feedback" ? "review_feedback" as const : "failed_checks" as const,
    cycleId: cycle.id,
    observationDigest,
  });
}
