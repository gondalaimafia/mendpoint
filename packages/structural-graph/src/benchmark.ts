export type GraphifyBenchmarkSplit = "development" | "validation" | "holdout";
export type GraphifyBenchmarkArm = "A" | "B" | "C";
export type GraphifyBenchmarkCase = {
  caseId: string;
  familyDigest: string;
  split: GraphifyBenchmarkSplit;
  indirect: boolean;
  language: string;
  inputDigest: string;
};
export type GraphifyBenchmarkPrediction = {
  nodes: string[];
  edges: string[];
  elapsedMs: number;
  peakMemoryBytes: number;
  semantic?: "not_measured";
};
export type GraphifyBenchmarkKey = {
  cohortDigest: string;
  cases: Array<{ caseId: string; expectedNodes: string[]; expectedEdges: string[] }>;
};
export type StagedGraphifyBenchmark = {
  schemaVersion: "mendpoint.graphify-benchmark-staged.v1";
  cohortDigest: string;
  cases: GraphifyBenchmarkCase[];
  predictions: Array<{ caseId: string; arm: GraphifyBenchmarkArm; output: GraphifyBenchmarkPrediction }>;
};
export type GraphifyBenchmarkArmMetrics = {
  semanticStatus: "measured" | "not_measured";
  nodePrecision: number;
  nodeRecall: number;
  edgePrecision: number;
  edgeRecall: number;
  indirectRecall: number;
  p95ElapsedMs: number;
  peakMemoryBytes: number;
};
export type GraphifyBenchmarkReport = {
  schemaVersion: "mendpoint.graphify-benchmark.v1";
  cohort: { total: number; development: number; validation: number; holdout: number; indirect: number };
  arms: Record<GraphifyBenchmarkArm, GraphifyBenchmarkArmMetrics>;
  modelCalls: 0;
  modelTokens: 0;
  modelCostUsd: 0;
  decision: "KEEP AS INTERNAL TOOL ONLY";
  adoptionBlockedBy: [
    "exact_path_accuracy_not_measured",
    "trap_correctness_not_measured",
    "incremental_equivalence_not_measured",
    "network_denial_not_measured",
    "sealed_external_holdout_not_executed",
  ];
};

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const compareCodeUnits = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const fail = (code: string): never => { throw new Error(code); };
const unique = (values: readonly string[]) => new Set(values).size === values.length;

function validatePrediction(value: GraphifyBenchmarkPrediction, arm: GraphifyBenchmarkArm): GraphifyBenchmarkPrediction {
  if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || value.nodes.length > 100_000 || value.edges.length > 500_000 || !unique(value.nodes) || !unique(value.edges)) fail("GRAPHIFY_BENCHMARK_OUTPUT_INVALID");
  if (![value.elapsedMs, value.peakMemoryBytes].every((number) => Number.isFinite(number) && number >= 0)) fail("GRAPHIFY_BENCHMARK_METRICS_INVALID");
  if (arm === "B" && value.semantic !== "not_measured") fail("GRAPHIFY_BENCHMARK_SEMANTIC_STATUS_INVALID");
  if (arm !== "B" && value.semantic !== undefined) fail("GRAPHIFY_BENCHMARK_SEMANTIC_STATUS_INVALID");
  return {
    nodes: [...value.nodes].sort(compareCodeUnits), edges: [...value.edges].sort(compareCodeUnits),
    elapsedMs: value.elapsedMs, peakMemoryBytes: value.peakMemoryBytes,
    ...(value.semantic === undefined ? {} : { semantic: value.semantic }),
  };
}

export async function stageGraphifyBenchmark(input: {
  cases: GraphifyBenchmarkCase[];
  cohortDigest: string;
  predict(caseInput: GraphifyBenchmarkCase & { arm: GraphifyBenchmarkArm }): Promise<GraphifyBenchmarkPrediction>;
}): Promise<StagedGraphifyBenchmark> {
  if (!DIGEST_RE.test(input.cohortDigest) || input.cases.length !== 18 || !unique(input.cases.map((item) => item.caseId))) fail("GRAPHIFY_BENCHMARK_COHORT_INVALID");
  const splitCounts = { development: 0, validation: 0, holdout: 0 };
  const indirectCounts = { development: 0, validation: 0, holdout: 0 };
  const familySplit = new Map<string, GraphifyBenchmarkSplit>();
  for (const item of input.cases) {
    if (!DIGEST_RE.test(item.familyDigest) || !DIGEST_RE.test(item.inputDigest) || !item.caseId || !item.language) fail("GRAPHIFY_BENCHMARK_CASE_INVALID");
    splitCounts[item.split] += 1;
    if (item.indirect) indirectCounts[item.split] += 1;
    const prior = familySplit.get(item.familyDigest);
    if (prior && prior !== item.split) fail("GRAPHIFY_BENCHMARK_LEAKAGE");
    familySplit.set(item.familyDigest, item.split);
  }
  if (Object.values(splitCounts).some((count) => count !== 6) || Object.values(indirectCounts).some((count) => count < 3)) fail("GRAPHIFY_BENCHMARK_SPLIT_INVALID");
  const cases = structuredClone(input.cases);
  const predictions: StagedGraphifyBenchmark["predictions"] = [];
  for (const item of cases) {
    for (const arm of ["A", "B", "C"] as const) {
      const output = validatePrediction(await input.predict({ ...structuredClone(item), arm }), arm);
      predictions.push({ caseId: item.caseId, arm, output });
    }
  }
  return Object.freeze({ schemaVersion: "mendpoint.graphify-benchmark-staged.v1", cohortDigest: input.cohortDigest, cases, predictions });
}

