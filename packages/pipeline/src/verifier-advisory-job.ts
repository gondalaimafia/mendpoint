import { createHash } from "node:crypto";
import {
  bindMissionToPolicyEnvelope,
  createPolicyEnvelope,
  enqueueJob,
  getConnectedRepository,
  getJob,
  getMission,
  getMissionPolicyEnvelope,
  insertArtifactManifest,
  listArtifactManifests,
  listRepositorySnapshots,
  type AppDb,
  type JobRow,
} from "@mendpoint/db";
import {
  verifyVerifierTelemetry,
  type VerifierProduct,
  type VerifierRisk,
  type VerifierTelemetry,
} from "@mendpoint/verifier";
import {
  canonicalPolicyEnvelopeJson,
  evaluatePolicyEnvelope,
  parsePolicyEnvelope,
  type PolicyEnvelope,
} from "@mendpoint/policy";

export const VERIFIER_ADVISORY_JOB_TYPE = "verifier.advisory.verify";
const INPUT_KIND = "agent_verifier_advisory_input";
const INPUT_MEDIA_TYPE = "application/vnd.mendpoint.agent-verifier-advisory-input.v1+json";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export type ProductCompletionAdvisoryInput = Readonly<{
  tenantId: string;
  missionId: string;
  taskId: string;
  product: VerifierProduct;
  repositoryId: string;
  snapshotId: string;
  snapshotDigest: string;
  objective: string;
  risk: VerifierRisk;
  allowedChangedPaths: readonly string[];
  candidateId: string;
  candidateDigest: string;
  changedPaths: readonly string[];
  observableSummary: string;
  deterministicEvidenceDigest: string;
  deterministicEvidenceRefs: readonly string[];
  observedAt: string;
}>;

type AdvisoryPayload = Readonly<{
  schemaVersion: 1;
  inputArtifactId: string;
  inputSha256: string;
  missionId: string;
  taskId: string;
  product: VerifierProduct;
}>;

export type EnqueueVerifierAdvisoryResult = Readonly<{
  status: "enqueued" | "duplicate";
  jobId: string;
  inputArtifactId: string;
  inputSha256: string;
}>;

export type VerifierAdvisoryPolicyAuthority = Readonly<{
  policyEnvelopeId: string;
  policyEnvelopeVersion: number;
  policyEnvelopeSha256: string;
  reviewRequired: true;
}>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactIso(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function text(value: unknown, maximum = 8_192): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 &&
    value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

function stringList(value: unknown, maximum = 256): value is string[] {
  return Array.isArray(value) && value.length <= maximum &&
    value.every((entry) => text(entry, 2_048)) && new Set(value).size === value.length;
}

export function verifyProductCompletionAdvisoryInput(value: unknown): ProductCompletionAdvisoryInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("verifier_advisory_input_invalid");
  }
  const raw = value as Record<string, unknown>;
  const keys = ["allowedChangedPaths", "candidateDigest", "candidateId", "changedPaths",
    "deterministicEvidenceDigest", "deterministicEvidenceRefs", "missionId", "objective",
    "observableSummary", "observedAt", "product", "repositoryId", "risk", "snapshotDigest",
    "snapshotId", "taskId", "tenantId"];
  if (canonical(Object.keys(raw).sort()) !== canonical(keys.sort()) ||
      ![raw.tenantId, raw.missionId, raw.taskId, raw.repositoryId, raw.snapshotId, raw.candidateId]
        .every((entry) => typeof entry === "string" && ID.test(entry)) ||
      raw.product !== "fettler" && raw.product !== "regauge" ||
      !["low", "medium", "high", "critical"].includes(String(raw.risk)) ||
      !DIGEST.test(String(raw.snapshotDigest)) || !DIGEST.test(String(raw.candidateDigest)) ||
      !DIGEST.test(String(raw.deterministicEvidenceDigest)) || !text(raw.objective) ||
      !text(raw.observableSummary) || !stringList(raw.allowedChangedPaths) ||
      !stringList(raw.changedPaths) || !stringList(raw.deterministicEvidenceRefs) ||
      raw.changedPaths.length === 0 || raw.deterministicEvidenceRefs.length === 0 ||
      !(raw.changedPaths as string[]).every((path) =>
        (raw.allowedChangedPaths as string[]).includes(path)) ||
      !exactIso(String(raw.observedAt))) {
    throw new Error("verifier_advisory_input_invalid");
  }
  return Object.freeze({
    tenantId: raw.tenantId as string,
    missionId: raw.missionId as string,
    taskId: raw.taskId as string,
    product: raw.product as VerifierProduct,
    repositoryId: raw.repositoryId as string,
    snapshotId: raw.snapshotId as string,
    snapshotDigest: raw.snapshotDigest as string,
    objective: raw.objective as string,
    risk: raw.risk as VerifierRisk,
    allowedChangedPaths: Object.freeze([...(raw.allowedChangedPaths as string[])]),
    candidateId: raw.candidateId as string,
    candidateDigest: raw.candidateDigest as string,
    changedPaths: Object.freeze([...(raw.changedPaths as string[])]),
    observableSummary: raw.observableSummary as string,
    deterministicEvidenceDigest: raw.deterministicEvidenceDigest as string,
    deterministicEvidenceRefs: Object.freeze([...(raw.deterministicEvidenceRefs as string[])]),
    observedAt: raw.observedAt as string,
  });
}

