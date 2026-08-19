import { createHash } from "node:crypto";
import {
  appendDomainEvent,
  getFettlerDelegationEvidence,
  getWardenCandidateDelivery,
  getWardenCiCycle,
  insertArtifactManifest,
  insertEvidenceRecord,
  verifyDomainEventIntegrity,
  type AppDb,
  type DurableEvidence,
  type FettlerDelegationEvidence,
} from "@mendpoint/db";
import {
  cleanupExactDraftWithOctokit,
  type ExactDraftCleanupEvidence,
  type ExactDraftCleanupInput,
  type ExactHeadRefCompareAndDeleteAuthority,
} from "@mendpoint/github";
import type {
  SoftwareAttestationSigner,
  SoftwareAttestationTrustPolicy,
} from "@mendpoint/contract";
import {
  issueSoftwareAttestation,
  verifyStoredSoftwareAttestation,
  type IssuedSoftwareAttestation,
} from "./software-attestation-operation.js";

type CleanupOctokit = Parameters<typeof cleanupExactDraftWithOctokit>[0];

export type DelegatedPrCleanupArtifactRefs = Readonly<{
  sourceIds: readonly string[];
  snapshotId: string;
  candidateId: string;
  verificationIds: readonly string[];
  policyId: string;
  deliveryId: string;
}>;

export type RecordDelegatedPrCleanupInput = Readonly<{
  tenantId: string;
  runId: string;
  correlationId: string;
  actorPrincipalId: string;
  deliveryRecordId: string;
  cycleId: string;
  idempotencyKey: string;
  observedAt: string;
  cleanup: ExactDraftCleanupInput;
  artifacts: DelegatedPrCleanupArtifactRefs;
}>;

export type DelegatedPrCleanupOperationDependencies = Readonly<{
  enabled?: boolean;
  octokit: CleanupOctokit;
  compareAndDeleteAuthority?: ExactHeadRefCompareAndDeleteAuthority;
  signer: SoftwareAttestationSigner;
  producerService?: string;
  producerVersion?: string;
  authorizeActor(db: AppDb, input: RecordDelegatedPrCleanupInput): boolean;
}>;

export type RecordedDelegatedPrCleanup = Readonly<{
  cleanupId: string;
  cleanupArtifactId: string;
  evidenceId: string;
  cleanup: ExactDraftCleanupEvidence;
  observedAt: string;
  attestation: IssuedSoftwareAttestation;
}>;

export type VerifiedDelegatedPrCleanup = Readonly<{
  cleanupId: string;
  cleanupArtifactId: string;
  evidenceId: string;
  cleanup: ExactDraftCleanupEvidence;
  observedAt: string;
  attestation: Awaited<ReturnType<typeof verifyStoredSoftwareAttestation>>;
}>;

export type VerifiedFettlerCleanupEvidence = Readonly<{
  cleanupId: string;
  artifact: Readonly<{ artifactId: string; sha256: string }>;
  attestationId: string;
  signerKeyIds: readonly string[];
  observedAt: string;
  cleanup: ExactDraftCleanupEvidence;
}>;

export type VerifiedFettlerDelegationEvidence = Omit<FettlerDelegationEvidence, "cleanup"> & Readonly<{
  cleanup: DurableEvidence<VerifiedFettlerCleanupEvidence>;
}>;

type RecordedCleanup = Omit<RecordedDelegatedPrCleanup, "attestation"> & Readonly<{
  repositoryId: string;
  deliveryArtifactId: string;
  attestationId: string | null;
}>;

