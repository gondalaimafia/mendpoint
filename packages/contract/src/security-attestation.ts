/**
 * Security-scan attestation: a bound, attributed, tiered replacement for the bare
 * `securityScanAttested` boolean that the PR security gate used to reduce to.
 *
 * No security scanner runs anywhere in this repository, and this module does not
 * invent one. What it does is turn the caller's claim into a structured record
 * that (a) names the attesting principal, (b) is bound to the exact change it
 * covers via a subject digest so it cannot be replayed onto a different change,
 * (c) may carry an expiry, and (d) distinguishes a bare human claim from a
 * scanner result carrying tool identity and an evidence reference.
 *
 * `verified: true` is NOT a property the caller can assert. Only a scanner-tier
 * result is eligible, and it becomes verified only when the platform itself
 * checks it — binds it to the authenticated principal and dereferences its
 * evidence (the `expectedPrincipal` / `verifyEvidence` seam below). With neither
 * wired today, a scanner tier is recorded and can satisfy a claim-tier policy,
 * but is never `verified`, and a require-verified policy fails closed. So typing
 * `"tier":"scanner"` into a request body can never produce a verified gate.
 *
 * The type is a discriminated union on `tier`, so the two tiers are structurally
 * different, not a string convention.
 */
import { createHash } from "node:crypto";

// Retained forward-compat surface: the canonical schema-version anchor for the
// security-attestation contract. Unreferenced until a v2 forces a migration; do
// not remove — it is the version this contract advertises to consumers.
export const SECURITY_ATTESTATION_SCHEMA_VERSION = 1 as const;

const DIGEST = /^[a-f0-9]{64}$/;

export type SecurityAttestationTier = "claim" | "scanner";

/** Binds an attestation to the exact change it covers. */
export type SecurityAttestationSubject = {
  /** Hash algorithm. Only sha256 is supported. */
  algo: "sha256";
  /** Lowercase-hex sha256 of the canonical change (old + new spec). */
  digest: string;
};

type SecurityAttestationBase = {
  /** Who asserts this — a human identity (email) or a service principal id. */
  principal: string;
  /** ISO-8601 timestamp the attestation was minted. */
  attestedAt: string;
  /** Subject binding to one exact change. */
  subject: SecurityAttestationSubject;
  /** Optional ISO-8601 expiry; enforced when present. */
  expiresAt?: string;
};

/**
 * Tier 1 — a bare human claim. Attributed and bound, but no tool ran, so this
 * tier is never `verified`.
 */
export type SecurityScanClaim = SecurityAttestationBase & {
  tier: "claim";
};

/**
 * Tier 2 — a scanner result. Carries the identity of the tool that produced it
 * and a reference to durable evidence. This is the only tier eligible to be
 * `verified`, but eligibility is not verification: it is verified only once the
 * platform binds it to the authenticated principal and dereferences its
 * evidence.
 */
export type SecurityScanResult = SecurityAttestationBase & {
  tier: "scanner";
  /** Identity of the scanner that produced the result. */
  tool: { name: string; version: string };
  /** Reference to the durable scan evidence (report URI or artifact id). */
  evidenceRef: string;
};

export type SecurityScanAttestation = SecurityScanClaim | SecurityScanResult;

export type SecurityAttestationPolicySource =
  /** Non-customer deployment, no explicit flag — today's behaviour. */
  | "default"
  /** Non-customer deployment that explicitly opted into require-verified. */
  | "require_verified_flag"
  /** Customer-profile deployment: requires verified by default. */
  | "customer_profile"
  /** A require-verified deployment downgraded by an explicit operator override. */
  | "operator_override";

/**
 * Deployment policy for the security gate. `requiredTier: "claim"` (the default
 * on non-customer deployments) preserves the historical behaviour exactly — a
 * bare claim satisfies the gate. `requiredTier: "scanner"` demands a verified
 * scanner result, so a bare claim fails the gate closed. `downgradeApplied`
 * marks the case where an otherwise require-verified deployment accepted a weaker
 * tier because an operator override is set; every attestation it permits records
 * the downgrade.
 */
