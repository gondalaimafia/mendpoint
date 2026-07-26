/**
 * ~200-line specialist template — Transformer adds BSG/DAG campaign planning.
 */
import { createPlatform } from "../index.js";
import { executePlan } from "@mendpoint/harness";
import { planMultiRepoAgents, formatMultiRepoMarkdown } from "@mendpoint/transformer";
import { createCampaign } from "@mendpoint/transformer";

export async function transformerCampaignStub(opts: {
  name: string;
  sourceSystem: string;
  targetStack: string;
  dag: Array<{
    id: string;
    title: string;
    repoKey: string;
    dependsOn?: string[];
  }>;
  baseDir?: string;
  execute?: boolean;
}) {
  const platform = createPlatform();
  const { plan, markdown } = platform.planCampaign(opts);
  const campaign = createCampaign({
    name: opts.name,
    sourceSystem: opts.sourceSystem,
    targetStack: opts.targetStack,
    dag: opts.dag.map((d) => ({
      id: d.id,
      title: d.title,
      repoKey: d.repoKey,
      dependsOn: d.dependsOn ?? [],
    })),
  });
  const multi = planMultiRepoAgents(campaign);
  const context = platform.plannerContext("transformer");

  if (!opts.execute) {
    return {
      plan,
      markdown,
      multiRepoMarkdown: formatMultiRepoMarkdown(multi),
      context,
      run: null,
    };
  }

  const run = await executePlan({ plan, baseDir: opts.baseDir });
  return {
    plan,
    markdown,
    multiRepoMarkdown: formatMultiRepoMarkdown(multi),
    context,
    run,
  };
}