const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function snapshotPlain<T>(value: T, code: string): T {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 20_000 || depth > 24) throw new Error(code);
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error(code);
      return current;
    }
    if (Array.isArray(current)) {
      if (seen.has(current) || current.length > 2_000) throw new Error(code);
      seen.add(current);
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const result: unknown[] = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) {
          throw new Error(code);
        }
        result.push(visit(descriptor.value, depth + 1));
      }
      seen.delete(current);
      return result;
    }
    if (typeof current !== "object" || current === undefined) throw new Error(code);
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
    if (seen.has(current)) throw new Error(code);
    seen.add(current);
    const result: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))
      .sort(([left], [right]) => compareCodeUnits(left, right))) {
      if (!("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) throw new Error(code);
      result[key] = visit(descriptor.value, depth + 1);
    }
    seen.delete(current);
    return result;
  };
  return deepFreeze(visit(value, 0) as T);
}

function snapshotDependencies(
  dependencies: DelegatedPrCleanupOperationDependencies,
): DelegatedPrCleanupOperationDependencies {
  const signerReceiver = dependencies?.signer;
  const signOperation = signerReceiver?.sign;
  const authorizeReceiver = dependencies;
  const authorizeOperation = dependencies?.authorizeActor;
  if (!signerReceiver || typeof signOperation !== "function" || typeof authorizeOperation !== "function") {
    throw new Error("delegated_pr_cleanup_dependencies_invalid");
  }
  return Object.freeze({
    enabled: dependencies.enabled,
    octokit: dependencies.octokit,
    compareAndDeleteAuthority: dependencies.compareAndDeleteAuthority,
    signer: Object.freeze({
      keyId: signerReceiver.keyId,
      algorithm: signerReceiver.algorithm,
      sign: (bytes: Uint8Array) => Reflect.apply(signOperation, signerReceiver, [bytes]),
    }),
    producerService: dependencies.producerService,
    producerVersion: dependencies.producerVersion,
    authorizeActor: (db: AppDb, input: RecordDelegatedPrCleanupInput) =>
      Reflect.apply(authorizeOperation, authorizeReceiver, [db, input]),
  });
}

function validTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validateInput(input: RecordDelegatedPrCleanupInput): void {
  const ids = [input.tenantId, input.runId, input.correlationId, input.actorPrincipalId,
    input.deliveryRecordId, input.cycleId, input.idempotencyKey,
    input.artifacts.snapshotId, input.artifacts.candidateId, input.artifacts.policyId,
    input.artifacts.deliveryId, ...input.artifacts.sourceIds, ...input.artifacts.verificationIds];
  if (ids.some((value) => typeof value !== "string" || !ID.test(value)) ||
      !validTimestamp(input.observedAt) || input.artifacts.sourceIds.length === 0 ||
      input.artifacts.verificationIds.length === 0 ||
      new Set(input.artifacts.sourceIds).size !== input.artifacts.sourceIds.length ||
      new Set(input.artifacts.verificationIds).size !== input.artifacts.verificationIds.length) {
    throw new Error("delegated_pr_cleanup_input_invalid");
  }
}

function githubPullIdentity(url: string): { owner: string; repo: string; number: number } | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const number = Number(parts[3]);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password ||
        parsed.search || parsed.hash || parts.length !== 4 || parts[2] !== "pull" ||
        !Number.isSafeInteger(number) || number < 1) return null;
    return { owner: parts[0]!, repo: parts[1]!, number };
  } catch {
    return null;
  }
}

