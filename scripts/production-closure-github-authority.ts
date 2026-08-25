import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type ReleaseOwnerActor = "Codex" | "Claude" | "Cursor";
export interface TrustedReviewerIdentity {
  login: string;
  userId: number;
}

export interface GitHubPullRequest {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  merge_commit_sha: string | null;
  title: string;
  html_url: string;
  body: string | null;
  user: { login: string };
  labels: Array<{ name: string }>;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

export interface GitHubIssue {
  number: number;
  state: "open" | "closed";
  title: string;
  html_url: string;
  body: string | null;
  updated_at: string;
  assignees: Array<{ login: string }>;
  pull_request?: unknown;
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  html_url: string;
}

export interface GitHubWorkflowRun {
  id: number;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  html_url: string;
}

export interface GitHubWorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

export interface GitHubReview {
  id: number;
  state: string;
  commit_id: string;
  user: { login: string; id: number };
  body: string | null;
  submitted_at: string | null;
  html_url: string;
}

export interface ProviderResolvedPullRequest {
  observationSource: "github_api";
  number: number;
  url: string;
  title: string;
  baseBranch: string;
  headBranch: string;
  owner: {
    actor: ReleaseOwnerActor;
    source: "github_label";
    label: string;
  };
  disposition: string;
  dependencies: { pullRequests: number[]; branches: string[] };
  requirementIds: string[];
  blockers: Array<{ priority: string; summary: string }>;
  remediatesPullRequests: number[];
  authorityRotation?: {
    rotationId: string;
    issuedAt: string;
    expiresAt: string;
    basePolicySha256: string;
    proposedPolicySha256: string;
  };
}

export interface StaticPullRequestRecord {
  number: number;
  state: "open" | "merged" | "closed";
  url: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  headRevision: string;
  mergeRevision: string | null;
  requirementIds: string[];
  reviewRemediationPullRequest?: number | null;
  checkState?: string;
  owner?: { actor: ReleaseOwnerActor };
  review?: {
    state: string;
    reviewedHeadRevision: string | null;
    reviewer: string | null;
    reviewId: string | null;
    url: string | null;
  };
}

export interface GitHubAuthorityMatrix {
  issueAuthority: {
    repository: string;
    issues: Array<{
      number: number;
      state: "open" | "closed";
      owner: string;
      title: string;
      url: string;
      updatedAt: string;
      requirementIds: string[];
    }>;
  };
  releaseTrain: {
    repository: string;
    observedMainRevision: string;
    pullRequests: StaticPullRequestRecord[];
    currentPullRequestBootstrap: ProviderResolvedPullRequest;
  };
}

export interface GitHubAuthorityContext {
  eventName: "pull_request" | "push";
  repository: string;
  githubSha: string;
  workflowRunId: string;
  observedAt: string;
  checkout: { headRevision: string; parentRevisions: string[] };
  pullRequest?: {
    number: number;
    baseRef: string;
    baseRevision: string;
    headRef: string;
    headRevision: string;
  };
  trustedReviewerIdentities: Partial<
    Record<ReleaseOwnerActor, TrustedReviewerIdentity[]>
  >;
}

export interface GitHubAuthorityClient {
  getMainRevision(): Promise<string>;
  listOpenPullRequests(baseBranch: string): Promise<GitHubPullRequest[]>;
  getPullRequest(number: number): Promise<GitHubPullRequest>;
  listCheckRuns(revision: string): Promise<GitHubCheckRun[]>;
  listWorkflowRuns(revision: string): Promise<GitHubWorkflowRun[]>;
  listWorkflowJobs(runId: number): Promise<GitHubWorkflowJob[]>;
  listReviews(number: number): Promise<GitHubReview[]>;
  getIssue(number: number): Promise<GitHubIssue>;
}

export interface GitHubAuthorityIssue {
  code: string;
  subject: string;
  message: string;
}

export interface GitHubAuthorityObservation {
  schemaVersion: 1;
  repository: string;
  eventName: "pull_request" | "push" | "configuration_failure";
  workflowRunId: string;
  observedAt: string;
  githubSha: string;
  checkoutRevision: string;
  mainRevisionStart: string | null;
  mainRevisionEnd: string | null;
  eventPullRequest: number | null;
  openPullRequests: number[];
  verifiedPullRequests: number[];
  verifiedIssues: number[];
  checkRunIds: number[];
  workflowRunIds: number[];
  reviewIds: number[];
  verdict: "pass" | "fail";
  issues: GitHubAuthorityIssue[];
}

interface GitHubPullRequestEvent {
  pull_request?: {
    number?: unknown;
    base?: { ref?: unknown; sha?: unknown };
    head?: { ref?: unknown; sha?: unknown };
  };
}

const REQUIRED_CHECKS = [
  "test",
  "release-gates",
  "container-builds",
  "deployment-e2e",
] as const;

function sorted<T extends string | number>(values: readonly T[]): T[] {
  return [...values].sort((left, right) =>
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right)),
  );
}

