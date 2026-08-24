import { describe, expect, it } from "vitest";
import {
  openGraphLearnMemory,
  upsertEdge,
  upsertNode,
} from "@mendpoint/graph-learn";
import {
  consultRegaugeGraphDependencies,
  consultRegaugeOrganizationMemory,
} from "./regauge-plan-consult.js";

describe("consultRegaugeGraphDependencies", () => {
  it("declares not_consulted when no graph is supplied", () => {
    const result = consultRegaugeGraphDependencies({
      graph: null,
      tenantId: "tenant-a",
      repositoryIds: ["shop"],
    });
    expect(result).toMatchObject({
      consulted: false,
      coverage: { basis: "not_consulted" },
      dependsOnByRepositoryId: {},
    });
  });

  it("fails closed when DEPENDS_ON is empty rather than treating units as independent", () => {
    const db = openGraphLearnMemory();
    upsertNode(db, { id: "service:shop", kind: "Service", label: "shop", repo_id: "tenant-a" });
    const result = consultRegaugeGraphDependencies({
      graph: db,
      tenantId: "tenant-a",
      repositoryIds: ["shop"],
    });
    expect(result.coverage.basis).toBe("target_absent");
    expect(result.dependsOnByRepositoryId).toEqual({});
    db.raw.close();
  });

  it("maps Service DEPENDS_ON onto campaign repository ids", () => {
    const db = openGraphLearnMemory();
    upsertNode(db, { id: "service:shop", kind: "Service", label: "shop", repo_id: "tenant-a" });
    upsertNode(db, { id: "service:billing", kind: "Service", label: "billing", repo_id: "tenant-a" });
    upsertEdge(db, {
      id: "DEPENDS_ON:shop:billing",
      kind: "DEPENDS_ON",
      source: "service:shop",
      target: "service:billing",
      source_system: "manifest",
    });
    const result = consultRegaugeGraphDependencies({
      graph: db,
      tenantId: "tenant-a",
      repositoryIds: ["shop", "billing"],
    });
    expect(result.coverage.basis).toBe("complete");
    expect(result.dependsOnByRepositoryId).toEqual({
      shop: ["billing"],
      billing: [],
    });
    db.raw.close();
  });
});

describe("consultRegaugeOrganizationMemory", () => {
  it("keeps confirmed memory subordinate to hard policy", () => {
    const result = consultRegaugeOrganizationMemory({
      tenantId: "tenant-a",
      hardPolicy: { tenantId: "tenant-a", id: "policy-1", directive: "no force push" },
      records: [{
        tenantId: "tenant-a",
        memoryId: "om-1",
        recordId: "omr-1",
        status: "ACTIVE",
        statement: "prefer squash merges",
      }],
    });
    expect(result.consulted).toBe(true);
    expect(result.winner).toBe("hard_policy");
    expect(result.appliedMemoryId).toBeNull();
    expect(result.overriddenMemoryIds).toEqual(["om-1"]);
  });
});
