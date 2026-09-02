import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CORE_DISASTER_RECOVERY_POLICY,
  customerBackupInputFromEnv,
  fenceMarkerOwnerIsAlive,
  fenceMarkerOwnerLiveness,
  initializeWithMutationLease,
  inspectMutationFence,
  livePidStartedAtMs,
  PID_START_TIME_TOLERANCE_MS,
  prepareMutationFenceDirectories,
  recoverStaleMutationMarker,
  tryAcquireMutationLease,
} from "@mendpoint/ops";
import { afterEach, describe, expect, it, vi } from "vitest";

import { customerWardenChildEnvironment } from "./customer-warden-profile.js";
import {
  BACKUP_FENCE_CONTENDED,
  backupChildUsesProcessGroup,
  classifyCustomerBackupOutcome,
  cleanAbandonedBackupStaging,
  customerBackupIntervalMs,
  customerBackupKillTimeoutMs,
  customerBackupOperationTimeoutMs,
  CUSTOMER_BACKUP_CONTENTION_ESCALATION,
  CUSTOMER_BACKUP_RPO_SAFETY_FACTOR,
  nextContentionState,
  nextCustomerBackupId,
  reapStaleExclusiveFence,
  reapStaleExclusiveFenceAtBoot,
  runCustomerBackupProcess,
  shouldScheduleCustomerBackup,
  startScheduler,
  summarizeBackupReceipt,
  type SchedulerHandle,
} from "./customer-backup-scheduler.js";

const temporaryRoots: string[] = [];
const openHandles: SchedulerHandle[] = [];

afterEach(async () => {
  while (openHandles.length) await openHandles.pop()?.stop();
  while (temporaryRoots.length) {
    const dir = temporaryRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), "mendpoint-backup-sched-"));
  temporaryRoots.push(parent);
  return parent;
}

/**
 * A production-SHAPED customer environment: the real directory layout, the real
 * relative resource paths, and a key that actually parses. A fixture that merely
 * satisfied the type would have let the worker-role defect through, because the
 * defect only appears once `customerBackupInputFromEnv` really runs.
 */
function customerBackupEnv(): NodeJS.ProcessEnv {
  const root = temporaryRoot();
  const data = resolve(root, "db");
  const out = resolve(root, "staging");
  for (const dir of [data, out, resolve(data, ".backup-state"), resolve(data, "config")]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const file of [
    "mendpoint.sqlite",
    "graph-learn.sqlite",
    "change-sources.sqlite",
    "transformer-control-plane.sqlite",
    "transformer-pilot.sqlite",
  ]) writeFileSync(resolve(data, file), "");
  return {
    MENDPOINT_DEPLOYMENT_PROFILE: "customer",
    MENDPOINT_DATA_DIR: data,
    MENDPOINT_BACKUP_SOURCE_ROOT: data,
    MENDPOINT_BACKUP_OUTPUT_ROOT: out,
    MENDPOINT_BACKUP_FENCE_ROOT: resolve(data, ".backup-fence"),
    MENDPOINT_BACKUP_EVIDENCE_PATH: resolve(data, ".backup-state", "last-verified.json"),
    MENDPOINT_BACKUP_STORAGE_CLASS: "object_store_publish",
    MENDPOINT_BACKUP_KEY: "a".repeat(64),
    MENDPOINT_BACKUP_KEY_ID: "test-backup-key",
    MENDPOINT_BACKUP_DATABASE_PATH: "mendpoint.sqlite",
    MENDPOINT_BACKUP_GRAPH_PATH: "graph-learn.sqlite",
    MENDPOINT_BACKUP_CHANGE_SOURCES_PATH: "change-sources.sqlite",
    MENDPOINT_BACKUP_TRANSFORMER_CONTROL_PLANE_PATH: "transformer-control-plane.sqlite",
    MENDPOINT_BACKUP_TRANSFORMER_PILOT_PATH: "transformer-pilot.sqlite",
    MENDPOINT_BACKUP_ARTIFACTS_PATH: ".",
    MENDPOINT_BACKUP_CONFIGURATION_PATH: "config",
    DATABASE_URL: `file:${resolve(data, "mendpoint.sqlite")}`,
    GRAPH_LEARN_DB: resolve(data, "graph-learn.sqlite"),
    AWS_ACCESS_KEY_ID: "aws-key",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    AWS_SESSION_TOKEN: "aws-session",
    // Second layer: the object-store config the backup also needs.
    MENDPOINT_BACKUP_TRANSPORT: "rclone_s3",
    BUCKET_NAME: "mendpoint-test-bucket",
    AWS_ENDPOINT_URL_S3: "https://s3.example.com",
    AWS_REGION: "auto",
    MENDPOINT_BACKUP_STAGING_ROOT: resolve(root, "object-staging"),
    MENDPOINT_BACKUP_OBJECT_PREFIX: "customer/test",
  };
}

/** Records every spawn and lets the test decide how the child behaves. */
function recordingSpawn(behaviour: (child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }) => void) {
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const spawnBackup = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => child.emit("close", null, "SIGKILL"),
    });
    queueMicrotask(() => behaviour(child));
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawnBackup, calls };
}

