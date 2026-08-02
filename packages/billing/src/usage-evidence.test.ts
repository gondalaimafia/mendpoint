import { describe, expect, it } from "vitest";
import { buildReconciledUsageEvidence, type BillableUsageLedgerEntry } from "./usage-evidence.js";

function entry(overrides: Partial<BillableUsageLedgerEntry> = {}): BillableUsageLedgerEntry {
  return {
    id: "settlement-a",
    tenantId: "tenant-a",
    taskId: "task-a",
    priceVersion: "mcu-price-v3",
    consumedMcuMicrosDelta: 4_000_000,
    entryHash: "a".repeat(64),
    createdAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function build(overrides: Partial<Parameters<typeof buildReconciledUsageEvidence>[0]> = {}) {
  return buildReconciledUsageEvidence({
    tenantId: "tenant-a",
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-08-02T00:00:00.000Z",
    priceVersion: "mcu-price-v3",
    currency: "USD",
    entries: [entry()],
    ledgerReconciliation: { ok: true, checked: 1 },
    acceptedTaskIds: ["task-a"],
    ...overrides,
  });
}

describe("usage ledger invoice evidence bridge", () => {
  it("builds exact period evidence from a verified usage ledger", () => {
    expect(build()).toEqual({
      tenantId: "tenant-a",
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-08-02T00:00:00.000Z",
      priceVersion: "mcu-price-v3",
      currency: "USD",
      consumedMcuMicros: 4_000_000,
      ledgerEntryIds: ["settlement-a"],
      ledgerHeadHash: "a".repeat(64),
      ledgerIntegrityOk: true,
      matchedTaskCount: 1,
      unmatchedTaskIds: [],
    });
  });

  it("fails closed on an unverified ledger, unmatched work, or mixed prices", () => {
    expect(() => build({ ledgerReconciliation: { ok: false, checked: 0 } })).toThrow("billing_usage_ledger_unverified");
    expect(build({ acceptedTaskIds: [] }).unmatchedTaskIds).toEqual(["task-a"]);
    expect(() => build({ entries: [entry({ priceVersion: "other" })] })).toThrow("billing_usage_price_mismatch");
  });
});
