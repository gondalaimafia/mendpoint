import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import {
  mkdirSync,
  linkSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import {
  evaluatePerformanceRun,
  resolvePerformanceTierId,
  validatePerformanceContract,
  WARDEN_PERFORMANCE_CONTRACT,
  type PerformanceContract,
  type PerformanceEvidenceBinding,
  type PerformanceMetric,
  type PerformanceMode,
  type PerformanceObservation,
  type PerformanceReport,
  type PerformanceTier,
} from "./performance-contract.js";

const METRICS: readonly PerformanceMetric[] = [
  "first_result",
  "complete_scan",
  "verification",
  "queue_wait",
  "campaign_fanout",
];
const REPOSITORY_REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const FIXTURE_DIGEST = /^[0-9a-f]{64}$/;
const DEPLOYMENT_REVISION = /^(?!main$|master$|latest$|head$)[a-zA-Z0-9][a-zA-Z0-9._-]{6,127}$/i;
export const PERFORMANCE_OBSERVATION_LIMIT = 10_000;
export const PERFORMANCE_PROBE_RESPONSE_BYTE_LIMIT = 1_048_576;

const PERFORMANCE_DESTINATION_BLOCK_LIST = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  PERFORMANCE_DESTINATION_BLOCK_LIST.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) {
  PERFORMANCE_DESTINATION_BLOCK_LIST.addSubnet(address, prefix, "ipv6");
}

export type PerformanceMetricMeasurement = Readonly<{
  durationMs: number;
  success: boolean;
}>;

export type PerformanceProbeMeasurement = Readonly<{
  observed: Readonly<{
    tenantId: string;
    repositoryId: string;
    repositoryRevision: string;
    deploymentRevision: string;
    fixtureDigest: string;
    correlationId: string;
    probeSource: string;
    repository: PerformanceEvidenceBinding["repository"];
  }>;
  metrics: Readonly<Record<PerformanceMetric, PerformanceMetricMeasurement>>;
}>;

export type PerformanceProbeContext = Readonly<{
  invocationId: string;
  sequence: number;
  mode: PerformanceMode;
  tier: PerformanceTier;
  repositoryRevision: string;
  deploymentRevision: string;
  fixtureDigest: string;
  tenantId: string;
  repositoryId: string;
  correlationId: string;
  source: string;
  repository: PerformanceEvidenceBinding["repository"];
  signal: AbortSignal;
}>;

export type PerformanceProbe = (
  context: PerformanceProbeContext,
) => Promise<PerformanceProbeMeasurement>;

export type PerformancePinnedRequest = (
  endpoint: URL,
  approvedAddress: string,
  init: RequestInit,
) => Promise<Response>;

export type PerformanceProbeReport = Readonly<{
  schemaVersion: 2;
  contractVersion: string;
  percentileMethod: string;
  repositoryRevision: string;
  deploymentRevision: string;
  fixtureDigest: string;
  tenantId: string;
  repositoryId: string;
  correlationId: string;
  source: string;
  dependencyVersions: Readonly<Record<string, string>>;
  tierId: string;
  mode: PerformanceMode;
  repository: PerformanceTier["repository"];
  measuredRepository: PerformanceEvidenceBinding["repository"] | null;
  concurrency: number;
  measuredConcurrency: number;
  minimumSamples: number;
  plannedDurationMs: number;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  status: "completed" | "incomplete" | "aborted";
  abortReason: string | null;
  cancelledInvocationCount: number;
  ok: boolean;
  observations: readonly PerformanceObservation[];
  evaluation: PerformanceReport | null;
}>;

export type RunPerformanceProbeOptions = Readonly<{
  contract?: PerformanceContract;
  tierId: string;
  mode: PerformanceMode;
  repositoryRevision: string;
  deploymentRevision: string;
  fixtureDigest: string;
  tenantId: string;
  repositoryId: string;
  correlationId: string;
  source: string;
  repository: PerformanceEvidenceBinding["repository"];
  dependencyVersions: Readonly<Record<string, string>>;
  probe: PerformanceProbe;
  signal?: AbortSignal;
  now?: () => number;
}>;