describe("interval and timeouts derive from the recovery policy", () => {
  it("derives the interval from the RPO rather than hardcoding it", () => {
    expect(customerBackupIntervalMs({ rpoSeconds: 3600 })).toBe(1_800_000);
    expect(customerBackupIntervalMs({ rpoSeconds: 7200 })).toBe(3_600_000);
    expect(customerBackupIntervalMs({ rpoSeconds: 1800 })).toBe(900_000);
  });

  it("defaults to the same policy object assessCustomerBackupReadiness measures against", () => {
    expect(customerBackupIntervalMs()).toBe(customerBackupIntervalMs(CORE_DISASTER_RECOVERY_POLICY));
    expect(CORE_DISASTER_RECOVERY_POLICY.rpoSeconds).toBe(3600);
  });

  it("leaves room for a whole missed run inside the RPO", () => {
    for (const rpoSeconds of [1800, 3600, 7200, 86_400]) {
      expect(2 * customerBackupIntervalMs({ rpoSeconds })).toBeLessThanOrEqual(rpoSeconds * 1_000);
    }
    expect(CUSTOMER_BACKUP_RPO_SAFETY_FACTOR).toBeLessThanOrEqual(0.5);
  });

  it("nests the object-store budget inside the hard kill, inside one interval", () => {
    // The graceful bound must be able to fire before the kill, or customer-backup.ts
    // never gets to unwind its own staging.
    for (const rpoSeconds of [1800, 3600, 7200, 86_400]) {
      const policy = { rpoSeconds };
      const operation = customerBackupOperationTimeoutMs(policy);
      const kill = customerBackupKillTimeoutMs(policy);
      expect(operation).toBeLessThan(kill);
      expect(kill).toBeLessThan(customerBackupIntervalMs(policy));
      // loadCustomerObjectStoreConfig rejects anything outside these bounds.
      expect(operation).toBeGreaterThanOrEqual(60_000);
      expect(operation).toBeLessThanOrEqual(24 * 60 * 60 * 1_000);
    }
  });

  it("reconciles against the 4h machine default rather than inheriting it", () => {
    // fly.customer-warden.toml declares 14400000. A 4h operation budget cannot
    // hold against a 30-minute cadence, so the schedule must win.
    expect(customerBackupOperationTimeoutMs()).toBeLessThan(14_400_000);
    expect(customerBackupOperationTimeoutMs()).toBe(1_440_000);
  });

  it("rejects a policy whose RPO is not a positive integer", () => {
    for (const rpoSeconds of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => customerBackupIntervalMs({ rpoSeconds })).toThrow(
        "customer_backup_schedule_rpo_invalid",
      );
    }
  });
});

describe("profile gate", () => {
  it("schedules only under the customer profile", () => {
    expect(shouldScheduleCustomerBackup({ MENDPOINT_DEPLOYMENT_PROFILE: "customer" })).toBe(true);
    for (const profile of ["demo", "pilot", "transformer_pilot", "regauge_production", "", "Customer"]) {
      expect(shouldScheduleCustomerBackup({ MENDPOINT_DEPLOYMENT_PROFILE: profile })).toBe(false);
    }
    expect(shouldScheduleCustomerBackup({})).toBe(false);
  });

  it("matches the gate customerBackupInputFromEnv itself enforces", () => {
    expect(() => customerBackupInputFromEnv({ MENDPOINT_DEPLOYMENT_PROFILE: "demo" })).toThrow(
      "customer_backup_profile_required",
    );
  });
});

describe("outcome classification", () => {
  it("treats a clean exit as success and a lost fence race as contention", () => {
    expect(classifyCustomerBackupOutcome(0, null, "")).toEqual({ status: "succeeded" });
    expect(classifyCustomerBackupOutcome(1, null, `${BACKUP_FENCE_CONTENDED}\n`)).toEqual({
      status: "contended",
    });
  });

  it("carries the child's stderr out with every failure so it can be logged", () => {
    const failure = classifyCustomerBackupOutcome(1, null, "customer_backup_key_required");
    expect(failure).toEqual({
      status: "failed",
      code: "customer_backup_exit_1",
      stderr: "customer_backup_key_required",
    });
    expect(classifyCustomerBackupOutcome(null, "SIGKILL", "boom")).toEqual({
      status: "failed",
      code: "customer_backup_signalled_SIGKILL",
      stderr: "boom",
    });
  });
});

describe("persistent contention escalates", () => {
  it("stays quiet for isolated contention and goes loud once it repeats", () => {
    let state = { consecutiveContended: 0 };
    for (let attempt = 1; attempt < CUSTOMER_BACKUP_CONTENTION_ESCALATION; attempt += 1) {
      const next = nextContentionState(state, { status: "contended" });
      state = next.state;
      expect(next.escalate).toBe(false);
    }
    const escalated = nextContentionState(state, { status: "contended" });
    expect(escalated.escalate).toBe(true);
  });

  it("resets the streak on any non-contended outcome", () => {
    const state = { consecutiveContended: CUSTOMER_BACKUP_CONTENTION_ESCALATION };
    expect(nextContentionState(state, { status: "succeeded" }).state.consecutiveContended).toBe(0);
    expect(
      nextContentionState(state, { status: "failed", code: "x", stderr: "" }).state
        .consecutiveContended,
    ).toBe(0);
  });
});

