import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateProductRequirements,
  type ProductRequirement,
  type ProductRequirementManifest,
} from "../packages/contract/src/product-requirements.js";
import {
  FETTLER_PERFORMANCE_CONTRACT,
  metricDictionaryDigest,
  performanceContractDigest,
  validatePerformanceContract,
} from "../packages/eval/src/performance-contract.js";
import {
  MCU_LEDGER_ENTRY_TYPES,
  MCU_SCHEDULE_DIGEST,
  MCU_VERSION,
} from "../packages/platform/src/mcu.js";

export const FETTLER_PRODUCTION_CLOSURE_SCHEMA_VERSION =
  "fettler-production-requirement-closure/1" as const;
export const FETTLER_PRODUCTION_CLOSURE_ARTIFACT_PATH = fileURLToPath(
  new URL("../docs/FETTLER_PRODUCTION_REQUIREMENT_CLOSURE.json", import.meta.url),
);
export const FETTLER_REQUIREMENT_REGISTER_PATH = fileURLToPath(
  new URL("../docs/PRODUCT_REQUIREMENTS.json", import.meta.url),
);
export const FETTLER_REQUIREMENT_REGISTER_LOCATOR = "docs/PRODUCT_REQUIREMENTS.json" as const;
export const FETTLER_REQUIREMENT_COUNT = 68 as const;
export const FETTLER_TARGET_RELEASES = ["warden-pilot", "warden-ga"] as const;

const SHA1 = /^[a-f0-9]{40}$/;

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function loadFettlerRequirementProjection(
  registerPath = FETTLER_REQUIREMENT_REGISTER_PATH,
) {
  const bytes = readFileSync(registerPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("fettler_requirement_register_unparseable");
  }
  const issues = validateProductRequirements(parsed);
  if (issues.length > 0) {
    throw new Error(
      `fettler_requirement_register_invalid:${issues.map(({ code }) => code).sort().join(",")}`,
    );
  }
  const manifest = parsed as ProductRequirementManifest;
  const registerSets = [
    {
      key: "foundational",
      closurePlan: manifest.closurePlan,
      requirements: manifest.requirements,
    },
    ...(manifest.additionalRegisterSets ?? []),
  ];
  for (const set of registerSets) {
    if (!SHA1.test(set.closurePlan.auditedRevision)) {
      throw new Error("fettler_requirement_register_revision_invalid");
    }
  }
  const requirements = registerSets
    .flatMap((set) => set.requirements)
    .filter((requirement) =>
      FETTLER_TARGET_RELEASES.includes(
        requirement.targetRelease as (typeof FETTLER_TARGET_RELEASES)[number],
      ))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (requirements.length !== FETTLER_REQUIREMENT_COUNT) {
    throw new Error("fettler_requirement_count_invalid");
  }
  if (new Set(requirements.map(({ id }) => id)).size !== requirements.length) {
    throw new Error("fettler_requirement_duplicate");
  }
  return {
    sourceAuthority: {
      path: FETTLER_REQUIREMENT_REGISTER_LOCATOR,
      sha256: sha256(bytes),
      specSha256: `sha256:${manifest.spec.sha256}`,
      targetReleases: FETTLER_TARGET_RELEASES,
      requirementCount: FETTLER_REQUIREMENT_COUNT,
      registerSets: registerSets.map(({ key, closurePlan, requirements: rows }) => ({
        key,
        source: closurePlan.source,
        auditedRevision: closurePlan.auditedRevision,
        requirementCount: rows.length,
      })),
    },
    requirements: requirements.map((requirement: ProductRequirement) => ({
      id: requirement.id,
      title: requirement.title,
      targetRelease: requirement.targetRelease,
      implementationStatus: requirement.implementationStatus,
      availability: requirement.availability,
      claimState: requirement.claimState,
      closureWorkstream: requirement.closureWorkstream,
      acceptanceIds: requirement.acceptance.map(({ id }) => id),
      externalBlockers: requirement.externalBlockers,
    })),
  };
}

export function buildFettlerProductionClosure() {
  const performance = validatePerformanceContract(FETTLER_PERFORMANCE_CONTRACT);
  const projection = loadFettlerRequirementProjection();
  return {
    schemaVersion: FETTLER_PRODUCTION_CLOSURE_SCHEMA_VERSION,
    product: "fettler" as const,
    release: "production" as const,
    sourceAuthority: projection.sourceAuthority,
    requirements: projection.requirements,
    qualification: {
      status: "not_qualified" as const,
      deploymentRevision: null,
      evidenceDigest: null,
      reason: "exact_revision_production_evidence_not_supplied" as const,
    },
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
