import { createHash } from "node:crypto";
import {
  sandboxEgressAuthorityFromEnv,
  verifySandboxEgressAttestation,
  type VerifiedSandboxEgressAttestationPayload,
} from "@mendpoint/platform";
import { resolveEitherRenamedEnv } from "@mendpoint/shared";

export const CUSTOMER_QUALIFICATION_ATTESTATION_SCHEMA = "2026-08-30.v1" as const;
export const CUSTOMER_QUALIFICATION_REQUIREMENT_COUNT = 101 as const;

export type CustomerReadinessStatus = "ready" | "not_ready" | "indeterminate";
export type CustomerReadinessActivation = "inactive_compatibility" | "required";

export type CustomerReadinessReason =
  | "critical_health_indeterminate"
  | "critical_health_failed"
  | "customer_declaration_indeterminate"
  | "customer_declared_not_ready"
  | "customer_profile_blocked"
  | "evidence_revocation_state_indeterminate"
  | "evidence_revoked"
  | "qualification_activation_invalid"
  | "qualification_attestation_malformed"
  | "qualification_attestation_missing"
  | "qualification_evidence_manifest_digest_mismatch"
  | "qualification_outcome_incomplete"
  | "qualification_public_claims_digest_mismatch"
  | "qualification_register_digest_mismatch"
  | "qualification_revision_mismatch"
  | "qualification_trust_roots_missing"
  | "release_revision_indeterminate"
  | "sandbox_receipt_expired"
  | "sandbox_receipt_invalid"
  | "sandbox_receipt_revoked"
  | "sandbox_receipt_scope_mismatch"
  | "sandbox_receipt_unavailable"
  | "validation_time_indeterminate";

export type CustomerQualificationAttestation = Readonly<{
  schemaVersion: typeof CUSTOMER_QUALIFICATION_ATTESTATION_SCHEMA;
  qualifiedRevision: string;
  requirementRegisterDigest: string;
  publicClaimsRegistryDigest: string;
  evidenceManifestDigest: string;
  qualification: Readonly<{
    outcome: "qualified";
    requirementCount: typeof CUSTOMER_QUALIFICATION_REQUIREMENT_COUNT;
    qualifiedRequirementCount: typeof CUSTOMER_QUALIFICATION_REQUIREMENT_COUNT;
  }>;
}>;

export type CustomerQualificationTrustRoots = Readonly<{
  requirementRegisterDigest?: string;
  publicClaimsRegistryDigest?: string;
  evidenceManifestDigest?: string;
}>;

export type CustomerSandboxReceiptVerification =
  | Readonly<{
      status: "verified";
      app: string;
      image: string;
      policyDigest: string;
      testedAt: string;
      expiresAt: string;
    }>
  | Readonly<{
      status: "invalid" | "expired" | "scope_mismatch" | "revoked" | "unavailable";
    }>;

export type CustomerCriticalHealth = Readonly<{ name: string; ok: boolean }>;

export type CustomerReadinessInput = Readonly<{
  activation: CustomerReadinessActivation | string;
  declaration?: string;
  releaseRevision?: string | null;
  qualificationAttestation?: unknown;
  trustRoots?: CustomerQualificationTrustRoots;
  profileBlockers?: readonly string[];
  sandboxReceipt?: CustomerSandboxReceiptVerification;
  criticalHealth?: readonly CustomerCriticalHealth[];
  revokedEvidenceIds?: readonly string[];
  now: string;
}>;

export type CustomerReadinessAssessment = Readonly<{
  status: CustomerReadinessStatus;
  declared: CustomerReadinessStatus;
  activation: CustomerReadinessActivation | "invalid";
  reasons: readonly CustomerReadinessReason[];
  sourceRevision: string | null;
  digest: `sha256:${string}`;
}>;

