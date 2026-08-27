import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type SweepAuthorityKind = "proposal" | "github";
export type SweepIssueCategory = "semantic" | "operational";

export interface SweepExecutionOutcomes {
  appIdentity: string;
  branchProtection: string;
  matrix: string;
  externalPublication: string;
  controllerPublication: string;
  proposal: string;
  github: string;
}

export const sweepIssueCategories = {
  proposal: {
    PROPOSAL_AUTHORITY_CONFIGURATION_INVALID: "operational",
    PROPOSAL_AUTHORITY_IDENTITY_INVALID: "operational",
    PROPOSAL_TREE_TRUNCATED: "operational",
    PROPOSAL_BLOB_INVALID: "operational",
    PROPOSAL_BLOB_BUDGET_EXCEEDED: "operational",
    PROPOSAL_BLOB_DIGEST_MISMATCH: "operational",
    PROPOSAL_BASE_AUTHORITY_INVALID: "operational",
    PROPOSAL_BASE_TREE_TRUNCATED: "operational",
    PROPOSAL_BASE_BLOB_INVALID: "operational",
    PROPOSAL_AUTHORITY_MERGE_BASE_UNRESOLVED: "operational",
    PROPOSAL_BASE_MATRIX_INVALID: "operational",
    PROPOSAL_BASE_AUTHORITY_MISMATCH: "operational",
    PROPOSAL_AUTHORITY_UNAVAILABLE: "operational",
    AUTHORITY_SUCCESSOR_WORKFLOW_UNSAFE: "semantic",
    PROPOSAL_PATH_INVALID: "semantic",
    PROPOSAL_JSON_INVALID: "semantic",
    PROPOSAL_PROVIDER_RECORD_REMOVAL_UNVERIFIED: "semantic",
    PROPOSAL_AUTHORITY_SURFACE_DRIFT: "semantic",
    AUTHORITY_ROTATION_TREE_ENTRY_INVALID: "semantic",
    AUTHORITY_ROTATION_MATRIX_SCOPE_INVALID: "semantic",
    AUTHORITY_ROTATION_BOOTSTRAP_MISMATCH: "semantic",
    PROPOSAL_CONTROLLER_SURFACE_COLLISION: "semantic",
    PROPOSAL_AUTHORITY_POLICY_DRIFT: "semantic",
    SPEC_MISSING: "semantic",
    SPEC_HASH_MISMATCH: "semantic",
    CLAIM_SURFACE_BINDING_MISSING: "semantic",
    AUTHORITY_ROTATION_RECEIPT_INVALID: "semantic",
    AUTHORITY_ROTATION_POLICY_DIGEST_MISMATCH: "semantic",
    AUTHORITY_SUCCESSOR_TRANSITION_INVALID: "semantic",
    AUTHORITY_ROTATION_IDENTITY_DRIFT: "semantic",
    AUTHORITY_SUCCESSOR_STAGE_ACTIVE_DRIFT: "semantic",
    AUTHORITY_SUCCESSOR_TUPLE_INVALID: "semantic",
    AUTHORITY_SUCCESSOR_STAGE_STATE_INVALID: "semantic",
    AUTHORITY_SUCCESSOR_CONTEXT_COLLISION: "semantic",
    AUTHORITY_SUCCESSOR_ACTIVATION_DEADLINE_INVALID: "semantic",
    AUTHORITY_SUCCESSOR_WORKFLOW_NOT_PINNED: "semantic",
    AUTHORITY_SUCCESSOR_APP_IDENTITY_DRIFT: "semantic",
    AUTHORITY_SUCCESSOR_PREDECESSOR_NOT_RETAINED: "semantic",
    AUTHORITY_SUCCESSOR_ACTIVATION_STATE_INVALID: "semantic",
    AUTHORITY_SUCCESSOR_ACTIVATION_IDENTITY_INVALID: "semantic",
    AUTHORITY_SUCCESSOR_ACTIVATION_EXPIRED: "semantic",
    AUTHORITY_SUCCESSOR_STAGED_BYTES_DRIFT: "semantic",
    AUTHORITY_SUCCESSOR_PREDECESSOR_NOT_REMOVED: "semantic",
    AUTHORITY_ROTATION_WORKFLOW_SUCCESSOR_REQUIRED: "semantic",
    AUTHORITY_ROTATION_REVIEWER_CONTINUITY_REQUIRED: "semantic",
    AUTHORITY_ROTATION_CHANGE_INVALID: "semantic",
    AUTHORITY_ROTATION_SCOPE_INVALID: "semantic",
    AUTHORITY_ROTATION_CHANGESET_MISMATCH: "semantic",
    AUTHORITY_ROTATION_PROTECTED_FILE_REMOVED: "semantic",
    AUTHORITY_ROTATION_PROTECTED_PATH_INVALID: "semantic",
    AUTHORITY_ROTATION_PROTECTED_DIGEST_INVALID: "semantic",
    AUTHORITY_ROTATION_DYNAMIC_IMPORT_FORBIDDEN: "semantic",
    AUTHORITY_ROTATION_IMPORT_UNRESOLVED: "semantic",
    AUTHORITY_ROTATION_IMPORT_CLOSURE_INCOMPLETE: "semantic",
    CLOSURE_SOURCE: "semantic",
    CLOSURE_REVISION: "semantic",
    CLOSURE_PLAN: "semantic",
    REQUIREMENTS_TYPE: "semantic",
    REQUIREMENT_TYPE: "semantic",
    REQUIREMENT_ID: "semantic",
    REQUIREMENT_DUPLICATE: "semantic",
    GAP_ID: "semantic",
    TARGET_RELEASE: "semantic",
    AVAILABILITY: "semantic",
    IMPLEMENTATION_STATUS: "semantic",
    CLAIM_STATE: "semantic",
    WORKSTREAM_REFERENCE: "semantic",
    EXTERNAL_BLOCKERS_TYPE: "semantic",
    EXTERNAL_BLOCKER_VALUE: "semantic",
    EXTERNAL_BLOCKER_DUPLICATE: "semantic",
    EXTERNAL_BLOCKER: "semantic",
    GA_STATUS: "semantic",
    GA_BLOCKER: "semantic",
    CLAIM_EXCEEDS_AVAILABILITY: "semantic",
    ACCEPTANCE_REQUIRED: "semantic",
    PARTIAL_IMPLEMENTATION_EVIDENCE: "semantic",
    ACCEPTANCE_TYPE: "semantic",
    ACCEPTANCE_ID: "semantic",
    ACCEPTANCE_DUPLICATE: "semantic",
    ACCEPTANCE_ASSERTION: "semantic",
    EVIDENCE_REQUIRED: "semantic",
    EVIDENCE_TYPE: "semantic",
    EVIDENCE_ID: "semantic",
    EVIDENCE_DUPLICATE: "semantic",
    EVIDENCE_KIND: "semantic",
    EVIDENCE_LOCATOR: "semantic",
    EXTERNAL_EVIDENCE_BLOCKER: "semantic",
    GA_EVIDENCE: "semantic",
    EXTERNAL_ACCEPTANCE_VERIFIED: "semantic",
    VERIFIED_WITHOUT_CODE_EVIDENCE: "semantic",
    REQUIREMENT_MISSING: "semantic",
    REQUIREMENT_UNEXPECTED: "semantic",
    REQUIREMENT_COUNT: "semantic",
    MANIFEST_TYPE: "semantic",
    SCHEMA_VERSION: "semantic",
    SPEC_RECORD: "semantic",
    SPEC_PATH: "semantic",
    SPEC_VERSION: "semantic",
    SPEC_HASH: "semantic",
    WORKSTREAMS_TYPE: "semantic",
    WORKSTREAM_ID: "semantic",
    WORKSTREAM_DUPLICATE: "semantic",
    WORKSTREAM_TITLE: "semantic",
    WORKSTREAM_EMPTY: "semantic",
    REGISTER_SET_KEY: "semantic",
    REGISTER_SET_UNKNOWN: "semantic",
    REGISTER_SET_DUPLICATE: "semantic",
    REGISTER_SET_MISSING: "semantic",
    REGISTRY_TYPE: "semantic",
    WEBSITE: "semantic",
    WEBSITE_STATUS: "semantic",
    AUDITED_REVISION: "semantic",
    AS_OF: "semantic",
    CLAIMS_REQUIRED: "semantic",
    CLAIM_TYPE: "semantic",
    CLAIM_ID: "semantic",
    CLAIM_DUPLICATE: "semantic",
    CLAIM_KIND: "semantic",
    REQUIREMENT_IDS_REQUIRED: "semantic",
    REQUIREMENT_ID_DUPLICATE: "semantic",
    REQUIREMENT_REFERENCE: "semantic",
    PROVEN_CAPABILITY_REQUIREMENT_INCOMPLETE: "semantic",
    PROVEN_CAPABILITY_REQUIREMENT_NON_PUBLIC: "semantic",
    SURFACES_REQUIRED: "semantic",
    SURFACE: "semantic",
    SURFACE_PATHS_REQUIRED: "semantic",
    SURFACE_PATH: "semantic",
    UNSUPPORTED_ABSOLUTE: "semantic",
    LIMITATIONS: "semantic",
    LIMITATION: "semantic",
    VERIFIED_DATE: "semantic",
    EXPIRY_DATE: "semantic",
    QUALIFIER_REQUIRED: "semantic",
    QUALIFIER_MISSING: "semantic",
    QUALIFIER_UNEXPECTED: "semantic",
    ROADMAP_LABEL: "semantic",
    LIVE_EVIDENCE_OBSERVED_AT: "semantic",
    LIVE_EVIDENCE_FRESH_UNTIL: "semantic",
    LIVE_EVIDENCE_REVISION: "semantic",
    LIVE_EVIDENCE_REVISION_MISMATCH: "semantic",
    LIVE_EVIDENCE_FUTURE: "semantic",
    LIVE_EVIDENCE_FRESHNESS_WINDOW: "semantic",
    LIVE_EVIDENCE_STALE: "semantic",
    LIVE_EVIDENCE_BATCH_STAMP: "semantic",
    DESTINATIONS_REQUIRED: "semantic",
    DESTINATION_TYPE: "semantic",
    DESTINATION_ID: "semantic",
    DESTINATION_DUPLICATE: "semantic",
    DESTINATION_HREF: "semantic",
    DESTINATION_CLAIM: "semantic",
    RELEASE_REVISION_UNREACHABLE: "semantic",
    RELEASE_SNAPSHOT_FROM_FUTURE: "semantic",
    RELEASE_SNAPSHOT_STALE: "semantic",
    PR_HEAD_REVISION_UNREACHABLE: "semantic",
    PR_MERGE_REVISION_UNREACHABLE: "semantic",
    PR_DEPENDENCY_NOT_ON_MAIN: "semantic",
    GA_LIVE_EVIDENCE_FROM_FUTURE: "semantic",
    GA_LIVE_EVIDENCE_STALE: "semantic",
    GA_DEPLOYED_REVISION_UNREACHABLE: "semantic",
    GA_EVIDENCE_ARTIFACT_UNREACHABLE: "semantic",
    GA_VERSION_EVIDENCE_INVALID: "semantic",
    CANONICAL_REGISTER: "semantic",
    ISSUE_INTEGRITY_INVALID: "semantic",
    ISSUE_AUTHORITY_RECORD_INVALID: "semantic",
    UNKNOWN_REQUIREMENT_REFERENCE: "semantic",
    REQUIREMENT_UNKNOWN: "semantic",
    REGISTER_SET_DRIFT: "semantic",
    STATUS_DRIFT: "semantic",
    ISSUE_REFERENCE: "semantic",
    ISSUE_AUTHORITY_MISSING: "semantic",
    ISSUE_REQUIREMENT_MISMATCH: "semantic",
    PR_REFERENCE: "semantic",
    TEST_EVIDENCE_DRIFT: "semantic",
    PRODUCTION_EVIDENCE_DRIFT: "semantic",
    EVIDENCE_REFERENCE: "semantic",
    GA_PRODUCTION_EVIDENCE_REQUIRED: "semantic",
    GA_LIVE_EVIDENCE_BINDING_DUPLICATE: "semantic",
    GA_LIVE_EVIDENCE_BINDING_INVALID: "semantic",
    GA_LIVE_EVIDENCE_BINDING_REQUIRED: "semantic",
    GA_LIVE_EVIDENCE_BINDING_UNKNOWN: "semantic",
    REQUIREMENT_CLOSURE_PATH_REQUIRED: "semantic",
    RELEASE_REVISION: "semantic",
    RELEASE_INTEGRITY_INVALID: "semantic",
    RELEASE_TIMESTAMP: "semantic",
    OWNER_AUTHORITY: "semantic",
    CURRENT_PR_BOOTSTRAP_INVALID: "semantic",
    CURRENT_PR_AUTHORITY_ROTATION_INVALID: "semantic",
    BLOCKER_FORMAT: "semantic",
    CURRENT_PR_BLOCKED: "semantic",
    CURRENT_PR_NOT_MERGE_ELIGIBLE: "semantic",
    PR_AUTHORITY_URL_INVALID: "semantic",
    PR_DUPLICATE: "semantic",
    CURRENT_PR_BOOTSTRAP_DUPLICATE: "semantic",
    PR_STATE: "semantic",
    PR_DISPOSITION: "semantic",
    PR_CHECK_STATE: "semantic",
    PR_HEAD_REVISION_REQUIRED: "semantic",
    PR_MERGE_REVISION_REQUIRED: "semantic",
    PR_CHECK_RECORD_INVALID: "semantic",
    PR_REQUIRED_CHECKS_MISSING: "semantic",
    PR_REVIEW_RECORD_REQUIRED: "semantic",
    PR_DISPOSITION_STATE: "semantic",
    PR_EXACT_REVIEW_REQUIRED: "semantic",
    PR_GREEN_WITH_BLOCKERS: "semantic",
    PR_DEPENDENCY_SELF: "semantic",
    PR_MERGED_WITH_BLOCKERS: "semantic",
    PR_MERGED_REVIEW_REQUIRED: "semantic",
    PR_DEPENDENCY_UNTRACKED: "semantic",
    PR_DEPENDENCY_UNSATISFIED: "semantic",
    PR_DEPENDENCY_CYCLE: "semantic",
    REQUIREMENT_ACTIVE_CLOSURE_PATH_REQUIRED: "semantic",
    PR_NOT_IN_RELEASE_TRAIN: "semantic",
    PR_REQUIREMENT_MISMATCH: "semantic",
    CURRENT_PR_REMEDIATION_INVALID: "semantic",
    CURRENT_PR_DEPENDENCY_UNSATISFIED: "semantic",
    CURRENT_PR_BRANCH_DEPENDENCY_UNVERIFIED: "semantic",
    LIVE_EVIDENCE_REVISION_UNREACHABLE: "semantic",
  },
  github: {
    GITHUB_REPOSITORY_MISMATCH: "operational",
    PR_EVENT_NUMBER_MISMATCH: "operational",
    PR_EVENT_BASE_MISMATCH: "operational",
    PR_EVENT_HEAD_MISMATCH: "operational",
    CHECKOUT_REVISION_MISMATCH: "operational",
    PUSH_MAIN_REVISION_MISMATCH: "operational",
    MAIN_CHANGED_DURING_OBSERVATION: "operational",
    GITHUB_AUTHORITY_UNAVAILABLE: "operational",
    GITHUB_AUTHORITY_CONFIGURATION_INVALID: "operational",
    MATRIX_MAIN_REVISION_MISMATCH: "semantic",
    OPEN_PR_COMPLETENESS_MISMATCH: "semantic",
    CURRENT_PR_NOT_MERGE_ELIGIBLE: "semantic",
    CURRENT_PR_DEPENDENCY_UNSATISFIED: "semantic",
    CURRENT_PR_BRANCH_DEPENDENCY_UNVERIFIED: "semantic",
    PR_METADATA_MISMATCH: "semantic",
    PR_REQUIREMENT_MAPPING_MISMATCH: "semantic",
    PR_REQUIRED_CHECKS_NOT_GREEN: "semantic",
    PR_EXACT_TRUSTED_REVIEW_REQUIRED: "semantic",
    AUTHORITY_ROTATION_REVIEW_ATTESTATION_REQUIRED: "semantic",
    AUTHORITY_ROTATION_REVIEW_UNEXPECTED: "semantic",
    AUTHORITY_SUCCESSOR_DECLARATION_REQUIRED: "semantic",
    AUTHORITY_SUCCESSOR_LIVE_PROOF_REQUIRED: "semantic",
    AUTHORITY_SUCCESSOR_WORKFLOW_PROVENANCE_INVALID: "semantic",
    ISSUE_METADATA_MISMATCH: "semantic",
    ISSUE_REQUIREMENT_MAPPING_MISMATCH: "semantic",
  },
} as const satisfies Record<SweepAuthorityKind, Record<string, SweepIssueCategory>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function positiveIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(positiveInteger);
}

