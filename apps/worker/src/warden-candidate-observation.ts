import { createHash } from "node:crypto";
import { redactSourceForModel } from "@mendpoint/agent";
import {
  completeJob,
  failJob,
  getWardenCiCycle,
  pauseWardenCiCycle,
  recordWardenCiObservation,
  type AppDb,
  type JobRow,
} from "@mendpoint/db";
import type {
  ExactDraftCheckResult,
  ExactDraftFailure,
  ExactDraftObservation,
  ExactDraftObservationInput,
} from "@mendpoint/github";

const JOB_TYPE = "warden.candidate.observe";
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAX_FIELD_CHARS = 2_000;

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
): readonly Readonly<Record<string, string | null>>[] {
  const required = new Set(requiredChecks);
  return Object.freeze(observation.failures
    .filter((failure) => required.has(failureIdentity(failure)))
    .map((failure) => Object.freeze({
      kind: failure.kind,
      id: failure.id,
      publisherId: failure.publisherId === null ? null : String(failure.publisherId),
      name: redact(failure.name),
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
  verdict: "success" | "failure";
  requiredResults: readonly ExactDraftCheckResult[];
  failures: readonly Readonly<Record<string, string | null>>[];
  evidenceRefs: readonly string[];
  observedAt: string;
}>): Uint8Array {
  const document = {
    schemaVersion: "2026-08-13.warden-ci-observation.v1",
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
    verdict: input.verdict,
    requiredResults: [...input.requiredResults].sort((left, right) => compareCodeUnits(left.identity, right.identity)),
    failures: input.failures,
    evidenceRefs: [...input.evidenceRefs].sort(compareCodeUnits),
    observedAt: input.observedAt,
  };
  return Buffer.from(JSON.stringify(document), "utf8");
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
    requireExactDraft: true,
    includeCommitStatuses: false,
  });
  if (observation.state !== "draft" || observation.baseRevision !== cycle.baseRevision ||
      observation.headRevision !== cycle.currentHeadSha || observation.checkRevision !== cycle.currentHeadSha) {
    throw new Error("warden_ci_observation_authority_mismatch");
  }
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
  const verdict = checks.every((check) => check.state === "success") ? "success" as const : "failure" as const;
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
    verdict,
    requiredResults: checks,
    failures: safeFailures(observation, cycle.requiredChecks),
    evidenceRefs: observation.evidenceRefs,
    observedAt,
  });
  const observationDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const persisted = await input.persistEvidence(bytes);
  if (!persisted.artifactId || persisted.artifactId.length > 200 || persisted.digest !== observationDigest ||
      !SHA256.test(persisted.digest)) {
    throw new Error("warden_ci_observation_evidence_mismatch");
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
    status: verdict === "success" ? "checks_passed" as const : "failed_checks" as const,
    cycleId: cycle.id,
    observationDigest,
  });
}
