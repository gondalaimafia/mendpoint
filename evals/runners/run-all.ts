/**
 * Phase 4 driver — run the full suite and emit reports.
 *
 *   tsx evals/runners/run-all.ts            # run everything, write reports
 *   tsx evals/runners/run-all.ts --only fettler-ts-payments-rename
 *   tsx evals/runners/run-all.ts --product fettler
 *
 * Writes:
 *   evals/reports/latest.md          design-partner readiness dashboard
 *   evals/FAILURES.md                failure backlog
 *   evals/reports/latest-runs.json   raw per-run records (dataset seed)
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CORPUS_ROOT, SCENARIOS, type ScenarioConfig } from "../scenarios/index.js";
import { resolveScenarios, type RunnableScenario } from "../scenarios/resolve.js";
import { loadGroundTruth } from "../ground-truth/load.js";
import type { GroundTruth } from "../ground-truth/schema.js";
import { runFettler } from "./fettler-runner.js";
import { runRegauge } from "./regauge-runner.js";
import { renderLatestReport, renderFailuresBacklog, type ScoredRun } from "./report.js";
import { assertCorpusIsolation } from "./isolation.js";
import { evaluateReadiness, loadReadinessGates } from "../readiness.js";
import { renderScorecard } from "../scorecard.js";
import type { RunRecord } from "./types.js";

const RECORD_START = "@@RUNRECORD_START@@";
const RECORD_END = "@@RUNRECORD_END@@";

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

function parseArgs(argv: string[]): {
  only?: string;
  product?: string;
  skip: string[];
  record: boolean;
  generatedOnly: boolean;
  enforceReadiness: boolean;
} {
  const out = {
    only: undefined as string | undefined,
    product: undefined as string | undefined,
    skip: [] as string[],
    record: false,
    generatedOnly: false,
    enforceReadiness: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") out.only = argv[++i];
    else if (argv[i] === "--product") out.product = argv[++i];
    else if (argv[i] === "--skip") out.skip.push(...(argv[++i] ?? "").split(",").filter(Boolean));
    else if (argv[i] === "--record") out.record = true;
    else if (argv[i] === "--generated-only") out.generatedOnly = true;
    else if (argv[i] === "--enforce-readiness") out.enforceReadiness = true;
  }
  return out;
}

async function runOne(
  cfg: ScenarioConfig,
  gt: GroundTruth,
  ctx: { gitCommit: string; productVersion: string },
): Promise<RunRecord> {
  return cfg.product === "fettler" ? runFettler(cfg, gt, ctx) : runRegauge(cfg, gt, ctx);
}

/**
 * Run a resolved scenario in-process: prepare (materialize a generated repo or
 * point at the corpus repo), run the product, then clean up scratch.
 */
async function runResolved(
  rs: RunnableScenario,
  ctx: { gitCommit: string; productVersion: string },
): Promise<RunRecord> {
  const { config, cleanup } = rs.prepare();
  try {
    return await runOne(config, rs.gt, ctx);
  } finally {
    cleanup();
  }
}

/**
 * Run a budgeted scenario in an isolated child process; hard-kill the process
 * tree if it exceeds the budget and synthesize a SCALE_FAILURE record. This is
 * how the suite measures "latency becomes unreasonable" on large repos without
 * hanging the whole run — the product call is CPU-bound and will not yield to an
 * in-process timer, so isolation is the only reliable bound.
 */