function exactList(actual: readonly string[], expected: readonly string[]): boolean {
  return canonical([...actual]) === canonical([...expected]);
}

/**
 * Retain, bind, and evaluate the exact external verifier authority before a
 * durable job can be enqueued. A running Mission may predate this release, so
 * the same function is both the launch-time binder and the recovery reconciler:
 * an exact existing binding is idempotent; any changed version/content fails.
 */
export function reconcileVerifierAdvisoryPolicyAuthority(db: AppDb, input: Readonly<{
  completion: ProductCompletionAdvisoryInput;
  policyEnvelopeJson: string;
  actorPrincipalId: string;
  branch: string;
  processingRegion: string;
  createdAt: string;
}>): VerifierAdvisoryPolicyAuthority {
  const completion = verifyProductCompletionAdvisoryInput(input.completion);
  let unsafe: unknown;
  try { unsafe = JSON.parse(input.policyEnvelopeJson); }
  catch { throw new Error("verifier_advisory_policy_invalid"); }
  let template: PolicyEnvelope;
  try { template = parsePolicyEnvelope(unsafe); }
  catch { throw new Error("verifier_advisory_policy_invalid"); }
  // Repository and branch ids are created or authenticated during bootstrap, so
  // the protected template deliberately leaves only those two arrays empty. We
  // bind them to the Mission's exact durable scope before retaining the actual
  // envelope. Empty never reaches evaluation or storage as unrestricted scope.
  if (template.repositoryScope.length !== 0 || template.branchScope.length !== 0) {
    throw new Error("verifier_advisory_policy_template_scope_invalid");
  }
  const envelope = Object.freeze({
    ...template,
    repositoryScope: Object.freeze([completion.repositoryId]),
    branchScope: Object.freeze([input.branch]),
  });
  const mission = getMission(db, completion.tenantId, completion.missionId);
  const repository = getConnectedRepository(db, completion.repositoryId, completion.tenantId);
  const snapshot = listRepositorySnapshots(db, completion.tenantId, completion.repositoryId)
    .filter((candidate) => candidate.id === completion.snapshotId);
  if (!mission || mission.product !== completion.product || mission.repositoryId !== completion.repositoryId ||
      mission.snapshotId !== completion.snapshotId || snapshot.length !== 1 || !repository ||
      repository.selected_branch !== input.branch || envelope.tenantId !== completion.tenantId ||
      !exactList(envelope.repositoryScope, [completion.repositoryId]) ||
      !exactList(envelope.branchScope, [input.branch]) ||
      !exactList(envelope.allowedTools, ["deepseek-verifier"]) ||
      !exactList(envelope.allowedModelClasses, ["rented_specialist"]) ||
      !envelope.externalProcessingAllowed || envelope.residency !== input.processingRegion ||
      envelope.riskCeiling !== "high" || !envelope.reviewRequired ||
      envelope.deploymentAllowed || envelope.trainingDataAllowed ||
      envelope.retentionDays === null || envelope.retentionDays > 90 ||
      !exactIso(envelope.createdAt) || envelope.createdAt > input.createdAt) {
    throw new Error("verifier_advisory_policy_authority_invalid");
  }
  const decision = evaluatePolicyEnvelope(envelope, {
    repositoryId: completion.repositoryId,
    branch: input.branch,
    targetPaths: completion.changedPaths,
    tool: "deepseek-verifier",
    modelClass: "rented_specialist",
    externalProcessing: true,
    risk: completion.risk,
    isDeployment: false,
    wantsTrainingCapture: false,
    residency: input.processingRegion,
  });
  if (!decision.allowed || !decision.reviewRequired) {
    throw new Error(`verifier_advisory_policy_denied:${decision.violations.map((item) => item.code).join(",")}`);
  }
  const envelopeJson = canonicalPolicyEnvelopeJson(envelope);
  const stored = createPolicyEnvelope(db, {
    tenantId: envelope.tenantId,
    version: envelope.version,
    policyEnvelopeId: envelope.policyEnvelopeId,
    envelopeJson,
    createdAt: envelope.createdAt,
  });
  bindMissionToPolicyEnvelope(db, {
    tenantId: completion.tenantId,
    missionId: completion.missionId,
    version: envelope.version,
    actorPrincipalId: input.actorPrincipalId,
    eventId: `event-${sha256(`${completion.missionId}\0${envelope.version}`).slice(0, 40)}`,
    idempotencyKey: `mission-policy-${completion.missionId}-${envelope.version}`,
    correlationId: completion.taskId,
    createdAt: input.createdAt,
  });
  const inherited = getMissionPolicyEnvelope(db, completion.tenantId, completion.missionId);
  if (!inherited || inherited.contentSha256 !== stored.contentSha256 ||
      inherited.policyEnvelopeId !== envelope.policyEnvelopeId) {
    throw new Error("verifier_advisory_policy_binding_invalid");
  }
  return Object.freeze({
    policyEnvelopeId: envelope.policyEnvelopeId,
    policyEnvelopeVersion: envelope.version,
    policyEnvelopeSha256: stored.contentSha256,
    reviewRequired: true,
  });
}

