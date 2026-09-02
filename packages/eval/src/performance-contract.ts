import { createHash } from "node:crypto";

export const PERFORMANCE_CONTRACT_VERSION = "2026-09-02.v2" as const;
export const PERFORMANCE_METRIC_DICTIONARY_VERSION = "2026-09-02.v1" as const;
export const PERFORMANCE_PERCENTILE_METHOD = "nearest_rank_v1" as const;

const LEGACY_PERFORMANCE_CONTRACT_VERSION = "2026-08-02.v1";

export type PerformanceMetric =
  | "first_result"
  | "complete_scan"
  | "verification"
  | "queue_wait"
  | "campaign_fanout";

export type PerformanceMode = "load" | "soak";

export type PerformanceLanguageMix = Readonly<{
  language: string;
  minimumPercent: number;
}>;

export type PerformanceTier = {
  id: string;
  repository: {
    files: number;
    bytes: number;
    maxFileBytes?: number;
    languages: string[];
    languageMix?: PerformanceLanguageMix[];
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

export type PerformanceMetricDefinition = {
  metric: PerformanceMetric;
  eventSource: string;
  dimensions: string[];
  exclusions: string[];
  freshnessSeconds: number;
  qualityChecks: string[];
};

export type PerformanceContract = {
  version: string;
  percentileMethod: typeof PERFORMANCE_PERCENTILE_METHOD;
  metricDictionaryVersion?: string;
  tiers: PerformanceTier[];
  objectives: PerformanceObjective[];
  metricDictionary?: PerformanceMetricDefinition[];
};

export type PerformanceObservation = {
  id: string;
  tierId: string;
  metric: PerformanceMetric;
  mode: PerformanceMode;
  deploymentRevision: string;
  repositoryRevision: string;
  fixtureDigest: string;
  tierDefinitionDigest: string;
  observedConcurrency: number;
  durationMs: number;
  success: boolean;
  observedAt: string;
};

export type PerformanceResult = PerformanceObjective & {
  tierId: string;
  mode: PerformanceMode;
  concurrency: number;
  sampleCount: number;
  failureCount: number;
  observedP50Ms: number;
  observedP95Ms: number;
  observedP99Ms: number;
  ok: boolean;
};

export type PerformanceReport = {
  version: string;
  contractDigest: string;
  metricDictionaryVersion: string;
  metricDictionaryDigest: string;
  percentileMethod: typeof PERFORMANCE_PERCENTILE_METHOD;
  mode: PerformanceMode;
  deploymentRevision: string;
  repositoryRevision: string;
  fixtureDigest: string;
  evaluatedAt: string;
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

const METRICS: readonly PerformanceMetric[] = [
  "first_result",
  "complete_scan",
  "verification",
  "queue_wait",
  "campaign_fanout",
];

const REQUIRED_DIMENSIONS = [
  "deployment_revision",
  "repository_revision",
  "tier_id",
  "mode",
] as const;

const METRIC_DICTIONARY: PerformanceMetricDefinition[] = METRICS.map((metric) => ({
  metric,
  eventSource: `fettler.performance.${metric}`,
  dimensions: [...REQUIRED_DIMENSIONS],
  exclusions: ["operator_cancelled"],
  freshnessSeconds: 300,
  qualityChecks: [
    "finite_duration",
    "successful_terminal_state",
    "revision_bound",
  ],
}));

export const FETTLER_PERFORMANCE_CONTRACT: PerformanceContract = {
  version: PERFORMANCE_CONTRACT_VERSION,
  percentileMethod: PERFORMANCE_PERCENTILE_METHOD,
  metricDictionaryVersion: PERFORMANCE_METRIC_DICTIONARY_VERSION,
  tiers: [
    {
      id: "fettler-small",
      repository: {
        files: 5_000,
        bytes: 50_000_000,
        maxFileBytes: 1_000_000,
        languages: ["typescript"],
        languageMix: [{ language: "typescript", minimumPercent: 100 }],
      },
      concurrency: 2,
      minimumSamples: 100,
      loadDurationSeconds: 300,
      soakDurationSeconds: 3_600,
    },
    {
      id: "fettler-medium",
      repository: {
        files: 25_000,
        bytes: 500_000_000,
        maxFileBytes: 5_000_000,
        languages: ["javascript", "python", "typescript"],
        languageMix: [
          { language: "javascript", minimumPercent: 34 },
          { language: "python", minimumPercent: 33 },
          { language: "typescript", minimumPercent: 33 },
        ],
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
  metricDictionary: METRIC_DICTIONARY,
};

/** Compatibility export for runtime callers that have not migrated their import name. */
export const WARDEN_PERFORMANCE_CONTRACT = FETTLER_PERFORMANCE_CONTRACT;

const ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const REPOSITORY_REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const FIXTURE_DIGEST = /^[0-9a-f]{64}$/;
const DEPLOYMENT_REVISION = /^(?!main$|master$|latest$|head$)[a-zA-Z0-9][a-zA-Z0-9._-]{6,127}$/i;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: string): never {
  throw new Error(code);
}

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${field}_invalid`);
}

function duration(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) fail(`${field}_invalid`);
}

function isoTime(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(`${field}_invalid`);
  return parsed;
}

function uniqueIds(values: readonly string[], field: string): void {
  if (
    values.length === 0 ||
    values.some((value) => !ID.test(value)) ||
    new Set(values).size !== values.length
  ) {
    fail(`${field}_invalid`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function performanceTierDefinitionDigest(tier: PerformanceTier): string {
  return digest({
    id: tier.id,
    repository: tier.repository,
    concurrency: tier.concurrency,
    minimumSamples: tier.minimumSamples,
    loadDurationSeconds: tier.loadDurationSeconds,
    soakDurationSeconds: tier.soakDurationSeconds,
  });
}

function dictionaryFor(input: PerformanceContract): PerformanceMetricDefinition[] {
  if (input.version === LEGACY_PERFORMANCE_CONTRACT_VERSION && input.metricDictionary === undefined) {
    return METRIC_DICTIONARY;
  }
  return input.metricDictionary ?? fail("performance_metric_dictionary_incomplete");
}

function dictionaryVersionFor(input: PerformanceContract): string {
  if (input.version === LEGACY_PERFORMANCE_CONTRACT_VERSION && input.metricDictionaryVersion === undefined) {
    return PERFORMANCE_METRIC_DICTIONARY_VERSION;
  }
  if (input.metricDictionaryVersion !== PERFORMANCE_METRIC_DICTIONARY_VERSION) {
    fail("performance_metric_dictionary_version_invalid");
  }
  return input.metricDictionaryVersion;
}

export function metricDictionaryDigest(input: PerformanceContract): string {
  validatePerformanceContract(input);
  return digest({
    version: dictionaryVersionFor(input),
    definitions: dictionaryFor(input),
  });
}

export function performanceContractDigest(input: PerformanceContract): string {
  validatePerformanceContract(input);
  return digest(input);
}

export function validatePerformanceContract(input: PerformanceContract): PerformanceContract {
  if (
    input.version !== PERFORMANCE_CONTRACT_VERSION &&
    input.version !== LEGACY_PERFORMANCE_CONTRACT_VERSION
  ) {
    fail("performance_version_invalid");
  }
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
    uniqueIds(tier.repository.languages, "performance_tier_languages");
    if (input.version === PERFORMANCE_CONTRACT_VERSION) {
      positiveInteger(tier.repository.maxFileBytes ?? 0, "performance_tier_max_file_bytes");
      if (tier.repository.maxFileBytes! > tier.repository.bytes) {
        fail("performance_tier_max_file_bytes_invalid");
      }
      const mix = tier.repository.languageMix;
      if (!Array.isArray(mix) || mix.length !== tier.repository.languages.length) {
        fail("performance_tier_language_mix_invalid");
      }
      const mixLanguages = mix.map((entry) => entry.language);
      if (
        new Set(mixLanguages).size !== mixLanguages.length ||
        mixLanguages.some((language) => !tier.repository.languages.includes(language)) ||
        mix.some((entry) => !Number.isInteger(entry.minimumPercent) || entry.minimumPercent < 1) ||
        mix.reduce((sum, entry) => sum + entry.minimumPercent, 0) !== 100
      ) {
        fail("performance_tier_language_mix_invalid");
      }
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
  const dictionary = dictionaryFor(input);
  dictionaryVersionFor(input);
  if (!Array.isArray(dictionary) || dictionary.length !== METRICS.length) {
    fail("performance_metric_dictionary_incomplete");
  }
  const dictionaryMetrics = new Set<PerformanceMetric>();
  for (const definition of dictionary) {
    if (!METRICS.includes(definition.metric)) fail("performance_metric_dictionary_metric_invalid");
    if (dictionaryMetrics.has(definition.metric)) fail("performance_metric_dictionary_duplicate");
    dictionaryMetrics.add(definition.metric);
    if (!ID.test(definition.eventSource)) fail("performance_metric_event_source_invalid");
    uniqueIds(definition.dimensions, "performance_metric_dimensions");
    uniqueIds(definition.exclusions, "performance_metric_exclusions");
    uniqueIds(definition.qualityChecks, "performance_metric_quality_checks");
    positiveInteger(definition.freshnessSeconds, "performance_metric_freshness");
    if (REQUIRED_DIMENSIONS.some((dimension) => !definition.dimensions.includes(dimension))) {
      fail("performance_metric_dimensions_incomplete");
    }
  }
  if (METRICS.some((metric) => !dictionaryMetrics.has(metric))) {
    fail("performance_metric_dictionary_incomplete");
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
  evaluatedAt?: string,
): PerformanceReport {
  const contract = validatePerformanceContract(rawContract);
  if (mode !== "load" && mode !== "soak") fail("performance_mode_invalid");
  const knownTiers = new Map(contract.tiers.map((tier) => [tier.id, tier]));
  const observationIds = new Set<string>();
  const observationTimes: number[] = [];
  let deploymentRevision: string | undefined;
  let repositoryRevision: string | undefined;
  let fixtureDigest: string | undefined;
  for (const observation of observations) {
    if (!ID.test(observation.id)) fail("performance_observation_id_invalid");
    if (observationIds.has(observation.id)) fail("performance_observation_duplicate");
    observationIds.add(observation.id);
    const tier = knownTiers.get(observation.tierId);
    if (!tier) fail("performance_observation_tier_invalid");
    if (!METRICS.includes(observation.metric)) fail("performance_observation_metric_invalid");
    if (observation.mode !== mode) fail("performance_observation_mode_invalid");
    if (
      typeof observation.deploymentRevision !== "string" ||
      !DEPLOYMENT_REVISION.test(observation.deploymentRevision)
    ) {
      fail("performance_observation_deployment_revision_invalid");
    }
    if (
      typeof observation.repositoryRevision !== "string" ||
      !REPOSITORY_REVISION.test(observation.repositoryRevision)
    ) {
      fail("performance_observation_repository_revision_invalid");
    }
    if (
      typeof observation.fixtureDigest !== "string" ||
      !FIXTURE_DIGEST.test(observation.fixtureDigest)
    ) {
      fail("performance_observation_fixture_digest_invalid");
    }
    if (
      typeof observation.tierDefinitionDigest !== "string" ||
      !SHA256_DIGEST.test(observation.tierDefinitionDigest) ||
      observation.tierDefinitionDigest !== performanceTierDefinitionDigest(tier)
    ) {
      fail("performance_observation_tier_definition_mismatch");
    }
    positiveInteger(observation.observedConcurrency, "performance_observation_concurrency");
    if (observation.observedConcurrency > tier.concurrency) {
      fail("performance_observation_concurrency_invalid");
    }
    deploymentRevision ??= observation.deploymentRevision;
    repositoryRevision ??= observation.repositoryRevision;
    fixtureDigest ??= observation.fixtureDigest;
    if (
      observation.deploymentRevision !== deploymentRevision ||
      observation.repositoryRevision !== repositoryRevision ||
      observation.fixtureDigest !== fixtureDigest
    ) {
      fail("performance_observation_identity_mismatch");
    }
    duration(observation.durationMs, "performance_observation_duration");
    observationTimes.push(isoTime(observation.observedAt, "performance_observation_time"));
  }
  if (observationTimes.length === 0) fail("performance_observations_required");
  const evaluatedAtValue = evaluatedAt ?? new Date(Date.now()).toISOString();
  const evaluatedAtMs = isoTime(evaluatedAtValue, "performance_evaluated_at");
  const dictionary = new Map(dictionaryFor(contract).map((definition) => [definition.metric, definition]));
  for (let index = 0; index < observations.length; index += 1) {
    const ageMs = evaluatedAtMs - observationTimes[index]!;
    if (ageMs < 0) fail("performance_observation_future");
    const definition = dictionary.get(observations[index]!.metric)!;
    if (ageMs > definition.freshnessSeconds * 1_000) fail("performance_observation_stale");
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
      const observedConcurrency = Math.max(...samples.map((sample) => sample.observedConcurrency));
      if (observedConcurrency !== tier.concurrency) {
        fail("performance_observation_concurrency_incomplete");
      }
      const durations = samples.map((sample) => sample.durationMs);
      const p50Ms = nearestRank(durations, 0.5);
      const p95Ms = nearestRank(durations, 0.95);
      const p99Ms = nearestRank(durations, 0.99);
      const failureCount = samples.filter((sample) => !sample.success).length;
      results.push({
        tierId: tier.id,
        metric: objective.metric,
        mode,
        concurrency: observedConcurrency,
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
      compareText(left.tierId, right.tierId) || compareText(left.metric, right.metric),
  );
  return {
    version: contract.version,
    contractDigest: performanceContractDigest(contract),
    metricDictionaryVersion: dictionaryVersionFor(contract),
    metricDictionaryDigest: metricDictionaryDigest(contract),
    percentileMethod: PERFORMANCE_PERCENTILE_METHOD,
    mode,
    deploymentRevision: deploymentRevision!,
    repositoryRevision: repositoryRevision!,
    fixtureDigest: fixtureDigest!,
    evaluatedAt: evaluatedAtValue,
    ok: results.every((result) => result.ok),
    results,
  };
}
