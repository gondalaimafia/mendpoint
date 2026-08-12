import type { AppDb } from "@mendpoint/db";
import { createHash, createHmac, createPrivateKey, createPublicKey, sign as ed25519Sign, timingSafeEqual } from "node:crypto";
import { MENDPOINT_SOFTWARE_ATTESTATION_PREDICATE_V1, type SoftwareAttestationSigner, type SoftwareAttestationTrustPolicy } from "@mendpoint/contract";
import {
  getPostTrainedAdapterEligibility,
  getPostTrainedAdapterStatus,
  issueSoftwareAttestation,
  readSoftwareAttestation,
  registerPostTrainedAdapter,
  routePostTrainedAdapterDryRun,
  getPostTrainedTrainingJob,
  runPostTrainedTrainingJob,
  postTrainedReconciliationSigningBytes,
  type PostTrainedTrainer,
  type PostTrainedReconciliationReceipt,
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
  verifyEvidence?(tenantId: string, evidenceRefs: readonly string[]): boolean;
  trainer?: PostTrainedTrainer;
  trainingTimeoutMs?: number;
  trainingLeaseMs?: number;
  trainingWorkerId?: string;
  verifyReconciliation?(receipt: PostTrainedReconciliationReceipt): boolean;
  authorizeAttestationScope?: SoftwareAttestationOperationDependencies["authorizeScope"];
  authorizeDataset?: import("@mendpoint/pipeline").PostTrainedTrainingDependencies["authorizeDataset"];
}>;

