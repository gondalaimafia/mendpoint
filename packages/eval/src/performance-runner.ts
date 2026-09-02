import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  evaluatePerformanceRun,
  performanceTierDefinitionDigest,
  validatePerformanceContract,
  WARDEN_PERFORMANCE_CONTRACT,
  type PerformanceContract,
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

export type PerformanceMetricMeasurement = Readonly<{
  durationMs: number;
  success: boolean;
}>;

export type PerformanceProbeMeasurement = Readonly<{
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
  signal: AbortSignal;
}>;

export type PerformanceProbe = (
  context: PerformanceProbeContext,
) => Promise<PerformanceProbeMeasurement>;

export type PerformanceProbeReport = Readonly<{
  schemaVersion: 1;
  contractVersion: string;
  percentileMethod: string;
  repositoryRevision: string;
  deploymentRevision: string;
  fixtureDigest: string;
  dependencyVersions: Readonly<Record<string, string>>;
  tierId: string;
  mode: PerformanceMode;
  repository: PerformanceTier["repository"];
  concurrency: number;
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
  if (!FIXTURE_DIGEST.test(options.fixtureDigest)) {
    invalid("performance_fixture_digest_invalid");
  }
  const dependencies = Object.entries(options.dependencyVersions);
  if (
    dependencies.length === 0 ||
    dependencies.some(([name, version]) => !name.trim() || !version.trim())
  ) {
    invalid("performance_dependency_versions_invalid");
  }
}

function validateMeasurement(measurement: PerformanceProbeMeasurement): void {
  if (!measurement || typeof measurement !== "object" || !measurement.metrics) {
    invalid("performance_probe_measurement_invalid");
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
      value.durationMs < 0 ||
      typeof value.success !== "boolean"
    ) {
      invalid("performance_probe_metric_invalid");
    }
  }
}

function observedAt(now: () => number): string {
  return new Date(Math.max(0, now())).toISOString();
}

function recordInvocation(
  observations: PerformanceObservation[],
  context: Readonly<{
    tier: PerformanceTier;
    deploymentRevision: string;
    repositoryRevision: string;
    fixtureDigest: string;
    observedConcurrency: number;
  }>,
  mode: PerformanceMode,
  sequence: number,
  measurement: PerformanceProbeMeasurement,
  at: string,
): void {
  for (const metric of METRICS) {
    const value = measurement.metrics[metric];
    observations.push({
      id: `${context.tier.id}.${mode}.${String(sequence).padStart(8, "0")}.${metric}`,
      tierId: context.tier.id,
      metric,
      mode,
      deploymentRevision: context.deploymentRevision,
      repositoryRevision: context.repositoryRevision,
      fixtureDigest: context.fixtureDigest,
      tierDefinitionDigest: performanceTierDefinitionDigest(context.tier),
      observedConcurrency: context.observedConcurrency,
      durationMs: value.durationMs,
      success: value.success,
      observedAt: at,
    });
  }
}

function failedMeasurement(durationMs: number): PerformanceProbeMeasurement {
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
  const tier = contract.tiers.find((candidate) => candidate.id === options.tierId);
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
  let sequence = 0;
  let cancelledInvocationCount = 0;
  let activeInvocationCount = 0;
  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted && now() < deadlineMs) {
      const invocationSequence = sequence++;
      const invocationId = `${tier.id}.${options.mode}.${String(invocationSequence).padStart(8, "0")}`;
      const invocationStarted = now();
      activeInvocationCount += 1;
      const observedConcurrency = activeInvocationCount;
      try {
        const measurement = await options.probe({
          invocationId,
          sequence: invocationSequence,
          mode: options.mode,
          tier,
          repositoryRevision: options.repositoryRevision,
          deploymentRevision: options.deploymentRevision,
          fixtureDigest: options.fixtureDigest,
          signal: controller.signal,
        });
        validateMeasurement(measurement);
        recordInvocation(
          observations,
          {
            tier,
            deploymentRevision: options.deploymentRevision,
            repositoryRevision: options.repositoryRevision,
            fixtureDigest: options.fixtureDigest,
            observedConcurrency,
          },
          options.mode,
          invocationSequence,
          measurement,
          observedAt(now),
        );
      } catch {
        if (controller.signal.aborted || now() >= deadlineMs) {
          cancelledInvocationCount += 1;
          continue;
        }
        recordInvocation(
          observations,
          {
            tier,
            deploymentRevision: options.deploymentRevision,
            repositoryRevision: options.repositoryRevision,
            fixtureDigest: options.fixtureDigest,
            observedConcurrency,
          },
          options.mode,
          invocationSequence,
          failedMeasurement(Math.max(0, now() - invocationStarted)),
          observedAt(now),
        );
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
  };
  const evaluation = !externallyAborted && completeSamples
    ? evaluatePerformanceRun(
        selectedTierContract,
        observations,
        options.mode,
        new Date(Math.max(0, endedMs)).toISOString(),
      )
    : null;
  const status = externallyAborted
    ? "aborted"
    : completeSamples
      ? "completed"
      : "incomplete";

  return Object.freeze({
    schemaVersion: 1,
    contractVersion: contract.version,
    percentileMethod: contract.percentileMethod,
    repositoryRevision: options.repositoryRevision,
    deploymentRevision: options.deploymentRevision,
    fixtureDigest: options.fixtureDigest,
    dependencyVersions: Object.freeze(
      Object.fromEntries(Object.entries(options.dependencyVersions).sort(([left], [right]) => left.localeCompare(right))),
    ),
    tierId: tier.id,
    mode: options.mode,
    repository: tier.repository,
    concurrency: tier.concurrency,
    minimumSamples: tier.minimumSamples,
    plannedDurationMs,
    startedAt: new Date(Math.max(0, startedMs)).toISOString(),
    endedAt: new Date(Math.max(0, endedMs)).toISOString(),
    elapsedMs: Math.max(0, endedMs - startedMs),
    status,
    abortReason: externallyAborted ? abortReason(options.signal?.reason) : null,
    cancelledInvocationCount,
    ok: status === "completed" && evaluation?.ok === true,
    observations: Object.freeze(observations),
    evaluation,
  });
}

