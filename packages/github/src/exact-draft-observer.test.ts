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
  installationId?: number;
  changedFiles?: Array<Readonly<{ filename: string; previous_filename?: string; status?: string }>>;
  compareNextPage?: boolean;
  matchingDrafts?: number;
  pullsNextPage?: boolean;
  checkDetailsUrl?: string;
  reviews?: Array<Readonly<{
    id: number;
    state: string;
    commitId?: string;
    login?: string;
    body?: string;
    submittedAt?: string;
    userType?: string;
  }>>;
  threadOutdated?: boolean;
  threadCommentsNextPage?: boolean;
  threadComments?: Array<Readonly<{
    id: string;
    body: string;
    login: string;
    commitId?: string;
    reviewState?: string;
    path?: string;
    line?: number | null;
    authorType?: string;
  }>>;
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
        data: (input.reviews ?? [{ id: 7, state: "APPROVED", commitId: input.reviewCommit ?? head,
          login: "reviewer", submittedAt: "2026-08-14T12:00:00.000Z", userType: "User" }]).map((review) => ({
          id: review.id,
          state: review.state,
          commit_id: review.commitId ?? head,
          user: { login: review.login ?? "reviewer", type: review.userType ?? "User" },
          body: review.body ?? null,
          submitted_at: review.submittedAt ?? "2026-08-14T12:00:00.000Z",
        })),
        headers: {},
      })),
      list: vi.fn(async () => ({
        data: Array.from({ length: input.matchingDrafts ?? 1 }, (_, index) => ({
          number: 3 + index,
          state: "open",
          draft: true,
          base: { ref: "main", sha: input.baseSha ?? sha("a") },
          head: { ref: "mendpoint/change", sha: head },
        })),
        headers: input.pullsNextPage ? { link: '<https://api.github.test/pulls?page=2>; rel="next"' } : {},
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
      compareCommitsWithBasehead: vi.fn(async () => ({
        data: {
          base_commit: { sha: input.baseSha ?? sha("a") },
          commits: [{ sha: head }],
          files: input.changedFiles ?? [{ filename: "src/client.ts", status: "modified" }],
        },
        headers: input.compareNextPage
          ? { link: '<https://api.github.test/compare?page=2>; rel="next"' }
          : {},
      })),
    },
    git: {
      getCommit: vi.fn(async () => ({ data: { tree: { sha: sha("c") } } })),
    },
    graphql: vi.fn(async () => ({ repository: { pullRequest: { reviewThreads: {
      nodes: [{
        id: "thread-1",
        isResolved: input.openThread !== true,
        isOutdated: input.threadOutdated === true,
        comments: {
          nodes: (input.threadComments ?? []).map((comment) => ({
            id: comment.id,
            body: comment.body,
            author: { login: comment.login, __typename: comment.authorType ?? "User" },
            createdAt: "2026-08-14T12:01:00.000Z",
            updatedAt: "2026-08-14T12:02:00.000Z",
            path: comment.path ?? "src/client.ts",
            line: comment.line ?? 12,
            pullRequestReview: {
              state: comment.reviewState ?? "CHANGES_REQUESTED",
              commit: { oid: comment.commitId ?? head },
            },
          })),
          pageInfo: { hasNextPage: input.threadCommentsNextPage === true },
        },
      }],
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
  it("binds pagination-complete remote files, tree leaves, installation, and one exact open draft", async () => {
    const client = octokit();
    const observed = await observeExactDraftWithOctokit(client, {
      ...input,
      expectedRepositoryId: 101,
      expectedInstallationId: 202,
      requireExactDraft: true,
      includeDeliveryEvidence: true,
    });
    expect(observed).toMatchObject({
      repositoryId: 101,
      installationId: 202,
      matchingOpenDrafts: 1,
      changedPaths: ["src/client.ts"],
      remoteTreeSha: sha("c"),
    });
    expect(client.pulls.list).toHaveBeenCalledWith(expect.objectContaining({
      state: "open",
      head: "acme:mendpoint/change",
    }));
    expect(client.repos.compareCommitsWithBasehead).toHaveBeenCalledWith(expect.objectContaining({
      basehead: `${sha("a")}...${sha("b")}`,
    }));
    expect(observed.evidenceRefs).toEqual(expect.arrayContaining([
      "github:installation:202",
      `github:repository:101`,
      `github:tree:${sha("c")}`,
      "github:changed-path-sha256:25d66d74617fe2e23d7946bd6e3ba95640ab1b9bc8947445d604fc271c7c1f12",
    ]));
  });

  it.each([
    [{ compareNextPage: true }, "github_exact_draft_observation_incomplete"],
    [{ pullsNextPage: true }, "github_exact_draft_observation_incomplete"],
    [{ matchingDrafts: 2 }, "github_exact_draft_observation_authority_mismatch"],
  ])("fails closed when remote delivery evidence is incomplete or ambiguous", async (settings, code) => {
    await expect(observeExactDraftWithOctokit(octokit(settings), {
      ...input,
      expectedRepositoryId: 101,
      expectedInstallationId: 202,
      requireExactDraft: true,
      includeDeliveryEvidence: true,
    })).rejects.toThrow(code);
  });

  it("binds both sides of a rename and accepts canonical Git paths with spaces", async () => {
    const observed = await observeExactDraftWithOctokit(octokit({ changedFiles: [{
      filename: "src/new client.ts",
      previous_filename: "src/old client.ts",
      status: "renamed",
    }] }), {
      ...input,
      expectedRepositoryId: 101,
      expectedInstallationId: 202,
      requireExactDraft: true,
      includeDeliveryEvidence: true,
    });
    expect(observed.changedPaths).toEqual(["src/new client.ts", "src/old client.ts"]);
  });

  it("fails closed at GitHub's comparison file cap because truncation cannot be disproved", async () => {
    const changedFiles = Array.from({ length: 300 }, (_, index) => ({
      filename: `src/file-${index}.ts`,
      status: "modified",
    }));
    await expect(observeExactDraftWithOctokit(octokit({ changedFiles }), {
      ...input,
      expectedRepositoryId: 101,
      expectedInstallationId: 202,
      requireExactDraft: true,
      includeDeliveryEvidence: true,
    })).rejects.toThrow("github_exact_draft_observation_incomplete");
  });

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

  it("returns bounded current-head change requests and unresolved inline comments", async () => {
    const observed = await observeExactDraftWithOctokit(octokit({
      openThread: true,
      reviews: [
        { id: 6, state: "CHANGES_REQUESTED", commitId: sha("a"), body: "stale request" },
        { id: 7, state: "CHANGES_REQUESTED", commitId: sha("b"), body: `Fix the retry path ${"r".repeat(3_000)}` },
      ],
      threadComments: [{ id: "comment-1", login: "reviewer", body: `Handle the nil response ${"c".repeat(3_000)}` }],
    }), input);

    expect(observed.reviewFeedback).toEqual({
      verdict: "changes_requested",
      changeRequests: [{
        id: "7",
        reviewer: "reviewer",
        commitRevision: sha("b"),
        body: expect.stringMatching(/^Fix the retry path /),
        submittedAt: "2026-08-14T12:00:00.000Z",
      }],
      comments: [{
        id: "comment-1",
        threadId: "thread-1",
        reviewer: "reviewer",
        commitRevision: sha("b"),
        body: expect.stringMatching(/^Handle the nil response /),
        path: "src/client.ts",
        line: 12,
        createdAt: "2026-08-14T12:01:00.000Z",
        updatedAt: "2026-08-14T12:02:00.000Z",
      }],
    });
    expect(observed.reviewFeedback.changeRequests[0]!.body!.length).toBeLessThanOrEqual(2_000);
    expect(observed.reviewFeedback.comments[0]!.body.length).toBeLessThanOrEqual(2_000);
    expect(Object.isFrozen(observed.reviewFeedback)).toBe(true);
    expect(Object.isFrozen(observed.reviewFeedback.comments)).toBe(true);
  });

  it("preserves a bodyless current-head change request as authoritative feedback", async () => {
    const observed = await observeExactDraftWithOctokit(octokit({
      reviews: [{ id: 7, state: "CHANGES_REQUESTED", commitId: sha("b") }],
    }), input);

    expect(observed.reviewFeedback).toEqual({
      verdict: "changes_requested",
      changeRequests: [{
        id: "7",
        reviewer: "reviewer",
        commitRevision: sha("b"),
        body: null,
        submittedAt: "2026-08-14T12:00:00.000Z",
      }],
      comments: [],
    });
  });

  it("ignores stale, dismissed, resolved, and outdated review feedback", async () => {
    const dismissed = await observeExactDraftWithOctokit(octokit({
      reviews: [
        { id: 6, state: "CHANGES_REQUESTED", commitId: sha("b"), body: "old request" },
        { id: 7, state: "DISMISSED", commitId: sha("b"), body: "dismissed" },
      ],
      openThread: true,
      threadOutdated: true,
      threadComments: [{ id: "comment-1", login: "reviewer", body: "outdated comment" }],
    }), input);
    expect(dismissed.reviewFeedback).toEqual({ verdict: "none", changeRequests: [], comments: [] });

    const resolved = await observeExactDraftWithOctokit(octokit({
      openThread: false,
      threadComments: [{ id: "comment-2", login: "reviewer", body: "resolved comment" }],
    }), input);
    expect(resolved.reviewFeedback.comments).toEqual([]);
  });

  it("ignores comments outside an active human change request", async () => {
    const observed = await observeExactDraftWithOctokit(octokit({
      openThread: true,
      reviews: [{ id: 7, state: "COMMENTED", commitId: sha("b"), body: "non-authoritative" }],
      threadComments: [
        { id: "comment-approved", login: "reviewer", body: "looks good", reviewState: "APPROVED" },
        { id: "comment-bot", login: "mendpoint-bot", body: "loop", authorType: "Bot" },
      ],
    }), input);
    expect(observed.reviewFeedback).toEqual({ verdict: "none", changeRequests: [], comments: [] });

    const superseded = await observeExactDraftWithOctokit(octokit({
      openThread: true,
      reviews: [{ id: 8, state: "APPROVED", commitId: sha("b"), login: "reviewer" }],
      threadComments: [{ id: "old-request", login: "reviewer", body: "already addressed",
        reviewState: "CHANGES_REQUESTED" }],
    }), input);
    expect(superseded.reviewFeedback).toEqual({ verdict: "none", changeRequests: [], comments: [] });
  });

  it("normalizes provider timestamps and fails closed on invalid time or duplicate feedback identities", async () => {
    await expect(observeExactDraftWithOctokit(octokit({
      reviews: [{ id: 7, state: "CHANGES_REQUESTED", commitId: sha("b"), body: "fix",
        submittedAt: "2026-08-14T12:00:00Z" }],
    }), input)).resolves.toMatchObject({ reviewFeedback: { changeRequests: [{
      submittedAt: "2026-08-14T12:00:00.000Z",
    }] } });
    await expect(observeExactDraftWithOctokit(octokit({
      reviews: [{ id: 7, state: "CHANGES_REQUESTED", commitId: sha("b"), submittedAt: "not-a-time" }],
    }), input)).rejects.toThrow("github_exact_draft_review_timestamp_invalid");
    await expect(observeExactDraftWithOctokit(octokit({
      openThread: true,
      reviews: [{ id: 7, state: "CHANGES_REQUESTED", commitId: sha("b"), login: "reviewer", body: "fix" }],
      threadComments: [
        { id: "duplicate", login: "reviewer", body: "first" },
        { id: "duplicate", login: "reviewer", body: "second" },
      ],
    }), input)).rejects.toThrow("github_exact_draft_review_identity_ambiguous");
  });

  it("fails closed when inline review comment pagination is incomplete", async () => {
    await expect(observeExactDraftWithOctokit(octokit({
      openThread: true,
      threadCommentsNextPage: true,
      threadComments: [{ id: "comment-1", login: "reviewer", body: "more follows" }],
    }), input)).rejects.toThrow("github_exact_draft_observation_incomplete");
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