function invalid(code: string): never {
  throw new Error(code);
}

function abortReason(reason: unknown): string {
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  if (reason instanceof Error && reason.message) return reason.message;
  return "aborted";
}

function validateMetadata(options: RunPerformanceProbeOptions): void {
  if (!REPOSITORY_REVISION.test(options.repositoryRevision)) {
    invalid("performance_repository_revision_invalid");
  }
  if (!DEPLOYMENT_REVISION.test(options.deploymentRevision)) {
    invalid("performance_deployment_revision_invalid");
  }
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(options.fixtureDigest)) {
    invalid("performance_fixture_digest_invalid");
  }
  for (const [field, value] of [
    ["tenant_id", options.tenantId],
    ["repository_id", options.repositoryId],
    ["correlation_id", options.correlationId],
    ["source", options.source],
  ] as const) {
    if (!value || value.length > 256 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)) {
      invalid(`performance_${field}_invalid`);
    }
  }
  if (
    !Number.isSafeInteger(options.repository.files) || options.repository.files < 1 ||
    !Number.isSafeInteger(options.repository.sourceLines) || options.repository.sourceLines < 1 ||
    !Number.isSafeInteger(options.repository.bytes) || options.repository.bytes < 1 ||
    !Number.isSafeInteger(options.repository.maxFileBytes) || options.repository.maxFileBytes < 1 ||
    options.repository.maxFileBytes > options.repository.bytes ||
    options.repository.languages.length === 0
  ) {
    invalid("performance_repository_shape_invalid");
  }
  const dependencies = Object.entries(options.dependencyVersions);
  if (
    dependencies.length === 0 ||
    dependencies.some(([name, version]) => !name.trim() || !version.trim())
  ) {
    invalid("performance_dependency_versions_invalid");
  }
}

function normalizeFixtureDigest(value: string): string {
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function canonicalRepositoryShape(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const repository = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(repository.files) ||
    !Number.isSafeInteger(repository.sourceLines) ||
    !Number.isSafeInteger(repository.bytes) ||
    !Number.isSafeInteger(repository.maxFileBytes) ||
    !Array.isArray(repository.languages) ||
    repository.languages.some((language) => typeof language !== "string") ||
    !repository.languageSourceLines ||
    typeof repository.languageSourceLines !== "object" ||
    Array.isArray(repository.languageSourceLines)
  ) {
    return null;
  }
  const languageSourceLines = repository.languageSourceLines as Record<string, unknown>;
  if (Object.values(languageSourceLines).some((lines) => !Number.isSafeInteger(lines))) return null;
  return JSON.stringify({
    files: repository.files,
    sourceLines: repository.sourceLines,
    bytes: repository.bytes,
    maxFileBytes: repository.maxFileBytes,
    languages: [...repository.languages].sort(),
    languageSourceLines: Object.fromEntries(
      Object.entries(languageSourceLines).sort(([left], [right]) => left.localeCompare(right)),
    ),
  });
}

