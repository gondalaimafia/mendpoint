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

  it("tenant-scopes an in-memory graph so cross-tenant edges never leak", () => {
    const db = openGraphLearnMemory();
    upsertNode(db, { id: "service:shop", kind: "Service", label: "shop", repo_id: "tenant-a" });
    upsertNode(db, { id: "service:billing", kind: "Service", label: "billing", repo_id: "tenant-a" });
    upsertNode(db, { id: "service:leak", kind: "Service", label: "leak", repo_id: "tenant-b" });
    upsertEdge(db, {
      id: "DEPENDS_ON:shop:billing",
      kind: "DEPENDS_ON",
      source: "service:shop",
      target: "service:billing",
      source_system: "manifest",
    });
    upsertEdge(db, {
      id: "DEPENDS_ON:shop:leak",
      kind: "DEPENDS_ON",
      source: "service:shop",
      target: "service:leak",
      source_system: "manifest",
    });
    const result = consultRegaugeGraphDependencies({
      graph: db,
      tenantId: "tenant-a",
      repositoryIds: ["shop", "billing", "leak"],
    });
    // Without tenant scoping the shop -> leak edge (leak owned by tenant-b) would
    // surface here; scoping the in-memory graph drops it.
    expect(result.dependsOnByRepositoryId).toEqual({
      shop: ["billing"],
      billing: [],
      leak: [],
    });
    db.raw.close();
  });
});

describe("consultRegaugeOrganizationMemory", () => {
  it("declares not_consulted when no memory provider is supplied", () => {
    const result = consultRegaugeOrganizationMemory({
      tenantId: "tenant-a",
      hardPolicy: { tenantId: "tenant-a", id: "policy-1", directive: "no force push" },
      records: null,
    });
    expect(result.consulted).toBe(false);
    expect(result.basis).toBe("not_consulted");
    // The dishonest pre-fix behavior resolved null into a hard-policy win; a
    // not_consulted result must not carry resolver fields.
    expect(result).not.toHaveProperty("winner");
  });

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
    if (!result.consulted) throw new Error("expected a consulted result");
    expect(result.winner).toBe("hard_policy");
    expect(result.appliedMemoryId).toBeNull();
    expect(result.overriddenMemoryIds).toEqual(["om-1"]);
  });

  it("carries every ACTIVE convention as overridden, not just the first per layer", () => {
    const active = (n: number) => ({
      tenantId: "tenant-a",
      memoryId: `om-${n}`,
      recordId: `omr-${n}`,
      status: "ACTIVE" as const,
      statement: `convention ${n}`,
    });
    const result = consultRegaugeOrganizationMemory({
      tenantId: "tenant-a",
      hardPolicy: { tenantId: "tenant-a", id: "policy-1", directive: "no force push" },
      records: [active(3), active(1), active(2)],
    });
    expect(result.consulted).toBe(true);
    if (!result.consulted) throw new Error("expected a consulted result");
    // All three ACTIVE conventions are outranked by hard policy and must all be
    // surfaced; the pre-fix `.find` dropped records 2..N.
    expect(result.overriddenMemoryIds).toEqual(["om-1", "om-2", "om-3"]);
  });
});