function isoTime(value: unknown): value is string {
  return nonemptyString(value) && Number.isFinite(Date.parse(value));
}

function proposalObservationShape(value: Record<string, unknown>): boolean {
  const rotation = value.authorityRotation;
  const rotationValid = rotation === null || (
    isRecord(rotation) &&
    nonemptyString(rotation.rotationId) &&
    ["runtime", "stage_successor", "activate_successor"].includes(String(rotation.kind)) &&
    isoTime(rotation.issuedAt) &&
    isoTime(rotation.expiresAt) &&
    typeof rotation.basePolicySha256 === "string" &&
    SHA256.test(rotation.basePolicySha256) &&
    typeof rotation.proposedPolicySha256 === "string" &&
    SHA256.test(rotation.proposedPolicySha256) &&
    (rotation.successor === null || isRecord(rotation.successor))
  );
  return value.repository === "gondalaimafia/mendpoint" &&
    positiveInteger(value.repositoryId) &&
    typeof value.proposalRevision === "string" &&
    SHA.test(value.proposalRevision) &&
    isoTime(value.observedAt) &&
    Array.isArray(value.fetchedBlobs) &&
    value.fetchedBlobs.every((blob) =>
      isRecord(blob) &&
      nonemptyString(blob.path) &&
      typeof blob.gitBlobSha === "string" &&
      SHA.test(blob.gitBlobSha) &&
      typeof blob.sha256 === "string" &&
      SHA256.test(blob.sha256) &&
      Number.isInteger(blob.size) &&
      Number(blob.size) >= 0
    ) &&
    positiveIntegerArray(value.providerValidationPullRequests) &&
    positiveIntegerArray(value.providerValidationIssues) &&
    rotationValid;
}

