import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { observeExactDraftWithOctokit } from "./exact-draft-observer.js";

const sha = (value: string) => value.repeat(40);

function octokit(input: Readonly<{
  baseSha?: string;
  headSha?: string;
  checkStatus?: string;
  checkConclusion?: string | null;
  reviewCommit?: string;
  openThread?: boolean;
  checksTotal?: number;
  commitStatus?: string;
}> = {}): Octokit {
  const head = input.headSha ?? sha("b");
  return {
    pulls: {
      get: vi.fn(async () => ({ data: {
        base: { ref: "main", sha: input.baseSha ?? sha("a") },
        head: { ref: "mendpoint/change", sha: head },
        state: "open",
        merged_at: null,
      } })),
      listReviews: vi.fn(async () => ({
        data: [{ id: 7, state: "APPROVED", commit_id: input.reviewCommit ?? head, user: { login: "reviewer" } }],
        headers: {},
      })),
    },
    checks: {
      listForRef: vi.fn(async () => ({ data: {
        total_count: input.checksTotal ?? 1,
        check_runs: [{ id: 9, status: input.checkStatus ?? "completed", conclusion: input.checkConclusion ?? "success" }],
      } })),
    },
    repos: {
      getCombinedStatusForRef: vi.fn(async () => ({ data: {
        state: input.commitStatus ?? "success",
        total_count: 1,
        statuses: [{ id: 11, context: "legacy-ci", state: input.commitStatus ?? "success" }],
      } })),
    },
    graphql: vi.fn(async () => ({ repository: { pullRequest: { reviewThreads: {
      nodes: [{ id: "thread-1", isResolved: input.openThread !== true }],
      pageInfo: { hasNextPage: false },
    } } } })),
  } as unknown as Octokit;
}

const input = Object.freeze({
  owner: "acme",
  repo: "service",
  pullRequestNumber: 3,
  expectedBaseBranch: "main",
  expectedBaseSha: sha("a"),
  expectedHeadBranch: "mendpoint/change",
  expectedHeadSha: sha("b"),
});

describe("exact GitHub draft observation", () => {
  it("binds exact head checks, reviews, and resolved conversations", async () => {
    const client = octokit();
    await expect(observeExactDraftWithOctokit(client, input)).resolves.toMatchObject({
      state: "draft",
      baseRevision: sha("a"),
      headRevision: sha("b"),
      checks: "success",
      checkRevision: sha("b"),
      approvals: 1,
      approvalRevision: sha("b"),
      conversationsResolved: true,
    });
    expect(client.checks.listForRef).toHaveBeenCalledWith(expect.objectContaining({ ref: sha("b") }));
  });

  it("returns revision drift as evidence for campaign reconciliation", async () => {
    await expect(observeExactDraftWithOctokit(octokit({ baseSha: sha("c"), headSha: sha("d") }), input))
      .resolves.toMatchObject({ baseRevision: sha("c"), headRevision: sha("d") });
  });

  it("does not count stale approvals and reports failed checks or open conversations", async () => {
    await expect(observeExactDraftWithOctokit(octokit({
      reviewCommit: sha("c"),
      checkConclusion: "failure",
      openThread: true,
    }), input)).resolves.toMatchObject({
      checks: "failure",
      approvals: 0,
      approvalRevision: null,
      conversationsResolved: false,
    });
  });

  it("includes classic commit statuses in the exact CI verdict", async () => {
    await expect(observeExactDraftWithOctokit(octokit({ commitStatus: "failure" }), input))
      .resolves.toMatchObject({ checks: "failure", checkRevision: sha("b") });
  });

  it("fails closed when GitHub pagination would omit authority evidence", async () => {
    await expect(observeExactDraftWithOctokit(octokit({ checksTotal: 2 }), input))
      .rejects.toThrow("github_exact_draft_observation_incomplete");
  });
});
