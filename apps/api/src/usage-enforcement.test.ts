import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDb,
  getUsageSummary,
  insertTenant,
  listUsageLedger,
  provisionEntitlementForPlan,
  type AppDb,
} from "@mendpoint/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitRunUsage,
  estimateRunMcuMicros,
  usageEnforcementEnabled,
} from "./usage-enforcement.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];
const now = "2026-08-01T00:00:00.000Z";
const ON = { MENDPOINT_USAGE_ENFORCEMENT: "1" } as unknown as NodeJS.ProcessEnv;
const OFF = {} as unknown as NodeJS.ProcessEnv;

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup(provision = true) {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-usage-enforce-"));
  dirs.push(dir);
  const db = createDb(join(dir, "enforce.sqlite"));
  dbs.push(db);
  insertTenant(db, { id: "tenant-a", slug: "tenant-a", name: "Tenant A", createdAt: now });
  if (provision) {
    provisionEntitlementForPlan(db, {
      tenantId: "tenant-a",
      plan: "free", // flat 15 MCU
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
      now,
    });
  }
  return db;
}

describe("run-admission usage enforcement", () => {
  it("is a no-op when the flag is off (legacy path unchanged)", () => {
    const db = setup();
    expect(usageEnforcementEnabled(OFF)).toBe(false);
    const decision = admitRunUsage(db, {
      tenantId: "tenant-a",
      runId: "run-off",
      mcuMicros: estimateRunMcuMicros({ targetCount: 3 }),
      reason: "run admission",
      createdAt: now,
      env: OFF,
    });
    expect(decision).toEqual({ enforced: false });
    // Nothing was reserved: the ledger is untouched.
    expect(listUsageLedger(db, "tenant-a")).toHaveLength(0);
    expect(getUsageSummary(db, "tenant-a", now).reservedMcuMicros).toBe(0);
  });

  it("reserves the run estimate when the flag is on", () => {
    const db = setup();
    const decision = admitRunUsage(db, {
      tenantId: "tenant-a",
      runId: "run-on",
      mcuMicros: estimateRunMcuMicros({ targetCount: 3 }),
      reason: "run admission",
      createdAt: now,
      env: ON,
    });
    expect(decision).toMatchObject({ enforced: true, admitted: true, reservedMcuMicros: 4_000_000 });
    if (decision.enforced && decision.admitted) {
      expect(decision.reservationId).toBeTruthy();
    }
    expect(getUsageSummary(db, "tenant-a", now).reservedMcuMicros).toBe(4_000_000);
  });

  it("rejects with 402 usage_quota_exceeded when the hold exceeds quota", () => {
    const db = setup();
    const decision = admitRunUsage(db, {
      tenantId: "tenant-a",
      runId: "run-over",
      mcuMicros: 16_000_000, // > 15 MCU Free quota
      reason: "run admission",
      createdAt: now,
      env: ON,
    });
    expect(decision).toMatchObject({
      enforced: true,
      admitted: false,
      status: 402,
      body: { error: "usage_quota_exceeded" },
    });
    if (decision.enforced && !decision.admitted) {
      expect(decision.body.summary.availableMcuMicros).toBe(15_000_000);
    }
    // Rejected admission reserves nothing.
    expect(getUsageSummary(db, "tenant-a", now).reservedMcuMicros).toBe(0);
  });

  it("rejects with 402 usage_entitlement_required when the tenant has no plan", () => {
    const db = setup(false); // tenant exists but no entitlement provisioned
    const decision = admitRunUsage(db, {
      tenantId: "tenant-a",
      runId: "run-noplan",
      mcuMicros: estimateRunMcuMicros({ targetCount: 1 }),
      reason: "run admission",
      createdAt: now,
      env: ON,
    });
    expect(decision).toMatchObject({
      enforced: true,
      admitted: false,
      status: 402,
      body: { error: "usage_entitlement_required" },
    });
    if (decision.enforced && !decision.admitted) {
      expect(decision.body.summary.entitlement).toBeNull();
    }
  });
});
