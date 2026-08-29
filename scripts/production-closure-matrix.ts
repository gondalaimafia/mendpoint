import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ProductAvailability,
  ProductClaimState,
  ProductImplementationStatus,
  ProductRequirement,
  ProductRequirementManifest,
} from "../packages/contract/src/product-requirements.js";

export interface ProductionClosureStatus {
  implementationStatus: ProductImplementationStatus;
  availability: ProductAvailability;
  claimState: ProductClaimState;
}

export interface ProductionClosureRequirement {
  requirementId: string;
  registerSet: string;
  status: ProductionClosureStatus;
  issues: number[];
  pullRequests: number[];
  testEvidenceIds: string[];
  productionEvidenceIds: string[];
  productionEvidenceBindings?: ProductionEvidenceBinding[];
}

export interface ProductionEvidenceBinding {
  evidenceId: string;
  receipt: {
    schemaVersion: 1;
    evidenceId: string;
    locator: string;
    observedAt: string;
    freshUntil: string;
    deployedRevision: string;
    versionLocator: string;
    versionObservedRevision: string;
    authorityId: string;
    authorityKeyId: string;
    observationEvidence: EvidenceArtifactRef;
    versionEvidence: EvidenceArtifactRef;
    rollbackEvidence: EvidenceArtifactRef;
    failureEvidence: EvidenceArtifactRef;
  };
  receiptDigest: string;
  signature: string;
}

export interface EvidenceArtifactRef {
  locator: string;
  digest: string;
}

export interface ReleaseTrainBlocker {
  priority: "P0" | "P1" | "P2";
  summary: string;
}

export interface ProductionEvidenceTrustRoot {
  authorityId: string;
  authorityKeyId: string;
  publicKeyPem: string;
}

export interface ReleaseTrainPullRequest {
  number: number;
  state: "open" | "merged" | "closed";
  url: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  owner: {
    actor: "Codex" | "Claude" | "Cursor";
    source: "branch_prefix";
    provisional: true;
  };
  disposition:
    | "merge_after_rebase_and_review"
    | "extract_smaller_replacement"
    | "merged"
    | "superseded"
    | "blocked_explicit_dependency";
  dependencies: {
    pullRequests: number[];
    branches: string[];
  };
  requirementIds: string[];
  checkState:
    | "current_checks_green"
    | "conflicting"
    | "behind"
    | "checks_running"
    | "checks_failed"
    | "checks_green_unreviewed"
    | "stale_checks"
    | "stacked_unverified";
  headRevision: string;
  mergeRevision: string | null;
  checks: Array<{
    name: string;
    status: "completed" | "in_progress" | "queued";
    conclusion: "success" | "failure" | "skipped" | "cancelled" | null;
    headRevision: string;
    detailsUrl: string;
  }>;
  review: {
    state: "approved" | "changes_requested" | "none";
    reviewedHeadRevision: string | null;
    reviewer: string | null;
    reviewerAgent: "Codex" | "Claude" | "Cursor" | null;
    source: "github" | "claude_session" | "codex_review" | null;
    reviewId: string | null;
    url: string | null;
    submittedAt: string | null;
    attributable: boolean;
  };
  blockers: ReleaseTrainBlocker[];
  reviewRemediationPullRequest?: number | null;
  // Records that this closed pull request's work was fully subsumed by another
  // pull request that actually merged. It is the only truthful way to discharge
  // a dependent's dependency on a PR that was closed because it was superseded,
  // rather than falsely restating the closed PR as merged or silently deleting
  // the dependency edge. It is deliberately NOT a general bypass: it only
  // satisfies a dependency when it names a genuinely merged, non-superseded
  // pull request, and it is a validation error in its own right otherwise
  // (see PR_SUPERSEDED_BY_INVALID). Null or absent means "not superseded".
  supersededBy?: number | null;
}

export interface CurrentPullRequestBootstrap {
  observationSource: "github_api";
  number: number;
  url: string;
  title: string;
  baseBranch: string;
  headBranch: string;
  owner: {
    actor: "Codex" | "Claude" | "Cursor";
    source: "github_label";
    label: string;
  };
  disposition:
    | "merge_after_rebase_and_review"
    | "extract_smaller_replacement"
    | "blocked_explicit_dependency";
  dependencies: {
    pullRequests: number[];
    branches: string[];
  };
  requirementIds: string[];
  blockers: ReleaseTrainBlocker[];
  remediatesPullRequests: number[];
  authorityRotation?: {
    rotationId: string;
    kind: "runtime" | "stage_successor" | "activate_successor";
    issuedAt: string;
    expiresAt: string;
    basePolicySha256: string;
    proposedPolicySha256: string;
    successor?: {
      templatePath: string;
      workflowPath: string;
      workflowSha256: string;
      externalCheckName: string;
      externalCheckAppId: number;
      controllerCheckName: string;
      controllerCheckAppId: number;
      controllerStatusCreatorLogin: string;
      controllerStatusCreatorUserId: number;
      activationDeadline: string;
    };
  };
}

export interface IssueAuthorityRecord {
  number: number;
  state: "open" | "closed";
  owner: string;
  title: string;
  url: string;
  updatedAt: string;
  requirementIds: string[];
}

export interface ProductionClosureMatrix {
  schemaVersion: 2;
  canonicalRegister: {
    path: "docs/PRODUCT_REQUIREMENTS.json";
    includeAdditionalRegisterSets: true;
  };
  requirements: ProductionClosureRequirement[];
  productionEvidenceAuthority: {
    authorityId: string;
    authorityKeyId: string;
  } | null;
  issueAuthority: {
    provider: "github";
    repository: "gondalaimafia/mendpoint";
    observedAt: string;
    observationDigest: string;
    issues: IssueAuthorityRecord[];
  };
  releaseTrain: {
    provider: "github";
    repository: "gondalaimafia/mendpoint";
    observedAt: string;
    observedMainRevision: string;
    observationDigest: string;
    ownershipAuthority: "provisional_branch_prefix_only";
    currentPullRequestBootstrap: CurrentPullRequestBootstrap;
    pullRequests: ReleaseTrainPullRequest[];
  };
}

export interface ProductionClosureMatrixIssue {
  code: string;
  subject: string;
  message: string;
}

export interface ProductionClosureValidationOptions {
  trustedProductionEvidenceAuthorities?: readonly ProductionEvidenceTrustRoot[];
  requireCurrentPullRequestBootstrap?: boolean;
}

export function exactLegacyBootstrapMatrixAllowed(
  matrixBytes: Buffer,
  configuredDigest: string | undefined,
): boolean {
  return Boolean(
    configuredDigest &&
    SHA256.test(configuredDigest) &&
    sha256(matrixBytes) === configuredDigest,
  );
}