export function createHttpPerformanceProbe(options: Readonly<{
  endpoint: string;
  bearerToken?: string;
  fetch?: typeof fetch;
}>): PerformanceProbe {
  const endpoint = new URL(options.endpoint).toString();
  const request = options.fetch ?? globalThis.fetch;
  return async (context) => {
    const response = await request(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
      },
      body: JSON.stringify({
        schemaVersion: 1,
        invocationId: context.invocationId,
        mode: context.mode,
        tier: context.tier,
        repositoryRevision: context.repositoryRevision,
        deploymentRevision: context.deploymentRevision,
        fixtureDigest: context.fixtureDigest,
      }),
      signal: context.signal,
    });
    if (!response.ok) throw new Error(`performance_probe_http_${response.status}`);
    const payload = await response.json() as {
      deploymentRevision?: unknown;
      repositoryRevision?: unknown;
      fixtureDigest?: unknown;
      tierId?: unknown;
      mode?: unknown;
      invocationId?: unknown;
      metrics?: unknown;
    };
    if (payload.deploymentRevision !== context.deploymentRevision) {
      invalid("performance_probe_deployment_revision_mismatch");
    }
    if (payload.repositoryRevision !== context.repositoryRevision) {
      invalid("performance_probe_repository_revision_mismatch");
    }
    if (payload.fixtureDigest !== context.fixtureDigest) {
      invalid("performance_probe_fixture_digest_mismatch");
    }
    if (payload.tierId !== context.tier.id) {
      invalid("performance_probe_tier_mismatch");
    }
    if (payload.mode !== context.mode) {
      invalid("performance_probe_mode_mismatch");
    }
    if (payload.invocationId !== context.invocationId) {
      invalid("performance_probe_invocation_mismatch");
    }
    const measurement = { metrics: payload.metrics } as PerformanceProbeMeasurement;
    validateMeasurement(measurement);
    return measurement;
  };
}

export function persistPerformanceProbeReport(
  path: string,
  report: PerformanceProbeReport,
): string {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
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
  const mode = option("mode") as PerformanceMode | undefined;
  const tierId = option("tier");
  const endpoint = option("endpoint");
  const deploymentRevision = option("deployment-revision");
  const fixtureDigest = option("fixture-digest");
  const output = option("output");
  if (!mode || !tierId || !endpoint || !deploymentRevision || !fixtureDigest || !output) {
    throw new Error(
      "usage: --mode=load|soak --tier=<tier> --endpoint=<url> " +
      "--deployment-revision=<immutable-id> --fixture-digest=<sha256> --output=<path>",
    );
  }
  const controller = new AbortController();
  const stop = () => controller.abort("operator_signal");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const report = await runPerformanceProbe({
      tierId,
      mode,
      repositoryRevision: repositoryRevision(),
      deploymentRevision,
      fixtureDigest,
      dependencyVersions: dependencyVersions(resolve("package-lock.json")),
      probe: createHttpPerformanceProbe({
        endpoint,
        bearerToken: process.env.MENDPOINT_PERFORMANCE_BEARER_TOKEN,
      }),
      signal: controller.signal,
    });
    console.log(`Performance report ${persistPerformanceProbeReport(output, report)}`);
    console.log(`${report.tierId} ${report.mode}: ${report.status}, ${report.observations.length} observations`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("performance-runner.ts") ||
  process.argv[1]?.replace(/\\/g, "/").endsWith("performance-runner.js");
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