function authoritySnapshot(db: AppDb, input: RecordDelegatedPrCleanupInput) {
  const delivery = getWardenCandidateDelivery(db, input.tenantId, input.deliveryRecordId);
  const cycle = getWardenCiCycle(db, input.tenantId, input.cycleId);
  const principal = db.raw.prepare(
    `SELECT id FROM principals WHERE tenant_id = ? AND id = ? AND kind = 'service'
       AND created_at <= ? AND (expires_at IS NULL OR expires_at > ?)
       AND (revoked_at IS NULL OR revoked_at > ?)`,
  ).get(input.tenantId, input.actorPrincipalId, input.observedAt, input.observedAt, input.observedAt);
  if (!delivery || !cycle || !principal || delivery.status !== "delivered" || delivery.draftPr !== true ||
      delivery.branchName === null || delivery.baseRevision === null || delivery.commitSha === null ||
      delivery.draftPrNumber === null || delivery.draftPrUrl === null) {
    throw new Error("delegated_pr_cleanup_authority_not_found");
  }
  const remote = githubPullIdentity(delivery.draftPrUrl);
  const cleanup = input.cleanup;
  const matches = remote !== null && delivery.tenantId === input.tenantId && delivery.runId === input.runId &&
    cycle.deliveryId === delivery.id && cycle.repositoryId === delivery.repositoryId &&
    cycle.remoteRepositoryId === cleanup.expectedRepositoryId && cycle.installationId === cleanup.installationId &&
    cycle.pullRequestNumber === delivery.draftPrNumber && cycle.pullRequestNumber === cleanup.pullRequestNumber &&
    cycle.baseBranch === delivery.baseBranch && cycle.baseBranch === cleanup.baseBranch &&
    cycle.branchName === delivery.branchName && cycle.branchName === cleanup.headBranch &&
    cycle.baseRevision === delivery.baseRevision && cycle.baseRevision === cleanup.expectedBaseSha &&
    cycle.currentHeadSha === delivery.commitSha && cycle.currentHeadSha === cleanup.expectedHeadSha &&
    remote.owner === cleanup.owner && remote.repo === cleanup.repo && remote.number === cleanup.pullRequestNumber;
  if (!matches) throw new Error("delegated_pr_cleanup_scope_mismatch");
  return deepFreeze({ delivery, cycle });
}

function requestDigest(input: RecordDelegatedPrCleanupInput): string {
  return sha256(canonical({ ...input, observedAt: undefined }));
}

function cleanupIds(input: RecordDelegatedPrCleanupInput, digest: string) {
  const root = sha256(`${input.tenantId}\0${input.idempotencyKey}\0${digest}`);
  return {
    cleanupId: `delegated_cleanup_${root.slice(0, 40)}`,
    cleanupArtifactId: `artifact_cleanup_${root.slice(0, 40)}`,
    evidenceId: `evidence_cleanup_${root.slice(0, 40)}`,
  };
}

function readRecordedByKey(
  db: AppDb,
  input: RecordDelegatedPrCleanupInput,
  expectedDigest: string,
): RecordedCleanup | undefined {
  const event = db.raw.prepare(
    `SELECT aggregate_id, payload_json FROM domain_events
       WHERE tenant_id = ? AND idempotency_key = ? AND event_type = 'fettler_delegation_cleanup.recorded'`,
  ).get(input.tenantId, `delegated-pr-cleanup:${input.idempotencyKey}`) as
    | { aggregate_id: string; payload_json: string }
    | undefined;
  if (!event) return undefined;
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(event.payload_json) as Record<string, unknown>; }
  catch { throw new Error("delegated_pr_cleanup_event_corrupt"); }
  if (payload.requestDigest !== expectedDigest || payload.runId !== input.runId ||
      payload.correlationId !== input.correlationId || payload.deliveryRecordId !== input.deliveryRecordId ||
      payload.cycleId !== input.cycleId || typeof payload.cleanupArtifactId !== "string" ||
      typeof payload.evidenceId !== "string" || typeof payload.repositoryId !== "string" ||
      typeof payload.deliveryArtifactId !== "string" || typeof payload.observedAt !== "string") {
    throw new Error("delegated_pr_cleanup_idempotency_conflict");
  }
  return readRecorded(db, input.tenantId, event.aggregate_id, payload, false);
}

