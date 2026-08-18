import { createHash } from "node:crypto";
import {
  buildVerifierCalibrationReport,
  createVerifierEvidencePack,
  type AgentVerifier,
  type VerifierCalibrationObservation,
  type VerifierCalibrationReport,
  type VerifierEvidencePackInput,
} from "@mendpoint/verifier";

export type MuseDeepSeekBenchmarkTask = Readonly<{
  taskId: string;
  family: "fettler" | "regauge";
  difficulty: "easy" | "medium" | "hard" | "critical";
  split: "holdout";
  cohortRevision: string;
  cohortDigest: string;
  pack: VerifierEvidencePackInput;
  correctByCandidateId: Readonly<Record<string, boolean>>;
  generationUsageByCandidateId: Readonly<Record<string, Readonly<{ tokens: number; costUsd: number; latencyMs: number }>>>;
}>;

type ArmMetrics = Readonly<{
  successes: number;
  total: number;
  rate: number;
  absoluteLift: number;
  relativeLift: number | null;
  selectionAccuracy: number;
  misrankingRate: number;
  falseConfidenceRate: number;
  caughtMuseErrors: number;
  introducedErrors: number;
  generationTokens: number;
  verificationTokens: number;
  totalCostUsd: number;
  latencyMs: number;
  incrementalCostPerAdditionalSuccessUsd: number | null;
}>;

export type MuseDeepSeekBenchmarkRow = Readonly<{
  candidateCount: number;
  musePassAt1: ArmMetrics;
  museSelfSelected: ArmMetrics;
  deepSeekSelected: ArmMetrics;
  oracle: ArmMetrics;
}>;

export type MuseDeepSeekBenchmarkReport = Readonly<{
  schemaVersion: "2026-08-17.muse-deepseek-benchmark.v1";
  runId: string;
  observedAt: string;
  cohortDigest: string;
  taskCount: number;
  rows: readonly MuseDeepSeekBenchmarkRow[];
  deepSeekCalibration: VerifierCalibrationReport;
  reportDigest: string;
}>;

type MutableArm = {
  successes: number;
  oraclePossible: number;
  falseConfidence: number;
  caughtMuseErrors: number;
  introducedErrors: number;
  generationTokens: number;
  verificationTokens: number;
  totalCostUsd: number;
  latencyMs: number;
};

