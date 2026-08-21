import { describe, expect, it, vi } from "vitest";
import type { ExactDraftDeliveryInput } from "./exact-draft.js";
import {
  GitLabDeliveryError,
  MockGitLabDelivery,
  type GitLabDelivery,
  type MergeRequestResult,
} from "./gitlab.js";
import { gitlabAsExactDraftDelivery } from "./gitlab-exact-draft.js";

const BASE_SHA = "a".repeat(40);
/** A real-looking 40-hex GitLab commit id the recording adapter returns. */
const COMMIT_SHA = "ab".repeat(20);

function intent(overrides: Partial<ExactDraftDeliveryInput> = {}): ExactDraftDeliveryInput {
  return Object.freeze({
    owner: "acme",
    repo: "customer",
    baseBranch: "main",
    expectedBaseSha: BASE_SHA,
    branch: "mendpoint/transformer-abc123",
    commitMessage: "Apply approved Transformer candidate",
    commitDate: "2026-08-06T01:00:20.000Z",
    title: "Apply approved Transformer candidate",
    body: "Sealed exact-draft body.",
    files: Object.freeze([
      { path: "package.json", content: "{\"name\":\"customer\"}\n", mode: "100644" as const },
      { path: "src/client.ts", content: "export const migrated = true;\n", mode: "100755" as const },
    ]),
    ...overrides,
  });
}

/** A recording GitLabDelivery that returns a draft merge request by default. */
function recordingGitLab(
  mrOverrides: Partial<MergeRequestResult> = {},
  commitSha: string = COMMIT_SHA,
  /** Base revision the recorder observes for the base branch (defaults to the approved base). */
  observedBaseSha: string = BASE_SHA,
): GitLabDelivery & {
  calls: {
    resolveBranchSha: unknown[][];
    verifyExactCommit: unknown[][];
    createBranch: unknown[][];
    commitFiles: unknown[][];
    openDraftMergeRequest: unknown[][];
  };
} {
  const calls = {
    resolveBranchSha: [] as unknown[][],
    verifyExactCommit: [] as unknown[][],
    createBranch: [] as unknown[][],
    commitFiles: [] as unknown[][],
    openDraftMergeRequest: [] as unknown[][],
  };
  return {
    calls,
    async resolveBranchSha(namespace, project, branch) {
      calls.resolveBranchSha.push([namespace, project, branch]);
      return branch === "main" ? observedBaseSha : undefined;
    },
    async verifyExactCommit(namespace, project, branch, input) {
      calls.verifyExactCommit.push([namespace, project, branch, input]);
      return false;
    },
    async createBranch(namespace, project, branch, fromBranch) {
      calls.createBranch.push([namespace, project, branch, fromBranch]);
    },
    async commitFiles(namespace, project, branch, message, files) {
      calls.commitFiles.push([namespace, project, branch, message, files]);
      return commitSha;
    },
    async openDraftMergeRequest(namespace, project, sourceBranch, title, body, targetBranch) {
      calls.openDraftMergeRequest.push([namespace, project, sourceBranch, title, body, targetBranch]);
      return {
        number: 7,
        url: `https://gitlab.com/${namespace}/${project}/-/merge_requests/7`,
        branch: sourceBranch,
        title: `Draft: ${title}`,
        draft: true,
        ...mrOverrides,
      } as MergeRequestResult;
    },
  };
}