function runIsolated(
  cfg: ScenarioConfig,
  ctx: { gitCommit: string; productVersion: string },
): RunRecord {
  const self = fileURLToPath(import.meta.url);
  const started = Date.now();
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", self, "--only", cfg.scenario_id, "--record"],
    { cwd: REPO_ROOT, timeout: cfg.budgetMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, killSignal: "SIGKILL" },
  );
  const out = res.stdout ?? "";
  const start = out.indexOf(RECORD_START);
  const end = out.indexOf(RECORD_END);
  if (!res.error && start >= 0 && end > start) {
    try {
      return JSON.parse(out.slice(start + RECORD_START.length, end)) as RunRecord;
    } catch {
      /* fall through to synthesized failure */
    }
  }
  const timedOut = res.error !== undefined && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  return {
    run_id: randomUUID(),
    timestamp: new Date().toISOString(),
    git_commit: ctx.gitCommit,
    product: cfg.product,
    product_version: ctx.productVersion,
    scenario_id: cfg.scenario_id,
    scenario_version: "1",
    invocation_path: `isolated child process, budget ${cfg.budgetMs}ms`,
    model: null,
    model_provider: null,
    routing_decisions: [],
    tokens: null,
    latency_ms: Date.now() - started,
    estimated_cost_usd: null,
    activity: { filesExamined: 0, notes: [timedOut ? `exceeded ${cfg.budgetMs}ms budget; hard-killed` : "child produced no record"] },
    findings: [],
    findingGraphPaths: [],
    confidence: null,
    produced_edit: false,
    grader_results: [
      { dimension: "completes_within_budget", passed: false, score: 0, detail: timedOut ? `did not complete within ${cfg.budgetMs}ms` : "no record emitted" },
    ],
    failures: [
      {
        category: "SCALE_FAILURE",
        severity: "P1",
        dimension: "completes_within_budget",
        observed: timedOut ? `analysis did not finish within the ${cfg.budgetMs}ms budget on this repository` : "child process produced no run record",
        expected: "complete analysis within the budget",
      },
    ],
    passed: false,
    unmeasured_dimensions: ["impact findings (analysis did not complete within budget)"],
    error: timedOut ? "ETIMEDOUT" : res.error ? String(res.error) : "no record",
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const commit = gitCommit();
  const ctx = { gitCommit: commit, productVersion: productVersion(commit) };

  // --record: single-scenario in-process run, emit the record for the parent.
  // Only budgeted CORPUS scenarios use this path (generated scenarios never
  // carry a budget, so they always run in the parent process).
  if (args.record) {
    if (!args.only) throw new Error("--record requires --only <scenario_id>");
    const cfg = SCENARIOS.find((s) => s.scenario_id === args.only);
    if (!cfg) throw new Error(`unknown scenario: ${args.only}`);
    const record = await runOne(cfg, loadGroundTruth(cfg.scenario_id), ctx);
    process.stdout.write(`\n${RECORD_START}${JSON.stringify(record)}${RECORD_END}\n`);
    return;
  }

  // Answer-key isolation invariant (spec §18.3): the corpus MUST resolve outside
  // the repo that holds the ground truth. Assert it before anything runs, so
  // committing the corpus or a misconfigured MENDPOINT_CORPUS_ROOT fails loudly
  // instead of silently letting a staged product read its own answer key.
  assertCorpusIsolation(CORPUS_ROOT, REPO_ROOT);

  let scenarios: RunnableScenario[] = resolveScenarios();
  if (args.only) scenarios = scenarios.filter((s) => s.scenario_id === args.only);
  if (args.product) scenarios = scenarios.filter((s) => s.product === args.product);
  if (args.skip.length) scenarios = scenarios.filter((s) => !args.skip.includes(s.scenario_id));
  if (args.generatedOnly) scenarios = scenarios.filter((s) => s.origin === "generated");

  // The hand-authored corpus lives outside the repo (external path). On a machine
  // without it — every GitHub-hosted CI runner — skip those scenarios cleanly
  // rather than record them as crashes. Generated scenarios always run. What was
  // skipped is reported so a green run can never be mistaken for full coverage.
  const skippedCorpus: string[] = [];
  scenarios = scenarios.filter((rs) => {
    if (rs.origin !== "corpus") return true;
    const cfg = SCENARIOS.find((s) => s.scenario_id === rs.scenario_id);
    if (cfg && existsSync(cfg.repoPath)) return true;
    skippedCorpus.push(rs.scenario_id);
    return false;
  });
  if (skippedCorpus.length) {
    process.stdout.write(
      `skipping ${skippedCorpus.length} corpus scenario(s) — corpus not present at ${CORPUS_ROOT} (generated suite still runs)\n`,
    );
  }

  const scored: ScoredRun[] = [];
  for (const rs of scenarios) {
    const isolated = rs.origin === "corpus" && rs.budgetMs !== undefined;
    process.stdout.write(
      `running ${rs.scenario_id} (${rs.product}, ${rs.origin})${isolated ? " [isolated]" : ""} ... `,
    );
    // Budgeted corpus scenarios run isolated so a CPU-bound stall cannot hang
    // the suite; the isolated child re-resolves the config from the registry.
    const record = isolated
      ? runIsolated(SCENARIOS.find((s) => s.scenario_id === rs.scenario_id)!, ctx)
      : await runResolved(rs, ctx);
    scored.push({ record, gt: rs.gt });
    const gap = record.failures.some((f) => f.category === "COVERAGE_GAP");
    process.stdout.write(
      `${record.passed ? "PASS" : "FAIL"}${gap ? " (coverage gap)" : ""}${record.error ? ` (${record.error})` : ""} ${record.latency_ms}ms\n`,
    );
  }

  const gates = loadReadinessGates();
  const readiness = evaluateReadiness(scored, gates);

  const reportsDir = join(HERE, "..", "reports");
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(reportsDir, "latest.md"), renderLatestReport(scored), "utf8");
  writeFileSync(join(HERE, "..", "FAILURES.md"), renderFailuresBacklog(scored), "utf8");
  writeFileSync(join(reportsDir, "readiness-scorecard.md"), renderScorecard(scored, readiness, gates), "utf8");
  writeFileSync(
    join(reportsDir, "latest-runs.json"),
    JSON.stringify(scored.map((s) => s.record), null, 2) + "\n",
    "utf8",
  );

  const total = scored.length;
  const passed = scored.filter((s) => s.record.passed).length;
  const p0 = scored.flatMap((s) => s.record.failures).filter((f) => f.severity === "P0").length;
  console.log("");
  console.log(`suite: ${passed}/${total} passed; P0 failures: ${p0}`);
  if (skippedCorpus.length) {
    console.log(`corpus scenarios skipped (corpus absent): ${skippedCorpus.length} — generated coverage only, NOT the full readiness measure`);
  }
  console.log("");
  console.log(`readiness policy: ${readiness.policy} (owner ${readiness.owner}); OVERALL ${readiness.overall}`);
  for (const cap of readiness.capabilities) {
    console.log(`  ${cap.capability}: ${cap.verdict}`);
    for (const c of cap.criteria) {
      const v = !c.measurable ? "NOT MEASURED" : c.passed ? "PASS" : "FAIL";
      console.log(`    - ${c.name}: ${c.measured} (need ${c.threshold}) -> ${v}`);
    }
  }
  console.log("");
  console.log(`wrote evals/reports/latest.md, evals/reports/readiness-scorecard.md, evals/FAILURES.md, evals/reports/latest-runs.json`);

  // The readiness gate is an INSTRUMENT: by default it reports its verdict and
  // the run still exits 0 (a corpus built to make the product fail cannot gate CI
  // green). --enforce-readiness turns it into a hard gate for a future GA check;
  // it is intentionally NOT wired into per-PR CI today, where the gate is
  // expected to fail honestly (~precision-first bar not yet met).
  if (args.enforceReadiness && readiness.overall !== "PASS") {
    console.error(`readiness gate NOT met and --enforce-readiness set; exiting non-zero`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