function sameValues<T extends string | number>(
  left: readonly T[],
  right: readonly T[],
): boolean {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function requirementMapping(body: string | null): string[] | null {
  if (!body) return null;
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const heading = lines.findIndex((line) => line.trim() === "## Requirement mapping");
  if (heading < 0) return null;
  const ids: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    if (!line.trim()) continue;
    const match = /^-\s+(ME-[A-Z0-9]+-\d+)$/.exec(line.trim());
    if (!match || ids.includes(match[1])) return null;
    ids.push(match[1]);
  }
  return ids.length > 0 ? sorted(ids) : null;
}

function remediationReviewScope(body: string | null): Map<number, string> | null {
  if (!body) return null;
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const heading = lines.findIndex(
    (line) => line.trim() === "## Remediation review scope",
  );
  if (heading < 0) return null;
  const scope = new Map<number, string>();
  for (const line of lines.slice(heading + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    if (!line.trim()) continue;
    const match = /^-\s+#(\d+)\s+@\s+([0-9a-f]{40})$/.exec(line.trim());
    if (!match) return null;
    const number = Number(match[1]);
    if (scope.has(number)) return null;
    scope.set(number, match[2]);
  }
  return scope.size > 0 ? scope : null;
}

function authorityRotationAttestation(body: string | null): {
  rotationId: string;
  basePolicySha256: string;
  proposedPolicySha256: string;
} | null {
  if (!body) return null;
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const heading = lines.findIndex(
    (line) => line.trim() === "## Authority rotation attestation",
  );
  if (heading < 0) return null;
  const section: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    if (line.trim()) section.push(line.trim());
  }
  if (section.length !== 3) return null;
  const rotation = /^- Rotation ID: ([a-z0-9][a-z0-9._-]{7,127})$/.exec(section[0]);
  const base = /^- Base policy: (sha256:[a-f0-9]{64})$/.exec(section[1]);
  const proposed = /^- Proposed policy: (sha256:[a-f0-9]{64})$/.exec(section[2]);
  if (!rotation || !base || !proposed) return null;
  return {
    rotationId: rotation[1],
    basePolicySha256: base[1],
    proposedPolicySha256: proposed[1],
  };
}

function canonicalGitHubTime(value: string): string | null {
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? null : new Date(milliseconds).toISOString();
}

function add(
  issues: GitHubAuthorityIssue[],
  code: string,
  subject: string,
  message: string,
): void {
  issues.push({ code, subject, message });
}

function normalizedPullRequestState(
  pullRequest: GitHubPullRequest,
): "open" | "merged" | "closed" {
  if (pullRequest.merged) return "merged";
  return pullRequest.state;
}

function trustedReviewerIdentities(
  context: GitHubAuthorityContext,
  owner: ReleaseOwnerActor,
): Map<string, number> {
  const trusted = new Map<string, number>();
  for (const [actor, identities] of Object.entries(context.trustedReviewerIdentities)) {
    if (actor === owner) continue;
    for (const identity of identities ?? []) {
      trusted.set(identity.login.toLowerCase(), identity.userId);
    }
  }
  return trusted;
}

function qualifyingReviews(
  reviews: GitHubReview[],
  headRevision: string,
  pullRequestAuthor: string,
  trustedIdentities: Map<string, number>,
): GitHubReview[] {
  const latestByReviewer = new Map<string, GitHubReview>();
  for (const review of reviews) {
    const login = review.user.login.toLowerCase();
    const existing = latestByReviewer.get(login);
    if (!existing || review.id > existing.id) latestByReviewer.set(login, review);
  }
  return [...latestByReviewer.values()]
    .filter(
      (review) =>
        review.state === "APPROVED" &&
        review.commit_id === headRevision &&
        review.user.login.toLowerCase() !== pullRequestAuthor.toLowerCase() &&
        trustedIdentities.get(review.user.login.toLowerCase()) === review.user.id,
    )
    .sort((left, right) => right.id - left.id);
}

function qualifyingReview(
  reviews: GitHubReview[],
  headRevision: string,
  pullRequestAuthor: string,
  trustedIdentities: Map<string, number>,
): GitHubReview | null {
  return qualifyingReviews(reviews, headRevision, pullRequestAuthor, trustedIdentities)[0] ?? null;
}

