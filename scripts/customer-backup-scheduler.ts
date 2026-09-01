/**
 * On-machine trigger for the customer production backup.
 *
 * Why this exists
 * ---------------
 * The backup already runs ON the customer machine. `customer-backup.yml` did
 * nothing but reach in over SSH and run `scripts/customer-backup.ts`. GitHub
 * Actions was only the TRIGGER, and it is an unreliable one: the workflow asked
 * for a once-per-30-minutes cron, and the scheduled deliveries this repo
 * actually received landed 2h13m to 8h23m apart, every gap wider than the 3600s
 * RPO. Every run that fired succeeded. So a one-hour recovery commitment was fed
 * by a trigger firing every several hours, `last_verified_backup` went `overdue`
 * between runs, and Fly's own /ready poll sat red for reasons unrelated to the
 * backup. This moves the trigger onto the machine. It does not port the backup.
 *
 * Why this is its own process, and not the worker
 * ----------------------------------------------
 * Least privilege decides the host. `customerWardenChildEnvironment`
 * (scripts/customer-warden-profile.ts) strips every sensitive value from each
 * child and restores only that role's list. The `worker` role deliberately gets
 * neither `MENDPOINT_BACKUP_KEY` nor the object-store credentials, and main's own
 * test pins that. A scheduler hosted in the worker would spawn a child that
 * throws `customer_backup_key_required` on every tick: loud, but never once
 * taking a backup. The `api` role keeps the backup key but not the AWS
 * credentials, so it cannot publish either. The `backup` role already existed for
 * exactly this credential set, so the scheduler runs as that role and the child
 * inherits that same scoped environment.
 *
 * This process must never take the machine down
 * ---------------------------------------------
 * `start-fly.mjs` supervises it as a NON-CRITICAL child: its exit is logged and
 * it is restarted with backoff, never escalated to a machine shutdown. That is
 * supervision policy rather than an attempt to make this process unable to exit,
 * because an OOM kill or a loader failure must have the same non-fatal outcome.
 * Belt and braces on this side: every idle path parks on a REF'D timer, because
 * `await new Promise(() => {})` does not keep Node alive -- with no ref'd handle
 * the event loop is empty and the process exits 0 immediately.
 *
 * The interval is DERIVED from the RPO, never hardcoded
 * ----------------------------------------------------
 * `assessCustomerBackupReadiness` goes red when the newest backup is older than
 * `policy.rpoSeconds`. A hardcoded cadence beside a separately declared RPO is
 * exactly how the original defect was born. The cadence, the per-run object-store
 * budget and the hard kill are all computed from the same
 * `CORE_DISASTER_RECOVERY_POLICY` object that `customerBackupInputFromEnv`
 * attaches to the input `assessCustomerBackupReadiness` reads.
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assessCustomerBackupReadiness,
  CORE_DISASTER_RECOVERY_POLICY,
  customerBackupInputFromEnv,
  deploymentProfile,
  fenceMarkerOwnerIsAlive,
  fenceMarkerOwnerLiveness,
  inspectMutationFence,
  prepareMutationFenceDirectories,
  recoverStaleMutationMarker,
  resolveMutationFenceRoot,
} from "@mendpoint/ops";

import { loadCustomerObjectStoreConfig } from "./customer-object-store.js";

/**
 * Fraction of the RPO at which a backup is triggered. One half means a whole run
 * can be dropped and the next still lands inside the RPO window.
 */
export const CUSTOMER_BACKUP_RPO_SAFETY_FACTOR = 0.5;

/**
 * Fractions of the INTERVAL for the two nested bounds on a single run. The
 * object-store budget fires first and unwinds cleanly through
 * `customer-backup.ts`'s own `finally`; the hard kill is the last resort for a
 * process that ignored it. Both are strictly below 1 so a wedged run can never
 * still hold the fence when the next tick is due.
 */
export const CUSTOMER_BACKUP_OPERATION_FACTOR = 0.8;
export const CUSTOMER_BACKUP_KILL_FACTOR = 0.9;

/** Never hammer the machine, whatever a future RPO says. */
const CUSTOMER_BACKUP_MIN_INTERVAL_MS = 60_000;

