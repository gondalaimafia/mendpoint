/**
 * Phase 5 — Fettler (impact-analysis) graders.
 *
 * Deterministic. Given the set of files the product confidently flagged and the
 * scenario's ground truth, score:
 *   - expected-findings recall
 *   - precision (expected hits vs. expected + traps + extras)
 *   - false-positive-trap avoidance (touching a distractor is P0)
 *   - abstention / no-op correctness (for abstain and no_op scenarios the
 *     correct output is explicitly NOTHING)
 *
 * No LLM judging. A trailing "/" in an acceptable/trap entry marks a directory
 * prefix (used for generated/, vendor/, node_modules/ trees).
 */
import type { GroundTruth } from "../ground-truth/schema.js";
import type { GraderResult, RunFailure } from "../runners/types.js";
import { classifyOutcome } from "./taxonomy.js";

export interface FettlerGrade {
  grader_results: GraderResult[];
  failures: RunFailure[];
  passed: boolean;
  precision: number;
  recall: number;
  expectedHits: string[];
  trapHits: string[];
  extras: string[];
}

function matches(path: string, entry: string): boolean {
  if (entry.endsWith("/")) return path === entry.slice(0, -1) || path.startsWith(entry);
  return path === entry;
}

function inAny(path: string, entries: readonly string[]): boolean {
  return entries.some((e) => matches(path, e));
}

/**
 * `flagged` — repo-relative posix paths the product CONFIDENTLY flagged
 * (medium+). Low-confidence notifications are graded separately by the caller.
 */
export function gradeFettler(flagged: readonly string[], gt: GroundTruth): FettlerGrade {
  const expected = gt.expected_findings;
  const acceptable = gt.acceptable_findings;
  const traps = gt.false_positive_traps;

  const expectedHits = expected.filter((e) => flagged.some((f) => matches(f, e)));
  const trapHits = flagged.filter((f) => inAny(f, traps));
  const extras = flagged.filter(
    (f) => !inAny(f, expected) && !inAny(f, acceptable) && !inAny(f, traps),
  );

  const falsePositives = trapHits.length + extras.length;
  const recall = expected.length ? expectedHits.length / expected.length : 1;
  const precision =
    expectedHits.length + falsePositives > 0
      ? expectedHits.length / (expectedHits.length + falsePositives)
      : 1;

  const grader_results: GraderResult[] = [];
  const failures: RunFailure[] = [];

  const abstainKind = gt.correct_behavior === "abstain" || gt.correct_behavior === "no_op";

  if (abstainKind) {
    // Correct output is nothing confident.
    const actedWrong = trapHits.length + extras.length + expectedHits.length;
    const ok = actedWrong === 0;
    grader_results.push({
      dimension: gt.correct_behavior === "abstain" ? "abstention_correctness" : "no_op_correctness",
      passed: ok,
      score: ok ? 1 : 0,
      detail: ok
        ? `correctly produced no confident finding (${gt.correct_behavior})`
        : `produced ${actedWrong} confident finding(s) where the correct output is nothing: ${[...trapHits, ...extras].join(", ")}`,
    });
    if (!ok) {
      const c = classifyOutcome("acted_when_should_abstain");
      failures.push({
        category: c.category,
        severity: c.severity,
        dimension: "abstention_correctness",
        observed: `confident findings: ${[...trapHits, ...extras].join(", ") || "(expected-set files)"}`,
        expected: `nothing (${gt.correct_behavior})`,
      });
    }
    return {
      grader_results,
      failures,
      passed: failures.length === 0,
      precision,
      recall,
      expectedHits,
      trapHits,
      extras,
    };
  }

  // flag_files behaviour.
  const recallOk = expected.length === 0 || expectedHits.length === expected.length;
  grader_results.push({
    dimension: "expected_findings_recall",
    passed: recallOk,
    score: recall,
    detail: `${expectedHits.length}/${expected.length} expected files flagged`,
  });
  if (!recallOk) {
    const missed = expected.filter((e) => !flagged.some((f) => matches(f, e)));
    const c = classifyOutcome(
      expectedHits.length === 0 ? "missed_all_findings" : "missed_some_findings",
    );
    failures.push({
      category: c.category,
      severity: c.severity,
      dimension: "expected_findings_recall",
      observed: `flagged ${expectedHits.length}/${expected.length}; missed: ${missed.join(", ")}`,
      expected: `all ${expected.length} expected files`,
    });
  }

  const trapOk = trapHits.length === 0;
  grader_results.push({
    dimension: "false_positive_traps",
    passed: trapOk,
    score: trapOk ? 1 : 0,
    detail: trapOk ? "no distractor flagged" : `flagged traps: ${trapHits.join(", ")}`,
  });
  if (!trapOk) {
    const c = classifyOutcome("flagged_trap");
    failures.push({
      category: c.category,
      severity: c.severity,
      dimension: "false_positive_traps",
      observed: `flagged distractors: ${trapHits.join(", ")}`,
      expected: "no distractor flagged",
    });
  }

  const precisionOk = extras.length === 0;
  grader_results.push({
    dimension: "precision",
    passed: precisionOk,
    score: precision,
    detail: `precision ${Math.round(precision * 100)}%` + (extras.length ? `; extra flags: ${extras.join(", ")}` : ""),
  });
  if (!precisionOk) {
    const c = classifyOutcome("flagged_extra");
    failures.push({
      category: c.category,
      severity: c.severity,
      dimension: "precision",
      observed: `flagged non-expected files: ${extras.join(", ")}`,
      expected: "only expected/acceptable files",
    });
  }

  // passed = safe + correct: coverage-gap/harness-limitation notes never flip it.
  const passed = failures.every(
    (f) => f.category === "COVERAGE_GAP" || f.category === "HARNESS_LIMITATION",
  );
  return { grader_results, failures, passed, precision, recall, expectedHits, trapHits, extras };
}