async function requiredChecksGreen(
  checks: GitHubCheckRun[],
  headRevision: string,
  client: GitHubAuthorityClient,
): Promise<{ valid: boolean; ids: number[]; workflowRunIds: number[] }> {
  const latestByName = new Map<string, GitHubCheckRun>();
  for (const check of checks) {
    const existing = latestByName.get(check.name);
    if (!existing || check.id > existing.id) latestByName.set(check.name, check);
  }
  const required = REQUIRED_CHECKS.map((name) => latestByName.get(name));
  const checkIds = required.flatMap((check) => (check ? [check.id] : []));
  const matchingRuns = (await client.listWorkflowRuns(headRevision))
    .filter(
      (run) =>
        run.path.split("@", 1)[0] === ".github/workflows/ci.yml" &&
        run.event === "pull_request" &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        run.head_sha === headRevision,
    )
    .sort((left, right) => right.id - left.id);
  for (const run of matchingRuns) {
    const latestByName = new Map<string, GitHubWorkflowJob>();
    for (const job of await client.listWorkflowJobs(run.id)) {
      const existing = latestByName.get(job.name);
      if (!existing || job.id > existing.id) latestByName.set(job.name, job);
    }
    const trustedJobs = REQUIRED_CHECKS.map((name) => latestByName.get(name));
    if (
      trustedJobs.every(
        (job) =>
          job?.status === "completed" &&
          job.conclusion === "success" &&
          checkIds.includes(job.id),
      )
    ) {
      return {
        valid: required.every(
          (check) =>
            check?.status === "completed" &&
            check.conclusion === "success" &&
            check.head_sha === headRevision,
        ),
        ids: checkIds,
        workflowRunIds: [run.id],
      };
    }
  }
  return {
    valid: false,
    ids: checkIds,
    workflowRunIds: matchingRuns.map((run) => run.id),
  };
}

