import { createHash } from "node:crypto";

export type ChangeGraphBenchmarkSplit = "development" | "validation" | "holdout";
export type ChangeGraphBenchmarkScenario = {
  id: string;
  split: ChangeGraphBenchmarkSplit;
  splitGroupId: string;
  indirect: boolean;
  task: string;
  expectedEntityIds: string[];
  rawContext: string;
  graphContext: string;
};
export type ChangeGraphGeneratorResult = {
  entityIds: readonly string[];
  deterministicAccepted: boolean;
  failureCategory?: string;
  usage: { inputTokens: number; outputTokens: number; latencyMs: number; costUsd: number };
};
export type ChangeGraphBenchmarkGenerator = (input: Readonly<{
  scenarioId: string;
  task: string;
  context: string;
  arm: "raw" | "graph";
}>) => Promise<ChangeGraphGeneratorResult>;
export type ChangeGraphBenchmarkVerifier = (input: Readonly<{
  scenarioId: string;
  task: string;
  context: string;
  arm: "raw" | "graph";
  entityIds: readonly string[];
}>) => Promise<{ score: number; model: string }>;

const compareCodeUnits = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort(compareCodeUnits)) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
const exactIds = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify([...new Set(left)].sort(compareCodeUnits)) === JSON.stringify([...new Set(right)].sort(compareCodeUnits));

function assertScenarioSet(scenarios: ChangeGraphBenchmarkScenario[]): void {
  if (!Array.isArray(scenarios) || scenarios.length < 3 || scenarios.length > 1_000) {
    throw new Error("change_graph_benchmark_scenarios_invalid");
  }
  const ids = new Set<string>();
  const groupSplits = new Map<string, ChangeGraphBenchmarkSplit>();
  for (const scenario of scenarios) {
    if (!scenario.id || scenario.id.length > 256 || ids.has(scenario.id)) {
      throw new Error("change_graph_benchmark_scenario_id_invalid");
    }
    ids.add(scenario.id);
    if (!scenario.splitGroupId || scenario.splitGroupId.length > 512 || /[\u0000-\u001f]/.test(scenario.splitGroupId)) {
      throw new Error("change_graph_benchmark_split_group_invalid");
    }
    if (!scenario.task || scenario.task.length > 8_192 ||
        !scenario.rawContext || Buffer.byteLength(scenario.rawContext) > 262_144 ||
        !scenario.graphContext || Buffer.byteLength(scenario.graphContext) > 262_144 ||
        !Array.isArray(scenario.expectedEntityIds) || scenario.expectedEntityIds.length < 1 ||
        scenario.expectedEntityIds.length > 100 ||
        scenario.expectedEntityIds.some((id) => !id || id.length > 1_024 || /[\u0000-\u001f]/.test(id)) ||
        new Set(scenario.expectedEntityIds).size !== scenario.expectedEntityIds.length) {
      throw new Error("change_graph_benchmark_scenario_invalid");
    }
    const group = scenario.splitGroupId;
    const prior = groupSplits.get(group);
    if (prior && prior !== scenario.split) throw new Error("change_graph_benchmark_split_group_leakage");
    groupSplits.set(group, scenario.split);
  }
  for (const split of ["development", "validation", "holdout"] as const) {
    const members = scenarios.filter((scenario) => scenario.split === split);
    if (!members.length) throw new Error("change_graph_benchmark_split_empty");
    if (split !== "development" && members.filter((scenario) => scenario.indirect).length / members.length < 0.5) {
      throw new Error("change_graph_benchmark_indirect_coverage_insufficient");
    }
  }
}

type Observation = {
  scenarioId: string;
  split: ChangeGraphBenchmarkSplit;
  indirect: boolean;
  arm: "raw" | "graph";
  correct: boolean;
  deterministicAccepted: boolean;
  failureCategory?: string;
  contextBytes: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  verifier?: { score: number; model: string };
};

