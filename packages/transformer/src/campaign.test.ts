import { describe, expect, it } from "vitest";
import {
  CampaignValidationError,
  createCampaign,
  classifyMigrationChange,
  diffOutputs,
  MIGRATION_COMPATIBILITY_RULES,
  orderDag,
  planFromCampaign,
  planMultiRepoAgents,
} from "./index.js";

describe("transformer DAG + campaign", () => {
  it("rejects malformed campaign input at the domain boundary", () => {
    expect(() => createCampaign(null)).toThrow(CampaignValidationError);
    expect(() =>
      createCampaign({ name: "Migration", sourceSystem: "old", targetStack: "new", dag: "no" }),
    ).toThrow("dag must contain at least one node");
    expect(() =>
      createCampaign({
        name: "Migration",
        sourceSystem: "old",
        targetStack: "new",
        dag: [{ id: "one", title: "One", repoKey: "repo", dependsOn: [1] }],
      }),
    ).toThrow("dag[0].dependsOn[0] is required");
    expect(() =>
      createCampaign({
        name: "Migration",
        sourceSystem: "old",
        targetStack: "new",
        dag: [{ id: "one", title: "One", repoKey: "repo", dependsOn: [] }],
        bsg: { id: "graph", nodes: [], edges: [] },
      }),
    ).toThrow("bsg.title is required");
    expect(() =>
      createCampaign({
        name: "Migration",
        sourceSystem: "old",
        targetStack: "new",
        dag: [{ id: "one", title: "One", repoKey: "repo", dependsOn: [] }],
        bsg: {
          id: "graph",
          title: "Graph",
          sourceSystem: "old",
          targetSystem: "new",
          nodes: [],
          edges: [{ id: "edge", from: "missing", to: "missing", kind: "implies" }],
        },
      }),
    ).toThrow("references an unknown node");
  });

  it("toposorts PR units", () => {
    const ordered = orderDag([
      {
        id: "b",
        title: "B",
        repoKey: "svc-b",
        dependsOn: ["a"],
        status: "pending",
      },
      {
        id: "a",
        title: "A",
        repoKey: "svc-a",
        dependsOn: [],
        status: "pending",
      },
      {
        id: "c",
        title: "C",
        repoKey: "svc-c",
        dependsOn: ["b"],
        status: "pending",
      },
    ]);
    expect(ordered.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("builds plan from campaign", () => {
    const c = createCampaign({
      name: "billing-modernize",
      sourceSystem: "vb6-billing",
      targetStack: "node-ts",
      dag: [
        { id: "1", title: "Extract domain", repoKey: "core", dependsOn: [] },
        {
          id: "2",
          title: "Port API",
          repoKey: "api",
          dependsOn: ["1"],
        },
      ],
    });
    const plan = planFromCampaign(c);
    expect(plan.agent).toBe("transformer");
    expect(plan.kind).toBe("bsg_campaign");
    expect(plan.steps.length).toBeGreaterThanOrEqual(3);
    expect(plan.steps.some((s) => s.action === "dag.pr_unit")).toBe(true);
  });

  it("diffs outputs", () => {
    expect(diffOutputs({ a: 1 }, { a: 1 }).equal).toBe(true);
    expect(diffOutputs({ a: 1, b: 2 }, { b: 2, a: 1 }).equal).toBe(true);
    expect(diffOutputs({ a: 1 }, { a: 2 }).equal).toBe(false);
    expect(diffOutputs({ a: undefined }, { a: null }).equal).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(diffOutputs(cyclic, cyclic)).toMatchObject({
      equal: false,
      comparisonError: "cyclic output cannot be compared",
    });
  });

  it.each([
    {
      name: "empty graph",
      nodes: [],
      message: /at least one node/,
    },
    {
      name: "duplicate id",
      nodes: [
        { id: "a", title: "A", repoKey: "one", dependsOn: [], status: "pending" as const },
        { id: "a", title: "B", repoKey: "two", dependsOn: [], status: "pending" as const },
      ],
      message: /duplicate node id/,
    },
    {
      name: "unknown dependency",
      nodes: [
        { id: "a", title: "A", repoKey: "one", dependsOn: ["missing"], status: "pending" as const },
      ],
      message: /unknown dependency/,
    },
    {
      name: "self dependency",
      nodes: [
        { id: "a", title: "A", repoKey: "one", dependsOn: ["a"], status: "pending" as const },
      ],
      message: /cannot depend on itself/,
    },
    {
      name: "cycle",
      nodes: [
        { id: "a", title: "A", repoKey: "one", dependsOn: ["b"], status: "pending" as const },
        { id: "b", title: "B", repoKey: "two", dependsOn: ["a"], status: "pending" as const },
      ],
      message: /cycle involving: a, b/,
    },
  ])("rejects a malformed $name", ({ nodes, message }) => {
    expect(() => orderDag(nodes)).toThrow(message);
  });

  it("assigns one agent per repo and waves", () => {
    const c = createCampaign({
      name: "m",
      sourceSystem: "legacy",
      targetStack: "node",
      dag: [
        { id: "1", title: "A", repoKey: "repo-a", dependsOn: [] },
        { id: "2", title: "B", repoKey: "repo-b", dependsOn: ["1"] },
        { id: "3", title: "A2", repoKey: "repo-a", dependsOn: ["1"] },
      ],
    });
    const mp = planMultiRepoAgents(c);
    expect(mp.assignments.length).toBe(2);
    expect(mp.waves[0]).toContain("1");
    expect(mp.waves.length).toBeGreaterThanOrEqual(2);
    expect(mp.waves.flat()).toHaveLength(3);
    for (const wave of mp.waves) {
      const repoKeys = wave.map((id) => c.dag.find((node) => node.id === id)!.repoKey);
      expect(new Set(repoKeys).size).toBe(repoKeys.length);
    }
    expect(planMultiRepoAgents(c)).toEqual(mp);
  });

  it("classifies compatibility across source, wire, semantic, state, and security dimensions", () => {
    expect(MIGRATION_COMPATIBILITY_RULES.length).toBeGreaterThanOrEqual(30);
    expect(classifyMigrationChange("rest_add_optional_request_field")).toMatchObject({
      severity: "additive",
      requiresApproval: false,
    });
    expect(classifyMigrationChange("protobuf_change_field_number")).toMatchObject({
      severity: "breaking",
      dimensions: expect.arrayContaining(["wire", "state"]),
      autoExecutable: false,
    });
    expect(classifyMigrationChange("oauth_remove_insecure_flow")).toMatchObject({
      severity: "security_required",
      dimensions: expect.arrayContaining(["security"]),
      requiresApproval: true,
    });
  });
});
