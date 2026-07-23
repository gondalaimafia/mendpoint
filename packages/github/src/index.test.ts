import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
  });
});

describe("octokit real delivery", () => {
  it("errors clearly without token", () => {
    const prev = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    expect(() => new OctokitGitHubDelivery(undefined)).toThrow(/GITHUB_TOKEN/);
    if (prev) process.env.GITHUB_TOKEN = prev;
  });
});