export type SecurityAttestationPolicy = {
  requiredTier: SecurityAttestationTier;
  downgradeApplied: boolean;
  source: SecurityAttestationPolicySource;
};

export const DEFAULT_SECURITY_ATTESTATION_POLICY: SecurityAttestationPolicy =
  Object.freeze({
    requiredTier: "claim",
    downgradeApplied: false,
    source: "default",
  });

/**
 * Deployment profile value that requires a verified scanner result by default.
 * The policy keys on the deployment PROFILE (`MENDPOINT_DEPLOYMENT_PROFILE`),
 * consistent with every other customer guardrail (pilot-seed, backup
 * completeness, poll settings). It deliberately does NOT key on
 * `MENDPOINT_DEPLOYMENT_CLASS`: the live app runs CLASS=customer with
 * PROFILE=demo, and keying on CLASS would flip require-verified on in production
 * with nothing able to produce a verified result — a shipped outage.
 */
export const SECURITY_ATTESTATION_CUSTOMER_PROFILE = "customer" as const;
export const DEPLOYMENT_PROFILE_ENV = "MENDPOINT_DEPLOYMENT_PROFILE" as const;

/**
 * Explicit opt-in that raises the required tier to `scanner` on a deployment
 * whose profile would not otherwise demand it (a regulated non-customer buyer).
 * New variable, no legacy name, so it is read directly (the dual-read helper in
 * `@mendpoint/shared` is only for variables that were renamed and still carry a
 * superseded alias in production). Default-off preserves today's behaviour.
 */
export const SECURITY_ATTESTATION_REQUIRE_VERIFIED_ENV =
  "MENDPOINT_SECURITY_ATTESTATION_REQUIRE_VERIFIED" as const;

/**
 * Operator override that lets a require-verified deployment (customer profile, or
 * the explicit flag above) accept the attested `claim` tier. Explicit and
 * opt-in; never inferred. Every attestation it permits is recorded as a
 * downgrade in the audit record and stated plainly in the PR evidence. A
 * malformed value fails closed — the override does not take effect and
 * require-verified stays in force.
 */
export const SECURITY_ATTESTATION_ALLOW_UNVERIFIED_ENV =
  "MENDPOINT_SECURITY_ATTESTATION_ALLOW_UNVERIFIED" as const;

type FlagState = "on" | "off" | "malformed";

function parseFlag(raw: string | undefined): FlagState {
  if (raw === undefined) return "off";
  const value = raw.trim().toLowerCase();
  if (value === "") return "off";
  if (value === "1" || value === "true") return "on";
  if (value === "0" || value === "false") return "off";
  return "malformed";
}

/**
 * Resolve the security-attestation policy from environment.
 *
 * Precedence: a customer-profile deployment (or an explicit require-verified
 * flag) demands the verified tier, UNLESS the operator override is validly set —
 * in which case the attested tier is accepted and the acceptance is recorded as
 * a downgrade. A malformed override fails closed (require-verified stays). Every
 * other profile keeps today's behaviour.
 */
export function securityAttestationPolicyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): SecurityAttestationPolicy {
  const customerProfile =
    env[DEPLOYMENT_PROFILE_ENV]?.trim() === SECURITY_ATTESTATION_CUSTOMER_PROFILE;
  const requireFlag = parseFlag(env[SECURITY_ATTESTATION_REQUIRE_VERIFIED_ENV]);
  const wantVerified = customerProfile || requireFlag === "on";
  if (!wantVerified) {
    return { requiredTier: "claim", downgradeApplied: false, source: "default" };
  }
  const overrideFlag = parseFlag(env[SECURITY_ATTESTATION_ALLOW_UNVERIFIED_ENV]);
  if (overrideFlag === "on") {
    return {
      requiredTier: "claim",
      downgradeApplied: true,
      source: "operator_override",
    };
  }
  // Override off or malformed: it does not take effect. Fail closed to verified.
  return {
    requiredTier: "scanner",
    downgradeApplied: false,
    source: customerProfile ? "customer_profile" : "require_verified_flag",
  };
}

