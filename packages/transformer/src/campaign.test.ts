import { describe, expect, it } from "vitest";
import {
  createCampaign,
  diffOutputs,
  orderDag,
  planFromCampaign,
} from "./index.js";

describe("transformer DAG + campaign", () => {
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
    expect(diffOutputs({ a: 1 }, { a: 2 }).equal).toBe(false);
  });
});