function validateMeasurement(
  measurement: PerformanceProbeMeasurement,
  expected: Pick<PerformanceProbeContext,
    "tenantId" | "repositoryId" | "repositoryRevision" | "deploymentRevision" |
    "fixtureDigest" | "correlationId" | "source" | "repository">,
): PerformanceEvidenceBinding["repository"] {
  if (!measurement || typeof measurement !== "object" || !measurement.metrics || !measurement.observed) {
    invalid("performance_probe_measurement_invalid");
  }
  const observed = measurement.observed;
  for (const [field, actual, wanted] of [
    ["tenant", observed.tenantId, expected.tenantId],
    ["repository", observed.repositoryId, expected.repositoryId],
    ["repository_revision", observed.repositoryRevision, expected.repositoryRevision],
    ["deployment_revision", observed.deploymentRevision, expected.deploymentRevision],
    ["fixture", normalizeFixtureDigest(observed.fixtureDigest), normalizeFixtureDigest(expected.fixtureDigest)],
    ["correlation", observed.correlationId, expected.correlationId],
    ["source", observed.probeSource, expected.source],
  ] as const) {
    if (actual !== wanted) invalid(`performance_probe_${field}_mismatch`);
  }
  if (
    canonicalRepositoryShape(observed.repository) === null ||
    canonicalRepositoryShape(observed.repository) !== canonicalRepositoryShape(expected.repository)
  ) {
    invalid("performance_probe_repository_shape_mismatch");
  }
  const keys = Object.keys(measurement.metrics);
  if (keys.length !== METRICS.length || keys.some((key) => !METRICS.includes(key as PerformanceMetric))) {
    invalid("performance_probe_metrics_incomplete");
  }
  for (const metric of METRICS) {
    const value = measurement.metrics[metric];
    if (
      !value ||
      !Number.isFinite(value.durationMs) ||
      value.durationMs <= 0 ||
      typeof value.success !== "boolean"
    ) {
      invalid("performance_probe_metric_invalid");
    }
  }
  return observed.repository;
}

function observedAt(now: () => number): string {
  return new Date(Math.max(0, now())).toISOString();
}

function recordInvocation(
  observations: PerformanceObservation[],
  tierId: string,
  mode: PerformanceMode,
  sequence: number,
  measurement: Pick<PerformanceProbeMeasurement, "metrics">,
  at: string,
  evidence: Pick<PerformanceEvidenceBinding,
    "tenantId" | "repositoryId" | "repositoryRevision" | "deploymentRevision" |
    "fixtureDigest" | "correlationId" | "source">,
  eventSources: ReadonlyMap<PerformanceMetric, string>,
  bindingSource: "probe_observed" | "request_context",
): boolean {
  if (observations.length + METRICS.length > PERFORMANCE_OBSERVATION_LIMIT) return false;
  for (const metric of METRICS) {
    const value = measurement.metrics[metric];
    observations.push({
      id: `${tierId}.${mode}.${String(sequence).padStart(8, "0")}.${metric}`,
      tierId,
      metric,
      mode,
      durationMs: value.durationMs,
      success: value.success,
      observedAt: at,
      tenantId: evidence.tenantId,
      repositoryId: evidence.repositoryId,
      repositoryRevision: evidence.repositoryRevision,
      deploymentRevision: evidence.deploymentRevision,
      fixtureDigest: evidence.fixtureDigest,
      correlationId: evidence.correlationId,
      source: evidence.source,
      eventSource: eventSources.get(metric),
      bindingSource,
    });
  }
  return true;
}

function failedMeasurement(durationMs: number): Pick<PerformanceProbeMeasurement, "metrics"> {
  return {
    metrics: Object.fromEntries(METRICS.map((metric) => [
      metric,
      { durationMs, success: false },
    ])) as PerformanceProbeMeasurement["metrics"],
  };
}

function hasMinimumSamples(
  observations: readonly PerformanceObservation[],
  minimumSamples: number,
): boolean {
  return METRICS.every(
    (metric) => observations.filter((item) => item.metric === metric).length >= minimumSamples,
  );
}

