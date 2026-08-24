/**
 * Stable platform SDK for Warden / Transformer specialist teams.
 * graph_query / plan / execute / record_outcome + Day-90 surface area
 */
import { normalizeChange } from "@mendpoint/change-intel";
import {
  getGraphLearnDb,
  labelPrOutcome,
  runGraphQuery,
  formatQueryForPlanner,
  backfillGitTemporal,
  checkSlos,
  formatLatencyReport,
  latencyReport,
  pickGraphQuery,
  promotePatterns,
  measureAbLift,
  formatAbReport,
  ingestAstRepo,
  ingestLspSymbols,
  incrementalReingest,
  exportGnnFeatures,
  writeGnnExport,
  type GraphQuery,
  type GraphQueryResult,
  type GraphTenantScope,
  type GitTemporalOptions,
  type GitTemporalResult,
  type QueryPick,
  type AbReport,
  type AstIngestResult,
  type Promotion,
} from "@mendpoint/graph-learn";
import {
  executePlan,
  helloWorldRun,
  collectDogfood,
  formatDogfoodReport,
  writeDogfoodReport,
  listPlans,
  savePlanHitl,
  type ExecuteResult,
  type DogfoodReport,
  type PlanPatch,
} from "@mendpoint/harness";
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
  createVmSandbox,
  startLiveSandbox,
  vmStatusReport,
  listScmProviders,
  recentAlerts,
  evaluateLatencyAlerts,
  evaluateDogfoodAlerts,
  estimateCost,
  type CostBreakdown,
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
    planId?: string;
    experiment?: string;
  }) => void;
  plannerContext: (agent: "warden" | "transformer") => string;
  planToMarkdown: typeof planToMarkdown;
  backfillGit: (opts: GitTemporalOptions) => GitTemporalResult;
  latencySlo: () => {
    report: ReturnType<typeof latencyReport>;
    check: ReturnType<typeof checkSlos>;
    markdown: string;
  };
  dogfood: (baseDir?: string) => DogfoodReport & { markdown: string; reportPath: string };
  pickQuery: (q: string) => QueryPick;
  promotePatterns: () => Promotion[];
  abLift: () => AbReport & { markdown: string };
  ingestAst: (repoPath: string, repoId?: string) => AstIngestResult;
  ingestLsp: (repoPath: string, repoId?: string) => ReturnType<typeof ingestLspSymbols>;
  incremental: (repoPath: string, repoId?: string) => ReturnType<typeof incrementalReingest>;
  gnnExport: (outPath?: string) => { nodes: number; edges: number; path?: string };
  vmStatus: () => ReturnType<typeof vmStatusReport>;
  createVm: (opts?: {
    backend?: "local" | "docker" | "firecracker";
    cacheKey?: string;
  }) => ReturnType<typeof createVmSandbox>;
  liveSandbox: () => ReturnType<typeof startLiveSandbox>;
  scmProviders: () => ReturnType<typeof listScmProviders>;
  alerts: () => ReturnType<typeof recentAlerts>;
  editPlan: (baseDir: string, runId: string, patch: PlanPatch) => AgentPlan;
  listPlans: (baseDir?: string) => ReturnType<typeof listPlans>;
  estimateCost: (input: {
    tokensEst?: number;
    sandboxMinutes?: number;
    graphQueries?: number;
    durationMs?: number;
  }) => CostBreakdown;
};

/**
 * Build a platform client bound to a single tenant. Every graph read and write
 * is scoped to `scope`, so an SDK consumer can never reach another tenant's
 * graph. The scope is mandatory: there is no unscoped/global client.
 */
export function createPlatform(scope: GraphTenantScope): PlatformClient {
  return {
    graphQuery(q) {
      const r = runGraphQuery(getGraphLearnDb(), q, scope);
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
      return executePlan({ plan, baseDir, scope });
    },
    executeHello(baseDir) {
      return helloWorldRun(baseDir, scope);
    },
    recordOutcome(input) {
      labelPrOutcome(getGraphLearnDb(), input, scope.tenantId);
    },
    plannerContext(agent) {
      let mem = createMemory();
      mem = seedMemoryForAgent(agent, mem);
      try {
        const rates = runGraphQuery(getGraphLearnDb(), {
          op: "pattern_success_rates",
          minSamples: 1,
        }, scope);
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
    backfillGit(opts) {
      return backfillGitTemporal(getGraphLearnDb(), opts);
    },
    latencySlo() {
      const report = latencyReport();
      const check = checkSlos(3);
      evaluateLatencyAlerts({ ok: check.ok, violations: check.violations, tenantId: scope.tenantId });
      return {
        report,
        check,
        markdown: formatLatencyReport(report),
      };
    },
    dogfood(baseDir = process.cwd()) {
      const report = collectDogfood(baseDir, scope);
      evaluateDogfoodAlerts({ ...report, tenantId: scope.tenantId });
      const reportPath = writeDogfoodReport(baseDir, report, scope);
      return {
        ...report,
        markdown: formatDogfoodReport(report),
        reportPath,
      };
    },
    pickQuery(q) {
      return pickGraphQuery(q);
    },
    promotePatterns() {
      return promotePatterns(getGraphLearnDb(), {}, scope);
    },
    abLift() {
      const report = measureAbLift(getGraphLearnDb());
      return { ...report, markdown: formatAbReport(report) };
    },
    ingestAst(repoPath, repoId) {
      return ingestAstRepo(getGraphLearnDb(), { repoPath, repoId, maxFiles: 200 });
    },
    ingestLsp(repoPath, repoId) {
      return ingestLspSymbols(getGraphLearnDb(), { repoPath, repoId });
    },
    incremental(repoPath, repoId) {
      return incrementalReingest(getGraphLearnDb(), {
        repoPath,
        repoId,
        maxFiles: 200,
      });
    },
    gnnExport(outPath) {
      if (outPath) {
        return writeGnnExport(getGraphLearnDb(), outPath, scope);
      }
      const exp = exportGnnFeatures(getGraphLearnDb(), scope);
      return { nodes: exp.nodes.length, edges: exp.edges.length };
    },
    vmStatus() {
      return vmStatusReport();
    },
    createVm(opts) {
      const backend = opts?.backend ?? "local";
      if (opts?.cacheKey !== undefined) {
        // The client is already tenant-bound. Derive cache authority from that
        // immutable scope instead of accepting a second caller-controlled tenant
        // that could redirect cache reads into another tenant's namespace.
        return createVmSandbox({
          backend,
          cacheKey: opts.cacheKey,
          tenantId: scope.tenantId,
        });
      }
      return createVmSandbox({ backend, tenantId: scope.tenantId });
    },
    liveSandbox() {
      return startLiveSandbox();
    },
    scmProviders() {
      return listScmProviders();
    },
    alerts() {
      return recentAlerts(50, { tenantId: scope.tenantId });
    },
    editPlan(baseDir, runId, patch) {
      return savePlanHitl(baseDir, runId, patch, scope);
    },
    listPlans(baseDir = process.cwd()) {
      return listPlans(baseDir, scope);
    },
    estimateCost(input) {
      return estimateCost(input);
    },
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
export type {
  AgentPlan,
  GraphQuery,
  GraphQueryResult,
  SpecPlanInput,
  ExecuteResult,
  PlanPatch,
  QueryPick,
  AbReport,
};
