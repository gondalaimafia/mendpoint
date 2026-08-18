import { describe, expect, it } from "vitest";
import type { ImpactFinding, MigrationDraft } from "@mendpoint/shared";
import { filterRepairEdits } from "./repair-policy.js";

const draft: MigrationDraft = {
  title: "Migration",
  body: "Body",
  branchName: "mendpoint/migration",
  patch: "",
  risk: "breaking",
  confidence: "high",
  fileEdits: [],
};

function finding(
  filePath: string,
  confidence: ImpactFinding["confidence"],
): ImpactFinding {
  return {
    filePath,
    lineStart: 1,
    lineEnd: 1,
    symbol: "symbol",
    confidence,
    evidence: "evidence",
    relatedOps: [],
  };
}

describe("filterRepairEdits", () => {
  it("rejects new repair paths protected by the canonical baseline", () => {
    const result = filterRepairEdits({
      draft,
      findings: [],
      policy: {},
      existingPaths: [],
      edits: [
        {
          filePath: "terraform/main.tf",
          original: "before",
          updated: "after",
        },
        {
          filePath: "src/allowed.ts",
          original: "before",
          updated: "after",
        },
      ],
    });

    expect(result.blockedPaths).toContain("terraform/main.tf");
    expect(result.allowed.map((edit) => edit.path)).toEqual(["src/allowed.ts"]);
    expect(result.fullyAuthorized).toBe(false);
  });

  it("rejects new repair paths below the configured confidence threshold", () => {
    const result = filterRepairEdits({
      draft,
      findings: [finding("src/uncertain.ts", "low")],
      policy: { minConfidenceForEdit: "medium" },
      existingPaths: [],
      edits: [
        {
          filePath: "src/uncertain.ts",
          original: "before",
          updated: "after",
        },
      ],
    });

    expect(result.allowed).toEqual([]);
    expect(result.rejectedPaths).toEqual(["src/uncertain.ts"]);
    expect(result.fullyAuthorized).toBe(false);
  });

  it("does not duplicate paths already admitted by the original decision", () => {
    const result = filterRepairEdits({
      draft,
      findings: [],
      policy: {},
      existingPaths: ["src/existing.ts"],
      edits: [
        {
          filePath: "src/existing.ts",
          original: "before",
          updated: "after",
        },
      ],
    });

    expect(result).toEqual({
      allowed: [],
      blockedPaths: [],
      rejectedPaths: [],
      fullyAuthorized: true,
    });
  });
});