const ratio = (numerator: number, denominator: number) => denominator === 0 ? 1 : numerator / denominator;
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0;

export function gradeGraphifyBenchmark(staged: StagedGraphifyBenchmark, key: GraphifyBenchmarkKey): GraphifyBenchmarkReport {
  if (staged.cohortDigest !== key.cohortDigest || key.cases.length !== staged.cases.length || !unique(key.cases.map((item) => item.caseId))) fail("GRAPHIFY_BENCHMARK_KEY_MISMATCH");
  const truth = new Map(key.cases.map((item) => [item.caseId, item]));
  if (staged.cases.some((item) => !truth.has(item.caseId))) fail("GRAPHIFY_BENCHMARK_KEY_MISMATCH");
  const metrics = {} as Record<GraphifyBenchmarkArm, GraphifyBenchmarkArmMetrics>;
  for (const arm of ["A", "B", "C"] as const) {
    let nodeTrue = 0, nodePredicted = 0, nodeExpected = 0, edgeTrue = 0, edgePredicted = 0, edgeExpected = 0;
    let indirectTrue = 0, indirectExpected = 0;
    const elapsed: number[] = [];
    let peakMemoryBytes = 0;
    for (const item of staged.cases) {
      const expected = truth.get(item.caseId)!;
      const prediction = staged.predictions.find((candidate) => candidate.caseId === item.caseId && candidate.arm === arm);
      if (!prediction) throw new Error("GRAPHIFY_BENCHMARK_ARM_MISSING");
      const nodes = new Set(prediction.output.nodes); const edges = new Set(prediction.output.edges);
      nodeTrue += expected.expectedNodes.filter((node) => nodes.has(node)).length;
      nodePredicted += nodes.size; nodeExpected += expected.expectedNodes.length;
      edgeTrue += expected.expectedEdges.filter((edge) => edges.has(edge)).length;
      edgePredicted += edges.size; edgeExpected += expected.expectedEdges.length;
      if (item.indirect && item.split !== "development") {
        indirectTrue += expected.expectedEdges.filter((edge) => edges.has(edge)).length;
        indirectExpected += expected.expectedEdges.length;
      }
      elapsed.push(prediction.output.elapsedMs); peakMemoryBytes = Math.max(peakMemoryBytes, prediction.output.peakMemoryBytes);
    }
    metrics[arm] = {
      semanticStatus: arm === "B" ? "not_measured" : "measured",
      nodePrecision: ratio(nodeTrue, nodePredicted), nodeRecall: ratio(nodeTrue, nodeExpected),
      edgePrecision: ratio(edgeTrue, edgePredicted), edgeRecall: ratio(edgeTrue, edgeExpected),
      indirectRecall: ratio(indirectTrue, indirectExpected), p95ElapsedMs: p95(elapsed), peakMemoryBytes,
    };
  }
  return Object.freeze({
    schemaVersion: "mendpoint.graphify-benchmark.v1",
    cohort: {
      total: staged.cases.length,
      development: staged.cases.filter((item) => item.split === "development").length,
      validation: staged.cases.filter((item) => item.split === "validation").length,
      holdout: staged.cases.filter((item) => item.split === "holdout").length,
      indirect: staged.cases.filter((item) => item.indirect).length,
    },
    arms: metrics, modelCalls: 0, modelTokens: 0, modelCostUsd: 0,
    decision: "KEEP AS INTERNAL TOOL ONLY",
    adoptionBlockedBy: [
      "exact_path_accuracy_not_measured",
      "trap_correctness_not_measured",
      "incremental_equivalence_not_measured",
      "network_denial_not_measured",
      "sealed_external_holdout_not_executed",
    ] as GraphifyBenchmarkReport["adoptionBlockedBy"],
  });
}
