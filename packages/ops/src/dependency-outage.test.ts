import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertDependencyOutageScope,
  classifyDependencyOutage,
  DEPENDENCY_OUTAGE_SCHEMA_VERSION,
} from "./dependency-outage.js";

const DIGEST = "a".repeat(64);
const NOW = "2026-09-01T12:00:00.000Z";
const EXPIRES = "2026-09-01T13:00:00.000Z";

function failure(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-acme",
    dependencyKind: "model" as const,
    providerId: "muse-spark",
    operationDigest: DIGEST,
    failureKind: "transient" as const,
    attempt: 1,
    retryBudget: 3,
    now: NOW,
    expiresAt: EXPIRES,
    ...overrides,
  };
}

describe("dependency outage decision", () => {
  it("bounds transient retries and returns a deterministic delayed retry", () => {
    const first = classifyDependencyOutage(failure());
    const replay = classifyDependencyOutage(failure());
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      schemaVersion: DEPENDENCY_OUTAGE_SCHEMA_VERSION,
      action: "retry",
      retryable: true,
      attemptsRemaining: 2,
      circuitState: "closed",
      standing: "degraded_retrying",
    });
    expect(Date.parse(first.nextAttemptAt!)).toBeGreaterThan(Date.parse(NOW));

    expect(classifyDependencyOutage(failure({ attempt: 3 }))).toMatchObject({
      action: "fail",
      retryable: false,
      reason: "retry_budget_exhausted",
      attemptsRemaining: 0,
      standing: "degraded_failed",
    });
  });

  it("distinguishes throttling, an open circuit, and a half-open recovery probe", () => {
    expect(classifyDependencyOutage(failure({
      failureKind: "throttled",
      retryAfterMs: 45_000,
    })).nextAttemptAt).toBe("2026-09-01T12:00:45.000Z");

    expect(classifyDependencyOutage(failure({
      circuit: {
        state: "open",
        openedAt: "2026-09-01T11:59:50.000Z",
        cooldownMs: 30_000,
        consecutiveFailures: 4,
      },
    }))).toMatchObject({
      action: "wait",
      retryable: true,
      circuitState: "open",
      nextAttemptAt: "2026-09-01T12:00:20.000Z",
    });

    expect(classifyDependencyOutage(failure({
      now: "2026-09-01T12:00:21.000Z",
      circuit: {
        state: "open",
        openedAt: "2026-09-01T11:59:50.000Z",
        cooldownMs: 30_000,
        consecutiveFailures: 4,
      },
    }))).toMatchObject({
      action: "retry",
      retryable: true,
      circuitState: "half_open",
      reason: "half_open_probe",
      circuit: {
        state: "half_open",
        openedAt: "2026-09-01T11:59:50.000Z",
        cooldownMs: 30_000,
        consecutiveFailures: 4,
      },
    });
  });

  it("carries the complete circuit snapshot through three failures and a half-open failure", () => {
    const first = classifyDependencyOutage(failure({
      retryBudget: 6,
      circuit: { state: "closed", cooldownMs: 30_000, consecutiveFailures: 0 },
    }));
    expect(first.circuit).toEqual({
      state: "closed",
      cooldownMs: 30_000,
      consecutiveFailures: 1,
    });

    const second = classifyDependencyOutage(failure({
      attempt: 2,
      retryBudget: 6,
      now: "2026-09-01T12:00:02.000Z",
      circuit: first.circuit,
    }));
    expect(second.circuit).toEqual({
      state: "closed",
      cooldownMs: 30_000,
      consecutiveFailures: 2,
    });

    const third = classifyDependencyOutage(failure({
      attempt: 3,
      retryBudget: 6,
      now: "2026-09-01T12:00:04.000Z",
      circuit: second.circuit,
    }));
    expect(third).toMatchObject({ action: "wait", circuitState: "open" });
    expect(third.circuit).toEqual({
      state: "open",
      openedAt: "2026-09-01T12:00:04.000Z",
      cooldownMs: 30_000,
      consecutiveFailures: 3,
    });

    const probe = classifyDependencyOutage(failure({
      attempt: 4,
      retryBudget: 6,
      now: "2026-09-01T12:00:34.000Z",
      circuit: third.circuit,
    }));
    expect(probe.circuit).toEqual({
      state: "half_open",
      openedAt: "2026-09-01T12:00:04.000Z",
      cooldownMs: 30_000,
      consecutiveFailures: 3,
    });

    const reopened = classifyDependencyOutage(failure({
      attempt: 4,
      retryBudget: 6,
      now: "2026-09-01T12:00:34.000Z",
      circuit: probe.circuit,
    }));
    expect(reopened.circuit).toEqual({
      state: "open",
      openedAt: "2026-09-01T12:00:34.000Z",
      cooldownMs: 30_000,
      consecutiveFailures: 4,
    });
  });

  it("never retries denial, expiry, permanent failure, or a completed effect", () => {
    for (const failureKind of ["authentication", "permission"] as const) {
      expect(classifyDependencyOutage(failure({ failureKind }))).toMatchObject({
        action: "await_authority",
        retryable: false,
        standing: "degraded_blocked",
      });
    }
    expect(classifyDependencyOutage(failure({ failureKind: "permanent" }))).toMatchObject({
      action: "fail",
      retryable: false,
      standing: "degraded_failed",
    });
    expect(classifyDependencyOutage(failure({
      now: EXPIRES,
      failureKind: "transient",
    }))).toMatchObject({
      action: "fail",
      reason: "operation_expired",
    });
    expect(classifyDependencyOutage(failure({ failureKind: "completed" }))).toMatchObject({
      action: "reconcile",
      retryable: false,
      standing: "recovering",
    });
  });

  it("fails closed on malformed scope and cross-tenant recovery", () => {
    expect(() => classifyDependencyOutage(failure({ tenantId: "" })))
      .toThrow("dependency_outage_tenant_invalid");
    expect(() => classifyDependencyOutage(failure({ operationDigest: "not-a-digest" })))
      .toThrow("dependency_outage_digest_invalid");
    expect(() => classifyDependencyOutage(failure({
      failureKind: "quota_exhausted_forever",
    }) as never)).toThrow("dependency_outage_failure_kind_invalid");
    expect(() => assertDependencyOutageScope(
      { tenantId: "tenant-acme", dependencyKind: "model", providerId: "muse-spark" },
      { tenantId: "tenant-other", dependencyKind: "model", providerId: "muse-spark" },
    )).toThrow("dependency_outage_scope_mismatch");
  });

  it("keeps every version-one failure kind explicit", () => {
    const supported = [
      "timeout",
      "throttled",
      "transient",
      "invalid_response",
      "authentication",
      "permission",
      "permanent",
      "expired",
      "completed",
    ] as const;
    expect(supported.map((failureKind) =>
      classifyDependencyOutage(failure({ failureKind })).failureKind
    )).toEqual(supported);
  });
});

describe("dependency inversion architecture", () => {
  it("keeps the package dependency graph acyclic while model and SCM use injected ports", () => {
    const packagesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const names = ["agent", "db", "github", "ops"] as const;
    const manifests = new Map(names.map((name) => {
      const manifest = JSON.parse(readFileSync(resolve(packagesRoot, name, "package.json"), "utf8")) as {
        name: string;
        dependencies?: Record<string, string>;
      };
      return [manifest.name, Object.keys(manifest.dependencies ?? {})
        .filter((dependency) => dependency.startsWith("@mendpoint/"))];
    }));
    const visit = (name: string, path: readonly string[]): void => {
      if (path.includes(name)) throw new Error(`package_dependency_cycle:${[...path, name].join("->")}`);
      for (const dependency of manifests.get(name) ?? []) {
        if (manifests.has(dependency)) visit(dependency, [...path, name]);
      }
    };
    for (const name of manifests.keys()) visit(name, []);
    expect(manifests.get("@mendpoint/agent")).not.toContain("@mendpoint/ops");
    expect(manifests.get("@mendpoint/github")).not.toContain("@mendpoint/db");
    expect(manifests.get("@mendpoint/github")).not.toContain("@mendpoint/ops");
  });
});