/** `loadCustomerObjectStoreConfig` rejects anything outside these. */
const OPERATION_TIMEOUT_FLOOR_MS = 60_000;
const OPERATION_TIMEOUT_CEILING_MS = 24 * 60 * 60 * 1_000;

/**
 * Consecutive lost fence races after which contention stops being benign. One or
 * two mean the manual workflow or the watchdog is running. This many in a row
 * means nothing is releasing the fence: a stall wearing a benign label.
 */
export const CUSTOMER_BACKUP_CONTENTION_ESCALATION = 3;

/** A timer far enough out to be inert, ref'd so it holds the event loop open. */
const IDLE_PARK_MS = 1 << 30;

export function customerBackupIntervalMs(
  policy: Readonly<{ rpoSeconds: number }> = CORE_DISASTER_RECOVERY_POLICY,
): number {
  const { rpoSeconds } = policy;
  if (!Number.isInteger(rpoSeconds) || rpoSeconds <= 0) {
    throw new Error("customer_backup_schedule_rpo_invalid");
  }
  return Math.max(
    CUSTOMER_BACKUP_MIN_INTERVAL_MS,
    Math.floor(rpoSeconds * 1_000 * CUSTOMER_BACKUP_RPO_SAFETY_FACTOR),
  );
}

/**
 * The object-store budget handed to the child, reconciling
 * `MENDPOINT_BACKUP_OPERATION_TIMEOUT_MS` with the schedule.
 *
 * fly.customer-warden.toml declares 4 hours and the retired SSH workflow budgeted
 * 270 minutes. Neither can hold against a 30-minute cadence: a run still going
 * when the next tick is due is a run whose backup can never satisfy a 1h RPO.
 * The schedule is the tighter constraint, so it wins, and the child is told so
 * explicitly rather than being left to trust a machine-level default that
 * disagrees with the trigger driving it.
 */
export function customerBackupOperationTimeoutMs(
  policy: Readonly<{ rpoSeconds: number }> = CORE_DISASTER_RECOVERY_POLICY,
): number {
  const intervalMs = customerBackupIntervalMs(policy);
  const budget = Math.floor(intervalMs * CUSTOMER_BACKUP_OPERATION_FACTOR);
  const bounded = Math.min(
    OPERATION_TIMEOUT_CEILING_MS,
    Math.max(OPERATION_TIMEOUT_FLOOR_MS, budget),
  );
  if (bounded >= customerBackupKillTimeoutMs(policy)) {
    // The floor pushed the app-level bound past the hard kill, so the graceful
    // unwind could never run. Refuse rather than ship a bound that cannot fire.
    throw new Error("customer_backup_schedule_operation_timeout_invalid");
  }
  return bounded;
}

/** The hard kill: last resort for a child that ignored its own budget. */
export function customerBackupKillTimeoutMs(
  policy: Readonly<{ rpoSeconds: number }> = CORE_DISASTER_RECOVERY_POLICY,
): number {
  const intervalMs = customerBackupIntervalMs(policy);
  const killMs = Math.floor(intervalMs * CUSTOMER_BACKUP_KILL_FACTOR);
  if (killMs >= intervalMs || killMs <= 0) {
    throw new Error("customer_backup_schedule_timeout_invalid");
  }
  return killMs;
}

/**
 * Only the customer profile takes backups, matching the gate in
 * `assessCustomerBackupReadiness` and in `customerBackupInputFromEnv` (which
 * throws `customer_backup_profile_required` otherwise).
 */
export function shouldScheduleCustomerBackup(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return deploymentProfile(env) === "customer";
}

/** Same shape as `customerBackupInputFromEnv`'s default id. */
export function nextCustomerBackupId(now: Date = new Date()): string {
  return `customer-${now.toISOString().replaceAll(/[:.]/g, "-")}`;
}

export type CustomerBackupOutcome =
  | { status: "succeeded" }
  /**
   * Another backup holds the exclusive fence. `createApplicationConsistentBackup`
   * creates that marker with `flag: "wx"`, so the loser of the race exits without
   * writing rather than corrupting anything. Benign once; see
   * CUSTOMER_BACKUP_CONTENTION_ESCALATION for when it stops being benign.
   */
  | { status: "contended" }
  | { status: "failed"; code: string; stderr: string };

export const BACKUP_FENCE_CONTENDED = "backup_fence_already_active";