export async function runMuseDeepSeekVerifierBenchmark(input: Readonly<{
  tasks: readonly MuseDeepSeekBenchmarkTask[];
  candidateCounts: readonly number[];
  museSelfVerifier: AgentVerifier;
  deepSeekVerifier: AgentVerifier;
  runId: string;
  observedAt: string;
}>): Promise<MuseDeepSeekBenchmarkReport> {
  if (!input.tasks.length || input.tasks.length > 10_000) fail("verifier_benchmark_tasks_invalid");
  const candidateCounts = uniqueCounts(input.candidateCounts);
  const runId = identifier(input.runId, "verifier_benchmark_run_id_invalid");
  const observedAt = exactIso(input.observedAt, "verifier_benchmark_observed_at_invalid");
  const calibration: VerifierCalibrationObservation[] = [];
  const rows: MuseDeepSeekBenchmarkRow[] = [];
  const cohortDigests = new Set<string>();

  for (const task of input.tasks) validateTask(task, cohortDigests);
  const cohortDigest = sha256([...cohortDigests].sort(compareText).join("\0"));

  for (const candidateCount of candidateCounts) {
    const baseline = emptyArm();
    const self = emptyArm();
    const deep = emptyArm();
    const oracle = emptyArm();
    for (const task of input.tasks) {
      const candidates = task.pack.candidates.slice(0, candidateCount);
      if (!candidates.length) fail("verifier_benchmark_candidates_missing");
      const ids = new Set(candidates.map(({ candidateId }) => candidateId));
      const checks = task.pack.checks.filter((check) => check.candidateIds === null || check.candidateIds.some((candidateId) => ids.has(candidateId)))
        .map((check) => ({ ...check, candidateIds: check.candidateIds === null ? null : check.candidateIds.filter((candidateId) => ids.has(candidateId)) }));
      const pack = createVerifierEvidencePack({ ...structuredClone(task.pack), candidates: structuredClone(candidates), checks: structuredClone(checks) });
      const incumbentId = candidates[0]!.candidateId;
      const baselineCorrect = outcome(task, incumbentId);
      const oracleCorrect = candidates.some(({ candidateId }) => outcome(task, candidateId));
      const generation = candidates.reduce((total, { candidateId }) => {
        const usage = task.generationUsageByCandidateId[candidateId];
        if (!usage) fail("verifier_benchmark_generation_usage_missing");
        return { tokens: total.tokens + finite(usage.tokens), cost: total.cost + finite(usage.costUsd), latency: total.latency + finite(usage.latencyMs) };
      }, { tokens: 0, cost: 0, latency: 0 });
      addOutcome(baseline, baselineCorrect, oracleCorrect, baselineCorrect, 0, generation, { tokens: 0, cost: 0, latency: 0 });
      addOutcome(oracle, oracleCorrect, oracleCorrect, baselineCorrect, 1, generation, { tokens: 0, cost: 0, latency: 0 });

      const request = { pack, incumbentCandidateId: incumbentId, observedAt, } as const;
      const selfResult = await input.museSelfVerifier.verify({ ...request, verificationAttemptId: `${runId}:${task.taskId}:n${candidateCount}:self` });
      const deepResult = await input.deepSeekVerifier.verify({ ...request, verificationAttemptId: `${runId}:${task.taskId}:n${candidateCount}:deepseek` });
      const selfId = selfResult.suggestedCandidateId ?? incumbentId;
      const deepId = deepResult.suggestedCandidateId ?? incumbentId;
      const selfCorrect = outcome(task, selfId);
      const deepCorrect = outcome(task, deepId);
      const selfScore = selfResult.telemetry.candidateScores[selfId] ?? 0;
      const deepScore = deepResult.telemetry.candidateScores[deepId] ?? 0;
      addOutcome(self, selfCorrect, oracleCorrect, baselineCorrect, selfScore, generation, verifierUsage(selfResult));
      addOutcome(deep, deepCorrect, oracleCorrect, baselineCorrect, deepScore, generation, verifierUsage(deepResult));
      calibration.push({
        observationId: `${task.taskId}:n${candidateCount}`,
        product: task.family,
        taskFamily: task.family,
        score: deepScore,
        correct: deepCorrect,
      });
    }
    const baselineMetrics = metrics(baseline, input.tasks.length, 0, 0);
    rows.push(Object.freeze({
      candidateCount,
      musePassAt1: baselineMetrics,
      museSelfSelected: metrics(self, input.tasks.length, baseline.successes, baseline.totalCostUsd),
      deepSeekSelected: metrics(deep, input.tasks.length, baseline.successes, baseline.totalCostUsd),
      oracle: metrics(oracle, input.tasks.length, baseline.successes, baseline.totalCostUsd),
    }));
  }
  const base = {
    schemaVersion: "2026-08-17.muse-deepseek-benchmark.v1" as const,
    runId,
    observedAt,
    cohortDigest,
    taskCount: input.tasks.length,
    rows: Object.freeze(rows),
    deepSeekCalibration: buildVerifierCalibrationReport(calibration),
  };
  return deepFreeze({ ...base, reportDigest: sha256(canonicalJson(base)) });
}

export function renderMuseDeepSeekBenchmarkMarkdown(report: MuseDeepSeekBenchmarkReport): string {
  const lines = [
    "# Muse 1.2 and DeepSeek V4 Flash verifier benchmark",
    "",
    `Run: ${report.runId}`,
    `Holdout tasks: ${report.taskCount}`,
    `Cohort digest: ${report.cohortDigest}`,
    "",
    "| N | Muse Pass@1 | Muse self selected | DeepSeek selected | Oracle | Cost per additional successful task |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.rows.map((row) => `| ${row.candidateCount} | ${percent(row.musePassAt1.rate)} | ${percent(row.museSelfSelected.rate)} | ${percent(row.deepSeekSelected.rate)} | ${percent(row.oracle.rate)} | ${money(row.deepSeekSelected.incrementalCostPerAdditionalSuccessUsd)} |`),
    "",
    `DeepSeek calibration Brier score: ${report.deepSeekCalibration.brierScore.toFixed(4)}`,
    `DeepSeek expected calibration error: ${report.deepSeekCalibration.expectedCalibrationError.toFixed(4)}`,
    `Report digest: ${report.reportDigest}`,
    "",
    "The benchmark contains observable outputs and sealed grader outcomes only. Private model reasoning is not captured.",
  ];
  return `${lines.join("\n")}\n`;
}

