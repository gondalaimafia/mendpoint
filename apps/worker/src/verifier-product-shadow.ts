import { createHash } from "node:crypto";
import { findActiveLearningConsent, recordAudit, type AppDb } from "@mendpoint/db";
import {
  beginVerifierAdvisoryProviderOperation,
  findVerifierTelemetry,
  persistVerifierAdvisoryProviderNoResponse,
  persistVerifierAdvisoryProviderResponse,
  persistVerifierAdvisoryProviderRetryableResponse,
  persistVerifierTelemetry,
  REGAUGE_DEEPSEEK_APPROVED_SCOPE,
  REGAUGE_VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE,
  type ProductCompletionAdvisoryInput,
} from "@mendpoint/pipeline";
import {
  createCompletionVerifierEvidencePack,
  createFetchVerifierTransport,
  resolveVerifierRuntimeConfig,
  type AgentVerifierResult,
  type VerifierDataClassification,
  type VerifierHttpTransport,
  type VerifierHttpRequest,
  type VerifierPricing,
  type VerifierProduct,
  type VerifierSourceInput,
} from "@mendpoint/verifier";
import { createVerifierAdvisoryRuntime } from "./verifier-shadow.js";

// The verifier sends tenant repository content to an EXTERNAL third-party model
// (DeepSeek) for independent scoring. That egress is a categorically different
// data use from the internal adapter-training purposes
// (`governed-adapter-training`, `transformer-adaptive-repair`): a tenant may
// consent to internal training yet not to external-model egress, or the reverse,
// so a grant for one must never be read as a grant for the other. A distinct
// consent purpose keeps the two authorizations separate.
export const VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE = "verifier-external-model-egress";
export { REGAUGE_VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE };
export const RETRYABLE_VERIFIER_FAILURE_CODES = new Set(["api_failure", "logprob_failure"] as const);

export class VerifierProviderNoResponseError extends Error {
  readonly code = "verifier_transport_not_sent";
}

