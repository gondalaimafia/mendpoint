import { describe, expect, it } from "vitest";
import type { GroundTruth } from "../ground-truth/schema.js";
import { loadAllGroundTruth } from "../ground-truth/load.js";
import {
  classifyTaskFamily,
  groupByTaskFamily,
  importChainHops,
  REPORTED_TASK_FAMILIES,
} from "./task-family.js";

function gt(overrides: Partial<GroundTruth> = {}): GroundTruth {
  return {
    scenario_id: "fettler-x",
    repo_family: "typescript-service",
    difficulty: 3,
    difficulty_rationale: "test",
    intended_product: ["fettler"],
    dataset_split: "development",
    correct_behavior: "flag_files",
    faults: [],
    expected_findings: ["src/a.ts", "src/b.ts"],
    acceptable_findings: [],
    false_positive_traps: [],
    blast_radius_truth: { affectedFiles: 2 },
    tags: [],
    ...overrides,
  } as GroundTruth;
}

describe("importChainHops", () => {
  it("returns null when there is no chain to read (never conflated with a single hop)", () => {
    expect(importChainHops(undefined)).toBeNull();
    expect(importChainHops([])).toBeNull();
  });

  it("counts a single direct reference as one hop", () => {
    expect(importChainHops(["lib/index.js wires the client into one service"])).toBe(1);
  });

  it("counts chain arrows as nodes (N arrows = N+1 hops)", () => {
    expect(importChainHops(["order.js -> facade.js -> http.js -> vendor/sdk.js"])).toBe(4);
    expect(importChainHops(["a → b → c"])).toBe(3);
  });

  it("counts multiple entries as segments of one chain", () => {
    // Two chain arrows across the entries describe three nodes.
    expect(importChainHops(["providers/client.ts", "-> service.ts", "-> job.ts"])).toBe(3);
    // Arrowless entries each count as a distinct named hop.
    expect(importChainHops(["providers/client.ts", "service.ts", "job.ts"])).toBe(3);
  });
});

describe("classifyTaskFamily", () => {
  it("classifies a multi-hop chain as relationship-heavy", () => {
    const c = classifyTaskFamily(
      gt({ blast_radius_truth: { affectedFiles: 4, importChain: ["a -> b -> c"] } }),
    );
    expect(c.family).toBe("relationship-heavy");
    expect(c.reason).toContain("3 hops");
    expect(c.signals.importChainHops).toBe(3);
  });

  it("classifies a single direct reference as direct-reference", () => {
    const c = classifyTaskFamily(
      gt({ blast_radius_truth: { affectedFiles: 1, importChain: ["a direct import of the symbol"] } }),
    );
    expect(c.family).toBe("direct-reference");
    expect(c.signals.importChainHops).toBe(1);
  });

  it("does NOT default a retrieval task with no importChain into a family", () => {
    const c = classifyTaskFamily(gt({ blast_radius_truth: { affectedFiles: 8 } }));
    expect(c.family).toBe("unclassified");
    expect(c.reason).toContain("no importChain answer key");
    expect(c.signals.importChainHops).toBeNull();
  });

  it("keeps abstain/no_op restraint scenarios off the retrieval axis", () => {
    for (const behavior of ["abstain", "no_op"] as const) {
      const c = classifyTaskFamily(
        gt({ correct_behavior: behavior, expected_findings: [], blast_radius_truth: { affectedFiles: 0 } }),
      );
      expect(c.family).toBe("unclassified");
      expect(c.reason).toContain("restraint/coverage");
    }
  });

  it("records the corpus signals it derived from, so the classification is inspectable", () => {
    const c = classifyTaskFamily(
      gt({ repo_family: "node-service-edge", difficulty: 4, blast_radius_truth: { affectedFiles: 5, importChain: ["a -> b"] } }),
    );
    expect(c.signals).toEqual({
      correct_behavior: "flag_files",
      expectedFindings: 2,
      importChainHops: 2,
      repo_family: "node-service-edge",
      difficulty: 4,
    });
  });
});

describe("groupByTaskFamily", () => {
  it("splits into three buckets and never pools direct with relationship-heavy", () => {
    const items = [
      gt({ scenario_id: "rel", blast_radius_truth: { affectedFiles: 3, importChain: ["a -> b -> c"] } }),
      gt({ scenario_id: "dir", blast_radius_truth: { affectedFiles: 1, importChain: ["direct"] } }),
      gt({ scenario_id: "none", blast_radius_truth: { affectedFiles: 2 } }),
    ];
    const groups = groupByTaskFamily(items, (g) => classifyTaskFamily(g).family);
    expect(groups["relationship-heavy"].map((g) => g.scenario_id)).toEqual(["rel"]);
    expect(groups["direct-reference"].map((g) => g.scenario_id)).toEqual(["dir"]);
    expect(groups.unclassified.map((g) => g.scenario_id)).toEqual(["none"]);
    // The reported families never include the honest catch-all bucket.
    expect(REPORTED_TASK_FAMILIES).not.toContain("unclassified");
  });
});

describe("classification over the real corpus is deterministic and inspectable", () => {
  it("derives every scenario's family from ground truth alone, with a stated reason", () => {
    const all = loadAllGroundTruth();
    expect(all.length).toBeGreaterThan(0);
    for (const g of all) {
      const c = classifyTaskFamily(g);
      // A reason is always present; nothing is placed by silent default.
      expect(c.reason.length).toBeGreaterThan(0);
      // Every scenario the corpus encodes a multi-hop chain for is relationship-heavy.
      const hops = importChainHops(g.blast_radius_truth?.importChain);
      if (
        (g.correct_behavior === "flag_files" || g.correct_behavior === "apply_recipe") &&
        g.expected_findings.length > 0 &&
        hops !== null &&
        hops >= 2
      ) {
        expect(c.family, `${g.scenario_id}`).toBe("relationship-heavy");
      }
    }
  });

  it("holdout ground truth is classified from the answer key alone (never the repo under test)", () => {
    // Classification touches only GroundTruth — the answer key that is NEVER
    // staged into the repo a product sees. So a holdout scenario can be placed on
    // the axis without exposing its key. Assert the function is pure over GT: the
    // same GT yields the same classification with no filesystem access needed.
    const holdoutLike = gt({
      dataset_split: "holdout",
      blast_radius_truth: { affectedFiles: 3, importChain: ["wrapper -> core -> sink"] },
    });
    const a = classifyTaskFamily(holdoutLike);
    const b = classifyTaskFamily(holdoutLike);
    expect(a).toEqual(b);
    expect(a.family).toBe("relationship-heavy");
  });
});
