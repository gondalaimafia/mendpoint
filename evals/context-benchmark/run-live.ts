/**
 * Runner for the LIVE-MODEL context-benchmark arm.
 *
 *   npx tsx evals/context-benchmark/run-live.ts
 *
 * It reuses the exact deterministic cohort and sealed key, builds each arm's
 * prompt with the REAL Mission Context Compiler, and measures a real model's
 * realized repeat-avoidance against the deterministic ceiling. It is SAFE to run
 * unconfigured: it skips with an explicit not-measured reason and spends nothing.
 *
 * Required configuration to actually measure (any missing one skips cleanly):
 *   - OPENAI_API_KEY (or XAI_API_KEY)     — provider credential (never printed).
 *   - LLM_AGENT_URL                        — the model endpoint base URL.
 *   - LLM_AGENT_MODEL=muse-spark-1.2-contributor — the approved model id.
 *   - MENDPOINT_LIVE_APPROVED_HOST         — the endpoint host, pinned out of band
 *     (must equal the LLM_AGENT_URL host); this is the task-1 host pin.
 *   - MENDPOINT_LIVE_EVAL_MAX_USD          — optional hard cap; defaults to $5.
 *
 * The contributor tier trains on submitted prompts and completions; every prompt
 * here is synthetic (the in-memory cohort under tenant tenant-northwind), so no
 * customer data leaves the process.
 */
import { runLiveContextBenchmark, type LiveContextMeasured } from "./live-arm.js";
import type { ArmId, Metric } from "./context-benchmark.js";

function m(metric: Metric): string {
  return metric.measured ? metric.value.toFixed(4) : `not-measured (${metric.reason})`;
}

function printMeasured(result: LiveContextMeasured): void {
  const { report } = result;
  console.log("\n=== LIVE CONTEXT ARM (real model) ===");
  console.log(`approved: model=${result.approved.model} host=${result.approved.host}`);
  console.log(`cohort: ${report.cohort.scenarios} scenarios, ${report.cohort.tasks} tasks, ${report.cohort.hazards} hazards`);
  for (const arm of ["stateless", "persistent"] as ArmId[]) {
    const a = report.arms[arm];
    const usage = result.perArm[arm];
    console.log(
      `  arm=${arm}  correct=${m(a.taskCorrectness)}  repeatRate=${m(a.repeatedMistakeRate)} ` +
        `(${a.repeatedMistakeCount}/${a.priorlyResolvedHazards})  corrections=${a.humanCorrections}  ` +
        `verify=${m(a.verificationSuccess)} (${a.stagesPassed}/${a.stagesTotal})  ` +
        `modelCalls=${usage.calls}  modelTokens=${usage.modelTokens}  cost=$${usage.costUsd.toFixed(4)}`,
    );
  }
  console.log(
    `  HEADLINE realized repeats avoided by persistent context: ${m(result.realizedRepeatsAvoided)} ` +
      `(stateless=${m(report.headline.statelessRepeatedMistakeRate)} persistent=${m(report.headline.persistentRepeatedMistakeRate)})`,
  );
  console.log(`  gates: overall=${result.gates.overall}`);
  for (const g of result.gates.gates) console.log(`    [${g.status}] ${g.id} — ${g.detail}`);
  console.log(`  estimate=$${result.estimateUsd.toFixed(4)}  ACTUAL SPEND=$${result.spentUsd.toFixed(4)}`);
}

async function main(): Promise<void> {
  const result = await runLiveContextBenchmark();
  if (result.status === "not_measured") {
    console.log(`\nLIVE CONTEXT ARM not measured: ${result.reason}`);
    console.log(`ACTUAL SPEND=$${result.spentUsd.toFixed(4)}`);
    return;
  }
  printMeasured(result);
}

void main();
