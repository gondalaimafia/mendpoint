import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS,
  assessProductionAttributionDiscrimination,
} from "@mendpoint/pipeline";

// Anti-drift guard for the producer-attribution registry in
// `packages/pipeline/src/lesson-routing.ts`. That registry is the documented,
// countable evidence that in production the lesson classifier is handed a constant
// attribution. A hand-maintained registry could silently drift from the producers
// it describes; this test reads the real producer source (the files are siblings
// of this test) and fails if any producer's attribution no longer matches its
// registry entry — including a drift in the referenced line number. It dies if the
// registry is emptied, and it dies if a producer changes how it sets attribution
// without updating the registry.

function readProducerLines(entry: (typeof GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS)[number]): {
  lines: string[];
  referencedLine: string;
  referencedLineNumber: number;
} {
  const localPath = fileURLToPath(new URL(`./${basename(entry.producer)}`, import.meta.url));
  const lines = readFileSync(localPath, "utf8").split("\n");
  const referencedLineNumber = Number(entry.reference.split(":").pop());
  return { lines, referencedLine: (lines[referencedLineNumber - 1] ?? "").trim(), referencedLineNumber };
}

describe("governed-learning producer attribution registry stays true to source", () => {
  it("registers three producers: two hardcoded production, one caller-supplied generic", () => {
    expect(GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS).toHaveLength(3);
    const production = GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS.filter((e) => e.role === "production");
    const generic = GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS.filter((e) => e.role === "generic");
    expect(production).toHaveLength(2);
    expect(generic).toHaveLength(1);
  });

  it("each hardcoded production producer really hardcodes its registered constant at the referenced line", () => {
    for (const entry of GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS.filter((e) => e.attributionSource === "hardcoded_constant")) {
      expect(entry.constantValue).not.toBeNull();
      const { lines, referencedLine } = readProducerLines(entry);
      // The referenced file:line is exactly the hardcoded attribution.
      expect(referencedLine).toBe(`attribution: "${entry.constantValue}",`);
      // And the producer does not derive attribution from the outcome anywhere.
      expect(lines.some((l) => l.includes("attribution: facts.outcome.attribution"))).toBe(false);
    }
  });

  it("the caller-supplied generic producer forwards its caller's attribution at the referenced line", () => {
    const generic = GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS.find((e) => e.attributionSource === "caller_supplied");
    expect(generic).toBeDefined();
    const { referencedLine } = readProducerLines(generic!);
    expect(referencedLine).toBe("attribution: facts.outcome.attribution,");
  });

  it("the source-derived reality matches the assessed degeneracy", () => {
    // Cross-check: the registry the source validates is the same registry the
    // discrimination assessment reads, so "effectively constant" reflects the code.
    const assessment = assessProductionAttributionDiscrimination();
    expect(assessment.effectivelyConstant).toBe(true);
    expect(assessment.constant).toBe("model_behavior");
  });
});