function githubObservationShape(value: Record<string, unknown>): boolean {
  return value.repository === "gondalaimafia/mendpoint" &&
    value.eventName === "pull_request" &&
    nonemptyString(value.workflowRunId) &&
    isoTime(value.observedAt) &&
    typeof value.githubSha === "string" &&
    SHA.test(value.githubSha) &&
    typeof value.checkoutRevision === "string" &&
    SHA.test(value.checkoutRevision) &&
    typeof value.mainRevisionStart === "string" &&
    SHA.test(value.mainRevisionStart) &&
    typeof value.mainRevisionEnd === "string" &&
    SHA.test(value.mainRevisionEnd) &&
    positiveInteger(value.eventPullRequest) &&
    positiveIntegerArray(value.openPullRequests) &&
    positiveIntegerArray(value.verifiedPullRequests) &&
    positiveIntegerArray(value.verifiedIssues) &&
    positiveIntegerArray(value.checkRunIds) &&
    positiveIntegerArray(value.workflowRunIds) &&
    positiveIntegerArray(value.reviewIds);
}

export function isHealthyFullSweepObservation(
  authority: string,
  value: unknown,
): boolean {
  if (authority !== "proposal" && authority !== "github") return false;
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.issues)) return false;
  if (authority === "proposal" && !proposalObservationShape(value)) return false;
  if (authority === "github" && !githubObservationShape(value)) return false;
  if (value.verdict === "pass") return value.issues.length === 0;
  if (value.verdict !== "fail" || value.issues.length === 0) return false;

  const categories: Record<string, SweepIssueCategory> = sweepIssueCategories[authority];
  return value.issues.every((issue) =>
    isRecord(issue) &&
    nonemptyString(issue.code) &&
    nonemptyString(issue.subject) &&
    nonemptyString(issue.message) &&
    categories[issue.code] === "semantic"
  );
}

