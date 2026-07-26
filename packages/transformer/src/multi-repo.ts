/**
 * One-agent-per-repo + routing orchestrator (Transformer P0 pattern).
 */
import { newId } from "@mendpoint/shared";
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
      agentId: newId(),
      repoKey,
      nodeIds: nodes.map((n) => n.id),
      status: "idle" as const,
    }),
  );

  // Waves: process nodes in topo order; group independent nodes
  const done = new Set<string>();
  const waves: string[][] = [];
  const remaining = new Set(ordered.map((n) => n.id));
  while (remaining.size) {
    const wave: string[] = [];
    for (const n of ordered) {
      if (!remaining.has(n.id)) continue;
      if (n.dependsOn.every((d) => done.has(d) || !remaining.has(d) && done.has(d))) {
        if (n.dependsOn.every((d) => done.has(d))) wave.push(n.id);
      }
    }
    // fix: dependsOn all in done
    const wave2 = ordered
      .filter((n) => remaining.has(n.id) && n.dependsOn.every((d) => done.has(d)))
      .map((n) => n.id);
    if (!wave2.length) {
      // cycle already prevented by orderDag; break safety
      break;
    }
    for (const id of wave2) {
      remaining.delete(id);
      done.add(id);
    }
    waves.push(wave2);
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