export function parseProductionEvidenceTrustRoots(
  value: string | undefined,
): ProductionEvidenceTrustRoot[] {
  if (!value?.trim()) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("production_evidence_trust_roots_not_array");
  const seen = new Set<string>();
  return parsed.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("production_evidence_trust_root_invalid");
    }
    const root = candidate as Record<string, unknown>;
    if (
      !nonEmptyString(root.authorityId) ||
      !SHA256.test(String(root.authorityKeyId ?? "")) ||
      !nonEmptyString(root.publicKeyPem) ||
      sha256(root.publicKeyPem) !== root.authorityKeyId
    ) {
      throw new Error("production_evidence_trust_root_invalid");
    }
    createPublicKey(root.publicKeyPem);
    const identity = `${root.authorityId}:${root.authorityKeyId}`;
    if (seen.has(identity)) throw new Error("production_evidence_trust_root_duplicate");
    seen.add(identity);
    return {
      authorityId: root.authorityId,
      authorityKeyId: root.authorityKeyId,
      publicKeyPem: root.publicKeyPem,
    };
  });
}

const TEST_EVIDENCE_TYPES = new Set([
  "unit",
  "integration",
  "e2e",
  "benchmark",
  "security",
]);
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const PR_STATES = new Set(["open", "merged", "closed"]);
const PR_DISPOSITIONS = new Set([
  "merge_after_rebase_and_review",
  "extract_smaller_replacement",
  "merged",
  "superseded",
  "blocked_explicit_dependency",
]);
const PR_CHECK_STATES = new Set([
  "current_checks_green",
  "conflicting",
  "behind",
  "checks_running",
  "checks_failed",
  "checks_green_unreviewed",
  "stale_checks",
  "stacked_unverified",
]);
const REQUIRED_RELEASE_CHECKS = [
  "test",
  "release-gates",
  "container-builds",
  "deployment-e2e",
] as const;
const ARTIFACT_LOCATOR = /^docs\/evidence\/[A-Za-z0-9._/-]+$/;
// A live observation older than this is treated as decayed: the open-PR
// snapshot is a point-in-time read that goes stale within hours, so a bounded
// age converts silent rot into a visible refresh obligation without CI needing
// network access.
const OBSERVATION_MAX_AGE_DAYS = 14;

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function artifactRefValid(value: EvidenceArtifactRef | undefined): boolean {
  return Boolean(
    value &&
      ARTIFACT_LOCATOR.test(value.locator) &&
      !value.locator.includes("..") &&
      SHA256.test(value.digest),
  );
}

export function releaseTrainIntegrityDigest(matrix: ProductionClosureMatrix): string {
  return sha256(
    canonicalJson({
      provider: matrix.releaseTrain.provider,
      repository: matrix.releaseTrain.repository,
      observedAt: matrix.releaseTrain.observedAt,
      observedMainRevision: matrix.releaseTrain.observedMainRevision,
      currentPullRequestBootstrap: matrix.releaseTrain.currentPullRequestBootstrap,
      pullRequests: matrix.releaseTrain.pullRequests,
    }),
  );
}

export function issueIntegrityDigest(matrix: ProductionClosureMatrix): string {
  return sha256(
    canonicalJson({
      provider: matrix.issueAuthority.provider,
      repository: matrix.issueAuthority.repository,
      observedAt: matrix.issueAuthority.observedAt,
      issues: matrix.issueAuthority.issues,
    }),
  );
}

function add(
  issues: ProductionClosureMatrixIssue[],
  code: string,
  subject: string,
  message: string,
) {
  issues.push({ code, subject, message });
}

function canonicalRequirements(
  manifest: ProductRequirementManifest,
): Array<{ registerSet: string; requirement: ProductRequirement }> {
  return [
    ...manifest.requirements.map((requirement) => ({
      registerSet: "foundational",
      requirement,
    })),
    ...(manifest.additionalRegisterSets ?? []).flatMap((set) =>
      set.requirements.map((requirement) => ({
        registerSet: set.key,
        requirement,
      })),
    ),
  ];
}

function evidenceFor(requirement: ProductRequirement) {
  return requirement.acceptance.flatMap((criterion) => criterion.evidence);
}

/**
 * releaseTrain.observedAt and releaseTrain.observedMainRevision both assert a
 * live observation: someone read main and the open-PR set at one instant. The
 * pure validator above can only check that the revision is well-formed
 * (SHA.test) and the timestamp parses (Date.parse); it has no repository access
 * or clock, so it cannot tell a real commit from a fabricated forty-hex string,
 * a genuine probe from a hand-entered batch stamp, or a fresh snapshot from a
 * decayed one. This does, and it mirrors the same guards public-claims-check.ts
 * applies to live claim evidence, because that is exactly where this hole first
 * appeared: a batch of PRs stamped observedAt while pinning a revision that was
 * never committed here. The rules:
 *   - a well-formed observedMainRevision must resolve to an actual commit
 *     object (malformed revisions are left to the RELEASE_REVISION format check
 *     so we do not double-report them);
 *   - observedAt must be within OBSERVATION_MAX_AGE_DAYS of now.
 */
