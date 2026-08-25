/**
 * Stable platform SDK for Warden / Transformer specialist teams.
 * graph_query / plan / execute / record_outcome + Day-90 surface area
 */
import { normalizeChange } from "@mendpoint/change-intel";
import {
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
  type GraphLearnDb,
  type Promotion,
} from "@mendpoint/graph-learn";
import {
  resolveTenantGraphHandle,
  type TenantGraphHandleUnavailableReason,
} from "@mendpoint/pipeline";
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
 * Fail-closed signal raised when no ready tenant Change Graph handle exists.
 * Carries the same structured `{error, reason, detail}` fields the API graph
 * surface returns, so callers branch on `reason`/`detail` instead of parsing a
 * string message.
 */
export class GraphHandleUnavailableError extends Error {
  readonly error = "graph_handle_unavailable" as const;
  readonly reason: TenantGraphHandleUnavailableReason;
  readonly detail: string;
  constructor(reason: TenantGraphHandleUnavailableReason, detail: string) {
    super(`graph_handle_unavailable:${reason}`);
    this.name = "GraphHandleUnavailableError";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Resolve a tenant graph handle for one call and run `fn` against it. Every
 * handle flows through `resolveTenantGraphHandle`: there is no in-process handle
 * injection, so an ephemeral/empty store can never bypass the guard. Tests point
 * at a real on-disk graph via `graphPath`; production leaves it undefined and the
 * resolver reads `GRAPH_LEARN_DB`.
 */
function withTenantGraph<T>(
  scope: GraphTenantScope,
  graphPath: string | null | undefined,
  fn: (graphDb: GraphLearnDb) => T,
  opts?: { allowEmpty?: boolean },
): T {
  const resolved = resolveTenantGraphHandle({
    tenantId: scope.tenantId,
    consumerIds: scope.consumerIds,
    allowEmpty: opts?.allowEmpty,
    graphPath,
  });
  if (resolved.status !== "ready") {
    throw new GraphHandleUnavailableError(resolved.reason, resolved.detail);
  }
  try {
    return fn(resolved.graphDb);
  } finally {
    resolved.close();
  }
}

/**
 * Build a platform client bound to a single tenant. Tenant-partitioned graph
 * reads and writes are scoped to `scope`, so an SDK consumer cannot reach
 * another tenant's graph. The scope is mandatory: there is no unscoped/global
 * client. One documented exception: `backfillGit` writes repo-scoped
 * git-temporal history through `backfillGitTemporal`, which keys nodes by repo
 * and takes no tenant scope; it is a bootstrap ingest, not a cross-tenant read.
 *
 * Every graph handle is resolved by `resolveTenantGraphHandle`, in tests too:
 * production reads `GRAPH_LEARN_DB`, tests pass an explicit `graphPath` to a real
 * on-disk graph. There is no in-process handle injection, so an ephemeral/empty
 * store can never be presented as a tenant Change Graph handle.
 */
export function createPlatform(
  scope: GraphTenantScope,
  opts?: { graphPath?: string | null },
): PlatformClient {
  const graph = <T>(fn: (graphDb: GraphLearnDb) => T, allowEmpty = false) =>
    withTenantGraph(scope, opts?.graphPath, fn, { allowEmpty });
  return {
    graphQuery(q) {
      const r = graph((graphDb) => runGraphQuery(graphDb, q, scope));
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
      // Write path: the first outcome may be labeled before any read-worthy node
      // exists, so an existing-but-empty tenant view is allowed here (allowEmpty).
      graph((graphDb) => labelPrOutcome(graphDb, input, scope.tenantId), true);
    },
    plannerContext(agent) {
      let mem = createMemory();
      mem = seedMemoryForAgent(agent, mem);
      const base = memoryForPlanner(mem);
      let rates: GraphQueryResult;
      try {
        rates = graph((graphDb) => runGraphQuery(graphDb, {
          op: "pattern_success_rates",
          minSamples: 1,
        }, scope));
      } catch (error) {
        // Fail closed without collapsing "graph unavailable" into "no patterns":
        // surface the structured reason so a caller can tell the graph was never
        // consulted apart from the case where it was consulted and found none.
        if (error instanceof GraphHandleUnavailableError) {
          return `${base}\n\n## Change Graph unavailable\n- reason: ${error.reason}\n- detail: ${error.detail}`;
        }
        throw error;
      }
      if (rates.rows?.length) {
        const top = rates.rows
          .slice(0, 3)
          .map(
            (r) =>
              `- pattern ${r.pattern}: ${(Number(r.successRate) * 100).toFixed(0)}% (${r.samples} samples)`,
          )
          .join("\n");
        return `${base}\n\n## Historical patterns\n${top}`;
      }
      return `${base}\n\n## Historical patterns\n- none above minSamples`;
    },
    planToMarkdown,
    backfillGit(opts) {
      // Bootstrap ingest: git-temporal history is keyed by repo (not tenant) and
      // may run before any node exists, so allow an empty tenant view (allowEmpty).
      return graph((graphDb) => backfillGitTemporal(graphDb, opts), true);
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
      return graph((graphDb) => promotePatterns(graphDb, {}, scope));
    },
    abLift() {
      const report = graph((graphDb) => measureAbLift(graphDb, undefined, scope));
      return { ...report, markdown: formatAbReport(report) };
    },
    ingestAst(repoPath, repoId) {
      return graph((graphDb) => ingestAstRepo(graphDb, { repoPath, repoId, maxFiles: 200 }), true);
    },
    ingestLsp(repoPath, repoId) {
      return graph((graphDb) => ingestLspSymbols(graphDb, { repoPath, repoId }), true);
    },
    incremental(repoPath, repoId) {
      return graph((graphDb) => incrementalReingest(graphDb, {
        repoPath,
        repoId,
        maxFiles: 200,
      }), true);
    },
    gnnExport(outPath) {
      if (outPath) {
        return graph((graphDb) => writeGnnExport(graphDb, outPath, scope));
      }
      const exp = graph((graphDb) => exportGnnFeatures(graphDb, scope));
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
