import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "@mendpoint/codebase-index";
import type { ImpactableSurface } from "@mendpoint/shared";
import { analyzeImpact } from "./index.js";

/**
 * The §11.7 / §12.4 coverage channel. Every case below produces the SAME empty
 * `sites` list; the tests assert the analysis nonetheless distinguishes the
 * three states the spec requires be kept apart — analyzed-and-clean,
 * analyzed-with-gaps, and not-analyzed — which the old collapsed `overallConfidence`
 * (always "low" for an empty result) could not express.
 */

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mp-coverage-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

// A surface referencing a field none of the fixtures below contain, so discovery
// finds nothing and the analysis is genuinely empty. These tests are about what
// that empty result MEANS under different coverage, not about finding sites.
const UNMATCHED_SURFACE: ImpactableSurface[] = [
  {
    id: "s1",
    canonicalId: "acme.charges.nonexistent_field_zzz",
    kind: "request_field",
    op: "request_field_renamed",
    fromField: "nonexistent_field_zzz",
    toField: "still_nonexistent_zzz",
    severity: "breaking",
    migrationStrategy: "rename",
    explanation: "rename",
    searchTokens: ["nonexistent_field_zzz"],
  },
];

describe("evidence coverage channel — clean vs gaps vs not-analyzed", () => {
  it("analyzed + empty = complete evidence of no impact (clean, high confidence)", async () => {
    const dir = tempRepo({ "src/app.ts": "export const value = 1;\n" });
    const report = await analyzeImpact(dir, UNMATCHED_SURFACE, {
      index: buildIndex(dir),
    });
    expect(report.sites).toHaveLength(0);
    expect(report.coverage?.basis).toBe("analyzed");
    expect(report.coverage?.gaps).toHaveLength(0);
    // The distinguishing assertion: a clean, fully-covered empty result is NOT
    // "low" — it is a confident "no impact".
    expect(report.overallConfidence).toBe("high");
  });

  it("partial (unsupported language present) + empty = no KNOWN impact (unknown)", async () => {
    const dir = tempRepo({
      "src/app.ts": "export const value = 1;\n",
      "src/legacy.rb": "def charge\nend\n",
    });
    const report = await analyzeImpact(dir, UNMATCHED_SURFACE, {
      index: buildIndex(dir),
    });
    expect(report.sites).toHaveLength(0);
    expect(report.coverage?.basis).toBe("partial");
    expect(report.coverage?.gaps.map((g) => g.reason)).toContain(
      "unsupported_language",
    );
    // Same empty sites as the clean case, but degraded coverage makes it
    // "unknown", not clean. That distinction is the whole point of §11.7.
    expect(report.overallConfidence).toBe("unknown");
  });

  it("partial (unresolved first-party import) + empty = provenance gap, unknown", async () => {
    // A genuinely-unresolvable first-party Python import means the provider
    // reachability graph is missing edges, so a match demoted for being
    // unreachable may be a false demote. That is a real coverage gap: an empty
    // result here must read as "no KNOWN impact" (unknown), never as the
    // confident "no impact" a demoted-to-zero provenance result would otherwise
    // report with `basis: analyzed` and no gaps.
    const dir = tempRepo({
      "app/__init__.py": "",
      "app/main.py": "from app.missing import thing\n\n\ndef run():\n    return thing\n",
    });
    const report = await analyzeImpact(dir, UNMATCHED_SURFACE, {
      index: buildIndex(dir),
    });
    expect(report.sites).toHaveLength(0);
    expect(report.coverage?.basis).toBe("partial");
    expect(report.coverage?.gaps.map((g) => g.reason)).toContain("query_truncated");
    expect(report.overallConfidence).toBe("unknown");
  });

  it("not_analyzed (no analyzable source) + empty = no information at all (unknown)", async () => {
    const dir = tempRepo({ "README.md": "# docs only, no code\n" });
    const report = await analyzeImpact(dir, UNMATCHED_SURFACE, {
      index: buildIndex(dir),
    });
    expect(report.sites).toHaveLength(0);
    expect(report.coverage?.basis).toBe("not_analyzed");
    expect(report.coverage?.filesInspected).toBe(0);
    expect(report.overallConfidence).toBe("unknown");
  });

  it("the three states are mutually distinguishable from identical empty results", async () => {
    const cleanDir = tempRepo({ "src/a.ts": "export const x = 1;\n" });
    const partialDir = tempRepo({
      "src/a.ts": "export const x = 1;\n",
      "src/b.go": "package main\nfunc main() {}\n",
    });
    const emptyDir = tempRepo({ "README.md": "# no code\n" });
    const clean = await analyzeImpact(cleanDir, UNMATCHED_SURFACE, {
      index: buildIndex(cleanDir),
    });
    const partial = await analyzeImpact(partialDir, UNMATCHED_SURFACE, {
      index: buildIndex(partialDir),
    });
    const notAnalyzed = await analyzeImpact(emptyDir, UNMATCHED_SURFACE, {
      index: buildIndex(emptyDir),
    });
    const bases = new Set([
      clean.coverage?.basis,
      partial.coverage?.basis,
      notAnalyzed.coverage?.basis,
    ]);
    expect(bases).toEqual(new Set(["analyzed", "partial", "not_analyzed"]));
    const confidences = new Set([
      clean.overallConfidence,
      partial.overallConfidence,
      notAnalyzed.overallConfidence,
    ]);
    // "high" for clean, "unknown" for both degraded states.
    expect(confidences).toEqual(new Set(["high", "unknown"]));
  });
});
