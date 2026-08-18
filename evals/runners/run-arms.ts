/**
 * Representation experiment driver (spec §11.21) — declare the N named arms and
 * write the report that makes the controlled experiment inspectable.
 *
 *   tsx evals/runners/run-arms.ts            # deterministic arm measured; A/B/C not measured
 *   MENDPOINT_EVAL_LIVE=1 tsx evals/runners/run-arms.ts   # also measure arm A (raw retrieval + Muse)
 *
 * This is SEPARATE from `eval:synthetic` and shares the live lane's double gate:
 * arm A (raw retrieval + Muse) runs only when the live model is explicitly
 * requested AND configured; otherwise it is recorded "not measured" with the
 * reason. Arms B (Change Graph projection + Muse) and C (+ independent verifier)
 * are DECLARED but cannot run yet — the projection is not wired into
 * `packages/code-impact` and `packages/verifier` is not on main — so they are
 * reported not-measured with their code blockers, never dropped from the report.
 *
 * Writes:
 *   evals/reports/representation-arms.md    every declared arm × task family
 *   evals/reports/representation-arms.json  machine-readable payload
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LiveModelProvenanceRecord } from "@mendpoint/agent";
import {
  liveModelRecordFromObservation,
  resolveLiveLaneConfig,
  type LiveModelApprovedConfig,
} from "@mendpoint/eval/live-model";
import { CORPUS_ROOT, SCENARIOS } from "../scenarios/index.js";
import { resolveScenarios } from "../scenarios/resolve.js";
import { runFettler } from "./fettler-runner.js";
import { assertCorpusIsolation } from "./isolation.js";
import { buildLiveResult, scoreRun, skippedLiveResult } from "./live-lane.js";
import {
  ANALYSIS_CORE_ARM,
  ARM_A_RAW_MUSE,
  ARM_B_GRAPH_MUSE,
  ARM_C_GRAPH_MUSE_VERIFIER,
  REPRESENTATION_ARMS,
  analysisCoreArmResult,
  buildArmSuitePayload,
  buildScenarioArms,
  liveResultAsArmResult,
  notMeasuredArmResult,
  renderArmSuiteReport,
  type ArmScenarioResult,
  type ScenarioArms,
} from "./arms.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

const ARM_B_BLOCKER =
  "Change Graph projection is not wired into packages/code-impact (@mendpoint/graph-learn is not on the evaluated path); the projection is being built concurrently";
const ARM_C_BLOCKER =
  "the independent verifier (packages/verifier) is not on main yet (arrives with PR #182); arm C also depends on the arm B projection";

function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return "unknown";
  }
}

function liveEnvRequested(env: NodeJS.ProcessEnv): boolean {
  const v = (env.MENDPOINT_EVAL_LIVE ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function parseArgs(argv: string[]): { live: boolean; only?: string } {
  const out = { live: false, only: undefined as string | undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--live") out.live = true;
    else if (argv[i] === "--only") out.only = argv[++i];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const commit = gitCommit();
  const ctx = { gitCommit: commit, productVersion: `mendpoint+${commit}` };

  assertCorpusIsolation(CORPUS_ROOT, REPO_ROOT);

  const liveRequested = args.live || liveEnvRequested(process.env);
  const config = resolveLiveLaneConfig();
  let approved: LiveModelApprovedConfig | undefined;
  let armAReason: string;
  if (!liveRequested) {
    armAReason = "live lane not requested (pass --live or set MENDPOINT_EVAL_LIVE=1)";
  } else if (config.status === "skipped") {
    armAReason = config.reason;
  } else {
    approved = config.approved;
    armAReason = "";
  }

  // The representation arms exercise the Fettler impact-confirm model path.
  let runnables = resolveScenarios().filter((s) => s.product === "fettler");
  if (args.only) runnables = runnables.filter((s) => s.scenario_id === args.only);
  const toRun = runnables.filter((rs) => {
    if (rs.origin === "corpus") {
      const cfg = SCENARIOS.find((s) => s.scenario_id === rs.scenario_id);
      if (cfg && !existsSync(cfg.repoPath)) return false; // corpus absent — skip cleanly
      if (rs.budgetMs !== undefined) return false; // budgeted scale scenario excluded
    }
    return true;
  });

  const scenarios: ScenarioArms[] = [];
  for (const rs of toRun) {
    const prepared = rs.prepare();
    try {
      process.stdout.write(`running ${rs.scenario_id} (analysis core) ... `);
      const detRecord = await runFettler(prepared.config, rs.gt, ctx);
      const detScore = scoreRun(detRecord, rs.gt);
      process.stdout.write(`${detScore.passed ? "PASS" : "FAIL"} ${detRecord.latency_ms}ms\n`);

      let armA: ArmScenarioResult;
      if (approved) {
        const provenance: LiveModelProvenanceRecord[] = [];
        process.stdout.write(`running ${rs.scenario_id} (arm A: raw retrieval + Muse) ... `);
        const liveRecord = await runFettler(prepared.config, rs.gt, ctx, {
          onLlmCall: (obs) => provenance.push(liveModelRecordFromObservation(obs)),
        });
        armA = liveResultAsArmResult(buildLiveResult(liveRecord, rs.gt, provenance, approved));
        process.stdout.write(`${provenance.length} call(s)\n`);
      } else {
        armA = liveResultAsArmResult(skippedLiveResult(armAReason));
      }

      const results: Record<string, ArmScenarioResult> = {
        [ANALYSIS_CORE_ARM.id]: analysisCoreArmResult(detScore),
        [ARM_A_RAW_MUSE.id]: armA,
        [ARM_B_GRAPH_MUSE.id]: notMeasuredArmResult(ARM_B_BLOCKER),
        [ARM_C_GRAPH_MUSE_VERIFIER.id]: notMeasuredArmResult(ARM_C_BLOCKER),
      };
      scenarios.push(buildScenarioArms(rs.gt, rs.scenario_id, rs.product, results));
    } finally {
      prepared.cleanup();
    }
  }

  const payload = buildArmSuitePayload({ gitCommit: commit, arms: REPRESENTATION_ARMS, scenarios });
  const reportsDir = join(HERE, "..", "reports");
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(reportsDir, "representation-arms.md"), renderArmSuiteReport(payload), "utf8");
  writeFileSync(
    join(reportsDir, "representation-arms.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );

  console.log("");
  console.log(`declared arms: ${REPRESENTATION_ARMS.map((a) => a.id).join(", ")}`);
  console.log(`arm A (raw retrieval + Muse): ${approved ? "MEASURED" : "NOT MEASURED — " + armAReason}`);
  console.log(`arm B (Change Graph projection + Muse): NOT MEASURED — ${ARM_B_BLOCKER}`);
  console.log(`arm C (+ independent verifier): NOT MEASURED — ${ARM_C_BLOCKER}`);
  console.log("");
  console.log(`wrote evals/reports/representation-arms.md, evals/reports/representation-arms.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