function validateTask(task: MuseDeepSeekBenchmarkTask, cohortDigests: Set<string>): void {
  if (task.split !== "holdout") fail("verifier_benchmark_holdout_required");
  if (!/^[a-f0-9]{40}$/.test(task.cohortRevision) || !/^sha256:[a-f0-9]{64}$/.test(task.cohortDigest)) fail("verifier_benchmark_cohort_invalid");
  if (task.taskId !== task.pack.taskId || task.family !== task.pack.product) fail("verifier_benchmark_task_binding_invalid");
  const candidateIds = task.pack.candidates.map(({ candidateId }) => candidateId);
  if (candidateIds.some((candidateId) => typeof task.correctByCandidateId[candidateId] !== "boolean")) fail("verifier_benchmark_outcome_missing");
  const answerPattern = candidateIds.map(escapeRegExp).join("|");
  if (answerPattern && task.pack.sources.some(({ content }) => new RegExp(`(?:correct|winner|answer)[^\\n]{0,64}(?:${answerPattern})|(?:${answerPattern})[^\\n]{0,64}(?:correct|winner|answer)`, "i").test(content))) {
    fail("verifier_benchmark_answer_key_leak");
  }
  cohortDigests.add(`${task.cohortRevision}:${task.cohortDigest}`);
}

function addOutcome(arm: MutableArm, correct: boolean, oraclePossible: boolean, baselineCorrect: boolean, confidence: number, generation: { tokens: number; cost: number; latency: number }, verification: { tokens: number; cost: number; latency: number }): void {
  if (correct) arm.successes++;
  if (oraclePossible) arm.oraclePossible++;
  if (!correct && confidence >= 0.8) arm.falseConfidence++;
  if (!baselineCorrect && correct) arm.caughtMuseErrors++;
  if (baselineCorrect && !correct) arm.introducedErrors++;
  arm.generationTokens += generation.tokens;
  arm.verificationTokens += verification.tokens;
  arm.totalCostUsd += generation.cost + verification.cost;
  arm.latencyMs += generation.latency + verification.latency;
}

function metrics(arm: MutableArm, total: number, baselineSuccesses: number, baselineCost: number): ArmMetrics {
  const rate = arm.successes / total;
  const baselineRate = baselineSuccesses / total;
  const added = arm.successes - baselineSuccesses;
  return Object.freeze({
    successes: arm.successes,
    total,
    rate,
    absoluteLift: rate - baselineRate,
    relativeLift: baselineRate > 0 ? (rate - baselineRate) / baselineRate : rate > 0 ? 1 : null,
    selectionAccuracy: arm.oraclePossible ? arm.successes / arm.oraclePossible : 0,
    misrankingRate: arm.oraclePossible ? (arm.oraclePossible - arm.successes) / arm.oraclePossible : 0,
    falseConfidenceRate: arm.falseConfidence / total,
    caughtMuseErrors: arm.caughtMuseErrors,
    introducedErrors: arm.introducedErrors,
    generationTokens: arm.generationTokens,
    verificationTokens: arm.verificationTokens,
    totalCostUsd: arm.totalCostUsd,
    latencyMs: arm.latencyMs,
    incrementalCostPerAdditionalSuccessUsd: added > 0 ? (arm.totalCostUsd - baselineCost) / added : null,
  });
}

function verifierUsage(result: Awaited<ReturnType<AgentVerifier["verify"]>>): { tokens: number; cost: number; latency: number } {
  return { tokens: result.telemetry.usage.totalTokens, cost: result.telemetry.estimatedCostUsd, latency: result.telemetry.latencyMs };
}
function outcome(task: MuseDeepSeekBenchmarkTask, candidateId: string): boolean { const value = task.correctByCandidateId[candidateId]; if (typeof value !== "boolean") fail("verifier_benchmark_outcome_missing"); return value; }
function emptyArm(): MutableArm { return { successes: 0, oraclePossible: 0, falseConfidence: 0, caughtMuseErrors: 0, introducedErrors: 0, generationTokens: 0, verificationTokens: 0, totalCostUsd: 0, latencyMs: 0 }; }
function uniqueCounts(values: readonly number[]): readonly number[] { if (!values.length || values.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 5) || new Set(values).size !== values.length) fail("verifier_benchmark_candidate_counts_invalid"); return Object.freeze([...values].sort((a, b) => a - b)); }
function exactIso(value: string, code: string): string { const time = Date.parse(value); if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail(code); return value; }
function identifier(value: string, code: string): string { if (!/^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/.test(value)) fail(code); return value; }
function finite(value: number): number { if (!Number.isFinite(value) || value < 0) fail("verifier_benchmark_usage_invalid"); return value; }
function percent(value: number): string { return `${(value * 100).toFixed(1)}%`; }
function money(value: number | null): string { return value === null ? "n/a" : `$${value.toFixed(4)}`; }
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function sha256(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function canonicalJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const object = value as Record<string, unknown>; return `{${Object.keys(object).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
function fail(code: string): never { throw new Error(code); }