export function classifyCustomerBackupOutcome(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): CustomerBackupOutcome {
  if (signal) return { status: "failed", code: `customer_backup_signalled_${signal}`, stderr };
  if (exitCode === 0) return { status: "succeeded" };
  if (stderr.includes(BACKUP_FENCE_CONTENDED)) return { status: "contended" };
  return { status: "failed", code: `customer_backup_exit_${exitCode ?? "unknown"}`, stderr };
}

export interface ReapStaleExclusiveFenceOptions {
  readonly fenceRoot: string;
  readonly host?: string;
  readonly isAlive?: (pid: number) => boolean;
  /** Injected in tests; real liveness reads /proc. */
  readonly startedAtMs?: (pid: number) => number | null;
}

/**
 * Releases an exclusive fence marker whose owning process no longer exists.
 *
 * `scripts/customer-backup.ts` installs no SIGTERM handler, so a run killed by a
 * signal never reaches the `finally { rmSync(paths.exclusive) }` in
 * `createApplicationConsistentBackup`. The marker outlives its owner, and then
 * `initializeWithMutationLease` refuses to boot the machine at all.
 *
 * `recoverStaleMutationMarker` already had a MANUAL caller,
 * `scripts/backup-fence-recover.ts` (`npm run backup:fence:recover`). What did
 * not exist was an automatic one, so recovery needed a human at exactly the
 * moment the machine would not start.
 *
 * On the strength of the guards: the LIVENESS check is the safety property here.
 * The digest passed to `recoverStaleMutationMarker` is hashed from the same file
 * this function just read, so it is not independent evidence about the owner --
 * it narrowly guards the window between inspect and recover, catching a marker
 * that changed underneath us. The claim is no broader than that.
 */
export function reapStaleExclusiveFence(
  options: ReapStaleExclusiveFenceOptions,
): { reaped: boolean; reason: string } {
  const host = options.host ?? hostname();
  const marker = inspectMutationFence(options.fenceRoot).exclusive;
  if (!marker) return { reaped: false, reason: "no_exclusive_marker" };
  // A pid on another host says nothing about liveness here. On Fly this is the
  // machine id (verified: hostname() === FLY_MACHINE_ID), and the customer
  // profile refuses to boot unless FLY_MACHINE_ID === MENDPOINT_ALLOWED_MACHINE_ID,
  // so it is stable across restarts and this branch means a genuinely foreign
  // marker rather than our own machine under a new name.
  if (marker.hostname !== host) return { reaped: false, reason: "marker_owned_by_other_host" };
  const livenessDeps = {
    ...(options.isAlive ? { isAlive: options.isAlive } : {}),
    ...(options.startedAtMs ? { startedAtMs: options.startedAtMs } : {}),
  };
  const liveness = fenceMarkerOwnerLiveness(marker, livenessDeps);
  if (liveness.alive) {
    // The third state, kept distinct. "Still running" and "cannot tell whether
    // this pid is still the owner" both fail closed, but only one of them is a
    // healthy steady state; collapsing them hides a fence that will never be
    // reaped behind a reason that reads like everything is fine.
    return liveness.determinable
      ? { reaped: false, reason: "marker_owner_alive" }
      : { reaped: false, reason: `liveness_undeterminable:${liveness.reason}` };
  }
  recoverStaleMutationMarker({
    fenceRoot: options.fenceRoot,
    kind: "exclusive",
    // The SAME liveness authority, with the same injected dependencies, so the
    // decision made above is the decision ops re-checks. Without this the reap
    // was inert: ops re-tested with a plain pid check, a recycled pid read as
    // alive, the recover threw, and the machine stayed unbootable.
    ownerIsAlive: (candidate) => fenceMarkerOwnerIsAlive(candidate, livenessDeps),
    markerId: marker.id,
    expectedMarkerSha256: marker.markerSha256,
    ownerTerminationEvidence:
      `customer_backup_scheduler_reaped_dead_owner pid=${marker.pid} host=${marker.hostname}`,
  });
  return { reaped: true, reason: "reaped_dead_owner" };
}

