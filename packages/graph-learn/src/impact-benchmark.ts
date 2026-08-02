export const IMPACT_BENCHMARK_VERSION = "2026-08-02.v1" as const;

export type ImpactScaleTier = "small" | "medium" | "large";

export type ImpactBenchmarkCase = Readonly<{
  id: string;
  corpusRevision: string;
  snapshotId: string;
  exactCommit: string;
  expectedAffectedNodeIds: readonly string[];
  expectedDependencyPaths: readonly (readonly string[])[];
  noImpactExpected?: boolean;
  evidenceRefs: readonly string[];
}>;

export type ImpactPrediction = Readonly<{
  tenantId: string;
  snapshotId: string;
  exactCommit: string;
  corpusRevision: string;
  affectedNodeIds: readonly string[];
  dependencyPaths: readonly (readonly string[])[];
  evidenceRefs: readonly string[];
}>;

export type ImpactBenchmarkContract = Readonly<{
  version: typeof IMPACT_BENCHMARK_VERSION;
  tenantId: string;
  repositorySnapshot: Readonly<{ id: string; exactCommit: string }>;
  corpus: Readonly<{
    id: string;
    revision: string;
    digest: string;
    split: "held_out" | "training" | "validation";
    createdAt: string;
    trainingCaseIds: readonly string[];
  }>;
  scale: Readonly<{ tier: ImpactScaleTier; nodeCount: number; edgeCount: number }>;
  thresholds: Readonly<{
    minPrecision: number;
    minRecall: number;
    minFullPathAccuracy: number;
    maxP95LatencyMs: number;
  }>;
  cases: readonly ImpactBenchmarkCase[];
  evidenceRefs: readonly string[];
}>;

export type ImpactBenchmarkReport = Readonly<{
  version: typeof IMPACT_BENCHMARK_VERSION;
  tenantId: string;
  repositorySnapshot: Readonly<{ id: string; exactCommit: string }>;
  corpus: Readonly<{ id: string; revision: string; digest: string }>;
  evaluatedAt: string;
  scale: Readonly<{ tier: ImpactScaleTier; nodeCount: number; edgeCount: number }>;
  cases: number;
  metrics: Readonly<{
    precision: number;
    recall: number;
    fullDependencyPathAccuracy: number;
    latencyMs: Readonly<{ p50: number; p95: number; p99: number; maximum: number }>;
  }>;
  accepted: boolean;
  failures: readonly string[];
  evidenceRefs: readonly string[];
}>;

const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const SCALE_LIMITS: Readonly<Record<ImpactScaleTier, Readonly<{ nodes: number; edges: number }>>> = {
  small: { nodes: 10_000, edges: 50_000 },
  medium: { nodes: 100_000, edges: 500_000 },
  large: { nodes: 1_000_000, edges: 5_000_000 },
};

function fail(message: string): never {
  throw new Error(message);
}

function required(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(message);
  return value.trim();
}

function references(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(message);
  const result = value.map((entry) => required(entry, message));
  if (new Set(result).size !== result.length) fail(message);
  return result.sort();
}

function probability(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(message);
  }
  return value;
}

function positiveInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail(message);
  return value;
}

function uniqueStrings(value: unknown, message: string): string[] {
  if (!Array.isArray(value)) fail(message);
  const result = value.map((entry) => required(entry, message));
  if (new Set(result).size !== result.length) fail(message);
  return result;
}

