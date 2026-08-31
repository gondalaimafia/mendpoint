import type { AppDb } from "@mendpoint/db";
import { createHash, createHmac, createPrivateKey, createPublicKey, sign as ed25519Sign, timingSafeEqual } from "node:crypto";
import { MENDPOINT_SOFTWARE_ATTESTATION_PREDICATE_V1, type SoftwareAttestationSigner, type SoftwareAttestationTrustPolicy } from "@mendpoint/contract";
import {
  getPostTrainedAdapterEligibility,
  getPostTrainedAdapterStatus,
  issueSoftwareAttestation,
  readSoftwareAttestation,
  registerPostTrainedAdapter,
  rollbackPostTrainedAdapter,
  routePostTrainedAdapterDryRun,
  getPostTrainedTrainingJob,
  getPostTrainedEvaluation,
  getPostTrainedCanary,
  runPostTrainedTrainingJob,
  runPostTrainedIndependentEvaluation,
  runPostTrainedCanary,
  postTrainedEvaluationReceiptSigningBytes,
  postTrainedCanaryReceiptSigningBytes,
  postTrainedReconciliationSigningBytes,
  authorizeGovernedLearningCorpus,
  getGovernedLearningStatus,
  grantGovernedLearningConsent,
  materializeGovernedLearningCorpus,
  revokeGovernedLearningConsent,
  type PostTrainedTrainer,
  type PostTrainedReconciliationReceipt,
  type PostTrainedEvaluationDependencies,
  type PostTrainedCanaryDependencies,
  type SoftwareAttestationOperationDependencies,
} from "@mendpoint/pipeline";
import { can, type PostTrainedConsentSnapshot } from "@mendpoint/platform";
import { Hono, type Context } from "hono";
import type { ApiEnv } from "./auth.js";

export type AdvancedAiApplicationRoutesOptions = Readonly<{
  db: AppDb;
  enabled: boolean;
  signer?: SoftwareAttestationSigner;
  trustPolicy?: SoftwareAttestationTrustPolicy;
  attestationPrincipalId?: string;
  now?: () => string;
  readConsent?(tenantId: string, datasetId: string, stored: PostTrainedConsentSnapshot): PostTrainedConsentSnapshot | undefined;
  verifyEvidence?(tenantId: string, evidenceRefs: readonly string[], expected?: Readonly<{ subjectTypes: readonly string[]; subjectId: string; artifactIds?: readonly string[] }>): boolean;
  authorizeHumanApprover?(tenantId: string, principalId: string): boolean;
  trainer?: PostTrainedTrainer;
  trainingTimeoutMs?: number;
  trainingLeaseMs?: number;
  trainingWorkerId?: string;
  trainingProcessingBoundary?: "tenant_local" | "external";
  trainingAuthorityId?: string;
  trainingEndpointIdentity?: string;
  trainingCredentialIdentity?: string;
  verifyReconciliation?(receipt: PostTrainedReconciliationReceipt): boolean;
  authorizeAttestationScope?: SoftwareAttestationOperationDependencies["authorizeScope"];
  authorizeDataset?: import("@mendpoint/pipeline").PostTrainedTrainingDependencies["authorizeDataset"];
  evaluator?: PostTrainedEvaluationDependencies["evaluator"];
  evaluationTimeoutMs?: number;
  evaluationLeaseMs?: number;
  evaluationWorkerId?: string;
  evaluationPrincipalId?: string;
  evaluationAuthorityId?: string;
  evaluationEndpointIdentity?: string;
  evaluationCredentialIdentity?: string;
  evaluationProcessingBoundary?: "tenant_local" | "external";
  evaluationExpected?: PostTrainedEvaluationDependencies["expected"];
  authorizeEvaluationDataset?: PostTrainedEvaluationDependencies["authorizeDataset"];
  verifyEvaluationReceipt?: PostTrainedEvaluationDependencies["verifyReceipt"];
  canaryRunner?: PostTrainedCanaryDependencies["runner"];
  canaryTimeoutMs?: number;
  canaryLeaseMs?: number;
  canaryWorkerId?: string;
  canaryPrincipalId?: string;
  canaryAuthorityId?: string;
  canaryEndpointIdentity?: string;
  canaryCredentialIdentity?: string;
  canaryExpected?: PostTrainedCanaryDependencies["expected"];
  verifyCanaryReceipt?: PostTrainedCanaryDependencies["verifyReceipt"];
}>;

export function advancedAiApplicationsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MENDPOINT_ADVANCED_AI_APPLICATIONS_ENABLED === "1";
}

export function advancedAiRuntimeAuthoritiesIndependent(input: Readonly<{
  trainingAuthorityId?: string; trainingEndpointIdentity?: string; trainingCredentialIdentity?: string;
  evaluationAuthorityId?: string; evaluationEndpointIdentity?: string; evaluationCredentialIdentity?: string;
  canaryAuthorityId?: string; canaryEndpointIdentity?: string; canaryCredentialIdentity?: string;
}>): boolean {
  const authorities = [input.trainingAuthorityId, input.evaluationAuthorityId, input.canaryAuthorityId];
  const endpoints = [input.trainingEndpointIdentity, input.evaluationEndpointIdentity, input.canaryEndpointIdentity];
  const credentials = [input.trainingCredentialIdentity, input.evaluationCredentialIdentity, input.canaryCredentialIdentity];
  return [authorities, endpoints, credentials].every((values) =>
    values.every((value) => typeof value === "string" && value.trim().length > 0)
    && new Set(values).size === values.length);
}

export function advancedAiAttestationCryptoFromEnv(env: NodeJS.ProcessEnv = process.env): Pick<AdvancedAiApplicationRoutesOptions, "signer" | "trustPolicy" | "attestationPrincipalId"> {
  const keyId = env.MENDPOINT_ATTESTATION_KEY_ID;
  const privateDer = env.MENDPOINT_ATTESTATION_PRIVATE_KEY_PKCS8_BASE64;
  const publicDer = env.MENDPOINT_ATTESTATION_PUBLIC_KEY_SPKI_BASE64;
  const tenantIds = env.MENDPOINT_ATTESTATION_TENANT_IDS?.split(",").map((value) => value.trim()).filter(Boolean);
  const principalId = env.MENDPOINT_ATTESTATION_PRINCIPAL_ID;
  const validFrom = env.MENDPOINT_ATTESTATION_KEY_VALID_FROM;
  const validUntil = env.MENDPOINT_ATTESTATION_KEY_VALID_UNTIL;
  if (![keyId, privateDer, publicDer, principalId, validFrom, validUntil].every((value) => value?.trim()) || !tenantIds?.length) return {};
  if (!Number.isFinite(Date.parse(validFrom!)) || !Number.isFinite(Date.parse(validUntil!)) || Date.parse(validFrom!) >= Date.parse(validUntil!) || new Set(tenantIds).size !== tenantIds.length) return {};
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(privateDer!, "base64"), format: "der", type: "pkcs8" });
    const publicKey = createPublicKey({ key: Buffer.from(publicDer!, "base64"), format: "der", type: "spki" });
    const derivedPublic = Buffer.from(createPublicKey(privateKey).export({ format: "der", type: "spki" }));
    const configuredPublic = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
    if (derivedPublic.length !== configuredPublic.length || !timingSafeEqual(derivedPublic, configuredPublic)) return {};
    return {
      signer: Object.freeze({ keyId: keyId!, algorithm: "ed25519" as const, sign: (bytes: Uint8Array) => new Uint8Array(ed25519Sign(null, bytes, privateKey)) }),
      trustPolicy: Object.freeze({ resolve: (requested: string) => requested === keyId ? Object.freeze({ keyId: keyId!, algorithm: "ed25519" as const, publicKey, principalId: principalId!, service: "mendpoint-attestation", tenantIds: Object.freeze(tenantIds), predicateTypes: Object.freeze([MENDPOINT_SOFTWARE_ATTESTATION_PREDICATE_V1]), validFrom: validFrom!, validUntil: validUntil!, revokedAt: null }) : null }),
      attestationPrincipalId: principalId!,
    };
  } catch { return {}; }
}