export async function runPerformanceProbe(
  options: RunPerformanceProbeOptions,
): Promise<PerformanceProbeReport> {
  validateMetadata(options);
  const contract = validatePerformanceContract(options.contract ?? WARDEN_PERFORMANCE_CONTRACT);
  const requestedTier = options.tierId.startsWith("pilot-")
    ? resolvePerformanceTierId(options.tierId)
    : options.tierId;
  const tier = contract.tiers.find((candidate) => candidate.id === requestedTier);
  if (!tier) invalid("performance_tier_not_found");
  if (options.mode !== "load" && options.mode !== "soak") invalid("performance_mode_invalid");

  const now = options.now ?? Date.now;
  const startedMs = now();
  const plannedDurationMs = (
    options.mode === "load" ? tier.loadDurationSeconds : tier.soakDurationSeconds
  ) * 1_000;
  const deadlineMs = startedMs + plannedDurationMs;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const deadlineTimer = setTimeout(
    () => controller.abort("duration_elapsed"),
    plannedDurationMs,
  );
  deadlineTimer.unref?.();

  const observations: PerformanceObservation[] = [];
  const evidenceIdentity = {
    tenantId: options.tenantId,
    repositoryId: options.repositoryId,
    repositoryRevision: options.repositoryRevision,
    deploymentRevision: options.deploymentRevision,
    fixtureDigest: normalizeFixtureDigest(options.fixtureDigest),
    correlationId: options.correlationId,
    source: options.source,
  } as const;
  let sequence = 0;
  let cancelledInvocationCount = 0;
  let activeInvocationCount = 0;
  let measuredConcurrency = 0;
  let observedRepository: PerformanceEvidenceBinding["repository"] | null = null;
  let unobservedFailure = false;
  let evidenceOverflow = false;
  let internalAbortReason: "probe_failure_unobserved" | "evidence_budget_exceeded" | "duration_elapsed" | null = null;
  const eventSources = new Map(
    (contract.metricDictionary ?? WARDEN_PERFORMANCE_CONTRACT.metricDictionary!).map(
      (definition) => [definition.metric, definition.eventSource],
    ),
  );
  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted && now() < deadlineMs) {
      const invocationSequence = sequence++;
      const invocationId = `${tier.id}.${options.mode}.${String(invocationSequence).padStart(8, "0")}`;
      const invocationStarted = now();
      activeInvocationCount += 1;
      measuredConcurrency = Math.max(measuredConcurrency, activeInvocationCount);
      try {
        const measurement = await options.probe({
          invocationId,
          sequence: invocationSequence,
          mode: options.mode,
          tier,
          repositoryRevision: options.repositoryRevision,
          deploymentRevision: options.deploymentRevision,
          fixtureDigest: options.fixtureDigest,
          tenantId: options.tenantId,
          repositoryId: options.repositoryId,
          correlationId: options.correlationId,
          source: options.source,
          repository: options.repository,
          signal: controller.signal,
        });
        const producerRepository = validateMeasurement(measurement, {
          tenantId: options.tenantId,
          repositoryId: options.repositoryId,
          repositoryRevision: options.repositoryRevision,
          deploymentRevision: options.deploymentRevision,
          fixtureDigest: options.fixtureDigest,
          correlationId: options.correlationId,
          source: options.source,
          repository: options.repository,
        });
        observedRepository ??= producerRepository;
        const recorded = recordInvocation(
          observations,
          tier.id,
          options.mode,
          invocationSequence,
          measurement,
          observedAt(now),
          evidenceIdentity,
          eventSources,
          "probe_observed",
        );
        if (!recorded) {
          evidenceOverflow = true;
          internalAbortReason = "evidence_budget_exceeded";
          controller.abort("evidence_budget_exceeded");
        }
      } catch {
        if (controller.signal.aborted || now() >= deadlineMs) {
          cancelledInvocationCount += 1;
          continue;
        }
        unobservedFailure = true;
        const recorded = recordInvocation(
          observations,
          tier.id,
          options.mode,
          invocationSequence,
          failedMeasurement(Math.max(1, now() - invocationStarted)),
          observedAt(now),
          evidenceIdentity,
          eventSources,
          "request_context",
        );
        if (!recorded) {
          evidenceOverflow = true;
          internalAbortReason = "evidence_budget_exceeded";
          controller.abort("evidence_budget_exceeded");
        } else {
          internalAbortReason = "probe_failure_unobserved";
          controller.abort("probe_failure_unobserved");
        }
      } finally {
        activeInvocationCount -= 1;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: tier.concurrency }, () => worker()));
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }

  observations.sort((left, right) => left.id.localeCompare(right.id));
  const endedMs = now();
  const externallyAborted = Boolean(options.signal?.aborted);
  const completeSamples = hasMinimumSamples(observations, tier.minimumSamples);
  const selectedTierContract: PerformanceContract = {
    ...contract,
    tiers: [tier],
    objectives: contract.objectives.filter((objective) =>
      objective.tierId === undefined || objective.tierId === tier.id,
    ),
  };
  const performanceEvidence: PerformanceEvidenceBinding = {
    tierId: tier.id,
    ...evidenceIdentity,
    repository: observedRepository ?? options.repository,
    measuredConcurrency,
    startedAt: new Date(Math.max(0, startedMs)).toISOString(),
    endedAt: new Date(Math.max(0, endedMs)).toISOString(),
  };
  const evaluation = !externallyAborted && !unobservedFailure && !evidenceOverflow && observedRepository && completeSamples
    ? evaluatePerformanceRun(selectedTierContract, observations, performanceEvidence, options.mode)
    : null;
  const status = externallyAborted
    ? "aborted"
    : completeSamples && observedRepository && !unobservedFailure && !evidenceOverflow
      ? "completed"
      : "incomplete";
  if (
    status === "incomplete" &&
    internalAbortReason === null &&
    controller.signal.aborted &&
    controller.signal.reason === "duration_elapsed"
  ) {
    internalAbortReason = "duration_elapsed";
  }

  return Object.freeze({
    schemaVersion: 2,
    contractVersion: contract.version,
    percentileMethod: contract.percentileMethod,
    repositoryRevision: options.repositoryRevision,
    deploymentRevision: options.deploymentRevision,
    fixtureDigest: evidenceIdentity.fixtureDigest,
    tenantId: options.tenantId,
    repositoryId: options.repositoryId,
    correlationId: options.correlationId,
    source: options.source,
    dependencyVersions: Object.freeze(
      Object.fromEntries(Object.entries(options.dependencyVersions).sort(([left], [right]) => left.localeCompare(right))),
    ),
    tierId: tier.id,
    mode: options.mode,
    repository: tier.repository,
    measuredRepository: observedRepository,
    concurrency: tier.concurrency,
    measuredConcurrency,
    minimumSamples: tier.minimumSamples,
    plannedDurationMs,
    startedAt: new Date(Math.max(0, startedMs)).toISOString(),
    endedAt: new Date(Math.max(0, endedMs)).toISOString(),
    elapsedMs: Math.max(0, endedMs - startedMs),
    status,
    abortReason: externallyAborted ? abortReason(options.signal?.reason) : internalAbortReason,
    cancelledInvocationCount,
    ok: status === "completed" && evaluation?.ok === true,
    observations: Object.freeze(observations),
    evaluation,
  });
}

