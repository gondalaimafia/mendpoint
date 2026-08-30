import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adjustUsage,
  createDb,
  createInvoiceExport,
  createUsageEntitlement,
  createUsagePriceVersion,
  creditUsage,
  getInvoiceExport,
  insertPrincipal,
  insertTenant,
  reconcileInvoiceExport,
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
      subject: `finance-${tenant}@example.test`,
      displayName: `Finance ${tenant}`,
      createdAt: PERIOD_START,
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
    reason: "accepted work",
    actorPrincipalId: "actor-a",
    createdAt: "2026-08-10T10:01:00.000Z",
  });
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

describe("signed invoice exports", () => {
  it("derives and signs immutable exact-price lines, replays once, and reconciles", () => {
    const { db } = open();
    seed(db);
    creditUsage(db, {
      id: "credit-a",
      tenantId: "tenant-a",
      idempotencyKey: "credit-a",
      taskId: "task-a",
      campaignId: "campaign-a",
      mcuMicrosDelta: -500_000,
      reason: "service credit",
      actorPrincipalId: "actor-a",
      createdAt: "2026-08-15T00:00:00.000Z",
    });
    adjustUsage(db, {
      id: "refund-a",
      tenantId: "tenant-a",
      idempotencyKey: "refund-a",
      taskId: "task-a",
      campaignId: "campaign-a",
      mcuMicrosDelta: -250_000,
      reason: "customer refund",
      actorPrincipalId: "actor-a",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    adjustUsage(db, {
      id: "adjustment-a",
      tenantId: "tenant-a",
      idempotencyKey: "adjustment-a",
      taskId: "task-a",
      campaignId: "campaign-a",
      mcuMicrosDelta: 250_000,
      reason: "late measured usage correction",
      actorPrincipalId: "actor-a",
      createdAt: "2026-08-21T00:00:00.000Z",
    });

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
      "refund",
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

  it("rejects changed replay, cross-tenant authority, missing signing authority, and invalid tax", () => {
    const { db } = open();
    seed(db);
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
    }))).toThrow("invoice_export_price_contract_mismatch");
    expect(() => createInvoiceExport(db, createInput({
      id: "invoice-open-period",
      idempotencyKey: "open-period",
      issuedAt: "2026-08-31T23:59:59.000Z",
    }))).toThrow("invoice_export_period_open");
  });

  it("prevents a source entry from appearing on a second signed invoice", () => {
    const { db } = open();
    seed(db);
    createInvoiceExport(db, createInput());
    expect(() => createInvoiceExport(db, createInput({
      id: "invoice-a-duplicate",
      idempotencyKey: "invoice-request-a-duplicate",
    }))).toThrow("invoice_export_source_already_invoiced");
  });

  it("detects late ledger changes, tampering, and invalid or replayed state transitions", () => {
    const { db } = open();
    seed(db);
    createInvoiceExport(db, createInput());
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

    creditUsage(db, {
      id: "late-credit",
      tenantId: "tenant-a",
      idempotencyKey: "late-credit",
      taskId: "task-a",
      mcuMicrosDelta: -100_000,
      reason: "late refund",
      actorPrincipalId: "actor-a",
      createdAt: "2026-08-31T23:59:00.000Z",
    });
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
});