function payloadFor(input: ProductCompletionAdvisoryInput, artifactId: string, inputSha256: string): AdvisoryPayload {
  return Object.freeze({
    schemaVersion: 1,
    inputArtifactId: artifactId,
    inputSha256,
    missionId: input.missionId,
    taskId: input.taskId,
    product: input.product,
  });
}

function jobId(input: ProductCompletionAdvisoryInput, inputSha256: string): string {
  const digest = sha256(canonical({ schemaVersion: 1, tenantId: input.tenantId,
    missionId: input.missionId, taskId: input.taskId, product: input.product, inputSha256 }));
  return `verifier_advisory_${digest.slice(0, 40)}`;
}

export function enqueueVerifierAdvisoryJob(db: AppDb, input: Readonly<{
  completion: ProductCompletionAdvisoryInput;
  producerPrincipalId?: string | null;
  createdAt: string;
}>): EnqueueVerifierAdvisoryResult {
  const completion = verifyProductCompletionAdvisoryInput(input.completion);
  if (!exactIso(input.createdAt) || input.createdAt !== completion.observedAt) {
    throw new Error("verifier_advisory_created_at_invalid");
  }
  const content = canonical(completion);
  const inputSha256 = sha256(content);
  const inputArtifactId = `verifier-advisory-input-${inputSha256.slice(0, 40)}`;
  const id = jobId(completion, inputSha256);
  const payload = payloadFor(completion, inputArtifactId, inputSha256);
  const expectedPayload = canonical(payload);
  const owns = !db.raw.isTransaction;
  const savepoint = `verifier_advisory_${inputSha256.slice(0, 12)}`;
  if (owns) db.raw.exec("BEGIN IMMEDIATE"); else db.raw.exec(`SAVEPOINT ${savepoint}`);
  try {
    insertArtifactManifest(db, {
      id: inputArtifactId,
      tenantId: completion.tenantId,
      kind: INPUT_KIND,
      schemaVersion: 1,
      sha256: inputSha256,
      mediaType: INPUT_MEDIA_TYPE,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      storageRef: `sqlite://artifact_manifests/${inputArtifactId}`,
      content,
      producerPrincipalId: input.producerPrincipalId ?? null,
      createdAt: input.createdAt,
    });
    const existing = db.raw.prepare("SELECT tenant_id, type, payload_json FROM jobs WHERE id = ?")
      .get(id) as { tenant_id: string; type: string; payload_json: string } | undefined;
    let status: "enqueued" | "duplicate" = "enqueued";
    if (existing) {
      let parsed: unknown;
      try { parsed = JSON.parse(existing.payload_json); }
      catch { throw new Error("verifier_advisory_job_conflict"); }
      if (existing.tenant_id !== completion.tenantId || existing.type !== VERIFIER_ADVISORY_JOB_TYPE ||
          canonical(parsed) !== expectedPayload) {
        throw new Error("verifier_advisory_job_conflict");
      }
      status = "duplicate";
    } else {
      enqueueJob(db, { id, tenantId: completion.tenantId, type: VERIFIER_ADVISORY_JOB_TYPE,
        payload, maxAttempts: 5, createdAt: input.createdAt });
    }
    if (owns) db.raw.exec("COMMIT"); else db.raw.exec(`RELEASE ${savepoint}`);
    return Object.freeze({ status, jobId: id, inputArtifactId, inputSha256 });
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    else if (!owns && db.raw.isTransaction) {
      db.raw.exec(`ROLLBACK TO ${savepoint}`);
      db.raw.exec(`RELEASE ${savepoint}`);
    }
    throw error;
  }
}