export type CustomerReadinessAuthority = Readonly<{
  qualificationAttestation?: unknown;
  trustRoots?: CustomerQualificationTrustRoots;
  sandboxReceipt?: CustomerSandboxReceiptVerification;
  criticalHealth?: readonly CustomerCriticalHealth[];
  revokedEvidenceIds?: readonly string[];
  releaseRevision?: string | null;
  now?: string;
}>;

const RELEASE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const ATTESTATION_KEYS = Object.freeze([
  "schemaVersion",
  "qualifiedRevision",
  "requirementRegisterDigest",
  "publicClaimsRegistryDigest",
  "evidenceManifestDigest",
  "qualification",
]);
const QUALIFICATION_KEYS = Object.freeze([
  "outcome",
  "requirementCount",
  "qualifiedRequirementCount",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`);
  return `{${entries.join(",")}}`;
}

function assessmentDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

export function parseCustomerQualificationAttestation(value: unknown): CustomerQualificationAttestation | null {
  if (!isRecord(value) || !hasExactKeys(value, ATTESTATION_KEYS)) return null;
  if (
    value.schemaVersion !== CUSTOMER_QUALIFICATION_ATTESTATION_SCHEMA ||
    typeof value.qualifiedRevision !== "string" ||
    !RELEASE_REVISION.test(value.qualifiedRevision) ||
    typeof value.requirementRegisterDigest !== "string" ||
    !SHA256.test(value.requirementRegisterDigest) ||
    typeof value.publicClaimsRegistryDigest !== "string" ||
    !SHA256.test(value.publicClaimsRegistryDigest) ||
    typeof value.evidenceManifestDigest !== "string" ||
    !SHA256.test(value.evidenceManifestDigest) ||
    !isRecord(value.qualification) ||
    !hasExactKeys(value.qualification, QUALIFICATION_KEYS) ||
    value.qualification.outcome !== "qualified" ||
    typeof value.qualification.requirementCount !== "number" ||
    typeof value.qualification.qualifiedRequirementCount !== "number"
  ) return null;
  return value as CustomerQualificationAttestation;
}

function receiptReason(
  receipt: Exclude<CustomerSandboxReceiptVerification, { status: "verified" }>,
): CustomerReadinessReason {
  if (receipt.status === "expired") return "sandbox_receipt_expired";
  if (receipt.status === "scope_mismatch") return "sandbox_receipt_scope_mismatch";
  if (receipt.status === "revoked") return "sandbox_receipt_revoked";
  if (receipt.status === "unavailable") return "sandbox_receipt_unavailable";
  return "sandbox_receipt_invalid";
}

/**
 * Pure customer-readiness authority. The declaration is only an upper bound:
 * it may hold readiness down, but it cannot prove qualification, sandbox
 * containment, health, or non-revocation.
 */
export function computeCustomerReadiness(input: CustomerReadinessInput): CustomerReadinessAssessment {
  const reasons = new Set<CustomerReadinessReason>();
  const declaration = input.declaration?.trim();
  const declared: CustomerReadinessStatus = declaration === "1"
    ? "ready"
    : declaration === "0"
      ? "not_ready"
      : "indeterminate";
  const activation = input.activation === "inactive_compatibility" || input.activation === "required"
    ? input.activation
    : "invalid";
  const sourceRevision = typeof input.releaseRevision === "string" && RELEASE_REVISION.test(input.releaseRevision)
    ? input.releaseRevision
    : null;
  const nowMs = Date.parse(input.now);
  const revocationStateAuthoritative = Array.isArray(input.revokedEvidenceIds) &&
    input.revokedEvidenceIds.every((evidenceId) => typeof evidenceId === "string" && evidenceId.trim().length > 0);

  if (declared === "indeterminate") reasons.add("customer_declaration_indeterminate");
  else if (declared === "not_ready") reasons.add("customer_declared_not_ready");
  if (activation === "invalid") reasons.add("qualification_activation_invalid");
  if (!Number.isFinite(nowMs) || new Date(nowMs).toISOString() !== input.now) {
    reasons.add("validation_time_indeterminate");
  }
  if ((input.profileBlockers?.length ?? 0) > 0) reasons.add("customer_profile_blocked");

  if (activation === "required") {
    if (!input.criticalHealth || input.criticalHealth.length === 0) {
      reasons.add("critical_health_indeterminate");
    } else if (input.criticalHealth.some((check) => !check.ok)) {
      reasons.add("critical_health_failed");
    }
    if (!revocationStateAuthoritative) reasons.add("evidence_revocation_state_indeterminate");
    else if (input.revokedEvidenceIds.length > 0) reasons.add("evidence_revoked");
    if (!sourceRevision) reasons.add("release_revision_indeterminate");
    const trustRoots = input.trustRoots;
    if (
      !trustRoots ||
      !trustRoots.requirementRegisterDigest ||
      !SHA256.test(trustRoots.requirementRegisterDigest) ||
      !trustRoots.publicClaimsRegistryDigest ||
      !SHA256.test(trustRoots.publicClaimsRegistryDigest) ||
      !trustRoots.evidenceManifestDigest ||
      !SHA256.test(trustRoots.evidenceManifestDigest)
    ) reasons.add("qualification_trust_roots_missing");

    if (input.qualificationAttestation === undefined || input.qualificationAttestation === null) {
      reasons.add("qualification_attestation_missing");
    } else {
      const attestation = parseCustomerQualificationAttestation(input.qualificationAttestation);
      if (!attestation) {
        reasons.add("qualification_attestation_malformed");
      } else {
        if (sourceRevision && attestation.qualifiedRevision !== sourceRevision) {
          reasons.add("qualification_revision_mismatch");
        }
        if (trustRoots?.requirementRegisterDigest && attestation.requirementRegisterDigest !== trustRoots.requirementRegisterDigest) {
          reasons.add("qualification_register_digest_mismatch");
        }
        if (trustRoots?.publicClaimsRegistryDigest && attestation.publicClaimsRegistryDigest !== trustRoots.publicClaimsRegistryDigest) {
          reasons.add("qualification_public_claims_digest_mismatch");
        }
        if (trustRoots?.evidenceManifestDigest && attestation.evidenceManifestDigest !== trustRoots.evidenceManifestDigest) {
          reasons.add("qualification_evidence_manifest_digest_mismatch");
        }
        if (
          attestation.qualification.requirementCount !== CUSTOMER_QUALIFICATION_REQUIREMENT_COUNT ||
          attestation.qualification.qualifiedRequirementCount !== CUSTOMER_QUALIFICATION_REQUIREMENT_COUNT
        ) reasons.add("qualification_outcome_incomplete");
      }
    }

    const receipt = input.sandboxReceipt;
    if (!receipt) {
      reasons.add("sandbox_receipt_unavailable");
    } else if (receipt.status !== "verified") {
      reasons.add(receiptReason(receipt));
    } else {
      const expiresAtMs = Date.parse(receipt.expiresAt);
      if (!Number.isFinite(expiresAtMs)) reasons.add("sandbox_receipt_invalid");
      else if (Number.isFinite(nowMs) && nowMs >= expiresAtMs) reasons.add("sandbox_receipt_expired");
    }
  }

  const orderedReasons = [...reasons].sort();
  const indeterminateReasons = new Set<CustomerReadinessReason>([
    "critical_health_indeterminate",
    "customer_declaration_indeterminate",
    "evidence_revocation_state_indeterminate",
    "qualification_activation_invalid",
    "qualification_attestation_malformed",
    "qualification_attestation_missing",
    "qualification_trust_roots_missing",
    "release_revision_indeterminate",
    "sandbox_receipt_unavailable",
    "validation_time_indeterminate",
  ]);
  const status: CustomerReadinessStatus = orderedReasons.length === 0
    ? "ready"
    : orderedReasons.some((reason) => indeterminateReasons.has(reason))
      ? "indeterminate"
      : "not_ready";
  const assessmentWithoutDigest = Object.freeze({
    status,
    declared,
    activation,
    reasons: Object.freeze(orderedReasons),
    sourceRevision,
  });
  return Object.freeze({
    ...assessmentWithoutDigest,
    digest: assessmentDigest({
      assessment: assessmentWithoutDigest,
      evaluatedAt: input.now,
      profileBlockers: [...(input.profileBlockers ?? [])].sort(),
      criticalHealth: [...(input.criticalHealth ?? [])]
        .map(({ name, ok }) => ({ name, ok }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      revokedEvidenceIds: revocationStateAuthoritative ? [...input.revokedEvidenceIds].sort() : null,
      trustRoots: input.trustRoots ?? null,
      qualificationAttestation: parseCustomerQualificationAttestation(input.qualificationAttestation),
      sandboxReceipt: input.sandboxReceipt ?? null,
    }),
  });
}

function sandboxReceiptFromError(error: unknown): CustomerSandboxReceiptVerification {
  const code = error instanceof Error ? error.message : "sandbox_egress_attestation_invalid";
  if (code === "sandbox_egress_attestation_expired") return Object.freeze({ status: "expired" });
  if (code === "sandbox_egress_attestation_scope_mismatch") return Object.freeze({ status: "scope_mismatch" });
  if (code === "sandbox_egress_attestation_required") return Object.freeze({ status: "unavailable" });
  return Object.freeze({ status: "invalid" });
}

export function verifyCustomerSandboxReceipt(
  env: Readonly<NodeJS.ProcessEnv>,
  now: string,
): CustomerSandboxReceiptVerification {
  const expectedApp = env.MENDPOINT_SANDBOX_FLY_APP?.trim();
  const expectedImage = env.MENDPOINT_SANDBOX_FLY_IMAGE?.trim();
  if (!expectedApp || !expectedImage) return Object.freeze({ status: "unavailable" });
  try {
    const payload: VerifiedSandboxEgressAttestationPayload = verifySandboxEgressAttestation({
      ...sandboxEgressAuthorityFromEnv(env as NodeJS.ProcessEnv),
      expectedApp,
      expectedImage,
      observedAt: now,
    });
    return Object.freeze({
      status: "verified",
      app: payload.app,
      image: payload.image,
      policyDigest: payload.policyDigest,
      testedAt: payload.testedAt,
      expiresAt: payload.expiresAt,
    });
  } catch (error) {
    return sandboxReceiptFromError(error);
  }
}

/**
 * Runtime adapter. Unset activation stays in explicit inactive compatibility
 * mode. Supplying or requiring the new authority switches to fail-closed mode.
 */
export function assessCustomerReadiness(
  env: Readonly<Record<string, string | undefined>>,
  profileBlockers: readonly string[] = [],
  authority: CustomerReadinessAuthority = {},
): CustomerReadinessAssessment {
  const configuredActivation = env.MENDPOINT_CUSTOMER_QUALIFICATION_MODE?.trim();
  const activation = configuredActivation === undefined || configuredActivation === ""
    ? "inactive_compatibility"
    : configuredActivation === "inactive"
      ? "inactive_compatibility"
      : configuredActivation;
  const now = authority.now ?? new Date().toISOString();
  const required = activation === "required";
  const receipt = authority.sandboxReceipt ?? (required
    ? verifyCustomerSandboxReceipt(env as NodeJS.ProcessEnv, now)
    : undefined);
  return computeCustomerReadiness({
    activation,
    declaration: resolveEitherRenamedEnv(env, "MENDPOINT_CUSTOMER_READY"),
    releaseRevision: authority.releaseRevision ?? env.MENDPOINT_RELEASE_REVISION?.trim() ?? null,
    qualificationAttestation: authority.qualificationAttestation,
    trustRoots: authority.trustRoots,
    profileBlockers,
    sandboxReceipt: receipt,
    criticalHealth: authority.criticalHealth,
    revokedEvidenceIds: authority.revokedEvidenceIds,
    now,
  });
}
