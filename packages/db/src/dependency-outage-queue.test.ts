import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createDependencyOutageQueue,
  type DependencyOutageFailureDecision,
} from "./dependency-outage-queue.js";

const DIGEST = "b".repeat(64);
const COMPLETION = "c".repeat(64);
const SCOPE = Object.freeze({
  tenantId: "tenant-acme",
  dependencyKind: "model" as const,
  providerId: "muse-spark",
  operationId: "mission-123:model-call-4",
  operationDigest: DIGEST,
});

function retryDecision(nextAttemptAt = "2026-09-01T12:00:01.000Z"): DependencyOutageFailureDecision {
  return {
    schemaVersion: 1,
    action: "retry",
    failureKind: "transient",
    retryable: true,
    reason: "transient_failure",
    nextAttemptAt,
    circuitState: "closed",
    circuit: { state: "closed", cooldownMs: 30_000, consecutiveFailures: 1 },
    standing: "degraded_retrying",
  };
}

describe("durable dependency outage queue", () => {
  it("survives restart, fences stale claims, and acknowledges completion exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-outage-"));
    const path = join(root, "outage.sqlite");
    const firstDb = new DatabaseSync(path);
    const first = createDependencyOutageQueue(firstDb);
    first.enqueue({
      ...SCOPE,
      retryBudget: 3,
      expiresAt: "2026-09-01T13:00:00.000Z",
      nextAttemptAt: "2026-09-01T12:00:00.000Z",
      standing: "degraded_retrying",
      authorityVersion: "model-authority-v1",
    }, "2026-09-01T12:00:00.000Z");
    firstDb.close();

    const secondDb = new DatabaseSync(path);
    const second = createDependencyOutageQueue(secondDb);
    const oldClaim = second.claim({
      ...SCOPE,
      workerId: "worker-old",
      now: "2026-09-01T12:00:00.000Z",
      leaseMs: 1_000,
      authorityVersion: "model-authority-v1",
    });
    expect(oldClaim).not.toBeNull();
    const newClaim = second.claim({
      ...SCOPE,
      workerId: "worker-new",
      now: "2026-09-01T12:00:02.000Z",
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
    });
    expect(newClaim!.claimGeneration).toBe(oldClaim!.claimGeneration + 1);
    expect(second.complete(oldClaim!, COMPLETION, "2026-09-01T12:00:03.000Z").applied)
      .toBe(false);
    expect(second.complete(newClaim!, COMPLETION, "2026-09-01T12:00:03.000Z").applied)
      .toBe(true);
    expect(second.complete(newClaim!, COMPLETION, "2026-09-01T12:00:04.000Z").applied)
      .toBe(false);
    expect(second.get(SCOPE)).toMatchObject({ status: "completed", completionDigest: COMPLETION });
    expect(second.history(SCOPE).map((event) => event.kind)).toEqual([
      "enqueued",
      "claimed",
      "claim_recovered",
      "completed",
    ]);
    secondDb.close();
  });

  it("recovers a lost response without repeating the completed external effect", async () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-01T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    let remote: { value: string; digest: string } | null = null;
    const execute = vi.fn(async () => {
      remote = { value: "model-result", digest: COMPLETION };
      throw Object.assign(new Error("response lost"), { code: "ECONNRESET" });
    });
    const operation = {
      ...SCOPE,
      workerId: "worker-1",
      retryBudget: 3,
      expiresAt: "2026-09-01T13:00:00.000Z",
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
      reconcile: async () => remote === null
        ? ({ status: "missing" as const })
        : ({ status: "completed" as const, value: remote.value, completionDigest: remote.digest }),
      execute,
      classify: () => retryDecision("2026-09-01T12:00:01.000Z"),
    };
    await expect(queue.run(operation)).resolves.toMatchObject({ status: "deferred" });
    now = "2026-09-01T12:00:02.000Z";
    await expect(queue.run(operation)).resolves.toMatchObject({
      status: "recovered",
      value: "model-result",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(queue.get(SCOPE)).toMatchObject({ status: "completed", completionDigest: COMPLETION });
    db.close();
  });

  it("persists three-failure circuit history across restarts and probes half-open once", async () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-outage-circuit-"));
    const path = join(root, "outage.sqlite");
    const times = [
      "2026-09-01T12:00:00.000Z",
      "2026-09-01T12:00:02.000Z",
      "2026-09-01T12:00:04.000Z",
      "2026-09-01T12:00:34.000Z",
      "2026-09-01T12:01:04.000Z",
    ];
    const circuits: Array<Readonly<{
      state: "closed" | "open" | "half_open";
      openedAt?: string;
      cooldownMs: number;
      consecutiveFailures: number;
    }>> = [];
    let invocation = 0;

    const runFailure = async (now: string) => {
      const db = new DatabaseSync(path);
      const queue = createDependencyOutageQueue(db, { now: () => now });
      const result = await queue.run({
        ...SCOPE,
        workerId: `worker-${invocation + 1}`,
        retryBudget: 6,
        expiresAt: "2026-09-01T13:00:00.000Z",
        leaseMs: 30_000,
        authorityVersion: "model-authority-v1",
        reconcile: async () => ({ status: "missing" as const }),
        execute: async () => { throw Object.assign(new Error("unavailable"), { status: 503 }); },
        classify: (_error, context) => {
          circuits.push(context.circuit);
          const count = context.circuit.consecutiveFailures + 1;
          const open = context.circuit.state === "half_open" || count >= 3;
          return {
            schemaVersion: 1,
            action: open ? "wait" : "retry",
            failureKind: "transient",
            retryable: true,
            reason: open ? "circuit_opened" : "transient_failure",
            nextAttemptAt: new Date(Date.parse(context.now) + (open ? 30_000 : 1_000)).toISOString(),
            circuitState: open ? "open" : "closed",
            circuit: open
              ? { state: "open", openedAt: context.now, cooldownMs: 30_000, consecutiveFailures: count }
              : { state: "closed", cooldownMs: 30_000, consecutiveFailures: count },
            standing: "degraded_retrying",
          };
        },
      });
      invocation += 1;
      db.close();
      return result;
    };

    await runFailure(times[0]!);
    await runFailure(times[1]!);
    const opened = await runFailure(times[2]!);
    expect(opened.record).toMatchObject({
      circuitState: "open",
      circuitOpenedAt: times[2],
      circuitCooldownMs: 30_000,
      consecutiveFailures: 3,
    });

    const reopened = await runFailure(times[3]!);
    expect(circuits).toEqual([
      { state: "closed", cooldownMs: 30_000, consecutiveFailures: 0 },
      { state: "closed", cooldownMs: 30_000, consecutiveFailures: 1 },
      { state: "closed", cooldownMs: 30_000, consecutiveFailures: 2 },
      { state: "half_open", openedAt: times[2], cooldownMs: 30_000, consecutiveFailures: 3 },
    ]);
    expect(reopened.record).toMatchObject({
      circuitState: "open",
      circuitOpenedAt: times[3],
      consecutiveFailures: 4,
    });

    const finalDb = new DatabaseSync(path);
    const finalQueue = createDependencyOutageQueue(finalDb, { now: () => times[4]! });
    const recovered = await finalQueue.run({
      ...SCOPE,
      workerId: "worker-recovery",
      retryBudget: 6,
      expiresAt: "2026-09-01T13:00:00.000Z",
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
      reconcile: async () => ({ status: "missing" as const }),
      execute: async () => ({ value: "recovered", completionDigest: COMPLETION }),
      classify: () => { throw new Error("classification_not_expected"); },
    });
    expect(recovered).toMatchObject({ status: "completed", value: "recovered" });
    expect(finalQueue.get(SCOPE)).toMatchObject({
      status: "completed",
      standing: "healthy",
      circuitState: "closed",
      circuitOpenedAt: null,
      consecutiveFailures: 0,
    });
    finalDb.close();
  });

  it("does not claim blocked, expired, over-budget, or cross-tenant operations", () => {
    const db = new DatabaseSync(":memory:");
    const queue = createDependencyOutageQueue(db);
    queue.enqueue({
      ...SCOPE,
      retryBudget: 1,
      expiresAt: "2026-09-01T13:00:00.000Z",
      nextAttemptAt: "2026-09-01T12:00:00.000Z",
      standing: "degraded_retrying",
    }, "2026-09-01T12:00:00.000Z");
    const claim = queue.claim({ ...SCOPE, workerId: "worker-1", now: "2026-09-01T12:00:00.000Z", leaseMs: 1_000 })!;
    const failed = queue.fail(claim, retryDecision(), "2026-09-01T12:00:00.500Z");
    expect(failed).toMatchObject({ status: "failed", standing: "degraded_failed" });
    expect(queue.claim({ ...SCOPE, workerId: "worker-2", now: "2026-09-01T12:00:02.000Z", leaseMs: 1_000 }))
      .toBeNull();
    expect(queue.claim({ ...SCOPE, tenantId: "tenant-other", workerId: "worker-2", now: "2026-09-01T12:00:02.000Z", leaseMs: 1_000 }))
      .toBeNull();
    db.close();
  });

  it("keeps tenant and retry-budget claim guards independently load-bearing", () => {
    const db = new DatabaseSync(":memory:");
    const queue = createDependencyOutageQueue(db);
    queue.enqueue({
      ...SCOPE,
      retryBudget: 1,
      expiresAt: "2026-09-01T13:00:00.000Z",
      nextAttemptAt: "2026-09-01T12:00:00.000Z",
      standing: "degraded_retrying",
      authorityVersion: "model-authority-v1",
    }, "2026-09-01T12:00:00.000Z");

    expect(queue.claim({
      ...SCOPE,
      tenantId: "tenant-other",
      workerId: "worker-other",
      now: "2026-09-01T12:00:00.000Z",
      leaseMs: 1_000,
      authorityVersion: "model-authority-v1",
    } as never)).toBeNull();

    const first = queue.claim({
      ...SCOPE,
      workerId: "worker-first",
      now: "2026-09-01T12:00:00.000Z",
      leaseMs: 1_000,
      authorityVersion: "model-authority-v1",
    } as never);
    expect(first).not.toBeNull();
    expect(queue.claim({
      ...SCOPE,
      workerId: "worker-over-budget",
      now: "2026-09-01T12:00:02.000Z",
      leaseMs: 1_000,
      authorityVersion: "model-authority-v1",
    } as never)).toBeNull();
    db.close();
  });

  it("rejects authority drift before queued or lease-recovered work can execute", async () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-01T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    const execute = vi.fn(async () => ({ value: "delivered", completionDigest: COMPLETION }));
    const operation = {
      ...SCOPE,
      workerId: "worker-new",
      retryBudget: 3,
      expiresAt: "2026-09-01T13:00:00.000Z",
      leaseMs: 1_000,
      authorityVersion: "model-authority-v2",
      reconcile: async () => ({ status: "missing" as const }),
      execute,
      classify: () => retryDecision(),
    };
    queue.enqueue({
      ...SCOPE,
      retryBudget: 3,
      expiresAt: operation.expiresAt,
      nextAttemptAt: now,
      standing: "degraded_retrying",
      authorityVersion: "model-authority-v1",
    }, now);

    await expect(queue.run(operation)).rejects.toThrow("dependency_outage_authority_mismatch");
    expect(execute).not.toHaveBeenCalled();
    expect(queue.get(SCOPE)).toMatchObject({ status: "queued", authorityVersion: "model-authority-v1" });

    const claim = queue.claim({
      ...SCOPE,
      workerId: "worker-old",
      now,
      leaseMs: 1_000,
      authorityVersion: "model-authority-v1",
    } as never);
    expect(claim).not.toBeNull();
    now = "2026-09-01T12:00:02.000Z";
    await expect(queue.run(operation)).rejects.toThrow("dependency_outage_authority_mismatch");
    expect(execute).not.toHaveBeenCalled();
    expect(queue.get(SCOPE)).toMatchObject({ status: "claimed", authorityVersion: "model-authority-v1" });
    db.close();
  });

  it("reactivates authentication-blocked work only after the authority version changes", async () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-01T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    const operation = {
      ...SCOPE,
      workerId: "worker-1",
      retryBudget: 3,
      expiresAt: "2026-09-01T13:00:00.000Z",
      authorityVersion: "installation-v1",
      leaseMs: 30_000,
      reconcile: async () => ({ status: "missing" as const }),
      execute: async (): Promise<never> => {
        throw Object.assign(new Error("bad credentials"), { status: 401 });
      },
      classify: (): DependencyOutageFailureDecision => ({
        schemaVersion: 1,
        action: "await_authority",
        failureKind: "authentication",
        retryable: false,
        reason: "authority_change_required",
        nextAttemptAt: null,
        circuitState: "open",
        circuit: { state: "open", openedAt: now, cooldownMs: 30_000, consecutiveFailures: 1 },
        standing: "degraded_blocked",
      }),
    };
    await expect(queue.run(operation)).resolves.toMatchObject({
      status: "blocked",
      record: { authorityVersion: "installation-v1" },
    });
    expect(() => queue.reactivateAuthority(SCOPE, {
      previousAuthorityVersion: "installation-v1",
      nextAuthorityVersion: "installation-v1",
      now: "2026-09-01T12:05:00.000Z",
    })).toThrow("dependency_outage_authority_unchanged");
    now = "2026-09-01T12:05:01.000Z";
    await expect(queue.run({
      ...operation,
      workerId: "worker-2",
      authorityVersion: "installation-v2",
      execute: async () => ({ value: "delivered", completionDigest: COMPLETION }),
      classify: () => { throw new Error("classification_not_expected"); },
    })).resolves.toMatchObject({ status: "completed", value: "delivered" });
    expect(queue.history(SCOPE).map((event) => event.kind)).toContain("authority_reactivated");
    db.close();
  });

  it("rejects missing or malformed authority on authority-bearing operations", async () => {
    const db = new DatabaseSync(":memory:");
    const queue = createDependencyOutageQueue(db, { now: () => "2026-09-01T12:00:00.000Z" });
    const operation = {
      ...SCOPE,
      workerId: "worker-1",
      retryBudget: 3,
      expiresAt: "2026-09-01T13:00:00.000Z",
      leaseMs: 30_000,
      authorityVersion: "bad authority",
      reconcile: async () => ({ status: "missing" as const }),
      execute: async () => ({ value: "unused", completionDigest: COMPLETION }),
      classify: () => retryDecision(),
    };
    await expect(queue.run(operation)).rejects.toThrow("dependency_outage_authority_invalid");
    db.close();
  });

  it("rejects digest substitution and expired authority reactivation", () => {
    const db = new DatabaseSync(":memory:");
    const queue = createDependencyOutageQueue(db);
    queue.enqueue({
      ...SCOPE,
      retryBudget: 3,
      expiresAt: "2026-09-01T12:01:00.000Z",
      nextAttemptAt: "2026-09-01T12:00:00.000Z",
      standing: "degraded_blocked",
      authorityVersion: "installation-v1",
      status: "blocked",
    }, "2026-09-01T12:00:00.000Z");

    expect(() => queue.claim({
      ...SCOPE,
      operationDigest: "d".repeat(64),
      workerId: "worker-1",
      now: "2026-09-01T12:00:00.000Z",
      leaseMs: 1_000,
    })).toThrow("dependency_outage_operation_digest_conflict");
    expect(() => queue.reactivateAuthority(SCOPE, {
      previousAuthorityVersion: "installation-v1",
      nextAuthorityVersion: "installation-v2",
      now: "2026-09-01T12:01:00.000Z",
    })).toThrow("dependency_outage_expired");
    db.close();
  });

  it("keeps the hash-chained recovery history append-only", () => {
    const db = new DatabaseSync(":memory:");
    const queue = createDependencyOutageQueue(db);
    queue.enqueue({
      ...SCOPE,
      retryBudget: 3,
      expiresAt: "2026-09-01T13:00:00.000Z",
      nextAttemptAt: "2026-09-01T12:00:00.000Z",
      standing: "degraded_retrying",
    }, "2026-09-01T12:00:00.000Z");

    expect(() => db.exec("UPDATE dependency_outage_history SET event_kind = 'rewritten'"))
      .toThrow("dependency_outage_history_immutable");
    expect(() => db.exec("DELETE FROM dependency_outage_history"))
      .toThrow("dependency_outage_history_immutable");
    expect(queue.history(SCOPE).map((event) => event.kind)).toEqual(["enqueued"]);
    db.close();
  });
});