function parsePayload(job: JobRow): AdvisoryPayload {
  let value: unknown;
  try { value = JSON.parse(job.payload_json); }
  catch { throw new Error("verifier_advisory_job_payload_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("verifier_advisory_job_payload_invalid");
  }
  const raw = value as Record<string, unknown>;
  if (canonical(Object.keys(raw).sort()) !== canonical(["inputArtifactId", "inputSha256", "missionId", "product", "schemaVersion", "taskId"]) ||
      raw.schemaVersion !== 1 || !ID.test(String(raw.inputArtifactId)) ||
      !/^[a-f0-9]{64}$/.test(String(raw.inputSha256)) || !ID.test(String(raw.missionId)) ||
      !ID.test(String(raw.taskId)) || raw.product !== "fettler" && raw.product !== "regauge") {
    throw new Error("verifier_advisory_job_payload_invalid");
  }
  return Object.freeze(raw as unknown as AdvisoryPayload);
}

export function readVerifierAdvisoryJobInput(db: AppDb, job: JobRow): ProductCompletionAdvisoryInput {
  if (job.type !== VERIFIER_ADVISORY_JOB_TYPE) throw new Error("verifier_advisory_job_invalid");
  const payload = parsePayload(job);
  const artifacts = listArtifactManifests(db, job.tenant_id, INPUT_KIND)
    .filter((artifact) => artifact.id === payload.inputArtifactId);
  if (artifacts.length !== 1) throw new Error("verifier_advisory_input_missing");
  const artifact = artifacts[0]!;
  const content = artifact.content_text;
  if (artifact.schema_version !== 1 || artifact.media_type !== INPUT_MEDIA_TYPE || content === null ||
      artifact.sha256 !== payload.inputSha256 || sha256(content) !== artifact.sha256 ||
      Buffer.byteLength(content, "utf8") !== artifact.size_bytes) {
    throw new Error("verifier_advisory_input_integrity_invalid");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { throw new Error("verifier_advisory_input_invalid"); }
  const completion = verifyProductCompletionAdvisoryInput(parsed);
  if (completion.tenantId !== job.tenant_id || completion.missionId !== payload.missionId ||
      completion.taskId !== payload.taskId || completion.product !== payload.product ||
      job.id !== jobId(completion, payload.inputSha256)) {
    throw new Error("verifier_advisory_job_binding_invalid");
  }
  return completion;
}

export function findVerifierTelemetry(db: AppDb, input: Readonly<{
  tenantId: string;
  verificationAttemptId: string;
  evidencePackDigest: string;
}>): VerifierTelemetry | null {
  const matches = listArtifactManifests(db, input.tenantId, "agent_verifier_telemetry")
    .flatMap((artifact) => {
      if (!artifact.content_text || sha256(artifact.content_text) !== artifact.sha256) return [];
      try {
        const telemetry = verifyVerifierTelemetry(JSON.parse(artifact.content_text) as VerifierTelemetry);
        return telemetry.verificationAttemptId === input.verificationAttemptId &&
          telemetry.evidencePackDigest === input.evidencePackDigest ? [telemetry] : [];
      } catch { return []; }
    });
  if (matches.length > 1) throw new Error("verifier_advisory_telemetry_ambiguous");
  return matches[0] ?? null;
}

export function getVerifierAdvisoryJob(db: AppDb, id: string, tenantId: string): JobRow | undefined {
  const job = getJob(db, id, tenantId);
  return job?.type === VERIFIER_ADVISORY_JOB_TYPE ? job : undefined;
}
