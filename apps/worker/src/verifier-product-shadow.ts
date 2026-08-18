import { createHash } from "node:crypto";
import { recordAudit, type AppDb } from "@mendpoint/db";
import { claimVerifierShadowAttempt, persistVerifierTelemetry } from "@mendpoint/pipeline";
import {
  createCompletionVerifierEvidencePack,
  resolveVerifierRuntimeConfig,
  type AgentVerifierResult,
  type VerifierDataClassification,
  type VerifierHttpTransport,
  type VerifierPricing,
  type VerifierProduct,
  type VerifierRisk,
} from "@mendpoint/verifier";
import { createVerifierShadowRuntime } from "./verifier-shadow.js";

export type ProductCompletionShadowInput = Readonly<{
  tenantId: string;
  missionId: string;
  taskId: string;
  product: VerifierProduct;
  repositoryId: string;
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

export async function observeProductCompletionInShadow(input: Readonly<{
  db: AppDb;
  env?: Readonly<Record<string, string | undefined>>;
  completion: ProductCompletionShadowInput;
  transport?: VerifierHttpTransport;
}>): Promise<AgentVerifierResult | null> {
  const env = input.env ?? process.env;
  const runtimeConfig = resolveVerifierRuntimeConfig(env);
  if (!runtimeConfig.enabled || runtimeConfig.rolloutMode === "off") return null;
  const governance = resolveGovernance(env, input.completion.tenantId, input.completion.product);
  const pricing = resolvePricing(env);
  const principalId = env.MENDPOINT_AGENT_VERIFIER_PRINCIPAL_ID?.trim() || null;
  const pack = createCompletionVerifierEvidencePack({
    ...input.completion,
    governance: {
      dataClassification: governance.dataClassification,
      requiredRegion: governance.requiredRegion,
      processingRegion: governance.processingRegion,
      externalModelAllowed: governance.externalModelAllowed,
      mayLeaveTenantBoundary: governance.mayLeaveTenantBoundary,
      consentId: governance.consentId,
      consentActive: governance.consentActive,
    },
    governanceEvidenceRef: governance.evidenceRef,
    assembledAt: input.completion.observedAt,
    assemblerVersion: "mendpoint-worker-completion-verifier/1",
  });
  const verificationAttemptId = `completion_${input.completion.taskId}`;
  if (!claimVerifierShadowAttempt(input.db, {
    tenantId: input.completion.tenantId,
    verificationAttemptId,
    evidencePackDigest: pack.packDigest,
    observedAt: input.completion.observedAt,
    producerPrincipalId: principalId,
  })) return null;
  const runtime = createVerifierShadowRuntime({
    env,
    pricing,
    ...(input.transport ? { transport: input.transport } : {}),
    actorId: principalId ?? "mendpoint-verifier-worker",
    persistTelemetry: async (telemetry) => { persistVerifierTelemetry(input.db, { telemetry, producerPrincipalId: principalId }); },
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
  return await runtime.observe({
    pack,
    incumbentCandidateId: input.completion.candidateId,
    verificationAttemptId,
    observedAt: input.completion.observedAt,
  });
}

function resolveGovernance(env: Readonly<Record<string, string | undefined>>, tenantId: string, product: VerifierProduct): Readonly<{ dataClassification: VerifierDataClassification; requiredRegion: string; processingRegion: string; consentId: string; evidenceRef: string; externalModelAllowed: boolean; mayLeaveTenantBoundary: boolean; consentActive: boolean }> {
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