function readRecorded(
  db: AppDb,
  tenantId: string,
  cleanupId: string,
  payload: Record<string, unknown>,
  requireEvidence = true,
): RecordedCleanup {
  const cleanupArtifactId = String(payload.cleanupArtifactId);
  const evidenceId = String(payload.evidenceId);
  const artifact = db.raw.prepare(
    `SELECT sha256, size_bytes, content_text, producer_principal_id FROM artifact_manifests
       WHERE tenant_id = ? AND id = ? AND kind = 'delegated_pr_cleanup_rollback'
       AND schema_version = 1 AND media_type = 'application/vnd.mendpoint.delegated-pr-cleanup+json'`,
  ).get(tenantId, cleanupArtifactId) as
    | { sha256: string; size_bytes: number; content_text: string | null; producer_principal_id: string }
    | undefined;
  if (!artifact?.content_text || !SHA256.test(artifact.sha256) ||
      sha256(artifact.content_text) !== artifact.sha256 || Buffer.byteLength(artifact.content_text) !== artifact.size_bytes) {
    throw new Error("delegated_pr_cleanup_artifact_corrupt");
  }
  if (requireEvidence) {
    const evidence = db.raw.prepare(
      `SELECT artifact_id, input_artifact_id, producer_principal_id, verdict FROM evidence_records
         WHERE tenant_id = ? AND id = ? AND subject_type = 'delegated_pr_cleanup' AND subject_id = ?`,
    ).get(tenantId, evidenceId, cleanupId) as
      | { artifact_id: string; input_artifact_id: string | null; producer_principal_id: string; verdict: string }
      | undefined;
    if (!evidence || evidence.artifact_id !== cleanupArtifactId || evidence.input_artifact_id !== payload.deliveryArtifactId ||
        evidence.producer_principal_id !== artifact.producer_principal_id || evidence.verdict !== "passed") {
      throw new Error("delegated_pr_cleanup_evidence_corrupt");
    }
  }
  let content: Record<string, unknown>;
  try { content = JSON.parse(artifact.content_text) as Record<string, unknown>; }
  catch { throw new Error("delegated_pr_cleanup_artifact_corrupt"); }
  if (content.schemaVersion !== 1 || content.cleanupId !== cleanupId || content.tenantId !== tenantId ||
      content.runId !== payload.runId || content.correlationId !== payload.correlationId ||
      content.repositoryId !== payload.repositoryId || content.deliveryRecordId !== payload.deliveryRecordId ||
      content.cycleId !== payload.cycleId || content.actorPrincipalId !== artifact.producer_principal_id ||
      content.observedAt !== payload.observedAt || canonical(content.cleanup) !== canonical(payload.cleanup)) {
    throw new Error("delegated_pr_cleanup_artifact_mismatch");
  }
  return deepFreeze({
    cleanupId,
    cleanupArtifactId,
    evidenceId,
    cleanup: content.cleanup as ExactDraftCleanupEvidence,
    observedAt: String(payload.observedAt),
    repositoryId: String(payload.repositoryId),
    deliveryArtifactId: String(payload.deliveryArtifactId),
    attestationId: typeof payload.attestationId === "string" ? payload.attestationId : null,
  });
}