export function advancedAiTrainingRuntimeFromEnv(
  db: AppDb,
  env: NodeJS.ProcessEnv = process.env,
  transport: typeof fetch = fetch,
): Pick<AdvancedAiApplicationRoutesOptions, "trainer" | "trainingTimeoutMs" | "trainingLeaseMs" | "trainingWorkerId" | "trainingProcessingBoundary" | "trainingAuthorityId" | "trainingEndpointIdentity" | "trainingCredentialIdentity" | "verifyReconciliation" | "verifyEvidence" | "authorizeDataset"> {
  const endpoint = env.MENDPOINT_POST_TRAINED_TRAINER_URL;
  const token = env.MENDPOINT_POST_TRAINED_TRAINER_TOKEN;
  const externalApproved = env.MENDPOINT_POST_TRAINED_EXTERNAL_PROCESSING_APPROVED === "1";
  const receiptSecret = env.MENDPOINT_POST_TRAINED_RECEIPT_HMAC_SECRET;
  const workerId = env.MENDPOINT_POST_TRAINED_WORKER_ID;
  const authorityId = env.MENDPOINT_POST_TRAINED_TRAINER_AUTHORITY_ID;
  const rawTimeout = Number(env.MENDPOINT_POST_TRAINED_TRAINER_TIMEOUT_MS ?? "30000");
  const rawLease = Number(env.MENDPOINT_POST_TRAINED_LEASE_MS ?? "120000");
  if (!endpoint?.trim() || !token?.trim() || !receiptSecret?.trim() || receiptSecret.length < 32 || !workerId?.trim() || !authorityId?.trim() || !externalApproved || !Number.isSafeInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > 300_000 || !Number.isSafeInteger(rawLease) || rawLease < rawTimeout * 2 || rawLease > 3_600_000) return {};
  let base: URL;
  try { base = new URL(endpoint); } catch { return {}; }
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(base.hostname))) return {};
  if (base.username || base.password || base.search || base.hash) return {};
  const request = async (path: string, method: "GET" | "POST", body: unknown, signal: AbortSignal) => {
    const response = await transport(new URL(path, base), { method, signal, redirect: "error", headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) }, body: method === "POST" ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`post_trained_trainer_http_${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 16_777_216) throw new Error("post_trained_trainer_result_too_large");
    const text = await response.text();
    if (Buffer.byteLength(text) > 16_777_216) throw new Error("post_trained_trainer_result_too_large");
    let value: unknown; try { value = JSON.parse(text); } catch { throw new Error("post_trained_trainer_result_invalid"); }
    return value as any;
  };
  const trainer: PostTrainedTrainer = Object.freeze({
    async train(input) {
      const value = await request("jobs", "POST", input, input.signal);
      if (value.jobId !== input.jobId || value.requestDigest !== input.requestDigest) throw new Error("post_trained_trainer_binding_mismatch");
      return { receipt: value.receipt, result: value.result };
    },
    async reconcile(input) {
      const value = await request(`jobs/${encodeURIComponent(input.jobId)}?requestDigest=${encodeURIComponent(input.requestDigest)}`, "GET", undefined, input.signal);
      if (value.jobId !== input.jobId || value.requestDigest !== input.requestDigest) throw new Error("post_trained_trainer_binding_mismatch");
      return { receipt: value.receipt, result: value.result };
    },
  });
  const verifyEvidence = createDurablePostTrainedEvidenceAuthority(db);
  const authorizeDataset: NonNullable<AdvancedAiApplicationRoutesOptions["authorizeDataset"]> = (input) => {
    const dataset = db.raw.prepare("SELECT status, purpose, residency_region FROM learning_dataset_versions WHERE id = ? AND tenant_id = ?").get(input.datasetId, input.tenantId) as { status: string; purpose: string; residency_region: string } | undefined;
    const consent = db.raw.prepare("SELECT id, action, expires_at FROM learning_consents WHERE tenant_id = ? AND purpose = ? AND residency_region = ? AND effective_at <= ? ORDER BY consent_version DESC LIMIT 1").get(input.tenantId, input.purpose, input.residencyRegion, input.at) as { id: string; action: string; expires_at: string | null } | undefined;
    const consentEvidence = consent && db.raw.prepare("SELECT artifact.sha256, artifact.content_text FROM evidence_records evidence JOIN artifact_manifests artifact ON artifact.id = evidence.artifact_id AND artifact.tenant_id = evidence.tenant_id JOIN principals principal ON principal.id = evidence.producer_principal_id AND principal.tenant_id = evidence.tenant_id WHERE evidence.tenant_id = ? AND evidence.subject_type = 'learning_consent' AND evidence.subject_id = ? AND evidence.verdict = 'passed' AND principal.revoked_at IS NULL AND artifact.content_text IS NOT NULL ORDER BY evidence.created_at DESC LIMIT 1").get(input.tenantId, consent.id) as { sha256: string; content_text: string } | undefined;
    const validConsentEvidence = Boolean(consentEvidence && createHash("sha256").update(consentEvidence.content_text).digest("hex") === consentEvidence.sha256);
    return Boolean(dataset?.status === "sealed" && dataset.purpose === input.purpose && dataset.residency_region === input.residencyRegion && consent?.action === "granted" && validConsentEvidence && (!consent.expires_at || Date.parse(consent.expires_at) > Date.parse(input.at)))
      && authorizeGovernedLearningCorpus(db, {
        tenantId: input.tenantId,
        datasetVersionId: input.datasetId,
        purpose: input.purpose,
        residencyRegion: input.residencyRegion,
        trainingArtifactIds: input.trainingCorpusArtifactIds,
        validationArtifactId: input.validationArtifactId,
        holdoutArtifactId: input.holdoutArtifactId,
        splitManifestDigest: input.splitManifestDigest,
        processingBoundary: input.processingBoundary,
        at: input.at,
      });
  };
  const verifyReconciliation = (receipt: PostTrainedReconciliationReceipt) => {
    if (!receipt || typeof receipt.signature !== "string" || !/^[a-f0-9]{64}$/.test(receipt.signature)) return false;
    const expected = createHmac("sha256", receiptSecret).update(postTrainedReconciliationSigningBytes(receipt)).digest();
    const supplied = Buffer.from(receipt.signature, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  return { trainer, trainingTimeoutMs: rawTimeout, trainingLeaseMs: rawLease, trainingWorkerId: workerId, trainingProcessingBoundary: "external", trainingAuthorityId: authorityId, trainingEndpointIdentity: base.toString(), trainingCredentialIdentity: `sha256:${createHash("sha256").update(token).digest("hex")}`, verifyReconciliation, verifyEvidence, authorizeDataset };
}

export function createDurablePostTrainedEvidenceAuthority(db: AppDb): NonNullable<AdvancedAiApplicationRoutesOptions["verifyEvidence"]> {
  return (tenantId, refs, expected) => refs.length > 0 && refs.every((ref) => {
    if (typeof ref !== "string" || !ref.trim()) return false;
    const byArtifact = Boolean(expected?.artifactIds?.includes(ref));
    const row = db.raw.prepare(`SELECT evidence.verdict, evidence.subject_type, evidence.subject_id, evidence.producer_principal_id, evidence.artifact_id,
      artifact.sha256, artifact.content_text, principal.revoked_at FROM evidence_records evidence JOIN artifact_manifests artifact ON artifact.id = evidence.artifact_id AND artifact.tenant_id = evidence.tenant_id
      JOIN principals principal ON principal.id = evidence.producer_principal_id AND principal.tenant_id = evidence.tenant_id
      WHERE evidence.tenant_id = ? AND ${byArtifact ? "evidence.artifact_id" : "evidence.id"} = ? ORDER BY evidence.created_at DESC LIMIT 1`).get(tenantId, ref) as { verdict: string; subject_type: string; subject_id: string; producer_principal_id: string | null; artifact_id: string; sha256: string; content_text: string | null; revoked_at: string | null } | undefined;
    if (!row || row.verdict !== "passed" || !row.subject_type.trim() || !row.subject_id.trim() || !row.producer_principal_id || row.revoked_at || !row.content_text || createHash("sha256").update(row.content_text).digest("hex") !== row.sha256) return false;
    if (!expected) return true;
    const exactSubject = row.subject_id === expected.subjectId;
    const consentForDataset = row.subject_type === "learning_consent" && Boolean(db.raw.prepare(`SELECT 1 FROM learning_dataset_versions dataset
      JOIN learning_consents consent ON consent.tenant_id = dataset.tenant_id AND consent.purpose = dataset.purpose AND consent.residency_region = dataset.residency_region
      WHERE dataset.tenant_id = ? AND dataset.id = ? AND consent.id = ? AND consent.action = 'granted' LIMIT 1`).get(tenantId, expected.subjectId, row.subject_id));
    return expected.subjectTypes.includes(row.subject_type) && (exactSubject || consentForDataset) && (!byArtifact || row.artifact_id === ref);
  });
}

export function createDurableAttestationScopeAuthority(): NonNullable<AdvancedAiApplicationRoutesOptions["authorizeAttestationScope"]> {
  return (db, input, scope) => {
    const events = db.raw.prepare("SELECT event_type, payload_json, actor_principal_id FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'warden_run' AND aggregate_id = ? AND correlation_id = ? AND event_type LIKE 'warden.run.%' ORDER BY event_sequence").all(input.tenantId, input.runId, input.correlationId) as Array<{ event_type: string; payload_json: string; actor_principal_id: string }>;
    if (!events.length || events.some((event) => event.actor_principal_id !== input.actorPrincipalId)) return false;
    const refs = events.flatMap((row) => { try { const parsed = JSON.parse(row.payload_json) as { eventKind?: string; artifacts?: Array<{ id: string; kind: string; sha256: string }> }; const expectedType = `warden.run.${parsed.eventKind}`; return expectedType === row.event_type && Array.isArray(parsed.artifacts) ? parsed.artifacts.map((artifact) => ({ ...artifact, eventType: row.event_type })) : []; } catch { return []; } });
    const exact = (artifact: { artifactId: string; sha256: string }, kind: string, eventType: string) => {
      if (!refs.some((ref) => ref.id === artifact.artifactId && ref.sha256 === artifact.sha256 && ref.kind === kind && ref.eventType === eventType)) return false;
      const row = db.raw.prepare("SELECT kind, sha256, size_bytes, content_text FROM artifact_manifests WHERE tenant_id = ? AND id = ?").get(input.tenantId, artifact.artifactId) as { kind: string; sha256: string; size_bytes: number; content_text: string | null } | undefined;
      return Boolean(row?.content_text && row.kind === kind && row.sha256 === artifact.sha256 && Buffer.byteLength(row.content_text) === row.size_bytes && createHash("sha256").update(row.content_text).digest("hex") === row.sha256);
    };
    const snapshot = db.raw.prepare("SELECT manifest_sha256 FROM repository_snapshots WHERE id = ? AND tenant_id = ? AND repository_id = ?").get(scope.snapshotArtifact.artifactId, input.tenantId, input.repositoryId) as { manifest_sha256: string } | undefined;
    const verificationKinds = new Map([["warden-baseline-verification", false], ["warden-post-edit-verification", true]]);
    let successfulPostEditVerifications = 0;
    const verification = scope.verificationArtifacts.every((artifact) => {
      const ref = refs.find((candidate) => candidate.id === artifact.artifactId && candidate.sha256 === artifact.sha256 && candidate.eventType === "warden.run.verification_completed");
      if (!ref || !verificationKinds.has(ref.kind) || !exact(artifact, ref.kind, "warden.run.verification_completed")) return false;
      if (!verificationKinds.get(ref.kind)) return true;
      const row = db.raw.prepare("SELECT content_text FROM artifact_manifests WHERE tenant_id = ? AND id = ?").get(input.tenantId, artifact.artifactId) as { content_text: string };
      try {
        const passed = (JSON.parse(row.content_text) as { comparison?: { ok?: boolean } }).comparison?.ok === true;
        if (passed) successfulPostEditVerifications += 1;
        return passed;
      } catch { return false; }
    });
    return Boolean(input.outcome === "passed"
      && successfulPostEditVerifications > 0
      && snapshot?.manifest_sha256 === scope.snapshotArtifact.sha256
      && scope.sourceArtifacts.every((artifact) => exact(artifact, "warden-source-envelope", "warden.run.artifact_ingested"))
      && exact(scope.candidateArtifact, "warden-candidate", "warden.run.candidate_generated")
      && verification
      && exact(scope.policyArtifact, "warden-execution-gates", "warden.run.policy_enforced")
      && (!scope.deliveryArtifact || exact(scope.deliveryArtifact, "warden-campaign-review-package", "warden.run.run_completed"))
      && !scope.rollbackArtifact
      && !scope.waiverArtifact);
  };
}

export function createDurablePostTrainedConsentReader(db: AppDb, clock: () => string = () => new Date().toISOString()): NonNullable<AdvancedAiApplicationRoutesOptions["readConsent"]> {
  return (tenantId, datasetId, stored) => {
    if (stored.tenantId !== tenantId || stored.datasetId !== datasetId) return undefined;
    const dataset = db.raw.prepare("SELECT purpose, residency_region FROM learning_dataset_versions WHERE id = ? AND tenant_id = ?").get(datasetId, tenantId) as { purpose: string; residency_region: string } | undefined;
    if (!dataset) return undefined;
    const checkedAt = clock();
    const consent = db.raw.prepare("SELECT id, consent_version, action, expires_at FROM learning_consents WHERE tenant_id = ? AND purpose = ? AND residency_region = ? AND effective_at <= ? ORDER BY consent_version DESC LIMIT 1").get(tenantId, dataset.purpose, dataset.residency_region, checkedAt) as { id: string; consent_version: number; action: string; expires_at: string | null } | undefined;
    if (!consent) return Object.freeze({ tenantId, datasetId, revision: 0, status: "missing" as const, evidenceRefs: Object.freeze([]), checkedAt });
    const evidenceRefs = (db.raw.prepare("SELECT id FROM evidence_records WHERE tenant_id = ? AND subject_type = 'learning_consent' AND subject_id = ? AND verdict = 'passed' ORDER BY created_at, id").all(tenantId, consent.id) as Array<{ id: string }>).map((row) => row.id);
    const expired = Boolean(consent.expires_at && Date.parse(consent.expires_at) <= Date.parse(checkedAt));
    const status = consent.action === "revoked" ? "revoked" as const : expired ? "expired" as const : consent.action === "granted" ? "active" as const : "denied" as const;
    return Object.freeze({ tenantId, datasetId, revision: consent.consent_version, status: status === "active" && evidenceRefs.length === 0 ? "missing" as const : status, evidenceRefs: Object.freeze(evidenceRefs), checkedAt, ...(consent.expires_at ? { expiresAt: consent.expires_at } : {}) });
  };
}

export function createAdvancedAiApplicationRoutes(options: AdvancedAiApplicationRoutesOptions): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>({ strict: false });
  if (!options.enabled) routes.use("*", async (c) => c.json({ error: "not_found" }, 404));
  const now = options.now ?? (() => new Date().toISOString());

  routes.post("/learning/consents", async (c) => {
    try {
      const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
      const actorPrincipalId = c.get("trustPrincipalId"); if (!actorPrincipalId) return c.json({ error: "trust_principal_required" }, 401);
      if (!can(principal, "tenant:admin")) return c.json({ error: "forbidden" }, 403);
      const body = await jsonBody(c);
      const idempotencyKey = c.req.header("idempotency-key"); if (!idempotencyKey?.trim()) throw new Error("idempotency_key_required");
      const result = grantGovernedLearningConsent(options.db, {
        id: body.id,
        tenantId: principal.tenantId,
        consentVersion: body.consentVersion,
        purpose: body.purpose,
        residencyRegion: body.residencyRegion,
        actorPrincipalId,
        supersedesConsentId: body.supersedesConsentId,
        effectiveAt: body.effectiveAt,
        expiresAt: body.expiresAt,
        reason: body.reason,
        idempotencyKey,
        createdAt: now(),
      });
      c.header("Cache-Control", "no-store");
      c.header("Location", `/advanced-ai/learning/consents/${result.id}`);
      return c.json(result, 201);
    } catch (error) { return failure(c, error); }
  });
  routes.post("/learning/consents/:consentId/revoke", async (c) => {
    try {
      const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
      const actorPrincipalId = c.get("trustPrincipalId"); if (!actorPrincipalId) return c.json({ error: "trust_principal_required" }, 401);
      if (!can(principal, "tenant:admin")) return c.json({ error: "forbidden" }, 403);
      const body = await jsonBody(c);
      const idempotencyKey = c.req.header("idempotency-key"); if (!idempotencyKey?.trim()) throw new Error("idempotency_key_required");
      const result = revokeGovernedLearningConsent(options.db, {
        id: body.id,
        tenantId: principal.tenantId,
        consentId: c.req.param("consentId"),
        consentVersion: body.consentVersion,
        actorPrincipalId,
        reason: body.reason,
        idempotencyKey,
        createdAt: now(),
      });
      c.header("Cache-Control", "no-store");
      return c.json(result);
    } catch (error) { return failure(c, error); }
  });
  routes.get("/learning/status", (c) => {
    try {
      const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
      if (!can(principal, "plan:read")) return c.json({ error: "forbidden" }, 403);
      c.header("Cache-Control", "no-store");
      return c.json(getGovernedLearningStatus(options.db, principal.tenantId, now()));
    } catch (error) { return failure(c, error); }
  });
  routes.post("/learning/corpora", async (c) => {
    try {
      const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
      const actorPrincipalId = c.get("trustPrincipalId"); if (!actorPrincipalId) return c.json({ error: "trust_principal_required" }, 401);
      if (!can(principal, "tenant:admin")) return c.json({ error: "forbidden" }, 403);
      const body = await jsonBody(c);
      const idempotencyKey = c.req.header("idempotency-key"); if (!idempotencyKey?.trim()) throw new Error("idempotency_key_required");
      const result = materializeGovernedLearningCorpus(options.db, {
        tenantId: principal.tenantId,
        purpose: body.purpose,
        temporalCutoffAt: body.temporalCutoffAt,
        actorPrincipalId,
        idempotencyKey,
        createdAt: now(),
      });
      c.header("Cache-Control", "no-store");
      c.header("Location", `/advanced-ai/learning/corpora/${result.datasetVersionId}`);
      return c.json(result, 201);
    } catch (error) { return failure(c, error); }
  });

  routes.post("/attestations", async (c) => {
    try {
      const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
      if (!can(principal, "tenant:admin")) return c.json({ error: "forbidden" }, 403);
      if (!options.signer || !options.attestationPrincipalId) return c.json({ error: "software_attestation_signer_unconfigured" }, 503);
      const body = await jsonBody(c); const idempotencyKey = c.req.header("idempotency-key");
      if (!idempotencyKey?.trim()) throw new Error("idempotency_key_required");
      const actorPrincipalId = c.get("trustPrincipalId"); if (!actorPrincipalId) return c.json({ error: "trust_principal_required" }, 401);
      if (options.attestationPrincipalId && options.attestationPrincipalId !== actorPrincipalId) return c.json({ error: "software_attestation_principal_binding_invalid" }, 403);
      const issued = await issueSoftwareAttestation(options.db, { ...body, tenantId: principal.tenantId, actorPrincipalId, idempotencyKey, issuedAt: now() } as never, { enabled: true, signer: options.signer, authorizeScope: options.authorizeAttestationScope });
      c.header("Location", `/advanced-ai/attestations/${issued.attestationId}`); c.header("Cache-Control", "no-store");
      return c.json(issued, 201);
    } catch (error) { return failure(c, error); }
  });

  routes.get("/attestations/:attestationId", (c) => {
    try { const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401); if (!can(principal, "plan:read")) return c.json({ error: "forbidden" }, 403); const value = readSoftwareAttestation(options.db, principal.tenantId, c.req.param("attestationId")); if (!value) return c.json({ error: "not_found" }, 404); c.header("Cache-Control", "no-store"); return c.json(value); } catch (error) { return failure(c, error); }
  });

  routes.post("/attestations/:attestationId/verify", async (c) => {
    try {
      const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
      if (!can(principal, "plan:read")) return c.json({ error: "forbidden" }, 403);
      if (!options.trustPolicy) return c.json({ error: "software_attestation_trust_unconfigured" }, 503);
      const { verifyStoredSoftwareAttestation } = await import("@mendpoint/pipeline");
      const verified = await verifyStoredSoftwareAttestation(options.db, { tenantId: principal.tenantId, attestationId: c.req.param("attestationId"), verifiedAt: now(), trustPolicy: options.trustPolicy });
      c.header("Cache-Control", "no-store");
      return c.json({ verified: true, attestationId: verified.statement.predicate.attestationId, key: verified.key, verifiedAt: verified.verifiedAt });
    } catch (error) { return failure(c, error); }
  });

  routes.post("/post-trained/adapters", async (c) => {
    try { const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401); const actorPrincipalId = c.get("trustPrincipalId"); if (!actorPrincipalId) return c.json({ error: "trust_principal_required" }, 401); if (!can(principal, "tenant:admin")) return c.json({ error: "forbidden" }, 403); const idempotencyKey = c.req.header("idempotency-key"); if (!idempotencyKey?.trim()) throw new Error("idempotency_key_required"); const body = await jsonBody(c); const value = registerPostTrainedAdapter(options.db, { ...body, tenantId: principal.tenantId, actorPrincipalId, idempotencyKey, registeredAt: now() } as never, { enabled: true, readConsent: options.readConsent, verifyEvidence: options.verifyEvidence, authorizeHumanApprover: options.authorizeHumanApprover }); c.header("Location", `/advanced-ai/post-trained/adapters/${value.adapterId}`); c.header("Cache-Control", "no-store"); return c.json(value, 201); } catch (error) { return failure(c, error); }
  });
  routes.post("/post-trained/adapters/:adapterId/rollback", async (c) => {
    try { const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401); const actorPrincipalId = c.get("trustPrincipalId"); if (!actorPrincipalId) return c.json({ error: "trust_principal_required" }, 401); if (!can(principal, "tenant:admin")) return c.json({ error: "forbidden" }, 403); const idempotencyKey = c.req.header("idempotency-key"); if (!idempotencyKey?.trim()) throw new Error("idempotency_key_required"); const body = await jsonBody(c); const value = rollbackPostTrainedAdapter(options.db, { tenantId: principal.tenantId, adapterId: c.req.param("adapterId"), actorPrincipalId, expectedArtifactDigest: body.expectedArtifactDigest, reason: body.reason, idempotencyKey, rolledBackAt: now() } as never, { enabled: true, authorizeHumanApprover: options.authorizeHumanApprover }); c.header("Cache-Control", "no-store"); return c.json(value); } catch (error) { return failure(c, error); }
  });
  routes.get("/post-trained/adapters/:adapterId", (c) => { try { const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401); if (!can(principal, "plan:read")) return c.json({ error: "forbidden" }, 403); c.header("Cache-Control", "no-store"); return c.json(getPostTrainedAdapterStatus(options.db, principal.tenantId, c.req.param("adapterId"), { enabled: true, readConsent: options.readConsent })); } catch (error) { return failure(c, error); } });
  routes.post("/post-trained/adapters/:adapterId/eligibility", async (c) => { try { const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401); if (!can(principal, "plan:execute")) return c.json({ error: "forbidden" }, 403); const body = await jsonBody(c); return c.json(getPostTrainedAdapterEligibility(options.db, { tenantId: principal.tenantId, adapterId: c.req.param("adapterId"), task: body.task, now: new Date(now()) } as never, { enabled: true, readConsent: options.readConsent, verifyEvidence: options.verifyEvidence })); } catch (error) { return failure(c, error); } });
  routes.post("/post-trained/adapters/:adapterId/route-dry-run", async (c) => { try { const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401); if (!can(principal, "plan:execute")) return c.json({ error: "forbidden" }, 403); const body = await jsonBody(c); return c.json(routePostTrainedAdapterDryRun(options.db, { tenantId: principal.tenantId, adapterId: c.req.param("adapterId"), task: body.task, policy: body.policy, remainingBudgetUsd: body.remainingBudgetUsd, now: new Date(now()) } as never, { enabled: true, readConsent: options.readConsent, verifyEvidence: options.verifyEvidence })); } catch (error) { return failure(c, error); } });
  routes.post("/post-trained/training-jobs", async (c) => { try { const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401); const actorPrincipalId = c.get("trustPrincipalId"); if (!actorPrincipalId) return c.json({ error: "trust_principal_required" }, 401); if (!can(principal, "tenant:admin")) return c.json({ error: "forbidden" }, 403); if (!options.trainer || !options.authorizeDataset || !options.verifyReconciliation || !options.trainingWorkerId || !options.trainingLeaseMs || !options.trainingProcessingBoundary || !options.trainingAuthorityId) return c.json({ error: "post_trained_training_unconfigured" }, 503); const body = await jsonBody(c); const idempotencyKey = c.req.header("idempotency-key"); if (!idempotencyKey?.trim()) throw new Error("idempotency_key_required"); const job = await runPostTrainedTrainingJob(options.db, { ...body, tenantId: principal.tenantId, actorPrincipalId, idempotencyKey, submittedAt: now() } as never, { enabled: true, trainer: options.trainer, authorityId: options.trainingAuthorityId, authorizeDataset: options.authorizeDataset, verifyReconciliation: options.verifyReconciliation, workerId: options.trainingWorkerId, processingBoundary: options.trainingProcessingBoundary, leaseMs: options.trainingLeaseMs, timeoutMs: options.trainingTimeoutMs ?? 30_000 }); c.header("Location", `/advanced-ai/post-trained/training-jobs/${job.jobId}`); c.header("Cache-Control", "no-store"); return c.json(job, 201); } catch (error) { return failure(c, error); } });
  routes.get("/post-trained/training-jobs/:jobId", (c) => { try { const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401); if (!can(principal, "plan:read")) return c.json({ error: "forbidden" }, 403); const job = getPostTrainedTrainingJob(options.db, principal.tenantId, c.req.param("jobId")); if (!job) return c.json({ error: "not_found" }, 404); c.header("Cache-Control", "no-store"); return c.json(job); } catch (error) { return failure(c, error); } });
  routes.post("/post-trained/evaluations", async (c) => {
    try {
      const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
      if (!can(principal, "tenant:admin")) return c.json({ error: "forbidden" }, 403);
      if (!options.evaluator || !options.evaluationWorkerId || !options.evaluationPrincipalId || !options.evaluationAuthorityId || !options.evaluationProcessingBoundary || !options.evaluationExpected || !options.authorizeEvaluationDataset || !options.verifyEvaluationReceipt || !options.evaluationLeaseMs || options.evaluationAuthorityId === options.trainingAuthorityId || !runtimePairIndependent(options.trainingEndpointIdentity, options.trainingCredentialIdentity, options.evaluationEndpointIdentity, options.evaluationCredentialIdentity)) return c.json({ error: "post_trained_evaluation_unconfigured" }, 503);
      const evaluatorPrincipal = options.db.raw.prepare("SELECT 1 FROM principals WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL").get(principal.tenantId, options.evaluationPrincipalId);
      if (!evaluatorPrincipal) return c.json({ error: "post_trained_evaluation_principal_invalid" }, 503);
      const body = await jsonBody(c);
      const idempotencyKey = c.req.header("idempotency-key"); if (!idempotencyKey?.trim()) throw new Error("idempotency_key_required");
      const evaluation = await runPostTrainedIndependentEvaluation(options.db, { ...body, baseline: options.evaluationExpected.baseline, evaluator: options.evaluationExpected.evaluator, policy: options.evaluationExpected.policy, tenantId: principal.tenantId, actorPrincipalId: options.evaluationPrincipalId, idempotencyKey, requestedAt: now() } as never, { enabled: true, evaluator: options.evaluator, workerId: options.evaluationWorkerId, authorityId: options.evaluationAuthorityId, processingBoundary: options.evaluationProcessingBoundary, expected: options.evaluationExpected, authorizeDataset: options.authorizeEvaluationDataset, verifyReceipt: options.verifyEvaluationReceipt, leaseMs: options.evaluationLeaseMs, timeoutMs: options.evaluationTimeoutMs ?? 30_000 });
      c.header("Location", `/advanced-ai/post-trained/evaluations/${evaluation.evaluationId}`); c.header("Cache-Control", "no-store"); return c.json(evaluation, 201);
    } catch (error) { return failure(c, error); }
  });
  routes.get("/post-trained/evaluations/:evaluationId", (c) => { try { const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401); if (!can(principal, "plan:read")) return c.json({ error: "forbidden" }, 403); const evaluation = getPostTrainedEvaluation(options.db, principal.tenantId, c.req.param("evaluationId")); if (!evaluation) return c.json({ error: "not_found" }, 404); c.header("Cache-Control", "no-store"); return c.json(evaluation); } catch (error) { return failure(c, error); } });
  routes.post("/post-trained/canaries", async (c) => {
    try {
      const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
      if (!can(principal, "tenant:admin")) return c.json({ error: "forbidden" }, 403);
      if (!options.canaryRunner || !options.canaryWorkerId || !options.canaryPrincipalId || !options.canaryAuthorityId || !options.canaryExpected || !options.verifyCanaryReceipt || !options.canaryLeaseMs || !runtimeCanaryIndependent(options)) return c.json({ error: "post_trained_canary_unconfigured" }, 503);
      const canaryPrincipal = options.db.raw.prepare("SELECT 1 FROM principals WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL").get(principal.tenantId, options.canaryPrincipalId); if (!canaryPrincipal) return c.json({ error: "post_trained_canary_principal_invalid" }, 503);
      const body = await jsonBody(c); const idempotencyKey = c.req.header("idempotency-key"); if (!idempotencyKey?.trim()) throw new Error("idempotency_key_required");
      const canary = await runPostTrainedCanary(options.db, { ...body, servingRevision: options.canaryExpected.servingRevision, mode: options.canaryExpected.mode, allocationPercent: options.canaryExpected.allocationPercent, policy: options.canaryExpected.policy, tenantId: principal.tenantId, actorPrincipalId: options.canaryPrincipalId, idempotencyKey, requestedAt: now() } as never, { enabled: true, runner: options.canaryRunner, workerId: options.canaryWorkerId, authorityId: options.canaryAuthorityId, expected: options.canaryExpected, verifyReceipt: options.verifyCanaryReceipt, leaseMs: options.canaryLeaseMs, timeoutMs: options.canaryTimeoutMs ?? 30_000 });
      c.header("Location", `/advanced-ai/post-trained/canaries/${canary.canaryId}`); c.header("Cache-Control", "no-store"); return c.json(canary, 201);
    } catch (error) { return failure(c, error); }
  });
  routes.get("/post-trained/canaries/:canaryId", (c) => { try { const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401); if (!can(principal, "plan:read")) return c.json({ error: "forbidden" }, 403); const canary = getPostTrainedCanary(options.db, principal.tenantId, c.req.param("canaryId")); if (!canary) return c.json({ error: "not_found" }, 404); c.header("Cache-Control", "no-store"); return c.json(canary); } catch (error) { return failure(c, error); } });
  return routes;
}

export function advancedAiEvaluationRuntimeFromEnv(
  db: AppDb,
  env: NodeJS.ProcessEnv = process.env,
  transport: typeof fetch = fetch,
): Pick<AdvancedAiApplicationRoutesOptions, "evaluator" | "evaluationTimeoutMs" | "evaluationLeaseMs" | "evaluationWorkerId" | "evaluationPrincipalId" | "evaluationAuthorityId" | "evaluationEndpointIdentity" | "evaluationCredentialIdentity" | "evaluationProcessingBoundary" | "evaluationExpected" | "authorizeEvaluationDataset" | "verifyEvaluationReceipt"> {
  const endpoint = env.MENDPOINT_POST_TRAINED_EVALUATOR_URL;
  const token = env.MENDPOINT_POST_TRAINED_EVALUATOR_TOKEN;
  const receiptSecret = env.MENDPOINT_POST_TRAINED_EVALUATOR_RECEIPT_HMAC_SECRET;
  const workerId = env.MENDPOINT_POST_TRAINED_EVALUATION_WORKER_ID;
  const principalId = env.MENDPOINT_POST_TRAINED_EVALUATOR_PRINCIPAL_ID;
  const authorityId = env.MENDPOINT_POST_TRAINED_EVALUATOR_AUTHORITY_ID;
  const externalApproved = env.MENDPOINT_POST_TRAINED_EVALUATION_EXTERNAL_PROCESSING_APPROVED === "1";
  const baselineExecutorId = env.MENDPOINT_POST_TRAINED_BASELINE_EXECUTOR_ID;
  const baselineRevision = env.MENDPOINT_POST_TRAINED_BASELINE_REVISION;
  const harnessVersion = env.MENDPOINT_POST_TRAINED_EVALUATION_HARNESS_VERSION;
  const graderVersion = env.MENDPOINT_POST_TRAINED_EVALUATION_GRADER_VERSION;
  const minimumSuccessRate = Number(env.MENDPOINT_POST_TRAINED_MINIMUM_SUCCESS_RATE);
  const maximumRegressionRate = Number(env.MENDPOINT_POST_TRAINED_MAXIMUM_REGRESSION_RATE);
  const maximumSecurityRegressions = Number(env.MENDPOINT_POST_TRAINED_MAXIMUM_SECURITY_REGRESSIONS);
  const rawTimeout = Number(env.MENDPOINT_POST_TRAINED_EVALUATOR_TIMEOUT_MS ?? "30000");
  const rawLease = Number(env.MENDPOINT_POST_TRAINED_EVALUATION_LEASE_MS ?? "120000");
  if (![endpoint, token, receiptSecret, workerId, principalId, authorityId, baselineExecutorId, baselineRevision, harnessVersion, graderVersion].every((value) => value?.trim()) || receiptSecret!.length < 32 || !externalApproved || !/^[a-f0-9]{40}$/u.test(baselineRevision!) || !Number.isFinite(minimumSuccessRate) || minimumSuccessRate < 0 || minimumSuccessRate > 1 || !Number.isFinite(maximumRegressionRate) || maximumRegressionRate < 0 || maximumRegressionRate > 1 || !Number.isSafeInteger(maximumSecurityRegressions) || maximumSecurityRegressions < 0 || !Number.isSafeInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > 300_000 || !Number.isSafeInteger(rawLease) || rawLease < rawTimeout * 2 || rawLease > 3_600_000) return {};
  let base: URL;
  try { base = new URL(endpoint!); } catch { return {}; }
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(base.hostname))) return {};
  if (base.username || base.password || base.search || base.hash) return {};
  const request = async (path: string, method: "GET" | "POST", body: unknown, signal: AbortSignal) => {
    const response = await transport(new URL(path, base), { method, signal, redirect: "error", headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) }, body: method === "POST" ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`post_trained_evaluator_http_${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 16_777_216) throw new Error("post_trained_evaluator_result_too_large");
    const text = await response.text();
    if (Buffer.byteLength(text) > 16_777_216) throw new Error("post_trained_evaluator_result_too_large");
    try { return JSON.parse(text) as any; } catch { throw new Error("post_trained_evaluator_result_invalid"); }
  };
  const evaluator: PostTrainedEvaluationDependencies["evaluator"] = Object.freeze({
    async evaluate(input) {
      const { signal, ...payload } = input;
      const value = await request("evaluations", "POST", payload, signal);
      if (value.evaluationId !== input.evaluationId || value.requestDigest !== input.requestDigest) throw new Error("post_trained_evaluator_binding_mismatch");
      return { receipt: value.receipt, result: value.result };
    },
    async reconcile(input) {
      const value = await request(`evaluations/${encodeURIComponent(input.evaluationId)}?requestDigest=${encodeURIComponent(input.requestDigest)}`, "GET", undefined, input.signal);
      if (value.evaluationId !== input.evaluationId || value.requestDigest !== input.requestDigest) throw new Error("post_trained_evaluator_binding_mismatch");
      return { receipt: value.receipt, result: value.result };
    },
  });
  const verifyEvaluationReceipt: PostTrainedEvaluationDependencies["verifyReceipt"] = (receipt) => {
    if (!receipt || typeof receipt.signature !== "string" || !/^[a-f0-9]{64}$/u.test(receipt.signature)) return false;
    const expected = createHmac("sha256", receiptSecret!).update(postTrainedEvaluationReceiptSigningBytes(receipt)).digest();
    const supplied = Buffer.from(receipt.signature, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const authorizeEvaluationDataset = advancedAiTrainingRuntimeFromEnv(db, {
    ...env,
    MENDPOINT_POST_TRAINED_TRAINER_URL: endpoint,
    MENDPOINT_POST_TRAINED_TRAINER_TOKEN: token,
    MENDPOINT_POST_TRAINED_TRAINER_TIMEOUT_MS: String(rawTimeout),
    MENDPOINT_POST_TRAINED_LEASE_MS: String(rawLease),
    MENDPOINT_POST_TRAINED_WORKER_ID: workerId,
    MENDPOINT_POST_TRAINED_TRAINER_AUTHORITY_ID: authorityId,
    MENDPOINT_POST_TRAINED_RECEIPT_HMAC_SECRET: receiptSecret,
    MENDPOINT_POST_TRAINED_EXTERNAL_PROCESSING_APPROVED: "1",
  }, transport).authorizeDataset;
  if (!authorizeEvaluationDataset) return {};
  const evaluationExpected = Object.freeze({ baseline: Object.freeze({ executorId: baselineExecutorId!, revision: baselineRevision! }), evaluator: Object.freeze({ harnessVersion: harnessVersion!, graderVersion: graderVersion! }), policy: Object.freeze({ minimumSuccessRate, maximumRegressionRate, maximumSecurityRegressions }) });
  return { evaluator, evaluationTimeoutMs: rawTimeout, evaluationLeaseMs: rawLease, evaluationWorkerId: workerId!, evaluationPrincipalId: principalId!, evaluationAuthorityId: authorityId!, evaluationEndpointIdentity: base.toString(), evaluationCredentialIdentity: `sha256:${createHash("sha256").update(token!).digest("hex")}`, evaluationProcessingBoundary: "external", evaluationExpected, authorizeEvaluationDataset, verifyEvaluationReceipt };
}

export function advancedAiCanaryRuntimeFromEnv(
  db: AppDb,
  env: NodeJS.ProcessEnv = process.env,
  transport: typeof fetch = fetch,
): Pick<AdvancedAiApplicationRoutesOptions, "canaryRunner" | "canaryTimeoutMs" | "canaryLeaseMs" | "canaryWorkerId" | "canaryPrincipalId" | "canaryAuthorityId" | "canaryEndpointIdentity" | "canaryCredentialIdentity" | "canaryExpected" | "verifyCanaryReceipt"> {
  const endpoint = env.MENDPOINT_POST_TRAINED_CANARY_URL;
  const token = env.MENDPOINT_POST_TRAINED_CANARY_TOKEN;
  const receiptSecret = env.MENDPOINT_POST_TRAINED_CANARY_RECEIPT_HMAC_SECRET;
  const workerId = env.MENDPOINT_POST_TRAINED_CANARY_WORKER_ID;
  const principalId = env.MENDPOINT_POST_TRAINED_CANARY_PRINCIPAL_ID;
  const authorityId = env.MENDPOINT_POST_TRAINED_CANARY_AUTHORITY_ID;
  const servingRevision = env.MENDPOINT_POST_TRAINED_CANARY_SERVING_REVISION;
  const mode = env.MENDPOINT_POST_TRAINED_CANARY_MODE;
  const allocationPercent = Number(env.MENDPOINT_POST_TRAINED_CANARY_ALLOCATION_PERCENT);
  const minimumSuccessRate = Number(env.MENDPOINT_POST_TRAINED_CANARY_MINIMUM_SUCCESS_RATE);
  const maximumErrorRate = Number(env.MENDPOINT_POST_TRAINED_CANARY_MAXIMUM_ERROR_RATE);
  const maximumPolicyViolations = Number(env.MENDPOINT_POST_TRAINED_CANARY_MAXIMUM_POLICY_VIOLATIONS);
  const maximumP95LatencyMs = Number(env.MENDPOINT_POST_TRAINED_CANARY_MAXIMUM_P95_LATENCY_MS);
  const maximumCostUsd = Number(env.MENDPOINT_POST_TRAINED_CANARY_MAXIMUM_COST_USD);
  const rawTimeout = Number(env.MENDPOINT_POST_TRAINED_CANARY_TIMEOUT_MS ?? "30000");
  const rawLease = Number(env.MENDPOINT_POST_TRAINED_CANARY_LEASE_MS ?? "120000");
  if (![endpoint, token, receiptSecret, workerId, principalId, authorityId, servingRevision].every((value) => value?.trim()) || !["shadow", "canary"].includes(mode ?? "") || receiptSecret!.length < 32 || !Number.isFinite(allocationPercent) || allocationPercent <= 0 || allocationPercent > (mode === "shadow" ? 100 : 25) || !Number.isFinite(minimumSuccessRate) || minimumSuccessRate < 0 || minimumSuccessRate > 1 || !Number.isFinite(maximumErrorRate) || maximumErrorRate < 0 || maximumErrorRate > 1 || !Number.isSafeInteger(maximumPolicyViolations) || maximumPolicyViolations < 0 || !Number.isFinite(maximumP95LatencyMs) || maximumP95LatencyMs <= 0 || !Number.isFinite(maximumCostUsd) || maximumCostUsd < 0 || !Number.isSafeInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > 300_000 || !Number.isSafeInteger(rawLease) || rawLease < rawTimeout * 2 || rawLease > 3_600_000) return {};
  let base: URL; try { base = new URL(endpoint!); } catch { return {}; }
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(base.hostname))) return {};
  if (base.username || base.password || base.search || base.hash) return {};
  const request = async (path: string, method: "GET" | "POST", body: unknown, signal: AbortSignal) => {
    const response = await transport(new URL(path, base), { method, signal, redirect: "error", headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) }, body: method === "POST" ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`post_trained_canary_http_${response.status}`);
    const declared = Number(response.headers.get("content-length")); if (Number.isFinite(declared) && declared > 4_194_304) throw new Error("post_trained_canary_result_too_large");
    const text = await response.text(); if (Buffer.byteLength(text) > 4_194_304) throw new Error("post_trained_canary_result_too_large");
    try { return JSON.parse(text) as any; } catch { throw new Error("post_trained_canary_result_invalid"); }
  };
  const canaryRunner: PostTrainedCanaryDependencies["runner"] = Object.freeze({
    async run(input) { const { signal, ...payload } = input; const value = await request("canaries", "POST", payload, signal); if (value.canaryId !== input.canaryId || value.requestDigest !== input.requestDigest) throw new Error("post_trained_canary_binding_mismatch"); return { receipt: value.receipt, result: value.result }; },
    async reconcile(input) { const value = await request(`canaries/${encodeURIComponent(input.canaryId)}?requestDigest=${encodeURIComponent(input.requestDigest)}`, "GET", undefined, input.signal); if (value.canaryId !== input.canaryId || value.requestDigest !== input.requestDigest) throw new Error("post_trained_canary_binding_mismatch"); return { receipt: value.receipt, result: value.result }; },
  });
  const verifyCanaryReceipt: PostTrainedCanaryDependencies["verifyReceipt"] = (receipt) => { if (!receipt || typeof receipt.signature !== "string" || !/^[a-f0-9]{64}$/u.test(receipt.signature)) return false; const expected = createHmac("sha256", receiptSecret!).update(postTrainedCanaryReceiptSigningBytes(receipt)).digest(); const supplied = Buffer.from(receipt.signature, "hex"); return supplied.length === expected.length && timingSafeEqual(supplied, expected); };
  const canaryExpected = Object.freeze({ servingRevision: servingRevision!, mode: mode as "shadow" | "canary", allocationPercent, policy: Object.freeze({ minimumSuccessRate, maximumErrorRate, maximumPolicyViolations, maximumP95LatencyMs, maximumCostUsd }) });
  return { canaryRunner, canaryTimeoutMs: rawTimeout, canaryLeaseMs: rawLease, canaryWorkerId: workerId!, canaryPrincipalId: principalId!, canaryAuthorityId: authorityId!, canaryEndpointIdentity: base.toString(), canaryCredentialIdentity: `sha256:${createHash("sha256").update(token!).digest("hex")}`, canaryExpected, verifyCanaryReceipt };
}