/**
 * Removes the staging directories a hard-killed run left behind.
 *
 * SIGKILL skips `customer-backup.ts`'s `finally { rmSync(input.backupRoot) }`, so
 * without this the staging volume accumulates one abandoned tree per timeout.
 * Scoped to the exact backup id this scheduler generated -- never a blanket sweep
 * of the output root, which could delete a concurrent run's working tree.
 */
export function cleanAbandonedBackupStaging(
  outputRoot: string,
  backupId: string,
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(outputRoot);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    // `createBackupBundle` stages at `${backupRoot}.staging-${uuid}`.
    if (entry !== backupId && !entry.startsWith(`${backupId}.staging-`)) continue;
    try {
      rmSync(resolve(outputRoot, entry), { recursive: true, force: true });
      removed.push(entry);
    } catch {
      // Reported by absence from the returned list; never fatal.
    }
  }
  return removed;
}

/**
 * Windows has no POSIX process groups, so the negative-pid kill is unavailable
 * there. Everywhere else the child gets its own group so a timeout kill reaches
 * the rclone grandchild rather than orphaning a live object-store transfer.
 */
export function backupChildUsesProcessGroup(platform: NodeJS.Platform | string): boolean {
  return platform !== "win32";
}

export interface ReapAtBootOptions {
  readonly fenceRoot: string;
  /** Defaults to the real fence-directory preparer; injected in tests. */
  readonly prepare?: (fenceRoot: string) => void;
  readonly reap?: (options: ReapStaleExclusiveFenceOptions) => { reaped: boolean; reason: string };
  readonly host?: string;
  readonly isAlive?: (pid: number) => boolean;
  readonly startedAtMs?: (pid: number) => number | null;
}

/**
 * The boot-time reap, with the ownership prologue it must not run without.
 *
 * start-fly.mjs runs as ROOT (Dockerfile `USER root` precedes its CMD), while
 * every backup runs as uid 1000. `recoverStaleMutationMarker` appends to
 * recovery-audit.jsonl with `appendFileSync(..., { mode: 0o600 })`, so a reap
 * performed as root CREATES THAT FILE OWNED BY ROOT. Every later backup then
 * dies in `prepareCustomerBackupDirectories` -> `prepareMutationFenceDirectories`
 * at its `accessSync(paths.audit, R_OK | W_OK)`, and so does the in-process reap.
 * The machine keeps booting and never takes another backup.
 *
 * scripts/backup-fence-recover.ts established the prologue for this same call:
 * prepare the fence directories, then run as the customer identity.
 * start-fly.mjs cannot drop root -- it still has to chown paths and spawn
 * children under an identity -- so the equivalent here is to bracket the reap
 * with `prepareMutationFenceDirectories`, which chowns the audit file to uid 1000
 * whenever it is called as root. The trailing call is the load-bearing one: it
 * hands back ownership of a file the reap just created. It also repairs a file
 * left root-owned by an earlier boot.
 *
 * This is invisible on a fresh volume, because with no marker there is no reap
 * and no audit file. It appears only on a machine that has had one hard-killed
 * backup -- the routine case this scheduler exists to handle.
 */
export function reapStaleExclusiveFenceAtBoot(
  options: ReapAtBootOptions,
): { reaped: boolean; reason: string } {
  const prepare = options.prepare ?? ((fenceRoot: string) => prepareMutationFenceDirectories(fenceRoot));
  const reap = options.reap ?? reapStaleExclusiveFence;
  prepare(options.fenceRoot);
  try {
    return reap({
      fenceRoot: options.fenceRoot,
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
      ...(options.startedAtMs === undefined ? {} : { startedAtMs: options.startedAtMs }),
    });
  } finally {
    // Runs even when the reap threw: recoverStaleMutationMarker can fail AFTER
    // creating the audit file, and a root-owned file left behind by a failed
    // reap breaks backups exactly as one left by a successful reap would.
    prepare(options.fenceRoot);
  }
}

export interface RunCustomerBackupProcessOptions {
  readonly cwd: string;
  /** Hard kill, last resort. The child's own budget should fire before this. */
  readonly killTimeoutMs: number;
  /** The scoped `backup` role environment this process itself runs under. */
  readonly env: NodeJS.ProcessEnv;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly spawnBackup?: typeof spawn;
  readonly onStdout?: (chunk: string) => void;
  /** Called after a hard kill so the caller can clear staging. */
  readonly onKilled?: () => void;
  /** Injected in tests so the process-group decision is checkable off-Linux. */
  readonly platform?: NodeJS.Platform | string;
}

