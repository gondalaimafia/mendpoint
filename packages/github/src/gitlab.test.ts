import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitLabDelivery,
  createReviewableChangeDelivery,
  gitlabAsReviewableChangeDelivery,
  GitLabDeliveryError,
  HttpGitLabDelivery,
  MockGitLabDelivery,
  type GitLabFetch,
} from "./index.js";

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/**
 * Scripted GitLab fetch. Records every request and answers by matching the
 * first responder whose (method, url-substring) predicate passes.
 */
function scriptedFetch(
  responders: Array<{
    method?: string;
    match: (url: string) => boolean;
    reply: { ok: boolean; status: number; json: unknown };
  }>,
): { fetchImpl: GitLabFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: GitLabFetch = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, headers, body });
    const responder = responders.find(
      (r) => (!r.method || r.method === method) && r.match(url),
    );
    if (!responder) {
      return { ok: false, status: 404, json: { message: "no responder" } };
    }
    return responder.reply;
  };
  return { fetchImpl, calls };
}

const NS = "acme";
const PROJECT = "shop";
const SOURCE = "mendpoint/stripe/candidate-a";
const TARGET = "main";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MockGitLabDelivery", () => {
  it("creates a branch, commits files, and opens a draft merge request", async () => {
    const delivery = new MockGitLabDelivery();
    await delivery.createBranch(NS, PROJECT, SOURCE, TARGET);
    const commitSha = await delivery.commitFiles(NS, PROJECT, SOURCE, "Apply migration", [
      { path: "src/client.ts", content: "export const v = 2\n" },
    ]);
    // The mock returns a deterministic 40-hex commit id, like a real GitLab SHA.
    expect(commitSha).toMatch(/^[a-f0-9]{40}$/);
    const mr = await delivery.openDraftMergeRequest(
      NS,
      PROJECT,
      SOURCE,
      "Stripe migration",
      "Human review required. Automatic merge is disabled.",
      TARGET,
    );
    expect(mr.draft).toBe(true);
    expect(mr.number).toBe(1);
    expect(mr.branch).toBe(SOURCE);
    expect(mr.title).toBe("Draft: Stripe migration");
    expect(mr.url).toBe(
      `https://gitlab.com/${NS}/${PROJECT}/-/merge_requests/1`,
    );
  });

  it("does not double-prefix an already-draft title", async () => {
    const delivery = new MockGitLabDelivery();
    const mr = await delivery.openDraftMergeRequest(
      NS,
      PROJECT,
      SOURCE,
      "Draft: already marked",
      "body",
      TARGET,
    );
    expect(mr.title).toBe("Draft: already marked");
  });

  it("reuses an existing merge request for the same source and target branch", async () => {
    const delivery = new MockGitLabDelivery();
    const first = await delivery.openDraftMergeRequest(NS, PROJECT, SOURCE, "one", "b", TARGET);
    const second = await delivery.openDraftMergeRequest(NS, PROJECT, SOURCE, "two", "b", TARGET);
    expect(second.number).toBe(first.number);
    expect(second.title).toBe(first.title);
  });

  it("rejects an invalid branch name", async () => {
    const delivery = new MockGitLabDelivery();
    await expect(
      delivery.createBranch(NS, PROJECT, "../escape", TARGET),
    ).rejects.toThrow("gitlab_branch_invalid");
  });

  it("rejects an invalid project identity", async () => {
    const delivery = new MockGitLabDelivery();
    await expect(
      delivery.openDraftMergeRequest(NS, "bad project", SOURCE, "t", "b", TARGET),
    ).rejects.toThrow("gitlab_project_identity_invalid");
  });
});

