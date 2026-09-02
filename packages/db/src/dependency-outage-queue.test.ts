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

function decisionForAction(
  action: DependencyOutageFailureDecision["action"],
): DependencyOutageFailureDecision {
  const base = retryDecision("2026-09-02T12:00:01.000Z");
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
    ["completed reconciliation", decisionForAction("reconcile"), "blocked", "completed_effect_requires_reconciliation"],
    ["authentication recovery", decisionForAction("await_authority"), "blocked", "authority_change_required"],
    ["permission recovery", { ...decisionForAction("await_authority"), failureKind: "permission" }, "blocked", "authority_change_required"],
    ["transient retry", decisionForAction("retry"), "failed", "retry_budget_exhausted"],
    ["throttle wait", { ...decisionForAction("wait"), failureKind: "throttled", reason: "provider_throttled" }, "failed", "retry_budget_exhausted"],
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
    const failed = queue.fail(claim, retryDecision(), "2026-09-01T12:00:00.500Z");
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
