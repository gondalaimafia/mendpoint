import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runChangePipeline } from "@mendpoint/pipeline";
import {
  claimNextJob,
  completeJob,
  createDb,
  enqueueJob,
  failJob,
  renewJobLease,
  findMonorepoRoot,
  findAuthorizedGitHubInstallationForRepository,
  getConnectedRepository,
  getConsumer,
  getConsumerRepo,
  getJob,
  getAgentRun,
  getAgentRunByJobId,
  getJobRecoverySummary,
  getRepositorySnapshotPolicy,
  getScmConnection,
  insertAgentRun,
  recordAgentRunMeter,
  releaseRunUsage,
  settleRunUsage,
  RUN_USAGE_RESERVATION_KEY,
  RUN_USAGE_RESERVED_MCU_KEY,
  insertRepairSession,
  expireAdaptiveCandidate,
  listAdaptiveCandidateTenantIds,
  listAdaptiveCandidatesForMaintenance,
  listConnectedRepositories,
  listFeedSchedules,
  listFeedPolls,
  listJobs,
  listRepositorySnapshots,
  listProviders,
  listVersionsForProvider,
  settleActiveWardenModelReservationsForFence,
  type AppDb,
  type FeedScheduleRow,
} from "@mendpoint/db";
import {
  listCatalogFeeds,
  pollAllFeeds,
  probeKnownSdks,
  runFeedSchedules,
} from "@mendpoint/catalog";
import { assessFeedFreshness, nowIso } from "@mendpoint/shared";
import {
  createAppDelivery,
  createGitLabDelivery,
  gitlabAsExactDraftDelivery,
  loadAppCredentials,
  OctokitGitHubDelivery,
  parseGitHubAccountTenantBindings,
  resolveGitHubTenantAccountBinding,
  type ExactDraftDeliveryInput,
  type GitHubDelivery,
} from "@mendpoint/github";
import {
  deploymentProfile,
  resolveMutationFenceRoot,
  tryAcquireMutationLease,
  initializeWithMutationLease,
} from "@mendpoint/ops";

export function initializeWorkerDurableState<T>(
  initialize: () => T,
  env: Readonly<Record<string, string | undefined>> = process.env,
): T {
  return initializeWithMutationLease(initialize, env);
}
import {
  runWarden,
  runWardenAttempt,
  runPolicyRoutedWarden,
  resolveAgentModelEndpoint,
  WARDEN_CANDIDATE_REVIEW_LIMITS,
  type AgentModelSourcePolicy,
  type AgentPlanner,
  type WardenAttemptLimits,
  type WardenAttemptResult,
} from "@mendpoint/agent";
import {
  buildWardenExecutorRegistry,
  createWardenRoutingRuntime,
  synthesizeWardenRun,
  wardenExecutorDescriptor,
  wardenRoutingOutcomeAttribution,
  wardenRoutingRequest,
  type WardenModelRoutingProfile,
} from "./warden-router.js";
import { runRepairSession } from "@mendpoint/repair";
import {
  discardAdaptiveCandidate,
  TransformerPilotExecutionStore,
} from "@mendpoint/transformer";
import type { ContractCase } from "@mendpoint/contract";
import {
  runTransformerPilotLaneOnce,
  transformerPilotWorkerPath,
  type TransformerPilotLaneResult,
} from "./transformer-pilot-lane.js";
import { loadWardenSnapshotBinding } from "./warden-snapshot-loader.js";
import {
  authorizeConfiguredTransformerAdaptiveExternalProcessing,
  resolveTransformerAdaptivePlannerAdapter,
} from "./transformer-adaptive-planner.js";
import { buildLearningPrecedent } from "./transformer-learning-consumer.js";
import { learningLoopEnabled } from "./transformer-learning-outcome.js";
import {
  runTransformerAdaptiveDelivery,
  type ResolveTransformerAdaptiveRepository,
} from "./transformer-adaptive-delivery.js";
import {
  runWardenCandidateDelivery,
  type ResolveWardenCandidateRepository,
} from "./warden-candidate-delivery.js";
import {
  assertWardenModelAccountingSettled,
  createWardenModelAccountingRuntime,
} from "./warden-model-accounting.js";
import { enqueuePipelineWardenRuns } from "./warden-pilot-join.js";
import { runTransformerServiceCli } from "./transformer-service-cli.js";

const WORKER_ID =
  process.env.MENDPOINT_WORKER_ID ?? `worker:${process.pid}:${randomUUID()}`;
const wardenMaintenanceRowOffsets = new Map<string, number>();

export function transformerAdaptiveProductionPorts(
  env: NodeJS.ProcessEnv = process.env,
  db?: AppDb,
) {
  const precedentEnabled = Boolean(db) && learningLoopEnabled(env);
  return Object.freeze({
    adaptivePlannerAdapterForTenant: (tenantId: string) =>
      resolveTransformerAdaptivePlannerAdapter(tenantId, env, {
        ...(precedentEnabled
          ? {
              loadPrecedent: () =>
                buildLearningPrecedent({ db: db!, tenantId, at: nowIso(), env }),
            }
          : {}),
      }),
    authorizeAdaptiveExternalProcessing: (
      authorization: Parameters<
        typeof authorizeConfiguredTransformerAdaptiveExternalProcessing
      >[0],
    ) => authorizeConfiguredTransformerAdaptiveExternalProcessing(authorization, env),
  });
}
let wardenMaintenanceTenantOffset = 0;

export type JobDrainResult = {
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
};

export type WorkerHeartbeat = {
  ok: boolean;
  workerId: string;
  recordedAt: string;
  jobs: JobDrainResult;
  activeJob?: { id: string; type: string; leaseGeneration: number } | null;
  activeJobs?: Array<{ id: string; type: string; leaseGeneration: number }>;
  recovery?: {
    due: number;
    scheduled: number;
    running: number;
    deadLetter: number;
    expiredLeases: number;
  };
  transformer?: TransformerPilotLaneHeartbeat;
  feedPollingEnabled: boolean;
  feedPollOk: boolean;
  feedScheduleCount?: number;
  feedLastSuccessAt?: string;
  feedStaleAfterMs?: number;
  feedPollStartedAt?: string;
};

export function summarizeCustomerFeedEvidence(
  rows: readonly FeedScheduleRow[],
  nowMs = Date.now(),
) {
  const schedules = rows.filter((schedule) => schedule.enabled === 1);
  const assessed = schedules.map((schedule) => ({
    schedule,
    alertStateHealthy:
      schedule.alert_state === "healthy" && schedule.consecutive_failures === 0,
    freshness: assessFeedFreshness({
      lastSuccessAt: schedule.last_success_at ?? undefined,
      staleAfterMs: schedule.stale_after_ms,
      nowMs,
    }),
  }));
  const critical = assessed.find(
    ({ freshness, alertStateHealthy }) => !freshness.ok || !alertStateHealthy,
  ) ?? assessed.reduce<(typeof assessed)[number] | undefined>((earliest, candidate) => {
    if (!earliest) return candidate;
    const earliestDeadline = Date.parse(earliest.schedule.last_success_at ?? "") +
      earliest.schedule.stale_after_ms;
    const candidateDeadline = Date.parse(candidate.schedule.last_success_at ?? "") +
      candidate.schedule.stale_after_ms;
    return candidateDeadline < earliestDeadline ? candidate : earliest;
  }, undefined);
  const alertStateHealthy = schedules.length > 0 &&
    assessed.every((candidate) => candidate.alertStateHealthy);
  return Object.freeze({
    scheduleCount: schedules.length,
    lastSuccessAt: critical?.schedule.last_success_at ?? undefined,
    staleAfterMs: critical?.schedule.stale_after_ms,
    alertStateHealthy,
    fresh:
      alertStateHealthy && assessed.every(({ freshness }) => freshness.ok),
  });
}

export type TransformerPilotLaneHeartbeat = TransformerPilotLaneResult & Readonly<{
  active: boolean;
  lastRunAt?: string;
  lastSuccessAt?: string;
  infrastructureError?: string;
}>;

function transformerInfrastructureErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/database is locked|SQLITE_BUSY/i.test(raw)) {
    return "transformer_lane_database_locked";
  }
  if (/^[A-Za-z0-9][A-Za-z0-9._,:-]{0,199}$/.test(raw)) return raw;
  return "transformer_lane_internal_error";
}

export function transformerPilotHeartbeatStarted(
  previous: TransformerPilotLaneHeartbeat,
  observedAt: string,
): TransformerPilotLaneHeartbeat {
  return Object.freeze({ ...previous, active: true, lastRunAt: observedAt });
}

export function transformerPilotHeartbeatAfterResult(
  previous: TransformerPilotLaneHeartbeat,
  result: TransformerPilotLaneResult,
  observedAt: string,
): TransformerPilotLaneHeartbeat {
  const { infrastructureError: _previousError, ...previousWithoutError } = previous;
  if (result.infrastructureError) {
    return Object.freeze({
      ...previousWithoutError,
      ...result,
      active: false,
      lastRunAt: observedAt,
      ...(previous.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
    });
  }
  return Object.freeze({
    ...previousWithoutError,
    ...result,
    active: false,
    lastRunAt: observedAt,
    lastSuccessAt: observedAt,
  });
}

export function transformerPilotHeartbeatAfterFailure(
  previous: TransformerPilotLaneHeartbeat,
  error: unknown,
  observedAt: string,
): TransformerPilotLaneHeartbeat {
  return Object.freeze({
    ...previous,
    active: false,
    lastRunAt: observedAt,
    infrastructureError: transformerInfrastructureErrorCode(error),
  });
}

export function writeWorkerHeartbeat(
  heartbeatPath: string,
  heartbeat: WorkerHeartbeat,
): void {
  if (!isAbsolute(heartbeatPath)) {
    throw new Error("Worker heartbeat path must be absolute");
  }
  const parent = dirname(heartbeatPath);
  mkdirSync(parent, { recursive: true });
  const temporary = `${heartbeatPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(heartbeat)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, heartbeatPath);
}

export function parseIntervalMs(
  value: string | number | undefined,
  fallback = 60_000,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error("Worker interval must be an integer number of milliseconds");
  }
  if (parsed < 1_000 || parsed > 86_400_000) {
    throw new Error("Worker interval must be between 1000 and 86400000 milliseconds");
  }
  return parsed;
}

export function retryDelayMs(
  consecutiveFailures: number,
  baseMs: number,
  maxMs = 300_000,
): number {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 8));
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

export function parseJobConcurrency(value: string | number | undefined): number {
  const parsed = value === undefined ? 2 : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) {
    throw new Error("MENDPOINT_JOB_CONCURRENCY must be an integer between 1 and 8");
  }
  return parsed;
}

export function startConcurrentJobLanes<T>(
  concurrency: number,
  start: (lane: number) => Promise<T>,
): Promise<T[]> {
  return Promise.all(Array.from({ length: concurrency }, (_, lane) => start(lane)));
}

export function waitForWorkerDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function feedPipelineJobId(input: {
  tenantId: string;
  providerSlug: string;
  contentHash: string;
  versionId?: string;
}): string {
  const digest = createHash("sha256")
    .update(
      `${input.tenantId}\n${input.providerSlug}\n${input.contentHash}\n${input.versionId ?? ""}`,
    )
    .digest("hex")
    .slice(0, 32);
  return `feed_pipeline_${digest}`;
}

export function enqueueFeedPipelineJob(
  db: AppDb,
  input: {
    tenantId: string;
    providerSlug: string;
    contentHash: string;
    versionId?: string;
  },
): string {
  const id = feedPipelineJobId(input);
  const payload = {
    providerSlug: input.providerSlug,
    source: "feed",
    contentHash: input.contentHash,
    versionId: input.versionId,
  };
  const existing = getJob(db, id, input.tenantId);
  if (existing) {
    if (
      existing.type !== "pipeline.fanout" ||
      existing.payload_json !== JSON.stringify(payload)
    ) {
      throw new Error("Feed pipeline job idempotency collision");
    }
    return id;
  }
  try {
    enqueueJob(db, {
      id,
      tenantId: input.tenantId,
      type: "pipeline.fanout",
      payload,
      createdAt: nowIso(),
    });
  } catch (error) {
    const replay = getJob(db, id, input.tenantId);
    if (
      !replay ||
      replay.type !== "pipeline.fanout" ||
      replay.payload_json !== JSON.stringify(payload)
    ) {
      throw error;
    }
  }
  return id;
}

export function startIndependentWorkerLanes<TFeed, TJobs>(input: {
  feeds: () => Promise<TFeed>;
  jobs: () => Promise<TJobs>;
}): { feeds: Promise<TFeed>; jobs: Promise<TJobs> } {
  return {
    feeds: Promise.resolve().then(input.feeds),
    jobs: Promise.resolve().then(input.jobs),
  };
}

export function classifyJobFailure(error: unknown): {
  message: string;
  errorCode: string;
  retryable: boolean;
} {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const explicitCode = /^[a-z][a-z0-9_]{2,63}$/.test(message) ? message : null;
  const authorizationFailure =
    /auth|permission|forbidden|unauthorized|bad credentials/.test(normalized) ||
    /github_app_(?:credentials|token_(?:installation|invalid)|installation|repository|permissions|connection|delivery_mode|selected_repositories)/.test(
      normalized,
    );
  const retryable =
    !authorizationFailure &&
    /timeout|timed out|rate.?limit|429|5\d\d|econnreset|econnrefused|enotfound|sqlite_busy|lease_(?:expired|lost)|delivery_failed/.test(
        normalized,
      );
  const errorCode = explicitCode ?? (retryable
    ? /rate.?limit|429/.test(normalized)
      ? "rate_limited"
      : /sqlite_busy/.test(normalized)
        ? "database_busy"
        : /lease/.test(normalized)
          ? "lease_lost"
          : "transient_dependency"
    : authorizationFailure
      ? "authorization_failed"
      : /verify|repair|warden|gate/.test(normalized)
        ? "verification_failed"
        : "job_failed");
  return { message, errorCode, retryable };
}

export function parseLeaseMs(value: string | number | undefined): number {
  const parsed = value === undefined ? 900_000 : Number(value);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < 1_000 ||
    parsed > 86_400_000
  ) {
    throw new Error("JOB_LEASE_MS must be between 1000 and 86400000 milliseconds");
  }
  return parsed;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return Boolean(
    rel &&
      rel !== ".." &&
      !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(rel),
  );
}

function safeTenantId(tenantId: string): string {
  if (
    tenantId === "." ||
    tenantId === ".." ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tenantId)
  ) {
    throw new Error("Worker tenant ID is not path safe");
  }
  return tenantId;
}

export function resolveWorkerRepoPath(
  repoPath: string,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!repoPath || !isAbsolute(repoPath) || !existsSync(repoPath)) {
    throw new Error(`Worker repository path is unavailable: ${repoPath}`);
  }
  const realRepo = realpathSync(resolve(repoPath));
  if (!statSync(realRepo).isDirectory()) {
    throw new Error(`Worker repository path is not a directory: ${repoPath}`);
  }
  const configuredRoot = env.MENDPOINT_REPOS_DIR;
  if (env.NODE_ENV === "production" && !configuredRoot) {
    throw new Error("MENDPOINT_REPOS_DIR is required for production worker execution");
  }
  if (configuredRoot) {
    if (!isAbsolute(configuredRoot) || !existsSync(configuredRoot)) {
      throw new Error("MENDPOINT_REPOS_DIR must be an existing absolute directory");
    }
    const realRoot = realpathSync(resolve(configuredRoot));
    const boundary =
      env.NODE_ENV === "production"
        ? realpathSync(resolve(realRoot, safeTenantId(tenantId)))
        : realRoot;
    if (!isWithin(boundary, realRepo)) {
      throw new Error("Worker repository path is outside the tenant repository root");
    }
  }
  return realRepo;
}

type WardenJobPayload = Readonly<{
  goal: string;
  consumerId: string;
  verifyCommand?: string;
  errorLog?: string;
  maxSteps?: number;
  dryRun?: boolean;
  useLlm?: boolean;
  sessionId?: string;
  allowedChangedPaths?: string[];
  reviewFeedback?: string;
  supersedesRunId?: string;
  reviewerPrincipalId?: string;
  source?: Readonly<{
    pipelineJobId: string;
    changeId: string;
    providerSlug: string;
    repositoryId: string;
    snapshotId: string;
    revision: string;
  }>;
}>;

type WardenVerificationPolicy = Readonly<{
  targetCommand: string;
  regressionCommands: readonly string[];
  securityCommands: readonly string[];
  protectedPaths: readonly string[];
}>;

const WARDEN_ATTEMPT_LIMITS = Object.freeze({
  maxSourceFiles: 20_000,
  maxSourceFileBytes: 32 * 1024 * 1024,
  maxSourceBytes: 512 * 1024 * 1024,
  maxTreeDepth: 64,
  ...WARDEN_CANDIDATE_REVIEW_LIMITS,
  maxEvidenceBytes: 512 * 1024,
  verificationTimeoutMs: 120_000,
}) satisfies Omit<WardenAttemptLimits, "allowedChangedPaths">;
const WARDEN_JOB_MODEL_BUDGET_USD = 25;

function parseWardenStringArray(value: string, field: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${field}_invalid`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 500 ||
    parsed.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 1_000)
  ) {
    throw new Error(`${field}_invalid`);
  }
  return [...new Set(parsed.map((entry) => String(entry).trim()))];
}

