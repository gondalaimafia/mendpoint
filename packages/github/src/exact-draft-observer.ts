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
  evidenceRefs: readonly string[];
}>;

function validate(input: ExactDraftObservationInput): void {
  if (!IDENTITY.test(input.owner) || !IDENTITY.test(input.repo) ||
      !Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1 ||
      !input.expectedBaseBranch || !input.expectedHeadBranch ||
      !SHA.test(input.expectedBaseSha) || !SHA.test(input.expectedHeadSha)) {
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
  const [reviewsResponse, checksResponse, statusesResponse, threads] = await Promise.all([
    octokit.pulls.listReviews({ owner: input.owner, repo: input.repo, pull_number: input.pullRequestNumber, per_page: 100 }),
    octokit.checks.listForRef({ owner: input.owner, repo: input.repo, ref: headRevision, per_page: 100 }),
    octokit.repos.getCombinedStatusForRef({ owner: input.owner, repo: input.repo, ref: headRevision, per_page: 100 }),
    octokit.graphql<{
      repository?: { pullRequest?: { reviewThreads?: {
        nodes?: Array<{ id?: string; isResolved?: boolean }>;
        pageInfo?: { hasNextPage?: boolean };
      } } };
    }>(`query ExactDraftThreads($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) { nodes { id isResolved } pageInfo { hasNextPage } }
        }
      }
    }`, { owner: input.owner, repo: input.repo, number: input.pullRequestNumber }),
  ]);
  const reviewsLink = String(reviewsResponse.headers.link ?? "");
  const reviewThreads = threads.repository?.pullRequest?.reviewThreads;
  if (!reviewThreads || reviewsLink.includes('rel="next"') ||
      checksResponse.data.total_count > checksResponse.data.check_runs.length ||
      statusesResponse.data.total_count > statusesResponse.data.statuses.length ||
      reviewThreads?.pageInfo?.hasNextPage === true) {
    throw new Error("github_exact_draft_observation_incomplete");
  }
  const latestByReviewer = new Map<string, { state: string; commitId: string | null; id: number }>();
  for (const review of reviewsResponse.data) {
    const reviewer = review.user?.login;
    if (!reviewer || !Number.isSafeInteger(review.id)) continue;
    const key = reviewer.toLowerCase();
    const existing = latestByReviewer.get(key);
    if (existing && existing.id >= review.id) continue;
    latestByReviewer.set(key, {
      state: String(review.state ?? "").toUpperCase(),
      commitId: review.commit_id ?? null,
      id: review.id,
    });
  }
  const approvals = [...latestByReviewer.values()].filter((review) =>
    review.state === "APPROVED" && review.commitId === headRevision
  );
  const threadNodes = reviewThreads?.nodes ?? [];
  const checks = checksResponse.data.check_runs;
  const evidenceRefs = [
    `github:pull-request:${input.owner}/${input.repo}#${input.pullRequestNumber}`,
    `github:base:${baseRevision}`,
    `github:head:${headRevision}`,
    ...checks.map((check) => `github:check-run:${check.id}:${check.status}:${check.conclusion ?? "none"}`),
    ...statusesResponse.data.statuses.map((status) => `github:commit-status:${status.id}:${status.context}:${status.state}`),
    ...approvals.map((review) => `github:review:${review.id}:${headRevision}`),
    ...threadNodes.map((thread) => `github:review-thread:${thread.id ?? "unknown"}:${thread.isResolved === true ? "resolved" : "open"}`),
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
    evidenceRefs: Object.freeze(evidenceRefs),
  });
}
