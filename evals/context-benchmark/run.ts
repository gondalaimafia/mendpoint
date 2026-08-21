/**
 * Deterministic runner for the stateless-versus-persistent context benchmark.
 *
 *   npx tsx evals/context-benchmark/run.ts
 *
 * It stages both arms over the cohort WITHOUT the sealed key, grades against the
 * sealed key, evaluates the gates, and prints the report plus the controlled
 * memory panel. No live model is called; time and cost are reported not-measured.
 */
import {
  stageBenchmark,
  gradeBenchmark,
  evaluateGates,
  type ArmMetrics,
  type BenchmarkReport,
  type Metric,
  type BenchmarkScenario,
  type SealedKey,
} from "./context-benchmark.js";
import {
  COHORT,
  SEALED_KEY,
  sealedKeyFor,
  MEMORY_CONTROLLED_SCENARIO,
  CONTEXT_INFLATION_SCENARIO,
  CONFLICTING_CONTEXT_SCENARIO,
} from "./scenarios.js";

function m(metric: Metric): string {
  return metric.measured ? metric.value.toFixed(4) : `not-measured (${metric.reason})`;
}

function armLine(a: ArmMetrics): string {
  return [
    `  arm=${a.arm}`,
    `hazards=${a.hazardsGraded}`,
    `correct=${m(a.taskCorrectness)}`,
    `repeatRate=${m(a.repeatedMistakeRate)} (${a.repeatedMistakeCount}/${a.priorlyResolvedHazards})`,
    `reInstr=${a.repeatedInstructions}`,
    `corrections=${a.humanCorrections}`,
    `consistency=${m(a.migrationConsistency)}`,
    `verify=${m(a.verificationSuccess)} (${a.stagesPassed}/${a.stagesTotal})`,
    `policyViol=${a.policyViolations}/${a.policyGovernedHazards}`,
    `ctxTokens=${a.contextTokens}`,
    `retrieval=${a.retrievalCalls}`,
    `time=${m(a.timeToCompletionMs)}`,
    `cost=${m(a.costUsd)}`,
  ].join("  ");
}

function printReport(title: string, report: BenchmarkReport): void {
  console.log(`\n=== ${title} ===`);
  console.log(`cohort: ${report.cohort.scenarios} scenarios, ${report.cohort.tasks} tasks, ${report.cohort.hazards} hazards`);
  console.log(`cohortDigest=${report.cohortDigest}`);
  console.log(armLine(report.arms.stateless));
  console.log(armLine(report.arms.persistent));
  const q = report.arms.persistent.contextQuality;
  console.log(
    `  persistent context quality: relevant=${q.relevant} irrelevant=${q.irrelevant} stale=${q.stale} conflicting=${q.conflicting} duplicated=${q.duplicated} total=${q.total} tokens=${q.tokens}`,
  );
  console.log(`  HEADLINE repeated-mistake rate: stateless=${m(report.headline.statelessRepeatedMistakeRate)} persistent=${m(report.headline.persistentRepeatedMistakeRate)}`);
  console.log(`  HEADLINE repeats avoided by persistent context: ${m(report.headline.repeatsAvoidedByPersistentContext)}`);
}

function run(title: string, scenarios: readonly BenchmarkScenario[], key: SealedKey): BenchmarkReport {
  const staged = stageBenchmark(scenarios);
  const report = gradeBenchmark(scenarios, staged, key);
  printReport(title, report);
  const verdict = evaluateGates(scenarios, report, staged);
  console.log(`  gates: overall=${verdict.overall}`);
  for (const g of verdict.gates) console.log(`    [${g.status}] ${g.id} — ${g.detail}`);
  return report;
}

run("FULL COHORT", COHORT, SEALED_KEY);
run("CONTROLLED: memory-oauth (Mission 1 -> Mission 2)", [MEMORY_CONTROLLED_SCENARIO], sealedKeyFor([MEMORY_CONTROLLED_SCENARIO]));
run("CONTROL: context inflation (more context, no better outcome)", [CONTEXT_INFLATION_SCENARIO], sealedKeyFor([CONTEXT_INFLATION_SCENARIO]));
run("CONTROL: conflicting context (persistent context is worse)", [CONFLICTING_CONTEXT_SCENARIO], sealedKeyFor([CONFLICTING_CONTEXT_SCENARIO]));
