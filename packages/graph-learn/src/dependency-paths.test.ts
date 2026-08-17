import { describe, expect, it } from "vitest";
import {
  openGraphLearnMemory,
  runGraphQuery,
  upsertEdge,
  upsertNode,
  type GraphLearnDb,
} from "./index.js";

function addNode(
  db: GraphLearnDb,
  id: string,
  repoId?: string,
  tenantId?: string,
) {
  upsertNode(db, {
    id,
    kind: "MigrationUnit",
    label: id,
    repo_id: repoId,
    props: tenantId ? { tenant_id: tenantId } : undefined,
  });
}

function addDependency(
  db: GraphLearnDb,
  source: string,
  target: string,
  confidence = 1,
) {
  upsertEdge(db, {
    id: `DEPENDS_ON:${source}:${target}`,
    kind: "DEPENDS_ON",
    source,
    target,
    confidence,
  });
}

describe("complete dependency path query", () => {
  it("enumerates every branch with deterministic confidence-first ranks", () => {
    const db = openGraphLearnMemory();
    try {
      for (const id of ["root", "high", "high-leaf", "low", "low-leaf"]) {
        addNode(db, id, "tenant-x");
      }
      addDependency(db, "root", "low", 0.7);
      addDependency(db, "low", "low-leaf", 1);
      addDependency(db, "root", "high", 0.9);
      addDependency(db, "high", "high-leaf", 1);

      const first = runGraphQuery(db, {
        op: "depends_on_path",
        nodeId: "root",
      }, { tenantId: "tenant-x" });
      const second = runGraphQuery(db, {
        op: "depends_on_path",
        nodeId: "root",
      }, { tenantId: "tenant-x" });

      expect(first.rows).toEqual([
        expect.objectContaining({
          rank: 1,
          nodeIds: ["root", "high", "high-leaf"],
          terminal: "leaf",
        }),
        expect.objectContaining({
          rank: 2,
          nodeIds: ["root", "low", "low-leaf"],
          terminal: "leaf",
        }),
      ]);
      expect(second.rows).toEqual(first.rows);
      expect(first.edges).toHaveLength(4);
      expect(first.truncation).toEqual(
        expect.objectContaining({ truncated: false, pathsReturned: 2 }),
      );
    } finally {
      db.raw.close();
    }
  });

  it("records cycles as terminal evidence without revisiting them", () => {
    const db = openGraphLearnMemory();
    try {
      for (const id of ["root", "branch", "leaf"]) addNode(db, id, "tenant-x");
      addDependency(db, "root", "branch");
      addDependency(db, "branch", "leaf", 1);
      addDependency(db, "branch", "root", 0.5);

      const result = runGraphQuery(db, {
        op: "depends_on_path",
        nodeId: "root",
        maxHops: 20,
      }, { tenantId: "tenant-x" });

      expect(result.rows).toEqual([
        expect.objectContaining({
          nodeIds: ["root", "branch", "leaf"],
          terminal: "leaf",
        }),
        expect.objectContaining({
          nodeIds: ["root", "branch", "root"],
          terminal: "cycle",
          cycleNodeId: "root",
        }),
      ]);
      expect(result.truncation?.truncated).toBe(false);
    } finally {
      db.raw.close();
    }
  });

  it("reports path-count and depth truncation explicitly", () => {
    const db = openGraphLearnMemory();
    try {
      for (const id of ["root", "a", "b", "c", "leaf"]) addNode(db, id, "tenant-x");
      addDependency(db, "root", "a", 0.9);
      addDependency(db, "root", "b", 0.8);
      addDependency(db, "root", "c", 0.7);
      addDependency(db, "a", "leaf");

      const pathLimited = runGraphQuery(db, {
        op: "depends_on_path",
        nodeId: "root",
        maxPaths: 2,
      }, { tenantId: "tenant-x" });
      expect(pathLimited.rows).toHaveLength(2);
      expect(pathLimited.truncation).toEqual(
        expect.objectContaining({
          truncated: true,
          reasons: ["max_paths"],
          maxPaths: 2,
          omittedPathsAtLeast: 1,
        }),
      );
      expect(pathLimited.summary).toContain("truncated by max_paths");

      const depthLimited = runGraphQuery(db, {
        op: "depends_on_path",
        nodeId: "root",
        maxHops: 1,
        maxPaths: 10,
      }, { tenantId: "tenant-x" });
      expect(depthLimited.rows?.[0]).toEqual(
        expect.objectContaining({
          nodeIds: ["root", "a"],
          terminal: "max_hops",
        }),
      );
      expect(depthLimited.truncation).toEqual(
        expect.objectContaining({
          truncated: true,
          reasons: ["max_hops"],
          maxHops: 1,
          omittedPathsAtLeast: 1,
        }),
      );
    } finally {
      db.raw.close();
    }
  });

  it("enumerates only paths visible in the authenticated tenant view", () => {
    const db = openGraphLearnMemory();
    try {
      addNode(db, "unit:tenant-a:root", "tenant-a:repo");
      addNode(db, "unit:tenant-a:dependency", "tenant-a:repo");
      addNode(db, "unit:tenant-b:root", "tenant-b:repo");
      addNode(db, "unit:tenant-b:secret", "tenant-b:repo");
      addDependency(db, "unit:tenant-a:root", "unit:tenant-a:dependency");
      addDependency(db, "unit:tenant-b:root", "unit:tenant-b:secret");

      const scope = { tenantId: "tenant-a", consumerIds: [] };
      const own = runGraphQuery(
        db,
        { op: "depends_on_path", nodeId: "unit:tenant-a:root" },
        scope,
      );
      expect(own.rows?.[0]).toEqual(
        expect.objectContaining({
          nodeIds: ["unit:tenant-a:root", "unit:tenant-a:dependency"],
        }),
      );
      expect(JSON.stringify(own)).not.toContain("tenant-b");

      const foreign = runGraphQuery(
        db,
        { op: "depends_on_path", nodeId: "unit:tenant-b:root" },
        scope,
      );
      expect(foreign.rows).toEqual([]);
      expect(foreign.nodes).toEqual([]);
      expect(foreign.edges).toEqual([]);
    } finally {
      db.raw.close();
    }
  });

  it("retains dependency ordered repository transitions for cross repository rollout", () => {
    const db = openGraphLearnMemory();
    try {
      addNode(db, "unit:edge", "repo-edge", "tenant-x");
      addNode(db, "unit:service", "repo-service", "tenant-x");
      addNode(db, "unit:contract", "repo-contract", "tenant-x");
      addDependency(db, "unit:edge", "unit:service");
      addDependency(db, "unit:service", "unit:contract");

      const result = runGraphQuery(db, {
        op: "depends_on_path",
        nodeId: "unit:edge",
      }, { tenantId: "tenant-x" });

      expect(result.rows?.[0]).toEqual(expect.objectContaining({
        nodeIds: ["unit:edge", "unit:service", "unit:contract"],
        repositoryIds: ["repo-edge", "repo-service", "repo-contract"],
      }));
    } finally {
      db.raw.close();
    }
  });
});