export async function runChangeGraphRepresentationBenchmark(input: {
  benchmarkId: string;
  generatorId: string;
  scenarios: ChangeGraphBenchmarkScenario[];
  generator: ChangeGraphBenchmarkGenerator;
  verifier?: ChangeGraphBenchmarkVerifier;
}) {
  const benchmarkId = input.benchmarkId;
  const generatorId = input.generatorId;
  const generator = input.generator;
  const verifierPort = input.verifier;
  if (
    typeof benchmarkId !== "string" || !benchmarkId || benchmarkId.length > 512 ||
    typeof generatorId !== "string" || !generatorId || generatorId.length > 512 ||
    typeof generator !== "function" ||
    (verifierPort !== undefined && typeof verifierPort !== "function")
  ) throw new Error("change_graph_benchmark_identity_invalid");
  const scenarios = structuredClone(input.scenarios);
  assertScenarioSet(scenarios);
  const scenarioSetDigest = digest(scenarios);
  const observations: Observation[] = [];
  for (const scenario of scenarios.sort((a, b) => compareCodeUnits(a.id, b.id))) {
    for (const arm of ["raw", "graph"] as const) {
      const context = arm === "raw" ? scenario.rawContext : scenario.graphContext;
      const request = Object.freeze({
        scenarioId: scenario.id,
        task: scenario.task,
        context,
        arm,
      });
      const generated = structuredClone(await generator(request));
      if (
        !generated || typeof generated !== "object" ||
        !Array.isArray(generated.entityIds) || generated.entityIds.length > 100 ||
        generated.entityIds.some((id) => typeof id !== "string" || !id || id.length > 1_024 || /[\u0000-\u001f]/.test(id)) ||
        typeof generated.deterministicAccepted !== "boolean" ||
        (generated.failureCategory !== undefined && (
          typeof generated.failureCategory !== "string" ||
          !/^[a-z][a-z0-9_]{0,127}$/.test(generated.failureCategory)
        )) ||
        (generated.deterministicAccepted && generated.failureCategory !== undefined) ||
        (!generated.deterministicAccepted && generated.failureCategory === undefined)
      ) throw new Error("change_graph_benchmark_generator_result_invalid");
      const entityIds = [...new Set(generated.entityIds)].sort(compareCodeUnits);
      const usage = generated.usage;
      if (
        !usage || typeof usage !== "object" ||
        !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 ||
        !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0 ||
        !Number.isFinite(usage.latencyMs) || usage.latencyMs < 0 ||
        !Number.isFinite(usage.costUsd) || usage.costUsd < 0
      ) throw new Error("change_graph_benchmark_usage_invalid");
      const correct = generated.deterministicAccepted && exactIds(entityIds, scenario.expectedEntityIds);
      let verifier: Observation["verifier"];
      if (verifierPort && generated.deterministicAccepted) {
        const result = structuredClone(await verifierPort(Object.freeze({
          ...request,
          entityIds: Object.freeze(entityIds),
        })));
        if (
          !result || typeof result !== "object" ||
          !Number.isFinite(result.score) || result.score < 0 || result.score > 1 ||
          typeof result.model !== "string" || !result.model || result.model.length > 512
        ) {
          throw new Error("change_graph_benchmark_verifier_result_invalid");
        }
        verifier = { score: result.score, model: result.model };
      }
      observations.push({
        scenarioId: scenario.id,
        split: scenario.split,
        indirect: scenario.indirect,
        arm,
        correct,
        deterministicAccepted: generated.deterministicAccepted,
        ...(generated.failureCategory ? { failureCategory: generated.failureCategory } : {}),
        contextBytes: Buffer.byteLength(context, "utf8"),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: usage.latencyMs,
        costUsd: usage.costUsd,
        verifier,
      });
    }
  }
  const arms = Object.fromEntries((["raw", "graph"] as const).map((arm) => {
    const rows = observations.filter((row) => row.arm === arm);
    const correct = rows.filter((row) => row.correct).length;
    const failureCategories: Record<string, number> = {};
    for (const row of rows) {
      if (!row.failureCategory) continue;
      failureCategories[row.failureCategory] = (failureCategories[row.failureCategory] ?? 0) + 1;
    }
    return [arm, {
      scenarios: rows.length,
      correct,
      accuracy: correct / rows.length,
      deterministicAccepted: rows.filter((row) => row.deterministicAccepted).length,
      abstained: rows.filter((row) => !row.deterministicAccepted).length,
      failureCategories,
      contextBytes: rows.reduce((sum, row) => sum + row.contextBytes, 0),
      inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
      latencyMs: rows.reduce((sum, row) => sum + row.latencyMs, 0),
      costUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
    }];
  })) as Record<"raw" | "graph", {
    scenarios: number; correct: number; accuracy: number; deterministicAccepted: number;
    abstained: number; failureCategories: Record<string, number>;
    contextBytes: number; inputTokens: number; outputTokens: number; latencyMs: number; costUsd: number;
  }>;
  const splits = Object.fromEntries((["development", "validation", "holdout"] as const).map((split) => {
    const members = scenarios.filter((scenario) => scenario.split === split);
    return [split, { scenarioCount: members.length, indirectCount: members.filter((scenario) => scenario.indirect).length }];
  })) as Record<ChangeGraphBenchmarkSplit, { scenarioCount: number; indirectCount: number }>;
  const report = {
    schemaVersion: "mendpoint.change-graph-benchmark.v1" as const,
    benchmarkId,
    generatorId,
    scenarioSetDigest,
    scenarios: scenarios.length,
    splits,
    arms,
    observations,
  };
  return structuredClone({ ...report, reportDigest: digest(report) });
}
