import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  estimateRunMcuMicros,
  getUsageSummary,
  insertTenant,
  provisionEntitlementForPlan,
  releaseRunUsage,
  reserveRunUsage,
  RUN_MCU_ESTIMATE,
  settleRunUsage,
} from "./index.js";

const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];
const now = "2026-08-01T00:00:00.000Z";

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close?.();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-usage-run-"));
  dirs.push(dir);
  const db = createDb(join(dir, "usage-run.sqlite"));
  dbs.push(db);
  insertTenant(db, { id: "tenant-a", slug: "tenant-a", name: "Tenant A", createdAt: now });
  provisionEntitlementForPlan(db, {
    tenantId: "tenant-a",
    plan: "pro",
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-09-01T00:00:00.000Z",
    seats: 1,
    now,
  });
  return db;
}

describe("run-lifecycle usage helpers", () => {
  it("computes a deterministic estimate from declared scope", () => {
    expect(estimateRunMcuMicros({ targetCount: 2 })).toBe(
      RUN_MCU_ESTIMATE.baseMcuMicros + RUN_MCU_ESTIMATE.perTargetMcuMicros * 2,
    );
    // Same input -> same output; floors at one target; clamps at the ceiling.
    expect(estimateRunMcuMicros({ targetCount: 2 })).toBe(estimateRunMcuMicros({ targetCount: 2 }));
    expect(estimateRunMcuMicros({ targetCount: 0 })).toBe(
      RUN_MCU_ESTIMATE.baseMcuMicros + RUN_MCU_ESTIMATE.perTargetMcuMicros,
    );
    expect(estimateRunMcuMicros({ targetCount: 10_000 })).toBe(
      RUN_MCU_ESTIMATE.baseMcuMicros + RUN_MCU_ESTIMATE.perTargetMcuMicros * RUN_MCU_ESTIMATE.maxTargets,
    );
  });

  it("reserves at admission then settles to the measured actual on success", () => {
    const db = setup();
    const reservation = reserveRunUsage(db, {
      tenantId: "tenant-a",
      runId: "run-success",
      mcuMicros: estimateRunMcuMicros({ targetCount: 2 }),
      reason: "run admission",
      createdAt: now,
    });
    expect(reservation.taskId).toBe("run-success");
    expect(reservation.reservedMcuMicrosDelta).toBe(3_000_000);
    expect(getUsageSummary(db, "tenant-a", now).reservedMcuMicros).toBe(3_000_000);

    const settlement = settleRunUsage(db, {
      tenantId: "tenant-a",
      reservationId: reservation.id,
      actualMcuMicros: 2_000_000,
      reason: "run completed",
      createdAt: "2026-08-01T00:05:00.000Z",
    });
    // Idempotent replay of the same settlement returns the same entry.
    expect(
      settleRunUsage(db, {
        tenantId: "tenant-a",
        reservationId: reservation.id,
        actualMcuMicros: 2_000_000,
        reason: "run completed",
        createdAt: "2026-08-01T00:05:00.000Z",
      }),
    ).toEqual(settlement);
    const summary = getUsageSummary(db, "tenant-a", now);
    expect(summary.reservedMcuMicros).toBe(0);
    expect(summary.consumedMcuMicros).toBe(2_000_000);
  });

  it("releases the hold on failure so a failed run burns no quota", () => {
    const db = setup();
    const reservation = reserveRunUsage(db, {
      tenantId: "tenant-a",
      runId: "run-failure",
      mcuMicros: estimateRunMcuMicros({ targetCount: 4 }),
      reason: "run admission",
      createdAt: now,
    });
    expect(getUsageSummary(db, "tenant-a", now).reservedMcuMicros).toBe(5_000_000);

    const release = releaseRunUsage(db, {
      tenantId: "tenant-a",
      reservationId: reservation.id,
      reason: "run failed",
      createdAt: "2026-08-01T00:05:00.000Z",
    });
    expect(
      releaseRunUsage(db, {
        tenantId: "tenant-a",
        reservationId: reservation.id,
        reason: "run failed",
        createdAt: "2026-08-01T00:05:00.000Z",
      }),
    ).toEqual(release);
    const summary = getUsageSummary(db, "tenant-a", now);
    expect(summary.reservedMcuMicros).toBe(0);
    expect(summary.consumedMcuMicros).toBe(0);
  });
});
