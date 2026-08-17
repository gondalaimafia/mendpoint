import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { reconcileExactDraftUpdateWithOctokit, updateExactDraftWithOctokit } from "./exact-draft-update.js";

const sha = (value: string) => value.repeat(40);
const PREVIOUS = sha("a");
const CREATED = sha("b");

const input = Object.freeze({
  owner: "acme",
  repo: "service",
  expectedRepositoryId: 101,
  pullRequestNumber: 17,
  baseBranch: "main",
  branch: "mendpoint/warden-run",
  expectedHeadSha: PREVIOUS,
  commitMessage: "Repair failed CI",
  commitDate: "2026-08-13T18:00:00.000Z",
  files: Object.freeze([{ path: "src/a.ts", content: "export const value = 2;\n", mode: "100644" as const }]),
});

function client(overrides: Readonly<{
  head?: string;
  draft?: boolean;
  state?: string;
  updateLosesResponse?: boolean;
}> = {}): Octokit {
  let head = overrides.head ?? PREVIOUS;
  const pull = () => ({
    number: 17,
    html_url: "https://github.com/acme/service/pull/17",
    state: overrides.state ?? "open",
    draft: overrides.draft ?? true,
    base: { ref: "main", repo: { id: 101 } },
    head: { ref: "mendpoint/warden-run", sha: head, repo: { id: 101 } },
  });
  return {
    pulls: { get: vi.fn(async () => ({ data: pull() })) },
    git: {
      getRef: vi.fn(async () => ({ data: { object: { sha: head } } })),
      getCommit: vi.fn(async () => ({ data: { tree: { sha: "parent-tree" } } })),
      createBlob: vi.fn(async () => ({ data: { sha: "blob-a" } })),
      createTree: vi.fn(async () => ({ data: { sha: "next-tree" } })),
      createCommit: vi.fn(async () => ({ data: { sha: CREATED } })),
      updateRef: vi.fn(async ({ sha: next, force }: { sha: string; force: boolean }) => {
        expect(force).toBe(false);
        head = next;
        if (overrides.updateLosesResponse) throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
        return { data: { object: { sha: next } } };
      }),
    },
  } as unknown as Octokit;
}

