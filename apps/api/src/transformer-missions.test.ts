import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  createOrganizationConstraintContract,
  recipeFilesDigest,
} from "@mendpoint/transformer";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
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

function request(actorId: string, key: string) {
  return {
    tenantId: "tenant-a",
    actorId,
    requestId: `request-${key}`,
    idempotencyKey: key,
    evidenceRefs: [`evidence:request:${key}`],
  };
}

function fixture() {
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
  const snapshotDigest = recipeFilesDigest(files);
  const repositories: TransformerMissionRepositoryAuthority = {
    load(tenantId, repositoryId) {
      if (tenantId !== "tenant-a" || repositoryId !== "repo-a") throw new Error("repository_not_found");
      return {
        planning: {
          id: "repo-a",
          organizationId: "organization-a",
          revision: revision("b"),
          snapshotDigest,
          observedAt: new Date(Date.now() - 60_000).toISOString(),
          evidenceRefs: ["evidence:snapshot:a"],
          files,
          fileEvidence: Object.entries(files).map(([path, content]) => ({
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
            revision: revision("b"),
            manifestSha256: "b".repeat(64),
            digest: snapshotDigest,
            evidenceRefs: ["evidence:snapshot:a"],
          },
          files,
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
  const service = new TransformerMissionService(
    control,
    executions,
    repositories,
    organizations,
    [NODE_RUNTIME_18_TO_20_RECIPE],
    "test",
  );
  return {
    control,
    executions,
    service,
    replaceConstraints(value: typeof constraints) { activeConstraints = value; },
  };
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
      expect(planned.graphPlan.coverage.basis).toBe("not_consulted");
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
});
