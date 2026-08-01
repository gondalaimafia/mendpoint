/**
 * One-agent-per-repo + routing orchestrator (Transformer P0 pattern).
 */
import type { MigrationCampaign, MigrationDagNode } from "./types.js";
import { orderDag } from "./campaign.js";

export type RepoAgentAssignment = {
  agentId: string;
  repoKey: string;
  nodeIds: string[];
  status: "idle" | "running" | "done" | "failed";
};

export type MultiRepoPlan = {
  campaignId: string;
  assignments: RepoAgentAssignment[];
  /** Shared learnings file path (logical) */
  sharedLearningsPath: string;
  /** Execution waves: each wave can run in parallel across repos */
  waves: string[][];
};

function stableAgentId(campaignId: string, repoKey: string): string {
  const input = `${campaignId}:${repoKey}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `repo-agent-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Group DAG nodes by repoKey and produce parallel waves by topology levels.
 */
export function planMultiRepoAgents(campaign: MigrationCampaign): MultiRepoPlan {
  const ordered = orderDag(campaign.dag);
  const byRepo = new Map<string, MigrationDagNode[]>();
  for (const n of ordered) {
    const list = byRepo.get(n.repoKey) ?? [];
    list.push(n);
    byRepo.set(n.repoKey, list);
  }

  const assignments: RepoAgentAssignment[] = [...byRepo.entries()].map(
    ([repoKey, nodes]) => ({
      agentId: stableAgentId(campaign.id, repoKey),
      repoKey,
      nodeIds: nodes.map((n) => n.id),
      status: "idle" as const,
    }),
  );

  // Process independent repositories in parallel while serializing work per repository.
  const done = new Set<string>();
  const waves: string[][] = [];
  const remaining = new Set(ordered.map((n) => n.id));
  while (remaining.size) {
    const wave: string[] = [];
    const reposInWave = new Set<string>();
    for (const n of ordered) {
      if (!remaining.has(n.id)) continue;
      if (!n.dependsOn.every((dependencyId) => done.has(dependencyId))) continue;
      if (reposInWave.has(n.repoKey)) continue;
      wave.push(n.id);
      reposInWave.add(n.repoKey);
    }
    if (!wave.length) {
      throw new Error("Migration campaign could not produce a complete execution wave");
    }
    for (const id of wave) {
      remaining.delete(id);
      done.add(id);
    }
    waves.push(wave);
  }

  const planned = waves.flat();
  if (planned.length !== ordered.length || new Set(planned).size !== ordered.length) {
    throw new Error("Migration campaign plan does not cover every DAG node exactly once");
  }

  return {
    campaignId: campaign.id,
    assignments,
    sharedLearningsPath: `.mendpoint/campaigns/${campaign.id}/learnings.md`,
    waves,
  };
}

export function formatMultiRepoMarkdown(plan: MultiRepoPlan): string {
  return [
    "### Multi-repo agent assignments",
    "",
    ...plan.assignments.map(
      (a) =>
        `- Agent \`${a.agentId.slice(0, 8)}\` → **${a.repoKey}** nodes: ${a.nodeIds.join(", ")}`,
    ),
    "",
    `Shared learnings: \`${plan.sharedLearningsPath}\``,
    "",
    "Waves (parallel within wave):",
    ...plan.waves.map((w, i) => `${i + 1}. ${w.join(", ")}`),
  ].join("\n");
}