/**
 * Runs one backup as a child process.
 *
 * `scripts/customer-backup.ts` calls `dropRootIdentity()`, which irreversibly
 * setuids the calling process, and a hung run needs to be killable. A child gives
 * both: the same command the SSH path already proved in production, with its own
 * process boundary and a hard timeout.
 *
 * Started in its own process GROUP where the platform supports it, so the kill
 * reaches the `rclone` grandchild too. Killing only the direct child would leave
 * an rclone transfer running against the object store with nothing supervising it.
 */
export function runCustomerBackupProcess(
  options: RunCustomerBackupProcessOptions,
): Promise<CustomerBackupOutcome> {
  const spawnBackup = options.spawnBackup ?? spawn;
  const ownProcessGroup = backupChildUsesProcessGroup(options.platform ?? process.platform);
  return new Promise<CustomerBackupOutcome>((resolveOutcome) => {
    const child = spawnBackup(
      options.command ?? process.execPath,
      [...(options.args ?? ["--import", "tsx", "scripts/customer-backup.ts"])],
      {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: ownProcessGroup,
      },
    );
    let stderr = "";
    let settled = false;
    const finish = (outcome: CustomerBackupOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOutcome(outcome);
    };
    const killTree = () => {
      try {
        // Negative pid targets the whole process group.
        if (ownProcessGroup && typeof child.pid === "number") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    };
    const timer = setTimeout(() => {
      killTree();
      options.onKilled?.();
      finish({ status: "failed", code: "customer_backup_timed_out", stderr });
    }, options.killTimeoutMs);
    timer.unref();
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 8_192) stderr += String(chunk);
    });
    // Drained so the pipe cannot fill and block the child.
    child.stdout?.on("data", (chunk: Buffer | string) => {
      options.onStdout?.(String(chunk));
    });
    child.once("error", (error: Error) => {
      finish({
        status: "failed",
        code: `customer_backup_spawn_failed:${error.message}`,
        stderr,
      });
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      finish(classifyCustomerBackupOutcome(code, signal, stderr));
    });
  });
}

/**
 * The backup receipt carries the bucket, prefix, endpoint, key id and digests. At
 * 48 runs a day that is a lot of storage identity in the Fly log stream, so only
 * the backup id is echoed.
 */
export function summarizeBackupReceipt(stdout: string): string {
  const match = /"backupId"\s*:\s*"([A-Za-z0-9._-]{1,128})"/.exec(stdout);
  return match ? `backupId=${match[1]}` : "backupId=unreported";
}

interface ContentionState {
  consecutiveContended: number;
}

export function nextContentionState(
  state: ContentionState,
  outcome: CustomerBackupOutcome,
): { state: ContentionState; escalate: boolean } {
  if (outcome.status !== "contended") return { state: { consecutiveContended: 0 }, escalate: false };
  const consecutiveContended = state.consecutiveContended + 1;
  return {
    state: { consecutiveContended },
    escalate: consecutiveContended >= CUSTOMER_BACKUP_CONTENTION_ESCALATION,
  };
}

export type SchedulerMode = "idle_not_applicable" | "idle_misconfigured" | "running";

export interface SchedulerHandle {
  /**
   * `idle_*` modes take no backup. They exist so a non-customer deployment or a
   * misconfigured one stays UP and says why, rather than exiting and letting the
   * supervisor tear the machine down.
   */
  readonly mode: SchedulerMode;
  readonly intervalMs: number | null;
  /** False would mean the process can fall out of its event loop and exit. */
  keepsProcessAlive(): boolean;
  /** Resolves once any in-flight backup has finished. */
  stop(): Promise<void>;
}

export interface StartSchedulerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly spawnBackup?: typeof spawn;
  readonly log?: (message: string, detail?: string) => void;
  readonly logError?: (message: string, detail?: string) => void;
  readonly now?: () => Date;
  /** Injected in tests; the real readiness authority otherwise. */
  readonly assessReadiness?: typeof assessCustomerBackupReadiness;
  /**
   * Liveness dependencies for the fence reap. Injected so a test can choose the
   * branch it means -- recycled pid, live owner, or undeterminable -- instead of
   * inheriting whichever one the host's /proc happens to produce.
   */
  readonly startedAtMs?: (pid: number) => number | null;
  readonly isAlive?: (pid: number) => boolean;
}

