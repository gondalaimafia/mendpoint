import { describe, expect, it } from "vitest";
import type { ImpactFinding, MigrationDraft } from "@mendpoint/shared";
import { filterRepairEdits } from "./repair-policy.js";

const draft: MigrationDraft = {
  title: "t",
  body: "b",
  branchName: "br",
  patch: "",
  risk: "breaking",
  confidence: "high",
  fileEdits: [],
};

function finding(filePath: string, confidence: ImpactFinding["confidence"]): ImpactFinding {
  return {
    filePath,
    lineStart: 1,
    lineEnd: 1,
    symbol: "sym",
    confidence,
    evidence: "e",
    relatedOps: [],
  };
}

describe("filterRepairEdits routes repair edits through the policy filter", () => {
  it("rejects a repair edit targeting a denylisted path instead of appending it", () => {
    const result = filterRepairEdits({
      draft,
      findings: [],
      policy: {},
      edits: [
        { filePath: "terraform/main.tf", original: "x", updated: "y" },
        { filePath: "src/ok.ts", original: "a", updated: "b" },
      ],
      existingPaths: [],
    });
    expect(result.blocked).toContain("terraform/main.tf");
    expect(result.allowed.map((e) => e.path)).toEqual(["src/ok.ts"]);
  });

  it("rejects a repair edit below the confidence threshold", () => {
    // Default minConfidenceForEdit is "medium"; a mapped low-confidence finding
    // must suppress the edit even though it is not denylisted.
    const result = filterRepairEdits({
      draft,
      findings: [finding("src/low.ts", "low")],
      policy: {},
      edits: [{ filePath: "src/low.ts", original: "a", updated: "b" }],
      existingPaths: [],
    });
    expect(result.allowed).toHaveLength(0);
    expect(result.blocked).toHaveLength(0);
  });

  it("keeps a legitimate repair edit so the working path survives", () => {
    const result = filterRepairEdits({
      draft,
      findings: [finding("src/high.ts", "high")],
      policy: {},
      edits: [{ filePath: "src/high.ts", original: "a", updated: "b" }],
      existingPaths: [],
    });
    expect(result.allowed.map((e) => e.path)).toEqual(["src/high.ts"]);
    expect(result.allowed[0]!.updated).toBe("b");
  });

  it("skips repair edits the draft decision already carries", () => {
    const result = filterRepairEdits({
      draft,
      findings: [],
      policy: {},
      edits: [{ filePath: "src/already.ts", original: "a", updated: "b" }],
      existingPaths: ["src/already.ts"],
    });
    expect(result.allowed).toHaveLength(0);
    expect(result.blocked).toHaveLength(0);
  });

  it("honors a tenant override but still applies the baseline denylist", () => {
    // A short tenant override (the seeded 5-entry list) must not shrink the
    // baseline: id_rsa stays blocked even though the override omits it.
    const result = filterRepairEdits({
      draft,
      findings: [],
      policy: {
        neverTouchPaths: [".env", ".env.production", "secrets/", "prod/", "package-lock.json"],
      },
      edits: [
        { filePath: "deploy/id_rsa", original: "x", updated: "y" },
        { filePath: "src/ok.ts", original: "a", updated: "b" },
      ],
      existingPaths: [],
    });
    expect(result.blocked).toContain("deploy/id_rsa");
    expect(result.allowed.map((e) => e.path)).toEqual(["src/ok.ts"]);
  });
});
