import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  getActiveUsageEntitlement,
  insertTenant,
  provisionEntitlementForPlan,
  resolvePlanQuotaMcuMicros,
  USAGE_PLAN_CATALOG,
} from "./index.js";

const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];
const now = "2026-08-01T00:00:00.000Z";
const periodStart = "2026-08-01T00:00:00.000Z";
const periodEnd = "2026-09-01T00:00:00.000Z";

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close?.();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-usage-plan-"));
  dirs.push(dir);
  const db = createDb(join(dir, "usage-plan.sqlite"));
  dbs.push(db);
  insertTenant(db, {
    id: "tenant-a",
    slug: "tenant-a",
    name: "Tenant A",
    createdAt: now,
  });
  return db;
}

describe("plan -> entitlement provisioning", () => {
  it("provisions Pro as 150 MCU/seat/month and is idempotent on re-run", () => {
    const db = setup();
    const first = provisionEntitlementForPlan(db, {
      tenantId: "tenant-a",
      plan: "pro",
      periodStart,
      periodEnd,
      seats: 3,
      now,
    });
    expect(first.quotaMcuMicros).toBe(150 * 1_000_000 * 3);

    const second = provisionEntitlementForPlan(db, {
      tenantId: "tenant-a",
      plan: "pro",
      periodStart,
      periodEnd,
      seats: 3,
      now,
    });
    // Deterministic ids: re-run returns the same row and does not double-provision.
    expect(second).toEqual(first);
    const active = getActiveUsageEntitlement(db, "tenant-a", "2026-08-15T00:00:00.000Z");
    expect(active?.id).toBe(first.id);
    expect(active?.version).toBe(first.version);
  });

  it("provisions Free as a flat allowance and ignores seats", () => {
    const db = setup();
    const free = provisionEntitlementForPlan(db, {
      tenantId: "tenant-a",
      plan: "free",
      periodStart,
      periodEnd,
      seats: 25,
      now,
    });
    expect(free.quotaMcuMicros).toBe(USAGE_PLAN_CATALOG.free.monthlyMcuMicros);
    expect(free.quotaMcuMicros).toBe(15 * 1_000_000);
  });

  it("resolves per-seat and flat quotas and rejects unknown plans / bad seats", () => {
    const db = setup();
    expect(resolvePlanQuotaMcuMicros(USAGE_PLAN_CATALOG.teams, 2)).toBe(400 * 1_000_000 * 2);
    expect(resolvePlanQuotaMcuMicros(USAGE_PLAN_CATALOG.free, 99)).toBe(15 * 1_000_000);
    expect(() =>
      provisionEntitlementForPlan(db, {
        tenantId: "tenant-a",
        plan: "does-not-exist",
        periodStart,
        periodEnd,
        now,
      }),
    ).toThrow("usage_plan_unknown");
    expect(() => resolvePlanQuotaMcuMicros(USAGE_PLAN_CATALOG.pro, 0)).toThrow(
      "usage_plan_seats_invalid",
    );
  });
});
