export type ProductTargetRelease =
  | "warden-pilot"
  | "warden-ga"
  | "transformer-pilot"
  | "transformer-ga"
  | "enterprise";

export type ProductAvailability =
  | "planned"
  | "internal"
  | "experimental"
  | "pilot"
  | "ga";

export type ProductImplementationStatus =
  | "unimplemented"
  | "scaffold"
  | "partial"
  | "verified"
  | "blocked_external"
  | "retired";

export type ProductClaimState =
  | "public_current"
  | "public_limited"
  | "experimental_only"
  | "internal_only"
  | "roadmap_only"
  | "no_claim";

export type ProductEvidenceType =
  | "unit"
  | "integration"
  | "e2e"
  | "live"
  | "benchmark"
  | "security"
  | "code"
  | "document"
  | "external"
  | "planned";

export interface ProductEvidence {
  id: string;
  type: ProductEvidenceType;
  locator: string;
}

export interface ProductAcceptance {
  id: string;
  assertion: string;
  evidence: ProductEvidence[];
}

export interface ProductRequirement {
  id: string;
  closureGapId: string;
  title: string;
  owner: string;
  targetRelease: ProductTargetRelease;
  availability: ProductAvailability;
  implementationStatus: ProductImplementationStatus;
  claimState: ProductClaimState;
  closureWorkstream: string;
  acceptance: ProductAcceptance[];
  externalBlockers: string[];
}

export interface ProductRequirementManifest {
  schemaVersion: number;
  spec: {
    path: string;
    version: string;
    sha256: string;
  };
  closurePlan: {
    source: string;
    auditedRevision: string;
    requirementCount: number;
  };
  closureWorkstreams: Array<{ id: string; title: string }>;
  requirements: ProductRequirement[];
}

export interface ProductRequirementIssue {
  code: string;
  subject: string;
  message: string;
}

export interface ProductRequirementValidationOptions {
  expectedIds?: readonly string[];
}

const DOMAIN_COUNTS = {
  FND: 10,
  ING: 9,
  SCM: 6,
  GRF: 8,
  WAR: 10,
  TRN: 13,
  RTR: 9,
  ENT: 12,
  COM: 4,
  GTM: 3,
} as const;

export const FOUNDATIONAL_REQUIREMENT_IDS = Object.entries(DOMAIN_COUNTS)
  .flatMap(([domain, count]) =>
    Array.from(
      { length: count },
      (_, index) => `ME-${domain}-${String(index + 1).padStart(3, "0")}`,
    ),
  )
  .sort();

const REQUIREMENT_ID = /^ME-(FND|ING|SCM|GRF|WAR|TRN|RTR|ENT|COM|GTM)-[0-9]{3}$/;
const GAP_ID = /^(SPEC|ING|SCM|GRF|WRD|TRN|RTR|ENT|COM|GTM)-[0-9]{2}$/;
const WORKSTREAM_ID = /^FC-(0[0-9]|10)$/;
const SHA256 = /^[a-f0-9]{64}$/;