describe("stale exclusive fence reaper", () => {
  const marker = (id: string, pid: number, host: string) => `${JSON.stringify({
    schemaVersion: 1,
    kind: "exclusive",
    id,
    pid,
    hostname: host,
    processStartedAt: "2026-08-31T22:59:00.000Z",
    acquiredAt: "2026-08-31T23:00:00.000Z",
    ownerToken: "a".repeat(32),
  })}\n`;

  const plantMarker = (root: string, pid: number, host: string, id = "customer-dead-owner") => {
    const lease = tryAcquireMutationLease(root);
    lease?.release();
    writeFileSync(resolve(root, "exclusive.json"), marker(id, pid, host), { mode: 0o600 });
  };

  const fence = () => resolve(temporaryRoot(), ".backup-fence");

  it("releases a marker whose owning process is gone", () => {
    const root = fence();
    plantMarker(root, 424_242, hostname());
    expect(inspectMutationFence(root).exclusive).not.toBeNull();
    expect(reapStaleExclusiveFence({ fenceRoot: root, isAlive: () => false })).toEqual({
      reaped: true,
      reason: "reaped_dead_owner",
    });
    // The point of the whole thing: the next boot can now take the lease.
    expect(inspectMutationFence(root).exclusive).toBeNull();
  });

  it("never reaps a marker whose owner is still running", () => {
    const root = fence();
    plantMarker(root, process.pid, hostname());
    // startedAtMs injected so liveness is DETERMINABLE: without it this host has
    // no /proc and the result is the third state, not "owner alive".
    expect(reapStaleExclusiveFence({
      fenceRoot: root,
      isAlive: () => true,
      startedAtMs: () => Date.parse("2026-08-31T22:59:00.000Z"),
    })).toEqual({ reaped: false, reason: "marker_owner_alive" });
    expect(inspectMutationFence(root).exclusive).not.toBeNull();
  });

  it("never reaps a marker written by a different host", () => {
    const root = fence();
    plantMarker(root, 424_242, "some-other-host");
    expect(reapStaleExclusiveFence({ fenceRoot: root, isAlive: () => false })).toEqual({
      reaped: false,
      reason: "marker_owned_by_other_host",
    });
    expect(inspectMutationFence(root).exclusive).not.toBeNull();
  });

  it("refuses when the marker changed between inspection and recovery", () => {
    // This is the ONLY property the digest argument buys in the automatic path:
    // it is hashed from the file the reaper just read, so it is not independent
    // evidence about the owner. It does close the inspect/recover window, and
    // that narrow claim is what this pins.
    const root = fence();
    plantMarker(root, 424_242, hostname());
    expect(() => reapStaleExclusiveFence({
      fenceRoot: root,
      isAlive: (pid) => {
        // Rewrite the marker after inspection, before recovery.
        writeFileSync(
          resolve(root, "exclusive.json"),
          marker("customer-dead-owner", pid, hostname()).replace("22:59", "22:58"),
          { mode: 0o600 },
        );
        return false;
      },
    })).toThrow("backup_fence_recovery_marker_evidence_mismatch");
    // Fails closed: the marker it could not vouch for is still there.
    expect(inspectMutationFence(root).exclusive).not.toBeNull();
  });

  it("is a no-op when no backup holds the fence", () => {
    const root = fence();
    const lease = tryAcquireMutationLease(root);
    lease?.release();
    expect(reapStaleExclusiveFence({ fenceRoot: root, isAlive: () => false })).toEqual({
      reaped: false,
      reason: "no_exclusive_marker",
    });
  });
});

describe("abandoned staging cleanup", () => {
  it("removes only the trees belonging to the killed run", () => {
    const out = temporaryRoot();
    const backupId = "customer-2026-08-31T23-00-00-000Z";
    for (const dir of [backupId, `${backupId}.staging-abc`, "customer-someone-else"]) {
      mkdirSync(resolve(out, dir), { recursive: true });
    }
    const removed = cleanAbandonedBackupStaging(out, backupId).sort();
    expect(removed).toEqual([backupId, `${backupId}.staging-abc`]);
    // A concurrent run's working tree must survive.
    expect(cleanAbandonedBackupStaging(out, "customer-someone-else")).toEqual([
      "customer-someone-else",
    ]);
  });

  it("is silent when the output root does not exist", () => {
    expect(cleanAbandonedBackupStaging(resolve(temporaryRoot(), "absent"), "x")).toEqual([]);
  });

  it("generates ids in the shape customerBackupInputFromEnv expects", () => {
    const id = nextCustomerBackupId(new Date("2026-08-31T23:00:00.000Z"));
    expect(id).toBe("customer-2026-08-31T23-00-00-000Z");
    expect(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)).toBe(true);
  });
});

describe("receipt logging", () => {
  it("reduces the receipt to the backup id, leaking no storage identity", () => {
    const receipt = JSON.stringify({
      backupId: "customer-2026-08-31T23-00-00-000Z",
      publication: { bucket: "secret-bucket", prefix: "p/x", endpoint: "https://s3" },
      manifestAuthentication: "f".repeat(64),
      keyId: "customer-backup-key-v2",
    });
    const summary = summarizeBackupReceipt(receipt);
    expect(summary).toBe("backupId=customer-2026-08-31T23-00-00-000Z");
    for (const secret of ["secret-bucket", "https://s3", "f".repeat(64), "customer-backup-key-v2"]) {
      expect(summary).not.toContain(secret);
    }
  });

  it("says so rather than inventing an id when the receipt is unreadable", () => {
    expect(summarizeBackupReceipt("")).toBe("backupId=unreported");
  });
});

describe("runCustomerBackupProcess", () => {
  it("spawns the same command the workflow ran over SSH", async () => {
    const { spawnBackup, calls } = recordingSpawn((child) => child.emit("close", 0, null));
    const outcome = await runCustomerBackupProcess({
      cwd: "/app",
      killTimeoutMs: 1_000,
      env: { MENDPOINT_BACKUP_KEY: "k" },
      spawnBackup,
    });
    expect(outcome).toEqual({ status: "succeeded" });
    expect(calls[0]!.args).toEqual(["--import", "tsx", "scripts/customer-backup.ts"]);
    expect(calls[0]!.options.cwd).toBe("/app");
    // Its own process group, so a timeout kill reaches the rclone grandchild too.
    // Killing only the direct child would leave an rclone transfer running against
    // the object store with nothing supervising it.
    expect(calls[0]!.options.detached).toBe(backupChildUsesProcessGroup(process.platform));
  });

  it("gives the child its own process group everywhere POSIX groups exist", async () => {
    // Asserted through an injected platform so this bites on Windows too, where
    // comparing against the host's own platform would be vacuously true.
    expect(backupChildUsesProcessGroup("linux")).toBe(true);
    expect(backupChildUsesProcessGroup("win32")).toBe(false);
    for (const [platform, expected] of [["linux", true], ["win32", false]] as const) {
      const { spawnBackup, calls } = recordingSpawn((child) => child.emit("close", 0, null));
      await runCustomerBackupProcess({
        cwd: "/app",
        killTimeoutMs: 1_000,
        env: {},
        spawnBackup,
        platform,
      });
      expect(calls[0]!.options.detached).toBe(expected);
    }
  });

  it("surfaces a failing backup with its stderr instead of swallowing it", async () => {
    const { spawnBackup } = recordingSpawn((child) => {
      child.stderr.emit("data", "customer_backup_verification_failed:database");
      child.emit("close", 1, null);
    });
    expect(
      await runCustomerBackupProcess({ cwd: "/app", killTimeoutMs: 1_000, env: {}, spawnBackup }),
    ).toEqual({
      status: "failed",
      code: "customer_backup_exit_1",
      stderr: "customer_backup_verification_failed:database",
    });
  });

  it("reports a spawn error as a failure rather than a silent success", async () => {
    const { spawnBackup } = recordingSpawn((child) => child.emit("error", new Error("ENOENT")));
    expect(
      await runCustomerBackupProcess({ cwd: "/app", killTimeoutMs: 1_000, env: {}, spawnBackup }),
    ).toEqual({ status: "failed", code: "customer_backup_spawn_failed:ENOENT", stderr: "" });
  });

  it("kills a run that exceeds its timeout and asks the caller to clear staging", async () => {
    let cleaned = false;
    // A real child that never exits on its own: only the timeout can end this.
    const outcome = await runCustomerBackupProcess({
      cwd: process.cwd(),
      killTimeoutMs: 250,
      env: process.env,
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      onKilled: () => { cleaned = true; },
    });
    expect(outcome.status).toBe("failed");
    expect(outcome).toMatchObject({ code: "customer_backup_timed_out" });
    expect(cleaned).toBe(true);
  });
});

