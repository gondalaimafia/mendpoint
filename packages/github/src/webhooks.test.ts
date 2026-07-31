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
      repository: { name: "r", owner: { login: "o" } },
    });
    expect(n.type).toBe("pull_request");
    if (n.type === "pull_request") {
      expect(prFeedbackFromWebhook(n)).toBe("merged");
      expect(n.number).toBe(3);
    }
  });

  it("normalizes installation", () => {
    const n = normalizeGitHubEvent("installation", {
      action: "created",
      installation: { id: 99, account: { login: "acme" } },
      repositories: [{ full_name: "acme/shop" }],
    });
    expect(n.type).toBe("installation");
    if (n.type === "installation") {
      expect(n.installationId).toBe(99);
      expect(n.repos?.[0]?.name).toBe("shop");
    }
  });

  it("normalizes repository additions and removals", () => {
    const n = normalizeGitHubEvent("installation_repositories", {
      action: "removed",
      installation: { id: 99, account: { login: "acme" } },
      repositories_added: [{ full_name: "acme/new" }],
      repositories_removed: [{ full_name: "acme/old" }],
    });
    expect(n.type).toBe("installation");
    if (n.type === "installation") {
      expect(n.reposAdded).toEqual([{ owner: "acme", name: "new" }]);
      expect(n.reposRemoved).toEqual([{ owner: "acme", name: "old" }]);
    }
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
    expect(body).toContain("Warden CI check (Mendpoint)");
    expect(body).toContain("TypeScript");
    expect(body).toContain("Never auto-merges");
  });
});
