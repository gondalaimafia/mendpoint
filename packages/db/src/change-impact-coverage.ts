/**
 * FET-017 change-level coverage: distinguish verified no-impact from
 * no-known-impact under partial/unknown coverage. The PR console already
 * does this per `coverage_json`. The change report must not collapse an
 * empty findings list into "no impact".
 */
export type ChangeImpactKind = "impact" | "no_impact" | "unknown_impact";
export type ChangeCoverageBasis = "analyzed" | "partial" | "not_analyzed";

export type ChangeImpactCoverage = Readonly<{
  impact: ChangeImpactKind;
  coverageBasis: ChangeCoverageBasis | null;
  reason: string | null;
  findingCount: number;
  prCount: number;
}>;

export type ChangeCoverageInput = Readonly<{
  findingCount: number;
  prs: ReadonlyArray<{ coverage?: unknown }>;
}>;

function basisOf(coverage: unknown): ChangeCoverageBasis | null {
  if (!coverage || typeof coverage !== "object") return null;
  const basis = (coverage as { basis?: unknown }).basis;
  if (basis === "analyzed" || basis === "partial" || basis === "not_analyzed") return basis;
  return null;
}

/**
 * Aggregate persisted PR coverage + finding count into the change-level
 * FET-017 discriminator. Never invents `analyzed` when coverage is absent.
 */
export function summarizeChangeImpactCoverage(input: ChangeCoverageInput): ChangeImpactCoverage {
  const findingCount = Math.max(0, input.findingCount);
  const prCount = input.prs.length;
  const bases = input.prs.map((pr) => basisOf(pr.coverage));

  if (findingCount > 0) {
    const recorded = bases.find((basis) => basis !== null) ?? null;
    return Object.freeze({
      impact: "impact",
      coverageBasis: recorded,
      reason: null,
      findingCount,
      prCount,
    });
  }

  if (prCount === 0) {
    return Object.freeze({
      impact: "unknown_impact",
      coverageBasis: null,
      reason: "pipeline_not_recorded",
      findingCount: 0,
      prCount: 0,
    });
  }

  if (bases.every((basis) => basis === null)) {
    return Object.freeze({
      impact: "unknown_impact",
      coverageBasis: null,
      reason: "coverage_not_recorded",
      findingCount: 0,
      prCount,
    });
  }

  if (bases.every((basis) => basis === "analyzed")) {
    return Object.freeze({
      impact: "no_impact",
      coverageBasis: "analyzed",
      reason: null,
      findingCount: 0,
      prCount,
    });
  }

  const weakest = bases.includes("not_analyzed")
    ? "not_analyzed"
    : bases.includes("partial")
      ? "partial"
      : bases.find((basis) => basis !== null) ?? null;
  return Object.freeze({
    impact: "unknown_impact",
    coverageBasis: weakest,
    reason: weakest === "not_analyzed" ? "analysis_did_not_run" : "partial_or_unknown_coverage",
    findingCount: 0,
    prCount,
  });
}
