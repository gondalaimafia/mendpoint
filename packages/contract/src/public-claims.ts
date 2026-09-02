import type {
  ProductRequirement,
} from "./product-requirements.js";

export type PublicClaimState =
  | "proven"
  | "limited_availability"
  | "preview"
  | "roadmap"
  | "thesis"
  | "illustrative";

export type PublicClaimEvidenceType = "code" | "test" | "live" | "document" | "external";

export type PublicClaimKind = "capability" | "guardrail";

export type PublicWebsiteStatus = "replacement_candidate" | "published";

interface PublicClaimEvidenceBase {
  id: string;
  type: PublicClaimEvidenceType;
  locator: string;
}

export interface PublicClaimLiveEvidence extends PublicClaimEvidenceBase {
  type: "live";
  observedAt: string;
  freshUntil: string;
  revision: string;
}

export interface PublicClaimNonLiveEvidence extends PublicClaimEvidenceBase {
  type: Exclude<PublicClaimEvidenceType, "live">;
}

export type PublicClaimEvidence =
  | PublicClaimLiveEvidence
  | PublicClaimNonLiveEvidence;

export type PublicClaimRequirement = Pick<
  ProductRequirement,
  "id" | "implementationStatus" | "claimState"
>;

export interface PublicClaim {
  id: string;
  claimKind: PublicClaimKind;
  requirementIds: string[];
  surfaces: string[];
  surfacePaths: string[];
  wording: string;
  owner: string;
  evidenceOwner: string;
  state: PublicClaimState;
  scope: string;
  evidence: PublicClaimEvidence[];
  limitations: string[];
  requiredQualifier: string | null;
  lastVerifiedAt: string;
  expiresAt: string | null;
}

export interface PublicDestination {
  id: string;
  label: string;
  href: string;
  purpose: string;
  claimId: string;
}

export interface PublicClaimRegistry {
  schemaVersion: number;
  website: string;
  websiteStatus: PublicWebsiteStatus;
  auditedRevision: string;
  claims: PublicClaim[];
  destinations: PublicDestination[];
}

export interface PublicClaimIssue {
  code: string;
  subject: string;
  message: string;
}

export interface PublicClaimValidationOptions {
  requirements: readonly PublicClaimRequirement[];
  asOf?: Date;
}

/**
 * Result of comparing the registry's auditedRevision against the revision being
 * shipped. The caller (which has Git access) performs the comparison and hands
 * the outcome to {@link detectStaleClaims}. Keeping this a plain value keeps the
 * staleness rule pure and testable without a working tree.
 *
 * `indeterminate` is a fail-closed signal: a shallow clone, a missing object, a
 * non-ancestor auditedRevision, or "not a Git work tree" all land here so the
 * gate reports a could-not-determine failure rather than silently passing.
 */
export type ClaimStalenessComparison =
  | {
      readonly status: "comparable";
      readonly headRevision: string;
      readonly changedPaths: readonly string[];
    }
  | { readonly status: "indeterminate"; readonly reason: string };

const CLAIM_ID = /^CLM-[0-9]{3}$/;
const EVIDENCE_ID = /^CLM-[0-9]{3}-EV[0-9]{2}$/;
const DESTINATION_ID = /^DST-[0-9]{3}$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ISO_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const REVISION = /^[a-f0-9]{40}$/;
const REQUIREMENT_ID = /^ME-(FND|ING|SCM|GRF|WAR|TRN|RTR|ENT|COM|GTM)-[0-9]{3}$/;
const CLAIM_KINDS = new Set<PublicClaimKind>(["capability", "guardrail"]);
const WEBSITE_STATUSES = new Set<PublicWebsiteStatus>([
  "replacement_candidate",
  "published",
]);
const STATES = new Set<PublicClaimState>([
  "proven",
  "limited_availability",
  "preview",
  "roadmap",
  "thesis",
  "illustrative",
]);
const EVIDENCE_TYPES = new Set<PublicClaimEvidenceType>([
  "code",
  "test",
  "live",
  "document",
  "external",
]);
const DISALLOWED_ABSOLUTES = [
  /\bevery\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\bunlimited\b/i,
  /\bfull blast radius\b/i,
  /\bno guessing\b/i,
  /\bin minutes\b/i,
  /\bno data leaves\b/i,
];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function add(
  issues: PublicClaimIssue[],
  code: string,
  subject: string,
  message: string,
) {
  issues.push({ code, subject, message });
}

