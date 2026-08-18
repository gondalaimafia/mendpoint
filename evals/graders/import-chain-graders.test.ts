import { describe, it, expect } from "vitest";
import type { GraphPath } from "@mendpoint/shared";
import { gradeImportChain, type ObservedFindingPath } from "./import-chain-graders.js";
import { validateGroundTruth, type GroundTruth } from "../ground-truth/schema.js";
import { loadAllGroundTruth } from "../ground-truth/load.js";

/** A complete (anchor-terminated) path over `nodes`. */
const complete = (nodes: string[]): GraphPath => ({
  nodes,
  hops: nodes.length - 1,
  terminal: "anchor",
  truncated: false,
  coverage: "complete",
});

/** A bounded (truncated) path over `nodes`, ended by `terminal`. */
const bounded = (nodes: string[], terminal: "cycle" | "max_hops"): GraphPath => ({
  nodes,
  hops: nodes.length - 1,
  terminal,
  truncated: true,
  coverage: "partial",
});

const gt = (over: Partial<GroundTruth> = {}): GroundTruth => ({
  scenario_id: "t",
  repo_family: "typescript-service",
  difficulty: 4,
  difficulty_rationale: "test",
  intended_product: ["fettler"],
  dataset_split: "development",
  correct_behavior: "flag_files",
  faults: [],
  expected_findings: [],
  acceptable_findings: [],
  false_positive_traps: [],
  blast_radius_truth: {
    affectedFiles: 1,
    importChainPaths: [["anchor.ts", "mid.ts", "leaf.ts"]],
  },
  tags: [],
  ...over,
});

const obs = (filePath: string, graphPath?: GraphPath): ObservedFindingPath => ({ filePath, graphPath });

