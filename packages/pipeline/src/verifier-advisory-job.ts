import { createHash } from "node:crypto";
import {
  advanceMissionPolicyEnvelopeVersion,
  bindMissionToPolicyEnvelope,
  createPolicyEnvelope,
  enqueueJob,
  findActiveLearningConsent,
  getConnectedRepository,
  getJob,
  getMission,
  getMissionPolicyEnvelope,
  insertArtifactManifest,
  listArtifactManifests,
  listRepositorySnapshots,
  type AppDb,
  type JobRow,
  type LearningConsentRow,
} from "@mendpoint/db";
import {
  verifyVerifierTelemetry,
  type VerifierProduct,
  type VerifierHttpResponse,
  type VerifierRisk,
  type VerifierSourceInput,
  type VerifierTelemetry,
} from "@mendpoint/verifier";
import {
  canonicalPolicyEnvelopeJson,
  defaultPolicyEnvelope,
  evaluatePolicyEnvelope,
  parsePolicyEnvelope,
  type PolicyEnvelope,
} from "@mendpoint/policy";
import { defaultPolicyEnvelopeId } from "./mission-policy-binding.js";

export const VERIFIER_ADVISORY_JOB_TYPE = "verifier.advisory.verify";
export const REGAUGE_DEEPSEEK_APPROVED_SCOPE = Object.freeze({
  tenantId: "tenant_regauge_canary",
  campaignId: "campaign_regauge_canary_20260814",
  repositoryOwner: "gondalaimafia",
  repositoryName: "mendpoint-canary-drill-20260801",
  repositoryFullName: "gondalaimafia/mendpoint-canary-drill-20260801",
  branch: "main",
  authorizationDeadline: "2026-11-20T23:59:59.000Z",
});
export const REGAUGE_VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE =
  `verifier-external-model-egress:regauge:${REGAUGE_DEEPSEEK_APPROVED_SCOPE.campaignId}:${REGAUGE_DEEPSEEK_APPROVED_SCOPE.repositoryFullName}`;
const INPUT_KIND = "agent_verifier_advisory_input";
const INPUT_MEDIA_TYPE = "application/vnd.mendpoint.agent-verifier-advisory-input.v1+json";
const SUBSTANTIVE_EVIDENCE_KIND = "agent_verifier_advisory_substantive_evidence";
const SUBSTANTIVE_EVIDENCE_MEDIA_TYPE = "application/vnd.mendpoint.agent-verifier-advisory-substantive-evidence.v1+json";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const PROVIDER_REQUEST_KIND = "agent_verifier_provider_request_intent";
const PROVIDER_RESPONSE_KIND = "agent_verifier_provider_response_receipt";
const PROVIDER_NO_RESPONSE_KIND = "agent_verifier_provider_no_response";
const PROVIDER_RETRYABLE_RESPONSE_KIND = "agent_verifier_provider_retryable_response";

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
  substantiveEvidenceArtifactId: string;
  substantiveEvidenceSha256: string;
}>;

