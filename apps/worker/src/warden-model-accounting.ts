import { createHash } from "node:crypto";
import {
  countActiveWardenModelReservations,
  reserveWardenModelCall,
  settleWardenModelCall,
  type AppDb,
} from "@mendpoint/db";
import type {
  AgentExternalModelAccounting,
  AgentExternalModelReservation,
} from "@mendpoint/agent";

export type WardenModelAccountingRuntimeInput = Readonly<{
  db: AppDb;
  tenantId: string;
  jobId: string;
  runId: string;
  workerId: string;
  leaseGeneration: number;
  provider: string;
  configuredModel: string;
  endpoint: string;
  maximumCallCostUsd: number;
  jobBudgetUsd: number;
  now?: () => string;
}>;

function executionScope(input: WardenModelAccountingRuntimeInput): string {
  return `sha256:${createHash("sha256")
    .update([
      input.tenantId,
      input.jobId,
      input.runId,
      input.workerId,
      String(input.leaseGeneration),
    ].join("\0"), "utf8")
    .digest("hex")}`;
}

function assertReservationProvenance(
  input: WardenModelAccountingRuntimeInput,
  reservation: AgentExternalModelReservation,
): void {
  const endpointHost = new URL(input.endpoint).host;
  if (
    reservation.provider !== input.provider ||
    reservation.configuredModel !== input.configuredModel ||
    reservation.endpointHost !== endpointHost ||
    reservation.maximumCostUsd !== input.maximumCallCostUsd
  ) {
    throw new Error("warden_model_accounting_provenance_mismatch");
  }
}

export function createWardenModelAccountingRuntime(
  input: WardenModelAccountingRuntimeInput,
): AgentExternalModelAccounting {
  const observedAt = input.now ?? (() => new Date().toISOString());
  return Object.freeze({
    executionScopeId: executionScope(input),
    maximumCostUsd: input.maximumCallCostUsd,
    reserve: async (reservation) => {
      assertReservationProvenance(input, reservation);
      reserveWardenModelCall(input.db, {
        id: reservation.reservationId,
        tenantId: input.tenantId,
        jobId: input.jobId,
        runId: input.runId,
        workerId: input.workerId,
        leaseGeneration: input.leaseGeneration,
        callIndex: reservation.callIndex,
        requestDigest: reservation.requestDigest,
        provider: reservation.provider,
        configuredModel: reservation.configuredModel,
        endpointHost: reservation.endpointHost,
        maximumInputTokens: reservation.maximumInputTokens,
        maximumOutputTokens: reservation.maximumOutputTokens,
        maximumTotalTokens: reservation.maximumTotalTokens,
        maximumCostUsd: reservation.maximumCostUsd,
        jobBudgetUsd: input.jobBudgetUsd,
        observedAt: observedAt(),
      });
    },
    settle: async (settlement) => {
      settleWardenModelCall(input.db, {
        tenantId: input.tenantId,
        jobId: input.jobId,
        reservationId: settlement.reservationId,
        workerId: input.workerId,
        leaseGeneration: input.leaseGeneration,
        status: settlement.status,
        ...(settlement.actualModel !== undefined ? { actualModel: settlement.actualModel } : {}),
        ...(settlement.bodyRequestId !== undefined ? { bodyRequestId: settlement.bodyRequestId } : {}),
        ...(settlement.headerRequestId !== undefined ? { headerRequestId: settlement.headerRequestId } : {}),
        ...(settlement.inputTokens !== undefined ? { inputTokens: settlement.inputTokens } : {}),
        ...(settlement.outputTokens !== undefined ? { outputTokens: settlement.outputTokens } : {}),
        ...(settlement.totalTokens !== undefined ? { totalTokens: settlement.totalTokens } : {}),
        ...(settlement.costUsd !== undefined ? { costUsd: settlement.costUsd } : {}),
        ...(settlement.errorCode ? { errorCode: settlement.errorCode } : {}),
        observedAt: observedAt(),
      });
    },
  });
}

export function assertWardenModelAccountingSettled(
  db: AppDb,
  fence: Readonly<{
    tenantId: string;
    jobId: string;
    workerId: string;
    leaseGeneration: number;
  }>,
): void {
  if (countActiveWardenModelReservations(
    db,
    fence.tenantId,
    fence.jobId,
    fence.workerId,
    fence.leaseGeneration,
  ) > 0) {
    throw new Error("warden_model_reservations_active");
  }
}
