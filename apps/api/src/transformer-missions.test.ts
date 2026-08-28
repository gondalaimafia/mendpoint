import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  createRegaugeDependencyProjectionV1,
  createOrganizationConstraintContract,
  recipeFilesDigest,
  type TransformerBlueprint,
} from "@mendpoint/transformer";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import { ingestLspSymbols, openGraphLearnMemory } from "@mendpoint/graph-learn";
import { TransformerCampaignService } from "./transformer-control-plane.js";
import { TransformerPilotExecutionService } from "./transformer-pilot-executions.js";
import {
  TransformerMissionService,
  type TransformerMissionOrganizationAuthority,
  type TransformerMissionRepositoryAuthority,
} from "./transformer-missions.js";

const roots: string[] = [];
const services: Array<{ close(): void }> = [];
afterEach(() => {
  while (services.length) services.pop()!.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const revision = (value: string) => value.repeat(40);
const files = {
  "package.json": '{"name":"service","engines":{"node":"18.x"}}\n',
  Dockerfile: "FROM node:18-alpine\n",
};
const digest = (content: string) =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function resignBlueprint(value: TransformerBlueprint): TransformerBlueprint {
  const candidate = structuredClone(value);
  const { id: _id, digest: _digest, ...body } = candidate;
  const nextDigest = digest(JSON.stringify(stableValue(body)));
  return {
    ...candidate,
    id: `tfb_${nextDigest.slice("sha256:".length, "sha256:".length + 24)}`,
    digest: nextDigest,
  };
}

function request(actorId: string, key: string) {
  return {
    tenantId: "tenant-a",
    actorId,
    requestId: `request-${key}`,
    idempotencyKey: key,
    evidenceRefs: [`evidence:request:${key}`],
  };
}

function fixture(graphMode: "complete" | "not_consulted" = "complete") {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-transformer-mission-"));
  roots.push(root);
  const gate = JSON.stringify({
    schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
    tenantAllowlist: ["tenant-a"],
    environmentAllowlist: ["test"],
    grants: [{
      tenantId: "tenant-a",
      environment: "test",
      boundaries: ["api_control_plane", "worker_action", "ui"],
      acceptanceEvidenceRefs: ["evidence:gate:a"],
      productionDeliveryApprovalRefs: [],
    }],
  });
  const control = new TransformerCampaignService(join(root, "control.sqlite"));
  const executions = new TransformerPilotExecutionService(join(root, "execution.sqlite"), {
    rawGateConfig: gate,
    environment: "test",
  });
  services.push(control, executions);
  let activeFiles: Readonly<Record<string, string>> = { ...files };
  let activeRevision = revision("b");
  const repositoryLoads: Array<{ allowedPaths?: readonly string[]; snapshotId?: string }> = [];
  const repositories: TransformerMissionRepositoryAuthority = {
    load(tenantId, repositoryId, _observedAt, allowedPaths, snapshotId) {
      if (tenantId !== "tenant-a" || repositoryId !== "repo-a") throw new Error("repository_not_found");
      repositoryLoads.push({ allowedPaths, snapshotId });
      const snapshotDigest = recipeFilesDigest(activeFiles);
      return {
        planning: {
          id: "repo-a",
          snapshotId: "snapshot-a",
          organizationId: "organization-a",
          revision: activeRevision,
          snapshotDigest,
          observedAt: new Date(Date.now() - 60_000).toISOString(),
          evidenceRefs: ["evidence:snapshot:a"],
          files: activeFiles,
          fileEvidence: Object.entries(activeFiles).map(([path, content]) => ({
            path,
            digest: digest(content),
            ownerIds: ["owner-a"],
            evidenceRefs: [`evidence:file:${path}`],
          })),
        },
        execution: {
          snapshot: {
            snapshotId: "snapshot-a",
            repositoryId: "repo-a",
            revision: activeRevision,
            manifestSha256: "b".repeat(64),
            digest: snapshotDigest,
            evidenceRefs: ["evidence:snapshot:a"],
          },
          files: activeFiles,
        },
      };
    },
  };
  const constraints = createOrganizationConstraintContract({
    tenantId: "tenant-a",
    organizationId: "organization-a",
    version: 1,
    effectiveAt: new Date(Date.now() - 120_000).toISOString(),
    sources: [{
      id: "policy-a",
      kind: "explicit_policy",
      repositoryId: "repo-a",
      revision: revision("b"),
      digest: digest("policy"),
      locator: "policy:repo-a:v1",
      evidenceRefs: ["evidence:policy:a"],
    }],
    rules: [{
      id: "allow-repo-a",
      sourceId: "policy-a",
      repositoryId: "repo-a",
      pathPattern: "**",
      actions: ["change"],
      effect: "allow",
      ownerIds: ["owner-a"],
      rationale: "Approved runtime migration.",
    }],
  });
  let activeConstraints = constraints;
  const organizations: TransformerMissionOrganizationAuthority = {
    load(tenantId, repositoryIds, plannerActorId, observedAt) {
      if (tenantId !== "tenant-a" || repositoryIds.join(",") !== "repo-a") {
        throw new Error("organization_not_found");
      }
      return {
        constraints: activeConstraints,
        organization: {
          id: "organization-a",
          revision: revision("a"),
          digest: activeConstraints.digest,
          observedAt,
          repositoryIds: ["repo-a"],
          memberIds: ["owner-a", plannerActorId, "reviewer-a"],
          evidenceRefs: [
            "evidence:organization:a",
            `organization-constraint:${activeConstraints.digest}`,
          ],
          humanReviewPolicy: {
            required: true,
            minimumApprovals: 1,
            reviewerIds: ["reviewer-a"],
            prohibitPlannerApproval: true,
          },
        },
      };
    },
  };
  const graph = graphMode === "complete" ? openGraphLearnMemory() : null;
  if (graph) {
    ingestLspSymbols(graph, {
      repoPath: "/unused",
      repoId: "repo-a",
      tenantId: "tenant-a",
      observedAt: new Date(Date.now() - 60_000).toISOString(),
      files: [{ path: "package.json", text: files["package.json"] }],
    });
    services.push({ close: () => graph.raw.close() });
  }
  const service = new TransformerMissionService(
    control,
    executions,
    repositories,
    organizations,
    [NODE_RUNTIME_18_TO_20_RECIPE],
    "test",
    undefined,
    { graph },
  );
  return {
    control,
    executions,
    service,
    repositoryLoads,
    replaceConstraints(value: typeof constraints) { activeConstraints = value; },
    replaceRepositorySnapshot(
      nextFiles: Readonly<Record<string, string>>,
      nextRevision = activeRevision,
    ) {
      activeFiles = { ...nextFiles };
      activeRevision = nextRevision;
    },
  };
}

function planForLaunch(service: TransformerMissionService, campaignId: string, key: string) {
  return service.plan(request("planner-a", key), {
    campaignId,
    environment: "test",
    evaluatedAt: new Date(Date.now() - 30_000).toISOString(),
    maxEvidenceAgeMs: 10 * 60_000,
    constraints: { maxUnits: 4, maxRepositories: 2, maxPathsPerUnit: 8 },
    repositoryIds: ["repo-a"],
    objective: {
      id: `upgrade-node-${campaignId}`,
      statement: "Upgrade the service from Node 18 to Node 20.",
      sourceSystem: "node@18",
      targetSystem: "node@20",
      evidenceRefs: [`evidence:objective:${campaignId}`],
      assumptions: [{
        id: `snapshot-stability-${campaignId}`,
        statement: "The reviewed snapshot remains immutable.",
        evidenceRefs: [`evidence:assumption:${campaignId}`],
      }],
      risks: [{
        id: `runtime-compatibility-${campaignId}`,
        statement: "Runtime behavior can change.",
        severity: "high",
        ownerId: "owner-a",
        evidenceRefs: [`evidence:risk:${campaignId}`],
      }],
    },
  });
}

describe("Transformer mission application service", () => {
  it("joins objective planning, human review, and pilot execution creation", () => {
    const { control, service } = fixture();
    const evaluatedAt = new Date(Date.now() - 30_000).toISOString();
    const planned = service.plan(request("planner-a", "plan-a"), {
      campaignId: "campaign-a",
      environment: "test",
      evaluatedAt,
      maxEvidenceAgeMs: 10 * 60_000,
      constraints: { maxUnits: 4, maxRepositories: 2, maxPathsPerUnit: 8 },
      repositoryIds: ["repo-a"],
      objective: {
        id: "upgrade-node",
        statement: "Upgrade the service from Node 18 to Node 20.",
        sourceSystem: "node@18",
        targetSystem: "node@20",
        evidenceRefs: ["evidence:objective:a"],
        assumptions: [{
          id: "snapshot-stability",
          statement: "The reviewed snapshot remains immutable.",
          evidenceRefs: ["evidence:assumption:a"],
        }],
        risks: [{
          id: "runtime-compatibility",
          statement: "Runtime behavior can change.",
          severity: "high",
          ownerId: "owner-a",
          evidenceRefs: ["evidence:risk:a"],
        }],
      },
    });
    expect(planned.decision).toBe("planned");
    if (planned.decision === "planned") {
      expect(planned.graphPlan.repositories[0]).toMatchObject({
        repositoryId: "repo-a",
        coverage: "complete",
        dependsOnRepositoryIds: [],
      });
      const dependencies = planned.blueprint.evidence.dependencies;
      if (!dependencies) throw new Error("expected dependency projection");
      expect(dependencies.contentDigest).toBe(planned.graphPlan.contentDigest);
      // No Organization Memory provider is wired on this fixture, so the consult
      // must declare "not consulted" rather than resolving into a hard-policy win
      // that is indistinguishable from a real but empty consult.
      expect(planned.organizationMemory.consulted).toBe(false);
      expect(planned.organizationMemory.basis).toBe("not_consulted");
    }
    expect(() => service.launch(request("reviewer-a", "launch-before-review"), "campaign-a"))
      .toThrow("transformer_mission_review_required");

    control.reviewToReady(request("reviewer-a", "review-a"), "campaign-a", {
      campaign: 1,
      blueprint: 1,
      bsg: 1,
    });
    const execution = service.launch(request("reviewer-a", "launch-a"), "campaign-a");
    expect(execution).toMatchObject({
      campaignId: "campaign-a",
      organizationId: "organization-a",
      state: "running",
      units: [expect.objectContaining({
        id: "repo-a-node-runtime-18-to-20",
        changedPaths: ["Dockerfile", "package.json"],
      })],
    });
  });

  it("rejects launch when the durable organization constraint changes after review", () => {
    const { control, service, replaceConstraints } = fixture();
    const evaluatedAt = new Date(Date.now() - 30_000).toISOString();
    const planned = service.plan(request("planner-a", "plan-drift"), {
      campaignId: "campaign-drift",
      environment: "test",
      evaluatedAt,
      maxEvidenceAgeMs: 10 * 60_000,
      constraints: { maxUnits: 4, maxRepositories: 2, maxPathsPerUnit: 8 },
      repositoryIds: ["repo-a"],
      objective: {
        id: "upgrade-node-drift",
        statement: "Upgrade the service from Node 18 to Node 20.",
        sourceSystem: "node@18",
        targetSystem: "node@20",
        evidenceRefs: ["evidence:objective:drift"],
        assumptions: [{
          id: "snapshot-stability-drift",
          statement: "The reviewed snapshot remains immutable.",
          evidenceRefs: ["evidence:assumption:drift"],
        }],
        risks: [{
          id: "runtime-compatibility-drift",
          statement: "Runtime behavior can change.",
          severity: "high",
          ownerId: "owner-a",
          evidenceRefs: ["evidence:risk:drift"],
        }],
      },
    });
    expect(planned.decision).toBe("planned");
    control.reviewToReady(request("reviewer-a", "review-drift"), "campaign-drift", {
      campaign: 1,
      blueprint: 1,
      bsg: 1,
    });
    replaceConstraints(createOrganizationConstraintContract({
      tenantId: "tenant-a",
      organizationId: "organization-a",
      version: 2,
      effectiveAt: new Date(Date.now() - 10_000).toISOString(),
      sources: [{
        id: "policy-a",
        kind: "explicit_policy",
        repositoryId: "repo-a",
        revision: revision("b"),
        digest: digest("policy-v2"),
        locator: "policy:repo-a:v2",
        evidenceRefs: ["evidence:policy:a:v2"],
      }],
      rules: [{
        id: "allow-repo-a",
        sourceId: "policy-a",
        repositoryId: "repo-a",
        pathPattern: "**",
        actions: ["change"],
        effect: "allow",
        ownerIds: ["owner-a"],
        rationale: "Changed after review.",
      }],
    }));
    expect(() => service.launch(request("reviewer-a", "launch-drift"), "campaign-drift"))
      .toThrow("transformer_mission_authority_drift");
  });

  it("abstains with zero control-plane writes when any requested dependency coverage is incomplete", () => {
    const { control, service } = fixture("not_consulted");
    const result = service.plan(request("planner-a", "plan-no-graph"), {
      campaignId: "campaign-no-graph",
      environment: "test",
      evaluatedAt: new Date(Date.now() - 30_000).toISOString(),
      maxEvidenceAgeMs: 10 * 60_000,
      constraints: { maxUnits: 4, maxRepositories: 2, maxPathsPerUnit: 8 },
      repositoryIds: ["repo-a"],
      objective: {
        id: "upgrade-node-no-graph",
        statement: "Upgrade the service from Node 18 to Node 20.",
        sourceSystem: "node@18",
        targetSystem: "node@20",
        evidenceRefs: ["evidence:objective:no-graph"],
        assumptions: [{
          id: "snapshot-stability-no-graph",
          statement: "The reviewed snapshot remains immutable.",
          evidenceRefs: ["evidence:assumption:no-graph"],
        }],
        risks: [{
          id: "runtime-compatibility-no-graph",
          statement: "Runtime behavior can change.",
          severity: "high",
          ownerId: "owner-a",
          evidenceRefs: ["evidence:risk:no-graph"],
        }],
      },
    });
    expect(result).toMatchObject({
      decision: "abstained",
      reasons: ["dependency_projection_incomplete:repo-a:graph_not_supplied"],
      blueprint: null,
      graphPlan: {
        tenantId: "tenant-a",
        repositories: [{ repositoryId: "repo-a", coverage: "not_consulted" }],
      },
    });
    expect(control.store.getCampaign("tenant-a", "campaign-no-graph")).toBeUndefined();
    expect(control.events("tenant-a", "campaign-no-graph")).toEqual([]);
  });

  it("rejects launch when the reviewed dependency projection was tampered", () => {
    const { control, service } = fixture();
    const planned = service.plan(request("planner-a", "plan-tamper"), {
      campaignId: "campaign-tamper",
      environment: "test",
      evaluatedAt: new Date(Date.now() - 30_000).toISOString(),
      maxEvidenceAgeMs: 10 * 60_000,
      constraints: { maxUnits: 4, maxRepositories: 2, maxPathsPerUnit: 8 },
      repositoryIds: ["repo-a"],
      objective: {
        id: "upgrade-node-tamper",
        statement: "Upgrade the service from Node 18 to Node 20.",
        sourceSystem: "node@18",
        targetSystem: "node@20",
        evidenceRefs: ["evidence:objective:tamper"],
        assumptions: [{
          id: "snapshot-stability-tamper",
          statement: "The reviewed snapshot remains immutable.",
          evidenceRefs: ["evidence:assumption:tamper"],
        }],
        risks: [{
          id: "runtime-compatibility-tamper",
          statement: "Runtime behavior can change.",
          severity: "high",
          ownerId: "owner-a",
          evidenceRefs: ["evidence:risk:tamper"],
        }],
      },
    });
    expect(planned.decision).toBe("planned");
    if (planned.decision !== "planned") throw new Error(planned.reasons.join(","));
    const stored = control.store.getBlueprint("tenant-a", planned.blueprint.id)!;
    const tampered = structuredClone(stored.content);
    const dependencyEvidence = tampered.evidence as {
      dependencies: { graphVersionId: string; repositories: Array<{ evidenceRefs: string[] }> };
    };
    dependencyEvidence.dependencies.graphVersionId = "topology-v1:forged";
    const resigned = resignBlueprint(tampered as unknown as TransformerBlueprint);
    control.store.reviseBlueprint(
      "tenant-a",
      planned.blueprint.id,
      { content: resigned as unknown as Record<string, unknown>, policy: stored.policy },
      1,
      {
        actorId: "planner-a",
        correlationId: "request-tamper",
        causationId: "request-tamper",
        evidenceRefs: ["evidence:tamper-test"],
        idempotencyKey: "tamper-blueprint",
      },
    );
    control.reviewToReady(request("reviewer-a", "review-tamper"), "campaign-tamper", {
      campaign: 1,
      blueprint: 2,
      bsg: 1,
    });
    expect(() => service.launch(request("reviewer-a", "launch-tamper"), "campaign-tamper"))
      .toThrow("transformer_blueprint_integrity_invalid");
  });

  it("revalidates the complete manifest projection against the current repository snapshot at launch", () => {
    const { control, service, replaceRepositorySnapshot } = fixture();
    const planned = planForLaunch(service, "campaign-snapshot-drift", "plan-snapshot-drift");
    expect(planned.decision).toBe("planned");
    if (planned.decision !== "planned") throw new Error(planned.reasons.join(","));
    control.reviewToReady(request("reviewer-a", "review-snapshot-drift"), "campaign-snapshot-drift", {
      campaign: 1,
      blueprint: 1,
      bsg: 1,
    });
    replaceRepositorySnapshot({
      ...files,
      "package.json": '{"name":"service","engines":{"node":"20.x"}}\n',
    });

    expect(() => service.launch(
      request("reviewer-a", "launch-snapshot-drift"),
      "campaign-snapshot-drift",
    )).toThrow("transformer_mission_dependency_replan_required:current_snapshot_drift");
  });

  it("loads the approved snapshot once at launch and derives execution scope from that authority", () => {
    const { control, service, repositoryLoads } = fixture();
    const planned = planForLaunch(service, "campaign-exact-snapshot", "plan-exact-snapshot");
    expect(planned.decision).toBe("planned");
    if (planned.decision !== "planned") throw new Error(planned.reasons.join(","));
    control.reviewToReady(request("reviewer-a", "review-exact-snapshot"), "campaign-exact-snapshot", {
      campaign: 1, blueprint: 1, bsg: 1,
    });
    repositoryLoads.length = 0;
    service.launch(request("reviewer-a", "launch-exact-snapshot"), "campaign-exact-snapshot");
    expect(repositoryLoads).toEqual([{ allowedPaths: undefined, snapshotId: "snapshot-a" }]);
  });

  it("rejects launch when a reviewed canonical projection no longer proves complete coverage", () => {
    const { control, service } = fixture();
    const planned = planForLaunch(service, "campaign-incomplete", "plan-incomplete");
    expect(planned.decision).toBe("planned");
    if (planned.decision !== "planned") throw new Error(planned.reasons.join(","));
    const stored = control.store.getBlueprint("tenant-a", planned.blueprint.id)!;
    const changed = structuredClone(stored.content) as unknown as TransformerBlueprint;
    const dependencies = changed.evidence.dependencies!;
    const incompleteDependencies = createRegaugeDependencyProjectionV1({
      tenantId: dependencies.tenantId,
      evaluatedAt: dependencies.evaluatedAt,
      graphVersionId: dependencies.graphVersionId,
      graphContentDigest: dependencies.graphContentDigest,
      requestedRepositoryIds: dependencies.requestedRepositoryIds,
      repositories: dependencies.repositories.map((repository) => ({
        ...repository,
        coverage: "unknown" as const,
        reason: "manifest_ingest_incomplete",
        dependsOnRepositoryIds: [],
        evidenceRefs: [],
        manifestPath: null,
        manifestContentDigest: null,
        manifestVersionId: null,
        snapshotRevision: null,
        snapshotDigest: null,
      })),
      edges: [],
    });
    const revised = resignBlueprint({
      ...changed,
      evidence: { ...changed.evidence, dependencies: incompleteDependencies },
    });
    control.store.reviseBlueprint(
      "tenant-a",
      planned.blueprint.id,
      { content: revised, policy: stored.policy },
      1,
      {
        actorId: "planner-a",
        correlationId: "request-incomplete",
        causationId: "request-incomplete",
        evidenceRefs: ["evidence:incomplete-test"],
        idempotencyKey: "revise-incomplete-blueprint",
      },
    );
    control.reviewToReady(request("reviewer-a", "review-incomplete"), "campaign-incomplete", {
      campaign: 1,
      blueprint: 2,
      bsg: 1,
    });

    expect(() => service.launch(request("reviewer-a", "launch-incomplete"), "campaign-incomplete"))
      .toThrow("transformer_mission_dependency_replan_required:incomplete_projection");
  });

  it("rejects legacy reviewed blueprints with an explicit replan requirement", () => {
    const { control, service } = fixture();
    const planned = planForLaunch(service, "campaign-legacy", "plan-legacy");
    expect(planned.decision).toBe("planned");
    if (planned.decision !== "planned") throw new Error(planned.reasons.join(","));
    const stored = control.store.getBlueprint("tenant-a", planned.blueprint.id)!;
    const legacy = structuredClone(stored.content) as TransformerBlueprint & {
      evidence: Omit<TransformerBlueprint["evidence"], "dependencies"> & { dependencies?: never };
    };
    delete legacy.evidence.dependencies;
    const revised = resignBlueprint(legacy as TransformerBlueprint);
    control.store.reviseBlueprint(
      "tenant-a",
      planned.blueprint.id,
      { content: revised, policy: stored.policy },
      1,
      {
        actorId: "planner-a",
        correlationId: "request-legacy",
        causationId: "request-legacy",
        evidenceRefs: ["evidence:legacy-test"],
        idempotencyKey: "revise-legacy-blueprint",
      },
    );
    control.reviewToReady(request("reviewer-a", "review-legacy"), "campaign-legacy", {
      campaign: 1,
      blueprint: 2,
      bsg: 1,
    });

    expect(() => service.launch(request("reviewer-a", "launch-legacy"), "campaign-legacy"))
      .toThrow("transformer_mission_dependency_replan_required:legacy_blueprint");
  });
});
