import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  NODE_RUNTIME_20_TO_22_RECIPE,
  recipeFilesDigest,
} from "./recipe.js";
import {
  createRegaugeDependencyProjectionV1,
  planTransformerMission,
  type TransformerMissionPlanningInput,
} from "./mission-planner.js";
import { verifyTransformerBlueprint } from "./blueprint-planner.js";

const sha256 = (value: string) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const revision = (value: string) => value.repeat(40);
const files = {
  "package.json": '{"name":"service","engines":{"node":"18.x"}}\n',
  Dockerfile: "FROM node:18-alpine\n",
  "src/unrelated.ts": "export const untouched = true;\n",
};

function dependencyProjection(
  repositories: ReadonlyArray<{
    repositoryId: string;
    dependsOnRepositoryIds?: readonly string[];
    coverage?: "complete" | "unknown" | "not_consulted";
    reason?: string;
  }> = [{ repositoryId: "repo-a" }],
) {
  const manifestContentDigest = sha256(files["package.json"]);
  const manifestEvidenceRef = `manifest-ingest:${manifestContentDigest}`;
  return createRegaugeDependencyProjectionV1({
    tenantId: "tenant-a",
    requestedRepositoryIds: repositories.map((repository) => repository.repositoryId),
    repositories: repositories.map((repository) => ({
      repositoryId: repository.repositoryId,
      serviceId: `service:${repository.repositoryId}:service`,
      manifestPath: "package.json",
      manifestContentDigest,
      manifestVersionId: sha256(`manifest-version:${repository.repositoryId}`),
      snapshotRevision: revision("b"),
      snapshotDigest: recipeFilesDigest(files),
      coverage: repository.coverage ?? "complete",
      reason: repository.reason ?? "manifest_ingest_complete",
      dependsOnRepositoryIds: repository.dependsOnRepositoryIds ?? [],
      evidenceRefs: [manifestEvidenceRef],
    })),
    edges: repositories.flatMap((repository) =>
      (repository.dependsOnRepositoryIds ?? []).map((targetRepositoryId) => ({
        sourceRepositoryId: repository.repositoryId,
        targetRepositoryId,
        graphEdgeId: `DEPENDS_ON:${repository.repositoryId}:${targetRepositoryId}`,
        sourceSystem: "manifest",
        confidence: 1,
        evidenceRefs: [manifestEvidenceRef],
      }))),
  });
}

function input(): TransformerMissionPlanningInput {
  return {
    tenantId: "tenant-a",
    evaluatedAt: "2026-08-13T12:00:00.000Z",
    plannerActorId: "planner-a",
    maxEvidenceAgeMs: 60 * 60 * 1_000,
    constraints: { maxUnits: 10, maxRepositories: 5, maxPathsPerUnit: 10 },
    organization: {
      id: "organization-a",
      revision: revision("a"),
      digest: sha256("organization-a"),
      observedAt: "2026-08-13T11:40:00.000Z",
      repositoryIds: ["repo-a"],
      memberIds: ["owner-a", "planner-a", "reviewer-a"],
      evidenceRefs: ["evidence:organization:a"],
      humanReviewPolicy: {
        required: true,
        minimumApprovals: 1,
        reviewerIds: ["reviewer-a"],
        prohibitPlannerApproval: true,
      },
    },
    repositories: [{
      id: "repo-a",
      organizationId: "organization-a",
      revision: revision("b"),
      snapshotDigest: recipeFilesDigest(files),
      observedAt: "2026-08-13T11:50:00.000Z",
      evidenceRefs: ["evidence:snapshot:a"],
      files,
      fileEvidence: Object.entries(files).map(([path, content]) => ({
        path,
        digest: sha256(content),
        ownerIds: ["owner-a"],
        evidenceRefs: [`evidence:file:${path}`],
      })),
    }],
    objective: {
      id: "upgrade-node",
      statement: "Upgrade the service from Node 18 to Node 20.",
      sourceSystem: "node@18",
      targetSystem: "node@20",
      evidenceRefs: ["evidence:objective:upgrade-node"],
      assumptions: [{
        id: "snapshot-stability",
        statement: "The reviewed source snapshot remains immutable.",
        evidenceRefs: ["evidence:assumption:snapshot-stability"],
      }],
      risks: [{
        id: "runtime-compatibility",
        statement: "Runtime behavior can change across major versions.",
        severity: "high",
        ownerId: "owner-a",
        evidenceRefs: ["evidence:risk:runtime-compatibility"],
      }],
    },
    recipeCatalog: [NODE_RUNTIME_20_TO_22_RECIPE, NODE_RUNTIME_18_TO_20_RECIPE],
    dependencyProjection: dependencyProjection(),
  };
}

