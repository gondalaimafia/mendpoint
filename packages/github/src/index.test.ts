import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MockGitHubDelivery, OctokitGitHubDelivery } from "./index.js";

const BASE_SHA = "a".repeat(40);
const DRIFTED_BASE_SHA = "b".repeat(40);
const COMMIT_SHA = "c".repeat(40);
const DIVERGENT_SHA = "d".repeat(40);

const EXACT_DRAFT = Object.freeze({
  owner: "acme",
  repo: "shop",
  baseBranch: "main",
  expectedBaseSha: BASE_SHA,
  branch: "mendpoint/transformer/candidate-a",
  commitMessage: "Open approved Transformer candidate",
  commitDate: "2026-08-06T12:00:00.000Z",
  title: "Transformer candidate for review",
  body: "Exact approved candidate. Automatic merge is disabled.",
  files: Object.freeze([{
    path: "src/a.ts",
    content: "export const x = 2\n",
    mode: "100644" as const,
  }]),
});

function githubNotFound(): Error {
  return Object.assign(new Error("Not Found"), { status: 404 });
}

function exactOctokit(input: Readonly<{
  baseSha?: string;
  branchHead?: string;
  branchTree?: string;
  branchParent?: string;
  pulls?: Array<Record<string, unknown>>;
}> = {}) {
  let baseHead = input.baseSha ?? BASE_SHA;
  let branchHead = input.branchHead;
  const pulls = input.pulls ?? [];
  const commitTrees = new Map<string, { tree: string; parents: string[] }>();
  commitTrees.set(BASE_SHA, { tree: "base-tree", parents: [] });
  if (branchHead) {
    commitTrees.set(branchHead, {
      tree: input.branchTree ?? "desired-tree",
      parents: [input.branchParent ?? BASE_SHA],
    });
  }
  const git = {
    getRef: vi.fn(async ({ ref }: { ref: string }) => {
      if (ref === "heads/main") {
        return { data: { object: { sha: baseHead } } };
      }
      if (ref === `heads/${EXACT_DRAFT.branch}` && branchHead) {
        return { data: { object: { sha: branchHead } } };
      }
      throw githubNotFound();
    }),
    createRef: vi.fn(async ({ sha }: { sha: string }) => {
      if (branchHead) throw Object.assign(new Error("Reference already exists"), { status: 422 });
      branchHead = sha;
      return { data: { ref: `refs/heads/${EXACT_DRAFT.branch}`, object: { sha } } };
    }),
    getCommit: vi.fn(async ({ commit_sha }: { commit_sha: string }) => {
      const value = commitTrees.get(commit_sha);
      if (!value) throw githubNotFound();
      return {
        data: {
          sha: commit_sha,
          tree: { sha: value.tree },
          parents: value.parents.map((sha) => ({ sha })),
        },
      };
    }),
    createBlob: vi.fn(async () => ({ data: { sha: "blob-a" } })),
    createTree: vi.fn(async () => ({ data: { sha: "desired-tree" } })),
    createCommit: vi.fn(async () => {
      commitTrees.set(COMMIT_SHA, { tree: "desired-tree", parents: [BASE_SHA] });
      return { data: { sha: COMMIT_SHA } };
    }),
    updateRef: vi.fn(async ({ sha, force }: { sha: string; force: boolean }) => {
      expect(force).toBe(false);
      branchHead = sha;
      return { data: { object: { sha } } };
    }),
  };
  const pullApi = {
    list: vi.fn(async () => ({ data: pulls })),
    create: vi.fn(async (request: Record<string, unknown>) => {
      const pull = {
        number: 17,
        html_url: "https://github.com/acme/shop/pull/17",
        state: "open",
        draft: true,
        title: request.title,
        body: request.body,
        head: { ref: EXACT_DRAFT.branch, sha: branchHead },
        base: { ref: EXACT_DRAFT.baseBranch, sha: baseHead },
      };
      pulls.push(pull);
      return { data: pull };
    }),
  };
  return {
    git,
    pulls: pullApi,
    advanceBase(sha: string) {
      baseHead = sha;
      for (const pull of pulls) {
        const base = pull.base as { ref: string; sha: string } | undefined;
        if (base) base.sha = sha;
      }
    },
  };
}