export async function observeProductCompletionInAdvisory(input: Readonly<{
  db: AppDb;
  env?: Readonly<Record<string, string | undefined>>;
  completion: ProductCompletionAdvisoryInput;
  substantiveSources?: readonly Readonly<VerifierSourceInput>[];
  transport?: VerifierHttpTransport;
  authorityAt?: string;
  now?: () => string;
  beforeProviderRequest?: (requestedAt: string) => void;
  operationHooks?: Readonly<{
    afterProviderReturn?: () => void;
    afterProviderReceipt?: () => void;
  }>;
}>): Promise<AgentVerifierResult | null> {
  const env = input.env ?? process.env;
  const runtimeConfig = resolveVerifierRuntimeConfig(env);
  // `off` never observes; `offline` never egresses from this production path
  // (see createVerifierAdvisoryRuntime). Refuse both before building an evidence
  // pack or claiming an attempt, so offline never even prepares tenant content.
  if (!runtimeConfig.enabled || runtimeConfig.rolloutMode === "off" || runtimeConfig.rolloutMode === "offline") return null;
  const governance = resolveVerifierGovernance(env, input.completion.tenantId, input.completion.product);
  // Tenant consent for external-model egress is resolved from the append-only
  // `learning_consents` table, NOT from the process-wide governance env blob, so
  // a tenant that revokes consent stops egressing on the next completion without
  // a redeploy. It is fail-closed: no record, a revoked one, an expired one, or
  // an unreadable table all deny (see resolveExternalModelConsent). The operator
  // env governance is retained as an ADDITIONAL restriction below: consent grants
  // permission but cannot override the operator's off switch.
  const authorityAt = input.authorityAt ?? input.completion.observedAt;
  const consentPurpose = input.completion.product === "regauge"
    ? REGAUGE_VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE
    : VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE;
  const consent = resolveExternalModelConsent(input.db, input.completion.tenantId, authorityAt, consentPurpose);
  const exactConsent = consent.active && consent.consentId === governance.consentId &&
    (input.completion.product !== "regauge" ||
      consent.effectiveAt < authorityAt && consent.grantedAt < authorityAt &&
      consent.expiresAt !== null && consent.expiresAt > authorityAt &&
      consent.expiresAt <= REGAUGE_DEEPSEEK_APPROVED_SCOPE.authorizationDeadline);
  const pricing = resolvePricing(env);
  const principalId = env.MENDPOINT_AGENT_VERIFIER_PRINCIPAL_ID?.trim() || null;
  const pack = createCompletionVerifierEvidencePack({
    ...input.completion,
    governance: {
      dataClassification: governance.dataClassification,
      requiredRegion: governance.requiredRegion,
      processingRegion: governance.processingRegion,
      // Operator external-processing switch (evidence pack gate evaluates this
      // BEFORE consent, so an operator disabling egress globally always wins).
      externalModelAllowed: governance.externalModelAllowed,
      mayLeaveTenantBoundary: governance.mayLeaveTenantBoundary,
      // Reference the authoritative append-only consent record when active; the
      // env consentId is only a fallback for the denied path (never egresses).
      consentId: exactConsent ? consent.consentId : governance.consentId,
      // Both the operator's env consent switch AND an active tenant table consent
      // are required. Fail-closed: either false denies external egress.
      consentActive: governance.consentActive && exactConsent,
    },
    governanceEvidenceRef: governance.evidenceRef,
    assembledAt: input.completion.observedAt,
    assemblerVersion: "mendpoint-worker-completion-verifier/1",
    ...(input.substantiveSources ? { substantiveSources: input.substantiveSources } : {}),
  });
  const verificationAttemptId = `completion_${input.completion.taskId}`;
  // A dispatch intent proves only that work was requested. It is never a replay
  // terminal: only validated, durable telemetry proves the provider result was
  // recorded. This lets a queue retry after a timeout without permanently
  // suppressing the attempt that failed between intent and telemetry.
  if (findVerifierTelemetry(input.db, {
    tenantId: input.completion.tenantId,
    verificationAttemptId,
    evidencePackDigest: pack.packDigest,
  })) return null;
  const now = input.now ?? (() => new Date().toISOString());
  const providerTransport = input.transport ?? createFetchVerifierTransport();
  const completedProviderOperationIds: string[] = [];
  const transport = input.completion.product === "regauge"
    ? durableRegaugeTransport({
      db: input.db,
      providerTransport,
      tenantId: input.completion.tenantId,
      verificationAttemptId,
      evidencePackDigest: pack.packDigest,
      expectedConsentId: governance.consentId,
      producerPrincipalId: principalId,
      now,
      beforeProviderRequest: input.beforeProviderRequest,
      hooks: input.operationHooks,
      completedOperationIds: completedProviderOperationIds,
    })
    : input.transport;
  const runtime = createVerifierAdvisoryRuntime({
    env,
    pricing,
    ...(transport ? { transport } : {}),
    actorId: principalId ?? "mendpoint-verifier-worker",
    // A provider or log-probability transport failure is not a completed
    // verification. The durable queue must retry it, so do not create the
    // telemetry replay terminal for those two transient outcomes. Credential
    // access remains audited; a later successful/definitive result is retained.
    persistTelemetry: async (telemetry) => {
      if (telemetry.failureCode && RETRYABLE_VERIFIER_FAILURE_CODES.has(
        telemetry.failureCode as "api_failure" | "logprob_failure",
      )) return;
      persistVerifierTelemetry(input.db, { telemetry, producerPrincipalId: principalId });
    },
    auditCredentialAccess: async (event) => {
      const id = `audit_verifier_${createHash("sha256").update([input.completion.tenantId, event.credentialId, event.requestId ?? "none", event.outcome, event.occurredAt].join("\0")).digest("hex").slice(0, 40)}`;
      recordAudit(input.db, {
        id,
        tenantId: input.completion.tenantId,
        actor: "mendpoint-verifier-worker",
        principalId,
        requestId: event.requestId ?? null,
        action: "verifier.credential_access",
        resourceType: "credential",
        resourceId: event.credentialId,
        metadata: { audience: event.audience, purpose: event.purpose, outcome: event.outcome, reason: event.reason, occurredAt: event.occurredAt, rotation: event.rotation },
      });
    },
  });
  if (!runtime) return null;
  const result = await runtime.observe({
    pack,
    incumbentCandidateId: input.completion.candidateId,
    verificationAttemptId,
    observedAt: authorityAt,
  });
  if (result.failureCode && RETRYABLE_VERIFIER_FAILURE_CODES.has(
    result.failureCode as "api_failure" | "logprob_failure",
  )) {
    const operationId = completedProviderOperationIds.at(-1);
    if (operationId) {
      persistVerifierAdvisoryProviderRetryableResponse(input.db, {
        tenantId: input.completion.tenantId,
        operationId,
        errorCode: result.failureCode as "api_failure" | "logprob_failure",
        classifiedAt: now(),
        producerPrincipalId: principalId,
      });
    }
  }
  return result;
}

