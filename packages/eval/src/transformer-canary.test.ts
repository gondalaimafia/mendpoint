import { describe, expect, it } from "vitest";
import { runTransformerCanary } from "./transformer-canary.js";

describe("Transformer end-to-end canary (T4c)", () => {
  it("proves all four families end-to-end with the safety invariants held", async () => {
    const report = await runTransformerCanary();

    // The prove-then-enable gate is green only when every family and every
    // safety invariant passes.
    expect(report.passed).toBe(true);
    expect(report.provenance).toEqual({
      deterministic: true,
      liveModel: false,
      network: "none",
      scm: "mock",
      families: 4,
    });

    // One representative recipe per Transformer family, all passing.
    expect(report.families.map((family) => family.family)).toEqual([
      "sdk",
      "framework",
      "runtime",
      "internal_api",
    ]);
    expect(report.familiesCovered).toEqual({
      sdk: true,
      framework: true,
      runtime: true,
      internal_api: true,
    });
    expect(report.families.every((family) => family.passed)).toBe(true);

    // Both mock SCM adapters (GitHub and the T4a GitLab selector path) are
    // exercised, and every delivery is a draft pull request.
    expect(report.families.map((family) => family.scmProvider).sort()).toEqual([
      "github",
      "github",
      "github",
      "gitlab",
    ]);
    for (const family of report.families) {
      expect(family.delivery.draftPr).toBe(true);
      expect(family.delivery.number).toBeGreaterThan(0);
      expect(family.candidate.status).toBe("promoted");
      expect(family.candidate.candidateDigest).not.toBe(family.candidate.divergedFromDigest);
    }

    // Every named safety invariant across the run holds.
    const allInvariants = [
      ...report.safetyInvariants,
      ...report.families.flatMap((family) => family.invariants),
    ];
    const failed = allInvariants.filter((entry) => !entry.passed);
    expect(failed).toEqual([]);

    // The production Transformer gate default stays denied.
    const gate = report.safetyInvariants.find(
      (entry) => entry.id === "gate.production_default_denied",
    );
    expect(gate?.passed).toBe(true);
  }, 120_000);
});