describe("the child actually receives the backup credentials", () => {
  // Replacing the spawn env with `{}` must fail. A fake spawn cannot catch that,
  // so this runs a REAL child that reads its own environment.
  const readsEnv = [
    "-e",
    "process.exit(process.env.MENDPOINT_BACKUP_KEY === 'sentinel-key' ? 0 : 3)",
  ];

  it("passes the scoped backup environment through to the child", async () => {
    expect(
      await runCustomerBackupProcess({
        cwd: process.cwd(),
        killTimeoutMs: 20_000,
        env: { ...process.env, MENDPOINT_BACKUP_KEY: "sentinel-key" },
        command: process.execPath,
        args: readsEnv,
      }),
    ).toEqual({ status: "succeeded" });
  });

  it("fails when the environment does not carry the backup key", async () => {
    const outcome = await runCustomerBackupProcess({
      cwd: process.cwd(),
      killTimeoutMs: 20_000,
      env: {},
      command: process.execPath,
      args: readsEnv,
    });
    expect(outcome).toMatchObject({ status: "failed", code: "customer_backup_exit_3" });
  });
});

describe("startScheduler keeps the process alive and spawns nothing it should not", () => {
  it("idles without exiting on a non-customer profile", () => {
    const { spawnBackup, calls } = recordingSpawn((child) => child.emit("close", 0, null));
    const handle = startScheduler({
      env: { MENDPOINT_DEPLOYMENT_PROFILE: "demo" },
      spawnBackup,
      log: () => {},
      logError: () => {},
    });
    openHandles.push(handle);
    expect(handle.mode).toBe("idle_not_applicable");
    // The defect this pins: `await new Promise(() => {})` leaves the event loop
    // empty, Node exits 0, and the supervisor takes the machine down with it.
    expect(handle.keepsProcessAlive()).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("idles without exiting, and without spawning, when the configuration is invalid", () => {
    const errors: string[] = [];
    const { spawnBackup, calls } = recordingSpawn((child) => child.emit("close", 0, null));
    const handle = startScheduler({
      // Customer profile but nothing else: customerBackupInputFromEnv throws.
      env: { MENDPOINT_DEPLOYMENT_PROFILE: "customer" },
      spawnBackup,
      log: () => {},
      logError: (message, detail) => errors.push(`${message} ${detail ?? ""}`),
    });
    openHandles.push(handle);
    expect(handle.mode).toBe("idle_misconfigured");
    expect(handle.keepsProcessAlive()).toBe(true);
    // A doomed backup every tick would be the alternative.
    expect(calls).toHaveLength(0);
    expect(errors.join(" ")).toContain("customer_backup_scheduler_misconfigured");
  });

  it("runs on a real customer environment and catches up when evidence is missing", async () => {
    const { spawnBackup, calls } = recordingSpawn((child) => child.emit("close", 0, null));
    const handle = startScheduler({
      env: customerBackupEnv(),
      cwd: process.cwd(),
      spawnBackup,
      log: () => {},
      logError: () => {},
    });
    openHandles.push(handle);
    expect(handle.mode).toBe("running");
    expect(handle.intervalMs).toBe(1_800_000);
    expect(handle.keepsProcessAlive()).toBe(true);
    await handle.stop();
    // No evidence file exists, so the catch-up path must have fired exactly once.
    expect(calls).toHaveLength(1);
    const childEnv = calls[0]!.options.env as NodeJS.ProcessEnv;
    // The child is told the schedule's budget, not the machine's 4h default.
    expect(childEnv.MENDPOINT_BACKUP_OPERATION_TIMEOUT_MS).toBe("1440000");
    expect(childEnv.MENDPOINT_BACKUP_ID).toMatch(/^customer-/);
  });

  it("logs the child's stderr on failure, not just an exit code", async () => {
    // stdio is piped, so the child's reason reaches Fly logs only if this puts it
    // there. An exit code alone would make every failure look identical.
    const errors: string[] = [];
    const { spawnBackup } = recordingSpawn((child) => {
      child.stderr.emit("data", "customer_backup_publication_rejected:bucket-denied");
      child.emit("close", 1, null);
    });
    const handle = startScheduler({
      env: customerBackupEnv(),
      spawnBackup,
      log: () => {},
      logError: (message, detail) => errors.push(`${message} ${detail ?? ""}`),
    });
    openHandles.push(handle);
    await handle.stop();
    const failure = errors.find((line) => line.startsWith("customer_backup_schedule_failed"));
    expect(failure).toBeDefined();
    expect(failure).toContain("customer_backup_exit_1");
    expect(failure).toContain("customer_backup_publication_rejected:bucket-denied");
  });
});

describe("only the backup role can actually run this scheduler", () => {
  // The P0 that made the first attempt useless: the scheduler was hosted in the
  // worker, whose role environment has neither the backup key nor the AWS
  // credentials, so every tick spawned a child that could not possibly succeed.
  // This asserts the privilege wiring behaviourally, through the same function
  // start-fly.mjs uses, rather than by reading a list.
  const roleEnv = (role: "backup" | "worker" | "api") =>
    customerWardenChildEnvironment(role, customerBackupEnv() as Record<string, string>);

  it("reaches running under the backup role", () => {
    const { spawnBackup } = recordingSpawn((child) => child.emit("close", 0, null));
    const handle = startScheduler({
      env: roleEnv("backup"),
      spawnBackup,
      log: () => {},
      logError: () => {},
    });
    openHandles.push(handle);
    expect(handle.mode).toBe("running");
  });

  it("cannot run under the worker or api role, which is why it does not live there", () => {
    for (const role of ["worker", "api"] as const) {
      const { spawnBackup, calls } = recordingSpawn((child) => child.emit("close", 0, null));
      const handle = startScheduler({
        env: roleEnv(role),
        spawnBackup,
        log: () => {},
        logError: () => {},
      });
      openHandles.push(handle);
      expect(handle.mode).toBe("idle_misconfigured");
      expect(calls).toHaveLength(0);
    }
  });
});

describe("the third state: liveness that cannot be determined", () => {
  const marker = { pid: 4242, processStartedAt: "2026-09-01T12:00:00.000Z" };

  it("reports undeterminable distinctly from genuinely alive", () => {
    const undeterminable = fenceMarkerOwnerLiveness(marker, {
      isAlive: () => true,
      startedAtMs: () => null,
    });
    expect(undeterminable).toEqual({
      alive: true,
      determinable: false,
      reason: "process_start_time_unavailable",
    });
    expect(fenceMarkerOwnerLiveness(marker, {
      isAlive: () => true,
      startedAtMs: () => Date.parse(marker.processStartedAt),
    })).toEqual({ alive: true, determinable: true });
  });

  it("names an unparseable marker start time as its own cause", () => {
    expect(fenceMarkerOwnerLiveness({ pid: 1, processStartedAt: "not-a-date" }, {
      isAlive: () => true,
      startedAtMs: () => Date.now(),
    })).toEqual({
      alive: true,
      determinable: false,
      reason: "marker_start_time_unparseable",
    });
  });

  it("surfaces it as a distinct reap reason rather than 'owner alive'", () => {
    // Off Linux there is no /proc, so this is the REAL default path on this host.
    const root = resolve(temporaryRoot(), ".backup-fence");
    tryAcquireMutationLease(root)?.release();
    writeFileSync(
      resolve(root, "exclusive.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "exclusive",
        id: "customer-undeterminable",
        pid: process.pid,
        hostname: hostname(),
        processStartedAt: "2020-01-01T00:00:00.000Z",
        acquiredAt: "2026-08-31T23:00:00.000Z",
        ownerToken: "a".repeat(32),
      })}\n`,
      { mode: 0o600 },
    );
    const result = reapStaleExclusiveFence({ fenceRoot: root, startedAtMs: () => null });
    expect(result.reaped).toBe(false);
    expect(result.reason).toBe("liveness_undeterminable:process_start_time_unavailable");
    // Fails closed: the marker it could not vouch for is still there.
    expect(inspectMutationFence(root).exclusive).not.toBeNull();
  });

  /**
   * Plants a marker owned by a LIVE pid (this test process) that claims to have
   * started in 2020. Which branch that lands in is decided entirely by the
   * injected start-time source, never by the host: on Linux the real /proc would
   * report a start time of today and classify it recycled, on Windows there is no
   * /proc at all and it would be undeterminable. Both branches below therefore
   * inject, so each test exercises the case it names on either platform.
   */
  const plantLivePidMarker = (env: NodeJS.ProcessEnv) => {
    const fenceRoot = env.MENDPOINT_BACKUP_FENCE_ROOT!;
    tryAcquireMutationLease(fenceRoot)?.release();
    writeFileSync(
      resolve(fenceRoot, "exclusive.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "exclusive",
        id: "customer-live-pid-marker",
        pid: process.pid,
        hostname: hostname(),
        processStartedAt: "2020-01-01T00:00:00.000Z",
        acquiredAt: "2026-08-31T23:00:00.000Z",
        ownerToken: "a".repeat(32),
      })}\n`,
      { mode: 0o600 },
    );
  };

  const runReapAndCollect = async (
    liveness: { startedAtMs: (pid: number) => number | null },
  ): Promise<string[]> => {
    const errors: string[] = [];
    const env = customerBackupEnv();
    plantLivePidMarker(env);
    const { spawnBackup } = recordingSpawn((child) => child.emit("close", 0, null));
    const handle = startScheduler({
      env,
      spawnBackup,
      log: () => {},
      logError: (message, detail) => errors.push(`${message} ${detail ?? ""}`),
      startedAtMs: liveness.startedAtMs,
    });
    openHandles.push(handle);
    await handle.stop();
    return errors;
  };

  it("logs the undeterminable state from the in-process reap", async () => {
    // No start time obtainable: fail closed, and SAY so. Injected rather than
    // relying on the host lacking /proc, which is what made this pass on Windows
    // and fail on Linux CI.
    const errors = await runReapAndCollect({ startedAtMs: () => null });
    expect(errors.join(" ")).toContain("customer_backup_fence_liveness_undeterminable");
    expect(errors.join(" ")).toContain("process_start_time_unavailable");
    // It must NOT claim to have reaped anything.
    expect(errors.join(" ")).not.toContain("customer_backup_fence_reaped");
  });

  it("logs a reap when the start time proves the pid was recycled", async () => {
    // The complementary, Linux-shaped case: /proc answers, and the answer is that
    // this pid started long after the marker claims its owner did. Injected so it
    // runs identically on a host with no /proc at all.
    const errors = await runReapAndCollect({
      startedAtMs: () => Date.parse("2026-09-01T12:00:00.000Z"),
    });
    expect(errors.join(" ")).toContain("customer_backup_fence_reaped");
    expect(errors.join(" ")).toContain("reaped_dead_owner");
    expect(errors.join(" ")).not.toContain("liveness_undeterminable");
  });

  it("logs neither when the owner is genuinely the live process", async () => {
    // Start time agrees with the marker: same process, really running. Nothing to
    // reap and nothing undeterminable, so the reap must stay silent.
    const errors = await runReapAndCollect({
      startedAtMs: () => Date.parse("2020-01-01T00:00:00.000Z"),
    });
    expect(errors.join(" ")).not.toContain("customer_backup_fence_reaped");
    expect(errors.join(" ")).not.toContain("liveness_undeterminable");
  });
});

describe("a recycled pid is reaped END TO END, through recoverStaleMutationMarker", () => {
  // The defect this pins: the scheduler decided "dead" with the start-time-aware
  // rule and then handed the reap to recoverStaleMutationMarker, which re-tested
  // liveness with a PLAIN pid check. A reused pid is alive to that check, so the
  // recover threw, the marker stayed, and initializeWithMutationLease refused to
  // boot the machine. The start-time rule was inert on the only path that matters.
  function plantRecycledPidMarker(): string {
    const root = resolve(temporaryRoot(), ".backup-fence");
    tryAcquireMutationLease(root)?.release();
    writeFileSync(
      resolve(root, "exclusive.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "exclusive",
        id: "customer-recycled-pid",
        // A pid that really is alive: this very test process.
        pid: process.pid,
        hostname: hostname(),
        // ...but recorded as having started years before it did.
        processStartedAt: "2020-01-01T00:00:00.000Z",
        acquiredAt: "2026-08-31T23:00:00.000Z",
        ownerToken: "a".repeat(32),
      })}\n`,
      { mode: 0o600 },
    );
    return root;
  }

  it("reaps, and the lease is allowed afterwards", () => {
    const root = plantRecycledPidMarker();
    const env = { MENDPOINT_BACKUP_FENCE_ROOT: root };
    expect(() => initializeWithMutationLease(() => {}, env))
      .toThrow("customer_startup_blocked_by_backup");
    const result = reapStaleExclusiveFenceAtBoot({
      fenceRoot: root,
      prepare: () => {},
      // The live pid is real; only the start time betrays the reuse.
      startedAtMs: () => Date.parse("2026-09-01T12:00:00.000Z"),
    });
    expect(result).toEqual({ reaped: true, reason: "reaped_dead_owner" });
    expect(inspectMutationFence(root).exclusive).toBeNull();
    let booted = false;
    initializeWithMutationLease(() => { booted = true; }, env);
    expect(booted).toBe(true);
  });

  it("still refuses when the owner is genuinely alive", () => {
    const root = plantRecycledPidMarker();
    const result = reapStaleExclusiveFenceAtBoot({
      fenceRoot: root,
      prepare: () => {},
      // Start time agrees with the marker: same process, really running.
      startedAtMs: () => Date.parse("2020-01-01T00:00:00.000Z"),
    });
    expect(result).toEqual({ reaped: false, reason: "marker_owner_alive" });
    expect(inspectMutationFence(root).exclusive).not.toBeNull();
  });

  it("refuses at the ops layer too when its own predicate says alive", () => {
    // recoverStaleMutationMarker owns the final word; this is the guard that made
    // the scheduler's smarter rule inert, so it must still fire on demand.
    const root = plantRecycledPidMarker();
    const inspected = inspectMutationFence(root).exclusive!;
    expect(() => recoverStaleMutationMarker({
      fenceRoot: root,
      kind: "exclusive",
      markerId: inspected.id,
      expectedMarkerSha256: inspected.markerSha256,
      ownerTerminationEvidence: "test",
      ownerIsAlive: () => true,
    })).toThrow("backup_fence_recovery_owner_still_alive");
  });
});

describe("the boot reap must not leave a root-owned audit file", () => {
  // start-fly.mjs runs as root (Dockerfile USER root precedes its CMD) while every
  // backup runs as uid 1000. recoverStaleMutationMarker appends recovery-audit.jsonl
  // with mode 0o600, so a reap performed as root creates that file owned by ROOT and
  // every later backup dies in prepareMutationFenceDirectories' accessSync on it.
  // Invisible on a fresh volume: no marker means no reap and no audit file.
  //
  // Ownership is modelled rather than exercised, because no test process is root
  // and Windows has no uid at all. The model is the real call sequence: who runs
  // the reap, and whether prepare is invoked as root afterwards to hand the file
  // back. It fails on the pre-fix code, which called the reaper with no prologue.
  function ownershipModel() {
    // `runningAsRoot` mirrors production: start-fly.mjs boots as root, and
    // prepareMutationFenceDirectories chowns ONLY under that branch. A stub that
    // chowned unconditionally would pass even if the privileged gate were wrong.
    const state = { auditExists: false, auditOwner: 0 as number, runningAsRoot: true };
    const prepare = (_fenceRoot: string) => {
      if (!state.runningAsRoot) return;
      if (state.auditExists) state.auditOwner = 1000;
    };
    const reap = () => {
      // Real recoverStaleMutationMarker appends the audit line as the current
      // user, which at boot is root.
      state.auditExists = true;
      state.auditOwner = 0;
      return { reaped: true, reason: "reaped_dead_owner" };
    };
    return { state, prepare, reap };
  }

  it("hands the audit file back to the customer identity after reaping", () => {
    const model = ownershipModel();
    const result = reapStaleExclusiveFenceAtBoot({
      fenceRoot: "/data/db/.backup-fence",
      prepare: model.prepare,
      reap: model.reap,
    });
    expect(result).toEqual({ reaped: true, reason: "reaped_dead_owner" });
    expect(model.state.auditExists).toBe(true);
    // uid 1000, or the next backup cannot open its own fence audit.
    expect(model.state.auditOwner).toBe(1000);
  });

  it("repairs ownership even when the reap throws after creating the file", () => {
    const model = ownershipModel();
    expect(() => reapStaleExclusiveFenceAtBoot({
      fenceRoot: "/data/db/.backup-fence",
      prepare: model.prepare,
      reap: () => {
        model.reap();
        throw new Error("backup_fence_recovery_marker_evidence_mismatch");
      },
    })).toThrow("backup_fence_recovery_marker_evidence_mismatch");
    expect(model.state.auditOwner).toBe(1000);
  });

  it("really reaps, on a real fence, when nothing is injected", () => {
    // Every other case here injects `reap`, which leaves the DEFAULT wiring
    // uncovered: pointing it at a no-op would keep them all green while the boot
    // reap silently stopped reaping. Only `prepare` is stubbed, because the real
    // one needs a root process to be meaningful.
    const root = resolve(temporaryRoot(), ".backup-fence");
    tryAcquireMutationLease(root)?.release();
    writeFileSync(
      resolve(root, "exclusive.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "exclusive",
        id: "customer-killed-run",
        pid: 424_242,
        hostname: hostname(),
        processStartedAt: "2026-08-31T22:59:00.000Z",
        acquiredAt: "2026-08-31T23:00:00.000Z",
        ownerToken: "a".repeat(32),
      })}\n`,
      { mode: 0o600 },
    );
    expect(inspectMutationFence(root).exclusive).not.toBeNull();
    const result = reapStaleExclusiveFenceAtBoot({
      fenceRoot: root,
      prepare: () => {},
      isAlive: () => false,
    });
    expect(result).toEqual({ reaped: true, reason: "reaped_dead_owner" });
    expect(inspectMutationFence(root).exclusive).toBeNull();
  });

  it("really prepares, via the ownership-enforcing preparer, when nothing is injected", () => {
    // The default `prepare` must be the REAL prepareMutationFenceDirectories --
    // the only thing that hands the audit file back to uid 1000. Pointing it at a
    // no-op would keep the call-order tests green while the ownership fix quietly
    // stopped happening. The real preparer rejects an unsafe fence root;
    // inspectMutationFence, which the reaper itself calls, does not. So this
    // throwing is proof the real preparer ran, and ran first.
    expect(() => reapStaleExclusiveFenceAtBoot({
      fenceRoot: resolve("/"),
      reap: () => { throw new Error("reap must not be reached"); },
    })).toThrow(/backup_fence_root(_parent)?_unsafe/);
  });

  it("cannot repair ownership when it is not running as root", () => {
    // Mirrors the real branch: an unprivileged prepare chowns nothing, so a
    // root-created audit file would stay root-owned. This is why the reap has to
    // happen where the launcher still has the privilege to hand it back.
    const model = ownershipModel();
    model.state.runningAsRoot = false;
    reapStaleExclusiveFenceAtBoot({
      fenceRoot: "/data/db/.backup-fence",
      prepare: model.prepare,
      reap: model.reap,
    });
    expect(model.state.auditOwner).toBe(0);
  });

  it("prepares the fence directories before reaping, not only after", () => {
    const order: string[] = [];
    reapStaleExclusiveFenceAtBoot({
      fenceRoot: "/data/db/.backup-fence",
      prepare: () => order.push("prepare"),
      reap: () => { order.push("reap"); return { reaped: false, reason: "no_exclusive_marker" }; },
    });
    expect(order).toEqual(["prepare", "reap", "prepare"]);
  });

  it("chowns an existing audit file to the customer identity when run as root", () => {
    // The ops-level seam the model above stands for. Without injection this
    // branch is unreachable off a root Linux host.
    const root = resolve(temporaryRoot(), ".backup-fence");
    tryAcquireMutationLease(root)?.release();
    writeFileSync(resolve(root, "recovery-audit.jsonl"), "{}\n", { mode: 0o600 });
    const chowned: Array<[string, number, number]> = [];
    prepareMutationFenceDirectories(root, { uid: 1000, gid: 1000 }, {
      getuid: () => 0,
      chown: (path, uid, gid) => chowned.push([path, uid, gid]),
      chmod: () => {},
      access: () => {},
    });
    const audit = chowned.find(([path]) => path.endsWith("recovery-audit.jsonl"));
    expect(audit).toBeDefined();
    expect(audit!.slice(1)).toEqual([1000, 1000]);
  });

  it("does not chown when it is not running as root", () => {
    const root = resolve(temporaryRoot(), ".backup-fence");
    tryAcquireMutationLease(root)?.release();
    writeFileSync(resolve(root, "recovery-audit.jsonl"), "{}\n", { mode: 0o600 });
    const chowned: string[] = [];
    prepareMutationFenceDirectories(root, { uid: 1000, gid: 1000 }, {
      getuid: () => 1000,
      chown: (path) => chowned.push(path),
      chmod: () => {},
      access: () => {},
    });
    expect(chowned).toEqual([]);
  });
});