export async function verifyGitHubClosureAuthority(
  matrix: GitHubAuthorityMatrix,
  context: GitHubAuthorityContext,
  client: GitHubAuthorityClient,
): Promise<GitHubAuthorityObservation> {
  const issues: GitHubAuthorityIssue[] = [];
  const observation: GitHubAuthorityObservation = {
    schemaVersion: 1,
    repository: context.repository,
    eventName: context.eventName,
    workflowRunId: context.workflowRunId,
    observedAt: context.observedAt,
    githubSha: context.githubSha,
    checkoutRevision: context.checkout.headRevision,
    mainRevisionStart: null,
    mainRevisionEnd: null,
    eventPullRequest: context.pullRequest?.number ?? null,
    openPullRequests: [],
    verifiedPullRequests: [],
    verifiedIssues: [],
    checkRunIds: [],
    workflowRunIds: [],
    reviewIds: [],
    verdict: "fail",
    issues,
  };
  if (
    matrix.releaseTrain.repository !== context.repository ||
    matrix.issueAuthority.repository !== context.repository
  ) {
    add(
      issues,
      "GITHUB_REPOSITORY_MISMATCH",
      "matrix",
      "matrix and workflow repository identities must match",
    );
    return observation;
  }

  try {
    observation.mainRevisionStart = await client.getMainRevision();
    const expectedMatrixMainRevision = context.eventName === "pull_request"
      ? observation.mainRevisionStart
      : context.checkout.parentRevisions[0] ?? null;
    if (matrix.releaseTrain.observedMainRevision !== expectedMatrixMainRevision) {
      add(
        issues,
        "MATRIX_MAIN_REVISION_MISMATCH",
        "releaseTrain",
        "the matrix observed main revision is not the exact PR base or pushed commit parent",
      );
    }
    const liveOpenPullRequests = await client.listOpenPullRequests("main");
    observation.openPullRequests = sorted(
      liveOpenPullRequests.map((pullRequest) => pullRequest.number),
    );
    const expectedOpen = matrix.releaseTrain.pullRequests
      .filter((pullRequest) => pullRequest.state === "open")
      .map((pullRequest) => pullRequest.number);
    if (context.eventName === "pull_request") {
      expectedOpen.push(matrix.releaseTrain.currentPullRequestBootstrap.number);
    }
    if (!sameValues(expectedOpen, observation.openPullRequests)) {
      add(
        issues,
        "OPEN_PR_COMPLETENESS_MISMATCH",
        "releaseTrain",
        `matrix open pull requests ${sorted(expectedOpen).join(",")} do not match GitHub ${observation.openPullRequests.join(",")}`,
      );
    }

    const bootstrap = matrix.releaseTrain.currentPullRequestBootstrap;
    if (
      bootstrap.blockers.length > 0 ||
      bootstrap.disposition !== "merge_after_rebase_and_review"
    ) {
      add(
        issues,
        "CURRENT_PR_NOT_MERGE_ELIGIBLE",
        String(bootstrap.number),
        "the current pull request retains blockers or a non-merge disposition",
      );
    }
    const trackedPullRequests = new Map(
      matrix.releaseTrain.pullRequests.map((record) => [record.number, record]),
    );
    for (const dependencyNumber of bootstrap.dependencies.pullRequests) {
      const dependency = trackedPullRequests.get(dependencyNumber);
      if (!dependency || dependency.state !== "merged" || !dependency.mergeRevision) {
        add(
          issues,
          "CURRENT_PR_DEPENDENCY_UNSATISFIED",
          String(bootstrap.number),
          `current pull request dependency ${dependencyNumber} is not a tracked merged revision`,
        );
      }
    }
    if (bootstrap.dependencies.branches.length > 0) {
      add(
        issues,
        "CURRENT_PR_BRANCH_DEPENDENCY_UNVERIFIED",
        String(bootstrap.number),
        "current pull request branch dependencies are not provider verified",
      );
    }
    const liveBootstrap = await client.getPullRequest(bootstrap.number);
    const expectedBootstrapState =
      context.eventName === "pull_request" ? "open" : "merged";
    const bootstrapMetadataMatches =
      liveBootstrap.number === bootstrap.number &&
      liveBootstrap.html_url === bootstrap.url &&
      liveBootstrap.title === bootstrap.title &&
      liveBootstrap.base.ref === bootstrap.baseBranch &&
      liveBootstrap.head.ref === bootstrap.headBranch &&
      normalizedPullRequestState(liveBootstrap) === expectedBootstrapState &&
      liveBootstrap.labels.some((label) => label.name === bootstrap.owner.label);
    if (!bootstrapMetadataMatches) {
      add(
        issues,
        "PR_METADATA_MISMATCH",
        String(bootstrap.number),
        "provider-resolved pull request metadata does not match its release declaration",
      );
    }
    if (
      !sameValues(
        requirementMapping(liveBootstrap.body) ?? [],
        bootstrap.requirementIds,
      )
    ) {
      add(
        issues,
        "PR_REQUIREMENT_MAPPING_MISMATCH",
        String(bootstrap.number),
        "GitHub pull request requirement mapping does not match the matrix",
      );
    }

    if (context.eventName === "pull_request") {
      const event = context.pullRequest;
      if (!event || event.number !== bootstrap.number) {
        add(
          issues,
          "PR_EVENT_NUMBER_MISMATCH",
          String(bootstrap.number),
          "workflow event does not identify the provider-resolved pull request",
        );
      } else {
        if (
          event.baseRef !== bootstrap.baseBranch ||
          event.baseRevision !== observation.mainRevisionStart ||
          event.baseRevision !== liveBootstrap.base.sha
        ) {
          add(
            issues,
            "PR_EVENT_BASE_MISMATCH",
            String(bootstrap.number),
            "event, live pull request, and current main do not share the exact base",
          );
        }
        if (
          event.headRef !== bootstrap.headBranch ||
          event.headRevision !== liveBootstrap.head.sha
        ) {
          add(
            issues,
            "PR_EVENT_HEAD_MISMATCH",
            String(bootstrap.number),
            "event and live pull request do not share the exact head",
          );
        }
        if (
          context.checkout.headRevision !== event.baseRevision ||
          context.githubSha !== event.baseRevision
        ) {
          add(
            issues,
            "CHECKOUT_REVISION_MISMATCH",
            "checkout",
            "the authority code is not executing from the exact immutable base revision",
          );
        }
      }
    } else {
      if (
        observation.mainRevisionStart !== context.githubSha ||
        liveBootstrap.merge_commit_sha !== context.githubSha
      ) {
        add(
          issues,
          "PUSH_MAIN_REVISION_MISMATCH",
          "push",
          "push revision, merged pull request, and live main are not identical",
        );
      }
      if (context.checkout.headRevision !== context.githubSha) {
        add(
          issues,
          "CHECKOUT_REVISION_MISMATCH",
          "checkout",
          "checked-out HEAD is not the pushed revision",
        );
      }
    }

    const bootstrapChecks = await requiredChecksGreen(
      await client.listCheckRuns(liveBootstrap.head.sha),
      liveBootstrap.head.sha,
      client,
    );
    observation.checkRunIds.push(...bootstrapChecks.ids);
    observation.workflowRunIds.push(...bootstrapChecks.workflowRunIds);
    if (!bootstrapChecks.valid) {
      add(
        issues,
        "PR_REQUIRED_CHECKS_NOT_GREEN",
        String(bootstrap.number),
        "required checks are not successful on the exact pull request head",
      );
    }
    const bootstrapReviews = await client.listReviews(bootstrap.number);
    const bootstrapReviewCandidates = qualifyingReviews(
      bootstrapReviews,
      liveBootstrap.head.sha,
      liveBootstrap.user.login,
      trustedReviewerIdentities(context, bootstrap.owner.actor),
    );
    const expectedRotation = bootstrap.authorityRotation;
    const bootstrapReview = expectedRotation
      ? bootstrapReviewCandidates.find((review) => {
          const attestation = authorityRotationAttestation(review.body);
          const submittedAt = Date.parse(review.submitted_at ?? "");
          return Boolean(
            attestation &&
            attestation.rotationId === expectedRotation.rotationId &&
            attestation.basePolicySha256 === expectedRotation.basePolicySha256 &&
            attestation.proposedPolicySha256 === expectedRotation.proposedPolicySha256 &&
            Number.isFinite(submittedAt) &&
            submittedAt >= Date.parse(expectedRotation.issuedAt) &&
            submittedAt <= Date.parse(expectedRotation.expiresAt)
          );
        }) ?? null
      : bootstrapReviewCandidates[0] ?? null;
    if (!bootstrapReview) {
      add(
        issues,
        "PR_EXACT_TRUSTED_REVIEW_REQUIRED",
        String(bootstrap.number),
        "an exact-head GitHub approval from a trusted reviewer distinct from the owner is required",
      );
    } else {
      observation.reviewIds.push(bootstrapReview.id);
    }
    const attestedRotation = authorityRotationAttestation(bootstrapReview?.body ?? null);
    if (
      expectedRotation &&
      (!attestedRotation ||
        attestedRotation.rotationId !== expectedRotation.rotationId ||
        attestedRotation.basePolicySha256 !== expectedRotation.basePolicySha256 ||
        attestedRotation.proposedPolicySha256 !== expectedRotation.proposedPolicySha256 ||
        !bootstrapReview?.submitted_at ||
        !Number.isFinite(Date.parse(bootstrapReview.submitted_at)) ||
        Date.parse(bootstrapReview.submitted_at) < Date.parse(expectedRotation.issuedAt) ||
        Date.parse(bootstrapReview.submitted_at) > Date.parse(expectedRotation.expiresAt))
    ) {
      add(
        issues,
        "AUTHORITY_ROTATION_REVIEW_ATTESTATION_REQUIRED",
        String(bootstrap.number),
        "authority rotation requires an exact-head base-trusted review attesting the exact rotation and policy digests",
      );
    }
    if (!expectedRotation && attestedRotation) {
      add(
        issues,
        "AUTHORITY_ROTATION_REVIEW_UNEXPECTED",
        String(bootstrap.number),
        "a non-rotation pull request cannot carry authority rotation attestation",
      );
    }
    const attestedRemediationScope = remediationReviewScope(
      bootstrapReview?.body ?? null,
    );
    observation.verifiedPullRequests.push(bootstrap.number);

    for (const record of matrix.releaseTrain.pullRequests) {
      const live = await client.getPullRequest(record.number);
      if (
        live.number !== record.number ||
        live.html_url !== record.url ||
        live.title !== record.title ||
        live.base.ref !== record.baseBranch ||
        live.head.ref !== record.headBranch ||
        live.head.sha !== record.headRevision ||
        normalizedPullRequestState(live) !== record.state ||
        (record.state === "merged" && live.merge_commit_sha !== record.mergeRevision)
      ) {
        add(
          issues,
          "PR_METADATA_MISMATCH",
          String(record.number),
          "GitHub pull request metadata does not match the tracked matrix record",
        );
      }
      if (
        !sameValues(requirementMapping(live.body) ?? [], record.requirementIds)
      ) {
        add(
          issues,
          "PR_REQUIREMENT_MAPPING_MISMATCH",
          String(record.number),
          "GitHub pull request requirement mapping does not match the matrix",
        );
      }
      if (
        record.checkState === "current_checks_green" ||
        record.checkState === "checks_green_unreviewed"
      ) {
        const exactChecks = await requiredChecksGreen(
          await client.listCheckRuns(live.head.sha),
          live.head.sha,
          client,
        );
        observation.checkRunIds.push(...exactChecks.ids);
        observation.workflowRunIds.push(...exactChecks.workflowRunIds);
        if (!exactChecks.valid) {
          add(
            issues,
            "PR_REQUIRED_CHECKS_NOT_GREEN",
            String(record.number),
            "tracked green state is not supported by exact-head GitHub checks",
          );
        }
        const liveReview = record.owner
          ? qualifyingReview(
              await client.listReviews(record.number),
              live.head.sha,
              live.user.login,
              trustedReviewerIdentities(context, record.owner.actor),
            )
          : null;
        const directReviewMatches = Boolean(
          liveReview &&
          record.review?.state === "approved" &&
          record.review.reviewedHeadRevision === live.head.sha &&
          record.review.reviewer?.toLowerCase() ===
            liveReview.user.login.toLowerCase() &&
          record.review.reviewId === String(liveReview.id) &&
          record.review.url === liveReview.html_url,
        );
        const reviewedRemediationMatches = Boolean(
          record.checkState === "checks_green_unreviewed" &&
          record.reviewRemediationPullRequest === bootstrap.number &&
          bootstrap.remediatesPullRequests.includes(record.number) &&
          bootstrapReview &&
          attestedRemediationScope?.get(record.number) === record.headRevision,
        );
        if (!directReviewMatches && !reviewedRemediationMatches) {
          add(
            issues,
            "PR_EXACT_TRUSTED_REVIEW_REQUIRED",
            String(record.number),
            "tracked green state is not supported by an exact trusted GitHub approval or the declared reviewed remediation pull request",
          );
        } else if (liveReview && directReviewMatches) {
          observation.reviewIds.push(liveReview.id);
        }
      }
      observation.verifiedPullRequests.push(record.number);
    }

    for (const record of matrix.issueAuthority.issues) {
      const live = await client.getIssue(record.number);
      const metadataMatches =
        live.pull_request === undefined &&
        live.number === record.number &&
        live.state === record.state &&
        live.title === record.title &&
        live.html_url === record.url &&
        canonicalGitHubTime(live.updated_at) === canonicalGitHubTime(record.updatedAt) &&
        live.assignees.some((assignee) => assignee.login === record.owner);
      if (!metadataMatches) {
        add(
          issues,
          "ISSUE_METADATA_MISMATCH",
          String(record.number),
          "GitHub issue metadata does not match the matrix authority record",
        );
      }
      if (!sameValues(requirementMapping(live.body) ?? [], record.requirementIds)) {
        add(
          issues,
          "ISSUE_REQUIREMENT_MAPPING_MISMATCH",
          String(record.number),
          "GitHub issue requirement mapping does not match the matrix",
        );
      }
      observation.verifiedIssues.push(record.number);
    }

    observation.mainRevisionEnd = await client.getMainRevision();
    if (observation.mainRevisionEnd !== observation.mainRevisionStart) {
      add(
        issues,
        "MAIN_CHANGED_DURING_OBSERVATION",
        "main",
        "main changed while the GitHub authority observation was running",
      );
    }
    if (
      context.eventName === "pull_request" &&
      matrix.releaseTrain.observedMainRevision !== observation.mainRevisionEnd
    ) {
      add(
        issues,
        "MATRIX_MAIN_REVISION_MISMATCH",
        "releaseTrain",
        "the matrix observed main revision changed or differs from the final live GitHub main revision",
      );
    }
  } catch {
    add(
      issues,
      "GITHUB_AUTHORITY_UNAVAILABLE",
      "github",
      "GitHub authority could not be read completely; release qualification fails closed",
    );
  }
  observation.openPullRequests = sorted(observation.openPullRequests);
  observation.verifiedPullRequests = sorted(observation.verifiedPullRequests);
  observation.verifiedIssues = sorted(observation.verifiedIssues);
  observation.checkRunIds = sorted([...new Set(observation.checkRunIds)]);
  observation.workflowRunIds = sorted([...new Set(observation.workflowRunIds)]);
  observation.reviewIds = sorted([...new Set(observation.reviewIds)]);
  observation.issues.sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      left.subject.localeCompare(right.subject) ||
      left.message.localeCompare(right.message),
  );
  observation.verdict = observation.issues.length === 0 ? "pass" : "fail";
  return observation;
}

