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
});
