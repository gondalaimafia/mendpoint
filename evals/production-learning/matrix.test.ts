import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { learningCases } from "./catalog.js";
import { buildRequirementCaseTraceability, flattenRequirementRegister, validateRequirementCaseTraceability, type ClosureRow, type RequirementRegister } from "./matrix.js";

const register = JSON.parse(readFileSync("docs/PRODUCT_REQUIREMENTS.json", "utf8")) as RequirementRegister;
const requirements = flattenRequirementRegister(register);
const closure = JSON.parse(readFileSync("docs/PRODUCTION_CLOSURE_MATRIX.json", "utf8")) as { requirements: ClosureRow[] };

describe("requirement to case to test to production evidence traceability", () => {
  const traces = buildRequirementCaseTraceability({ requirements, closureRows: closure.requirements, cases: learningCases });

  it("covers every canonical requirement and every case without creating production proof", () => {
    expect(traces).toHaveLength(101);
    expect(validateRequirementCaseTraceability({
      traces,
      expectedRequirementIds: requirements.map((requirement) => requirement.id),
      expectedCaseIds: learningCases.map((item) => item.id),
    })).toEqual([]);
    expect(new Set(traces.flatMap((trace) => trace.caseIds))).toEqual(new Set(learningCases.map((item) => item.id)));
  });

  it("preserves missing production evidence as unknown", () => {
    const withoutProof = traces.filter((trace) => trace.productionEvidenceIds.length === 0);
    expect(withoutProof.length).toBeGreaterThan(0);
    expect(withoutProof.every((trace) => trace.productionEvidenceState === "unknown")).toBe(true);
  });

  it("preserves register blockers and statuses instead of promoting them", () => {
    for (const trace of traces) {
      const requirement = requirements.find((row) => row.id === trace.requirementId)!;
      expect(trace.registerStatus).toBe(requirement.implementationStatus);
      expect(trace.registerClaimState).toBe(requirement.claimState);
      expect(trace.externalBlockers).toEqual(requirement.externalBlockers);
    }
  });

  it("keeps product-specific requirements on their product cases", () => {
    expect(traces.find((trace) => trace.requirementId === "ME-WAR-001")?.caseIds.every((id) => id.startsWith("FET-"))).toBe(true);
    expect(traces.find((trace) => trace.requirementId === "ME-TRN-001")?.caseIds.every((id) => id.startsWith("REG-"))).toBe(true);
  });
});
