import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeModelCostUsd,
  resolveAgentModelEndpoint,
  resolveAgentModelName,
  runWarden,
  type AgentExternalModelAccounting,
  type AgentExternalModelReservation,
  type AgentExternalModelSettlement,
  type AgentRunResult,
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
export const DEFAULT_LIVE_EVAL_TRANSIENT_RETRIES = 2;
export const DEFAULT_LIVE_EVAL_TRANSIENT_BACKOFF_MS = 1_000;
const MAX_TRANSIENT_BACKOFF_MS = 10_000;

const LIVE_GOAL = "Repair the client path. The correct endpoint is /v1/charges.";
const LIVE_ERROR_LOG = "HTTP 404 for /v1/chargess, expected /v1/charges";
const VERIFY_COMMAND = "node check.mjs";
const ALLOWED_FILES = Object.freeze(["client.js"]);
const LIVE_TENANT_ID = "tenant_warden_live_eval";
const LIVE_MODEL_MAX_OUTPUT_TOKENS = 1_024;
const LIVE_TREE_MAX_ENTRIES = 32;
const LIVE_TREE_MAX_FILE_BYTES = 1024 * 1024;
const LIVE_TREE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const LIVE_TREE_MAX_DEPTH = 4;
const LIVE_OBJECTIVE_SOURCE = /^\s*export\s+const\s+chargePath\s*=\s*(['"])\/v1\/charges\1\s*;\s*$/;

function liveScenarioFiles(): Readonly<Record<string, string>> {
  return Object.freeze({
    "client.js": "export const chargePath = '/v1/chargess';\n",
    "check.mjs": [
      'import { readFileSync } from "node:fs";',
      'const source = readFileSync(new URL("./client.js", import.meta.url), "utf8");',
      'const valid = /^\\s*export\\s+const\\s+chargePath\\s*=\\s*([\'\"])\\/v1\\/charges\\1\\s*;\\s*$/.test(source);',
      'if (!valid) process.exit(1);',
      "",
    ].join("\n"),
  });
}

export type LiveEvalTrial = Readonly<{
  trial: number;
  passed: boolean;
  objectiveVerified: boolean;
  ok: boolean;
  stoppedReason: string;
  verifierStatus: AgentRunResult["verifier"]["status"];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  timeouts: number;
  filesChanged: readonly string[];
  trajectory: readonly Readonly<{
    step: number;
    tool: string;
    target: Readonly<{
      kind: "path" | "query" | "command";
      length: number;
      digest: string;
    }> | null;
    ok: boolean;
    resultCode: string;
    resultDigest: string;
    plannerSource: "model" | "heuristic" | "system" | null;
  }>[];
  provenance: readonly LiveModelProvenanceRecord[];
  grades: readonly LiveModelGrade[];
}>;

export type LiveEvalReport = Readonly<{
  schemaVersion: 2;
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
  /** Bounded retries for timeouts, connection failures, and retry safe HTTP statuses. */
  maxTransientRetries?: number;
  /** Base transient backoff (ms); doubles per retry, capped. */
  transientBackoffMs?: number;
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
  if (raw.trim() === "") throw new Error("warden_live_eval_budget_invalid");
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("warden_live_eval_budget_invalid");
  }
  return parsed;
}

function boundedRetryCount(
  value: number | undefined,
  fallback: number,
  errorCode: string,
): number {
  const count = value ?? fallback;
  if (!Number.isSafeInteger(count) || count < 0 || count > 10) {
    throw new Error(errorCode);
  }
  return count;
}

function boundedBackoffMs(
  value: number | undefined,
  fallback: number,
  maximum: number,
  errorCode: string,
): number {
  const delay = value ?? fallback;
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > maximum) {
    throw new Error(errorCode);
  }
  return delay;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

type LiveTreeSnapshot = Readonly<Record<string, string>>;

function snapshotLiveTree(root: string): LiveTreeSnapshot {
  const snapshot: Record<string, string> = {};
  let entries = 0;
  let totalBytes = 0;
  const visit = (relative: string, depth: number): void => {
    if (depth > LIVE_TREE_MAX_DEPTH) throw new Error("warden_live_eval_tree_depth_exceeded");
    const absolute = relative ? join(root, relative) : root;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      entries += 1;
      if (entries > LIVE_TREE_MAX_ENTRIES) {
        throw new Error("warden_live_eval_tree_entries_exceeded");
      }
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const target = join(root, ...path.split("/"));
      if (entry.isDirectory()) {
        snapshot[`${path}/`] = "directory";
        visit(path, depth + 1);
      } else if (entry.isFile()) {
        const size = statSync(target).size;
        if (size > LIVE_TREE_MAX_FILE_BYTES) {
          throw new Error("warden_live_eval_tree_file_bytes_exceeded");
        }
        totalBytes += size;
        if (totalBytes > LIVE_TREE_MAX_TOTAL_BYTES) {
          throw new Error("warden_live_eval_tree_total_bytes_exceeded");
        }
        snapshot[path] = `file:${createHash("sha256").update(readFileSync(target)).digest("hex")}`;
      } else if (entry.isSymbolicLink()) {
        snapshot[path] = `symlink:${sha256(readlinkSync(target))}`;
      } else {
        snapshot[path] = "other";
      }
    }
  };
  visit("", 0);
  return Object.freeze({ ...snapshot });
}