export function releaseTrainObservationIssues(
  matrix: ProductionClosureMatrix,
  options: {
    revisionExists: (revision: string) => boolean;
    revisionIsAncestor?: (revision: string, descendant: string) => boolean;
    readArtifact?: (locator: string) => Buffer | null;
    // Whether `revisionExists` can authoritatively decide reachability of OTHER
    // open PRs' head revisions. A local object database CANNOT, because it only
    // holds the current checkout's objects. When false, absence of an open PR head
    // locally is treated as "unknown", not "unreachable", so the strict reachability
    // report is skipped for open-PR heads. Defaults to true so an omitted flag keeps
    // the strict behavior. Merge/deploy revisions are never gated by this flag: those
    // must be on main and are correctly checked locally. Note (#530): the github-
    // authority live mirror that once re-verified open-PR heads/state was removed as
    // unsatisfiable, so no caller re-verifies open-PR heads live any more; do not
    // reintroduce that expectation here.
    openPullRequestHeadsVerifiable?: boolean;
    now: Date;
  },
): ProductionClosureMatrixIssue[] {
  const issues: ProductionClosureMatrixIssue[] = [];
  const revision = matrix.releaseTrain?.observedMainRevision ?? "";
  if (SHA.test(revision) && !options.revisionExists(revision)) {
    add(
      issues,
      "RELEASE_REVISION_UNREACHABLE",
      "releaseTrain",
      `observedMainRevision ${revision} is not a commit in this repository`,
    );
  }
  const observedAt = matrix.releaseTrain?.observedAt ?? "";
  const observedMs = Date.parse(observedAt);
  if (!Number.isNaN(observedMs)) {
    const ageMs = options.now.getTime() - observedMs;
    if (ageMs < 0) {
      add(
        issues,
        "RELEASE_SNAPSHOT_FROM_FUTURE",
        "releaseTrain",
        `observedAt ${observedAt} is later than the validation clock`,
      );
    }
    if (ageMs > OBSERVATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000) {
      add(
        issues,
        "RELEASE_SNAPSHOT_STALE",
        "releaseTrain",
        `observedAt ${observedAt} is older than ${OBSERVATION_MAX_AGE_DAYS} days; refresh the snapshot against current main`,
      );
    }
  }
  for (const pullRequest of matrix.releaseTrain?.pullRequests ?? []) {
    if (
      pullRequest.state === "open" &&
      SHA.test(pullRequest.headRevision) &&
      (options.openPullRequestHeadsVerifiable ?? true) &&
      !options.revisionExists(pullRequest.headRevision)
    ) {
      add(
        issues,
        "PR_HEAD_REVISION_UNREACHABLE",
        String(pullRequest.number),
        `head revision ${pullRequest.headRevision} is not reachable in this repository`,
      );
    }
    if (
      pullRequest.state === "merged" &&
      SHA.test(pullRequest.mergeRevision ?? "") &&
      !options.revisionExists(pullRequest.mergeRevision ?? "")
    ) {
      add(
        issues,
        "PR_MERGE_REVISION_UNREACHABLE",
        String(pullRequest.number),
        `merge revision ${pullRequest.mergeRevision} is not reachable in this repository`,
      );
    }
    if (
      pullRequest.checkState === "current_checks_green" &&
      options.revisionIsAncestor
    ) {
      for (const dependencyNumber of pullRequest.dependencies.pullRequests) {
        const dependency = matrix.releaseTrain.pullRequests.find(
          (candidate) => candidate.number === dependencyNumber,
        );
        if (
          dependency?.state === "merged" &&
          !options.revisionIsAncestor(
            dependency.mergeRevision ?? "",
            matrix.releaseTrain.observedMainRevision,
          )
        ) {
          add(
            issues,
            "PR_DEPENDENCY_NOT_ON_MAIN",
            String(pullRequest.number),
            `dependency ${dependencyNumber} is not an ancestor of observed main`,
          );
        }
      }
    }
  }
  for (const row of matrix.requirements ?? []) {
    if (row.status.availability !== "ga") continue;
    for (const binding of row.productionEvidenceBindings ?? []) {
      const receipt = binding.receipt;
      if (Date.parse(receipt.observedAt) > options.now.getTime()) {
        add(
          issues,
          "GA_LIVE_EVIDENCE_FROM_FUTURE",
          row.requirementId,
          `${binding.evidenceId} was observed after the validation clock`,
        );
      }
      if (Date.parse(receipt.freshUntil) <= options.now.getTime()) {
        add(
          issues,
          "GA_LIVE_EVIDENCE_STALE",
          row.requirementId,
          `${binding.evidenceId} is past its signed freshness boundary`,
        );
      }
      if (!options.revisionExists(receipt.deployedRevision)) {
        add(
          issues,
          "GA_DEPLOYED_REVISION_UNREACHABLE",
          row.requirementId,
          `${receipt.deployedRevision} is not reachable in this repository`,
        );
      }
      for (const artifact of [
        receipt.observationEvidence,
        receipt.versionEvidence,
        receipt.rollbackEvidence,
        receipt.failureEvidence,
      ]) {
        const bytes = options.readArtifact?.(artifact.locator) ?? null;
        if (!bytes || sha256(bytes) !== artifact.digest) {
          add(
            issues,
            "GA_EVIDENCE_ARTIFACT_UNREACHABLE",
            row.requirementId,
            `${artifact.locator} is missing or its bytes do not match the signed digest`,
          );
        }
      }
      const versionBytes = options.readArtifact?.(receipt.versionEvidence.locator) ?? null;
      if (versionBytes) {
        try {
          const version = JSON.parse(versionBytes.toString("utf8")) as Record<string, unknown>;
          if (
            version.locator !== receipt.versionLocator ||
            version.observedAt !== receipt.observedAt ||
            version.revision !== receipt.deployedRevision
          ) {
            throw new Error("version binding mismatch");
          }
        } catch {
          add(
            issues,
            "GA_VERSION_EVIDENCE_INVALID",
            row.requirementId,
            `${receipt.versionEvidence.locator} does not bind the signed /version observation to the deployed revision`,
          );
        }
      }
    }
  }
  return issues;
}

