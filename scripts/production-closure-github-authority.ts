import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ProductImplementationStatus,
  ProductRequirementManifest,
} from "../packages/contract/src/product-requirements.js";

export type GitHubSleep = (milliseconds: number) => Promise<void>;

const GITHUB_READ_MAX_RETRIES = 2;
const GITHUB_READ_MAX_TOTAL_WAIT_MS = 180_000;

export const defaultGitHubSleep: GitHubSleep = async (milliseconds) => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

function retryAfterMilliseconds(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function responseRetryDelay(
  response: Response,
  retryIndex: number,
  now: number,
): number | null {
  const retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"), now);
  if (retryAfter !== null) return retryAfter;

  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
      return Math.max(1_000, resetSeconds * 1_000 - now + 1_000);
    }
  }

  if (response.status === 403 || response.status === 429) {
    return 60_000 * 2 ** retryIndex;
  }
  if ([502, 503, 504].includes(response.status)) {
    return 1_000 * 2 ** retryIndex;
  }
  return null;
}

export async function fetchGitHubReadWithRetry(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  sleepImpl: GitHubSleep = defaultGitHubSleep,
  now: () => number = Date.now,
): Promise<Response> {
  let totalWait = 0;
  for (let attempt = 0; attempt <= GITHUB_READ_MAX_RETRIES; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      if (attempt === GITHUB_READ_MAX_RETRIES) {
        throw new Error("GitHub API read failed before receiving an HTTP response");
      }
      const delay = 1_000 * 2 ** attempt;
      if (totalWait + delay > GITHUB_READ_MAX_TOTAL_WAIT_MS) {
        throw new Error("GitHub API read retry budget was exhausted");
      }
      totalWait += delay;
      await sleepImpl(delay);
      continue;
    }
    if (response.ok || attempt === GITHUB_READ_MAX_RETRIES) return response;
    const delay = responseRetryDelay(response, attempt, now());
    if (delay === null || totalWait + delay > GITHUB_READ_MAX_TOTAL_WAIT_MS) return response;
    await response.body?.cancel();
    totalWait += delay;
    await sleepImpl(delay);
  }
  throw new Error("GitHub API read retry budget was exhausted");
}

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
  details_url?: string | null;
  app?: { id: number } | null;
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

export interface GitHubCommitStatus {
  id: number;
  context: string;
  state: string;
  target_url: string | null;
  creator: { login: string; id: number };
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
  // See ReleaseTrainPullRequest in production-closure-matrix.ts: a closed record
  // superseded by a merged pull request that reciprocally lists it in supersedes.
  supersededBy?: number | null;
  supersedes?: number[];
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
  requirements?: Array<{
    requirementId: string;
    issues: number[];
    pullRequests: number[];
  }>;
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
  observationScope: "current_pull_request" | "full_release_train";
  providerValidationPullRequests: number[];
  providerValidationIssues: number[];
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
  // Canonical implementation status per requirement id, flattened from the
  // product requirement register (foundational + additional register sets).
  // Populated by main() from docs/PRODUCT_REQUIREMENTS.json; absent in unit
  // fixtures that do not exercise the closure-path check.
  canonicalRequirementStatuses?: Record<string, ProductImplementationStatus>;
}

