import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  createChildSupervisor,
  nonCriticalRestartDelayMs,
  NONCRITICAL_RESTART_BASE_MS,
  NONCRITICAL_RESTART_MAX_MS,
  NONCRITICAL_STABLE_MS,
} from "./child-supervisor.js";

/**
 * A child stand-in that can be made to die the way a real one does: a clean
 * exit, a signal, or a launch failure that emits `error` and never `exit`.
 */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 1234,
    exitCode: null as number | null,
    killed: [] as string[],
    kill(signal: string) {
      child.killed.push(signal);
      return true;
    },
  });
  // Mirror Node: a process that exits has an exitCode; one that never launched
  // keeps null, which is what makes shutdown wait for it.
  child.on("exit", (code: number | null) => {
    child.exitCode = code ?? 0;
  });
  return child;
}

function harness(options: { now?: () => number } = {}) {
  const spawned: Array<{ name: string; command: string; args: readonly string[] }> = [];
  const children: ReturnType<typeof fakeChild>[] = [];
  const logs: string[] = [];
  const exits: number[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const spawn = ((command: string, args: readonly string[]) => {
    const child = fakeChild();
    children.push(child);
    spawned.push({ name: `${children.length}`, command, args });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  const supervisor = createChildSupervisor({
    spawn,
    log: (message) => logs.push(message),
    exit: (code) => exits.push(code),
    now: options.now,
    setTimer: ((fn: () => void, ms: number) => {
      const entry = { fn, ms, cleared: false };
      timers.push(entry);
      return { unref: () => {}, __entry: entry } as unknown as NodeJS.Timeout;
    }),
    clearTimer: ((timer: NodeJS.Timeout & { __entry?: { cleared: boolean } }) => {
      if (timer.__entry) timer.__entry.cleared = true;
    }),
  });
  return { supervisor, children, spawned, logs, exits, timers };
}

describe("critical children take the machine down; non-critical ones never do", () => {
  it("shuts down when a critical child exits", () => {
    const h = harness();
    h.supervisor.startProcess("api", "node", ["server.js"]);
    h.children[0]!.emit("exit", 1, null);
    // The control for the test below: this is the behaviour that is CORRECT for
    // api, worker and web, and wrong for a backup helper.
    expect(h.exits).toEqual([1]);
    expect(h.supervisor.isStopping()).toBe(true);
  });

  it("does not shut down when a non-critical child exits, and schedules a restart", () => {
    const h = harness();
    h.supervisor.startProcess("backup", "node", ["sched.js"], { critical: false });
    h.children[0]!.emit("exit", 0, null);
    expect(h.exits).toEqual([]);
    expect(h.supervisor.isStopping()).toBe(false);
    expect(h.supervisor.pendingRestarts()).toEqual(["backup"]);
    expect(h.logs.join(" ")).toContain("non-critical; restarting in 30000ms");
  });

  it("actually restarts the non-critical child when its timer fires", () => {
    const h = harness();
    h.supervisor.startProcess("backup", "node", ["sched.js"], { critical: false });
    expect(h.spawned).toHaveLength(1);
    h.children[0]!.emit("exit", 0, null);
    const restart = h.timers.at(-1)!;
    expect(restart.ms).toBe(NONCRITICAL_RESTART_BASE_MS);
    restart.fn();
    expect(h.spawned).toHaveLength(2);
    expect(h.spawned[1]!.args).toEqual(["sched.js"]);
  });

  it("backs off exponentially to a ceiling and resets after a stable run", () => {
    expect(nonCriticalRestartDelayMs(0)).toBe(30_000);
    expect(nonCriticalRestartDelayMs(1)).toBe(60_000);
    expect(nonCriticalRestartDelayMs(99)).toBe(NONCRITICAL_RESTART_MAX_MS);
    // A child that ran past the stable window starts its next streak at zero.
    let clock = 0;
    const h = harness({ now: () => clock });
    h.supervisor.startProcess("backup", "node", ["sched.js"], { critical: false, restartAttempt: 5 });
    clock += NONCRITICAL_STABLE_MS;
    h.children[0]!.emit("exit", 0, null);
    expect(h.timers.at(-1)!.ms).toBe(NONCRITICAL_RESTART_BASE_MS);
  });
});

describe("a launch failure is a death like any other", () => {
  // A spawn that never launches emits `error` and NEVER emits `exit`. Handling
  // only `exit` would let an unhandled error escape the supervisor entirely.
  it("restarts a non-critical child that fails to launch, without shutting down", () => {
    const h = harness();
    h.supervisor.startProcess("backup", "node", ["missing.js"], { critical: false });
    h.children[0]!.emit("error", new Error("spawn ENOENT"));
    expect(h.exits).toEqual([]);
    expect(h.supervisor.isStopping()).toBe(false);
    expect(h.supervisor.pendingRestarts()).toEqual(["backup"]);
    expect(h.logs.join(" ")).toContain("failed to start: spawn ENOENT");
  });

  it("shuts down when a critical child fails to launch", () => {
    const h = harness();
    h.supervisor.startProcess("api", "node", ["missing.js"]);
    h.children[0]!.emit("error", new Error("spawn ENOENT"));
    // A child that never launched reports exitCode null, so shutdown SIGTERMs it
    // and waits out the grace period rather than exiting synchronously. The
    // decision under test is that shutdown was entered at all.
    expect(h.supervisor.isStopping()).toBe(true);
    expect(h.supervisor.pendingRestarts()).toEqual([]);
  });

  it("applies the policy once when a failure emits both error and exit", () => {
    const h = harness();
    h.supervisor.startProcess("backup", "node", ["missing.js"], { critical: false });
    h.children[0]!.emit("error", new Error("spawn ENOENT"));
    h.children[0]!.emit("exit", null, null);
    // Two restarts for one death would double the spawn rate on every failure.
    expect(h.timers.filter((t) => t.ms === NONCRITICAL_RESTART_BASE_MS)).toHaveLength(1);
  });
});

describe("shutdown", () => {
  it("SIGTERMs every child, including the non-critical one", () => {
    const h = harness();
    h.supervisor.startProcess("api", "node", ["a.js"]);
    h.supervisor.startProcess("backup", "node", ["b.js"], { critical: false });
    h.supervisor.shutdown(0);
    expect(h.children[0]!.killed).toEqual(["SIGTERM"]);
    expect(h.children[1]!.killed).toEqual(["SIGTERM"]);
  });

  it("cancels a pending restart so shutdown cannot resurrect a child", () => {
    const h = harness();
    h.supervisor.startProcess("backup", "node", ["b.js"], { critical: false });
    h.children[0]!.emit("exit", 0, null);
    const restart = h.timers.at(-1)!;
    h.supervisor.shutdown(0);
    expect(restart.cleared).toBe(true);
    expect(h.supervisor.pendingRestarts()).toEqual([]);
    // Even if a stale timer fired, stopping must keep it from spawning.
    restart.fn();
    expect(h.spawned).toHaveLength(1);
  });

  it("ignores a child dying during shutdown rather than re-entering", () => {
    const h = harness();
    h.supervisor.startProcess("api", "node", ["a.js"]);
    h.supervisor.shutdown(3);
    h.children[0]!.emit("exit", 1, null);
    expect(h.exits.every((code) => code === 3)).toBe(true);
  });
});