function persistCleanup(
  db: AppDb,
  input: RecordDelegatedPrCleanupInput,
  cleanup: ExactDraftCleanupEvidence,
  digest: string,
  repositoryId: string,
): RecordedCleanup {
  const ids = cleanupIds(input, digest);
  const content = canonical({
    schemaVersion: 1,
    ...ids,
    tenantId: input.tenantId,
    runId: input.runId,
    correlationId: input.correlationId,
    repositoryId,
    deliveryRecordId: input.deliveryRecordId,
    cycleId: input.cycleId,
    actorPrincipalId: input.actorPrincipalId,
    observedAt: input.observedAt,
    cleanup,
  });
  const artifactSha256 = sha256(content);
  const eventPayload = {
    requestDigest: digest,
    ...ids,
    tenantId: input.tenantId,
    runId: input.runId,
    correlationId: input.correlationId,
    repositoryId,
    deliveryRecordId: input.deliveryRecordId,
    cycleId: input.cycleId,
    deliveryArtifactId: input.artifacts.deliveryId,
    actorPrincipalId: input.actorPrincipalId,
    observedAt: input.observedAt,
    cleanup,
  };
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    insertArtifactManifest(db, {
      id: ids.cleanupArtifactId,
      tenantId: input.tenantId,
      kind: "delegated_pr_cleanup_rollback",
      schemaVersion: 1,
      sha256: artifactSha256,
      mediaType: "application/vnd.mendpoint.delegated-pr-cleanup+json",
      sizeBytes: Buffer.byteLength(content),
      storageRef: `sqlite://artifact_manifests/${ids.cleanupArtifactId}#content_text`,
      content,
      producerPrincipalId: input.actorPrincipalId,
      createdAt: input.observedAt,
    });
    appendDomainEvent(db, {
      id: `event_${sha256(`${ids.cleanupId}\0recorded`)}`,
      tenantId: input.tenantId,
      schemaVersion: 1,
      eventType: "fettler_delegation_cleanup.recorded",
      aggregateType: "fettler_delegation_cleanup",
      aggregateId: ids.cleanupId,
      actorPrincipalId: input.actorPrincipalId,
      correlationId: input.correlationId,
      idempotencyKey: `delegated-pr-cleanup:${input.idempotencyKey}`,
      payload: eventPayload,
      createdAt: input.observedAt,
    });
    db.raw.exec("COMMIT");
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
  return readRecorded(db, input.tenantId, ids.cleanupId, eventPayload, false);
}

async function attestAndFinalize(
  db: AppDb,
  input: RecordDelegatedPrCleanupInput,
  dependencies: DelegatedPrCleanupOperationDependencies,
  recorded: RecordedCleanup,
): Promise<RecordedDelegatedPrCleanup> {
  const attestation = await issueSoftwareAttestation(db, {
    tenantId: input.tenantId,
    repositoryId: recorded.repositoryId,
    runId: input.runId,
    correlationId: input.correlationId,
    actorPrincipalId: input.actorPrincipalId,
    idempotencyKey: `delegated-cleanup-attestation:${input.idempotencyKey}`,
    outcome: "passed",
    issuedAt: recorded.observedAt,
    artifacts: {
      ...input.artifacts,
      rollbackId: recorded.cleanupArtifactId,
      waiverId: null,
    },
  }, {
    enabled: true,
    signer: dependencies.signer,
    producerService: dependencies.producerService ?? "mendpoint-delegated-cleanup",
    producerVersion: dependencies.producerVersion ?? "1",
    authorizeScope: (_db, _issued, scope) =>
      scope.rollbackArtifact?.artifactId === recorded.cleanupArtifactId &&
      scope.deliveryArtifact?.artifactId === recorded.deliveryArtifactId,
  });
  const finalKey = `delegated-pr-cleanup-attested:${input.idempotencyKey}`;
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    insertEvidenceRecord(db, {
      id: recorded.evidenceId,
      tenantId: input.tenantId,
      subjectType: "delegated_pr_cleanup",
      subjectId: recorded.cleanupId,
      artifactId: recorded.cleanupArtifactId,
      inputArtifactId: recorded.deliveryArtifactId,
      producerPrincipalId: input.actorPrincipalId,
      tool: "mendpoint-delegated-cleanup",
      toolVersion: dependencies.producerVersion ?? "1",
      verdict: "passed",
      createdAt: recorded.observedAt,
    });
    const existing = db.raw.prepare(
      "SELECT payload_json FROM domain_events WHERE tenant_id = ? AND idempotency_key = ?",
    ).get(input.tenantId, finalKey) as { payload_json: string } | undefined;
    if (existing) {
      const payload = JSON.parse(existing.payload_json) as Record<string, unknown>;
      if (payload.cleanupId !== recorded.cleanupId || payload.attestationId !== attestation.attestationId ||
          payload.attestationArtifactId !== attestation.artifactId) {
        throw new Error("delegated_pr_cleanup_idempotency_conflict");
      }
    } else {
      appendDomainEvent(db, {
        id: `event_${sha256(`${recorded.cleanupId}\0attested`)}`,
        tenantId: input.tenantId,
        schemaVersion: 1,
        eventType: "fettler_delegation_cleanup.attested",
        aggregateType: "fettler_delegation_cleanup",
        aggregateId: recorded.cleanupId,
        actorPrincipalId: input.actorPrincipalId,
        correlationId: input.correlationId,
        idempotencyKey: finalKey,
        payload: {
          cleanupId: recorded.cleanupId,
          cleanupArtifactId: recorded.cleanupArtifactId,
          evidenceId: recorded.evidenceId,
          attestationId: attestation.attestationId,
          attestationArtifactId: attestation.artifactId,
          tenantId: input.tenantId,
          runId: input.runId,
          correlationId: input.correlationId,
        },
        createdAt: recorded.observedAt,
      });
    }
    db.raw.exec("COMMIT");
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
  return deepFreeze({
    cleanupId: recorded.cleanupId,
    cleanupArtifactId: recorded.cleanupArtifactId,
    evidenceId: recorded.evidenceId,
    cleanup: recorded.cleanup,
    observedAt: recorded.observedAt,
    attestation,
  });
}

