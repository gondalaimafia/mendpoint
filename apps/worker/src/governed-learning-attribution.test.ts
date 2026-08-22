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
// countable record of how each governed-learning producer sets its outcome
// `attribution`. A hand-maintained registry could silently drift from the
// producers it describes; this test reads the real producer source (the files are
// siblings of this test) and fails if any producer's attribution no longer matches
// its registry entry — including a drift in the referenced line number.
//
// The old truth this asserted was that both production producers HARDCODED
// `attribution: "model_behavior"`, collapsing the classifier to a constant. Both
// production producers now DERIVE attribution via `deriveOutcomeAttribution` — that
// is their SHAPE, and this guard asserts it. It does NOT claim the producers
// discriminate: each feeds the deriver a constant `not_verified`, so both always
// emit `none` (Warden's verifier is unsatisfiable; ReGauge's `passed` flag is
// tautological). The guard still fails if a producer regresses to a hardcoded
// constant (reintroducing `attribution: "<literal>"`, or dropping the derivation
// call), AND — added below — if a producer reintroduces the tautological
// `verification.passed === true` check or the `signalClass -> "verified"`
// conflation that once fabricated `model_behavior`.

function readProducerLines(entry: (typeof GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS)[number]): {
  source: string;
  lines: string[];
  referencedLine: string;
  referencedLineNumber: number;
} {
  const localPath = fileURLToPath(new URL(`./${basename(entry.producer)}`, import.meta.url));
  const source = readFileSync(localPath, "utf8");
  const lines = source.split("\n");
  const referencedLineNumber = Number(entry.reference.split(":").pop());
  return { source, lines, referencedLine: (lines[referencedLineNumber - 1] ?? "").trim(), referencedLineNumber };
}

// A hardcoded outcome attribution literal, e.g. `attribution: "model_behavior",`.
// Its absence from a production producer is the regression guard: if a producer
// reverts to emitting a constant, this pattern reappears and the test fails.
const HARDCODED_ATTRIBUTION = /attribution:\s*"[a-z_]+"\s*,/;

describe("governed-learning producer attribution registry stays true to source", () => {
  it("registers three producers: two evidence-deriving production, one caller-supplied generic", () => {
    expect(GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS).toHaveLength(3);
    const production = GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS.filter((e) => e.role === "production");
    const generic = GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS.filter((e) => e.role === "generic");
    expect(production).toHaveLength(2);
    expect(generic).toHaveLength(1);
    // Every production producer is now evidence-derived; none hardcodes a constant.
    expect(production.every((e) => e.attributionSource === "evidence_derived")).toBe(true);
  });

  it("each production producer really derives attribution from evidence and hardcodes no constant", () => {
    for (const entry of GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS.filter((e) => e.attributionSource === "evidence_derived")) {
      // An evidence-derived producer registers no constant.
      expect(entry.constantValue).toBeNull();
      const { source, referencedLine } = readProducerLines(entry);
      // The referenced file:line forwards the DERIVED value into the event, not a
      // literal: the outcome block reads `attribution,` (shorthand for the local
      // derived above), never `attribution: "<constant>"`.
      expect(referencedLine).toBe("attribution,");
      // The derivation actually happens in this producer.
      expect(source.includes("deriveOutcomeAttribution(")).toBe(true);
      // Regression guard: the producer nowhere hardcodes an attribution literal. If
      // it regresses to `attribution: "model_behavior",` this fails.
      expect(HARDCODED_ATTRIBUTION.test(source)).toBe(false);
    }
  });

  it("the caller-supplied generic producer forwards its caller's attribution at the referenced line", () => {
    const generic = GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS.find((e) => e.attributionSource === "caller_supplied");
    expect(generic).toBeDefined();
    const { referencedLine } = readProducerLines(generic!);
    expect(referencedLine).toBe("attribution: facts.outcome.attribution,");
  });

  it("the assessment reports its narrow degeneracy honestly: no hardcoded-same-literal collapse", () => {
    // `effectivelyConstant` detects ONLY the same-hardcoded-literal collapse, and
    // neither producer hardcodes, so it is false. This does NOT mean the classifier
    // discriminates in production — both producers feed the deriver a constant
    // `not_verified` and always emit `none`, a degeneracy this static check cannot
    // see (see assessProductionAttributionDiscrimination's own doc). The value below
    // is the honest report of the narrow thing the check measures.
    const assessment = assessProductionAttributionDiscrimination();
    expect(assessment.effectivelyConstant).toBe(false);
    expect(assessment.constant).toBeNull();
  });

  it("neither production producer reintroduces the tautology or the signalClass->verified conflation", () => {
    // The delete-the-check guard for defects (2) and (3). Reverting either fix
    // reintroduces one of these source patterns and fabricates `model_behavior`:
    //   - `verification.passed === true`  — ReGauge's tautology (sealing guarantees
    //     `passed: true`, so both sides trace to the same input).
    //   - `signalClass === "hard" ? "verified"` — conflating the producer-authority
    //     axis with a verification outcome at the deriver call.
    // Both production producers must instead pass the literal `verification:
    // "not_verified"` into `deriveOutcomeAttribution`.
    for (const entry of GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS.filter((e) => e.role === "production")) {
      const { source } = readProducerLines(entry);
      expect(/verification\.passed\s*===\s*true/.test(source)).toBe(false);
      expect(/signalClass\s*===\s*"hard"\s*\?\s*"verified"/.test(source)).toBe(false);
      expect(source.includes('verification: "not_verified"')).toBe(true);
    }
  });
});