describe("gitlabAsExactDraftDelivery", () => {
  it("delivers an approved exact-draft as a GitLab draft merge request", async () => {
    const gitlab = recordingGitLab();
    const result = await gitlabAsExactDraftDelivery(gitlab).deliverExactDraft(intent());

    // Branch creation is pinned to the immutable revision that was observed and
    // approved, not the mutable base-branch name. If main moves after the read,
    // GitLab still creates the source branch from this exact commit.
    expect(gitlab.calls.createBranch).toEqual([["acme", "customer", "mendpoint/transformer-abc123", BASE_SHA]]);
    const committed = gitlab.calls.commitFiles[0]!;
    expect(committed.slice(0, 4)).toEqual([
      "acme",
      "customer",
      "mendpoint/transformer-abc123",
      "Apply approved Transformer candidate",
    ]);
    expect(committed[4]).toEqual([
      { path: "package.json", content: "{\"name\":\"customer\"}\n", mode: "100644" },
      { path: "src/client.ts", content: "export const migrated = true;\n", mode: "100755" },
    ]);
    expect(gitlab.calls.openDraftMergeRequest).toEqual([
      [
        "acme",
        "customer",
        "mendpoint/transformer-abc123",
        "Apply approved Transformer candidate",
        "Sealed exact-draft body.",
        "main",
      ],
    ]);

    // Delivery evidence uses the intent's own title (not GitLab's Draft: prefix)
    // and reports the reviewed base, so the worker's evidence check accepts it.
    expect(result).toMatchObject({
      number: 7,
      url: "https://gitlab.com/acme/customer/-/merge_requests/7",
      branch: "mendpoint/transformer-abc123",
      title: "Apply approved Transformer candidate",
      draft: true,
      baseBranch: "main",
      baseSha: BASE_SHA,
    });
    // Evidence threads the real 40-hex commit SHA GitLab returned, not a digest.
    expect(result.commitSha).toBe(COMMIT_SHA);
    expect(result.commitSha).toMatch(/^[a-f0-9]{40}$/);
  });

  it("preserves an approved deletion as a GitLab delete action", async () => {
    const gitlab = recordingGitLab();
    await gitlabAsExactDraftDelivery(gitlab).deliverExactDraft(intent({
      files: Object.freeze([{ path: "src/obsolete.ts", delete: true as const }]),
    }));
    expect(gitlab.calls.commitFiles[0]![4]).toEqual([
      { path: "src/obsolete.ts", delete: true },
    ]);
  });

  it("fails closed when the base branch has drifted from the approved revision", async () => {
    // The base branch now points at a different commit than the sealed intent
    // was approved against. Delivery must refuse rather than build onto it.
    const moved = "b".repeat(40);
    const gitlab = recordingGitLab({}, COMMIT_SHA, moved);
    await expect(
      gitlabAsExactDraftDelivery(gitlab).deliverExactDraft(intent()),
    ).rejects.toThrow("gitlab_exact_draft_base_revision_drift");
    // The base was observed and, on drift, nothing was created or committed.
    expect(gitlab.calls.resolveBranchSha).toEqual([
      ["acme", "customer", "mendpoint/transformer-abc123"],
      ["acme", "customer", "main"],
    ]);
    expect(gitlab.calls.createBranch).toEqual([]);
    expect(gitlab.calls.commitFiles).toEqual([]);
    expect(gitlab.calls.openDraftMergeRequest).toEqual([]);
  });

  it("reports the observed base revision, not the intent's own input", async () => {
    // Two deliveries whose base branch is observed at different revisions each
    // report the value they OBSERVED. Because delivery fails closed on drift,
    // the observed value equals the approved base on success — so it is exactly
    // the drift case above (observed differs -> rejected) that proves the base
    // is observed rather than echoed straight from the intent.
    const firstBase = "a".repeat(40);
    const secondBase = "c".repeat(40);
    const first = await gitlabAsExactDraftDelivery(
      recordingGitLab({}, COMMIT_SHA, firstBase),
    ).deliverExactDraft(intent({ expectedBaseSha: firstBase }));
    const second = await gitlabAsExactDraftDelivery(
      recordingGitLab({}, COMMIT_SHA, secondBase),
    ).deliverExactDraft(intent({ expectedBaseSha: secondBase }));
    expect(first.baseSha).toBe(firstBase);
    expect(second.baseSha).toBe(secondBase);
    expect(first.baseSha).not.toBe(second.baseSha);
  });

  it("returns an honest empty commit id when GitLab omits the SHA — no fabricated digest", async () => {
    // GitLab omitted the commit id. The adapter returns the empty observed value
    // unshaped; it never synthesizes a 64-hex id to satisfy a validator. The
    // worker's evidence assertions require a real 40-hex id and reject this.
    const result = await gitlabAsExactDraftDelivery(recordingGitLab({}, "")).deliverExactDraft(intent());
    expect(result.commitSha).toBe("");
    expect(result.commitSha).not.toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed when GitLab does not confirm a draft merge request", async () => {
    const gitlab = recordingGitLab({ draft: false as unknown as true });
    await expect(
      gitlabAsExactDraftDelivery(gitlab).deliverExactDraft(intent()),
    ).rejects.toThrow("gitlab_exact_draft_not_draft");
  });

  it("rejects an invalid exact-draft intent before any GitLab call", async () => {
    const gitlab = recordingGitLab();
    const openSpy = vi.spyOn(gitlab, "openDraftMergeRequest");
    await expect(
      gitlabAsExactDraftDelivery(gitlab).deliverExactDraft(intent({ expectedBaseSha: "not-a-sha" })),
    ).rejects.toThrow("github_exact_draft_base_sha_invalid");
    expect(gitlab.calls.createBranch).toEqual([]);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("delivers through the deterministic MockGitLabDelivery and dedupes on replay", async () => {
    const mock = new MockGitLabDelivery();
    const commitSpy = vi.spyOn(mock, "commitFiles");
    const delivery = gitlabAsExactDraftDelivery(mock);
    const first = await delivery.deliverExactDraft(intent());
    expect(first).toMatchObject({
      branch: "mendpoint/transformer-abc123",
      title: "Apply approved Transformer candidate",
      draft: true,
      baseBranch: "main",
      baseSha: BASE_SHA,
    });
    expect(first.url).toBe("https://gitlab.com/acme/customer/-/merge_requests/1");
    // The mock threads a deterministic 40-hex commit SHA (not the fallback).
    expect(first.commitSha).toMatch(/^[a-f0-9]{40}$/);
    // Re-delivering the same sealed intent returns the same merge request.
    const replay = await delivery.deliverExactDraft(intent());
    expect(replay.number).toBe(first.number);
    expect(replay.commitSha).toBe(first.commitSha);
    // A lost response may replay the sealed delivery. The remote commit is an
    // externally visible side effect and must be reconciled, not emitted again
    // on top of the first commit.
    expect(commitSpy).toHaveBeenCalledTimes(1);
  });

  it("reconciles an exact commit after the commit response is lost", async () => {
    const backing = new MockGitLabDelivery();
    let commitCalls = 0;
    const responseLoss: GitLabDelivery = {
      createBranch: (...args) => backing.createBranch(...args),
      resolveBranchSha: (...args) => backing.resolveBranchSha(...args),
      verifyExactCommit: (...args) => backing.verifyExactCommit(...args),
      openDraftMergeRequest: (...args) => backing.openDraftMergeRequest(...args),
      async commitFiles(...args) {
        commitCalls++;
        await backing.commitFiles(...args);
        throw new Error("simulated response loss");
      },
    };

    const result = await gitlabAsExactDraftDelivery(responseLoss).deliverExactDraft(intent());

    expect(result.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(result.draft).toBe(true);
    expect(commitCalls).toBe(1);
  });

  it("reconciles an exact commit when another worker wins the branch-creation race", async () => {
    const backing = new MockGitLabDelivery();
    let createCalls = 0;
    let commitCalls = 0;
    const raced: GitLabDelivery = {
      resolveBranchSha: (...args) => backing.resolveBranchSha(...args),
      verifyExactCommit: (...args) => backing.verifyExactCommit(...args),
      openDraftMergeRequest: (...args) => backing.openDraftMergeRequest(...args),
      async createBranch(namespace, project, branch, fromBranch) {
        createCalls++;
        await backing.createBranch(namespace, project, branch, fromBranch);
        await backing.commitFiles(
          namespace,
          project,
          branch,
          intent().commitMessage,
          [
            { path: "package.json", content: "{\"name\":\"customer\"}\n", mode: "100644" },
            { path: "src/client.ts", content: "export const migrated = true;\n", mode: "100755" },
          ],
        );
        throw new Error("simulated concurrent branch winner");
      },
      async commitFiles(...args) {
        commitCalls++;
        return backing.commitFiles(...args);
      },
    };

    const result = await gitlabAsExactDraftDelivery(raced).deliverExactDraft(intent());

    expect(result.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(result.draft).toBe(true);
    expect(createCalls).toBe(1);
    expect(commitCalls).toBe(0);
  });

  it("propagates a retryable outage (not a diverged integrity error) when verification cannot reach GitLab", async () => {
    // The source branch exists, but verifyExactCommit cannot reach GitLab to
    // decide (a 500). This must surface as a retryable GitLabDeliveryError
    // carrying the upstream status, NOT the terminal
    // gitlab_exact_draft_branch_diverged that would dead-letter an approved
    // candidate on a transient outage.
    const gitlab: GitLabDelivery = {
      async resolveBranchSha(_ns, _p, branch) {
        return branch === intent().branch ? "cd".repeat(20) : BASE_SHA;
      },
      async verifyExactCommit() {
        throw new GitLabDeliveryError("verifyExactCommit", 500, { message: "upstream" });
      },
      async createBranch() {},
      async commitFiles() {
        return COMMIT_SHA;
      },
      async openDraftMergeRequest() {
        throw new Error("no merge request must be opened when verification is inconclusive");
      },
    };

    const err = await gitlabAsExactDraftDelivery(gitlab)
      .deliverExactDraft(intent())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabDeliveryError);
    expect(err).toMatchObject({ provider: "gitlab", operation: "verifyExactCommit", status: 500 });
    expect(String((err as Error).message)).not.toContain("gitlab_exact_draft_branch_diverged");
  });

  it("fails closed as diverged when the existing branch head is a PROVEN mismatch", async () => {
    // verifyExactCommit returned a definite false (GitLab answered; the head is
    // not our commit). This is the one case that stays terminal and fails
    // closed — the outage fix must not make a real integrity mismatch retryable.
    const gitlab: GitLabDelivery = {
      async resolveBranchSha(_ns, _p, branch) {
        return branch === intent().branch ? "cd".repeat(20) : BASE_SHA;
      },
      async verifyExactCommit() {
        return false;
      },
      async createBranch() {},
      async commitFiles() {
        return COMMIT_SHA;
      },
      async openDraftMergeRequest() {
        throw new Error("no merge request must be opened for a diverged branch");
      },
    };

    await expect(
      gitlabAsExactDraftDelivery(gitlab).deliverExactDraft(intent()),
    ).rejects.toThrow("gitlab_exact_draft_branch_diverged");
  });
});