function observationVerdict(value: unknown): "pass" | "fail" | null {
  if (!isRecord(value)) return null;
  return value.verdict === "pass" || value.verdict === "fail" ? value.verdict : null;
}

export function isHealthySweepExecution(
  eventName: string,
  outcomes: SweepExecutionOutcomes,
  proposalObservation: unknown,
  githubObservation: unknown,
): boolean {
  if (
    outcomes.appIdentity !== "success" ||
    outcomes.branchProtection !== "success" ||
    outcomes.matrix !== "success" ||
    outcomes.externalPublication !== "success" ||
    outcomes.controllerPublication !== "success"
  ) {
    return false;
  }
  if (
    !isHealthyFullSweepObservation("proposal", proposalObservation) ||
    !isHealthyFullSweepObservation("github", githubObservation)
  ) {
    return false;
  }

  const proposalVerdict = observationVerdict(proposalObservation);
  const githubVerdict = observationVerdict(githubObservation);
  if (eventName === "pull_request_target") {
    return outcomes.proposal === "success" &&
      outcomes.github === "success" &&
      proposalVerdict === "pass" &&
      githubVerdict === "pass";
  }
  if (!["push", "schedule", "workflow_dispatch"].includes(eventName)) return false;
  return (
    (outcomes.proposal === "success" && proposalVerdict === "pass") ||
    (outcomes.proposal === "failure" && proposalVerdict === "fail")
  ) && (
    (outcomes.github === "success" && githubVerdict === "pass") ||
    (outcomes.github === "failure" && githubVerdict === "fail")
  );
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main(): void {
  const [mode, ...args] = process.argv.slice(2);
  try {
    if (mode === "execution") {
      const [eventName, proposalPath, githubPath] = args;
      const outcomes: SweepExecutionOutcomes = {
        appIdentity: process.env.APP_IDENTITY_OUTCOME ?? "",
        branchProtection: process.env.BRANCH_PROTECTION_OUTCOME ?? "",
        matrix: process.env.MATRIX_OUTCOME ?? "",
        externalPublication: process.env.EXTERNAL_PUBLICATION_OUTCOME ?? "",
        controllerPublication: process.env.CONTROLLER_PUBLICATION_OUTCOME ?? "",
        proposal: process.env.PROPOSAL_OUTCOME ?? "",
        github: process.env.GITHUB_OUTCOME ?? "",
      };
      if (!isHealthySweepExecution(
        eventName,
        outcomes,
        readJson(proposalPath),
        readJson(githubPath),
      )) {
        process.exitCode = 1;
      }
      return;
    }
    const [observationPath] = args;
    if (!isHealthyFullSweepObservation(mode, readJson(observationPath))) process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
