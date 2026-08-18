/**
 * Regression tests for two graph query-path defects:
 *  1. Attacker-controlled traversal bounds (maxHops/result size) must be clamped
 *     by the engine, and a clamped result must report `partial` coverage.
 *  2. Edges closed with a past `valid_to` must not be returned as current facts
 *     by blast_radius / neighbors / callers / path, while time-travel ops keep
 *     seeing history and future-valid edges are still current.
 */
import { describe, expect, it } from "vitest";
import {
  GraphQuerySchema,
  blastRadius,
  openGraphLearnMemory,
  runGraphQuery,
  seedSyntheticTemporal,
  upsertEdge,
  upsertNode,
  type GraphLearnDb,
  type GlEdgeKind,
} from "./index.js";

const TENANT = "t";
const scope = { tenantId: TENANT };
const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

function node(db: GraphLearnDb, id: string, kind = "Symbol"): void {
  upsertNode(db, {
    id,
    kind: kind as never,
    label: id,
    repo_id: TENANT,
  });
}

function edge(
  db: GraphLearnDb,
  id: string,
  source: string,
  target: string,
  kind: GlEdgeKind,
  validFrom: string,
  validTo: string | null,
): void {
  upsertEdge(db, {
    id,
    kind,
    source,
    target,
    valid_from: validFrom,
    valid_to: validTo,
    source_system: "git",
    confidence: 1,
  });
}

describe("graph query input bounds", () => {
  it("clamps an attacker-supplied maxHops and reports partial coverage", () => {
    const db = openGraphLearnMemory();
    try {
      node(db, "sym:a");
      node(db, "sym:b");
      edge(db, "e1", "sym:a", "sym:b", "CALLS", PAST, null);

      const started = performance.now();
      const result = runGraphQuery(
        db,
        { op: "blast_radius", nodeId: "sym:a", maxHops: 1e9 },
        scope,
      );
      // Bounded work: an unclamped 1e9-iteration loop could not return promptly.
      expect(performance.now() - started).toBeLessThan(1000);
      expect(result.coverage?.basis).toBe("partial");
      expect(result.coverage?.basis).not.toBe("complete");
      expect(result.coverage?.reason).toMatch(/clamp/i);
    } finally {
      db.raw.close();
    }
  });

  it("caps blast-radius breadth and flags the result partial", () => {
    const db = openGraphLearnMemory();
    try {
      node(db, "hub");
      // A star wider than the hard result cap must not be reported complete.
      for (let i = 0; i < 1100; i++) {
        node(db, `leaf:${i}`);
        edge(db, `he:${i}`, "hub", `leaf:${i}`, "RELATED", PAST, null);
      }
      const r = blastRadius(db, "hub", 4);
      expect(r.truncated).toBe(true);
      const result = runGraphQuery(
        db,
        { op: "blast_radius", nodeId: "hub", maxHops: 4 },
        scope,
      );
      expect(result.coverage?.basis).toBe("partial");
    } finally {
      db.raw.close();
    }
  });

  it("bounds the consumers_of_field endpoint scan", () => {
    const db = openGraphLearnMemory();
    try {
      node(db, "schema:S", "Schema");
      upsertNode(db, {
        id: "schema:S",
        kind: "Schema" as never,
        label: "S",
        repo_id: TENANT,
        props: { name: "S", path: "/x", method: "GET" },
      });
      upsertNode(db, {
        id: "field:F",
        kind: "Field" as never,
        label: "F",
        repo_id: TENANT,
        props: { name: "F" },
      });
      edge(db, "hf", "schema:S", "field:F", "HAS_FIELD", PAST, null);
      // More endpoints than the hard result cap sharing the schema's path.
      for (let i = 0; i < 1100; i++) {
        upsertNode(db, {
          id: `endpoint:${i}`,
          kind: "Endpoint" as never,
          label: `E${i}`,
          repo_id: TENANT,
          props: { path: "/x", method: "GET" },
        });
      }
      const result = runGraphQuery(
        db,
        { op: "consumers_of_field", schemaName: "S", fieldName: "F" },
        scope,
      );
      expect(result.coverage?.basis).toBe("partial");
    } finally {
      db.raw.close();
    }
  });
});

