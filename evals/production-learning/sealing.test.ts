import { describe, expect, it } from "vitest";
import { learningCases } from "./catalog.js";
import type { LearningCase } from "./schema.js";
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

  it("withholds the expected impact graph from every holdout projection", () => {
    const holdouts = learningCases.filter((item) => item.datasetSplit === "holdout");
    expect(holdouts.length).toBeGreaterThan(0);
    for (const learningCase of holdouts) {
      const projection = publicCaseProjection(learningCase) as { pattern: { expectedImpactGraph: unknown } };
      expect(projection.pattern.expectedImpactGraph).toBeNull();
      // Compared as the exact serialized array rather than node by node: some
      // node names ("credential-provider") are also legitimate substrings of
      // published fields such as pattern.family, so a per-node substring scan
      // reports a leak that is not one.
      expect(JSON.stringify(projection)).not.toContain(
        JSON.stringify(learningCase.pattern.expectedImpactGraph),
      );
    }
  });

  it("publishes the expected impact graph for development cases", () => {
    const learningCase = learningCases.find((item) => item.datasetSplit === "development")!;
    const projection = publicCaseProjection(learningCase) as { pattern: { expectedImpactGraph: unknown } };
    expect(projection.pattern.expectedImpactGraph).toEqual(learningCase.pattern.expectedImpactGraph);
  });

  it("binds the holdout commitment to the expected impact graph as well as the expected outcome", () => {
    const learningCase = learningCases.find((item) => item.datasetSplit === "holdout")!;
    const commitment = (publicCaseProjection(learningCase) as { holdout: { answerKeyCommitmentSha256: string } })
      .holdout.answerKeyCommitmentSha256;
    const impactGraphMutated: LearningCase = {
      ...learningCase,
      pattern: { ...learningCase.pattern, expectedImpactGraph: ["mendpoint-unrelated-node"] },
    };
    const mutatedCommitment = (publicCaseProjection(impactGraphMutated) as {
      holdout: { answerKeyCommitmentSha256: string };
    }).holdout.answerKeyCommitmentSha256;
    expect(mutatedCommitment).not.toEqual(commitment);
  });
});
