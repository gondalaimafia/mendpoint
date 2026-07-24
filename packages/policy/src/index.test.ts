import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, evaluatePolicy, filterFindingsByPolicy } from "./index.js";

const baseDraft = {
  title: "t",
  body: "b",
  branchName: "br",
  patch: "",
  risk: "breaking" as const,
  confidence: "high" as const,
  fileEdits: [
    { path: "src/api.ts", original: "a", updated: "b" },
    { path: ".env.production", original: "k=1", updated: "k=2" },
    { path: "config/prod/secrets.yaml", original: "x", updated: "y" },
  ],
};

afterEach(() => {
  delete process.env.ALLOW_AUTO_MERGE;
});

describe("policy engine", () => {
  it("defaults never auto-merge", () => {
    expect(DEFAULT_POLICY.autoMergeLowRisk).toBe(false);
    const d = evaluatePolicy(baseDraft, []);
    expect(d.allowAutoMerge).toBe(false);
    expect(d.labels).toContain("needs-human-review");
  });

  it("hard-offs auto-merge even when policy flag true without env", () => {
    const draft = { ...baseDraft, risk: "non_breaking" as const };
    const d = evaluatePolicy(draft, [], {
      policy: { autoMergeLowRisk: true },
    });
    expect(d.allowAutoMerge).toBe(false);
    expect(d.labels).toContain("needs-human-review");
    expect(d.reasons.some((r) => r.includes("auto-merge"))).toBe(true);
  });

  it("allows auto-merge only when env set and non_breaking with policy flag", () => {
    process.env.ALLOW_AUTO_MERGE = "true";
    const draft = { ...baseDraft, risk: "non_breaking" as const };
    const d = evaluatePolicy(draft, [], {
      policy: { autoMergeLowRisk: true },
    });
    expect(d.allowAutoMerge).toBe(true);
    expect(d.labels).toContain("auto-merge-eligible");
  });

  it("blocks denylisted paths", () => {
    const d = evaluatePolicy(baseDraft, [
      {
        filePath: "src/api.ts",
        lineStart: 1,
        lineEnd: 1,
        symbol: "x",
        confidence: "high",
        evidence: "x",
        relatedOps: [],
      },
    ]);
    expect(d.blockedFiles.some((p) => p.includes(".env") || p.includes("prod"))).toBe(true);
    expect(d.allowedEdits.every((e) => e.path === "src/api.ts")).toBe(true);
    expect(d.allowPr).toBe(true);
  });

  it("flags auth findings for two reviewers", () => {
    const d = evaluatePolicy(baseDraft, [
      {
        filePath: "src/api.ts",
        lineStart: 1,
        lineEnd: 1,
        symbol: "X-API-Key",
        confidence: "high",
        evidence: "Authorization header",
        relatedOps: ["security_changed"],
      },
    ]);
    expect(d.labels).toContain("needs-two-reviewers");
  });

  it("filterFindingsByPolicy drops low confidence and blocked paths", () => {
    const f = filterFindingsByPolicy([
      {
        filePath: ".env",
        lineStart: 1,
        lineEnd: 1,
        symbol: "KEY",
        confidence: "high",
        evidence: "x",
        relatedOps: [],
      },
      {
        filePath: "src/a.ts",
        lineStart: 1,
        lineEnd: 1,
        symbol: "x",
        confidence: "low",
        evidence: "x",
        relatedOps: [],
      },
      {
        filePath: "src/a.ts",
        lineStart: 2,
        lineEnd: 2,
        symbol: "y",
        confidence: "high",
        evidence: "y",
        relatedOps: [],
      },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.symbol).toBe("y");
  });
});
