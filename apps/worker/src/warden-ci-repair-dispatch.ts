import { createHash } from "node:crypto";
import {
  beginWardenCiRepair,
  completeJob,
  enqueueJob,
  exhaustWardenCiCycle,
  getAgentRun,
  getJob,
  getWardenCandidateDelivery,
  getWardenCiCycle,
  insertAgentRun,
  listWardenCiObservations,
  type AppDb,
  type JobRow,
} from "@mendpoint/db";

const JOB_TYPE = "warden.candidate.repair";
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_EVIDENCE_BYTES = 128 * 1024;

export type MaterializedWardenCiHead = Readonly<{
  repositoryId: string;
  snapshotId: string;
  revision: string;
  manifestSha256: string;
  root: string;
}>;

export type WardenCiRepairDispatchInput = Readonly<{
  db: AppDb;
  job: JobRow;
  materializeHead: (input: Readonly<{
    tenantId: string;
    repositoryId: string;
    remoteRepositoryId: number;
    installationId: number;
    headSha: string;
  }>) => Promise<MaterializedWardenCiHead>;
  readEvidence: (input: Readonly<{
    tenantId: string;
    artifactId: string;
    expectedDigest: string;
  }>) => Promise<Uint8Array>;
  now?: () => string;
}>;

function parsePayload(job: JobRow): Readonly<{ cycleId: string; observationId: string; observationDigest: string }> {
  let value: unknown;
  try { value = JSON.parse(job.payload_json); } catch { throw new Error("warden_ci_repair_payload_invalid"); }
  if (!value || typeof value !== "object") throw new Error("warden_ci_repair_payload_invalid");
  const record = value as Record<string, unknown>;
  if (typeof record.cycleId !== "string" || typeof record.observationId !== "string" ||
      typeof record.observationDigest !== "string") throw new Error("warden_ci_repair_payload_invalid");
  return Object.freeze({ cycleId: record.cycleId, observationId: record.observationId,
    observationDigest: record.observationDigest });
}

function stableIds(tenantId: string, cycleId: string, observationDigest: string) {
  const hash = createHash("sha256").update([tenantId, cycleId, observationDigest, "repair"].join("\0"), "utf8").digest("hex");
  return Object.freeze({ runId: `warden-ci-run-${hash.slice(0, 32)}`, jobId: `warden-ci-job-${hash.slice(32)}` });
}

function parseOriginalPayload(value: string): Readonly<Record<string, unknown> & { consumerId: string }> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("warden_ci_source_job_invalid"); }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as Record<string, unknown>).consumerId !== "string" ||
      !(parsed as Record<string, unknown>).consumerId) throw new Error("warden_ci_source_job_invalid");
  return Object.freeze({ ...(parsed as Record<string, unknown>), consumerId: String((parsed as Record<string, unknown>).consumerId) });
}

function claimedMissionId(payload: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof payload.missionId !== "string") return undefined;
  const missionId = payload.missionId.trim();
  if (!missionId || missionId !== payload.missionId) return undefined;
  return missionId;
}