function liveObjectiveSourceValid(root: string): boolean {
  try {
    const source = readFileSync(join(root, "client.js"), "utf8");
    return Buffer.byteLength(source, "utf8") <= LIVE_TREE_MAX_FILE_BYTES &&
      LIVE_OBJECTIVE_SOURCE.test(source);
  } catch {
    return false;
  }
}

function changedTreePaths(before: LiveTreeSnapshot, after: LiveTreeSnapshot): readonly string[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Object.freeze([...paths]
    .filter((path) => before[path] !== after[path])
    .sort());
}

function safeTrajectoryResultCode(
  tool: string,
  ok: boolean,
  error: string | undefined,
): string {
  if (ok) return `${tool}_ok`;
  const safeError = new Set(["args", "ENOENT", "policy", "source_budget", "timeout"]);
  return safeError.has(error ?? "") ? `${tool}_${error}` : `${tool}_failed`;
}

type LiveReservation = Readonly<{
  value: AgentExternalModelReservation;
  worstCaseUsd: number;
  settlement?: AgentExternalModelSettlement;
}>;

class LiveEvalAccounting implements AgentExternalModelAccounting {
  readonly maximumCostUsd: number;
  private readonly reservations = new Map<string, LiveReservation>();
  private consumedUsd = 0;
  private readonly scopeSeed = randomUUID();
  private attempt = 0;

  constructor(
    private readonly approvedModel: string,
    private readonly approvedHost: string,
    maximumCostUsd: number,
  ) {
    this.maximumCostUsd = maximumCostUsd;
  }

  get executionScopeId(): string {
    return sha256(`${LIVE_EVAL_CASE_ID}\0${this.scopeSeed}\0${this.attempt}`);
  }

  beginAttempt(): void {
    this.attempt += 1;
  }

  spentUsd(): number {
    return this.consumedUsd;
  }

  private reservedUsd(): number {
    return [...this.reservations.values()]
      .filter((reservation) => !reservation.settlement)
      .reduce((sum, reservation) => sum + reservation.worstCaseUsd, 0);
  }

  async reserve(value: AgentExternalModelReservation): Promise<void> {
    const prior = this.reservations.get(value.reservationId);
    if (prior) {
      if (JSON.stringify(prior.value) !== JSON.stringify(value)) {
        throw new Error("warden_live_eval_reservation_conflict");
      }
      return;
    }
    if (
      value.configuredModel !== this.approvedModel ||
      value.endpointHost !== this.approvedHost
    ) {
      throw new Error("warden_live_eval_reservation_identity_mismatch");
    }
    const worstCaseUsd = computeModelCostUsd(
      value.configuredModel,
      value.maximumInputTokens,
      value.maximumOutputTokens,
    );
    if (worstCaseUsd === null) throw new Error("warden_live_eval_model_unpriced");
    if (this.consumedUsd + this.reservedUsd() + worstCaseUsd > this.maximumCostUsd) {
      throw new Error("warden_live_eval_budget_exceeded");
    }
    this.reservations.set(value.reservationId, Object.freeze({ value, worstCaseUsd }));
  }

  async settle(value: AgentExternalModelSettlement): Promise<void> {
    const reservation = this.reservations.get(value.reservationId);
    if (!reservation) throw new Error("warden_live_eval_settlement_without_reservation");
    if (reservation.settlement) {
      if (JSON.stringify(reservation.settlement) !== JSON.stringify(value)) {
        throw new Error("warden_live_eval_settlement_conflict");
      }
      return;
    }
    const measured = value.status === "succeeded" &&
      Number.isSafeInteger(value.inputTokens) && value.inputTokens! > 0 &&
      Number.isSafeInteger(value.outputTokens) && value.outputTokens! > 0 &&
      Number.isSafeInteger(value.totalTokens) &&
      value.totalTokens === value.inputTokens! + value.outputTokens! &&
      typeof value.costUsd === "number" &&
      Number.isFinite(value.costUsd) && value.costUsd > 0;
    const chargedUsd = measured ? value.costUsd! : reservation.worstCaseUsd;
    if (chargedUsd > reservation.worstCaseUsd) {
      throw new Error("warden_live_eval_call_cost_exceeded");
    }
    const nextConsumed = this.consumedUsd + chargedUsd;
    if (nextConsumed > this.maximumCostUsd) {
      throw new Error("warden_live_eval_budget_exceeded");
    }
    this.consumedUsd = nextConsumed;
    this.reservations.set(value.reservationId, Object.freeze({
      ...reservation,
      settlement: Object.freeze({ ...value }),
    }));
  }
}

