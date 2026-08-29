import { describe, expect, it } from "vitest";
import { admissionCandidates } from "./repositories.js";
import { assertCatalogComplete, catalogSummary, learningCases } from "./catalog.js";

describe("sourced 150 case catalog", () => {
  it("contains exactly the required product and cohort distribution", () => {
    expect(() => assertCatalogComplete()).not.toThrow();
    expect(catalogSummary()).toMatchObject({
      total: 150,
      development: 120,
      holdout: 30,
      byProductAndCohort: {
        "fettler:common": 50,
        "fettler:edge": 25,
        "regauge:common": 50,
        "regauge:edge": 25,
      },
    });
  });

  it("uses only current primary source forms and no placeholder domains", () => {
    const urls = learningCases.flatMap((item) => item.sources.map((source) => source.url));
    expect(urls.length).toBeGreaterThanOrEqual(150);
    expect(urls.every((url) => url.startsWith("https://"))).toBe(true);
    expect(urls.some((url) => url.includes("example.invalid"))).toBe(false);
  });

  it("binds every case to a reviewed immutable repository candidate", () => {
    const candidates = new Set(admissionCandidates.map((candidate) => candidate.id));
    const missing = learningCases.filter((item) => !candidates.has(item.repository.provenanceId));
    expect(missing.map((item) => item.id)).toEqual([]);
  });

  it("keeps all holdout cases sealed by stable split assignment", () => {
    const holdoutIds = learningCases.filter((item) => item.datasetSplit === "holdout").map((item) => item.id);
    expect(holdoutIds).toHaveLength(30);
    expect(new Set(holdoutIds).size).toBe(30);
    expect(holdoutIds.every((id) => Number(id.slice(-3)) % 5 === 0)).toBe(true);
  });

  it("covers every required control and failure family", () => {
    const corpus = learningCases.map((item) => `${item.pattern.family} ${item.title} ${item.pattern.seededFailure}`).join(" ").toLowerCase();
    for (const required of [
      "positive control",
      "negative control",
      "ambiguous",
      "multi-repository",
      "partial coverage",
      "stale",
      "conflicting",
      "concurrency",
      "replay",
      "tenant",
      "webhook",
      "authorization",
      "outage",
      "verifier",
    ]) expect(corpus).toContain(required);
  });
});