describe("self serving Transformer mission planner", () => {
  it("discovers an applicable recipe and derives a reviewable blueprint from exact snapshots", () => {
    const result = planTransformerMission(input());
    expect(result.decision).toBe("planned");
    if (result.decision !== "planned") throw new Error(result.reasons.join(","));
    expect(result.blueprint.units).toEqual([expect.objectContaining({
      id: "repo-a-node-runtime-18-to-20",
      repositoryId: "repo-a",
      scopePaths: ["Dockerfile", "package.json"],
      ownerIds: ["owner-a"],
      recipe: expect.objectContaining({ id: "node-runtime-18-to-20" }),
    })]);
    expect(result.blueprint.units[0]!.repositorySnapshotDigest).toBe(recipeFilesDigest({
      "package.json": files["package.json"],
      Dockerfile: files.Dockerfile,
    }));
    expect(result.blueprint.scope.repositories[0]!.paths.map((file) => file.path))
      .toEqual(["Dockerfile", "package.json"]);
    expect(result.blueprint.review.state).toBe("awaiting_human_review");
  });

  it("is deterministic under repository, file, and catalog reordering", () => {
    const first = planTransformerMission(input());
    const candidate = input();
    const second = planTransformerMission({
      ...candidate,
      recipeCatalog: [...candidate.recipeCatalog].reverse(),
      repositories: candidate.repositories.map((repository) => ({
        ...repository,
        fileEvidence: [...repository.fileEvidence].reverse(),
        files: Object.fromEntries(Object.entries(repository.files).reverse()),
      })),
    });
    expect(second).toEqual(first);
  });

  it("abstains instead of guessing when no exact recipe is applicable", () => {
    const candidate = input();
    const result = planTransformerMission({
      ...candidate,
      objective: { ...candidate.objective, targetSystem: "node@22" },
      recipeCatalog: [NODE_RUNTIME_18_TO_20_RECIPE],
    });
    expect(result).toEqual({
      decision: "abstained",
      reasons: ["repository_recipe_not_applicable:repo-a"],
      blueprint: null,
    });
  });

  it("abstains on snapshot or ownership evidence drift before planning", () => {
    const candidate = input();
    expect(planTransformerMission({
      ...candidate,
      repositories: [{ ...candidate.repositories[0]!, snapshotDigest: sha256("wrong") }],
    })).toMatchObject({
      decision: "abstained",
      reasons: ["dependency_projection_snapshot_mismatch:repo-a"],
    });
    expect(planTransformerMission({
      ...candidate,
      repositories: [{
        ...candidate.repositories[0]!,
        fileEvidence: candidate.repositories[0]!.fileEvidence.map((file) => ({ ...file, ownerIds: [] })),
      }],
    })).toMatchObject({ decision: "abstained", reasons: ["repository_operation_owner_missing:repo-a"] });
  });

  it("persists exact dependency evidence and orders A after B", () => {
    const candidate = input();
    const repoB = {
      ...candidate.repositories[0]!,
      id: "repo-b",
      evidenceRefs: ["evidence:snapshot:b"],
    };
    const result = planTransformerMission({
      ...candidate,
      organization: {
        ...candidate.organization,
        repositoryIds: ["repo-a", "repo-b"],
      },
      repositories: [repoB, candidate.repositories[0]!],
      dependencyProjection: dependencyProjection([
        { repositoryId: "repo-a", dependsOnRepositoryIds: ["repo-b"] },
        { repositoryId: "repo-b" },
      ]),
    });
    expect(result.decision).toBe("planned");
    if (result.decision !== "planned") throw new Error(result.reasons.join(","));
    const byRepo = Object.fromEntries(result.blueprint.units.map((unit) => [unit.repositoryId, unit.dependsOn]));
    expect(byRepo["repo-a"]).toEqual(["repo-b-node-runtime-18-to-20"]);
    expect(byRepo["repo-b"]).toEqual([]);
    expect(result.blueprint.waves).toEqual([
      { id: "wave-001", unitIds: ["repo-b-node-runtime-18-to-20"] },
      { id: "wave-002", unitIds: ["repo-a-node-runtime-18-to-20"] },
    ]);
    expect(result.blueprint.evidence.dependencies).toEqual(
      dependencyProjection([
        { repositoryId: "repo-a", dependsOnRepositoryIds: ["repo-b"] },
        { repositoryId: "repo-b" },
      ]),
    );
  });

  it("abstains when dependency evidence is missing, incomplete, tenant-mismatched, or tampered", () => {
    const candidate = input();
    expect(planTransformerMission({
      ...candidate,
      dependencyProjection: undefined,
    } as unknown as TransformerMissionPlanningInput)).toMatchObject({
      decision: "abstained",
      reasons: ["dependency_projection_required"],
    });
    expect(planTransformerMission({
      ...candidate,
      dependencyProjection: dependencyProjection([{
        repositoryId: "repo-a",
        coverage: "unknown",
        reason: "manifest_ingest_evidence_missing",
      }]),
    })).toMatchObject({
      decision: "abstained",
      reasons: ["dependency_projection_incomplete:repo-a:manifest_ingest_evidence_missing"],
    });
    expect(planTransformerMission({
      ...candidate,
      tenantId: "tenant-b",
    })).toMatchObject({
      decision: "abstained",
      reasons: ["dependency_projection_tenant_mismatch"],
    });
    const tampered = structuredClone(candidate.dependencyProjection) as {
      repositories: Array<{ dependsOnRepositoryIds: string[] }>;
    } & TransformerMissionPlanningInput["dependencyProjection"];
    tampered.repositories[0]!.dependsOnRepositoryIds.push("repo-b");
    expect(planTransformerMission({ ...candidate, dependencyProjection: tampered })).toMatchObject({
      decision: "abstained",
      reasons: ["dependency_projection_integrity_invalid"],
    });
  });

  it("rejects dependency evidence tampering through blueprint integrity verification", () => {
    const result = planTransformerMission(input());
    expect(result.decision).toBe("planned");
    if (result.decision !== "planned") throw new Error(result.reasons.join(","));
    const tampered = structuredClone(result.blueprint);
    const dependencies = tampered.evidence.dependencies;
    if (!dependencies) throw new Error("expected dependency projection");
    (dependencies.repositories[0]!.evidenceRefs as string[]).push("evidence:forged");
    expect(() => verifyTransformerBlueprint(tampered)).toThrow("transformer_blueprint_integrity_invalid");
  });
});