export async function recordDelegatedPrCleanup(
  db: AppDb,
  input: RecordDelegatedPrCleanupInput,
  dependencies: DelegatedPrCleanupOperationDependencies,
): Promise<RecordedDelegatedPrCleanup> {
  const planInput = snapshotPlain(input, "delegated_pr_cleanup_input_invalid");
  if (dependencies?.enabled !== true) throw new Error("delegated_pr_cleanup_disabled");
  const planDependencies = snapshotDependencies(dependencies);
  validateInput(planInput);
  const authorized = planDependencies.authorizeActor(db, planInput);
  if (authorized !== true) throw new Error("delegated_pr_cleanup_actor_unauthorized");
  const before = authoritySnapshot(db, planInput);
  const digest = requestDigest(planInput);
  const replay = readRecordedByKey(db, planInput, digest);
  if (replay) return attestAndFinalize(db, planInput, planDependencies, replay);
  const cleanup = await cleanupExactDraftWithOctokit(
    planDependencies.octokit,
    planInput.cleanup,
    planDependencies.compareAndDeleteAuthority,
  );
  const after = authoritySnapshot(db, planInput);
  if (canonical(before) !== canonical(after)) throw new Error("delegated_pr_cleanup_authority_changed");
  const recorded = persistCleanup(db, planInput, cleanup, digest, before.delivery.repositoryId);
  return attestAndFinalize(db, planInput, planDependencies, recorded);
}

