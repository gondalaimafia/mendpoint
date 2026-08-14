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
  checkCount?: number;
  draft?: boolean;
  repositoryId?: number;
  checkDetailsUrl?: string;
}> = {}): Octokit {
  const head = input.headSha ?? sha("b");
  const checkRuns = Array.from({ length: input.checkCount ?? 1 }, (_, index) => ({
    id: 9 + index,
    name: `test-${index}`,
    app: { id: 77 },
    status: input.checkStatus ?? "completed",
    conclusion: input.checkConclusion ?? "success",
    details_url: input.checkDetailsUrl ?? "https://github.com/acme/service/actions/runs/9",
    output: {
      title: "Unit tests failed",
      summary: `summary-${index} ${"s".repeat(3_000)}`,
      text: `text-${index} ${"t".repeat(3_000)}`,
    },
  }));
  return {
    pulls: {
      get: vi.fn(async () => ({ data: {
        base: { ref: "main", sha: input.baseSha ?? sha("a"), repo: { id: input.repositoryId ?? 101 } },
        head: { ref: "mendpoint/change", sha: head, repo: { id: input.repositoryId ?? 101 } },
        state: "open",
        draft: input.draft ?? true,
        merged_at: null,
      } })),
      listReviews: vi.fn(async () => ({
        data: [{ id: 7, state: "APPROVED", commit_id: input.reviewCommit ?? head, user: { login: "reviewer" } }],
        headers: {},
      })),
    },
    checks: {
      listForRef: vi.fn(async () => ({ data: {
        total_count: input.checksTotal ?? checkRuns.length,
        check_runs: checkRuns,
      } })),
    },
    repos: {
      getCombinedStatusForRef: vi.fn(async () => ({ data: {
        state: input.commitStatus ?? "success",
        total_count: 1,
        statuses: [{
          id: 11,
          creator: { id: 88 },
          context: "legacy-ci",
          state: input.commitStatus ?? "success",
          description: `legacy failure ${"d".repeat(3_000)}`,
          target_url: "https://ci.example.invalid/build/11",
        }],
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
  includeCommitStatuses: true,
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

  it("returns bounded structured failure evidence for the exact failed head", async () => {
    const observed = await observeExactDraftWithOctokit(octokit({
      checkConclusion: "failure",
      commitStatus: "failure",
      checkCount: 25,
    }), input);

    expect(observed.failures).toHaveLength(20);
    expect(observed.failures[0]).toEqual({
      kind: "check_run",
      id: "9",
      publisherId: 77,
      name: "test-0",
      state: "failure",
      title: "Unit tests failed",
      summary: expect.stringMatching(/^summary-0 /),
      text: expect.stringMatching(/^text-0 /),
      detailsUrl: "https://github.com/acme/service/actions/runs/9",
    });
    expect(observed.failures[0]!.summary!.length).toBeLessThanOrEqual(2_000);
    expect(observed.failures[0]!.text!.length).toBeLessThanOrEqual(2_000);
    expect(Object.isFrozen(observed.failures)).toBe(true);
    expect(Object.isFrozen(observed.failures[0])).toBe(true);
    expect(observed.checkIdentities).toEqual([
      ...Array.from({ length: 25 }, (_, index) => `check:77:test-${index}`),
      "status:legacy-ci",
    ].sort());
  });

  it("includes a bounded classic status failure when no failed check run displaces it", async () => {
    const observed = await observeExactDraftWithOctokit(octokit({ commitStatus: "failure" }), input);

    expect(observed.failures).toContainEqual({
      kind: "commit_status",
      id: "11",
      publisherId: null,
      name: "legacy-ci",
      state: "failure",
      title: null,
      summary: expect.stringMatching(/^legacy failure /),
      text: null,
      detailsUrl: "https://ci.example.invalid/build/11",
    });
  });

  it("removes query credentials and fragments from failure detail links", async () => {
    const observed = await observeExactDraftWithOctokit(octokit({
      checkConclusion: "failure",
      checkDetailsUrl: "https://ci.example.invalid/build/11?token=secret#logs",
    }), input);
    expect(observed.failures[0]?.detailsUrl).toBe("https://ci.example.invalid/build/11");
  });

  it("fails closed when GitHub pagination would omit authority evidence", async () => {
    await expect(observeExactDraftWithOctokit(octokit({ checksTotal: 2 }), input))
      .rejects.toThrow("github_exact_draft_observation_incomplete");
  });

  it.each([
    [octokit({ headSha: sha("c") }), { ...input, expectedRepositoryId: 101, requireExactDraft: true }],
    [octokit({ draft: false }), { ...input, expectedRepositoryId: 101, requireExactDraft: true }],
    [octokit({ repositoryId: 202 }), { ...input, expectedRepositoryId: 101, requireExactDraft: true }],
  ])("fails closed when strict draft authority does not match", async (client, strictInput) => {
    await expect(observeExactDraftWithOctokit(client, strictInput))
      .rejects.toThrow("github_exact_draft_observation_authority_mismatch");
    expect(client.checks.listForRef).not.toHaveBeenCalled();
  });
});
