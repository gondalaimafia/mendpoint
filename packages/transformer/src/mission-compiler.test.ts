import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { planTransformerBlueprint, type TransformerBlueprintPlanningInput } from "./blueprint-planner.js";
import { createOrganizationConstraintContract } from "./organization-constraints.js";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  recipeFilesDigest,
  recipeReference,
} from "./recipe.js";
import {
  compileApprovedTransformerMission,
  type TransformerMissionCompilationInput,
} from "./mission-compiler.js";

const sha256 = (value: string) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const revision = (value: string) => value.repeat(40);
const observedAt = "2026-08-13T12:00:00.000Z";
const files = {
  "package.json": '{"name":"service","engines":{"node":"18.x"}}\n',
  Dockerfile: "FROM node:18-alpine\n",
};

function planned() {
  const recipe = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
  const snapshotDigest = recipeFilesDigest(files);
  const planning: TransformerBlueprintPlanningInput = {
    evaluatedAt: "2026-08-13T11:30:00.000Z",
    plannerActorId: "planner-a",
    maxEvidenceAgeMs: 60 * 60 * 1_000,
    constraints: { maxUnits: 4, maxRepositories: 2, maxPathsPerUnit: 4 },
    organization: {
      id: "organization-a",
      revision: revision("a"),
      digest: sha256("organization-a"),
      observedAt: "2026-08-13T11:20:00.000Z",
      repositoryIds: ["repo-a"],
      memberIds: ["owner-a", "planner-a", "reviewer-a", "reviewer-b"],
      evidenceRefs: ["evidence:organization:a"],
      humanReviewPolicy: {
        required: true,
        minimumApprovals: 2,
        reviewerIds: ["reviewer-a", "reviewer-b"],
        prohibitPlannerApproval: true,
      },
    },
    repositories: [{
      id: "repo-a",
      organizationId: "organization-a",
      revision: revision("b"),
      snapshotDigest,
      observedAt: "2026-08-13T11:25:00.000Z",
      evidenceRefs: ["evidence:snapshot:a"],
      supportedRecipes: [recipe],
      files: Object.entries(files).map(([path, content]) => ({
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
        statement: "The reviewed snapshot remains immutable during execution.",
        evidenceRefs: ["evidence:assumption:snapshot-stability"],
      }],
      risks: [{
        id: "runtime-compatibility",
        statement: "Runtime behavior can change across major versions.",
        severity: "high",
        ownerId: "owner-a",
        evidenceRefs: ["evidence:risk:runtime-compatibility"],
      }],
      units: [{
        id: "upgrade-service",
        title: "Upgrade service runtime",
        repositoryId: "repo-a",
        dependsOn: [],
        scopePaths: ["Dockerfile", "package.json"],
        ownerIds: ["owner-a"],
        recipe,
      }],
    },
  };
  const result = planTransformerBlueprint(planning);
  if (result.decision !== "planned") throw new Error(result.reasons.join(","));
  return result.blueprint;
}

function input(): TransformerMissionCompilationInput {
  const blueprint = planned();
  return {
    tenantId: "tenant-a",
    organizationId: "organization-a",
    environment: "pilot",
    campaignId: "campaign-upgrade-node",
    blueprint,
    approvals: ["reviewer-b", "reviewer-a"].map((reviewerId) => ({
      reviewerId,
      blueprintId: blueprint.id,
      blueprintDigest: blueprint.digest,
      approvedAt: "2026-08-13T11:45:00.000Z",
      evidenceRefs: [`evidence:approval:${reviewerId}`],
    })),
    repositories: [{
      snapshot: {
        snapshotId: "snapshot-a",
        repositoryId: "repo-a",
        revision: revision("b"),
        manifestSha256: "c".repeat(64),
        digest: recipeFilesDigest(files),
        evidenceRefs: ["evidence:snapshot:a"],
      },
      files,
    }],
    constraints: createOrganizationConstraintContract({
      tenantId: "tenant-a",
      organizationId: "organization-a",
      version: 1,
      effectiveAt: "2026-08-13T11:00:00.000Z",
      sources: [{
        id: "policy-a",
        kind: "explicit_policy",
        repositoryId: "repo-a",
        revision: revision("b"),
        digest: sha256("policy-a"),
        locator: "policy:repo-a:v1",
        evidenceRefs: ["evidence:policy:a"],
      }],
      rules: [{
        id: "allow-upgrade",
        sourceId: "policy-a",
        repositoryId: "repo-a",
        pathPattern: "**",
        actions: ["change"],
        effect: "allow",
        ownerIds: ["owner-a"],
        rationale: "Approved modernization campaign.",
      }],
    }),
    observedAt,
    evidenceRefs: ["evidence:mission:compile"],
    idempotencyKey: "compile-upgrade-node",
    gateConfig: "tenant=tenant-a;environment=pilot;evidence=evidence:gate:a",
  };
}

describe("approved Transformer mission compiler", () => {
  it("compiles an independently reviewed blueprint into a deterministic runnable campaign", () => {
    const first = compileApprovedTransformerMission(input());
    const second = compileApprovedTransformerMission({
      ...input(),
      approvals: [...input().approvals].reverse(),
    });

    expect(first).toEqual(second);
    expect(first.units).toEqual([expect.objectContaining({
      id: "upgrade-service",
      ownerId: "owner-a",
      reviewerIds: ["reviewer-a", "reviewer-b"],
      changedPaths: ["Dockerfile", "package.json"],
      candidateDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      candidateRevision: expect.stringMatching(/^[a-f0-9]{40}$/),
    })]);
    expect(first.evidenceRefs).toEqual([
      "evidence:approval:reviewer-a",
      "evidence:approval:reviewer-b",
      "evidence:mission:compile",
      `transformer-blueprint:${first.units[0]!.id}:${planned().digest}`,
    ]);
    expect(Object.isFrozen(first.units[0]!.changedPaths)).toBe(true);
  });

  it("rejects missing, duplicate, unauthorized, and planner approvals", () => {
    const candidate = input();
    expect(() => compileApprovedTransformerMission({
      ...candidate,
      approvals: candidate.approvals.slice(0, 1),
    })).toThrow("transformer_mission_approvals_incomplete");
    expect(() => compileApprovedTransformerMission({
      ...candidate,
      approvals: [candidate.approvals[0]!, candidate.approvals[0]!],
    })).toThrow("transformer_mission_approval_duplicate");
    expect(() => compileApprovedTransformerMission({
      ...candidate,
      approvals: [{ ...candidate.approvals[0]!, reviewerId: "planner-a" }, candidate.approvals[1]!],
    })).toThrow("transformer_mission_reviewer_invalid");
  });

  it("rejects blueprint, source, and review evidence drift before recipe execution", () => {
    const candidate = input();
    expect(() => compileApprovedTransformerMission({
      ...candidate,
      blueprint: { ...candidate.blueprint, objective: { ...candidate.blueprint.objective, statement: "Changed" } },
    })).toThrow("transformer_blueprint_integrity_invalid");
    expect(() => compileApprovedTransformerMission({
      ...candidate,
      repositories: [{ ...candidate.repositories[0]!, files: { ...files, Dockerfile: "FROM node:19\n" } }],
    })).toThrow("transformer_mission_snapshot_digest_mismatch");
    expect(() => compileApprovedTransformerMission({
      ...candidate,
      approvals: candidate.approvals.map((approval) => ({ ...approval, blueprintDigest: sha256("other") })),
    })).toThrow("transformer_mission_approval_binding_invalid");
  });
});
