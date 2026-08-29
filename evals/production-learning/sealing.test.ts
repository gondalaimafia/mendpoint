import { describe, expect, it } from "vitest";
import { learningCases } from "./catalog.js";
import { publicCaseProjection, stageModeledCase } from "./sealing.js";

describe("modeled input and holdout publication boundaries", () => {
  it("constructs modeled input without expected diagnosis, repair, oracle, or acceptance material", () => {
    const learningCase = learningCases.find((item) => item.datasetSplit === "holdout")!;
    const serialized = JSON.stringify(stageModeledCase(learningCase, "configured_model_router"));
    expect(serialized).not.toContain(learningCase.expected.diagnosis);
    expect(serialized).not.toContain(learningCase.expected.repairOrMigration);
    expect(serialized).not.toContain(learningCase.expected.oracleIds[0]!);
    expect(serialized).not.toContain(learningCase.expected.productionAcceptance[0]!);
  });

  it("redacts holdout answer keys and labels them assigned but not sealed", () => {
    const learningCase = learningCases.find((item) => item.datasetSplit === "holdout")!;
    const projection = publicCaseProjection(learningCase);
    expect(projection).not.toHaveProperty("expected");
    expect(projection).toMatchObject({ holdout: { state: "assigned_unsealed" } });
    expect(JSON.stringify(projection)).not.toContain(learningCase.expected.diagnosis);
  });
});