function evidenceAuthority(bytes: Uint8Array): Readonly<{
  trigger: "ci_failure" | "review_feedback";
  reviewFeedbackDigest: string | null;
}> {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new Error("warden_ci_evidence_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("warden_ci_evidence_invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (record.trigger === undefined || record.trigger === "ci_failure") {
    return Object.freeze({ trigger: "ci_failure" as const, reviewFeedbackDigest: null });
  }
  if (record.trigger !== "review_feedback" || !record.reviewFeedback ||
      typeof record.reviewFeedback !== "object" || Array.isArray(record.reviewFeedback)) {
    throw new Error("warden_ci_evidence_invalid");
  }
  const feedback = record.reviewFeedback as Record<string, unknown>;
  if (feedback.verdict !== "changes_requested" || !Array.isArray(feedback.changeRequests) ||
      !Array.isArray(feedback.comments) || feedback.changeRequests.length + feedback.comments.length < 1 ||
      feedback.changeRequests.length + feedback.comments.length > 50) {
    throw new Error("warden_ci_evidence_invalid");
  }
  if (typeof record.reviewFeedbackDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(record.reviewFeedbackDigest)) {
    throw new Error("warden_ci_evidence_invalid");
  }
  return Object.freeze({ trigger: "review_feedback" as const,
    reviewFeedbackDigest: record.reviewFeedbackDigest });
}

export async function runWardenCiRepairDispatch(input: WardenCiRepairDispatchInput) {
  if (input.job.type !== JOB_TYPE || input.job.status !== "running" || !input.job.lease_owner ||
      input.job.lease_generation < 1) throw new Error("warden_ci_repair_job_invalid");
  const payload = parsePayload(input.job);
  const cycle = getWardenCiCycle(input.db, input.job.tenant_id, payload.cycleId);
  if (!cycle || cycle.status !== "checks_failed" || cycle.currentObservationDigest !== payload.observationDigest) {
    throw new Error("warden_ci_repair_not_authorized");
  }
  const observation = listWardenCiObservations(input.db, cycle.tenantId, cycle.id)
    .find((candidate) => candidate.id === payload.observationId);
  if (!observation || observation.verdict !== "failure" || observation.headSha !== cycle.currentHeadSha ||
      observation.observationDigest !== payload.observationDigest) throw new Error("warden_ci_observation_not_authorized");
  const now = input.now ?? (() => new Date().toISOString());
  if (cycle.usedCycles >= cycle.maxCycles) {
    const observedAt = now();
    input.db.raw.exec("BEGIN IMMEDIATE");
    try {
      exhaustWardenCiCycle(input.db, { tenantId: cycle.tenantId, cycleId: cycle.id,
        observationDigest: observation.observationDigest, observedAt });
      if (!completeJob(input.db, input.job.id, { cycleId: cycle.id, status: "budget_exhausted" }, observedAt,
        { workerId: input.job.lease_owner, leaseGeneration: input.job.lease_generation })) {
        throw new Error("warden_ci_repair_lease_lost");
      }
      input.db.raw.exec("COMMIT");
    } catch (error) {
      if (input.db.raw.isTransaction) input.db.raw.exec("ROLLBACK");
      throw error;
    }
    return Object.freeze({ status: "budget_exhausted" as const, cycleId: cycle.id });
  }
  const delivery = getWardenCandidateDelivery(input.db, cycle.tenantId, cycle.deliveryId);
  if (!delivery || delivery.status !== "delivered" || delivery.runId.length === 0) {
    throw new Error("warden_ci_delivery_not_authorized");
  }
  const sourceRun = getAgentRun(input.db, delivery.runId, cycle.tenantId);
  const sourceJob = sourceRun?.job_id ? getJob(input.db, sourceRun.job_id, cycle.tenantId) : undefined;
  if (!sourceRun || !sourceJob || sourceJob.type !== "agent.run") throw new Error("warden_ci_source_job_invalid");
  const originalPayload = parseOriginalPayload(sourceJob.payload_json);
  const evidence = await input.readEvidence({ tenantId: cycle.tenantId, artifactId: observation.evidenceArtifactId,
    expectedDigest: observation.evidenceDigest });
  if (evidence.byteLength < 1 || evidence.byteLength > MAX_EVIDENCE_BYTES ||
      `sha256:${createHash("sha256").update(evidence).digest("hex")}` !== observation.evidenceDigest) {
    throw new Error("warden_ci_evidence_digest_mismatch");
  }
  const evidenceAuthorityValue = evidenceAuthority(evidence);
  const trigger = evidenceAuthorityValue.trigger;
  const materialized = await input.materializeHead({ tenantId: cycle.tenantId, repositoryId: cycle.repositoryId,
    remoteRepositoryId: cycle.remoteRepositoryId, installationId: cycle.installationId, headSha: cycle.currentHeadSha });
  if (materialized.repositoryId !== cycle.repositoryId || materialized.revision !== cycle.currentHeadSha ||
      !materialized.snapshotId || !SHA.test(materialized.revision) || !SHA256.test(materialized.manifestSha256)) {
    throw new Error("warden_ci_snapshot_binding_mismatch");
  }
  const ids = stableIds(cycle.tenantId, cycle.id, observation.observationDigest);
  const observedAt = now();
  const callsPerCycle = Math.max(1, Math.floor(cycle.maxModelCalls / cycle.maxCycles));
  const costPerCycle = cycle.maximumCostUsd / cycle.maxCycles;
  const ciFailure = Object.freeze({ cycleId: cycle.id, deliveryId: cycle.deliveryId,
    pullRequestNumber: cycle.pullRequestNumber, failedHeadSha: cycle.currentHeadSha,
    observationDigest: observation.observationDigest, evidenceArtifactId: observation.evidenceArtifactId,
    evidenceDigest: observation.evidenceDigest, trigger,
    reviewFeedbackDigest: evidenceAuthorityValue.reviewFeedbackDigest });
  // Copy the source run's claimed Mission id when present. Do not invent one
  // from the delivery or campaign; unbound source runs stay unbound.
  const missionId = claimedMissionId(originalPayload);
  const agentPayload = Object.freeze({
    goal: trigger === "review_feedback"
      ? `Address the authoritative review feedback on draft pull request ${cycle.pullRequestNumber} at exact head ${cycle.currentHeadSha}.`
      : `Repair the required CI failures on draft pull request ${cycle.pullRequestNumber} at exact head ${cycle.currentHeadSha}.`,
    consumerId: originalPayload.consumerId,
    errorLog: Buffer.from(evidence).toString("utf8"),
    maxSteps: Math.min(100, Math.max(1, callsPerCycle * 4)),
    maxModelCalls: callsPerCycle,
    maximumCostUsd: costPerCycle,
    useLlm: true,
    sessionId: ids.runId,
    allowedChangedPaths: [...cycle.allowedChangedPaths],
    snapshotBinding: Object.freeze({ repositoryId: materialized.repositoryId, snapshotId: materialized.snapshotId,
      revision: materialized.revision, manifestSha256: materialized.manifestSha256 }),
    ciFailure,
    ...(missionId ? { missionId } : {}),
  });
  input.db.raw.exec("BEGIN IMMEDIATE");
  try {
    enqueueJob(input.db, { id: ids.jobId, tenantId: cycle.tenantId, type: "agent.run", payload: agentPayload,
      createdAt: observedAt });
    insertAgentRun(input.db, { id: ids.runId, tenantId: cycle.tenantId, jobId: ids.jobId, goal: agentPayload.goal,
      repoPath: materialized.root, status: "queued", ok: false, steps: 0, filesChanged: [], reportMd: null,
      resultJson: JSON.stringify({ jobId: ids.jobId, product: "warden", sourceKind: "immutable_snapshot",
        source: agentPayload.snapshotBinding, ciFailure }), createdAt: observedAt, finishedAt: null });
    beginWardenCiRepair(input.db, { tenantId: cycle.tenantId, cycleId: cycle.id,
      observationDigest: observation.observationDigest, repairRunId: ids.runId, repairJobId: ids.jobId, observedAt });
    if (!completeJob(input.db, input.job.id, { cycleId: cycle.id, repairRunId: ids.runId, repairJobId: ids.jobId },
      observedAt, { workerId: input.job.lease_owner, leaseGeneration: input.job.lease_generation })) {
      throw new Error("warden_ci_repair_lease_lost");
    }
    input.db.raw.exec("COMMIT");
  } catch (error) {
    if (input.db.raw.isTransaction) input.db.raw.exec("ROLLBACK");
    throw error;
  }
  return Object.freeze({ status: "repair_enqueued" as const, cycleId: cycle.id, repairRunId: ids.runId,
    repairJobId: ids.jobId });
}
