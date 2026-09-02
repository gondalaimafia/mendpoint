import { createHash } from "node:crypto";

export const PERFORMANCE_CONTRACT_VERSION = "2026-09-02.v3" as const;
export const PERFORMANCE_METRIC_DICTIONARY_VERSION = "2026-09-02.v1" as const;
export const PERFORMANCE_PERCENTILE_METHOD = "nearest_rank_v1" as const;

const LEGACY_PERFORMANCE_CONTRACT_VERSIONS = new Set([
  "2026-08-02.v1",
  "2026-09-02.v2",
]);

export const FETTLER_PERFORMANCE_TIER_IDS = ["small", "medium", "large"] as const;
export type FettlerPerformanceTierId = typeof FETTLER_PERFORMANCE_TIER_IDS[number];

const LEGACY_TIER_ALIASES: Readonly<Record<string, FettlerPerformanceTierId>> = Object.freeze({
  "pilot-small": "small",
  "pilot-medium": "medium",
  "pilot-large": "large",
});

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
    minimumFiles?: number;
    files: number;
    minimumSourceLines?: number;
    sourceLines?: number;
    minimumBytes?: number;
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
  tierId?: string;
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
  durationMs: number;
  success: boolean;
  observedAt: string;
  tenantId?: string;
  repositoryId?: string;
  repositoryRevision?: string;
  deploymentRevision?: string;
  fixtureDigest?: string;
  correlationId?: string;
  source?: string;
  eventSource?: string;
  bindingSource?: "probe_observed" | "request_context";
};

export type PerformanceEvidenceBinding = Readonly<{
  tierId: string;
  tenantId: string;
  repositoryId: string;
  repositoryRevision: string;
  deploymentRevision: string;
  fixtureDigest: string;
  correlationId: string;
  source: string;
  repository: Readonly<{
    files: number;
    sourceLines: number;
    bytes: number;
    languages: readonly string[];
    languageSourceLines?: Readonly<Record<string, number>>;
  }>;
  measuredConcurrency: number;
  startedAt: string;
  endedAt: string;
}>;

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
  evaluatedAt: string;
  evidence: PerformanceEvidenceBinding;
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
  "tenant_id",
  "repository_id",
  "deployment_revision",
  "repository_revision",
  "fixture_digest",
  "correlation_id",
  "probe_source",
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
      id: "small",
      repository: {
        minimumFiles: 1_000,
        files: 2_000,
        minimumSourceLines: 50_000,
        sourceLines: 100_000,
        minimumBytes: 25_000_000,
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
      id: "medium",
      repository: {
        minimumFiles: 10_000,
        files: 20_000,
        minimumSourceLines: 500_000,
        sourceLines: 1_000_000,
        minimumBytes: 250_000_000,
        bytes: 500_000_000,
        maxFileBytes: 5_000_000,
        languages: ["javascript", "python", "typescript"],
        languageMix: [
          { language: "javascript", minimumPercent: 20 },
          { language: "python", minimumPercent: 20 },
          { language: "typescript", minimumPercent: 20 },
        ],
      },
      concurrency: 4,
      minimumSamples: 100,
      loadDurationSeconds: 600,
      soakDurationSeconds: 7_200,
    },
    {
      id: "large",
      repository: {
        minimumFiles: 50_000,
        files: 100_000,
        minimumSourceLines: 2_500_000,
        sourceLines: 5_000_000,
        minimumBytes: 1_250_000_000,
        bytes: 2_500_000_000,
        maxFileBytes: 10_000_000,
        languages: ["go", "java", "javascript", "python", "ruby", "typescript"],
        languageMix: [
          { language: "go", minimumPercent: 10 },
          { language: "java", minimumPercent: 10 },
          { language: "javascript", minimumPercent: 10 },
          { language: "python", minimumPercent: 10 },
          { language: "ruby", minimumPercent: 10 },
          { language: "typescript", minimumPercent: 10 },
        ],
      },
      concurrency: 8,
      minimumSamples: 100,
      loadDurationSeconds: 900,
      soakDurationSeconds: 14_400,
    },
  ],
  objectives: [
    { tierId: "small", metric: "first_result", p50Ms: 30_000, p95Ms: 90_000, p99Ms: 180_000 },
    { tierId: "small", metric: "complete_scan", p50Ms: 120_000, p95Ms: 300_000, p99Ms: 480_000 },
    { tierId: "small", metric: "verification", p50Ms: 300_000, p95Ms: 900_000, p99Ms: 1_500_000 },
    { tierId: "small", metric: "queue_wait", p50Ms: 5_000, p95Ms: 30_000, p99Ms: 60_000 },
    { tierId: "small", metric: "campaign_fanout", p50Ms: 30_000, p95Ms: 120_000, p99Ms: 300_000 },
    { tierId: "medium", metric: "first_result", p50Ms: 90_000, p95Ms: 240_000, p99Ms: 480_000 },
    { tierId: "medium", metric: "complete_scan", p50Ms: 600_000, p95Ms: 1_500_000, p99Ms: 2_400_000 },
    { tierId: "medium", metric: "verification", p50Ms: 900_000, p95Ms: 2_400_000, p99Ms: 3_600_000 },
    { tierId: "medium", metric: "queue_wait", p50Ms: 10_000, p95Ms: 60_000, p99Ms: 120_000 },
    { tierId: "medium", metric: "campaign_fanout", p50Ms: 60_000, p95Ms: 240_000, p99Ms: 600_000 },
    { tierId: "large", metric: "first_result", p50Ms: 240_000, p95Ms: 600_000, p99Ms: 1_200_000 },
    { tierId: "large", metric: "complete_scan", p50Ms: 2_100_000, p95Ms: 4_500_000, p99Ms: 7_200_000 },
    { tierId: "large", metric: "verification", p50Ms: 2_700_000, p95Ms: 7_200_000, p99Ms: 10_800_000 },
    { tierId: "large", metric: "queue_wait", p50Ms: 30_000, p95Ms: 120_000, p99Ms: 300_000 },
    { tierId: "large", metric: "campaign_fanout", p50Ms: 120_000, p95Ms: 600_000, p99Ms: 1_200_000 },
  ],
  metricDictionary: METRIC_DICTIONARY,
};

