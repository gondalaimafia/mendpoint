import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  createDb,
  listProviders,
  getProviderBySlug,
  listChanges,
  getChange,
  listConsumers,
  listPrs,
  getPr,
  listAudit,
  listFindingsForChange,
  listVersionsForProvider,
  listMonitoredForConsumer,
  getConsumer,
  insertProvider,
  insertApiVersion,
  insertConsumer,
  insertConsumerRepo,
  insertMonitoredApi,
  recordAudit,
  computeProductMetrics,
  computeDesignPartnerMetrics,
  exportAuditJson,
  exportAuditCsv,
  updateChangeSeverity,
  enqueueJob,
  listJobs,
  claimNextJob,
  completeJob,
  failJob,
  listSuppressedPatterns,
  getConsumerRepo,
  providerToApi,
  changeToApi,
  consumerToApi,
  prToApi,
  findingToApi,
  auditToApi,
  versionToApi,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  apiKeyToApi,
  listFeedPolls,
  feedPollToApi,
  updateProviderFeedUrls,
  BILLING_PLANS,
  listTenants,
  getTenant,
  getTenantBySlug,
  insertTenant,
  updateTenantPlan,
  tenantToApi,
  upsertGitHubInstallation,
  listGitHubInstallations,
  githubInstallationToApi,
  linkConsumersToInstallation,
  insertRepairSession,
  listRepairSessions,
  getRepairSession,
  repairSessionToApi,
  insertAgentRun,
  listAgentRuns,
  getAgentRun,
  agentRunToApi,
  buildExposureReport,
  listConsumersForProvider,
  listConsumersImpactedByChange,
  registrySummaryMarkdown,
} from "@mendpoint/db";
import {
  detectVendors,
  listCatalog,
  listCatalogFeeds,
  pollAllFeeds,
  probeKnownSdks,
} from "@mendpoint/catalog";
import { applyPrFeedback, runChangePipeline } from "@mendpoint/pipeline";
import {
  normalizeGitHubEvent,
  parseWebhookHeaders,
  prFeedbackFromWebhook,
  verifyGitHubSignature,
  formatCiCheckComment,
  MockPrCommenter,
  postCiCheck,
  getGitHubAppConfig,
  buildInstallUrl,
  normalizeMockInstall,
} from "@mendpoint/github";
import {
  listBrandPacks,
  getBrandPack,
  applyBrandPack,
} from "@mendpoint/branding";
import {
  buildChangeImpactGraph,
  buildProviderApiGraph,
  buildProductKnowledgeGraph,
  invalidateGraphCaches,
} from "@mendpoint/graph";
import {
  wardenProductGraph,
  wardenDebugGraph,
  graphToMermaid,
  graphToProductShape,
  runAgentGraph,
  planFromSpecDiff,
  planToMarkdown,
} from "@mendpoint/orchestrator";
import { evaluatePrGates, reviewOpenApiDesign } from "@mendpoint/contract";
import {
  createCampaign,
  planFromCampaign,
  planMultiRepoAgents,
  formatMultiRepoMarkdown,
} from "@mendpoint/transformer";
import {
  createSandbox,
  sandboxManifest,
  seedMemoryForAgent,
  createMemory,
  memoryForPlanner,
  evaluateCanary,
  RUNTIME_MATRIX,
  createVmSandbox,
  vmStatusReport,
  startLiveSandbox,
  listScmProviders,
  recentAlerts,
  evaluateLatencyAlerts,
  evaluateDogfoodAlerts,
  parsePrincipalFromHeaders,
  can,
  permissionForRoute,
  estimateCost,
  setAlertPersistPath,
  defaultAlertPath,
} from "@mendpoint/platform";
import {
  getGraphLearnDb,
  runGraphQuery,
  formatQueryForPlanner,
  GRAPH_RAG_TOOLS,
  countStats,
  pickGraphQuery,
  promotePatterns,
  measureAbLift,
  formatAbReport,
  ingestAstRepo,
  ingestLspSymbols,
  incrementalReingest,
  exportGnnFeatures,
  checkSlos,
  embedGraphNodes,
  kuzuStatus,
  exportSqliteToKuzuScript,
  type GraphQuery,
} from "@mendpoint/graph-learn";
import {
  collectDogfood,
  formatDogfoodReport,
  listTrajectories,
  viewTrajectory,
  listPlans,
  getPlan,
  savePlanHitl,
  type PlanPatch,
} from "@mendpoint/harness";
import { FeedbackOutcomeSchema, newId, nowIso } from "@mendpoint/shared";
import { notifyWardenEvent } from "@mendpoint/notify";
import { runRepairSession, runAgenticRepairLoop } from "@mendpoint/repair";
import { runWarden } from "@mendpoint/agent";
import { normalizeChange } from "@mendpoint/change-intel";
import { createAuthMiddleware, effectiveAuthMode } from "./auth.js";
import {
  assertApiEnvOrExit,
  liveness,
  readiness,
  RELEASE,
  releaseBanner,
  featureMatrix,
  isProduction,
} from "@mendpoint/ops";
import {
  requestIdMiddleware,
  securityHeadersMiddleware,
  rateLimitMiddleware,
  corsOrigins,
} from "./production.js";

// Fail fast in production if env invalid
assertApiEnvOrExit();

const db = createDb();
const app = new Hono();
const startedAt = Date.now();

app.use("*", requestIdMiddleware());
app.use("*", securityHeadersMiddleware());

app.use(
  "*",
  cors({
    origin: corsOrigins(),
    allowMethods: ["GET", "POST", "PATCH", "OPTIONS", "DELETE"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-API-Key",
      "X-Role",
      "X-Tenant-Id",
      "X-User-Id",
      "X-Request-Id",
    ],
  }),
);

/** Request timing + uncaught error boundary */
app.use("*", async (c, next) => {
  const t0 = Date.now();
  try {
    await next();
  } catch (e) {
    console.error("[api]", c.req.method, c.req.path, e);
    return c.json(
      {
        error: "internal_error",
        message: e instanceof Error ? e.message : String(e),
      },
      500,
    );
  } finally {
    const ms = Date.now() - t0;
    if (ms > 500 || c.req.path.startsWith("/graph")) {
      c.header("Server-Timing", `total;dur=${ms}`);
      c.header("X-Response-Time", `${ms}ms`);
    }
  }
});

// Rate limit before auth so credential stuffing is throttled
app.use("*", rateLimitMiddleware());
app.use("*", createAuthMiddleware(db));

/** Broader RBAC — role headers; default engineer when API_AUTH off */
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;
  if (method === "OPTIONS") return next();
  const need = permissionForRoute(method, path);
  if (!need) return next();
  // When API_AUTH=off, still honor explicit restrictive roles (viewer)
  const principal = parsePrincipalFromHeaders({
    "x-tenant-id": c.req.header("x-tenant-id") ?? undefined,
    "x-role": c.req.header("x-role") ?? undefined,
    "x-user-id": c.req.header("x-user-id") ?? undefined,
  });
  // If no x-role and auth off, treat as engineer (dev ergonomics)
  const roleHeader = c.req.header("x-role");
  const effective =
    !roleHeader && (process.env.API_AUTH ?? "off") === "off"
      ? { ...principal, role: "engineer" as const }
      : principal;
  if (!can(effective, need)) {
    return c.json(
      {
        error: "rbac_denied",
        need,
        role: effective.role,
        message: `role ${effective.role} lacks ${need}`,
      },
      403,
    );
  }
  c.set("principal", effective);
  return next();
});

// Persist alerts under data/
try {
  setAlertPersistPath(defaultAlertPath(process.cwd()));
} catch {
  /* */
}

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "mendpoint-api",
    product: RELEASE.product,
    platform: RELEASE.platform,
    version: RELEASE.version,
    channel: RELEASE.channel,
    banner: releaseBanner(),
    auth: effectiveAuthMode(),
    graphNative: true,
    rbac: true,
    production: isProduction(),
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  }),
);

