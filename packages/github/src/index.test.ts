import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MockGitHubDelivery, OctokitGitHubDelivery } from "./index.js";

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
});
