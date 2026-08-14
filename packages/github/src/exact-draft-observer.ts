import type { Octokit } from "@octokit/rest";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export type ExactDraftObservationInput = Readonly<{
  owner: string;
  repo: string;
  pullRequestNumber: number;
  expectedBaseBranch: string;
  expectedBaseSha: string;
  expectedHeadBranch: string;
  expectedHeadSha: string;
  expectedRepositoryId?: number;
  requireExactDraft?: boolean;
  includeCommitStatuses?: boolean;
}>;

export type ExactDraftFailure = Readonly<{
  kind: "check_run" | "commit_status";
  id: string;
  publisherId: number | null;
  name: string;
  state: "failure";
  title: string | null;
  summary: string | null;
  text: string | null;
  detailsUrl: string | null;
}>;

export type ExactDraftCheckResult = Readonly<{
  identity: string;
  state: "success" | "failure" | "running";
}>;

export type ExactDraftChangeRequest = Readonly<{
  id: string;
  reviewer: string;
  commitRevision: string;
  body: string | null;
  submittedAt: string;
}>;

export type ExactDraftReviewComment = Readonly<{
  id: string;
  threadId: string;
  reviewer: string;
  commitRevision: string;
  body: string;
  path: string;
  line: number | null;
  createdAt: string;
  updatedAt: string;
}>;

export type ExactDraftReviewFeedback = Readonly<{
  verdict: "changes_requested" | "none";
  changeRequests: readonly ExactDraftChangeRequest[];
  comments: readonly ExactDraftReviewComment[];
}>;

export type ExactDraftObservation = Readonly<{
  state: "draft" | "merged" | "closed";
  baseRevision: string;
  headRevision: string;
  checks: "success" | "failure" | "running" | "missing";
  checkRevision: string | null;
  approvals: number;
  approvalRevision: string | null;
  conversationsResolved: boolean;
  failures: readonly ExactDraftFailure[];
  checkIdentities: readonly string[];
  checkResults: readonly ExactDraftCheckResult[];
  reviewFeedback: ExactDraftReviewFeedback;
  evidenceRefs: readonly string[];
}>;

const MAX_FAILURES = 20;
const MAX_FAILURE_TEXT = 2_000;
const MAX_REVIEW_FEEDBACK = 50;
const MAX_REVIEW_FEEDBACK_BYTES = 64 * 1_024;

function bounded(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\0\r]/g, " ").trim();
  return clean ? clean.slice(0, MAX_FAILURE_TEXT) : null;
}

function detailsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function requiredBounded(value: unknown, code: string, max = MAX_FAILURE_TEXT): string {
  const result = bounded(value);
  if (!result || result.length > max) throw new Error(code);
  return result;
}

function canonicalTimestamp(value: unknown): string {
  const raw = requiredBounded(value, "github_exact_draft_review_timestamp_invalid", 100);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error("github_exact_draft_review_timestamp_invalid");
  return new Date(parsed).toISOString();
}

function validate(input: ExactDraftObservationInput): void {
  if (!IDENTITY.test(input.owner) || !IDENTITY.test(input.repo) ||
      !Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1 ||
      !input.expectedBaseBranch || !input.expectedHeadBranch ||
      !SHA.test(input.expectedBaseSha) || !SHA.test(input.expectedHeadSha) ||
      (input.expectedRepositoryId !== undefined &&
        (!Number.isSafeInteger(input.expectedRepositoryId) || input.expectedRepositoryId < 1))) {
    throw new Error("github_exact_draft_observation_invalid");
  }
}

function checkState(
  checks: readonly Readonly<{ status?: string | null; conclusion?: string | null }>[],
  commitStatus: string,
):
  ExactDraftObservation["checks"] {
  if (checks.length === 0 && commitStatus === "pending") return "running";
  if (checks.length === 0 && !commitStatus) return "missing";
  if (checks.some((check) => check.status !== "completed") || commitStatus === "pending") return "running";
  const successful = new Set(["success", "neutral", "skipped"]);
  return checks.every((check) => check.conclusion && successful.has(check.conclusion)) &&
    (commitStatus === "success" || !commitStatus)
    ? "success"
    : "failure";
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function publisherId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error("github_exact_draft_observation_publisher_invalid");
  }
  return Number(value);
}

