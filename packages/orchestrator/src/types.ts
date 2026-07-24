/**
 * Graph-engineering primitives for Mendpoint agent orchestration.
 * Each node is still a loop; the graph is the topology.
 */

export type NodeId = string;

export type GraphNodeKind =
  | "change_intel"
  | "index_code"
  | "candidates"
  | "expand"
  | "confirm"
  | "generate"
  | "verify"
  | "review_gate"
  | "custom";

export type GraphNodeDef = {
  id: NodeId;
  kind: GraphNodeKind;
  /** Human label for diagrams / audit */
  label: string;
  /** What clean context this node is allowed to see */
  contextContract: string;
  /** Whether this node may fan-out (parallel instances) */
  fanOut?: boolean;
  /** Stop condition for the loop inside the node */
  stopWhen?: string;
};

export type EdgeKind =
  | "sequence"
  | "fan_out"
  | "fan_in"
  | "on_success"
  | "on_failure"
  | "branch";

export type GraphEdgeDef = {
  id: string;
  from: NodeId;
  to: NodeId;
  kind: EdgeKind;
  /** Optional routing predicate description (inspectable control flow) */
  when?: string;
};

/** Shared state that flows along edges — not one muddy transcript. */
export type GraphState = {
  runId: string;
  goal?: string;
  providerSlug?: string;
  changeId?: string;
  surfaces?: unknown[];
  findings?: unknown[];
  draft?: unknown;
  verifyOk?: boolean;
  verifyOutput?: string;
  filesChanged?: string[];
  policy?: { allowPr?: boolean; allowAutoMerge?: boolean; reasons?: string[] };
  /** Per-node scratch; nodes should not read other nodes' scratch */
  nodeOutputs: Record<NodeId, unknown>;
  errors: Array<{ nodeId: NodeId; message: string }>;
  /** Ordered audit of which edges fired */
  trace: Array<{
    step: number;
    nodeId: NodeId;
    edgeId?: string;
    summary: string;
    ok: boolean;
  }>;
};

export type NodeHandler = (
  state: GraphState,
  node: GraphNodeDef,
) => Promise<GraphState> | GraphState;

export type AgentGraphDef = {
  id: string;
  title: string;
  /** Entry node */
  entry: NodeId;
  nodes: GraphNodeDef[];
  edges: GraphEdgeDef[];
  /** Terminal node ids */
  terminals: NodeId[];
};
