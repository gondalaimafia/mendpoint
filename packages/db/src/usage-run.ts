import { newId } from "@mendpoint/shared";
import type { AppDb } from "./index.js";
import type { UsageLedgerEntry } from "./usage.js";
import {
  releaseUsageReservation,
  reserveUsage,
  settleUsageReservation,
} from "./usage.js";

/**
 * Run-lifecycle usage helpers.
 *
 * These wrap the tenant MCU ledger (packages/db/src/usage.ts) with deterministic
 * idempotency keys so the reserve/settle/release lifecycle of a single product run
 * can be driven from two processes (the API admits/cancels, the worker settles or
 * releases on completion) without double-counting. The underlying ledger functions
 * remain the single source of truth for quota and hash-chain integrity; nothing here
 * fabricates usage.
 *
 * 1 MCU = 1_000_000 micros. Kept local so this module does not depend on the
 * platform package (which is downstream of @mendpoint/db).
 */
export const MCU_MICROS = 1_000_000;

/**
 * Deterministic, honest MCU estimate for a run computed from its declared scope.
 *
 * A run reserves a ceiling before doing work. The estimate is NOT measured usage:
 * it is a documented, configurable, indicative hold that is later settled to the
 * measured actual where a measurement exists, or to this reserved estimate where
 * no per-run MCU measurement exists (see docs/USAGE_ENFORCEMENT.md). All values are
 * fixed constants so the estimate is fully deterministic for a given scope.
 */
export const RUN_MCU_ESTIMATE = Object.freeze({
  /** Floor charged to admit any run at all. */
  baseMcuMicros: MCU_MICROS,
  /** Added per declared target (e.g. per consumer repo processed by a fanout). */
  perTargetMcuMicros: MCU_MICROS,
  /** Upper bound so a pathological scope cannot reserve an unbounded hold. */
  maxTargets: 500,
});

export function estimateRunMcuMicros(scope: { targetCount: number }): number {
  const raw = Number.isFinite(scope.targetCount) ? Math.floor(scope.targetCount) : 0;
  const targets = Math.max(1, Math.min(RUN_MCU_ESTIMATE.maxTargets, raw < 1 ? 1 : raw));
  return RUN_MCU_ESTIMATE.baseMcuMicros + RUN_MCU_ESTIMATE.perTargetMcuMicros * targets;
}

/** Payload keys a reserved run carries so the worker can settle or release it. */
export const RUN_USAGE_RESERVATION_KEY = "usageReservationId";
export const RUN_USAGE_RESERVED_MCU_KEY = "usageReservedMcuMicros";

function runAdmissionKey(runId: string): string {
  return `run-admission:${runId}`;
}

function runSettleKey(reservationId: string): string {
  return `run-settle:${reservationId}`;
}

function runReleaseKey(reservationId: string): string {
  return `run-release:${reservationId}`;
}

/**
 * Reserve the run's estimated MCU ceiling at admission. Throws the ledger's honest
 * errors unchanged: `usage_entitlement_required` (tenant has no active plan) or
 * `usage_quota_exceeded` (hold would exceed the entitlement).
 */
export function reserveRunUsage(
  db: AppDb,
  input: {
    tenantId: string;
    runId: string;
    mcuMicros: number;
    reason: string;
    campaignId?: string | null;
    actorPrincipalId?: string | null;
    createdAt: string;
  },
): UsageLedgerEntry {
  return reserveUsage(db, {
    id: newId(),
    tenantId: input.tenantId,
    idempotencyKey: runAdmissionKey(input.runId),
    taskId: input.runId,
    campaignId: input.campaignId ?? null,
    mcuMicros: input.mcuMicros,
    reason: input.reason,
    actorPrincipalId: input.actorPrincipalId ?? null,
    createdAt: input.createdAt,
  });
}

/** Settle a run's reservation to its measured (or reserved-estimate) actual. */
export function settleRunUsage(
  db: AppDb,
  input: {
    tenantId: string;
    reservationId: string;
    actualMcuMicros: number;
    reason: string;
    invoiceReference?: string | null;
    actorPrincipalId?: string | null;
    createdAt: string;
  },
): UsageLedgerEntry {
  return settleUsageReservation(db, {
    id: newId(),
    tenantId: input.tenantId,
    idempotencyKey: runSettleKey(input.reservationId),
    reservationId: input.reservationId,
    actualMcuMicros: input.actualMcuMicros,
    invoiceReference: input.invoiceReference ?? null,
    reason: input.reason,
    actorPrincipalId: input.actorPrincipalId ?? null,
    createdAt: input.createdAt,
  });
}

/** Release a run's outstanding hold (infra failure or cancel: burns no quota). */
export function releaseRunUsage(
  db: AppDb,
  input: {
    tenantId: string;
    reservationId: string;
    reason: string;
    actorPrincipalId?: string | null;
    createdAt: string;
  },
): UsageLedgerEntry {
  return releaseUsageReservation(db, {
    id: newId(),
    tenantId: input.tenantId,
    idempotencyKey: runReleaseKey(input.reservationId),
    reservationId: input.reservationId,
    reason: input.reason,
    actorPrincipalId: input.actorPrincipalId ?? null,
    createdAt: input.createdAt,
  });
}
