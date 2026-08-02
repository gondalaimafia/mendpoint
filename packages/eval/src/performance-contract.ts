export const PERFORMANCE_CONTRACT_VERSION = "2026-08-02.v1" as const;
export const PERFORMANCE_PERCENTILE_METHOD = "nearest_rank_v1" as const;

export type PerformanceMetric =
  | "first_result"
  | "complete_scan"
  | "verification"
  | "queue_wait"
  | "campaign_fanout";

export type PerformanceMode = "load" | "soak";

export type PerformanceTier = {
  id: string;
  repository: {
    files: number;
    bytes: number;
    languages: string[];
  };
  concurrency: number;
  minimumSamples: number;
  loadDurationSeconds: number;
  soakDurationSeconds: number;
};

export type PerformanceObjective = {
  metric: PerformanceMetric;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
};

export type PerformanceContract = {
  version: typeof PERFORMANCE_CONTRACT_VERSION;
  percentileMethod: typeof PERFORMANCE_PERCENTILE_METHOD;
  tiers: PerformanceTier[];
  objectives: PerformanceObjective[];
};

export type PerformanceObservation = {
  id: string;
  tierId: string;
  metric: PerformanceMetric;
  mode: PerformanceMode;
  durationMs: number;
  success: boolean;
  observedAt: string;
};

export type PerformanceResult = PerformanceObjective & {
  tierId: string;
  mode: PerformanceMode;
  sampleCount: number;
  failureCount: number;
  observedP50Ms: number;
  observedP95Ms: number;
  observedP99Ms: number;
  ok: boolean;
};

export type PerformanceReport = {
  version: typeof PERFORMANCE_CONTRACT_VERSION;
  percentileMethod: typeof PERFORMANCE_PERCENTILE_METHOD;
  mode: PerformanceMode;
  ok: boolean;
  results: Array<Omit<PerformanceResult, "observedP50Ms" | "observedP95Ms" | "observedP99Ms"> & {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    objectiveP50Ms: number;
    objectiveP95Ms: number;
    objectiveP99Ms: number;
  }>;
};

export const WARDEN_PERFORMANCE_CONTRACT: PerformanceContract = {
  version: PERFORMANCE_CONTRACT_VERSION,
  percentileMethod: PERFORMANCE_PERCENTILE_METHOD,
  tiers: [
    {
      id: "pilot-small",
      repository: { files: 5_000, bytes: 50_000_000, languages: ["typescript"] },
      concurrency: 2,
      minimumSamples: 100,
      loadDurationSeconds: 300,
      soakDurationSeconds: 3_600,
    },
    {
      id: "pilot-medium",
      repository: {
        files: 25_000,
        bytes: 500_000_000,
        languages: ["javascript", "python", "typescript"],
      },
      concurrency: 5,
      minimumSamples: 100,
      loadDurationSeconds: 600,
      soakDurationSeconds: 7_200,
    },
  ],
  objectives: [
    { metric: "first_result", p50Ms: 60_000, p95Ms: 180_000, p99Ms: 300_000 },
    { metric: "complete_scan", p50Ms: 300_000, p95Ms: 900_000, p99Ms: 1_800_000 },
    { metric: "verification", p50Ms: 120_000, p95Ms: 600_000, p99Ms: 1_200_000 },
    { metric: "queue_wait", p50Ms: 5_000, p95Ms: 30_000, p99Ms: 60_000 },
    { metric: "campaign_fanout", p50Ms: 30_000, p95Ms: 120_000, p99Ms: 300_000 },
  ],
};

