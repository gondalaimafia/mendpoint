import { describe, it, expect } from "vitest";
import {
  evaluateReadiness,
  loadReadinessGates,
  DEFAULT_GATES_PATH,
  type FettlerImpactThresholds,
  type ReadinessGatesConfig,
  type ScoredRun,
} from "./readiness.js";
import type { GroundTruth } from "./ground-truth/schema.js";
import type { RunRecord, RunFailure } from "./runners/types.js";

function gt(over: Partial<GroundTruth>): GroundTruth {
  return {
    scenario_id: "s",
    repo_family: "typescript-service",
    difficulty: 3,
    difficulty_rationale: "x",
    intended_product: ["fettler"],
    dataset_split: "development",
    correct_behavior: "flag_files",
    faults: [],
    expected_findings: [],
    acceptable_findings: [],
    false_positive_traps: [],
    blast_radius_truth: { affectedFiles: 0 },
    tags: [],
    ...over,
  };
}

function rec(over: Partial<RunRecord>): RunRecord {
  return {
    run_id: "r",
    timestamp: "2026-08-17T00:00:00.000Z",
    git_commit: "abc123",
    product: "fettler",
    product_version: "test",
    scenario_id: over.scenario_id ?? "s",
    scenario_version: "1",
    invocation_path: "test",
    model: null,
    model_provider: null,
    routing_decisions: [],
    tokens: null,
    latency_ms: 10,
    estimated_cost_usd: null,
    activity: { filesExamined: 0 },
    findings: [],
    findingGraphPaths: [],
    confidence: null,
    produced_edit: false,
    grader_results: [],
    failures: [],
    passed: true,
    unmeasured_dimensions: [],
    ...over,
  };
}

const GATES: ReadinessGatesConfig = {
  schema_version: 1,
  policy: "precision-first",
  owner: "Talal",
  decided_at: "2026-08-17",
  capabilities: {
    "fettler-impact-analysis": {
      impact_precision_min: 0.9,
      impact_recall_min: 0.85,
      max_open_p0: 0,
      holdout_dev_gap_max_pp: 10,
    },
  },
};

describe("loadReadinessGates", () => {
  it("loads and validates the shipped versioned config", () => {
    const cfg = loadReadinessGates(DEFAULT_GATES_PATH);
    expect(cfg.schema_version).toBe(1);
    expect(cfg.policy).toBe("precision-first");
    expect(
      (cfg.capabilities["fettler-impact-analysis"] as FettlerImpactThresholds).impact_precision_min,
    ).toBe(0.9);
  });
});

