import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ProductAvailability,
  ProductClaimState,
  ProductImplementationStatus,
  ProductRequirement,
  ProductRequirementManifest,
} from "@mendpoint/contract";

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
}

export interface ReleaseTrainBlocker {
  priority: "P1" | "P2";
  summary: string;
}

export interface ReleaseTrainPullRequest {
  number: number;
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
    | "stale_checks"
    | "stacked_unverified";
  blockers: ReleaseTrainBlocker[];
}

export interface ProductionClosureMatrix {
  schemaVersion: 1;
  canonicalRegister: {
    path: "docs/PRODUCT_REQUIREMENTS.json";
    includeAdditionalRegisterSets: true;
  };
  requirements: ProductionClosureRequirement[];
  releaseTrain: {
    observedAt: string;
    observedMainRevision: string;
    ownershipAuthority: "provisional_branch_prefix_only";
    openPullRequests: ReleaseTrainPullRequest[];
  };
}

export interface ProductionClosureMatrixIssue {
  code: string;
  subject: string;
  message: string;
}

const TEST_EVIDENCE_TYPES = new Set([
  "unit",
  "integration",
  "e2e",
  "benchmark",
  "security",
]);
const SHA = /^[a-f0-9]{40}$/;
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
 *   - observedAt must not end in ".000Z": a genuine probe reads the clock once
 *     and records sub-second precision (…T02:57:03.604Z), while a synthetic
 *     batch stamp collapses to whole-second precision;
 *   - observedAt must be within OBSERVATION_MAX_AGE_DAYS of now.
 */
export function releaseTrainObservationIssues(
  matrix: ProductionClosureMatrix,
  options: {
    revisionExists: (revision: string) => boolean;
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
  if (observedAt.endsWith(".000Z")) {
    add(
      issues,
      "RELEASE_TIMESTAMP_BATCH_STAMP",
      "releaseTrain",
      `observedAt ${observedAt} uses whole-second precision; a genuine live observation records sub-second precision`,
    );
  }
  const observedMs = Date.parse(observedAt);
  if (!Number.isNaN(observedMs)) {
    const ageMs = options.now.getTime() - observedMs;
    if (ageMs > OBSERVATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000) {
      add(
        issues,
        "RELEASE_SNAPSHOT_STALE",
        "releaseTrain",
        `observedAt ${observedAt} is older than ${OBSERVATION_MAX_AGE_DAYS} days; refresh the snapshot against current main`,
      );
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

export function validateProductionClosureMatrix(
  manifest: ProductRequirementManifest,
  matrix: ProductionClosureMatrix,
): ProductionClosureMatrixIssue[] {
  const issues: ProductionClosureMatrixIssue[] = [];
  const canonical = canonicalRequirements(manifest);
  const canonicalById = new Map(
    canonical.map((entry) => [entry.requirement.id, entry] as const),
  );
  const rowsById = new Map<string, ProductionClosureRequirement>();

  if (matrix.schemaVersion !== 1) {
    add(issues, "SCHEMA_VERSION", "matrix", "schemaVersion must equal 1");
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

  if (!SHA.test(matrix.releaseTrain?.observedMainRevision ?? "")) {
    add(
      issues,
      "RELEASE_REVISION",
      "releaseTrain",
      "observedMainRevision must be a full Git commit",
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

  const releasePrs = new Map<number, ReleaseTrainPullRequest>();
  for (const pullRequest of matrix.releaseTrain?.openPullRequests ?? []) {
    if (!Number.isInteger(pullRequest.number) || pullRequest.number < 1) {
      add(
        issues,
        "PR_REFERENCE",
        "releaseTrain",
        `invalid pull request ${pullRequest.number}`,
      );
      continue;
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
      if (!(["P1", "P2"] as const).includes(blocker.priority) || !blocker.summary.trim()) {
        add(
          issues,
          "BLOCKER_FORMAT",
          String(pullRequest.number),
          "release blockers must be nonempty P1 or P2 records",
        );
      }
    }
  }

  for (const row of matrix.requirements ?? []) {
    for (const number of row.pullRequests ?? []) {
      const pullRequest = releasePrs.get(number);
      if (number > 0 && !pullRequest) {
        add(
          issues,
          "PR_NOT_IN_RELEASE_TRAIN",
          row.requirementId,
          `pull request ${number} is absent from the open snapshot`,
        );
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
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as ProductRequirementManifest;
  const matrix = JSON.parse(
    readFileSync(matrixPath, "utf8"),
  ) as ProductionClosureMatrix;
  const issues = [
    ...releaseTrainObservationIssues(matrix, {
      revisionExists: (revision) => gitRevisionExists(root, revision),
      now: new Date(),
    }),
    ...validateProductionClosureMatrix(manifest, matrix),
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
    `PRODUCTION CLOSURE MATRIX PASS: ${matrix.requirements.length} requirements, ${matrix.releaseTrain.openPullRequests.length} open pull requests`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main();
}
