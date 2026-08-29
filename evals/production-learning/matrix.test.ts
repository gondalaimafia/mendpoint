import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { learningCases } from "./catalog.js";
import { buildRequirementCaseTraceability, flattenRequirementRegister, validateRequirementCaseTraceability, type ClosureRow, type RequirementRegister } from "./matrix.js";

const register = JSON.parse(readFileSync("docs/PRODUCT_REQUIREMENTS.json", "utf8")) as RequirementRegister;
const requirements = flattenRequirementRegister(register);
const closure = JSON.parse(readFileSync("docs/PRODUCTION_CLOSURE_MATRIX.json", "utf8")) as { requirements: ClosureRow[] };

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

  it("verifies only an explicitly planned requirement with an admitted completed receipt", () => {
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
      executionReceipts: [{ ...baseReceipt, admissionState: "blocked" }],
    });
    expect(blocked.every((trace) => trace.verificationState === "unverified")).toBe(true);

    const admitted = buildRequirementCaseTraceability({
      requirements,
      closureRows: closure.requirements,
      cases: learningCases,
      executionReceipts: [{ ...baseReceipt, admissionState: "admitted" }],
    });
    const verified = admitted.find((trace) => trace.requirementId === requirementId)!;
    expect(verified.verificationState).toBe("verified");
    expect(verified.executionReceiptIds).toEqual([baseReceipt.id]);
    expect(verified.verifiedCaseIds).toEqual([learningCase.id]);
    expect(verified.productionEvidenceState).toBe("verified");
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