describe("exact GitHub draft update", () => {
  it("adds one non-force commit to the exact existing draft head", async () => {
    const octokit = client();

    await expect(updateExactDraftWithOctokit(octokit, input)).resolves.toEqual({
      number: 17,
      url: "https://github.com/acme/service/pull/17",
      branch: input.branch,
      previousHeadSha: PREVIOUS,
      commitSha: CREATED,
      draft: true,
    });
    expect(octokit.git.createCommit).toHaveBeenCalledWith(expect.objectContaining({
      parents: [PREVIOUS],
      tree: "next-tree",
    }));
    expect(octokit.git.updateRef).toHaveBeenCalledWith(expect.objectContaining({
      ref: `heads/${input.branch}`,
      sha: CREATED,
      force: false,
    }));
  });

  it("deletes an approved tracked file with an exact null tree entry", async () => {
    const octokit = client();
    const deletion = {
      ...input,
      files: [{ path: "src/obsolete.ts", delete: true } as never],
    };

    await expect(updateExactDraftWithOctokit(octokit, deletion)).resolves.toMatchObject({
      previousHeadSha: PREVIOUS,
      commitSha: CREATED,
    });
    expect(octokit.git.createBlob).not.toHaveBeenCalled();
    expect(octokit.git.createTree).toHaveBeenCalledWith(expect.objectContaining({
      tree: [{ path: "src/obsolete.ts", mode: "100644", type: "blob", sha: null }],
    }));
  });

  it.each([
    [{ head: sha("c") }, "github_exact_draft_update_head_drift"],
    [{ draft: false }, "github_exact_draft_update_not_draft"],
    [{ state: "closed" }, "github_exact_draft_update_not_draft"],
  ] as const)("rejects stale or non-draft authority before ref mutation", async (overrides, code) => {
    const octokit = client(overrides);
    await expect(updateExactDraftWithOctokit(octokit, input)).rejects.toThrow(code);
    expect(octokit.git.updateRef).not.toHaveBeenCalled();
  });

  it("reconciles a lost update response from the exact resulting head", async () => {
    const octokit = client({ updateLosesResponse: true });
    await expect(updateExactDraftWithOctokit(octokit, input)).resolves.toMatchObject({ commitSha: CREATED });
    expect(octokit.git.updateRef).toHaveBeenCalledTimes(1);
  });

  it("replays the exact deterministic commit without writing the ref twice", async () => {
    const octokit = client({ head: CREATED });
    await expect(updateExactDraftWithOctokit(octokit, input)).resolves.toMatchObject({
      previousHeadSha: PREVIOUS,
      commitSha: CREATED,
    });
    expect(octokit.git.updateRef).not.toHaveBeenCalled();
  });

  it("reconciles an exact applied commit using read-only GitHub operations", async () => {
    const octokit = {
      pulls: { get: vi.fn(async () => ({ data: {
        number: 17, html_url: "https://github.com/acme/service/pull/17", state: "open", draft: true,
        base: { ref: "main", repo: { id: 101 } },
        head: { ref: "mendpoint/warden-run", sha: CREATED, repo: { id: 101 } },
      } })) },
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: CREATED } } })),
        getCommit: vi.fn(async ({ commit_sha }: { commit_sha: string }) => ({ data: commit_sha === CREATED ? {
          tree: { sha: "candidate-tree" }, parents: [{ sha: PREVIOUS }], message: input.commitMessage,
          author: { name: "Mendpoint", email: "delivery@mendpoint.ai", date: input.commitDate },
          committer: { name: "Mendpoint", email: "delivery@mendpoint.ai", date: input.commitDate },
        } : { tree: { sha: "base-tree" }, parents: [], message: "base" } })),
        getTree: vi.fn(async ({ tree_sha }: { tree_sha: string }) => ({ data: { truncated: false,
          tree: tree_sha === "candidate-tree"
            ? [{ path: "src", mode: "040000", type: "tree", sha: sha("e") },
              { path: "src/a.ts", mode: "100644", type: "blob", sha: sha("c") }]
            : [{ path: "src", mode: "040000", type: "tree", sha: sha("f") },
              { path: "src/a.ts", mode: "100644", type: "blob", sha: sha("d") }],
        } })),
        getBlob: vi.fn(async () => ({ data: { encoding: "base64",
          content: Buffer.from(input.files[0]!.content, "utf8").toString("base64") } })),
        createBlob: vi.fn(), createTree: vi.fn(), createCommit: vi.fn(), updateRef: vi.fn(),
      },
    } as unknown as Octokit;

    await expect(reconcileExactDraftUpdateWithOctokit(octokit, input)).resolves.toMatchObject({
      status: "applied", result: { commitSha: CREATED, previousHeadSha: PREVIOUS },
    });
    expect(octokit.git.getBlob).toHaveBeenCalledTimes(1);
    expect(octokit.git.updateRef).not.toHaveBeenCalled();
    expect(octokit.git.createCommit).not.toHaveBeenCalled();
  });

  it("does not accept an applied commit that omits an approved new file", async () => {
    const missing = { ...input, files: [...input.files, {
      path: "src/new.ts", content: "export const added = true;\n", mode: "100644" as const,
    }] };
    const octokit = {
      pulls: { get: vi.fn(async () => ({ data: { number: 17,
        html_url: "https://github.com/acme/service/pull/17", state: "open", draft: true,
        base: { ref: "main", repo: { id: 101 } },
        head: { ref: "mendpoint/warden-run", sha: CREATED, repo: { id: 101 } } } })) },
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: CREATED } } })),
        getCommit: vi.fn(async ({ commit_sha }: { commit_sha: string }) => ({ data: commit_sha === CREATED ? {
          tree: { sha: "candidate-tree" }, parents: [{ sha: PREVIOUS }], message: input.commitMessage,
          author: { name: "Mendpoint", email: "delivery@mendpoint.ai", date: input.commitDate },
          committer: { name: "Mendpoint", email: "delivery@mendpoint.ai", date: input.commitDate },
        } : { tree: { sha: "base-tree" }, parents: [], message: "base" } })),
        getTree: vi.fn(async () => ({ data: { truncated: false,
          tree: [{ path: "src/a.ts", mode: "100644", type: "blob", sha: sha("c") }] } })),
        getBlob: vi.fn(async () => ({ data: { encoding: "base64",
          content: Buffer.from(input.files[0]!.content, "utf8").toString("base64") } })),
      },
    } as unknown as Octokit;

    await expect(reconcileExactDraftUpdateWithOctokit(octokit, missing)).resolves.toEqual({ status: "unknown" });
  });

  it("reconciles an exact applied deletion only when the approved leaf is absent", async () => {
    const deletion = {
      ...input,
      files: [{ path: "src/obsolete.ts", delete: true } as never],
    };
    const octokit = {
      pulls: { get: vi.fn(async () => ({ data: {
        number: 17, html_url: "https://github.com/acme/service/pull/17", state: "open", draft: true,
        base: { ref: "main", repo: { id: 101 } },
        head: { ref: "mendpoint/warden-run", sha: CREATED, repo: { id: 101 } },
      } })) },
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: CREATED } } })),
        getCommit: vi.fn(async ({ commit_sha }: { commit_sha: string }) => ({ data: commit_sha === CREATED ? {
          tree: { sha: "candidate-tree" }, parents: [{ sha: PREVIOUS }], message: input.commitMessage,
          author: { name: "Mendpoint", email: "delivery@mendpoint.ai", date: input.commitDate },
          committer: { name: "Mendpoint", email: "delivery@mendpoint.ai", date: input.commitDate },
        } : { tree: { sha: "base-tree" }, parents: [], message: "base" } })),
        getTree: vi.fn(async ({ tree_sha }: { tree_sha: string }) => ({ data: { truncated: false,
          tree: tree_sha === "candidate-tree"
            ? [{ path: "src/a.ts", mode: "100644", type: "blob", sha: sha("c") }]
            : [{ path: "src/a.ts", mode: "100644", type: "blob", sha: sha("c") },
              { path: "src/obsolete.ts", mode: "100644", type: "blob", sha: sha("d") }],
        } })),
        getBlob: vi.fn(),
      },
    } as unknown as Octokit;

    await expect(reconcileExactDraftUpdateWithOctokit(octokit, deletion)).resolves.toMatchObject({
      status: "applied",
      result: { commitSha: CREATED, previousHeadSha: PREVIOUS },
    });
    expect(octokit.git.getBlob).not.toHaveBeenCalled();
  });

  it("reports not applied without writes when the branch is still at the expected head", async () => {
    const octokit = client();
    await expect(reconcileExactDraftUpdateWithOctokit(octokit, input)).resolves.toEqual({ status: "not_applied" });
    expect(octokit.git.createBlob).not.toHaveBeenCalled();
    expect(octokit.git.updateRef).not.toHaveBeenCalled();
  });
});