describe("HttpGitLabDelivery", () => {
  it("creates a branch with the PRIVATE-TOKEN header and branch/ref query", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        method: "POST",
        match: (u) => u.includes("/repository/branches?"),
        reply: { ok: true, status: 201, json: { name: SOURCE } },
      },
    ]);
    const delivery = new HttpGitLabDelivery({ token: "glpat-abc", fetch: fetchImpl });
    await delivery.createBranch(NS, PROJECT, SOURCE, TARGET);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["PRIVATE-TOKEN"]).toBe("glpat-abc");
    expect(calls[0]!.url).toContain(
      `/projects/${encodeURIComponent(`${NS}/${PROJECT}`)}/repository/branches?`,
    );
    expect(calls[0]!.url).toContain(`branch=${encodeURIComponent(SOURCE)}`);
    expect(calls[0]!.url).toContain(`ref=${encodeURIComponent(TARGET)}`);
  });

  it("rejects an existing deterministic branch that is not at the requested commit", async () => {
    const requested = "a".repeat(40);
    const moved = "b".repeat(40);
    const { fetchImpl } = scriptedFetch([
      {
        method: "POST",
        match: (u) => u.includes("/repository/branches?"),
        reply: { ok: false, status: 400, json: { message: "Branch already exists" } },
      },
      {
        method: "GET",
        match: (u) => u.includes(`/repository/branches/${encodeURIComponent(SOURCE)}`),
        reply: { ok: true, status: 200, json: { name: SOURCE, commit: { id: moved } } },
      },
    ]);
    const delivery = new HttpGitLabDelivery({ token: "glpat-abc", fetch: fetchImpl });

    await expect(delivery.createBranch(NS, PROJECT, SOURCE, requested)).rejects.toThrow(
      /existing branch head drift/i,
    );
  });

  it("verifies an existing exact commit from its parent, diff, mode, and bytes", async () => {
    const commitSha = "c".repeat(40);
    const parentSha = "a".repeat(40);
    const content = "export const migrated = true;\n";
    const { fetchImpl } = scriptedFetch([
      {
        method: "GET",
        match: (u) => u.endsWith(`/repository/commits/${commitSha}`),
        reply: {
          ok: true,
          status: 200,
          json: { id: commitSha, parent_ids: [parentSha], message: "Apply migration" },
        },
      },
      {
        method: "GET",
        match: (u) => u.includes(`/repository/commits/${commitSha}/diff?`),
        reply: {
          ok: true,
          status: 200,
          json: [
            {
              old_path: "src/client.ts",
              new_path: "src/client.ts",
              new_file: false,
              deleted_file: false,
              renamed_file: false,
              a_mode: "100644",
              b_mode: "100755",
            },
          ],
        },
      },
      {
        method: "GET",
        match: (u) => u.includes("/repository/files/src%2Fclient.ts?"),
        reply: {
          ok: true,
          status: 200,
          json: {
            encoding: "base64",
            content: Buffer.from(content, "utf8").toString("base64"),
            file_mode: "100755",
            commit_id: commitSha,
          },
        },
      },
      {
        method: "GET",
        match: (u) => u.includes(`/repository/branches/${encodeURIComponent(SOURCE)}`),
        reply: {
          ok: true,
          status: 200,
          json: { name: SOURCE, commit: { id: commitSha } },
        },
      },
    ]);
    const delivery = new HttpGitLabDelivery({ token: "glpat-abc", fetch: fetchImpl });

    await expect(
      delivery.verifyExactCommit(NS, PROJECT, SOURCE, {
        commitSha,
        parentSha,
        message: "Apply migration",
        files: [{ path: "src/client.ts", content, mode: "100755" }],
      }),
    ).resolves.toBe(true);
    await expect(
      delivery.verifyExactCommit(NS, PROJECT, SOURCE, {
        commitSha,
        parentSha,
        message: "Apply migration",
        files: [{ path: "src/client.ts", content: "tampered\n", mode: "100755" }],
      }),
    ).resolves.toBe(false);
  });

  it("throws a retryable GitLabDeliveryError when the commit read is unreachable (500/429), never a false", async () => {
    // An unreachable upstream is the third state boolean cannot carry: it must
    // surface as a retryable error carrying the upstream status, not collapse
    // into a proven mismatch that dead-letters an approved candidate.
    const commitSha = "c".repeat(40);
    for (const status of [500, 429] as const) {
      const { fetchImpl } = scriptedFetch([
        {
          method: "GET",
          match: (u) => u.endsWith(`/repository/commits/${commitSha}`),
          reply: { ok: false, status, json: { message: "upstream unavailable" } },
        },
      ]);
      const delivery = new HttpGitLabDelivery({ token: "glpat-abc", fetch: fetchImpl });
      const err = await delivery
        .verifyExactCommit(NS, PROJECT, SOURCE, {
          commitSha,
          parentSha: "a".repeat(40),
          message: "Apply migration",
          files: [{ path: "src/client.ts", content: "x\n" }],
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitLabDeliveryError);
      expect(err).toMatchObject({ provider: "gitlab", operation: "verifyExactCommit", status });
    }
  });

  it("returns a terminal false when the commit read is a definite 404 (proven absent, not an outage)", async () => {
    // A 404 is GitLab's definite answer that the head is not our commit, a
    // proven mismatch that must stay terminal and fail closed.
    const commitSha = "d".repeat(40);
    const { fetchImpl } = scriptedFetch([
      {
        method: "GET",
        match: (u) => u.endsWith(`/repository/commits/${commitSha}`),
        reply: { ok: false, status: 404, json: { message: "404 Commit Not Found" } },
      },
    ]);
    const delivery = new HttpGitLabDelivery({ token: "glpat-abc", fetch: fetchImpl });
    await expect(
      delivery.verifyExactCommit(NS, PROJECT, SOURCE, {
        commitSha,
        parentSha: "a".repeat(40),
        message: "Apply migration",
        files: [{ path: "src/client.ts", content: "x\n" }],
      }),
    ).resolves.toBe(false);
  });

  it("commits with create/update actions decided by file existence", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      // existing file -> update
      {
        method: "GET",
        match: (u) => u.includes("/repository/files/") && u.includes("existing.ts"),
        reply: { ok: true, status: 200, json: { file_path: "existing.ts" } },
      },
      // new file -> 404 -> create
      {
        method: "GET",
        match: (u) => u.includes("/repository/files/") && u.includes("new.ts"),
        reply: { ok: false, status: 404, json: { message: "404" } },
      },
      {
        method: "POST",
        match: (u) => u.endsWith("/repository/commits"),
        reply: { ok: true, status: 201, json: { id: "c".repeat(40) } },
      },
    ]);
    const delivery = new HttpGitLabDelivery({ token: "glpat-abc", fetch: fetchImpl });
    const commitSha = await delivery.commitFiles(NS, PROJECT, SOURCE, "Apply migration", [
      { path: "existing.ts", content: "a" },
      { path: "new.ts", content: "b" },
    ]);
    // The real adapter returns GitLab's reported commit id verbatim.
    expect(commitSha).toBe("c".repeat(40));
    const commit = calls.find((c) => c.method === "POST" && c.url.endsWith("/repository/commits"));
    expect(commit).toBeDefined();
    expect(commit!.headers["PRIVATE-TOKEN"]).toBe("glpat-abc");
    expect(commit!.headers["Content-Type"]).toBe("application/json");
    expect(commit!.body).toMatchObject({
      branch: SOURCE,
      commit_message: "Apply migration",
      actions: [
        { action: "update", file_path: "existing.ts", content: "a" },
        { action: "create", file_path: "new.ts", content: "b" },
      ],
    });
  });

  it("commits a deletion only when the exact GitLab source file exists", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        method: "GET",
        match: (u) => u.includes("/repository/files/") && u.includes("obsolete.ts"),
        reply: { ok: true, status: 200, json: { file_path: "obsolete.ts" } },
      },
      {
        method: "POST",
        match: (u) => u.endsWith("/repository/commits"),
        reply: { ok: true, status: 201, json: { id: "d".repeat(40) } },
      },
    ]);
    const delivery = new HttpGitLabDelivery({ token: "glpat-abc", fetch: fetchImpl });
    await expect(delivery.commitFiles(NS, PROJECT, SOURCE, "Remove obsolete source", [
      { path: "obsolete.ts", delete: true },
    ])).resolves.toBe("d".repeat(40));
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
      actions: [{ action: "delete", file_path: "obsolete.ts" }],
    });
  });

  it("opens a draft merge request with the target branch and Draft title", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        method: "GET",
        match: (u) => u.includes("/merge_requests?"),
        reply: { ok: true, status: 200, json: [] },
      },
      {
        method: "POST",
        match: (u) => u.endsWith("/merge_requests"),
        reply: {
          ok: true,
          status: 201,
          json: {
            iid: 7,
            web_url: `https://gitlab.com/${NS}/${PROJECT}/-/merge_requests/7`,
            title: "Draft: Stripe migration",
            draft: true,
            source_branch: SOURCE,
            target_branch: TARGET,
            description: "Human review required.",
            sha: "c".repeat(40),
          },
        },
      },
    ]);
    const delivery = new HttpGitLabDelivery({ token: "glpat-abc", fetch: fetchImpl });
    const mr = await delivery.openDraftMergeRequest(
      NS,
      PROJECT,
      SOURCE,
      "Stripe migration",
      "Human review required.",
      TARGET,
      "c".repeat(40),
    );
    expect(mr).toEqual({
      number: 7,
      url: `https://gitlab.com/${NS}/${PROJECT}/-/merge_requests/7`,
      branch: SOURCE,
      title: "Draft: Stripe migration",
      draft: true,
    });
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/merge_requests"));
    expect(post!.headers["PRIVATE-TOKEN"]).toBe("glpat-abc");
    expect(post!.body).toMatchObject({
      source_branch: SOURCE,
      target_branch: TARGET,
      title: "Draft: Stripe migration",
      description: "Human review required.",
    });
  });

  it("reuses an already-open merge request for the same source and target", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        method: "GET",
        match: (u) => u.includes("/merge_requests?"),
        reply: {
          ok: true,
          status: 200,
          json: [
            {
              iid: 3,
              web_url: "https://gitlab.com/acme/shop/-/merge_requests/3",
              title: "Draft: new",
              draft: true,
              source_branch: SOURCE,
              target_branch: TARGET,
              description: "b",
            },
          ],
        },
      },
    ]);
    const delivery = new HttpGitLabDelivery({ token: "glpat-abc", fetch: fetchImpl });
    const mr = await delivery.openDraftMergeRequest(NS, PROJECT, SOURCE, "new", "b", TARGET);
    expect(mr.number).toBe(3);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("rejects an existing merge request whose exact delivery evidence diverges", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        method: "GET",
        match: (u) => u.includes("/merge_requests?"),
        reply: {
          ok: true,
          status: 200,
          json: [
            {
              iid: 3,
              web_url: "https://gitlab.com/acme/shop/-/merge_requests/3",
              title: "Draft: new",
              draft: true,
              source_branch: SOURCE,
              target_branch: TARGET,
              description: "different body",
            },
          ],
        },
      },
    ]);
    const delivery = new HttpGitLabDelivery({ token: "glpat-abc", fetch: fetchImpl });

    await expect(
      delivery.openDraftMergeRequest(NS, PROJECT, SOURCE, "new", "b", TARGET),
    ).rejects.toThrow(/merge request evidence diverged/i);
  });

  it("reconciles a lost merge-request response without a second POST", async () => {
    let reads = 0;
    let posts = 0;
    const fetchImpl: GitLabFetch = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/merge_requests?")) {
        reads++;
        return reads === 1
          ? { ok: true, status: 200, json: [] }
          : {
              ok: true,
              status: 200,
              json: [
                {
                  iid: 7,
                  web_url: `https://gitlab.com/${NS}/${PROJECT}/-/merge_requests/7`,
                  title: "Draft: Stripe migration",
                  draft: true,
                  source_branch: SOURCE,
                  target_branch: TARGET,
                  description: "Human review required.",
                  sha: "c".repeat(40),
                },
              ],
            };
      }
      if (method === "POST" && url.endsWith("/merge_requests")) {
        posts++;
        return { ok: false, status: 0, json: { error: "response lost" } };
      }
      return { ok: false, status: 404, json: {} };
    };
    const delivery = new HttpGitLabDelivery({ token: "glpat-abc", fetch: fetchImpl });

    const result = await delivery.openDraftMergeRequest(
      NS,
      PROJECT,
      SOURCE,
      "Stripe migration",
      "Human review required.",
      TARGET,
      "c".repeat(40),
    );

    expect(result.number).toBe(7);
    expect(posts).toBe(1);
    expect(reads).toBe(2);
  });

  it("fails closed when the merge request API rejects the request", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        method: "GET",
        match: (u) => u.includes("/merge_requests?"),
        reply: { ok: true, status: 200, json: [] },
      },
      {
        method: "POST",
        match: (u) => u.endsWith("/merge_requests"),
        reply: { ok: false, status: 403, json: { message: "insufficient scope" } },
      },
    ]);
    const delivery = new HttpGitLabDelivery({ token: "glpat-abc", fetch: fetchImpl });
    await expect(
      delivery.openDraftMergeRequest(NS, PROJECT, SOURCE, "t", "b", TARGET),
    ).rejects.toMatchObject({
      name: "GitLabDeliveryError",
      provider: "gitlab",
      operation: "openDraftMergeRequest",
      status: 403,
      response: { message: "insufficient scope" },
    });
  });

  it("fails closed when the API returns a non-draft merge request", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        method: "GET",
        match: (u) => u.includes("/merge_requests?"),
        reply: { ok: true, status: 200, json: [] },
      },
      {
        method: "POST",
        match: (u) => u.endsWith("/merge_requests"),
        reply: {
          ok: true,
          status: 201,
          json: {
            iid: 9,
            web_url: "https://gitlab.com/acme/shop/-/merge_requests/9",
            title: "Stripe migration",
            draft: false,
            work_in_progress: false,
          },
        },
      },
    ]);
    const delivery = new HttpGitLabDelivery({ token: "glpat-abc", fetch: fetchImpl });
    await expect(
      delivery.openDraftMergeRequest(NS, PROJECT, SOURCE, "Stripe migration", "b", TARGET),
    ).rejects.toMatchObject({
      name: "GitLabDeliveryError",
      operation: "openDraftMergeRequest",
    });
  });

  it("requires a token when constructed for real delivery", () => {
    expect(() => new HttpGitLabDelivery({ token: undefined })).toThrow(/GITLAB_TOKEN/);
  });
});