function objectiveGrade(
  id: string,
  passed: boolean,
  expected: unknown,
  observed: unknown,
): LiveModelGrade {
  const render = (value: unknown) =>
    typeof value === "string" ? value : JSON.stringify(value);
  return Object.freeze({ id, passed, expected: render(expected), observed: render(observed) });
}

function wardenObjectiveGrades(
  result: AgentRunResult,
  before: LiveTreeSnapshot,
  after: LiveTreeSnapshot,
  actualChangedFiles: readonly string[],
  hiddenSemanticJudgePassed: boolean,
): readonly LiveModelGrade[] {
  const recordedChangedFiles = [...result.filesChanged].sort();
  const changedFiles = [...actualChangedFiles].sort();
  const expectedFiles = [...ALLOWED_FILES].sort();
  return Object.freeze([
    objectiveGrade("objective.completed", result.ok, true, result.ok),
    objectiveGrade(
      "objective.verifier_passed",
      result.verifier.status === "passed",
      "passed",
      result.verifier.status,
    ),
    objectiveGrade(
      "objective.stop_reason",
      result.stoppedReason === "verify_passed" || result.stoppedReason === "finish_verified",
      ["verify_passed", "finish_verified"],
      result.stoppedReason,
    ),
    objectiveGrade(
      "objective.exact_allowed_files",
      JSON.stringify(changedFiles) === JSON.stringify(expectedFiles),
      expectedFiles,
      changedFiles,
    ),
    objectiveGrade(
      "objective.tool_ledger_matches_tree",
      JSON.stringify(recordedChangedFiles) === JSON.stringify(changedFiles),
      changedFiles,
      recordedChangedFiles,
    ),
    objectiveGrade(
      "objective.verifier_immutable",
      before["check.mjs"] === after["check.mjs"],
      before["check.mjs"],
      after["check.mjs"],
    ),
    objectiveGrade(
      "objective.hidden_semantic_judge",
      hiddenSemanticJudgePassed,
      true,
      hiddenSemanticJudgePassed,
    ),
    objectiveGrade(
      "objective.no_rollback",
      result.rollback.performed === false && result.rollback.failedFiles.length === 0,
      { performed: false, failedFiles: [] },
      result.rollback,
    ),
  ]);
}

