import type {
  ProductAvailability,
  ProductClaimState,
  ProductImplementationStatus,
} from "../packages/contract/src/product-requirements.js";

export const APPROVED_PRIMARY_PLAN_CATALOG: Readonly<Record<string, readonly string[]>> = {
  "00-02": ["ME-FND-001", "ME-FND-002", "ME-FND-003", "ME-FND-004", "ME-FND-005", "ME-FND-006", "ME-FND-007", "ME-FND-008", "ME-FND-009", "ME-FND-010"],
  "01-01": ["ME-ENT-003"],
  "02-01": ["ME-MSN-001", "ME-MSN-002", "ME-MSN-003"],
  "02-02": ["ME-MCC-001", "ME-MTE-001"],
  "02-03": ["ME-PEV-001"],
  "03-01": ["ME-SCM-001", "ME-SCM-002", "ME-SCM-005"],
  "03-02": ["ME-SCM-003"],
  "03-03": ["ME-SCM-004", "ME-SCM-006"],
  "04-01": ["ME-ING-001", "ME-ING-003", "ME-ING-004"],
  "04-02": ["ME-ING-005", "ME-ING-006"],
  "04-03": ["ME-ING-002", "ME-ING-007", "ME-ING-008", "ME-ING-009"],
  "05-01": ["ME-GRF-001", "ME-GRF-002", "ME-FET-015", "ME-SXT-001"],
  "05-02": ["ME-GRF-004", "ME-GRF-005", "ME-GRF-006", "ME-FET-016", "ME-FET-017"],
  "05-03": ["ME-FET-018", "ME-REG-015"],
  "05-04": ["ME-REG-016", "ME-REG-017", "ME-REG-018"],
  "05-05": ["ME-GRF-003", "ME-GRF-007", "ME-GRF-008", "ME-CGR-001"],
  "06-01": ["ME-WAR-001", "ME-WAR-002"],
  "06-02": ["ME-WAR-003", "ME-WAR-005", "ME-WAR-008"],
  "06-03": ["ME-WAR-004", "ME-WAR-006", "ME-WAR-007"],
  "06-04": ["ME-WAR-009", "ME-GTM-001", "ME-GTM-002"],
  "06-05": ["ME-WAR-010", "ME-GTM-003"],
  "07-01": ["ME-TRN-001", "ME-TRN-002", "ME-TRN-009"],
  "07-02": ["ME-TRN-003", "ME-TRN-010"],
  "07-03": ["ME-TRN-011", "ME-TRN-013"],
  "07-04": ["ME-TRN-004", "ME-TRN-005", "ME-TRN-006"],
  "07-05": ["ME-TRN-007", "ME-TRN-008", "ME-TRN-012"],
  "08-01": ["ME-RTR-001", "ME-RTR-002", "ME-RTR-003", "ME-RTR-004"],
  "08-02": ["ME-RTR-005", "ME-RTR-006", "ME-RTR-009"],
  "08-03": ["ME-RTR-007", "ME-OMM-001"],
  "08-04": ["ME-RTR-008"],
  "09-01": ["ME-COM-001", "ME-COM-002", "ME-COM-004"],
  "09-02": ["ME-COM-003"],
  "10-01": ["ME-ENT-001"],
  "10-02": ["ME-ENT-002", "ME-ENT-004"],
  "10-03": ["ME-ENT-005", "ME-ENT-006"],
  "10-04": ["ME-ENT-007", "ME-ENT-008"],
  "10-05": ["ME-ENT-009"],
  "10-06": ["ME-ENT-010"],
  "10-07": ["ME-ENT-011"],
  "10-14": ["ME-ENT-012"],
};

export const EXPECTED_WORKSTREAM_COUNTS: Readonly<Record<string, number>> = {
  "FC-00": 14,
  "FC-01": 4,
  "FC-02": 6,
  "FC-03": 28,
  "FC-04": 8,
  "FC-05": 11,
  "FC-06": 7,
  "FC-07": 8,
  "FC-08": 3,
  "FC-09": 4,
  "FC-10": 8,
};

export type ClosureEvidenceProfile =
  | "documentation_policy"
  | "behavioral"
  | "behavioral_external"
  | "external_only";

export type ClosureQueueState = "build" | "repair" | "ship" | "external-proof";
export type ClosureTransitionState =
  | "implementation_pending"
  | "repair_pending"
  | "deployment_pending"
  | "external_proof_pending"
  | "qualified";

export interface CanonicalClosureRow {
  requirementId: string;
  registerSet: string;
  workstream: string;
  implementationStatus: ProductImplementationStatus;
  availability: ProductAvailability;
  claimState: ProductClaimState;
  primaryPlan: string;
  acceptanceIds: string[];
  evidenceProfile: ClosureEvidenceProfile;
  implementationEvidenceIds: string[];
  testEvidenceIds: string[];
  syntheticEvidenceIds: string[];
  liveEvidenceIds: string[];
  externalEvidenceIds: string[];
  plannedEvidenceIds: string[];
  rollbackEvidenceIds: string[];
  supportBoundary: {
    owner: string;
    targetRelease: string;
    externalBlockers: string[];
  };
  target: {
    implementationStatus: ProductImplementationStatus;
    availability: ProductAvailability;
    claimState: ProductClaimState;
  };
  productionRevision: string | null;
  productionEvidenceDigest: string | null;
  transitionState: ClosureTransitionState;
  queueState: ClosureQueueState;
}

