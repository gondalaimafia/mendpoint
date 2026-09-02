/**
 * Child-process supervision policy for the single-machine customer runtime.
 *
 * Extracted from scripts/start-fly.mjs so the policy can be EXECUTED by tests
 * rather than asserted by scanning the launcher's source. A source-text scan
 * cannot tell `critical` from `if (true)`, and cannot tell a live call from one
 * a comment happens to mention; both of those defects survived such scans.
 *
 * Two classes of child:
 *
 *   critical (api, worker, web)
 *     Load-bearing. If one dies the machine is not serving, so bringing the
 *     machine down is the correct, honest outcome.
 *
 *   non-critical (the backup scheduler)
 *     A helper whose death must never stop the product. Logged and restarted
 *     with backoff, never escalated to a shutdown. This is supervision policy
 *     rather than an attempt to make the child unable to exit, because an OOM
 *     kill or a module-load failure has to have the same non-fatal outcome as a
 *     clean exit -- and neither of those is something the child can prevent.
 *
 * Both `exit` and `error` are handled. A spawn that fails to launch at all (a
 * bad interpreter path, a missing script) emits `error` and never emits `exit`,
 * so handling only `exit` would let a non-critical child fail permanently in
 * silence while an unhandled `error` took the supervisor down -- the opposite of
 * the policy on both counts.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

/** Backoff for a non-critical child, doubling to a ceiling. */
export const NONCRITICAL_RESTART_BASE_MS = 30_000;
export const NONCRITICAL_RESTART_MAX_MS = 600_000;
/**
 * Uptime after which a child counts as healthy again and its backoff resets, so
 * an outage days later does not inherit an old streak.
 */
export const NONCRITICAL_STABLE_MS = 600_000;

export function nonCriticalRestartDelayMs(attempt: number): number {
  return Math.min(NONCRITICAL_RESTART_BASE_MS * 2 ** attempt, NONCRITICAL_RESTART_MAX_MS);
}

export interface SupervisorOptions {
  readonly spawn?: typeof nodeSpawn;
  readonly log?: (message: string) => void;
  /** Injected so tests observe the decision instead of dying with the runner. */
  readonly exit?: (code: number) => void;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer?: (timer: NodeJS.Timeout) => void;
  /** Grace period before surviving children are SIGKILLed during shutdown. */
  readonly shutdownGraceMs?: number;
}

export interface StartChildOptions {
  readonly cwd?: string;
  readonly identity?: Record<string, unknown>;
  readonly env?: NodeJS.ProcessEnv;
  /** False only for helpers whose death must not stop the product. */
  readonly critical?: boolean;
  readonly restartAttempt?: number;
}

export interface ChildSupervisor {
  startProcess(
    name: string,
    command: string,
    args: readonly string[],
    options?: StartChildOptions,
  ): ChildProcess;
  shutdown(exitCode?: number): void;
  readonly children: Map<string, ChildProcess>;
  isStopping(): boolean;
  /** Test seam: pending non-critical restarts, by child name. */
  pendingRestarts(): string[];
}

export function createChildSupervisor(options: SupervisorOptions = {}): ChildSupervisor {
  const spawn = options.spawn ?? nodeSpawn;
  const log = options.log ?? ((message: string) => console.error(message));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  const shutdownGraceMs = options.shutdownGraceMs ?? 25_000;

  const children = new Map<string, ChildProcess>();
  const restartTimers = new Map<string, NodeJS.Timeout>();
  let stopping = false;

  const shutdown = (exitCode = 0): void => {
    if (stopping) return;
    stopping = true;
    // A pending non-critical restart must not resurrect a child mid-shutdown.
    for (const timer of restartTimers.values()) clearTimer(timer);
    restartTimers.clear();
    const active = [...children.values()].filter((child) => child.exitCode === null);
    for (const child of active) child.kill("SIGTERM");
    if (active.length === 0) {
      exit(exitCode);
      return;
    }
    const timer = setTimer(() => {
      for (const child of active) {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      exit(exitCode);
    }, shutdownGraceMs);
    timer.unref?.();
    void Promise.all(
      active.map((child) => new Promise((resolveChild) => child.once("exit", resolveChild))),
    ).finally(() => exit(exitCode));
  };

  const startProcess = (
    name: string,
    command: string,
    args: readonly string[],
    startOptions: StartChildOptions = {},
  ): ChildProcess => {
    const { critical = true, restartAttempt = 0 } = startOptions;
    const startedAt = now();
    const child = spawn(command, [...args], {
      cwd: startOptions.cwd,
      env: startOptions.env,
      stdio: "inherit",
      ...(startOptions.identity ?? {}),
    });
    // Kept in `children` either way, so shutdown() still SIGTERMs it.
    children.set(name, child);

    // ENOENT-style failures can emit BOTH `error` and `exit`; the policy must be
    // applied once, or a single failure would schedule two restarts.
    let settled = false;
    const handleDeath = (reason: string, code: number | null) => {
      if (settled) return;
      settled = true;
      if (stopping) return;
      log(`${name} ${reason}`);
      if (critical) {
        shutdown(code ?? 1);
        return;
      }
      const attempt = now() - startedAt >= NONCRITICAL_STABLE_MS ? 0 : restartAttempt;
      const delay = nonCriticalRestartDelayMs(attempt);
      log(`${name} is non-critical; restarting in ${delay}ms (attempt ${attempt + 1})`);
      const timer = setTimer(() => {
        restartTimers.delete(name);
        if (stopping) return;
        startProcess(name, command, args, { ...startOptions, critical, restartAttempt: attempt + 1 });
      }, delay);
      timer.unref?.();
      restartTimers.set(name, timer);
    };

    child.on("exit", (code, signal) => {
      handleDeath(`exited code=${code ?? "none"} signal=${signal ?? "none"}`, code);
    });
    // A launch failure emits `error` and never `exit`. Unhandled, it would throw
    // out of the supervisor; handled here it follows the same policy as any
    // other death, which is what "or fails to load" above has to mean.
    child.on("error", (error: Error) => {
      handleDeath(`failed to start: ${error.message}`, 1);
    });
    return child;
  };

  return {
    startProcess,
    shutdown,
    children,
    isStopping: () => stopping,
    pendingRestarts: () => [...restartTimers.keys()],
  };
}
