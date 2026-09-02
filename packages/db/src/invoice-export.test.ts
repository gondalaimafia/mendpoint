import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adjustUsage,
  createDb,
  createInvoiceExport,
  createUsageEntitlement,
  createUsageFinanceAuthorization,
  createUsagePriceVersion,
  creditUsage,
  getInvoiceExport,
  insertPrincipal,
  insertTenant,
  putTenantMembership,
  reconcileInvoiceExport,
  reconcileGrossMargin,
  reconcileUsageLedger,
  reserveUsage,
  settleUsageReservation,
  transitionInvoiceExportState,
  type AppDb,
  type InvoiceExportSigner,
} from "./index.js";

const PERIOD_START = "2026-08-01T00:00:00.000Z";
const PERIOD_END = "2026-09-01T00:00:00.000Z";
const ISSUED_AT = "2026-09-02T12:00:00.000Z";
const directories: string[] = [];
const databases: AppDb[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.raw.close();
  while (directories.length) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function open(name = "invoice.sqlite") {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-invoice-"));
  directories.push(directory);
  const path = join(directory, name);
  const db = createDb(path);
  databases.push(db);
  return { db, path };
}

function hmacSigner(authorized = true): InvoiceExportSigner {
  const secret = "test-only-invoice-signing-secret";
  return Object.freeze({
    keyId: "invoice-key-1",
    authorize: ({ tenantId, actorPrincipalId }) =>
      authorized && actorPrincipalId === `actor-${tenantId.at(-1)}`,
    sign: (payload) => createHmac("sha256", secret).update(payload).digest("hex"),
    verifyForKey: (keyId, payload, signature) =>
      keyId === "invoice-key-1" &&
      createHmac("sha256", secret).update(payload).digest("hex") === signature,
  });
}

function seed(db: AppDb) {
  for (const tenant of ["tenant-a", "tenant-b"]) {
    insertTenant(db, {
      id: tenant,
      slug: tenant,
      name: tenant,
      createdAt: PERIOD_START,
    });
    insertPrincipal(db, {
      id: `actor-${tenant.at(-1)}`,
      tenantId: tenant,
      kind: "human",
      subject: `https://identity.example.test|finance-${tenant}`,
      displayName: `Finance ${tenant}`,
      audience: "https://identity.example.test",
      createdAt: PERIOD_START,
    });
    putTenantMembership(db, {
      tenantId: tenant,
      issuer: "https://identity.example.test",
      subject: `finance-${tenant}`,
      email: `finance-${tenant}@example.test`,
      displayName: `Finance ${tenant}`,
      role: "owner",
      status: "active",
      updatedAt: PERIOD_START,
    });
    createUsagePriceVersion(db, {
      id: `price-${tenant}`,
      tenantId: tenant,
      formulaVersion: "mcu-v1",
      currency: "USD",
      pricePerMcuMoneyMicros: 20_000,
      effectiveAt: PERIOD_START,
      expiresAt: PERIOD_END,
      contractReference: `contract-${tenant}`,
      createdAt: PERIOD_START,
    });
    createUsageEntitlement(db, {
      id: `entitlement-${tenant}`,
      tenantId: tenant,
      priceVersionId: `price-${tenant}`,
      quotaMcuMicros: 20_000_000,
      features: ["fettler", "regauge"],
      contractReference: `contract-${tenant}`,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      createdAt: PERIOD_START,
    });
  }
  const reservation = reserveUsage(db, {
    id: "reservation-a",
    tenantId: "tenant-a",
    idempotencyKey: "reserve-a",
    taskId: "task-a",
    campaignId: "campaign-a",
    mcuMicros: 5_000_000,
    reason: "bounded work",
    actorPrincipalId: "actor-a",
    createdAt: "2026-08-10T10:00:00.000Z",
  });
  settleUsageReservation(db, {
    id: "settlement-a",
    tenantId: "tenant-a",
    idempotencyKey: "settle-a",
    reservationId: reservation.id,
    actualMcuMicros: 4_000_000,
    invoiceReference: "invoice-a",
    reason: "accepted work",
    actorPrincipalId: "actor-a",
    createdAt: "2026-08-10T10:01:00.000Z",
  });
}

function financeAuthorization(db: AppDb, input: {
  entryType: "adjustment" | "credit";
  idempotencyKey: string;
  mcuMicrosDelta: number;
  reason: string;
  createdAt: string;
}) {
  const authorization = createUsageFinanceAuthorization(db, {
    id: `finance-${input.idempotencyKey}`,
    tenantId: "tenant-a",
    approvedByPrincipalId: "actor-a",
    actorPrincipalId: "actor-a",
    entryType: input.entryType,
    invoiceReference: "invoice-a",
    entryIdempotencyKey: input.idempotencyKey,
    mcuMicrosDelta: input.mcuMicrosDelta,
    reason: input.reason,
    approvedAt: "2026-08-10T10:01:30.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
  });
  return {
    invoiceReference: "invoice-a",
    financeAuthorizationId: authorization.id,
    financeAuthorizationDigest: authorization.authorizationDigest,
  };
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "invoice-a",
    tenantId: "tenant-a",
    idempotencyKey: "invoice-request-a",
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    currency: "USD",
    contractReference: "contract-tenant-a",
    tax: {
      basisPoints: 825,
      jurisdiction: "US-IL",
      policyVersion: "tax-policy-2026-08",
    },
    actorPrincipalId: "actor-a",
    issuedAt: ISSUED_AT,
    signer: hmacSigner(),
    ...overrides,
  };
}

