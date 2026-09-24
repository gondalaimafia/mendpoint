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

function retryDecision(
  nextAttemptAt = "2026-09-01T12:00:01.000Z",
  attemptsRemaining = 2,
): DependencyOutageFailureDecision {
  return {
    schemaVersion: 1,
    action: "retry",
    failureKind: "transient",
    retryable: true,
    reason: "transient_failure",
    nextAttemptAt,
    attemptsRemaining,
    circuitState: "closed",
    circuit: { state: "closed", cooldownMs: 30_000, consecutiveFailures: 1 },
    standing: "degraded_retrying",
  };
}

function decisionForAction(
  action: DependencyOutageFailureDecision["action"],
  attemptsRemaining = 2,
): DependencyOutageFailureDecision {
  const base = retryDecision("2026-09-02T12:00:01.000Z", attemptsRemaining);
  if (action === "reconcile") {
    return {
      ...base,
      action,
      failureKind: "completed",
      retryable: false,
      reason: "completed_effect_requires_reconciliation",
      nextAttemptAt: null,
      standing: "recovering",
    };
  }
  if (action === "await_authority") {
    return {
      ...base,
      action,
      failureKind: "authentication",
      retryable: false,
      reason: "authority_change_required",
      nextAttemptAt: null,
      circuitState: "open",
      circuit: {
        state: "open",
        openedAt: "2026-09-02T12:00:00.000Z",
        cooldownMs: 30_000,
        consecutiveFailures: 1,
      },
      standing: "degraded_blocked",
    };
  }
  if (action === "fail") {
    return {
      ...base,
      action,
      failureKind: "permanent",
      retryable: false,
      reason: "permanent_failure",
      nextAttemptAt: null,
      circuitState: "open",
      circuit: {
        state: "open",
        openedAt: "2026-09-02T12:00:00.000Z",
        cooldownMs: 30_000,
        consecutiveFailures: 1,
      },
      standing: "degraded_failed",
    };
  }
  if (action === "wait") {
    return {
      ...base,
      action,
      reason: "circuit_open",
      circuitState: "open",
      circuit: {
        state: "open",
        openedAt: "2026-09-02T12:00:00.000Z",
        cooldownMs: 30_000,
        consecutiveFailures: 3,
      },
    };
  }
  return {
    ...base,
    action,
    reason: "transient_failure",
  };
}

