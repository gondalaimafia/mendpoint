import { describe, expect, it } from "vitest";
import {
  coverageSummary,
  mapPrStatus,
  parseUnifiedDiff,
  patchStats,
  relativeTime,
} from "./pr-map";
import type { PrCoverage } from "./pr-map";

describe("pr-map — live PR mapping helpers", () => {
  it("maps API PR status onto DS lifecycle status", () => {
    expect(mapPrStatus("draft")).toBe("draft");
    expect(mapPrStatus("open")).toBe("open");
    expect(mapPrStatus("merged")).toBe("merged");
    expect(mapPrStatus("closed")).toBe("failing");
    expect(mapPrStatus("unknown")).toBe("open");
  });

  it("does not collapse a verified-clean low_confidence result into red 'failing'", () => {
    // The §11.7 bug: low_confidence -> failing made a fully-analyzed clean repo
    // and an unanalyzable one render identically red. Coverage now discriminates.
    expect(mapPrStatus("low_confidence", { basis: "analyzed", gaps: [] })).toBe("open");
    expect(mapPrStatus("low_confidence", { basis: "partial", gaps: [] })).toBe("pending");
    expect(mapPrStatus("low_confidence", { basis: "not_analyzed", gaps: [] })).toBe("pending");
    // Absent coverage is unknown, never clean — and still never a fabricated red.
    expect(mapPrStatus("low_confidence")).toBe("pending");
    expect(mapPrStatus("low_confidence", null)).toBe("pending");
    expect(mapPrStatus("low_confidence", { basis: "analyzed", gaps: [] })).not.toBe("failing");
  });

  it("summarizes coverage into distinct, honest states", () => {
    const clean = coverageSummary("low_confidence", {
      basis: "analyzed",
      gaps: [],
      filesInspected: 128,
      filesInScope: 128,
    });
    expect(clean.state).toBe("clean");
    expect(clean.tone).toBe("emerald");
    expect(clean.detail).toContain("complete evidence of no impact");
    expect(clean.files).toBe("128 of 128 files inspected");

    const partial: PrCoverage = {
      basis: "partial",
      reason: "Ruby files were present but unsupported.",
      gaps: [{ reason: "unsupported_language", detail: "3 .rb files not analyzed", count: 3 }],
    };
    const partialSummary = coverageSummary("low_confidence", partial);
    expect(partialSummary.state).toBe("no_known_impact");
    expect(partialSummary.tone).toBe("amber");
    expect(partialSummary.gaps[0]).toEqual({
      reason: "Unsupported language",
      detail: "3 .rb files not analyzed",
    });

    const notAnalyzed = coverageSummary("low_confidence", { basis: "not_analyzed", gaps: [] });
    expect(notAnalyzed.state).toBe("no_basis");
    expect(notAnalyzed.detail).toContain("not a clean result");

    // Absent coverage -> unknown, never defaulted to analyzed/clean.
    const unknown = coverageSummary("low_confidence", null);
    expect(unknown.state).toBe("unknown");
    expect(unknown.tone).toBe("neutral");
    expect(unknown.detail).toContain("unverified");

    // An actionable (non-empty) PR with full coverage is "covered", not "clean".
    const covered = coverageSummary("open", { basis: "analyzed", gaps: [] });
    expect(covered.state).toBe("covered");
    expect(covered.tone).toBe("emerald");
  });

  it("counts +/- lines and touched files without double-counting git headers", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "-const a = 1;",
      "+const a = 2;",
      " const b = 3;",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1,1 +1,2 @@",
      " const c = 4;",
      "+const d = 5;",
    ].join("\n");
    expect(patchStats(patch)).toEqual({ additions: 2, deletions: 1, files: 2 });
  });

  it("parses a unified diff into per-file hunks with line numbers", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "-const a = 1;",
      "+const a = 2;",
      " const b = 3;",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("src/a.ts");
    expect(files[0]!.additions).toBe(1);
    expect(files[0]!.deletions).toBe(1);
    const lines = files[0]!.hunks[0]!.lines;
    expect(lines.map((l) => l.type)).toEqual(["del", "add", "ctx"]);
    expect(lines[0]).toMatchObject({ type: "del", line: 1, text: "const a = 1;" });
    expect(lines[1]).toMatchObject({ type: "add", line: 1, text: "const a = 2;" });
    expect(lines[2]).toMatchObject({ type: "ctx", line: 2, text: "const b = 3;" });
  });

  it("returns no files for an empty patch", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(patchStats("")).toEqual({ additions: 0, deletions: 0, files: 0 });
  });

  it("renders compact relative timestamps", () => {
    const now = Date.now();
    expect(relativeTime(new Date(now - 30_000).toISOString())).toBe("just now");
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString())).toBe("3h ago");
    expect(relativeTime(new Date(now - 2 * 86_400_000).toISOString())).toBe("2d ago");
    expect(relativeTime("not-a-date")).toBe("");
  });
});
