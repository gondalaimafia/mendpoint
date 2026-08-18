import { createHash } from "node:crypto";

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
  externalBlockers: string[] | null;
}

export interface ProductClosurePlan {
  source: string;
  auditedRevision: string;
  requirementCount: number;
}

/**
 * A supplemental register set enrolled alongside the foundational requirements.
 * Each set carries its own provenance (`closurePlan.source`/`auditedRevision`)
 * and its own accepted-identifier set, so a reviewer can answer "which audit
 * produced this requirement, at which revision" for any row without conflating
 * it with the foundational audit.
 */
export interface ProductRegisterSet {
  key: string;
  closurePlan: ProductClosurePlan;
  requirements: ProductRequirement[];
}

export interface ProductRequirementManifest {
  schemaVersion: number;
  spec: {
    path: string;
    version: string;
    sha256: string;
  };
  closurePlan: ProductClosurePlan;
  closureWorkstreams: Array<{ id: string; title: string }>;
  requirements: ProductRequirement[];
  additionalRegisterSets?: ProductRegisterSet[];
}

export interface ProductRequirementIssue {
  code: string;
  subject: string;
  message: string;
}

export interface ProductRequirementValidationOptions {
  expectedIds?: readonly string[];
  registerSets?: readonly RegisterSetDefinition[];
}

/**
 * The authoritative definition of one register set: which identifiers it
 * accepts and how their identifier and gap-analysis tokens are shaped. The
 * accepted-identifier set (and therefore the required count) lives in code, not
 * in the manifest, so `closurePlan.requirementCount` remains an integrity check
 * on a provenance claim rather than a value the manifest can assert about
 * itself.
 */