describe("durable dependency outage queue", () => {
  it("rejects every unknown decision enum and extra field while retaining the active fence", () => {
    const invalidDecisions: readonly DependencyOutageFailureDecision[] = [
      { ...retryDecision(), action: "mystery" } as never,
      { ...retryDecision(), failureKind: "mystery" },
      { ...retryDecision(), circuitState: "mystery" } as never,
      { ...retryDecision(), circuit: { ...retryDecision().circuit, state: "mystery" } } as never,
      { ...retryDecision(), standing: "mystery" } as never,
      { ...retryDecision(), unsupported: true } as never,
      { ...retryDecision(), circuit: { ...retryDecision().circuit, unsupported: true } } as never,
    ];

    for (const [index, decision] of invalidDecisions.entries()) {
      const queue = createDependencyOutageQueue(new DatabaseSync(":memory:"));
      const scope = { ...SCOPE, operationId: `invalid-decision-${index}` };
      queue.enqueue({
        ...scope,
        retryBudget: 3,
        expiresAt: "2026-09-02T14:00:00.000Z",
        nextAttemptAt: "2026-09-02T12:00:00.000Z",
        standing: "degraded_retrying",
        authorityVersion: "model-authority-v1",
      }, "2026-09-02T12:00:00.000Z");
      const claim = queue.claim({
        ...scope,
        workerId: "worker-1",
        now: "2026-09-02T12:00:00.000Z",
        leaseMs: 30_000,
        authorityVersion: "model-authority-v1",
      })!;
      expect(() => queue.fail(claim, decision, "2026-09-02T12:00:01.000Z"))
        .toThrow("dependency_outage_decision_invalid");
      expect(queue.get(scope)).toMatchObject({
        status: "claimed",
        claimGeneration: claim.claimGeneration,
      });
    }
  });

  it("rejects every invalid action and failure-kind combination", () => {
    const failureKinds = [
      "timeout", "throttled", "transient", "invalid_response", "authentication",
      "permission", "permanent", "expired", "completed",
    ] as const;
    const allowed = {
      retry: new Set(["timeout", "throttled", "transient", "invalid_response"]),
      wait: new Set(["timeout", "throttled", "transient", "invalid_response"]),
      await_authority: new Set(["authentication", "permission"]),
      fail: new Set(["timeout", "throttled", "transient", "invalid_response", "permanent", "expired"]),
      reconcile: new Set(["completed"]),
    } satisfies Record<DependencyOutageFailureDecision["action"], ReadonlySet<string>>;

    let index = 0;
    for (const action of Object.keys(allowed) as DependencyOutageFailureDecision["action"][]) {
      for (const failureKind of failureKinds) {
        if (allowed[action].has(failureKind)) continue;
        const queue = createDependencyOutageQueue(new DatabaseSync(":memory:"));
        const scope = { ...SCOPE, operationId: `invalid-pair-${index++}` };
        queue.enqueue({
          ...scope,
          retryBudget: 3,
          expiresAt: "2026-09-02T14:00:00.000Z",
          nextAttemptAt: "2026-09-02T12:00:00.000Z",
          standing: "degraded_retrying",
          authorityVersion: "model-authority-v1",
        }, "2026-09-02T12:00:00.000Z");
        const claim = queue.claim({
          ...scope,
          workerId: "worker-1",
          now: "2026-09-02T12:00:00.000Z",
          leaseMs: 30_000,
          authorityVersion: "model-authority-v1",
        })!;
        expect(() => queue.fail(
          claim,
          { ...decisionForAction(action), failureKind },
          "2026-09-02T12:00:01.000Z",
        ), `${action}:${failureKind}`).toThrow("dependency_outage_decision_invalid");
      }
    }
  });

  it.each([
    ["completed reconciliation", decisionForAction("reconcile", 0), "blocked", "completed_effect_requires_reconciliation"],
    ["authentication recovery", decisionForAction("await_authority", 0), "blocked", "authority_change_required"],
    ["permission recovery", { ...decisionForAction("await_authority", 0), failureKind: "permission" }, "blocked", "authority_change_required"],
    ["transient retry", decisionForAction("retry", 0), "failed", "retry_budget_exhausted"],
    ["throttle wait", { ...decisionForAction("wait", 0), failureKind: "throttled", reason: "provider_throttled" }, "failed", "retry_budget_exhausted"],
  ] as const)("applies final-attempt precedence to %s", (_name, decision, status, reason) => {
    const queue = createDependencyOutageQueue(new DatabaseSync(":memory:"));
    queue.enqueue({
      ...SCOPE,
      retryBudget: 1,
      expiresAt: "2026-09-02T14:00:00.000Z",
      nextAttemptAt: "2026-09-02T12:00:00.000Z",
      standing: "degraded_retrying",
      authorityVersion: "model-authority-v1",
    }, "2026-09-02T12:00:00.000Z");
    const claim = queue.claim({
      ...SCOPE,
      workerId: "worker-1",
      now: "2026-09-02T12:00:00.000Z",
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
    })!;
    expect(queue.fail(claim, decision, "2026-09-02T12:00:01.000Z")).toMatchObject({
      status,
      lastFailureKind: decision.failureKind,
      lastFailureReason: reason,
    });
  });

  it("rejects retry scheduling at or beyond the operation expiry", () => {
    for (const nextAttemptAt of [
      "2026-09-02T14:00:00.000Z",
      "2026-09-02T14:00:00.001Z",
    ]) {
      const queue = createDependencyOutageQueue(new DatabaseSync(":memory:"));
      queue.enqueue({
        ...SCOPE,
        retryBudget: 3,
        expiresAt: "2026-09-02T14:00:00.000Z",
        nextAttemptAt: "2026-09-02T12:00:00.000Z",
        standing: "degraded_retrying",
        authorityVersion: "model-authority-v1",
      }, "2026-09-02T12:00:00.000Z");
      const claim = queue.claim({
        ...SCOPE,
        workerId: "worker-1",
        now: "2026-09-02T12:00:00.000Z",
        leaseMs: 30_000,
        authorityVersion: "model-authority-v1",
      })!;
      expect(() => queue.fail(claim, retryDecision(nextAttemptAt), "2026-09-02T12:00:01.000Z"))
        .toThrow("dependency_outage_retry_after_expiry");
      expect(queue.get(SCOPE)).toMatchObject({ status: "claimed" });
    }
  });

  it("rejects retry scheduling before the failure timestamp", () => {
    const queue = createDependencyOutageQueue(new DatabaseSync(":memory:"));
    queue.enqueue({
      ...SCOPE,
      retryBudget: 3,
      expiresAt: "2026-09-02T14:00:00.000Z",
      nextAttemptAt: "2026-09-02T12:00:00.000Z",
      standing: "degraded_retrying",
      authorityVersion: "model-authority-v1",
    }, "2026-09-02T12:00:00.000Z");
    const claim = queue.claim({
      ...SCOPE,
      workerId: "worker-1",
      now: "2026-09-02T12:00:00.000Z",
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
    })!;

    expect(() => queue.fail(
      claim,
      retryDecision("2026-09-02T12:00:00.999Z"),
      "2026-09-02T12:00:01.000Z",
    )).toThrow("dependency_outage_retry_before_failure");
    expect(queue.get(SCOPE)).toMatchObject({ status: "claimed" });
  });

  it.each([
    ["before its first claim", "2026-09-02T12:00:00.000Z"],
    ["while waiting for retry", "2026-09-02T12:30:00.000Z"],
  ])("terminalizes queued work that expires %s", (_name, nextAttemptAt) => {
    const db = new DatabaseSync(":memory:");
    const queue = createDependencyOutageQueue(db);
    queue.enqueue({
      ...SCOPE,
      retryBudget: 3,
      expiresAt: "2026-09-02T13:00:00.000Z",
      nextAttemptAt,
      standing: "degraded_retrying",
      authorityVersion: "model-authority-v1",
    }, "2026-09-02T12:00:00.000Z");

    expect(queue.claim({
      ...SCOPE,
      workerId: "worker-1",
      now: "2026-09-02T13:00:00.000Z",
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
    })).toBeNull();
    expect(queue.get(SCOPE)).toMatchObject({
      status: "failed",
      standing: "degraded_failed",
      lastFailureKind: "expired",
      lastFailureReason: "operation_expired",
    });
    expect(queue.history(SCOPE).at(-1)).toMatchObject({
      kind: "failed",
      details: { failureKind: "expired", reason: "operation_expired" },
    });
  });

  it("settles an expired queued operation exactly once across competing claimers", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-outage-expiry-"));
    const path = join(root, "outage.sqlite");
    const first = createDependencyOutageQueue(new DatabaseSync(path));
    const second = createDependencyOutageQueue(new DatabaseSync(path));
    first.enqueue({
      ...SCOPE,
      retryBudget: 3,
      expiresAt: "2026-09-02T13:00:00.000Z",
      nextAttemptAt: "2026-09-02T12:00:00.000Z",
      standing: "degraded_retrying",
      authorityVersion: "model-authority-v1",
    }, "2026-09-02T12:00:00.000Z");
    const claimInput = {
      ...SCOPE,
      workerId: "worker-1",
      now: "2026-09-02T13:00:00.000Z",
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
    };

    expect(first.claim(claimInput)).toBeNull();
    expect(second.claim({ ...claimInput, workerId: "worker-2" })).toBeNull();
    expect(first.history(SCOPE).filter((event) =>
      event.kind === "failed" && event.details.reason === "operation_expired"
    )).toHaveLength(1);
  });

  it("replays an expired queued operation as the same terminal failure", async () => {
    let now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(new DatabaseSync(":memory:"), { now: () => now });
    const operation = {
      ...SCOPE,
      workerId: "worker-1",
      retryBudget: 3,
      expiresAt: "2026-09-02T13:00:00.000Z",
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
      reconcile: async () => ({ status: "missing" as const }),
      execute: async () => { throw new Error("execute_not_expected"); },
      classify: () => retryDecision(),
    };
    queue.enqueue({
      ...operation,
      nextAttemptAt: "2026-09-02T12:30:00.000Z",
      standing: "degraded_retrying",
    }, now);
    now = "2026-09-02T13:00:00.000Z";

    await expect(queue.run(operation)).resolves.toMatchObject({
      status: "failed",
      record: { lastFailureKind: "expired", lastFailureReason: "operation_expired" },
    });
    await expect(queue.run(operation)).resolves.toMatchObject({
      status: "failed",
      record: { lastFailureKind: "expired", lastFailureReason: "operation_expired" },
    });
    expect(queue.history(SCOPE).filter((event) =>
      event.kind === "failed" && event.details.reason === "operation_expired"
    )).toHaveLength(1);
  });

  it("rejects malformed injected failure decisions instead of minting retry authority", async () => {
    const queue = createDependencyOutageQueue(new DatabaseSync(":memory:"), {
      now: () => "2026-09-02T12:00:00.000Z",
    });
    const operation = {
      ...SCOPE,
      workerId: "worker-1",
      retryBudget: 3,
      expiresAt: "2026-09-02T14:00:00.000Z",
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
      reconcile: async () => ({ status: "missing" as const }),
      execute: async () => { throw new Error("transport failed"); },
      classify: () => ({
        ...retryDecision("2026-09-02T12:00:01.000Z"),
        failureKind: "mystery",
      }),
    };

    await expect(queue.run(operation)).rejects.toThrow("dependency_outage_decision_invalid");
    expect(queue.get(SCOPE)).toMatchObject({ status: "claimed" });
  });

  it("rejects unknown reconciliation evidence before executing the external effect", async () => {
    const queue = createDependencyOutageQueue(new DatabaseSync(":memory:"), {
      now: () => "2026-09-02T12:00:00.000Z",
    });
    const execute = vi.fn(async () => ({ value: "result", completionDigest: COMPLETION }));

    await expect(queue.run({
      ...SCOPE,
      workerId: "worker-1",
      retryBudget: 3,
      expiresAt: "2026-09-02T14:00:00.000Z",
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
      reconcile: async () => ({ status: "unknown" }) as never,
      execute,
      classify: () => retryDecision(),
    })).rejects.toThrow("dependency_outage_reconciliation_invalid");
    expect(execute).not.toHaveBeenCalled();
  });

  it("projects a bounded tenant-only degraded health view without operation identifiers", () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    const base = { ...SCOPE, tenantId: "tenant-a", operationId: "model-call-a" };
    queue.enqueue({
      ...base,
      retryBudget: 3,
      expiresAt: "2026-09-02T14:00:00.000Z",
      nextAttemptAt: now,
      standing: "degraded_retrying",
      authorityVersion: "authority-v1",
    });
    queue.enqueue({
      ...SCOPE,
      tenantId: "tenant-a",
      operationId: "model-call-b",
      retryBudget: 3,
      expiresAt: "2026-09-02T14:00:00.000Z",
      nextAttemptAt: now,
      standing: "degraded_retrying",
      authorityVersion: "authority-v1",
    });
    queue.enqueue({
      ...SCOPE,
      tenantId: "tenant-b",
      operationId: "private-model-call",
      retryBudget: 3,
      expiresAt: "2026-09-02T14:00:00.000Z",
      nextAttemptAt: now,
      standing: "degraded_retrying",
      authorityVersion: "authority-v1",
    });

    now = "2026-09-02T12:10:00.000Z";
    const health = queue.tenantHealth({
      tenantId: "tenant-a",
      limit: 1,
      staleAfterMs: 60_000,
      now,
    });

    expect(health).toMatchObject({
      tenantId: "tenant-a",
      standing: "degraded_retrying",
      total: 2,
      returned: 1,
      truncated: true,
      stale: 2,
    });
    expect(health.operations).toHaveLength(1);
    expect(health.operations[0]).toEqual(expect.objectContaining({
      dependencyKind: "model",
      providerId: "muse-spark",
      standing: "degraded_retrying",
      stale: true,
      lastTransition: expect.objectContaining({ kind: "enqueued" }),
      operationIdentityDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(JSON.stringify(health)).not.toContain("model-call-a");
    expect(JSON.stringify(health)).not.toContain("model-call-b");
    expect(JSON.stringify(health)).not.toContain("private-model-call");
  });

  it("rejects unbounded or malformed tenant health queries", () => {
    const queue = createDependencyOutageQueue(new DatabaseSync(":memory:"));
    expect(() => queue.tenantHealth({ tenantId: "tenant-a", limit: 0 }))
      .toThrow("dependency_outage_list_limit_invalid");
    expect(() => queue.tenantHealth({ tenantId: "tenant-a", limit: 101 }))
      .toThrow("dependency_outage_list_limit_invalid");
    expect(() => queue.tenantHealth({ tenantId: "../tenant-b", limit: 10 }))
      .toThrow("dependency_outage_tenant_invalid");
  });
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

  it("fails the lease and records a failure event when reconcile throws before execute", async () => {
    const db = new DatabaseSync(":memory:");
    const queue = createDependencyOutageQueue(db, {
      now: () => "2026-09-02T12:00:00.000Z",
    });
    const execute = vi.fn(async () => ({ value: "model-result", completionDigest: COMPLETION }));
    const operation = {
      ...SCOPE,
      workerId: "w1",
      retryBudget: 3,
      expiresAt: "2026-09-02T14:00:00.000Z",
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
      reconcile: async (): Promise<never> => {
        throw new Error("github_exact_draft_branch_diverged");
      },
      execute,
      classify: () => decisionForAction("fail"),
    };

    const result = await queue.run(operation);
    expect(result).toMatchObject({ status: "failed", decision: { action: "fail" } });
    expect(execute).not.toHaveBeenCalled();
    const record = queue.get(SCOPE);
    expect(record?.status).toBe("failed");
    expect(queue.history(SCOPE).map((event) => event.kind)).toEqual([
      "enqueued",
      "claimed",
      "failed",
    ]);
    db.close();
  });

  it("blocks an uncertain completed effect for reconciliation instead of retrying it", async () => {
    const db = new DatabaseSync(":memory:");
    const queue = createDependencyOutageQueue(db, {
      now: () => "2026-09-01T12:00:00.000Z",
    });
    const execute = vi.fn(async (): Promise<never> => {
      throw Object.assign(new Error("provider outcome unknown"), {
        remoteSideEffectUncertain: true,
      });
    });
    const operation = {
      ...SCOPE,
      workerId: "worker-1",
      retryBudget: 3,
      expiresAt: "2026-09-01T13:00:00.000Z",
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
      reconcile: async () => ({ status: "missing" as const }),
      execute,
      classify: (): DependencyOutageFailureDecision => ({
        schemaVersion: 1,
        action: "reconcile",
        failureKind: "completed",
        retryable: false,
        reason: "completed_effect_requires_reconciliation",
        nextAttemptAt: null,
        attemptsRemaining: 2,
        circuitState: "closed",
        circuit: { state: "closed", cooldownMs: 30_000, consecutiveFailures: 0 },
        standing: "recovering",
      }),
    };

    await expect(queue.run(operation)).resolves.toMatchObject({
      status: "blocked",
      record: {
        status: "blocked",
        lastFailureReason: "completed_effect_requires_reconciliation",
      },
    });
    await expect(queue.run(operation)).resolves.toMatchObject({ status: "blocked" });
    await expect(queue.run({ ...operation, authorityVersion: "model-authority-v2" }))
      .rejects.toThrow("dependency_outage_reconciliation_required");
    expect(execute).toHaveBeenCalledTimes(1);
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
            attemptsRemaining: context.retryBudget - context.attempt,
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
      authorityVersion: "model-authority-v1",
    }, "2026-09-01T12:00:00.000Z");
    const claim = queue.claim({ ...SCOPE, workerId: "worker-1", now: "2026-09-01T12:00:00.000Z", leaseMs: 1_000, authorityVersion: "model-authority-v1" })!;
    const failed = queue.fail(claim, retryDecision("2026-09-01T12:00:01.000Z", 0), "2026-09-01T12:00:00.500Z");
    expect(failed).toMatchObject({ status: "failed", standing: "degraded_failed" });
    expect(queue.claim({ ...SCOPE, workerId: "worker-2", now: "2026-09-01T12:00:02.000Z", leaseMs: 1_000, authorityVersion: "model-authority-v1" }))
      .toBeNull();
    expect(queue.claim({ ...SCOPE, tenantId: "tenant-other", workerId: "worker-2", now: "2026-09-01T12:00:02.000Z", leaseMs: 1_000, authorityVersion: "model-authority-v1" }))
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
    })).toBeNull();

    const first = queue.claim({
      ...SCOPE,
      workerId: "worker-first",
      now: "2026-09-01T12:00:00.000Z",
      leaseMs: 1_000,
      authorityVersion: "model-authority-v1",
    });
    expect(first).not.toBeNull();
    expect(queue.claim({
      ...SCOPE,
      workerId: "worker-over-budget",
      now: "2026-09-01T12:00:02.000Z",
      leaseMs: 1_000,
      authorityVersion: "model-authority-v1",
    })).toBeNull();
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
    });
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
        attemptsRemaining: 2,
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
      authorityVersion: "installation-v1",
    })).toThrow("dependency_outage_operation_digest_conflict");
    expect(() => queue.reactivateAuthority(SCOPE, {
      previousAuthorityVersion: "installation-v1",
      nextAuthorityVersion: "installation-v2",
      now: "2026-09-01T12:01:00.000Z",
    })).toThrow("dependency_outage_expired");
    db.close();
  });

  it("reconciles blocked uncertain work on replay without repeating execution", async () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    let remoteCompleted = false;
    const queue = createDependencyOutageQueue(db, { now: () => now });
    const reconcile = vi.fn(async () => remoteCompleted
      ? ({ status: "completed" as const, value: "delivered", completionDigest: COMPLETION })
      : ({ status: "missing" as const }));
    const execute = vi.fn(async (): Promise<never> => {
      remoteCompleted = true;
      throw Object.assign(new Error("response_lost"), { remoteSideEffectUncertain: true });
    });
    const operation = {
      ...SCOPE,
      workerId: "worker-1",
      retryBudget: 3,
      expiresAt: "2026-09-02T13:00:00.000Z",
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
      reconcile,
      execute,
      classify: () => decisionForAction("reconcile"),
    };

    await expect(queue.run(operation)).resolves.toMatchObject({ status: "blocked" });
    now = "2026-09-02T12:00:01.000Z";
    await expect(queue.run(operation)).resolves.toMatchObject({
      status: "recovered",
      value: "delivered",
      record: { status: "completed", completionDigest: COMPLETION },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("reconciles and terminalizes an expired lease-recovered claim", async () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    const reconcile = vi.fn(async () => ({ status: "missing" as const }));
    const execute = vi.fn(async () => ({ value: "unexpected", completionDigest: COMPLETION }));
    const operation = {
      ...SCOPE,
      workerId: "worker-recovery",
      retryBudget: 3,
      expiresAt: "2026-09-02T12:00:02.000Z",
      leaseMs: 1_000,
      authorityVersion: "model-authority-v1",
      reconcile,
      execute,
      classify: () => retryDecision(),
    };
    queue.enqueue({
      ...operation,
      nextAttemptAt: now,
      standing: "degraded_retrying",
    }, now);
    expect(queue.claim({
      ...SCOPE,
      workerId: "worker-crashed",
      now,
      leaseMs: 1_000,
      authorityVersion: "model-authority-v1",
    })).not.toBeNull();
    now = "2026-09-02T12:00:03.000Z";

    await expect(queue.run(operation)).resolves.toMatchObject({
      status: "failed",
      record: {
        status: "failed",
        lastFailureKind: "expired",
        lastFailureReason: "operation_expired",
      },
    });
    await expect(queue.run(operation)).resolves.toMatchObject({ status: "failed" });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(queue.history(SCOPE).filter((event) =>
      event.kind === "failed" && event.details.reason === "operation_expired"
    )).toHaveLength(1);
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

  it("rejects a forged history append that breaks the hash chain", () => {
    const db = new DatabaseSync(":memory:");
    const queue = createDependencyOutageQueue(db);
    queue.enqueue({
      ...SCOPE,
      retryBudget: 3,
      expiresAt: "2026-09-01T13:00:00.000Z",
      nextAttemptAt: "2026-09-01T12:00:00.000Z",
      standing: "degraded_retrying",
    }, "2026-09-01T12:00:00.000Z");

    // The append-only triggers block UPDATE and DELETE but not INSERT, so a
    // forger can still append a fabricated event. Only the hash-chain verifier
    // in history() catches it: the forged row links to a bogus previous hash and
    // carries a bogus event hash, so both chain checks must reject it.
    db.prepare(`INSERT INTO dependency_outage_history (
      tenant_id, dependency_kind, provider_id, operation_id, event_kind,
      observed_at, details_json, previous_hash, event_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      SCOPE.tenantId, SCOPE.dependencyKind, SCOPE.providerId, SCOPE.operationId,
      "completed", "2026-09-01T12:00:05.000Z", "{}", "forged-previous-hash", "forged-event-hash",
    );

    expect(() => queue.history(SCOPE)).toThrow("dependency_outage_history_chain_invalid");
    db.close();
  });

  it("scopes get() and history() to the caller's tenant across an identical scope", () => {
    const db = new DatabaseSync(":memory:");
    const queue = createDependencyOutageQueue(db, {
      now: () => "2026-09-02T12:00:00.000Z",
    });
    const shared = {
      dependencyKind: "model" as const,
      providerId: "muse-spark",
      operationId: "mission-shared:model-call-1",
      operationDigest: DIGEST,
    };
    queue.enqueue({
      ...shared,
      tenantId: "tenant-foreign",
      retryBudget: 3,
      expiresAt: "2026-09-02T14:00:00.000Z",
      nextAttemptAt: "2026-09-02T12:00:00.000Z",
      standing: "degraded_retrying",
      authorityVersion: "authority-v1",
    }, "2026-09-02T12:00:00.000Z");

    // The foreign tenant owns the only row. A byte-identical scope under a
    // different tenant must never resolve it: inspect()/get() and history() are
    // both tenant-scoped, so dropping the tenant clause would leak this record.
    expect(queue.get({ ...shared, tenantId: "tenant-foreign" })?.status).toBe("queued");
    expect(queue.get({ ...shared, tenantId: "tenant-a" })).toBeNull();
    expect(queue.history({ ...shared, tenantId: "tenant-a" })).toEqual([]);
    db.close();
  });

  it("scopes every operation mutation to the caller's tenant under a shared branch operation id", () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    // GitHub operation ids are branch-scoped, not tenant-scoped, so two tenants
    // can legitimately share one. Every UPDATE (claim, expiry-on-claim, complete,
    // fail, authority reactivation) must still be tenant-scoped: tenant A driving
    // its own row must never mutate tenant B's identically-keyed row.
    const enqueuePair = (operationId: string, expiresAt = "2026-09-02T14:00:00.000Z", nextAttemptAt = "2026-09-02T12:00:00.000Z") => {
      for (const tenantId of ["tenant-a", "tenant-b"]) {
        queue.enqueue({
          tenantId,
          dependencyKind: "scm",
          providerId: "github",
          operationId,
          operationDigest: DIGEST,
          retryBudget: 3,
          expiresAt,
          nextAttemptAt,
          standing: "degraded_retrying",
          authorityVersion: "authority-v1",
        });
      }
    };
    const foreign = (operationId: string) => queue.get({
      tenantId: "tenant-b", dependencyKind: "scm", providerId: "github", operationId, operationDigest: DIGEST,
    });
    const claimA = (operationId: string) => queue.claim({
      tenantId: "tenant-a", dependencyKind: "scm", providerId: "github", operationId, operationDigest: DIGEST,
      workerId: "w1", now, leaseMs: 30_000, authorityVersion: "authority-v1",
    });

    // Fresh claim UPDATE.
    enqueuePair("github-draft:claim");
    const beforeClaim = foreign("github-draft:claim");
    expect(claimA("github-draft:claim")).not.toBeNull();
    expect(foreign("github-draft:claim")).toEqual(beforeClaim);

    // Complete UPDATE.
    enqueuePair("github-draft:complete");
    const beforeComplete = foreign("github-draft:complete");
    const completeClaim = claimA("github-draft:complete")!;
    queue.complete(completeClaim, COMPLETION, now);
    expect(foreign("github-draft:complete")).toEqual(beforeComplete);

    // Fail UPDATE.
    enqueuePair("github-draft:fail");
    const beforeFail = foreign("github-draft:fail");
    const failClaim = claimA("github-draft:fail")!;
    queue.fail(failClaim, decisionForAction("fail"), now);
    expect(foreign("github-draft:fail")).toEqual(beforeFail);

    // Authority reactivation UPDATE: drive A to blocked/authority_change_required.
    enqueuePair("github-draft:reactivate");
    const authClaim = claimA("github-draft:reactivate")!;
    queue.fail(authClaim, decisionForAction("await_authority"), now);
    const beforeReactivate = foreign("github-draft:reactivate");
    queue.reactivateAuthority(
      { tenantId: "tenant-a", dependencyKind: "scm", providerId: "github", operationId: "github-draft:reactivate", operationDigest: DIGEST },
      { previousAuthorityVersion: "authority-v1", nextAuthorityVersion: "authority-v2", now },
    );
    expect(foreign("github-draft:reactivate")).toEqual(beforeReactivate);

    // Expiry-on-claim UPDATE: a queued but expired row is settled on claim.
    enqueuePair("github-draft:expire", "2026-09-02T12:00:30.000Z");
    now = "2026-09-02T13:00:00.000Z";
    const beforeExpire = foreign("github-draft:expire");
    expect(claimA("github-draft:expire")).toBeNull();
    expect(foreign("github-draft:expire")).toEqual(beforeExpire);
    db.close();
  });

  it("scopes the history projection and stale count to the caller's tenant", () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    const scopeFor = (tenantId: string) => ({
      tenantId, dependencyKind: "scm" as const, providerId: "github",
      operationId: "github-draft:shared", operationDigest: DIGEST,
    });
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      queue.enqueue({
        ...scopeFor(tenantId),
        retryBudget: 3,
        expiresAt: "2026-09-02T14:00:00.000Z",
        nextAttemptAt: "2026-09-02T12:00:00.000Z",
        standing: "degraded_retrying",
        authorityVersion: "authority-v1",
      });
    }
    // Both tenants share an operation id, and each has its own event chain. A
    // history query that dropped its tenant clause would interleave the two
    // chains and break hash-chain verification; it must return only A's events.
    queue.claim({ ...scopeFor("tenant-a"), workerId: "w1", now, leaseMs: 30_000, authorityVersion: "authority-v1" });
    queue.claim({ ...scopeFor("tenant-b"), workerId: "w2", now, leaseMs: 30_000, authorityVersion: "authority-v1" });
    expect(queue.history(scopeFor("tenant-a")).map((event) => event.kind)).toEqual(["enqueued", "claimed"]);
    db.close();
  });

  it("scopes the stale count to the caller's tenant", () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    // B is enqueued in the distant past (stale); A is enqueued fresh. A's stale
    // count must reflect only A's own rows, never borrow B's aged row.
    queue.enqueue({
      tenantId: "tenant-b", dependencyKind: "scm", providerId: "github",
      operationId: "github-draft:stale-b", operationDigest: DIGEST,
      retryBudget: 3, expiresAt: "2026-09-10T00:00:00.000Z",
      nextAttemptAt: "2026-09-02T12:00:00.000Z", standing: "degraded_retrying",
      authorityVersion: "authority-v1",
    });
    now = "2026-09-05T12:04:30.000Z";
    queue.enqueue({
      tenantId: "tenant-a", dependencyKind: "scm", providerId: "github",
      operationId: "github-draft:fresh-a", operationDigest: DIGEST,
      retryBudget: 3, expiresAt: "2026-09-10T00:00:00.000Z",
      nextAttemptAt: "2026-09-05T12:04:30.000Z", standing: "degraded_retrying",
      authorityVersion: "authority-v1",
    });
    const health = queue.tenantHealth({ tenantId: "tenant-a", now: "2026-09-05T12:05:00.000Z", staleAfterMs: 60_000 });
    expect(health.total).toBe(1);
    expect(health.stale).toBe(0);
    db.close();
  });

  it("rejects a forged completed event even with a correct previous hash", () => {
    const db = new DatabaseSync(":memory:");
    const queue = createDependencyOutageQueue(db);
    queue.enqueue({
      ...SCOPE,
      retryBudget: 3,
      expiresAt: "2026-09-01T13:00:00.000Z",
      nextAttemptAt: "2026-09-01T12:00:00.000Z",
      standing: "degraded_retrying",
    }, "2026-09-01T12:00:00.000Z");

    // A forger who links correctly to the last real event (correct previous_hash)
    // but cannot recompute the event hash: only the event-hash check rejects this,
    // so it pins that check independently of the chain-linkage check.
    const last = db.prepare(`SELECT event_hash FROM dependency_outage_history
      WHERE tenant_id = ? AND dependency_kind = ? AND provider_id = ? AND operation_id = ?
      ORDER BY sequence DESC LIMIT 1`)
      .get(SCOPE.tenantId, SCOPE.dependencyKind, SCOPE.providerId, SCOPE.operationId) as { event_hash: string };
    db.prepare(`INSERT INTO dependency_outage_history (
      tenant_id, dependency_kind, provider_id, operation_id, event_kind,
      observed_at, details_json, previous_hash, event_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      SCOPE.tenantId, SCOPE.dependencyKind, SCOPE.providerId, SCOPE.operationId,
      "completed", "2026-09-01T12:00:05.000Z", "{}", last.event_hash, "forged-but-well-linked-hash",
    );

    expect(() => queue.history(SCOPE)).toThrow("dependency_outage_history_chain_invalid");
    db.close();
  });

  it("fails the lease with an event when the injected decision policy throws", async () => {
    const db = new DatabaseSync(":memory:");
    const queue = createDependencyOutageQueue(db, {
      now: () => "2026-09-02T12:00:00.000Z",
    });
    const operation = {
      ...SCOPE,
      workerId: "w1",
      retryBudget: 3,
      expiresAt: "2026-09-02T14:00:00.000Z",
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
      reconcile: async () => ({ status: "missing" as const }),
      execute: async () => { throw new Error("provider exploded"); },
      classify: () => { throw new Error("decision policy backend unavailable"); },
    };

    const result = await queue.run(operation);
    // A throwing policy must still settle the lease with a terminal decision and
    // a recorded failure event, never leave the row claimed with the lease held.
    expect(result.status).toBe("failed");
    expect(queue.get(SCOPE)?.status).toBe("failed");
    expect(queue.history(SCOPE).map((event) => event.kind)).toEqual([
      "enqueued",
      "claimed",
      "failed",
    ]);
    db.close();
  });

  it("upgrades a pre-circuit-breaker operations table in place and preserves existing rows", () => {
    const db = new DatabaseSync(":memory:");
    // The pre-change production shape: the operations table before the circuit
    // breaker persistence columns (circuit_opened_at / circuit_cooldown_ms /
    // consecutive_failures) were added. Every fresh database (the queue
    // constructor and createDb both run the same CREATE, which already declares
    // those columns) skips the additive ALTER TABLE branch, so only a database
    // created by an older build reaches it. This test builds that older shape
    // directly to exercise the upgrade path that fresh-install coverage cannot.
    db.exec(`
      CREATE TABLE dependency_outage_operations (
        tenant_id TEXT NOT NULL,
        dependency_kind TEXT NOT NULL CHECK (dependency_kind IN ('model','scm','feed','registry','notification')),
        provider_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        operation_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','claimed','blocked','failed','completed')),
        standing TEXT NOT NULL CHECK (standing IN ('healthy','degraded_retrying','degraded_blocked','degraded_failed','recovering')),
        circuit_state TEXT NOT NULL CHECK (circuit_state IN ('closed','open','half_open')),
        retry_budget INTEGER NOT NULL CHECK (retry_budget > 0),
        attempts_consumed INTEGER NOT NULL DEFAULT 0 CHECK (attempts_consumed >= 0),
        next_attempt_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        authority_version TEXT,
        claim_owner TEXT,
        claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
        claim_expires_at TEXT,
        completion_digest TEXT,
        last_failure_kind TEXT,
        last_failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, dependency_kind, provider_id, operation_id)
      ) STRICT;
    `);
    db.prepare(`INSERT INTO dependency_outage_operations (
      tenant_id, dependency_kind, provider_id, operation_id, operation_digest,
      status, standing, circuit_state, retry_budget, attempts_consumed,
      next_attempt_at, expires_at, authority_version, claim_generation,
      created_at, updated_at
    ) VALUES ('tenant-legacy','model','muse-spark','legacy:op-1',?,'queued','degraded_retrying',
      'closed',3,0,'2026-09-02T12:01:00.000Z','2026-09-02T14:00:00.000Z','authority-v1',0,
      '2026-09-02T12:00:00.000Z','2026-09-02T12:00:00.000Z')`).run(DIGEST);

    // Booting the queue runs ensureSchema, which must ALTER the existing table.
    const queue = createDependencyOutageQueue(db, { now: () => "2026-09-02T12:02:00.000Z" });

    const columns = new Set((db.prepare("PRAGMA table_info(dependency_outage_operations)").all() as
      Array<{ name: string }>).map((column) => column.name));
    expect(columns.has("circuit_opened_at")).toBe(true);
    expect(columns.has("circuit_cooldown_ms")).toBe(true);
    expect(columns.has("consecutive_failures")).toBe(true);

    // The legacy row survives with sane circuit-breaker defaults.
    const legacy = queue.get({
      tenantId: "tenant-legacy",
      dependencyKind: "model",
      providerId: "muse-spark",
      operationId: "legacy:op-1",
      operationDigest: DIGEST,
    });
    expect(legacy).toMatchObject({
      status: "queued",
      circuitState: "closed",
      circuitCooldownMs: 30_000,
      consecutiveFailures: 0,
      circuitOpenedAt: null,
    });

    // A write through the upgraded table succeeds: the INSERT names the new
    // columns, so it would fail against the pre-change shape.
    const enqueued = queue.enqueue({
      ...SCOPE,
      tenantId: "tenant-upgraded",
      operationId: "upgraded:op-2",
      retryBudget: 3,
      expiresAt: "2026-09-02T14:00:00.000Z",
      nextAttemptAt: "2026-09-02T12:03:00.000Z",
      standing: "degraded_retrying",
      authorityVersion: "authority-v1",
    });
    expect(enqueued).toMatchObject({ status: "queued", circuitCooldownMs: 30_000, consecutiveFailures: 0 });
    db.close();
  });


  it("reopens an operation_expired failed row for a fresh retry window (queued, attempts reset, reopened event)", () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    queue.enqueue({
      ...SCOPE,
      retryBudget: 3,
      expiresAt: "2026-09-02T12:00:01.000Z",
      nextAttemptAt: now,
      standing: "degraded_retrying",
      authorityVersion: "model-authority-v1",
    }, now);
    now = "2026-09-02T12:00:05.000Z";
    // Past expiry, the claim fails the operation terminally with operation_expired.
    expect(queue.claim({ ...SCOPE, workerId: "worker-1", now, leaseMs: 30_000, authorityVersion: "model-authority-v1" })).toBeNull();
    expect(queue.get(SCOPE)).toMatchObject({ status: "failed", lastFailureReason: "operation_expired" });
    // expiresAt/retryBudget are a retry window, not a deadline: reopen gives a fresh one.
    const result = queue.reopen(SCOPE, { reason: "operation_expired", expiresAt: "2026-09-02T13:00:05.000Z", now });
    expect(result).toMatchObject({
      reopened: true,
      record: { status: "queued", attemptsConsumed: 0, circuitState: "half_open", expiresAt: "2026-09-02T13:00:05.000Z" },
    });
    expect(queue.history(SCOPE).at(-1)).toMatchObject({
      kind: "reopened",
      details: { previousReason: "operation_expired", reopenReason: "operation_expired", reopenCount: 1 },
    });
    db.close();
  });

  it("never auto-reopens a permanent failure", () => {
    const db = new DatabaseSync(":memory:");
    const now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    queue.enqueue({
      ...SCOPE,
      retryBudget: 3,
      expiresAt: "2026-09-02T14:00:00.000Z",
      nextAttemptAt: now,
      standing: "degraded_retrying",
      authorityVersion: "model-authority-v1",
    }, now);
    const claim = queue.claim({ ...SCOPE, workerId: "worker-1", now, leaseMs: 30_000, authorityVersion: "model-authority-v1" })!;
    queue.fail(claim, decisionForAction("fail"), "2026-09-02T12:00:01.000Z");
    expect(queue.get(SCOPE)).toMatchObject({ status: "failed", lastFailureReason: "permanent_failure" });
    // Even an operator retry may not reopen a permanent failure.
    expect(queue.reopen(SCOPE, { reason: "operator_retry", expiresAt: "2026-09-02T13:00:00.000Z", now: "2026-09-02T12:00:02.000Z" }))
      .toEqual({ reopened: false, reason: "operation_permanent" });
    db.close();
  });

  it("refuses to reopen a queued row, refuses a mismatched auto reason, but an operator retry reopens a non-permanent failure", () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    queue.enqueue({
      ...SCOPE,
      retryBudget: 3,
      expiresAt: "2026-09-02T12:00:01.000Z",
      nextAttemptAt: now,
      standing: "degraded_retrying",
      authorityVersion: "model-authority-v1",
    }, now);
    // A queued row is not reopenable.
    expect(queue.reopen(SCOPE, { reason: "operator_retry", expiresAt: "2026-09-02T13:00:00.000Z", now }))
      .toEqual({ reopened: false, reason: "operation_not_failed" });
    // Fail it with operation_expired; a mismatched auto reason is refused.
    now = "2026-09-02T12:00:05.000Z";
    queue.claim({ ...SCOPE, workerId: "worker-1", now, leaseMs: 30_000, authorityVersion: "model-authority-v1" });
    expect(queue.reopen(SCOPE, { reason: "retry_budget_exhausted", expiresAt: "2026-09-02T13:00:05.000Z", now }))
      .toEqual({ reopened: false, reason: "reason_not_reopenable" });
    // But an operator retry reopens the same non-permanent failed row.
    expect(queue.reopen(SCOPE, { reason: "operator_retry", expiresAt: "2026-09-02T13:00:05.000Z", now }))
      .toMatchObject({ reopened: true });
    db.close();
  });

  it("reports a missing operation as not reopened and scopes reopen to the caller's tenant", () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    queue.enqueue({
      ...SCOPE,
      retryBudget: 3,
      expiresAt: "2026-09-02T12:00:01.000Z",
      nextAttemptAt: now,
      standing: "degraded_retrying",
      authorityVersion: "model-authority-v1",
    }, now);
    now = "2026-09-02T12:00:05.000Z";
    queue.claim({ ...SCOPE, workerId: "worker-1", now, leaseMs: 30_000, authorityVersion: "model-authority-v1" });
    // A foreign tenant with the same operation id cannot see or reopen the row.
    expect(queue.reopen({ ...SCOPE, tenantId: "tenant-evil" }, { reason: "operation_expired", expiresAt: "2026-09-02T13:00:05.000Z", now }))
      .toEqual({ reopened: false, reason: "operation_missing" });
    expect(queue.reopen(SCOPE, { reason: "operation_expired", expiresAt: "2026-09-02T13:00:05.000Z", now }))
      .toMatchObject({ reopened: true });
    db.close();
  });

  it("adoptive run() reopens a failed-expired operation and delivers (liveness past the retry window)", async () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    const makeOp = (execute: () => Promise<Readonly<{ value: unknown; completionDigest: string }>>) => ({
      ...SCOPE,
      adoptive: true as const,
      workerId: "worker-1",
      retryBudget: 5,
      // A fresh window is computed each attempt, exactly like deliverAdoptiveDraft.
      expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
      reconcile: async () => ({ status: "missing" as const }),
      execute,
      classify: (_error: unknown, context: { attempt: number; retryBudget: number }) =>
        decisionForAction("retry", Math.max(0, context.retryBudget - context.attempt)),
    });
    const failTransient = async (): Promise<never> => { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); };
    // Attempt 1 defers (transient); the operation is queued.
    expect((await queue.run(makeOp(failTransient))).status).toBe("deferred");
    // Advance past the retry window: the next run fails it terminally (expired).
    now = "2026-09-02T14:00:00.000Z";
    expect((await queue.run(makeOp(failTransient))).status).toBe("failed");
    expect(queue.get(SCOPE)).toMatchObject({ status: "failed", lastFailureReason: "operation_expired" });
    // A later run REOPENS the expired operation and delivers — expiry is not terminal.
    const delivered = await queue.run(makeOp(async () => ({ value: { pr: 1 }, completionDigest: COMPLETION })));
    expect(delivered).toMatchObject({ status: "completed" });
    expect(queue.history(SCOPE).some((event) => event.kind === "reopened")).toBe(true);
    db.close();
  });

  it("adoptive run() returns {completed, fenced:true} when the claim is lost mid-flight but execute delivered", async () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    const result = await queue.run({
      ...SCOPE,
      adoptive: true as const,
      workerId: "worker-1",
      retryBudget: 5,
      expiresAt: "2026-09-02T13:00:00.000Z",
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
      reconcile: async () => ({ status: "missing" as const }),
      execute: async () => {
        // The lease expires and worker 2 reclaims the operation mid-delivery, so
        // worker 1's claim is fenced out — but its execute still delivered.
        now = "2026-09-02T12:00:40.000Z";
        queue.claim({ ...SCOPE, workerId: "worker-2", now, leaseMs: 30_000, authorityVersion: "model-authority-v1" });
        return { value: { pr: 7 }, completionDigest: COMPLETION };
      },
      classify: () => decisionForAction("retry"),
    });
    // Fenced success: completed with the delivered value, never a fence-lost throw.
    expect(result).toMatchObject({ status: "completed", fenced: true });
    db.close();
  });

  it("E: a fenced-but-successful worker settles a row another worker already failed", async () => {
    const db = new DatabaseSync(":memory:");
    let now = "2026-09-02T12:00:00.000Z";
    const queue = createDependencyOutageQueue(db, { now: () => now });
    const result = await queue.run({
      ...SCOPE,
      adoptive: true as const,
      workerId: "worker-1",
      retryBudget: 5,
      expiresAt: "2026-09-02T13:00:00.000Z",
      leaseMs: 30_000,
      authorityVersion: "model-authority-v1",
      reconcile: async () => ({ status: "missing" as const }),
      execute: async () => {
        // Worker 1's lease expires; worker 2 reclaims and FAILS the row before
        // worker 1's (successful) delivery returns.
        now = "2026-09-02T12:00:40.000Z";
        const c2 = queue.claim({ ...SCOPE, workerId: "worker-2", now, leaseMs: 30_000, authorityVersion: "model-authority-v1" })!;
        queue.fail(c2, decisionForAction("fail", 3), now);
        return { value: { pr: 7 }, completionDigest: COMPLETION };
      },
      classify: () => decisionForAction("retry"),
    });
    expect(result).toMatchObject({ status: "completed", fenced: true });
    // The row must be settled completed/healthy, not left failed/degraded_failed.
    expect(queue.get(SCOPE)).toMatchObject({ status: "completed", standing: "healthy", completionDigest: COMPLETION });
    db.close();
  });
});