const TIER_RANK: Readonly<Record<SecurityAttestationTier, number>> = Object.freeze({
  claim: 1,
  scanner: 2,
});

export type SecurityAttestationCode =
  | "none"
  | "legacy_claim"
  | "valid_claim"
  | "valid_scanner"
  | "malformed"
  | "subject_unverifiable"
  | "subject_mismatch"
  | "expired"
  | "policy_insufficient";

/**
 * The evaluated outcome, surfaced to the PR gate, the PR evidence renderer, and
 * the durable audit record. `satisfied` is the single fail-closed verdict the
 * gate consumes.
 */
export type SecurityAttestationOutcome = {
  /** Whether any attestation (structured or legacy boolean) was supplied. */
  present: boolean;
  /** Effective tier; "none" when absent or rejected before a tier is decided. */
  tier: "none" | SecurityAttestationTier;
  /**
   * True only for a valid, unexpired, subject-bound scanner result that the
   * PLATFORM verified (principal-bound and evidence dereferenced) — never from
   * the caller's tier label alone.
   */
  verified: boolean;
  /** Did the attestation satisfy the gate under the active policy? */
  satisfied: boolean;
  /** True for the legacy bare-boolean path: a claim attributed to nobody. */
  unattributed: boolean;
  /** True when the operator override accepted a weaker tier than the deployment demands. */
  downgradeApplied: boolean;
  /** Machine-readable reason. */
  code: SecurityAttestationCode;
  /** Human-readable detail for the gate and the audit record. */
  detail: string;
  /** Minimum tier demanded by the active policy. */
  requiredTier: SecurityAttestationTier;
  /** How the active policy was resolved. */
  policySource: SecurityAttestationPolicySource;
  principal?: string;
  attestedAt?: string;
  subjectDigest?: string;
  expiresAt?: string;
  tool?: { name: string; version: string };
  evidenceRef?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Deterministic digest of the exact change being gated. The change is fully
 * determined by its (oldSpec, newSpec) transition; the pipeline already
 * content-addresses both specs as source artifacts (`textDigest(openapi_json)`),
 * so this reuses that content identity, canonicalized so an attester computes the
 * same value independently of key ordering or whitespace. It is deliberately not
 * the random per-run `changeId`, which an attester cannot reproduce and which
 * differs between runs of the same change.
 */
export function changeSubjectDigest(oldSpec: unknown, newSpec: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ old: oldSpec ?? null, new: newSpec ?? null }))
    .digest("hex");
}

/**
 * Structural validation of a supplied attestation. Fail-closed: anything that is
 * not a well-formed claim or scanner result is rejected.
 */
function isWellFormed(attestation: SecurityScanAttestation): boolean {
  if (!isRecord(attestation)) return false;
  if (!isNonEmptyString(attestation.principal)) return false;
  if (!isIsoTimestamp(attestation.attestedAt)) return false;
  const subject = attestation.subject;
  if (
    !isRecord(subject) ||
    subject.algo !== "sha256" ||
    typeof subject.digest !== "string" ||
    !DIGEST.test(subject.digest)
  ) {
    return false;
  }
  if (
    attestation.expiresAt !== undefined &&
    !isIsoTimestamp(attestation.expiresAt)
  ) {
    return false;
  }
  if (attestation.tier === "claim") return true;
  if (attestation.tier === "scanner") {
    const tool = (attestation as SecurityScanResult).tool;
    if (
      !isRecord(tool) ||
      !isNonEmptyString(tool.name) ||
      !isNonEmptyString(tool.version)
    ) {
      return false;
    }
    return isNonEmptyString((attestation as SecurityScanResult).evidenceRef);
  }
  return false;
}

/**
 * Evaluate a security-scan attestation against the change being gated and the
 * deployment policy. Missing, malformed, expired, mismatched-subject, or
 * policy-insufficient all resolve to `satisfied: false` — the gate blocks
 * delivery on any ambiguity.
 */
