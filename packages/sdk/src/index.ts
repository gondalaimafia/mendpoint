/**
 * Stable platform SDK for Warden / Transformer specialist teams.
 * graph_query / plan / execute / record_outcome
 */
import { normalizeChange } from "@mendpoint/change-intel";
import {
  getGraphLearnDb,
  labelPrOutcome,
  runGraphQuery,
  formatQueryForPlanner,
  type GraphQuery,
  type GraphQueryResult,
} from "@mendpoint/graph-learn";
import { executePlan, helloWorldRun, type ExecuteResult } from "@mendpoint/harness";
import {
  planFromSpecDiff,
  planToMarkdown,
  type AgentPlan,
  type SpecPlanInput,
} from "@mendpoint/orchestrator";
import {
  createMemory,
  memoryForPlanner,
  seedMemoryForAgent,
} from "@mendpoint/platform";
import { createCampaign, planFromCampaign } from "@mendpoint/transformer";

export type PlatformClient = {
  graphQuery: (q: GraphQuery) => GraphQueryResult & { markdown: string };
  planSpecDiff: (input: SpecPlanInput) => AgentPlan;
  planCampaign: (input: {
    name: string;
    sourceSystem: string;
    targetStack: string;
    dag: Array<{
      id: string;
      title: string;
      repoKey: string;
      dependsOn?: string[];
    }>;
  }) => { plan: AgentPlan; markdown: string };
  execute: (plan: AgentPlan, baseDir?: string) => Promise<ExecuteResult>;
  executeHello: (baseDir?: string) => Promise<ExecuteResult>;
  recordOutcome: (input: {
    prId: string;
    changeId: string;
    consumerId: string;
    outcome: "merged" | "closed" | "broke" | "waived";
    title?: string;
  }) => void;
  plannerContext: (agent: "warden" | "transformer") => string;
  planToMarkdown: typeof planToMarkdown;
};

export function createPlatform(): PlatformClient {
  return {
    graphQuery(q) {
      const r = runGraphQuery(getGraphLearnDb(), q);
      return { ...r, markdown: formatQueryForPlanner(r) };
    },
    planSpecDiff(input) {
      return planFromSpecDiff(input);
    },
    planCampaign(input) {
      const campaign = createCampaign({
        name: input.name,
        sourceSystem: input.sourceSystem,
        targetStack: input.targetStack,
        dag: input.dag.map((d) => ({
          id: d.id,
          title: d.title,
          repoKey: d.repoKey,
          dependsOn: d.dependsOn ?? [],
        })),
      });
      const plan = planFromCampaign(campaign);
      return { plan, markdown: planToMarkdown(plan) };
    },
    execute(plan, baseDir) {
      return executePlan({ plan, baseDir });
    },
    executeHello(baseDir) {
      return helloWorldRun(baseDir);
    },
    recordOutcome(input) {
      labelPrOutcome(getGraphLearnDb(), input);
    },
    plannerContext(agent) {
      let mem = createMemory();
      mem = seedMemoryForAgent(agent, mem);
      // Inject historical patterns when available
      try {
        const rates = runGraphQuery(getGraphLearnDb(), {
          op: "pattern_success_rates",
          minSamples: 1,
        });
        if (rates.rows?.length) {
          const top = rates.rows
            .slice(0, 3)
            .map(
              (r) =>
                `- pattern ${r.pattern}: ${(Number(r.successRate) * 100).toFixed(0)}% (${r.samples} samples)`,
            )
            .join("\n");
          return `${memoryForPlanner(mem)}\n\n## Historical patterns\n${top}`;
        }
      } catch {
        /* */
      }
      return memoryForPlanner(mem);
    },
    planToMarkdown,
  };
}

/** Helper: build SpecPlanInput from raw OpenAPI pair */
export function planFromOpenApiPair(
  providerSlug: string,
  oldSpec: unknown,
  newSpec: unknown,
  extra?: Partial<SpecPlanInput>,
): AgentPlan {
  const { diff, surfaces } = normalizeChange(oldSpec as object, newSpec as object, {
    providerSlug,
  });
  return planFromSpecDiff({
    providerSlug,
    diff,
    surfaces,
    ...extra,
  });
}

export { normalizeChange };
export type { AgentPlan, GraphQuery, GraphQueryResult, SpecPlanInput, ExecuteResult };