describe("github mock delivery", () => {
  it("writes a fake PR", async () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-gh-"));
    const gh = new MockGitHubDelivery(root);
    await gh.createBranch("acme", "shop", "mendpoint/test");
    await gh.commitFiles("acme", "shop", "mendpoint/test", "msg", [
      { path: "src/a.ts", content: "export const x = 1\n" },
    ]);
    const pr = await gh.openPullRequest(
      "acme",
      "shop",
      "mendpoint/test",
      "title",
      "body",
    );
    expect(pr.number).toBe(1);
    expect(pr.url).toContain("/pull/1");
    expect(existsSync(join(root, "acme/shop/pulls/1.json"))).toBe(true);
    const saved = JSON.parse(readFileSync(join(root, "acme/shop/pulls/1.json"), "utf8"));
    expect(saved.title).toBe("title");
    expect(saved.draft).toBe(true);
  });

  it("contains every mock owner, branch, and file path", async () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-gh-contained-"));
    const gh = new MockGitHubDelivery(root);

    await expect(gh.createBranch("..", "shop", "mendpoint/test")).rejects.toThrow(
      /invalid github/i,
    );
    await expect(
      gh.createBranch("acme", "shop", "../../../outside"),
    ).rejects.toThrow(/invalid github branch/i);
    await expect(
      gh.commitFiles("acme", "shop", "mendpoint/test", "msg", [
        { path: "../../../../outside.ts", content: "bad\n" },
      ]),
    ).rejects.toThrow(/escapes its root/i);
  });

  it("returns exact immutable evidence and replays the same mock draft", async () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-gh-exact-"));
    const gh = new MockGitHubDelivery(root);

    const first = await gh.deliverExactDraft(EXACT_DRAFT);
    const replay = await gh.deliverExactDraft(EXACT_DRAFT);

    expect(first).toEqual({
      number: 1,
      url: "https://github.com/acme/shop/pull/1",
      branch: EXACT_DRAFT.branch,
      title: EXACT_DRAFT.title,
      draft: true,
      baseBranch: "main",
      baseSha: BASE_SHA,
      commitSha: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    expect(replay).toEqual(first);
  });

  it("persists executable file mode evidence and replays it exactly", async () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-gh-executable-"));
    const gh = new MockGitHubDelivery(root);
    const executableDraft = {
      ...EXACT_DRAFT,
      branch: "mendpoint/transformer/executable-a",
      files: [{ path: "bin/check", content: "#!/bin/sh\nexit 0\n", mode: "100755" as const }],
    };

    const first = await gh.deliverExactDraft(executableDraft);
    await expect(gh.deliverExactDraft(executableDraft)).resolves.toEqual(first);

    const branchDir = join(
      root,
      "acme",
      "shop",
      "branches",
      "mendpoint",
      "transformer",
      "executable-a",
    );
    const metadata = JSON.parse(
      readFileSync(join(branchDir, ".exact-draft.json"), "utf8"),
    ) as { fileModes?: unknown };
    expect(metadata.fileModes).toEqual([{ path: "bin/check", mode: "100755" }]);
    if (process.platform !== "win32") {
      expect(statSync(join(branchDir, "bin", "check")).mode & 0o111).not.toBe(0);
    }
  });
});