function gitRevisionExists(repoRoot: string, revision: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function gitRevisionIsAncestor(
  repoRoot: string,
  revision: string,
  descendant: string,
): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", revision, descendant], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function validateProductionClosureMatrix(
  manifest: ProductRequirementManifest,
  matrix: ProductionClosureMatrix,
  options: ProductionClosureValidationOptions = {},
): ProductionClosureMatrixIssue[] {
  const issues: ProductionClosureMatrixIssue[] = [];
  const canonical = canonicalRequirements(manifest);
  const canonicalById = new Map(
    canonical.map((entry) => [entry.requirement.id, entry] as const),
  );
  const rowsById = new Map<string, ProductionClosureRequirement>();
  const authorityIssueByNumber = new Map<number, IssueAuthorityRecord>();

  if (matrix.schemaVersion !== 2) {
    add(issues, "SCHEMA_VERSION", "matrix", "schemaVersion must equal 2");
  }
  if (
    matrix.canonicalRegister?.path !== "docs/PRODUCT_REQUIREMENTS.json" ||
    matrix.canonicalRegister?.includeAdditionalRegisterSets !== true
  ) {
    add(
      issues,
      "CANONICAL_REGISTER",
      "matrix",
      "matrix must source the foundational and all additional register sets",
    );
  }
  if (
    matrix.issueAuthority?.provider !== "github" ||
    matrix.issueAuthority?.repository !== "gondalaimafia/mendpoint" ||
    !canonicalTime(matrix.issueAuthority?.observedAt) ||
    matrix.issueAuthority?.observationDigest !== issueIntegrityDigest(matrix)
  ) {
    add(
      issues,
      "ISSUE_INTEGRITY_INVALID",
      "issueAuthority",
      "the issue snapshot must have a canonical edit-integrity digest; protected GitHub verification supplies authority",
    );
  }
  for (const issue of matrix.issueAuthority?.issues ?? []) {
    if (
      !Number.isInteger(issue.number) ||
      issue.number < 1 ||
      authorityIssueByNumber.has(issue.number) ||
      !["open", "closed"].includes(issue.state) ||
      !nonEmptyString(issue.owner) ||
      !nonEmptyString(issue.title) ||
      issue.url !== `https://github.com/gondalaimafia/mendpoint/issues/${issue.number}` ||
      !canonicalTime(issue.updatedAt)
    ) {
      add(
        issues,
        "ISSUE_AUTHORITY_RECORD_INVALID",
        String(issue.number),
        "issue authority record is malformed or duplicated",
      );
    }
    authorityIssueByNumber.set(issue.number, issue);
    for (const requirementId of issue.requirementIds ?? []) {
      if (!canonicalById.has(requirementId)) {
        add(
          issues,
          "UNKNOWN_REQUIREMENT_REFERENCE",
          String(issue.number),
          `issue authority references unknown requirement ${requirementId}`,
        );
      }
    }
  }

  for (const row of matrix.requirements ?? []) {
    if (rowsById.has(row.requirementId)) {
      add(
        issues,
        "REQUIREMENT_DUPLICATE",
        row.requirementId,
        "matrix requirement is duplicated",
      );
    }
    rowsById.set(row.requirementId, row);
    const canonicalEntry = canonicalById.get(row.requirementId);
    if (!canonicalEntry) {
      add(
        issues,
        "REQUIREMENT_UNKNOWN",
        row.requirementId,
        "matrix requirement is not registered",
      );
      continue;
    }
    const requirement = canonicalEntry.requirement;
    if (row.registerSet !== canonicalEntry.registerSet) {
      add(
        issues,
        "REGISTER_SET_DRIFT",
        row.requirementId,
        `recorded ${row.registerSet}, canonical ${canonicalEntry.registerSet}`,
      );
    }
    const canonicalStatus: ProductionClosureStatus = {
      implementationStatus: requirement.implementationStatus,
      availability: requirement.availability,
      claimState: requirement.claimState,
    };
    if (JSON.stringify(row.status) !== JSON.stringify(canonicalStatus)) {
      add(
        issues,
        "STATUS_DRIFT",
        row.requirementId,
        "matrix status no longer matches the canonical register",
      );
    }

    for (const issue of row.issues ?? []) {
      if (!Number.isInteger(issue) || issue < 1) {
        add(issues, "ISSUE_REFERENCE", row.requirementId, `invalid issue ${issue}`);
      } else {
        const authority = authorityIssueByNumber.get(issue);
        if (!authority) {
          add(
            issues,
            "ISSUE_AUTHORITY_MISSING",
            row.requirementId,
            `issue ${issue} has no authoritative GitHub observation`,
          );
        } else if (!authority.requirementIds.includes(row.requirementId)) {
          add(
            issues,
            "ISSUE_REQUIREMENT_MISMATCH",
            row.requirementId,
            `issue ${issue} does not map back to the requirement`,
          );
        }
      }
    }
    for (const pullRequest of row.pullRequests ?? []) {
      if (!Number.isInteger(pullRequest) || pullRequest < 1) {
        add(
          issues,
          "PR_REFERENCE",
          row.requirementId,
          `invalid pull request ${pullRequest}`,
        );
      }
    }

    const evidence = evidenceFor(requirement);
    const evidenceById = new Map(evidence.map((item) => [item.id, item] as const));
    const canonicalTests = evidence
      .filter((item) => TEST_EVIDENCE_TYPES.has(item.type))
      .map((item) => item.id);
    const canonicalProduction = evidence
      .filter((item) => item.type === "live")
      .map((item) => item.id);
    if (!sameStrings(row.testEvidenceIds ?? [], canonicalTests)) {
      add(
        issues,
        "TEST_EVIDENCE_DRIFT",
        row.requirementId,
        "test evidence IDs must be sourced from canonical acceptance evidence",
      );
    }
    if (!sameStrings(row.productionEvidenceIds ?? [], canonicalProduction)) {
      add(
        issues,
        "PRODUCTION_EVIDENCE_DRIFT",
        row.requirementId,
        "production evidence IDs must be canonical live evidence",
      );
    }
    for (const evidenceId of [
      ...(row.testEvidenceIds ?? []),
      ...(row.productionEvidenceIds ?? []),
    ]) {
      if (!evidenceById.has(evidenceId)) {
        add(
          issues,
          "EVIDENCE_REFERENCE",
          row.requirementId,
          `unknown canonical evidence ${evidenceId}`,
        );
      }
    }
    // A "verified needs code-verifiable evidence" rule once lived here, but it
    // could never be the check that failed: the contract's stricter
    // VERIFIED_WITHOUT_CODE_EVIDENCE rule (spec:check, which runs first in
    // ga:check) forbids the same requirements over a strict subset of evidence
    // types, so any requirement this would reject is already rejected upstream.
    // A check that cannot fail reads as coverage it does not provide, so it was
    // removed rather than duplicated here.
    if (
      requirement.availability === "ga" &&
      !evidence.some((item) => item.type === "live")
    ) {
      add(
        issues,
        "GA_PRODUCTION_EVIDENCE_REQUIRED",
        row.requirementId,
        "GA requirements need canonical live production evidence",
      );
    }
    if (requirement.availability === "ga") {
      const bindings = row.productionEvidenceBindings ?? [];
      const bindingById = new Map(
        bindings.map((binding) => [binding.evidenceId, binding] as const),
      );
      if (bindingById.size !== bindings.length) {
        add(
          issues,
          "GA_LIVE_EVIDENCE_BINDING_DUPLICATE",
          row.requirementId,
          "each canonical live evidence item must have exactly one signed binding",
        );
      }
      for (const evidenceId of canonicalProduction) {
        const binding = bindingById.get(evidenceId);
        const canonicalEvidence = evidenceById.get(evidenceId);
        const receipt = binding?.receipt;
        const authority = matrix.productionEvidenceAuthority;
        const trustedAuthority = options.trustedProductionEvidenceAuthorities?.find(
          (candidate) =>
            candidate.authorityId === authority?.authorityId &&
            candidate.authorityKeyId === authority?.authorityKeyId,
        );
        const receiptBytes = receipt ? canonicalJson(receipt) : "";
        let signatureValid = false;
        try {
          signatureValid = Boolean(
            binding &&
              trustedAuthority &&
              verifySignature(
                null,
                Buffer.from(receiptBytes, "utf8"),
                createPublicKey(trustedAuthority.publicKeyPem),
                Buffer.from(binding.signature, "base64"),
              ),
          );
        } catch {
          signatureValid = false;
        }
        const observedAtMs = Date.parse(receipt?.observedAt ?? "");
        const freshUntilMs = Date.parse(receipt?.freshUntil ?? "");
        if (
          !binding ||
          !receipt ||
          !authority ||
          binding.evidenceId !== evidenceId ||
          receipt.schemaVersion !== 1 ||
          receipt.evidenceId !== evidenceId ||
          receipt.locator !== canonicalEvidence?.locator ||
          !canonicalTime(receipt.observedAt) ||
          !canonicalTime(receipt.freshUntil) ||
          freshUntilMs <= observedAtMs ||
          !SHA.test(receipt.deployedRevision) ||
          receipt.versionObservedRevision !== receipt.deployedRevision ||
          !/^https:\/\//.test(receipt.versionLocator) ||
          !receipt.versionLocator.endsWith("/version") ||
          !nonEmptyString(receipt.authorityId) ||
          receipt.authorityId !== authority?.authorityId ||
          receipt.authorityKeyId !== authority?.authorityKeyId ||
          trustedAuthority?.authorityKeyId !== sha256(trustedAuthority?.publicKeyPem ?? "") ||
          !artifactRefValid(receipt.observationEvidence) ||
          !artifactRefValid(receipt.versionEvidence) ||
          !artifactRefValid(receipt.rollbackEvidence) ||
          !artifactRefValid(receipt.failureEvidence) ||
          binding.receiptDigest !== sha256(receiptBytes) ||
          !nonEmptyString(binding.signature) ||
          !signatureValid
        ) {
          add(
            issues,
            binding ? "GA_LIVE_EVIDENCE_BINDING_INVALID" : "GA_LIVE_EVIDENCE_BINDING_REQUIRED",
            row.requirementId,
            `live evidence ${evidenceId} must have a valid signed receipt binding exact observation, version response, deployed revision, authority, rollback, and failure artifacts`,
          );
        }
      }
      for (const binding of bindings) {
        if (!canonicalProduction.includes(binding.evidenceId)) {
          add(
            issues,
            "GA_LIVE_EVIDENCE_BINDING_UNKNOWN",
            row.requirementId,
            `binding ${binding.evidenceId} is not canonical live evidence`,
          );
        }
      }
    }

    if (
      !["verified", "retired"].includes(requirement.implementationStatus) &&
      (row.issues?.length ?? 0) === 0 &&
      (row.pullRequests?.length ?? 0) === 0
    ) {
      add(
        issues,
        "REQUIREMENT_CLOSURE_PATH_REQUIRED",
        row.requirementId,
        "unfinished requirements need at least one owned issue or pull request",
      );
    }
  }

  for (const requirementId of canonicalById.keys()) {
    if (!rowsById.has(requirementId)) {
      add(
        issues,
        "REQUIREMENT_MISSING",
        requirementId,
        "registered requirement is missing from the matrix",
      );
    }
  }
  for (const issue of authorityIssueByNumber.values()) {
    for (const requirementId of issue.requirementIds) {
      const row = rowsById.get(requirementId);
      if (row && !row.issues.includes(issue.number)) {
        add(
          issues,
          "ISSUE_REQUIREMENT_MISMATCH",
          String(issue.number),
          `requirement ${requirementId} does not map back to the issue`,
        );
      }
    }
  }

  if (!SHA.test(matrix.releaseTrain?.observedMainRevision ?? "")) {
    add(
      issues,
      "RELEASE_REVISION",
      "releaseTrain",
      "observedMainRevision must be a full Git commit",
    );
  }
  if (
    matrix.releaseTrain?.provider !== "github" ||
    matrix.releaseTrain?.repository !== "gondalaimafia/mendpoint" ||
    matrix.releaseTrain?.observationDigest !== releaseTrainIntegrityDigest(matrix)
  ) {
    add(
      issues,
      "RELEASE_INTEGRITY_INVALID",
      "releaseTrain",
      "the release snapshot must have a canonical edit-integrity digest; protected GitHub verification supplies authority",
    );
  }
  if (Number.isNaN(Date.parse(matrix.releaseTrain?.observedAt ?? ""))) {
    add(
      issues,
      "RELEASE_TIMESTAMP",
      "releaseTrain",
      "observedAt must be an ISO timestamp",
    );
  }
  if (matrix.releaseTrain?.ownershipAuthority !== "provisional_branch_prefix_only") {
    add(
      issues,
      "OWNER_AUTHORITY",
      "releaseTrain",
      "branch-prefix ownership must remain explicitly provisional",
    );
  }

  const currentBootstrap = matrix.releaseTrain?.currentPullRequestBootstrap;
  if (
    (options.requireCurrentPullRequestBootstrap === true && !currentBootstrap) ||
    (currentBootstrap !== undefined && (
      currentBootstrap.observationSource !== "github_api" ||
      !Number.isInteger(currentBootstrap.number) ||
      currentBootstrap.number < 1 ||
      currentBootstrap.url !==
        `https://github.com/gondalaimafia/mendpoint/pull/${currentBootstrap.number}` ||
      !nonEmptyString(currentBootstrap.title) ||
      currentBootstrap.baseBranch !== "main" ||
      !nonEmptyString(currentBootstrap.headBranch) ||
      currentBootstrap.owner?.source !== "github_label" ||
      currentBootstrap.owner?.label !==
        `release-owner:${currentBootstrap.owner?.actor?.toLowerCase()}` ||
      !["merge_after_rebase_and_review", "extract_smaller_replacement", "blocked_explicit_dependency"].includes(
        currentBootstrap.disposition,
      )
    ))
  ) {
    add(
      issues,
      "CURRENT_PR_BOOTSTRAP_INVALID",
      "releaseTrain",
      "the current pull request needs a provider-resolved GitHub bootstrap with exact static ownership and mapping fields",
    );
  }
  const authorityRotation = currentBootstrap?.authorityRotation;
  if (
    authorityRotation !== undefined &&
    (
      !/^[a-z0-9][a-z0-9._-]{7,127}$/.test(authorityRotation.rotationId) ||
      !["runtime", "stage_successor", "activate_successor"].includes(authorityRotation.kind) ||
      !canonicalTime(authorityRotation.issuedAt) ||
      !canonicalTime(authorityRotation.expiresAt) ||
      !SHA256.test(authorityRotation.basePolicySha256) ||
      !SHA256.test(authorityRotation.proposedPolicySha256) ||
      (authorityRotation.kind === "runtime" && authorityRotation.successor !== undefined) ||
      (authorityRotation.kind !== "runtime" && (
        !authorityRotation.successor ||
        !/^config\/production-closure-successors\/closure-authority-[a-z0-9-]+\.yml$/.test(authorityRotation.successor.templatePath) ||
        !/^\.github\/workflows\/closure-authority-[a-z0-9-]+\.yml$/.test(authorityRotation.successor.workflowPath) ||
        authorityRotation.successor.templatePath.split("/").at(-1) !== authorityRotation.successor.workflowPath.split("/").at(-1) ||
        !SHA256.test(authorityRotation.successor.workflowSha256) ||
        !authorityRotation.successor.externalCheckName?.trim() ||
        !Number.isInteger(authorityRotation.successor.externalCheckAppId) ||
        authorityRotation.successor.externalCheckAppId < 1 ||
        !authorityRotation.successor.controllerCheckName?.trim() ||
        !Number.isInteger(authorityRotation.successor.controllerCheckAppId) ||
        authorityRotation.successor.controllerCheckAppId < 1 ||
        !authorityRotation.successor.controllerStatusCreatorLogin?.trim() ||
        !Number.isInteger(authorityRotation.successor.controllerStatusCreatorUserId) ||
        authorityRotation.successor.controllerStatusCreatorUserId < 1 ||
        !canonicalTime(authorityRotation.successor.activationDeadline)
      ))
    )
  ) {
    add(
      issues,
      "CURRENT_PR_AUTHORITY_ROTATION_INVALID",
      String(currentBootstrap?.number ?? "releaseTrain"),
      "authority rotation metadata must bind an exact rotation and base and proposed policy digests",
    );
  }
  for (const requirementId of currentBootstrap?.requirementIds ?? []) {
    if (!canonicalById.has(requirementId)) {
      add(
        issues,
        "UNKNOWN_REQUIREMENT_REFERENCE",
        String(currentBootstrap?.number),
        `current pull request references unknown requirement ${requirementId}`,
      );
    }
  }
  for (const blocker of currentBootstrap?.blockers ?? []) {
    if (!(["P0", "P1", "P2"] as const).includes(blocker.priority) || !blocker.summary.trim()) {
      add(
        issues,
        "BLOCKER_FORMAT",
        String(currentBootstrap?.number),
        "release blockers must be nonempty P0, P1, or P2 records",
      );
    }
  }
  if ((currentBootstrap?.blockers.length ?? 0) > 0) {
    add(
      issues,
      "CURRENT_PR_BLOCKED",
      String(currentBootstrap?.number ?? "releaseTrain"),
      "the current pull request cannot qualify while any P0, P1, or P2 blocker remains",
    );
  }
  if (
    currentBootstrap &&
    currentBootstrap.disposition !== "merge_after_rebase_and_review"
  ) {
    add(
      issues,
      "CURRENT_PR_NOT_MERGE_ELIGIBLE",
      String(currentBootstrap.number),
      "the current pull request must have the merge-after-rebase-and-review disposition to qualify",
    );
  }

  const releasePrs = new Map<number, ReleaseTrainPullRequest>();
  for (const pullRequest of matrix.releaseTrain?.pullRequests ?? []) {
    if (!Number.isInteger(pullRequest.number) || pullRequest.number < 1) {
      add(
        issues,
        "PR_REFERENCE",
        "releaseTrain",
        `invalid pull request ${pullRequest.number}`,
      );
      continue;
    }
    if (
      pullRequest.url !==
      `https://github.com/gondalaimafia/mendpoint/pull/${pullRequest.number}`
    ) {
      add(
        issues,
        "PR_AUTHORITY_URL_INVALID",
        String(pullRequest.number),
        "pull request authority URL must identify the exact repository pull request",
      );
    }
    if (releasePrs.has(pullRequest.number)) {
      add(
        issues,
        "PR_DUPLICATE",
        String(pullRequest.number),
        "release-train pull request is duplicated",
      );
    }
    releasePrs.set(pullRequest.number, pullRequest);
    if (pullRequest.number === currentBootstrap?.number) {
      add(
        issues,
        "CURRENT_PR_BOOTSTRAP_DUPLICATE",
        String(pullRequest.number),
        "the provider-resolved current pull request must not duplicate a static snapshot record",
      );
    }
    if (!PR_STATES.has(pullRequest.state)) {
      add(
        issues,
        "PR_STATE",
        String(pullRequest.number),
        "pull request state must be open, merged, or closed",
      );
    }
    if (!PR_DISPOSITIONS.has(pullRequest.disposition)) {
      add(
        issues,
        "PR_DISPOSITION",
        String(pullRequest.number),
        "pull request disposition is not recognized",
      );
    }
    if (!PR_CHECK_STATES.has(pullRequest.checkState)) {
      add(
        issues,
        "PR_CHECK_STATE",
        String(pullRequest.number),
        "pull request check state is not recognized",
      );
    }
    if (!SHA.test(pullRequest.headRevision ?? "")) {
      add(
        issues,
        "PR_HEAD_REVISION_REQUIRED",
        String(pullRequest.number),
        "every tracked pull request must bind its exact head revision",
      );
    }
    if (
      (pullRequest.state === "merged" &&
        !SHA.test(pullRequest.mergeRevision ?? "")) ||
      (pullRequest.state !== "merged" && pullRequest.mergeRevision !== null)
    ) {
      add(
        issues,
        "PR_MERGE_REVISION_REQUIRED",
        String(pullRequest.number),
        "merged pull requests need an exact merge revision and non-merged pull requests must keep it null",
      );
    }
    const checks = pullRequest.checks ?? [];
    const checkNames = new Set<string>();
    for (const check of checks) {
      if (
        !nonEmptyString(check.name) ||
        checkNames.has(check.name) ||
        !["completed", "in_progress", "queued"].includes(check.status) ||
        !["success", "failure", "skipped", "cancelled", null].includes(
          check.conclusion,
        ) ||
        check.headRevision !== pullRequest.headRevision ||
        !/^https:\/\/github\.com\/gondalaimafia\/mendpoint\/actions\//.test(
          check.detailsUrl,
        )
      ) {
        add(
          issues,
          "PR_CHECK_RECORD_INVALID",
          String(pullRequest.number),
          "check records must be unique, typed, GitHub sourced, and bound to the exact head",
        );
      }
      checkNames.add(check.name);
    }
    if (
      ["current_checks_green", "checks_green_unreviewed"].includes(
        pullRequest.checkState,
      ) &&
      !REQUIRED_RELEASE_CHECKS.every((name) =>
        checks.some(
          (check) =>
            check.name === name &&
            check.status === "completed" &&
            check.conclusion === "success" &&
            check.headRevision === pullRequest.headRevision,
        ),
      )
    ) {
      add(
        issues,
        "PR_REQUIRED_CHECKS_MISSING",
        String(pullRequest.number),
        "green state requires successful test, release-gates, container-builds, and deployment-e2e records on the exact head",
      );
    }
    const review = pullRequest.review;
    const reviewSourceUrlValid =
      review?.source === null ||
      (review?.source === "claude_session" &&
        /^https:\/\/claude\.ai\/code\/session_/.test(review.url ?? "")) ||
      ((review?.source === "github" || review?.source === "codex_review") &&
        /^https:\/\/github\.com\/gondalaimafia\/mendpoint\//.test(
          review.url ?? "",
        ));
    if (
      !review ||
      !["approved", "changes_requested", "none"].includes(review.state) ||
      (review.state === "none" &&
        (review.reviewedHeadRevision !== null ||
          review.reviewer !== null ||
          review.reviewerAgent !== null ||
          review.source !== null ||
          review.reviewId !== null ||
          review.url !== null ||
          review.submittedAt !== null ||
          review.attributable !== false)) ||
      (review.state !== "none" &&
        (!SHA.test(review.reviewedHeadRevision ?? "") ||
          !nonEmptyString(review.reviewer) ||
          !["Codex", "Claude", "Cursor"].includes(review.reviewerAgent ?? "") ||
          review.reviewerAgent === pullRequest.owner.actor ||
          !["github", "claude_session", "codex_review"].includes(
            review.source ?? "",
          ) ||
          !nonEmptyString(review.reviewId) ||
          !reviewSourceUrlValid ||
          !canonicalTime(review.submittedAt) ||
          review.attributable !== true))
    ) {
      add(
        issues,
        "PR_REVIEW_RECORD_REQUIRED",
        String(pullRequest.number),
        "every tracked pull request needs a well-formed attributable review record or an explicit none state",
      );
    }
    if (
      pullRequest.state === "open" &&
      ["merged", "superseded"].includes(pullRequest.disposition)
    ) {
      add(
        issues,
        "PR_DISPOSITION_STATE",
        String(pullRequest.number),
        "an open pull request needs an active release disposition",
      );
    }
    if (pullRequest.state === "merged" && pullRequest.disposition !== "merged") {
      add(
        issues,
        "PR_DISPOSITION_STATE",
        String(pullRequest.number),
        "a merged pull request must use the merged disposition",
      );
    }
    if (pullRequest.state === "closed" && pullRequest.disposition !== "superseded") {
      add(
        issues,
        "PR_DISPOSITION_STATE",
        String(pullRequest.number),
        "a closed pull request must use the superseded disposition",
      );
    }
    if (pullRequest.checkState === "current_checks_green") {
      if (
        !SHA.test(pullRequest.headRevision ?? "") ||
        review?.state !== "approved" ||
        review.reviewedHeadRevision !== pullRequest.headRevision ||
        !review.reviewer?.trim() ||
        review.attributable !== true
      ) {
        add(
          issues,
          "PR_EXACT_REVIEW_REQUIRED",
          String(pullRequest.number),
          "current green checks require an attributable approval bound to the exact head revision",
        );
      }
      if (pullRequest.blockers.length > 0) {
        add(
          issues,
          "PR_GREEN_WITH_BLOCKERS",
          String(pullRequest.number),
          "current green checks cannot retain unresolved P0, P1, or P2 blockers",
        );
      }
    }
    if (
      pullRequest.owner?.source !== "branch_prefix" ||
      pullRequest.owner?.provisional !== true
    ) {
      add(
        issues,
        "OWNER_AUTHORITY",
        String(pullRequest.number),
        "branch-prefix owner must be marked provisional",
      );
    }
    for (const dependency of pullRequest.dependencies?.pullRequests ?? []) {
      if (!Number.isInteger(dependency) || dependency < 1) {
        add(
          issues,
          "PR_REFERENCE",
          String(pullRequest.number),
          `invalid dependency pull request ${dependency}`,
        );
      }
      if (dependency === pullRequest.number) {
        add(
          issues,
          "PR_DEPENDENCY_SELF",
          String(pullRequest.number),
          "a pull request cannot depend on itself",
        );
      }
    }
    for (const requirementId of pullRequest.requirementIds ?? []) {
      if (!canonicalById.has(requirementId)) {
        add(
          issues,
          "UNKNOWN_REQUIREMENT_REFERENCE",
          String(pullRequest.number),
          `unknown requirement ${requirementId}`,
        );
      }
    }
    for (const blocker of pullRequest.blockers ?? []) {
      if (!(["P0", "P1", "P2"] as const).includes(blocker.priority) || !blocker.summary.trim()) {
        add(
          issues,
          "BLOCKER_FORMAT",
          String(pullRequest.number),
          "release blockers must be nonempty P0, P1, or P2 records",
        );
      }
    }
  }

  // A closed record's supersededBy genuinely discharges a dependency only when
  // it names a DIFFERENT tracked pull request that actually merged in its own
  // right and is not itself superseded. Guardrails, in order:
  //   - it may appear only on a closed record: a merged or open record carrying
  //     it is incoherent (a merged PR discharges dependents by being merged; an
  //     open one has not been superseded by anything yet);
  //   - the target must exist in the manifest, be a different PR, and be merged;
  //   - transitivity is forbidden: the target must have merged directly, so it
  //     cannot itself carry supersededBy. Because a merged record can never
  //     carry supersededBy, no chain or cycle can form and this single,
  //     non-recursive lookup cannot stack-overflow.
  // The same predicate gates both the discharge and the PR_SUPERSEDED_BY_INVALID
  // error, so a supersededBy either satisfies AND is valid, or does neither and
  // is rejected; it can never be silently ignored.
  const supersededByMerged = (record: ReleaseTrainPullRequest): boolean => {
    const target = record.supersededBy ?? null;
    if (target === null) return false;
    if (record.state !== "closed") return false;
    const superseder = releasePrs.get(target);
    return Boolean(
      superseder &&
        superseder.number !== record.number &&
        superseder.state === "merged" &&
        (superseder.supersededBy ?? null) === null,
    );
  };
  for (const pullRequest of releasePrs.values()) {
    if ((pullRequest.supersededBy ?? null) !== null && !supersededByMerged(pullRequest)) {
      add(
        issues,
        "PR_SUPERSEDED_BY_INVALID",
        String(pullRequest.number),
        "supersededBy may appear only on a closed pull request and must name a different tracked pull request that is itself merged and not superseded",
      );
    }
    if (pullRequest.state === "merged" && pullRequest.blockers.length > 0) {
      add(
        issues,
        "PR_MERGED_WITH_BLOCKERS",
        String(pullRequest.number),
        "merged pull requests cannot retain unresolved P0, P1, or P2 blockers",
      );
    }
    if (
      pullRequest.state === "merged" &&
      pullRequest.checkState === "checks_green_unreviewed" &&
      !(
        pullRequest.review.state === "approved" &&
        pullRequest.review.reviewedHeadRevision === pullRequest.headRevision &&
        pullRequest.review.attributable === true
      )
    ) {
      const remediationNumber = pullRequest.reviewRemediationPullRequest;
      if (
        remediationNumber !== currentBootstrap?.number ||
        !currentBootstrap?.remediatesPullRequests.includes(pullRequest.number)
      ) {
        add(
          issues,
          "PR_MERGED_REVIEW_REQUIRED",
          String(pullRequest.number),
          "a materially unreviewed merged pull request needs an exact-head review or an explicitly linked provider-verified remediation pull request",
        );
      }
    }
    for (const dependencyNumber of pullRequest.dependencies.pullRequests) {
      const dependency = releasePrs.get(dependencyNumber);
      if (!dependency) {
        add(
          issues,
          "PR_DEPENDENCY_UNTRACKED",
          String(pullRequest.number),
          `dependency ${dependencyNumber} is absent from the release-train integrity manifest`,
        );
      } else if (
        (pullRequest.state === "merged" ||
          pullRequest.checkState === "current_checks_green") &&
        dependency.state !== "merged" &&
        !supersededByMerged(dependency)
      ) {
        add(
          issues,
          "PR_DEPENDENCY_UNSATISFIED",
          String(pullRequest.number),
          `dependency ${dependencyNumber} must be merged or superseded by a merged pull request before this pull request can be release eligible`,
        );
      }
    }
  }
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visitDependency = (number: number) => {
    if (visiting.has(number)) {
      add(
        issues,
        "PR_DEPENDENCY_CYCLE",
        String(number),
        "pull request dependencies contain a cycle",
      );
      return;
    }
    if (visited.has(number)) return;
    visiting.add(number);
    for (const dependency of releasePrs.get(number)?.dependencies.pullRequests ?? []) {
      if (releasePrs.has(dependency)) visitDependency(dependency);
    }
    visiting.delete(number);
    visited.add(number);
  };
  for (const number of releasePrs.keys()) visitDependency(number);

  for (const row of matrix.requirements ?? []) {
    const canonicalEntry = canonicalById.get(row.requirementId);
    if (
      canonicalEntry &&
      !["verified", "retired"].includes(
        canonicalEntry.requirement.implementationStatus,
      )
    ) {
      const hasOpenIssue = row.issues.some(
        (number) => authorityIssueByNumber.get(number)?.state === "open",
      );
      const hasOpenPullRequest = row.pullRequests.some(
        (number) =>
          releasePrs.get(number)?.state === "open" ||
          number === currentBootstrap?.number,
      );
      if (!hasOpenIssue && !hasOpenPullRequest) {
        add(
          issues,
          "REQUIREMENT_ACTIVE_CLOSURE_PATH_REQUIRED",
          row.requirementId,
          "unfinished requirements need an open authoritative issue or pull request",
        );
      }
    }
  }

  for (const row of matrix.requirements ?? []) {
    for (const number of row.pullRequests ?? []) {
      const pullRequest = releasePrs.get(number);
      if (number > 0 && !pullRequest) {
        if (
          number !== currentBootstrap?.number ||
          !currentBootstrap.requirementIds.includes(row.requirementId)
        ) {
          add(
            issues,
            "PR_NOT_IN_RELEASE_TRAIN",
            row.requirementId,
            `pull request ${number} is absent from the release-train integrity manifest`,
          );
        }
      } else if (pullRequest && !pullRequest.requirementIds.includes(row.requirementId)) {
        add(
          issues,
          "PR_REQUIREMENT_MISMATCH",
          row.requirementId,
          `pull request ${number} does not map back to the requirement`,
        );
      }
    }
  }
  for (const pullRequest of releasePrs.values()) {
    for (const requirementId of pullRequest.requirementIds) {
      const row = rowsById.get(requirementId);
      if (row && !row.pullRequests.includes(pullRequest.number)) {
        add(
          issues,
          "PR_REQUIREMENT_MISMATCH",
          String(pullRequest.number),
          `requirement ${requirementId} does not map back to the pull request`,
        );
      }
    }
  }
  for (const requirementId of currentBootstrap?.requirementIds ?? []) {
    const row = rowsById.get(requirementId);
    if (row && !row.pullRequests.includes(currentBootstrap.number)) {
      add(
        issues,
        "PR_REQUIREMENT_MISMATCH",
        String(currentBootstrap.number),
        `requirement ${requirementId} does not map back to the current pull request`,
      );
    }
  }
  for (const remediatedNumber of currentBootstrap?.remediatesPullRequests ?? []) {
    const remediated = releasePrs.get(remediatedNumber);
    if (!remediated || remediated.state !== "merged") {
      add(
        issues,
        "CURRENT_PR_REMEDIATION_INVALID",
        String(currentBootstrap.number),
        `remediated pull request ${remediatedNumber} must be a tracked merged pull request`,
      );
    }
  }
  for (const dependencyNumber of currentBootstrap?.dependencies.pullRequests ?? []) {
    const dependency = releasePrs.get(dependencyNumber);
    if (!dependency || dependency.state !== "merged" || !dependency.mergeRevision) {
      add(
        issues,
        "CURRENT_PR_DEPENDENCY_UNSATISFIED",
        String(currentBootstrap?.number),
        `current pull request dependency ${dependencyNumber} is not a tracked merged revision`,
      );
    }
  }
  if ((currentBootstrap?.dependencies.branches.length ?? 0) > 0) {
    add(
      issues,
      "CURRENT_PR_BRANCH_DEPENDENCY_UNVERIFIED",
      String(currentBootstrap?.number),
      "current pull request branch dependencies require provider verification and cannot qualify structurally",
    );
  }

  return issues.sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      left.subject.localeCompare(right.subject) ||
      left.message.localeCompare(right.message),
  );
}