/**
 * Installs the schedule and returns a handle. Never throws for configuration
 * reasons: a misconfigured deployment parks in `idle_misconfigured` and says so
 * every tick, because throwing here would exit the process.
 */
export function startScheduler(options: StartSchedulerOptions = {}): SchedulerHandle {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((message, detail) => console.log(message, detail ?? ""));
  const logError = options.logError ?? ((message, detail) => console.error(message, detail ?? ""));
  const now = options.now ?? (() => new Date());
  const assessReadiness = options.assessReadiness ?? assessCustomerBackupReadiness;

  const park = (
    mode: "idle_not_applicable" | "idle_misconfigured",
    repeat?: { everyMs: number; say: () => void },
  ): SchedulerHandle => {
    // A REF'D timer. `await new Promise(() => {})` would leave the event loop
    // empty and Node would exit 0 a moment after boot.
    //
    // When there is something to keep saying, the park timer IS the cadence:
    // an idle_misconfigured child looks perfectly healthy to the supervisor
    // while taking no backup at all, so a single line at startup would scroll
    // away and leave nothing but a silent, green-looking process.
    const parked = repeat
      ? setInterval(repeat.say, repeat.everyMs)
      : setInterval(() => {}, IDLE_PARK_MS);
    return {
      mode,
      intervalMs: null,
      keepsProcessAlive: () => parked.hasRef(),
      stop: async () => {
        clearInterval(parked);
      },
    };
  };

  if (!shouldScheduleCustomerBackup(env)) {
    log("customer_backup_scheduler_not_applicable", "deployment profile is not customer");
    return park("idle_not_applicable");
  }

  // Prove the configuration BEFORE relying on assessCustomerBackupReadiness.
  // That function's outer catch turns "cannot evaluate" into
  // {ok:false, detail:"missing_or_invalid"}, indistinguishable from "no backup
  // yet". Reading it without this check is how a misconfigured process would
  // spawn a doomed backup every tick and call the result freshness.
  // Derived before the configuration proof, so a throw inside it cannot leave the
  // misconfigured park without a cadence.
  let parkCadenceMs: number;
  try {
    parkCadenceMs = customerBackupIntervalMs();
  } catch {
    parkCadenceMs = 1_800_000;
  }
  let outputRoot: string;
  let fenceRoot: string;
  let intervalMs: number;
  let killTimeoutMs: number;
  let operationTimeoutMs: number;
  try {
    const input = customerBackupInputFromEnv(env);
    // BOTH layers, because they fail in different roles. The first needs
    // MENDPOINT_BACKUP_KEY; the second needs the object-store credentials, which
    // the api role does NOT have even though it does hold the key. Proving only
    // the first would let a role that can never publish report itself healthy and
    // spawn a doomed child every tick.
    loadCustomerObjectStoreConfig(env);
    outputRoot = input.outputRoot!;
    fenceRoot = resolveMutationFenceRoot(env);
    intervalMs = customerBackupIntervalMs();
    killTimeoutMs = customerBackupKillTimeoutMs();
    operationTimeoutMs = customerBackupOperationTimeoutMs();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    logError("customer_backup_scheduler_misconfigured", reason);
    return park("idle_misconfigured", {
      // Same cadence a backup would have run on, so the silence is as loud as
      // the backups would have been. Computed BEFORE the try, because
      // customerBackupIntervalMs is one of the things that can throw into this
      // catch -- re-calling it here would turn a park into a crash loop.
      everyMs: parkCadenceMs,
      say: () => logError(
        "customer_backup_scheduler_misconfigured",
        `${reason}; no backup has been taken`,
      ),
    });
  }

  let contention: ContentionState = { consecutiveContended: 0 };
  let stopping = false;
  let inFlight: Promise<void> = Promise.resolve();

  const runOnce = async (): Promise<void> => {
    if (stopping) return;
    try {
      const reaped = reapStaleExclusiveFence({
        fenceRoot,
        ...(options.startedAtMs ? { startedAtMs: options.startedAtMs } : {}),
        ...(options.isAlive ? { isAlive: options.isAlive } : {}),
      });
      if (reaped.reaped) logError("customer_backup_fence_reaped", reaped.reason);
      else if (reaped.reason.startsWith("liveness_undeterminable")) {
        logError("customer_backup_fence_liveness_undeterminable", reaped.reason);
      }
    } catch (error) {
      logError(
        "customer_backup_fence_reap_failed",
        error instanceof Error ? error.message : "unknown",
      );
    }
    // Naming the id makes the staging tree deterministic, so a hard kill can be
    // cleaned up precisely instead of by sweeping the output root.
    const backupId = nextCustomerBackupId(now());
    let receipt = "";
    const outcome = await runCustomerBackupProcess({
      cwd,
      killTimeoutMs,
      env: {
        ...env,
        MENDPOINT_BACKUP_ID: backupId,
        MENDPOINT_BACKUP_OPERATION_TIMEOUT_MS: String(operationTimeoutMs),
      },
      spawnBackup: options.spawnBackup,
      onStdout: (chunk) => {
        if (receipt.length < 8_192) receipt += chunk;
      },
      onKilled: () => {
        const removed = cleanAbandonedBackupStaging(outputRoot, backupId);
        logError("customer_backup_staging_cleaned", `${backupId} removed=${removed.length}`);
      },
    });
    const next = nextContentionState(contention, outcome);
    contention = next.state;
    if (outcome.status === "succeeded") {
      log("customer_backup_succeeded", summarizeBackupReceipt(receipt));
      return;
    }
    if (outcome.status === "contended") {
      if (next.escalate) {
        logError(
          "customer_backup_contended_persistently",
          `consecutive=${contention.consecutiveContended}; the fence is not being released`,
        );
      } else {
        log("customer_backup_contended", "another backup holds the fence");
      }
      return;
    }
    // The captured stderr is the only place the child's reason survives: stdio is
    // piped, so nothing of it reaches the Fly log stream on its own.
    logError("customer_backup_schedule_failed", `${outcome.code}; stderr=${outcome.stderr.trim()}`);
  };

  const schedule = () => {
    inFlight = runOnce().catch((error: unknown) => {
      logError(
        "customer_backup_schedule_failed",
        error instanceof Error ? error.message : "unknown",
      );
    });
  };

  // A deploy restarts this process and /ready matters most right after one, so
  // catch up when the evidence will be outside the RPO BEFORE the first tick --
  // not merely when it is already outside it.
  //
  // With rpoSeconds 3600 and intervalMs 1_800_000: evidence aged 3599s at boot is
  // still "current", so an already-overdue test skips the catch-up; by the first
  // tick it is 5399s old, and /ready reports last_verified_backup red for up to
  // 1799s after every single deploy. Asking the SAME authority about the moment
  // of the next tick removes that window without duplicating the age arithmetic.
  //
  // Only reached once the configuration proved valid, so `missing_or_invalid`
  // here really does mean missing or bad rather than unreadable.
  const firstTickAt = new Date(now().getTime() + intervalMs);
  if (!assessReadiness(env, firstTickAt).ok) schedule();

  const timer = setInterval(schedule, intervalMs);

  log(
    "customer_backup_scheduler_started",
    `intervalMs=${intervalMs} operationTimeoutMs=${operationTimeoutMs} killTimeoutMs=${killTimeoutMs}`,
  );

  return {
    mode: "running",
    intervalMs,
    keepsProcessAlive: () => timer.hasRef(),
    stop: async () => {
      stopping = true;
      clearInterval(timer);
      // Do NOT kill an in-flight backup: customer-backup.ts has no SIGTERM
      // handler, so killing it orphans the exclusive fence marker. Let it finish.
      // start-fly.mjs allows 25s before SIGKILL; a marker orphaned by that hard
      // kill is reaped at the next BOOT, before initializeWithMutationLease, by
      // the same reaper this file exports.
      await inFlight;
    },
  };
}

function main(): void {
  const handle = startScheduler();
  const stop = () => {
    void handle.stop().finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

const isMain = Boolean(process.argv[1]) &&
  resolve(process.argv[1]!) === resolve(fileURLToPath(import.meta.url));

if (isMain) main();