export function validatePublicClaimRegistry(
  input: unknown,
  options: PublicClaimValidationOptions,
): PublicClaimIssue[] {
  const issues: PublicClaimIssue[] = [];
  if (!record(input)) {
    return [{ code: "REGISTRY_TYPE", subject: "registry", message: "must be an object" }];
  }
  if (input.schemaVersion !== 2) {
    add(issues, "SCHEMA_VERSION", "registry", "schemaVersion must equal 2");
  }
  if (!nonempty(input.website) || !input.website.startsWith("https://")) {
    add(issues, "WEBSITE", "registry", "website must be an HTTPS URL");
  }
  if (!WEBSITE_STATUSES.has(input.websiteStatus as PublicWebsiteStatus)) {
    add(
      issues,
      "WEBSITE_STATUS",
      "registry",
      "websiteStatus must be replacement_candidate or published",
    );
  }
  if (!nonempty(input.auditedRevision) || !REVISION.test(input.auditedRevision)) {
    add(issues, "AUDITED_REVISION", "registry", "auditedRevision must be a full lowercase Git revision");
  }

  const requirementById = new Map(
    options.requirements.map((requirement) => [requirement.id, requirement] as const),
  );
  const asOf = options.asOf ?? new Date();
  const asOfMs = asOf.getTime();
  if (!Number.isFinite(asOfMs)) {
    add(issues, "AS_OF", "registry", "validation time must be valid");
  }

  const claimIds = new Set<string>();
  const liveObservations: { id: string; locator: string; observedAt: string }[] = [];
  if (!Array.isArray(input.claims) || input.claims.length === 0) {
    add(issues, "CLAIMS_REQUIRED", "registry", "at least one public claim is required");
  } else {
    for (const rawClaim of input.claims) {
      if (!record(rawClaim)) {
        add(issues, "CLAIM_TYPE", "registry", "claim must be an object");
        continue;
      }
      const id = nonempty(rawClaim.id) ? rawClaim.id : "unknown";
      if (!CLAIM_ID.test(id)) add(issues, "CLAIM_ID", id, "claim ID is invalid");
      if (claimIds.has(id)) add(issues, "CLAIM_DUPLICATE", id, "claim ID is duplicated");
      claimIds.add(id);

      if (!CLAIM_KINDS.has(rawClaim.claimKind as PublicClaimKind)) {
        add(issues, "CLAIM_KIND", id, "claimKind must be capability or guardrail");
      }

      const requirementIds = new Set<string>();
      if (!Array.isArray(rawClaim.requirementIds) || rawClaim.requirementIds.length === 0) {
        add(issues, "REQUIREMENT_IDS_REQUIRED", id, "at least one requirement ID is required");
      } else {
        for (const rawRequirementId of rawClaim.requirementIds) {
          if (!nonempty(rawRequirementId) || !REQUIREMENT_ID.test(rawRequirementId)) {
            add(issues, "REQUIREMENT_ID", id, "requirement IDs must use the foundational ID format");
            continue;
          }
          if (requirementIds.has(rawRequirementId)) {
            add(issues, "REQUIREMENT_ID_DUPLICATE", id, `${rawRequirementId} is duplicated`);
            continue;
          }
          requirementIds.add(rawRequirementId);
          const requirement = requirementById.get(rawRequirementId);
          if (!requirement) {
            add(issues, "REQUIREMENT_REFERENCE", id, `${rawRequirementId} is not registered`);
            continue;
          }
          if (rawClaim.state === "proven") {
            if (requirement.implementationStatus !== "verified") {
              add(
                issues,
                "PROVEN_CAPABILITY_REQUIREMENT_INCOMPLETE",
                id,
                `${rawRequirementId} is ${requirement.implementationStatus}`,
              );
            }
            if (requirement.claimState !== "public_current") {
              add(
                issues,
                "PROVEN_CAPABILITY_REQUIREMENT_NON_PUBLIC",
                id,
                `${rawRequirementId} is ${requirement.claimState}`,
              );
            }
          }
        }
      }

      if (!Array.isArray(rawClaim.surfaces) || rawClaim.surfaces.length === 0) {
        add(issues, "SURFACES_REQUIRED", id, "at least one public surface is required");
      } else if (rawClaim.surfaces.some((surface) => !nonempty(surface))) {
        add(issues, "SURFACE", id, "public surfaces must be nonempty strings");
      }
      if (!Array.isArray(rawClaim.surfacePaths) || rawClaim.surfacePaths.length === 0) {
        add(issues, "SURFACE_PATHS_REQUIRED", id, "at least one public surface path is required");
      } else if (rawClaim.surfacePaths.some((surface) => !nonempty(surface))) {
        add(issues, "SURFACE_PATH", id, "public surface paths must be nonempty strings");
      }
      for (const field of ["wording", "owner", "evidenceOwner", "scope"] as const) {
        if (!nonempty(rawClaim[field])) add(issues, `CLAIM_${field.toUpperCase()}`, id, `${field} is required`);
      }
      if (!STATES.has(rawClaim.state as PublicClaimState)) {
        add(issues, "CLAIM_STATE", id, "claim state is invalid");
      }
      if (nonempty(rawClaim.wording)) {
        for (const absolute of DISALLOWED_ABSOLUTES) {
          if (absolute.test(rawClaim.wording)) {
            add(issues, "UNSUPPORTED_ABSOLUTE", id, `wording contains ${absolute.source}`);
          }
        }
      }
      if (!Array.isArray(rawClaim.limitations)) {
        add(issues, "LIMITATIONS", id, "limitations must be an array");
      } else if (rawClaim.limitations.some((item) => !nonempty(item))) {
        add(issues, "LIMITATION", id, "limitations must be nonempty strings");
      }
      if (!nonempty(rawClaim.lastVerifiedAt) || !ISO_DATE.test(rawClaim.lastVerifiedAt)) {
        add(issues, "VERIFIED_DATE", id, "lastVerifiedAt must be an ISO date");
      }
      if (rawClaim.expiresAt !== null && (!nonempty(rawClaim.expiresAt) || !ISO_DATE.test(rawClaim.expiresAt))) {
        add(issues, "EXPIRY_DATE", id, "expiresAt must be null or an ISO date");
      }

      const qualified = rawClaim.state === "limited_availability" || rawClaim.state === "preview";
      if (qualified) {
        if (!nonempty(rawClaim.requiredQualifier)) {
          add(issues, "QUALIFIER_REQUIRED", id, "limited and preview claims require a qualifier");
        } else if (
          nonempty(rawClaim.wording) &&
          !rawClaim.wording.toLowerCase().includes(rawClaim.requiredQualifier.toLowerCase())
        ) {
          add(issues, "QUALIFIER_MISSING", id, "wording must contain the required qualifier");
        }
      } else if (rawClaim.requiredQualifier !== null) {
        add(issues, "QUALIFIER_UNEXPECTED", id, "this claim state does not accept a required qualifier");
      }
      if (rawClaim.state === "roadmap" && nonempty(rawClaim.wording) && !/roadmap|planned/i.test(rawClaim.wording)) {
        add(issues, "ROADMAP_LABEL", id, "roadmap wording must say roadmap or planned");
      }

      if (!Array.isArray(rawClaim.evidence) || rawClaim.evidence.length === 0) {
        add(issues, "EVIDENCE_REQUIRED", id, "at least one evidence record is required");
      } else {
        const evidenceIds = new Set<string>();
        for (const rawEvidence of rawClaim.evidence) {
          if (!record(rawEvidence)) {
            add(issues, "EVIDENCE_TYPE", id, "evidence must be an object");
            continue;
          }
          const evidenceId = nonempty(rawEvidence.id) ? rawEvidence.id : "unknown";
          if (!EVIDENCE_ID.test(evidenceId) || !evidenceId.startsWith(`${id}-`)) {
            add(issues, "EVIDENCE_ID", id, "evidence ID must belong to its claim");
          }
          if (evidenceIds.has(evidenceId)) {
            add(issues, "EVIDENCE_DUPLICATE", evidenceId, "evidence ID is duplicated");
          }
          evidenceIds.add(evidenceId);
          if (!EVIDENCE_TYPES.has(rawEvidence.type as PublicClaimEvidenceType)) {
            add(issues, "EVIDENCE_KIND", evidenceId, "evidence type is invalid");
          }
          if (!nonempty(rawEvidence.locator)) {
            add(issues, "EVIDENCE_LOCATOR", evidenceId, "evidence locator is required");
          }
          if (rawEvidence.type === "live") {
            const observedAtMs = liveTimestamp(
              rawEvidence.observedAt,
              issues,
              "LIVE_EVIDENCE_OBSERVED_AT",
              evidenceId,
              "observedAt",
            );
            const freshUntilMs = liveTimestamp(
              rawEvidence.freshUntil,
              issues,
              "LIVE_EVIDENCE_FRESH_UNTIL",
              evidenceId,
              "freshUntil",
            );
            if (!nonempty(rawEvidence.revision) || !REVISION.test(rawEvidence.revision)) {
              add(
                issues,
                "LIVE_EVIDENCE_REVISION",
                evidenceId,
                "live evidence revision must be a full lowercase Git revision",
              );
            } else if (
              nonempty(input.auditedRevision) &&
              rawEvidence.revision !== input.auditedRevision
            ) {
              add(
                issues,
                "LIVE_EVIDENCE_REVISION_MISMATCH",
                evidenceId,
                "live evidence revision must equal the registry auditedRevision",
              );
            }
            if (observedAtMs !== undefined && Number.isFinite(asOfMs) && observedAtMs > asOfMs) {
              add(issues, "LIVE_EVIDENCE_FUTURE", evidenceId, "live evidence cannot be observed in the future");
            }
            if (
              freshUntilMs !== undefined &&
              observedAtMs !== undefined &&
              freshUntilMs <= observedAtMs
            ) {
              add(
                issues,
                "LIVE_EVIDENCE_FRESHNESS_WINDOW",
                evidenceId,
                "freshUntil must be later than observedAt",
              );
            }
            if (freshUntilMs !== undefined && Number.isFinite(asOfMs) && freshUntilMs <= asOfMs) {
              add(issues, "LIVE_EVIDENCE_STALE", evidenceId, "live evidence freshness window has expired");
            }
            if (nonempty(rawEvidence.observedAt) && ISO_TIMESTAMP.test(rawEvidence.observedAt)) {
              liveObservations.push({
                id: evidenceId,
                locator: nonempty(rawEvidence.locator) ? rawEvidence.locator : "",
                observedAt: rawEvidence.observedAt,
              });
            }
          }
        }
      }
    }
  }

  // Batch-stamp guard. A genuine probe run reads the clock once and records
  // millisecond precision (…T00:01:45.565Z); a hand-entered batch collapses to
  // whole-second precision (…T23:59:11.000Z) and is copied across endpoints. We
  // flag only second-resolution observedAt values that repeat across different
  // locators, so a real probe run that stamps several endpoints at one
  // sub-second instant still passes while a copied second-resolution stamp
  // cannot stand as several independent observations.
  const secondResolutionByObservedAt = new Map<string, { id: string; locator: string }[]>();
  for (const observation of liveObservations) {
    if (!observation.observedAt.endsWith(".000Z")) continue;
    const bucket = secondResolutionByObservedAt.get(observation.observedAt) ?? [];
    bucket.push({ id: observation.id, locator: observation.locator });
    secondResolutionByObservedAt.set(observation.observedAt, bucket);
  }
  for (const [observedAt, bucket] of secondResolutionByObservedAt) {
    if (bucket.length < 2 || new Set(bucket.map((entry) => entry.locator)).size < 2) continue;
    const collidingIds = bucket.map((entry) => entry.id).sort();
    for (const entry of bucket) {
      add(
        issues,
        "LIVE_EVIDENCE_BATCH_STAMP",
        entry.id,
        `second-resolution observedAt ${observedAt} is shared across ${collidingIds.join(", ")}; a single batch stamp cannot stand as independent live observations`,
      );
    }
  }

  const destinationIds = new Set<string>();
  if (!Array.isArray(input.destinations) || input.destinations.length === 0) {
    add(issues, "DESTINATIONS_REQUIRED", "registry", "at least one destination is required");
  } else {
    for (const rawDestination of input.destinations) {
      if (!record(rawDestination)) {
        add(issues, "DESTINATION_TYPE", "registry", "destination must be an object");
        continue;
      }
      const id = nonempty(rawDestination.id) ? rawDestination.id : "unknown";
      if (!DESTINATION_ID.test(id)) add(issues, "DESTINATION_ID", id, "destination ID is invalid");
      if (destinationIds.has(id)) add(issues, "DESTINATION_DUPLICATE", id, "destination ID is duplicated");
      destinationIds.add(id);
      for (const field of ["label", "purpose"] as const) {
        if (!nonempty(rawDestination[field])) {
          add(issues, `DESTINATION_${field.toUpperCase()}`, id, `${field} is required`);
        }
      }
      if (
        !nonempty(rawDestination.href) ||
        rawDestination.href === "#" ||
        !(rawDestination.href.startsWith("/") || rawDestination.href.startsWith("https://") || rawDestination.href.startsWith("mailto:"))
      ) {
        add(issues, "DESTINATION_HREF", id, "destination must use an internal, HTTPS, or email URL");
      }
      if (!nonempty(rawDestination.claimId) || !claimIds.has(rawDestination.claimId)) {
        add(issues, "DESTINATION_CLAIM", id, "destination must reference an existing claim");
      }
    }
  }

  return issues.sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      left.subject.localeCompare(right.subject) ||
      left.message.localeCompare(right.message),
  );
}

