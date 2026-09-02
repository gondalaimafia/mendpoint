import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FETTLER_PERFORMANCE_CONTRACT,
  metricDictionaryDigest,
  performanceContractDigest,
  validatePerformanceContract,
} from "../packages/eval/src/performance-contract.js";
import {
  createMcuLedgerEntry,
  MCU_LEDGER_ENTRY_TYPES,
  MCU_MICROS,
  MCU_SCHEDULE_DIGEST,
  MCU_VERSION,
  reconcileMcuLedgerLifecycle,
} from "../packages/platform/src/mcu.js";

export const FETTLER_PRODUCTION_CLOSURE_SCHEMA_VERSION =
  "fettler-production-requirement-closure/1" as const;
export const FETTLER_PRODUCTION_CLOSURE_ARTIFACT_PATH = fileURLToPath(
  new URL("../docs/FETTLER_PRODUCTION_REQUIREMENT_CLOSURE.json", import.meta.url),
);

function validateMigrationComputeAuthority() {
  const reservation = createMcuLedgerEntry({
    tenantId: "tenant-fettler-closure",
    entryType: "reservation",
    entitlementId: "entitlement-fettler-production",
    idempotencyKey: "fettler-closure-reservation",
    taskId: "task-fettler-closure",
    campaignId: null,
    reservationId: null,
    reservedMcuMicrosDelta: MCU_MICROS,
    consumedMcuMicrosDelta: 0,
    invoiceReference: null,
    actorId: "release-owner",
    reasonCode: "operating-contract-self-check",
    occurredAt: "2026-09-01T00:00:00.000Z",
  }, null);
  const settlement = createMcuLedgerEntry({
    tenantId: reservation.tenantId,
    entryType: "settlement",
    entitlementId: reservation.entitlementId,
    idempotencyKey: "fettler-closure-settlement",
    taskId: reservation.taskId,
    campaignId: reservation.campaignId,
    reservationId: reservation.id,
    reservedMcuMicrosDelta: -MCU_MICROS,
    consumedMcuMicrosDelta: MCU_MICROS,
    invoiceReference: "invoice-fettler-closure",
    actorId: "release-owner",
    reasonCode: "operating-contract-self-check",
    occurredAt: "2026-09-01T00:00:01.000Z",
  }, reservation);
  const reconciliation = reconcileMcuLedgerLifecycle({
    scheduleVersion: MCU_VERSION,
    scheduleDigest: MCU_SCHEDULE_DIGEST,
    entries: [reservation, settlement],
  });
  return {
    reconciled: reconciliation.reconciled,
    entryCount: reconciliation.entryCount,
    settledEntryIds: reconciliation.invoiceMappings.flatMap((mapping) => mapping.settledEntryIds),
  };
}

export function buildFettlerProductionClosure() {
  const performance = validatePerformanceContract(FETTLER_PERFORMANCE_CONTRACT);
  return {
    schemaVersion: FETTLER_PRODUCTION_CLOSURE_SCHEMA_VERSION,
    product: "fettler" as const,
    release: "production" as const,
    requirements: ["ME-FND-006", "ME-FND-007", "ME-FND-008"] as const,
    operatingContracts: {
      performance: {
        version: performance.version,
        digest: performanceContractDigest(performance),
        metricDictionaryVersion: performance.metricDictionaryVersion!,
        metricDictionaryDigest: metricDictionaryDigest(performance),
        evidence: {
          status: "not_observed" as const,
          reason: "production_measurement_not_supplied" as const,
        },
      },
      migrationCompute: {
        version: MCU_VERSION,
        digest: MCU_SCHEDULE_DIGEST,
        ledgerEntryTypes: MCU_LEDGER_ENTRY_TYPES,
        evidence: {
          status: "not_observed" as const,
          reason: "production_ledger_not_supplied" as const,
        },
        selfCheck: validateMigrationComputeAuthority(),
      },
    },
  };
}

export function serializeFettlerProductionClosure(): string {
  return `${JSON.stringify(buildFettlerProductionClosure(), null, 2)}\n`;
}

export function checkFettlerProductionClosureArtifact(
  artifactPath = FETTLER_PRODUCTION_CLOSURE_ARTIFACT_PATH,
): void {
  const expected = serializeFettlerProductionClosure();
  let actual: string;
  try {
    actual = readFileSync(artifactPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("fettler_production_closure_artifact_missing");
    }
    throw error;
  }
  if (actual !== expected) throw new Error("fettler_production_closure_artifact_stale");
}

export function writeFettlerProductionClosureArtifact(
  artifactPath = FETTLER_PRODUCTION_CLOSURE_ARTIFACT_PATH,
): void {
  const validatedBytes = serializeFettlerProductionClosure();
  writeFileSync(artifactPath, validatedBytes, "utf8");
  checkFettlerProductionClosureArtifact(artifactPath);
}

export function main(args = process.argv.slice(2)): void {
  if (args.length === 0) {
    checkFettlerProductionClosureArtifact();
    return;
  }
  if (args.length === 1 && args[0] === "--write") {
    writeFettlerProductionClosureArtifact();
    return;
  }
  throw new Error("fettler_production_closure_arguments_invalid");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