export type WardenApprovedModelSourcePolicy = Readonly<
  AgentModelSourcePolicy &
    WardenModelRoutingProfile & {
      externalProcessingAllowed: boolean;
      maximumCallCostUsd: number;
    }
>;

export function resolveWardenModelSourcePolicy(
  tenantId: string,
  useLlm: boolean,
  env: NodeJS.ProcessEnv = process.env,
): WardenApprovedModelSourcePolicy | undefined {
  if (!useLlm || env.MENDPOINT_WARDEN_MODEL_SOURCE_ENABLED !== "1") return undefined;
  const tenants = new Set(
    (env.MENDPOINT_WARDEN_MODEL_SOURCE_TENANTS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (!tenants.has(tenantId)) return undefined;
  const provider = env.MENDPOINT_WARDEN_MODEL_PROVIDER?.trim() ?? "";
  const model = env.LLM_AGENT_MODEL?.trim() ?? "";
  const endpoint = resolveAgentModelEndpoint(env);
  const region = env.MENDPOINT_WARDEN_MODEL_REGION?.trim() ?? "";
  const maximumDataClassification =
    env.MENDPOINT_WARDEN_MODEL_MAXIMUM_DATA_CLASSIFICATION?.trim() ?? "";
  const externalProcessing = env.MENDPOINT_WARDEN_EXTERNAL_PROCESSING_ALLOWED?.trim() ?? "";
  const estimatedCostText = env.MENDPOINT_WARDEN_MODEL_ESTIMATED_COST_USD?.trim() ?? "";
  const estimatedCostUsd = Number(estimatedCostText);
  const maximumCallCostText = env.MENDPOINT_WARDEN_MODEL_MAXIMUM_CALL_COST_USD?.trim() ?? "";
  const maximumCallCostUsd = Number(maximumCallCostText);
  if (
    !provider ||
    !model ||
    !endpoint ||
    !region ||
    !(["public", "internal", "confidential", "restricted"] as const).includes(
      maximumDataClassification as "public" | "internal" | "confidential" | "restricted",
    ) ||
    !["0", "1"].includes(externalProcessing) ||
    !estimatedCostText ||
    !Number.isFinite(estimatedCostUsd) ||
    estimatedCostUsd < 0 ||
    !maximumCallCostText ||
    !Number.isFinite(maximumCallCostUsd) ||
    maximumCallCostUsd <= 0
  ) {
    throw new Error("warden_model_source_policy_incomplete");
  }
  const externalProcessingAllowed = externalProcessing === "1";
  const canonical = JSON.stringify({
    schemaVersion: 2,
    tenantId,
    provider,
    model,
    endpoint,
    externalProcessingAllowed,
    region,
    maximumDataClassification,
    estimatedCostUsd,
    maximumCallCostUsd,
  });
  return Object.freeze({
    approved: true,
    tenantId,
    provider,
    model,
    endpoint,
    externalProcessingAllowed,
    region,
    maximumDataClassification: maximumDataClassification as
      | "public"
      | "internal"
      | "confidential"
      | "restricted",
    estimatedCostUsd,
    maximumCallCostUsd,
    policyDigest: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
  });
}

function wardenVerificationPolicy(
  db: AppDb,
  tenantId: string,
  snapshotId: string,
  requestedTarget?: string,
): WardenVerificationPolicy {
  const policy = getRepositorySnapshotPolicy(db, tenantId, snapshotId);
  if (!policy) throw new Error("warden_snapshot_policy_required");
  const commands = parseWardenStringArray(
    policy.verification_commands_json,
    "warden_verification_commands",
  );
  if (!commands.length) throw new Error("warden_verification_profile_required");
  const targetCommand = commands[0]!;
  if (requestedTarget?.trim() && requestedTarget.trim() !== targetCommand) {
    throw new Error("warden_target_verifier_must_match_primary_snapshot_policy_command");
  }
  const remaining = commands.filter((command) => command !== targetCommand);
  const securityCommands = remaining.filter((command) => /(?:^|:|\s)(?:lint|security)(?:$|:|\s)/i.test(command));
  const regressionCommands = remaining.filter((command) => !securityCommands.includes(command));
  return Object.freeze({
    targetCommand,
    regressionCommands: Object.freeze(regressionCommands),
    securityCommands: Object.freeze(securityCommands),
    protectedPaths: Object.freeze(parseWardenStringArray(
      policy.ci_files_json,
      "warden_ci_files",
    )),
  });
}

function validatedWardenPilotSource(
  db: AppDb,
  tenantId: string,
  consumerId: string,
  sessionId: string,
  binding: Readonly<{
    repositoryId: string;
    snapshotId: string;
    revision: string;
  }>,
  source: WardenJobPayload["source"],
): WardenJobPayload["source"] {
  if (!source) return undefined;
  if (
    !source.pipelineJobId ||
    !source.changeId ||
    !source.providerSlug ||
    source.repositoryId !== binding.repositoryId ||
    source.snapshotId !== binding.snapshotId ||
    source.revision !== binding.revision
  ) {
    throw new Error("warden_pilot_source_binding_mismatch");
  }
  const pipelineJob = getJob(db, source.pipelineJobId, tenantId);
  if (!pipelineJob || pipelineJob.type !== "pipeline.fanout" || pipelineJob.status !== "done") {
    throw new Error("warden_pilot_source_job_not_complete");
  }
  const pipelinePayload = JSON.parse(pipelineJob.payload_json) as Record<string, unknown>;
  if (
    pipelinePayload.wardenPilot !== true ||
    pipelinePayload.providerSlug !== source.providerSlug ||
    !Array.isArray(pipelinePayload.consumerIds) ||
    !pipelinePayload.consumerIds.includes(consumerId)
  ) {
    throw new Error("warden_pilot_source_job_mismatch");
  }
  const pipelineResult = pipelineJob.result_json
    ? JSON.parse(pipelineJob.result_json) as Record<string, unknown>
    : null;
  const wardenRuns = Array.isArray(pipelineResult?.wardenRuns)
    ? pipelineResult.wardenRuns as Array<Record<string, unknown>>
    : [];
  if (
    pipelineResult?.changeId !== source.changeId ||
    !wardenRuns.some((run) =>
      run.consumerId === consumerId &&
      run.runId === sessionId &&
      (run.status === "queued" || run.status === "replayed")
    )
  ) {
    throw new Error("warden_pilot_source_result_mismatch");
  }
  return Object.freeze({ ...source });
}

function privateWardenDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return realpathSync(path);
}

function privateWardenChildDirectory(root: string, path: string): string {
  const directory = privateWardenDirectory(path);
  if (!isWithin(root, directory)) throw new Error("warden_storage_tenant_boundary_invalid");
  return directory;
}

function wardenStorageNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (value === undefined || !value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field}_invalid`);
  }
  return parsed;
}

function sweepWardenTenantStorage(
  roots: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  evidenceRoot?: string,
): { retainedBytes: number; expiresAt: string } {
  const ttlMs = wardenStorageNumber(
    env.MENDPOINT_WARDEN_CANDIDATE_TTL_MS,
    7 * 24 * 60 * 60 * 1000,
    60 * 60 * 1000,
    30 * 24 * 60 * 60 * 1000,
    "warden_candidate_ttl",
  );
  const quotaBytes = wardenStorageNumber(
    env.MENDPOINT_WARDEN_CANDIDATE_QUOTA_BYTES,
    2 * 1024 * 1024 * 1024,
    512 * 1024 * 1024,
    10 * 1024 * 1024 * 1024,
    "warden_candidate_quota",
  );
  const now = Date.now();
  let retainedBytes = 0;
  let visited = 0;
  const measure = (path: string): void => {
    visited++;
    if (visited > 100_000) throw new Error("warden_candidate_storage_entry_limit");
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error("warden_candidate_storage_symlink");
    if (info.isDirectory()) {
      for (const name of readdirSync(path)) measure(join(path, name));
      return;
    }
    if (!info.isFile()) throw new Error("warden_candidate_storage_special_file");
    retainedBytes += info.size;
  };
  for (const root of roots) {
    for (const name of readdirSync(root)) {
      // Sealed approvals are bounded compliance records, not attempt storage, and
      // are never deleted. Excluding the tenant evidence root's top-level approvals
      // directory keeps them from permanently consuming the attempt storage quota.
      if (root === evidenceRoot && name === "approvals") continue;
      const target = join(root, name);
      measure(target);
    }
  }
  const reservedAttemptBytes = WARDEN_ATTEMPT_LIMITS.maxSourceBytes +
    WARDEN_ATTEMPT_LIMITS.maxEvidenceBytes;
  if (retainedBytes + reservedAttemptBytes > quotaBytes) {
    throw new Error("warden_candidate_storage_quota_exceeded");
  }
  return {
    retainedBytes,
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
}

function reconcileWardenOrphans(
  db: AppDb,
  tenantId: string,
  candidateRoot: string,
  evidenceRoot: string,
  env: NodeJS.ProcessEnv,
  observedAt: string,
): number {
  const graceMs = wardenStorageNumber(
    env.MENDPOINT_WARDEN_ORPHAN_GRACE_MS,
    60 * 60 * 1000,
    60_000,
    24 * 60 * 60 * 1000,
    "warden_orphan_grace",
  );
  const referenced = new Set<string>();
  const runningAttemptPrefixes = (db.raw.prepare(
    `SELECT id FROM jobs
     WHERE tenant_id = ? AND type = 'agent.run' AND status = 'running'`,
  ).all(tenantId) as Array<{ id: string }>).map((row) => `${row.id}-`);
  const rows = db.raw.prepare(
    `SELECT result_json FROM agent_runs
     WHERE tenant_id = ?
       AND status IN ('candidate_ready', 'candidate_approved', 'candidate_rejected', 'candidate_expired')
       AND result_json IS NOT NULL
       AND json_valid(result_json) = 1`,
  ).all(tenantId) as Array<{ result_json: string }>;
  for (const row of rows) {
    const result = JSON.parse(row.result_json) as Record<string, unknown>;
    const artifacts = result.artifacts && typeof result.artifacts === "object"
      ? result.artifacts as Record<string, unknown>
      : null;
    for (const key of ["candidateWorkspace", "candidateManifest", "evidence"] as const) {
      const value = artifacts?.[key];
      if (typeof value === "string") referenced.add(resolve(value));
    }
    const approval = artifacts?.approval && typeof artifacts.approval === "object"
      ? artifacts.approval as Record<string, unknown>
      : null;
    if (typeof approval?.path === "string") referenced.add(resolve(approval.path));
  }
  const cutoff = Date.parse(observedAt) - graceMs;
  let removed = 0;
  for (const root of [candidateRoot, evidenceRoot]) {
    for (const name of readdirSync(root)) {
      // Sealed approval artifacts are durable compliance records. Never reap the
      // tenant evidence root's top-level approvals directory, even if no row
      // references it (rows may live on another shard or backup timeline).
      if (root === evidenceRoot && name === "approvals") continue;
      const target = resolve(root, name);
      if (!isWithin(root, target) || referenced.has(target)) continue;
      // A workspace and its temporary evidence are created only after the job
      // becomes running, and every top-level name begins with the durable job id.
      // A job claimed after this read can only create fresh entries inside the
      // grace window, so this reference is safe against the claim/delete race.
      if (runningAttemptPrefixes.some((prefix) => name.startsWith(prefix))) continue;
      const info = lstatSync(target);
      if (info.mtimeMs > cutoff) continue;
      rmSync(target, {
        recursive: info.isDirectory() && !info.isSymbolicLink(),
        force: true,
      });
      removed++;
    }
  }
  return removed;
}

function discardWardenAttempt(
  attempt: WardenAttemptResult,
  candidateRoot: string,
  evidenceRoot: string,
): void {
  if (attempt.status !== "succeeded") return;
  const workspace = realpathSync(attempt.artifacts.candidateWorkspace);
  const manifest = resolve(attempt.artifacts.candidateManifest);
  const evidence = resolve(attempt.artifacts.evidence);
  if (
    !isWithin(candidateRoot, workspace) ||
    !isWithin(candidateRoot, manifest) ||
    !isWithin(evidenceRoot, evidence)
  ) {
    throw new Error("warden_candidate_cleanup_boundary_invalid");
  }
  rmSync(workspace, { recursive: true, force: true });
  rmSync(manifest, { force: true });
  rmSync(evidence, { force: true });
}

function removeStoredWardenArtifacts(
  artifacts: Record<string, unknown>,
  candidateRoot: string,
  evidenceRoot: string,
): void {
  const workspace = typeof artifacts.candidateWorkspace === "string"
    ? resolve(artifacts.candidateWorkspace)
    : "";
  const manifest = typeof artifacts.candidateManifest === "string"
    ? resolve(artifacts.candidateManifest)
    : "";
  const evidence = typeof artifacts.evidence === "string"
    ? resolve(artifacts.evidence)
    : "";
  if (
    !workspace ||
    !manifest ||
    !evidence ||
    !isWithin(candidateRoot, workspace) ||
    !isWithin(candidateRoot, manifest) ||
    !isWithin(evidenceRoot, evidence)
  ) {
    throw new Error("warden_candidate_cleanup_boundary_invalid");
  }
  for (const [path, recursive] of [[workspace, true], [manifest, false], [evidence, false]] as const) {
    if (!existsSync(path)) continue;
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error("warden_candidate_cleanup_symlink");
    rmSync(path, { recursive, force: true });
  }
}

function expireWardenAgentRuns(
  db: AppDb,
  tenantId: string,
  candidateRoot: string,
  evidenceRoot: string,
  observedAt = nowIso(),
): Readonly<{ expired: number; cleaned: number; cleanupPending: number }> {
  const eligible = `(
    status = 'candidate_ready' OR
    (
      status = 'candidate_approved' AND NOT EXISTS (
        SELECT 1 FROM warden_candidate_deliveries delivery
        WHERE delivery.tenant_id = agent_runs.tenant_id
          AND delivery.run_id = agent_runs.id
          AND delivery.status = 'delivery_pending'
      )
    ) OR
    (
      status IN ('candidate_expired', 'candidate_rejected') AND
      CASE
        WHEN result_json IS NULL OR json_valid(result_json) = 0 THEN 1
        ELSE COALESCE(json_extract(result_json, '$.cleanup.status'), 'pending') <> 'cleaned'
      END
    )
  )`;
  const count = Number((db.raw.prepare(
    `SELECT COUNT(*) AS count FROM agent_runs WHERE tenant_id = ? AND ${eligible}`,
  ).get(tenantId) as { count: number }).count);
  let offset = wardenMaintenanceRowOffsets.get(tenantId) ?? 0;
  if (offset >= count) offset = 0;
  const rows = db.raw.prepare(
    `SELECT id, status, result_json FROM agent_runs
     WHERE tenant_id = ? AND ${eligible}
     ORDER BY created_at, id LIMIT 100 OFFSET ?`,
  ).all(tenantId, offset) as Array<{ id: string; status: string; result_json: string | null }>;
  wardenMaintenanceRowOffsets.set(
    tenantId,
    count > 0 && offset + rows.length < count ? offset + rows.length : 0,
  );
  let expired = 0;
  let cleaned = 0;
  let cleanupPending = 0;
  for (const row of rows) {
    let result: Record<string, unknown>;
    try {
      const parsed = row.result_json ? JSON.parse(row.result_json) as unknown : null;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      result = parsed as Record<string, unknown>;
    } catch {
      console.error(`  Warden candidate row is malformed run=${row.id}`);
      const corruptAt = observedAt;
      db.raw.prepare(
        `UPDATE agent_runs SET status = 'candidate_corrupt', result_json = ?, finished_at = ?
         WHERE id = ? AND tenant_id = ? AND status = ?`,
      ).run(JSON.stringify({
        corruption: { code: "warden_candidate_result_invalid", observedAt: corruptAt },
        cleanup: { status: "pending", attempts: 0 },
      }), corruptAt, row.id, tenantId, row.status);
      expired++;
      cleanupPending++;
      continue;
    }
    const retention = result?.retention && typeof result.retention === "object"
      ? (result.retention as Record<string, unknown>)
      : null;
    let status = row.status;
    if (status === "candidate_ready" || status === "candidate_approved") {
      const expiresAt = typeof retention?.expiresAt === "string"
        ? Date.parse(retention.expiresAt)
        : Number.NaN;
      if (Number.isFinite(expiresAt) && expiresAt > Date.parse(observedAt)) continue;
      result = {
        ...result,
        retention: {
          ...retention,
          expiredAt: observedAt,
          ...(!Number.isFinite(expiresAt) ? { invalidExpiry: true } : {}),
        },
        cleanup: { status: "pending", attempts: 0 },
      };
      const update = db.raw.prepare(
        `UPDATE agent_runs SET status = 'candidate_expired', result_json = ?, finished_at = ?
         WHERE id = ? AND tenant_id = ? AND status IN ('candidate_ready', 'candidate_approved')`,
      ).run(JSON.stringify(result), observedAt, row.id, tenantId);
      if (Number(update.changes) !== 1) continue;
      status = "candidate_expired";
      expired++;
    }
    const artifacts = result.artifacts && typeof result.artifacts === "object"
      ? (result.artifacts as Record<string, unknown>)
      : null;
    if (!artifacts || artifacts.candidateWorkspace === null) continue;
    const previousCleanup = result.cleanup && typeof result.cleanup === "object"
      ? result.cleanup as Record<string, unknown>
      : null;
    const attempts = Number(previousCleanup?.attempts ?? 0) + 1;
    try {
      removeStoredWardenArtifacts(artifacts, candidateRoot, evidenceRoot);
      const cleanedResult = {
        ...result,
        artifacts: {
          sourceDigest: artifacts.sourceDigest ?? null,
          candidateDigest: artifacts.candidateDigest ?? null,
          candidateWorkspace: null,
          candidateManifest: null,
          evidence: null,
        },
        cleanup: { status: "cleaned", attempts, cleanedAt: observedAt },
      };
      db.raw.prepare(
        `UPDATE agent_runs SET result_json = ? WHERE id = ? AND tenant_id = ? AND status = ?`,
      ).run(JSON.stringify(cleanedResult), row.id, tenantId, status);
      cleaned++;
    } catch (error) {
      const message = error instanceof Error ? error.message : "warden_candidate_cleanup_failed";
      const pendingResult = {
        ...result,
        cleanup: { status: "pending", attempts, lastError: message, lastAttemptAt: observedAt },
      };
      db.raw.prepare(
        `UPDATE agent_runs SET result_json = ? WHERE id = ? AND tenant_id = ? AND status = ?`,
      ).run(JSON.stringify(pendingResult), row.id, tenantId, status);
      cleanupPending++;
      console.error(`  Warden candidate cleanup deferred run=${row.id} error=${message}`);
    }
  }
  return Object.freeze({ expired, cleaned, cleanupPending });
}

export function maintainWardenArtifactsOnce(
  db: AppDb,
  env: NodeJS.ProcessEnv = process.env,
  observedAt = nowIso(),
): Readonly<{ tenants: number; expired: number; cleaned: number; cleanupPending: number }> {
  const tenantSource = `(
    SELECT tenant_id FROM agent_runs
    UNION
    SELECT tenant_id FROM jobs WHERE type = 'agent.run'
  )`;
  const tenantCount = Number((db.raw.prepare(
    `SELECT COUNT(*) AS count FROM ${tenantSource}`,
  ).get() as { count: number }).count);
  if (wardenMaintenanceTenantOffset >= tenantCount) wardenMaintenanceTenantOffset = 0;
  const tenants = db.raw.prepare(
    `SELECT tenant_id FROM ${tenantSource}
     ORDER BY tenant_id LIMIT 100 OFFSET ?`,
  ).all(wardenMaintenanceTenantOffset) as Array<{ tenant_id: string }>;
  wardenMaintenanceTenantOffset = tenantCount > 0 &&
      wardenMaintenanceTenantOffset + tenants.length < tenantCount
    ? wardenMaintenanceTenantOffset + tenants.length
    : 0;
  const dataRoot = privateWardenDirectory(
    resolve(env.MENDPOINT_DATA_DIR ?? join(process.cwd(), "data")),
  );
  const total = { tenants: tenants.length, expired: 0, cleaned: 0, cleanupPending: 0 };
  for (const row of tenants) {
    try {
      const key = safeTenantId(row.tenant_id);
      const candidateRoot = privateWardenChildDirectory(
        dataRoot,
        join(dataRoot, "warden-candidates", key),
      );
      const evidenceRoot = privateWardenChildDirectory(
        dataRoot,
        join(dataRoot, "warden-evidence", key),
      );
      const result = expireWardenAgentRuns(
        db,
        row.tenant_id,
        candidateRoot,
        evidenceRoot,
        observedAt,
      );
      total.expired += result.expired;
      total.cleaned += result.cleaned;
      total.cleanupPending += result.cleanupPending;
      reconcileWardenOrphans(
        db,
        row.tenant_id,
        candidateRoot,
        evidenceRoot,
        env,
        observedAt,
      );
    } catch (error) {
      total.cleanupPending++;
      console.error(
        `  Warden maintenance deferred tenant=${row.tenant_id} error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return Object.freeze(total);
}

