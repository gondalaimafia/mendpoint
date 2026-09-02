import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FETTLER_PERFORMANCE_CONTRACT,
  metricDictionaryDigest,
  performanceContractDigest,
  validatePerformanceContract,
} from "../packages/eval/src/performance-contract.js";
import {
  MCU_LEDGER_ENTRY_TYPES,
  MCU_MICROS,
  MCU_SCHEDULE_DIGEST,
  MCU_SCHEDULE_V1,
  MCU_VERSION,
} from "../packages/platform/src/mcu.js";
import {
  createDb,
  createUsageEntitlement,
  createUsagePriceVersion,
  listUsageLedger,
  reconcileUsageLedger,
  reserveUsage,
  settleUsageReservation,
} from "../packages/db/src/index.js";

export const FETTLER_PRODUCTION_CLOSURE_SCHEMA_VERSION =
  "fettler-production-requirement-closure/1" as const;
export const FETTLER_PRODUCTION_CLOSURE_ARTIFACT_PATH = fileURLToPath(
  new URL("../docs/FETTLER_PRODUCTION_REQUIREMENT_CLOSURE.json", import.meta.url),
);

function validateMigrationComputeAuthority() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-fettler-closure-"));
  const db = createDb(join(directory, "closure.sqlite"));
  try {
    createUsagePriceVersion(db, {
      id: "price-fettler-closure",
      tenantId: "tenant_default",
      formulaVersion: MCU_SCHEDULE_V1.settlement.formulaVersion,
      currency: "USD",
      pricePerMcuMoneyMicros: 10_000,
      effectiveAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-10-01T00:00:00.000Z",
      contractReference: MCU_SCHEDULE_DIGEST,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    createUsageEntitlement(db, {
      id: "entitlement-fettler-production",
      tenantId: "tenant_default",
      priceVersionId: "price-fettler-closure",
      quotaMcuMicros: MCU_MICROS,
      features: ["fettler"],
      contractReference: MCU_SCHEDULE_DIGEST,
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const reservation = reserveUsage(db, {
      id: "reservation-fettler-closure",
      tenantId: "tenant_default",
      idempotencyKey: "fettler-closure-reservation",
      taskId: "task-fettler-closure",
      campaignId: null,
      mcuMicros: MCU_MICROS,
      reason: "operating-contract-self-check",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const settlement = settleUsageReservation(db, {
      id: "settlement-fettler-closure",
      tenantId: reservation.tenantId,
      idempotencyKey: "fettler-closure-settlement",
      reservationId: reservation.id,
      actualMcuMicros: MCU_MICROS,
      invoiceReference: "invoice-fettler-closure",
      reason: "operating-contract-self-check",
      createdAt: "2026-09-01T00:00:01.000Z",
    });
    const reconciliation = reconcileUsageLedger(db, reservation.tenantId);
    if (!reconciliation.ok) {
      throw new Error(reconciliation.error ?? "fettler_mcu_self_check_failed");
    }
    const entries = listUsageLedger(db, reservation.tenantId);
    return {
      reconciled: true as const,
      entryCount: reconciliation.checked,
      storageAuthority: "usage_ledger_entries" as const,
      ledgerHeadHash: settlement.entryHash,
      settledEntryIds: entries
        .filter((entry) => entry.entryType === "settlement")
        .map((entry) => entry.id)
        .sort(),
    };
  } finally {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
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
