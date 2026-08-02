import { describe, expect, it } from "vitest";
import {
  campaignAction,
  deriveTransformerWorkspace,
  dependencyWaves,
  type TransformerCampaignView,
  type TransformerEventView,
} from "./workspace-model.js";

const campaign: TransformerCampaignView = {
  campaign: {
    id: "campaign-a",
    state: "running",
    revision: 3,
    createdAt: "2026-08-01T10:00:00.000Z",
    name: "Runtime migration",
    sourceSystem: "Node 18",
    targetSystem: "Node 20",
    blueprintId: "blueprint-a",
    bsgId: "bsg-a",
  },
  blueprint: {
    id: "blueprint-a",
    state: "reviewed",
    revision: 3,
    createdAt: "2026-08-01T10:00:00.000Z",
    objective: "Move every service to Node 20 with behavioral parity",
    content: {
      legacyNodesBefore: 120,
      legacyNodesAfter: 30,
      reviewerMinutesBaseline: 80,
      reviewerMinutesCurrent: 50,
    },
    policy: {
      ownerIds: ["owner-a"],
      risks: [],
      unknowns: [],
      verification: { commands: ["npm test"] },
      rollback: { strategy: "inverse_operations", verificationCommands: ["npm test"] },
      approval: { required: true, reviewerIds: ["reviewer-a"] },
      recipe: { id: "runtime", version: "1", digest: "sha256:test" },
    },
  },
  bsg: {
    id: "bsg-a",
    state: "locked",
    revision: 2,
    createdAt: "2026-08-01T10:00:00.000Z",
    nodes: [
      { id: "inventory", kind: "inventory", spec: "Inventory runtimes", sourceRefs: ["repo:api"] },
      { id: "api", kind: "semantic_change", spec: "Upgrade API", sourceRefs: ["repo:api"] },
      { id: "worker", kind: "semantic_change", spec: "Upgrade worker", sourceRefs: ["repo:worker"] },
    ],
    edges: [
      { id: "edge-a", from: "inventory", to: "api", kind: "depends_on" },
      { id: "edge-b", from: "inventory", to: "worker", kind: "depends_on" },
    ],
  },
};

const events: TransformerEventView[] = [
  {
    sequence: 1,
    id: "event-a",
    type: "unit.transitioned",
    entityType: "unit",
    entityId: "inventory",
    payload: { state: "completed" },
    evidenceRefs: ["test:inventory"],
    createdAt: "2026-08-01T10:20:00.000Z",
  },
  {
    sequence: 2,
    id: "event-b",
    type: "unit.transitioned",
    entityType: "unit",
    entityId: "api",
    payload: { state: "completed" },
    evidenceRefs: ["test:api"],
    createdAt: "2026-08-01T10:40:00.000Z",
  },
  {
    sequence: 3,
    id: "event-c",
    type: "attempt.transitioned",
    entityType: "attempt",
    entityId: "attempt-a",
    payload: { state: "succeeded", costUsd: 1.25 },
    evidenceRefs: ["test:verification"],
    createdAt: "2026-08-01T10:45:00.000Z",
  },
  {
    sequence: 4,
    id: "event-d",
    type: "approval.created",
    entityType: "approval",
    entityId: "approval-a",
    payload: { state: "pending", subjectType: "pr", subjectId: "pr-a" },
    evidenceRefs: ["review:requested"],
    createdAt: "2026-08-01T10:50:00.000Z",
  },
  {
    sequence: 5,
    id: "event-e",
    type: "approval.transitioned",
    entityType: "approval",
    entityId: "approval-a",
    payload: { state: "approved" },
    evidenceRefs: ["review:approval"],
    createdAt: "2026-08-01T11:00:00.000Z",
  },
  {
    sequence: 6,
    id: "event-f",
    type: "exception.created",
    entityType: "exception",
    entityId: "exception-a",
    payload: { state: "open" },
    evidenceRefs: ["test:exception"],
    createdAt: "2026-08-01T11:10:00.000Z",
  },
  {
    sequence: 7,
    id: "event-g",
    type: "campaign.transitioned",
    entityType: "campaign",
    entityId: "campaign-a",
    payload: { state: "paused", costUsd: 0.75 },
    evidenceRefs: ["operator:rollback-request"],
    createdAt: "2026-08-01T11:20:00.000Z",
  },
];

describe("Transformer workspace model", () => {
  it("turns the dependency graph into deterministic execution waves", () => {
    expect(dependencyWaves(campaign.bsg)).toEqual([
      { index: 1, nodeIds: ["inventory"] },
      { index: 2, nodeIds: ["api", "worker"] },
    ]);
  });

  it("fails closed when the behavioral graph contains a dependency cycle", () => {
    const cyclic = {
      ...campaign.bsg,
      edges: [
        ...campaign.bsg.edges,
        { id: "edge-cycle", from: "api", to: "inventory", kind: "depends_on" },
      ],
    };
    expect(() => dependencyWaves(cyclic)).toThrow("transformer_dependency_cycle");
  });

  it("derives all operator outcome metrics from tenant scoped campaign evidence", () => {
    const workspace = deriveTransformerWorkspace(campaign, events);

    expect(workspace.progress).toMatchObject({ completedNodes: 2, totalNodes: 3, completedWaves: 1, totalWaves: 2 });
    expect(workspace.metrics).toEqual({
      campaignCompletionPercent: 67,
      waveCompletionPercent: 50,
      acceptancePercent: 100,
      timeToFirstAcceptedPrMinutes: 60,
      openExceptions: 1,
      verificationPercent: 100,
      rollbackRequests: 1,
      legacyReductionPercent: 75,
      reviewerMinutesDelta: -30,
      costUsd: 2,
    });
  });

  it("keeps retry, pause, and rollback bounded by campaign state", () => {
    expect(campaignAction("running", "pause")).toEqual({ allowed: true, nextState: "paused" });
    expect(campaignAction("paused", "retry")).toEqual({ allowed: true, nextState: "running" });
    expect(campaignAction("running", "rollback")).toEqual({ allowed: true, nextState: "cancelled" });
    expect(campaignAction("completed", "rollback")).toEqual({ allowed: false, nextState: null });
  });
});
