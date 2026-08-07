import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAgentModelEndpoint,
  resolveAgentModelName,
  runWarden,
  type AgentTask,
  type LiveModelProvenanceRecord,
} from "@mendpoint/agent";
import {
  gradeLiveModelProvenance,
  resolveApprovedLiveModel,
  type LiveModelApprovedConfig,
  type LiveModelGrade,
} from "./live-model-eval.js";
import {
  runTransformerLiveEval,
  type TransformerLiveEvalReport,
} from "./transformer-live-eval.js";

export const LIVE_EVAL_CASE_ID = "warden.live.path_repair.live" as const;
export const DEFAULT_LIVE_EVAL_MAX_USD = 25;
/** Contributor tier allows 60 requests/minute; back off rather than spin. */
export const DEFAULT_LIVE_EVAL_RATE_LIMIT_RETRIES = 3;
export const DEFAULT_LIVE_EVAL_RATE_LIMIT_BACKOFF_MS = 1_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 60_000;

const LIVE_GOAL = "Repair the client path. The correct endpoint is /v1/charges.";
const LIVE_ERROR_LOG = "HTTP 404 for /v1/chargess, expected /v1/charges";
const VERIFY_COMMAND = "node check.mjs";
const ALLOWED_FILES = Object.freeze(["client.js"]);

function liveScenarioFiles(): Readonly<Record<string, string>> {
  return Object.freeze({
    "client.js": "export const chargePath = '/v1/chargess';\n",
    "check.mjs": [
      'import { chargePath } from "./client.js";',
      'if (chargePath !== "/v1/charges") process.exit(1);',
      "",
    ].join("\n"),
  });
}

export type LiveEvalTrial = Readonly<{
  trial: number;
  passed: boolean;
  ok: boolean;
  stoppedReason: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  timeouts: number;
  filesChanged: readonly string[];
  provenance: readonly LiveModelProvenanceRecord[];
  grades: readonly LiveModelGrade[];
}>;

export type LiveEvalReport = Readonly<{
  schemaVersion: 1;
  caseId: typeof LIVE_EVAL_CASE_ID;
  lane: "live_model";
  approved: LiveModelApprovedConfig;
  repetitions: number;
  passed: boolean;
  consistent: boolean;
  budgetUsd: number;
  spentUsd: number;
  totalTokens: number;
  trials: readonly LiveEvalTrial[];
}>;

