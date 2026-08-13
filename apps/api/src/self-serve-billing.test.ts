import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDb,
  getActiveUsageEntitlement,
  getUsageSummary,
  insertTenant,
  listUsageLedger,
  provisionEntitlementForPlan,
  reserveRunUsage,
  settleRunUsage,
  type AppDb,
} from "@mendpoint/db";
import {
  SELF_SERVE_BILLING_FLAG,
  computeFanoutRunMcuMicros,
  resolveFanoutSettlementMcuMicros,
  type FanoutRunMeterSignals,
} from "@mendpoint/platform";
import { afterEach, describe, expect, it } from "vitest";
import {
  billingPlanChangeDecision,
  monthlyBillingPeriod,
  selfServePlanChangeDecision,
} from "./billing-plan-control.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];
const NOW = "2026-08-13T12:00:00.000Z";
const ON = { [SELF_SERVE_BILLING_FLAG]: "1" } as unknown as NodeJS.ProcessEnv;
const OFF = {} as unknown as NodeJS.ProcessEnv;
const MCU = 1_000_000;

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup(seatLimit = 2): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-self-serve-"));
  dirs.push(dir);
  const db = createDb(join(dir, "self-serve.sqlite"));
  dbs.push(db);
  insertTenant(db, {
    id: "tenant-a",
    slug: "tenant-a",
    name: "Tenant A",
    seatLimit,
    createdAt: NOW,
  });
  return db;
}

/** Mirror of the /tenants/:id/plan self-serve branch: switch plan -> provision quota. */
function provisionSelfServe(db: AppDb, plan: string, seats: number) {
  const period = monthlyBillingPeriod(NOW);
  return provisionEntitlementForPlan(db, {
    tenantId: "tenant-a",
    plan,
    periodStart: period.start,
    periodEnd: period.end,
    seats,
    now: NOW,
  });
}

describe("self-serve plan change control", () => {
  it("owner/admin are allowed self-serve; non-privileged roles are forbidden", () => {
    expect(selfServePlanChangeDecision("owner")).toEqual({ allowed: true, mode: "self_serve" });
    expect(selfServePlanChangeDecision("admin")).toEqual({ allowed: true, mode: "self_serve" });
    expect(selfServePlanChangeDecision("viewer")).toEqual({
      allowed: false,
      error: "billing_plan_change_forbidden",
      status: 403,
    });
  });

  it("flag OFF keeps the manual-contract gate byte-identical", () => {
    // With the self-serve flag unset, the route falls back to the manual-contract
    // decision, which still fails closed until finance enables it.
    expect(billingPlanChangeDecision("owner", OFF)).toEqual({
      allowed: false,
      error: "billing_plan_change_disabled",
      status: 503,
    });
  });

  it("computes the current UTC monthly billing period", () => {
    expect(monthlyBillingPeriod(NOW)).toEqual({
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-09-01T00:00:00.000Z",
    });
  });
});

describe("self-serve plan select grants the plan's MCU quota", () => {
  it("provisions a flat Free entitlement (15 MCU)", () => {
    const db = setup();
    provisionSelfServe(db, "free", 2);
    const summary = getUsageSummary(db, "tenant-a", NOW);
    expect(summary.entitlement?.quotaMcuMicros).toBe(15 * MCU);
    expect(summary.availableMcuMicros).toBe(15 * MCU);
  });

  it("provisions a per-seat Pro entitlement (150 MCU/seat)", () => {
    const db = setup(2);
    const entitlement = provisionSelfServe(db, "pro", 2);
    expect(entitlement.quotaMcuMicros).toBe(300 * MCU); // 150 MCU * 2 seats
    expect(getActiveUsageEntitlement(db, "tenant-a", NOW)?.quotaMcuMicros).toBe(300 * MCU);
  });

  it("is idempotent for the same (tenant, plan, period)", () => {
    const db = setup();
    const first = provisionSelfServe(db, "free", 2);
    const second = provisionSelfServe(db, "free", 2);
    expect(second.id).toBe(first.id);
  });
});

describe("server-computed MCU metered against the entitlement (not client-declared)", () => {
  const realSignals: FanoutRunMeterSignals = {
    surfaces: 4,
    findings: 6,
    candidates: 9,
    confirmed: 3,
    edits: 2,
  };
  const reservedEstimate = 4 * MCU; // Wave C admission hold for targetCount 3

  it("settles the computed real-work amount when the flag is on", () => {
    const db = setup();
    provisionSelfServe(db, "free", 2); // 15 MCU
    const reservation = reserveRunUsage(db, {
      tenantId: "tenant-a",
      runId: "run-metered",
      mcuMicros: reservedEstimate,
      reason: "run admission",
      createdAt: NOW,
    });
    const settlementAmount = resolveFanoutSettlementMcuMicros({
      reservedMcuMicros: reservedEstimate,
      signals: realSignals,
      env: ON,
    });
    // The metered amount is derived from real work, not the client/reserved figure.
    expect(settlementAmount).toBe(computeFanoutRunMcuMicros(realSignals));
    expect(settlementAmount).toBe(1 * MCU);
    expect(settlementAmount).not.toBe(reservedEstimate);

    settleRunUsage(db, {
      tenantId: "tenant-a",
      reservationId: reservation.id,
      actualMcuMicros: settlementAmount,
      reason: "run completed",
      createdAt: NOW,
    });

    const summary = getUsageSummary(db, "tenant-a", NOW);
    expect(summary.consumedMcuMicros).toBe(1 * MCU); // computed, not 4 MCU
    expect(summary.reservedMcuMicros).toBe(0); // hold released on settle
    expect(summary.availableMcuMicros).toBe(14 * MCU);
  });

  it("flag OFF settles to the reserved estimate (byte-identical Wave C path)", () => {
    const db = setup();
    provisionSelfServe(db, "free", 2);
    const reservation = reserveRunUsage(db, {
      tenantId: "tenant-a",
      runId: "run-legacy",
      mcuMicros: reservedEstimate,
      reason: "run admission",
      createdAt: NOW,
    });
    const settlementAmount = resolveFanoutSettlementMcuMicros({
      reservedMcuMicros: reservedEstimate,
      signals: realSignals,
      env: OFF,
    });
    expect(settlementAmount).toBe(reservedEstimate);
    settleRunUsage(db, {
      tenantId: "tenant-a",
      reservationId: reservation.id,
      actualMcuMicros: settlementAmount,
      reason: "run completed",
      createdAt: NOW,
    });
    expect(getUsageSummary(db, "tenant-a", NOW).consumedMcuMicros).toBe(reservedEstimate);
  });
});

describe("MCU/cost quota cap", () => {
  it("rejects an over-quota run with usage_quota_exceeded", () => {
    const db = setup();
    provisionSelfServe(db, "free", 2); // 15 MCU
    expect(() =>
      reserveRunUsage(db, {
        tenantId: "tenant-a",
        runId: "run-over",
        mcuMicros: 16 * MCU, // exceeds the 15 MCU entitlement
        reason: "run admission",
        createdAt: NOW,
      }),
    ).toThrow("usage_quota_exceeded");
    // Nothing was reserved.
    expect(listUsageLedger(db, "tenant-a")).toHaveLength(0);
  });

  it("rejects a run for a tenant with no provisioned plan", () => {
    const db = setup();
    expect(() =>
      reserveRunUsage(db, {
        tenantId: "tenant-a",
        runId: "run-noplan",
        mcuMicros: 1 * MCU,
        reason: "run admission",
        createdAt: NOW,
      }),
    ).toThrow("usage_entitlement_required");
  });
});