function normalizePaths(value: unknown, message: string): string[] {
  if (!Array.isArray(value)) fail(message);
  const result = value.map((path) => {
    const nodes = uniqueStrings(path, message);
    if (nodes.length === 0) fail(message);
    return nodes.join("\u001f");
  });
  if (new Set(result).size !== result.length) fail(message);
  return result.sort();
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateThresholds(contract: ImpactBenchmarkContract): void {
  const thresholds = contract.thresholds;
  probability(thresholds?.minPrecision, "impact_benchmark_threshold_unacceptable");
  probability(thresholds?.minRecall, "impact_benchmark_threshold_unacceptable");
  probability(thresholds?.minFullPathAccuracy, "impact_benchmark_threshold_unacceptable");
  if (
    thresholds.minPrecision < 0.7 ||
    thresholds.minRecall < 0.7 ||
    thresholds.minFullPathAccuracy < 0.5 ||
    typeof thresholds.maxP95LatencyMs !== "number" ||
    !Number.isFinite(thresholds.maxP95LatencyMs) ||
    thresholds.maxP95LatencyMs <= 0 ||
    thresholds.maxP95LatencyMs > 2_000
  ) fail("impact_benchmark_threshold_unacceptable");
}

export function runImpactBenchmark(
  contract: ImpactBenchmarkContract,
  options: Readonly<{
    expectedCorpusRevision: string;
    evaluatedAt: string;
    maxCorpusAgeMs?: number;
    predict: (benchmarkCase: ImpactBenchmarkCase) => ImpactPrediction;
    measureLatencyMs?: (benchmarkCase: ImpactBenchmarkCase, elapsedMs: number) => number;
  }>,
): ImpactBenchmarkReport {
  if (contract.version !== IMPACT_BENCHMARK_VERSION) fail("impact_benchmark_version_unsupported");
  const tenantId = required(contract.tenantId, "impact_benchmark_tenant_required");
  const snapshotId = required(contract.repositorySnapshot?.id, "impact_benchmark_snapshot_required");
  const exactCommit = required(contract.repositorySnapshot?.exactCommit, "impact_benchmark_commit_required");
  if (!REVISION.test(exactCommit)) fail("impact_benchmark_commit_invalid");
  const corpusId = required(contract.corpus?.id, "impact_benchmark_corpus_required");
  if (contract.corpus?.split !== "held_out") fail("impact_benchmark_corpus_not_held_out");
  const revision = required(contract.corpus.revision, "impact_benchmark_corpus_revision_required");
  if (!REVISION.test(revision)) fail("impact_benchmark_corpus_revision_invalid");
  if (revision !== required(options.expectedCorpusRevision, "impact_benchmark_expected_revision_required")) {
    fail("impact_benchmark_corpus_revision_mismatch");
  }
  const digest = required(contract.corpus.digest, "impact_benchmark_corpus_digest_required");
  if (!DIGEST.test(digest)) fail("impact_benchmark_corpus_digest_invalid");
  const evaluatedTimestamp = Date.parse(required(options.evaluatedAt, "impact_benchmark_evaluated_at_invalid"));
  const createdTimestamp = Date.parse(required(contract.corpus.createdAt, "impact_benchmark_corpus_created_at_invalid"));
  if (!Number.isFinite(evaluatedTimestamp) || !Number.isFinite(createdTimestamp)) {
    fail("impact_benchmark_timestamp_invalid");
  }
  const maxAge = options.maxCorpusAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (!Number.isFinite(maxAge) || maxAge <= 0) fail("impact_benchmark_max_age_invalid");
  if (createdTimestamp > evaluatedTimestamp || evaluatedTimestamp - createdTimestamp > maxAge) {
    fail("impact_benchmark_corpus_stale");
  }
  const contractEvidence = references(contract.evidenceRefs, "impact_benchmark_evidence_required");
  validateThresholds(contract);
  const scaleLimit = SCALE_LIMITS[contract.scale?.tier];
  if (!scaleLimit) fail("impact_benchmark_scale_tier_invalid");
  const nodeCount = positiveInteger(contract.scale.nodeCount, "impact_benchmark_scale_invalid");
  const edgeCount = positiveInteger(contract.scale.edgeCount, "impact_benchmark_scale_invalid");
  if (nodeCount > scaleLimit.nodes || edgeCount > scaleLimit.edges) {
    fail("impact_benchmark_scale_tier_mismatch");
  }
  if (!Array.isArray(contract.cases) || contract.cases.length === 0) fail("impact_benchmark_cases_required");

  const caseIds = new Set<string>();
  const labels = new Map<string, Readonly<{ affected: string[]; paths: string[] }>>();
  for (const benchmarkCase of contract.cases) {
    const id = required(benchmarkCase.id, "impact_benchmark_case_id_required");
    if (caseIds.has(id)) fail("impact_benchmark_case_duplicate");
    caseIds.add(id);
    if (contract.corpus.trainingCaseIds.includes(id)) fail("impact_benchmark_case_leakage");
    if (benchmarkCase.corpusRevision !== revision) fail("impact_benchmark_case_revision_mismatch");
    if (benchmarkCase.snapshotId !== snapshotId) fail("impact_benchmark_case_snapshot_mismatch");
    if (benchmarkCase.exactCommit !== exactCommit) fail("impact_benchmark_case_commit_mismatch");
    const affected = uniqueStrings(benchmarkCase.expectedAffectedNodeIds, "impact_benchmark_labels_invalid").sort();
    const paths = normalizePaths(benchmarkCase.expectedDependencyPaths, "impact_benchmark_labels_invalid");
    if (affected.length === 0 && paths.length === 0 && benchmarkCase.noImpactExpected !== true) {
      fail("impact_benchmark_labels_required");
    }
    if (benchmarkCase.noImpactExpected === true && (affected.length > 0 || paths.length > 0)) {
      fail("impact_benchmark_labels_invalid");
    }
    references(benchmarkCase.evidenceRefs, "impact_benchmark_case_evidence_required");
    labels.set(id, Object.freeze({ affected, paths }));
  }

  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let exactPaths = 0;
  const latencyMs: number[] = [];
  const predictionEvidence: string[] = [];
  for (const benchmarkCase of contract.cases) {
    const startedAt = performance.now();
    const prediction = options.predict(benchmarkCase);
    const measured = performance.now() - startedAt;
    const latency = options.measureLatencyMs?.(benchmarkCase, measured) ?? measured;
    if (typeof latency !== "number" || !Number.isFinite(latency) || latency < 0) {
      fail("impact_benchmark_latency_invalid");
    }
    latencyMs.push(latency);
    if (prediction?.tenantId !== tenantId) fail("impact_benchmark_prediction_tenant_mismatch");
    if (prediction.snapshotId !== snapshotId) fail("impact_benchmark_prediction_snapshot_mismatch");
    if (prediction.exactCommit !== exactCommit) fail("impact_benchmark_prediction_commit_mismatch");
    if (prediction.corpusRevision !== revision) fail("impact_benchmark_prediction_revision_mismatch");
    predictionEvidence.push(...references(prediction?.evidenceRefs, "impact_benchmark_prediction_evidence_required"));
    const predictedAffected = uniqueStrings(prediction?.affectedNodeIds, "impact_benchmark_prediction_invalid").sort();
    const predictedPaths = normalizePaths(prediction?.dependencyPaths, "impact_benchmark_prediction_invalid");
    const expected = labels.get(benchmarkCase.id)!;
    const expectedSet = new Set(expected.affected);
    const predictedSet = new Set(predictedAffected);
    truePositive += predictedAffected.filter((nodeId) => expectedSet.has(nodeId)).length;
    falsePositive += predictedAffected.filter((nodeId) => !expectedSet.has(nodeId)).length;
    falseNegative += expected.affected.filter((nodeId) => !predictedSet.has(nodeId)).length;
    if (sameSet(expected.paths, predictedPaths)) exactPaths++;
  }
  if (truePositive + falsePositive === 0 || truePositive + falseNegative === 0) {
    fail("impact_benchmark_metric_denominator_empty");
  }
  const precision = truePositive / (truePositive + falsePositive);
  const recall = truePositive / (truePositive + falseNegative);
  const fullDependencyPathAccuracy = exactPaths / contract.cases.length;
  const latency = Object.freeze({
    p50: percentile(latencyMs, 0.5),
    p95: percentile(latencyMs, 0.95),
    p99: percentile(latencyMs, 0.99),
    maximum: Math.max(...latencyMs),
  });
  const failures: string[] = [];
  if (precision < contract.thresholds.minPrecision) failures.push("precision");
  if (recall < contract.thresholds.minRecall) failures.push("recall");
  if (fullDependencyPathAccuracy < contract.thresholds.minFullPathAccuracy) failures.push("full_dependency_path_accuracy");
  if (latency.p95 > contract.thresholds.maxP95LatencyMs) failures.push("p95_latency");

  return Object.freeze({
    version: IMPACT_BENCHMARK_VERSION,
    tenantId,
    repositorySnapshot: Object.freeze({ id: snapshotId, exactCommit }),
    corpus: Object.freeze({ id: corpusId, revision, digest }),
    evaluatedAt: new Date(evaluatedTimestamp).toISOString(),
    scale: Object.freeze({ tier: contract.scale.tier, nodeCount, edgeCount }),
    cases: contract.cases.length,
    metrics: Object.freeze({ precision, recall, fullDependencyPathAccuracy, latencyMs: latency }),
    accepted: failures.length === 0,
    failures: Object.freeze(failures),
    evidenceRefs: Object.freeze([...new Set([...contractEvidence, ...predictionEvidence])].sort()),
  });
}