const TARGET_RELEASES = new Set<ProductTargetRelease>([
  "warden-pilot",
  "warden-ga",
  "transformer-pilot",
  "transformer-ga",
  "enterprise",
]);
const AVAILABILITIES = new Set<ProductAvailability>([
  "planned",
  "internal",
  "experimental",
  "pilot",
  "ga",
]);
const IMPLEMENTATION_STATUSES = new Set<ProductImplementationStatus>([
  "unimplemented",
  "scaffold",
  "partial",
  "verified",
  "blocked_external",
  "retired",
]);
const CLAIM_STATES = new Set<ProductClaimState>([
  "public_current",
  "public_limited",
  "experimental_only",
  "internal_only",
  "roadmap_only",
  "no_claim",
]);
const EVIDENCE_TYPES = new Set<ProductEvidenceType>([
  "unit",
  "integration",
  "e2e",
  "live",
  "benchmark",
  "security",
  "code",
  "document",
  "external",
  "planned",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: ProductRequirementIssue[],
  code: string,
  subject: string,
  message: string,
) {
  issues.push({ code, subject, message });
}

export function validateProductRequirements(
  input: unknown,
  options: ProductRequirementValidationOptions = {},
): ProductRequirementIssue[] {
  const issues: ProductRequirementIssue[] = [];
  if (!isRecord(input)) {
    return [{ code: "MANIFEST_TYPE", subject: "manifest", message: "must be an object" }];
  }

  if (input.schemaVersion !== 1) {
    addIssue(issues, "SCHEMA_VERSION", "manifest", "schemaVersion must equal 1");
  }
  if (!isRecord(input.spec)) {
    addIssue(issues, "SPEC_RECORD", "manifest", "spec must be an object");
  } else {
    if (typeof input.spec.path !== "string" || input.spec.path.length === 0) {
      addIssue(issues, "SPEC_PATH", "manifest", "spec.path is required");
    }
    if (typeof input.spec.version !== "string" || input.spec.version.length === 0) {
      addIssue(issues, "SPEC_VERSION", "manifest", "spec.version is required");
    }
    if (typeof input.spec.sha256 !== "string" || !SHA256.test(input.spec.sha256)) {
      addIssue(issues, "SPEC_HASH", "manifest", "spec.sha256 must be a lowercase SHA-256 digest");
    }
  }

  const workstreamIds = new Set<string>();
  if (!Array.isArray(input.closureWorkstreams)) {
    addIssue(issues, "WORKSTREAMS_TYPE", "manifest", "closureWorkstreams must be an array");
  } else {
    for (const item of input.closureWorkstreams) {
      if (!isRecord(item) || typeof item.id !== "string" || !WORKSTREAM_ID.test(item.id)) {
        addIssue(issues, "WORKSTREAM_ID", "manifest", "every workstream needs a valid FC-00 to FC-10 ID");
        continue;
      }
      if (workstreamIds.has(item.id)) {
        addIssue(issues, "WORKSTREAM_DUPLICATE", item.id, "workstream ID is duplicated");
      }
      workstreamIds.add(item.id);
      if (typeof item.title !== "string" || item.title.trim().length === 0) {
        addIssue(issues, "WORKSTREAM_TITLE", item.id, "workstream title is required");
      }
    }
  }

  if (!Array.isArray(input.requirements)) {
    addIssue(issues, "REQUIREMENTS_TYPE", "manifest", "requirements must be an array");
    return issues.sort(compareIssues);
  }

  const expectedIds = [...(options.expectedIds ?? FOUNDATIONAL_REQUIREMENT_IDS)].sort();
  const requirementIds = new Set<string>();
  const acceptanceIds = new Set<string>();
  const evidenceIds = new Set<string>();

  for (const raw of input.requirements) {
    if (!isRecord(raw)) {
      addIssue(issues, "REQUIREMENT_TYPE", "manifest", "each requirement must be an object");
      continue;
    }
    const id = typeof raw.id === "string" ? raw.id : "unknown";
    if (!REQUIREMENT_ID.test(id)) {
      addIssue(issues, "REQUIREMENT_ID", id, "requirement ID is invalid");
    }
    if (requirementIds.has(id)) {
      addIssue(issues, "REQUIREMENT_DUPLICATE", id, "requirement ID is duplicated");
    }
    requirementIds.add(id);

    if (typeof raw.closureGapId !== "string" || !GAP_ID.test(raw.closureGapId)) {
      addIssue(issues, "GAP_ID", id, "closureGapId is invalid");
    }
    for (const [field, value] of [
      ["title", raw.title],
      ["owner", raw.owner],
    ] as const) {
      if (typeof value !== "string" || value.trim().length === 0) {
        addIssue(issues, `REQUIREMENT_${field.toUpperCase()}`, id, `${field} is required`);
      }
    }
    if (!TARGET_RELEASES.has(raw.targetRelease as ProductTargetRelease)) {
      addIssue(issues, "TARGET_RELEASE", id, "targetRelease is invalid");
    }
    if (!AVAILABILITIES.has(raw.availability as ProductAvailability)) {
      addIssue(issues, "AVAILABILITY", id, "availability is invalid");
    }
    if (!IMPLEMENTATION_STATUSES.has(raw.implementationStatus as ProductImplementationStatus)) {
      addIssue(issues, "IMPLEMENTATION_STATUS", id, "implementationStatus is invalid");
    }
    if (!CLAIM_STATES.has(raw.claimState as ProductClaimState)) {
      addIssue(issues, "CLAIM_STATE", id, "claimState is invalid");
    }
    if (typeof raw.closureWorkstream !== "string" || !workstreamIds.has(raw.closureWorkstream)) {
      addIssue(issues, "WORKSTREAM_REFERENCE", id, "closureWorkstream does not exist");
    }

    const blockers = Array.isArray(raw.externalBlockers)
      ? raw.externalBlockers.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
    if (raw.implementationStatus === "blocked_external" && blockers.length === 0) {
      addIssue(issues, "EXTERNAL_BLOCKER", id, "blocked_external requires a named blocker");
    }
    if (raw.availability === "ga" && raw.implementationStatus !== "verified") {
      addIssue(issues, "GA_STATUS", id, "GA requirements must be verified");
    }
    if (raw.availability === "ga" && blockers.length > 0) {
      addIssue(issues, "GA_BLOCKER", id, "GA requirements cannot have external blockers");
    }
    if (
      (raw.availability === "planned" || raw.availability === "internal") &&
      (raw.claimState === "public_current" || raw.claimState === "public_limited")
    ) {
      addIssue(issues, "CLAIM_EXCEEDS_AVAILABILITY", id, "current public claims require pilot or GA availability");
    }

    if (!Array.isArray(raw.acceptance) || raw.acceptance.length === 0) {
      addIssue(issues, "ACCEPTANCE_REQUIRED", id, "at least one acceptance criterion is required");
      continue;
    }
    for (const criterion of raw.acceptance) {
      if (!isRecord(criterion)) {
        addIssue(issues, "ACCEPTANCE_TYPE", id, "acceptance criterion must be an object");
        continue;
      }
      const acceptanceId = typeof criterion.id === "string" ? criterion.id : "unknown";
      if (!new RegExp(`^${id}-AC[0-9]{2}$`).test(acceptanceId)) {
        addIssue(issues, "ACCEPTANCE_ID", id, "acceptance ID must belong to its requirement");
      }
      if (acceptanceIds.has(acceptanceId)) {
        addIssue(issues, "ACCEPTANCE_DUPLICATE", acceptanceId, "acceptance ID is duplicated");
      }
      acceptanceIds.add(acceptanceId);
      if (typeof criterion.assertion !== "string" || criterion.assertion.trim().length === 0) {
        addIssue(issues, "ACCEPTANCE_ASSERTION", acceptanceId, "acceptance assertion is required");
      }
      if (!Array.isArray(criterion.evidence) || criterion.evidence.length === 0) {
        addIssue(issues, "EVIDENCE_REQUIRED", acceptanceId, "at least one evidence record is required");
        continue;
      }
      for (const evidence of criterion.evidence) {
        if (!isRecord(evidence)) {
          addIssue(issues, "EVIDENCE_TYPE", acceptanceId, "evidence must be an object");
          continue;
        }
        const evidenceId = typeof evidence.id === "string" ? evidence.id : "unknown";
        if (!new RegExp(`^${acceptanceId}-EV[0-9]{2}$`).test(evidenceId)) {
          addIssue(issues, "EVIDENCE_ID", acceptanceId, "evidence ID must belong to its acceptance criterion");
        }
        if (evidenceIds.has(evidenceId)) {
          addIssue(issues, "EVIDENCE_DUPLICATE", evidenceId, "evidence ID is duplicated");
        }
        evidenceIds.add(evidenceId);
        if (!EVIDENCE_TYPES.has(evidence.type as ProductEvidenceType)) {
          addIssue(issues, "EVIDENCE_KIND", evidenceId, "evidence type is invalid");
        }
        if (typeof evidence.locator !== "string" || evidence.locator.trim().length === 0) {
          addIssue(issues, "EVIDENCE_LOCATOR", evidenceId, "evidence locator is required");
        }
        if (raw.availability === "ga" && ["document", "code", "planned", "external"].includes(String(evidence.type))) {
          addIssue(issues, "GA_EVIDENCE", evidenceId, "GA acceptance needs automated or live evidence");
        }
      }
    }
  }

  const actualIds = [...requirementIds].sort();
  for (const workstreamId of workstreamIds) {
    const ownsRequirement = input.requirements.some(
      (requirement) => isRecord(requirement) && requirement.closureWorkstream === workstreamId,
    );
    if (!ownsRequirement) {
      addIssue(
        issues,
        "WORKSTREAM_EMPTY",
        workstreamId,
        "declared workstream must own at least one requirement",
      );
    }
  }
  for (const missing of expectedIds.filter((id) => !requirementIds.has(id))) {
    addIssue(issues, "REQUIREMENT_MISSING", missing, "foundational requirement is missing");
  }
  for (const unexpected of actualIds.filter((id) => !expectedIds.includes(id))) {
    addIssue(issues, "REQUIREMENT_UNEXPECTED", unexpected, "requirement is not in the foundational register");
  }

  if (isRecord(input.closurePlan) && input.closurePlan.requirementCount !== expectedIds.length) {
    addIssue(issues, "REQUIREMENT_COUNT", "manifest", `closure plan count must equal ${expectedIds.length}`);
  }

  return issues.sort(compareIssues);
}

function compareIssues(left: ProductRequirementIssue, right: ProductRequirementIssue) {
  return (
    left.code.localeCompare(right.code) ||
    left.subject.localeCompare(right.subject) ||
    left.message.localeCompare(right.message)
  );
}