/** Compatibility export for runtime callers that have not migrated their import name. */
export const WARDEN_PERFORMANCE_CONTRACT = FETTLER_PERFORMANCE_CONTRACT;

export function resolvePerformanceTierId(input: string): FettlerPerformanceTierId {
  const normalized = input.trim().toLowerCase();
  const canonical = LEGACY_TIER_ALIASES[normalized] ?? normalized;
  if (!FETTLER_PERFORMANCE_TIER_IDS.includes(canonical as FettlerPerformanceTierId)) {
    fail("performance_tier_not_found");
  }
  return canonical as FettlerPerformanceTierId;
}

const ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

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

function dictionaryFor(input: PerformanceContract): PerformanceMetricDefinition[] {
  if (LEGACY_PERFORMANCE_CONTRACT_VERSIONS.has(input.version) && input.metricDictionary === undefined) {
    return METRIC_DICTIONARY;
  }
  return input.metricDictionary ?? fail("performance_metric_dictionary_incomplete");
}

function dictionaryVersionFor(input: PerformanceContract): string {
  if (LEGACY_PERFORMANCE_CONTRACT_VERSIONS.has(input.version) && input.metricDictionaryVersion === undefined) {
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
    !LEGACY_PERFORMANCE_CONTRACT_VERSIONS.has(input.version)
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
      positiveInteger(tier.repository.sourceLines ?? 0, "performance_tier_source_lines");
      positiveInteger(tier.repository.minimumFiles ?? 0, "performance_tier_minimum_files");
      positiveInteger(tier.repository.minimumSourceLines ?? 0, "performance_tier_minimum_source_lines");
      positiveInteger(tier.repository.minimumBytes ?? 0, "performance_tier_minimum_bytes");
      if (
        tier.repository.minimumFiles! > tier.repository.files ||
        tier.repository.minimumSourceLines! > tier.repository.sourceLines! ||
        tier.repository.minimumBytes! > tier.repository.bytes
      ) fail("performance_tier_repository_range_invalid");
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
        mix.reduce((sum, entry) => sum + entry.minimumPercent, 0) > 100
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
  const expectedObjectiveCount = input.version === PERFORMANCE_CONTRACT_VERSION
    ? input.tiers.length * METRICS.length
    : METRICS.length;
  if (!Array.isArray(input.objectives) || input.objectives.length !== expectedObjectiveCount) {
    fail("performance_objectives_incomplete");
  }
  const objectiveKeys = new Set<string>();
  for (const objective of input.objectives) {
    if (!METRICS.includes(objective.metric)) fail("performance_objective_metric_invalid");
    const tierId = input.version === PERFORMANCE_CONTRACT_VERSION
      ? objective.tierId ?? fail("performance_objective_tier_required")
      : objective.tierId ?? "legacy";
    if (input.version === PERFORMANCE_CONTRACT_VERSION && !tierIds.has(tierId)) {
      fail("performance_objective_tier_invalid");
    }
    const key = `${tierId}:${objective.metric}`;
    if (objectiveKeys.has(key)) fail("performance_objective_duplicate");
    objectiveKeys.add(key);
    positiveInteger(objective.p50Ms, "performance_objective_p50");
    positiveInteger(objective.p95Ms, "performance_objective_p95");
    positiveInteger(objective.p99Ms, "performance_objective_p99");
    if (objective.p50Ms > objective.p95Ms || objective.p95Ms > objective.p99Ms) {
      fail("performance_objective_order_invalid");
    }
  }
  for (const tier of input.tiers) {
    const tierKey = input.version === PERFORMANCE_CONTRACT_VERSION ? tier.id : "legacy";
    if (METRICS.some((metric) => !objectiveKeys.has(`${tierKey}:${metric}`))) {
      fail("performance_objectives_incomplete");
    }
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

const REVISION = /^(?!main$|master$|latest$|head$)[a-zA-Z0-9][a-zA-Z0-9._-]{6,127}$/i;
const FIXTURE_DIGEST = /^sha256:[a-f0-9]{64}$/;

function requiredEvidenceId(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)
  ) {
    fail(`${field}_invalid`);
  }
}

function validateEvidenceBinding(
  contract: PerformanceContract,
  evidence: PerformanceEvidenceBinding,
  mode: PerformanceMode,
): { tier: PerformanceTier; startedAtMs: number; endedAtMs: number } {
  if (!evidence || typeof evidence !== "object") fail("performance_evidence_binding_required");
  requiredEvidenceId(evidence.tenantId, "performance_tenant_id");
  requiredEvidenceId(evidence.repositoryId, "performance_repository_id");
  requiredEvidenceId(evidence.correlationId, "performance_correlation_id");
  requiredEvidenceId(evidence.source, "performance_source");
  if (!REVISION.test(evidence.repositoryRevision)) fail("performance_repository_revision_invalid");
  if (!REVISION.test(evidence.deploymentRevision)) fail("performance_deployment_revision_invalid");
  if (!FIXTURE_DIGEST.test(evidence.fixtureDigest)) fail("performance_fixture_digest_invalid");
  const tier = contract.tiers.find((candidate) => candidate.id === evidence.tierId);
  if (!tier) fail("performance_evidence_tier_invalid");
  positiveInteger(evidence.repository.files, "performance_repository_files");
  positiveInteger(evidence.repository.sourceLines, "performance_repository_source_lines");
  positiveInteger(evidence.repository.bytes, "performance_repository_bytes");
  uniqueIds([...evidence.repository.languages], "performance_repository_languages");
  const languageSourceLines = evidence.repository.languageSourceLines;
  if (contract.version === PERFORMANCE_CONTRACT_VERSION) {
    if (
      evidence.repository.files < tier.repository.minimumFiles! ||
      evidence.repository.sourceLines < tier.repository.minimumSourceLines! ||
      evidence.repository.bytes < tier.repository.minimumBytes!
    ) fail("performance_repository_shape_below_tier");
    if (!languageSourceLines || typeof languageSourceLines !== "object") {
      fail("performance_repository_language_distribution_invalid");
    }
    const distributionEntries = Object.entries(languageSourceLines);
    const declaredLanguages = new Set(evidence.repository.languages);
    if (
      distributionEntries.length !== tier.repository.languages.length ||
      declaredLanguages.size !== distributionEntries.length ||
      distributionEntries.some(([language]) => !declaredLanguages.has(language)) ||
      distributionEntries.some(([language, lines]) =>
        !tier.repository.languages.includes(language) || !Number.isSafeInteger(lines) || lines < 1) ||
      distributionEntries.reduce((sum, [, lines]) => sum + lines, 0) !== evidence.repository.sourceLines ||
      tier.repository.languageMix!.some(({ language, minimumPercent }) =>
        ((languageSourceLines[language] ?? 0) * 100) / evidence.repository.sourceLines < minimumPercent)
    ) fail("performance_repository_language_distribution_invalid");
  }
  if (
    evidence.repository.files > tier.repository.files ||
    evidence.repository.sourceLines > (tier.repository.sourceLines ?? Number.MAX_SAFE_INTEGER) ||
    evidence.repository.bytes > tier.repository.bytes ||
    evidence.repository.languages.length > tier.repository.languages.length ||
    evidence.repository.languages.some((language) => !tier.repository.languages.includes(language))
  ) {
    fail("performance_repository_shape_exceeds_tier");
  }
  if (evidence.measuredConcurrency !== tier.concurrency) {
    fail("performance_measured_concurrency_mismatch");
  }
  const startedAtMs = isoTime(evidence.startedAt, "performance_run_started_at");
  const endedAtMs = isoTime(evidence.endedAt, "performance_run_ended_at");
  const minimumDurationMs = (
    mode === "load" ? tier.loadDurationSeconds : tier.soakDurationSeconds
  ) * 1_000;
  if (endedAtMs <= startedAtMs || endedAtMs - startedAtMs < minimumDurationMs) {
    fail("performance_run_duration_incomplete");
  }
  return { tier, startedAtMs, endedAtMs };
}

export function evaluatePerformanceRun(
  rawContract: PerformanceContract,
  observations: readonly PerformanceObservation[],
  evidence: PerformanceEvidenceBinding,
  mode: PerformanceMode = "load",
  evaluatedAt?: string,
): PerformanceReport {
  const contract = validatePerformanceContract(rawContract);
  if (mode !== "load" && mode !== "soak") fail("performance_mode_invalid");
  const { tier, startedAtMs, endedAtMs } = validateEvidenceBinding(contract, evidence, mode);
  const dictionary = new Map(dictionaryFor(contract).map((definition) => [definition.metric, definition]));
  const observationIds = new Set<string>();
  const observationTimes: number[] = [];
  for (const observation of observations) {
    if (!ID.test(observation.id)) fail("performance_observation_id_invalid");
    if (observationIds.has(observation.id)) fail("performance_observation_duplicate");
    observationIds.add(observation.id);
    if (observation.tierId !== tier.id) fail("performance_observation_tier_invalid");
    if (!METRICS.includes(observation.metric)) fail("performance_observation_metric_invalid");
    if (observation.mode !== mode) fail("performance_observation_mode_invalid");
    if (!Number.isFinite(observation.durationMs) || observation.durationMs <= 0) {
      fail("performance_observation_duration_invalid");
    }
    if (typeof observation.success !== "boolean") fail("performance_observation_success_invalid");
    if (observation.tenantId !== evidence.tenantId) fail("performance_observation_tenant_mismatch");
    if (observation.repositoryId !== evidence.repositoryId) fail("performance_observation_repository_mismatch");
    if (observation.repositoryRevision !== evidence.repositoryRevision) {
      fail("performance_observation_repository_revision_mismatch");
    }
    if (observation.deploymentRevision !== evidence.deploymentRevision) {
      fail("performance_observation_deployment_revision_mismatch");
    }
    if (observation.fixtureDigest !== evidence.fixtureDigest) fail("performance_observation_fixture_mismatch");
    if (observation.correlationId !== evidence.correlationId) {
      fail("performance_observation_correlation_mismatch");
    }
    if (observation.source !== evidence.source) fail("performance_observation_source_mismatch");
    const definition = dictionaryFor(contract).find((item) => item.metric === observation.metric)!;
    if (observation.eventSource !== definition.eventSource) {
      fail("performance_observation_event_source_mismatch");
    }
    if (observation.bindingSource !== "probe_observed") {
      fail("performance_observation_binding_unobserved");
    }
    const observedAtMs = isoTime(observation.observedAt, "performance_observation_time");
    if (observedAtMs < startedAtMs || observedAtMs > endedAtMs) {
      fail("performance_observation_outside_run");
    }
    observationTimes.push(observedAtMs);
  }
  if (observationTimes.length === 0) fail("performance_observations_required");
  const evaluatedAtValue = evaluatedAt ?? (
    new Date(endedAtMs).toISOString()
  );
  const evaluatedAtMs = isoTime(evaluatedAtValue, "performance_evaluated_at");
  if (evaluatedAtMs < endedAtMs) fail("performance_evaluated_before_run_end");
  observations.forEach((observation, index) => {
    const ageMs = evaluatedAtMs - observationTimes[index]!;
    if (ageMs < 0) fail("performance_observation_future");
    const definition = dictionary.get(observation.metric)!;
    if (ageMs > definition.freshnessSeconds * 1_000) fail("performance_observation_stale");
  });

  const results: PerformanceReport["results"] = [];
  const objectives = contract.objectives.filter((objective) =>
    contract.version === PERFORMANCE_CONTRACT_VERSION
      ? objective.tierId === tier.id
      : true,
  );
  for (const objective of objectives) {
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
        concurrency: tier.concurrency,
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
    evaluatedAt: evaluatedAtValue,
    evidence: Object.freeze({
      ...evidence,
      repository: Object.freeze({
        ...evidence.repository,
        languages: Object.freeze([...evidence.repository.languages]),
        languageSourceLines: evidence.repository.languageSourceLines === undefined
          ? undefined
          : Object.freeze({ ...evidence.repository.languageSourceLines }),
      }),
    }),
    ok: results.every((result) => result.ok),
    results,
  };
}
