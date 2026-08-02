import { describe, expect, it } from "vitest";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  planTransformerBlueprint,
  recipeReference,
  type TransformerBlueprintPlanningInput,
} from "./index.js";

const SHA = (character: string) => `sha256:${character.repeat(64)}`;
const REVISION = (character: string) => character.repeat(40);

function input(): TransformerBlueprintPlanningInput {
  const recipe = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
  return {
    evaluatedAt: "2026-08-02T12:00:00.000Z",
    plannerActorId: "planner-a",
    maxEvidenceAgeMs: 60 * 60 * 1_000,
    constraints: {
      maxUnits: 10,
      maxRepositories: 5,
      maxPathsPerUnit: 8,
    },
    organization: {
      id: "organization-a",
      revision: REVISION("a"),
      digest: SHA("a"),
      observedAt: "2026-08-02T11:45:00.000Z",
      repositoryIds: ["repo-api", "repo-web"],
      memberIds: ["owner-api", "owner-web", "planner-a", "reviewer-a", "reviewer-b"],
      evidenceRefs: ["org://organization-a/revisions/aaaaaaaa"],
      humanReviewPolicy: {
        required: true,
        minimumApprovals: 2,
        reviewerIds: ["reviewer-b", "reviewer-a"],
        prohibitPlannerApproval: true,
      },
    },
    repositories: [
      {
        id: "repo-web",
        organizationId: "organization-a",
        revision: REVISION("c"),
        snapshotDigest: SHA("c"),
        observedAt: "2026-08-02T11:50:00.000Z",
        evidenceRefs: ["repo://repo-web/revisions/cccccccc"],
        supportedRecipes: [recipe],
        files: [
          {
            path: "package.json",
            digest: SHA("d"),
            ownerIds: ["owner-web"],
            evidenceRefs: ["repo://repo-web/files/package.json@cccccccc"],
          },
        ],
      },
      {
        id: "repo-api",
        organizationId: "organization-a",
        revision: REVISION("b"),
        snapshotDigest: SHA("b"),
        observedAt: "2026-08-02T11:55:00.000Z",
        evidenceRefs: ["repo://repo-api/revisions/bbbbbbbb"],
        supportedRecipes: [recipe],
        files: [
          {
            path: "Dockerfile",
            digest: SHA("e"),
            ownerIds: ["owner-api"],
            evidenceRefs: ["repo://repo-api/files/Dockerfile@bbbbbbbb"],
          },
          {
            path: "package.json",
            digest: SHA("f"),
            ownerIds: ["owner-api"],
            evidenceRefs: ["repo://repo-api/files/package.json@bbbbbbbb"],
          },
        ],
      },
    ],
    objective: {
      id: "upgrade-node-runtime",
      statement: "Move the API and web repositories from Node 18 to Node 20.",
      sourceSystem: "node@18",
      targetSystem: "node@20",
      evidenceRefs: ["objective://upgrade-node-runtime/approved-scope"],
      assumptions: [
        {
          id: "snapshot-stability",
          statement: "Repository revisions remain unchanged until a reviewer approves the blueprint.",
          evidenceRefs: ["objective://upgrade-node-runtime/approved-scope"],
        },
      ],
      risks: [
        {
          id: "runtime-compatibility",
          statement: "Runtime behavior may differ after the major version change.",
          severity: "high",
          ownerId: "owner-api",
          evidenceRefs: ["objective://upgrade-node-runtime/approved-scope"],
        },
      ],
      units: [
        {
          id: "web-runtime",
          title: "Upgrade the web runtime",
          repositoryId: "repo-web",
          dependsOn: ["api-runtime"],
          scopePaths: ["package.json"],
          ownerIds: ["owner-web"],
          recipe,
        },
        {
          id: "api-runtime",
          title: "Upgrade the API runtime",
          repositoryId: "repo-api",
          dependsOn: [],
          scopePaths: ["package.json", "Dockerfile"],
          ownerIds: ["owner-api"],
          recipe,
        },
      ],
    },
  };
}

