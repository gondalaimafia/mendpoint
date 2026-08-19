import { describe, it, expect } from "vitest";
import { renderLatestReport, renderFailuresBacklog } from "./report.js";
import { renderScorecard } from "../scorecard.js";
import {
  evaluateReadiness,
  loadReadinessGates,
  type AbsentScenario,
  type ScoredRun,
} from "../readiness.js";
import type { GroundTruth } from "../ground-truth/schema.js";
import type { RunRecord } from "./types.js";

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
    timestamp: "2026-08-19T00:00:00.000Z",
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

const SCORED: ScoredRun[] = [
  { gt: gt({ scenario_id: "a", dataset_split: "development", expected_findings: ["src/a.ts"] }), record: rec({ scenario_id: "a", findings: ["src/a.ts"], passed: true }) },
  { gt: gt({ scenario_id: "h", dataset_split: "holdout", expected_findings: ["src/b.ts"] }), record: rec({ scenario_id: "h", findings: ["src/b.ts"], passed: true }) },
];

const ABSENT: AbsentScenario[] = [
  { scenario_id: "fettler-corpus-scale", product: "fettler", gt: gt({ scenario_id: "fettler-corpus-scale", correct_behavior: "flag_files" }) },
];

describe("skipped-corpus visibility in the evidence renderers", () => {
  it("latest.md names the absent scenario and does not fold it into the pass rate", () => {
    const md = renderLatestReport(SCORED, ABSENT);
    expect(md).toContain("fettler-corpus-scale");
    expect(md).toContain("NOT MEASURED");
    // The scored total is the two that ran, called out separately from the absent one.
    expect(md).toContain("Total scenarios: 2 scored");
    // The readiness section reflects the forced FAIL.
    expect(md).toContain("Overall readiness: FAIL");
  });

  it("readiness-scorecard.md lists the absent scenario as not measured", () => {
    const gates = loadReadinessGates();
    const ev = evaluateReadiness(SCORED, gates, undefined, ABSENT);
    const md = renderScorecard(SCORED, ev, gates, ABSENT);
    expect(md).toContain("fettler-corpus-scale");
    expect(md).toContain("not measured (absent)");
    expect(md).toContain("Overall readiness: **FAIL**");
  });

  it("FAILURES.md records the absent scenario as an explicit not-measured entry", () => {
    const md = renderFailuresBacklog(SCORED, ABSENT);
    expect(md).toContain("NOT-MEASURED");
    expect(md).toContain("fettler-corpus-scale");
    expect(md).toContain("NOT_MEASURED");
  });

  it("renders nothing extra when no scenario is absent", () => {
    const md = renderLatestReport(SCORED, []);
    expect(md).not.toContain("Gated scenarios not measured");
  });
});
