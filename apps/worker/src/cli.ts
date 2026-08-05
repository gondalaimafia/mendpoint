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
  getConsumer,
  getConsumerRepo,
  getJob,
  getAgentRun,
  getAgentRunByJobId,
  getJobRecoverySummary,
  getRepositorySnapshotPolicy,
  insertAgentRun,
  insertRepairSession,
  listFeedPolls,
  listJobs,
  listProviders,
  listVersionsForProvider,
  type AppDb,
} from "@mendpoint/db";
import {
  listCatalogFeeds,
  pollAllFeeds,
  probeKnownSdks,
  runFeedSchedules,
} from "@mendpoint/catalog";
import { nowIso } from "@mendpoint/shared";
import { loadAppCredentials } from "@mendpoint/github";
import {
  runWarden,
  runWardenAttempt,
  resolveAgentModelEndpoint,
  type AgentModelSourcePolicy,
  type AgentPlanner,
  type WardenAttemptLimits,
  type WardenAttemptResult,
} from "@mendpoint/agent";
import { runRepairSession } from "@mendpoint/repair";
import { TransformerPilotExecutionStore } from "@mendpoint/transformer";
import type { ContractCase } from "@mendpoint/contract";
import {
  runTransformerPilotLaneOnce,
  transformerPilotWorkerPath,
  type TransformerPilotLaneResult,
} from "./transformer-pilot-lane.js";
import { loadWardenSnapshotBinding } from "./warden-snapshot-loader.js";

const WORKER_ID =
  process.env.MENDPOINT_WORKER_ID ?? `worker:${process.pid}:${randomUUID()}`;
const wardenMaintenanceRowOffsets = new Map<string, number>();
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
};

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
  maxChangedFiles: 40,
  maxChangedBytes: 4 * 1024 * 1024,
  maxEvidenceBytes: 512 * 1024,
  verificationTimeoutMs: 120_000,
}) satisfies Omit<WardenAttemptLimits, "allowedChangedPaths">;

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

export function resolveWardenModelSourcePolicy(
  tenantId: string,
  useLlm: boolean,
  env: NodeJS.ProcessEnv = process.env,
): AgentModelSourcePolicy | undefined {
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
  if (!provider || !model || !endpoint) {
    throw new Error("warden_model_source_policy_incomplete");
  }
  const canonical = JSON.stringify({ schemaVersion: 1, tenantId, provider, model, endpoint });
  return Object.freeze({
    approved: true,
    tenantId,
    provider,
    model,
    endpoint,
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
    status IN ('candidate_ready', 'candidate_approved') OR
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

type AgentRunWrite = Parameters<typeof insertAgentRun>[1];
type JobFence = Readonly<{ workerId: string; leaseGeneration: number }>;

function persistCompletedAgentJob(
  db: AppDb,
  jobId: string,
  fence: JobFence,
  jobResult: unknown,
  run: AgentRunWrite,
): void {
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    if (!completeJob(db, jobId, jobResult, nowIso(), fence)) {
      throw new Error("lease_lost_before_warden_completion");
    }
    insertAgentRun(db, { ...run, jobId });
    db.raw.exec("COMMIT");
  } catch (error) {
    db.raw.exec("ROLLBACK");
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
  run: AgentRunWrite,
) {
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const failure = failJob(db, jobId, failureInput.message, nowIso(), {
      ...fence,
      errorCode: failureInput.errorCode,
      retryable: failureInput.retryable,
      baseDelayMs: 5_000,
      maxDelayMs: 300_000,
    });
    if (failure.applied) {
      insertAgentRun(db, {
        ...run,
        jobId,
        status: failure.status === "pending" ? "retrying" : run.status,
        finishedAt: failure.status === "pending" ? null : run.finishedAt,
      });
    }
    db.raw.exec("COMMIT");
    return failure;
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function validateWorkerProductionEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (env.NODE_ENV !== "production") return [];
  const errors: string[] = [];
  if (env.GITHUB_MODE !== "mock" && env.GITHUB_MODE !== "real") {
    errors.push("GITHUB_MODE must be explicitly set to mock or real");
  }
  const hasAnyAppCredential = Boolean(
    env.GITHUB_APP_ID?.trim() ||
    env.GITHUB_APP_PRIVATE_KEY?.trim() ||
    env.GITHUB_APP_PRIVATE_KEY_PATH?.trim(),
  );
  const appCredentials = loadAppCredentials(env);
  if (
    env.GITHUB_MODE === "real" &&
    !env.GITHUB_TOKEN?.trim() &&
    !appCredentials
  ) {
    errors.push("GITHUB_TOKEN or complete GitHub App credentials are required for real worker delivery");
  }
  if (hasAnyAppCredential && !appCredentials) {
    errors.push(
      "GitHub App credentials must include a positive app ID and a readable RSA private key",
    );
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
  }
  return errors;
}

async function demo() {
  const report = await runChangePipeline({
    tenantId: process.env.MENDPOINT_TENANT_ID ?? "tenant_default",
    providerSlug: "acme-payments",
  });
  console.log(JSON.stringify(report, null, 2));
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
  const db = createDb();
  const seen = new Set<string>();
  for (;;) {
    for (const provider of listProviders(db)) {
      const versions = listVersionsForProvider(db, provider.id);
      if (versions.length < 2) continue;
      const key = `${provider.slug}:${versions.map((version) => version.version_label).join(">")}`;
      if (seen.has(key)) continue;
      console.log(`Running pipeline for ${provider.slug}`);
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
      }
    }
    await processJobsOnce(db);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, intervalMs));
  }
}