export interface GitHubAuthorityClient {
  getMainRevision(): Promise<string>;
  revisionIsAncestor(revision: string, descendant: string): Promise<boolean>;
  listOpenPullRequests(baseBranch: string): Promise<GitHubPullRequest[]>;
  getPullRequest(number: number): Promise<GitHubPullRequest>;
  listCheckRuns(revision: string): Promise<GitHubCheckRun[]>;
  listWorkflowRuns(revision: string): Promise<GitHubWorkflowRun[]>;
  listWorkflowJobs(runId: number): Promise<GitHubWorkflowJob[]>;
  listReviews(number: number): Promise<GitHubReview[]>;
  listCommitStatuses(revision: string): Promise<GitHubCommitStatus[]>;
  getWorkflowRun(runId: number): Promise<GitHubWorkflowRun>;
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

const SHA = /^[0-9a-f]{40}$/;

function exactSha(revision: string): string {
  if (!SHA.test(revision)) {
    throw new Error("revision must be a full 40-character Git commit SHA");
  }
  return revision;
}

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
  kind: "runtime" | "stage_successor" | "activate_successor";
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
  if (section.length !== 4) return null;
  const rotation = /^- Rotation ID: ([a-z0-9][a-z0-9._-]{7,127})$/.exec(section[0]);
  const transition = /^- Transition: (runtime|stage_successor|activate_successor)$/.exec(section[1]);
  const base = /^- Base policy: (sha256:[a-f0-9]{64})$/.exec(section[2]);
  const proposed = /^- Proposed policy: (sha256:[a-f0-9]{64})$/.exec(section[3]);
  if (!rotation || !transition || !base || !proposed) return null;
  return {
    rotationId: rotation[1],
    kind: transition[1] as "runtime" | "stage_successor" | "activate_successor",
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

// The live-open counterpart of production-closure-matrix's
// REQUIREMENT_ACTIVE_CLOSURE_PATH_REQUIRED. That check (run locally by
// closure:check / closure:proposal:check, which have no live GitHub view)
// decides an unfinished requirement has an active closure path by trusting the
// matrix's own `state === "open"` claim for a pull request. The open-sibling
// state mirror that used to verify that claim live has been relaxed as
// unsatisfiable, so this recomputes the same determination against the live
// open-PR set instead of the recorded state. A requirement fails only when it
// is unfinished, has no open authority issue (issue state stays live-verified),
// is not carried by the current bootstrap, and none of its cited pull requests
// is actually open on GitHub — i.e. its recorded closure path points at a pull
// request that has already left the open set. One-directional and satisfiable:
// a pull request only ever leaves the open set, and once it has, that closure
// path genuinely no longer exists.
function requirementsWithoutLiveClosurePath(
  matrix: GitHubAuthorityMatrix,
  context: GitHubAuthorityContext,
  isLiveOpenPullRequest: (pullRequestNumber: number) => boolean,
): string[] {
  const statuses = context.canonicalRequirementStatuses ?? {};
  const bootstrapNumber = matrix.releaseTrain.currentPullRequestBootstrap.number;
  const issueStateByNumber = new Map(
    matrix.issueAuthority.issues.map((issue) => [issue.number, issue.state] as const),
  );
  const failing: string[] = [];
  for (const row of matrix.requirements ?? []) {
    const status = statuses[row.requirementId];
    if (status === undefined || status === "verified" || status === "retired") {
      continue;
    }
    const hasOpenIssue = row.issues.some(
      (number) => issueStateByNumber.get(number) === "open",
    );
    const hasLiveOpenPullRequest = row.pullRequests.some(
      (number) => isLiveOpenPullRequest(number) || number === bootstrapNumber,
    );
    if (!hasOpenIssue && !hasLiveOpenPullRequest) failing.push(row.requirementId);
  }
  return failing;
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
    // A PR-authored snapshot cannot pin the exact live main tip: main advances
    // after the snapshot is taken and merges to it on both the PR and push paths.
    // Require only that the recorded revision is an ancestor of the current main
    // (PR) or the pushed commit's first parent (push). This still forbids a forked
    // or fabricated revision (a fork compares "diverged"; an unresolvable revision
    // makes /compare 404 and fails closed) while tolerating that main moved on.
    // The "must be a real commit" judgment is owned by production-closure-matrix's
    // RELEASE_REVISION_UNREACHABLE check and is not duplicated here.
    const matrixMainRevisionDescendant = context.eventName === "pull_request"
      ? observation.mainRevisionStart
      : context.checkout.parentRevisions[0] ?? null;
    if (
      matrixMainRevisionDescendant === null ||
      !(await client.revisionIsAncestor(
        matrix.releaseTrain.observedMainRevision,
        matrixMainRevisionDescendant,
      ))
    ) {
      add(
        issues,
        "MATRIX_MAIN_REVISION_MISMATCH",
        "releaseTrain",
        "the matrix observed main revision is not an ancestor of live main or the pushed commit parent",
      );
    }
    // The live open-PR set is recorded for the observation artifact only. Cross-PR
    // completeness (matrix open set == live open set) was removed: it is unsatisfiable
    // by a PR-authored snapshot, because a PR authored at time T cannot enumerate a
    // sibling PR created at T+1, and every merge to main mutates the live open set out
    // from under every other snapshot. Recording an open PR that never existed still
    // fails: each verified record is resolved live below (getPullRequest), and an
    // unresolvable number makes that call fail closed. Own-bootstrap completeness stays
    // enforced by the bootstrap checks below.
    const liveOpenPullRequests = await client.listOpenPullRequests("main");
    observation.openPullRequests = sorted(
      liveOpenPullRequests.map((pullRequest) => pullRequest.number),
    );
    const liveOpenPullRequestNumbers = new Set(observation.openPullRequests);
    for (const requirementId of requirementsWithoutLiveClosurePath(
      matrix,
      context,
      (pullRequestNumber) => liveOpenPullRequestNumbers.has(pullRequestNumber),
    )) {
      add(
        issues,
        "REQUIREMENT_CLOSURE_PATH_PR_NOT_LIVE_OPEN",
        requirementId,
        "an unfinished requirement's only active closure path cites a pull request absent from the live open set",
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
    // A closed record superseded by a merged pull request that reciprocally
    // lists it discharges a dependency exactly as a merged revision does. This
    // mirrors supersededByMerged in production-closure-matrix.ts so the two
    // gates agree on what the same release-train data means.
    const supersededByMerged = (record: StaticPullRequestRecord): boolean => {
      const target = record.supersededBy ?? null;
      if (target === null || record.state !== "closed") return false;
      const superseder = trackedPullRequests.get(target);
      return Boolean(
        superseder &&
          superseder.number !== record.number &&
          superseder.state === "merged" &&
          (superseder.supersededBy ?? null) === null &&
          (superseder.supersedes ?? []).includes(record.number),
      );
    };
    for (const dependencyNumber of bootstrap.dependencies.pullRequests) {
      const dependency = trackedPullRequests.get(dependencyNumber);
      if (
        !dependency ||
        !(
          (dependency.state === "merged" && dependency.mergeRevision) ||
          supersededByMerged(dependency)
        )
      ) {
        add(
          issues,
          "CURRENT_PR_DEPENDENCY_UNSATISFIED",
          String(bootstrap.number),
          `current pull request dependency ${dependencyNumber} is not a tracked merged revision or a closed record superseded by a merged pull request`,
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

    const bootstrapCheckRuns = await client.listCheckRuns(liveBootstrap.head.sha);
    const bootstrapChecks = await requiredChecksGreen(
      bootstrapCheckRuns,
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
            attestation.kind === expectedRotation.kind &&
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
        attestedRotation.kind !== expectedRotation.kind ||
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
    if (expectedRotation?.kind === "activate_successor") {
      const successor = expectedRotation.successor;
      if (!successor) {
        add(
          issues,
          "AUTHORITY_SUCCESSOR_DECLARATION_REQUIRED",
          String(bootstrap.number),
          "successor activation requires the exact staged workflow and check identity tuple",
        );
      } else {
        const successorCheck = bootstrapCheckRuns
          .filter(
            (check) =>
              check.name === successor.externalCheckName &&
              check.status === "completed" &&
              check.conclusion === "success" &&
              check.head_sha === liveBootstrap.head.sha &&
              check.app?.id === successor.externalCheckAppId,
          )
          .sort((left, right) => right.id - left.id)[0];
        const successorStatus = (await client.listCommitStatuses(liveBootstrap.head.sha))
          .filter(
            (status) =>
              status.context === successor.controllerCheckName &&
              status.state === "success" &&
              status.creator.login.toLowerCase() ===
                successor.controllerStatusCreatorLogin.toLowerCase() &&
              status.creator.id === successor.controllerStatusCreatorUserId,
          )
          .sort((left, right) => right.id - left.id)[0];
        const checkRunId = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(
          successorCheck?.details_url ?? "",
        )?.[1];
        const statusRunId = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(
          successorStatus?.target_url ?? "",
        )?.[1];
        if (!successorCheck || !successorStatus || !checkRunId || checkRunId !== statusRunId) {
          add(
            issues,
            "AUTHORITY_SUCCESSOR_LIVE_PROOF_REQUIRED",
            successor.workflowPath,
            "successor external and controller results must be successful, exact-head, App-bound, and linked to one workflow run",
          );
        } else {
          const run = await client.getWorkflowRun(Number(checkRunId));
          if (
            run.id !== Number(checkRunId) ||
            run.path.split("@", 1)[0] !== successor.workflowPath ||
            run.event !== "pull_request_target" ||
            run.status !== "completed" ||
            run.conclusion !== "success" ||
            run.head_sha !== observation.mainRevisionStart
          ) {
            add(
              issues,
              "AUTHORITY_SUCCESSOR_WORKFLOW_PROVENANCE_INVALID",
              successor.workflowPath,
              "successor proof must come from the exact staged default-branch workflow and current base revision",
            );
          } else {
            observation.checkRunIds.push(successorCheck.id);
            observation.workflowRunIds.push(run.id);
          }
        }
      }
    }
    const attestedRemediationScope = remediationReviewScope(
      bootstrapReview?.body ?? null,
    );
    observation.verifiedPullRequests.push(bootstrap.number);

    const pullRequestsToVerify = context.observationScope === "full_release_train"
      ? matrix.releaseTrain.pullRequests
      : matrix.releaseTrain.pullRequests.filter((record) =>
        context.providerValidationPullRequests.includes(record.number)
      );
    for (const record of pullRequestsToVerify) {
      const live = await client.getPullRequest(record.number);
      // A snapshot cannot keep a live-accurate mirror of every OTHER open PR's mutable
      // metadata: siblings are retitled, re-pushed, and closed continuously, and a
      // stale mirror of a sibling says nothing about this PR's own truthfulness. So the
      // metadata/requirement mirror is enforced only for the current bootstrap (its own
      // entry, also verified above) and for records the matrix records as terminal
      // (merged or closed). The merged case is load-bearing and stays strict: a matrix
      // dependency is trusted as merged from its own record (CURRENT_PR_DEPENDENCY_*),
      // so this is the only live proof that a claimed-merged PR actually merged at the
      // recorded revision, not at some other ancestor of main. Open-state siblings are
      // no longer live-verified here; their check/review authority below still is.
      const enforceRecordMirror =
        record.number === bootstrap.number || record.state !== "open";
      if (
        enforceRecordMirror &&
        (live.number !== record.number ||
          live.html_url !== record.url ||
          live.title !== record.title ||
          live.base.ref !== record.baseBranch ||
          live.head.ref !== record.headBranch ||
          live.head.sha !== record.headRevision ||
          normalizedPullRequestState(live) !== record.state ||
          (record.state === "merged" && live.merge_commit_sha !== record.mergeRevision))
      ) {
        add(
          issues,
          "PR_METADATA_MISMATCH",
          String(record.number),
          "GitHub pull request metadata does not match the tracked matrix record",
        );
      }
      if (
        enforceRecordMirror &&
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

    const issuesToVerify = context.observationScope === "full_release_train"
      ? matrix.issueAuthority.issues
      : matrix.issueAuthority.issues.filter((record) =>
        context.providerValidationIssues.includes(record.number)
      );
    for (const record of issuesToVerify) {
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
    const finalMainRevision = observation.mainRevisionEnd;
    if (finalMainRevision !== observation.mainRevisionStart) {
      add(
        issues,
        "MAIN_CHANGED_DURING_OBSERVATION",
        "main",
        "main changed while the GitHub authority observation was running",
      );
    }
    // Same relaxation as the start-of-observation check: the recorded revision must be
    // an ancestor of the final live main, not exactly equal to it. Leaving this second
    // site strict while relaxing the first would re-fail every PR whose snapshot predates
    // the current main tip, defeating the relaxation.
    if (
      context.eventName === "pull_request" &&
      !(await client.revisionIsAncestor(
        matrix.releaseTrain.observedMainRevision,
        finalMainRevision,
      ))
    ) {
      add(
        issues,
        "MATRIX_MAIN_REVISION_MISMATCH",
        "releaseTrain",
        "the matrix observed main revision is not an ancestor of the final live GitHub main revision",
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
    private readonly sleepImpl: GitHubSleep = defaultGitHubSleep,
  ) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error("invalid GitHub repository identity");
    }
    if (!token.trim()) throw new Error("GitHub token is required");
  }

  private async request<T>(path: string): Promise<T> {
    const response = await fetchGitHubReadWithRetry(`${this.apiBase}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "user-agent": "mendpoint-production-closure-authority",
        "x-github-api-version": "2022-11-28",
      },
    }, this.fetchImpl, this.sleepImpl);
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
  async revisionIsAncestor(revision: string, descendant: string): Promise<boolean> {
    // Both inputs must be exact commit SHAs before interpolation: encodeURIComponent
    // does not encode "." "~" "-" "_" and other path-significant characters, so a
    // non-SHA argument could otherwise reshape the /compare path. Defence-in-depth;
    // the callers only ever pass recorded/observed revisions.
    const comparison = await this.request<{ status?: unknown }>(
      `/repos/${this.repository}/compare/${encodeURIComponent(exactSha(revision))}...${encodeURIComponent(exactSha(descendant))}`,
    );
    if (typeof comparison.status !== "string") {
      throw new Error("GitHub compare response is invalid");
    }
    // "ahead": descendant has commits the revision lacks -> revision is a strict
    // ancestor. "identical": they are the same commit. "behind"/"diverged": the
    // revision is not an ancestor (a fork is "diverged"). A revision that does not
    // resolve makes /compare respond 404, which throws and fails closed upstream.
    return comparison.status === "ahead" || comparison.status === "identical";
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
  async listCommitStatuses(revision: string): Promise<GitHubCommitStatus[]> {
    return this.paginate<GitHubCommitStatus>(
      `/repos/${this.repository}/commits/${revision}/statuses`,
    );
  }
  async getWorkflowRun(runId: number): Promise<GitHubWorkflowRun> {
    return this.request<GitHubWorkflowRun>(
      `/repos/${this.repository}/actions/runs/${runId}`,
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
  const workflowEventName = requiredEnvironment(environment, "GITHUB_EVENT_NAME");
  const eventName =
    environment.MENDPOINT_CLOSURE_EVENT_NAME?.trim() ||
    (workflowEventName === "pull_request_target" ? "pull_request" : workflowEventName);
  if (eventName !== "pull_request" && eventName !== "push") {
    throw new Error("GITHUB_EVENT_NAME must be pull_request or push");
  }
  // Only a pull_request_target run is discovered as a single-PR observation.
  // Scheduled and manually dispatched runs fan out across every open PR and
  // must retain their full historical provider-drift backstop even though each
  // matrix job uses the normalized pull_request execution contract.
  const observationScope = workflowEventName === "pull_request_target"
    ? "current_pull_request"
    : "full_release_train";
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
    observationScope,
    providerValidationPullRequests: [],
    providerValidationIssues: [],
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
  if (context.observationScope === "current_pull_request") {
    const runnerTemp = requiredEnvironment(process.env, "RUNNER_TEMP");
    const proposalObservationPath = resolve(
      runnerTemp,
      "production-closure-proposal-authority.json",
    );
    const proposalObservation = JSON.parse(
      readFileSync(proposalObservationPath, "utf8"),
    ) as {
      proposalRevision?: unknown;
      verdict?: unknown;
      providerValidationPullRequests?: unknown;
      providerValidationIssues?: unknown;
    };
    const exactNumbers = (value: unknown, label: string): number[] => {
      if (
        !Array.isArray(value) ||
        value.some((entry) => !Number.isInteger(entry) || entry <= 0) ||
        new Set(value).size !== value.length
      ) {
        throw new Error(`proposal ${label} provider-validation set is invalid`);
      }
      return [...value].sort((left, right) => left - right) as number[];
    };
    if (
      proposalObservation.verdict !== "pass" ||
      proposalObservation.proposalRevision !== context.pullRequest?.headRevision
    ) {
      throw new Error("proposal authority observation is not bound to the exact pull request head");
    }
    context.providerValidationPullRequests = exactNumbers(
      proposalObservation.providerValidationPullRequests,
      "pull request",
    );
    context.providerValidationIssues = exactNumbers(
      proposalObservation.providerValidationIssues,
      "issue",
    );
  }
  if (context.repository !== policy.repository) {
    throw new Error("protected authority repository does not match pinned policy");
  }
  const matrixPath = process.env.MENDPOINT_CLOSURE_MATRIX_PATH?.trim() ||
    resolve(root, "docs", "PRODUCTION_CLOSURE_MATRIX.json");
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as GitHubAuthorityMatrix;
  const requirementsPath = process.env.MENDPOINT_CLOSURE_REQUIREMENTS_PATH?.trim() ||
    resolve(root, "docs", "PRODUCT_REQUIREMENTS.json");
  const manifest = JSON.parse(
    readFileSync(requirementsPath, "utf8"),
  ) as ProductRequirementManifest;
  context.canonicalRequirementStatuses = Object.fromEntries([
    ...manifest.requirements.map(
      (requirement) => [requirement.id, requirement.implementationStatus] as const,
    ),
    ...(manifest.additionalRegisterSets ?? []).flatMap((registerSet) =>
      registerSet.requirements.map(
        (requirement) => [requirement.id, requirement.implementationStatus] as const,
      ),
    ),
  ]);
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
