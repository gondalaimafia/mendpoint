import { newId, nowIso } from "@mendpoint/shared";
import { addStep, emptyPlan, type AgentPlan } from "@mendpoint/orchestrator";
import type {
  BehavioralSpecGraph,
  MigrationCampaign,
  MigrationDagNode,
} from "./types.js";

export function emptyBsg(partial: {
  title: string;
  sourceSystem: string;
  targetSystem: string;
}): BehavioralSpecGraph {
  return {
    id: newId(),
    title: partial.title,
    sourceSystem: partial.sourceSystem,
    targetSystem: partial.targetSystem,
    nodes: [],
    edges: [],
  };
}

/** Topological order of DAG nodes (Kahn). Throws on cycle. */
export function orderDag(nodes: MigrationDagNode[]): MigrationDagNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const n of nodes) {
    for (const d of n.dependsOn) {
      if (byId.has(d)) indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
    }
  }
  const q = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const out: MigrationDagNode[] = [];
  while (q.length) {
    const id = q.shift()!;
    const n = byId.get(id)!;
    out.push(n);
    for (const m of nodes) {
      if (!m.dependsOn.includes(id)) continue;
      const next = (indeg.get(m.id) ?? 1) - 1;
      indeg.set(m.id, next);
      if (next === 0) q.push(m.id);
    }
  }
  if (out.length !== nodes.length) {
    throw new Error("Migration DAG has a cycle");
  }
  return out;
}

export function createCampaign(input: {
  name: string;
  sourceSystem: string;
  targetStack: string;
  dag: Omit<MigrationDagNode, "status">[];
  bsg?: BehavioralSpecGraph;
}): MigrationCampaign {
  const bsg =
    input.bsg ??
    emptyBsg({
      title: `${input.name} BSG`,
      sourceSystem: input.sourceSystem,
      targetSystem: input.targetStack,
    });
  return {
    id: newId(),
    name: input.name,
    sourceSystem: input.sourceSystem,
    targetStack: input.targetStack,
    bsg,
    dag: input.dag.map((d) => ({ ...d, status: "pending" as const })),
    createdAt: nowIso(),
  };
}

/** Plan-of-record for a campaign: one step per DAG node in topo order. */
export function planFromCampaign(campaign: MigrationCampaign): AgentPlan {
  const ordered = orderDag(campaign.dag);
  let plan = emptyPlan({
    kind: "bsg_campaign",
    title: `Transformer campaign: ${campaign.name}`,
    goal: `Migrate ${campaign.sourceSystem} → ${campaign.targetStack} with behavioral parity`,
    agent: "transformer",
    metadata: {
      campaignId: campaign.id,
      planOfRecord: "bsg_dag",
      bsgId: campaign.bsg.id,
    },
  });
  plan = addStep(plan, {
    title: "Lock Behavioral Specification Graph",
    action: "bsg.lock",
    successCriteria: [
      "BSG pre/post/invariants recorded",
      "No migration PR without BSG ref",
    ],
  });
  for (const n of ordered) {
    plan = addStep(plan, {
      title: n.title,
      action: "dag.pr_unit",
      ref: n.id,
      successCriteria: [
        `Repo unit: ${n.repoKey}`,
        "Differential traces pass or waived",
        "PR-per-DAG-node opened (human review)",
      ],
      notes: n.dependsOn.length
        ? `dependsOn: ${n.dependsOn.join(", ")}`
        : undefined,
    });
  }
  plan = addStep(plan, {
    title: "Campaign fidelity critic vs BSG",
    action: "critic.bsg_fidelity",
    successCriteria: ["Read-only critic report attached", "Blocking gaps escalated to domain expert"],
  });
  return plan;
}

/** Stub differential: deep equality of JSON outputs. */
export function diffOutputs(
  legacyOutput: unknown,
  targetOutput: unknown,
  traceId = "trace",
) {
  const equal = JSON.stringify(legacyOutput) === JSON.stringify(targetOutput);
  return {
    traceId,
    legacyOutput,
    targetOutput,
    equal,
    diffSummary: equal ? "outputs match" : "outputs differ",
  };
}
