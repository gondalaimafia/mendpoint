import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adjustUsage,
  createDb,
  createUsageEntitlement,
  createUsageFinanceAuthorization,
  createUsagePriceVersion,
  creditUsage,
  getUsageSummary,
  insertPrincipal,
  putTenantMembership,
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
  insertPrincipal(db, {
    id: "finance-owner",
    tenantId: "tenant_default",
    kind: "human",
    subject: "finance-owner@example.test",
    displayName: "Finance Owner",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  putTenantMembership(db, {
    tenantId: "tenant_default",
    issuer: "https://identity.example.test",
    subject: "finance-owner",
    email: "finance-owner@example.test",
    displayName: "Finance Owner",
    role: "owner",
    status: "active",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  db.raw.prepare(
    "UPDATE principals SET subject = ?, audience = ? WHERE id = ?",
  ).run(
    "https://identity.example.test|finance-owner",
    "https://identity.example.test",
    "finance-owner",
  );
  return db;
}

function financeAuthorization(
  db: ReturnType<typeof setup>,
  input: {
    entryType: "adjustment" | "credit";
    idempotencyKey: string;
    mcuMicrosDelta: number;
    invoiceReference: string;
    reason: string;
    createdAt: string;
  },
) {
  const authorization = createUsageFinanceAuthorization(db, {
    id: `finance-${input.idempotencyKey}`,
    tenantId: "tenant_default",
    approvedByPrincipalId: "finance-owner",
    actorPrincipalId: "finance-owner",
    entryType: input.entryType,
    invoiceReference: input.invoiceReference,
    entryIdempotencyKey: input.idempotencyKey,
    mcuMicrosDelta: input.mcuMicrosDelta,
    reason: input.reason,
    approvedAt: "2026-08-01T12:01:30.000Z",
    expiresAt: "2026-08-02T00:00:00.000Z",
  });
  return {
    actorPrincipalId: "finance-owner",
    financeAuthorizationId: authorization.id,
    financeAuthorizationDigest: authorization.authorizationDigest,
  };
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
    const creditInput = {
      id: "credit-a",
      tenantId: "tenant_default",
      idempotencyKey: "credit-task-a",
      taskId: "task-a",
      campaignId: "campaign-a",
      mcuMicrosDelta: -500_000,
      invoiceReference: "invoice-2026-08",
      reason: "service credit",
      createdAt: "2026-08-01T12:02:00.000Z",
    } as const;
    const creditAuthorization = financeAuthorization(db, {
      entryType: "credit",
      ...creditInput,
      invoiceReference: creditInput.invoiceReference,
    });
    const credit = creditUsage(db, {
      ...creditInput,
      ...creditAuthorization,
    });
    expect(credit).toMatchObject({
      financeAuthorizationId: creditAuthorization.financeAuthorizationId,
      financeAuthorizationDigest: creditAuthorization.financeAuthorizationDigest,
    });
    expect(creditUsage(db, { ...creditInput, ...creditAuthorization })).toEqual(credit);
    expect(() => creditUsage(db, {
      ...creditInput,
      id: "credit-reuse",
      idempotencyKey: "credit-reuse",
      ...creditAuthorization,
    })).toThrow("usage_finance_authorization_binding_invalid");
    expect(() => db.raw.prepare(
      "UPDATE usage_finance_authorizations SET reason = 'changed' WHERE id = ?",
    ).run(creditAuthorization.financeAuthorizationId)).toThrow(
      "usage_finance_authorizations_immutable",
    );
    expect(() => db.raw.prepare(
      "DELETE FROM usage_finance_authorizations WHERE id = ?",
    ).run(creditAuthorization.financeAuthorizationId)).toThrow(
      "usage_finance_authorizations_append_only",
    );
    expect(() => creditUsage(db, {
      ...creditInput,
      id: "credit-forged-digest",
      financeAuthorizationId: creditAuthorization.financeAuthorizationId,
      financeAuthorizationDigest: `sha256:${"0".repeat(64)}`,
      actorPrincipalId: creditAuthorization.actorPrincipalId,
    })).toThrow("usage_finance_authorization_binding_invalid");
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
    db.raw.exec("DROP TRIGGER usage_ledger_entries_append_only_update");
    db.raw.prepare(
      "UPDATE usage_ledger_entries SET finance_authorization_digest = ? WHERE id = ?",
    ).run(`sha256:${"0".repeat(64)}`, credit.id);
    expect(reconcileUsageLedger(db, "tenant_default")).toMatchObject({
      ok: false,
      error: `usage_integrity:${credit.id}`,
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

    const expired = createUsageFinanceAuthorization(db, {
      id: "finance-expired-credit",
      tenantId: "tenant_default",
      approvedByPrincipalId: "finance-owner",
      actorPrincipalId: "finance-owner",
      entryType: "credit",
      invoiceReference: "invoice-a",
      entryIdempotencyKey: "expired-credit",
      mcuMicrosDelta: -1,
      reason: "expired approval",
      approvedAt: "2026-08-01T12:01:01.000Z",
      expiresAt: "2026-08-01T12:01:30.000Z",
    });
    expect(() => creditUsage(db, {
      id: "expired-credit",
      tenantId: "tenant_default",
      idempotencyKey: "expired-credit",
      taskId: "task-invoice",
      mcuMicrosDelta: -1,
      invoiceReference: "invoice-a",
      reason: "expired approval",
      actorPrincipalId: "finance-owner",
      financeAuthorizationId: expired.id,
      financeAuthorizationDigest: expired.authorizationDigest,
      createdAt: "2026-08-01T12:02:00.000Z",
    })).toThrow("usage_finance_authorization_expired");

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
    const unknownAdjustment = {
      id: "unknown-invoice-adjustment",
      tenantId: "tenant_default",
      idempotencyKey: "unknown-invoice-adjustment",
      taskId: "task-invoice",
      mcuMicrosDelta: 1,
      invoiceReference: "invoice-b",
      reason: "unknown invoice",
      createdAt: "2026-08-01T12:02:00.000Z",
    } as const;
    expect(() => adjustUsage(db, {
      ...unknownAdjustment,
      ...financeAuthorization(db, {
        entryType: "adjustment",
        ...unknownAdjustment,
        invoiceReference: unknownAdjustment.invoiceReference,
      }),
    })).toThrow("usage_invoice_allocation_not_found");
    const crossInvoiceCredit = {
      id: "cross-invoice-credit",
      tenantId: "tenant_default",
      idempotencyKey: "cross-invoice-credit",
      taskId: "task-invoice",
      mcuMicrosDelta: -1,
      invoiceReference: "invoice-b",
      reason: "wrong invoice",
      createdAt: "2026-08-01T12:02:00.000Z",
    } as const;
    expect(() => creditUsage(db, {
      ...crossInvoiceCredit,
      ...financeAuthorization(db, {
        entryType: "credit",
        ...crossInvoiceCredit,
        invoiceReference: crossInvoiceCredit.invoiceReference,
      }),
    })).toThrow("usage_invoice_allocation_not_found");
    const overInvoiceCredit = {
      id: "over-invoice-credit",
      tenantId: "tenant_default",
      idempotencyKey: "over-invoice-credit",
      taskId: "task-invoice",
      mcuMicrosDelta: -1_000_001,
      invoiceReference: "invoice-a",
      reason: "over invoice",
      createdAt: "2026-08-01T12:02:00.000Z",
    } as const;
    expect(() => creditUsage(db, {
      ...overInvoiceCredit,
      ...financeAuthorization(db, {
        entryType: "credit",
        ...overInvoiceCredit,
        invoiceReference: overInvoiceCredit.invoiceReference,
      }),
    })).toThrow("usage_credit_exceeds_invoice_allocation");

    expect(reconcileUsageLedger(db, "tenant_default")).toMatchObject({
      ok: true,
      invoices: { "invoice-a": 1_000_000 },
    });
  });

  it("replays an already committed finance mutation after authorization expiry", () => {
    const db = setup();
    const reservation = reserveUsage(db, {
      id: "reservation-replay",
      tenantId: "tenant_default",
      idempotencyKey: "reserve-replay",
      taskId: "task-replay",
      mcuMicros: 100,
      reason: "replay allocation",
      createdAt: at,
    });
    settleUsageReservation(db, {
      id: "settlement-replay",
      tenantId: "tenant_default",
      idempotencyKey: "settle-replay",
      reservationId: reservation.id,
      actualMcuMicros: 100,
      invoiceReference: "invoice-replay",
      reason: "replay settlement",
      createdAt: "2026-08-01T12:01:00.000Z",
    });
    const authorization = createUsageFinanceAuthorization(db, {
      id: "finance-replay",
      tenantId: "tenant_default",
      approvedByPrincipalId: "finance-owner",
      actorPrincipalId: "finance-owner",
      entryType: "credit",
      invoiceReference: "invoice-replay",
      entryIdempotencyKey: "credit-replay",
      mcuMicrosDelta: -10,
      reason: "lost response replay",
      approvedAt: "2026-08-01T12:01:30.000Z",
      expiresAt: "2026-08-01T12:02:00.000Z",
    });
    const input = {
      id: "credit-replay",
      tenantId: "tenant_default",
      idempotencyKey: "credit-replay",
      taskId: "task-replay",
      mcuMicrosDelta: -10,
      invoiceReference: "invoice-replay",
      reason: "lost response replay",
      actorPrincipalId: "finance-owner",
      financeAuthorizationId: authorization.id,
      financeAuthorizationDigest: authorization.authorizationDigest,
    } as const;
    const committed = creditUsage(db, {
      ...input,
      createdAt: "2026-08-01T12:01:45.000Z",
    });

    expect(creditUsage(db, {
      ...input,
      id: "new-api-generated-id",
      createdAt: "2026-08-01T12:10:00.000Z",
    })).toEqual(committed);
    expect(listUsageLedger(db, "tenant_default").filter((entry) =>
      entry.idempotencyKey === "credit-replay",
    )).toHaveLength(1);
  });

  it("applies a late credit to the entitlement represented by its invoice", () => {
    const db = setup();
    const reservation = reserveUsage(db, {
      id: "reservation-august",
      tenantId: "tenant_default",
      idempotencyKey: "reserve-august",
      taskId: "task-august",
      mcuMicros: 1_000,
      reason: "august allocation",
      createdAt: at,
    });
    settleUsageReservation(db, {
      id: "settlement-august",
      tenantId: "tenant_default",
      idempotencyKey: "settle-august",
      reservationId: reservation.id,
      actualMcuMicros: 1_000,
      invoiceReference: "invoice-august",
      reason: "august settlement",
      createdAt: "2026-08-15T00:00:00.000Z",
    });
    createUsagePriceVersion(db, {
      id: "price-b",
      tenantId: "tenant_default",
      formulaVersion: "mcu-v1",
      currency: "USD",
      pricePerMcuMoneyMicros: 20_000,
      effectiveAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-10-01T00:00:00.000Z",
      contractReference: "contract-b",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    createUsageEntitlement(db, {
      id: "entitlement-b",
      tenantId: "tenant_default",
      priceVersionId: "price-b",
      quotaMcuMicros: 10_000_000,
      features: ["fettler"],
      contractReference: "contract-b",
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const excessAuthorization = createUsageFinanceAuthorization(db, {
      id: "finance-late-credit-excess",
      tenantId: "tenant_default",
      approvedByPrincipalId: "finance-owner",
      actorPrincipalId: "finance-owner",
      entryType: "credit",
      invoiceReference: "invoice-august",
      entryIdempotencyKey: "late-credit-excess",
      mcuMicrosDelta: -1_001,
      reason: "excess late august correction",
      approvedAt: "2026-09-02T12:00:00.000Z",
      expiresAt: "2026-09-02T12:05:00.000Z",
    });
    expect(() => creditUsage(db, {
      id: "late-credit-excess",
      tenantId: "tenant_default",
      idempotencyKey: "late-credit-excess",
      taskId: "task-august",
      mcuMicrosDelta: -1_001,
      invoiceReference: "invoice-august",
      reason: "excess late august correction",
      actorPrincipalId: "finance-owner",
      financeAuthorizationId: excessAuthorization.id,
      financeAuthorizationDigest: excessAuthorization.authorizationDigest,
      createdAt: "2026-09-02T12:01:00.000Z",
    })).toThrow("usage_credit_exceeds_invoice_allocation");
    const authorization = createUsageFinanceAuthorization(db, {
      id: "finance-late-credit",
      tenantId: "tenant_default",
      approvedByPrincipalId: "finance-owner",
      actorPrincipalId: "finance-owner",
      entryType: "credit",
      invoiceReference: "invoice-august",
      entryIdempotencyKey: "late-credit",
      mcuMicrosDelta: -400,
      reason: "late august correction",
      approvedAt: "2026-09-02T12:00:00.000Z",
      expiresAt: "2026-09-02T12:05:00.000Z",
    });

    const credit = creditUsage(db, {
      id: "late-credit",
      tenantId: "tenant_default",
      idempotencyKey: "late-credit",
      taskId: "task-august",
      mcuMicrosDelta: -400,
      invoiceReference: "invoice-august",
      reason: "late august correction",
      actorPrincipalId: "finance-owner",
      financeAuthorizationId: authorization.id,
      financeAuthorizationDigest: authorization.authorizationDigest,
      createdAt: "2026-09-02T12:01:00.000Z",
    });
    expect(credit).toMatchObject({
      entitlementId: "entitlement-a",
      priceVersion: "price-a",
      consumedMcuMicrosDelta: -400,
    });

    const fullAuthorization = createUsageFinanceAuthorization(db, {
      id: "finance-late-credit-full",
      tenantId: "tenant_default",
      approvedByPrincipalId: "finance-owner",
      actorPrincipalId: "finance-owner",
      entryType: "credit",
      invoiceReference: "invoice-august",
      entryIdempotencyKey: "late-credit-full",
      mcuMicrosDelta: -600,
      reason: "full august correction",
      approvedAt: "2026-09-02T12:02:00.000Z",
      expiresAt: "2026-09-02T12:07:00.000Z",
    });
    expect(creditUsage(db, {
      id: "late-credit-full",
      tenantId: "tenant_default",
      idempotencyKey: "late-credit-full",
      taskId: "task-august",
      mcuMicrosDelta: -600,
      invoiceReference: "invoice-august",
      reason: "full august correction",
      actorPrincipalId: "finance-owner",
      financeAuthorizationId: fullAuthorization.id,
      financeAuthorizationDigest: fullAuthorization.authorizationDigest,
      createdAt: "2026-09-02T12:03:00.000Z",
    })).toMatchObject({ entitlementId: "entitlement-a", consumedMcuMicrosDelta: -600 });

    const septemberReservation = reserveUsage(db, {
      id: "reservation-september",
      tenantId: "tenant_default",
      idempotencyKey: "reserve-september",
      taskId: "task-september",
      mcuMicros: 500,
      reason: "september allocation",
      createdAt: "2026-09-02T12:03:10.000Z",
    });
    settleUsageReservation(db, {
      id: "settlement-september",
      tenantId: "tenant_default",
      idempotencyKey: "settle-september",
      reservationId: septemberReservation.id,
      actualMcuMicros: 500,
      invoiceReference: "invoice-september",
      reason: "september settlement",
      createdAt: "2026-09-02T12:03:20.000Z",
    });
    const septemberAuthorization = createUsageFinanceAuthorization(db, {
      id: "finance-september-credit",
      tenantId: "tenant_default",
      approvedByPrincipalId: "finance-owner",
      actorPrincipalId: "finance-owner",
      entryType: "credit",
      invoiceReference: "invoice-september",
      entryIdempotencyKey: "september-credit",
      mcuMicrosDelta: -100,
      reason: "september correction",
      approvedAt: "2026-09-02T12:03:30.000Z",
      expiresAt: "2026-09-02T12:08:30.000Z",
    });
    expect(creditUsage(db, {
      id: "september-credit",
      tenantId: "tenant_default",
      idempotencyKey: "september-credit",
      taskId: "task-september",
      mcuMicrosDelta: -100,
      invoiceReference: "invoice-september",
      reason: "september correction",
      actorPrincipalId: "finance-owner",
      financeAuthorizationId: septemberAuthorization.id,
      financeAuthorizationDigest: septemberAuthorization.authorizationDigest,
      createdAt: "2026-09-02T12:04:00.000Z",
    })).toMatchObject({ entitlementId: "entitlement-b", consumedMcuMicrosDelta: -100 });
    expect(reconcileUsageLedger(db, "tenant_default")).toMatchObject({
      ok: true,
      invoices: { "invoice-august": 0, "invoice-september": 400 },
    });
  });

  it("atomically allocates one historical credit across every immutable invoice allocation", () => {
    const db = setup();
    const august = reserveUsage(db, {
      id: "reservation-split-august",
      tenantId: "tenant_default",
      idempotencyKey: "reserve-split-august",
      taskId: "task-split",
      mcuMicros: 60,
      reason: "first invoice allocation",
      createdAt: "2026-08-01T12:00:00.000Z",
    });
    settleUsageReservation(db, {
      id: "settlement-split-august",
      tenantId: "tenant_default",
      idempotencyKey: "settle-split-august",
      reservationId: august.id,
      actualMcuMicros: 60,
      invoiceReference: "invoice-split",
      reason: "first invoice allocation",
      createdAt: "2026-08-01T12:01:00.000Z",
    });
    createUsagePriceVersion(db, {
      id: "price-split-b",
      tenantId: "tenant_default",
      formulaVersion: "mcu-v1",
      currency: "USD",
      pricePerMcuMoneyMicros: 30_000,
      effectiveAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-10-01T00:00:00.000Z",
      contractReference: "contract-split-b",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    createUsageEntitlement(db, {
      id: "entitlement-split-b",
      tenantId: "tenant_default",
      priceVersionId: "price-split-b",
      quotaMcuMicros: 10_000,
      features: ["fettler"],
      contractReference: "contract-split-b",
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const september = reserveUsage(db, {
      id: "reservation-split-september",
      tenantId: "tenant_default",
      idempotencyKey: "reserve-split-september",
      taskId: "task-split",
      mcuMicros: 40,
      reason: "second invoice allocation",
      createdAt: "2026-09-02T12:00:00.000Z",
    });
    settleUsageReservation(db, {
      id: "settlement-split-september",
      tenantId: "tenant_default",
      idempotencyKey: "settle-split-september",
      reservationId: september.id,
      actualMcuMicros: 40,
      invoiceReference: "invoice-split",
      reason: "second invoice allocation",
      createdAt: "2026-09-02T12:01:00.000Z",
    });
    const creditInput = {
      id: "credit-split",
      tenantId: "tenant_default",
      idempotencyKey: "credit-split",
      taskId: "task-split",
      mcuMicrosDelta: -80,
      invoiceReference: "invoice-split",
      reason: "split invoice correction",
      createdAt: "2026-09-02T12:02:00.000Z",
    } as const;
    const authorizationRecord = createUsageFinanceAuthorization(db, {
      id: "finance-credit-split",
      tenantId: "tenant_default",
      approvedByPrincipalId: "finance-owner",
      actorPrincipalId: "finance-owner",
      entryType: "credit",
      invoiceReference: creditInput.invoiceReference,
      entryIdempotencyKey: creditInput.idempotencyKey,
      mcuMicrosDelta: creditInput.mcuMicrosDelta,
      reason: creditInput.reason,
      approvedAt: "2026-09-02T12:01:30.000Z",
      expiresAt: "2026-09-02T12:03:00.000Z",
    });
    const authorization = {
      actorPrincipalId: "finance-owner",
      financeAuthorizationId: authorizationRecord.id,
      financeAuthorizationDigest: authorizationRecord.authorizationDigest,
    } as const;

    expect(() => creditUsage(db, { ...creditInput, ...authorization })).not.toThrow();
    expect(reconcileUsageLedger(db, "tenant_default")).toMatchObject({
      ok: true,
      invoices: { "invoice-split": 20 },
    });
    const creditLines = listUsageLedger(db, "tenant_default")
      .filter((entry) => entry.financeAuthorizationId === authorization.financeAuthorizationId);
    const allocationByPrice = Object.fromEntries(creditLines.map((entry) => [
      entry.priceVersion,
      (creditLines.filter((candidate) => candidate.priceVersion === entry.priceVersion)
        .reduce((sum, candidate) => sum + candidate.consumedMcuMicrosDelta, 0)),
    ]));
    expect(allocationByPrice).toEqual({ "price-a": -60, "price-split-b": -20 });
    expect(creditUsage(db, { ...creditInput, ...authorization })).toEqual(
      creditLines.find((entry) => entry.id === creditInput.id),
    );

    const excessInput = {
      id: "credit-split-excess",
      tenantId: "tenant_default",
      idempotencyKey: "credit-split-excess",
      taskId: "task-split",
      mcuMicrosDelta: -21,
      invoiceReference: "invoice-split",
      reason: "excess split invoice correction",
      createdAt: "2026-09-02T12:03:00.000Z",
    } as const;
    const excessAuthorization = createUsageFinanceAuthorization(db, {
      id: "finance-credit-split-excess",
      tenantId: "tenant_default",
      approvedByPrincipalId: "finance-owner",
      actorPrincipalId: "finance-owner",
      entryType: "credit",
      invoiceReference: excessInput.invoiceReference,
      entryIdempotencyKey: excessInput.idempotencyKey,
      mcuMicrosDelta: excessInput.mcuMicrosDelta,
      reason: excessInput.reason,
      approvedAt: "2026-09-02T12:02:30.000Z",
      expiresAt: "2026-09-02T12:04:00.000Z",
    });
    expect(() => creditUsage(db, {
      ...excessInput,
      actorPrincipalId: "finance-owner",
      financeAuthorizationId: excessAuthorization.id,
      financeAuthorizationDigest: excessAuthorization.authorizationDigest,
    })).toThrow("usage_credit_exceeds_invoice_allocation");

    const fullInput = {
      id: "credit-split-full",
      tenantId: "tenant_default",
      idempotencyKey: "credit-split-full",
      taskId: "task-split",
      mcuMicrosDelta: -20,
      invoiceReference: "invoice-split",
      reason: "full split invoice correction",
      createdAt: "2026-09-02T12:03:00.000Z",
    } as const;
    const fullAuthorization = createUsageFinanceAuthorization(db, {
      id: "finance-credit-split-full",
      tenantId: "tenant_default",
      approvedByPrincipalId: "finance-owner",
      actorPrincipalId: "finance-owner",
      entryType: "credit",
      invoiceReference: fullInput.invoiceReference,
      entryIdempotencyKey: fullInput.idempotencyKey,
      mcuMicrosDelta: fullInput.mcuMicrosDelta,
      reason: fullInput.reason,
      approvedAt: "2026-09-02T12:02:30.000Z",
      expiresAt: "2026-09-02T12:04:00.000Z",
    });
    creditUsage(db, {
      ...fullInput,
      actorPrincipalId: "finance-owner",
      financeAuthorizationId: fullAuthorization.id,
      financeAuthorizationDigest: fullAuthorization.authorizationDigest,
    });
    expect(reconcileUsageLedger(db, "tenant_default")).toMatchObject({
      ok: true,
      invoices: { "invoice-split": 0 },
    });
  });

  it("recovers an existing finance authorization from the stable intent", () => {
    const db = setup();
    const original = createUsageFinanceAuthorization(db, {
      id: "finance-original",
      tenantId: "tenant_default",
      approvedByPrincipalId: "finance-owner",
      actorPrincipalId: "finance-owner",
      entryType: "credit",
      invoiceReference: "invoice-recovery",
      entryIdempotencyKey: "credit-recovery",
      mcuMicrosDelta: -10,
      reason: "authorization recovery",
      approvedAt: "2026-08-01T12:01:30.000Z",
      expiresAt: "2026-08-01T12:06:30.000Z",
    });
    const recovered = createUsageFinanceAuthorization(db, {
      id: "new-server-generated-id",
      tenantId: "tenant_default",
      approvedByPrincipalId: "finance-owner",
      actorPrincipalId: "finance-owner",
      entryType: "credit",
      invoiceReference: "invoice-recovery",
      entryIdempotencyKey: "credit-recovery",
      mcuMicrosDelta: -10,
      reason: "authorization recovery",
      approvedAt: "2026-08-01T12:02:00.000Z",
      expiresAt: "2026-08-01T12:07:00.000Z",
    });

    expect(recovered).toEqual(original);
    expect(() => createUsageFinanceAuthorization(db, {
      id: "conflicting-server-generated-id",
      tenantId: "tenant_default",
      approvedByPrincipalId: "finance-owner",
      actorPrincipalId: "finance-owner",
      entryType: "credit",
      invoiceReference: "invoice-recovery",
      entryIdempotencyKey: "credit-recovery",
      mcuMicrosDelta: -11,
      reason: "authorization recovery",
      approvedAt: "2026-08-01T12:02:00.000Z",
      expiresAt: "2026-08-01T12:07:00.000Z",
    })).toThrow("usage_finance_authorization_conflict");
  });

  it("rejects invalid finance entry types before a durable mutation", () => {
    const db = setup();
    for (const [index, entryType] of ["refund", null, [], {}].entries()) {
      expect(() => createUsageFinanceAuthorization(db, {
        id: `invalid-finance-type-${index}`,
        tenantId: "tenant_default",
        approvedByPrincipalId: "finance-owner",
        actorPrincipalId: "finance-owner",
        entryType: entryType as never,
        invoiceReference: "invoice-a",
        entryIdempotencyKey: `invalid-finance-type-${index}`,
        mcuMicrosDelta: 1,
        reason: "invalid entry type",
        approvedAt: "2026-08-01T12:01:30.000Z",
        expiresAt: "2026-08-01T12:06:30.000Z",
      })).toThrow("usage_finance_entry_type_invalid");
    }
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS total FROM usage_finance_authorizations",
    ).get()).toEqual({ total: 0 });
  });

  it("requires a live tenant owner for approval and consumption", () => {
    const db = setup();
    insertPrincipal(db, {
      id: "finance-viewer",
      tenantId: "tenant_default",
      kind: "human",
      subject: "https://identity.example.test|finance-viewer",
      displayName: "Finance Viewer",
      audience: "https://identity.example.test",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    putTenantMembership(db, {
      tenantId: "tenant_default",
      issuer: "https://identity.example.test",
      subject: "finance-viewer",
      email: "finance-viewer@example.test",
      displayName: "Finance Viewer",
      role: "viewer",
      status: "active",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(() => createUsageFinanceAuthorization(db, {
      id: "viewer-approval",
      tenantId: "tenant_default",
      approvedByPrincipalId: "finance-viewer",
      actorPrincipalId: "finance-viewer",
      entryType: "adjustment",
      invoiceReference: "invoice-a",
      entryIdempotencyKey: "viewer-adjustment",
      mcuMicrosDelta: 1,
      reason: "viewer cannot approve",
      approvedAt: "2026-08-01T12:01:30.000Z",
      expiresAt: "2026-08-01T12:06:30.000Z",
    })).toThrow("usage_finance_owner_required");

    const reservation = reserveUsage(db, {
      id: "finance-lifecycle-reservation",
      tenantId: "tenant_default",
      idempotencyKey: "finance-lifecycle-reservation",
      taskId: "finance-lifecycle-task",
      mcuMicros: 10,
      reason: "finance lifecycle",
      createdAt: at,
    });
    settleUsageReservation(db, {
      id: "finance-lifecycle-settlement",
      tenantId: "tenant_default",
      idempotencyKey: "finance-lifecycle-settlement",
      reservationId: reservation.id,
      actualMcuMicros: 10,
      invoiceReference: "invoice-a",
      reason: "finance lifecycle",
      createdAt: "2026-08-01T12:01:00.000Z",
    });
    const authorization = createUsageFinanceAuthorization(db, {
      id: "revoked-owner-approval",
      tenantId: "tenant_default",
      approvedByPrincipalId: "finance-owner",
      actorPrincipalId: "finance-owner",
      entryType: "credit",
      invoiceReference: "invoice-a",
      entryIdempotencyKey: "revoked-owner-credit",
      mcuMicrosDelta: -1,
      reason: "approval before revocation",
      approvedAt: "2026-08-01T12:01:30.000Z",
      expiresAt: "2026-08-01T12:06:30.000Z",
    });
    db.raw.prepare(
      "UPDATE principals SET revoked_at = ? WHERE id = ?",
    ).run("2026-08-01T12:01:45.000Z", "finance-owner");
    expect(() => creditUsage(db, {
      id: "revoked-owner-credit",
      tenantId: "tenant_default",
      idempotencyKey: "revoked-owner-credit",
      taskId: "finance-lifecycle-task",
      mcuMicrosDelta: -1,
      invoiceReference: "invoice-a",
      reason: "approval before revocation",
      actorPrincipalId: "finance-owner",
      financeAuthorizationId: authorization.id,
      financeAuthorizationDigest: authorization.authorizationDigest,
      createdAt: "2026-08-01T12:02:00.000Z",
    })).toThrow("usage_finance_owner_inactive");

    db.raw.prepare(
      "UPDATE principals SET revoked_at = NULL WHERE id = ?",
    ).run("finance-owner");
    const consumed = creditUsage(db, {
      id: "revoked-owner-credit",
      tenantId: "tenant_default",
      idempotencyKey: "revoked-owner-credit",
      taskId: "finance-lifecycle-task",
      mcuMicrosDelta: -1,
      invoiceReference: "invoice-a",
      reason: "approval before revocation",
      actorPrincipalId: "finance-owner",
      financeAuthorizationId: authorization.id,
      financeAuthorizationDigest: authorization.authorizationDigest,
      createdAt: "2026-08-01T12:02:00.000Z",
    });
    expect(reconcileUsageLedger(db, "tenant_default")).toMatchObject({ ok: true });
    db.raw.exec("DROP TRIGGER usage_finance_authorizations_guard_update");
    db.raw.prepare(
      "UPDATE usage_finance_authorizations SET consumed_entry_id = ? WHERE id = ?",
    ).run("finance-lifecycle-settlement", authorization.id);
    expect(reconcileUsageLedger(db, "tenant_default")).toMatchObject({
      ok: false,
      error: `usage_finance_authorization_invalid:${consumed.id}`,
    });
  });
});