describe("gradeImportChain", () => {
  it("a path matching the expected chain grades as correct (exact)", () => {
    const g = gradeImportChain([obs("leaf.ts", complete(["anchor.ts", "mid.ts", "leaf.ts"]))], gt());
    expect(g.applicable).toBe(true);
    expect(g.summary.exact).toBe(1);
    expect(g.results[0]!.outcome).toBe("exact");
    expect(g.failures).toEqual([]);
    expect(g.grader_results[0]!.passed).toBe(true);
  });

  it("the right file reached by the WRONG route does not grade as correct", () => {
    // Same anchor and terminal, different intermediate node.
    const g = gradeImportChain([obs("leaf.ts", complete(["anchor.ts", "other.ts", "leaf.ts"]))], gt());
    expect(g.summary.exact).toBe(0);
    expect(g.summary.reachedAnchorWrongRoute).toBe(1);
    expect(g.results[0]!.outcome).toBe("reached_anchor_wrong_route");
    expect(g.grader_results[0]!.passed).toBe(false);
    // Classified into the existing taxonomy, and never P0 (so it cannot gate).
    expect(g.failures[0]!.category).toBe("GRAPH_CONSTRUCTION_FAILURE");
    expect(g.failures[0]!.severity).toBe("P2");
  });

  it("reaching the terminal from a DIFFERENT multi-node anchor is wrong_anchor, not exact", () => {
    const g = gradeImportChain([obs("leaf.ts", complete(["notanchor.ts", "mid.ts", "leaf.ts"]))], gt());
    expect(g.summary.wrongAnchor).toBe(1);
    expect(g.results[0]!.outcome).toBe("wrong_anchor");
    expect(g.failures[0]!.category).toBe("GRAPH_CONSTRUCTION_FAILURE");
  });

  it("a single-node self-path is self_anchor (no relationship traced), never wrong", () => {
    // The product anchored the finding on itself: nodes = [terminal] only.
    const g = gradeImportChain([obs("leaf.ts", complete(["leaf.ts"]))], gt());
    expect(g.summary.selfAnchor).toBe(1);
    expect(g.summary.wrongAnchor).toBe(0);
    expect(g.summary.exact).toBe(0);
    expect(g.results[0]!.outcome).toBe("self_anchor");
    // Not a confidently-wrong path: no failure is emitted for it.
    expect(g.failures).toEqual([]);
    // No relationship was traced, so the dimension is unmeasured (not failed).
    expect(g.grader_results[0]!.passed).toBe(true);
  });

  it("an ABSENT graphPath is NOT graded as an incorrect path", () => {
    // Finding exists for the terminal, but the product computed no path.
    const g = gradeImportChain([obs("leaf.ts", undefined)], gt());
    expect(g.summary.absent).toBe(1);
    expect(g.summary.exact).toBe(0);
    expect(g.summary.reachedAnchorWrongRoute).toBe(0);
    expect(g.summary.wrongAnchor).toBe(0);
    expect(g.results[0]!.outcome).toBe("absent");
    expect(g.failures).toEqual([]);
    // All-absent means the dimension is unmeasured, which is not a failure.
    expect(g.grader_results[0]!.passed).toBe(true);
  });

  it("no finding at all for the terminal is also absent, never wrong", () => {
    const g = gradeImportChain([obs("unrelated.ts", complete(["anchor.ts", "unrelated.ts"]))], gt());
    expect(g.summary.absent).toBe(1);
    expect(g.failures).toEqual([]);
  });

  it("a cycle-terminated path whose suffix matches is BOUNDED, not wrong", () => {
    // Real chain is anchor -> mid -> leaf; the product could only show mid -> leaf.
    const g = gradeImportChain([obs("leaf.ts", bounded(["mid.ts", "leaf.ts"], "cycle"))], gt());
    expect(g.summary.boundedOk).toBe(1);
    expect(g.summary.reachedAnchorWrongRoute).toBe(0);
    expect(g.results[0]!.outcome).toBe("bounded_ok");
    expect(g.failures).toEqual([]);
  });

  it("a max_hops-terminated multi-node path whose suffix matches is BOUNDED, not wrong", () => {
    // Real chain anchor -> mid -> leaf; the product shows the mid -> leaf tail,
    // stopped by the hop cap. A multi-node truncated suffix, not a self-path.
    const g = gradeImportChain([obs("leaf.ts", bounded(["mid.ts", "leaf.ts"], "max_hops"))], gt());
    expect(g.summary.boundedOk).toBe(1);
    expect(g.summary.selfAnchor).toBe(0);
    expect(g.results[0]!.outcome).toBe("bounded_ok");
    expect(g.failures).toEqual([]);
  });

  it("a bounded path whose shown suffix DISAGREES with the true tail is divergent", () => {
    const g = gradeImportChain([obs("leaf.ts", bounded(["wrong.ts", "leaf.ts"], "max_hops"))], gt());
    expect(g.summary.boundedDivergent).toBe(1);
    expect(g.results[0]!.outcome).toBe("bounded_divergent");
    expect(g.failures[0]!.category).toBe("GRAPH_CONSTRUCTION_FAILURE");
  });

  it("a scenario with NO importChainPaths key is skipped honestly, not defaulted", () => {
    const g = gradeImportChain(
      [obs("leaf.ts", complete(["anchor.ts", "leaf.ts"]))],
      gt({ blast_radius_truth: { affectedFiles: 1 } }),
    );
    expect(g.applicable).toBe(false);
    expect(g.results).toEqual([]);
    expect(g.failures).toEqual([]);
    expect(g.grader_results).toEqual([]);
    expect(g.summary.expectedPaths).toBe(0);
  });

  it("normalizes windows-style backslash paths before comparing", () => {
    const g = gradeImportChain(
      [obs("leaf.ts", complete(["anchor.ts", "mid.ts", "leaf.ts"]))],
      gt({ blast_radius_truth: { affectedFiles: 1, importChainPaths: [["anchor.ts", "mid.ts", "leaf.ts"]] } }),
    );
    // Emit the same path with backslashes; must still match exactly.
    const g2 = gradeImportChain(
      [obs("src\\leaf.ts", complete(["src\\anchor.ts", "src\\mid.ts", "src\\leaf.ts"]))],
      gt({ blast_radius_truth: { affectedFiles: 1, importChainPaths: [["src/anchor.ts", "src/mid.ts", "src/leaf.ts"]] } }),
    );
    expect(g.summary.exact).toBe(1);
    expect(g2.summary.exact).toBe(1);
  });

  it("grades each path of a multi-path (fan-out) key independently", () => {
    const scenario = gt({
      blast_radius_truth: {
        affectedFiles: 2,
        importChainPaths: [
          ["client.ts", "a.ts"],
          ["client.ts", "b.ts"],
        ],
      },
    });
    const g = gradeImportChain(
      [
        obs("a.ts", complete(["client.ts", "a.ts"])), // exact
        obs("b.ts", undefined), // absent, not wrong
      ],
      scenario,
    );
    expect(g.summary.exact).toBe(1);
    expect(g.summary.absent).toBe(1);
    expect(g.failures).toEqual([]);
  });
});

describe("importChainPaths schema validation", () => {
  it("accepts a well-formed key and rejects malformed ones", () => {
    expect(
      validateGroundTruth(gt({ blast_radius_truth: { affectedFiles: 1, importChainPaths: [["a.ts", "b.ts"]] } })),
    ).toEqual([]);
    const bad = validateGroundTruth(
      gt({ blast_radius_truth: { affectedFiles: 1, importChainPaths: [["only-one"]] as unknown as string[][] } }),
    );
    expect(bad.some((p) => p.includes("importChainPaths"))).toBe(true);
  });

  it("every real importChainPaths entry in the corpus is anchor-first with a distinct terminal", () => {
    for (const g of loadAllGroundTruth()) {
      const paths = g.blast_radius_truth.importChainPaths;
      if (!paths) continue;
      for (const p of paths) {
        expect(p.length).toBeGreaterThanOrEqual(2);
        // anchor and terminal are distinct files.
        expect(p[0]).not.toBe(p[p.length - 1]);
        // full posix paths (no backslashes) — the answer key is normalized.
        for (const n of p) expect(n).not.toContain("\\");
      }
    }
  });
});