/** Kubernetes-style probes */
app.get("/live", (c) => c.json(liveness()));

app.get("/ready", (c) => {
  const r = readiness({
    dbPing: () => {
      db.raw.prepare("SELECT 1").get();
      return true;
    },
  });
  return c.json(r, r.status === "fail" ? 503 : 200);
});

app.get("/version", (c) =>
  c.json({
    ...RELEASE,
    banner: releaseBanner(),
    features: featureMatrix(),
  }),
);

app.get("/status", (c) => {
  const r = readiness({
    dbPing: () => {
      try {
        db.raw.prepare("SELECT 1").get();
        return true;
      } catch {
        return false;
      }
    },
  });
  return c.json({
    ...r,
    ga: {
      version: RELEASE.version,
      channel: RELEASE.channel,
      gaFeatures: RELEASE.gaFeatures,
      experimental: RELEASE.experimentalFeatures,
    },
    endpoints: {
      health: "/health",
      live: "/live",
      ready: "/ready",
      version: "/version",
      metrics: "/metrics",
    },
  });
});

// ─── Phase F: Graph native APIs ──────────────────────────────────────────────

app.get("/graph/changes/:id", (c) => {
  try {
    const consumerId = c.req.query("consumerId") ?? undefined;
    const includeApi = c.req.query("includeApi") !== "0";
    const g = buildChangeImpactGraph(db, c.req.param("id"), {
      consumerId,
      includeApiGraph: includeApi,
    });
    if (!g) return c.json({ error: "change not found" }, 404);
    c.header("Cache-Control", "private, max-age=10");
    return c.json(g);
  } catch (e) {
    return c.json(
      { error: "graph_build_failed", message: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

app.get("/graph/consumers/:id", (c) => {
  try {
    const changeId = c.req.query("changeId");
    if (!changeId) {
      return c.json({ error: "changeId query required" }, 400);
    }
    const g = buildChangeImpactGraph(db, changeId, {
      consumerId: c.req.param("id"),
      includeApiGraph: true,
    });
    if (!g) return c.json({ error: "change not found" }, 404);
    c.header("Cache-Control", "private, max-age=10");
    return c.json(g);
  } catch (e) {
    return c.json(
      { error: "graph_build_failed", message: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

// ─── Warden matrix P0: plans, contracts, registry, transformer scaffold ──────

/** Spec-first plan-of-record from provider OpenAPI pair */
app.post("/warden/plans/from-spec", async (c) => {
  try {
    const body = await c.req.json<{
      providerSlug: string;
      fromVersion?: string;
      toVersion?: string;
      goal?: string;
    }>();
    if (!body.providerSlug) return c.json({ error: "providerSlug required" }, 400);
    const provider = getProviderBySlug(db, body.providerSlug);
    if (!provider) return c.json({ error: "provider not found" }, 404);
    const versions = listVersionsForProvider(db, provider.id);
    if (versions.length < 2) {
      return c.json({ error: "provider needs ≥2 versions" }, 400);
    }
    const from =
      (body.fromVersion
        ? versions.find((v) => v.version_label === body.fromVersion)
        : versions[versions.length - 2]) ?? versions[versions.length - 2]!;
    const to =
      (body.toVersion
        ? versions.find((v) => v.version_label === body.toVersion)
        : versions[versions.length - 1]) ?? versions[versions.length - 1]!;
    const oldSpec = JSON.parse(from.openapi_json);
    const newSpec = JSON.parse(to.openapi_json);
    const { diff, surfaces } = normalizeChange(oldSpec, newSpec, {
      providerSlug: provider.slug,
      providerNotes: to.changelog_md ?? undefined,
    });
    const plan = planFromSpecDiff({
      providerSlug: provider.slug,
      providerName: provider.name,
      fromVersion: from.version_label,
      toVersion: to.version_label,
      diff,
      surfaces,
      goal: body.goal,
    });
    const consumers = listConsumersForProvider(db, provider.slug);
    return c.json({
      plan,
      markdown: planToMarkdown(plan),
      registry: consumers,
      registryMarkdown: registrySummaryMarkdown(consumers, provider.slug),
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/** PR gates: oas-breaking + contract suite + security stub */
app.post("/warden/gates", async (c) => {
  try {
    const body = await c.req.json<{
      providerSlug?: string;
      oldSpec?: unknown;
      newSpec?: unknown;
      contractCases?: Array<{
        id: string;
        name: string;
        requiredKeys?: string[];
        responseBody?: unknown;
        requireAuth?: boolean;
        requestHeaders?: Record<string, string>;
      }>;
      securityScanOk?: boolean;
    }>();
    let oldSpec = body.oldSpec;
    let newSpec = body.newSpec;
    if (body.providerSlug && (!oldSpec || !newSpec)) {
      const provider = getProviderBySlug(db, body.providerSlug);
      if (!provider) return c.json({ error: "provider not found" }, 404);
      const versions = listVersionsForProvider(db, provider.id);
      if (versions.length >= 2) {
        oldSpec = JSON.parse(versions[versions.length - 2]!.openapi_json);
        newSpec = JSON.parse(versions[versions.length - 1]!.openapi_json);
      }
    }
    const result = evaluatePrGates({
      oldSpec,
      newSpec,
      providerSlug: body.providerSlug,
      contractCases: body.contractCases,
      securityScanOk: body.securityScanOk,
    });
    return c.json(result);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/** Read-only API design critic */
app.post("/warden/review", async (c) => {
  try {
    const body = await c.req.json<{
      providerSlug?: string;
      spec?: unknown;
    }>();
    let spec = body.spec;
    if (!spec && body.providerSlug) {
      const provider = getProviderBySlug(db, body.providerSlug);
      if (!provider) return c.json({ error: "provider not found" }, 404);
      const versions = listVersionsForProvider(db, provider.id);
      if (!versions.length) return c.json({ error: "no versions" }, 400);
      spec = JSON.parse(versions[versions.length - 1]!.openapi_json);
    }
    if (!spec) return c.json({ error: "spec or providerSlug required" }, 400);
    return c.json(reviewOpenApiDesign(spec));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/** Consumer registry for a provider */
app.get("/registry/providers/:slug/consumers", (c) => {
  const slug = c.req.param("slug");
  const hits = listConsumersForProvider(db, slug);
  return c.json({
    providerSlug: slug,
    consumers: hits,
    markdown: registrySummaryMarkdown(hits, slug),
  });
});

app.get("/registry/changes/:id/consumers", (c) => {
  const id = c.req.param("id");
  return c.json({
    changeId: id,
    consumers: listConsumersImpactedByChange(db, id),
  });
});

/** Transformer campaign scaffold */
app.post("/transformer/campaigns", async (c) => {
  try {
    const body = await c.req.json<{
      name: string;
      sourceSystem: string;
      targetStack: string;
      dag: Array<{
        id: string;
        title: string;
        repoKey: string;
        dependsOn?: string[];
      }>;
    }>();
    if (!body.name || !body.sourceSystem || !body.targetStack) {
      return c.json({ error: "name, sourceSystem, targetStack required" }, 400);
    }
    const campaign = createCampaign({
      name: body.name,
      sourceSystem: body.sourceSystem,
      targetStack: body.targetStack,
      dag: (body.dag ?? []).map((d) => ({
        id: d.id,
        title: d.title,
        repoKey: d.repoKey,
        dependsOn: d.dependsOn ?? [],
      })),
    });
    const plan = planFromCampaign(campaign);
    const multi = planMultiRepoAgents(campaign);
    return c.json(
      {
        campaign,
        plan,
        markdown: planToMarkdown(plan),
        multiRepo: multi,
        multiRepoMarkdown: formatMultiRepoMarkdown(multi),
      },
      201,
    );
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/** Local sandbox (live-service interface; local workdir today) */
app.post("/platform/sandbox", async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    files?: Record<string, string>;
    serviceBaseUrl?: string;
  };
  const sbx = createSandbox({
    files: body.files,
    serviceBaseUrl: body.serviceBaseUrl,
    mocks: [{ name: "upstream-stub" }],
  });
  const manifest = sandboxManifest(sbx);
  // Dispose immediately after manifest for API safety; real sessions would keep handle
  sbx.dispose();
  return c.json({ ...manifest, disposed: true, runtimes: RUNTIME_MATRIX });
});

/** Seeded memory / style guide for planner prompts */
app.get("/platform/memory/seed", (c) => {
  const agent = (c.req.query("agent") === "transformer" ? "transformer" : "warden") as
    | "warden"
    | "transformer";
  let mem = createMemory();
  mem = seedMemoryForAgent(agent, mem);
  return c.json({
    agent,
    plannerContext: memoryForPlanner(mem),
    layers: {
      knowledge: mem.knowledge.length,
      working: mem.working.length,
    },
  });
});

/** Canary decision (hooks only — no auto production deploy) */
app.post("/platform/canary/evaluate", async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    humanApproved?: boolean;
    observedErrorRate?: number;
  };
  return c.json(evaluateCanary(body));
});

/** Dimension 6 — Graph learning / graph-RAG */
app.get("/graph-learn/stats", (c) => {
  return c.json({ ...countStats(getGraphLearnDb()), tools: GRAPH_RAG_TOOLS });
});

app.post("/graph-learn/query", async (c) => {
  try {
    const body = (await c.req.json()) as GraphQuery;
    if (!body?.op) return c.json({ error: "op required" }, 400);
    const result = runGraphQuery(getGraphLearnDb(), body);
    return c.json({
      ...result,
      markdown: formatQueryForPlanner(result),
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/** Graph-RAG v1 natural-language query pick */
app.post("/graph-learn/pick", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { q?: string; run?: boolean };
  if (!body.q) return c.json({ error: "q required" }, 400);
  const pick = pickGraphQuery(body.q);
  if (body.run) {
    const result = runGraphQuery(getGraphLearnDb(), pick.query);
    return c.json({
      pick,
      result: { ...result, markdown: formatQueryForPlanner(result) },
    });
  }
  return c.json({ pick });
});

app.post("/graph-learn/promote-patterns", (c) => {
  const promotions = promotePatterns(getGraphLearnDb());
  return c.json({ count: promotions.length, promotions });
});

app.get("/graph-learn/ab", (c) => {
  const report = measureAbLift(getGraphLearnDb());
  return c.json({ ...report, markdown: formatAbReport(report) });
});

app.post("/graph-learn/ast-ingest", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    repoPath?: string;
    repoId?: string;
    maxFiles?: number;
  };
  const repoPath = body.repoPath ?? process.cwd();
  const r = ingestAstRepo(getGraphLearnDb(), {
    repoPath,
    repoId: body.repoId,
    maxFiles: body.maxFiles ?? 100,
  });
  return c.json(r);
});

app.post("/graph-learn/lsp-ingest", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    repoPath?: string;
    repoId?: string;
  };
  const r = ingestLspSymbols(getGraphLearnDb(), {
    repoPath: body.repoPath ?? process.cwd(),
    repoId: body.repoId,
  });
  return c.json(r);
});

app.post("/graph-learn/incremental", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    repoPath?: string;
    repoId?: string;
  };
  const r = incrementalReingest(getGraphLearnDb(), {
    repoPath: body.repoPath ?? process.cwd(),
    repoId: body.repoId,
    maxFiles: 150,
  });
  return c.json(r);
});

app.get("/graph-learn/gnn-export", (c) => {
  const exp = exportGnnFeatures(getGraphLearnDb());
  return c.json({
    exportedAt: exp.exportedAt,
    nodes: exp.nodes.length,
    edges: exp.edges.length,
    kindIndex: exp.kindIndex,
    sampleNodes: exp.nodes.slice(0, 20),
    sampleEdges: exp.edges.slice(0, 20),
  });
});

app.get("/graph-learn/slo", (c) => {
  const check = checkSlos(3);
  evaluateLatencyAlerts({
    ok: check.ok,
    violations: check.violations,
  });
  return c.json(check);
});

app.post("/graph-learn/embed", (c) => {
  const r = embedGraphNodes(getGraphLearnDb());
  return c.json(r);
});

app.get("/graph-learn/kuzu", (c) => {
  const status = kuzuStatus();
  const script = exportSqliteToKuzuScript(getGraphLearnDb(), { maxNodes: 100 });
  return c.json({
    ...status,
    export: {
      nodeInserts: script.nodeInserts.length,
      edgeInserts: script.edgeInserts.length,
      sample: script.nodeInserts.slice(0, 3),
    },
  });
});

/** Platform completeness APIs */
app.get("/platform/vm", (c) => c.json(vmStatusReport()));

app.post("/platform/vm/sandbox", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    backend?: "local" | "docker" | "firecracker";
    cacheKey?: string;
  };
  const sbx = createVmSandbox({
    backend: body.backend ?? "local",
    cacheKey: body.cacheKey,
    files: { "README": "vm sandbox\n" },
  });
  const out = {
    id: sbx.id,
    backend: sbx.backend,
    fallback: sbx.fallback,
    cacheHit: sbx.cacheHit,
    root: sbx.root,
    kind: sbx.kind,
    manifestExtra: sbx.manifestExtra,
  };
  sbx.dispose();
  return c.json(out);
});

app.post("/platform/live-sandbox", async (c) => {
  const live = await startLiveSandbox();
  const probe = await live.curl("/health");
  const out = {
    baseUrl: live.baseUrl,
    port: live.port,
    probe,
    routes: live.routes.map((r) => `${r.method ?? "GET"} ${r.path}`),
  };
  live.dispose();
  return c.json(out);
});

app.get("/platform/scm", (c) => c.json({ providers: listScmProviders() }));

app.get("/platform/alerts", (c) => c.json({ alerts: recentAlerts(50) }));

app.get("/platform/dogfood", (c) => {
  const baseDir = process.cwd();
  const report = collectDogfood(baseDir);
  evaluateDogfoodAlerts(report);
  return c.json({ ...report, markdown: formatDogfoodReport(report) });
});

app.get("/platform/trajectories", (c) => {
  return c.json({ runs: listTrajectories(process.cwd()) });
});

app.get("/platform/trajectories/:runId", (c) => {
  const text = viewTrajectory(process.cwd(), c.req.param("runId"));
  return c.json({ runId: c.req.param("runId"), text });
});

app.get("/platform/plans", (c) => {
  return c.json({ plans: listPlans(process.cwd()) });
});

app.get("/platform/plans/:runId", (c) => {
  try {
    const plan = getPlan(process.cwd(), c.req.param("runId"));
    return c.json(plan);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
  }
});

app.patch("/platform/plans/:runId", async (c) => {
  const principal = parsePrincipalFromHeaders({
    "x-tenant-id": c.req.header("x-tenant-id") ?? undefined,
    "x-role": c.req.header("x-role") ?? undefined,
    "x-user-id": c.req.header("x-user-id") ?? undefined,
  });
  if (!can(principal, "plan:edit")) {
    return c.json({ error: "rbac_denied", need: "plan:edit" }, 403);
  }
  const patch = (await c.req.json()) as PlanPatch;
  try {
    const plan = savePlanHitl(process.cwd(), c.req.param("runId"), patch);
    return c.json({ ok: true, plan });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

app.post("/platform/cost/estimate", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    tokensEst?: number;
    sandboxMinutes?: number;
    graphQueries?: number;
    durationMs?: number;
  };
  return c.json(estimateCost(body));
});

/** Agent orchestration graph (graph engineering) — topology, not domain code graph */
app.get("/graph/agent", (c) => {
  const which = c.req.query("which") ?? "product";
  const g = which === "debug" ? wardenDebugGraph() : wardenProductGraph();
  return c.json({
    ...graphToProductShape(g),
    mermaid: graphToMermaid(g),
    doctrine: "graph-engineering",
    docs: "docs/GRAPH_ENGINEERING.md",
  });
});

app.get("/graph/agent/mermaid", (c) => {
  const which = c.req.query("which") ?? "product";
  const g = which === "debug" ? wardenDebugGraph() : wardenProductGraph();
  return c.text(graphToMermaid(g), 200, { "Content-Type": "text/plain; charset=utf-8" });
});

/** Dry-run topology walk (no side effects) for demos / health */
app.post("/graph/agent/dry-run", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { which?: string };
  const g = body.which === "debug" ? wardenDebugGraph() : wardenProductGraph();
  const result = await runAgentGraph({ graph: g, handlers: {}, dryRunMissing: true });
  return c.json({
    ok: result.ok || result.state.trace.length > 0,
    stoppedAt: result.stoppedAt,
    steps: result.state.trace.length,
    trace: result.state.trace,
  });
});

app.get("/graph/product", (c) => {
  try {
    const focus = c.req.query("focus");
    let f:
      | { type: "all" }
      | { type: "provider"; slug: string }
      | { type: "consumer"; id: string }
      | { type: "tenant"; id: string } = { type: "all" };
    if (focus?.startsWith("provider:")) {
      f = { type: "provider", slug: focus.slice("provider:".length) };
    } else if (focus?.startsWith("consumer:")) {
      f = { type: "consumer", id: focus.slice("consumer:".length) };
    } else if (focus?.startsWith("tenant:")) {
      f = { type: "tenant", id: focus.slice("tenant:".length) };
    }
    c.header("Cache-Control", "private, max-age=5");
    return c.json(buildProductKnowledgeGraph(db, f));
  } catch (e) {
    return c.json(
      { error: "graph_build_failed", message: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

app.get("/graph/api/:providerSlug", (c) => {
  try {
    const g = buildProviderApiGraph(db, c.req.param("providerSlug"));
    if (!g) return c.json({ error: "provider not found" }, 404);
    c.header("Cache-Control", "private, max-age=15");
    return c.json(g);
  } catch (e) {
    return c.json(
      { error: "graph_build_failed", message: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});


app.get("/providers", (c) => c.json(listProviders(db).map(providerToApi)));

app.get("/providers/:slug", (c) => {
  const p = getProviderBySlug(db, c.req.param("slug"));
  if (!p) return c.json({ error: "not found" }, 404);
  const versions = listVersionsForProvider(db, p.id).map(versionToApi);
  return c.json({ ...providerToApi(p), versions });
});

app.post("/providers", async (c) => {
  const body = await c.req.json<{
    slug: string;
    name: string;
    website?: string;
    openapiUrl?: string;
    changelogUrl?: string;
  }>();
  const id = newId();
  insertProvider(db, {
    id,
    slug: body.slug,
    name: body.name,
    website: body.website ?? null,
    openapiUrl: body.openapiUrl ?? null,
    changelogUrl: body.changelogUrl ?? null,
    createdAt: nowIso(),
  });
  recordAudit(db, {
    actor: "api",
    action: "provider.created",
    resourceType: "provider",
    resourceId: id,
  });
  return c.json({ id, ...body }, 201);
});

app.patch("/providers/:slug/feed", async (c) => {
  const p = getProviderBySlug(db, c.req.param("slug"));
  if (!p) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ openapiUrl?: string; changelogUrl?: string }>();
  updateProviderFeedUrls(db, p.slug, {
    openapiUrl: body.openapiUrl,
    changelogUrl: body.changelogUrl,
  });
  return c.json(providerToApi(getProviderBySlug(db, p.slug)!));
});

app.post("/providers/:slug/versions", async (c) => {
  const p = getProviderBySlug(db, c.req.param("slug"));
  if (!p) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{
    versionLabel: string;
    openapi: unknown;
    changelogMd?: string;
  }>();
  const id = newId();
  insertApiVersion(db, {
    id,
    providerId: p.id,
    versionLabel: body.versionLabel,
    openapiJson: JSON.stringify(body.openapi),
    changelogMd: body.changelogMd ?? null,
    publishedAt: nowIso(),
  });
  return c.json({ id, versionLabel: body.versionLabel }, 201);
});

app.post("/providers/:slug/publish", async (c) => {
  try {
    const body = await c.req
      .json<{
        severity?: "required" | "recommended" | "optional";
        notificationsOnly?: boolean;
        mode?: "migrate" | "adopt";
      }>()
      .catch(() => ({} as { severity?: never; notificationsOnly?: boolean; mode?: never }));
    const report = await runChangePipeline({
      providerSlug: c.req.param("slug"),
      db,
      severity: body.severity,
      notificationsOnly: body.notificationsOnly,
      mode: body.mode,
    });
    invalidateGraphCaches();
    void notifyWardenEvent(
      "warden_finished",
      `${c.req.param("slug")} change ${report.changeId} risk=${report.risk}`,
    ).catch(() => undefined);
    return c.json(report, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

/** Phase C: upload OpenAPI version and optionally publish (run pipeline) in one step */
app.post("/providers/:slug/publish-version", async (c) => {
  const p = getProviderBySlug(db, c.req.param("slug"));
  if (!p) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{
    versionLabel: string;
    openapi: unknown;
    changelogMd?: string;
    runPipeline?: boolean;
  }>();
  if (!body.versionLabel || body.openapi === undefined) {
    return c.json({ error: "versionLabel and openapi required" }, 400);
  }
  const id = newId();
  insertApiVersion(db, {
    id,
    providerId: p.id,
    versionLabel: body.versionLabel,
    openapiJson:
      typeof body.openapi === "string" ? body.openapi : JSON.stringify(body.openapi),
    changelogMd: body.changelogMd ?? null,
    publishedAt: nowIso(),
  });
  recordAudit(db, {
    actor: "api",
    action: "provider.version.uploaded",
    resourceType: "provider",
    resourceId: p.id,
    metadata: { versionLabel: body.versionLabel, versionId: id },
  });
  if (body.runPipeline) {
    try {
      const report = await runChangePipeline({ providerSlug: p.slug, db });
      invalidateGraphCaches();
      return c.json({ versionId: id, versionLabel: body.versionLabel, pipeline: report }, 201);
    } catch (e) {
      invalidateGraphCaches();
      return c.json(
        {
          versionId: id,
          versionLabel: body.versionLabel,
          pipelineError: e instanceof Error ? e.message : String(e),
        },
        201,
      );
    }
  }
  invalidateGraphCaches();
  return c.json({ versionId: id, versionLabel: body.versionLabel }, 201);
});

app.get("/changes", (c) => c.json(listChanges(db).map(changeToApi)));

app.get("/changes/:id", (c) => {
  const change = getChange(db, c.req.param("id"));
  if (!change) return c.json({ error: "not found" }, 404);
  const findings = listFindingsForChange(db, change.id).map(findingToApi);
  const prs = listPrs(db)
    .filter((p) => p.change_id === change.id)
    .map(prToApi);
  return c.json({
    ...changeToApi(change),
    diff: JSON.parse(change.diff_json),
    findings,
    prs,
  });
});

app.get("/consumers", (c) => {
  const all = listConsumers(db).map((cons) => ({
    ...consumerToApi(cons),
    monitored: listMonitoredForConsumer(db, cons.id),
  }));
  return c.json(all);
});

app.post("/consumers", async (c) => {
  const body = await c.req.json<{
    name: string;
    githubOwner: string;
    githubRepo: string;
    localPath: string;
  }>();
  const id = newId();
  insertConsumer(db, {
    id,
    name: body.name,
    githubOwner: body.githubOwner,
    githubRepo: body.githubRepo,
    installationId: null,
    createdAt: nowIso(),
  });
  insertConsumerRepo(db, {
    id: newId(),
    consumerId: id,
    localPath: body.localPath,
    defaultBranch: "main",
    createdAt: nowIso(),
  });
  return c.json({ id }, 201);
});

app.post("/consumers/:id/monitor", async (c) => {
  const consumer = getConsumer(db, c.req.param("id"));
  if (!consumer) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ providerSlug: string }>();
  const p = getProviderBySlug(db, body.providerSlug);
  if (!p) return c.json({ error: "provider not found" }, 404);
  const id = newId();
  insertMonitoredApi(db, {
    id,
    consumerId: consumer.id,
    providerId: p.id,
    detectionSource: "manual",
  });
  return c.json({ id }, 201);
});

/** Phase C: auto-detect vendors from consumer repo lockfiles/imports */
app.post("/consumers/:id/detect", async (c) => {
  const consumer = getConsumer(db, c.req.param("id"));
  if (!consumer) return c.json({ error: "not found" }, 404);
  const repo = getConsumerRepo(db, consumer.id);
  if (!repo) return c.json({ error: "no local repo path for consumer" }, 400);
  const detected = detectVendors(repo.local_path);
  const linked: Array<{ slug: string; monitoredId: string; created: boolean }> = [];
  for (const d of detected) {
    let p = getProviderBySlug(db, d.slug);
    if (!p) {
      const pid = newId();
      insertProvider(db, {
        id: pid,
        slug: d.slug,
        name: d.name,
        website: null,
        createdAt: nowIso(),
      });
      p = getProviderBySlug(db, d.slug)!;
    }
    const existing = listMonitoredForConsumer(db, consumer.id).filter(
      (m) => m.provider_id === p!.id,
    );
    if (existing.length) {
      linked.push({ slug: d.slug, monitoredId: existing[0]!.id, created: false });
      continue;
    }
    const mid = newId();
    insertMonitoredApi(db, {
      id: mid,
      consumerId: consumer.id,
      providerId: p.id,
      detectionSource: "auto_detect",
    });
    linked.push({ slug: d.slug, monitoredId: mid, created: true });
  }
  recordAudit(db, {
    actor: "api",
    action: "consumer.detect",
    resourceType: "consumer",
    resourceId: consumer.id,
    metadata: { detected, linked },
  });
  return c.json({ detected, linked });
});

app.get("/catalog", (c) => c.json(listCatalog()));

/** Phase D: continuous feeds */
app.get("/feeds", (c) =>
  c.json({
    catalog: listCatalogFeeds(),
    recentPolls: listFeedPolls(db, 40).map(feedPollToApi),
  }),
);

app.post("/feeds/poll", async (c) => {
  const body = await c.req
    .json<{ localOnly?: boolean; runPipeline?: boolean; slugs?: string[] }>()
    .catch(() => ({} as { localOnly?: boolean; runPipeline?: boolean; slugs?: string[] }));
  const results = await pollAllFeeds({
    db,
    localOnly: body.localOnly ?? true,
    runPipeline: body.runPipeline ?? true,
    slugs: body.slugs,
    pipeline: async (slug, d) => {
      const report = await runChangePipeline({ providerSlug: slug, db: d });
      return { changeId: report.changeId };
    },
  });
  return c.json({ results });
});

app.get("/learning/suppressed", (c) => {
  const consumerId = c.req.query("consumerId") ?? undefined;
  return c.json(listSuppressedPatterns(db, { consumerId }));
});

app.get("/prs", (c) => c.json(listPrs(db).map(prToApi)));

app.get("/prs/:id", (c) => {
  const pr = getPr(db, c.req.param("id"));
  if (!pr) return c.json({ error: "not found" }, 404);
  return c.json(prToApi(pr));
});

app.post("/prs/:id/feedback", async (c) => {
  const pr = getPr(db, c.req.param("id"));
  if (!pr) return c.json({ error: "not found" }, 404);
  const body = await c.req.json();
  const parsed = FeedbackOutcomeSchema.safeParse(body.outcome);
  if (!parsed.success) return c.json({ error: "invalid outcome" }, 400);
  await applyPrFeedback(db, pr.id, parsed.data, {
    experiment: body.experiment,
    planId: body.planId,
  });
  return c.json({
    ...prToApi(getPr(db, pr.id)!),
    experiment: body.experiment ?? null,
    planId: body.planId ?? null,
  });
});

/** Phase D: advisory CI check body (and optional mock post) for a migration PR */
app.post("/prs/:id/ci-check", async (c) => {
  const pr = getPr(db, c.req.param("id"));
  if (!pr) return c.json({ error: "not found" }, 404);
  const consumer = getConsumer(db, pr.consumer_id);
  if (!consumer) return c.json({ error: "consumer missing" }, 400);
  const findings = listFindingsForChange(db, pr.change_id);
  const body = await c.req
    .json<{
      harness?: Array<{
        name: string;
        passed: boolean;
        recall?: number;
        threshold?: number;
        detail?: string;
      }>;
      post?: boolean;
    }>()
    .catch(() => ({} as { harness?: never; post?: boolean }));

  const input = {
    owner: consumer.github_owner,
    repo: consumer.github_repo,
    prNumber: pr.github_pr_number ?? 0,
    title: pr.title,
    risk: pr.risk,
    findings: findings.length,
    harness: body.harness ?? [
      { name: "TypeScript", passed: true, recall: 1, threshold: 0.7 },
      { name: "Python", passed: true, recall: 1, threshold: 0.7 },
      { name: "Go", passed: true, recall: 1, threshold: 0.7 },
      { name: "Java", passed: true, recall: 1, threshold: 0.7 },
      { name: "Ruby", passed: true, recall: 1, threshold: 0.7 },
    ],
    policyNotes: ["Auto-merge disabled", "Human review required"],
  };
  const commentBody = formatCiCheckComment(input);
  if (body.post && pr.github_pr_number) {
    const commenter = new MockPrCommenter();
    const res = await postCiCheck(commenter, input);
    recordAudit(db, {
      actor: "api",
      action: "pr.ci_check",
      resourceType: "migration_pr",
      resourceId: pr.id,
      metadata: { commentId: res.id },
    });
    return c.json({ body: commentBody, posted: res });
  }
  return c.json({ body: commentBody, posted: null });
});

// ─── Phase D: API keys ───────────────────────────────────────────────────────

app.get("/keys", (c) => c.json(listApiKeys(db).map(apiKeyToApi)));

app.post("/keys", async (c) => {
  const body = await c.req.json<{ name: string; tenantId?: string; scopes?: string[] }>();
  if (!body.name) return c.json({ error: "name required" }, 400);
  const created = createApiKey(db, {
    id: newId(),
    name: body.name,
    tenantId: body.tenantId,
    scopes: body.scopes,
    createdAt: nowIso(),
  });
  recordAudit(db, {
    actor: "api",
    action: "api_key.created",
    resourceType: "api_key",
    resourceId: created.id,
    metadata: { name: body.name, tenantId: created.tenantId, prefix: created.prefix },
  });
  // token returned once
  return c.json(
    {
      id: created.id,
      token: created.token,
      prefix: created.prefix,
      tenantId: created.tenantId,
      warning: "Store this token now; it will not be shown again.",
    },
    201,
  );
});

app.post("/keys/:id/revoke", async (c) => {
  revokeApiKey(db, c.req.param("id"), nowIso());
  recordAudit(db, {
    actor: "api",
    action: "api_key.revoked",
    resourceType: "api_key",
    resourceId: c.req.param("id"),
  });
  return c.json({ ok: true });
});

// ─── Phase D: GitHub webhooks ────────────────────────────────────────────────

app.post("/webhooks/github", async (c) => {
  const raw = await c.req.text();
  const headers: Record<string, string | undefined> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const wh = parseWebhookHeaders(headers);
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const ok = verifyGitHubSignature(raw, wh.signature256, secret, {
    requireSecret: Boolean(secret),
  });
  if (!ok) {
    return c.json({ error: "invalid signature" }, 401);
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  const event = normalizeGitHubEvent(wh.event, payload);
  recordAudit(db, {
    actor: "github_webhook",
    action: `webhook.${event.type}`,
    resourceType: "webhook",
    resourceId: wh.delivery ?? null,
    metadata: event,
  });

  if (event.type === "ping") {
    return c.json({ ok: true, pong: event.zen ?? true });
  }

  if (event.type === "installation") {
    if (event.action === "deleted" && event.installationId) {
      db.raw
        .prepare(`DELETE FROM github_installations WHERE installation_id = ?`)
        .run(String(event.installationId));
      db.raw
        .prepare(`UPDATE consumers SET installation_id = NULL WHERE installation_id = ?`)
        .run(String(event.installationId));
      recordAudit(db, {
        actor: "github_webhook",
        action: "installation.deleted",
        resourceType: "github_installation",
        resourceId: String(event.installationId),
      });
      return c.json({ ok: true, type: "installation", action: "deleted" });
    }
    if (event.accountLogin && event.installationId) {
      upsertGitHubInstallation(db, {
        id: newId(),
        installationId: String(event.installationId),
        accountLogin: event.accountLogin,
        tenantId: "tenant_default",
        repositories: event.repos,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      linkConsumersToInstallation(
        db,
        event.accountLogin,
        String(event.installationId),
        "tenant_default",
      );
    }
    return c.json({ ok: true, type: "installation", installationId: event.installationId });
  }

  if (event.type === "pull_request") {
    const outcome = prFeedbackFromWebhook(event);
    if (outcome) {
      const match = listPrs(db).find(
        (p) =>
          p.github_pr_number === event.number ||
          (p.github_pr_url && p.github_pr_url === event.htmlUrl),
      );
      if (match) {
        // Experiment/plan from migration PR body tags; webhook does not override
        await applyPrFeedback(db, match.id, outcome, {});
        return c.json({
          ok: true,
          applied: outcome,
          prId: match.id,
          note: "experiment/plan taken from PR body tags if present",
        });
      }
      return c.json({ ok: true, applied: null, reason: "no matching migration PR" });
    }
    return c.json({ ok: true, ignored: event.action });
  }

  return c.json({ ok: true, type: event.type });
});

app.get("/audit", (c) => c.json(listAudit(db).map(auditToApi)));

/** Phase B instrumentation */
app.get("/metrics", (c) => c.json(computeProductMetrics(db)));

/** Design-partner metrics (gap closure) */
app.get("/metrics/design-partner", (c) => c.json(computeDesignPartnerMetrics(db)));

/** Pre-customer A2: consumer exposure report (Warden) */
app.get("/consumers/:id/exposure", (c) => {
  const report = buildExposureReport(db, c.req.param("id"));
  if (!report) return c.json({ error: "not found" }, 404);
  return c.json(report);
});

app.get("/consumers/:id/exposure.md", (c) => {
  const report = buildExposureReport(db, c.req.param("id"));
  if (!report) return c.text("not found", 404);
  return c.body(report.markdown, 200, {
    "Content-Type": "text/markdown; charset=utf-8",
  });
});


/** Audit export for enterprise / compliance */
app.get("/audit/export", (c) => {
  const format = c.req.query("format") ?? "json";
  const limit = Math.min(Number(c.req.query("limit") ?? 2000), 20_000);
  if (format === "csv") {
    const csv = exportAuditCsv(db, limit);
    return c.body(csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="mendpoint-audit.csv"',
    });
  }
  return c.json(exportAuditJson(db, limit));
});

/** Provider severity on a change */
app.post("/changes/:id/severity", async (c) => {
  const body = await c.req.json<{ severity: string }>();
  if (!["required", "recommended", "optional"].includes(body.severity)) {
    return c.json({ error: "severity must be required|recommended|optional" }, 400);
  }
  const ch = getChange(db, c.req.param("id"));
  if (!ch) return c.json({ error: "not found" }, 404);
  updateChangeSeverity(db, ch.id, body.severity);
  recordAudit(db, {
    actor: "api",
    action: "change.severity_updated",
    resourceType: "api_change",
    resourceId: ch.id,
    metadata: { severity: body.severity },
  });
  invalidateGraphCaches();
  return c.json(changeToApi(getChange(db, ch.id)!));
});

/** Fan-out job: run pipeline for a provider across consumers */
app.post("/jobs/fanout", async (c) => {
  const body = await c.req.json<{
    providerSlug: string;
    severity?: string;
    notificationsOnly?: boolean;
  }>();
  if (!body.providerSlug) return c.json({ error: "providerSlug required" }, 400);
  const id = newId();
  enqueueJob(db, {
    id,
    type: "pipeline.fanout",
    payload: {
      providerSlug: body.providerSlug,
      severity: body.severity,
      notificationsOnly: body.notificationsOnly,
    },
    createdAt: nowIso(),
  });
  return c.json({ id, type: "pipeline.fanout", status: "pending" }, 201);
});

app.get("/jobs", (c) => c.json(listJobs(db, 50)));

/** Process one pending job (also available on worker) */
app.post("/jobs/process-one", async (c) => {
  const job = claimNextJob(db, ["pipeline.fanout", "agent.run"]);
  if (!job) return c.json({ processed: false });
  try {
    if (job.type === "agent.run") {
      const payload = JSON.parse(job.payload_json) as {
        goal: string;
        repoPath: string;
        verifyCommand?: string;
        errorLog?: string;
        maxSteps?: number;
        dryRun?: boolean;
        useLlm?: boolean;
        allowNetwork?: boolean;
        sessionId?: string;
      };
      const started = nowIso();
      const result = await runWarden({
        goal: payload.goal,
        repoRoot: payload.repoPath,
        verifyCommand: payload.verifyCommand,
        errorLog: payload.errorLog,
        maxSteps: payload.maxSteps ?? 20,
        dryRun: payload.dryRun,
        useLlm: payload.useLlm ?? process.env.LLM_AGENT === "1",
        allowNetwork: payload.allowNetwork ?? false,
        sessionId: payload.sessionId,
      });
      insertAgentRun(db, {
        id: result.sessionId,
        goal: payload.goal,
        repoPath: payload.repoPath,
        status: result.ok ? "ok" : "failed",
        ok: result.ok,
        steps: result.steps.length,
        filesChanged: result.filesChanged,
        reportMd: result.reportMarkdown,
        resultJson: JSON.stringify({
          stoppedReason: result.stoppedReason,
          jobId: job.id,
        }),
        createdAt: started,
        finishedAt: nowIso(),
      });
      completeJob(
        db,
        job.id,
        {
          sessionId: result.sessionId,
          ok: result.ok,
          steps: result.steps.length,
          filesChanged: result.filesChanged,
          stoppedReason: result.stoppedReason,
        },
        nowIso(),
      );
      return c.json({
        processed: true,
        jobId: job.id,
        type: "agent.run",
        sessionId: result.sessionId,
        ok: result.ok,
      });
    }

    const payload = JSON.parse(job.payload_json) as {
      providerSlug: string;
      severity?: "required" | "recommended" | "optional";
      notificationsOnly?: boolean;
    };
    const report = await runChangePipeline({
      providerSlug: payload.providerSlug,
      db,
      severity: payload.severity,
      notificationsOnly: payload.notificationsOnly,
    });
    completeJob(db, job.id, report, nowIso());
    invalidateGraphCaches();
    return c.json({ processed: true, jobId: job.id, report });
  } catch (e) {
    failJob(db, job.id, e instanceof Error ? e.message : String(e), nowIso());
    return c.json(
      { processed: true, jobId: job.id, error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

/** SDK registry signals (live or local stub) */
app.get("/feeds/sdk-signals", async (c) => {
  const localOnly = c.req.query("local") !== "0";
  const signals = await probeKnownSdks({ localOnly });
  return c.json({ signals, localOnly });
});

// ─── Devin-style API bug agent ───────────────────────────────────────────────

app.get("/agent/runs", (c) => c.json(listAgentRuns(db, 40).map(agentRunToApi)));

app.get("/agent/runs/:id", (c) => {
  const r = getAgentRun(db, c.req.param("id"));
  if (!r) return c.json({ error: "not found" }, 404);
  return c.json(agentRunToApi(r));
});

/**
 * Run Warden — Mendpoint API debug agent (tool loop).
 * Body: { goal, repoPath|consumerId, verifyCommand?, errorLog?, maxSteps?, dryRun?, useLlm?, allowNetwork?, async? }
 * When async=true, enqueues job type agent.run and returns 202.
 */
app.post("/agent/runs", async (c) => {
  try {
    const body = await c.req.json<{
      goal: string;
      repoPath?: string;
      consumerId?: string;
      verifyCommand?: string;
      errorLog?: string;
      maxSteps?: number;
      dryRun?: boolean;
      useLlm?: boolean;
      allowNetwork?: boolean;
      async?: boolean;
    }>();
    if (!body.goal?.trim()) return c.json({ error: "goal required" }, 400);

    let repoPath = body.repoPath;
    if (!repoPath && body.consumerId) {
      const repo = getConsumerRepo(db, body.consumerId);
      if (!repo) return c.json({ error: "consumer has no local repo" }, 400);
      repoPath = repo.local_path;
    }
    if (!repoPath) return c.json({ error: "repoPath or consumerId required" }, 400);

    if (body.async) {
      const jobId = newId();
      const sessionId = newId();
      enqueueJob(db, {
        id: jobId,
        type: "agent.run",
        payload: {
          goal: body.goal,
          repoPath,
          verifyCommand: body.verifyCommand,
          errorLog: body.errorLog,
          maxSteps: body.maxSteps ?? 20,
          dryRun: body.dryRun,
          useLlm: body.useLlm ?? process.env.LLM_AGENT === "1",
          allowNetwork: body.allowNetwork ?? false,
          sessionId,
        },
        createdAt: nowIso(),
      });
      insertAgentRun(db, {
        id: sessionId,
        goal: body.goal,
        repoPath,
        status: "queued",
        ok: false,
        steps: 0,
        filesChanged: [],
        reportMd: null,
        resultJson: JSON.stringify({ jobId }),
        createdAt: nowIso(),
        finishedAt: null,
      });
      recordAudit(db, {
        actor: "agent",
        action: "agent.run.queued",
        resourceType: "agent_run",
        resourceId: sessionId,
        metadata: { jobId, product: "warden" },
      });
      return c.json(
        {
          sessionId,
          jobId,
          status: "queued",
          product: "warden",
          message: "Drain with POST /jobs/process-one or worker process-jobs",
        },
        202,
      );
    }

    const started = nowIso();
    const result = await runWarden({
      goal: body.goal,
      repoRoot: repoPath,
      verifyCommand: body.verifyCommand,
      errorLog: body.errorLog,
      maxSteps: body.maxSteps ?? 20,
      dryRun: body.dryRun,
      useLlm: body.useLlm ?? process.env.LLM_AGENT === "1",
      allowNetwork: body.allowNetwork ?? false,
    });

    insertAgentRun(db, {
      id: result.sessionId,
      goal: body.goal,
      repoPath,
      status: result.ok ? "ok" : "failed",
      ok: result.ok,
      steps: result.steps.length,
      filesChanged: result.filesChanged,
      reportMd: result.reportMarkdown,
      resultJson: JSON.stringify({
        stoppedReason: result.stoppedReason,
        steps: result.steps.map((s) => ({
          step: s.step,
          tool: s.call.tool,
          ok: s.result.ok,
          summary: s.result.summary,
          thought: s.thought,
        })),
      }),
      createdAt: started,
      finishedAt: nowIso(),
    });

    recordAudit(db, {
      actor: "agent",
      action: result.ok ? "agent.run.ok" : "agent.run.failed",
      resourceType: "agent_run",
      resourceId: result.sessionId,
      metadata: {
        steps: result.steps.length,
        files: result.filesChanged,
        stoppedReason: result.stoppedReason,
      },
    });

    return c.json(
      {
        sessionId: result.sessionId,
        ok: result.ok,
        steps: result.steps.length,
        filesChanged: result.filesChanged,
        stoppedReason: result.stoppedReason,
        reportMarkdown: result.reportMarkdown,
        trace: result.steps.slice(-15).map((s) => ({
          step: s.step,
          tool: s.call.tool,
          ok: s.result.ok,
          summary: s.result.summary,
          thought: s.thought,
        })),
      },
      201,
    );
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// ─── Agentic repair product layer ────────────────────────────────────────────

app.get("/repair/sessions", (c) =>
  c.json(listRepairSessions(db, 40).map(repairSessionToApi)),
);

app.get("/repair/sessions/:id", (c) => {
  const s = getRepairSession(db, c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  return c.json(repairSessionToApi(s));
});

/**
 * Run agentic repair against a consumer checkout (or explicit path).
 * Body: { consumerId?, repoPath?, renameMap?, verifyCommands?, maxAttempts?, dryRun?, useLlm? }
 */
app.post("/repair/sessions", async (c) => {
  try {
    const body = await c.req.json<{
      consumerId?: string;
      repoPath?: string;
      renameMap?: Record<string, string>;
      verifyCommands?: string[];
      maxAttempts?: number;
      dryRun?: boolean;
      useLlm?: boolean;
      agenticLoop?: boolean;
    }>();

    let repoPath = body.repoPath;
    let consumerId = body.consumerId ?? null;
    if (!repoPath && body.consumerId) {
      const repo = getConsumerRepo(db, body.consumerId);
      if (!repo) return c.json({ error: "consumer has no local repo" }, 400);
      repoPath = repo.local_path;
    }
    if (!repoPath) return c.json({ error: "repoPath or consumerId required" }, 400);

    const sessionId = newId();
    const started = nowIso();

    const result = body.agenticLoop
      ? (
          await runAgenticRepairLoop({
            repoRoot: repoPath,
            renameMap: body.renameMap,
            verifyCommands: body.verifyCommands,
            maxAttempts: body.maxAttempts ?? 3,
            dryRun: body.dryRun,
            useLlm: body.useLlm ?? process.env.LLM_REPAIR === "1",
          })
        ).repair
      : await runRepairSession({
          sessionId,
          repoRoot: repoPath,
          renameMap: body.renameMap,
          verifyCommands: body.verifyCommands,
          maxAttempts: body.maxAttempts ?? 3,
          dryRun: body.dryRun,
          useLlm: body.useLlm ?? process.env.LLM_REPAIR === "1",
        });

    insertRepairSession(db, {
      id: result.sessionId,
      consumerId,
      repoPath,
      status: result.ok ? "ok" : "failed",
      attempts: result.attempts,
      editsCount: result.edits.length,
      ok: result.ok,
      reportMd: result.reportMarkdown,
      resultJson: JSON.stringify({
        plans: result.plans,
        edits: result.edits.map((e) => ({
          filePath: e.filePath,
          reason: e.reason,
        })),
        policyNotes: result.policyNotes,
      }),
      createdAt: started,
      finishedAt: nowIso(),
    });

    recordAudit(db, {
      actor: "repair",
      action: result.ok ? "repair.session.ok" : "repair.session.failed",
      resourceType: "repair_session",
      resourceId: result.sessionId,
      metadata: {
        attempts: result.attempts,
        edits: result.edits.length,
        consumerId,
      },
    });

    return c.json(
      {
        sessionId: result.sessionId,
        ok: result.ok,
        attempts: result.attempts,
        editsCount: result.edits.length,
        reportMarkdown: result.reportMarkdown,
        edits: result.edits.map((e) => ({ path: e.filePath, reason: e.reason })),
        plans: result.plans.map((p) => ({
          attempt: p.attempt,
          strategy: p.strategy,
          summary: p.summary,
          actions: p.actions.length,
        })),
      },
      201,
    );
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

app.get("/policies/defaults", (c) =>
  c.json({
    autoMergeLowRisk: false,
    neverTouchPaths: [
      ".env",
      ".env.production",
      "secrets/",
      "prod/",
      "package-lock.json",
    ],
    requireTwoReviewersForAuth: true,
    minConfidenceForEdit: "medium",
    notificationsOnly: false,
  }),
);

// ─── Phase E: tenants + billing ──────────────────────────────────────────────

app.get("/billing/plans", (c) => c.json(BILLING_PLANS));

app.get("/tenants", (c) => c.json(listTenants(db).map(tenantToApi)));

app.get("/tenants/:idOrSlug", (c) => {
  const key = c.req.param("idOrSlug");
  const t = getTenant(db, key) ?? getTenantBySlug(db, key);
  if (!t) return c.json({ error: "not found" }, 404);
  return c.json(tenantToApi(t));
});

app.post("/tenants", async (c) => {
  const body = await c.req.json<{ slug: string; name: string; plan?: string }>();
  if (!body.slug || !body.name) return c.json({ error: "slug and name required" }, 400);
  if (getTenantBySlug(db, body.slug)) return c.json({ error: "slug taken" }, 409);
  const id = newId();
  const plan = body.plan ?? "free";
  const planMeta = BILLING_PLANS.find((p) => p.id === plan);
  insertTenant(db, {
    id,
    slug: body.slug,
    name: body.name,
    plan,
    seatLimit: planMeta?.seatLimit ?? 3,
    createdAt: nowIso(),
  });
  recordAudit(db, {
    actor: "api",
    action: "tenant.created",
    resourceType: "tenant",
    resourceId: id,
    metadata: { slug: body.slug, plan },
  });
  return c.json(tenantToApi(getTenant(db, id)!), 201);
});

app.post("/tenants/:id/plan", async (c) => {
  const t = getTenant(db, c.req.param("id"));
  if (!t) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ plan: string }>();
  if (!BILLING_PLANS.some((p) => p.id === body.plan)) {
    return c.json({ error: "invalid plan", plans: BILLING_PLANS.map((p) => p.id) }, 400);
  }
  // Billing stub: no Stripe charge — plan flips immediately for local/dev
  updateTenantPlan(db, t.id, body.plan);
  recordAudit(db, {
    actor: "api",
    action: "tenant.plan_changed",
    resourceType: "tenant",
    resourceId: t.id,
    metadata: { from: t.plan, to: body.plan, billing: "stub" },
  });
  return c.json(tenantToApi(getTenant(db, t.id)!));
});

// ─── Phase E: GitHub App install wizard ──────────────────────────────────────

app.get("/github/app/config", (c) => c.json(getGitHubAppConfig()));

app.get("/github/app/install-url", (c) => {
  const state = c.req.query("state") ?? undefined;
  const result = buildInstallUrl({ state });
  return c.json(result);
});

app.get("/github/app/installations", (c) =>
  c.json(listGitHubInstallations(db).map(githubInstallationToApi)),
);

/** Mock install entry (used when GITHUB_APP_ID unset). Real GitHub redirects to callback. */
app.get("/github/app/mock-install", async (c) => {
  const state = c.req.query("state") ?? "";
  const login = c.req.query("login") ?? "demo-org";
  return c.json({
    mock: true,
    message: "POST /github/app/callback with body to complete mock install",
    state,
    suggestedBody: {
      installationId: "mock-10001",
      accountLogin: login,
      accountType: "Organization",
      tenantId: "tenant_default",
      repositories: [{ owner: login, name: "shop-app" }],
    },
  });
});

app.post("/github/app/callback", async (c) => {
  const body = await c.req.json<{
    installationId?: string;
    accountLogin: string;
    accountType?: "User" | "Organization";
    tenantId?: string;
    repositories?: Array<{ owner: string; name: string }>;
    setupAction?: string;
  }>();
  if (!body.accountLogin) return c.json({ error: "accountLogin required" }, 400);

  const normalized = normalizeMockInstall({
    accountLogin: body.accountLogin,
    accountType: body.accountType,
    installationId: body.installationId,
    repositories: body.repositories,
    tenantId: body.tenantId ?? "tenant_default",
  });

  const id = upsertGitHubInstallation(db, {
    id: newId(),
    installationId: normalized.installationId,
    accountLogin: normalized.accountLogin,
    accountType: normalized.accountType,
    tenantId: normalized.tenantId,
    permissions: normalized.permissions,
    repositories: normalized.repositories,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  linkConsumersToInstallation(
    db,
    normalized.accountLogin,
    normalized.installationId,
    normalized.tenantId,
  );

  recordAudit(db, {
    actor: "github_app",
    action: "installation.completed",
    resourceType: "github_installation",
    resourceId: id,
    metadata: normalized,
  });

  return c.json(
    {
      ok: true,
      installation: githubInstallationToApi(
        listGitHubInstallations(db).find((i) => i.id === id)!,
      ),
      next: {
        web: "/install?done=1",
        detect: "POST /consumers/:id/detect",
      },
    },
    201,
  );
});

// ─── Phase E: first-party branded agents ─────────────────────────────────────

app.get("/brands", (c) => c.json(listBrandPacks()));

app.get("/brands/:id", (c) => {
  const pack = getBrandPack(c.req.param("id"));
  if (!pack) return c.json({ error: "not found" }, 404);
  return c.json(pack);
});

app.post("/brands/:id/preview", async (c) => {
  const pack = getBrandPack(c.req.param("id"));
  if (!pack) return c.json({ error: "not found" }, 404);
  const body = await c.req
    .json<{ title?: string; body?: string }>()
    .catch(() => ({} as { title?: string; body?: string }));
  const out = applyBrandPack(pack, {
    title: body.title ?? `Migrate ${pack.providerSlug} API surface`,
    body: body.body ?? "## Migration\n\nExample body before brand packaging.",
  });
  return c.json({ pack: pack.id, ...out });
});

const port = Number(process.env.API_PORT ?? 3001);

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(releaseBanner());
  console.log(`Mendpoint API listening on http://localhost:${port}`);
  console.log(
    `probes: /health /live /ready /version /status · auth=${effectiveAuthMode()} · channel=${RELEASE.channel}`,
  );
});

function shutdown(signal: string) {
  console.log(`[mendpoint] ${signal} — graceful shutdown`);
  try {
    // @hono/node-server Server
    const s = server as { close?: (cb?: () => void) => void };
    if (typeof s.close === "function") {
      s.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
      return;
    }
  } catch {
    /* */
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
