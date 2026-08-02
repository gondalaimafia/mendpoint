import { createHash } from "node:crypto";

export const AGENT_EVAL_VERSION = "2026-08-01.v2" as const;

export type AgentEvalProduct = "warden" | "transformer";
export type AgentEvalTier = "common" | "edge" | "adversarial" | "recovery";
export type AgentEvalDisposition = "passed" | "safe_handoff" | "failed";

export type AgentEvalBudget = Readonly<{
  maxDurationMs: number;
  maxSteps?: number;
  maxChangedFiles?: number;
  maxChangedBytes?: number;
  maxEvidenceBytes?: number;
}>;

export type AgentEvalMetrics = Readonly<{
  durationMs: number;
  steps: number;
  changedFiles: number;
  changedBytes: number;
  evidenceBytes: number;
}>;

export type AgentEvalGrade = Readonly<{
  id: string;
  critical: boolean;
  passed: boolean;
  expected: string;
  observed: string;
}>;

export type AgentEvalObservation = Readonly<{
  disposition: AgentEvalDisposition;
  semanticDigest: string;
  metrics: AgentEvalMetrics;
  details: Readonly<Record<string, unknown>>;
}>;

export type AgentEvalTrial = Readonly<{
  trial: number;
  passed: boolean;
  observation: AgentEvalObservation;
  grades: readonly AgentEvalGrade[];
}>;

export type AgentEvalScenario = Readonly<{
  id: string;
  product: AgentEvalProduct;
  family: string;
  tier: AgentEvalTier;
  critical: boolean;
  sourceRefs: readonly string[];
  budget: AgentEvalBudget;
  deterministic: boolean;
  run(trial: number): Promise<Readonly<{
    observation: AgentEvalObservation;
    grades: readonly AgentEvalGrade[];
  }>>;
}>;

export type AgentEvalScenarioResult = Readonly<{
  id: string;
  product: AgentEvalProduct;
  family: string;
  tier: AgentEvalTier;
  critical: boolean;
  sourceRefs: readonly string[];
  trials: readonly AgentEvalTrial[];
  passAtOne: boolean;
  passAtK: boolean;
  passToK: boolean;
  deterministic: boolean;
  passed: boolean;
}>;

export type AgentEvalReport = Readonly<{
  schemaVersion: 1;
  corpusVersion: typeof AGENT_EVAL_VERSION;
  repetitions: number;
  generatedAt: string;
  passed: boolean;
  scenarioCount: number;
  trialCount: number;
  criticalFailures: readonly string[];
  deterministicFailures: readonly string[];
  passAtOne: number;
  passAtK: number;
  passToK: number;
  durationMs: Readonly<{ p50: number; p95: number; total: number }>;
  byProduct: Readonly<Record<AgentEvalProduct, Readonly<{
    passed: number;
    total: number;
  }>>>;
  scenarios: readonly AgentEvalScenarioResult[];
}>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function agentEvalDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex")}`;
}

export function evalGrade(input: Readonly<{
  id: string;
  critical?: boolean;
  passed: boolean;
  expected: unknown;
  observed: unknown;
}>): AgentEvalGrade {
  const render = (value: unknown) =>
    typeof value === "string" ? value : JSON.stringify(stableValue(value));
  return Object.freeze({
    id: input.id,
    critical: input.critical ?? false,
    passed: input.passed,
    expected: render(input.expected),
    observed: render(input.observed),
  });
}

function budgetGrades(
  budget: AgentEvalBudget,
  metrics: AgentEvalMetrics,
): AgentEvalGrade[] {
  const grades = [
    evalGrade({
      id: "budget.duration",
      passed: metrics.durationMs <= budget.maxDurationMs,
      expected: `at most ${budget.maxDurationMs}`,
      observed: metrics.durationMs,
    }),
  ];
  const optional: Array<readonly [keyof AgentEvalMetrics, number | undefined, string]> = [
    ["steps", budget.maxSteps, "budget.steps"],
    ["changedFiles", budget.maxChangedFiles, "budget.changed_files"],
    ["changedBytes", budget.maxChangedBytes, "budget.changed_bytes"],
    ["evidenceBytes", budget.maxEvidenceBytes, "budget.evidence_bytes"],
  ];
  for (const [metric, limit, id] of optional) {
    if (limit === undefined) continue;
    grades.push(evalGrade({
      id,
      passed: metrics[metric] <= limit,
      expected: `at most ${limit}`,
      observed: metrics[metric],
    }));
  }
  return grades;
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentileValue * ordered.length));
  return ordered[rank - 1]!;
}