function normalizeDestinationAddress(value: string): string {
  const address = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (address.includes("%") || address.toLowerCase().startsWith("::ffff:")) {
    throw new Error("performance_probe_destination_blocked");
  }
  const family = isIP(address);
  if (family === 0) throw new Error("performance_probe_destination_invalid");
  if (PERFORMANCE_DESTINATION_BLOCK_LIST.check(address, family === 4 ? "ipv4" : "ipv6")) {
    throw new Error("performance_probe_destination_blocked");
  }
  return address;
}

async function resolvePerformanceDestination(hostname: string): Promise<readonly string[]> {
  const literal = isIP(hostname);
  if (literal !== 0) return [hostname];
  try {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    return answers.map((answer) => answer.address);
  } catch {
    throw new Error("performance_probe_destination_unresolved");
  }
}

function responseHeaders(source: Readonly<Record<string, string | readonly string[] | undefined>>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string") {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    }
  }
  return headers;
}

const pinnedHttpsPerformanceRequest: PerformancePinnedRequest = async (
  endpoint,
  approvedAddress,
  init,
) => new Promise<Response>((resolveResponse, rejectResponse) => {
  const family = isIP(approvedAddress);
  if (family !== 4 && family !== 6) {
    rejectResponse(new Error("performance_probe_destination_invalid"));
    return;
  }
  const pinnedLookup = ((
    _hostname: string,
    _options: unknown,
    callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ) => callback(null, approvedAddress, family)) as LookupFunction;
  const request = httpsRequest(endpoint, {
    agent: false,
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    lookup: pinnedLookup,
    method: init.method,
    signal: init.signal ?? undefined,
  }, (incoming) => {
    const status = incoming.statusCode ?? 502;
    const body = status === 204 || status === 205 || status === 304
      ? null
      : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
    resolveResponse(new Response(body, {
      headers: responseHeaders(incoming.headers),
      status,
    }));
  });
  request.once("error", rejectResponse);
  if (typeof init.body === "string" || init.body instanceof Uint8Array) request.write(init.body);
  else if (init.body !== null && init.body !== undefined) {
    request.destroy(new Error("performance_probe_request_body_invalid"));
    return;
  }
  request.end();
});

