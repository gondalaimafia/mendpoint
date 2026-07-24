/**
 * Minimal inspectable graph runner — topology + routing, not a free-roam loop.
 */
import { newId } from "@mendpoint/shared";
import type {
  AgentGraphDef,
  GraphEdgeDef,
  GraphNodeDef,
  GraphState,
  NodeHandler,
  NodeId,
} from "./types.js";

export function createEmptyState(partial?: Partial<GraphState>): GraphState {
  return {
    runId: partial?.runId ?? newId(),
    goal: partial?.goal,
    providerSlug: partial?.providerSlug,
    changeId: partial?.changeId,
    surfaces: partial?.surfaces,
    findings: partial?.findings,
    draft: partial?.draft,
    verifyOk: partial?.verifyOk,
    verifyOutput: partial?.verifyOutput,
    filesChanged: partial?.filesChanged ?? [],
    policy: partial?.policy,
    nodeOutputs: { ...(partial?.nodeOutputs ?? {}) },
    errors: [...(partial?.errors ?? [])],
    trace: [...(partial?.trace ?? [])],
  };
}

export function getNode(graph: AgentGraphDef, id: NodeId): GraphNodeDef | undefined {
  return graph.nodes.find((n) => n.id === id);
}

export function outgoing(graph: AgentGraphDef, from: NodeId): GraphEdgeDef[] {
  return graph.edges.filter((e) => e.from === from);
}

/**
 * Pick next edge after a node completes.
 * Explicit routing: on_failure if !ok, else on_success, else sequence.
 */
export function pickNextEdge(
  graph: AgentGraphDef,
  from: NodeId,
  ok: boolean,
): GraphEdgeDef | undefined {
  const outs = outgoing(graph, from);
  if (!outs.length) return undefined;
  if (!ok) {
    const fail = outs.find((e) => e.kind === "on_failure");
    if (fail) return fail;
  }
  const success = outs.find((e) => e.kind === "on_success" || e.kind === "sequence");
  if (success) return success;
  return outs[0];
}

export type RunGraphOptions = {
  graph: AgentGraphDef;
  handlers: Partial<Record<NodeId, NodeHandler>> & {
    /** Fallback by kind */
    byKind?: Partial<Record<GraphNodeDef["kind"], NodeHandler>>;
  };
  initial?: Partial<GraphState>;
  maxSteps?: number;
  /**
   * If true, missing handlers are no-ops that mark node ok (topology dry-run).
   * Default true for diagram/audit; set false to require full handlers.
   */
  dryRunMissing?: boolean;
};

export type GraphRunResult = {
  state: GraphState;
  stoppedAt: NodeId | "max_steps" | "no_edge";
  ok: boolean;
};

/**
 * Execute the graph step-by-step with inspectable trace.
 * Each node is expected to implement its own internal loop.
 */
export async function runAgentGraph(opts: RunGraphOptions): Promise<GraphRunResult> {
  const { graph, handlers } = opts;
  const maxSteps = opts.maxSteps ?? 32;
  const dryRunMissing = opts.dryRunMissing !== false;
  let state = createEmptyState(opts.initial);
  let current: NodeId | undefined = graph.entry;
  let steps = 0;

  while (current && steps < maxSteps) {
    steps++;
    const node = getNode(graph, current);
    if (!node) {
      state.errors.push({ nodeId: current, message: "unknown node" });
      return { state, stoppedAt: current, ok: false };
    }

    const handler =
      handlers[current] ??
      handlers.byKind?.[node.kind] ??
      (dryRunMissing
        ? (s: GraphState, n: GraphNodeDef) => {
            s.nodeOutputs[n.id] = { dryRun: true, kind: n.kind };
            return s;
          }
        : undefined);

    if (!handler) {
      state.errors.push({ nodeId: current, message: "no handler" });
      return { state, stoppedAt: current, ok: false };
    }

    let ok = true;
    try {
      state = await handler(state, node);
      const out = state.nodeOutputs[node.id] as { ok?: boolean } | undefined;
      if (out && typeof out.ok === "boolean") ok = out.ok;
      if (node.kind === "verify" && state.verifyOk === false) ok = false;
      if (node.kind === "review_gate" && state.policy?.allowPr === false) ok = false;
    } catch (e) {
      ok = false;
      const message = e instanceof Error ? e.message : String(e);
      state.errors.push({ nodeId: current, message });
      state.nodeOutputs[node.id] = { ok: false, error: message };
    }

    state.trace.push({
      step: steps,
      nodeId: current,
      summary: `${node.label} (${node.kind})`,
      ok,
    });

    if (graph.terminals.includes(current) && ok) {
      return { state, stoppedAt: current, ok: true };
    }

    const edge = pickNextEdge(graph, current, ok);
    if (!edge) {
      return {
        state,
        stoppedAt: graph.terminals.includes(current) ? current : "no_edge",
        ok: ok && graph.terminals.includes(current),
      };
    }
    state.trace[state.trace.length - 1]!.edgeId = edge.id;
    current = edge.to;
  }

  return { state, stoppedAt: "max_steps", ok: false };
}

/** Mermaid diagram for docs / UI. */
export function graphToMermaid(graph: AgentGraphDef): string {
  const lines = ["flowchart TD", `  %% ${graph.title}`];
  for (const n of graph.nodes) {
    lines.push(`  ${n.id}["${n.label}"]`);
  }
  for (const e of graph.edges) {
    const label = e.when ?? e.kind;
    lines.push(`  ${e.from} -->|${label}| ${e.to}`);
  }
  return lines.join("\n");
}

/** JSON export for /graph-style UIs */
export function graphToProductShape(graph: AgentGraphDef) {
  return {
    id: graph.id,
    title: graph.title,
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      meta: { contextContract: n.contextContract, fanOut: n.fanOut ?? false },
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      kind: e.kind,
      meta: { when: e.when },
    })),
  };
}
