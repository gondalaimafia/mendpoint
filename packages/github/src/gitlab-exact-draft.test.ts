import { describe, expect, it, vi } from "vitest";
import type { ExactDraftDeliveryInput } from "./exact-draft.js";
import type { FileEdit } from "./index.js";
import { MockGitLabDelivery, type GitLabDelivery, type MergeRequestResult } from "./gitlab.js";
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
    createBranch: unknown[][];
    commitFiles: unknown[][];
    openDraftMergeRequest: unknown[][];
  };
} {
  const calls = {
    resolveBranchSha: [] as unknown[][],
    createBranch: [] as unknown[][],
    commitFiles: [] as unknown[][],
    openDraftMergeRequest: [] as unknown[][],
  };
  return {
    calls,
    async resolveBranchSha(namespace, project, branch) {
      calls.resolveBranchSha.push([namespace, project, branch]);
      return observedBaseSha;
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

    // Branch is created from the approved base, files are committed without the
    // exact-draft mode field, and the MR targets the base branch.
    expect(gitlab.calls.createBranch).toEqual([["acme", "customer", "mendpoint/transformer-abc123", "main"]]);
    const committed = gitlab.calls.commitFiles[0]!;
    expect(committed.slice(0, 4)).toEqual([
      "acme",
      "customer",
      "mendpoint/transformer-abc123",
      "Apply approved Transformer candidate",
    ]);
    expect(committed[4]).toEqual([
      { path: "package.json", content: "{\"name\":\"customer\"}\n" },
      { path: "src/client.ts", content: "export const migrated = true;\n" },
    ] satisfies FileEdit[]);
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
    ] satisfies FileEdit[]);
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
    expect(gitlab.calls.resolveBranchSha).toEqual([["acme", "customer", "main"]]);
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
  });
});