function runtimePairIndependent(firstEndpoint: string | undefined, firstCredential: string | undefined, secondEndpoint: string | undefined, secondCredential: string | undefined): boolean {
  if ([firstEndpoint, firstCredential, secondEndpoint, secondCredential].every((value) => value === undefined)) return true;
  return Boolean(firstEndpoint?.trim() && firstCredential?.trim() && secondEndpoint?.trim() && secondCredential?.trim() && firstEndpoint !== secondEndpoint && firstCredential !== secondCredential);
}

function runtimeCanaryIndependent(options: AdvancedAiApplicationRoutesOptions): boolean {
  const identities = [options.trainingEndpointIdentity, options.trainingCredentialIdentity, options.evaluationEndpointIdentity, options.evaluationCredentialIdentity, options.canaryEndpointIdentity, options.canaryCredentialIdentity];
  if (identities.every((value) => value === undefined)) return options.canaryAuthorityId !== options.trainingAuthorityId && options.canaryAuthorityId !== options.evaluationAuthorityId;
  return advancedAiRuntimeAuthoritiesIndependent(options);
}

function identity(c: Context<ApiEnv>) { const principal = c.get("principal"); return principal?.tenantId?.trim() ? principal : undefined; }
async function jsonBody(c: Context<ApiEnv>): Promise<Record<string, any>> { const declared = Number(c.req.header("content-length")); if (Number.isFinite(declared) && declared > 1_048_576) throw new Error("advanced_ai_request_too_large"); const raw = await c.req.text(); if (Buffer.byteLength(raw) > 1_048_576) throw new Error("advanced_ai_request_too_large"); let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error("json_body_invalid"); } if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("json_body_invalid"); return value as Record<string, any>; }
function failure(c: Context<ApiEnv>, error: unknown) { const code = error instanceof Error ? error.message : "advanced_ai_failed"; if (code.endsWith("_not_found")) return c.json({ error: "not_found" }, 404); if (code.includes("idempotency_conflict") || code.includes("already_registered")) return c.json({ error: code }, 409); if (code === "advanced_ai_request_too_large") return c.json({ error: code }, 413); if (code.includes("disabled") || code.includes("unconfigured") || code.endsWith("_authority_missing")) return c.json({ error: code }, 503); return c.json({ error: code }, 400); }
