import { createHash } from "node:crypto";

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
  cases: Array<{
    caseId: string;
    familyDigest: string;
    split: GraphifyBenchmarkSplit;
    indirect: boolean;
    language: string;
    inputDigest: string;
    expectedNodes: string[];
    expectedEdges: string[];
    expectedIndirectEdges: string[];
  }>;
};
export type StagedGraphifyBenchmark = {
  schemaVersion: "mendpoint.graphify-benchmark-staged.v1";
  cohortDigest: string;
  cases: GraphifyBenchmarkCase[];
  predictions: Array<{ caseId: string; arm: GraphifyBenchmarkArm; output: GraphifyBenchmarkPrediction }>;
};
export type GraphifyBenchmarkArmMetrics = {
  semanticStatus: "not_measured";
  nodePrecision: number | null;
  nodeRecall: number | null;
  edgePrecision: number | null;
  edgeRecall: number | null;
  indirectRecall: number | null;
  p95ElapsedMs: number | null;
  peakMemoryBytes: number | null;
};
export type GraphifyBenchmarkReport = {
  schemaVersion: "mendpoint.graphify-benchmark.v1";
  contentDigest: `sha256:${string}`;
  cohortDigest: string;
  stagedDigest: `sha256:${string}`;
  keyDigest: `sha256:${string}`;
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
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}
const contentDigest = (value: unknown): `sha256:${string}` => `sha256:${createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex")}`;
const canonicalCase = (item: GraphifyBenchmarkCase) => ({
  caseId: item.caseId,
  familyDigest: item.familyDigest,
  split: item.split,
  indirect: item.indirect,
  language: item.language,
  inputDigest: item.inputDigest,
});

export function graphifyBenchmarkCohortDigest(cases: readonly GraphifyBenchmarkCase[]): string {
  const canonical = [...cases].map(canonicalCase).sort((a, b) => compareCodeUnits(a.caseId, b.caseId));
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

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
  predict(caseInput: Pick<GraphifyBenchmarkCase, "caseId" | "inputDigest" | "language"> & { arm: GraphifyBenchmarkArm }): Promise<GraphifyBenchmarkPrediction>;
}): Promise<StagedGraphifyBenchmark> {
  const cases = structuredClone(input.cases);
  const cohortDigest = input.cohortDigest;
  const predict = input.predict;
  if (typeof predict !== "function" || !DIGEST_RE.test(cohortDigest) || cohortDigest !== graphifyBenchmarkCohortDigest(cases) || cases.length !== 18 || !unique(cases.map((item) => item.caseId))) fail("GRAPHIFY_BENCHMARK_COHORT_INVALID");
  const splitCounts = { development: 0, validation: 0, holdout: 0 };
  const indirectCounts = { development: 0, validation: 0, holdout: 0 };
  const familySplit = new Map<string, GraphifyBenchmarkSplit>();
  for (const item of cases) {
    if (!DIGEST_RE.test(item.familyDigest) || !DIGEST_RE.test(item.inputDigest) || !item.caseId || !item.language) fail("GRAPHIFY_BENCHMARK_CASE_INVALID");
    splitCounts[item.split] += 1;
    if (item.indirect) indirectCounts[item.split] += 1;
    const prior = familySplit.get(item.familyDigest);
    if (prior && prior !== item.split) fail("GRAPHIFY_BENCHMARK_LEAKAGE");
    familySplit.set(item.familyDigest, item.split);
  }
  if (Object.values(splitCounts).some((count) => count !== 6) || Object.values(indirectCounts).some((count) => count < 3)) fail("GRAPHIFY_BENCHMARK_SPLIT_INVALID");
  const predictions: StagedGraphifyBenchmark["predictions"] = [];
  for (const item of cases) {
    for (const arm of ["A", "B", "C"] as const) {
      const output = validatePrediction(await predict({
        caseId: item.caseId,
        inputDigest: item.inputDigest,
        language: item.language,
        arm,
      }), arm);
      predictions.push({ caseId: item.caseId, arm, output });
    }
  }
  return deepFreeze({ schemaVersion: "mendpoint.graphify-benchmark-staged.v1", cohortDigest, cases, predictions });
}

