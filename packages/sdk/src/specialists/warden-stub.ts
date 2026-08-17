/**
 * ~200-line specialist template — Warden adds spec-diff planning on the shared platform.
 * Specialist teams start Day 91 from here.
 */
import { readFileSync } from "node:fs";
import { createPlatform, planFromOpenApiPair } from "../index.js";
import { executePlan } from "@mendpoint/harness";

/**
 * Given two OpenAPI paths, plan + optional harness execute (stub tools).
 */
export async function wardenSpecDiffStub(opts: {
  providerSlug: string;
  oldSpecPath: string;
  newSpecPath: string;
  baseDir?: string;
  execute?: boolean;
  /** Tenant that owns this specialist run's graph reads/writes. */
  tenantId?: string;
}) {
  const scope = { tenantId: opts.tenantId ?? "sdk-specialist-demo" };
  const platform = createPlatform(scope);
  const oldSpec = JSON.parse(readFileSync(opts.oldSpecPath, "utf8"));
  const newSpec = JSON.parse(readFileSync(opts.newSpecPath, "utf8"));

  // Graph-RAG: who is affected?
  const consumers = platform.graphQuery({
    op: "who_consumes_provider",
    providerSlug: opts.providerSlug,
  });

  const plan = planFromOpenApiPair(opts.providerSlug, oldSpec, newSpec, {
    providerName: opts.providerSlug,
    goal: `Evolve ${opts.providerSlug} with consumer awareness (${consumers.rows?.length ?? 0} consumers)`,
  });

  const context = platform.plannerContext("warden");
  const markdown = platform.planToMarkdown(plan);

  if (!opts.execute) {
    return { plan, markdown, consumers, context, run: null };
  }

  const run = await executePlan({
    plan,
    baseDir: opts.baseDir,
    scope,
  });
  return { plan, markdown, consumers, context, run };
}