export class GitHubRestClient implements GitHubAuthorityClient {
  private readonly apiBase = "https://api.github.com";

  constructor(
    private readonly repository: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error("invalid GitHub repository identity");
    }
    if (!token.trim()) throw new Error("GitHub token is required");
  }

  private async request<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "user-agent": "mendpoint-production-closure-authority",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub API request failed with HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const entries: T[] = [];
    for (let page = 1; ; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const batch = await this.request<unknown>(
        `${path}${separator}per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) throw new Error("GitHub list response is invalid");
      entries.push(...(batch as T[]));
      if (batch.length < 100) return entries;
    }
  }

  async getMainRevision(): Promise<string> {
    const reference = await this.request<{ object?: { sha?: unknown } }>(
      `/repos/${this.repository}/git/ref/heads/main`,
    );
    if (typeof reference.object?.sha !== "string") {
      throw new Error("GitHub main ref response is invalid");
    }
    return reference.object.sha;
  }
  async listOpenPullRequests(baseBranch: string): Promise<GitHubPullRequest[]> {
    return this.paginate<GitHubPullRequest>(
      `/repos/${this.repository}/pulls?state=open&base=${encodeURIComponent(baseBranch)}`,
    );
  }
  async getPullRequest(number: number): Promise<GitHubPullRequest> {
    return this.request<GitHubPullRequest>(
      `/repos/${this.repository}/pulls/${number}`,
    );
  }
  async listCheckRuns(revision: string): Promise<GitHubCheckRun[]> {
    const entries: GitHubCheckRun[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.request<{ check_runs?: unknown }>(
        `/repos/${this.repository}/commits/${revision}/check-runs?filter=latest&per_page=100&page=${page}`,
      );
      if (!Array.isArray(response.check_runs)) {
        throw new Error("GitHub check run response is invalid");
      }
      entries.push(...(response.check_runs as GitHubCheckRun[]));
      if (response.check_runs.length < 100) return entries;
    }
  }
  async listWorkflowRuns(revision: string): Promise<GitHubWorkflowRun[]> {
    const entries: GitHubWorkflowRun[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.request<{ workflow_runs?: unknown }>(
        `/repos/${this.repository}/actions/runs?head_sha=${revision}&per_page=100&page=${page}`,
      );
      if (!Array.isArray(response.workflow_runs)) {
        throw new Error("GitHub workflow run response is invalid");
      }
      entries.push(...(response.workflow_runs as GitHubWorkflowRun[]));
      if (response.workflow_runs.length < 100) return entries;
    }
  }
  async listWorkflowJobs(runId: number): Promise<GitHubWorkflowJob[]> {
    const entries: GitHubWorkflowJob[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.request<{ jobs?: unknown }>(
        `/repos/${this.repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
      );
      if (!Array.isArray(response.jobs)) {
        throw new Error("GitHub workflow jobs response is invalid");
      }
      entries.push(...(response.jobs as GitHubWorkflowJob[]));
      if (response.jobs.length < 100) return entries;
    }
  }
  async listReviews(number: number): Promise<GitHubReview[]> {
    return this.paginate<GitHubReview>(
      `/repos/${this.repository}/pulls/${number}/reviews`,
    );
  }
  async getIssue(number: number): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(
      `/repos/${this.repository}/issues/${number}`,
    );
  }
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function githubAuthorityContextFromEvent(
  environment: NodeJS.ProcessEnv,
  event: GitHubPullRequestEvent,
  checkout: GitHubAuthorityContext["checkout"],
  observedAt = new Date().toISOString(),
  configuredReviewerBindings?: unknown,
): GitHubAuthorityContext {
  const eventName =
    environment.MENDPOINT_CLOSURE_EVENT_NAME?.trim() ||
    requiredEnvironment(environment, "GITHUB_EVENT_NAME");
  if (eventName !== "pull_request" && eventName !== "push") {
    throw new Error("GITHUB_EVENT_NAME must be pull_request or push");
  }
  const reviewerBindings = configuredReviewerBindings ?? JSON.parse(
    requiredEnvironment(environment, "MENDPOINT_CLOSURE_TRUSTED_REVIEWERS_JSON"),
  ) as unknown;
  if (!reviewerBindings || typeof reviewerBindings !== "object") {
    throw new Error("trusted reviewer bindings must be a JSON object");
  }
  const trustedReviewerIdentities: GitHubAuthorityContext["trustedReviewerIdentities"] = {};
  const boundLogins = new Map<string, ReleaseOwnerActor>();
  for (const actor of ["Codex", "Claude", "Cursor"] as const) {
    const value = (reviewerBindings as Record<string, unknown>)[actor];
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      !value.every(
        (identity) =>
          identity &&
          typeof identity === "object" &&
          typeof (identity as Record<string, unknown>).login === "string" &&
          String((identity as Record<string, unknown>).login).trim() &&
          Number.isInteger((identity as Record<string, unknown>).userId) &&
          Number((identity as Record<string, unknown>).userId) > 0,
      )
    ) {
      throw new Error(`trusted reviewer binding ${actor} must contain exact login and userId identities`);
    }
    trustedReviewerIdentities[actor] = value.map((identity) => {
      const record = identity as Record<string, unknown>;
      const normalized = String(record.login).trim();
      const priorActor = boundLogins.get(normalized.toLowerCase());
      if (priorActor && priorActor !== actor) {
        throw new Error(
          `trusted reviewer login ${normalized} is bound to multiple agent identities`,
        );
      }
      boundLogins.set(normalized.toLowerCase(), actor);
      return { login: normalized, userId: Number(record.userId) };
    });
  }
  if (Object.keys(trustedReviewerIdentities).length === 0) {
    throw new Error("at least one trusted reviewer binding is required");
  }
  const context: GitHubAuthorityContext = {
    eventName,
    repository: requiredEnvironment(environment, "GITHUB_REPOSITORY"),
    githubSha: environment.MENDPOINT_CLOSURE_AUTHORITY_SHA?.trim() ||
      requiredEnvironment(environment, "GITHUB_SHA"),
    workflowRunId: requiredEnvironment(environment, "GITHUB_RUN_ID"),
    observedAt,
    checkout,
    trustedReviewerIdentities,
  };
  if (eventName === "pull_request") {
    const explicitPullRequestNumber = Number(environment.MENDPOINT_CLOSURE_PR_NUMBER);
    const pullRequest = Number.isInteger(explicitPullRequestNumber) && explicitPullRequestNumber > 0
      ? {
          number: explicitPullRequestNumber,
          base: {
            ref: environment.MENDPOINT_CLOSURE_PR_BASE_REF,
            sha: environment.MENDPOINT_CLOSURE_PR_BASE_SHA,
          },
          head: {
            ref: environment.MENDPOINT_CLOSURE_PR_HEAD_REF,
            sha: environment.MENDPOINT_CLOSURE_PR_HEAD_SHA,
          },
        }
      : event.pull_request;
    if (
      !pullRequest ||
      !Number.isInteger(pullRequest.number) ||
      typeof pullRequest.base?.ref !== "string" ||
      typeof pullRequest.base.sha !== "string" ||
      typeof pullRequest.head?.ref !== "string" ||
      typeof pullRequest.head.sha !== "string"
    ) {
      throw new Error("pull_request event payload is incomplete");
    }
    context.pullRequest = {
      number: pullRequest.number as number,
      baseRef: pullRequest.base.ref,
      baseRevision: pullRequest.base.sha,
      headRef: pullRequest.head.ref,
      headRevision: pullRequest.head.sha,
    };
  }
  return context;
}

