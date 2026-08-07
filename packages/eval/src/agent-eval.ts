import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  runAgentEvalScenarios,
  type AgentEvalReport,
} from "./agent-eval-contract.js";
import {
  runCapabilityEval,
  type CapabilityEvalReport,
} from "./capability-eval.js";
import { TRANSFORMER_AGENT_EVAL_SCENARIOS } from "./transformer-agent-eval.js";
import { TRANSFORMER_ADAPTIVE_DELIVERY_EVAL_SCENARIO } from "./transformer-adaptive-delivery-eval.js";
import { WARDEN_AGENT_EVAL_SCENARIOS } from "./warden-agent-eval.js";
import {
  WARDEN_SOURCE_EVAL_SCENARIO,
  WARDEN_WORKER_SOURCE_EVAL_SCENARIO,
} from "./warden-source-eval.js";

export type WardenTransformerEvalReport = Readonly<{
  schemaVersion: 1;
  passed: boolean;
  behavior: AgentEvalReport;
  capability: CapabilityEvalReport;
}>;

export async function runWardenTransformerEval(
  repetitions = 3,
): Promise<WardenTransformerEvalReport> {
  const behavior = await runAgentEvalScenarios(
    [
      ...WARDEN_AGENT_EVAL_SCENARIOS,
      WARDEN_SOURCE_EVAL_SCENARIO,
      WARDEN_WORKER_SOURCE_EVAL_SCENARIO,
      ...TRANSFORMER_AGENT_EVAL_SCENARIOS,
      TRANSFORMER_ADAPTIVE_DELIVERY_EVAL_SCENARIO,
    ],
    repetitions,
  );
  const capability = await runCapabilityEval();
  return Object.freeze({
    schemaVersion: 1,
    passed: behavior.passed && capability.passed === capability.total &&
      capability.criticalFailures.length === 0,
    behavior,
    capability,
  });
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function persistReport(path: string, report: WardenTransformerEvalReport): string {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}

async function main(): Promise<void> {
  const repetitionsValue = Number(option("repetitions") ?? "3");
  const report = await runWardenTransformerEval(repetitionsValue);
  const output = option("output");
  if (output) console.log(`Agent eval report ${persistReport(output, report)}`);
  console.log(`Agent eval corpus ${report.behavior.corpusVersion}`);
  console.log(`Warden ${report.behavior.byProduct.warden.passed}/${report.behavior.byProduct.warden.total}`);
  console.log(`Transformer ${report.behavior.byProduct.transformer.passed}/${report.behavior.byProduct.transformer.total}`);
  console.log(`Contract evidence ${report.behavior.byEvidenceLane.contract.passed}/${report.behavior.byEvidenceLane.contract.total}`);
  console.log(`Scripted planner evidence ${report.behavior.byEvidenceLane.simulated_scripted.passed}/${report.behavior.byEvidenceLane.simulated_scripted.total}`);
  console.log(`Live model evidence ${report.behavior.byEvidenceLane.live_model.passed}/${report.behavior.byEvidenceLane.live_model.total}`);
  if (report.behavior.byEvidenceLane.live_model.total === 0) {
    console.log("Live model capability not evaluated");
  }
  console.log(`Trials ${report.behavior.trialCount}`);
  console.log(`pass@1 ${report.behavior.passAtOne.toFixed(3)}`);
  console.log(`pass@${report.behavior.repetitions} ${report.behavior.passAtK.toFixed(3)}`);
  console.log(`pass^${report.behavior.repetitions} ${report.behavior.passToK.toFixed(3)}`);
  console.log(`Critical failures ${report.behavior.criticalFailures.length}`);
  console.log(`Deterministic failures ${report.behavior.deterministicFailures.length}`);
  for (const scenario of report.behavior.scenarios.filter((candidate) => !candidate.passed)) {
    console.error(`${scenario.id}:`);
    for (const trial of scenario.trials) {
      for (const grade of trial.grades.filter((candidate) => !candidate.passed)) {
        console.error(`  trial ${trial.trial} ${grade.id}: expected ${grade.expected}, observed ${grade.observed}`);
      }
    }
  }
  if (!report.passed) process.exit(1);
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("agent-eval.ts") ||
  process.argv[1]?.replace(/\\/g, "/").endsWith("agent-eval.js");
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