export async function verifyStoredDelegatedPrCleanup(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    runId: string;
    correlationId: string;
    verifiedAt: string;
    maximumAgeMs?: number;
    trustPolicy: SoftwareAttestationTrustPolicy;
  }>,
): Promise<VerifiedDelegatedPrCleanup | undefined> {
  if (!verifyDomainEventIntegrity(db, input.tenantId).ok) {
    throw new Error("delegated_pr_cleanup_event_integrity_invalid");
  }
  const events = db.raw.prepare(
    `SELECT aggregate_id, payload_json FROM domain_events
       WHERE tenant_id = ? AND aggregate_type = 'fettler_delegation_cleanup'
       AND event_type = 'fettler_delegation_cleanup.attested'
       AND json_extract(payload_json, '$.runId') = ?
       AND json_extract(payload_json, '$.correlationId') = ?
       ORDER BY event_sequence, id`,
  ).all(input.tenantId, input.runId, input.correlationId) as Array<{ aggregate_id: string; payload_json: string }>;
  if (events.length === 0) return undefined;
  if (events.length !== 1) throw new Error("delegated_pr_cleanup_join_ambiguous");
  const finalPayload = JSON.parse(events[0]!.payload_json) as Record<string, unknown>;
  const recordedEvent = db.raw.prepare(
    `SELECT payload_json FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'fettler_delegation_cleanup'
       AND aggregate_id = ? AND event_type = 'fettler_delegation_cleanup.recorded'`,
  ).get(input.tenantId, events[0]!.aggregate_id) as { payload_json: string } | undefined;
  if (!recordedEvent || typeof finalPayload.attestationId !== "string") {
    throw new Error("delegated_pr_cleanup_event_corrupt");
  }
  const payload = JSON.parse(recordedEvent.payload_json) as Record<string, unknown>;
  const recorded = readRecorded(db, input.tenantId, events[0]!.aggregate_id, payload);
  if (recorded.cleanupId !== finalPayload.cleanupId || recorded.cleanupArtifactId !== finalPayload.cleanupArtifactId ||
      recorded.evidenceId !== finalPayload.evidenceId || payload.runId !== input.runId ||
      payload.correlationId !== input.correlationId || !validTimestamp(recorded.observedAt)) {
    throw new Error("delegated_pr_cleanup_event_corrupt");
  }
  const maximumAgeMs = input.maximumAgeMs ?? 24 * 60 * 60 * 1_000;
  const verifiedAtMs = Date.parse(input.verifiedAt);
  const observedAtMs = Date.parse(recorded.observedAt);
  if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 1 || !Number.isFinite(verifiedAtMs) ||
      verifiedAtMs < observedAtMs || verifiedAtMs - observedAtMs > maximumAgeMs) {
    throw new Error("delegated_pr_cleanup_stale");
  }
  const attestation = await verifyStoredSoftwareAttestation(db, {
    tenantId: input.tenantId,
    attestationId: finalPayload.attestationId,
    verifiedAt: input.verifiedAt,
    trustPolicy: input.trustPolicy,
  });
  const scope = attestation.statement.predicate.scope;
  if (attestation.statement.predicate.outcome !== "passed" || scope.tenantId !== input.tenantId ||
      scope.runId !== input.runId || scope.correlationId !== input.correlationId ||
      scope.repositoryId !== recorded.repositoryId || scope.rollbackArtifact?.artifactId !== recorded.cleanupArtifactId ||
      scope.deliveryArtifact?.artifactId !== recorded.deliveryArtifactId ||
      !DIGEST.test(`sha256:${scope.rollbackArtifact.sha256}`)) {
    throw new Error("delegated_pr_cleanup_attestation_scope_mismatch");
  }
  return deepFreeze({
    cleanupId: recorded.cleanupId,
    cleanupArtifactId: recorded.cleanupArtifactId,
    evidenceId: recorded.evidenceId,
    cleanup: recorded.cleanup,
    observedAt: recorded.observedAt,
    attestation,
  });
}

export async function getVerifiedFettlerDelegationEvidence(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    runId: string;
    correlationId: string;
    verifiedAt: string;
    maximumAgeMs?: number;
    trustPolicy: SoftwareAttestationTrustPolicy;
  }>,
): Promise<VerifiedFettlerDelegationEvidence> {
  const base = getFettlerDelegationEvidence(db, input.tenantId, input.runId);
  const verified = await verifyStoredDelegatedPrCleanup(db, input);
  if (!verified) return base as VerifiedFettlerDelegationEvidence;
  const rollbackArtifact = verified.attestation.statement.predicate.scope.rollbackArtifact;
  if (!rollbackArtifact || rollbackArtifact.artifactId !== verified.cleanupArtifactId) {
    throw new Error("delegated_pr_cleanup_attestation_scope_mismatch");
  }
  return deepFreeze({
    ...base,
    cleanup: {
      status: "observed" as const,
      value: {
        cleanupId: verified.cleanupId,
        artifact: {
          artifactId: rollbackArtifact.artifactId,
          sha256: rollbackArtifact.sha256,
        },
        attestationId: verified.attestation.statement.predicate.attestationId,
        signerKeyIds: verified.attestation.keys.map((key) => key.keyId),
        observedAt: verified.observedAt,
        cleanup: verified.cleanup,
      },
    },
  });
}