const precision = (numerator: number, denominator: number) => denominator === 0 ? null : numerator / denominator;
// A recall over an empty ground-truth denominator measured nothing; 0 is the flattering value here
// exactly as 1 is for precision. Return null so an unmeasured cohort cannot read as a real result.
const recall = (numerator: number, denominator: number): number | null => denominator === 0 ? null : numerator / denominator;
// A latency percentile over nothing is not zero, it is unmeasured. Returning the
// flattering 0 lets a cohort that measured no latency read as instant; return
// null so "not measured" cannot silently drop out of the aggregate.
const p95 = (values: number[]): number | null => values.length === 0 ? null : ([...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? null);

export function gradeGraphifyBenchmark(staged: StagedGraphifyBenchmark, key: GraphifyBenchmarkKey): GraphifyBenchmarkReport {
  staged = structuredClone(staged);
  key = structuredClone(key);
  // The benchmark is pinned to an 18-case cohort. Without this invariant an empty
  // (or truncated) staged artifact grades cleanly and reports a flattering
  // p95ElapsedMs: 0 / peakMemoryBytes: 0 for a cohort that measured nothing.
  if (staged.cases.length !== 18 || key.cases.length !== 18) fail("GRAPHIFY_BENCHMARK_COHORT_INVALID");
  if (
    staged.schemaVersion !== "mendpoint.graphify-benchmark-staged.v1" ||
    staged.cohortDigest !== key.cohortDigest ||
    staged.cohortDigest !== graphifyBenchmarkCohortDigest(staged.cases) ||
    key.cases.length !== staged.cases.length ||
    !unique(key.cases.map((item) => item.caseId))
  ) fail("GRAPHIFY_BENCHMARK_KEY_MISMATCH");
  for (const item of staged.cases) {
    if (
      !item ||
      !item.caseId ||
      !DIGEST_RE.test(item.familyDigest) ||
      !DIGEST_RE.test(item.inputDigest) ||
      !["development", "validation", "holdout"].includes(item.split) ||
      typeof item.indirect !== "boolean" ||
      !item.language
    ) fail("GRAPHIFY_BENCHMARK_KEY_MISMATCH");
  }
  const truth = new Map(key.cases.map((item) => [item.caseId, item]));
  if (staged.cases.some((item) => !truth.has(item.caseId))) fail("GRAPHIFY_BENCHMARK_KEY_MISMATCH");
  for (const item of staged.cases) {
    const expected = truth.get(item.caseId)!;
    if (
      expected.familyDigest !== item.familyDigest ||
      expected.split !== item.split ||
      expected.indirect !== item.indirect ||
      expected.language !== item.language ||
      expected.inputDigest !== item.inputDigest ||
      !Array.isArray(expected.expectedNodes) ||
      !Array.isArray(expected.expectedEdges) ||
      !Array.isArray(expected.expectedIndirectEdges) ||
      !unique(expected.expectedNodes) ||
      !unique(expected.expectedEdges) ||
      !unique(expected.expectedIndirectEdges) ||
      expected.expectedIndirectEdges.some((edge) => !expected.expectedEdges.includes(edge)) ||
      (item.indirect && expected.expectedIndirectEdges.length === 0)
    ) fail("GRAPHIFY_BENCHMARK_KEY_MISMATCH");
  }
  if (
    staged.predictions.length !== staged.cases.length * 3 ||
    !unique(staged.predictions.map((item) => `${item.caseId}\0${item.arm}`))
  ) fail("GRAPHIFY_BENCHMARK_ARM_MISSING");
  for (const prediction of staged.predictions) {
    if (!truth.has(prediction.caseId) || !["A", "B", "C"].includes(prediction.arm)) fail("GRAPHIFY_BENCHMARK_ARM_MISSING");
    validatePrediction(prediction.output, prediction.arm);
  }
  const metrics = {} as Record<GraphifyBenchmarkArm, GraphifyBenchmarkArmMetrics>;
  for (const arm of ["A", "B", "C"] as const) {
    let nodeTrue = 0, nodePredicted = 0, nodeExpected = 0, edgeTrue = 0, edgePredicted = 0, edgeExpected = 0;
    let indirectTrue = 0, indirectExpected = 0;
    const elapsed: number[] = [];
    let peakMemoryBytes: number | null = null;
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
        indirectTrue += expected.expectedIndirectEdges.filter((edge) => edges.has(edge)).length;
        indirectExpected += expected.expectedIndirectEdges.length;
      }
      elapsed.push(prediction.output.elapsedMs);
      peakMemoryBytes = peakMemoryBytes === null ? prediction.output.peakMemoryBytes : Math.max(peakMemoryBytes, prediction.output.peakMemoryBytes);
    }
    // A latency, memory, or recall metric that measured nothing must fail the gate, not
    // pass as an unmeasured null quietly folded into the report.
    const p95ElapsedMs = p95(elapsed);
    const nodeRecall = recall(nodeTrue, nodeExpected);
    const edgeRecall = recall(edgeTrue, edgeExpected);
    const indirectRecall = recall(indirectTrue, indirectExpected);
    if (p95ElapsedMs === null || peakMemoryBytes === null ||
        nodeRecall === null || edgeRecall === null || indirectRecall === null) fail("GRAPHIFY_BENCHMARK_METRICS_UNMEASURED");
    metrics[arm] = {
      semanticStatus: "not_measured",
      nodePrecision: precision(nodeTrue, nodePredicted), nodeRecall,
      edgePrecision: precision(edgeTrue, edgePredicted), edgeRecall,
      indirectRecall, p95ElapsedMs, peakMemoryBytes,
    };
  }
  const reportWithoutDigest = {
    schemaVersion: "mendpoint.graphify-benchmark.v1",
    cohortDigest: staged.cohortDigest,
    stagedDigest: contentDigest(staged),
    keyDigest: contentDigest(key),
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
  } as const;
  return deepFreeze({ ...reportWithoutDigest, contentDigest: contentDigest(reportWithoutDigest) });
}
