import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runChangePipeline } from "@mendpoint/pipeline";
import {
  claimNextJob,
  completeJob,
  createDb,
  failJob,
  findMonorepoRoot,
  getConsumer,
  getConsumerRepo,
  insertAgentRun,
  listFeedPolls,
  listJobs,
  listProviders,
  listVersionsForProvider,
  type AppDb,
} from "@mendpoint/db";
import { listCatalogFeeds, pollAllFeeds, probeKnownSdks } from "@mendpoint/catalog";
import { nowIso } from "@mendpoint/shared";
import { runWarden } from "@mendpoint/agent";
import type { ContractCase } from "@mendpoint/contract";

const WORKER_ID =
  process.env.MENDPOINT_WORKER_ID ?? `worker:${process.pid}:${randomUUID()}`;

export type JobDrainResult = {
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
};

export type WorkerHeartbeat = {
  ok: true;
  workerId: string;
  recordedAt: string;
  jobs: JobDrainResult;
  feedPollingEnabled: boolean;
  feedPollOk: boolean;
};

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

export function validateWorkerProductionEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (env.NODE_ENV !== "production") return [];
  const errors: string[] = [];
  if (env.GITHUB_MODE !== "mock" && env.GITHUB_MODE !== "real") {
    errors.push("GITHUB_MODE must be explicitly set to mock or real");
  }
  if (env.GITHUB_MODE === "real" && !env.GITHUB_TOKEN?.trim()) {
    errors.push("GITHUB_TOKEN is required for real worker delivery");
  }
  if (!env.DATABASE_URL && !env.MENDPOINT_DATA_DIR) {
    errors.push("DATABASE_URL or MENDPOINT_DATA_DIR is required");
  }
  const reposDir = env.MENDPOINT_REPOS_DIR;
  if (!reposDir || !isAbsolute(reposDir) || !existsSync(reposDir)) {
    errors.push("MENDPOINT_REPOS_DIR must be an existing absolute directory");
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
  slugs?: string[];
}) {
  const root = findMonorepoRoot();
  const results = await pollAllFeeds({
    db: opts.db,
    tenantId: process.env.MENDPOINT_TENANT_ID ?? "tenant_default",
    monorepoRoot: root,
    localOnly: opts.localOnly,
    runPipeline: opts.runPipeline,
    slugs: opts.slugs,
    pipeline: async (slug, database) => {
      const report = await runChangePipeline({
        tenantId: process.env.MENDPOINT_TENANT_ID ?? "tenant_default",
        providerSlug: slug,
        db: database,
      });
      return { changeId: report.changeId };
    },
  });
  for (const result of results) {
    const extra = result.error ? ` err=${result.error}` : "";
    console.log(
      `  ${result.slug}: ${result.status}${result.versionLabel ? ` v=${result.versionLabel}` : ""}${result.changeId ? ` change=${result.changeId}` : ""}${extra}`,
    );
  }
  const signals = await probeKnownSdks({ localOnly: opts.localOnly });
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
  } = {},
): Promise<JobDrainResult> {
  const result: JobDrainResult = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
  };
  for (;;) {
    const job = claimNextJob(db, ["pipeline.fanout", "agent.run"], {
      tenantId: opts.tenantId ?? process.env.MENDPOINT_TENANT_ID,
      workerId: opts.workerId ?? WORKER_ID,
      leaseMs: parseLeaseMs(opts.leaseMs ?? process.env.JOB_LEASE_MS),
    });
    if (!job) break;
    result.claimed++;
    try {
      if (job.type === "agent.run") {
        const payload = JSON.parse(job.payload_json) as {
          goal: string;
          consumerId: string;
          errorLog?: string;
          maxSteps?: number;
          dryRun?: boolean;
          useLlm?: boolean;
          sessionId?: string;
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
        const repoPath = resolveWorkerRepoPath(
          consumerRepo.local_path,
          job.tenant_id,
        );
        console.log(`Job ${job.id} agent.run ${repoPath}`);
        const started = nowIso();
        const warden = await runWarden({
          goal: payload.goal,
          repoRoot: repoPath,
          errorLog: payload.errorLog,
          maxSteps: payload.maxSteps ?? 20,
          dryRun: payload.dryRun,
          useLlm: payload.useLlm ?? process.env.LLM_AGENT === "1",
          allowNetwork: false,
          sessionId: payload.sessionId,
        });
        insertAgentRun(db, {
          id: warden.sessionId,
          tenantId: job.tenant_id,
          goal: payload.goal,
          repoPath,
          status: warden.ok ? "ok" : "failed",
          ok: warden.ok,
          steps: warden.steps.length,
          filesChanged: warden.filesChanged,
          reportMd: warden.reportMarkdown,
          resultJson: JSON.stringify({
            stoppedReason: warden.stoppedReason,
            jobId: job.id,
            product: "warden",
          }),
          createdAt: started,
          finishedAt: nowIso(),
        });
        if (!warden.ok) {
          failJob(
            db,
            job.id,
            `Warden failed: ${warden.stoppedReason}`,
            nowIso(),
          );
          result.failed++;
          if (job.attempts < job.max_attempts) result.retried++;
          console.error(
            `  Warden failed session=${warden.sessionId} steps=${warden.steps.length}`,
          );
          break;
        }
        completeJob(
          db,
          job.id,
          {
            sessionId: warden.sessionId,
            ok: true,
            steps: warden.steps.length,
            filesChanged: warden.filesChanged,
            stoppedReason: warden.stoppedReason,
            product: "warden",
          },
          nowIso(),
        );
        result.succeeded++;
        console.log(
          `  Warden ok session=${warden.sessionId} steps=${warden.steps.length}`,
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
      });
      completeJob(db, job.id, { changeId: report.changeId }, nowIso());
      result.succeeded++;
      console.log(`  done change=${report.changeId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failJob(db, job.id, message, nowIso());
      result.failed++;
      if (job.attempts < job.max_attempts) result.retried++;
      console.error(`  failed: ${message}`);
      break;
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
  const db = createDb();
  const heartbeatPath = process.env.MENDPOINT_WORKER_HEARTBEAT_PATH;
  if (!heartbeatPath) {
    throw new Error("MENDPOINT_WORKER_HEARTBEAT_PATH is required for run-service");
  }
  let failures = 0;
  for (;;) {
    const feedPollingEnabled =
      process.env.MENDPOINT_FEED_POLLING_ENABLED !== "0";
    let feedPollOk = true;
    if (feedPollingEnabled) {
      try {
        const feedResults = await runFeedPoll({
          db,
          localOnly: process.env.POLL_LOCAL_ONLY === "1",
          runPipeline: true,
        });
        feedPollOk = feedResults.every((result) => result.status !== "error");
      } catch (error) {
        feedPollOk = false;
        console.error(error);
      }
    }

    let jobs: JobDrainResult = {
      claimed: 0,
      succeeded: 0,
      failed: 0,
      retried: 0,
    };
    try {
      jobs = await processJobsOnce(db);
    } catch (error) {
      jobs.failed++;
      console.error(error);
    }
    const healthy = feedPollOk && jobs.failed === 0;
    failures = healthy ? 0 : failures + 1;
    writeWorkerHeartbeat(heartbeatPath, {
      ok: true,
      workerId: WORKER_ID,
      recordedAt: nowIso(),
      jobs,
      feedPollingEnabled,
      feedPollOk,
    });
    const delay = failures ? retryDelayMs(failures, intervalMs) : intervalMs;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, delay));
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