describe("Transformer objective to blueprint planner", () => {
  it("produces a deterministic immutable review only blueprint bound to exact evidence", () => {
    const first = planTransformerBlueprint(input());
    const second = planTransformerBlueprint(input());

    expect(first).toEqual(second);
    expect(first.decision).toBe("planned");
    if (first.decision !== "planned") throw new Error("expected blueprint");

    expect(first.blueprint.waves.map((wave) => wave.unitIds)).toEqual([
      ["api-runtime"],
      ["web-runtime"],
    ]);
    expect(first.blueprint.scope.repositories).toEqual([
      expect.objectContaining({ id: "repo-api", revision: REVISION("b"), snapshotDigest: SHA("b") }),
      expect.objectContaining({ id: "repo-web", revision: REVISION("c"), snapshotDigest: SHA("c") }),
    ]);
    expect(first.blueprint.review).toEqual({
      state: "awaiting_human_review",
      required: true,
      plannerActorId: "planner-a",
      minimumApprovals: 2,
      reviewerIds: ["reviewer-a", "reviewer-b"],
      prohibitPlannerApproval: true,
    });
    expect(first.blueprint.automation).toEqual({
      mayMutate: false,
      mayApprove: false,
      mayMerge: false,
      mayDeploy: false,
    });
    expect(first.blueprint.abstentionReasons).toEqual([]);
    expect(first.blueprint.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.blueprint.id).toMatch(/^tfb_[a-f0-9]{24}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.blueprint.units[0]?.verification)).toBe(true);
  });

  it.each([
    ["missing repository evidence", (value: TransformerBlueprintPlanningInput) => {
      value.repositories = value.repositories.filter((repository) => repository.id !== "repo-web");
    }, "repository_evidence_missing:repo-web"],
    ["stale evidence", (value: TransformerBlueprintPlanningInput) => {
      value.repositories[0]!.observedAt = "2026-08-02T09:00:00.000Z";
    }, "repository_evidence_stale:repo-web"],
    ["conflicting repository evidence", (value: TransformerBlueprintPlanningInput) => {
      value.repositories.push({ ...value.repositories[0]!, revision: REVISION("f") });
    }, "repository_evidence_conflict:repo-web"],
    ["dependency cycle", (value: TransformerBlueprintPlanningInput) => {
      value.objective.units[1]!.dependsOn = ["web-runtime"];
    }, "objective_dependency_cycle:api-runtime,web-runtime"],
    ["unsupported work", (value: TransformerBlueprintPlanningInput) => {
      value.objective.units[0]!.recipe = { ...value.objective.units[0]!.recipe, id: "unknown-recipe" };
    }, "objective_recipe_unsupported:web-runtime"],
    ["excessive unit scope", (value: TransformerBlueprintPlanningInput) => {
      value.constraints.maxPathsPerUnit = 1;
    }, "objective_scope_exceeds_limit:api-runtime"],
    ["absent human review", (value: TransformerBlueprintPlanningInput) => {
      value.organization.humanReviewPolicy.required = false;
    }, "human_review_policy_required"],
  ])("abstains without a blueprint for %s", (_label, mutate, expectedReason) => {
    const value = input();
    mutate(value);
    const result = planTransformerBlueprint(value);

    expect(result).toEqual({
      decision: "abstained",
      reasons: expect.arrayContaining([expectedReason]),
      blueprint: null,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("abstains when path evidence, ownership, or an independent reviewer is absent", () => {
    const missingPath = input();
    missingPath.objective.units[0]!.scopePaths = ["Dockerfile"];
    expect(planTransformerBlueprint(missingPath)).toMatchObject({
      decision: "abstained",
      reasons: ["repository_path_evidence_missing:web-runtime:Dockerfile"],
    });

    const missingOwner = input();
    missingOwner.objective.units[0]!.ownerIds = ["owner-api"];
    expect(planTransformerBlueprint(missingOwner)).toMatchObject({
      decision: "abstained",
      reasons: ["repository_path_owner_mismatch:web-runtime:package.json"],
    });

    const noReviewer = input();
    noReviewer.organization.humanReviewPolicy.reviewerIds = ["planner-a"];
    noReviewer.organization.humanReviewPolicy.minimumApprovals = 1;
    expect(planTransformerBlueprint(noReviewer)).toMatchObject({
      decision: "abstained",
      reasons: ["independent_human_reviewer_required"],
    });
  });
});