export interface CanonicalClosureIssue {
  code: string;
  subject: string;
  message: string;
}

const PRIMARY_PLAN_BY_REQUIREMENT = new Map<string, string>();
for (const [planId, requirementIds] of Object.entries(APPROVED_PRIMARY_PLAN_CATALOG)) {
  for (const requirementId of requirementIds) {
    if (PRIMARY_PLAN_BY_REQUIREMENT.has(requirementId)) {
      throw new Error(`duplicate approved primary ownership for ${requirementId}`);
    }
    PRIMARY_PLAN_BY_REQUIREMENT.set(requirementId, planId);
  }
}

// These are the already-verified, provider-neutral contracts whose eventual
// public statement does not depend on a supported provider, product lane, or
// enterprise deployment boundary. Every other row is deliberately limited.
const PUBLIC_CURRENT_TARGET_REQUIREMENT_IDS = new Set([
  "ME-ING-002", "ME-ING-005", "ME-ING-007", "ME-ING-008",
  "ME-GRF-003", "ME-WAR-008",
  "ME-RTR-001", "ME-RTR-002", "ME-RTR-003", "ME-RTR-004", "ME-RTR-005", "ME-RTR-007",
  "ME-COM-001", "ME-COM-002", "ME-COM-004",
]);

export function approvedPrimaryPlan(requirementId: string): string {
  const planId = PRIMARY_PLAN_BY_REQUIREMENT.get(requirementId);
  if (!planId) throw new Error(`approved primary plan missing for ${requirementId}`);
  return planId;
}

export function targetClaimState(requirementId: string): ProductClaimState {
  return PUBLIC_CURRENT_TARGET_REQUIREMENT_IDS.has(requirementId)
    ? "public_current"
    : "public_limited";
}

export function evidenceProfile(input: {
  evidenceTypes: readonly string[];
  externalBlockers: readonly string[];
}): ClosureEvidenceProfile {
  const types = new Set(input.evidenceTypes);
  const hasBehavior = [...types].some((type) =>
    ["code", "unit", "integration", "e2e", "benchmark", "security", "live", "planned"].includes(type),
  );
  if (input.externalBlockers.length > 0) {
    return hasBehavior ? "behavioral_external" : "external_only";
  }
  if (!hasBehavior && types.size > 0 && [...types].every((type) => type === "document")) {
    return "documentation_policy";
  }
  return "behavioral";
}

export function initialQueueState(input: {
  implementationStatus: ProductImplementationStatus;
  evidenceProfile: ClosureEvidenceProfile;
}): ClosureQueueState {
  if (input.evidenceProfile === "external_only") return "external-proof";
  if (input.implementationStatus === "unimplemented" || input.implementationStatus === "scaffold") {
    return "build";
  }
  if (input.implementationStatus === "partial" || input.implementationStatus === "blocked_external") {
    return "repair";
  }
  return "ship";
}

export function transitionState(input: {
  queueState: ClosureQueueState;
  productionRevision: string | null;
  productionEvidenceDigest: string | null;
}): ClosureTransitionState {
  if (input.productionRevision && input.productionEvidenceDigest) return "qualified";
  switch (input.queueState) {
    case "build": return "implementation_pending";
    case "repair": return "repair_pending";
    case "ship": return "deployment_pending";
    case "external-proof": return "external_proof_pending";
  }
}

function issue(
  issues: CanonicalClosureIssue[],
  code: string,
  subject: string,
  message: string,
): void {
  issues.push({ code, subject, message });
}

const EVIDENCE_FIELDS = [
  "implementationEvidenceIds",
  "testEvidenceIds",
  "syntheticEvidenceIds",
  "liveEvidenceIds",
  "externalEvidenceIds",
  "plannedEvidenceIds",
  "rollbackEvidenceIds",
] as const;