function durableRegaugeTransport(input: Readonly<{
  db: AppDb;
  providerTransport: VerifierHttpTransport;
  tenantId: string;
  verificationAttemptId: string;
  evidencePackDigest: string;
  expectedConsentId: string;
  producerPrincipalId: string | null;
  now: () => string;
  beforeProviderRequest?: (requestedAt: string) => void;
  hooks?: Readonly<{ afterProviderReturn?: () => void; afterProviderReceipt?: () => void }>;
  completedOperationIds: string[];
}>): VerifierHttpTransport {
  return Object.freeze({
    request: async (request: VerifierHttpRequest) => {
      const providerRequestId = request.headers["x-mendpoint-request-id"];
      if (!providerRequestId) throw new Error("verifier_advisory_provider_request_invalid");
      const requestedAt = input.now();
      input.beforeProviderRequest?.(requestedAt);
      const operation = beginVerifierAdvisoryProviderOperation(input.db, {
        tenantId: input.tenantId,
        verificationAttemptId: input.verificationAttemptId,
        evidencePackDigest: input.evidencePackDigest,
        providerRequestId,
        requestBodySha256: digest(canonical(request.body)),
        expectedConsentId: input.expectedConsentId,
        consentPurpose: REGAUGE_VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE,
        authorizationDeadline: REGAUGE_DEEPSEEK_APPROVED_SCOPE.authorizationDeadline,
        requestedAt,
        producerPrincipalId: input.producerPrincipalId,
      });
      if (operation.status === "recover") {
        input.completedOperationIds.push(operation.operationId);
        return operation.response!;
      }
      try {
        const response = await input.providerTransport.request(request);
        input.hooks?.afterProviderReturn?.();
        persistVerifierAdvisoryProviderResponse(input.db, {
          tenantId: input.tenantId,
          operationId: operation.operationId,
          response,
          providerProcessedAt: input.now(),
          producerPrincipalId: input.producerPrincipalId,
        });
        input.hooks?.afterProviderReceipt?.();
        input.completedOperationIds.push(operation.operationId);
        return response;
      } catch (error) {
        const noResponseCode = provableNoResponseCode(error);
        if (noResponseCode) {
          persistVerifierAdvisoryProviderNoResponse(input.db, {
            tenantId: input.tenantId,
            operationId: operation.operationId,
            failedAt: input.now(),
            errorCode: noResponseCode,
            producerPrincipalId: input.producerPrincipalId,
          });
        }
        throw error;
      }
    },
  });
}

function provableNoResponseCode(error: unknown): string | null {
  if (error instanceof VerifierProviderNoResponseError) return error.code;
  if (!error || typeof error !== "object") return null;
  const direct = (error as { code?: unknown }).code;
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  const code = typeof direct === "string" ? direct : typeof cause === "string" ? cause : null;
  return code && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code)
    ? `verifier_transport_${code.toLowerCase()}`
    : null;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function resolveVerifierGovernance(env: Readonly<Record<string, string | undefined>>, tenantId: string, product: VerifierProduct): Readonly<{ dataClassification: VerifierDataClassification; requiredRegion: string; processingRegion: string; consentId: string; evidenceRef: string; externalModelAllowed: boolean; mayLeaveTenantBoundary: boolean; consentActive: boolean }> {
  const raw = env.MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON?.trim();
  if (!raw) fail("verifier_governance_configuration_required");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail("verifier_governance_configuration_invalid"); }
  if (!record(parsed) || parsed.schemaVersion !== "2026-08-17.v1" || !Array.isArray(parsed.entries) || Object.keys(parsed).some((key) => !["schemaVersion", "entries"].includes(key))) fail("verifier_governance_configuration_invalid");
  const entries = parsed.entries as unknown[];
  const matches = entries.filter((entry) => record(entry) && entry.tenantId === tenantId && Array.isArray(entry.products) && entry.products.includes(product));
  if (matches.length !== 1) fail("verifier_governance_authority_missing");
  const entry = matches[0] as Record<string, unknown>;
  // The external-processing authority booleans come from tenant governance
  // configuration, not a code constant, so the evidence-pack governance gate can
  // actually refuse a tenant that has not authorized external egress, consent,
  // or a tenant-boundary crossing for this verifier.
  const keys = ["tenantId", "products", "dataClassification", "requiredRegion", "processingRegion", "consentId", "evidenceRef", "externalModelAllowed", "mayLeaveTenantBoundary", "consentActive"];
  if (Object.keys(entry).some((key) => !keys.includes(key)) || keys.some((key) => !(key in entry))) fail("verifier_governance_configuration_invalid");
  if (!Array.isArray(entry.products) || entry.products.some((value) => value !== "fettler" && value !== "regauge") || new Set(entry.products).size !== entry.products.length) fail("verifier_governance_configuration_invalid");
  if (!["public", "internal", "confidential", "restricted"].includes(String(entry.dataClassification)) || !text(entry.requiredRegion) || !text(entry.processingRegion) || entry.requiredRegion !== entry.processingRegion || !text(entry.consentId) || !text(entry.evidenceRef)) fail("verifier_governance_configuration_invalid");
  if (typeof entry.externalModelAllowed !== "boolean" || typeof entry.mayLeaveTenantBoundary !== "boolean" || typeof entry.consentActive !== "boolean") fail("verifier_governance_configuration_invalid");
  return Object.freeze({ dataClassification: entry.dataClassification as VerifierDataClassification, requiredRegion: entry.requiredRegion as string, processingRegion: entry.processingRegion as string, consentId: entry.consentId as string, evidenceRef: entry.evidenceRef as string, externalModelAllowed: entry.externalModelAllowed, mayLeaveTenantBoundary: entry.mayLeaveTenantBoundary, consentActive: entry.consentActive });
}

