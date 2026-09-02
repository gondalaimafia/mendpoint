import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adjustUsage,
  createDb,
  createUsageEntitlement,
  createUsagePriceVersion,
  creditUsage,
  getUsageSummary,
  listUsageLedger,
  reconcileUsageLedger,
  releaseUsageReservation,
  reserveUsage,
  settleUsageReservation,
} from "./index.js";

const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];
const at = "2026-08-01T12:00:00.000Z";

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close?.();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-usage-"));
  dirs.push(dir);
  const db = createDb(join(dir, "usage.sqlite"));
  dbs.push(db);
  createUsagePriceVersion(db, {
    id: "price-a",
    tenantId: "tenant_default",
    formulaVersion: "mcu-v1",
    currency: "USD",
    pricePerMcuMoneyMicros: 20_000,
    effectiveAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
    contractReference: "contract-a",
    createdAt: at,
  });
  createUsageEntitlement(db, {
    id: "entitlement-a",
    tenantId: "tenant_default",
    priceVersionId: "price-a",
    quotaMcuMicros: 10_000_000,
    features: ["warden"],
    contractReference: "contract-a",
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-09-01T00:00:00.000Z",
    createdAt: at,
  });
  return db;
}

describe("usage ledger", () => {
  it("reserves, settles, credits, and reconciles idempotently", () => {
    const db = setup();
    const reservation = reserveUsage(db, {
      id: "reservation-a",
      tenantId: "tenant_default",
      idempotencyKey: "reserve-task-a",
      taskId: "task-a",
      campaignId: "campaign-a",
      mcuMicros: 5_000_000,
      reason: "planned task ceiling",
      createdAt: at,
    });
    expect(
      reserveUsage(db, {
        id: "reservation-a",
        tenantId: "tenant_default",
        idempotencyKey: "reserve-task-a",
        taskId: "task-a",
        campaignId: "campaign-a",
        mcuMicros: 5_000_000,
        reason: "planned task ceiling",
        createdAt: at,
      }),
    ).toEqual(reservation);
    expect(() =>
      reserveUsage(db, {
        id: "reservation-conflict",
        tenantId: "tenant_default",
        idempotencyKey: "reserve-task-a",
        taskId: "task-a",
        mcuMicros: 4_000_000,
        reason: "conflicting replay",
        createdAt: at,
      }),
    ).toThrow("usage_idempotency_conflict");

    const settlement = settleUsageReservation(db, {
      id: "settlement-a",
      tenantId: "tenant_default",
      idempotencyKey: "settle-task-a",
      reservationId: "reservation-a",
      actualMcuMicros: 4_000_000,
      invoiceReference: "invoice-2026-08",
      reason: "verified actual work",
      createdAt: "2026-08-01T12:01:00.000Z",
    });
    expect(
      settleUsageReservation(db, {
        id: "settlement-a",
        tenantId: "tenant_default",
        idempotencyKey: "settle-task-a",
        reservationId: "reservation-a",
        actualMcuMicros: 4_000_000,
        invoiceReference: "invoice-2026-08",
        reason: "verified actual work",
        createdAt: "2026-08-01T12:01:00.000Z",
      }),
    ).toEqual(settlement);
    creditUsage(db, {
      id: "credit-a",
      tenantId: "tenant_default",
      idempotencyKey: "credit-task-a",
      taskId: "task-a",
      campaignId: "campaign-a",
      mcuMicrosDelta: -500_000,
      invoiceReference: "invoice-2026-08",
      reason: "service credit",
      createdAt: "2026-08-01T12:02:00.000Z",
    });
    expect(getUsageSummary(db, "tenant_default", at)).toMatchObject({
      reservedMcuMicros: 0,
      consumedMcuMicros: 3_500_000,
      creditedMcuMicros: 500_000,
      availableMcuMicros: 6_500_000,
      billableMoneyMicros: 70_000,
      currency: "USD",
    });
    expect(reconcileUsageLedger(db, "tenant_default")).toMatchObject({
      ok: true,
      checked: 3,
      invoices: { "invoice-2026-08": 3_500_000 },
    });
  });

  it("fails closed on missing entitlement, quota, cross tenant, and mutation", () => {
    const db = setup();
    expect(() =>
      reserveUsage(db, {
        id: "reservation-b",
        tenantId: "tenant-other",
        idempotencyKey: "reserve-b",
        taskId: "task-b",
        mcuMicros: 1,
        reason: "no entitlement",
        createdAt: at,
      }),
    ).toThrow();
    expect(() =>
      reserveUsage(db, {
        id: "reservation-large",
        tenantId: "tenant_default",
        idempotencyKey: "reserve-large",
        taskId: "task-large",
        mcuMicros: 10_000_001,
        reason: "over quota",
        createdAt: at,
      }),
    ).toThrow("usage_quota_exceeded");
    const reservation = reserveUsage(db, {
      id: "reservation-release",
      tenantId: "tenant_default",
      idempotencyKey: "reserve-release",
      taskId: "task-release",
      mcuMicros: 1_000_000,
      reason: "release test",
      createdAt: at,
    });
    const release = releaseUsageReservation(db, {
      id: "release-a",
      tenantId: "tenant_default",
      idempotencyKey: "release-a",
      reservationId: reservation.id,
      reason: "task cancelled",
      createdAt: "2026-08-01T12:01:00.000Z",
    });
    expect(
      releaseUsageReservation(db, {
        id: "release-a",
        tenantId: "tenant_default",
        idempotencyKey: "release-a",
        reservationId: reservation.id,
        reason: "task cancelled",
        createdAt: "2026-08-01T12:01:00.000Z",
      }),
    ).toEqual(release);
    expect(() =>
      adjustUsage(db, {
        id: "adjust-too-far",
        tenantId: "tenant_default",
        idempotencyKey: "adjust-too-far",
        taskId: "task-release",
        mcuMicrosDelta: -1,
        reason: "invalid negative balance",
        createdAt: "2026-08-01T12:02:00.000Z",
      }),
    ).toThrow("usage_adjustment_invalid");
    expect(() =>
      db.raw.prepare("UPDATE usage_ledger_entries SET reason = 'changed'").run(),
    ).toThrow("usage_ledger_entries_append_only");
    expect(listUsageLedger(db, "tenant_default")).toHaveLength(2);
  });

  it("binds positive adjustments and negative credits to an existing invoice allocation", () => {
    const db = setup();
    const reservation = reserveUsage(db, {
      id: "reservation-invoice",
      tenantId: "tenant_default",
      idempotencyKey: "reserve-invoice",
      taskId: "task-invoice",
      mcuMicros: 1_000_000,
      reason: "invoice allocation",
      createdAt: at,
    });
    settleUsageReservation(db, {
      id: "settlement-invoice",
      tenantId: "tenant_default",
      idempotencyKey: "settle-invoice",
      reservationId: reservation.id,
      actualMcuMicros: 1_000_000,
      invoiceReference: "invoice-a",
      reason: "invoice usage",
      createdAt: "2026-08-01T12:01:00.000Z",
    });

    expect(() => adjustUsage(db, {
      id: "negative-adjustment",
      tenantId: "tenant_default",
      idempotencyKey: "negative-adjustment",
      taskId: "task-invoice",
      mcuMicrosDelta: -1,
      invoiceReference: "invoice-a",
      reason: "wrong sign",
      createdAt: "2026-08-01T12:02:00.000Z",
    })).toThrow("usage_adjustment_invalid");
    expect(() => adjustUsage(db, {
      id: "unbound-adjustment",
      tenantId: "tenant_default",
      idempotencyKey: "unbound-adjustment",
      taskId: "task-invoice",
      mcuMicrosDelta: 1,
      reason: "missing invoice",
      createdAt: "2026-08-01T12:02:00.000Z",
    })).toThrow("usage_invoice_reference_required");
    expect(() => adjustUsage(db, {
      id: "unknown-invoice-adjustment",
      tenantId: "tenant_default",
      idempotencyKey: "unknown-invoice-adjustment",
      taskId: "task-invoice",
      mcuMicrosDelta: 1,
      invoiceReference: "invoice-b",
      reason: "unknown invoice",
      createdAt: "2026-08-01T12:02:00.000Z",
    })).toThrow("usage_invoice_allocation_not_found");
    expect(() => creditUsage(db, {
      id: "cross-invoice-credit",
      tenantId: "tenant_default",
      idempotencyKey: "cross-invoice-credit",
      taskId: "task-invoice",
      mcuMicrosDelta: -1,
      invoiceReference: "invoice-b",
      reason: "wrong invoice",
      createdAt: "2026-08-01T12:02:00.000Z",
    })).toThrow("usage_invoice_allocation_not_found");
    expect(() => creditUsage(db, {
      id: "over-invoice-credit",
      tenantId: "tenant_default",
      idempotencyKey: "over-invoice-credit",
      taskId: "task-invoice",
      mcuMicrosDelta: -1_000_001,
      invoiceReference: "invoice-a",
      reason: "over invoice",
      createdAt: "2026-08-01T12:02:00.000Z",
    })).toThrow("usage_credit_exceeds_invoice_allocation");

    expect(reconcileUsageLedger(db, "tenant_default")).toMatchObject({
      ok: true,
      invoices: { "invoice-a": 1_000_000 },
    });
  });
});