const METRICS: readonly PerformanceMetric[] = [
  "first_result",
  "complete_scan",
  "verification",
  "queue_wait",
  "campaign_fanout",
];
const ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function fail(code: string): never {
  throw new Error(code);
}

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${field}_invalid`);
}

function duration(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) fail(`${field}_invalid`);
}

export function validatePerformanceContract(input: PerformanceContract): PerformanceContract {
  if (input.version !== PERFORMANCE_CONTRACT_VERSION) fail("performance_version_invalid");
  if (input.percentileMethod !== PERFORMANCE_PERCENTILE_METHOD) {
    fail("performance_percentile_method_invalid");
  }
  if (!Array.isArray(input.tiers) || input.tiers.length === 0) fail("performance_tiers_required");
  const tierIds = new Set<string>();
  for (const tier of input.tiers) {
    if (!ID.test(tier.id)) fail("performance_tier_id_invalid");
    if (tierIds.has(tier.id)) fail("performance_tier_duplicate");
    tierIds.add(tier.id);
    positiveInteger(tier.repository.files, "performance_tier_files");
    positiveInteger(tier.repository.bytes, "performance_tier_bytes");
    if (
      !Array.isArray(tier.repository.languages) ||
      tier.repository.languages.length === 0 ||
      tier.repository.languages.some((language) => !ID.test(language)) ||
      new Set(tier.repository.languages).size !== tier.repository.languages.length
    ) {
      fail("performance_tier_languages_invalid");
    }
    positiveInteger(tier.concurrency, "performance_tier_concurrency");
    positiveInteger(tier.minimumSamples, "performance_tier_minimum_samples");
    positiveInteger(tier.loadDurationSeconds, "performance_tier_load_duration");
    positiveInteger(tier.soakDurationSeconds, "performance_tier_soak_duration");
    if (tier.soakDurationSeconds <= tier.loadDurationSeconds) {
      fail("performance_tier_soak_duration_invalid");
    }
  }
  if (!Array.isArray(input.objectives) || input.objectives.length !== METRICS.length) {
    fail("performance_objectives_incomplete");
  }
  const objectiveMetrics = new Set<PerformanceMetric>();
  for (const objective of input.objectives) {
    if (!METRICS.includes(objective.metric)) fail("performance_objective_metric_invalid");
    if (objectiveMetrics.has(objective.metric)) fail("performance_objective_duplicate");
    objectiveMetrics.add(objective.metric);
    duration(objective.p50Ms, "performance_objective_p50");
    duration(objective.p95Ms, "performance_objective_p95");
    duration(objective.p99Ms, "performance_objective_p99");
    if (objective.p50Ms > objective.p95Ms || objective.p95Ms > objective.p99Ms) {
      fail("performance_objective_order_invalid");
    }
  }
  if (METRICS.some((metric) => !objectiveMetrics.has(metric))) {
    fail("performance_objectives_incomplete");
  }
  return input;
}

function nearestRank(values: readonly number[], percentile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)]!;
}

export function evaluatePerformanceRun(
  rawContract: PerformanceContract,
  observations: readonly PerformanceObservation[],
  mode: PerformanceMode = "load",
): PerformanceReport {
  const contract = validatePerformanceContract(rawContract);
  const knownTiers = new Set(contract.tiers.map((tier) => tier.id));
  const observationIds = new Set<string>();
  for (const observation of observations) {
    if (!ID.test(observation.id) || observationIds.has(observation.id)) {
      fail("performance_observation_id_invalid");
    }
    observationIds.add(observation.id);
    if (!knownTiers.has(observation.tierId)) fail("performance_observation_tier_invalid");
    if (!METRICS.includes(observation.metric)) fail("performance_observation_metric_invalid");
    if (observation.mode !== mode) fail("performance_observation_mode_invalid");
    duration(observation.durationMs, "performance_observation_duration");
    if (new Date(observation.observedAt).toISOString() !== observation.observedAt) {
      fail("performance_observation_time_invalid");
    }
  }

  const results: PerformanceReport["results"] = [];
  for (const tier of contract.tiers) {
    for (const objective of contract.objectives) {
      const samples = observations.filter(
        (observation) =>
          observation.tierId === tier.id &&
          observation.metric === objective.metric,
      );
      if (samples.length < tier.minimumSamples) fail("performance_samples_incomplete");
      const durations = samples.map((sample) => sample.durationMs);
      const p50Ms = nearestRank(durations, 0.5);
      const p95Ms = nearestRank(durations, 0.95);
      const p99Ms = nearestRank(durations, 0.99);
      const failureCount = samples.filter((sample) => !sample.success).length;
      results.push({
        tierId: tier.id,
        metric: objective.metric,
        mode,
        sampleCount: samples.length,
        failureCount,
        p50Ms,
        p95Ms,
        p99Ms,
        objectiveP50Ms: objective.p50Ms,
        objectiveP95Ms: objective.p95Ms,
        objectiveP99Ms: objective.p99Ms,
        ok:
          failureCount === 0 &&
          p50Ms <= objective.p50Ms &&
          p95Ms <= objective.p95Ms &&
          p99Ms <= objective.p99Ms,
      });
    }
  }
  results.sort(
    (left, right) =>
      left.tierId.localeCompare(right.tierId) || left.metric.localeCompare(right.metric),
  );
  return {
    version: PERFORMANCE_CONTRACT_VERSION,
    percentileMethod: PERFORMANCE_PERCENTILE_METHOD,
    mode,
    ok: results.every((result) => result.ok),
    results,
  };
}
