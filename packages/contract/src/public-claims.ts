export type PublicClaimState =
  | "proven"
  | "limited_availability"
  | "preview"
  | "roadmap"
  | "thesis"
  | "illustrative";

export type PublicClaimEvidenceType = "code" | "test" | "live" | "document" | "external";

export interface PublicClaimEvidence {
  id: string;
  type: PublicClaimEvidenceType;
  locator: string;
}

export interface PublicClaim {
  id: string;
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
  auditedRevision: string;
  claims: PublicClaim[];
  destinations: PublicDestination[];
}

export interface PublicClaimIssue {
  code: string;
  subject: string;
  message: string;
}

const CLAIM_ID = /^CLM-[0-9]{3}$/;
const EVIDENCE_ID = /^CLM-[0-9]{3}-EV[0-9]{2}$/;
const DESTINATION_ID = /^DST-[0-9]{3}$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
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

export function validatePublicClaimRegistry(input: unknown): PublicClaimIssue[] {
  const issues: PublicClaimIssue[] = [];
  if (!record(input)) {
    return [{ code: "REGISTRY_TYPE", subject: "registry", message: "must be an object" }];
  }
  if (input.schemaVersion !== 1) {
    add(issues, "SCHEMA_VERSION", "registry", "schemaVersion must equal 1");
  }
  if (!nonempty(input.website) || !input.website.startsWith("https://")) {
    add(issues, "WEBSITE", "registry", "website must be an HTTPS URL");
  }
  if (!nonempty(input.auditedRevision)) {
    add(issues, "AUDITED_REVISION", "registry", "auditedRevision is required");
  }

  const claimIds = new Set<string>();
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
        }
      }
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
