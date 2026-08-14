import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizeGitHubEvent,
  prFeedbackFromWebhook,
  verifyGitHubSignature,
} from "./webhooks.js";
import { formatCiCheckComment } from "./checks.js";

describe("github webhooks", () => {
  it("verifies HMAC sha256", () => {
    const body = '{"zen":"x"}';
    const secret = "s3cret";
    const sig =
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyGitHubSignature(body, sig, secret)).toBe(true);
    expect(verifyGitHubSignature(body, "sha256=dead", secret)).toBe(false);
    expect(verifyGitHubSignature(body, undefined, undefined)).toBe(true);
    expect(verifyGitHubSignature(body, undefined, undefined, { requireSecret: true })).toBe(
      false,
    );
  });

  it("normalizes pull_request closed merged", () => {
    const n = normalizeGitHubEvent("pull_request", {
      action: "closed",
      pull_request: {
        number: 3,
        merged: true,
        state: "closed",
        title: "migrate",
        html_url: "https://github.com/o/r/pull/3",
        head: { ref: "mendpoint/x" },
        labels: [{ name: "mendpoint" }],
      },
      repository: { id: 77, name: "r", owner: { id: 7123456, login: "o" } },
      installation: { id: 99 },
    });
    expect(n.type).toBe("pull_request");
    if (n.type === "pull_request") {
      expect(prFeedbackFromWebhook(n)).toBe("merged");
      expect(n.number).toBe(3);
      expect(n.repositoryId).toBe(77);
      expect(n.accountId).toBe(7123456);
      expect(n.installationId).toBe(99);
    }
  });

  it("does not manufacture pull request identity from mutable names", () => {
    const n = normalizeGitHubEvent("pull_request", {
      action: "closed",
      pull_request: { number: 3, merged: false, state: "closed" },
      repository: { name: "recycled", owner: { login: "recycled-owner" } },
    });
    expect(n.type).toBe("pull_request");
    if (n.type === "pull_request") {
      expect(n.repositoryId).toBeUndefined();
      expect(n.accountId).toBeUndefined();
      expect(n.installationId).toBeUndefined();
    }
  });

  it("normalizes installation", () => {
    const n = normalizeGitHubEvent("installation", {
      action: "created",
      installation: {
        id: 99,
        account: { id: 7123456, login: "acme" },
        permissions: { contents: "write", checks: "read" },
      },
      repositories: [{ full_name: "acme/shop" }],
    });
    expect(n.type).toBe("installation");
    if (n.type === "installation") {
      expect(n.installationId).toBe(99);
      expect(n.accountId).toBe(7123456);
      expect(n.accountLogin).toBe("acme");
      expect(n.repos?.[0]?.name).toBe("shop");
      expect(n.permissions).toEqual({ contents: "write", checks: "read" });
    }
  });

  it("does not manufacture a stable account identity from a mutable login", () => {
    const n = normalizeGitHubEvent("installation", {
      action: "created",
      installation: { id: 99, account: { login: "recycled-login" } },
    });
    expect(n.type).toBe("installation");
    if (n.type === "installation") {
      expect(n.accountId).toBeUndefined();
      expect(n.accountLogin).toBe("recycled-login");
    }
  });

  it("normalizes repository additions and removals", () => {
    const n = normalizeGitHubEvent("installation_repositories", {
      action: "removed",
      installation: { id: 99, account: { id: 7123456, login: "acme" } },
      repositories_added: [{ full_name: "acme/new" }],
      repositories_removed: [{ full_name: "acme/old" }],
    });
    expect(n.type).toBe("installation");
    if (n.type === "installation") {
      expect(n.reposAdded).toEqual([{ owner: "acme", name: "new" }]);
      expect(n.reposRemoved).toEqual([{ owner: "acme", name: "old" }]);
    }
  });

  it.each([
    ["pull_request_review", "review", { review: { id: 71, commit_id: "b".repeat(40), body: "untrusted" } }],
    ["pull_request_review_comment", "comment", { comment: { id: 72, commit_id: "b".repeat(40), body: "untrusted" } }],
  ])("normalizes %s as a stable wake-only review event", (eventName, source, resource) => {
    const normalized = normalizeGitHubEvent(eventName, {
      action: "submitted",
      ...resource,
      pull_request: { number: 17, head: { sha: "b".repeat(40) } },
      repository: { id: 77, name: "service", owner: { id: 7123456, login: "acme" } },
      installation: { id: 99 },
    });

    expect(normalized).toEqual({
      type: "pull_request_review",
      source,
      action: "submitted",
      owner: "acme",
      repo: "service",
      repositoryId: 77,
      accountId: 7123456,
      installationId: 99,
      pullRequestNumber: 17,
      headSha: "b".repeat(40),
      sourceId: source === "review" ? 71 : 72,
    });
    expect(JSON.stringify(normalized)).not.toContain("untrusted");
  });
});

describe("ci check comment", () => {
  it("formats harness table", () => {
    const body = formatCiCheckComment({
      owner: "o",
      repo: "r",
      prNumber: 1,
      title: "t",
      risk: "breaking",
      findings: 4,
      harness: [
        { name: "TypeScript", passed: true, recall: 1, threshold: 0.7 },
        { name: "Go", passed: true, recall: 0.8, threshold: 0.7 },
      ],
      policyNotes: ["Auto-merge disabled"],
    });
    expect(body).toContain("Fettler CI check (Mendpoint)");
    expect(body).toContain("TypeScript");
    expect(body).toContain("Never auto-merges");
  });
});
