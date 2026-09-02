import { describe, expect, it } from "vitest";
import {
  assertMcuScheduleChange,
  calculateMcuV1,
  createMcuLedgerEntry,
  formatMcu,
  MCU_SCHEDULE_DIGEST,
  MCU_MICROS,
  MCU_SCHEDULE_V1,
  mcuScheduleDigest,
  reconcileMcuLedgerLifecycle,
  type McuLedgerEntry,
  type McuLedgerLifecycle,
} from "./mcu.js";

function lifecycle(): McuLedgerLifecycle {
  const entries: McuLedgerEntry[] = [];
  const append = (input: Parameters<typeof createMcuLedgerEntry>[0]) => {
    const entry = createMcuLedgerEntry(input, entries.at(-1) ?? null);
    entries.push(entry);
    return entry;
  };
  const reservation = append({
    tenantId: "tenant-fettler",
    entryType: "reservation",
    entitlementId: "entitlement-1",
    idempotencyKey: "reserve-1",
    taskId: "task-1",
    campaignId: "campaign-a",
    reservationId: null,
    reservedMcuMicrosDelta: 4_000_000,
    consumedMcuMicrosDelta: 0,
    invoiceReference: null,
    actorId: "service-fettler-meter",
    reasonCode: "task_budget_reserved",
    occurredAt: "2026-09-02T00:00:00.000Z",
  });
  append({
    tenantId: "tenant-fettler",
    entryType: "settlement",
    entitlementId: "entitlement-1",
    idempotencyKey: "settle-1",
    taskId: "task-1",
    campaignId: "campaign-a",
    reservationId: reservation.id,
    reservedMcuMicrosDelta: -4_000_000,
    consumedMcuMicrosDelta: 3_000_000,
    invoiceReference: "invoice-1",
    actorId: "service-fettler-meter",
    reasonCode: "task_usage_settled",
    occurredAt: "2026-09-02T00:01:00.000Z",
  });
  append({
    tenantId: "tenant-fettler",
    entryType: "adjustment",
    entitlementId: "entitlement-1",
    idempotencyKey: "adjust-1",
    taskId: "task-1",
    campaignId: "campaign-a",
    reservationId: null,
    reservedMcuMicrosDelta: 0,
    consumedMcuMicrosDelta: 500_000,
    invoiceReference: "invoice-1",
    actorId: "finance-owner",
    reasonCode: "verified_usage_adjustment",
    occurredAt: "2026-09-02T00:02:00.000Z",
  });
  append({
    tenantId: "tenant-fettler",
    entryType: "credit",
    entitlementId: "entitlement-1",
    idempotencyKey: "credit-1",
    taskId: "task-1",
    campaignId: "campaign-a",
    reservationId: null,
    reservedMcuMicrosDelta: 0,
    consumedMcuMicrosDelta: -250_000,
    invoiceReference: "invoice-1",
    actorId: "finance-owner",
    reasonCode: "service_credit",
    occurredAt: "2026-09-02T00:03:00.000Z",
  });
  return {
    scheduleVersion: "mcu-v1",
    scheduleDigest: MCU_SCHEDULE_DIGEST,
    entries,
  };
}