describe("graph query boundary validation (POST /graph-learn/query)", () => {
  it("rejects a malformed body so the route answers 400, not 500", () => {
    // Missing required nodeId.
    expect(GraphQuerySchema.safeParse({ op: "blast_radius" }).success).toBe(
      false,
    );
    // Wrong type for a numeric bound.
    expect(
      GraphQuerySchema.safeParse({
        op: "blast_radius",
        nodeId: "x",
        maxHops: "lots",
      }).success,
    ).toBe(false);
    // Unknown op.
    expect(GraphQuerySchema.safeParse({ op: "drop_tables" }).success).toBe(
      false,
    );
    // Missing op entirely.
    expect(GraphQuerySchema.safeParse({ nodeId: "x" }).success).toBe(false);
  });

  it("accepts an oversized maxHops at the boundary and clamps it in the engine", () => {
    const db = openGraphLearnMemory();
    try {
      node(db, "sym:a");
      // Mirror the route: validate, then run. The boundary accepts the value;
      // the engine clamps it and downgrades coverage to partial.
      const parsed = GraphQuerySchema.safeParse({
        op: "blast_radius",
        nodeId: "sym:a",
        maxHops: 1e9,
      });
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      const result = runGraphQuery(db, parsed.data, scope);
      expect(result.coverage?.basis).toBe("partial");
    } finally {
      db.raw.close();
    }
  });
});

describe("temporal validity of returned edges", () => {
  function seedValidityGraph(db: GraphLearnDb): void {
    node(db, "a");
    node(db, "past");
    node(db, "future");
    node(db, "open");
    node(db, "future_start");
    // Closed in the past — no longer a current fact.
    edge(db, "e_past", "a", "past", "RELATED", PAST, PAST);
    // Closed in the future — still valid now.
    edge(db, "e_future", "a", "future", "RELATED", PAST, FUTURE);
    // Never closed — valid now.
    edge(db, "e_open", "a", "open", "RELATED", PAST, null);
    // Validity begins in the future — not current yet.
    edge(db, "e_future_start", "a", "future_start", "RELATED", FUTURE, null);
  }

  it("omits past-invalidated edges from blast_radius and neighbors", () => {
    const db = openGraphLearnMemory();
    try {
      seedValidityGraph(db);
      const blast = runGraphQuery(
        db,
        { op: "blast_radius", nodeId: "a", maxHops: 1 },
        scope,
      );
      const blastIds = blast.nodes.map((n) => n.id);
      expect(blastIds).toContain("future");
      expect(blastIds).toContain("open");
      expect(blastIds).not.toContain("past");
      expect(blastIds).not.toContain("future_start");

      const neighbors = runGraphQuery(
        db,
        { op: "neighbors", nodeId: "a" },
        scope,
      );
      const targets = neighbors.edges.map((e) => e.target);
      expect(targets).toContain("future");
      expect(targets).toContain("open");
      expect(targets).not.toContain("past");
      expect(targets).not.toContain("future_start");
    } finally {
      db.raw.close();
    }
  });

  it("omits a past-invalidated CALLS edge from callers", () => {
    const db = openGraphLearnMemory();
    try {
      node(db, "sym:target");
      node(db, "sym:old_caller");
      node(db, "sym:live_caller");
      edge(db, "c_old", "sym:old_caller", "sym:target", "CALLS", PAST, PAST);
      edge(db, "c_live", "sym:live_caller", "sym:target", "CALLS", PAST, null);
      const result = runGraphQuery(
        db,
        { op: "callers", symbolId: "sym:target" },
        scope,
      );
      const callers = result.edges.map((e) => e.source);
      expect(callers).toContain("sym:live_caller");
      expect(callers).not.toContain("sym:old_caller");
    } finally {
      db.raw.close();
    }
  });

  it("will not route a path across a past-invalidated edge", () => {
    const db = openGraphLearnMemory();
    try {
      node(db, "a");
      node(db, "mid");
      node(db, "reachable");
      node(db, "stale");
      // Live chain a -> mid -> reachable.
      edge(db, "p1", "a", "mid", "DEPENDS_ON", PAST, null);
      edge(db, "p2", "mid", "reachable", "DEPENDS_ON", PAST, null);
      // Only route to `stale` is through an invalidated edge.
      edge(db, "p_stale", "a", "stale", "DEPENDS_ON", PAST, PAST);

      const live = runGraphQuery(
        db,
        { op: "path", fromId: "a", toId: "reachable" },
        scope,
      );
      expect(live.edges.length).toBeGreaterThan(0);

      const stale = runGraphQuery(
        db,
        { op: "path", fromId: "a", toId: "stale" },
        scope,
      );
      expect(stale.edges).toHaveLength(0);
    } finally {
      db.raw.close();
    }
  });

  it("still lets time-travel ops see historical edges", () => {
    const db = openGraphLearnMemory();
    try {
      seedSyntheticTemporal(db, "demo");
      // At a timestamp inside the first window, the CALLS edge closed in
      // 2025-06 (now in the past) is still visible via time travel.
      const calls = runGraphQuery(
        db,
        { op: "time_travel_calls", at: "2025-03-01T00:00:00.000Z" },
        { tenantId: "demo" },
      );
      expect(calls.summary).toMatch(/CALLS/);
      expect(calls.edges.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.raw.close();
    }
  });
});