export interface RegisterSetDefinition {
  key: string;
  title: string;
  requirementIdPattern: RegExp;
  gapIdPattern: RegExp;
  expectedIds: readonly string[];
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

/**
 * The v3.0 platform baseline register set: the eight new functional
 * requirements added by the v3.0 specification (FET-015..018, REG-015..018)
 * plus the §28.1.1 Change Graph acceptance criteria (enrolled as ME-CGR-001).
 * These identifiers are non-sequential relative to the foundational set and
 * derive from a different audit, so they are listed explicitly rather than
 * generated from a domain-count table.
 */
export const V3_PLATFORM_REQUIREMENT_IDS = [
  "ME-FET-015",
  "ME-FET-016",
  "ME-FET-017",
  "ME-FET-018",
  "ME-REG-015",
  "ME-REG-016",
  "ME-REG-017",
  "ME-REG-018",
  "ME-CGR-001",
].sort();

const V3_REQUIREMENT_ID = /^ME-(FET|REG|CGR)-[0-9]{3}$/;
const V3_GAP_ID = /^(FET|REG|CGR)-[0-9]{3}$/;

/**
 * The foundational register set. Its accepted identifiers, identifier shape,
 * and gap-analysis token shape are exactly what the register enforced before
 * multi-set validation existed; nothing here changes the foundational contract.
 */
export const FOUNDATIONAL_REGISTER_SET: RegisterSetDefinition = {
  key: "foundational",
  title: "Foundational requirements (2026-08-01 gap analysis)",
  requirementIdPattern: REQUIREMENT_ID,
  gapIdPattern: GAP_ID,
  expectedIds: FOUNDATIONAL_REQUIREMENT_IDS,
};

export const V3_PLATFORM_REGISTER_SET: RegisterSetDefinition = {
  key: "v3-platform",
  title: "v3.0 platform baseline requirements",
  requirementIdPattern: V3_REQUIREMENT_ID,
  gapIdPattern: V3_GAP_ID,
  expectedIds: V3_PLATFORM_REQUIREMENT_IDS,
};

/**
 * The register sets enforced by default. The foundational set is validated
 * against the manifest's top-level `requirements`/`closurePlan`; every other
 * set is validated against a keyed entry in `additionalRegisterSets`.
 */
export const PRODUCT_REGISTER_SETS: readonly RegisterSetDefinition[] = [
  FOUNDATIONAL_REGISTER_SET,
  V3_PLATFORM_REGISTER_SET,
];

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
const IMPLEMENTATION_EVIDENCE_TYPES = new Set<ProductEvidenceType>([
  "unit",
  "integration",
  "e2e",
  "benchmark",
  "security",
  "code",
  "document",
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

function externalEvidenceBlockerNames(locator: string): string[] {
  const value = locator.startsWith("external:")
    ? locator.slice("external:".length)
    : locator;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Shared, cross-set state for one validation pass. Identifier-uniqueness sets
 * are shared across every register set so a requirement, acceptance, or
 * evidence identifier reused between sets still fails closed; the workstream
 * set is shared because workstreams are declared once at the manifest level.
 */
interface RegisterSetContext {
  issues: ProductRequirementIssue[];
  workstreamIds: Set<string>;
  requirementIds: Set<string>;
  acceptanceIds: Set<string>;
  evidenceIds: Set<string>;
}

/**
 * Validate one register set against its own definition. `requirements` and
 * `closurePlan` are the set's rows and provenance; `subject` labels the set in
 * manifest-scoped issues. Missing/unexpected/count checks are scoped to this
 * set's own accepted identifiers, so an unknown row in one set never masks or
 * pollutes another.
 */
function validateRegisterSet(
  context: RegisterSetContext,
  def: RegisterSetDefinition,
  requirements: unknown,
  closurePlan: unknown,
  subject: string,
) {
  const { issues, workstreamIds, requirementIds, acceptanceIds, evidenceIds } = context;

  if (isRecord(closurePlan)) {
    if (typeof closurePlan.source !== "string" || closurePlan.source.trim().length === 0) {
      addIssue(issues, "CLOSURE_SOURCE", subject, "closure plan source is required");
    }
    if (
      typeof closurePlan.auditedRevision !== "string" ||
      closurePlan.auditedRevision.trim().length === 0
    ) {
      addIssue(issues, "CLOSURE_REVISION", subject, "closure plan auditedRevision is required");
    }
  } else {
    addIssue(issues, "CLOSURE_PLAN", subject, "closurePlan must be an object");
  }

  if (!Array.isArray(requirements)) {
    addIssue(issues, "REQUIREMENTS_TYPE", subject, "requirements must be an array");
    return;
  }

  const expectedIds = [...def.expectedIds].sort();
  const setRequirementIds = new Set<string>();

  for (const raw of requirements) {
    if (!isRecord(raw)) {
      addIssue(issues, "REQUIREMENT_TYPE", subject, "each requirement must be an object");
      continue;
    }
    const id = typeof raw.id === "string" ? raw.id : "unknown";
    if (!def.requirementIdPattern.test(id)) {
      addIssue(issues, "REQUIREMENT_ID", id, "requirement ID is invalid");
    }
    if (requirementIds.has(id)) {
      addIssue(issues, "REQUIREMENT_DUPLICATE", id, "requirement ID is duplicated");
    }
    requirementIds.add(id);
    setRequirementIds.add(id);

    if (typeof raw.closureGapId !== "string" || !def.gapIdPattern.test(raw.closureGapId)) {
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

    const blockers: string[] = [];
    const blockerNames = new Set<string>();
    if (raw.externalBlockers !== null && !Array.isArray(raw.externalBlockers)) {
      addIssue(
        issues,
        "EXTERNAL_BLOCKERS_TYPE",
        id,
        "externalBlockers must be null or an array",
      );
    } else if (Array.isArray(raw.externalBlockers)) {
      for (const blocker of raw.externalBlockers) {
        if (typeof blocker !== "string" || blocker.trim().length === 0) {
          addIssue(
            issues,
            "EXTERNAL_BLOCKER_VALUE",
            id,
            "external blockers must be nonempty strings",
          );
          continue;
        }
        const normalized = blocker.trim();
        if (blockerNames.has(normalized)) {
          addIssue(
            issues,
            "EXTERNAL_BLOCKER_DUPLICATE",
            id,
            `external blocker is duplicated: ${normalized}`,
          );
          continue;
        }
        blockerNames.add(normalized);
        blockers.push(normalized);
      }
    }
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
      if (raw.implementationStatus === "partial") {
        addIssue(
          issues,
          "PARTIAL_IMPLEMENTATION_EVIDENCE",
          id,
          "partial requirements need implementation evidence",
        );
      }
      continue;
    }
    let hasImplementationEvidence = false;
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
      let hasExternalEvidence = false;
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
        } else {
          if (IMPLEMENTATION_EVIDENCE_TYPES.has(evidence.type as ProductEvidenceType)) {
            hasImplementationEvidence = true;
          }
          if (evidence.type === "external") {
            hasExternalEvidence = true;
          }
        }
        if (typeof evidence.locator !== "string" || evidence.locator.trim().length === 0) {
          addIssue(issues, "EVIDENCE_LOCATOR", evidenceId, "evidence locator is required");
        } else if (evidence.type === "external") {
          const namedBlockers = externalEvidenceBlockerNames(evidence.locator);
          if (namedBlockers.length === 0) {
            addIssue(
              issues,
              "EXTERNAL_EVIDENCE_BLOCKER",
              evidenceId,
              "external evidence must name a declared blocker",
            );
          }
          for (const namedBlocker of namedBlockers) {
            if (!blockerNames.has(namedBlocker)) {
              addIssue(
                issues,
                "EXTERNAL_EVIDENCE_BLOCKER",
                evidenceId,
                `external evidence names an undeclared blocker: ${namedBlocker}`,
              );
            }
          }
        }
        if (raw.availability === "ga" && ["document", "code", "planned", "external"].includes(String(evidence.type))) {
          addIssue(issues, "GA_EVIDENCE", evidenceId, "GA acceptance needs automated or live evidence");
        }
      }
      if (raw.implementationStatus === "verified" && hasExternalEvidence) {
        addIssue(
          issues,
          "EXTERNAL_ACCEPTANCE_VERIFIED",
          acceptanceId,
          "externally dependent acceptance cannot be verified",
        );
      }
    }
    if (raw.implementationStatus === "partial" && !hasImplementationEvidence) {
      addIssue(
        issues,
        "PARTIAL_IMPLEMENTATION_EVIDENCE",
        id,
        "partial requirements need implementation evidence",
      );
    }
  }

  const actualIds = [...setRequirementIds].sort();
  for (const missing of expectedIds.filter((id) => !setRequirementIds.has(id))) {
    addIssue(issues, "REQUIREMENT_MISSING", missing, `${def.key} requirement is missing`);
  }
  for (const unexpected of actualIds.filter((id) => !expectedIds.includes(id))) {
    addIssue(issues, "REQUIREMENT_UNEXPECTED", unexpected, `requirement is not in the ${def.key} register`);
  }

  if (isRecord(closurePlan) && closurePlan.requirementCount !== expectedIds.length) {
    addIssue(issues, "REQUIREMENT_COUNT", subject, `closure plan count must equal ${expectedIds.length}`);
  }
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

  // A caller-supplied `expectedIds` selects the legacy single-set mode: only the
  // top-level foundational set is validated, against those identifiers. Absent
  // that override the default is the full multi-set contract, whose foundational
  // set is the top-level `requirements`/`closurePlan` and whose every other set
  // must appear, keyed, in `additionalRegisterSets`.
  const registerSets: readonly RegisterSetDefinition[] = options.registerSets
    ? options.registerSets
    : options.expectedIds
      ? [{ ...FOUNDATIONAL_REGISTER_SET, expectedIds: [...options.expectedIds] }]
      : PRODUCT_REGISTER_SETS;

  const foundationalDef =
    registerSets.find((set) => set.key === FOUNDATIONAL_REGISTER_SET.key) ?? registerSets[0];
  const additionalDefs = registerSets.filter((set) => set !== foundationalDef);

  if (!Array.isArray(input.requirements)) {
    addIssue(issues, "REQUIREMENTS_TYPE", "manifest", "requirements must be an array");
    return issues.sort(compareIssues);
  }

  const context: RegisterSetContext = {
    issues,
    workstreamIds,
    requirementIds: new Set<string>(),
    acceptanceIds: new Set<string>(),
    evidenceIds: new Set<string>(),
  };

  validateRegisterSet(context, foundationalDef, input.requirements, input.closurePlan, "manifest");

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

  const manifestAdditional = Array.isArray(input.additionalRegisterSets)
    ? input.additionalRegisterSets
    : [];
  const knownKeys = new Set(additionalDefs.map((set) => set.key));
  const seenKeys = new Set<string>();
  for (const entry of manifestAdditional) {
    if (!isRecord(entry) || typeof entry.key !== "string" || entry.key.length === 0) {
      addIssue(issues, "REGISTER_SET_KEY", "additionalRegisterSets", "each register set needs a string key");
      continue;
    }
    if (!knownKeys.has(entry.key)) {
      addIssue(issues, "REGISTER_SET_UNKNOWN", entry.key, "register set key is not recognized");
      continue;
    }
    if (seenKeys.has(entry.key)) {
      addIssue(issues, "REGISTER_SET_DUPLICATE", entry.key, "register set key is duplicated");
      continue;
    }
    seenKeys.add(entry.key);
    const def = additionalDefs.find((set) => set.key === entry.key)!;
    validateRegisterSet(
      context,
      def,
      entry.requirements,
      entry.closurePlan,
      `additionalRegisterSets:${entry.key}`,
    );
  }
  for (const def of additionalDefs) {
    if (!seenKeys.has(def.key)) {
      addIssue(issues, "REGISTER_SET_MISSING", def.key, "declared register set is absent from the manifest");
    }
  }

  return issues.sort(compareIssues);
}

/** Stable digest for repository text regardless of the checkout's line endings. */
export function canonicalTextSha256(value: string): string {
  const canonical = value.replace(/\r\n?/g, "\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function compareIssues(left: ProductRequirementIssue, right: ProductRequirementIssue) {
  return (
    left.code.localeCompare(right.code) ||
    left.subject.localeCompare(right.subject) ||
    left.message.localeCompare(right.message)
  );
}
