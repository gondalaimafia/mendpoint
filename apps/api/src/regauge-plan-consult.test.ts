import { describe, expect, it } from "vitest";
import {
  ingestManifestDependencies,
  openGraphLearnMemory,
  upsertEdge,
  upsertNode,
} from "@mendpoint/graph-learn";
import {
  consultRegaugeGraphDependencies,
  consultRegaugeOrganizationMemory,
} from "./regauge-plan-consult.js";

describe("consultRegaugeGraphDependencies", () => {
  const ingest = (
    db: ReturnType<typeof openGraphLearnMemory>,
    tenantId: string,
    repositoryId: string,
    packageName: string,
    dependencies: Record<string, string> = {},
  ) => ingestManifestDependencies(db, {
    repoPath: "/unused",
    repoId: repositoryId,
    tenantId,
    files: [{ path: "package.json", text: JSON.stringify({ name: packageName, dependencies }) }],
  });

  it("binds not_consulted coverage to every requested repository when no graph is supplied", () => {
    const result = consultRegaugeGraphDependencies({
      graph: null,
      tenantId: "tenant-a",
      repositoryIds: ["shop", "billing"],
    });
    expect(result).toMatchObject({
      schemaVersion: "2026-08-27.v1",
      tenantId: "tenant-a",
      requestedRepositoryIds: ["billing", "shop"],
      repositories: [
        { repositoryId: "billing", coverage: "not_consulted", dependsOnRepositoryIds: [] },
        { repositoryId: "shop", coverage: "not_consulted", dependsOnRepositoryIds: [] },
      ],
      edges: [],
    });
    expect(result.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("represents known-empty only when valid manifest ingest evidence exists", () => {
    const db = openGraphLearnMemory();
    const evidence = ingest(db, "tenant-a", "shop", "shop");
    const result = consultRegaugeGraphDependencies({
      graph: db,
      tenantId: "tenant-a",
      repositoryIds: ["shop"],
    });
    expect(result.repositories).toEqual([expect.objectContaining({
      repositoryId: "shop",
      coverage: "complete",
      reason: "manifest_ingest_complete",
      dependsOnRepositoryIds: [],
      evidenceRefs: evidence.evidenceRefs,
    })]);
    db.raw.close();
  });

  it("maps a manifest dependency to an exact requested repository with provenance", () => {
    const db = openGraphLearnMemory();
    ingest(db, "tenant-a", "repo-b", "billing");
    ingest(db, "tenant-a", "repo-a", "shop", { billing: "workspace:*" });
    const result = consultRegaugeGraphDependencies({
      graph: db,
      tenantId: "tenant-a",
      repositoryIds: ["repo-a", "repo-b"],
    });
    expect(result.repositories).toEqual([
      expect.objectContaining({ repositoryId: "repo-a", coverage: "complete", dependsOnRepositoryIds: ["repo-b"] }),
      expect.objectContaining({ repositoryId: "repo-b", coverage: "complete", dependsOnRepositoryIds: [] }),
    ]);
    expect(result.edges).toEqual([expect.objectContaining({
      sourceRepositoryId: "repo-a",
      targetRepositoryId: "repo-b",
      sourceSystem: "manifest",
      evidenceRefs: [expect.stringMatching(/^manifest-ingest:sha256:/)],
    })]);
    db.raw.close();
  });

  it("is deterministic under requested-repository and ingest ordering", () => {
    const db = openGraphLearnMemory();
    ingest(db, "tenant-a", "repo-a", "shop", { billing: "workspace:*" });
    ingest(db, "tenant-a", "repo-b", "billing");
    const first = consultRegaugeGraphDependencies({ graph: db, tenantId: "tenant-a", repositoryIds: ["repo-b", "repo-a"] });
    const second = consultRegaugeGraphDependencies({ graph: db, tenantId: "tenant-a", repositoryIds: ["repo-a", "repo-b"] });
    expect(second).toEqual(first);
    db.raw.close();
  });

  it("marks missing and ambiguous manifest roots unknown instead of empty", () => {
    const db = openGraphLearnMemory();
    expect(consultRegaugeGraphDependencies({ graph: db, tenantId: "tenant-a", repositoryIds: ["repo-missing"] }).repositories[0])
      .toMatchObject({ repositoryId: "repo-missing", coverage: "unknown", reason: "manifest_ingest_evidence_missing" });
    ingest(db, "tenant-a", "repo-a", "shop");
    ingest(db, "tenant-a", "repo-a", "storefront");
    expect(consultRegaugeGraphDependencies({ graph: db, tenantId: "tenant-a", repositoryIds: ["repo-a"] }).repositories[0])
      .toMatchObject({ repositoryId: "repo-a", coverage: "unknown", reason: "manifest_root_ambiguous" });
    db.raw.close();
  });

  it("marks an unmapped manifest target unknown and ignores unrelated edges", () => {
    const db = openGraphLearnMemory();
    ingest(db, "tenant-a", "repo-a", "shop", { unknown_internal: "workspace:*" });
    upsertNode(db, { id: "service:provider-a", kind: "Service", label: "provider-a", props: { tenant_id: "tenant-a" } });
    upsertNode(db, { id: "service:provider-b", kind: "Service", label: "provider-b", props: { tenant_id: "tenant-a" } });
    upsertEdge(db, {
      id: "DEPENDS_ON:provider-a:provider-b",
      kind: "DEPENDS_ON",
      source: "service:provider-a",
      target: "service:provider-b",
      source_system: "provider",
    });
    const result = consultRegaugeGraphDependencies({ graph: db, tenantId: "tenant-a", repositoryIds: ["repo-a"] });
    expect(result.repositories[0]).toMatchObject({
      repositoryId: "repo-a",
      coverage: "unknown",
      reason: "dependency_target_unmapped",
      dependsOnRepositoryIds: [],
    });
    expect(result.edges).toEqual([]);
    db.raw.close();
  });

  it("excludes cross-tenant roots and edges from the projection", () => {
    const db = openGraphLearnMemory();
    ingest(db, "tenant-b", "repo-a", "shop");
    const result = consultRegaugeGraphDependencies({
      graph: db,
      tenantId: "tenant-a",
      repositoryIds: ["repo-a"],
    });
    expect(result.repositories[0]).toMatchObject({ repositoryId: "repo-a", coverage: "unknown", reason: "manifest_ingest_evidence_missing" });
    expect(result.edges).toEqual([]);
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
