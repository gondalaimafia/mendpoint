import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MATRIX_EXECUTION_EVIDENCE_AUTHORITY_ENVELOPE,
  MATRIX_PRODUCTION_AUTHORITY_ENVELOPE,
  PREFLIGHT_REVISION,
  installTestAuthorityTrustRoots,
} from "./authority-fixtures.test-support.js";
import { learningCases } from "./catalog.js";
import {
  buildRequirementCaseTraceability,
  flattenRequirementRegister,
  validateRequirementCaseTraceability,
  verifyCaseExecutionReceipt,
  type ClosureRow,
  type RequirementRegister,
  type VerifiedCaseExecutionReceipt,
} from "./matrix.js";
import { verifyProductionLearningAuthority } from "./preflight.js";

const register = JSON.parse(readFileSync("docs/PRODUCT_REQUIREMENTS.json", "utf8")) as RequirementRegister;
const requirements = flattenRequirementRegister(register);
const closure = JSON.parse(readFileSync("docs/PRODUCTION_CLOSURE_MATRIX.json", "utf8")) as { requirements: ClosureRow[] };
installTestAuthorityTrustRoots();
process.env.MENDPOINT_PRODUCTION_REVISION = PREFLIGHT_REVISION;

describe("requirement to case to test to production evidence traceability", () => {
  const traces = buildRequirementCaseTraceability({ requirements, closureRows: closure.requirements, cases: learningCases });

  it("retains every canonical requirement, records explicit case plans, and leaves unrelated requirements unplanned", () => {
    expect(traces).toHaveLength(101);
    expect(validateRequirementCaseTraceability({
      traces,
      expectedRequirementIds: requirements.map((requirement) => requirement.id),
      expectedCaseIds: learningCases.map((item) => item.id),
    })).toEqual([]);
    expect(new Set(traces.flatMap((trace) => trace.plannedCaseIds))).toEqual(new Set(learningCases.map((item) => item.id)));
    expect(traces.some((trace) => trace.planningState === "unplanned")).toBe(true);
    expect(traces.filter((trace) => trace.planningState === "unplanned").every((trace) => trace.plannedCaseIds.length === 0 && trace.plannedOracleIds.length === 0 && trace.planningGapReason !== null)).toBe(true);
  });

  it("reports zero verified coverage without admitted completed execution receipts", () => {
    expect(traces.filter((trace) => trace.verificationState === "verified")).toHaveLength(0);
    expect(traces.every((trace) => trace.executionReceiptIds.length === 0 && trace.verifiedCaseIds.length === 0 && trace.verifiedOracleEvidenceIds.length === 0)).toBe(true);
    expect(traces.every((trace) => trace.productionEvidenceState === "unknown")).toBe(true);
  });

  it("does not promote a caller-asserted completed receipt", () => {
    const learningCase = learningCases[0]!;
    const requirementId = learningCase.planning.requirementIds[0]!;
    const baseReceipt = {
      id: "receipt-matrix-test",
      caseId: learningCase.id,
      requirementIds: [requirementId],
      oracleEvidenceIds: ["oracle-evidence-matrix-test"],
      productionEvidenceIds: ["production-evidence-matrix-test"],
      executionState: "completed" as const,
    };
    const blocked = buildRequirementCaseTraceability({
      requirements,
      closureRows: closure.requirements,
      cases: learningCases,
      executionReceipts: [{ ...baseReceipt, admissionState: "blocked" } as unknown as VerifiedCaseExecutionReceipt],
    });
    expect(blocked.every((trace) => trace.verificationState === "unverified")).toBe(true);

    const admitted = buildRequirementCaseTraceability({
      requirements,
      closureRows: closure.requirements,
      cases: learningCases,
      executionReceipts: [{ ...baseReceipt, admissionState: "admitted" } as unknown as VerifiedCaseExecutionReceipt],
    });
    expect(admitted.every((trace) => trace.verificationState === "unverified")).toBe(true);
    expect(admitted.every((trace) => trace.productionEvidenceState === "unknown")).toBe(true);
  });

  it("promotes only requirements carried by a signed, case-bound, production-bound receipt", () => {
    installTestAuthorityTrustRoots();
    process.env.MENDPOINT_PRODUCTION_REVISION = PREFLIGHT_REVISION;
    const learningCase = learningCases.find((item) => item.id === "FET-C001")!;
    const authority = verifyProductionLearningAuthority(MATRIX_PRODUCTION_AUTHORITY_ENVELOPE);
    const receipt = verifyCaseExecutionReceipt(MATRIX_EXECUTION_EVIDENCE_AUTHORITY_ENVELOPE, authority, learningCase);
    const verified = buildRequirementCaseTraceability({
      requirements,
      closureRows: closure.requirements,
      cases: learningCases,
      executionReceipts: [receipt],
    });
    expect(verified.find((trace) => trace.requirementId === "ME-WAR-001")).toMatchObject({
      verificationState: "verified",
      executionReceiptIds: ["receipt-matrix-fet-c001"],
      verifiedCaseIds: ["FET-C001"],
      verifiedOracleEvidenceIds: ["oracle-evidence-fet-c001-run-1"],
      verifiedProductionEvidenceIds: ["production-evidence-fet-c001-run-1"],
      productionEvidenceState: "verified",
    });
    expect(verified.find((trace) => trace.requirementId === "ME-WAR-002")?.verificationState).toBe("unverified");
  });

  it("rejects tampered evidence and stops trusting an issued receipt after revision or key revocation", () => {
    installTestAuthorityTrustRoots();
    process.env.MENDPOINT_PRODUCTION_REVISION = PREFLIGHT_REVISION;
    const learningCase = learningCases.find((item) => item.id === "FET-C001")!;
    const authority = verifyProductionLearningAuthority(MATRIX_PRODUCTION_AUTHORITY_ENVELOPE);
    const tampered = structuredClone(MATRIX_EXECUTION_EVIDENCE_AUTHORITY_ENVELOPE);
    tampered.payload.productionEvidenceIds = ["caller-asserted-evidence"];
    expect(() => verifyCaseExecutionReceipt(tampered, authority, learningCase)).toThrow("authority_signature_invalid");
    const receipt = verifyCaseExecutionReceipt(MATRIX_EXECUTION_EVIDENCE_AUTHORITY_ENVELOPE, authority, learningCase);

    process.env.MENDPOINT_PRODUCTION_REVISION = "c".repeat(40);
    expect(buildRequirementCaseTraceability({ requirements, closureRows: closure.requirements, cases: learningCases, executionReceipts: [receipt] })
      .every((trace) => trace.verificationState === "unverified")).toBe(true);

    process.env.MENDPOINT_PRODUCTION_REVISION = PREFLIGHT_REVISION;
    process.env.MENDPOINT_CASE_EXECUTION_EVIDENCE_MINIMUM_ISSUED_AT = "2026-01-02T00:00:00.000Z";
    expect(buildRequirementCaseTraceability({ requirements, closureRows: closure.requirements, cases: learningCases, executionReceipts: [receipt] })
      .every((trace) => trace.verificationState === "unverified")).toBe(true);
    installTestAuthorityTrustRoots();
  });

  it("preserves register blockers and statuses instead of promoting them", () => {
    for (const trace of traces) {
      const requirement = requirements.find((row) => row.id === trace.requirementId)!;
      expect(trace.registerStatus).toBe(requirement.implementationStatus);
      expect(trace.registerClaimState).toBe(requirement.claimState);
      expect(trace.externalBlockers).toEqual(requirement.externalBlockers);
    }
  });

  it("keeps product-specific requirements on their product cases without mapping every case to every requirement", () => {
    expect(traces.find((trace) => trace.requirementId === "ME-WAR-001")?.plannedCaseIds.every((id) => id.startsWith("FET-"))).toBe(true);
    expect(traces.find((trace) => trace.requirementId === "ME-TRN-001")?.plannedCaseIds.every((id) => id.startsWith("REG-"))).toBe(true);
    expect(traces.find((trace) => trace.requirementId === "ME-WAR-003")?.planningState).toBe("unplanned");
    expect(traces.find((trace) => trace.requirementId === "ME-WAR-003")?.plannedCaseIds).toEqual([]);
  });
});