describe("evaluateReadiness", () => {
  it("passes when precision, recall, P0 and holdout gap all clear the bar", () => {
    const scored: ScoredRun[] = [
      {
        gt: gt({ scenario_id: "a", dataset_split: "development", expected_findings: ["src/a.ts"] }),
        record: rec({ scenario_id: "a", findings: ["src/a.ts"], passed: true }),
      },
      {
        gt: gt({ scenario_id: "h", dataset_split: "holdout", expected_findings: ["src/b.ts"] }),
        record: rec({ scenario_id: "h", findings: ["src/b.ts"], passed: true }),
      },
    ];
    const ev = evaluateReadiness(scored, GATES);
    expect(ev.overall).toBe("PASS");
    const cap = ev.capabilities[0];
    expect(cap.metrics.precision).toBe(1);
    expect(cap.metrics.recall).toBe(1);
  });

  it("FAILS on recall when impacted files are missed (the honest day-one signal)", () => {
    const scored: ScoredRun[] = [
      {
        gt: gt({ scenario_id: "a", expected_findings: ["src/a.ts", "src/b.ts", "src/c.ts"] }),
        record: rec({ scenario_id: "a", findings: ["src/a.ts"], passed: false }),
      },
    ];
    const ev = evaluateReadiness(scored, GATES);
    expect(ev.overall).toBe("FAIL");
    const recall = ev.capabilities[0].criteria.find((c) => c.name === "impact_recall")!;
    expect(recall.passed).toBe(false);
    expect(ev.capabilities[0].metrics.recall).toBeCloseTo(1 / 3, 5);
  });

  it("FAILS when an unsafe P0 failure is open", () => {
    const p0: RunFailure = {
      category: "FALSE_POSITIVE",
      severity: "P0",
      dimension: "false_positive_traps",
      observed: "flagged a distractor",
      expected: "no distractor",
    };
    const scored: ScoredRun[] = [
      {
        gt: gt({ scenario_id: "a", expected_findings: ["src/a.ts"], false_positive_traps: ["vendor/x.ts"] }),
        record: rec({ scenario_id: "a", findings: ["src/a.ts", "vendor/x.ts"], passed: false, failures: [p0] }),
      },
    ];
    const ev = evaluateReadiness(scored, GATES);
    const p0crit = ev.capabilities[0].criteria.find((c) => c.name === "open_p0")!;
    expect(p0crit.passed).toBe(false);
    expect(ev.capabilities[0].metrics.openP0).toBe(1);
    expect(ev.overall).toBe("FAIL");
  });

  it("does not count coverage-gap failures as open P0", () => {
    const gap: RunFailure = {
      category: "COVERAGE_GAP",
      severity: "P0",
      dimension: "x",
      observed: "no shipped recipe",
      expected: "abstain",
    };
    const scored: ScoredRun[] = [
      { gt: gt({ scenario_id: "a", expected_findings: ["src/a.ts"] }), record: rec({ scenario_id: "a", findings: ["src/a.ts"], failures: [gap] }) },
    ];
    const ev = evaluateReadiness(scored, GATES);
    expect(ev.capabilities[0].metrics.openP0).toBe(0);
  });

  it("scores a regauge family: apply/abstain pass but a residual that does not refuse fails the family on refusal + P0", () => {
    const familyGates: ReadinessGatesConfig = {
      ...GATES,
      capabilities: {
        "regauge-sdk-migration": {
          kind: "regauge-family",
          family: "sdk-upgrade",
          apply_correctness_min: 1,
          refusal_correctness_min: 1,
          abstention_correctness_min: 1,
          max_open_p0: 0,
        },
      },
    };
    const rg = (over: Partial<GroundTruth>): GroundTruth =>
      gt({ intended_product: ["regauge"], recipe_expectation: { family: "sdk-upgrade", shippedRecipeId: "aws-sdk-js-v2-to-v3" }, ...over });
    const p0: RunFailure = {
      category: "ABSTENTION_FAILURE",
      severity: "P0",
      dimension: "residual_refusal",
      observed: "status=applicable",
      expected: "status=incomplete",
    };
    const scored: ScoredRun[] = [
      { gt: rg({ scenario_id: "apply", correct_behavior: "apply_recipe", expected_findings: ["package.json"] }), record: rec({ scenario_id: "apply", product: "regauge", passed: true }) },
      { gt: rg({ scenario_id: "abstain", correct_behavior: "abstain" }), record: rec({ scenario_id: "abstain", product: "regauge", passed: true }) },
      { gt: rg({ scenario_id: "residual", correct_behavior: "refuse_partial", expected_findings: ["package.json"] }), record: rec({ scenario_id: "residual", product: "regauge", passed: false, failures: [p0] }) },
    ];
    const ev = evaluateReadiness(scored, familyGates);
    const cap = ev.capabilities.find((c) => c.capability === "regauge-sdk-migration")!;
    expect(cap.verdict).toBe("FAIL");
    expect(cap.criteria.find((c) => c.name === "apply_correctness")!.passed).toBe(true);
    expect(cap.criteria.find((c) => c.name === "out_of_scope_abstention")!.passed).toBe(true);
    expect(cap.criteria.find((c) => c.name === "residual_refusal")!.passed).toBe(false);
    expect(cap.criteria.find((c) => c.name === "open_p0")!.passed).toBe(false);
    expect(cap.familyMetrics?.openP0).toBe(1);
    expect(ev.overall).toBe("FAIL");
  });

  it("a regauge family with every residual refusing and no P0 passes", () => {
    const familyGates: ReadinessGatesConfig = {
      ...GATES,
      capabilities: {
        "regauge-runtime-migration": {
          kind: "regauge-family",
          family: "runtime-upgrade",
          apply_correctness_min: 1,
          refusal_correctness_min: 1,
          abstention_correctness_min: 1,
          max_open_p0: 0,
        },
      },
    };
    const rg = (over: Partial<GroundTruth>): GroundTruth =>
      gt({ intended_product: ["regauge"], recipe_expectation: { family: "runtime-upgrade", shippedRecipeId: "node-runtime-20-to-22" }, ...over });
    const scored: ScoredRun[] = [
      { gt: rg({ scenario_id: "a", correct_behavior: "apply_recipe", expected_findings: ["package.json"] }), record: rec({ scenario_id: "a", product: "regauge", passed: true }) },
      { gt: rg({ scenario_id: "r", correct_behavior: "refuse_partial", expected_findings: ["package.json"] }), record: rec({ scenario_id: "r", product: "regauge", passed: true }) },
      { gt: rg({ scenario_id: "o", correct_behavior: "abstain" }), record: rec({ scenario_id: "o", product: "regauge", passed: true }) },
    ];
    const ev = evaluateReadiness(scored, familyGates);
    const cap = ev.capabilities.find((c) => c.capability === "regauge-runtime-migration")!;
    expect(cap.verdict).toBe("PASS");
    expect(ev.overall).toBe("PASS");
  });

  it("marks the holdout-gap criterion not measurable when a split is empty", () => {
    const scored: ScoredRun[] = [
      { gt: gt({ scenario_id: "a", dataset_split: "development", expected_findings: ["src/a.ts"] }), record: rec({ scenario_id: "a", findings: ["src/a.ts"] }) },
    ];
    const ev = evaluateReadiness(scored, GATES);
    const gap = ev.capabilities[0].criteria.find((c) => c.name === "holdout_within_dev")!;
    expect(gap.measurable).toBe(false);
    // A criterion that cannot be measured cannot demonstrate readiness.
    expect(ev.overall).toBe("FAIL");
  });

  it("FAILS the holdout gap when the holdout OUTPERFORMS development beyond the threshold", () => {
    // Findings are all correct (precision/recall clear the bar), but the holdout
    // pass rate (100%) exceeds the development pass rate (50%) by 50pp — far more
    // than the 10pp allowed. A holdout that outperforms this much is evidence the
    // splits are not comparable, so it must FAIL, not silently pass.
    const scored: ScoredRun[] = [
      { gt: gt({ scenario_id: "d1", dataset_split: "development", expected_findings: ["src/a.ts"] }), record: rec({ scenario_id: "d1", findings: ["src/a.ts"], passed: true }) },
      { gt: gt({ scenario_id: "d2", dataset_split: "development", expected_findings: ["src/c.ts"] }), record: rec({ scenario_id: "d2", findings: ["src/c.ts"], passed: false }) },
      { gt: gt({ scenario_id: "h1", dataset_split: "holdout", expected_findings: ["src/b.ts"] }), record: rec({ scenario_id: "h1", findings: ["src/b.ts"], passed: true }) },
      { gt: gt({ scenario_id: "h2", dataset_split: "holdout", expected_findings: ["src/d.ts"] }), record: rec({ scenario_id: "h2", findings: ["src/d.ts"], passed: true }) },
    ];
    const ev = evaluateReadiness(scored, GATES);
    const cap = ev.capabilities[0];
    expect(cap.metrics.precision).toBe(1);
    expect(cap.metrics.recall).toBe(1);
    const gap = cap.criteria.find((c) => c.name === "holdout_within_dev")!;
    expect(gap.measurable).toBe(true);
    expect(gap.passed).toBe(false);
    // The rendered line agrees with the comparison: it shows the holdout ABOVE
    // development (+) by a magnitude (50.0pp) that exceeds the 10pp bound.
    expect(gap.measured).toBe("+50.0pp vs dev");
    expect(ev.overall).toBe("FAIL");
  });

  it("FAILS a capability whose gated scenario is absent, without renormalising the pooled metrics", () => {
    // Everything that DID run passes cleanly — precision/recall are 100% over the
    // scenarios present. But a gated flag_files scenario was absent (corpus not
    // on this runner). The capability must FAIL on an explicit not-measured
    // coverage criterion, not read as ready over the partial set.
    const scored: ScoredRun[] = [
      { gt: gt({ scenario_id: "a", dataset_split: "development", expected_findings: ["src/a.ts"] }), record: rec({ scenario_id: "a", findings: ["src/a.ts"], passed: true }) },
      { gt: gt({ scenario_id: "h", dataset_split: "holdout", expected_findings: ["src/b.ts"] }), record: rec({ scenario_id: "h", findings: ["src/b.ts"], passed: true }) },
    ];
    const absent = [
      { scenario_id: "fettler-corpus-scale", product: "fettler", gt: gt({ scenario_id: "fettler-corpus-scale", correct_behavior: "flag_files" }) },
    ];
    const ev = evaluateReadiness(scored, GATES, undefined, absent);
    const cap = ev.capabilities[0];
    // Pooled metrics are NOT diluted by the absent scenario (no phantom zeros).
    expect(cap.metrics.precision).toBe(1);
    expect(cap.metrics.recall).toBe(1);
    // But the capability fails on the coverage hole.
    const cov = cap.criteria.find((c) => c.name === "gated_scenario_coverage")!;
    expect(cov).toBeDefined();
    expect(cov.measurable).toBe(false);
    expect(cov.measured).toContain("fettler-corpus-scale");
    expect(cap.verdict).toBe("FAIL");
    expect(ev.overall).toBe("FAIL");
  });

  it("does not add a coverage criterion when no gated scenario is absent", () => {
    const scored: ScoredRun[] = [
      { gt: gt({ scenario_id: "a", dataset_split: "development", expected_findings: ["src/a.ts"] }), record: rec({ scenario_id: "a", findings: ["src/a.ts"], passed: true }) },
      { gt: gt({ scenario_id: "h", dataset_split: "holdout", expected_findings: ["src/b.ts"] }), record: rec({ scenario_id: "h", findings: ["src/b.ts"], passed: true }) },
    ];
    const ev = evaluateReadiness(scored, GATES, undefined, []);
    expect(ev.capabilities[0].criteria.some((c) => c.name === "gated_scenario_coverage")).toBe(false);
    expect(ev.overall).toBe("PASS");
  });
});