function checkIdentity(check: Readonly<{ name?: unknown; app?: { id?: unknown } | null }>): string {
  return `check:${publisherId(check.app?.id)}:${bounded(check.name) ?? "unnamed-check"}`;
}

function statusIdentity(status: Readonly<{ context?: unknown }>): string {
  return `status:${bounded(status.context) ?? "unnamed-status"}`;
}

export async function observeExactDraftWithOctokit(
  octokit: Octokit,
  input: ExactDraftObservationInput,
): Promise<ExactDraftObservation> {
  validate(input);
  const pullResponse = await octokit.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pullRequestNumber,
  });
  const pull = pullResponse.data;
  const baseRevision = String(pull.base.sha ?? "");
  const headRevision = String(pull.head.sha ?? "");
  if (pull.base.ref !== input.expectedBaseBranch || pull.head.ref !== input.expectedHeadBranch ||
      !SHA.test(baseRevision) || !SHA.test(headRevision)) {
    throw new Error("github_exact_draft_observation_drift");
  }
  if (input.requireExactDraft === true) {
    const headRepositoryId = pull.head.repo?.id;
    const baseRepositoryId = pull.base.repo?.id;
    if (pull.state !== "open" || pull.draft !== true || baseRevision !== input.expectedBaseSha ||
        headRevision !== input.expectedHeadSha || input.expectedRepositoryId === undefined ||
        headRepositoryId !== input.expectedRepositoryId || baseRepositoryId !== input.expectedRepositoryId) {
      throw new Error("github_exact_draft_observation_authority_mismatch");
    }
  }
  const [reviewsResponse, checksResponse, statusesResponse, threads] = await Promise.all([
    octokit.pulls.listReviews({ owner: input.owner, repo: input.repo, pull_number: input.pullRequestNumber, per_page: 100 }),
    octokit.checks.listForRef({ owner: input.owner, repo: input.repo, ref: headRevision, per_page: 100 }),
    input.includeCommitStatuses === true
      ? octokit.repos.getCombinedStatusForRef({ owner: input.owner, repo: input.repo, ref: headRevision, per_page: 100 })
      : Promise.resolve({ data: { state: "", total_count: 0, statuses: [] } }),
    octokit.graphql<{
      repository?: { pullRequest?: { reviewThreads?: {
        nodes?: Array<{
          id?: string;
          isResolved?: boolean;
          isOutdated?: boolean;
          comments?: {
            nodes?: Array<{
              id?: string;
              body?: string;
              author?: { login?: string; __typename?: string } | null;
              createdAt?: string;
              updatedAt?: string;
              path?: string;
              line?: number | null;
              pullRequestReview?: {
                state?: string;
                commit?: { oid?: string } | null;
              } | null;
            }>;
            pageInfo?: { hasNextPage?: boolean };
          };
        }>;
        pageInfo?: { hasNextPage?: boolean };
      } } };
    }>(`query ExactDraftThreads($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              isOutdated
              comments(first: 100) {
                nodes {
                  id
                  body
                  author { login __typename }
                  createdAt
                  updatedAt
                  path
                  line
                  pullRequestReview { state commit { oid } }
                }
                pageInfo { hasNextPage }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      }
    }`, { owner: input.owner, repo: input.repo, number: input.pullRequestNumber }),
  ]);
  const reviewsLink = String(reviewsResponse.headers.link ?? "");
  const reviewThreads = threads.repository?.pullRequest?.reviewThreads;
  if (!reviewThreads || reviewsLink.includes('rel="next"') ||
      checksResponse.data.total_count > checksResponse.data.check_runs.length ||
      statusesResponse.data.total_count > statusesResponse.data.statuses.length ||
      reviewThreads?.pageInfo?.hasNextPage === true ||
      (reviewThreads.nodes ?? []).some((thread) => !thread.comments || thread.comments.pageInfo?.hasNextPage === true)) {
    throw new Error("github_exact_draft_observation_incomplete");
  }
  const latestByReviewer = new Map<string, {
    state: string;
    commitId: string | null;
    id: number;
    reviewer: string;
    body: string | null;
    submittedAt: string;
  }>();
  for (const review of reviewsResponse.data) {
    const reviewer = review.user?.login;
    if (!reviewer || review.user?.type !== "User" || !Number.isSafeInteger(review.id)) continue;
    const key = reviewer.toLowerCase();
    const existing = latestByReviewer.get(key);
    if (existing && existing.id >= review.id) continue;
    latestByReviewer.set(key, {
      state: String(review.state ?? "").toUpperCase(),
      commitId: review.commit_id ?? null,
      id: review.id,
      reviewer,
      body: bounded(review.body),
      submittedAt: canonicalTimestamp(review.submitted_at),
    });
  }
  const approvals = [...latestByReviewer.values()].filter((review) =>
    review.state === "APPROVED" && review.commitId === headRevision
  );
  const activeChangeRequestReviewers = new Set([...latestByReviewer.values()]
    .filter((review) => review.state === "CHANGES_REQUESTED" && review.commitId === headRevision)
    .map((review) => review.reviewer.toLowerCase()));
  const threadNodes = reviewThreads?.nodes ?? [];
  const changeRequests: ExactDraftChangeRequest[] = [...latestByReviewer.values()]
    .filter((review) => review.state === "CHANGES_REQUESTED" && review.commitId === headRevision)
    .map((review) => Object.freeze({
      id: String(review.id),
      reviewer: requiredBounded(review.reviewer, "github_exact_draft_review_identity_invalid", 200),
      commitRevision: headRevision,
      body: review.body,
      submittedAt: review.submittedAt,
    }))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const reviewComments: ExactDraftReviewComment[] = [];
  for (const thread of threadNodes) {
    if (thread.isResolved === true || thread.isOutdated === true) continue;
    const threadId = requiredBounded(thread.id, "github_exact_draft_review_identity_invalid", 200);
    for (const comment of thread.comments?.nodes ?? []) {
      const commitRevision = comment.pullRequestReview?.commit?.oid ?? "";
      if (commitRevision !== headRevision || comment.pullRequestReview?.state !== "CHANGES_REQUESTED" ||
          comment.author?.__typename !== "User" ||
          !activeChangeRequestReviewers.has(String(comment.author.login ?? "").toLowerCase())) continue;
      const line = comment.line ?? null;
      if (line !== null && (!Number.isSafeInteger(line) || line < 1)) {
        throw new Error("github_exact_draft_review_location_invalid");
      }
      reviewComments.push(Object.freeze({
        id: requiredBounded(comment.id, "github_exact_draft_review_identity_invalid", 200),
        threadId,
        reviewer: requiredBounded(comment.author?.login, "github_exact_draft_review_identity_invalid", 200),
        commitRevision,
        body: requiredBounded(comment.body, "github_exact_draft_review_body_invalid"),
        path: requiredBounded(comment.path, "github_exact_draft_review_location_invalid", 1_000),
        line,
        createdAt: canonicalTimestamp(comment.createdAt),
        updatedAt: canonicalTimestamp(comment.updatedAt),
      }));
    }
  }
  reviewComments.sort((left, right) => compareCodeUnits(`${left.threadId}\0${left.id}`, `${right.threadId}\0${right.id}`));
  if (changeRequests.length + reviewComments.length > MAX_REVIEW_FEEDBACK) {
    throw new Error("github_exact_draft_review_feedback_limit");
  }
  const feedbackIds = [
    ...changeRequests.map((review) => `review:${review.id}`),
    ...reviewComments.map((comment) => `comment:${comment.id}`),
  ];
  if (new Set(feedbackIds).size !== feedbackIds.length) {
    throw new Error("github_exact_draft_review_identity_ambiguous");
  }
  if (Buffer.byteLength(JSON.stringify({ changeRequests, comments: reviewComments }), "utf8") >
      MAX_REVIEW_FEEDBACK_BYTES) {
    throw new Error("github_exact_draft_review_feedback_limit");
  }
  const reviewFeedback: ExactDraftReviewFeedback = Object.freeze({
    verdict: changeRequests.length || reviewComments.length ? "changes_requested" : "none",
    changeRequests: Object.freeze(changeRequests),
    comments: Object.freeze(reviewComments),
  });
  const checks = checksResponse.data.check_runs;
  const failures: ExactDraftFailure[] = [];
  const checkIdentities = [
    ...checks.map(checkIdentity),
    ...statusesResponse.data.statuses.map(statusIdentity),
  ];
  if (new Set(checkIdentities).size !== checkIdentities.length) {
    throw new Error("github_exact_draft_observation_check_identity_ambiguous");
  }
  checkIdentities.sort(compareCodeUnits);
  const checkResults: ExactDraftCheckResult[] = [
    ...checks.map((check) => Object.freeze({
      identity: checkIdentity(check),
      state: check.status !== "completed" ? "running" as const
        : check.conclusion === "success" ? "success" as const : "failure" as const,
    })),
    ...statusesResponse.data.statuses.map((status) => Object.freeze({
      identity: statusIdentity(status),
      state: status.state === "pending" ? "running" as const
        : status.state === "success" ? "success" as const : "failure" as const,
    })),
  ].sort((left, right) => compareCodeUnits(left.identity, right.identity));
  for (const check of checks) {
    if (check.status !== "completed" || !check.conclusion || check.conclusion === "success") continue;
    failures.push(Object.freeze({
      kind: "check_run",
      id: String(check.id),
      publisherId: publisherId(check.app?.id),
      name: bounded(check.name) ?? "unnamed-check",
      state: "failure",
      title: bounded(check.output?.title),
      summary: bounded(check.output?.summary),
      text: bounded(check.output?.text),
      detailsUrl: detailsUrl(check.details_url),
    }));
  }
  for (const status of statusesResponse.data.statuses) {
    if (status.state !== "failure" && status.state !== "error") continue;
    failures.push(Object.freeze({
      kind: "commit_status",
      id: String(status.id),
      publisherId: null,
      name: bounded(status.context) ?? "unnamed-status",
      state: "failure",
      title: null,
      summary: bounded(status.description),
      text: null,
      detailsUrl: detailsUrl(status.target_url),
    }));
  }
  failures.sort((left, right) => compareCodeUnits(`${left.kind}\0${left.name}\0${left.id}`, `${right.kind}\0${right.name}\0${right.id}`));
  const evidenceRefs = [
    `github:pull-request:${input.owner}/${input.repo}#${input.pullRequestNumber}`,
    `github:base:${baseRevision}`,
    `github:head:${headRevision}`,
    ...checks.map((check) => `github:check-run:${publisherId(check.app?.id)}:${check.id}:${check.status}:${check.conclusion ?? "none"}`),
    ...statusesResponse.data.statuses.map((status) => `github:commit-status:${status.id}:${status.context}:${status.state}`),
    ...approvals.map((review) => `github:review:${review.id}:${headRevision}`),
    ...threadNodes.map((thread) => `github:review-thread:${thread.id ?? "unknown"}:${thread.isResolved === true ? "resolved" : "open"}`),
    ...changeRequests.map((review) => `github:change-request:${review.id}:${headRevision}`),
    ...reviewComments.map((comment) => `github:review-comment:${comment.id}:${headRevision}`),
  ].sort(compareCodeUnits);
  return Object.freeze({
    state: pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : "draft",
    baseRevision,
    headRevision,
    checks: checkState(
      checks,
      statusesResponse.data.statuses.length ? statusesResponse.data.state : "",
    ),
    checkRevision: checks.length || statusesResponse.data.statuses.length ? headRevision : null,
    approvals: approvals.length,
    approvalRevision: approvals.length ? headRevision : null,
    conversationsResolved: threadNodes.every((thread) => thread.isResolved === true),
    failures: Object.freeze(failures.slice(0, MAX_FAILURES)),
    checkIdentities: Object.freeze(checkIdentities),
    checkResults: Object.freeze(checkResults),
    reviewFeedback,
    evidenceRefs: Object.freeze(evidenceRefs),
  });
}