describe("pid liveness compares process start time, not just pid existence", () => {
  const marker = (pid: number, processStartedAt: string) => ({ pid, processStartedAt });

  it("treats a recycled pid as dead", () => {
    // A Firecracker restart resets the pid namespace, so a dead owner's pid is
    // readily reoccupied. Without this the marker looks alive forever and the
    // lease blocks every boot -- the human-at-boot case this exists to remove.
    expect(fenceMarkerOwnerIsAlive(marker(4242, "2020-01-01T00:00:00.000Z"), {
      isAlive: () => true,
      startedAtMs: () => Date.parse("2026-09-01T12:00:00.000Z"),
    })).toBe(false);
  });

  it("treats a matching start time as the same, live process", () => {
    const startedAt = "2026-09-01T12:00:00.000Z";
    expect(fenceMarkerOwnerIsAlive(marker(4242, startedAt), {
      isAlive: () => true,
      startedAtMs: () => Date.parse(startedAt) + 1_000,
    })).toBe(true);
  });

  it("fails closed when the platform cannot supply a start time", () => {
    expect(fenceMarkerOwnerIsAlive(marker(4242, "2020-01-01T00:00:00.000Z"), {
      isAlive: () => true,
      startedAtMs: () => null,
    })).toBe(true);
  });

  it("is dead when the pid itself is gone, whatever the start time says", () => {
    expect(fenceMarkerOwnerIsAlive(marker(4242, "2026-09-01T12:00:00.000Z"), {
      isAlive: () => false,
      startedAtMs: () => Date.parse("2026-09-01T12:00:00.000Z"),
    })).toBe(false);
  });

  it("keeps the tolerance tight enough to still catch pid reuse", () => {
    // Both sides of the drift test below derive from this constant, so widening
    // it would keep that test green while quietly waving recycled pids through.
    // The bound has to be a LITERAL: the tolerance exists to absorb whole-second
    // btime rounding and 10ms clock ticks, nothing more.
    expect(PID_START_TIME_TOLERANCE_MS).toBeLessThanOrEqual(60_000);
    expect(PID_START_TIME_TOLERANCE_MS).toBeGreaterThanOrEqual(1_000);
  });

  it("tolerates the granularity of the two clocks", () => {
    const startedAt = "2026-09-01T12:00:00.000Z";
    expect(fenceMarkerOwnerIsAlive(marker(4242, startedAt), {
      isAlive: () => true,
      startedAtMs: () => Date.parse(startedAt) + PID_START_TIME_TOLERANCE_MS - 1,
    })).toBe(true);
    expect(fenceMarkerOwnerIsAlive(marker(4242, startedAt), {
      isAlive: () => true,
      startedAtMs: () => Date.parse(startedAt) + PID_START_TIME_TOLERANCE_MS + 1,
    })).toBe(false);
  });

  it("reads a start time out of /proc, counting fields past a comm with spaces", () => {
    const procStat = "cpu 1 2 3\nbtime 1756000000\nprocesses 99\n";
    // comm deliberately contains a space and a ")" -- the reason fields are
    // counted from the LAST ")" rather than by splitting on whitespace.
    const pidStat = "4242 (weird ) name) S 1 1 1 0 -1 0 0 0 0 0 1 2 3 4 20 0 1 0 360000 0 0";
    const startedAt = livePidStartedAtMs(4242, (path: string) =>
      path === "/proc/stat" ? procStat : pidStat);
    // btime 1756000000s + starttime 360000 ticks / 100 = +3600s
    expect(startedAt).toBe(1_756_000_000_000 + 3_600_000);
  });

  it("returns null rather than guessing when /proc is unavailable", () => {
    expect(livePidStartedAtMs(4242, () => { throw new Error("ENOENT"); })).toBeNull();
  });
});