describe("octokit real delivery", () => {
  it("errors clearly without token", () => {
    const prev = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    expect(() => new OctokitGitHubDelivery(undefined)).toThrow(/GITHUB_TOKEN/);
    if (prev) process.env.GITHUB_TOKEN = prev;
  });

  it("opens real pull requests as drafts", async () => {
    const delivery = new OctokitGitHubDelivery("test-token");
    const create = vi.fn(async (input: Record<string, unknown>) => ({
      data: {
        number: 7,
        html_url: "https://github.com/acme/shop/pull/7",
        title: input.title,
      },
    }));
    (
      delivery as unknown as {
        octokit: {
          pulls: {
            list: () => Promise<{ data: unknown[] }>;
            create: typeof create;
          };
        };
      }
    ).octokit = {
      pulls: {
        list: async () => ({ data: [] }),
        create,
      },
    };

    await delivery.openPullRequest("acme", "shop", "mendpoint/change", "Fix API", "body");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ draft: true, base: "main" }),
    );
  });

  it("never overwrites an existing recovery branch without an open pull request", async () => {
    const delivery = new OctokitGitHubDelivery("test-token");
    const createBlob = vi.fn();
    (
      delivery as unknown as {
        octokit: {
          git: {
            getRef: () => Promise<{ data: { object: { sha: string } } }>;
            createRef: () => Promise<never>;
            createBlob: typeof createBlob;
          };
          repos: { getContent: () => Promise<{ data: { content: string } }> };
        };
      }
    ).octokit = {
      git: {
        getRef: async () => ({ data: { object: { sha: "base" } } }),
        createRef: async () => {
          throw new Error("Reference already exists");
        },
        createBlob,
      },
      repos: {
        getContent: async () => ({
          data: { content: Buffer.from("reviewer change\n").toString("base64") },
        }),
      },
    };

    await delivery.createBranch("acme", "shop", "mendpoint/change");
    await expect(
      delivery.commitFiles("acme", "shop", "mendpoint/change", "Fix", [
        { path: "src/a.ts", content: "changed\n" },
      ]),
    ).rejects.toThrow(/human reconciliation required/);
    expect(createBlob).not.toHaveBeenCalled();
  });

  it("does not mistake a failed deletion read for an applied recovery", async () => {
    const delivery = new OctokitGitHubDelivery("test-token");
    const createBlob = vi.fn();
    (
      delivery as unknown as {
        octokit: {
          git: {
            getRef: () => Promise<{ data: { object: { sha: string } } }>;
            createRef: () => Promise<never>;
            createBlob: typeof createBlob;
          };
          repos: { getContent: () => Promise<never> };
        };
      }
    ).octokit = {
      git: {
        getRef: async () => ({ data: { object: { sha: "base" } } }),
        createRef: async () => {
          throw new Error("Reference already exists");
        },
        createBlob,
      },
      repos: {
        getContent: async () => {
          throw Object.assign(new Error("service unavailable"), { status: 503 });
        },
      },
    };

    await delivery.createBranch("acme", "shop", "mendpoint/change");
    await expect(delivery.commitFiles("acme", "shop", "mendpoint/change", "Fix", [
      { path: "src/obsolete.ts", delete: true },
    ])).rejects.toThrow(/human reconciliation required/);
    expect(createBlob).not.toHaveBeenCalled();
  });

  it("continues a lost delivery when the existing branch already has the intended patch", async () => {
    const delivery = new OctokitGitHubDelivery("test-token");
    const createBlob = vi.fn();
    (
      delivery as unknown as {
        octokit: {
          git: {
            getRef: () => Promise<{ data: { object: { sha: string } } }>;
            createRef: () => Promise<never>;
            createBlob: typeof createBlob;
          };
          repos: { getContent: () => Promise<{ data: { content: string } }> };
        };
      }
    ).octokit = {
      git: {
        getRef: async () => ({ data: { object: { sha: "base" } } }),
        createRef: async () => {
          throw new Error("Reference already exists");
        },
        createBlob,
      },
      repos: {
        getContent: async () => ({
          data: { content: Buffer.from("changed\n").toString("base64") },
        }),
      },
    };

    await delivery.createBranch("acme", "shop", "mendpoint/change");
    await expect(
      delivery.commitFiles("acme", "shop", "mendpoint/change", "Fix", [
        { path: "src/a.ts", content: "changed\n" },
      ]),
    ).resolves.toBeUndefined();
    expect(createBlob).not.toHaveBeenCalled();
  });

  it("pins PAT delivery to the exact numeric repository identity", async () => {
    const delivery = new OctokitGitHubDelivery("test-token");
    const get = vi.fn(async () => ({
      data: { id: 456, name: "shop", owner: { login: "acme" } },
    }));
    (
      delivery as unknown as {
        octokit: { repos: { get: typeof get } };
      }
    ).octokit = { repos: { get } };

    await expect(delivery.assertRepositoryIdentity("acme", "shop", 456))
      .resolves.toBeUndefined();
    await expect(delivery.assertRepositoryIdentity("acme", "shop", 789))
      .rejects.toThrow("github_repository_identity_mismatch");
    expect(get).toHaveBeenCalledWith({ owner: "acme", repo: "shop" });
  });

  it("delivers an exact non-force draft and returns base, commit, and PR evidence", async () => {
    const delivery = new OctokitGitHubDelivery("test-token");
    const octokit = exactOctokit();
    (delivery as unknown as { octokit: typeof octokit }).octokit = octokit;

    await expect(delivery.deliverExactDraft(EXACT_DRAFT)).resolves.toEqual({
      number: 17,
      url: "https://github.com/acme/shop/pull/17",
      branch: EXACT_DRAFT.branch,
      title: EXACT_DRAFT.title,
      draft: true,
      baseBranch: "main",
      baseSha: BASE_SHA,
      commitSha: COMMIT_SHA,
      remoteTreeSha: "desired-tree",
    });
    expect(octokit.git.createRef).toHaveBeenCalledWith(expect.objectContaining({ sha: BASE_SHA }));
    expect(octokit.git.updateRef).toHaveBeenCalledWith(expect.objectContaining({
      sha: COMMIT_SHA,
      force: false,
    }));
    expect(octokit.git.createCommit).toHaveBeenCalledWith(expect.objectContaining({
      tree: "desired-tree",
      parents: [BASE_SHA],
    }));
    expect(octokit.pulls.create).toHaveBeenCalledWith(expect.objectContaining({
      draft: true,
      base: "main",
      head: EXACT_DRAFT.branch,
    }));
  });

  it("preserves executable mode in the exact Git tree", async () => {
    const delivery = new OctokitGitHubDelivery("test-token");
    const octokit = exactOctokit();
    (delivery as unknown as { octokit: typeof octokit }).octokit = octokit;

    await delivery.deliverExactDraft({
      ...EXACT_DRAFT,
      files: [{ path: "bin/check", content: "#!/bin/sh\nexit 0\n", mode: "100755" }],
    });

    expect(octokit.git.createTree).toHaveBeenCalledWith(expect.objectContaining({
      tree: [expect.objectContaining({ path: "bin/check", mode: "100755", type: "blob" })],
    }));
  });

  it("deletes an approved tracked file with an exact null tree entry", async () => {
    const delivery = new OctokitGitHubDelivery("test-token");
    const octokit = exactOctokit();
    (delivery as unknown as { octokit: typeof octokit }).octokit = octokit;

    await delivery.deliverExactDraft({
      ...EXACT_DRAFT,
      files: [{ path: "src/obsolete.ts", delete: true } as never],
    });

    expect(octokit.git.createBlob).not.toHaveBeenCalled();
    expect(octokit.git.createTree).toHaveBeenCalledWith(expect.objectContaining({
      tree: [{ path: "src/obsolete.ts", mode: "100644", type: "blob", sha: null }],
    }));
  });

  it("rejects unsupported exact draft file modes before GitHub mutation", async () => {
    const delivery = new OctokitGitHubDelivery("test-token");
    const octokit = exactOctokit();
    (delivery as unknown as { octokit: typeof octokit }).octokit = octokit;

    await expect(delivery.deliverExactDraft({
      ...EXACT_DRAFT,
      files: [{
        path: "bin/check",
        content: "#!/bin/sh\nexit 0\n",
        mode: "100600",
      }],
    } as never)).rejects.toThrow("github_exact_draft_files_invalid");
    expect(octokit.git.createRef).not.toHaveBeenCalled();
    expect(octokit.git.createBlob).not.toHaveBeenCalled();
  });

  it("rejects base drift before first branch creation", async () => {
    const delivery = new OctokitGitHubDelivery("test-token");
    const octokit = exactOctokit({ baseSha: DRIFTED_BASE_SHA });
    (delivery as unknown as { octokit: typeof octokit }).octokit = octokit;

    await expect(delivery.deliverExactDraft(EXACT_DRAFT)).rejects.toThrow(
      "github_exact_draft_base_revision_drift",
    );
    expect(octokit.git.createRef).not.toHaveBeenCalled();
    expect(octokit.git.createCommit).not.toHaveBeenCalled();
    expect(octokit.pulls.create).not.toHaveBeenCalled();
  });

  it("recovers an exact draft after the base branch advances", async () => {
    const delivery = new OctokitGitHubDelivery("test-token");
    const octokit = exactOctokit();
    (delivery as unknown as { octokit: typeof octokit }).octokit = octokit;

    const first = await delivery.deliverExactDraft(EXACT_DRAFT);
    octokit.advanceBase(DRIFTED_BASE_SHA);

    await expect(delivery.deliverExactDraft(EXACT_DRAFT)).resolves.toEqual(first);
    expect(octokit.git.createRef).toHaveBeenCalledTimes(1);
    expect(octokit.git.updateRef).toHaveBeenCalledTimes(1);
    expect(octokit.pulls.create).toHaveBeenCalledTimes(1);
  });

  it("recovers idempotently after branch, commit, and pull request boundaries", async () => {
    const delivery = new OctokitGitHubDelivery("test-token");
    const octokit = exactOctokit();
    (delivery as unknown as { octokit: typeof octokit }).octokit = octokit;

    const first = await delivery.deliverExactDraft(EXACT_DRAFT);
    const replay = await delivery.deliverExactDraft(EXACT_DRAFT);

    expect(replay).toEqual(first);
    expect(octokit.git.createRef).toHaveBeenCalledTimes(1);
    expect(octokit.git.createCommit).toHaveBeenCalledTimes(2);
    expect(octokit.git.updateRef).toHaveBeenCalledTimes(1);
    expect(octokit.pulls.create).toHaveBeenCalledTimes(1);
  });

  it("recovers the exact draft when GitHub creates it but the response is lost", async () => {
    const delivery = new OctokitGitHubDelivery("test-token");
    const octokit = exactOctokit();
    const create = octokit.pulls.create.getMockImplementation()!;
    octokit.pulls.create.mockImplementationOnce(async (request) => {
      await create(request);
      throw Object.assign(new Error("socket closed after write"), { code: "ECONNRESET" });
    });
    (delivery as unknown as { octokit: typeof octokit }).octokit = octokit;

    await expect(delivery.deliverExactDraft(EXACT_DRAFT)).resolves.toMatchObject({
      number: 17,
      commitSha: COMMIT_SHA,
      baseSha: BASE_SHA,
      draft: true,
    });
    expect(octokit.pulls.list).toHaveBeenCalledTimes(2);
    expect(octokit.pulls.create).toHaveBeenCalledTimes(1);
  });

  it("recovers the exact draft after a concurrent create returns 422", async () => {
    const delivery = new OctokitGitHubDelivery("test-token");
    const octokit = exactOctokit();
    const create = octokit.pulls.create.getMockImplementation()!;
    octokit.pulls.create.mockImplementationOnce(async (request) => {
      await create(request);
      throw Object.assign(new Error("A pull request already exists"), { status: 422 });
    });
    (delivery as unknown as { octokit: typeof octokit }).octokit = octokit;

    await expect(delivery.deliverExactDraft(EXACT_DRAFT)).resolves.toMatchObject({
      number: 17,
      commitSha: COMMIT_SHA,
      baseSha: BASE_SHA,
      draft: true,
    });
    expect(octokit.pulls.list).toHaveBeenCalledTimes(2);
    expect(octokit.pulls.create).toHaveBeenCalledTimes(1);
  });

  it("marks an absent recovery result as an uncertain remote side effect", async () => {
    const delivery = new OctokitGitHubDelivery("test-token");
    const octokit = exactOctokit();
    octokit.pulls.create.mockRejectedValueOnce(
      Object.assign(new Error("request timed out after write"), { code: "ETIMEDOUT" }),
    );
    (delivery as unknown as { octokit: typeof octokit }).octokit = octokit;

    await expect(delivery.deliverExactDraft(EXACT_DRAFT)).rejects.toMatchObject({
      message: "github_exact_draft_remote_side_effect_uncertain",
      code: "GITHUB_EXACT_DRAFT_REMOTE_SIDE_EFFECT_UNCERTAIN",
      remoteSideEffectUncertain: true,
    });
    expect(octokit.pulls.list).toHaveBeenCalledTimes(2);
  });

  it("rejects a divergent deterministic branch without updating it", async () => {
    const delivery = new OctokitGitHubDelivery("test-token");
    const octokit = exactOctokit({
      branchHead: DIVERGENT_SHA,
      branchTree: "reviewer-tree",
      branchParent: BASE_SHA,
    });
    (delivery as unknown as { octokit: typeof octokit }).octokit = octokit;

    await expect(delivery.deliverExactDraft(EXACT_DRAFT)).rejects.toThrow(
      "github_exact_draft_branch_diverged",
    );
    expect(octokit.git.updateRef).not.toHaveBeenCalled();
    expect(octokit.pulls.create).not.toHaveBeenCalled();
  });

  it("rejects a different commit even when its tree and parent match", async () => {
    const delivery = new OctokitGitHubDelivery("test-token");
    const octokit = exactOctokit({
      branchHead: DIVERGENT_SHA,
      branchTree: "desired-tree",
      branchParent: BASE_SHA,
    });
    (delivery as unknown as { octokit: typeof octokit }).octokit = octokit;

    await expect(delivery.deliverExactDraft(EXACT_DRAFT)).rejects.toThrow(
      "github_exact_draft_branch_diverged",
    );
    expect(octokit.git.updateRef).not.toHaveBeenCalled();
    expect(octokit.pulls.create).not.toHaveBeenCalled();
  });

  it("rejects an existing pull request whose draft evidence does not match", async () => {
    const mismatchedPull = {
      number: 19,
      html_url: "https://github.com/acme/shop/pull/19",
      state: "open",
      draft: true,
      title: EXACT_DRAFT.title,
      body: EXACT_DRAFT.body,
      head: { ref: EXACT_DRAFT.branch, sha: COMMIT_SHA },
      base: { ref: "release", sha: DRIFTED_BASE_SHA },
    };
    const delivery = new OctokitGitHubDelivery("test-token");
    const octokit = exactOctokit({
      branchHead: COMMIT_SHA,
      branchTree: "desired-tree",
      branchParent: BASE_SHA,
      pulls: [mismatchedPull],
    });
    (delivery as unknown as { octokit: typeof octokit }).octokit = octokit;

    await expect(delivery.deliverExactDraft(EXACT_DRAFT)).rejects.toThrow(
      "github_exact_draft_pull_request_diverged",
    );
    expect(octokit.pulls.create).not.toHaveBeenCalled();
  });
});