function legacyUsageEntryHash(input: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

describe("signed invoice exports", () => {
  it("derives and signs immutable exact-price lines, replays once, and reconciles", () => {
    const { db } = open();
    seed(db);
    const creditInput = {
      id: "credit-a",
      tenantId: "tenant-a",
      idempotencyKey: "credit-a",
      taskId: "task-a",
      campaignId: "campaign-a",
      mcuMicrosDelta: -500_000,
      reason: "service credit",
      actorPrincipalId: "actor-a",
      createdAt: "2026-08-15T00:00:00.000Z",
    } as const;
    creditUsage(db, { ...creditInput, ...financeAuthorization(db, {
      entryType: "credit", ...creditInput,
    }) });
    const refundInput = {
      id: "refund-a",
      tenantId: "tenant-a",
      idempotencyKey: "refund-a",
      taskId: "task-a",
      campaignId: "campaign-a",
      mcuMicrosDelta: -250_000,
      reason: "customer refund",
      actorPrincipalId: "actor-a",
      createdAt: "2026-08-20T00:00:00.000Z",
    } as const;
    creditUsage(db, { ...refundInput, ...financeAuthorization(db, {
      entryType: "credit", ...refundInput,
    }) });
    const adjustmentInput = {
      id: "adjustment-a",
      tenantId: "tenant-a",
      idempotencyKey: "adjustment-a",
      taskId: "task-a",
      campaignId: "campaign-a",
      mcuMicrosDelta: 250_000,
      reason: "late measured usage correction",
      actorPrincipalId: "actor-a",
      createdAt: "2026-08-21T00:00:00.000Z",
    } as const;
    adjustUsage(db, { ...adjustmentInput, ...financeAuthorization(db, {
      entryType: "adjustment", ...adjustmentInput,
    }) });

    const invoice = createInvoiceExport(db, createInput());
    expect(invoice).toMatchObject({
      id: "invoice-a",
      tenantId: "tenant-a",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      currency: "USD",
      contractReference: "contract-tenant-a",
      subtotalMoneyMicros: 70_000,
      taxMoneyMicros: 5_775,
      totalMoneyMicros: 75_775,
      signingKeyId: "invoice-key-1",
      state: "issued",
    });
    expect(invoice.lines.map((line) => line.kind)).toEqual([
      "usage",
      "credit",
      "credit",
      "adjustment",
    ]);
    expect(invoice.lines.map((line) => line.priceVersionId)).toEqual([
      "price-tenant-a",
      "price-tenant-a",
      "price-tenant-a",
      "price-tenant-a",
    ]);
    expect(invoice.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(createInvoiceExport(db, { ...createInput(), issuedAt: "2026-09-03T00:00:00.000Z" }))
      .toEqual(invoice);
    expect(getInvoiceExport(db, "tenant-b", invoice.id)).toBeNull();
    expect(reconcileInvoiceExport(db, "tenant-a", invoice.id, hmacSigner())).toMatchObject({
      complete: true,
      usageChain: { ok: true },
      lineSums: { ok: true },
      payload: { ok: true },
      signature: { ok: true },
      stateEvents: { ok: true },
      issues: [],
    });
    expect(() => db.raw.prepare(
      "UPDATE invoice_export_lines SET money_micros = 1 WHERE invoice_id = 'invoice-a'",
    ).run()).toThrow("invoice_export_lines_append_only");
  });

  it("exports every split credit as a non-positive credit while preserving exact multi-price money", () => {
    const { db } = open();
    seed(db);
    createUsagePriceVersion(db, {
      id: "price-tenant-a-later",
      tenantId: "tenant-a",
      formulaVersion: "mcu-v1",
      currency: "USD",
      pricePerMcuMoneyMicros: 30_000,
      effectiveAt: "2026-08-15T00:00:00.000Z",
      expiresAt: PERIOD_END,
      contractReference: "contract-tenant-a",
      createdAt: "2026-08-15T00:00:00.000Z",
    });
    createUsageEntitlement(db, {
      id: "entitlement-tenant-a-later",
      tenantId: "tenant-a",
      priceVersionId: "price-tenant-a-later",
      quotaMcuMicros: 20_000_000,
      features: ["fettler"],
      contractReference: "contract-tenant-a",
      periodStart: "2026-08-15T00:00:00.000Z",
      periodEnd: PERIOD_END,
      createdAt: "2026-08-15T00:00:00.000Z",
    });
    const laterReservation = reserveUsage(db, {
      id: "reservation-a-later",
      tenantId: "tenant-a",
      idempotencyKey: "reserve-a-later",
      taskId: "task-a",
      campaignId: "campaign-a",
      mcuMicros: 2_000_000,
      reason: "later price allocation",
      actorPrincipalId: "actor-a",
      createdAt: "2026-08-20T10:00:00.000Z",
    });
    settleUsageReservation(db, {
      id: "settlement-a-later",
      tenantId: "tenant-a",
      idempotencyKey: "settle-a-later",
      reservationId: laterReservation.id,
      actualMcuMicros: 2_000_000,
      invoiceReference: "invoice-a",
      reason: "later price settlement",
      actorPrincipalId: "actor-a",
      createdAt: "2026-08-20T10:01:00.000Z",
    });
    const creditInput = {
      id: "credit-a-split",
      tenantId: "tenant-a",
      idempotencyKey: "credit-a-split",
      taskId: "task-a",
      campaignId: "campaign-a",
      mcuMicrosDelta: -5_000_000,
      reason: "multi-price service credit",
      actorPrincipalId: "actor-a",
      createdAt: "2026-08-21T00:00:00.000Z",
    } as const;
    creditUsage(db, {
      ...creditInput,
      ...financeAuthorization(db, { entryType: "credit", ...creditInput }),
    });

    const invoice = createInvoiceExport(db, createInput());
    const creditLines = invoice.lines.filter((line) => line.kind === "credit");
    expect(creditLines).toHaveLength(2);
    expect(creditLines.every((line) => line.mcuMicros < 0 && line.moneyMicros < 0)).toBe(true);
    expect(invoice.lines.filter((line) => line.mcuMicros > 0 && line.kind !== "usage")
      .every((line) => line.kind === "adjustment")).toBe(true);
    expect(invoice.subtotalMoneyMicros).toBe(30_000);
    expect(reconcileInvoiceExport(db, "tenant-a", invoice.id, hmacSigner())).toMatchObject({
      complete: true,
      usageChain: { ok: true },
    });
  });

  it("rejects changed replay, cross-tenant authority, missing signing authority, and invalid tax", () => {
    const { db } = open();
    seed(db);
    db.raw.prepare("UPDATE principals SET expires_at = ? WHERE id = ?")
      .run("2026-09-02T11:59:59.000Z", "actor-a");
    expect(() => createInvoiceExport(db, createInput({
      id: "invoice-expired-actor",
      idempotencyKey: "expired-actor",
    }))).toThrow("invoice_export_actor_inactive");
    db.raw.prepare("UPDATE principals SET expires_at = NULL, created_at = ? WHERE id = ?")
      .run("2026-09-02T12:00:01.000Z", "actor-a");
    expect(() => createInvoiceExport(db, createInput({
      id: "invoice-future-actor",
      idempotencyKey: "future-actor",
    }))).toThrow("invoice_export_actor_inactive");
    db.raw.prepare("UPDATE principals SET created_at = ? WHERE id = ?")
      .run(PERIOD_START, "actor-a");
    expect(() => createInvoiceExport(db, createInput({
      id: "invoice-bad-signature",
      idempotencyKey: "bad-signature",
      signer: { ...hmacSigner(), verifyForKey: () => false },
    }))).toThrow("invoice_export_signature_invalid");
    createInvoiceExport(db, createInput());
    expect(() => createInvoiceExport(db, createInput({
      tax: { basisPoints: 0, jurisdiction: "US-IL", policyVersion: "tax-policy-2026-08" },
    }))).toThrow("invoice_export_idempotency_conflict");
    expect(() => createInvoiceExport(db, createInput({
      tenantId: "tenant-b",
      actorPrincipalId: "actor-b",
      contractReference: "contract-tenant-b",
      idempotencyKey: "invoice-b",
    }))).toThrow("invoice_export_id_tenant_mismatch");
    expect(() => createInvoiceExport(db, createInput({ signer: undefined })))
      .toThrow("invoice_export_signer_required");
    expect(() => createInvoiceExport(db, createInput({ id: "invoice-denied", idempotencyKey: "denied", signer: hmacSigner(false) })))
      .toThrow("invoice_export_signing_not_authorized");
    expect(() => createInvoiceExport(db, createInput({ id: "invoice-tax", idempotencyKey: "tax", tax: undefined })))
      .toThrow("invoice_export_tax_required");
    expect(() => createInvoiceExport(db, createInput({
      id: "invoice-tax-precision",
      idempotencyKey: "tax-precision",
      tax: { basisPoints: 1.5, jurisdiction: "US-IL", policyVersion: "tax-policy-invalid" },
    }))).toThrow("invoice_export_tax_basis_points_invalid");
    expect(() => createInvoiceExport(db, createInput({
      id: "invoice-currency",
      idempotencyKey: "currency",
      currency: "EUR",
    }))).toThrow("invoice_export_usage_required");
    expect(() => createInvoiceExport(db, createInput({
      id: "invoice-open-period",
      idempotencyKey: "open-period",
      issuedAt: "2026-08-31T23:59:59.000Z",
    }))).toThrow("invoice_export_period_open");
  });

  it("prevents a source entry from appearing on a second signed invoice", () => {
    const { db } = open();
    seed(db);
    createUsagePriceVersion(db, {
      id: "price-tenant-a-eur",
      tenantId: "tenant-a",
      formulaVersion: "mcu-v1",
      currency: "EUR",
      pricePerMcuMoneyMicros: 30_000,
      effectiveAt: PERIOD_START,
      expiresAt: PERIOD_END,
      contractReference: "contract-tenant-a-eur",
      createdAt: PERIOD_START,
    });
    createUsageEntitlement(db, {
      id: "entitlement-tenant-a-eur",
      tenantId: "tenant-a",
      priceVersionId: "price-tenant-a-eur",
      quotaMcuMicros: 20_000_000,
      features: ["fettler"],
      contractReference: "contract-tenant-a-eur",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      createdAt: PERIOD_START,
    });
    const euroReservation = reserveUsage(db, {
      id: "reservation-a-eur",
      tenantId: "tenant-a",
      idempotencyKey: "reserve-a-eur",
      taskId: "task-a-eur",
      mcuMicros: 2_000_000,
      reason: "bounded euro work",
      actorPrincipalId: "actor-a",
      createdAt: "2026-08-11T10:00:00.000Z",
    });
    settleUsageReservation(db, {
      id: "settlement-a-eur",
      tenantId: "tenant-a",
      idempotencyKey: "settle-a-eur",
      reservationId: euroReservation.id,
      actualMcuMicros: 1_000_000,
      reason: "accepted euro work",
      actorPrincipalId: "actor-a",
      createdAt: "2026-08-11T10:01:00.000Z",
    });

    const usdInvoice = createInvoiceExport(db, createInput());
    expect(usdInvoice.lines.map((line) => line.usageEntryId)).toEqual(["settlement-a"]);
    const euroInvoice = createInvoiceExport(db, createInput({
      id: "invoice-a-eur",
      idempotencyKey: "invoice-request-a-eur",
      currency: "EUR",
      contractReference: "contract-tenant-a-eur",
    }));
    expect(euroInvoice.lines.map((line) => line.usageEntryId)).toEqual(["settlement-a-eur"]);
    expect(() => createInvoiceExport(db, createInput({
      id: "invoice-a-duplicate",
      idempotencyKey: "invoice-request-a-duplicate",
    }))).toThrow("invoice_export_source_already_invoiced");
  });

  it("detects late ledger changes, tampering, and invalid or replayed state transitions", () => {
    const { db } = open();
    seed(db);
    createInvoiceExport(db, createInput());
    db.raw.prepare("UPDATE principals SET expires_at = ? WHERE id = ?")
      .run("2026-09-02T12:04:59.000Z", "actor-a");
    expect(() => transitionInvoiceExportState(db, {
      tenantId: "tenant-a",
      invoiceId: "invoice-a",
      idempotencyKey: "state-expired-actor",
      state: "exported",
      policyVersion: "dunning-policy-v1",
      reason: "expired actor cannot export",
      actorPrincipalId: "actor-a",
      occurredAt: "2026-09-02T12:05:00.000Z",
      authority: hmacSigner(),
    })).toThrow("invoice_export_actor_inactive");
    db.raw.prepare("UPDATE principals SET expires_at = NULL WHERE id = ?").run("actor-a");
    const exported = transitionInvoiceExportState(db, {
      tenantId: "tenant-a",
      invoiceId: "invoice-a",
      idempotencyKey: "state-exported",
      state: "exported",
      policyVersion: "dunning-policy-v1",
      reason: "exported to approved finance channel",
      actorPrincipalId: "actor-a",
      occurredAt: "2026-09-02T12:05:00.000Z",
      authority: hmacSigner(),
    });
    expect(exported.state).toBe("exported");
    expect(transitionInvoiceExportState(db, {
      tenantId: "tenant-a",
      invoiceId: "invoice-a",
      idempotencyKey: "state-exported",
      state: "exported",
      policyVersion: "dunning-policy-v1",
      reason: "exported to approved finance channel",
      actorPrincipalId: "actor-a",
      occurredAt: "2026-09-03T00:00:00.000Z",
      authority: hmacSigner(),
    })).toEqual(exported);
    expect(() => transitionInvoiceExportState(db, {
      tenantId: "tenant-a",
      invoiceId: "invoice-a",
      idempotencyKey: "state-exported",
      state: "exported",
      policyVersion: "dunning-policy-v2",
      reason: "changed replay",
      actorPrincipalId: "actor-a",
      occurredAt: "2026-09-03T00:00:00.000Z",
      authority: hmacSigner(),
    })).toThrow("invoice_export_state_idempotency_conflict");
    transitionInvoiceExportState(db, {
      tenantId: "tenant-a",
      invoiceId: "invoice-a",
      idempotencyKey: "state-acknowledged",
      state: "acknowledged",
      policyVersion: "dunning-policy-v1",
      reason: "customer acknowledged export",
      actorPrincipalId: "actor-a",
      occurredAt: "2026-09-03T00:00:00.000Z",
      authority: hmacSigner(),
    });
    transitionInvoiceExportState(db, {
      tenantId: "tenant-a",
      invoiceId: "invoice-a",
      idempotencyKey: "state-overdue",
      state: "overdue",
      policyVersion: "dunning-policy-v1",
      reason: "approved due date passed",
      actorPrincipalId: "actor-a",
      occurredAt: "2026-10-03T00:00:00.000Z",
      authority: hmacSigner(),
    });
    const resolved = transitionInvoiceExportState(db, {
      tenantId: "tenant-a",
      invoiceId: "invoice-a",
      idempotencyKey: "state-resolved",
      state: "resolved",
      policyVersion: "dunning-policy-v1",
      reason: "finance reconciliation resolved",
      actorPrincipalId: "actor-a",
      occurredAt: "2026-10-04T00:00:00.000Z",
      authority: hmacSigner(),
    });
    expect(resolved.stateHistory.map((event) => event.state)).toEqual([
      "issued",
      "exported",
      "acknowledged",
      "overdue",
      "resolved",
    ]);
    expect(() => transitionInvoiceExportState(db, {
      tenantId: "tenant-a",
      invoiceId: "invoice-a",
      idempotencyKey: "state-changed-replay",
      state: "issued",
      policyVersion: "dunning-policy-v1",
      reason: "invalid reversal",
      actorPrincipalId: "actor-a",
      occurredAt: "2026-09-03T00:00:00.000Z",
      authority: hmacSigner(),
    })).toThrow("invoice_export_state_transition_invalid");
    expect(() => transitionInvoiceExportState(db, {
      tenantId: "tenant-b",
      invoiceId: "invoice-a",
      idempotencyKey: "state-cross-tenant",
      state: "acknowledged",
      policyVersion: "dunning-policy-v1",
      reason: "cross tenant",
      actorPrincipalId: "actor-b",
      occurredAt: "2026-09-03T00:00:00.000Z",
      authority: hmacSigner(),
    })).toThrow("invoice_export_not_found");

    const lateCreditInput = {
      id: "late-credit",
      tenantId: "tenant-a",
      idempotencyKey: "late-credit",
      taskId: "task-a",
      mcuMicrosDelta: -100_000,
      reason: "late refund",
      actorPrincipalId: "actor-a",
      createdAt: "2026-08-31T23:59:00.000Z",
    } as const;
    creditUsage(db, { ...lateCreditInput, ...financeAuthorization(db, {
      entryType: "credit", ...lateCreditInput,
    }) });
    expect(() => createInvoiceExport(db, createInput()))
      .toThrow("invoice_export_idempotency_conflict");

    db.raw.exec("DROP TRIGGER invoice_exports_append_only_update");
    db.raw.prepare("UPDATE invoice_exports SET payload_digest = ? WHERE id = ?")
      .run("0".repeat(64), "invoice-a");
    expect(reconcileInvoiceExport(db, "tenant-a", "invoice-a", hmacSigner())).toMatchObject({
      complete: false,
      payload: { ok: false },
      issues: expect.arrayContaining(["invoice_payload_digest_mismatch"]),
    });
    db.raw.exec("DROP TRIGGER invoice_export_state_events_append_only_update");
    db.raw.prepare(
      "UPDATE invoice_export_state_events SET event_hash = ? WHERE invoice_id = ? AND sequence = 2",
    ).run("f".repeat(64), "invoice-a");
    expect(reconcileInvoiceExport(db, "tenant-a", "invoice-a", hmacSigner())).toMatchObject({
      complete: false,
      stateEvents: { ok: false },
      issues: expect.arrayContaining(["invoice_state_event_chain_invalid"]),
    });
  });

  it("converges invoice tables and append-only triggers on fresh and reopened databases", () => {
    const opened = open("upgrade.sqlite");
    expect(opened.db.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'invoice_exports'",
    ).get()).toEqual({ name: "invoice_exports" });
    opened.db.raw.exec(`
      DROP TABLE invoice_export_state_events;
      DROP TABLE invoice_export_lines;
      DROP TABLE invoice_exports;
    `);
    opened.db.raw.close();
    databases.pop();
    const upgraded = createDb(opened.path);
    databases.push(upgraded);
    const objects = upgraded.raw.prepare(
      "SELECT name FROM sqlite_master WHERE name LIKE 'invoice_export%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(objects.map((row) => row.name)).toEqual(expect.arrayContaining([
      "invoice_exports",
      "invoice_export_lines",
      "invoice_export_state_events",
      "invoice_exports_append_only_update",
      "invoice_export_lines_append_only_update",
      "invoice_export_state_events_append_only_update",
    ]));
    expect(upgraded.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("migrates legacy adjustment and credit rows as explicit unverified authority without rewriting bytes", () => {
    const opened = open("legacy-finance-upgrade.sqlite");
    seed(opened.db);
    const previous = opened.db.raw.prepare(
      `SELECT entry_sequence, entry_hash FROM usage_ledger_entries
       WHERE tenant_id = 'tenant-a' ORDER BY entry_sequence DESC LIMIT 1`,
    ).get() as { entry_sequence: number; entry_hash: string };
    opened.db.raw.exec("PRAGMA foreign_keys = OFF");
    opened.db.raw.exec(`
      DROP TRIGGER usage_ledger_entries_append_only_update;
      DROP TRIGGER usage_ledger_entries_append_only_delete;
      CREATE TABLE usage_ledger_entries_legacy (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        entry_type TEXT NOT NULL CHECK (
          entry_type IN ('reservation', 'settlement', 'release', 'adjustment', 'credit')
        ),
        entitlement_id TEXT NOT NULL REFERENCES usage_entitlements(id),
        idempotency_key TEXT NOT NULL,
        task_id TEXT NOT NULL,
        campaign_id TEXT,
        reservation_id TEXT REFERENCES usage_ledger_entries_legacy(id),
        price_version TEXT NOT NULL,
        reserved_mcu_micros_delta INTEGER NOT NULL,
        consumed_mcu_micros_delta INTEGER NOT NULL,
        invoice_reference TEXT,
        reason TEXT NOT NULL,
        actor_principal_id TEXT,
        entry_sequence INTEGER NOT NULL,
        prev_hash TEXT,
        entry_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (tenant_id, idempotency_key),
        UNIQUE (tenant_id, entry_sequence)
      );
      INSERT INTO usage_ledger_entries_legacy
        (id, tenant_id, entry_type, entitlement_id, idempotency_key, task_id, campaign_id,
         reservation_id, price_version, reserved_mcu_micros_delta, consumed_mcu_micros_delta,
         invoice_reference, reason, actor_principal_id, entry_sequence, prev_hash, entry_hash,
         created_at)
      SELECT id, tenant_id, entry_type, entitlement_id, idempotency_key, task_id, campaign_id,
             reservation_id, price_version, reserved_mcu_micros_delta, consumed_mcu_micros_delta,
             invoice_reference, reason, actor_principal_id, entry_sequence, prev_hash, entry_hash,
             created_at
        FROM usage_ledger_entries;
      DROP TABLE usage_ledger_entries;
      ALTER TABLE usage_ledger_entries_legacy RENAME TO usage_ledger_entries;
      DROP TABLE usage_finance_authorizations;
    `);
    const adjustment = {
      id: "legacy-adjustment-a",
      tenantId: "tenant-a",
      entrySequence: previous.entry_sequence + 1,
      entryType: "adjustment",
      entitlementId: "entitlement-tenant-a",
      idempotencyKey: "legacy-adjustment-a",
      taskId: "task-a",
      campaignId: "campaign-a",
      reservationId: null,
      priceVersion: "price-tenant-a",
      reservedDelta: 0,
      consumedDelta: 250_000,
      invoiceReference: "invoice-a",
      reason: "legacy measured correction",
      actorPrincipalId: "actor-a",
      previousHash: previous.entry_hash,
      createdAt: "2026-08-11T00:00:00.000Z",
    } as const;
    const adjustmentHash = legacyUsageEntryHash(adjustment);
    const credit = {
      ...adjustment,
      id: "legacy-credit-a",
      entrySequence: adjustment.entrySequence + 1,
      entryType: "credit",
      idempotencyKey: "legacy-credit-a",
      consumedDelta: -100_000,
      reason: "legacy customer credit",
      previousHash: adjustmentHash,
      createdAt: "2026-08-12T00:00:00.000Z",
    } as const;
    const insertLegacy = opened.db.raw.prepare(`
      INSERT INTO usage_ledger_entries
        (id, tenant_id, entry_type, entitlement_id, idempotency_key, task_id, campaign_id,
         reservation_id, price_version, reserved_mcu_micros_delta, consumed_mcu_micros_delta,
         invoice_reference, reason, actor_principal_id, entry_sequence, prev_hash, entry_hash,
         created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of [
      { ...adjustment, entryHash: adjustmentHash },
      { ...credit, entryHash: legacyUsageEntryHash(credit) },
    ]) {
      insertLegacy.run(
        entry.id,
        entry.tenantId,
        entry.entryType,
        entry.entitlementId,
        entry.idempotencyKey,
        entry.taskId,
        entry.campaignId,
        entry.reservationId,
        entry.priceVersion,
        entry.reservedDelta,
        entry.consumedDelta,
        entry.invoiceReference,
        entry.reason,
        entry.actorPrincipalId,
        entry.entrySequence,
        entry.previousHash,
        entry.entryHash,
        entry.createdAt,
      );
    }
    opened.db.raw.close();
    databases.pop();

    const upgraded = createDb(opened.path);
    databases.push(upgraded);
    expect(upgraded.raw.prepare(
      `SELECT entry_id, authority_status, entry_hash
       FROM usage_legacy_finance_evidence ORDER BY entry_id`,
    ).all()).toEqual([
      {
        entry_id: "legacy-adjustment-a",
        authority_status: "legacy_unverified",
        entry_hash: adjustmentHash,
      },
      {
        entry_id: "legacy-credit-a",
        authority_status: "legacy_unverified",
        entry_hash: legacyUsageEntryHash(credit),
      },
    ]);
    expect(reconcileUsageLedger(upgraded, "tenant-a")).toMatchObject({
      ok: true,
      legacyUnverifiedFinanceEntryIds: ["legacy-adjustment-a", "legacy-credit-a"],
      invoices: { "invoice-a": 4_150_000 },
    });
    const invoice = createInvoiceExport(upgraded, createInput());
    expect(invoice.lines.map((line) => [line.usageEntryId, line.kind, line.moneyMicros])).toEqual([
      ["settlement-a", "usage", 80_000],
      ["legacy-adjustment-a", "adjustment", 5_000],
      ["legacy-credit-a", "credit", -2_000],
    ]);
    expect(reconcileInvoiceExport(upgraded, "tenant-a", invoice.id, hmacSigner())).toMatchObject({
      complete: true,
      usageChain: {
        ok: true,
        legacyUnverifiedFinanceEntryIds: ["legacy-adjustment-a", "legacy-credit-a"],
      },
    });
    expect(reconcileGrossMargin(upgraded, "tenant-a")).toMatchObject({
      usageIntegrity: {
        ok: true,
        legacyUnverifiedFinanceEntryIds: ["legacy-adjustment-a", "legacy-credit-a"],
      },
      adjustedMcuMicros: 250_000,
      creditedMcuMicros: 100_000,
      netRevenueMoneyMicros: 83_000,
    });
  });
});
