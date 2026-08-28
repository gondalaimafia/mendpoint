import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HANDOFF_WAVE_ASSIGNMENTS,
  buildExecutionLedger,
} from "./generate-production-closure-execution-ledger.js";

const root = resolve(import.meta.dirname, "..");

const REQUIRED_FIELDS = [
  "requirementId",
  "title",
  "registerSet",
  "workstream",
  "implementationStatus",
  "availability",
  "claimState",
  "acceptanceId",
  "acceptanceAssertion",
  "smallestUnmetGap",
  "owningWave",
  "owner",
  "issue",
  "pullRequests",
  "plannedPullRequest",
  "reachableCodePath",
  "mutationOrRegressionTest",
  "productionEvidenceTarget",
  "rollbackOrFailureProof",
  "publicClaimEffect",
  "externalDependency",
] as const;

describe("production closure execution ledger", () => {
  const ledger = buildExecutionLedger();
  const committed = JSON.parse(
    readFileSync(resolve(root, "docs/PRODUCTION_CLOSURE_EXECUTION_LEDGER.json"), "utf8"),
  ) as ReturnType<typeof buildExecutionLedger>;
  const register = JSON.parse(
    readFileSync(resolve(root, "docs/PRODUCT_REQUIREMENTS.json"), "utf8"),
  ) as {
    requirements: Array<{ id: string }>;
    additionalRegisterSets: Array<{ requirements: Array<{ id: string }> }>;
  };
  const registerIds = [
    ...register.requirements.map((row) => row.id),
    ...register.additionalRegisterSets.flatMap((set) => set.requirements.map((row) => row.id)),
  ];

  it("contains exactly the 101 canonical requirement IDs and no extras", () => {
    expect(ledger.requirementCount).toBe(101);
    expect(ledger.rows).toHaveLength(101);
    expect(ledger.rows.map((row) => row.requirementId)).toEqual(registerIds);
  });

  it("gives every row the handoff-required fields and a non-empty acceptance assertion", () => {
    for (const row of ledger.rows) {
      for (const field of REQUIRED_FIELDS) {
        expect(row).toHaveProperty(field);
      }
      expect(row.acceptanceAssertion.trim().length).toBeGreaterThan(20);
      expect(row.smallestUnmetGap.trim().length).toBeGreaterThan(20);
      expect(row.owningWave).toBeGreaterThanOrEqual(1);
      expect(row.owningWave).toBeLessThanOrEqual(11);
      expect(row.productionEvidenceTarget).toContain("5ba70419ef6164b51ba3bfdc38526bf96fa507d3");
    }
  });

  it("assigns the handoff's unimplemented and Mission rows to the declared waves", () => {
    const byId = new Map(ledger.rows.map((row) => [row.requirementId, row]));
    expect(byId.get("ME-FET-015")?.owningWave).toBe(1);
    expect(byId.get("ME-FET-018")?.owningWave).toBe(5);
    expect(byId.get("ME-REG-015")?.owningWave).toBe(7);
    expect(byId.get("ME-REG-016")?.owningWave).toBe(7);
    expect(byId.get("ME-REG-017")?.owningWave).toBe(1);
    expect(byId.get("ME-REG-018")?.owningWave).toBe(7);
    expect(byId.get("ME-CGR-001")?.owningWave).toBe(6);
    expect(byId.get("ME-WAR-010")?.owningWave).toBe(5);
    expect(byId.get("ME-WAR-010")?.externalDependency).toBeTruthy();
    expect(byId.get("ME-MSN-001")?.owningWave).toBe(4);
    expect(byId.get("ME-MCC-001")?.owningWave).toBe(4);
    expect(byId.get("ME-PEV-001")?.owningWave).toBe(4);
    expect(HANDOFF_WAVE_ASSIGNMENTS["ME-CGR-001"]).toBe(6);
  });

  it("fails if the committed ledger drops a row or changes a requirement ID", () => {
    expect(committed.rows).toHaveLength(101);
    expect(committed.rows.map((row) => row.requirementId)).toEqual(registerIds);
    expect(committed.rows.map((row) => row.requirementId)).toEqual(
      ledger.rows.map((row) => row.requirementId),
    );
  });

  it("CONTROL: deleting ME-CGR-001 from the generated ledger is a red mutation", () => {
    const withoutGraph = ledger.rows.filter((row) => row.requirementId !== "ME-CGR-001");
    expect(withoutGraph).toHaveLength(100);
    expect(withoutGraph.map((row) => row.requirementId)).not.toEqual(registerIds);
  });
});