export function validateCanonicalClosureRows(
  rows: readonly CanonicalClosureRow[],
  expectedRows?: readonly CanonicalClosureRow[],
): CanonicalClosureIssue[] {
  const issues: CanonicalClosureIssue[] = [];
  if (rows.length !== 101) {
    issue(issues, "REQUIREMENT_COUNT_DRIFT", "rows", `expected 101 rows, got ${rows.length}`);
  }
  const byId = new Map<string, CanonicalClosureRow>();
  for (const row of rows) {
    if (byId.has(row.requirementId)) {
      issue(issues, "REQUIREMENT_DUPLICATE", row.requirementId, "requirement appears more than once");
    }
    byId.set(row.requirementId, row);
    if (row.primaryPlan.includes("*")) {
      issue(issues, "PRIMARY_PLAN_WILDCARD", row.requirementId, "primary plan must be an exact approved plan ID");
    }
    const approved = PRIMARY_PLAN_BY_REQUIREMENT.get(row.requirementId);
    if (!approved) {
      issue(issues, "PRIMARY_PLAN_MISSING", row.requirementId, "requirement is absent from the approved catalog");
    } else if (row.primaryPlan !== approved) {
      issue(issues, "PRIMARY_PLAN_MISMATCH", row.requirementId, `expected ${approved}, got ${row.primaryPlan}`);
    }
    if (row.acceptanceIds.length === 0) {
      issue(issues, "ACCEPTANCE_UNCOVERED", row.requirementId, "at least one acceptance ID is required");
    }
    if (new Set(row.acceptanceIds).size !== row.acceptanceIds.length) {
      issue(issues, "ACCEPTANCE_DUPLICATE", row.requirementId, "acceptance IDs must be unique");
    }
    if (
      row.availability === "ga" &&
      row.supportBoundary.externalBlockers.length > 0 &&
      !row.productionEvidenceDigest
    ) {
      issue(issues, "EXTERNAL_GA_EVIDENCE_MISSING", row.requirementId, "external GA requires bound production evidence");
    }
    if (Boolean(row.productionRevision) !== Boolean(row.productionEvidenceDigest)) {
      issue(issues, "PRODUCTION_BINDING_INCOMPLETE", row.requirementId, "production revision and evidence digest must be present together");
    }
    if (row.availability === "ga" && (!row.productionRevision || !row.productionEvidenceDigest)) {
      issue(issues, "GA_EVIDENCE_MISSING", row.requirementId, "GA requires exact-revision production evidence");
    }
    if (
      (row.availability === "ga" || row.transitionState === "qualified") &&
      row.plannedEvidenceIds.length > 0
    ) {
      issue(issues, "PLANNED_EVIDENCE_UNRESOLVED", row.requirementId, "qualified rows cannot retain planned evidence locators");
    }
  }

  for (const requirementId of PRIMARY_PLAN_BY_REQUIREMENT.keys()) {
    if (!byId.has(requirementId)) {
      issue(issues, "PRIMARY_REQUIREMENT_MISSING", requirementId, "approved primary requirement is missing from the matrix");
    }
  }
  for (const [workstream, expectedCount] of Object.entries(EXPECTED_WORKSTREAM_COUNTS)) {
    const actual = rows.filter((row) => row.workstream === workstream).length;
    if (actual !== expectedCount) {
      issue(issues, "WORKSTREAM_COUNT_DRIFT", workstream, `expected ${expectedCount}, got ${actual}`);
    }
  }

  if (expectedRows) {
    const expectedById = new Map(expectedRows.map((row) => [row.requirementId, row]));
    for (const row of rows) {
      const expected = expectedById.get(row.requirementId);
      if (!expected) continue;
      if (
        row.registerSet !== expected.registerSet ||
        row.workstream !== expected.workstream ||
        row.implementationStatus !== expected.implementationStatus ||
        row.availability !== expected.availability
      ) {
        issue(issues, "REGISTER_DRIFT", row.requirementId, "row no longer matches the canonical requirement register");
      }
      if (row.claimState !== expected.claimState || row.target.claimState !== expected.target.claimState) {
        issue(issues, "CLAIM_DRIFT", row.requirementId, "current or target claim state drifted");
      }
      if (
        row.acceptanceIds.join("\0") !== expected.acceptanceIds.join("\0") ||
        EVIDENCE_FIELDS.some((field) => row[field].join("\0") !== expected[field].join("\0"))
      ) {
        issue(issues, "EVIDENCE_DRIFT", row.requirementId, "acceptance or evidence binding drifted");
      }
      if (
        row.productionRevision !== expected.productionRevision ||
        row.productionEvidenceDigest !== expected.productionEvidenceDigest
      ) {
        issue(issues, "DEPLOYED_REVISION_DRIFT", row.requirementId, "production revision or evidence digest drifted");
      }
    }
  }
  return issues;
}

export interface ClosurePlanQueueItem {
  planId: string;
  queueState: ClosureQueueState;
  outcome: "pending" | "running" | "succeeded" | "failed";
  dependencies: readonly string[];
}

export function runnableClosurePlans(items: readonly ClosurePlanQueueItem[]): string[] {
  const byPlan = new Map(items.map((item) => [item.planId, item]));
  return items
    .filter((item) =>
      item.outcome === "pending" &&
      item.queueState !== "external-proof" &&
      item.dependencies.every((dependency) => byPlan.get(dependency)?.outcome === "succeeded"),
    )
    .map((item) => item.planId)
    .sort();
}

export function finalQualificationReady(items: readonly ClosurePlanQueueItem[]): boolean {
  return items.length > 0 && items.every((item) => item.outcome === "succeeded");
}
