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
): GitLabDelivery & {
  calls: {
    createBranch: unknown[][];
    commitFiles: unknown[][];
    openDraftMergeRequest: unknown[][];
  };
} {
  const calls = {
    createBranch: [] as unknown[][],
    commitFiles: [] as unknown[][],
    openDraftMergeRequest: [] as unknown[][],
  };
  return {
    calls,
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

  it("falls back to a deterministic synthesized commit id when GitLab omits the SHA", async () => {
    const first = await gitlabAsExactDraftDelivery(recordingGitLab({}, "")).deliverExactDraft(intent());
    const second = await gitlabAsExactDraftDelivery(recordingGitLab({}, "")).deliverExactDraft(intent());
    // No real commit id, so the labeled 64-hex fallback is used, deterministic
    // per sealed intent.
    expect(first.commitSha).toMatch(/^[a-f0-9]{64}$/);
    expect(second.commitSha).toBe(first.commitSha);

    const changed = await gitlabAsExactDraftDelivery(recordingGitLab({}, "")).deliverExactDraft(
      intent({
        files: Object.freeze([
          { path: "package.json", content: "{\"name\":\"other\"}\n", mode: "100644" as const },
        ]),
      }),
    );
    expect(changed.commitSha).not.toBe(first.commitSha);
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