export type RunWardenLiveEvalOptions = Readonly<{
  repetitions?: number;
  maxSteps?: number;
  now?: () => number;
  /** Bounded retries on HTTP 429 before failing the trial closed. */
  maxRateLimitRetries?: number;
  /** Base backoff (ms); doubles per retry, capped, so it never spins. */
  rateLimitBackoffMs?: number;
  /** Injectable delay for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}>;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedRepetitions(value: number | undefined): number {
  const repetitions = value ?? 3;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10) {
    throw new Error("warden_live_eval_repetitions_invalid");
  }
  return repetitions;
}

function resolveBudgetUsd(env: NodeJS.ProcessEnv): number {
  const raw = env.MENDPOINT_LIVE_EVAL_MAX_USD;
  if (raw === undefined) return DEFAULT_LIVE_EVAL_MAX_USD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LIVE_EVAL_MAX_USD;
}

async function runLiveTrial(
  trial: number,
  approved: LiveModelApprovedConfig,
  maxSteps: number,
  now: () => number,
): Promise<LiveEvalTrial> {
  const root = mkdtempSync(join(tmpdir(), `mendpoint-warden-live-${trial}-`));
  try {
    for (const [path, content] of Object.entries(liveScenarioFiles())) {
      writeFileSync(join(root, path), content, { encoding: "utf8", flag: "wx" });
    }
    // The live lane forbids an injected scripted planner: the task carries none.
    const task: AgentTask = {
      goal: LIVE_GOAL,
      errorLog: LIVE_ERROR_LOG,
      repoRoot: root,
      verifyCommand: VERIFY_COMMAND,
      maxSteps,
      useLlm: true,
      allowNetwork: false,
      modelBudget: { maxCalls: maxSteps, requestTimeoutMs: 30_000, maxResponseBytes: 32_768 },
    };
    const started = now();
    const result = await runWarden(task);
    const latencyMs = Math.max(0, now() - started);
    const model = result.metrics.model;
    const plannerSources = result.steps
      .filter((step) => step.plannerSource === "model")
      .map((step) => step.plannerSource ?? "");
    const graded = gradeLiveModelProvenance({
      approved,
      provenance: model.provenance,
      plannerSources,
      scriptedPlannerInjected: Boolean(task.planner),
    });
    return Object.freeze({
      trial,
      passed: graded.passed,
      ok: result.ok,
      stoppedReason: result.stoppedReason,
      promptTokens: model.promptTokens,
      completionTokens: model.completionTokens,
      totalTokens: model.totalTokens,
      costUsd: model.costUsd,
      latencyMs,
      timeouts: model.timeouts,
      filesChanged: Object.freeze([...result.filesChanged]),
      provenance: model.provenance,
      grades: graded.grades,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function trialSignature(trial: LiveEvalTrial): string {
  return JSON.stringify({
    passed: trial.passed,
    grades: trial.grades.map((candidate) => [candidate.id, candidate.passed]),
    models: trial.provenance.map((record) => record.model),
    hosts: trial.provenance.map((record) => record.host),
  });
}

/**
 * Run the Warden live-eligible scenario against the REAL configured endpoint.
 *
 * Refuses to run unless OPENAI_API_KEY and LLM_AGENT_URL are configured — a
 * live result is never faked. Enforces a hard USD budget (default 25, override
 * with MENDPOINT_LIVE_EVAL_MAX_USD) and aborts before the accumulated spend can
 * exceed it. The configured model id must equal the approved allowlist model
 * (MENDPOINT_LIVE_APPROVED_MODEL); an unapproved model fails closed before any
 * call. Provider 429s are backed off within bounded retries, never spinning.
 */
export async function runWardenLiveEval(
  options: RunWardenLiveEvalOptions = {},
): Promise<LiveEvalReport> {
  const env = process.env;
  if (!env.OPENAI_API_KEY || !env.LLM_AGENT_URL) {
    throw new Error("warden_live_eval_credentials_required");
  }
  const endpoint = resolveAgentModelEndpoint(env);
  if (!endpoint) throw new Error("warden_live_eval_credentials_required");
  const approvedModel = resolveApprovedLiveModel(env);
  // Allowlist gate: only the approved model may drive a live trial.
  if (resolveAgentModelName(env) !== approvedModel) {
    throw new Error("warden_model_not_approved");
  }
  const approved: LiveModelApprovedConfig = Object.freeze({
    host: new URL(endpoint).host,
    model: approvedModel,
  });
  const repetitions = boundedRepetitions(options.repetitions);
  const budgetUsd = resolveBudgetUsd(env);
  const maxSteps = options.maxSteps ?? 14;
  const now = options.now ?? Date.now;
  const maxRateLimitRetries = options.maxRateLimitRetries ??
    DEFAULT_LIVE_EVAL_RATE_LIMIT_RETRIES;
  const backoffBaseMs = options.rateLimitBackoffMs ??
    DEFAULT_LIVE_EVAL_RATE_LIMIT_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;

  const trials: LiveEvalTrial[] = [];
  let spentUsd = 0;
  for (let trial = 1; trial <= repetitions; trial++) {
    // Abort BEFORE exceeding the budget — never start a trial we cannot afford.
    if (spentUsd >= budgetUsd) {
      throw new Error("warden_live_eval_budget_exceeded");
    }
    let result = await runLiveTrial(trial, approved, maxSteps, now);
    for (let attempt = 0; result.stoppedReason === "model_rate_limited"; attempt++) {
      if (attempt >= maxRateLimitRetries) {
        throw new Error("warden_live_eval_rate_limited");
      }
      await sleep(Math.min(backoffBaseMs * 2 ** attempt, MAX_RATE_LIMIT_BACKOFF_MS));
      result = await runLiveTrial(trial, approved, maxSteps, now);
    }
    trials.push(result);
    spentUsd += result.costUsd;
  }

  const signatures = new Set(trials.map(trialSignature));
  const consistent = signatures.size <= 1;
  const totalTokens = trials.reduce((sum, trial) => sum + trial.totalTokens, 0);
  return Object.freeze({
    schemaVersion: 1,
    caseId: LIVE_EVAL_CASE_ID,
    lane: "live_model",
    approved,
    repetitions,
    passed: trials.length > 0 && trials.every((trial) => trial.passed) && consistent,
    consistent,
    budgetUsd,
    spentUsd,
    totalTokens,
    trials: Object.freeze(trials),
  });
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function printWardenReport(report: LiveEvalReport): void {
  const pad = (value: string, width: number) => value.padEnd(width).slice(0, width);
  console.log("");
  console.log(`Live model evidence lane — ${report.caseId}`);
  console.log(`Approved provider ${report.approved.host} model ${report.approved.model}`);
  console.log(`Budget ${report.budgetUsd.toFixed(4)} USD, spent ${report.spentUsd.toFixed(6)} USD`);
  console.log("");
  console.log(
    `${pad("TRIAL", 6)} ${pad("PASS", 5)} ${pad("TOKENS", 8)} ${pad("USD", 12)} ${pad("MS", 8)} ${pad("TIMEOUTS", 9)} STOP`,
  );
  console.log("-".repeat(80));
  for (const trial of report.trials) {
    console.log(
      `${pad(String(trial.trial), 6)} ${pad(trial.passed ? "yes" : "no", 5)} ${pad(String(trial.totalTokens), 8)} ${pad(trial.costUsd.toFixed(8), 12)} ${pad(String(trial.latencyMs), 8)} ${pad(String(trial.timeouts), 9)} ${trial.stoppedReason}`,
    );
    for (const candidate of trial.grades.filter((item) => !item.passed)) {
      console.log(`  ${candidate.id}: expected ${candidate.expected}, observed ${candidate.observed}`);
    }
  }
  console.log("-".repeat(80));
  console.log(`Consistent across repetitions ${report.consistent}`);
  console.log(`Live model evidence ${report.passed ? "verified" : "NOT verified"}`);
  console.log("");
}

function printTransformerReport(report: TransformerLiveEvalReport): void {
  const pad = (value: string, width: number) => value.padEnd(width).slice(0, width);
  console.log("");
  console.log(`Transformer live model evidence lane: ${report.caseId}`);
  console.log(`Budget ${report.budgetUsd.toFixed(4)} USD, spent ${report.spentUsd.toFixed(6)} USD`);
  console.log("");
  console.log(
    `${pad("TRIAL", 6)} ${pad("PASS", 5)} ${pad("TOKENS", 8)} ${pad("USD", 12)} ${pad("MS", 8)} MODEL`,
  );
  console.log("=".repeat(80));
  for (const trial of report.trials) {
    console.log(
      `${pad(String(trial.trial), 6)} ${pad(trial.passed ? "yes" : "no", 5)} ${pad(String(trial.totalTokens), 8)} ${pad(trial.costUsd.toFixed(8), 12)} ${pad(String(trial.latencyMs), 8)} ${trial.provider}/${trial.model}`,
    );
    for (const candidate of trial.grades.filter((item) => !item.passed)) {
      console.log(`  ${candidate.id}: expected ${candidate.expected}, observed ${candidate.observed}`);
    }
  }
  console.log("=".repeat(80));
  console.log(`Pass rate ${report.passRate.toFixed(3)}, consistency rate ${report.consistencyRate.toFixed(3)}`);
  console.log(`Transformer live model evidence ${report.passed ? "verified" : "NOT verified"}`);
  console.log("");
}

async function main(): Promise<void> {
  const repetitions = Number(option("repetitions") ?? "3");
  const product = option("product") ?? "all";
  if (!new Set(["all", "warden", "transformer"]).has(product)) {
    console.error("Live model eval refused: product must be all, warden, or transformer");
    process.exit(1);
    return;
  }
  try {
    let passed = true;
    if (product === "all" || product === "warden") {
      const report = await runWardenLiveEval({ repetitions });
      printWardenReport(report);
      passed = passed && report.passed;
    }
    if (product === "all" || product === "transformer") {
      const report = await runTransformerLiveEval({ repetitions });
      printTransformerReport(report);
      passed = passed && report.passed;
    }
    if (!passed) process.exit(1);
  } catch (error) {
    console.error(`Live model eval refused: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("agent-eval-live.ts") ||
  process.argv[1]?.replace(/\\/g, "/").endsWith("agent-eval-live.js");
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
