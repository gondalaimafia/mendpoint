import {
  FETTLER_PERFORMANCE_CONTRACT,
  metricDictionaryDigest,
  performanceContractDigest,
  validatePerformanceContract,
} from "../packages/eval/src/performance-contract.js";

export const FETTLER_PRODUCTION_CLOSURE_SCHEMA_VERSION =
  "fettler-production-requirement-closure/1" as const;

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
    },
  };
}

export function serializeFettlerProductionClosure(): string {
  return `${JSON.stringify(buildFettlerProductionClosure(), null, 2)}\n`;
}