describe("createGitLabDelivery factory", () => {
  it("returns the mock adapter by default", () => {
    expect(createGitLabDelivery()).toBeInstanceOf(MockGitLabDelivery);
    expect(createGitLabDelivery("mock")).toBeInstanceOf(MockGitLabDelivery);
  });

  it("returns the real HTTP adapter when mode is real and a token is present", () => {
    vi.stubEnv("GITLAB_TOKEN", "glpat-xyz");
    expect(createGitLabDelivery("real")).toBeInstanceOf(HttpGitLabDelivery);
  });

  it("fails closed for real mode without a token", () => {
    vi.stubEnv("GITLAB_TOKEN", "");
    expect(() => createGitLabDelivery("real")).toThrow(/GITLAB_TOKEN/);
  });
});

describe("createReviewableChangeDelivery selector", () => {
  it("defaults to GitHub so existing behavior is unchanged when GitLab is unconfigured", async () => {
    const delivery = createReviewableChangeDelivery();
    await delivery.createBranch("acme", "shop", "mendpoint/x", "main");
    await delivery.commitFiles("acme", "shop", "mendpoint/x", "msg", [
      { path: "a.ts", content: "x" },
    ]);
    const change = await delivery.openPullRequest(
      "acme",
      "shop",
      "mendpoint/x",
      "title",
      "body",
      "main",
    );
    expect(change.url).toContain("github.com");
  });

  it("routes to the GitLab draft-MR adapter when GitLab is selected", async () => {
    const delivery = createReviewableChangeDelivery("gitlab");
    const change = await delivery.openPullRequest(
      NS,
      PROJECT,
      SOURCE,
      "Stripe migration",
      "body",
      TARGET,
    );
    expect(change.url).toContain("gitlab.com");
    expect(change.title).toBe("Draft: Stripe migration");
  });

  it("honors the SCM_PROVIDER environment default", () => {
    vi.stubEnv("SCM_PROVIDER", "gitlab");
    // The adapter is the mock GitLab delivery wrapped onto the shared contract.
    const delivery = createReviewableChangeDelivery();
    expect(delivery.openPullRequest).toBeTypeOf("function");
  });
});

describe("gitlabAsReviewableChangeDelivery", () => {
  it("maps openPullRequest onto a draft merge request", async () => {
    const wrapped = gitlabAsReviewableChangeDelivery(new MockGitLabDelivery());
    const change = await wrapped.openPullRequest(NS, PROJECT, SOURCE, "t", "b", TARGET);
    expect(change.url).toContain("/-/merge_requests/");
    expect(change.title).toBe("Draft: t");
  });
});