function liveTimestamp(
  value: unknown,
  issues: PublicClaimIssue[],
  code: string,
  subject: string,
  field: string,
): number | undefined {
  if (!nonempty(value) || !ISO_TIMESTAMP.test(value)) {
    add(issues, code, subject, `${field} must be an ISO timestamp`);
    return undefined;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    add(issues, code, subject, `${field} must be a valid ISO timestamp`);
    return undefined;
  }
  return parsed;
}

/**
 * Detects claims whose audit is stale relative to the code being shipped.
 *
 * A claim is stale when any of its own `surfacePaths` changed between the
 * registry's `auditedRevision` and `HEAD`. Scoping to surfacePaths (rather than
 * requiring `auditedRevision === HEAD`) keeps the check precise and
 * self-limiting: editing one surface invalidates only the claims that describe
 * it, and a claim whose surfaces are untouched stays valid however old the audit
 * is.
 *
 * The check fails closed. When the comparison could not be performed
 * (`indeterminate`) a single registry-level issue is returned rather than an
 * empty (passing) result.
 */
export function detectStaleClaims(
  registry: Pick<PublicClaimRegistry, "auditedRevision" | "claims">,
  comparison: ClaimStalenessComparison,
): PublicClaimIssue[] {
  const issues: PublicClaimIssue[] = [];
  const auditedRevision = nonempty(registry.auditedRevision)
    ? registry.auditedRevision
    : "unknown";

  if (comparison.status === "indeterminate") {
    add(
      issues,
      "CLAIM_STALENESS_INDETERMINATE",
      "registry",
      `cannot compare auditedRevision ${auditedRevision} against HEAD: ${comparison.reason}`,
    );
    return issues;
  }

  const changed = new Set(comparison.changedPaths);
  for (const claim of registry.claims ?? []) {
    const id = nonempty(claim?.id) ? claim.id : "unknown";
    for (const surfacePath of claim?.surfacePaths ?? []) {
      if (nonempty(surfacePath) && changed.has(surfacePath)) {
        add(
          issues,
          "CLAIM_SURFACE_STALE",
          id,
          `surface ${surfacePath} changed between auditedRevision ${auditedRevision} and HEAD ${comparison.headRevision}; re-audit the claim and update auditedRevision`,
        );
      }
    }
  }

  return issues;
}
