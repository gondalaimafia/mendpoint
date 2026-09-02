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
    }, "2026-09-01T12:00:00.000Z");
    firstDb.close();

    const secondDb = new DatabaseSync(path);
    const second = createDependencyOutageQueue(secondDb);
    const oldClaim = second.claim({
      ...SCOPE,
      workerId: "worker-old",
      now: "2026-09-01T12:00:00.000Z",
      leaseMs: 1_000,
    });
    expect(oldClaim).not.toBeNull();
    const newClaim = second.claim({
      ...SCOPE,
      workerId: "worker-new",
      now: "2026-09-01T12:00:02.000Z",
      leaseMs: 30_000,
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

  it("reactivates authorization-blocked work only after the authority version changes", () => {
    const db = new DatabaseSync(":memory:");
    const queue = createDependencyOutageQueue(db);
    queue.enqueue({
      ...SCOPE,
      retryBudget: 3,
      expiresAt: "2026-09-01T13:00:00.000Z",
      nextAttemptAt: "2026-09-01T12:00:00.000Z",
      standing: "degraded_blocked",
      authorityVersion: "installation-v1",
      status: "blocked",
    }, "2026-09-01T12:00:00.000Z");
    expect(() => queue.reactivateAuthority(SCOPE, {
      previousAuthorityVersion: "installation-v1",
      nextAuthorityVersion: "installation-v1",
      now: "2026-09-01T12:05:00.000Z",
    })).toThrow("dependency_outage_authority_unchanged");
    expect(queue.reactivateAuthority(SCOPE, {
      previousAuthorityVersion: "installation-v1",
      nextAuthorityVersion: "installation-v2",
      now: "2026-09-01T12:05:00.000Z",
    })).toMatchObject({ status: "queued", authorityVersion: "installation-v2" });
    db.close();
  });
});