type ExternalModelConsent =
  | Readonly<{ active: true; consentId: string; effectiveAt: string; grantedAt: string; expiresAt: string | null }>
  | Readonly<{ active: false; consentId: null }>;

/**
 * Resolve tenant consent for external-model verifier egress from the append-only
 * `learning_consents` table via the same `findActiveLearningConsent` path every
 * other learning consumer uses. That helper is already fail-closed: it returns
 * undefined for no grant, a revoked grant, an expired grant, an out-of-window
 * grant, or an ambiguous residency, so revocation takes effect on the next
 * completion with no redeploy. Any read failure (unreadable table, malformed
 * timestamp) is also treated as a denial here: absence must never read as
 * granted. This resolves consent only; the operator env governance switch is an
 * additional restriction applied by the caller and by the evidence-pack gate.
 */
function resolveExternalModelConsent(db: AppDb, tenantId: string, at: string, purpose: string): ExternalModelConsent {
  try {
    const consent = findActiveLearningConsent(db, {
      tenantId,
      purpose,
      at,
    });
    return consent ? Object.freeze({
      active: true,
      consentId: consent.id,
      effectiveAt: consent.effective_at,
      grantedAt: consent.created_at,
      expiresAt: consent.expires_at,
    }) : Object.freeze({ active: false, consentId: null });
  } catch {
    return Object.freeze({ active: false, consentId: null });
  }
}

function resolvePricing(env: Readonly<Record<string, string | undefined>>): VerifierPricing {
  const raw = env.MENDPOINT_AGENT_VERIFIER_PRICING_JSON?.trim();
  if (!raw) fail("verifier_pricing_configuration_required");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail("verifier_pricing_configuration_invalid"); }
  const keys = ["version", "currency", "effectiveAt", "inputPerMillion", "cachedInputPerMillion", "outputPerMillion"];
  if (!record(parsed) || Object.keys(parsed).some((key) => !keys.includes(key)) || keys.some((key) => !(key in parsed)) || parsed.currency !== "USD" || !text(parsed.version) || !text(parsed.effectiveAt) || !Number.isFinite(Date.parse(parsed.effectiveAt as string)) || new Date(Date.parse(parsed.effectiveAt as string)).toISOString() !== parsed.effectiveAt || [parsed.inputPerMillion, parsed.cachedInputPerMillion, parsed.outputPerMillion].some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) fail("verifier_pricing_configuration_invalid");
  return Object.freeze(parsed as unknown as VerifierPricing);
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value); }
function fail(code: string): never { throw new Error(code); }

/** @deprecated Import ProductCompletionAdvisoryInput from @mendpoint/pipeline. */
export type ProductCompletionShadowInput = ProductCompletionAdvisoryInput;
/** @deprecated Import observeProductCompletionInAdvisory. */
export const observeProductCompletionInShadow = observeProductCompletionInAdvisory;