export function maintainTransformerAdaptiveArtifactsOnce(
  db: AppDb,
  env: NodeJS.ProcessEnv = process.env,
  observedAt = nowIso(),
): Readonly<{
  tenants: number;
  expired: number;
  cleaned: number;
  cleanupPending: number;
}> {
  const nowMs = Date.parse(observedAt);
  if (!Number.isFinite(nowMs) || new Date(nowMs).toISOString() !== observedAt) {
    throw new Error("transformer_adaptive_maintenance_timestamp_invalid");
  }
  const tenantIds = listAdaptiveCandidateTenantIds(db);
  const total = { tenants: tenantIds.length, expired: 0, cleaned: 0, cleanupPending: 0 };
  const artifactEnv = {
    ...env,
    MENDPOINT_DATA_DIR: resolve(env.MENDPOINT_DATA_DIR ?? join(process.cwd(), "data")),
  };

  for (const tenantId of tenantIds) {
    try {
      const records = listAdaptiveCandidatesForMaintenance(db, tenantId);
      for (const record of records) {
        let status = record.status;
        if (status === "review_pending" && Date.parse(record.expiresAt) <= nowMs) {
          status = expireAdaptiveCandidate(db, {
            tenantId,
            id: record.id,
            observedAt,
          }).status;
          total.expired++;
        }
        const promotedRetentionElapsed =
          status === "promoted" && Date.parse(record.expiresAt) <= nowMs;
        const supersededRetentionElapsed =
          status === "superseded" && Date.parse(record.expiresAt) <= nowMs;
        if (
          status === "rejected" ||
          status === "expired" ||
          promotedRetentionElapsed ||
          supersededRetentionElapsed
        ) {
          try {
            const removed = discardAdaptiveCandidate({
              tenantId,
              path: record.sealedPath,
              sha256: record.sealedSha256,
              env: artifactEnv,
            });
            if (removed) total.cleaned++;
          } catch (error) {
            total.cleanupPending++;
            console.error(
              `  Transformer adaptive cleanup deferred candidate=${record.id} error=${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          continue;
        }
      }
    } catch (error) {
      total.cleanupPending++;
      console.error(
        `  Transformer adaptive maintenance deferred tenant=${tenantId} error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return Object.freeze(total);
}

type AgentRunWrite = Parameters<typeof insertAgentRun>[1];
type JobFence = Readonly<{ workerId: string; leaseGeneration: number }>;
type RoutingOutcomeFinalizer = (() => unknown) | undefined;

class WardenAtomicFinalizationError extends Error {
  readonly original: unknown;

  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "WardenAtomicFinalizationError";
    this.original = error;
  }
}

function persistCompletedAgentJob(
  db: AppDb,
  jobId: string,
  fence: JobFence,
  jobResult: unknown,
  run: AgentRunWrite,
  applyRoutingOutcome?: RoutingOutcomeFinalizer,
): void {
  let routingFinalizationStarted = false;
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    if (!completeJob(db, jobId, jobResult, nowIso(), fence)) {
      throw new Error("lease_lost_before_warden_completion");
    }
    if (applyRoutingOutcome) {
      routingFinalizationStarted = true;
      applyRoutingOutcome();
    }
    insertAgentRun(db, { ...run, jobId });
    // Wave 3b: record the per-run metering entry inside the same transaction,
    // after the routing outcome (cost/tokens) is durable.
    recordAgentRunMeter(db, { tenantId: run.tenantId, runId: run.id, meteredAt: nowIso() });
    db.raw.exec("COMMIT");
  } catch (error) {
    db.raw.exec("ROLLBACK");
    if (routingFinalizationStarted) throw new WardenAtomicFinalizationError(error);
    throw error;
  }
}

function persistFailedAgentJob(
  db: AppDb,
  jobId: string,
  fence: JobFence,
  failureInput: Readonly<{
    message: string;
    errorCode: string;
    retryable: boolean;
  }>,
  run: AgentRunWrite | null,
  applyRoutingOutcome?: RoutingOutcomeFinalizer,
) {
  let routingFinalizationStarted = false;
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const failedAt = nowIso();
    settleActiveWardenModelReservationsForFence(db, {
      jobId,
      workerId: fence.workerId,
      leaseGeneration: fence.leaseGeneration,
      observedAt: failedAt,
      errorCode: "warden_model_job_failed",
    });
    const failure = failJob(db, jobId, failureInput.message, failedAt, {
      ...fence,
      errorCode: failureInput.errorCode,
      retryable: failureInput.retryable,
      baseDelayMs: 5_000,
      maxDelayMs: 300_000,
    });
    if (failure.applied) {
      if (applyRoutingOutcome) {
        routingFinalizationStarted = true;
        applyRoutingOutcome();
      }
      if (run) {
        insertAgentRun(db, {
          ...run,
          jobId,
          status: failure.status === "pending" ? "retrying" : run.status,
          finishedAt: failure.status === "pending" ? null : run.finishedAt,
        });
        // Wave 3b: metering entry for the failed/retrying run (cost null when
        // unmeasured), inside the same transaction as the routing outcome.
        recordAgentRunMeter(db, { tenantId: run.tenantId, runId: run.id, meteredAt: nowIso() });
      }
    }
    db.raw.exec("COMMIT");
    return failure;
  } catch (error) {
    db.raw.exec("ROLLBACK");
    if (routingFinalizationStarted) throw new WardenAtomicFinalizationError(error);
    throw error;
  }
}

/**
 * Wave C: settle a completed pipeline.fanout run's usage hold. Only runs admitted
 * with quota enforcement on carry a reservation id, so this is a no-op for the legacy
 * path. Fanout has no per-run MCU measurement, so we settle to the reserved estimate
 * (documented in docs/USAGE_ENFORCEMENT.md) rather than fabricating a zero. Best-effort:
 * a settlement failure is logged for reconciliation and never breaks job processing.
 */
function settleFanoutRunUsage(
  db: AppDb,
  tenantId: string,
  payload: Record<string, unknown>,
): void {
  const reservationId = payload[RUN_USAGE_RESERVATION_KEY];
  const reserved = payload[RUN_USAGE_RESERVED_MCU_KEY];
  if (typeof reservationId !== "string" || !reservationId) return;
  if (typeof reserved !== "number" || !Number.isSafeInteger(reserved) || reserved <= 0) return;
  try {
    settleRunUsage(db, {
      tenantId,
      reservationId,
      actualMcuMicros: reserved,
      reason: "run completed: pipeline.fanout",
      createdAt: nowIso(),
    });
  } catch (error) {
    console.error(
      `  usage settle skipped reservation=${reservationId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Wave C: release a terminally failed pipeline.fanout run's usage hold so an infra
 * failure burns no quota. Retryable failures keep the hold (the retried run settles
 * it). Best-effort, no-op for the legacy path.
 */
function releaseFanoutRunUsage(
  db: AppDb,
  tenantId: string,
  payloadJson: string,
  jobId: string,
): void {
  let reservationId: unknown;
  try {
    reservationId = (JSON.parse(payloadJson) as Record<string, unknown>)[RUN_USAGE_RESERVATION_KEY];
  } catch {
    return;
  }
  if (typeof reservationId !== "string" || !reservationId) return;
  try {
    releaseRunUsage(db, {
      tenantId,
      reservationId,
      reason: `run failed: job ${jobId}`,
      createdAt: nowIso(),
    });
  } catch (error) {
    console.error(
      `  usage release skipped reservation=${reservationId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function validateWorkerProductionEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (env.NODE_ENV !== "production") return [];
  const errors: string[] = [];
  const profile = deploymentProfile(env);
  if (!env.MENDPOINT_DEPLOYMENT_PROFILE) {
    errors.push("MENDPOINT_DEPLOYMENT_PROFILE must be explicitly set to demo, pilot, or customer");
  } else if (!profile) {
    errors.push("MENDPOINT_DEPLOYMENT_PROFILE must be exactly demo, pilot, or customer");
  }
  if (profile === "customer") {
    if (env.GITHUB_MODE !== "real") {
      errors.push("Customer worker requires GITHUB_MODE=real");
    }
    if (env.MENDPOINT_DEPLOYMENT_CLASS !== "customer") {
      errors.push("Customer worker requires MENDPOINT_DEPLOYMENT_CLASS=customer");
    }
    if (env.MENDPOINT_FEED_POLLING_ENABLED !== "1") {
      errors.push("Customer worker requires MENDPOINT_FEED_POLLING_ENABLED=1");
    }
    if (env.POLL_LOCAL_ONLY !== "0") {
      errors.push("Customer worker requires POLL_LOCAL_ONLY=0");
    }
    if (env.MENDPOINT_PILOT_SEED !== "0") {
      errors.push("Customer worker requires MENDPOINT_PILOT_SEED=0");
    }
    if (env.MENDPOINT_WARDEN_MODEL_SOURCE_ENABLED !== "1") {
      errors.push("Customer worker requires Warden model source execution");
    }
    const fenceRoot = env.MENDPOINT_BACKUP_FENCE_ROOT?.trim();
    if (!fenceRoot || !isAbsolute(fenceRoot)) {
      errors.push("Customer worker requires an absolute MENDPOINT_BACKUP_FENCE_ROOT");
    }
    const heartbeatPath = env.MENDPOINT_WORKER_HEARTBEAT_PATH?.trim();
    if (!heartbeatPath || !isAbsolute(heartbeatPath)) {
      errors.push("Customer worker requires an absolute MENDPOINT_WORKER_HEARTBEAT_PATH");
    }
  }
  if (env.GITHUB_MODE !== "mock" && env.GITHUB_MODE !== "real") {
    errors.push("GITHUB_MODE must be explicitly set to mock or real");
  }
  const hasAnyAppCredential = Boolean(
    env.GITHUB_APP_ID?.trim() ||
    env.GITHUB_APP_PRIVATE_KEY?.trim() ||
    env.GITHUB_APP_PRIVATE_KEY_PATH?.trim(),
  );
  const appCredentials = loadAppCredentials(env);
  const deploymentClass = env.MENDPOINT_DEPLOYMENT_CLASS?.trim();
  if (
    env.GITHUB_MODE === "real" &&
    deploymentClass !== "customer" &&
    deploymentClass !== "disposable_canary"
  ) {
    errors.push(
      "MENDPOINT_DEPLOYMENT_CLASS must be customer or disposable_canary for real GitHub delivery",
    );
  }
  if (env.GITHUB_MODE === "real" && !appCredentials) {
    if (deploymentClass === "disposable_canary") {
      if (!env.GITHUB_TOKEN?.trim()) {
        errors.push("GITHUB_TOKEN is required for disposable canary PAT delivery");
      }
      if (!env.MENDPOINT_TENANT_ID?.trim()) {
        errors.push("MENDPOINT_TENANT_ID is required for disposable canary PAT delivery");
      }
    } else {
      errors.push(
        "Complete GitHub App credentials are required for customer production delivery",
      );
    }
  }
  if (hasAnyAppCredential && !appCredentials) {
    errors.push(
      "GitHub App credentials must include a positive app ID and a readable RSA private key",
    );
  }
  let customerTenantIds: string[] = [];
  if (profile === "customer" && appCredentials) {
    try {
      if (env.GITHUB_APP_OWNER_TENANT_BINDINGS?.trim()) throw new Error("legacy");
      const bindings = parseGitHubAccountTenantBindings(
        env.GITHUB_APP_ACCOUNT_TENANT_BINDINGS,
      );
      if (bindings.size === 0 || new Set(bindings.values()).size !== bindings.size) {
        throw new Error("ambiguous");
      }
      customerTenantIds = [...new Set(bindings.values())];
    } catch {
      errors.push(
        "GITHUB_APP_ACCOUNT_TENANT_BINDINGS must be a nonempty one-to-one JSON numeric account ID to tenant map; legacy login bindings are forbidden",
      );
    }
  }
  if (!env.DATABASE_URL && !env.MENDPOINT_DATA_DIR) {
    errors.push("DATABASE_URL or MENDPOINT_DATA_DIR is required");
  }
  const reposDir = env.MENDPOINT_REPOS_DIR;
  if (!reposDir || !isAbsolute(reposDir) || !existsSync(reposDir)) {
    errors.push("MENDPOINT_REPOS_DIR must be an existing absolute directory");
  }
  if (env.MENDPOINT_WARDEN_MODEL_SOURCE_ENABLED === "1") {
    if (!(env.MENDPOINT_WARDEN_MODEL_SOURCE_TENANTS ?? "").trim()) {
      errors.push("MENDPOINT_WARDEN_MODEL_SOURCE_TENANTS is required when model source is enabled");
    }
    if (!env.MENDPOINT_WARDEN_MODEL_PROVIDER?.trim()) {
      errors.push("MENDPOINT_WARDEN_MODEL_PROVIDER is required when model source is enabled");
    }
    if (!env.LLM_AGENT_MODEL?.trim()) {
      errors.push("LLM_AGENT_MODEL is required when model source is enabled");
    }
    if (!(env.LLM_AGENT_URL?.trim() || env.OPENAI_BASE_URL?.trim())) {
      errors.push("LLM_AGENT_URL or OPENAI_BASE_URL is required when model source is enabled");
    }
    if (!(env.OPENAI_API_KEY?.trim() || env.XAI_API_KEY?.trim())) {
      errors.push("OPENAI_API_KEY or XAI_API_KEY is required when model source is enabled");
    }
    if (!["0", "1"].includes(env.MENDPOINT_WARDEN_EXTERNAL_PROCESSING_ALLOWED?.trim() ?? "")) {
      errors.push(
        "MENDPOINT_WARDEN_EXTERNAL_PROCESSING_ALLOWED must explicitly be 0 or 1 when model source is enabled",
      );
    }
    if (
      profile === "customer" &&
      env.MENDPOINT_WARDEN_EXTERNAL_PROCESSING_ALLOWED?.trim() !== "1"
    ) {
      errors.push(
        "Customer worker requires external model processing to be explicitly allowed",
      );
    }
    if (!env.MENDPOINT_WARDEN_MODEL_REGION?.trim()) {
      errors.push("MENDPOINT_WARDEN_MODEL_REGION is required when model source is enabled");
    }
    if (
      !(["public", "internal", "confidential", "restricted"] as const).includes(
        env.MENDPOINT_WARDEN_MODEL_MAXIMUM_DATA_CLASSIFICATION?.trim() as
          | "public"
          | "internal"
          | "confidential"
          | "restricted",
      )
    ) {
      errors.push(
        "MENDPOINT_WARDEN_MODEL_MAXIMUM_DATA_CLASSIFICATION must be public, internal, confidential, or restricted when model source is enabled",
      );
    }
    const estimatedCostText = env.MENDPOINT_WARDEN_MODEL_ESTIMATED_COST_USD?.trim() ?? "";
    const estimatedCostUsd = Number(estimatedCostText);
    if (!estimatedCostText || !Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) {
      errors.push(
        "MENDPOINT_WARDEN_MODEL_ESTIMATED_COST_USD must be a non-negative number when model source is enabled",
      );
    }
    const maximumCallCostText = env.MENDPOINT_WARDEN_MODEL_MAXIMUM_CALL_COST_USD?.trim() ?? "";
    const maximumCallCostUsd = Number(maximumCallCostText);
    if (!maximumCallCostText || !Number.isFinite(maximumCallCostUsd) || maximumCallCostUsd <= 0) {
      errors.push(
        "MENDPOINT_WARDEN_MODEL_MAXIMUM_CALL_COST_USD must be a positive number when model source is enabled",
      );
    }
    if (profile === "customer") {
      const approvedTenants = new Set(
        (env.MENDPOINT_WARDEN_MODEL_SOURCE_TENANTS ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );
      if (customerTenantIds.some((tenantId) => !approvedTenants.has(tenantId))) {
        errors.push(
          "Every customer GitHub account tenant must be approved for Warden model source execution",
        );
      }
      try {
        const classifications = parseWardenRepositoryClassifications(
          env.MENDPOINT_WARDEN_REPOSITORY_CLASSIFICATIONS,
        );
        if (customerTenantIds.some((tenantId) => !classifications[tenantId])) {
          throw new Error("missing");
        }
      } catch {
        errors.push(
          "Customer worker requires a valid stable remote repository classification map for every tenant",
        );
      }
    }
  }
  if (env.MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_ENABLED === "1") {
    if (!(env.MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_TENANTS ?? "").trim()) {
      errors.push(
        "MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_TENANTS is required when Transformer adaptive model source is enabled",
      );
    }
    if (!env.MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_PROVIDER?.trim()) {
      errors.push(
        "MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_PROVIDER is required when Transformer adaptive model source is enabled",
      );
    }
    if (!env.MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_DEPLOYMENT?.trim()) {
      errors.push(
        "MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_DEPLOYMENT is required when Transformer adaptive model source is enabled",
      );
    }
    if (env.MENDPOINT_TRANSFORMER_ADAPTIVE_EXTERNAL_PROCESSING_APPROVED !== "1") {
      errors.push(
        "MENDPOINT_TRANSFORMER_ADAPTIVE_EXTERNAL_PROCESSING_APPROVED must be 1 when Transformer adaptive model source is enabled",
      );
    }
    if (!env.MENDPOINT_TRANSFORMER_ADAPTIVE_EXECUTION_REGION?.trim()) {
      errors.push(
        "MENDPOINT_TRANSFORMER_ADAPTIVE_EXECUTION_REGION is required when Transformer adaptive model source is enabled",
      );
    }
    if (
      !["public", "internal", "confidential", "restricted"].includes(
        env.MENDPOINT_TRANSFORMER_ADAPTIVE_MAX_DATA_CLASSIFICATION?.trim() ?? "",
      )
    ) {
      errors.push(
        "MENDPOINT_TRANSFORMER_ADAPTIVE_MAX_DATA_CLASSIFICATION must be public, internal, confidential, or restricted when Transformer adaptive model source is enabled",
      );
    }
    if (!env.LLM_AGENT_MODEL?.trim()) {
      errors.push("LLM_AGENT_MODEL is required when Transformer adaptive model source is enabled");
    }
    if (!(env.LLM_AGENT_URL?.trim() || env.OPENAI_BASE_URL?.trim())) {
      errors.push(
        "LLM_AGENT_URL or OPENAI_BASE_URL is required when Transformer adaptive model source is enabled",
      );
    }
    if (!(env.OPENAI_API_KEY?.trim() || env.XAI_API_KEY?.trim())) {
      errors.push(
        "OPENAI_API_KEY or XAI_API_KEY is required when Transformer adaptive model source is enabled",
      );
    }
  }
  return [...new Set(errors)];
}

type WardenRepositoryClassification = "public" | "internal" | "confidential" | "restricted";
const WARDEN_REPOSITORY_CLASSIFICATIONS = new Set<WardenRepositoryClassification>([
  "public",
  "internal",
  "confidential",
  "restricted",
]);

function parseWardenRepositoryClassifications(
  encoded: string | undefined,
): Readonly<Record<string, Readonly<Record<string, WardenRepositoryClassification>>>> {
  if (!encoded?.trim()) throw new Error("warden_repository_classification_required");
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("warden_repository_classifications_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("warden_repository_classifications_invalid");
  }
  const result: Record<string, Record<string, WardenRepositoryClassification>> = {};
  const tenantEntries = Object.entries(parsed as Record<string, unknown>);
  if (tenantEntries.length > 500) throw new Error("warden_repository_classifications_invalid");
  for (const [tenantId, value] of tenantEntries) {
    if (!tenantId.trim() || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("warden_repository_classifications_invalid");
    }
    const repositories = Object.entries(value as Record<string, unknown>);
    if (!repositories.length || repositories.length > 5_000) {
      throw new Error("warden_repository_classifications_invalid");
    }
    result[tenantId] = {};
    for (const [remoteId, classification] of repositories) {
      if (!remoteId.trim() || typeof classification !== "string" ||
        !WARDEN_REPOSITORY_CLASSIFICATIONS.has(classification as WardenRepositoryClassification)) {
        throw new Error("warden_repository_classifications_invalid");
      }
      result[tenantId][remoteId] = classification as WardenRepositoryClassification;
    }
  }
  return result;
}

export function resolveWardenRepositoryClassification(
  tenantId: string,
  remoteRepositoryId: string,
  env: NodeJS.ProcessEnv = process.env,
): WardenRepositoryClassification {
  const parsed = parseWardenRepositoryClassifications(
    env.MENDPOINT_WARDEN_REPOSITORY_CLASSIFICATIONS,
  );
  const tenantMap = parsed[tenantId];
  if (!tenantMap) {
    throw new Error("warden_repository_classification_required");
  }
  const classification = tenantMap[remoteRepositoryId];
  if (!classification) {
    throw new Error("warden_repository_classification_required");
  }
  return classification as WardenRepositoryClassification;
}

async function demo() {
  const fenceEnabled = process.env.MENDPOINT_DEPLOYMENT_PROFILE === "customer" ||
    Boolean(process.env.MENDPOINT_BACKUP_FENCE_ROOT?.trim());
  const lease = fenceEnabled
    ? tryAcquireMutationLease(resolveMutationFenceRoot())
    : undefined;
  if (fenceEnabled && !lease) return;
  try {
    const report = await runChangePipeline({
      tenantId: process.env.MENDPOINT_TENANT_ID ?? "tenant_default",
      providerSlug: "acme-payments",
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    lease?.release();
  }
}

export async function runUnseenVersion<T>(
  seen: Set<string>,
  key: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  if (seen.has(key)) return undefined;
  const result = await run();
  seen.add(key);
  return result;
}

async function watch(intervalMs = 30_000) {
  console.log(`Watching for providers with 2 or more versions every ${intervalMs}ms`);
  const db = initializeWorkerDurableState(() => createDb());
  const seen = new Set<string>();
  const fenceEnabled = process.env.MENDPOINT_DEPLOYMENT_PROFILE === "customer" ||
    Boolean(process.env.MENDPOINT_BACKUP_FENCE_ROOT?.trim());
  const fenceRoot = resolveMutationFenceRoot();
  for (;;) {
    for (const provider of listProviders(db)) {
      const versions = listVersionsForProvider(db, provider.id);
      if (versions.length < 2) continue;
      const key = `${provider.slug}:${versions.map((version) => version.version_label).join(">")}`;
      if (seen.has(key)) continue;
      console.log(`Running pipeline for ${provider.slug}`);
      const mutationLease = fenceEnabled
        ? tryAcquireMutationLease(fenceRoot)
        : undefined;
      if (fenceEnabled && !mutationLease) continue;
      try {
        const report = await runUnseenVersion(seen, key, () =>
          runChangePipeline({
            tenantId: process.env.MENDPOINT_TENANT_ID ?? "tenant_default",
            providerSlug: provider.slug,
            db,
          }),
        );
        if (!report) continue;
        console.log(
          `  change ${report.changeId} risk=${report.risk} consumers=${report.consumers.length}`,
        );
      } catch (error) {
        console.error(error);
      } finally {
        mutationLease?.release();
      }
    }
    await processJobsOnce(db);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, intervalMs));
  }
}

async function runFeedPollUnfenced(opts: {
  db: AppDb;
  localOnly: boolean;
  runPipeline: boolean;
  enqueuePipeline?: boolean;
  slugs?: string[];
}) {
  const root = findMonorepoRoot();
  const tenantId = process.env.MENDPOINT_TENANT_ID ?? "tenant_default";
  const results = await pollAllFeeds({
    db: opts.db,
    tenantId,
    monorepoRoot: root,
    localOnly: opts.localOnly,
    runPipeline: opts.runPipeline,
    concurrency: Number(process.env.MENDPOINT_FEED_CONCURRENCY ?? 4),
    slugs: opts.slugs,
    pipeline: opts.enqueuePipeline
      ? async (slug, database, context) => ({
          jobId: enqueueFeedPipelineJob(database, {
            tenantId,
            providerSlug: slug,
            contentHash: context.contentHash,
            versionId: context.versionId,
          }),
        })
      : async (slug, database) => {
          const report = await runChangePipeline({
            tenantId,
            providerSlug: slug,
            db: database,
          });
          return { changeId: report.changeId };
        },
  });
  for (const result of results) {
    const extra = result.error ? ` err=${result.error}` : "";
    console.log(
      `  ${result.slug}: ${result.status}${result.versionLabel ? ` v=${result.versionLabel}` : ""}${result.changeId ? ` change=${result.changeId}` : ""}${result.jobId ? ` job=${result.jobId}` : ""}${extra}`,
    );
  }
  const signals = await probeKnownSdks({
    localOnly: opts.localOnly,
    concurrency: Number(process.env.MENDPOINT_SDK_CONCURRENCY ?? 4),
  });
  console.log(
    `  sdk signals: ${signals.map((signal) => `${signal.packageName}@${signal.latestVersion ?? "?"}`).join(", ")}`,
  );
  return results;
}

async function runFeedPoll(
  opts: Parameters<typeof runFeedPollUnfenced>[0],
): Promise<Awaited<ReturnType<typeof runFeedPollUnfenced>>> {
  const fenceEnabled = process.env.MENDPOINT_DEPLOYMENT_PROFILE === "customer" ||
    Boolean(process.env.MENDPOINT_BACKUP_FENCE_ROOT?.trim());
  if (!fenceEnabled) return runFeedPollUnfenced(opts);
  const lease = tryAcquireMutationLease(resolveMutationFenceRoot());
  if (!lease) return [];
  try {
    return await runFeedPollUnfenced(opts);
  } finally {
    lease.release();
  }
}

async function pollFeeds(opts: {
  loop: boolean;
  intervalMs: number;
  localOnly: boolean;
  runPipeline: boolean;
  slugs?: string[];
}) {
  const db = initializeWorkerDurableState(() => createDb());
  const root = findMonorepoRoot();
  console.log(
    `Feed poll ${opts.loop ? "loop" : "once"} localOnly=${opts.localOnly} pipeline=${opts.runPipeline} root=${root}`,
  );
  console.log(`Catalog feeds: ${listCatalogFeeds().map((feed) => feed.slug).join(", ")}`);

  if (!opts.loop) {
    await runFeedPoll({ ...opts, db });
    return;
  }

  let failures = 0;
  for (;;) {
    try {
      await runFeedPoll({ ...opts, db });
      await processJobsOnce(db);
      failures = 0;
    } catch (error) {
      failures++;
      console.error(error);
    }
    const delay = failures
      ? retryDelayMs(failures, opts.intervalMs)
      : opts.intervalMs;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, delay));
  }
}

function transformerAdaptiveRepositoryResolver(
  db: AppDb,
): ResolveTransformerAdaptiveRepository {
  return ({ tenantId, repositoryId, snapshotId, baseBranch, expectedBaseRevision }) => {
    const repository = getConnectedRepository(db, repositoryId, tenantId);
    if (!repository || repository.status !== "ready") {
      throw new Error("transformer_adaptive_delivery_repository_not_ready");
    }
    const connection = getScmConnection(db, repository.connection_id, tenantId);
    if (!connection || connection.provider !== "github" || connection.revoked_at) {
      throw new Error("transformer_adaptive_delivery_github_connection_required");
    }
    const snapshot = listRepositorySnapshots(db, tenantId, repositoryId)
      .find((candidate) => candidate.id === snapshotId);
    if (
      !snapshot ||
      snapshot.requested_ref !== baseBranch ||
      snapshot.resolved_sha !== expectedBaseRevision
    ) {
      throw new Error("transformer_adaptive_delivery_snapshot_binding_mismatch");
    }
    return Object.freeze({
      owner: repository.owner,
      repo: repository.name,
      baseBranch: snapshot.requested_ref,
    });
  };
}

function transformerAdaptiveConnectedGitHubRepository(
  db: AppDb,
  tenantId: string,
  owner: string,
  repo: string,
) {
  const matches = listConnectedRepositories(db, tenantId).filter(
    (repository) =>
      repository.status === "ready" &&
      repository.owner.toLowerCase() === owner.toLowerCase() &&
      repository.name.toLowerCase() === repo.toLowerCase(),
  );
  if (matches.length !== 1) {
    throw new Error("transformer_adaptive_delivery_connected_repository_ambiguous");
  }
  const repository = matches[0]!;
  const connection = getScmConnection(db, repository.connection_id, tenantId);
  if (!connection || connection.provider !== "github" || connection.revoked_at) {
    throw new Error("transformer_adaptive_delivery_github_connection_required");
  }
  const remoteRepositoryId = Number(repository.remote_id);
  const installationId = Number(connection.external_account_id);
  if (
    !Number.isSafeInteger(remoteRepositoryId) ||
    remoteRepositoryId < 1 ||
    !Number.isSafeInteger(installationId) ||
    installationId < 1
  ) {
    throw new Error("transformer_adaptive_delivery_repository_identity_invalid");
  }
  return Object.freeze({ repository, connection, remoteRepositoryId, installationId });
}

function installationRepositoryId(
  repositoriesJson: string | null,
  owner: string,
  repo: string,
): number | undefined {
  try {
    const repositories = JSON.parse(repositoriesJson ?? "null") as unknown;
    if (!Array.isArray(repositories)) return undefined;
    const match = repositories.find((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const value = candidate as Record<string, unknown>;
      return (
        typeof value.owner === "string" &&
        typeof value.name === "string" &&
        value.owner.toLowerCase() === owner.toLowerCase() &&
        value.name.toLowerCase() === repo.toLowerCase()
      );
    }) as Record<string, unknown> | undefined;
    return Number.isSafeInteger(match?.id) && Number(match!.id) > 0
      ? Number(match!.id)
      : undefined;
  } catch {
    return undefined;
  }
}

export function transformerAdaptiveGitHubDelivery(
  db: AppDb,
  tenantId: string,
  env: NodeJS.ProcessEnv,
): GitHubDelivery {
  const unsupported = async (): Promise<never> => {
    throw new Error("transformer_adaptive_delivery_exact_draft_only");
  };
  return {
    async deliverExactDraft(input: ExactDraftDeliveryInput) {
      if (env.GITHUB_MODE !== "real") {
        throw new Error("transformer_adaptive_delivery_real_github_required");
      }
      const connected = transformerAdaptiveConnectedGitHubRepository(
        db,
        tenantId,
        input.owner,
        input.repo,
      );
      const credentials = loadAppCredentials(env);
      if (credentials) {
        const installation = findAuthorizedGitHubInstallationForRepository(
          db,
          tenantId,
          input.owner,
          input.repo,
        );
        if (!installation) {
          throw new Error("transformer_adaptive_delivery_installation_not_authorized");
        }
        if (!installation.account_id) {
          throw new Error("github_app_installation_account_identity_required");
        }
        const expectedAccountId = resolveGitHubTenantAccountBinding(tenantId, env);
        if (!expectedAccountId) {
          throw new Error("github_app_tenant_account_binding_required");
        }
        if (installation.account_id !== expectedAccountId) {
          throw new Error("github_app_installation_account_identity_mismatch");
        }
        const installationId = Number(installation.installation_id);
        const repositoryId = installationRepositoryId(
          installation.repositories_json,
          input.owner,
          input.repo,
        );
        if (
          !Number.isSafeInteger(installationId) ||
          installationId < 1 ||
          installationId !== connected.installationId ||
          !repositoryId ||
          repositoryId !== connected.remoteRepositoryId
        ) {
          throw new Error("transformer_adaptive_delivery_installation_invalid");
        }
        return createAppDelivery(installationId, credentials, [repositoryId])
          .deliverExactDraft(input);
      }
      const token = env.GITHUB_TOKEN?.trim();
      if (!token) throw new Error("transformer_adaptive_delivery_credentials_missing");
      if (env.MENDPOINT_DEPLOYMENT_CLASS?.trim() !== "disposable_canary") {
        throw new Error("transformer_adaptive_delivery_pat_disposable_canary_required");
      }
      if (env.MENDPOINT_TENANT_ID?.trim() !== tenantId) {
        throw new Error("transformer_adaptive_delivery_pat_tenant_not_pinned");
      }
      const patRepositories = listConnectedRepositories(db, tenantId).filter((repository) => {
        if (repository.status !== "ready") return false;
        const connection = getScmConnection(db, repository.connection_id, tenantId);
        return Boolean(
          connection &&
          connection.provider === "github" &&
          !connection.revoked_at &&
          connection.credential_ref === "env://GITHUB_TOKEN",
        );
      });
      if (
        connected.connection.credential_ref !== "env://GITHUB_TOKEN" ||
        patRepositories.length !== 1 ||
        patRepositories[0]!.id !== connected.repository.id
      ) {
        throw new Error("transformer_adaptive_delivery_pat_repository_not_pinned");
      }
      const delivery = new OctokitGitHubDelivery(token);
      await delivery.assertRepositoryIdentity(
        input.owner,
        input.repo,
        connected.remoteRepositoryId,
      );
      return delivery.deliverExactDraft(input);
    },
    createBranch: unsupported as GitHubDelivery["createBranch"],
    commitFiles: unsupported as GitHubDelivery["commitFiles"],
    openPullRequest: unsupported as GitHubDelivery["openPullRequest"],
  };
}

/**
 * GitLab exact-draft delivery for Transformer's approved candidate: the same
 * sealed intent is delivered as a GitLab draft merge request via the Wave B
 * GitLabDelivery (mock by default; real HTTP over GITLAB_TOKEN when
 * GITLAB_MODE=real). This is token-authenticated draft-MR delivery, not an
 * org-wide GitLab App install. The other GitHubDelivery methods are unused by
 * this delivery path and stay unsupported.
 */
export function transformerAdaptiveGitLabDelivery(env: NodeJS.ProcessEnv): GitHubDelivery {
  const unsupported = async (): Promise<never> => {
    throw new Error("transformer_adaptive_delivery_exact_draft_only");
  };
  const exactDraft = gitlabAsExactDraftDelivery(createGitLabDelivery(env.GITLAB_MODE));
  return {
    deliverExactDraft: (input: ExactDraftDeliveryInput) => exactDraft.deliverExactDraft(input),
    createBranch: unsupported as GitHubDelivery["createBranch"],
    commitFiles: unsupported as GitHubDelivery["commitFiles"],
    openPullRequest: unsupported as GitHubDelivery["openPullRequest"],
  };
}

/**
 * Select the exact-draft delivery provider for an approved candidate. Both the
 * Warden candidate delivery and the Transformer adaptive delivery construction
 * sites route through this selector. SCM_PROVIDER=gitlab routes to the GitLab
 * draft-MR path; anything else (unset or "github") returns the GitHub App / PAT
 * delivery unchanged, so a default deployment is byte-identical.
 */
export function transformerAdaptiveScmDelivery(
  db: AppDb,
  tenantId: string,
  env: NodeJS.ProcessEnv,
): GitHubDelivery {
  if (env.SCM_PROVIDER?.trim().toLowerCase() === "gitlab") {
    return transformerAdaptiveGitLabDelivery(env);
  }
  return transformerAdaptiveGitHubDelivery(db, tenantId, env);
}

async function processJobsOnceUnfenced(
  db: AppDb,
  opts: {
    tenantId?: string;
    workerId?: string;
    leaseMs?: number;
    maxJobs?: number;
    allTenants?: boolean;
    maxRunningPerTenant?: number;
    shouldContinue?: () => boolean;
    runWardenMaintenance?: boolean;
    wardenPlanner?: AgentPlanner;
    wardenEnv?: NodeJS.ProcessEnv;
    pipelineRunner?: typeof runChangePipeline;
    transformerAdaptiveGithub?: GitHubDelivery;
    transformerAdaptiveRepositoryResolver?: ResolveTransformerAdaptiveRepository;
    wardenCandidateGithub?: GitHubDelivery;
    wardenCandidateRepositoryResolver?: ResolveWardenCandidateRepository;
    onActiveJob?: (
      job: { id: string; type: string; leaseGeneration: number } | null,
    ) => void;
  } = {},
): Promise<JobDrainResult> {
  const workerId = opts.workerId ?? WORKER_ID;
  const workerEnv = opts.wardenEnv ?? process.env;
  const leaseMs = parseLeaseMs(opts.leaseMs ?? process.env.JOB_LEASE_MS);
  const maxJobs = Math.max(1, Math.min(opts.maxJobs ?? 25, 100));
  const result: JobDrainResult = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
  };
  if (opts.runWardenMaintenance !== false) {
    try {
      maintainWardenArtifactsOnce(db, workerEnv);
    } catch (error) {
      console.error(
        `  Warden maintenance unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      maintainTransformerAdaptiveArtifactsOnce(db, workerEnv);
    } catch (error) {
      console.error(
        `  Transformer adaptive maintenance unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  for (; result.claimed < maxJobs && opts.shouldContinue?.() !== false; ) {
    const job = claimNextJob(
      db,
      ["pipeline.fanout", "agent.run", "repair.run", "warden.candidate.deliver", "transformer.adaptive.deliver"],
      {
      tenantId: opts.allTenants
        ? undefined
        : opts.tenantId ?? process.env.MENDPOINT_TENANT_ID,
      workerId,
      leaseMs,
      maxRunningPerTenant: opts.maxRunningPerTenant,
      },
    );
    if (!job) break;
    result.claimed++;
    opts.onActiveJob?.({
      id: job.id,
      type: job.type,
      leaseGeneration: job.lease_generation,
    });
    const fence = {
      workerId,
      leaseGeneration: job.lease_generation,
    };
    let leaseLost = false;
    let pendingAgentRun: Readonly<{
      sessionId: string;
      goal: string;
      repoPath: string;
      createdAt: string;
    }> | null = null;
    let pendingWardenRoutingFinalizer: RoutingOutcomeFinalizer;
    if (job.type === "agent.run") {
      const queued = getAgentRunByJobId(db, job.id, job.tenant_id);
      if (queued) {
        pendingAgentRun = {
          sessionId: queued.id,
          goal: queued.goal,
          repoPath: queued.repo_path,
          createdAt: queued.created_at,
        };
      }
    }
    const renewal = setInterval(() => {
      try {
        if (
          !renewJobLease(db, job.id, {
            ...fence,
            leaseMs,
          })
        ) {
          leaseLost = true;
        }
      } catch (error) {
        leaseLost = true;
        console.error(
          `  lease renewal failed job=${job.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }, Math.max(100, Math.floor(leaseMs / 3)));
    renewal.unref();
    try {
      if (job.type === "warden.candidate.deliver") {
        const delivery = await runWardenCandidateDelivery({
          db,
          job,
          github: opts.wardenCandidateGithub ?? transformerAdaptiveScmDelivery(
            db,
            job.tenant_id,
            workerEnv,
          ),
          resolveRepository: opts.wardenCandidateRepositoryResolver ??
            transformerAdaptiveRepositoryResolver(db),
          artifactEnv: workerEnv,
        });
        if (delivery.status === "delivered") result.succeeded++;
        else {
          result.failed++;
          if (delivery.status === "retry_scheduled") result.retried++;
        }
        continue;
      }
      if (job.type === "transformer.adaptive.deliver") {
        const delivery = await runTransformerAdaptiveDelivery({
          db,
          job,
          github: opts.transformerAdaptiveGithub ?? transformerAdaptiveScmDelivery(
            db,
            job.tenant_id,
            workerEnv,
          ),
          resolveRepository: opts.transformerAdaptiveRepositoryResolver ??
            transformerAdaptiveRepositoryResolver(db),
          artifactEnv: workerEnv,
        });
        if (delivery.status === "delivered") result.succeeded++;
        else {
          result.failed++;
          if (delivery.status === "retry_scheduled") result.retried++;
        }
        continue;
      }
      if (job.type === "agent.run") {
        const payload = JSON.parse(job.payload_json) as WardenJobPayload;
        const executionGoal = payload.reviewFeedback
          ? `${payload.goal}\n\nReviewer feedback for this regeneration:\n${payload.reviewFeedback}`
          : payload.goal;
        const sessionId = payload.sessionId ?? pendingAgentRun?.sessionId ?? job.id;
        if (pendingAgentRun && pendingAgentRun.sessionId !== sessionId) {
          throw new Error("warden_agent_run_job_identity_mismatch");
        }
        const sessionRun = getAgentRun(db, sessionId, job.tenant_id);
        if (sessionRun && sessionRun.job_id !== job.id) {
          throw new Error("warden_agent_run_job_identity_mismatch");
        }
        pendingAgentRun ??= {
          sessionId,
          goal: payload.goal ?? "",
          repoPath: "",
          createdAt: nowIso(),
        };
        if (!payload.consumerId) {
          throw new Error("agent.run consumerId is required");
        }
        const consumer = getConsumer(db, payload.consumerId, job.tenant_id);
        if (!consumer) {
          throw new Error("agent.run consumer was not found for the job tenant");
        }
        const consumerRepo = getConsumerRepo(db, consumer.id, job.tenant_id);
        if (!consumerRepo) {
          throw new Error("agent.run consumer repository was not found");
        }
        pendingAgentRun = { ...pendingAgentRun, repoPath: consumerRepo.local_path };
        const started = nowIso();
        const binding = loadWardenSnapshotBinding(
          db,
          job.tenant_id,
          consumerRepo,
          started,
          {
            allowLegacyLocalSource: workerEnv.NODE_ENV !== "production",
            env: workerEnv,
          },
        );
        const wardenPilotSource = binding.sourceKind === "immutable_snapshot"
          ? validatedWardenPilotSource(
              db,
              job.tenant_id,
              consumer.id,
              sessionId,
              binding,
              payload.source,
            )
          : undefined;
        console.log(`Job ${job.id} agent.run ${binding.root}`);

        if (binding.sourceKind === "legacy_local") {
          const warden = await runWarden({
            goal: executionGoal,
            repoRoot: binding.root,
            verifyCommand: payload.verifyCommand,
            errorLog: payload.errorLog,
            maxSteps: payload.maxSteps ?? 20,
            dryRun: payload.dryRun,
            useLlm: payload.useLlm ?? process.env.LLM_AGENT === "1",
            allowNetwork: false,
            sessionId,
            shouldContinue: () =>
              !leaseLost && opts.shouldContinue?.() !== false,
          });
          if (leaseLost || warden.stoppedReason === "lease_lost") {
            throw new Error("lease_lost_during_warden");
          }
          const legacyRun: AgentRunWrite = {
            id: warden.sessionId,
            tenantId: job.tenant_id,
            goal: executionGoal,
            repoPath: binding.root,
            status: warden.ok ? "ok" : "failed",
            ok: warden.ok,
            steps: warden.steps.length,
            filesChanged: warden.filesChanged,
            reportMd: warden.reportMarkdown,
            resultJson: JSON.stringify({
              stoppedReason: warden.stoppedReason,
              verifier: warden.verifier,
              rollback: warden.rollback,
              jobId: job.id,
              product: "warden",
              sourceKind: "legacy_local",
            }),
            createdAt: started,
            finishedAt: nowIso(),
          };
          if (!warden.ok) {
            if (warden.verifier.status === "simulated") {
              persistCompletedAgentJob(db, job.id, fence, {
                sessionId: warden.sessionId,
                ok: false,
                simulated: true,
                stoppedReason: warden.stoppedReason,
              }, legacyRun);
              result.succeeded++;
              continue;
            }
            const failure = persistFailedAgentJob(
              db,
              job.id,
              fence,
              {
                message: `Warden failed: ${warden.stoppedReason}`,
                errorCode: "warden_needs_human",
                retryable: false,
              },
              legacyRun,
            );
            result.failed++;
            if (!failure.applied) console.error(`  stale lease ignored job=${job.id}`);
            continue;
          }
          persistCompletedAgentJob(db, job.id, fence, {
            sessionId: warden.sessionId,
            ok: true,
            steps: warden.steps.length,
            filesChanged: warden.filesChanged,
            stoppedReason: warden.stoppedReason,
            verifier: warden.verifier,
            product: "warden",
            sourceKind: "legacy_local",
          }, legacyRun);
          result.succeeded++;
          continue;
        }

        if (payload.dryRun) throw new Error("warden_snapshot_attempt_dry_run_unsupported");
        if (!Array.isArray(payload.allowedChangedPaths) || !payload.allowedChangedPaths.length) {
          throw new Error("warden_allowed_changed_paths_required");
        }
        // Capture the narrowed value so it survives into the executor closure.
        const allowedChangedPaths = payload.allowedChangedPaths;
        const verification = wardenVerificationPolicy(
          db,
          job.tenant_id,
          binding.snapshotId,
          payload.verifyCommand,
        );
        const useLlm = payload.useLlm ?? workerEnv.LLM_AGENT === "1";
        const modelSourcePolicy = resolveWardenModelSourcePolicy(
          job.tenant_id,
          useLlm,
          workerEnv,
        );
        if (deploymentProfile(workerEnv) === "customer" && !modelSourcePolicy) {
          throw new Error("customer_warden_model_policy_required");
        }
        const repository = getConnectedRepository(db, binding.repositoryId, job.tenant_id);
        if (!repository) throw new Error("warden_connected_repository_not_found");
        const repositoryClassification = modelSourcePolicy
          ? resolveWardenRepositoryClassification(job.tenant_id, repository.remote_id, workerEnv)
          : "restricted";
        const modelAccounting = modelSourcePolicy
          ? createWardenModelAccountingRuntime({
              db,
              tenantId: job.tenant_id,
              jobId: job.id,
              runId: sessionId,
              workerId: fence.workerId,
              leaseGeneration: fence.leaseGeneration,
              provider: modelSourcePolicy.provider,
              configuredModel: modelSourcePolicy.model,
              endpoint: modelSourcePolicy.endpoint,
              maximumCallCostUsd: modelSourcePolicy.maximumCallCostUsd,
              jobBudgetUsd: WARDEN_JOB_MODEL_BUDGET_USD,
            })
          : undefined;
        const dataRoot = privateWardenDirectory(
          resolve(workerEnv.MENDPOINT_DATA_DIR ?? join(process.cwd(), "data")),
        );
        const tenantStorageKey = safeTenantId(job.tenant_id);
        const candidateRoot = privateWardenChildDirectory(
          dataRoot,
          join(dataRoot, "warden-candidates", tenantStorageKey),
        );
        const evidenceRoot = privateWardenChildDirectory(
          dataRoot,
          join(dataRoot, "warden-evidence", tenantStorageKey),
        );
        expireWardenAgentRuns(
          db,
          job.tenant_id,
          candidateRoot,
          evidenceRoot,
        );
        const storage = sweepWardenTenantStorage(
          [candidateRoot, evidenceRoot],
          workerEnv,
          evidenceRoot,
        );
        const candidateExpiresAt = new Date(Math.min(
          Date.parse(storage.expiresAt),
          Date.parse(binding.expiresAt),
        )).toISOString();
        // Durable, policy-routed production execution. The shared router is the
        // dispatcher: it decides (execute vs mandatory human handoff), the
        // Warden attempt is the registered executor, and every decision +
        // outcome is persisted to the durable routing ledger with breaker
        // feedback. Safety persistence is fail-closed before unsafe dispatch.
        // All existing guarantees (lease fencing, snapshot expiry,
        // candidate artifacts, quota, failure codes) are preserved below.
        const routingDescriptor = wardenExecutorDescriptor(
          started,
          modelSourcePolicy,
        );
        const routingRuntime = createWardenRoutingRuntime({
          db,
          tenantId: job.tenant_id,
          jobId: job.id,
          runId: sessionId,
          registry: buildWardenExecutorRegistry(started, modelSourcePolicy),
          deferOutcomePersistence: true,
        });
        pendingWardenRoutingFinalizer = () => routingRuntime.applyPendingOutcome();
        let capturedAttempt: WardenAttemptResult | null = null;
        const routed = await runPolicyRoutedWarden({
          task: {
            goal: executionGoal,
            repoRoot: binding.root,
            tenantId: job.tenant_id,
          },
          routingRequest: wardenRoutingRequest({
            taskId: job.id,
            tenantId: job.tenant_id,
            goal: executionGoal,
            idempotencyKey: sessionId,
            verifyCommand: verification.targetCommand,
            sourceArtifactId: binding.snapshotId,
            classification: repositoryClassification,
            budgetUsd: WARDEN_JOB_MODEL_BUDGET_USD,
            ...(modelSourcePolicy
              ? {
                  modelSource: modelSourcePolicy,
                  externalProcessingAllowed:
                    modelSourcePolicy.externalProcessingAllowed,
                }
              : {}),
          }),
          runtime: routingRuntime,
          // A retry is a new execution with a new routing envelope. Scope the
          // outcome identity to the fenced lease generation so replays inside
          // one execution remain idempotent without colliding with a later
          // retry of the same durable job/session.
          outcomeIdempotencyKey:
            `${job.id}:${sessionId}:lease-${job.lease_generation}:route`,
          // Honest cost + token attribution from the attempt engine's measured
          // model usage. A heuristic-only run made no model call, so every field
          // stays null (never a fabricated measured zero) for the ledger.
          telemetry: () => {
            const attribution = capturedAttempt
              ? wardenRoutingOutcomeAttribution(capturedAttempt)
              : {
                  costUsd: null,
                  inputTokens: null,
                  outputTokens: null,
                  totalTokens: null,
                };
            return {
              actualCostUsd: attribution.costUsd,
              inputTokens: attribution.inputTokens,
              outputTokens: attribution.outputTokens,
              totalTokens: attribution.totalTokens,
              verifierId: "warden-attempt-verifier",
            };
          },
          executor: {
            executorId: routingDescriptor.executorId,
            providerId: routingDescriptor.providerId,
            run: async () => {
              const attempt = await runWardenAttempt({
                scope: { tenantId: job.tenant_id, attemptId: job.id },
                source: {
                  repositoryId: binding.repositoryId,
                  snapshotId: binding.snapshotId,
                  revision: binding.revision,
                  manifestSha256: binding.manifestSha256,
                  sparsePaths: binding.sparsePaths,
                  root: binding.root,
                },
                candidateRoot,
                evidenceRoot,
                task: {
                  goal: executionGoal,
                  errorLog: payload.errorLog,
                  verifyCommand: verification.targetCommand,
                  maxSteps: Math.max(1, Math.min(payload.maxSteps ?? 20, 100)),
                  useLlm,
                  ...(opts.wardenPlanner ? { planner: opts.wardenPlanner } : {}),
                  modelRequired: Boolean(modelSourcePolicy),
                  allowModelSource: Boolean(modelSourcePolicy),
                  ...(modelSourcePolicy ? { modelSourcePolicy } : {}),
                  ...(modelAccounting
                    ? { externalModelAccounting: modelAccounting }
                    : {}),
                  allowNetwork: false,
                  sessionId,
                  neverTouchPaths: [...verification.protectedPaths],
                  shouldContinue: () =>
                    !leaseLost && opts.shouldContinue?.() !== false,
                },
                verification,
                limits: {
                  ...WARDEN_ATTEMPT_LIMITS,
                  allowedChangedPaths: [...allowedChangedPaths],
                },
              });
              capturedAttempt = attempt;
              if (leaseLost || attempt.agent?.stoppedReason === "lease_lost") {
                discardWardenAttempt(attempt, candidateRoot, evidenceRoot);
                throw new Error("lease_lost_during_warden");
              }
              if (Date.parse(candidateExpiresAt) <= Date.now()) {
                discardWardenAttempt(attempt, candidateRoot, evidenceRoot);
                throw new Error("warden_snapshot_expired_during_attempt");
              }
              return synthesizeWardenRun(attempt, sessionId, payload.goal);
            },
          },
        });
        if (modelAccounting) {
          assertWardenModelAccountingSettled(db, {
            tenantId: job.tenant_id,
            jobId: job.id,
            workerId: fence.workerId,
            leaseGeneration: fence.leaseGeneration,
          });
        }
        if (!routed.run) {
          // The router required human review before any autonomous execution.
          // No attempt ran; block autonomous completion with a non-retryable
          // handoff code.
          const handoffReason = routed.routing.reason ?? "human_handoff";
          const failure = persistFailedAgentJob(
            db,
            job.id,
            fence,
            {
              message: `warden_routing_${handoffReason}`,
              errorCode: "warden_needs_human",
              retryable: false,
            },
            {
              id: sessionId,
              tenantId: job.tenant_id,
              goal: payload.goal,
              repoPath: binding.root,
              status: "failed",
              ok: false,
              steps: 0,
              filesChanged: [],
              reportMd: null,
              resultJson: JSON.stringify({
                jobId: job.id,
                product: "warden",
                sourceKind: "immutable_snapshot",
                ...(wardenPilotSource ? { intake: wardenPilotSource } : {}),
                routing: {
                  action: routed.routing.action,
                  envelopeId: routed.routing.envelopeId,
                  reason: handoffReason,
                },
              }),
              createdAt: started,
              finishedAt: nowIso(),
            },
          );
          result.failed++;
          if (!failure.applied) console.error(`  stale lease ignored job=${job.id}`);
          console.log(
            `  Warden routing requires human review session=${sessionId} reason=${handoffReason}`,
          );
          continue;
        }
        const attempt = capturedAttempt!;
        const noAction = attempt.status === "rejected" &&
          attempt.code === "warden_attempt_baseline_target_green";
        const ok = attempt.status === "succeeded" || noAction;
        const runWrite: AgentRunWrite = {
          id: sessionId,
          tenantId: job.tenant_id,
          goal: payload.goal,
          repoPath: binding.root,
          status: attempt.status === "succeeded" ? "candidate_ready" : noAction ? "no_action" : "failed",
          ok,
          steps: attempt.agent?.steps ?? 0,
          filesChanged: attempt.status === "succeeded" ? [...attempt.changedPaths] : [],
          reportMd: attempt.agent?.reportMarkdown ?? null,
          resultJson: JSON.stringify({
            jobId: job.id,
            product: "warden",
            sourceKind: "immutable_snapshot",
            ...(wardenPilotSource ? { intake: wardenPilotSource } : {}),
            attemptStatus: attempt.status,
            ...(attempt.status === "rejected" ? { code: attempt.code } : {}),
            summary: attempt.summary,
            source: {
              repositoryId: binding.repositoryId,
              snapshotId: binding.snapshotId,
              revision: binding.revision,
              manifestSha256: binding.manifestSha256,
            },
            changedPaths: attempt.changedPaths,
            artifacts: attempt.artifacts,
            retention: {
              expiresAt: candidateExpiresAt,
              retainedBytesBeforeAttempt: storage.retainedBytes,
            },
            agent: attempt.agent ?? null,
          }),
          createdAt: started,
          finishedAt: nowIso(),
        };
        if (attempt.status === "rejected" && !noAction) {
          const retryable = attempt.code === "warden_attempt_internal_error" ||
            ["request_timeout", "http_error"].includes(attempt.agent?.stoppedReason ?? "");
          const failure = persistFailedAgentJob(
            db,
            job.id,
            fence,
            {
              message: `${attempt.code}: ${attempt.summary}`,
              errorCode: attempt.code,
              retryable,
            },
            runWrite,
            pendingWardenRoutingFinalizer,
          );
          result.failed++;
          if (failure.status === "pending") result.retried++;
          if (!failure.applied) console.error(`  stale lease ignored job=${job.id}`);
          continue;
        }
        try {
          persistCompletedAgentJob(
            db,
            job.id,
            fence,
            attempt.status === "succeeded"
              ? {
                  sessionId,
                  ok: true,
                  status: "candidate_ready",
                  filesChanged: attempt.changedPaths,
                  artifacts: attempt.artifacts,
                  expiresAt: candidateExpiresAt,
                  product: "warden",
                }
              : {
                  sessionId,
                  ok: true,
                  status: "no_action",
                  product: "warden",
                },
            runWrite,
            pendingWardenRoutingFinalizer,
          );
        } catch (error) {
          discardWardenAttempt(attempt, candidateRoot, evidenceRoot);
          throw error;
        }
        result.succeeded++;
        console.log(`  Warden ${attempt.status === "succeeded" ? "candidate ready" : "no action"} session=${sessionId}`);
        continue;
      }

      if (job.type === "repair.run") {
        const payload = JSON.parse(job.payload_json) as {
          sessionId: string;
          consumerId: string;
          renameMap?: Record<string, string>;
          maxAttempts?: number;
          dryRun?: boolean;
          useLlm?: boolean;
        };
        const consumer = getConsumer(db, payload.consumerId, job.tenant_id);
        if (!consumer) throw new Error("repair consumer was not found for the job tenant");
        const consumerRepo = getConsumerRepo(db, consumer.id, job.tenant_id);
        if (!consumerRepo) throw new Error("repair consumer repository was not found");
        const repoPath = resolveWorkerRepoPath(consumerRepo.local_path, job.tenant_id);
        const started = nowIso();
        const repair = await runRepairSession({
          sessionId: payload.sessionId,
          repoRoot: repoPath,
          renameMap: payload.renameMap,
          maxAttempts: payload.maxAttempts,
          dryRun: payload.dryRun,
          useLlm: payload.useLlm,
          shouldContinue: () =>
            !leaseLost && opts.shouldContinue?.() !== false,
        });
        if (leaseLost || repair.stopReason === "lease_lost") {
          throw new Error("lease_lost_during_repair");
        }
        insertRepairSession(db, {
          id: repair.sessionId,
          tenantId: job.tenant_id,
          consumerId: consumer.id,
          repoPath,
          status: repair.simulated ? "simulated" : repair.ok ? "verified" : "needs_human",
          attempts: repair.attempts,
          editsCount: repair.edits.length,
          ok: repair.ok,
          reportMd: repair.reportMarkdown,
          resultJson: JSON.stringify({
            jobId: job.id,
            stopReason: repair.stopReason,
            simulated: repair.simulated,
            plans: repair.plans,
            edits: repair.edits.map((edit) => ({
              filePath: edit.filePath,
              reason: edit.reason,
            })),
            failureFingerprints: repair.failureFingerprints,
            actionFingerprints: repair.actionFingerprints,
            policyNotes: repair.policyNotes,
          }),
          createdAt: started,
          finishedAt: nowIso(),
        });
        if (!repair.ok && !repair.simulated) {
          const failure = failJob(
            db,
            job.id,
            `Repair needs human review: ${repair.stopReason}`,
            nowIso(),
            {
              ...fence,
              errorCode: "repair_needs_human",
              retryable: false,
            },
          );
          result.failed++;
          if (!failure.applied) console.error(`  stale lease ignored job=${job.id}`);
          continue;
        }
        if (leaseLost) throw new Error("lease_lost_before_repair_completion");
        if (
          !completeJob(
            db,
            job.id,
            {
              sessionId: repair.sessionId,
              ok: repair.ok,
              simulated: repair.simulated,
              stopReason: repair.stopReason,
              edits: repair.edits.length,
            },
            nowIso(),
            fence,
          )
        ) {
          throw new Error("lease_lost_before_repair_completion");
        }
        result.succeeded++;
        console.log(
          `  repair ${repair.simulated ? "simulated" : "verified"} session=${repair.sessionId}`,
        );
        continue;
      }

      const payload = JSON.parse(job.payload_json) as {
        providerSlug: string;
        consumerIds?: string[];
        severity?: "required" | "recommended" | "optional";
        notificationsOnly?: boolean;
        wardenPilot?: boolean;
        contractCases?: ContractCase[];
        securityScanOk?: boolean;
        repairVerifyCommands?: string[];
      };
      console.log(`Job ${job.id} pipeline.fanout ${payload.providerSlug}`);
      const pipelineRunner = opts.pipelineRunner ?? runChangePipeline;
      const report = await pipelineRunner({
        tenantId: job.tenant_id,
        providerSlug: payload.providerSlug,
        db,
        consumerIds: payload.consumerIds,
        severity: payload.severity,
        notificationsOnly: payload.wardenPilot ? true : payload.notificationsOnly,
        contractCases: payload.contractCases,
        securityScanOk: payload.securityScanOk,
        repairVerifyCommands: payload.repairVerifyCommands,
        shouldContinue: () =>
          !leaseLost && opts.shouldContinue?.() !== false,
      });
      const deliveryFailures = report.consumers.filter(
        (consumer) => consumer.prStatus === "delivery_failed",
      );
      if (deliveryFailures.length) {
        throw new Error(
          `pipeline_delivery_failed:${deliveryFailures
            .map(
              (consumer) =>
                `${consumer.consumerId}:${consumer.deliveryError ?? "unknown delivery error"}`,
            )
            .join("|")}`,
        );
      }
      if (leaseLost) throw new Error("lease_lost_before_pipeline_completion");
      if (payload.wardenPilot) {
        db.raw.exec("BEGIN IMMEDIATE");
        try {
          const joinedWardenRuns = enqueuePipelineWardenRuns(db, {
            tenantId: job.tenant_id,
            pipelineJobId: job.id,
            providerSlug: payload.providerSlug,
            report,
            observedAt: nowIso(),
            useLlm: true,
          });
          if (
            !completeJob(
              db,
              job.id,
              {
                changeId: report.changeId,
                consumers: report.consumers,
                wardenRuns: joinedWardenRuns,
              },
              nowIso(),
              fence,
            )
          ) {
            throw new Error("lease_lost_before_pipeline_completion");
          }
          db.raw.exec("COMMIT");
        } catch (error) {
          if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
          throw error;
        }
        settleFanoutRunUsage(db, job.tenant_id, payload);
        result.succeeded++;
        console.log(`  done change=${report.changeId}`);
        continue;
      }
      if (
        !completeJob(
          db,
          job.id,
          {
            changeId: report.changeId,
            consumers: report.consumers,
            wardenRuns: [],
          },
          nowIso(),
          fence,
        )
      ) {
        throw new Error("lease_lost_before_pipeline_completion");
      }
      settleFanoutRunUsage(db, job.tenant_id, payload);
      result.succeeded++;
      console.log(`  done change=${report.changeId}`);
    } catch (error) {
      if (error instanceof WardenAtomicFinalizationError) throw error;
      const classified = classifyJobFailure(error);
      const failure = pendingAgentRun || pendingWardenRoutingFinalizer
        ? persistFailedAgentJob(
            db,
            job.id,
            fence,
            classified,
            pendingAgentRun
              ? {
                  id: pendingAgentRun.sessionId,
                  tenantId: job.tenant_id,
                  goal: pendingAgentRun.goal,
                  repoPath: pendingAgentRun.repoPath,
                  status: "failed",
                  ok: false,
                  steps: 0,
                  filesChanged: [],
                  reportMd: null,
                  resultJson: JSON.stringify({
                    jobId: job.id,
                    product: "warden",
                    code: classified.errorCode,
                    summary: classified.message,
                  }),
                  createdAt: pendingAgentRun.createdAt,
                  finishedAt: nowIso(),
                }
              : null,
            pendingWardenRoutingFinalizer,
          )
        : failJob(db, job.id, classified.message, nowIso(), {
            ...fence,
            errorCode: classified.errorCode,
            retryable: classified.retryable,
            baseDelayMs: 5_000,
            maxDelayMs: 300_000,
          });
      result.failed++;
      if (failure.status === "pending") result.retried++;
      // Wave C: a terminally failed fanout run releases its usage hold (infra failure
      // burns no quota). Retryable failures keep the hold for the retried run.
      if (
        job.type === "pipeline.fanout" &&
        failure.applied &&
        failure.status === "dead_letter"
      ) {
        releaseFanoutRunUsage(db, job.tenant_id, job.payload_json, job.id);
      }
      console.error(`  failed: ${classified.message}`);
      if (!failure.applied) console.error(`  stale lease ignored job=${job.id}`);
    } finally {
      clearInterval(renewal);
      opts.onActiveJob?.(null);
    }
  }
  if (!result.claimed) console.log("No pending jobs");
  return result;
}

export async function processJobsOnce(
  db: AppDb | undefined = undefined,
  opts: NonNullable<Parameters<typeof processJobsOnceUnfenced>[1]> = {},
): Promise<JobDrainResult> {
  const env = opts.wardenEnv ?? process.env;
  const runtimeDb = db ?? initializeWorkerDurableState(() => createDb(), env);
  const fenceEnabled = env.MENDPOINT_DEPLOYMENT_PROFILE === "customer" ||
    Boolean(env.MENDPOINT_BACKUP_FENCE_ROOT?.trim());
  if (!fenceEnabled) return processJobsOnceUnfenced(runtimeDb, opts);
  const lease = tryAcquireMutationLease(resolveMutationFenceRoot(env));
  if (!lease) {
    return { claimed: 0, succeeded: 0, failed: 0, retried: 0 };
  }
  try {
    return await processJobsOnceUnfenced(runtimeDb, opts);
  } finally {
    lease.release();
  }
}

async function runJobWorker(intervalMs: number) {
  const db = initializeWorkerDurableState(() => createDb());
  let failures = 0;
  for (;;) {
    try {
      const result = await processJobsOnce(db);
      failures = result.failed > 0 ? failures + 1 : 0;
    } catch (error) {
      failures++;
      console.error(error);
    }
    const delay = failures ? retryDelayMs(failures, intervalMs) : intervalMs;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, delay));
  }
}

async function runService(intervalMs: number) {
  const jobConcurrency = parseJobConcurrency(process.env.MENDPOINT_JOB_CONCURRENCY);
  const durableState = initializeWorkerDurableState(() => ({
    feedDb: createDb(),
    heartbeatDb: createDb(),
    transformerDb: createDb(),
    transformerStore: new TransformerPilotExecutionStore(
      transformerPilotWorkerPath(),
    ),
    jobDbs: Array.from({ length: jobConcurrency }, () => createDb()),
  }));
  const { feedDb, heartbeatDb, transformerDb, transformerStore, jobDbs } = durableState;
  const heartbeatPath = process.env.MENDPOINT_WORKER_HEARTBEAT_PATH;
  if (!heartbeatPath) {
    throw new Error("MENDPOINT_WORKER_HEARTBEAT_PATH is required for run-service");
  }
  const configuredTenantId = process.env.MENDPOINT_TENANT_ID?.trim() || undefined;
  const customerProfile = deploymentProfile(process.env) === "customer";
  const mutationFenceEnabled = customerProfile ||
    Boolean(process.env.MENDPOINT_BACKUP_FENCE_ROOT?.trim());
  const mutationFenceRoot = resolveMutationFenceRoot();
  let feedPollingEnabled = process.env.MENDPOINT_FEED_POLLING_ENABLED !== "0";
  const readFeedEvidence = (nowMs = Date.now()) =>
    summarizeCustomerFeedEvidence(
      listFeedSchedules(feedDb, configuredTenantId),
      nowMs,
    );
  let feedEvidence = readFeedEvidence();
  let feedPollOk = !customerProfile || feedEvidence.fresh;
  let feedPollStartedAt: string | undefined;
  let jobs: JobDrainResult = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
  };
  let transformer: TransformerPilotLaneHeartbeat = {
    enabled: Boolean(process.env.MENDPOINT_TRANSFORMER_GATE?.trim()),
    active: false,
    expired: 0,
    attempted: 0,
    completed: 0,
    failed: 0,
    stale: 0,
    idle: 0,
    errors: [],
  };
  const activeJobs = new Map<number, NonNullable<WorkerHeartbeat["activeJob"]>>();
  const laneJobs = Array.from({ length: jobConcurrency }, (): JobDrainResult => ({
    claimed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
  }));
  const shutdown = new AbortController();
  const requestShutdown = () => shutdown.abort();
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);
  const emitHeartbeat = () => {
    try {
      const feedFreshness = assessFeedFreshness({
        lastSuccessAt: feedEvidence.lastSuccessAt,
        staleAfterMs: feedEvidence.staleAfterMs,
        pollStartedAt: feedPollStartedAt,
      });
      const recovery = getJobRecoverySummary(heartbeatDb, configuredTenantId);
      writeWorkerHeartbeat(heartbeatPath, {
        ok: true,
        workerId: WORKER_ID,
        recordedAt: nowIso(),
        jobs,
        activeJob: activeJobs.values().next().value ?? null,
        activeJobs: [...activeJobs.values()],
        recovery: {
          due: recovery.due,
          scheduled: recovery.scheduled,
          running: recovery.running,
          deadLetter: recovery.deadLetter,
          expiredLeases: recovery.expiredLeases,
        },
        transformer,
        feedPollingEnabled,
        feedPollOk: feedPollOk && (!customerProfile || feedFreshness.ok),
        feedScheduleCount: feedEvidence.scheduleCount,
        ...(feedEvidence.lastSuccessAt
          ? { feedLastSuccessAt: feedEvidence.lastSuccessAt }
          : {}),
        ...(feedEvidence.staleAfterMs !== undefined
          ? { feedStaleAfterMs: feedEvidence.staleAfterMs }
          : {}),
        ...(feedPollStartedAt ? { feedPollStartedAt } : {}),
      });
    } catch (error) {
      console.error(error);
    }
  };
  emitHeartbeat();
  const heartbeatTimer = setInterval(
    emitHeartbeat,
    Math.max(1_000, Math.min(intervalMs, 5_000)),
  );
  heartbeatTimer.unref();

  const runFeedLane = async () => {
    let failures = 0;
    while (!shutdown.signal.aborted) {
      feedPollingEnabled = process.env.MENDPOINT_FEED_POLLING_ENABLED !== "0";
      if (!customerProfile) feedPollOk = true;
      if (feedPollingEnabled) {
        const mutationLease = mutationFenceEnabled
          ? tryAcquireMutationLease(mutationFenceRoot)
          : undefined;
        if (mutationFenceEnabled && !mutationLease) {
          await waitForWorkerDelay(intervalMs, shutdown.signal);
          continue;
        }
        feedPollStartedAt = nowIso();
        try {
          const scheduled = await runFeedSchedules({
            db: feedDb,
            tenantId: configuredTenantId,
            defaultIntervalMs: parseIntervalMs(process.env.POLL_INTERVAL_MS, intervalMs),
            defaultStaleAfterMs: Number(process.env.POLL_STALE_AFTER_MS ?? intervalMs * 2),
            maxConcurrency: Number(process.env.MENDPOINT_FEED_CONCURRENCY ?? 4),
            localOnly: process.env.POLL_LOCAL_ONLY === "1",
            runPipeline: true,
            pipeline: async (slug, database, context) => ({
              jobId: enqueueFeedPipelineJob(database, {
                tenantId: context.tenantId,
                providerSlug: slug,
                contentHash: context.contentHash,
                versionId: context.versionId,
              }),
            }),
          });
          feedEvidence = readFeedEvidence();
          feedPollOk = scheduled.failed === 0 && scheduled.health.ok && (
            !customerProfile || feedEvidence.fresh
          );
          console.log(
            `Feed schedules: claimed=${scheduled.claimed} succeeded=${scheduled.succeeded} failed=${scheduled.failed} replayed=${scheduled.alreadyClaimed} health=${scheduled.health.status}`,
          );
        } catch (error) {
          feedPollOk = false;
          console.error(error);
        } finally {
          feedPollStartedAt = undefined;
          mutationLease?.release();
        }
      } else {
        feedPollStartedAt = undefined;
      }
      failures = feedPollOk ? 0 : failures + 1;
      emitHeartbeat();
      const delay = failures ? retryDelayMs(failures, intervalMs) : intervalMs;
      await waitForWorkerDelay(delay, shutdown.signal);
    }
  };

  const runJobLane = async (lane: number) => {
    let failures = 0;
    while (!shutdown.signal.aborted) {
      laneJobs[lane] = {
        claimed: 0,
        succeeded: 0,
        failed: 0,
        retried: 0,
      };
      try {
        laneJobs[lane] = await processJobsOnce(jobDbs[lane]!, {
          allTenants: !configuredTenantId,
          tenantId: configuredTenantId,
          workerId: `${WORKER_ID}:lane:${lane}`,
          maxRunningPerTenant: 1,
          runWardenMaintenance: lane === 0,
          shouldContinue: () => !shutdown.signal.aborted,
          onActiveJob: (job) => {
            if (job) activeJobs.set(lane, job);
            else activeJobs.delete(lane);
            emitHeartbeat();
          },
        });
      } catch (error) {
        laneJobs[lane]!.failed++;
        console.error(error);
      }
      jobs = laneJobs.reduce(
        (total, laneResult) => ({
          claimed: total.claimed + laneResult.claimed,
          succeeded: total.succeeded + laneResult.succeeded,
          failed: total.failed + laneResult.failed,
          retried: total.retried + laneResult.retried,
        }),
        { claimed: 0, succeeded: 0, failed: 0, retried: 0 },
      );
      failures = laneJobs[lane]!.failed === 0 ? 0 : failures + 1;
      emitHeartbeat();
      const delay = failures ? retryDelayMs(failures, intervalMs) : intervalMs;
      await waitForWorkerDelay(delay, shutdown.signal);
    }
  };

  const dataRoot = resolve(
    process.env.MENDPOINT_DATA_DIR ?? join(process.cwd(), "data"),
  );
  const runTransformerLane = async () => {
    let failures = 0;
    while (!shutdown.signal.aborted) {
      transformer = transformerPilotHeartbeatStarted(transformer, nowIso());
      emitHeartbeat();
      const mutationLease = mutationFenceEnabled
        ? tryAcquireMutationLease(mutationFenceRoot)
        : undefined;
      if (mutationFenceEnabled && !mutationLease) {
        await waitForWorkerDelay(intervalMs, shutdown.signal);
        continue;
      }
      try {
        const result = await runTransformerPilotLaneOnce({
          db: transformerDb,
          store: transformerStore,
          gateConfig: process.env.MENDPOINT_TRANSFORMER_GATE,
          tenantId: configuredTenantId,
          workerId: WORKER_ID,
          evidenceRoot: process.env.MENDPOINT_TRANSFORMER_EVIDENCE_ROOT ??
            join(dataRoot, "transformer-evidence"),
          candidateRoot: process.env.MENDPOINT_TRANSFORMER_CANDIDATE_ROOT ??
            join(dataRoot, "transformer-candidates"),
          tempRoot: process.env.MENDPOINT_TRANSFORMER_TEMP_ROOT ??
            join(dataRoot, "transformer-workspaces"),
          leaseDurationMs: Number(
            process.env.MENDPOINT_TRANSFORMER_LEASE_MS ?? 15 * 60_000,
          ),
          shouldContinue: () => !shutdown.signal.aborted,
          adaptiveCandidateDataRoot: dataRoot,
          ...transformerAdaptiveProductionPorts(process.env, transformerDb),
        });
        transformer = transformerPilotHeartbeatAfterResult(transformer, result, nowIso());
        failures = result.infrastructureError ? failures + 1 : 0;
      } catch (error) {
        failures++;
        transformer = transformerPilotHeartbeatAfterFailure(transformer, error, nowIso());
        console.error(error);
      } finally {
        mutationLease?.release();
      }
      emitHeartbeat();
      const delay = failures ? retryDelayMs(failures, intervalMs) : intervalMs;
      await waitForWorkerDelay(delay, shutdown.signal);
    }
  };

  const lanes = startIndependentWorkerLanes({
    feeds: runFeedLane,
    jobs: () => startConcurrentJobLanes(jobConcurrency, runJobLane),
  });
  try {
    await Promise.all([lanes.feeds, lanes.jobs, runTransformerLane()]);
  } finally {
    clearInterval(heartbeatTimer);
    process.off("SIGTERM", requestShutdown);
    process.off("SIGINT", requestShutdown);
    feedDb.raw.close();
    transformerStore.close();
    transformerDb.raw.close();
    for (const jobDb of jobDbs) jobDb.raw.close();
    heartbeatDb.raw.close();
  }
}

export function parseArgs(argv: string[]) {
  const flags = new Set(argv);
  const get = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    localOnly: flags.has("--local") || process.env.POLL_LOCAL_ONLY === "1",
    noPipeline: flags.has("--no-pipeline"),
    intervalMs: parseIntervalMs(
      get("--interval") ?? process.env.POLL_INTERVAL_MS,
      60_000,
    ),
    slugs: get("--slug") ? [get("--slug")!] : undefined,
  };
}

function isMain(): boolean {
  return Boolean(process.argv[1]) &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

async function main() {
  const envErrors = validateWorkerProductionEnv();
  if (envErrors.length) {
    throw new Error(`Worker production configuration failed: ${envErrors.join("; ")}`);
  }
  const cmd = process.argv[2] ?? "demo";
  const args = parseArgs(process.argv.slice(3));

  if (cmd === "demo") {
    await demo();
  } else if (cmd === "watch") {
    await watch(args.intervalMs);
  } else if (cmd === "poll-once" || cmd === "poll") {
    await pollFeeds({
      loop: cmd === "poll",
      intervalMs: args.intervalMs,
      localOnly: args.localOnly || cmd === "poll-once",
      runPipeline: !args.noPipeline,
      slugs: args.slugs,
    });
  } else if (cmd === "feeds") {
    const db = initializeWorkerDurableState(() => createDb());
    console.log(
      JSON.stringify({ catalog: listCatalogFeeds(), recent: listFeedPolls(db, 20) }, null, 2),
    );
  } else if (cmd === "jobs" || cmd === "process-jobs") {
    const result = await processJobsOnce();
    if (cmd === "jobs") {
      console.log(
        JSON.stringify(
          listJobs(
            initializeWorkerDurableState(() => createDb()),
            20,
            process.env.MENDPOINT_TENANT_ID,
          ),
          null,
          2,
        ),
      );
    }
    console.log(JSON.stringify(result));
    if (result.failed > 0) process.exitCode = 1;
  } else if (cmd === "run-jobs") {
    await runJobWorker(args.intervalMs);
  } else if (cmd === "run-service") {
    await runService(args.intervalMs);
  } else if (cmd === "run-transformer-service") {
    await runTransformerServiceCli();
    await new Promise(() => undefined);
  } else if (cmd === "sdk-signals") {
    console.log(JSON.stringify(await probeKnownSdks({ localOnly: args.localOnly }), null, 2));
  } else {
    console.log(`Usage: worker [demo|watch|poll-once|poll|feeds|jobs|process-jobs|run-jobs|run-service|run-transformer-service|sdk-signals]
  poll-once [--local] [--no-pipeline] [--slug acme-payments]
  poll [--local] [--interval 60000]
  process-jobs
  run-jobs [--interval 5000]
  run-service [--interval 5000]
  run-transformer-service
  sdk-signals [--local]`);
    process.exitCode = 1;
  }
}

if (isMain()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