async function runLiveTrial(
  trial: number,
  approved: LiveModelApprovedConfig,
  endpoint: string,
  accounting: AgentExternalModelAccounting,
  maxSteps: number,
  now: () => number,
): Promise<LiveEvalTrial> {
  const root = mkdtempSync(join(tmpdir(), `mendpoint-warden-live-${trial}-`));
  try {
    for (const [path, content] of Object.entries(liveScenarioFiles())) {
      writeFileSync(join(root, path), content, { encoding: "utf8", flag: "wx" });
    }
    const initialTree = snapshotLiveTree(root);
    const modelSourcePolicy = Object.freeze({
      approved: true,
      tenantId: LIVE_TENANT_ID,
      policyDigest: sha256(JSON.stringify({
        schemaVersion: 1,
        caseId: LIVE_EVAL_CASE_ID,
        source: "compiled_synthetic_fixture_only",
        tenantId: LIVE_TENANT_ID,
        provider: approved.host,
        model: approved.model,
        endpoint,
      })),
      provider: approved.host,
      model: approved.model,
      endpoint,
    });
    // The only source authorized for this live lane is the compiled synthetic
    // fixture above. No workspace or customer repository is read.
    const task: AgentTask = {
      goal: LIVE_GOAL,
      errorLog: LIVE_ERROR_LOG,
      tenantId: LIVE_TENANT_ID,
      repoRoot: root,
      verifyCommand: VERIFY_COMMAND,
      maxSteps,
      useLlm: true,
      allowNetwork: false,
      allowModelSource: true,
      modelSourcePolicy,
      externalModelAccounting: accounting,
      modelBudget: {
        maxCalls: maxSteps,
        requestTimeoutMs: 30_000,
        maxResponseBytes: 32_768,
        maxOutputTokens: LIVE_MODEL_MAX_OUTPUT_TOKENS,
      },
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
    const finalTree = snapshotLiveTree(root);
    const actualChangedFiles = changedTreePaths(initialTree, finalTree);
    const hiddenSemanticJudgePassed = liveObjectiveSourceValid(root);
    const objectiveGrades = wardenObjectiveGrades(
      result,
      initialTree,
      finalTree,
      actualChangedFiles,
      hiddenSemanticJudgePassed,
    );
    const objectiveVerified = objectiveGrades.every((candidate) => candidate.passed);
    return Object.freeze({
      trial,
      passed: graded.passed && objectiveVerified,
      objectiveVerified,
      ok: result.ok,
      stoppedReason: result.stoppedReason,
      verifierStatus: result.verifier.status,
      promptTokens: model.promptTokens,
      completionTokens: model.completionTokens,
      totalTokens: model.totalTokens,
      costUsd: model.costUsd,
      latencyMs,
      timeouts: model.timeouts,
      filesChanged: actualChangedFiles,
      trajectory: Object.freeze(result.steps.map((step) => Object.freeze({
        step: step.step,
        tool: step.call.tool,
        target: (() => {
          const candidates = [
            ["path", step.call.args.path],
            ["query", step.call.args.query],
            ["command", step.call.args.command],
          ] as const;
          const candidate = candidates.find(([, value]) => typeof value === "string");
          if (!candidate || typeof candidate[1] !== "string") return null;
          return Object.freeze({
            kind: candidate[0],
            length: candidate[1].length,
            digest: sha256(candidate[1]),
          });
        })(),
        ok: step.result.ok,
        resultCode: safeTrajectoryResultCode(
          step.call.tool,
          step.result.ok,
          step.result.error,
        ),
        resultDigest: sha256(step.result.summary),
        plannerSource: step.plannerSource ?? null,
      }))),
      provenance: model.provenance,
      grades: Object.freeze([...graded.grades, ...objectiveGrades]),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function trialSignature(trial: LiveEvalTrial): string {
  return JSON.stringify({
    passed: trial.passed,
    objectiveVerified: trial.objectiveVerified,
    ok: trial.ok,
    verifierStatus: trial.verifierStatus,
    stoppedReason: trial.stoppedReason,
    filesChanged: [...trial.filesChanged].sort(),
    failedGrades: trial.grades.filter((candidate) => !candidate.passed).map((candidate) => candidate.id),
    models: [...new Set(trial.provenance.map((record) => record.model))].sort(),
    hosts: [...new Set(trial.provenance.map((record) => record.host))].sort(),
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
 * call. Provider rate limits and typed transient delivery failures are backed
 * off within bounded retries, never spinning.
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
  const maxRateLimitRetries = boundedRetryCount(
    options.maxRateLimitRetries,
    DEFAULT_LIVE_EVAL_RATE_LIMIT_RETRIES,
    "warden_live_eval_rate_limit_retries_invalid",
  );
  const backoffBaseMs = boundedBackoffMs(
    options.rateLimitBackoffMs,
    DEFAULT_LIVE_EVAL_RATE_LIMIT_BACKOFF_MS,
    MAX_RATE_LIMIT_BACKOFF_MS,
    "warden_live_eval_rate_limit_backoff_invalid",
  );
  const sleep = options.sleep ?? defaultSleep;
  const maxTransientRetries = boundedRetryCount(
    options.maxTransientRetries,
    DEFAULT_LIVE_EVAL_TRANSIENT_RETRIES,
    "warden_live_eval_transient_retries_invalid",
  );
  const transientBackoffBaseMs = boundedBackoffMs(
    options.transientBackoffMs,
    DEFAULT_LIVE_EVAL_TRANSIENT_BACKOFF_MS,
    MAX_TRANSIENT_BACKOFF_MS,
    "warden_live_eval_transient_backoff_invalid",
  );
  if (budgetUsd <= 0) throw new Error("warden_live_eval_budget_exceeded");
  const accounting = new LiveEvalAccounting(approved.model, approved.host, budgetUsd);

  const trials: LiveEvalTrial[] = [];
  for (let trial = 1; trial <= repetitions; trial++) {
    const trialStartedUsd = accounting.spentUsd();
    const attempts: LiveEvalTrial[] = [];
    accounting.beginAttempt();
    let result = await runLiveTrial(trial, approved, endpoint, accounting, maxSteps, now);
    attempts.push(result);
    let rateLimitRetries = 0;
    let transientRetries = 0;
    while (true) {
      const rateLimited = result.stoppedReason === "model_rate_limited";
      const transient = result.stoppedReason === "model_http_transient_error" ||
        result.stoppedReason === "model_request_failed" ||
        result.stoppedReason === "model_request_timeout";
      if (!rateLimited && !transient) break;
      if (rateLimited && rateLimitRetries >= maxRateLimitRetries) {
        throw new Error("warden_live_eval_rate_limited");
      }
      if (transient && transientRetries >= maxTransientRetries) break;
      const retryNumber = rateLimited ? rateLimitRetries++ : transientRetries++;
      const baseMs = rateLimited ? backoffBaseMs : transientBackoffBaseMs;
      const capMs = rateLimited ? MAX_RATE_LIMIT_BACKOFF_MS : MAX_TRANSIENT_BACKOFF_MS;
      await sleep(Math.min(baseMs * 2 ** retryNumber, capMs));
      accounting.beginAttempt();
      result = await runLiveTrial(trial, approved, endpoint, accounting, maxSteps, now);
      attempts.push(result);
    }
    const priorAttemptsWithProvenance = attempts.slice(0, -1)
      .filter((attempt) => attempt.provenance.length > 0);
    const retryProvenanceValid = priorAttemptsWithProvenance.every((attempt) =>
      attempt.grades
        .filter((grade) => !grade.id.startsWith("objective."))
        .every((grade) => grade.passed)
    );
    const retryGrade = objectiveGrade(
      "retry.provenance_valid",
      retryProvenanceValid,
      true,
      retryProvenanceValid,
    );
    const combined = Object.freeze({
      ...result,
      passed: result.passed && retryGrade.passed,
      promptTokens: attempts.reduce((sum, attempt) => sum + attempt.promptTokens, 0),
      completionTokens: attempts.reduce((sum, attempt) => sum + attempt.completionTokens, 0),
      totalTokens: attempts.reduce((sum, attempt) => sum + attempt.totalTokens, 0),
      costUsd: accounting.spentUsd() - trialStartedUsd,
      latencyMs: attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0),
      timeouts: attempts.reduce((sum, attempt) => sum + attempt.timeouts, 0),
      provenance: Object.freeze(attempts.flatMap((attempt) => attempt.provenance)),
      trajectory: Object.freeze(attempts.flatMap((attempt) => attempt.trajectory)),
      grades: Object.freeze([...result.grades, retryGrade]),
    });
    trials.push(combined);
  }

  const spentUsd = accounting.spentUsd();
  const signatures = new Set(trials.map(trialSignature));
  const consistent = signatures.size <= 1;
  const totalTokens = trials.reduce((sum, trial) => sum + trial.totalTokens, 0);
  return Object.freeze({
    schemaVersion: 2,
    caseId: LIVE_EVAL_CASE_ID,
    lane: "live_model",
    approved,
    repetitions,
    passed: trials.length > 0 && trials.every((trial) => trial.passed) && consistent &&
      spentUsd <= budgetUsd,
    consistent,
    budgetUsd,
    spentUsd,
    totalTokens,
    trials: Object.freeze(trials),
  });
}

export function parseLiveEvalOption(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const assigned = args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
  if (assigned !== undefined) return assigned;
  const index = args.indexOf(`--${name}`);
  const next = index >= 0 ? args[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : undefined;
}

function option(name: string): string | undefined {
  return parseLiveEvalOption(process.argv, name);
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
    if (!trial.passed) {
      for (const step of trial.trajectory) {
        const target = step.target
          ? ` ${step.target.kind}:${step.target.length}:${step.target.digest}`
          : "";
        console.log(`  step ${step.step} ${step.plannerSource ?? "unknown"} ${step.tool}${target} ${step.ok ? "ok" : "fail"} ${step.resultCode} ${step.resultDigest}`);
      }
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
    `${pad("TRIAL", 6)} ${pad("PASS", 5)} ${pad("TOKENS", 8)} ${pad("MEASURED", 12)} ${pad("CHARGED", 12)} ${pad("MS", 8)} MODEL`,
  );
  console.log("=".repeat(80));
  for (const trial of report.trials) {
    console.log(
      `${pad(String(trial.trial), 6)} ${pad(trial.passed ? "yes" : "no", 5)} ${pad(String(trial.totalTokens), 8)} ${pad(trial.costUsd.toFixed(8), 12)} ${pad(trial.accountedCostUsd.toFixed(8), 12)} ${pad(String(trial.latencyMs), 8)} ${trial.provider}/${trial.model}`,
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