export function writeGitHubAuthorityObservation(
  path: string,
  observation: GitHubAuthorityObservation,
): void {
  writeFileSync(path, `${JSON.stringify(observation, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function writeGitHubAuthorityFailureObservation(
  path: string,
  observedAt = new Date().toISOString(),
): void {
  writeGitHubAuthorityObservation(path, {
    schemaVersion: 1,
    repository: "unavailable",
    eventName: "configuration_failure",
    workflowRunId: "unavailable",
    observedAt,
    githubSha: "unavailable",
    checkoutRevision: "unavailable",
    mainRevisionStart: null,
    mainRevisionEnd: null,
    eventPullRequest: null,
    openPullRequests: [],
    verifiedPullRequests: [],
    verifiedIssues: [],
    checkRunIds: [],
    workflowRunIds: [],
    reviewIds: [],
    verdict: "fail",
    issues: [{
      code: "GITHUB_AUTHORITY_CONFIGURATION_INVALID",
      subject: "configuration",
      message: "protected GitHub authority configuration or execution failed closed",
    }],
  });
}

async function main(): Promise<void> {
  const root = resolve(process.cwd());
  const policyPath = process.env.MENDPOINT_CLOSURE_AUTHORITY_POLICY_PATH?.trim() ||
    resolve(root, "config", "production-closure-authority.json");
  const policy = JSON.parse(readFileSync(policyPath, "utf8")) as {
    repositoryId: number;
    repository: string;
    trustedReviewers: unknown;
  };
  const eventPath = requiredEnvironment(process.env, "GITHUB_EVENT_PATH");
  const observationPath = requiredEnvironment(
    process.env,
    "MENDPOINT_CLOSURE_OBSERVATION_PATH",
  );
  const event = JSON.parse(readFileSync(eventPath, "utf8")) as GitHubPullRequestEvent;
  const headRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const parentRevisions = execFileSync(
    "git",
    ["show", "-s", "--format=%P", "HEAD"],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const context = githubAuthorityContextFromEvent(
    process.env,
    event,
    { headRevision, parentRevisions },
    new Date().toISOString(),
    policy.trustedReviewers,
  );
  if (context.repository !== policy.repository) {
    throw new Error("protected authority repository does not match pinned policy");
  }
  const matrixPath = process.env.MENDPOINT_CLOSURE_MATRIX_PATH?.trim() ||
    resolve(root, "docs", "PRODUCTION_CLOSURE_MATRIX.json");
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as GitHubAuthorityMatrix;
  const client = new GitHubRestClient(
    context.repository,
    requiredEnvironment(process.env, "GITHUB_TOKEN"),
  );
  const observation = await verifyGitHubClosureAuthority(matrix, context, client);
  writeGitHubAuthorityObservation(observationPath, observation);
  if (observation.verdict === "pass") {
    console.log(
      `GITHUB PRODUCTION CLOSURE AUTHORITY PASS: ${observation.verifiedPullRequests.length} pull requests, ${observation.verifiedIssues.length} issues`,
    );
    return;
  }
  for (const issue of observation.issues) {
    console.error(`${issue.code} ${issue.subject}: ${issue.message}`);
  }
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  void main().catch(() => {
    const observationPath = process.env.MENDPOINT_CLOSURE_OBSERVATION_PATH?.trim();
    if (observationPath) {
      try {
        writeGitHubAuthorityFailureObservation(observationPath);
      } catch {
        // The console verdict below remains the final fail-closed signal when
        // even the protected artifact path is unavailable.
      }
    }
    console.error(
      "GITHUB_AUTHORITY_UNAVAILABLE github: protected GitHub authority configuration or execution failed closed",
    );
    process.exitCode = 1;
  });
}
