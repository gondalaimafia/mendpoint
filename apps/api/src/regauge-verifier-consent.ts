import {
  findActiveLearningConsent,
  grantLearningConsent,
  listLearningConsentHistory,
  type AppDb,
  type LearningConsentRow,
} from "@mendpoint/db";
import {
  REGAUGE_DEEPSEEK_APPROVED_SCOPE,
  REGAUGE_VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE,
} from "@mendpoint/pipeline";

export const REGAUGE_VERIFIER_CONSENT_PURPOSE = REGAUGE_VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE;
export const REGAUGE_VERIFIER_AUTHORIZATION_DEADLINE = REGAUGE_DEEPSEEK_APPROVED_SCOPE.authorizationDeadline;

export type RegaugeVerifierConsentAuthority = Readonly<{
  consentId: string;
  evidenceRef: string;
  residencyRegion: string;
  effectiveAt: string;
  expiresAt: string;
}>;

export type RegaugeVerifierConsentReadiness =
  | Readonly<{ status: "active"; consent: LearningConsentRow }>
  | Readonly<{
      status: "disabled";
      reason: "historical_consent_inactive" | "explicit_versioned_consent_required";
      latestConsentId: string;
      latestConsentVersion: number;
      requestedConsentId?: string;
      requiredConsentVersion?: number;
      supersedesConsentId?: string;
    }>;

export function regaugeVerifierConsentAuthorityFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  tenantId: string,
): RegaugeVerifierConsentAuthority {
  if (tenantId !== REGAUGE_DEEPSEEK_APPROVED_SCOPE.tenantId) {
    throw new Error("regauge_verifier_consent_scope_invalid");
  }
  let governance: unknown;
  try { governance = JSON.parse(required(env.MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON)); }
  catch { throw new Error("regauge_verifier_consent_governance_invalid"); }
  if (!record(governance) || governance.schemaVersion !== "2026-08-17.v1" ||
      !Array.isArray(governance.entries)) {
    throw new Error("regauge_verifier_consent_governance_invalid");
  }
  const matches = governance.entries.filter((entry) => record(entry) &&
    entry.tenantId === tenantId && Array.isArray(entry.products) && entry.products.includes("regauge"));
  if (matches.length !== 1) throw new Error("regauge_verifier_consent_governance_invalid");
  const entry = matches[0]!;
  if (!text(entry.consentId) || !text(entry.evidenceRef) || !text(entry.processingRegion) ||
      entry.processingRegion !== entry.requiredRegion || entry.externalModelAllowed !== true ||
      entry.mayLeaveTenantBoundary !== true || entry.consentActive !== true) {
    throw new Error("regauge_verifier_consent_governance_invalid");
  }
  const effectiveAt = exactIso(env.MENDPOINT_REGAUGE_VERIFIER_CONSENT_EFFECTIVE_AT);
  const expiresAt = exactIso(env.MENDPOINT_REGAUGE_VERIFIER_CONSENT_EXPIRES_AT);
  if (Date.parse(effectiveAt) >= Date.parse(expiresAt) ||
      Date.parse(expiresAt) > Date.parse(REGAUGE_VERIFIER_AUTHORIZATION_DEADLINE)) {
    throw new Error("regauge_verifier_consent_window_invalid");
  }
  return Object.freeze({
    consentId: entry.consentId,
    evidenceRef: entry.evidenceRef,
    residencyRegion: entry.processingRegion,
    effectiveAt,
    expiresAt,
  });
}

export function ensureRegaugeVerifierConsent(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    reviewerPrincipalId: string;
    authority: RegaugeVerifierConsentAuthority;
    createdAt: string;
  }>,
): RegaugeVerifierConsentReadiness {
  if (input.tenantId !== REGAUGE_DEEPSEEK_APPROVED_SCOPE.tenantId) {
    throw new Error("regauge_verifier_consent_scope_invalid");
  }
  const at = exactIso(input.createdAt);
  const current = findActiveLearningConsent(db, {
    tenantId: input.tenantId,
    purpose: REGAUGE_VERIFIER_CONSENT_PURPOSE,
    at,
  });
  if (current) {
    return exact(current, input)
      ? Object.freeze({ status: "active", consent: current })
      : fail("regauge_verifier_consent_drift");
  }
  const history = listLearningConsentHistory(db, {
    tenantId: input.tenantId,
    purpose: REGAUGE_VERIFIER_CONSENT_PURPOSE,
  });
  const latest = history[0];
  if (latest) {
    const replacementRequired = !history.some((record) =>
      record.action === "granted" && record.id === input.authority.consentId
    );
    return Object.freeze({
      status: "disabled",
      reason: replacementRequired
        ? "explicit_versioned_consent_required"
        : "historical_consent_inactive",
      latestConsentId: latest.id,
      latestConsentVersion: latest.consent_version,
      ...(replacementRequired ? {
        requestedConsentId: input.authority.consentId,
        requiredConsentVersion: latest.consent_version + 1,
        supersedesConsentId: latest.id,
      } : {}),
    });
  }
  grantLearningConsent(db, {
    id: input.authority.consentId,
    tenantId: input.tenantId,
    consentVersion: 1,
    purpose: REGAUGE_VERIFIER_CONSENT_PURPOSE,
    residencyRegion: input.authority.residencyRegion,
    authorizedByPrincipalId: input.reviewerPrincipalId,
    supersedesConsentId: null,
    effectiveAt: input.authority.effectiveAt,
    expiresAt: input.authority.expiresAt,
    reason: reason(input.authority.evidenceRef),
    idempotencyKey: `regauge-verifier-consent:${input.authority.consentId}`,
    createdAt: at,
  });
  const stored = findActiveLearningConsent(db, {
    tenantId: input.tenantId,
    purpose: REGAUGE_VERIFIER_CONSENT_PURPOSE,
    at,
  });
  return stored && exact(stored, input)
    ? Object.freeze({ status: "active", consent: stored })
    : fail("regauge_verifier_consent_inactive");
}

function exact(row: LearningConsentRow, input: Readonly<{
  reviewerPrincipalId: string;
  authority: RegaugeVerifierConsentAuthority;
}>): boolean {
  return row.id === input.authority.consentId &&
    row.authorized_by_principal_id === input.reviewerPrincipalId &&
    row.residency_region === input.authority.residencyRegion &&
    row.effective_at === input.authority.effectiveAt &&
    row.expires_at === input.authority.expiresAt &&
    row.reason === reason(input.authority.evidenceRef);
}

function reason(evidenceRef: string): string {
  return `Authorized DeepSeek advisory verification for ${REGAUGE_DEEPSEEK_APPROVED_SCOPE.campaignId} at ${REGAUGE_DEEPSEEK_APPROVED_SCOPE.repositoryFullName}: ${evidenceRef}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 1_024;
}
function required(value: string | undefined): string {
  if (!value?.trim()) throw new Error("regauge_verifier_consent_configuration_required");
  return value.trim();
}
function exactIso(value: string | undefined): string {
  const normalized = required(value);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    throw new Error("regauge_verifier_consent_window_invalid");
  }
  return normalized;
}
function fail(code: string): never { throw new Error(code); }