describe("the deploy catch-up closes the whole window, not just the past", () => {
  const BOOT = new Date("2026-09-01T12:00:00.000Z");

  it("asks the readiness authority about the FIRST TICK, not about now", () => {
    // rpoSeconds 3600, intervalMs 1_800_000. Evidence aged 3599s at boot is still
    // "current", so an already-overdue test skips the catch-up; by the first tick
    // it is 5399s old and /ready is red for up to 1799s after every deploy.
    const asked: Array<Date | undefined> = [];
    const { spawnBackup, calls } = recordingSpawn((child) => child.emit("close", 0, null));
    const handle = startScheduler({
      env: customerBackupEnv(),
      spawnBackup,
      now: () => BOOT,
      log: () => {},
      logError: () => {},
      assessReadiness: ((_env: unknown, when?: Date) => {
        asked.push(when);
        const ageAt = (when ?? BOOT).getTime() - (BOOT.getTime() - 3_599_000);
        return ageAt <= 3_600_000
          ? { ok: true, detail: "current" as const }
          : { ok: false, detail: "overdue" as const };
      }) as never,
    });
    openHandles.push(handle);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.getTime()).toBe(BOOT.getTime() + 1_800_000);
    // Evidence that is "current" right now but overdue before the next tick must
    // still trigger the catch-up.
    expect(calls).toHaveLength(1);
  });

  it("does not run a gratuitous backup when the evidence survives the whole interval", () => {
    const { spawnBackup, calls } = recordingSpawn((child) => child.emit("close", 0, null));
    const handle = startScheduler({
      env: customerBackupEnv(),
      spawnBackup,
      now: () => BOOT,
      log: () => {},
      logError: () => {},
      assessReadiness: (() => ({ ok: true, detail: "current" as const })) as never,
    });
    openHandles.push(handle);
    expect(calls).toHaveLength(0);
  });
});

describe("a misconfigured scheduler keeps saying so", () => {
  it("repeats the reason on the backup cadence instead of once at startup", () => {
    // An idle_misconfigured child looks perfectly healthy to the supervisor while
    // taking no backup at all. A single startup line scrolls away and leaves a
    // silent, green-looking process.
    vi.useFakeTimers();
    try {
      const errors: string[] = [];
      const { spawnBackup, calls } = recordingSpawn((child) => child.emit("close", 0, null));
      const handle = startScheduler({
        env: { MENDPOINT_DEPLOYMENT_PROFILE: "customer" },
        spawnBackup,
        log: () => {},
        logError: (message, detail) => errors.push(`${message} ${detail ?? ""}`),
      });
      openHandles.push(handle);
      expect(handle.mode).toBe("idle_misconfigured");
      expect(errors).toHaveLength(1);
      vi.advanceTimersByTime(customerBackupIntervalMs());
      expect(errors).toHaveLength(2);
      expect(errors[1]).toContain("no backup has been taken");
      vi.advanceTimersByTime(customerBackupIntervalMs() * 2);
      expect(errors).toHaveLength(4);
      // Still never spawns anything it cannot complete.
      expect(calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