export type VerifierAdvisorySubstantiveEvidence = Readonly<{
  schemaVersion: 1;
  tenantId: string;
  repositoryId: string;
  snapshotId: string;
  snapshotDigest: string;
  candidateId: string;
  candidateDigest: string;
  changedPaths: readonly string[];
  sources: readonly Readonly<VerifierSourceInput>[];
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

export type VerifierAdvisoryMissionPolicyBinding = Readonly<{
  tenantId: string;
  missionId: string;
  product: VerifierProduct;
  repositoryId: string;
  snapshotId: string;
  policyEnvelopeJson: string;
  actorPrincipalId: string;
  branch: string;
  repositoryScope: string;
  processingRegion: string;
  createdAt: string;
}>;

export type VerifierAdvisoryConsentBinding = Readonly<{
  consentId: string;
  consentRecordDigest: string;
  consentGrantedAt: string;
  consentEffectiveAt: string;
  consentExpiresAt: string;
}>;

export type VerifierAdvisoryProviderOperation = Readonly<{
  status: "ready" | "recover";
  operationId: string;
  consent: VerifierAdvisoryConsentBinding;
  response: VerifierHttpResponse | null;
}>;

export type VerifierAdvisoryProviderEvidence = VerifierAdvisoryConsentBinding & Readonly<{
  providerRequestId: string;
  providerRequestedAt: string;
  providerProcessedAt: string;
  providerResponseDigest: string;
}>;

export function assertRegaugeDeepSeekApprovedScope(input: Readonly<{
  tenantId: string;
  campaignId: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryBranch: string;
}>): void {
  if (input.tenantId !== REGAUGE_DEEPSEEK_APPROVED_SCOPE.tenantId ||
      input.campaignId !== REGAUGE_DEEPSEEK_APPROVED_SCOPE.campaignId ||
      input.repositoryOwner !== REGAUGE_DEEPSEEK_APPROVED_SCOPE.repositoryOwner ||
      input.repositoryName !== REGAUGE_DEEPSEEK_APPROVED_SCOPE.repositoryName ||
      input.repositoryBranch !== REGAUGE_DEEPSEEK_APPROVED_SCOPE.branch) {
    throw new Error("verifier_advisory_scope_invalid");
  }
}

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

function verifierPolicyEnvelope(input: Readonly<{
  tenantId: string;
  policyEnvelopeJson: string;
  branch: string;
  repositoryScope: string;
  processingRegion: string;
  createdAt: string;
}>): PolicyEnvelope {
  let unsafe: unknown;
  try { unsafe = JSON.parse(input.policyEnvelopeJson); }
  catch { throw new Error("verifier_advisory_policy_invalid"); }
  let envelope: PolicyEnvelope;
  try { envelope = parsePolicyEnvelope(unsafe); }
  catch { throw new Error("verifier_advisory_policy_invalid"); }
  if (!exactIso(input.createdAt) || envelope.tenantId !== input.tenantId ||
      !exactList(envelope.repositoryScope, [input.repositoryScope]) ||
      !exactList(envelope.branchScope, [input.branch])) {
    throw new Error("verifier_advisory_policy_template_scope_invalid");
  }
  if (!exactList(envelope.allowedTools, ["deepseek-verifier"]) ||
      !exactList(envelope.allowedModelClasses, ["rented_specialist"]) ||
      !envelope.externalProcessingAllowed || envelope.residency !== input.processingRegion ||
      envelope.riskCeiling !== "high" || !envelope.reviewRequired ||
      envelope.deploymentAllowed || envelope.trainingDataAllowed ||
      envelope.retentionDays === null || envelope.retentionDays > 90 ||
      !exactIso(envelope.createdAt) || envelope.createdAt > input.createdAt) {
    throw new Error("verifier_advisory_policy_authority_invalid");
  }
  return envelope;
}

function assertVerifierMissionScope(db: AppDb, input: Readonly<{
  tenantId: string;
  missionId: string;
  product: VerifierProduct;
  repositoryId: string;
  snapshotId: string;
  branch: string;
  repositoryScope: string;
}>): void {
  const mission = getMission(db, input.tenantId, input.missionId);
  const repository = getConnectedRepository(db, input.repositoryId, input.tenantId);
  const snapshot = listRepositorySnapshots(db, input.tenantId, input.repositoryId)
    .filter((candidate) => candidate.id === input.snapshotId);
  if (!mission || mission.product !== input.product || mission.repositoryId !== input.repositoryId ||
      mission.snapshotId !== input.snapshotId || snapshot.length !== 1 || !repository ||
      repository.selected_branch !== input.branch ||
      `${repository.owner}/${repository.name}` !== input.repositoryScope) {
    throw new Error("verifier_advisory_policy_authority_invalid");
  }
}

function retainAndBindVerifierPolicy(db: AppDb, input: Readonly<{
  tenantId: string;
  missionId: string;
  actorPrincipalId: string;
  taskId: string;
  createdAt: string;
  envelope: PolicyEnvelope;
  allowDefaultUpgrade: boolean;
}>): VerifierAdvisoryPolicyAuthority {
  const inheritedBefore = getMissionPolicyEnvelope(db, input.tenantId, input.missionId);
  const envelopeJson = canonicalPolicyEnvelopeJson(input.envelope);
  const envelopeSha256 = sha256(envelopeJson);
  const requiresAdvance = inheritedBefore !== null &&
    (inheritedBefore.contentSha256 !== envelopeSha256 ||
      inheritedBefore.policyEnvelopeId !== input.envelope.policyEnvelopeId);

  // Validate the only privileged upgrade before retaining any new authority.
  // A predictable legacy id is not sufficient: the retained bytes and digest
  // must be the exact canonical default v1 body, and the target must be v2.
  if (requiresAdvance) {
    if (!input.allowDefaultUpgrade || inheritedBefore.version !== 1 ||
        inheritedBefore.policyEnvelopeId !== defaultPolicyEnvelopeId(input.tenantId) ||
        input.envelope.version !== 2) {
      throw new Error("verifier_advisory_policy_binding_invalid");
    }
    let inheritedEnvelope: PolicyEnvelope;
    try { inheritedEnvelope = parsePolicyEnvelope(JSON.parse(inheritedBefore.envelopeJson)); }
    catch { throw new Error("verifier_advisory_policy_prior_default_invalid"); }
    const canonicalInherited = canonicalPolicyEnvelopeJson(inheritedEnvelope);
    const expectedDefault = canonicalPolicyEnvelopeJson(defaultPolicyEnvelope({
      tenantId: input.tenantId,
      policyEnvelopeId: defaultPolicyEnvelopeId(input.tenantId),
      version: 1,
      residency: inheritedEnvelope.residency,
      createdAt: inheritedEnvelope.createdAt,
    }));
    if (canonicalInherited !== inheritedBefore.envelopeJson ||
        sha256(canonicalInherited) !== inheritedBefore.contentSha256 ||
        canonicalInherited !== expectedDefault) {
      throw new Error("verifier_advisory_policy_prior_default_invalid");
    }
  }

  const stored = createPolicyEnvelope(db, {
    tenantId: input.envelope.tenantId,
    version: input.envelope.version,
    policyEnvelopeId: input.envelope.policyEnvelopeId,
    envelopeJson,
    createdAt: input.envelope.createdAt,
  });
  if (!inheritedBefore) {
    bindMissionToPolicyEnvelope(db, {
      tenantId: input.tenantId,
      missionId: input.missionId,
      version: input.envelope.version,
      actorPrincipalId: input.actorPrincipalId,
      eventId: `event-${sha256(`${input.missionId}\0${input.envelope.version}`).slice(0, 40)}`,
      idempotencyKey: `mission-policy-${input.missionId}-${input.envelope.version}`,
      correlationId: input.taskId,
      createdAt: input.createdAt,
    });
  } else if (requiresAdvance) {
    advanceMissionPolicyEnvelopeVersion(db, {
      tenantId: input.tenantId,
      missionId: input.missionId,
      expectedPolicyEnvelopeVersion: String(inheritedBefore.version),
      nextPolicyEnvelopeVersion: String(input.envelope.version),
      actorPrincipalId: input.actorPrincipalId,
      authorityRef: `policy-envelope:${input.envelope.policyEnvelopeId}`,
      eventId: `event-${sha256(`${input.missionId}\0policy-advance\0${input.envelope.version}`).slice(0, 40)}`,
      idempotencyKey: `mission-policy-advance-${input.missionId}-${input.envelope.version}`,
      correlationId: input.taskId,
      createdAt: input.createdAt,
    });
  }
  const inherited = getMissionPolicyEnvelope(db, input.tenantId, input.missionId);
  if (!inherited || inherited.contentSha256 !== stored.contentSha256 ||
      inherited.policyEnvelopeId !== input.envelope.policyEnvelopeId) {
    throw new Error("verifier_advisory_policy_binding_invalid");
  }
  return Object.freeze({
    policyEnvelopeId: input.envelope.policyEnvelopeId,
    policyEnvelopeVersion: input.envelope.version,
    policyEnvelopeSha256: stored.contentSha256,
    reviewRequired: true,
  });
}

/** Bind the exact restrictive verifier envelope before a ReGauge Mission starts. */
export function bindVerifierAdvisoryPolicyAuthorityAtMissionLaunch(
  db: AppDb,
  input: VerifierAdvisoryMissionPolicyBinding,
): VerifierAdvisoryPolicyAuthority {
  const envelope = verifierPolicyEnvelope(input);
  assertVerifierMissionScope(db, input);
  return retainAndBindVerifierPolicy(db, {
    tenantId: input.tenantId,
    missionId: input.missionId,
    actorPrincipalId: input.actorPrincipalId,
    taskId: input.missionId,
    createdAt: input.createdAt,
    envelope,
    allowDefaultUpgrade: true,
  });
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
  repositoryScope: string;
  processingRegion: string;
  createdAt: string;
}>): VerifierAdvisoryPolicyAuthority {
  const completion = verifyProductCompletionAdvisoryInput(input.completion);
  const envelope = verifierPolicyEnvelope({ ...input, tenantId: completion.tenantId });
  assertVerifierMissionScope(db, {
    tenantId: completion.tenantId,
    missionId: completion.missionId,
    product: completion.product,
    repositoryId: completion.repositoryId,
    snapshotId: completion.snapshotId,
    branch: input.branch,
    repositoryScope: input.repositoryScope,
  });
  const decision = evaluatePolicyEnvelope(envelope, {
    repositoryId: input.repositoryScope,
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
  return retainAndBindVerifierPolicy(db, {
    tenantId: completion.tenantId,
    missionId: completion.missionId,
    actorPrincipalId: input.actorPrincipalId,
    taskId: completion.taskId,
    createdAt: input.createdAt,
    envelope,
    allowDefaultUpgrade: completion.product === "regauge" &&
      completion.tenantId === REGAUGE_DEEPSEEK_APPROVED_SCOPE.tenantId &&
      input.repositoryScope === REGAUGE_DEEPSEEK_APPROVED_SCOPE.repositoryFullName &&
      input.branch === REGAUGE_DEEPSEEK_APPROVED_SCOPE.branch &&
      completion.taskId.startsWith(`${REGAUGE_DEEPSEEK_APPROVED_SCOPE.campaignId}:`),
  });
}

function payloadFor(
  input: ProductCompletionAdvisoryInput,
  artifactId: string,
  inputSha256: string,
  evidenceArtifactId: string,
  evidenceSha256: string,
): AdvisoryPayload {
  return Object.freeze({
    schemaVersion: 1,
    inputArtifactId: artifactId,
    inputSha256,
    missionId: input.missionId,
    taskId: input.taskId,
    product: input.product,
    substantiveEvidenceArtifactId: evidenceArtifactId,
    substantiveEvidenceSha256: evidenceSha256,
  });
}

function jobId(input: ProductCompletionAdvisoryInput, inputSha256: string): string {
  const digest = sha256(canonical({ schemaVersion: 1, tenantId: input.tenantId,
    missionId: input.missionId, taskId: input.taskId, product: input.product, inputSha256 }));
  return `verifier_advisory_${digest.slice(0, 40)}`;
}

export function enqueueVerifierAdvisoryJob(db: AppDb, input: Readonly<{
  completion: ProductCompletionAdvisoryInput;
  substantiveEvidence?: VerifierAdvisorySubstantiveEvidence;
  producerPrincipalId?: string | null;
  createdAt: string;
}>): EnqueueVerifierAdvisoryResult {
  const completion = verifyProductCompletionAdvisoryInput(input.completion);
  if (!exactIso(input.createdAt) || input.createdAt !== completion.observedAt) {
    throw new Error("verifier_advisory_created_at_invalid");
  }
  if (!input.substantiveEvidence) throw new Error("verifier_advisory_substantive_evidence_required");
  const substantiveEvidence = verifySubstantiveEvidence(input.substantiveEvidence, completion);
  const evidenceContent = canonical(substantiveEvidence);
  const evidenceSha256 = sha256(evidenceContent);
  const evidenceArtifactId = `verifier-advisory-evidence-${evidenceSha256.slice(0, 40)}`;
  const content = canonical(completion);
  const inputSha256 = sha256(content);
  const inputArtifactId = `verifier-advisory-input-${inputSha256.slice(0, 40)}`;
  const id = jobId(completion, inputSha256);
  const payload = payloadFor(completion, inputArtifactId, inputSha256, evidenceArtifactId, evidenceSha256);
  const expectedPayload = canonical(payload);
  const owns = !db.raw.isTransaction;
  const savepoint = `verifier_advisory_${inputSha256.slice(0, 12)}`;
  if (owns) db.raw.exec("BEGIN IMMEDIATE"); else db.raw.exec(`SAVEPOINT ${savepoint}`);
  try {
    insertArtifactManifest(db, {
      id: evidenceArtifactId,
      tenantId: completion.tenantId,
      kind: SUBSTANTIVE_EVIDENCE_KIND,
      schemaVersion: 1,
      sha256: evidenceSha256,
      mediaType: SUBSTANTIVE_EVIDENCE_MEDIA_TYPE,
      sizeBytes: Buffer.byteLength(evidenceContent, "utf8"),
      storageRef: `sqlite://artifact_manifests/${evidenceArtifactId}`,
      content: evidenceContent,
      producerPrincipalId: input.producerPrincipalId ?? null,
      createdAt: input.createdAt,
    });
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
  if (canonical(Object.keys(raw).sort()) !== canonical(["inputArtifactId", "inputSha256", "missionId", "product", "schemaVersion", "substantiveEvidenceArtifactId", "substantiveEvidenceSha256", "taskId"]) ||
      raw.schemaVersion !== 1 || !ID.test(String(raw.inputArtifactId)) ||
      !/^[a-f0-9]{64}$/.test(String(raw.inputSha256)) || !ID.test(String(raw.missionId)) ||
      !ID.test(String(raw.substantiveEvidenceArtifactId)) ||
      !/^[a-f0-9]{64}$/.test(String(raw.substantiveEvidenceSha256)) ||
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

function verifySubstantiveEvidence(
  value: unknown,
  completion: ProductCompletionAdvisoryInput,
): VerifierAdvisorySubstantiveEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("verifier_advisory_substantive_evidence_invalid");
  }
  const raw = value as Record<string, unknown>;
  const keys = ["candidateDigest", "candidateId", "changedPaths", "repositoryId", "schemaVersion", "snapshotDigest", "snapshotId", "sources", "tenantId"];
  const sources = raw.sources;
  if (canonical(Object.keys(raw).sort()) !== canonical(keys) || raw.schemaVersion !== 1 ||
      raw.tenantId !== completion.tenantId || raw.repositoryId !== completion.repositoryId ||
      raw.snapshotId !== completion.snapshotId || raw.snapshotDigest !== completion.snapshotDigest ||
      raw.candidateId !== completion.candidateId || raw.candidateDigest !== completion.candidateDigest ||
      !Array.isArray(raw.changedPaths) || canonical(raw.changedPaths) !== canonical(completion.changedPaths) ||
      !Array.isArray(sources) || sources.length === 0 || sources.length > 32) {
    throw new Error("verifier_advisory_substantive_evidence_invalid");
  }
  let totalBytes = 0;
  const verified = sources.map((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error("verifier_advisory_substantive_evidence_invalid");
    }
    const candidate = source as Record<string, unknown>;
    if (canonical(Object.keys(candidate).sort()) !== canonical(["content", "digest", "id", "kind", "locator"]) ||
        !ID.test(String(candidate.id)) ||
        !["repository_excerpt", "graph", "retrieval"].includes(String(candidate.kind)) ||
        !DIGEST.test(String(candidate.digest)) || !text(candidate.locator, 2_048) ||
        !text(candidate.content, 32_000) ||
        candidate.digest !== `sha256:${sha256(candidate.content as string)}`) {
      throw new Error("verifier_advisory_substantive_evidence_invalid");
    }
    totalBytes += Buffer.byteLength(candidate.content as string, "utf8");
    return Object.freeze({
      id: candidate.id as string,
      kind: candidate.kind as VerifierSourceInput["kind"],
      digest: candidate.digest as string,
      locator: candidate.locator as string,
      content: candidate.content as string,
    });
  });
  if (totalBytes > 256 * 1024 || new Set(verified.map((source) => source.id)).size !== verified.length) {
    throw new Error("verifier_advisory_substantive_evidence_invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    tenantId: completion.tenantId,
    repositoryId: completion.repositoryId,
    snapshotId: completion.snapshotId,
    snapshotDigest: completion.snapshotDigest,
    candidateId: completion.candidateId,
    candidateDigest: completion.candidateDigest,
    changedPaths: Object.freeze([...completion.changedPaths]),
    sources: Object.freeze(verified),
  });
}

export function readVerifierAdvisoryJobSubstantiveEvidence(
  db: AppDb,
  job: JobRow,
  completion: ProductCompletionAdvisoryInput,
): VerifierAdvisorySubstantiveEvidence {
  const payload = parsePayload(job);
  const matches = listArtifactManifests(db, job.tenant_id, SUBSTANTIVE_EVIDENCE_KIND)
    .filter((artifact) => artifact.id === payload.substantiveEvidenceArtifactId);
  if (matches.length !== 1) throw new Error("verifier_advisory_substantive_evidence_missing");
  const artifact = matches[0]!;
  const content = artifact.content_text;
  if (artifact.schema_version !== 1 || artifact.media_type !== SUBSTANTIVE_EVIDENCE_MEDIA_TYPE ||
      content === null || artifact.sha256 !== payload.substantiveEvidenceSha256 ||
      sha256(content) !== artifact.sha256 || Buffer.byteLength(content, "utf8") !== artifact.size_bytes) {
    throw new Error("verifier_advisory_substantive_evidence_integrity_invalid");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { throw new Error("verifier_advisory_substantive_evidence_invalid"); }
  return verifySubstantiveEvidence(parsed, completion);
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

type ConsentSnapshot = Readonly<{
  id: string;
  tenantId: string;
  consentVersion: number;
  action: "granted";
  purpose: string;
  residencyRegion: string;
  authorizedByPrincipalId: string;
  supersedesConsentId: string | null;
  effectiveAt: string;
  expiresAt: string;
  reason: string;
  idempotencyKey: string;
  requestFingerprint: string;
  createdAt: string;
}>;

type ProviderRequestIntent = Readonly<{
  schemaVersion: "2026-08-24.verifier-provider-request.v1";
  operationKey: string;
  operationId: string;
  attempt: number;
  tenantId: string;
  verificationAttemptId: string;
  evidencePackDigest: string;
  providerRequestId: string;
  requestBodySha256: string;
  requestedAt: string;
  consent: ConsentSnapshot;
  consentRecordDigest: string;
}>;

type ProviderResponseReceipt = Readonly<{
  schemaVersion: "2026-08-24.verifier-provider-response.v1";
  operationId: string;
  providerProcessedAt: string;
  responseDigest: string;
  response: VerifierHttpResponse;
}>;

type ProviderRetryableResponse = Readonly<{
  schemaVersion: "2026-08-24.verifier-provider-retryable-response.v1";
  operationId: string;
  responseDigest: string;
  errorCode: "api_failure" | "logprob_failure";
  classifiedAt: string;
}>;

function consentSnapshot(row: LearningConsentRow): ConsentSnapshot {
  if (row.action !== "granted" || row.expires_at === null) {
    throw new Error("verifier_advisory_consent_invalid");
  }
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    consentVersion: row.consent_version,
    action: row.action,
    purpose: row.purpose,
    residencyRegion: row.residency_region,
    authorizedByPrincipalId: row.authorized_by_principal_id,
    supersedesConsentId: row.supersedes_consent_id,
    effectiveAt: row.effective_at,
    expiresAt: row.expires_at,
    reason: row.reason,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    createdAt: row.created_at,
  });
}

function binding(snapshot: ConsentSnapshot, consentRecordDigest: string): VerifierAdvisoryConsentBinding {
  return Object.freeze({
    consentId: snapshot.id,
    consentRecordDigest,
    consentGrantedAt: snapshot.createdAt,
    consentEffectiveAt: snapshot.effectiveAt,
    consentExpiresAt: snapshot.expiresAt,
  });
}

function storeArtifact(db: AppDb, input: Readonly<{
  id: string;
  tenantId: string;
  kind: string;
  mediaType: string;
  content: string;
  producerPrincipalId?: string | null;
  createdAt: string;
}>): boolean {
  return insertArtifactManifest(db, {
    id: input.id,
    tenantId: input.tenantId,
    kind: input.kind,
    schemaVersion: 1,
    sha256: sha256(input.content),
    mediaType: input.mediaType,
    sizeBytes: Buffer.byteLength(input.content, "utf8"),
    storageRef: `sqlite://artifact_manifests/${input.id}`,
    content: input.content,
    producerPrincipalId: input.producerPrincipalId ?? null,
    createdAt: input.createdAt,
  }).inserted;
}

function parseOperationArtifacts<T>(db: AppDb, tenantId: string, kind: string): T[] {
  return listArtifactManifests(db, tenantId, kind).map((artifact) => {
    if (artifact.schema_version !== 1 || !artifact.content_text ||
        sha256(artifact.content_text) !== artifact.sha256 ||
        Buffer.byteLength(artifact.content_text, "utf8") !== artifact.size_bytes) {
      throw new Error("verifier_advisory_provider_artifact_invalid");
    }
    try { return JSON.parse(artifact.content_text) as T; }
    catch { throw new Error("verifier_advisory_provider_artifact_invalid"); }
  });
}

function responseFor(db: AppDb, tenantId: string, operationId: string): ProviderResponseReceipt | null {
  const matches = parseOperationArtifacts<ProviderResponseReceipt>(db, tenantId, PROVIDER_RESPONSE_KIND)
    .filter((receipt) => receipt.operationId === operationId);
  if (matches.length > 1) throw new Error("verifier_advisory_provider_response_ambiguous");
  const receipt = matches[0];
  if (!receipt) return null;
  if (receipt.schemaVersion !== "2026-08-24.verifier-provider-response.v1" ||
      !exactIso(receipt.providerProcessedAt) || !DIGEST.test(receipt.responseDigest) ||
      receipt.responseDigest !== `sha256:${sha256(canonical(receipt.response))}`) {
    throw new Error("verifier_advisory_provider_response_invalid");
  }
  return receipt;
}

function hasNoResponseFailure(db: AppDb, tenantId: string, operationId: string): boolean {
  const matches = parseOperationArtifacts<{ schemaVersion: string; operationId: string; failedAt: string; errorCode: string }>(db, tenantId, PROVIDER_NO_RESPONSE_KIND)
    .filter((failure) => failure.operationId === operationId);
  if (matches.length > 1) throw new Error("verifier_advisory_provider_failure_ambiguous");
  if (matches[0] && (matches[0].schemaVersion !== "2026-08-24.verifier-provider-no-response.v1" ||
      !exactIso(matches[0].failedAt) || !ID.test(matches[0].errorCode))) {
    throw new Error("verifier_advisory_provider_failure_invalid");
  }
  return matches.length === 1;
}

function retryableResponseFor(
  db: AppDb,
  tenantId: string,
  operationId: string,
): ProviderRetryableResponse | null {
  const matches = parseOperationArtifacts<ProviderRetryableResponse>(db, tenantId, PROVIDER_RETRYABLE_RESPONSE_KIND)
    .filter((outcome) => outcome.operationId === operationId);
  if (matches.length > 1) throw new Error("verifier_advisory_provider_retryable_response_ambiguous");
  const outcome = matches[0];
  if (!outcome) return null;
  const receipt = responseFor(db, tenantId, operationId);
  if (!receipt || outcome.schemaVersion !== "2026-08-24.verifier-provider-retryable-response.v1" ||
      outcome.responseDigest !== receipt.responseDigest || !exactIso(outcome.classifiedAt) ||
      outcome.classifiedAt < receipt.providerProcessedAt ||
      outcome.errorCode !== "api_failure" && outcome.errorCode !== "logprob_failure") {
    throw new Error("verifier_advisory_provider_retryable_response_invalid");
  }
  return outcome;
}

export function beginVerifierAdvisoryProviderOperation(db: AppDb, input: Readonly<{
  tenantId: string;
  verificationAttemptId: string;
  evidencePackDigest: string;
  providerRequestId: string;
  requestBodySha256: string;
  expectedConsentId: string;
  consentPurpose: string;
  authorizationDeadline: string;
  requestedAt: string;
  producerPrincipalId?: string | null;
}>): VerifierAdvisoryProviderOperation {
  if (!exactIso(input.requestedAt) || !exactIso(input.authorizationDeadline) ||
      !DIGEST.test(input.evidencePackDigest) || !DIGEST.test(input.requestBodySha256) ||
      !ID.test(input.verificationAttemptId) || !ID.test(input.providerRequestId) ||
      !ID.test(input.expectedConsentId) || !text(input.consentPurpose)) {
    throw new Error("verifier_advisory_provider_request_invalid");
  }
  const operationKey = `sha256:${sha256(canonical({
    schemaVersion: 1,
    tenantId: input.tenantId,
    verificationAttemptId: input.verificationAttemptId,
    evidencePackDigest: input.evidencePackDigest,
    providerRequestId: input.providerRequestId,
    requestBodySha256: input.requestBodySha256,
  }))}`;
  const intents = parseOperationArtifacts<ProviderRequestIntent>(db, input.tenantId, PROVIDER_REQUEST_KIND)
    .filter((intent) => intent.operationKey === operationKey)
    .sort((left, right) => left.attempt - right.attempt);
  if (new Set(intents.map((intent) => intent.attempt)).size !== intents.length ||
      intents.some((intent) => intent.schemaVersion !== "2026-08-24.verifier-provider-request.v1" ||
      intent.tenantId !== input.tenantId || intent.verificationAttemptId !== input.verificationAttemptId ||
      intent.evidencePackDigest !== input.evidencePackDigest || intent.providerRequestId !== input.providerRequestId ||
      intent.requestBodySha256 !== input.requestBodySha256 || !Number.isSafeInteger(intent.attempt) ||
      intent.attempt < 1 || intent.consentRecordDigest !== `sha256:${sha256(canonical(intent.consent))}`)) {
    throw new Error("verifier_advisory_provider_request_invalid");
  }
  const latest = intents.at(-1);
  if (latest) {
    const receipt = responseFor(db, input.tenantId, latest.operationId);
    if (receipt && !retryableResponseFor(db, input.tenantId, latest.operationId)) {
      return Object.freeze({
        status: "recover",
        operationId: latest.operationId,
        consent: binding(latest.consent, latest.consentRecordDigest),
        response: receipt.response,
      });
    }
    if (!receipt && !hasNoResponseFailure(db, input.tenantId, latest.operationId)) {
      throw new Error("verifier_advisory_provider_outcome_unknown");
    }
  }
  const consent = findActiveLearningConsent(db, {
    tenantId: input.tenantId,
    purpose: input.consentPurpose,
    at: input.requestedAt,
  });
  if (!consent || consent.id !== input.expectedConsentId || consent.created_at >= input.requestedAt ||
      consent.effective_at >= input.requestedAt || consent.expires_at === null ||
      consent.expires_at <= input.requestedAt || consent.expires_at > input.authorizationDeadline) {
    throw new Error("verifier_advisory_consent_invalid");
  }
  const snapshot = consentSnapshot(consent);
  const consentRecordDigest = `sha256:${sha256(canonical(snapshot))}`;
  const attempt = (latest?.attempt ?? 0) + 1;
  const operationId = `verifier-provider-${operationKey.slice("sha256:".length, "sha256:".length + 32)}-${attempt}`;
  const intent: ProviderRequestIntent = Object.freeze({
    schemaVersion: "2026-08-24.verifier-provider-request.v1",
    operationKey,
    operationId,
    attempt,
    tenantId: input.tenantId,
    verificationAttemptId: input.verificationAttemptId,
    evidencePackDigest: input.evidencePackDigest,
    providerRequestId: input.providerRequestId,
    requestBodySha256: input.requestBodySha256,
    requestedAt: input.requestedAt,
    consent: snapshot,
    consentRecordDigest,
  });
  const inserted = storeArtifact(db, {
    id: operationId,
    tenantId: input.tenantId,
    kind: PROVIDER_REQUEST_KIND,
    mediaType: "application/vnd.mendpoint.agent-verifier-provider-request.v1+json",
    content: canonical(intent),
    producerPrincipalId: input.producerPrincipalId,
    createdAt: input.requestedAt,
  });
  if (!inserted) throw new Error("verifier_advisory_provider_outcome_unknown");
  return Object.freeze({
    status: "ready",
    operationId,
    consent: binding(snapshot, consentRecordDigest),
    response: null,
  });
}

export function persistVerifierAdvisoryProviderRetryableResponse(db: AppDb, input: Readonly<{
  tenantId: string;
  operationId: string;
  errorCode: "api_failure" | "logprob_failure";
  classifiedAt: string;
  producerPrincipalId?: string | null;
}>): void {
  const intent = exactIntent(db, input.tenantId, input.operationId);
  const receipt = responseFor(db, input.tenantId, input.operationId);
  if (!receipt || !exactIso(input.classifiedAt) || input.classifiedAt < receipt.providerProcessedAt ||
      input.classifiedAt >= intent.consent.expiresAt ||
      input.errorCode !== "api_failure" && input.errorCode !== "logprob_failure") {
    throw new Error("verifier_advisory_provider_retryable_response_invalid");
  }
  const outcome: ProviderRetryableResponse = Object.freeze({
    schemaVersion: "2026-08-24.verifier-provider-retryable-response.v1",
    operationId: input.operationId,
    responseDigest: receipt.responseDigest,
    errorCode: input.errorCode,
    classifiedAt: input.classifiedAt,
  });
  storeArtifact(db, {
    id: `${input.operationId}-retryable-response`,
    tenantId: input.tenantId,
    kind: PROVIDER_RETRYABLE_RESPONSE_KIND,
    mediaType: "application/vnd.mendpoint.agent-verifier-provider-retryable-response.v1+json",
    content: canonical(outcome),
    producerPrincipalId: input.producerPrincipalId,
    createdAt: input.classifiedAt,
  });
}

function exactIntent(db: AppDb, tenantId: string, operationId: string): ProviderRequestIntent {
  const matches = parseOperationArtifacts<ProviderRequestIntent>(db, tenantId, PROVIDER_REQUEST_KIND)
    .filter((intent) => intent.operationId === operationId);
  if (matches.length !== 1) throw new Error("verifier_advisory_provider_request_missing");
  const intent = matches[0]!;
  if (intent.schemaVersion !== "2026-08-24.verifier-provider-request.v1" ||
      intent.tenantId !== tenantId || intent.operationId !== operationId ||
      !Number.isSafeInteger(intent.attempt) || intent.attempt < 1 ||
      intent.consentRecordDigest !== `sha256:${sha256(canonical(intent.consent))}`) {
    throw new Error("verifier_advisory_consent_binding_invalid");
  }
  return intent;
}

export function persistVerifierAdvisoryProviderResponse(db: AppDb, input: Readonly<{
  tenantId: string;
  operationId: string;
  response: VerifierHttpResponse;
  providerProcessedAt: string;
  producerPrincipalId?: string | null;
}>): void {
  const intent = exactIntent(db, input.tenantId, input.operationId);
  if (!exactIso(input.providerProcessedAt) || input.providerProcessedAt < intent.requestedAt ||
      input.providerProcessedAt >= intent.consent.expiresAt ||
      hasNoResponseFailure(db, input.tenantId, input.operationId)) {
    throw new Error("verifier_advisory_provider_response_invalid");
  }
  const responseDigest = `sha256:${sha256(canonical(input.response))}`;
  const receipt: ProviderResponseReceipt = Object.freeze({
    schemaVersion: "2026-08-24.verifier-provider-response.v1",
    operationId: input.operationId,
    providerProcessedAt: input.providerProcessedAt,
    responseDigest,
    response: input.response,
  });
  storeArtifact(db, {
    id: `${input.operationId}-response`,
    tenantId: input.tenantId,
    kind: PROVIDER_RESPONSE_KIND,
    mediaType: "application/vnd.mendpoint.agent-verifier-provider-response.v1+json",
    content: canonical(receipt),
    producerPrincipalId: input.producerPrincipalId,
    createdAt: input.providerProcessedAt,
  });
}

export function persistVerifierAdvisoryProviderNoResponse(db: AppDb, input: Readonly<{
  tenantId: string;
  operationId: string;
  failedAt: string;
  errorCode: string;
  producerPrincipalId?: string | null;
}>): void {
  const intent = exactIntent(db, input.tenantId, input.operationId);
  if (!exactIso(input.failedAt) || input.failedAt < intent.requestedAt ||
      responseFor(db, input.tenantId, input.operationId) || !ID.test(input.errorCode)) {
    throw new Error("verifier_advisory_provider_failure_invalid");
  }
  const failure = Object.freeze({
    schemaVersion: "2026-08-24.verifier-provider-no-response.v1",
    operationId: input.operationId,
    failedAt: input.failedAt,
    errorCode: input.errorCode,
  });
  storeArtifact(db, {
    id: `${input.operationId}-no-response`,
    tenantId: input.tenantId,
    kind: PROVIDER_NO_RESPONSE_KIND,
    mediaType: "application/vnd.mendpoint.agent-verifier-provider-no-response.v1+json",
    content: canonical(failure),
    producerPrincipalId: input.producerPrincipalId,
    createdAt: input.failedAt,
  });
}

export function readVerifierAdvisoryProviderEvidence(db: AppDb, input: Readonly<{
  tenantId: string;
  verificationAttemptId: string;
  evidencePackDigest: string;
}>): VerifierAdvisoryProviderEvidence | null {
  const intents = parseOperationArtifacts<ProviderRequestIntent>(db, input.tenantId, PROVIDER_REQUEST_KIND)
    .filter((intent) => intent.verificationAttemptId === input.verificationAttemptId &&
      intent.evidencePackDigest === input.evidencePackDigest);
  const completed = intents.flatMap((intent) => {
    const receipt = responseFor(db, input.tenantId, intent.operationId);
    return receipt ? [{ intent, receipt }] : [];
  });
  if (completed.length === 0) return null;
  const verified = completed.map(({ intent, receipt }) => {
    const exact = exactIntent(db, input.tenantId, intent.operationId);
    if (exact.consent.createdAt >= exact.requestedAt || exact.consent.effectiveAt >= exact.requestedAt ||
        receipt.providerProcessedAt < exact.requestedAt || receipt.providerProcessedAt >= exact.consent.expiresAt ||
        receipt.responseDigest !== `sha256:${sha256(canonical(receipt.response))}`) {
      throw new Error("verifier_advisory_provider_evidence_invalid");
    }
    return { intent: exact, receipt };
  }).sort((left, right) => left.intent.requestedAt.localeCompare(right.intent.requestedAt) ||
    left.intent.providerRequestId.localeCompare(right.intent.providerRequestId));
  const first = verified[0]!;
  if (verified.some(({ intent }) => intent.consentRecordDigest !== first.intent.consentRecordDigest)) {
    throw new Error("verifier_advisory_provider_evidence_ambiguous");
  }
  const lastProcessedAt = verified.map(({ receipt }) => receipt.providerProcessedAt).sort().at(-1)!;
  return Object.freeze({
    ...binding(first.intent.consent, first.intent.consentRecordDigest),
    providerRequestId: verified.map(({ intent }) => intent.providerRequestId).join(","),
    providerRequestedAt: first.intent.requestedAt,
    providerProcessedAt: lastProcessedAt,
    providerResponseDigest: `sha256:${sha256(canonical(verified.map(({ receipt }) => receipt.responseDigest)))}`,
  });
}

export function getVerifierAdvisoryJob(db: AppDb, id: string, tenantId: string): JobRow | undefined {
  const job = getJob(db, id, tenantId);
  return job?.type === VERIFIER_ADVISORY_JOB_TYPE ? job : undefined;
}
