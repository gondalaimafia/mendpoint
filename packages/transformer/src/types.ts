/**
 * Transformer — AI legacy migration engineer (scaffold).
 * Plan-of-record: Behavioral Specification Graph (BSG) + DAG of PR-sized units.
 * @see docs/WARDEN_TRANSFORMER_GAP_ANALYSIS.md
 */

export type BsgNodeKind = "precondition" | "postcondition" | "invariant" | "behavior";

export type BsgNode = {
  id: string;
  kind: BsgNodeKind;
  label: string;
  /** Extracted or human-authored predicate / description */
  spec: string;
  sourceRefs?: string[]; // file:line
};

export type BsgEdge = {
  id: string;
  from: string;
  to: string;
  kind: "implies" | "orders" | "refines";
};

/** Behavioral Specification Graph — intermediate contract for migration fidelity. */
export type BehavioralSpecGraph = {
  id: string;
  title: string;
  sourceSystem: string;
  targetSystem: string;
  nodes: BsgNode[];
  edges: BsgEdge[];
};

export type DagNodeStatus = "pending" | "in_pr" | "merged" | "blocked" | "rolled_back";

export type MigrationDagNode = {
  id: string;
  title: string;
  /** Repo or package this PR-sized unit targets */
  repoKey: string;
  dependsOn: string[];
  status: DagNodeStatus;
  bsgNodeIds?: string[];
  prUrl?: string;
};

/** Campaign = durable unit above a single run (Transformer wedge). */
export type MigrationCampaign = {
  id: string;
  name: string;
  sourceSystem: string;
  targetStack: string;
  bsg: BehavioralSpecGraph;
  dag: MigrationDagNode[];
  playbookId?: string;
  createdAt: string;
};

export type DifferentialResult = {
  traceId: string;
  legacyOutput: unknown;
  targetOutput: unknown;
  equal: boolean;
  diffSummary: string;
  comparisonError?: string;
};
