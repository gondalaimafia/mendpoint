/**
 * Canonical Warden product topology — graph engineering default.
 * Each node is a specialized loop; edges are explicit routing.
 */
import type { AgentGraphDef } from "./types.js";

export function wardenProductGraph(): AgentGraphDef {
  return {
    id: "warden-product-v1",
    title: "Warden product agent graph",
    entry: "change_intel",
    terminals: ["review_gate"],
    nodes: [
      {
        id: "change_intel",
        kind: "change_intel",
        label: "Change intel",
        contextContract: "OpenAPI pair + changelog notes only",
        stopWhen: "surfaces emitted",
      },
      {
        id: "index_code",
        kind: "index_code",
        label: "Index codebase",
        contextContract: "Consumer repo root; no full source retained beyond index",
        stopWhen: "index ready",
      },
      {
        id: "candidates",
        kind: "candidates",
        label: "Candidate discovery",
        contextContract: "Surfaces + codebase index",
        fanOut: true,
        stopWhen: "candidate set complete",
      },
      {
        id: "expand",
        kind: "expand",
        label: "Expand (call-graph)",
        contextContract: "Candidate site + call-graph hops only",
        fanOut: true,
        stopWhen: "contexts expanded",
      },
      {
        id: "confirm",
        kind: "confirm",
        label: "Confirm impact",
        contextContract: "Code slice only (not whole-repo LLM)",
        stopWhen: "findings confirmed",
      },
      {
        id: "generate",
        kind: "generate",
        label: "Generate patch + PR",
        contextContract: "Findings + target files",
        stopWhen: "draft ready",
      },
      {
        id: "verify",
        kind: "verify",
        label: "Verify (Warden / repair loop)",
        contextContract: "Goal + verify command + repo sandbox",
        stopWhen: "verify exit 0 or budget exhausted",
      },
      {
        id: "review_gate",
        kind: "review_gate",
        label: "Human review gate",
        contextContract: "Draft + policy labels; never auto-merge by default",
        stopWhen: "human decision",
      },
    ],
    edges: [
      {
        id: "e1",
        from: "change_intel",
        to: "index_code",
        kind: "sequence",
        when: "surfaces ready",
      },
      {
        id: "e2",
        from: "index_code",
        to: "candidates",
        kind: "sequence",
      },
      {
        id: "e3",
        from: "candidates",
        to: "expand",
        kind: "fan_out",
        when: "per candidate / batch",
      },
      {
        id: "e4",
        from: "expand",
        to: "confirm",
        kind: "fan_in",
        when: "contexts joined",
      },
      {
        id: "e5",
        from: "confirm",
        to: "generate",
        kind: "on_success",
        when: "findings non-empty or adopt mode",
      },
      {
        id: "e6",
        from: "generate",
        to: "verify",
        kind: "sequence",
      },
      {
        id: "e7",
        from: "verify",
        to: "review_gate",
        kind: "on_success",
        when: "verifyOk",
      },
      {
        id: "e8",
        from: "verify",
        to: "generate",
        kind: "on_failure",
        when: "verify failed — re-patch (bounded)",
      },
    ],
  };
}

/** Standalone Warden debug session as a single-node graph (loop special case). */
export function wardenDebugGraph(): AgentGraphDef {
  return {
    id: "warden-debug-v1",
    title: "Warden API debug (single loop node)",
    entry: "verify",
    terminals: ["verify"],
    nodes: [
      {
        id: "verify",
        kind: "verify",
        label: "Warden tool loop",
        contextContract: "goal + errorLog + repo + verifyCommand",
        stopWhen: "verify pass or maxSteps",
      },
    ],
    edges: [],
  };
}