export function createHttpPerformanceProbe(options: Readonly<{
  endpoint: string;
  approvedDestination?: string;
  bearerToken?: string;
  resolveHostname?: (hostname: string) => Promise<readonly string[]>;
  pinnedRequest?: PerformancePinnedRequest;
}>): PerformanceProbe {
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(options.endpoint);
  } catch {
    throw new Error("performance_probe_url_invalid");
  }
  if (parsedEndpoint.username || parsedEndpoint.password) {
    throw new Error("performance_probe_url_credentials_forbidden");
  }
  if (parsedEndpoint.hash) throw new Error("performance_probe_url_fragment_forbidden");
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(parsedEndpoint.hostname);
  if (parsedEndpoint.protocol !== "https:" && !(
    parsedEndpoint.protocol === "http:" && loopback && !options.bearerToken
  )) {
    throw new Error("performance_probe_https_required");
  }
  const endpoint = parsedEndpoint.toString();
  if (options.bearerToken) {
    if (!options.approvedDestination) {
      throw new Error("performance_probe_approved_destination_required");
    }
    let approvedDestination: URL;
    try {
      approvedDestination = new URL(options.approvedDestination);
    } catch {
      throw new Error("performance_probe_approved_destination_mismatch");
    }
    if (
      approvedDestination.username || approvedDestination.password || approvedDestination.hash ||
      approvedDestination.toString() !== endpoint
    ) {
      throw new Error("performance_probe_approved_destination_mismatch");
    }
  }
  const resolveHostname = options.resolveHostname ?? resolvePerformanceDestination;
  const pinnedRequest = options.pinnedRequest ?? pinnedHttpsPerformanceRequest;
  const endpointHostname = parsedEndpoint.hostname.startsWith("[") && parsedEndpoint.hostname.endsWith("]")
    ? parsedEndpoint.hostname.slice(1, -1)
    : parsedEndpoint.hostname;
  return async (context) => {
    const init: RequestInit = {
      method: "POST",
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
        "content-type": "application/json",
        ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
      },
      body: JSON.stringify({
        schemaVersion: 2,
        invocationId: context.invocationId,
        tenantId: context.tenantId,
        repositoryId: context.repositoryId,
        correlationId: context.correlationId,
        source: context.source,
        repository: context.repository,
        mode: context.mode,
        tier: context.tier,
        repositoryRevision: context.repositoryRevision,
        deploymentRevision: context.deploymentRevision,
        fixtureDigest: context.fixtureDigest,
      }),
      redirect: "error",
      signal: context.signal,
    };
    let response: Response;
    if (parsedEndpoint.protocol === "http:" && loopback) {
      response = await globalThis.fetch(endpoint, init);
    } else {
      const resolved = await resolveHostname(endpointHostname);
      if (resolved.length === 0) throw new Error("performance_probe_destination_unresolved");
      const approvedAddresses = resolved.map(normalizeDestinationAddress);
      response = await pinnedRequest(parsedEndpoint, approvedAddresses[0]!, init);
    }
    if (!response.ok) throw new Error(`performance_probe_http_${response.status}`);
    const responseBytes = await readBoundedPerformanceResponse(response);
    let payload: { observed?: unknown; metrics?: unknown };
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes)) as {
        observed?: unknown;
        metrics?: unknown;
      };
    } catch {
      throw new Error("performance_probe_response_invalid");
    }
    const measurement = { observed: payload.observed, metrics: payload.metrics } as PerformanceProbeMeasurement;
    validateMeasurement(measurement, context);
    return measurement;
  };
}