describe("fettler-abstention capability (Phase 2 gate coverage)", () => {
  const gates: ReadinessGatesConfig = {
    schema_version: 1,
    policy: "precision-first",
    owner: "Talal",
    decided_at: "2026-08-17",
    capabilities: {
      "fettler-abstention": {
        kind: "fettler-abstention",
        abstention_correctness_min: 1.0,
        max_open_p0: 0,
      },
    },
  };

  it("PASSES when every abstain/no_op scenario correctly produced nothing", () => {
    const scored: ScoredRun[] = [
      { gt: gt({ scenario_id: "amb", correct_behavior: "abstain" }), record: rec({ scenario_id: "amb", passed: true }) },
      { gt: gt({ scenario_id: "mig", correct_behavior: "no_op" }), record: rec({ scenario_id: "mig", passed: true }) },
    ];
    const ev = evaluateReadiness(scored, gates);
    const cap = ev.capabilities.find((c) => c.capability === "fettler-abstention")!;
    expect(cap.verdict).toBe("PASS");
    expect(cap.metrics.scenarioCount).toBe(2);
  });

  it("FAILS (P0) when the product acts confidently where it must abstain", () => {
    const p0: RunFailure = {
      category: "ABSTENTION_FAILURE",
      severity: "P0",
      dimension: "abstention_correctness",
      observed: "confident findings on an ambiguous rename",
      expected: "nothing (abstain)",
    };
    const scored: ScoredRun[] = [
      { gt: gt({ scenario_id: "amb", correct_behavior: "abstain" }), record: rec({ scenario_id: "amb", passed: false, failures: [p0] }) },
    ];
    const ev = evaluateReadiness(scored, gates);
    const cap = ev.capabilities.find((c) => c.capability === "fettler-abstention")!;
    expect(cap.verdict).toBe("FAIL");
    expect(cap.metrics.openP0).toBe(1);
    expect(cap.criteria.find((c) => c.name === "abstention_correctness")!.passed).toBe(false);
  });

  it("does not pool flag_files scenarios into the abstention gate", () => {
    const scored: ScoredRun[] = [
      { gt: gt({ scenario_id: "amb", correct_behavior: "abstain" }), record: rec({ scenario_id: "amb", passed: true }) },
      { gt: gt({ scenario_id: "flag", correct_behavior: "flag_files", expected_findings: ["src/a.ts"] }), record: rec({ scenario_id: "flag", findings: [], passed: false }) },
    ];
    const ev = evaluateReadiness(scored, gates);
    const cap = ev.capabilities.find((c) => c.capability === "fettler-abstention")!;
    // Only the abstain scenario counts; the failing flag_files scenario is elsewhere.
    expect(cap.metrics.scenarioCount).toBe(1);
    expect(cap.verdict).toBe("PASS");
  });

  it("is marked not measurable when there are no abstain/no_op scenarios", () => {
    const scored: ScoredRun[] = [
      { gt: gt({ scenario_id: "flag", correct_behavior: "flag_files", expected_findings: ["src/a.ts"] }), record: rec({ scenario_id: "flag", findings: ["src/a.ts"], passed: true }) },
    ];
    const ev = evaluateReadiness(scored, gates);
    const cap = ev.capabilities.find((c) => c.capability === "fettler-abstention")!;
    const crit = cap.criteria.find((c) => c.name === "abstention_correctness")!;
    expect(crit.measurable).toBe(false);
    expect(cap.verdict).toBe("FAIL");
  });
});

describe("shipped readiness-gates.json coverage (Phase 2)", () => {
  it("gates fettler-abstention and the four ReGauge families alongside fettler-impact-analysis", () => {
    const cfg = loadReadinessGates(DEFAULT_GATES_PATH);
    expect(Object.keys(cfg.capabilities).sort()).toEqual([
      "fettler-abstention",
      "fettler-impact-analysis",
      "regauge-framework-migration",
      "regauge-internal-api-migration",
      "regauge-runtime-migration",
      "regauge-sdk-migration",
    ]);
  });

  it("records not-measured capabilities with an experiment (no invented thresholds)", () => {
    const cfg = loadReadinessGates(DEFAULT_GATES_PATH);
    expect(cfg.not_measured).toBeDefined();
    expect(cfg.not_measured!.capabilities.length).toBeGreaterThan(0);
    for (const c of cfg.not_measured!.capabilities) {
      expect(c.capability.length, c.capability).toBeGreaterThan(0);
      expect(c.reason.length, c.capability).toBeGreaterThan(0);
      expect(c.experiment.length, c.capability).toBeGreaterThan(0);
    }
  });
});