function main() {
  const root = resolve(process.cwd());
  const manifestPath = resolve(root, "docs", "PRODUCT_REQUIREMENTS.json");
  const matrixPath = resolve(root, "docs", "PRODUCTION_CLOSURE_MATRIX.json");
  if (!existsSync(manifestPath) || !existsSync(matrixPath)) {
    console.error("PRODUCTION CLOSURE MATRIX FAIL: required JSON file is missing");
    process.exit(1);
  }
  const matrixBytes = readFileSync(matrixPath);
  const policyPath = resolve(root, "config", "production-closure-authority.json");
  const policy = existsSync(policyPath)
    ? JSON.parse(readFileSync(policyPath, "utf8")) as { legacyBootstrapMatrixDigest?: string }
    : {};
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as ProductRequirementManifest;
  const matrix = JSON.parse(matrixBytes.toString("utf8")) as ProductionClosureMatrix;
  if (
    (matrix as { schemaVersion: number }).schemaVersion === 1 &&
    exactLegacyBootstrapMatrixAllowed(matrixBytes, policy.legacyBootstrapMatrixDigest)
  ) {
    console.log(
      "PRODUCTION CLOSURE BOOTSTRAP PASS: exact pinned legacy matrix retained; protected proposal authority still requires schema v2",
    );
    return;
  }
  const issues = [
    ...releaseTrainObservationIssues(matrix, {
      revisionExists: (revision) => gitRevisionExists(root, revision),
      revisionIsAncestor: (revision, descendant) =>
        gitRevisionIsAncestor(root, revision, descendant),
      readArtifact: (locator) => {
        if (!ARTIFACT_LOCATOR.test(locator) || locator.includes("..")) return null;
        const artifactPath = resolve(root, locator);
        return existsSync(artifactPath) ? readFileSync(artifactPath) : null;
      },
      // A local object database cannot see OTHER branches' open-PR heads: a
      // force-pushed head becomes a dangling commit that no checkout fetches,
      // so "absent locally" is NOT "absent on GitHub". Treating it as absence
      // is the third-state collapse documented in docs/agents/FAILURE_MODES.md
      // ("didn't look" masquerading as "looks bad"), and it fails ga:check on
      // every branch whenever any open PR is force-pushed. Open-PR head/state
      // is deliberately NOT re-verified live either (#530): the github-authority
      // open-sibling mirror was removed as unsatisfiable. Open-PR head reachability
      // is therefore not owned by any check; what remains live-guarded is the
      // merged-record binding and REQUIREMENT_CLOSURE_PATH_PR_NOT_LIVE_OPEN.
      openPullRequestHeadsVerifiable: false,
      now: new Date(),
    }),
    ...validateProductionClosureMatrix(manifest, matrix, {
      trustedProductionEvidenceAuthorities: parseProductionEvidenceTrustRoots(
        process.env.MENDPOINT_PRODUCTION_EVIDENCE_TRUST_ROOTS_JSON,
      ),
    }),
  ];
  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`${issue.code} ${issue.subject}: ${issue.message}`);
    }
    console.error(
      `PRODUCTION CLOSURE MATRIX FAIL: ${issues.length} issue${issues.length === 1 ? "" : "s"}`,
    );
    process.exit(1);
  }
  console.log(
    `PRODUCTION CLOSURE STRUCTURE PASS: ${matrix.requirements.length} requirements, ${matrix.releaseTrain.pullRequests.length} static pull requests${matrix.releaseTrain.currentPullRequestBootstrap ? `, current PR ${matrix.releaseTrain.currentPullRequestBootstrap.number}` : ""}; protected GitHub authority verification is still required`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main();
}