async function runFeedPoll(opts: {
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

async function pollFeeds(opts: {
  loop: boolean;
  intervalMs: number;
  localOnly: boolean;
  runPipeline: boolean;
  slugs?: string[];
}) {
  const db = createDb();
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

export async function processJobsOnce(
  db = createDb(),
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
  }
  for (; result.claimed < maxJobs && opts.shouldContinue?.() !== false; ) {
    const job = claimNextJob(db, ["pipeline.fanout", "agent.run", "repair.run"], {
      tenantId: opts.allTenants
        ? undefined
        : opts.tenantId ?? process.env.MENDPOINT_TENANT_ID,
      workerId,
      leaseMs,
      maxRunningPerTenant: opts.maxRunningPerTenant,
    });
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
      if (job.type === "agent.run") {
        const payload = JSON.parse(job.payload_json) as WardenJobPayload;
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
        console.log(`Job ${job.id} agent.run ${binding.root}`);

        if (binding.sourceKind === "legacy_local") {
          const warden = await runWarden({
            goal: payload.goal,
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
            goal: payload.goal,
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
            goal: payload.goal,
            errorLog: payload.errorLog,
            verifyCommand: verification.targetCommand,
            maxSteps: Math.max(1, Math.min(payload.maxSteps ?? 20, 100)),
            useLlm,
            ...(opts.wardenPlanner ? { planner: opts.wardenPlanner } : {}),
            modelRequired: Boolean(modelSourcePolicy),
            allowModelSource: Boolean(modelSourcePolicy),
            ...(modelSourcePolicy ? { modelSourcePolicy } : {}),
            allowNetwork: false,
            sessionId,
            neverTouchPaths: [...verification.protectedPaths],
            shouldContinue: () =>
              !leaseLost && opts.shouldContinue?.() !== false,
          },
          verification,
          limits: {
            ...WARDEN_ATTEMPT_LIMITS,
            allowedChangedPaths: [...payload.allowedChangedPaths],
          },
        });
        if (leaseLost || attempt.agent?.stoppedReason === "lease_lost") {
          discardWardenAttempt(attempt, candidateRoot, evidenceRoot);
          throw new Error("lease_lost_during_warden");
        }
        if (Date.parse(candidateExpiresAt) <= Date.now()) {
          discardWardenAttempt(attempt, candidateRoot, evidenceRoot);
          throw new Error("warden_snapshot_expired_during_attempt");
        }
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
        severity?: "required" | "recommended" | "optional";
        notificationsOnly?: boolean;
        contractCases?: ContractCase[];
        securityScanOk?: boolean;
        repairVerifyCommands?: string[];
      };
      console.log(`Job ${job.id} pipeline.fanout ${payload.providerSlug}`);
      const report = await runChangePipeline({
        tenantId: job.tenant_id,
        providerSlug: payload.providerSlug,
        db,
        severity: payload.severity,
        notificationsOnly: payload.notificationsOnly,
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
      if (
        !completeJob(
          db,
          job.id,
          { changeId: report.changeId, consumers: report.consumers },
          nowIso(),
          fence,
        )
      ) {
        throw new Error("lease_lost_before_pipeline_completion");
      }
      result.succeeded++;
      console.log(`  done change=${report.changeId}`);
    } catch (error) {
      const classified = classifyJobFailure(error);
      const failure = pendingAgentRun
        ? persistFailedAgentJob(
            db,
            job.id,
            fence,
            classified,
            {
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
            },
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

async function runJobWorker(intervalMs: number) {
  const db = createDb();
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
  const feedDb = createDb();
  const heartbeatDb = createDb();
  const transformerDb = createDb();
  const transformerStore = new TransformerPilotExecutionStore(
    transformerPilotWorkerPath(),
  );
  const jobConcurrency = parseJobConcurrency(process.env.MENDPOINT_JOB_CONCURRENCY);
  const jobDbs = Array.from({ length: jobConcurrency }, () => createDb());
  const heartbeatPath = process.env.MENDPOINT_WORKER_HEARTBEAT_PATH;
  if (!heartbeatPath) {
    throw new Error("MENDPOINT_WORKER_HEARTBEAT_PATH is required for run-service");
  }
  let feedPollingEnabled = process.env.MENDPOINT_FEED_POLLING_ENABLED !== "0";
  let feedPollOk = true;
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
  const configuredTenantId = process.env.MENDPOINT_TENANT_ID?.trim() || undefined;
  const shutdown = new AbortController();
  const requestShutdown = () => shutdown.abort();
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);
  const emitHeartbeat = () => {
    try {
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
        feedPollOk,
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
      feedPollOk = true;
      if (feedPollingEnabled) {
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
          feedPollOk = scheduled.failed === 0 && scheduled.health.ok;
          console.log(
            `Feed schedules: claimed=${scheduled.claimed} succeeded=${scheduled.succeeded} failed=${scheduled.failed} replayed=${scheduled.alreadyClaimed} health=${scheduled.health.status}`,
          );
        } catch (error) {
          feedPollOk = false;
          console.error(error);
        }
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
        });
        transformer = transformerPilotHeartbeatAfterResult(transformer, result, nowIso());
        failures = result.infrastructureError ? failures + 1 : 0;
      } catch (error) {
        failures++;
        transformer = transformerPilotHeartbeatAfterFailure(transformer, error, nowIso());
        console.error(error);
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
    const db = createDb();
    console.log(
      JSON.stringify({ catalog: listCatalogFeeds(), recent: listFeedPolls(db, 20) }, null, 2),
    );
  } else if (cmd === "jobs" || cmd === "process-jobs") {
    const result = await processJobsOnce();
    if (cmd === "jobs") {
      console.log(
        JSON.stringify(
          listJobs(createDb(), 20, process.env.MENDPOINT_TENANT_ID),
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
  } else if (cmd === "sdk-signals") {
    console.log(JSON.stringify(await probeKnownSdks({ localOnly: args.localOnly }), null, 2));
  } else {
    console.log(`Usage: worker [demo|watch|poll-once|poll|feeds|jobs|process-jobs|run-jobs|run-service|sdk-signals]
  poll-once [--local] [--no-pipeline] [--slug acme-payments]
  poll [--local] [--interval 60000]
  process-jobs
  run-jobs [--interval 5000]
  run-service [--interval 5000]
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