export function advancedAiApplicationsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MENDPOINT_ADVANCED_AI_APPLICATIONS_ENABLED === "1";
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
): Pick<AdvancedAiApplicationRoutesOptions, "trainer" | "trainingTimeoutMs" | "trainingLeaseMs" | "trainingWorkerId" | "verifyReconciliation" | "verifyEvidence" | "authorizeDataset"> {
  const endpoint = env.MENDPOINT_POST_TRAINED_TRAINER_URL;
  const token = env.MENDPOINT_POST_TRAINED_TRAINER_TOKEN;
  const externalApproved = env.MENDPOINT_POST_TRAINED_EXTERNAL_PROCESSING_APPROVED === "1";
  const receiptSecret = env.MENDPOINT_POST_TRAINED_RECEIPT_HMAC_SECRET;
  const workerId = env.MENDPOINT_POST_TRAINED_WORKER_ID;
  const rawTimeout = Number(env.MENDPOINT_POST_TRAINED_TRAINER_TIMEOUT_MS ?? "30000");
  const rawLease = Number(env.MENDPOINT_POST_TRAINED_LEASE_MS ?? "120000");
  if (!endpoint?.trim() || !token?.trim() || !receiptSecret?.trim() || receiptSecret.length < 32 || !workerId?.trim() || !externalApproved || !Number.isSafeInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > 300_000 || !Number.isSafeInteger(rawLease) || rawLease < rawTimeout * 2 || rawLease > 3_600_000) return {};
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
  const verifyEvidence = (tenantId: string, refs: readonly string[], expected?: Readonly<{ subjectTypes: readonly string[]; subjectId: string; artifactIds?: readonly string[] }>) => refs.length > 0 && refs.every((ref) => {
    if (typeof ref !== "string" || !ref.trim()) return false;
    const byArtifact = Boolean(expected?.artifactIds?.includes(ref));
    const row = db.raw.prepare(`SELECT evidence.verdict, evidence.subject_type, evidence.subject_id, evidence.producer_principal_id, evidence.artifact_id,
      artifact.sha256, artifact.content_text, principal.revoked_at FROM evidence_records evidence JOIN artifact_manifests artifact ON artifact.id = evidence.artifact_id AND artifact.tenant_id = evidence.tenant_id
      JOIN principals principal ON principal.id = evidence.producer_principal_id AND principal.tenant_id = evidence.tenant_id
      WHERE evidence.tenant_id = ? AND ${byArtifact ? "evidence.artifact_id" : "evidence.id"} = ? ORDER BY evidence.created_at DESC LIMIT 1`).get(tenantId, ref) as { verdict: string; subject_type: string; subject_id: string; producer_principal_id: string | null; artifact_id: string; sha256: string; content_text: string | null; revoked_at: string | null } | undefined;
    return Boolean(row && row.verdict === "passed" && row.subject_type.trim() && row.subject_id.trim() && row.producer_principal_id && !row.revoked_at && row.content_text && createHash("sha256").update(row.content_text).digest("hex") === row.sha256
      && (!expected || (expected.subjectTypes.includes(row.subject_type) && row.subject_id === expected.subjectId && (!byArtifact || row.artifact_id === ref))));
  });
  const authorizeDataset: NonNullable<AdvancedAiApplicationRoutesOptions["authorizeDataset"]> = (input) => {
    const dataset = db.raw.prepare("SELECT status, purpose, residency_region FROM learning_dataset_versions WHERE id = ? AND tenant_id = ?").get(input.datasetId, input.tenantId) as { status: string; purpose: string; residency_region: string } | undefined;
    const consent = db.raw.prepare("SELECT id, action, expires_at FROM learning_consents WHERE tenant_id = ? AND purpose = ? AND residency_region = ? AND effective_at <= ? ORDER BY consent_version DESC LIMIT 1").get(input.tenantId, input.purpose, input.residencyRegion, input.at) as { id: string; action: string; expires_at: string | null } | undefined;
    const consentEvidence = consent && db.raw.prepare("SELECT artifact.sha256, artifact.content_text FROM evidence_records evidence JOIN artifact_manifests artifact ON artifact.id = evidence.artifact_id AND artifact.tenant_id = evidence.tenant_id JOIN principals principal ON principal.id = evidence.producer_principal_id AND principal.tenant_id = evidence.tenant_id WHERE evidence.tenant_id = ? AND evidence.subject_type = 'learning_consent' AND evidence.subject_id = ? AND evidence.verdict = 'passed' AND principal.revoked_at IS NULL AND artifact.content_text IS NOT NULL ORDER BY evidence.created_at DESC LIMIT 1").get(input.tenantId, consent.id) as { sha256: string; content_text: string } | undefined;
    const validConsentEvidence = Boolean(consentEvidence && createHash("sha256").update(consentEvidence.content_text).digest("hex") === consentEvidence.sha256);
    return Boolean(dataset?.status === "sealed" && dataset.purpose === input.purpose && dataset.residency_region === input.residencyRegion && consent?.action === "granted" && validConsentEvidence && (!consent.expires_at || Date.parse(consent.expires_at) > Date.parse(input.at)));
  };
  const verifyReconciliation = (receipt: PostTrainedReconciliationReceipt) => {
    if (!receipt || typeof receipt.signature !== "string" || !/^[a-f0-9]{64}$/.test(receipt.signature)) return false;
    const expected = createHmac("sha256", receiptSecret).update(postTrainedReconciliationSigningBytes(receipt)).digest();
    const supplied = Buffer.from(receipt.signature, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  return { trainer, trainingTimeoutMs: rawTimeout, trainingLeaseMs: rawLease, trainingWorkerId: workerId, verifyReconciliation, verifyEvidence, authorizeDataset };
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
    const verification = scope.verificationArtifacts.every((artifact) => {
      const ref = refs.find((candidate) => candidate.id === artifact.artifactId && candidate.sha256 === artifact.sha256 && candidate.eventType === "warden.run.verification_completed");
      if (!ref || !verificationKinds.has(ref.kind) || !exact(artifact, ref.kind, "warden.run.verification_completed")) return false;
      if (!verificationKinds.get(ref.kind)) return true;
      const row = db.raw.prepare("SELECT content_text FROM artifact_manifests WHERE tenant_id = ? AND id = ?").get(input.tenantId, artifact.artifactId) as { content_text: string };
      try { return (JSON.parse(row.content_text) as { comparison?: { ok?: boolean } }).comparison?.ok === true; } catch { return false; }
    });
    return Boolean(snapshot?.manifest_sha256 === scope.snapshotArtifact.sha256
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
  if (!options.enabled) { routes.all("*", (c) => c.json({ error: "not_found" }, 404)); return routes; }
  const now = options.now ?? (() => new Date().toISOString());

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
    try { const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401); const actorPrincipalId = c.get("trustPrincipalId"); if (!actorPrincipalId) return c.json({ error: "trust_principal_required" }, 401); if (!can(principal, "tenant:admin")) return c.json({ error: "forbidden" }, 403); const idempotencyKey = c.req.header("idempotency-key"); if (!idempotencyKey?.trim()) throw new Error("idempotency_key_required"); const body = await jsonBody(c); const value = registerPostTrainedAdapter(options.db, { ...body, tenantId: principal.tenantId, actorPrincipalId, idempotencyKey, registeredAt: now() } as never, { enabled: true, readConsent: options.readConsent, verifyEvidence: options.verifyEvidence }); c.header("Location", `/advanced-ai/post-trained/adapters/${value.adapterId}`); c.header("Cache-Control", "no-store"); return c.json(value, 201); } catch (error) { return failure(c, error); }
  });
  routes.get("/post-trained/adapters/:adapterId", (c) => { try { const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401); if (!can(principal, "plan:read")) return c.json({ error: "forbidden" }, 403); c.header("Cache-Control", "no-store"); return c.json(getPostTrainedAdapterStatus(options.db, principal.tenantId, c.req.param("adapterId"), { enabled: true, readConsent: options.readConsent })); } catch (error) { return failure(c, error); } });
  routes.post("/post-trained/adapters/:adapterId/eligibility", async (c) => { try { const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401); if (!can(principal, "plan:execute")) return c.json({ error: "forbidden" }, 403); const body = await jsonBody(c); return c.json(getPostTrainedAdapterEligibility(options.db, { tenantId: principal.tenantId, adapterId: c.req.param("adapterId"), task: body.task, now: new Date(now()) } as never, { enabled: true, readConsent: options.readConsent, verifyEvidence: options.verifyEvidence })); } catch (error) { return failure(c, error); } });
  routes.post("/post-trained/adapters/:adapterId/route-dry-run", async (c) => { try { const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401); if (!can(principal, "plan:execute")) return c.json({ error: "forbidden" }, 403); const body = await jsonBody(c); return c.json(routePostTrainedAdapterDryRun(options.db, { tenantId: principal.tenantId, adapterId: c.req.param("adapterId"), task: body.task, policy: body.policy, remainingBudgetUsd: body.remainingBudgetUsd, now: new Date(now()) } as never, { enabled: true, readConsent: options.readConsent, verifyEvidence: options.verifyEvidence })); } catch (error) { return failure(c, error); } });
  routes.post("/post-trained/training-jobs", async (c) => { try { const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401); const actorPrincipalId = c.get("trustPrincipalId"); if (!actorPrincipalId) return c.json({ error: "trust_principal_required" }, 401); if (!can(principal, "tenant:admin")) return c.json({ error: "forbidden" }, 403); if (!options.trainer || !options.verifyEvidence || !options.authorizeDataset || !options.verifyReconciliation || !options.trainingWorkerId || !options.trainingLeaseMs) return c.json({ error: "post_trained_training_unconfigured" }, 503); const body = await jsonBody(c); const idempotencyKey = c.req.header("idempotency-key"); if (!idempotencyKey?.trim()) throw new Error("idempotency_key_required"); const job = await runPostTrainedTrainingJob(options.db, { ...body, tenantId: principal.tenantId, actorPrincipalId, idempotencyKey, submittedAt: now() } as never, { enabled: true, trainer: options.trainer, verifyEvidence: options.verifyEvidence, authorizeDataset: options.authorizeDataset, verifyReconciliation: options.verifyReconciliation, workerId: options.trainingWorkerId, leaseMs: options.trainingLeaseMs, timeoutMs: options.trainingTimeoutMs ?? 30_000 }); c.header("Location", `/advanced-ai/post-trained/training-jobs/${job.jobId}`); c.header("Cache-Control", "no-store"); return c.json(job, 201); } catch (error) { return failure(c, error); } });
  routes.get("/post-trained/training-jobs/:jobId", (c) => { try { const principal = identity(c); if (!principal) return c.json({ error: "authenticated_principal_required" }, 401); if (!can(principal, "plan:read")) return c.json({ error: "forbidden" }, 403); const job = getPostTrainedTrainingJob(options.db, principal.tenantId, c.req.param("jobId")); if (!job) return c.json({ error: "not_found" }, 404); c.header("Cache-Control", "no-store"); return c.json(job); } catch (error) { return failure(c, error); } });
  return routes;
}

function identity(c: Context<ApiEnv>) { const principal = c.get("principal"); return principal?.tenantId?.trim() ? principal : undefined; }
async function jsonBody(c: Context<ApiEnv>): Promise<Record<string, any>> { const declared = Number(c.req.header("content-length")); if (Number.isFinite(declared) && declared > 1_048_576) throw new Error("advanced_ai_request_too_large"); const raw = await c.req.text(); if (Buffer.byteLength(raw) > 1_048_576) throw new Error("advanced_ai_request_too_large"); let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error("json_body_invalid"); } if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("json_body_invalid"); return value as Record<string, any>; }
function failure(c: Context<ApiEnv>, error: unknown) { const code = error instanceof Error ? error.message : "advanced_ai_failed"; if (code.endsWith("_not_found")) return c.json({ error: "not_found" }, 404); if (code.includes("idempotency_conflict") || code.includes("already_registered")) return c.json({ error: code }, 409); if (code === "advanced_ai_request_too_large") return c.json({ error: code }, 413); if (code.includes("disabled") || code.includes("unconfigured") || code.endsWith("_authority_missing")) return c.json({ error: code }, 503); return c.json({ error: code }, 400); }