async function readBoundedPerformanceResponse(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
      throw new Error("performance_probe_response_length_invalid");
    }
    const declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes)) {
      throw new Error("performance_probe_response_length_invalid");
    }
    if (declaredBytes > PERFORMANCE_PROBE_RESPONSE_BYTE_LIMIT) {
      throw new Error("performance_probe_response_too_large");
    }
  }
  if (!response.body) throw new Error("performance_probe_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > PERFORMANCE_PROBE_RESPONSE_BYTE_LIMIT) {
        await reader.cancel("performance_probe_response_too_large").catch(() => undefined);
        throw new Error("performance_probe_response_too_large");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "performance_probe_response_too_large") throw error;
    throw new Error("performance_probe_response_invalid");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function persistPerformanceProbeReport(
  path: string,
  report: PerformanceProbeReport,
): string {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(temporary, bytes, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    linkSync(temporary, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const existing = readFileSync(target, "utf8");
      if (existing === bytes) return target;
      throw new Error("performance_report_conflict");
    }
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
  return target;
}

function option(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function repositoryRevision(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function dependencyVersions(lockPath: string): Record<string, string> {
  const source = readFileSync(lockPath, "utf8");
  const lock = JSON.parse(source) as {
    packages?: Record<string, { version?: string }>;
  };
  const entries = Object.entries(lock.packages ?? {})
    .filter(([locator, value]) => locator.includes("node_modules/") && value.version)
    .map(([locator, value]) => [locator, value.version!] as const);
  return Object.fromEntries([
    ["node", process.version],
    ["package-lock.sha256", createHash("sha256").update(source).digest("hex")],
    ...entries,
  ]);
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort("operator_signal");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const report = await runPerformanceCli(process.argv.slice(2), { signal: controller.signal });
    console.log(`Performance report ${resolve(option(process.argv.slice(2), "output")!)}`);
    console.log(`${report.tierId} ${report.mode}: ${report.status}, ${report.observations.length} observations`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export async function runPerformanceCli(
  args: readonly string[],
  dependencies: Readonly<{
    contract?: PerformanceContract;
    defaultRepositoryRevision?: string;
    dependencyVersions?: Readonly<Record<string, string>>;
    probe?: PerformanceProbe;
    signal?: AbortSignal;
    now?: () => number;
  }> = {},
): Promise<PerformanceProbeReport> {
  const explicitRevision = option(args, "repository-revision");
  const parsed = parsePerformanceCliArguments(
    args,
    dependencies.defaultRepositoryRevision ?? (explicitRevision ? undefined : repositoryRevision()),
  );
  const { endpoint, output, ...probeOptions } = parsed;
  const report = await runPerformanceProbe({
    ...probeOptions,
    ...(dependencies.contract === undefined ? {} : { contract: dependencies.contract }),
    dependencyVersions: dependencies.dependencyVersions ?? dependencyVersions(resolve("package-lock.json")),
    probe: dependencies.probe ?? createHttpPerformanceProbe({
      endpoint,
      approvedDestination: process.env.MENDPOINT_PERFORMANCE_APPROVED_DESTINATION,
      bearerToken: process.env.MENDPOINT_PERFORMANCE_BEARER_TOKEN,
    }),
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  persistPerformanceProbeReport(output, report);
  return report;
}

export function parsePerformanceCliArguments(
  args: readonly string[],
  defaultRepositoryRevision?: string,
): Omit<RunPerformanceProbeOptions, "dependencyVersions" | "probe" | "signal" | "now" | "contract"> & Readonly<{
  endpoint: string;
  output: string;
}> {
  const mode = option(args, "mode") as PerformanceMode | undefined;
  const tierId = option(args, "tier");
  const endpoint = option(args, "endpoint");
  const deploymentRevision = option(args, "deployment-revision");
  const fixtureDigest = option(args, "fixture-digest");
  const output = option(args, "output");
  const tenantId = option(args, "tenant-id");
  const repositoryId = option(args, "repository-id");
  const correlationId = option(args, "correlation-id");
  const source = option(args, "probe-source") ?? option(args, "source");
  const explicitRepositoryRevision = option(args, "repository-revision");
  const repositoryFiles = Number(option(args, "repository-files"));
  const repositorySourceLines = Number(option(args, "repository-source-lines"));
  const repositoryBytes = Number(option(args, "repository-bytes"));
  const repositoryMaxFileBytes = Number(option(args, "repository-max-file-bytes"));
  const repositoryLanguages = option(args, "repository-languages")?.split(",").map((value) => value.trim()).filter(Boolean);
  const distribution = option(args, "repository-language-source-lines");
  if (
    (mode !== "load" && mode !== "soak") || !tierId || !endpoint || !deploymentRevision || !fixtureDigest || !output ||
    !tenantId || !repositoryId || !correlationId || !source || !repositoryLanguages?.length || !distribution ||
    !(explicitRepositoryRevision ?? defaultRepositoryRevision)
  ) {
    throw new Error(
      "usage: --mode=load|soak --tier=<tier> --endpoint=<url> " +
      "--tenant-id=<tenant> --repository-id=<repository> --correlation-id=<correlation> " +
      "--probe-source=<source> --repository-revision=<immutable-id> " +
      "--repository-files=<count> --repository-source-lines=<count> " +
      "--repository-bytes=<count> --repository-max-file-bytes=<count> " +
      "--repository-languages=<comma-list> " +
      "--repository-language-source-lines=<language:count,...> " +
      "--deployment-revision=<immutable-id> --fixture-digest=<sha256> --output=<path>",
    );
  }
  const languageSourceLines: Record<string, number> = {};
  for (const entry of distribution.split(",")) {
    const [language, rawLines, ...rest] = entry.split(":");
    const lines = Number(rawLines);
    if (!language || rest.length || language in languageSourceLines || !Number.isSafeInteger(lines) || lines < 1) {
      invalid("performance_repository_language_distribution_invalid");
    }
    languageSourceLines[language] = lines;
  }
  if (
    !Number.isSafeInteger(repositoryFiles) || repositoryFiles < 1 ||
    !Number.isSafeInteger(repositorySourceLines) || repositorySourceLines < 1 ||
    !Number.isSafeInteger(repositoryBytes) || repositoryBytes < 1 ||
    !Number.isSafeInteger(repositoryMaxFileBytes) || repositoryMaxFileBytes < 1 ||
    repositoryMaxFileBytes > repositoryBytes ||
    Object.keys(languageSourceLines).length !== repositoryLanguages.length ||
    repositoryLanguages.some((language) => !(language in languageSourceLines)) ||
    Object.values(languageSourceLines).reduce((sum, lines) => sum + lines, 0) !== repositorySourceLines
  ) invalid("performance_repository_language_distribution_invalid");
  return {
    mode, tierId, endpoint, deploymentRevision, fixtureDigest, output, tenantId,
    repositoryId, correlationId, source,
    repositoryRevision: explicitRepositoryRevision ?? defaultRepositoryRevision!,
    repository: {
      files: repositoryFiles,
      sourceLines: repositorySourceLines,
      bytes: repositoryBytes,
      maxFileBytes: repositoryMaxFileBytes,
      languages: repositoryLanguages,
      languageSourceLines,
    },
  };
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("performance-runner.ts") ||
  process.argv[1]?.replace(/\\/g, "/").endsWith("performance-runner.js");
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
