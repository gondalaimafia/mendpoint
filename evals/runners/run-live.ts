/**
 * Phase 10/11 driver — run the deterministic and live-model lanes side by side.
 *
 *   MENDPOINT_EVAL_LIVE=1 tsx evals/runners/run-live.ts      # request the live lane
 *   tsx evals/runners/run-live.ts --live                     # same, via flag
 *   tsx evals/runners/run-live.ts                            # deterministic-only; live NOT MEASURED
 *
 * This is SEPARATE from `eval:synthetic` (run-all.ts) on purpose: a normal
 * synthetic run must never make paid model calls. The live lane here is
 * DOUBLE-gated — it runs only when it is explicitly requested (flag/env) AND the
 * model/endpoint/key are configured. If requested but unconfigured, the lane is
 * recorded as "not measured" with a stated reason; it is never downgraded to the
 * deterministic path and reported as live.
 *
 * Writes:
 *   evals/reports/live-lane.md    deterministic vs deterministic+model, side by side
 *   evals/reports/live-lane.json  machine-readable payload (the Muse-baseline seed)
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LiveModelProvenanceRecord } from "@mendpoint/agent";
import {
  liveModelRecordFromObservation,
  resolveLiveLaneConfig,
  type LiveModelApprovedConfig,
} from "@mendpoint/eval/live-model";
import { CORPUS_ROOT, CORPUS_ROOT_CONFIGURED, SCENARIOS } from "../scenarios/index.js";
import { resolveScenarios } from "../scenarios/resolve.js";
import { runFettler } from "./fettler-runner.js";
import { assertCorpusRunIsolation } from "./isolation.js";
import {
  buildLiveLanePayload,
  buildLiveResult,
  compareLanes,
  renderLiveLaneReport,
  scoreRun,
  skippedLiveResult,
  type LaneComparison,
  type LiveScenarioResult,
} from "./live-lane.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return "unknown";
  }
}

function productVersion(commit: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    return `mendpoint@${pkg.version}+${commit}`;
  } catch {
    return `mendpoint@unknown+${commit}`;
  }
}

function parseArgs(argv: string[]): { live: boolean; only?: string } {
  const out = { live: false, only: undefined as string | undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--live") out.live = true;
    else if (argv[i] === "--only") out.only = argv[++i];
  }
  return out;
}

function liveEnvRequested(env: NodeJS.ProcessEnv): boolean {
  const v = (env.MENDPOINT_EVAL_LIVE ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const commit = gitCommit();
  const ctx = { gitCommit: commit, productVersion: productVersion(commit) };

  // Same answer-key isolation invariant the deterministic driver asserts: every
  // corpus repo must resolve OUTSIDE the repo that holds the ground truth. This
  // matters more with the model on, since the product now reads staged files.
  assertCorpusRunIsolation({
    corpusRoot: CORPUS_ROOT,
    configured: CORPUS_ROOT_CONFIGURED,
    corpusRepoPaths: SCENARIOS.map((s) => s.repoPath),
    repoRoot: REPO_ROOT,
  });

  const liveRequested = args.live || liveEnvRequested(process.env);
  const config = resolveLiveLaneConfig();

  let laneStatus: "ready" | "skipped";
  let skipReason: string | undefined;
  let approved: LiveModelApprovedConfig | undefined;
  if (!liveRequested) {
    laneStatus = "skipped";
    skipReason = "live lane not requested (pass --live or set MENDPOINT_EVAL_LIVE=1)";
  } else if (config.status === "skipped") {
    laneStatus = "skipped";
    skipReason = config.reason;
  } else {
    laneStatus = "ready";
    approved = config.approved;
  }

  // The live lane exists for Fettler only (impact-confirm model path). ReGauge's
  // analyze-only runner exercises no model path; it is reported as not-applicable.
  let runnables = resolveScenarios().filter((s) => s.product === "fettler");
  if (args.only) runnables = runnables.filter((s) => s.scenario_id === args.only);

  const excluded: { scenario_id: string; reason: string }[] = [];
  const toRun = runnables.filter((rs) => {
    if (rs.origin === "corpus") {
      const cfg = SCENARIOS.find((s) => s.scenario_id === rs.scenario_id);
      if (cfg && !existsSync(cfg.repoPath)) return false; // corpus absent — skip cleanly
      if (rs.budgetMs !== undefined) {
        excluded.push({
          scenario_id: rs.scenario_id,
          reason: "budgeted scale scenario; excluded from the live lane to bound cost and time",
        });
        return false;
      }
    }
    return true;
  });

  const comparisons: LaneComparison[] = [];
  const allProvenance: LiveModelProvenanceRecord[] = [];

  for (const rs of toRun) {
    const prepared = rs.prepare();
    try {
      process.stdout.write(`running ${rs.scenario_id} (deterministic) ... `);
      const detRecord = await runFettler(prepared.config, rs.gt, ctx);
      const detScore = scoreRun(detRecord, rs.gt);
      process.stdout.write(`${detScore.passed ? "PASS" : "FAIL"} ${detRecord.latency_ms}ms\n`);

      let live: LiveScenarioResult;
      if (laneStatus === "ready" && approved) {
        const provenance: LiveModelProvenanceRecord[] = [];
        process.stdout.write(`running ${rs.scenario_id} (live model) ... `);
        const liveRecord = await runFettler(prepared.config, rs.gt, ctx, {
          onLlmCall: (obs) => provenance.push(liveModelRecordFromObservation(obs)),
        });
        live = buildLiveResult(liveRecord, rs.gt, provenance, approved);
        allProvenance.push(...provenance);
        const g = live.provenanceGrade;
        process.stdout.write(
          `${live.score!.passed ? "PASS" : "FAIL"} ${liveRecord.latency_ms}ms; ${provenance.length} call(s)` +
            `${g ? ` provenance ${g.passed ? "PASS" : "FAIL"}` : ""}\n`,
        );
      } else {
        live = skippedLiveResult(skipReason ?? "not measured");
      }
      comparisons.push(compareLanes(rs.gt, rs.scenario_id, rs.product, detScore, live));
    } finally {
      prepared.cleanup();
    }
  }

  const payload = buildLiveLanePayload({
    gitCommit: commit,
    liveRequested,
    laneStatus,
    skipReason,
    approved,
    excluded,
    comparisons,
    provenance: allProvenance,
  });

  const reportsDir = join(HERE, "..", "reports");
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(reportsDir, "live-lane.md"), renderLiveLaneReport(payload), "utf8");
  writeFileSync(join(reportsDir, "live-lane.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");

  console.log("");
  console.log(`live lane: ${laneStatus === "ready" ? "MEASURED" : "NOT MEASURED"}`);
  if (skipReason) console.log(`  reason: ${skipReason}`);
  const d = payload.summary.deterministic;
  console.log(
    `deterministic: ${d.passed}/${d.scenarios} passed; precision ${d.precisionMicro === null ? "n/a" : (d.precisionMicro * 100).toFixed(1) + "%"}, recall ${d.recallMicro === null ? "n/a" : (d.recallMicro * 100).toFixed(1) + "%"}`,
  );
  if (payload.summary.live) {
    const l = payload.summary.live;
    console.log(
      `live: ${l.passed}/${l.measured} measured passed; precision ${l.precisionMicro === null ? "n/a" : (l.precisionMicro * 100).toFixed(1) + "%"}, recall ${l.recallMicro === null ? "n/a" : (l.recallMicro * 100).toFixed(1) + "%"}; ${payload.aggregate.totalModelCalls} call(s), ${payload.aggregate.totalCostUsd.toFixed(6)} USD`,
    );
    if (payload.aggregate.provenanceGrade) {
      console.log(`provenance (union): ${payload.aggregate.provenanceGrade.passed ? "PASS" : "FAIL"}`);
    }
  }
  console.log("");
  console.log(`wrote evals/reports/live-lane.md, evals/reports/live-lane.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
