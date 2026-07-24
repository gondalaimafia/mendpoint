import { describe, expect, it } from "vitest";
import {
  graphToMermaid,
  graphToProductShape,
  pickNextEdge,
  runAgentGraph,
} from "./graph.js";
import { wardenDebugGraph, wardenProductGraph } from "./warden-product-graph.js";
import type { GraphState } from "./types.js";

describe("warden product graph topology", () => {
  it("has specialized nodes and inspectable edges", () => {
    const g = wardenProductGraph();
    expect(g.nodes.length).toBeGreaterThanOrEqual(7);
    expect(g.nodes.some((n) => n.kind === "expand" && n.fanOut)).toBe(true);
    expect(g.nodes.some((n) => n.kind === "verify")).toBe(true);
    expect(g.nodes.some((n) => n.kind === "review_gate")).toBe(true);
    expect(g.edges.some((e) => e.kind === "on_failure")).toBe(true);
    expect(g.edges.some((e) => e.kind === "fan_out")).toBe(true);
  });

  it("routes verify failure back to generate", () => {
    const g = wardenProductGraph();
    const edge = pickNextEdge(g, "verify", false);
    expect(edge?.to).toBe("generate");
    expect(edge?.kind).toBe("on_failure");
  });

  it("routes verify success to review_gate", () => {
    const g = wardenProductGraph();
    const edge = pickNextEdge(g, "verify", true);
    expect(edge?.to).toBe("review_gate");
  });

  it("exports mermaid and product shape", () => {
    const g = wardenProductGraph();
    const m = graphToMermaid(g);
    expect(m).toContain("flowchart TD");
    expect(m).toContain("change_intel");
    const shape = graphToProductShape(g);
    expect(shape.nodes.length).toBe(g.nodes.length);
    expect(shape.edges.length).toBe(g.edges.length);
  });
});

describe("runAgentGraph", () => {
  it("runs dry-run topology with trace", async () => {
    const g = wardenProductGraph();
    const result = await runAgentGraph({
      graph: g,
      handlers: {},
      dryRunMissing: true,
      maxSteps: 20,
    });
    expect(result.state.trace.length).toBeGreaterThan(3);
    expect(result.state.trace[0]!.nodeId).toBe("change_intel");
  });

  it("debug graph runs single Warden loop node with handler", async () => {
    const g = wardenDebugGraph();
    const result = await runAgentGraph({
      graph: g,
      maxSteps: 3,
      dryRunMissing: false,
      handlers: {
        verify: (state: GraphState) => {
          state.verifyOk = true;
          state.nodeOutputs.verify = { ok: true, loop: "warden" };
          return state;
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.state.verifyOk).toBe(true);
  });
});