describe("migration compute units", () => {
  it("calculates every v1 component without losing fractional compute", () => {
    expect(
      calculateMcuV1({
        graphObjects: 10_001,
        retrievalBytes: 10_000_001,
        modelCostUsd: 0.025,
        sandboxVcpuMinutes: 1.25,
        sandboxGibMinutes: 1,
        verificationVcpuMinutes: 0.5,
        verificationGibMinutes: 1,
        retainedVerificationBytes: 50_000_000,
      }),
    ).toEqual({
      version: "mcu-v1",
      graphMicros: 2 * MCU_MICROS,
      retrievalMicros: 2 * MCU_MICROS,
      modelMicros: 2.5 * MCU_MICROS,
      sandboxMicros: 1.75 * MCU_MICROS,
      verificationMicros: 1.5 * MCU_MICROS,
      totalMicros: 9.75 * MCU_MICROS,
    });
  });

  it("rejects invalid work and formats ledger precision", () => {
    expect(() => calculateMcuV1({ modelCostUsd: -1 })).toThrow(
      "mcu_model_cost_usd_invalid",
    );
    expect(() => calculateMcuV1({ graphObjects: Number.NaN })).toThrow(
      "mcu_graph_objects_invalid",
    );
    expect(() => calculateMcuV1({ retrievalBytes: Number.POSITIVE_INFINITY })).toThrow(
      "mcu_retrieval_bytes_invalid",
    );
    expect(() => calculateMcuV1({ modelCostUsd: Number.MAX_VALUE })).toThrow(
      "mcu_overflow",
    );
    expect(formatMcu(1_250_000)).toBe("1.25");
    expect(formatMcu(0)).toBe("0");
  });

  it("binds the schedule digest to reservation, settlement, adjustment, credit, and invoice mapping", () => {
    expect(MCU_SCHEDULE_DIGEST).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(mcuScheduleDigest(MCU_SCHEDULE_V1)).toBe(MCU_SCHEDULE_DIGEST);
    expect(reconcileMcuLedgerLifecycle(lifecycle())).toEqual({
      scheduleVersion: "mcu-v1",
      scheduleDigest: MCU_SCHEDULE_DIGEST,
      reservationMcuMicros: 4_000_000,
      settledMcuMicros: 3_000_000,
      adjustmentMcuMicros: 500_000,
      creditedMcuMicros: 250_000,
      outstandingReservationMcuMicros: 0,
      invoiceMappings: [{
        invoiceReference: "invoice-1",
        mcuMicros: 3_250_000,
        sourceEntryIds: lifecycle().entries.slice(1).map((entry) => entry.id),
        settledEntryIds: [lifecycle().entries[1]!.id],
      }],
      reconciled: true,
    });
  });

  it("rejects settlement above the reservation units released by that entry", () => {
    const overSettled = lifecycle();
    overSettled.entries[1] = {
      ...overSettled.entries[1]!,
      consumedMcuMicrosDelta: 10_000_000,
    };
    expect(() => reconcileMcuLedgerLifecycle(overSettled))
      .toThrow("mcu_settlement_exceeds_released_reservation");
  });

  it("binds campaign, schedule formula, price, contiguous sequence, and hash chain", () => {
    const changedCampaign = lifecycle();
    changedCampaign.entries[1] = { ...changedCampaign.entries[1]!, campaignId: "campaign-b" };
    expect(() => reconcileMcuLedgerLifecycle(changedCampaign))
      .toThrow("mcu_ledger_entry_hash_invalid");

    const arbitraryPrice = lifecycle();
    arbitraryPrice.entries[1] = { ...arbitraryPrice.entries[1]!, priceVersion: "price-arbitrary" };
    expect(() => reconcileMcuLedgerLifecycle(arbitraryPrice))
      .toThrow("mcu_ledger_entry_hash_invalid");

    const formulaDrift = lifecycle();
    formulaDrift.entries[1] = { ...formulaDrift.entries[1]!, formulaDigest: `sha256:${"0".repeat(64)}` };
    expect(() => reconcileMcuLedgerLifecycle(formulaDrift))
      .toThrow("mcu_ledger_entry_hash_invalid");

    const sequenceGap = lifecycle();
    sequenceGap.entries[1] = { ...sequenceGap.entries[1]!, entrySequence: 44 };
    expect(() => reconcileMcuLedgerLifecycle(sequenceGap))
      .toThrow("mcu_ledger_entry_hash_invalid");

    const tamperedReason = lifecycle();
    tamperedReason.entries[2] = { ...tamperedReason.entries[2]!, reasonCode: "unattributed" };
    expect(() => reconcileMcuLedgerLifecycle(tamperedReason))
      .toThrow("mcu_ledger_entry_hash_invalid");

    const brokenLink = lifecycle();
    brokenLink.entries[2] = { ...brokenLink.entries[2]!, previousEntryHash: `sha256:${"f".repeat(64)}` };
    expect(() => reconcileMcuLedgerLifecycle(brokenLink))
      .toThrow("mcu_ledger_entry_hash_invalid");
  });

  it("creates reproducible settled entry identities", () => {
    const first = lifecycle();
    const second = lifecycle();
    expect(second.entries.map((entry) => entry.id)).toEqual(first.entries.map((entry) => entry.id));
    expect(second.entries.map((entry) => entry.entryHash))
      .toEqual(first.entries.map((entry) => entry.entryHash));
  });

  it("fails closed for duplicate ledger evidence and schedule mutation without a version change", () => {
    const duplicate = lifecycle();
    duplicate.entries[2] = {
      ...duplicate.entries[2]!,
      idempotencyKey: duplicate.entries[1]!.idempotencyKey,
    };
    expect(() => reconcileMcuLedgerLifecycle(duplicate))
      .toThrow("mcu_ledger_duplicate_idempotency_key");

    const changedSchedule = {
      ...MCU_SCHEDULE_V1,
      weights: {
        ...MCU_SCHEDULE_V1.weights,
        graphObjectsPerMcu: MCU_SCHEDULE_V1.weights.graphObjectsPerMcu + 1,
      },
    };
    expect(mcuScheduleDigest(changedSchedule)).not.toBe(MCU_SCHEDULE_DIGEST);
    expect(() => reconcileMcuLedgerLifecycle({
      ...lifecycle(),
      scheduleDigest: mcuScheduleDigest(changedSchedule),
    })).toThrow("mcu_schedule_changed_without_version");
  });

  it("rejects unsafe ledger arithmetic and incomplete reservation closure", () => {
    const overflow = lifecycle();
    overflow.entries[2] = {
      ...overflow.entries[2]!,
      consumedMcuMicrosDelta: Number.MAX_SAFE_INTEGER,
    };
    expect(() => reconcileMcuLedgerLifecycle(overflow)).toThrow("mcu_ledger_overflow");

    const incomplete = lifecycle();
    incomplete.entries = incomplete.entries.filter((entry) => entry.entryType !== "settlement");
    expect(() => reconcileMcuLedgerLifecycle(incomplete))
      .toThrow("mcu_reservation_not_closed");
  });

  it("requires the reservation to start the ordered lifecycle", () => {
    const outOfOrder = lifecycle();
    [outOfOrder.entries[0], outOfOrder.entries[1]] = [
      outOfOrder.entries[1]!,
      outOfOrder.entries[0]!,
    ];
    outOfOrder.entries[0]!.entrySequence = 1;
    outOfOrder.entries[1]!.entrySequence = 2;

    expect(() => reconcileMcuLedgerLifecycle(outOfOrder))
      .toThrow("mcu_reservation_must_be_first");
  });

  it("publishes executable examples and requires a new finance approved version for changes", () => {
    for (const example of MCU_SCHEDULE_V1.examples) {
      expect(calculateMcuV1(example.work).totalMicros, example.label).toBe(example.expectedMicros);
    }
    expect(Object.isFrozen(MCU_SCHEDULE_V1)).toBe(true);
    expect(Object.isFrozen(MCU_SCHEDULE_V1.weights)).toBe(true);
    expect(() => assertMcuScheduleChange({
      currentVersion: "mcu-v1",
      nextVersion: "mcu-v1",
      approvedByRole: "finance_owner",
      currentVersionHasUsage: true,
    })).toThrow("mcu_new_version_required");
    expect(() => assertMcuScheduleChange({
      currentVersion: "mcu-v1",
      nextVersion: "mcu-v2",
      approvedByRole: "engineer",
      currentVersionHasUsage: true,
    })).toThrow("mcu_finance_approval_required");
    expect(() => assertMcuScheduleChange({
      currentVersion: "mcu-v1",
      nextVersion: "mcu-v2",
      approvedByRole: "finance_owner",
      currentVersionHasUsage: false,
    })).toThrow("mcu_change_without_usage_snapshot");
    expect(() => assertMcuScheduleChange({
      currentVersion: "mcu-v1",
      nextVersion: "mcu-v2",
      approvedByRole: "finance_owner",
      currentVersionHasUsage: true,
    })).not.toThrow();
  });
});