export function evaluateSecurityAttestation(input: {
  /** Structured attestation from a current client. */
  attestation?: SecurityScanAttestation;
  /** Bare boolean from an older client — degrades to the weakest, unattributed tier. */
  legacyAttested?: boolean;
  /** Subject digest of the change being gated; undefined when specs are absent. */
  expectedSubjectDigest?: string;
  policy?: SecurityAttestationPolicy;
  /** Evaluation clock (ISO-8601); defaults to now. */
  now?: string;
  /**
   * The authenticated principal the platform observed for this request. A
   * scanner result is only VERIFIED when it is bound to this principal — a
   * caller cannot mint a verified attestation in someone else's name. Absent
   * (today's wiring: the gate does not yet pass an authenticated principal down)
   * means no scanner result can be verified.
   */
  expectedPrincipal?: string;
  /**
   * Platform-side dereference of a scanner result's evidenceRef. `verified` is
   * true ONLY when this hook is supplied AND returns true for the referenced
   * evidence — never from the caller's `tier` label alone. Absent (today's
   * wiring: no scanner or durable evidence store is connected) means a
   * scanner-tier attestation is at most `satisfied` under a claim-tier policy,
   * never `verified`, and a require-verified policy fails closed. Wiring real
   * verification means implementing this to fetch the durable scan artifact and
   * confirm it is authentic and covers this subject.
   */
  verifyEvidence?: (input: {
    evidenceRef: string;
    subjectDigest: string;
    principal: string;
    tool: { name: string; version: string };
  }) => boolean;
}): SecurityAttestationOutcome {
  const policy = input.policy ?? DEFAULT_SECURITY_ATTESTATION_POLICY;
  const requiredTier = policy.requiredTier;
  const policySource = policy.source;
  const nowMs = Date.parse(input.now ?? new Date().toISOString());
  const downgradeSuffix = policy.downgradeApplied
    ? " — accepted under operator override (unverified tier permitted; recorded as a downgrade)"
    : "";

  const base = {
    present: true as const,
    requiredTier,
    policySource,
  };

  if (input.attestation !== undefined) {
    const attestation = input.attestation;
    if (!isWellFormed(attestation)) {
      return {
        ...base,
        tier: "none",
        verified: false,
        satisfied: false,
        unattributed: false,
        downgradeApplied: false,
        code: "malformed",
        detail: "attestation malformed — rejected",
      };
    }
    const subjectDigest = attestation.subject.digest;
    const attestedAt = attestation.attestedAt;
    const principal = attestation.principal;
    const expiresAt = attestation.expiresAt;
    const scannerFields =
      attestation.tier === "scanner"
        ? {
            tool: (attestation as SecurityScanResult).tool,
            evidenceRef: (attestation as SecurityScanResult).evidenceRef,
          }
        : {};
    const common = {
      ...base,
      principal,
      attestedAt,
      subjectDigest,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...scannerFields,
    };

    // Subject binding — kills replay. Without a computable subject the binding
    // cannot be confirmed, so fail closed rather than trust an unbound claim.
    if (input.expectedSubjectDigest === undefined) {
      return {
        ...common,
        tier: "none",
        verified: false,
        satisfied: false,
        unattributed: false,
        downgradeApplied: false,
        code: "subject_unverifiable",
        detail:
          "change subject unavailable to confirm attestation binding — rejected",
      };
    }
    if (subjectDigest !== input.expectedSubjectDigest) {
      return {
        ...common,
        tier: "none",
        verified: false,
        satisfied: false,
        unattributed: false,
        downgradeApplied: false,
        code: "subject_mismatch",
        detail:
          "attestation subject does not match the change being gated — rejected (possible replay)",
      };
    }

    // Expiry — enforced only when present.
    if (expiresAt !== undefined && Date.parse(expiresAt) <= nowMs) {
      return {
        ...common,
        tier: "none",
        verified: false,
        satisfied: false,
        unattributed: false,
        downgradeApplied: false,
        code: "expired",
        detail: `attestation expired at ${expiresAt} — rejected`,
      };
    }

    const tier = attestation.tier;
    // `verified` must reflect something the platform checked, never the caller's
    // `tier` label alone. A scanner result is verified ONLY when it is bound to
    // the authenticated principal AND the platform dereferences its evidenceRef
    // and confirms the durable evidence. With neither wired (today), `verified`
    // is always false — so no request body alone can produce a verified gate.
    let verified = false;
    if (
      tier === "scanner" &&
      input.expectedPrincipal !== undefined &&
      principal === input.expectedPrincipal &&
      input.verifyEvidence !== undefined
    ) {
      try {
        verified =
          input.verifyEvidence({
            evidenceRef: (scannerFields as { evidenceRef: string }).evidenceRef,
            subjectDigest,
            principal,
            tool: (scannerFields as { tool: { name: string; version: string } }).tool,
          }) === true;
      } catch {
        // Evidence authority failure is not proof. Treat the result as
        // unverified so require-verified deployments block without converting a
        // transient evidence-store failure into a request crash.
        verified = false;
      }
    }

    // Policy — a require-verified deployment (customer profile / require-verified
    // flag) is satisfied ONLY by a platform-verified scanner result. A claim
    // tier, or a scanner tier the platform did not independently verify, fails
    // closed: a caller-supplied string can never satisfy require-verified.
    if (requiredTier === "scanner" && !verified) {
      return {
        ...common,
        tier,
        verified: false,
        satisfied: false,
        unattributed: false,
        downgradeApplied: false,
        code: "policy_insufficient",
        detail:
          tier === "scanner"
            ? `policy requires a verified scanner result; supplied scanner attestation was not independently verified by this pipeline — rejected`
            : `policy requires a verified scanner result; supplied tier '${tier}' is insufficient — rejected`,
      };
    }

    if (tier === "scanner") {
      const { tool, evidenceRef } = scannerFields as {
        tool: { name: string; version: string };
        evidenceRef: string;
      };
      const downgradeApplied = policy.downgradeApplied && !verified;
      return {
        ...common,
        tier,
        verified,
        satisfied: true,
        unattributed: false,
        downgradeApplied,
        code: "valid_scanner",
        detail: verified
          ? `verified by ${tool.name}@${tool.version} for change ${subjectDigest.slice(0, 12)} (evidence ${evidenceRef}), attested by ${principal} at ${attestedAt}`
          : `scanner result asserted by ${principal} at ${attestedAt} for change ${subjectDigest.slice(0, 12)} (evidence ${evidenceRef}) — NOT independently verified by this pipeline${downgradeSuffix}`,
      };
    }
    return {
      ...common,
      tier,
      verified,
      satisfied: true,
      unattributed: false,
      downgradeApplied: policy.downgradeApplied,
      code: "valid_claim",
      detail: `caller claim by ${principal} at ${attestedAt} for change ${subjectDigest.slice(0, 12)} — NOT independently verified${downgradeSuffix}`,
    };
  }

  // Legacy bare-boolean path. Degrades to the weakest tier, attributed to
  // nobody, and preserves the exact historical gate detail so an old-style
  // caller's output is byte-identical when the policy is off.
  if (input.legacyAttested === true) {
    if (TIER_RANK.claim < TIER_RANK[requiredTier]) {
      return {
        ...base,
        tier: "claim",
        verified: false,
        satisfied: false,
        unattributed: true,
        downgradeApplied: false,
        code: "policy_insufficient",
        detail:
          "policy requires a verified scanner result; supplied tier 'claim' is insufficient — rejected",
      };
    }
    return {
      ...base,
      tier: "claim",
      verified: false,
      satisfied: true,
      unattributed: true,
      downgradeApplied: policy.downgradeApplied,
      code: "legacy_claim",
      detail: `attested by caller — NOT independently verified (no security scanner runs in this pipeline)${downgradeSuffix}`,
    };
  }

  return {
    present: false,
    tier: "none",
    verified: false,
    satisfied: false,
    unattributed: false,
    downgradeApplied: false,
    code: "none",
    detail: "no security-scan attestation supplied",
    requiredTier,
    policySource,
  };
}