function boundedRepetitions(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new Error("Agent eval repetitions must be an integer from 1 to 10");
  }
  return value;
}

export async function runAgentEvalScenarios(
  scenarios: readonly AgentEvalScenario[],
  repetitions = 3,
  now: () => Date = () => new Date(),
): Promise<AgentEvalReport> {
  const trialCount = boundedRepetitions(repetitions);
  const ids = new Set<string>();
  const results: AgentEvalScenarioResult[] = [];

  for (const scenario of scenarios) {
    if (!scenario.id.trim() || ids.has(scenario.id)) {
      throw new Error(`Agent eval scenario id is missing or duplicated: ${scenario.id}`);
    }
    if (!scenario.sourceRefs.length || scenario.sourceRefs.some((source) => !source.trim())) {
      throw new Error(`Agent eval scenario has no source reference: ${scenario.id}`);
    }
    ids.add(scenario.id);
    const trials: AgentEvalTrial[] = [];
    for (let trial = 1; trial <= trialCount; trial++) {
      const result = await scenario.run(trial);
      const grades = Object.freeze([
        ...result.grades,
        ...budgetGrades(scenario.budget, result.observation.metrics),
      ]);
      trials.push(Object.freeze({
        trial,
        passed: grades.every((grade) => grade.passed),
        observation: result.observation,
        grades,
      }));
    }
    const deterministic = !scenario.deterministic ||
      new Set(trials.map((trial) => trial.observation.semanticDigest)).size === 1;
    const passAtOne = trials[0]!.passed;
    const passAtK = trials.some((trial) => trial.passed);
    const passToK = trials.every((trial) => trial.passed);
    results.push(Object.freeze({
      id: scenario.id,
      product: scenario.product,
      family: scenario.family,
      tier: scenario.tier,
      critical: scenario.critical,
      sourceRefs: scenario.sourceRefs,
      trials: Object.freeze(trials),
      passAtOne,
      passAtK,
      passToK,
      deterministic,
      passed: passToK && deterministic,
    }));
  }

  const criticalFailures = results
    .filter((scenario) => scenario.critical && !scenario.passed)
    .map((scenario) => scenario.id);
  const deterministicFailures = results
    .filter((scenario) => !scenario.deterministic)
    .map((scenario) => scenario.id);
  const durations = results.flatMap((scenario) =>
    scenario.trials.map((trial) => trial.observation.metrics.durationMs),
  );
  const countRate = (select: (result: AgentEvalScenarioResult) => boolean) =>
    results.length ? results.filter(select).length / results.length : 0;
  const byProduct = (product: AgentEvalProduct) => {
    const matching = results.filter((result) => result.product === product);
    return Object.freeze({
      passed: matching.filter((result) => result.passed).length,
      total: matching.length,
    });
  };
  return Object.freeze({
    schemaVersion: 1,
    corpusVersion: AGENT_EVAL_VERSION,
    repetitions: trialCount,
    generatedAt: now().toISOString(),
    passed: results.length > 0 && results.every((result) => result.passed) &&
      criticalFailures.length === 0 && deterministicFailures.length === 0,
    scenarioCount: results.length,
    trialCount: results.length * trialCount,
    criticalFailures: Object.freeze(criticalFailures),
    deterministicFailures: Object.freeze(deterministicFailures),
    passAtOne: countRate((result) => result.passAtOne),
    passAtK: countRate((result) => result.passAtK),
    passToK: countRate((result) => result.passToK),
    durationMs: Object.freeze({
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      total: durations.reduce((sum, duration) => sum + duration, 0),
    }),
    byProduct: Object.freeze({
      warden: byProduct("warden"),
      transformer: byProduct("transformer"),
    }),
    scenarios: Object.freeze(results),
  });
}
