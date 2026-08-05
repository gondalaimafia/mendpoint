import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import {
  createDb,
  listProviders,
  getProviderBySlug,
  listChanges,
  getChange,
  listConsumers,
  listPrs,
  listPrsForChange,
  getPr,
  findPrByRepositoryAndNumber,
  listAudit,
  listFindingsForChange,
  listVersionsForProvider,
  listMonitoredForConsumer,
  listMonitoredForConsumers,
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
  getJob,
  jobToApi,
  getJobRecoverySummary,
  retryJob,
  cancelJob,
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
  getFeedScheduleHealth,
  updateProviderFeedUrls,
  BILLING_PLANS,
  adjustUsage,
  createUsageEntitlement,
  createUsagePriceVersion,
  creditUsage,
  getUsageSummary,
  listUsageLedger,
  reconcileUsageLedger,
  releaseUsageReservation,
  reserveUsage,
  settleUsageReservation,
  listTenants,
  getTenant,
  getTenantBySlug,
  getPrincipal,
  insertTenant,
  updateTenantPlan,
  tenantToApi,
  upsertGitHubInstallation,
  listGitHubInstallations,
  getGitHubInstallationByInstallationId,
  createGitHubInstallState,
  consumeGitHubInstallState,
  completeGitHubInstallState,
  recordGitHubWebhookDelivery,
  completeGitHubWebhookDelivery,
  failGitHubWebhookDelivery,
  githubInstallationToApi,
  linkConsumersToInstallation,
  findAuthorizedGitHubInstallationForRepository,
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
  resolveGitHubOwnerTenantBinding,
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
import {
  evaluatePrGates,
  reviewOpenApiDesign,
  type ContractCase,
} from "@mendpoint/contract";
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
  recentAlerts,
  evaluateLatencyAlerts,
  evaluateDogfoodAlerts,
  parsePrincipalFromHeaders,
  can,
  canMutateSystemCatalog,
  permissionForRoute,
  CredentialBroker,
  EnvSecretProvider,
  estimateCost,
  MCU_VERSION,
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
  type GraphTenantScope,
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
import {
  resolveCiHarnessEvidence,
  type CiHarnessEvidence,
} from "./ci-check.js";
import { FeedbackOutcomeSchema, newId, nowIso } from "@mendpoint/shared";
import { notifyWardenEvent } from "@mendpoint/notify";
import { parseWardenRunInput } from "./warden-run-input.js";
import {
  discardWardenCandidate,
  readWardenCandidate,
  sealWardenCandidateApproval,
} from "./warden-candidate.js";
import { isHumanWardenReviewer } from "./warden-review-auth.js";
import { normalizeChange } from "@mendpoint/change-intel";
import {
  createAuthMiddleware,
  effectiveAuthMode,
  scopeAllows,
  type ApiEnv,
} from "./auth.js";
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
import { canonicalRepoPath, resolveRepoKey } from "./repo-path.js";
import {
  materializeConnectedRepository,
  purgeExpiredSnapshots,
  registerConnectedRepository,
  registerScmConnection,
  revokeConnection,
  scmOverview,
} from "./repository-connections.js";
import {
  registerTransformerControlPlaneRoutes,
  TransformerCampaignService,
} from "./transformer-control-plane.js";
import {
  registerTransformerPilotExecutionRoutes,
  TransformerPilotExecutionService,
} from "./transformer-pilot-executions.js";
import {
  closeDefaultChangeSourceStore,
  createChangeSourceRoutes,
} from "./change-sources.js";
import { createBillingEconomicsRoutes } from "./billing-economics.js";
import { billingPlanChangeDecision } from "./billing-plan-control.js";
import { createDesignPartnerApplicationRoutes } from "./design-partner-applications.js";
import { createPilotSuccessContractRoutes } from "./pilot-success-contracts.js";
import { createMigrationPrReviewRoutes } from "./review-routes.js";

// Fail fast in production if env invalid
assertApiEnvOrExit();

const db = createDb();
const app = new Hono<ApiEnv>();
const transformerCampaigns = new TransformerCampaignService();
const transformerExecutions = new TransformerPilotExecutionService();
const startedAt = Date.now();

function requestAudit(
  c: Context<ApiEnv>,
  input: Omit<Parameters<typeof recordAudit>[1], "tenantId" | "principalId" | "apiKeyId" | "requestId">,
) {
  const principal = c.get("principal");
  if (!principal) throw new Error("authenticated_principal_required");
  recordAudit(db, {
    ...input,
    tenantId: principal.tenantId,
    principalId: principal.id,
    apiKeyId: c.get("apiKeyId") ?? null,
    requestId: c.get("requestId") ?? null,
  });
}

function requestTenantId(c: Context<ApiEnv>): string {
  const principal = c.get("principal");
  if (!principal) throw new Error("authenticated_principal_required");
  return principal.tenantId;
}

function requestListLimit(c: Context<ApiEnv>, fallback = 100, maximum = 200): number {
  const requested = Number(c.req.query("limit"));
  if (!Number.isInteger(requested) || requested < 1) return fallback;
  return Math.min(requested, maximum);
}

function requestListOffset(c: Context<ApiEnv>): number {
  const requested = Number(c.req.query("offset"));
  return Number.isSafeInteger(requested) && requested >= 0 ? requested : 0;
}

function pagedJson<T>(c: Context<ApiEnv>, rows: T[], limit: number, offset: number) {
  c.header("X-Page-Limit", String(limit));
  c.header("X-Page-Offset", String(offset));
  if (rows.length === limit) {
    const next = new URL(c.req.url);
    next.searchParams.set("limit", String(limit));
    next.searchParams.set("offset", String(offset + limit));
    c.header("Link", `<${next.pathname}${next.search}>; rel="next"`);
  }
  return c.json(rows);
}

function catalogMutationDenied(c: Context<ApiEnv>) {
  if (effectiveAuthMode() === "off") return undefined;
  const principal = c.get("principal");
  if (principal && canMutateSystemCatalog(principal)) return undefined;
  return c.json(
    {
      error: "catalog_authority_required",
      message: "Shared provider catalog changes require system administrator authority",
    },
    403,
  );
}

function requestConsumerIds(c: Context<ApiEnv>): string[] {
  return listConsumers(db, requestTenantId(c)).map((consumer) => consumer.id);
}

function requestGraphTenantScope(c: Context<ApiEnv>): GraphTenantScope {
  return {
    tenantId: requestTenantId(c),
    consumerIds: requestConsumerIds(c),
  };
}

function repositoryCredentialDependencies(c: Context<ApiEnv>) {
  const principal = c.get("principal");
  if (!principal) throw new Error("authenticated_principal_required");
  const credentialBroker = new CredentialBroker({
    providers: [
      new EnvSecretProvider({
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      }),
    ],
    audit: (event) =>
      requestAudit(c, {
        actor: "system",
        action: `credential.access.${event.outcome}`,
        resourceType: "scm_credential",
        resourceId: event.credentialId,
        metadata: {
          provider: event.reference.provider,
          audience: event.audience,
          purpose: event.purpose,
          reason: event.reason,
          rotationGeneration: event.rotation.generation,
          rotationDue: event.rotation.due,
        },
      }),
  });
  return {
    credentialBroker,
    actorId: principal.id,
    requestId: c.get("requestId") ?? undefined,
  };
}

function tenantConsumerRepo(consumerId: string, tenantId: string) {
  const consumer = getConsumer(db, consumerId, tenantId);
  const repo = consumer ? getConsumerRepo(db, consumer.id, tenantId) : undefined;
  if (!consumer || !repo) return undefined;
  return {
    consumer,
    repo: {
      ...repo,
      local_path: canonicalRepoPath(repo.local_path, tenantId),
    },
  };
}

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
      "X-Request-Id",
      "Idempotency-Key",
      "X-Mendpoint-Evidence-Refs",
    ],
  }),
);

/** Request timing + uncaught error boundary */
app.use("*", async (c, next) => {
  const t0 = Date.now();
  try {
    await next();
    const webhookDeliveryId = c.get("webhookDeliveryId");
    if (webhookDeliveryId) {
      if (c.res.status >= 400) {
        failGitHubWebhookDelivery(
          db,
          webhookDeliveryId,
          nowIso(),
          `HTTP ${c.res.status}`,
        );
      } else {
        completeGitHubWebhookDelivery(db, webhookDeliveryId, nowIso());
      }
    }
  } catch (e) {
    const webhookDeliveryId = c.get("webhookDeliveryId");
    if (webhookDeliveryId) {
      failGitHubWebhookDelivery(
        db,
        webhookDeliveryId,
        nowIso(),
        e instanceof Error ? e.message : String(e),
      );
    }
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
app.use("*", rateLimitMiddleware({ identity: "network" }));
app.use("*", createAuthMiddleware(db));
app.use("*", rateLimitMiddleware({ identity: "principal" }));

/** RBAC identity comes from the authenticated API key in protected modes. */
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;
  if (method === "OPTIONS") return next();
  const need = permissionForRoute(method, path);
  if (!need) return next();
  const mode = effectiveAuthMode();
  const authenticated = c.get("principal");
  const principal =
    authenticated ??
    (mode === "off"
      ? parsePrincipalFromHeaders({
          "x-tenant-id": c.req.header("x-tenant-id") ?? undefined,
          "x-role": c.req.header("x-role") ?? undefined,
          "x-user-id": c.req.header("x-user-id") ?? undefined,
        })
      : undefined);
  if (!principal) {
    return c.json({ error: "unauthorized", message: "authenticated principal required" }, 401);
  }
  const scopes = c.get("authScopes");
  const scopeAllowed = mode === "off" || scopeAllows(scopes, need);
  if (!can(principal, need) || !scopeAllowed) {
    return c.json(
      {
        error: "rbac_denied",
        need,
        role: principal.role,
        message: `role ${principal.role} or API key scope lacks ${need}`,
      },
      403,
    );
  }
  c.set("principal", principal);
  return next();
});

registerTransformerControlPlaneRoutes(app, transformerCampaigns);
registerTransformerPilotExecutionRoutes(app, transformerExecutions);
app.route("/change-sources", createChangeSourceRoutes());
app.route("/billing", createBillingEconomicsRoutes({ db }));
app.route(
  "/design-partner-applications",
  createDesignPartnerApplicationRoutes({ db }),
);
app.route(
  "/pilot-success-contracts",
  createPilotSuccessContractRoutes({ db }),
);
app.route("/prs", createMigrationPrReviewRoutes({ db }));

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
      tenantId: c.get("principal")?.tenantId,
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
      tenantId: c.get("principal")?.tenantId,
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
    const consumers = listConsumersForProvider(
      db,
      provider.slug,
      c.get("principal")?.tenantId,
    );
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
  const hits = listConsumersForProvider(
    db,
    slug,
    c.get("principal")?.tenantId,
  );
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
    consumers: listConsumersImpactedByChange(
      db,
      id,
      c.get("principal")?.tenantId,
    ),
  });
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
  const result = runGraphQuery(
    getGraphLearnDb(),
    { op: "stats" },
    requestGraphTenantScope(c),
  );
  return c.json({ ...(result.rows?.[0] ?? {}), tools: GRAPH_RAG_TOOLS });
});

app.post("/graph-learn/query", async (c) => {
  try {
    const body = (await c.req.json()) as GraphQuery;
    if (!body?.op) return c.json({ error: "op required" }, 400);
    const result = runGraphQuery(
      getGraphLearnDb(),
      body,
      requestGraphTenantScope(c),
    );
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
    const result = runGraphQuery(
      getGraphLearnDb(),
      pick.query,
      requestGraphTenantScope(c),
    );
    return c.json({
      pick,
      result: { ...result, markdown: formatQueryForPlanner(result) },
    });
  }
  return c.json({ pick });
});

app.post("/graph-learn/promote-patterns", (c) => {
  const promotions = promotePatterns(
    getGraphLearnDb(),
    {},
    requestGraphTenantScope(c),
  );
  return c.json({ count: promotions.length, promotions });
});

app.get("/graph-learn/ab", (c) => {
  const report = measureAbLift(
    getGraphLearnDb(),
    undefined,
    requestGraphTenantScope(c),
  );
  return c.json({ ...report, markdown: formatAbReport(report) });
});

app.post("/graph-learn/ast-ingest", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    consumerId?: string;
    maxFiles?: number;
  };
  const tenantId = requestTenantId(c);
  if (!body.consumerId) return c.json({ error: "consumerId required" }, 400);
  const owned = tenantConsumerRepo(body.consumerId, tenantId);
  if (!owned) return c.json({ error: "consumer not found" }, 404);
  const { consumer, repo } = owned;
  const r = ingestAstRepo(getGraphLearnDb(), {
    repoPath: repo.local_path,
    repoId: `${tenantId}:${consumer.id}`,
    maxFiles: Math.min(Math.max(body.maxFiles ?? 100, 1), 500),
  });
  return c.json(r);
});

app.post("/graph-learn/lsp-ingest", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    consumerId?: string;
  };
  const tenantId = requestTenantId(c);
  if (!body.consumerId) return c.json({ error: "consumerId required" }, 400);
  const owned = tenantConsumerRepo(body.consumerId, tenantId);
  if (!owned) return c.json({ error: "consumer not found" }, 404);
  const { consumer, repo } = owned;
  const r = ingestLspSymbols(getGraphLearnDb(), {
    repoPath: repo.local_path,
    repoId: `${tenantId}:${consumer.id}`,
  });
  return c.json(r);
});

app.post("/graph-learn/incremental", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    consumerId?: string;
  };
  const tenantId = requestTenantId(c);
  if (!body.consumerId) return c.json({ error: "consumerId required" }, 400);
  const owned = tenantConsumerRepo(body.consumerId, tenantId);
  if (!owned) return c.json({ error: "consumer not found" }, 404);
  const { consumer, repo } = owned;
  const r = incrementalReingest(getGraphLearnDb(), {
    repoPath: repo.local_path,
    repoId: `${tenantId}:${consumer.id}`,
    maxFiles: 150,
  });
  return c.json(r);
});

app.get("/graph-learn/gnn-export", (c) => {
  const exp = exportGnnFeatures(
    getGraphLearnDb(),
    requestGraphTenantScope(c),
  );
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
  const r = embedGraphNodes(
    getGraphLearnDb(),
    undefined,
    requestGraphTenantScope(c),
  );
  return c.json(r);
});

app.get("/graph-learn/kuzu", (c) => {
  const status = kuzuStatus();
  const script = exportSqliteToKuzuScript(
    getGraphLearnDb(),
    { maxNodes: 100 },
    requestGraphTenantScope(c),
  );
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

app.get("/platform/scm", (c) => c.json(scmOverview(db, requestTenantId(c))));

app.post("/platform/scm/connections", async (c) => {
  try {
    const body = await c.req.json<{
      provider?: unknown;
      credentialRef?: unknown;
      externalAccountId?: unknown;
      displayName?: unknown;
    }>();
    const connection = registerScmConnection(db, {
      tenantId: requestTenantId(c),
      provider: body.provider,
      credentialRef: body.credentialRef,
      externalAccountId: body.externalAccountId,
      displayName: body.displayName,
    });
    requestAudit(c, {
      actor: "operator",
      action: "scm.connection.registered",
      resourceType: "scm_connection",
      resourceId: connection.id,
      metadata: { provider: connection.provider },
    });
    return c.json(connection, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "invalid_request" }, 400);
  }
});

app.post("/platform/scm/repositories", async (c) => {
  try {
    const body = await c.req.json<{
      connectionId?: string;
      remoteId?: unknown;
      owner?: unknown;
      name?: unknown;
      defaultBranch?: unknown;
      selectedBranch?: unknown;
      environment?: unknown;
      retentionDays?: unknown;
    }>();
    const repository = registerConnectedRepository(db, {
      tenantId: requestTenantId(c),
      connectionId: body.connectionId ?? "",
      remoteId: body.remoteId,
      owner: body.owner,
      name: body.name,
      defaultBranch: body.defaultBranch,
      selectedBranch: body.selectedBranch,
      environment: body.environment,
      retentionDays: body.retentionDays,
    });
    requestAudit(c, {
      actor: "operator",
      action: "scm.repository.registered",
      resourceType: "connected_repository",
      resourceId: repository.id,
      metadata: { connectionId: repository.connection_id },
    });
    return c.json(repository, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "invalid_request" }, 400);
  }
});

app.post("/platform/scm/repositories/:id/snapshots", async (c) => {
  try {
    const body = await c.req
      .json<{ consumerRepoId?: string; sparsePaths?: string[] }>()
      .catch((): { consumerRepoId?: string; sparsePaths?: string[] } => ({}));
    const result = await materializeConnectedRepository(db, {
      tenantId: requestTenantId(c),
      repositoryId: c.req.param("id"),
      consumerRepoId: body.consumerRepoId,
      sparsePaths: body.sparsePaths,
    }, repositoryCredentialDependencies(c));
    requestAudit(c, {
      actor: "operator",
      action: "repository.snapshot.materialized",
      resourceType: "repository_snapshot",
      resourceId: result.snapshot.id,
      metadata: {
        exactCommit: result.snapshot.exactCommit,
        manifestSha256: result.snapshot.manifestSha256,
        reused: result.reused,
      },
    });
    return c.json(result, result.reused ? 200 : 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "invalid_request" }, 400);
  }
});

app.post("/platform/scm/connections/:id/revoke", (c) => {
  try {
    const connection = revokeConnection(db, requestTenantId(c), c.req.param("id"));
    requestAudit(c, {
      actor: "operator",
      action: "scm.connection.revoked",
      resourceType: "scm_connection",
      resourceId: connection.id,
    });
    return c.json(connection);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "invalid_request" }, 400);
  }
});

app.post("/platform/scm/snapshots/purge", async (c) => {
  const principal = c.get("principal");
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  const result = await purgeExpiredSnapshots(db, {
    tenantId: principal.tenantId,
    actorPrincipalId: principal.id,
  });
  requestAudit(c, {
    actor: "operator",
    action: "repository.snapshots.retention_evaluated",
    resourceType: "repository_snapshot",
    resourceId: principal.tenantId,
    metadata: result,
  });
  return c.json(result);
});

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
  const principal = c.get("principal");
  if (!principal || !can(principal, "plan:edit")) {
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
    return c.json(
      buildProductKnowledgeGraph(db, f, c.get("principal")?.tenantId),
    );
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


app.get("/providers", (c) => {
  const limit = requestListLimit(c);
  const offset = requestListOffset(c);
  return pagedJson(c, listProviders(db, limit, offset).map(providerToApi), limit, offset);
});

app.get("/providers/:slug", (c) => {
  const p = getProviderBySlug(db, c.req.param("slug"));
  if (!p) return c.json({ error: "not found" }, 404);
  const versions = listVersionsForProvider(db, p.id).map(versionToApi);
  return c.json({ ...providerToApi(p), versions });
});

app.post("/providers", async (c) => {
  const denied = catalogMutationDenied(c);
  if (denied) return denied;
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
  requestAudit(c, {
    actor: "api",
    action: "provider.created",
    resourceType: "provider",
    resourceId: id,
  });
  return c.json({ id, ...body }, 201);
});

app.patch("/providers/:slug/feed", async (c) => {
  const denied = catalogMutationDenied(c);
  if (denied) return denied;
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
  const denied = catalogMutationDenied(c);
  if (denied) return denied;
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
  const denied = catalogMutationDenied(c);
  if (denied) return denied;
  try {
    const body = await c.req
      .json<{
        severity?: "required" | "recommended" | "optional";
        notificationsOnly?: boolean;
        mode?: "migrate" | "adopt";
        contractCases?: ContractCase[];
        securityScanOk?: boolean;
      }>()
      .catch(() => (
        {} as {
          severity?: never;
          notificationsOnly?: boolean;
          mode?: never;
          contractCases?: ContractCase[];
          securityScanOk?: boolean;
        }
      ));
    const report = await runChangePipeline({
      providerSlug: c.req.param("slug"),
      db,
      tenantId: requestTenantId(c),
      consumerIds: requestConsumerIds(c),
      severity: body.severity,
      notificationsOnly: body.notificationsOnly,
      mode: body.mode,
      contractCases: body.contractCases,
      securityScanOk: body.securityScanOk,
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
  const denied = catalogMutationDenied(c);
  if (denied) return denied;
  const p = getProviderBySlug(db, c.req.param("slug"));
  if (!p) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{
    versionLabel: string;
    openapi: unknown;
    changelogMd?: string;
    runPipeline?: boolean;
    contractCases?: ContractCase[];
    securityScanOk?: boolean;
    repairVerifyCommands?: string[];
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
  requestAudit(c, {
    actor: "api",
    action: "provider.version.uploaded",
    resourceType: "provider",
    resourceId: p.id,
    metadata: { versionLabel: body.versionLabel, versionId: id },
  });
  if (body.runPipeline) {
    const jobId = newId();
    enqueueJob(db, {
      id: jobId,
      tenantId: requestTenantId(c),
      type: "pipeline.fanout",
      payload: {
        providerSlug: p.slug,
        contractCases: body.contractCases,
        securityScanOk: body.securityScanOk,
        repairVerifyCommands: body.repairVerifyCommands,
      },
      createdAt: nowIso(),
    });
    invalidateGraphCaches();
    return c.json(
      {
        versionId: id,
        versionLabel: body.versionLabel,
        jobId,
        status: "pending",
      },
      202,
    );
  }
  invalidateGraphCaches();
  return c.json({ versionId: id, versionLabel: body.versionLabel }, 201);
});

app.get("/changes", (c) => {
  const limit = requestListLimit(c);
  const offset = requestListOffset(c);
  return pagedJson(c, listChanges(db, limit, offset).map(changeToApi), limit, offset);
});

app.get("/changes/:id", (c) => {
  const change = getChange(db, c.req.param("id"));
  if (!change) return c.json({ error: "not found" }, 404);
  const tenantId = requestTenantId(c);
  const findings = listFindingsForChange(db, change.id, tenantId).map(findingToApi);
  const prs = listPrsForChange(db, change.id, tenantId).map(prToApi);
  return c.json({
    ...changeToApi(change),
    diff: JSON.parse(change.diff_json),
    findings,
    prs,
  });
});

app.get("/consumers", (c) => {
  const limit = requestListLimit(c);
  const offset = requestListOffset(c);
  const consumers = listConsumers(
    db,
    requestTenantId(c),
    limit,
    offset,
  );
  const monitoredByConsumer = new Map<string, ReturnType<typeof listMonitoredForConsumers>>();
  for (const monitored of listMonitoredForConsumers(
    db,
    consumers.map((consumer) => consumer.id),
  )) {
    const current = monitoredByConsumer.get(monitored.consumer_id) ?? [];
    current.push(monitored);
    monitoredByConsumer.set(monitored.consumer_id, current);
  }
  const all = consumers.map((cons) => ({
    ...consumerToApi(cons),
    monitored: monitoredByConsumer.get(cons.id) ?? [],
  }));
  return pagedJson(c, all, limit, offset);
});

app.post("/consumers", async (c) => {
  const principal = c.get("principal");
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{
    name: string;
    githubOwner: string;
    githubRepo: string;
    repoKey: string;
  }>();
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(body.githubOwner ?? "") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(body.githubRepo ?? "") ||
    body.githubRepo === "." ||
    body.githubRepo === ".."
  ) {
    return c.json({ error: "invalid GitHub owner or repository name" }, 400);
  }
  let localPath: string;
  try {
    localPath = resolveRepoKey(body.repoKey, principal.tenantId);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      400,
    );
  }
  const id = newId();
  const createdAt = nowIso();
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const installation = findAuthorizedGitHubInstallationForRepository(
      db,
      principal.tenantId,
      body.githubOwner,
      body.githubRepo,
    );
    insertConsumer(db, {
      id,
      name: body.name,
      githubOwner: body.githubOwner,
      githubRepo: body.githubRepo,
      installationId: installation?.installation_id ?? null,
      deliveryMode: "app",
      tenantId: principal.tenantId,
      createdAt,
    });
    insertConsumerRepo(db, {
      id: newId(),
      consumerId: id,
      localPath,
      defaultBranch: "main",
      createdAt,
    });
    db.raw.exec("COMMIT");
  } catch (error) {
    if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
  return c.json({ id }, 201);
});

app.post("/consumers/:id/monitor", async (c) => {
  const consumer = getConsumer(
    db,
    c.req.param("id"),
    c.get("principal")?.tenantId,
  );
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
  const consumer = getConsumer(
    db,
    c.req.param("id"),
    c.get("principal")?.tenantId,
  );
  if (!consumer) return c.json({ error: "not found" }, 404);
  const owned = tenantConsumerRepo(consumer.id, requestTenantId(c));
  if (!owned) return c.json({ error: "no valid repo for consumer" }, 400);
  const { repo } = owned;
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
  requestAudit(c, {
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
    recentPolls: listFeedPolls(db, 40, requestTenantId(c)).map(feedPollToApi),
    monitoring: getFeedScheduleHealth(db, nowIso(), requestTenantId(c)),
  }),
);

app.post("/feeds/poll", async (c) => {
  const body = await c.req
    .json<{ localOnly?: boolean; runPipeline?: boolean; slugs?: string[] }>()
    .catch(() => ({} as { localOnly?: boolean; runPipeline?: boolean; slugs?: string[] }));
  const results = await pollAllFeeds({
    db,
    tenantId: requestTenantId(c),
    localOnly: body.localOnly ?? true,
    runPipeline: body.runPipeline ?? true,
    slugs: body.slugs,
    pipeline: async (slug, d) => {
      const report = await runChangePipeline({
        providerSlug: slug,
        db: d,
        tenantId: requestTenantId(c),
        consumerIds: requestConsumerIds(c),
      });
      return { changeId: report.changeId };
    },
  });
  return c.json({ results });
});

app.get("/learning/suppressed", (c) => {
  const consumerId = c.req.query("consumerId") ?? undefined;
  if (
    consumerId &&
    !getConsumer(db, consumerId, c.get("principal")?.tenantId)
  ) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json(
    listSuppressedPatterns(db, {
      consumerId,
      tenantId: requestTenantId(c),
    }),
  );
});

app.get("/prs", (c) => {
  const limit = requestListLimit(c);
  const offset = requestListOffset(c);
  return pagedJson(
    c,
    listPrs(db, requestTenantId(c), limit, offset).map(prToApi),
    limit,
    offset,
  );
});

app.get("/prs/:id", (c) => {
  const pr = getPr(db, c.req.param("id"), c.get("principal")?.tenantId);
  if (!pr) return c.json({ error: "not found" }, 404);
  return c.json(prToApi(pr));
});

app.post("/prs/:id/feedback", async (c) => {
  const tenantId = c.get("principal")?.tenantId;
  const pr = getPr(db, c.req.param("id"), tenantId);
  if (!pr) return c.json({ error: "not found" }, 404);
  const body = await c.req.json();
  const parsed = FeedbackOutcomeSchema.safeParse(body.outcome);
  if (!parsed.success) return c.json({ error: "invalid outcome" }, 400);
  await applyPrFeedback(db, pr.id, parsed.data, {
    tenantId: tenantId ?? requestTenantId(c),
    experiment: body.experiment,
    planId: body.planId,
  });
  return c.json({
    ...prToApi(getPr(db, pr.id, tenantId)!),
    experiment: body.experiment ?? null,
    planId: body.planId ?? null,
  });
});

/** Phase D: advisory CI check body (and optional mock post) for a migration PR */
app.post("/prs/:id/ci-check", async (c) => {
  const tenantId = c.get("principal")?.tenantId;
  const pr = getPr(db, c.req.param("id"), tenantId);
  if (!pr) return c.json({ error: "not found" }, 404);
  const consumer = getConsumer(db, pr.consumer_id, tenantId);
  if (!consumer) return c.json({ error: "consumer missing" }, 400);
  const findings = listFindingsForChange(db, pr.change_id, requestTenantId(c));
  const body = await c.req
    .json<{
      harness?: CiHarnessEvidence[];
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
    harness: resolveCiHarnessEvidence(body.harness),
    policyNotes: ["Auto-merge disabled", "Human review required"],
  };
  const commentBody = formatCiCheckComment(input);
  if (body.post && pr.github_pr_number) {
    const commenter = new MockPrCommenter();
    const res = await postCiCheck(commenter, input);
    requestAudit(c, {
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

app.get("/keys", (c) => {
  const principal = c.get("principal");
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  return c.json(listApiKeys(db, principal.tenantId).map(apiKeyToApi));
});

app.post("/keys", async (c) => {
  const principal = c.get("principal");
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ name: string; scopes?: string[] }>();
  if (!body.name) return c.json({ error: "name required" }, 400);
  const created = createApiKey(db, {
    id: newId(),
    name: body.name,
    tenantId: principal.tenantId,
    scopes: body.scopes,
    createdAt: nowIso(),
  });
  requestAudit(c, {
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
  const principal = c.get("principal");
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  const revoked = revokeApiKey(
    db,
    c.req.param("id"),
    nowIso(),
    principal.tenantId,
  );
  if (!revoked) return c.json({ error: "not found" }, 404);
  requestAudit(c, {
    actor: "api",
    action: "api_key.revoked",
    resourceType: "api_key",
    resourceId: c.req.param("id"),
  });
  return c.json({ ok: true });
});

// ─── Phase D: GitHub webhooks ────────────────────────────────────────────────

app.post("/webhooks/github", async (c) => {
  const maxWebhookBytes = 1_048_576;
  const declaredLength = Number(c.req.header("content-length") ?? 0);
  if (declaredLength > maxWebhookBytes) {
    return c.json({ error: "payload_too_large" }, 413);
  }
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > maxWebhookBytes) {
    return c.json({ error: "payload_too_large" }, 413);
  }
  const headers: Record<string, string | undefined> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const wh = parseWebhookHeaders(headers);
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const ok = verifyGitHubSignature(raw, wh.signature256, secret, {
    requireSecret: isProduction() || Boolean(secret),
  });
  if (!ok) {
    return c.json({ error: "invalid signature" }, 401);
  }
  if (!wh.delivery && isProduction()) {
    return c.json({ error: "delivery id required" }, 400);
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (
    wh.delivery &&
    !recordGitHubWebhookDelivery(db, wh.delivery, wh.event, nowIso())
  ) {
    return c.json({ ok: true, duplicate: true });
  }
  if (wh.delivery) c.set("webhookDeliveryId", wh.delivery);

  const event = normalizeGitHubEvent(wh.event, payload);

  if (event.type === "ping") {
    return c.json({ ok: true, pong: event.zen ?? true });
  }

  if (event.type === "installation") {
    const installationId = String(event.installationId);
    const existing = getGitHubInstallationByInstallationId(db, installationId);
    const configuredTenantId = event.accountLogin
      ? resolveGitHubOwnerTenantBinding(event.accountLogin)
      : undefined;
    if (configuredTenantId && !getTenant(db, configuredTenantId)) {
      return c.json({ error: "github_owner_binding_tenant_not_found" }, 503);
    }
    const tenantId = existing?.tenant_id ?? configuredTenantId;
    if (event.action === "deleted" && event.installationId) {
      const deletedAt = nowIso();
      const tombstoned = db.raw
        .prepare(
          `UPDATE github_installations
           SET deleted_at = ?, updated_at = ?
           WHERE installation_id = ?`,
        )
        .run(deletedAt, deletedAt, installationId);
      if (Number(tombstoned.changes) === 0 && event.accountLogin) {
        upsertGitHubInstallation(db, {
          id: newId(),
          installationId,
          accountLogin: event.accountLogin,
          tenantId,
          permissions: event.permissions,
          repositories: event.repos,
          repositorySelection: event.repositorySelection,
          deletedAt,
          createdAt: deletedAt,
          updatedAt: deletedAt,
        });
      }
      db.raw
        .prepare(
          `UPDATE consumers
           SET installation_id = NULL, github_delivery_mode = 'revoked'
           WHERE installation_id = ?`,
        )
        .run(String(event.installationId));
      recordAudit(db, {
        tenantId: tenantId ?? "tenant_system_unassigned",
        actor: "github_webhook",
        action: `installation.${event.action}`,
        resourceType: "github_installation",
        resourceId: String(event.installationId),
      });
      return c.json({ ok: true, type: "installation", action: event.action });
    }
    if (event.action === "suspend" && event.installationId) {
      const suspendedAt = nowIso();
      const suspended = db.raw
        .prepare(
          `UPDATE github_installations
           SET suspended_at = ?, updated_at = ?
           WHERE installation_id = ?`,
        )
        .run(suspendedAt, suspendedAt, installationId);
      if (Number(suspended.changes) === 0 && event.accountLogin) {
        upsertGitHubInstallation(db, {
          id: newId(),
          installationId,
          accountLogin: event.accountLogin,
          tenantId,
          permissions: event.permissions,
          repositories: event.repos,
          repositorySelection: event.repositorySelection,
          suspendedAt,
          createdAt: suspendedAt,
          updatedAt: suspendedAt,
        });
      }
      db.raw
        .prepare(
          `UPDATE consumers
           SET installation_id = NULL, github_delivery_mode = 'revoked'
           WHERE installation_id = ?`,
        )
        .run(installationId);
      recordAudit(db, {
        tenantId: tenantId ?? "tenant_system_unassigned",
        actor: "github_webhook",
        action: "installation.suspend",
        resourceType: "github_installation",
        resourceId: installationId,
      });
      return c.json({ ok: true, type: "installation", action: event.action });
    }
    if (existing?.deleted_at) {
      return c.json({
        ok: true,
        type: "installation",
        action: event.action,
        ignored: "installation_deleted",
      });
    }
    if (event.accountLogin && event.installationId) {
      const currentRepos = existing?.repositories_json
        ? (JSON.parse(existing.repositories_json) as Array<{
            id?: number;
            owner: string;
            name: string;
          }>)
        : [];
      const repoKey = (repo: { owner: string; name: string }) =>
        `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
      const removed = new Set((event.reposRemoved ?? []).map(repoKey));
      const mergedRepos = new Map(
        [...currentRepos, ...(event.repos ?? []), ...(event.reposAdded ?? [])]
          .filter((repo) => !removed.has(repoKey(repo)))
          .map((repo) => [repoKey(repo), repo]),
      );
      upsertGitHubInstallation(db, {
        id: newId(),
        installationId: String(event.installationId),
        accountLogin: event.accountLogin,
        tenantId,
        permissions: event.permissions,
        repositories: [...mergedRepos.values()],
        repositorySelection: event.repositorySelection,
        suspendedAt: event.action === "unsuspend" ? null : undefined,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      const persisted = getGitHubInstallationByInstallationId(db, installationId);
      if (tenantId && !persisted?.suspended_at && !persisted?.deleted_at) {
        linkConsumersToInstallation(
          db,
          event.accountLogin,
          installationId,
          [...mergedRepos.values()],
          tenantId,
        );
        recordAudit(db, {
          tenantId,
          actor: "github_webhook",
          action: `installation.${event.action || "updated"}`,
          resourceType: "github_installation",
          resourceId: installationId,
          requestId: c.get("requestId"),
          metadata: { delivery: wh.delivery },
        });
      }
    }
    return c.json({ ok: true, type: "installation", installationId: event.installationId });
  }

  if (event.type === "pull_request") {
    const outcome = prFeedbackFromWebhook(event);
    if (outcome) {
      const match = findPrByRepositoryAndNumber(
        db,
        event.owner,
        event.repo,
        event.number,
      );
      if (match) {
        const consumer = getConsumer(db, match.consumer_id);
        if (!consumer) {
          return c.json({ error: "webhook_consumer_not_found" }, 409);
        }
        // Experiment/plan from migration PR body tags; webhook does not override
        await applyPrFeedback(db, match.id, outcome, {
          tenantId: consumer.tenant_id,
        });
        recordAudit(db, {
          id: wh.delivery
            ? `webhook_${createHash("sha256")
                .update(`${wh.delivery}\0pr.${outcome}`)
                .digest("hex")}`
            : undefined,
          tenantId: consumer.tenant_id,
          actor: "github_webhook",
          action: `pr.${outcome}`,
          resourceType: "migration_pr",
          resourceId: match.id,
          requestId: c.get("requestId"),
          metadata: {
            delivery: wh.delivery,
            owner: event.owner,
            repo: event.repo,
            number: event.number,
          },
        });
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

app.get("/audit", (c) => {
  const limit = requestListLimit(c);
  const offset = requestListOffset(c);
  return pagedJson(
    c,
    listAudit(db, requestTenantId(c), limit, offset).map(auditToApi),
    limit,
    offset,
  );
});

/** Phase B instrumentation */
app.get("/metrics", (c) =>
  c.json(computeProductMetrics(db, requestTenantId(c))),
);

/** Design-partner metrics (gap closure) */
app.get("/metrics/design-partner", (c) =>
  c.json(computeDesignPartnerMetrics(db, requestTenantId(c))),
);

/** Pre-customer A2: consumer exposure report (Warden) */
app.get("/consumers/:id/exposure", (c) => {
  if (!getConsumer(db, c.req.param("id"), c.get("principal")?.tenantId)) {
    return c.json({ error: "not found" }, 404);
  }
  const report = buildExposureReport(db, c.req.param("id"));
  if (!report) return c.json({ error: "not found" }, 404);
  return c.json(report);
});

app.get("/consumers/:id/exposure.md", (c) => {
  if (!getConsumer(db, c.req.param("id"), c.get("principal")?.tenantId)) {
    return c.text("not found", 404);
  }
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
    const csv = exportAuditCsv(db, limit, requestTenantId(c));
    return c.body(csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="mendpoint-audit.csv"',
    });
  }
  return c.json(exportAuditJson(db, limit, requestTenantId(c)));
});

/** Provider severity on a change */
app.post("/changes/:id/severity", async (c) => {
  const denied = catalogMutationDenied(c);
  if (denied) return denied;
  const body = await c.req.json<{ severity: string }>();
  if (!["required", "recommended", "optional"].includes(body.severity)) {
    return c.json({ error: "severity must be required|recommended|optional" }, 400);
  }
  const ch = getChange(db, c.req.param("id"));
  if (!ch) return c.json({ error: "not found" }, 404);
  updateChangeSeverity(db, ch.id, body.severity);
  requestAudit(c, {
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
    contractCases?: ContractCase[];
    securityScanOk?: boolean;
    repairVerifyCommands?: string[];
  }>();
  if (!body.providerSlug) return c.json({ error: "providerSlug required" }, 400);
  const id = newId();
  enqueueJob(db, {
    id,
    tenantId: requestTenantId(c),
    type: "pipeline.fanout",
    payload: {
      providerSlug: body.providerSlug,
      tenantId: requestTenantId(c),
      severity: body.severity,
      notificationsOnly: body.notificationsOnly,
      contractCases: body.contractCases,
      securityScanOk: body.securityScanOk,
      repairVerifyCommands: body.repairVerifyCommands,
    },
    createdAt: nowIso(),
  });
  return c.json({ id, type: "pipeline.fanout", status: "pending" }, 201);
});

app.get("/jobs", (c) =>
  c.json(listJobs(db, 50, requestTenantId(c)).map(jobToApi)),
);

app.get("/jobs/:id", (c) => {
  const job = getJob(db, c.req.param("id"), requestTenantId(c));
  if (!job) return c.json({ error: "not found" }, 404);
  return c.json(jobToApi(job));
});

app.get("/recovery/summary", (c) => {
  const now = nowIso();
  const summary = getJobRecoverySummary(db, requestTenantId(c), now);
  const oldestPendingAgeMs = summary.oldestPendingAt
    ? Math.max(0, Date.parse(now) - Date.parse(summary.oldestPendingAt))
    : null;
  return c.json({
    ...summary,
    retryScheduled: summary.scheduled,
    oldestPendingAgeMs,
  });
});

app.post("/jobs/:id/retry", async (c) => {
  const body = await c.req
    .json<{ reason?: string }>()
    .catch((): { reason?: string } => ({}));
  const tenantId = requestTenantId(c);
  const retried = retryJob(db, c.req.param("id"), { tenantId, now: nowIso() });
  if (!retried) return c.json({ error: "job is not eligible for retry" }, 409);
  requestAudit(c, {
    actor: "operator",
    action: "job.retry_requested",
    resourceType: "job",
    resourceId: c.req.param("id"),
    metadata: { reason: body.reason?.slice(0, 500) ?? null },
  });
  return c.json({ ok: true, id: c.req.param("id"), status: "pending" });
});

app.post("/jobs/:id/cancel", async (c) => {
  const body = await c.req
    .json<{ reason?: string }>()
    .catch((): { reason?: string } => ({}));
  const tenantId = requestTenantId(c);
  const cancelled = cancelJob(db, c.req.param("id"), nowIso(), {
    tenantId,
    reason: body.reason,
  });
  if (!cancelled) return c.json({ error: "job is not eligible for cancellation" }, 409);
  requestAudit(c, {
    actor: "operator",
    action: "job.cancelled",
    resourceType: "job",
    resourceId: c.req.param("id"),
    metadata: { reason: body.reason?.slice(0, 500) ?? null },
  });
  return c.json({ ok: true, id: c.req.param("id"), status: "cancelled" });
});

/** SDK registry signals (live or local stub) */
app.get("/feeds/sdk-signals", async (c) => {
  const localOnly = c.req.query("local") !== "0";
  const signals = await probeKnownSdks({ localOnly });
  return c.json({ signals, localOnly });
});

// ─── Devin-style API bug agent ───────────────────────────────────────────────

app.get("/agent/runs", (c) =>
  c.json(
    listAgentRuns(db, 40, requestTenantId(c)).map(agentRunToApi),
  ),
);

app.get("/agent/runs/:id", (c) => {
  const r = getAgentRun(db, c.req.param("id"), requestTenantId(c));
  if (!r) return c.json({ error: "not found" }, 404);
  return c.json(agentRunToApi(r));
});

function markWardenCandidateExpired(
  run: Readonly<{ id: string; status: string; result_json: string | null }>,
  tenantId: string,
): void {
  if (run.status !== "candidate_ready" && run.status !== "candidate_approved") return;
  let result: Record<string, unknown> = {};
  try {
    const parsed = run.result_json ? JSON.parse(run.result_json) as unknown : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      result = parsed as Record<string, unknown>;
    }
  } catch {
    result = {};
  }
  const retention = result.retention && typeof result.retention === "object"
    ? result.retention as Record<string, unknown>
    : {};
  const observedAt = nowIso();
  db.raw.prepare(
    `UPDATE agent_runs SET status = 'candidate_expired', result_json = ?, finished_at = ?
     WHERE id = ? AND tenant_id = ? AND status IN ('candidate_ready', 'candidate_approved')`,
  ).run(JSON.stringify({
    ...result,
    retention: { ...retention, expiredAt: observedAt },
    cleanup: { status: "pending", attempts: 0 },
  }), observedAt, run.id, tenantId);
}

app.get("/agent/runs/:id/candidate", async (c) => {
  const run = getAgentRun(db, c.req.param("id"), requestTenantId(c));
  if (!run) return c.json({ error: "not found" }, 404);
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  try {
    return c.json(await readWardenCandidate({
      tenantId: run.tenant_id,
      repoPath: run.repo_path,
      status: run.status,
      resultJson: run.result_json,
    }));
  } catch (error) {
    const code = error instanceof Error ? error.message : "warden_candidate_unavailable";
    if (code === "warden_candidate_expired") {
      markWardenCandidateExpired(run, run.tenant_id);
    }
    const status = code === "warden_candidate_expired" ? 410 :
      code === "warden_candidate_not_ready" ? 409 : 409;
    return c.json({ error: code }, status);
  }
});

app.post("/agent/runs/:id/candidate/review", async (c) => {
  const tenantId = requestTenantId(c);
  const principal = c.get("principal");
  const trustPrincipalId = c.get("trustPrincipalId");
  const trustPrincipal = trustPrincipalId
    ? getPrincipal(db, tenantId, trustPrincipalId)
    : undefined;
  if (!isHumanWardenReviewer(principal, trustPrincipal, tenantId, c.get("apiKeyId"))) {
    return c.json({ error: "human_review_required" }, 403);
  }
  let run = getAgentRun(db, c.req.param("id"), tenantId);
  if (!run) return c.json({ error: "not found" }, 404);
  const body: { decision?: unknown } = await c.req
    .json<{ decision?: unknown }>()
    .catch(() => ({}));
  if (body.decision !== "approve" && body.decision !== "reject") {
    return c.json({ error: "decision must be approve or reject" }, 400);
  }
  // Parsing the body yielded the event loop, so a concurrent review may have
  // moved this run. Re-read current state from the database before deciding to
  // seal; the `AND status = 'candidate_ready'` UPDATE guard remains the final
  // arbiter of the write.
  run = getAgentRun(db, run.id, tenantId);
  if (!run) return c.json({ error: "not found" }, 404);
  const reviewedAt = nowIso();
  const result = run.result_json
    ? (JSON.parse(run.result_json) as Record<string, unknown>)
    : {};
  const priorReview = result.review && typeof result.review === "object"
    ? result.review as Record<string, unknown>
    : null;
  if (
    ["candidate_approved", "candidate_rejected"].includes(run.status) &&
    priorReview?.decision === body.decision
  ) {
    return c.json(agentRunToApi(run));
  }
  if (run.status !== "candidate_ready") {
    return c.json({ error: "candidate is not awaiting review" }, 409);
  }
  let sealedApproval: Readonly<{ path: string; sha256: string; created: boolean }> | null = null;
  if (body.decision === "approve") {
    try {
      sealedApproval = await sealWardenCandidateApproval({
        tenantId: run.tenant_id,
        repoPath: run.repo_path,
        status: run.status,
        resultJson: run.result_json,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "warden_candidate_unavailable";
      if (code === "warden_candidate_expired") {
        markWardenCandidateExpired(run, tenantId);
      }
      return c.json({ error: code }, code === "warden_candidate_expired" ? 410 : 409);
    }
  }
  const status = body.decision === "approve" ? "candidate_approved" : "candidate_rejected";
  const existingArtifacts = result.artifacts && typeof result.artifacts === "object"
    ? result.artifacts as Record<string, unknown>
    : null;
  const reviewedResult = {
    ...result,
    review: {
      decision: body.decision,
      reviewedAt,
      reviewerPrincipalId: principal?.id ?? null,
    },
    ...(sealedApproval
      ? {
        artifacts: {
          ...(existingArtifacts ?? {}),
          approval: { path: sealedApproval.path, sha256: sealedApproval.sha256 },
        },
      }
      : {}),
    ...(body.decision === "reject"
      ? { cleanup: { status: "pending", attempts: 0 } }
      : {}),
  };
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const updated = db.raw.prepare(
      `UPDATE agent_runs
       SET status = ?, result_json = ?, finished_at = ?
       WHERE id = ? AND tenant_id = ? AND status = 'candidate_ready'`,
    ).run(
      status,
      JSON.stringify(reviewedResult),
      reviewedAt,
      run.id,
      tenantId,
    );
    if (Number(updated.changes) !== 1) throw new Error("warden_candidate_review_conflict");
    requestAudit(c, {
      actor: "operator",
      action: body.decision === "approve"
        ? "agent.candidate.approved"
        : "agent.candidate.rejected",
      resourceType: "agent_run",
      resourceId: run.id,
      metadata: {
        decision: body.decision,
        product: "warden",
        reviewerPrincipalId: principal?.id ?? null,
      },
    });
    db.raw.exec("COMMIT");
  } catch (error) {
    db.raw.exec("ROLLBACK");
    // Only delete the sealed artifact when THIS request created it. A concurrent
    // approve that committed first owns a pre-existing content-addressed seal;
    // removing it would destroy the committed approval's evidence.
    if (sealedApproval && sealedApproval.created) {
      try {
        rmSync(sealedApproval.path, { force: true });
      } catch {
        // best effort: avoid leaving an orphan sealed artifact behind
      }
    }
    const code = error instanceof Error ? error.message : "warden_candidate_review_failed";
    return c.json({ error: code }, 409);
  }
  if (body.decision === "reject") {
    try {
      discardWardenCandidate({
        tenantId,
        status: run.status,
        resultJson: run.result_json,
      });
      const artifacts = result.artifacts && typeof result.artifacts === "object"
        ? result.artifacts as Record<string, unknown>
        : null;
      db.raw.prepare(
        `UPDATE agent_runs SET result_json = ?
         WHERE id = ? AND tenant_id = ? AND status = 'candidate_rejected'`,
      ).run(JSON.stringify({
        ...reviewedResult,
        artifacts: artifacts ? {
          sourceDigest: artifacts.sourceDigest ?? null,
          candidateDigest: artifacts.candidateDigest ?? null,
          candidateWorkspace: null,
          candidateManifest: null,
          evidence: null,
        } : null,
        cleanup: { status: "cleaned", attempts: 1, cleanedAt: nowIso() },
      }), run.id, tenantId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "warden_candidate_cleanup_failed";
      db.raw.prepare(
        `UPDATE agent_runs SET result_json = ?
         WHERE id = ? AND tenant_id = ? AND status = 'candidate_rejected'`,
      ).run(JSON.stringify({
        ...reviewedResult,
        cleanup: { status: "pending", attempts: 1, lastError: message, lastAttemptAt: nowIso() },
      }), run.id, tenantId);
      return c.json({
        status,
        cleanup: "pending",
        error: message,
      }, 202);
    }
  }
  return c.json(agentRunToApi(getAgentRun(db, run.id, tenantId)!));
});

/**
 * Run Warden — Mendpoint API debug agent (tool loop).
 * Body: { goal, consumerId, allowedChangedPaths, verifyCommand?, errorLog?, maxSteps?, useLlm? }
 * Every run is queued so the worker can enforce the snapshot and lease boundaries.
 */
app.post("/agent/runs", async (c) => {
  try {
    const parsed = parseWardenRunInput(await c.req.json<unknown>());
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = parsed.value;

    const tenantId = requestTenantId(c);
    const owned = tenantConsumerRepo(body.consumerId, tenantId);
    if (!owned) return c.json({ error: "consumer not found" }, 404);
    const { consumer, repo } = owned;
    const repoPath = repo.local_path;

    const idempotencyKey = c.req.header("idempotency-key")?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) {
      return c.json({ error: "Idempotency-Key header must contain 8 to 128 safe characters" }, 400);
    }
    const identity = createHash("sha256")
      .update(`${tenantId}\n${idempotencyKey}`)
      .digest("hex");
    const jobId = `warden-job-${identity.slice(0, 32)}`;
    const sessionId = `warden-run-${identity.slice(32)}`;
    const payload = {
      goal: body.goal,
      consumerId: consumer.id,
      allowedChangedPaths: body.allowedChangedPaths,
      verifyCommand: body.verifyCommand,
      errorLog: body.errorLog,
      maxSteps: body.maxSteps,
      dryRun: body.dryRun,
      useLlm: body.useLlm ?? process.env.LLM_AGENT === "1",
      allowNetwork: false,
      sessionId,
    };
    const payloadJson = JSON.stringify(payload);
    const createdAt = nowIso();
    db.raw.exec("BEGIN IMMEDIATE");
    try {
      const existing = getJob(db, jobId, tenantId);
      if (existing) {
        if (existing.type !== "agent.run" || existing.payload_json !== payloadJson) {
          db.raw.exec("ROLLBACK");
          return c.json({ error: "idempotency key was already used for a different Warden run" }, 409);
        }
        db.raw.exec("COMMIT");
        return c.json(
          {
            sessionId,
            jobId,
            status: existing.status,
            product: "warden",
            replayed: true,
            message: "The existing Warden run was returned",
          },
          202,
        );
      }
      enqueueJob(db, {
        id: jobId,
        tenantId,
        type: "agent.run",
        payload,
        createdAt,
      });
      insertAgentRun(db, {
        id: sessionId,
        tenantId,
        jobId,
        goal: body.goal,
        repoPath,
        status: "queued",
        ok: false,
        steps: 0,
        filesChanged: [],
        reportMd: null,
        resultJson: JSON.stringify({
          jobId,
          ingressRedactions: body.ingressRedactions,
        }),
        createdAt,
        finishedAt: null,
      });
      requestAudit(c, {
        actor: "agent",
        action: "agent.run.queued",
        resourceType: "agent_run",
        resourceId: sessionId,
        metadata: {
          jobId,
          product: "warden",
          idempotencyFingerprint: identity.slice(0, 12),
        },
      });
      db.raw.exec("COMMIT");
    } catch (error) {
      db.raw.exec("ROLLBACK");
      throw error;
    }
    return c.json(
      {
        sessionId,
        jobId,
        status: "queued",
        product: "warden",
        message: "The recovery worker will process this job",
      },
      202,
    );
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// ─── Agentic repair product layer ────────────────────────────────────────────

app.get("/repair/sessions", (c) =>
  c.json(
    listRepairSessions(db, 40, requestTenantId(c)).map(repairSessionToApi),
  ),
);

app.get("/repair/sessions/:id", (c) => {
  const s = getRepairSession(db, c.req.param("id"), requestTenantId(c));
  if (!s) return c.json({ error: "not found" }, 404);
  return c.json(repairSessionToApi(s));
});

/**
 * Queue bounded repair against a tenant-owned consumer checkout.
 * The worker owns execution so a web timeout cannot orphan a mutation.
 */
app.post("/repair/sessions", async (c) => {
  try {
    const body = await c.req.json<{
      consumerId?: string;
      renameMap?: Record<string, string>;
      maxAttempts?: number;
      dryRun?: boolean;
      useLlm?: boolean;
    }>();

    const tenantId = requestTenantId(c);
    if (!body.consumerId) {
      return c.json({ error: "consumerId required" }, 400);
    }
    const owned = tenantConsumerRepo(body.consumerId, tenantId);
    if (!owned) return c.json({ error: "consumer not found" }, 404);
    const { consumer, repo } = owned;
    const repoPath = repo.local_path;
    const consumerId = consumer.id;

    const sessionId = newId();
    const jobId = newId();
    const started = nowIso();
    enqueueJob(db, {
      id: jobId,
      tenantId,
      type: "repair.run",
      payload: {
        sessionId,
        consumerId,
        renameMap: body.renameMap,
        maxAttempts: Math.max(1, Math.min(body.maxAttempts ?? 3, 5)),
        dryRun: body.dryRun === true,
        useLlm: body.useLlm ?? process.env.LLM_REPAIR === "1",
      },
      maxAttempts: 5,
      createdAt: started,
    });
    insertRepairSession(db, {
      id: sessionId,
      tenantId,
      consumerId,
      repoPath,
      status: "queued",
      attempts: 0,
      editsCount: 0,
      ok: false,
      reportMd: null,
      resultJson: JSON.stringify({ jobId }),
      createdAt: started,
      finishedAt: null,
    });

    requestAudit(c, {
      actor: "repair",
      action: "repair.session.queued",
      resourceType: "repair_session",
      resourceId: sessionId,
      metadata: {
        jobId,
        consumerId,
      },
    });

    return c.json(
      {
        sessionId,
        jobId,
        status: "queued",
        message: "Repair queued for bounded verified execution",
      },
      202,
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
app.get("/billing/config", (c) => c.json({
  manualPlanChangesEnabled: process.env.MENDPOINT_MANUAL_PLAN_CHANGES_ENABLED === "1",
  externalCollection: "disabled",
}));

app.get("/billing/usage", (c) => {
  const tenantId = requestTenantId(c);
  const at = c.req.query("at") ?? nowIso();
  try {
    return c.json({
      summary: getUsageSummary(db, tenantId, at),
      entries: listUsageLedger(db, tenantId, 200),
      reconciliation: reconcileUsageLedger(db, tenantId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "usage_query_failed";
    return c.json({ error: message }, 400);
  }
});

app.post("/billing/price-versions", async (c) => {
  const body = await c.req.json<{
    id?: string;
    currency?: string;
    pricePerMcuMoneyMicros?: number;
    effectiveAt?: string;
    expiresAt?: string | null;
    contractReference?: string;
  }>().catch(() => ({} as {
    id?: string;
    currency?: string;
    pricePerMcuMoneyMicros?: number;
    effectiveAt?: string;
    expiresAt?: string | null;
    contractReference?: string;
  }));
  try {
    const price = createUsagePriceVersion(db, {
      id: body.id ?? "",
      tenantId: requestTenantId(c),
      formulaVersion: MCU_VERSION,
      currency: body.currency ?? "",
      pricePerMcuMoneyMicros: body.pricePerMcuMoneyMicros ?? -1,
      effectiveAt: body.effectiveAt ?? "",
      expiresAt: body.expiresAt,
      contractReference: body.contractReference ?? "",
      createdAt: nowIso(),
    });
    requestAudit(c, {
      actor: c.get("principal")!.id,
      action: "billing.price_version_created",
      resourceType: "usage_price_version",
      resourceId: price.id,
      metadata: { formulaVersion: price.formulaVersion, currency: price.currency },
    });
    return c.json(price, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "usage_price_failed";
    return c.json({ error: message }, message.endsWith("_conflict") ? 409 : 400);
  }
});

app.post("/billing/entitlements", async (c) => {
  const body = await c.req.json<{
    id?: string;
    priceVersionId?: string;
    quotaMcuMicros?: number;
    features?: string[];
    contractReference?: string;
    periodStart?: string;
    periodEnd?: string;
  }>().catch(() => ({} as {
    id?: string;
    priceVersionId?: string;
    quotaMcuMicros?: number;
    features?: string[];
    contractReference?: string;
    periodStart?: string;
    periodEnd?: string;
  }));
  try {
    const entitlement = createUsageEntitlement(db, {
      id: body.id ?? "",
      tenantId: requestTenantId(c),
      priceVersionId: body.priceVersionId ?? "",
      quotaMcuMicros: body.quotaMcuMicros ?? -1,
      features: body.features ?? [],
      contractReference: body.contractReference ?? "",
      periodStart: body.periodStart ?? "",
      periodEnd: body.periodEnd ?? "",
      createdAt: nowIso(),
    });
    requestAudit(c, {
      actor: c.get("principal")!.id,
      action: "billing.entitlement_created",
      resourceType: "usage_entitlement",
      resourceId: entitlement.id,
      metadata: { version: entitlement.version, quotaMcuMicros: entitlement.quotaMcuMicros },
    });
    return c.json(entitlement, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "usage_entitlement_failed";
    return c.json({ error: message }, message.endsWith("_conflict") ? 409 : 400);
  }
});

app.post("/billing/usage/reservations", async (c) => {
  const body = await c.req.json<{
    idempotencyKey?: string;
    taskId?: string;
    campaignId?: string | null;
    mcuMicros?: number;
    reason?: string;
  }>().catch(() => ({} as {
    idempotencyKey?: string;
    taskId?: string;
    campaignId?: string | null;
    mcuMicros?: number;
    reason?: string;
  }));
  try {
    const entry = reserveUsage(db, {
      id: newId(),
      tenantId: requestTenantId(c),
      idempotencyKey: body.idempotencyKey ?? "",
      taskId: body.taskId ?? "",
      campaignId: body.campaignId,
      mcuMicros: body.mcuMicros ?? -1,
      reason: body.reason ?? "",
      actorPrincipalId: c.get("trustPrincipalId"),
      createdAt: nowIso(),
    });
    requestAudit(c, {
      actor: c.get("principal")!.id,
      action: "billing.usage_reserved",
      resourceType: "usage_ledger_entry",
      resourceId: entry.id,
      metadata: { taskId: entry.taskId, mcuMicros: entry.reservedMcuMicrosDelta },
    });
    return c.json(entry, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "usage_reservation_failed";
    return c.json(
      { error: message },
      message.includes("conflict") || message.includes("quota") || message.includes("required")
        ? 409
        : 400,
    );
  }
});

app.post("/billing/usage/reservations/:id/settle", async (c) => {
  const body = await c.req.json<{
    idempotencyKey?: string;
    actualMcuMicros?: number;
    invoiceReference?: string | null;
    reason?: string;
  }>().catch(() => ({} as {
    idempotencyKey?: string;
    actualMcuMicros?: number;
    invoiceReference?: string | null;
    reason?: string;
  }));
  try {
    const entry = settleUsageReservation(db, {
      id: newId(),
      tenantId: requestTenantId(c),
      idempotencyKey: body.idempotencyKey ?? "",
      reservationId: c.req.param("id"),
      actualMcuMicros: body.actualMcuMicros ?? -1,
      invoiceReference: body.invoiceReference,
      reason: body.reason ?? "",
      actorPrincipalId: c.get("trustPrincipalId"),
      createdAt: nowIso(),
    });
    requestAudit(c, {
      actor: c.get("principal")!.id,
      action: "billing.usage_settled",
      resourceType: "usage_ledger_entry",
      resourceId: entry.id,
      metadata: { reservationId: entry.reservationId, mcuMicros: entry.consumedMcuMicrosDelta },
    });
    return c.json(entry, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "usage_settlement_failed";
    return c.json({ error: message }, message.includes("not_found") ? 404 : 409);
  }
});

app.post("/billing/usage/reservations/:id/release", async (c) => {
  const body = await c.req.json<{ idempotencyKey?: string; reason?: string }>()
    .catch(() => ({} as { idempotencyKey?: string; reason?: string }));
  try {
    const entry = releaseUsageReservation(db, {
      id: newId(),
      tenantId: requestTenantId(c),
      idempotencyKey: body.idempotencyKey ?? "",
      reservationId: c.req.param("id"),
      reason: body.reason ?? "",
      actorPrincipalId: c.get("trustPrincipalId"),
      createdAt: nowIso(),
    });
    requestAudit(c, {
      actor: c.get("principal")!.id,
      action: "billing.usage_released",
      resourceType: "usage_ledger_entry",
      resourceId: entry.id,
      metadata: { reservationId: entry.reservationId },
    });
    return c.json(entry, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "usage_release_failed";
    return c.json({ error: message }, message.includes("not_found") ? 404 : 409);
  }
});

app.post("/billing/usage/:kind", async (c) => {
  const kind = c.req.param("kind");
  if (kind !== "adjustments" && kind !== "credits") {
    return c.json({ error: "usage_entry_kind_invalid" }, 404);
  }
  const body = await c.req.json<{
    idempotencyKey?: string;
    taskId?: string;
    campaignId?: string | null;
    mcuMicrosDelta?: number;
    invoiceReference?: string | null;
    reason?: string;
  }>().catch(() => ({} as {
    idempotencyKey?: string;
    taskId?: string;
    campaignId?: string | null;
    mcuMicrosDelta?: number;
    invoiceReference?: string | null;
    reason?: string;
  }));
  try {
    const operation = kind === "credits" ? creditUsage : adjustUsage;
    const entry = operation(db, {
      id: newId(),
      tenantId: requestTenantId(c),
      idempotencyKey: body.idempotencyKey ?? "",
      taskId: body.taskId ?? "",
      campaignId: body.campaignId,
      mcuMicrosDelta: body.mcuMicrosDelta ?? 0,
      invoiceReference: body.invoiceReference,
      reason: body.reason ?? "",
      actorPrincipalId: c.get("trustPrincipalId"),
      createdAt: nowIso(),
    });
    requestAudit(c, {
      actor: c.get("principal")!.id,
      action: `billing.usage_${entry.entryType}`,
      resourceType: "usage_ledger_entry",
      resourceId: entry.id,
      metadata: { taskId: entry.taskId, mcuMicros: entry.consumedMcuMicrosDelta },
    });
    return c.json(entry, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "usage_adjustment_failed";
    return c.json({ error: message }, message.includes("conflict") ? 409 : 400);
  }
});

app.get("/tenants", (c) => {
  const principal = c.get("principal");
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  const tenant = getTenant(db, principal.tenantId);
  return c.json(tenant ? [tenantToApi(tenant)] : []);
});

app.get("/tenants/:idOrSlug", (c) => {
  const principal = c.get("principal");
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  const key = c.req.param("idOrSlug");
  const t = getTenant(db, key) ?? getTenantBySlug(db, key);
  if (!t) return c.json({ error: "not found" }, 404);
  if (t.id !== principal.tenantId) return c.json({ error: "not found" }, 404);
  return c.json(tenantToApi(t));
});

app.post("/tenants", async (c) => {
  const principal = c.get("principal");
  if (!principal) return c.json({ error: "unauthorized" }, 401);
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
  requestAudit(c, {
    actor: "api",
    action: "tenant.created",
    resourceType: "tenant",
    resourceId: id,
    metadata: { slug: body.slug, plan },
  });
  return c.json(tenantToApi(getTenant(db, id)!), 201);
});

app.post("/tenants/:id/plan", async (c) => {
  const principal = c.get("principal");
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  const planDecision = billingPlanChangeDecision(principal.role);
  if (!planDecision.allowed) return c.json({ error: planDecision.error }, planDecision.status);
  const t = getTenant(db, c.req.param("id"));
  if (!t) return c.json({ error: "not found" }, 404);
  if (t.id !== principal.tenantId) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ plan: string }>();
  if (!BILLING_PLANS.some((p) => p.id === body.plan)) {
    return c.json({ error: "invalid plan", plans: BILLING_PLANS.map((p) => p.id) }, 400);
  }
  updateTenantPlan(db, t.id, body.plan);
  requestAudit(c, {
    actor: "api",
    action: "tenant.plan_changed",
    resourceType: "tenant",
    resourceId: t.id,
    metadata: { from: t.plan, to: body.plan, billing: planDecision.mode },
  });
  return c.json(tenantToApi(getTenant(db, t.id)!));
});

// ─── Phase E: GitHub App install wizard ──────────────────────────────────────

app.get("/github/app/config", (c) => c.json(getGitHubAppConfig()));

app.get("/github/app/install-url", (c) => {
  const principal = c.get("principal");
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  const config = getGitHubAppConfig();
  if (!config.installEnabled) {
    return c.json(
      {
        error: "github_app_install_disabled",
        message: config.disabledReason,
      },
      503,
    );
  }
  const state = randomBytes(32).toString("base64url");
  const createdAt = nowIso();
  createGitHubInstallState(db, {
    state,
    tenantId: principal.tenantId,
    principalId: principal.id,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 10 * 60_000).toISOString(),
  });
  const result = buildInstallUrl({ state });
  return c.json(result);
});

app.get("/github/app/installations", (c) =>
  c.json(
    listGitHubInstallations(db, c.get("principal")?.tenantId).map(
      githubInstallationToApi,
    ),
  ),
);

/** Mock install entry (used when GITHUB_APP_ID unset). Real GitHub redirects to callback. */
app.get("/github/app/mock-install", async (c) => {
  const principal = c.get("principal");
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  const config = getGitHubAppConfig();
  if (!config.installEnabled || !config.mockMode) {
    return c.json(
      {
        error: "github_app_install_disabled",
        message: config.disabledReason,
      },
      503,
    );
  }
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
      tenantId: principal.tenantId,
      repositories: [{ owner: login, name: "shop-app" }],
    },
  });
});

app.post("/github/app/callback", async (c) => {
  const principal = c.get("principal");
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  const config = getGitHubAppConfig();
  if (!config.installEnabled) {
    return c.json(
      {
        error: "github_app_install_disabled",
        message: config.disabledReason,
      },
      503,
    );
  }
  const body = await c.req.json<{
    state?: string;
    installationId?: string;
    accountLogin?: string;
    accountType?: "User" | "Organization";
    repositories?: Array<{ owner: string; name: string }>;
    setupAction?: string;
  }>();
  let normalized: ReturnType<typeof normalizeMockInstall>;
  if (config.mockMode) {
    if (
      !body.state ||
      !consumeGitHubInstallState(
        db,
        body.state,
        principal.tenantId,
        principal.id,
        nowIso(),
      )
    ) {
      return c.json({ error: "invalid_or_expired_state" }, 400);
    }
    if (!body.accountLogin) return c.json({ error: "accountLogin required" }, 400);
    normalized = normalizeMockInstall({
      accountLogin: body.accountLogin,
      accountType: body.accountType,
      installationId: body.installationId,
      repositories: body.repositories,
      tenantId: principal.tenantId,
    });
  } else {
    const setupAction = body.setupAction;
    if (
      !body.state ||
      !body.installationId ||
      !/^[1-9][0-9]{0,19}$/.test(body.installationId) ||
      !Number.isSafeInteger(Number(body.installationId)) ||
      (setupAction !== "install" && setupAction !== "update")
    ) {
      return c.json({ error: "invalid_installation_return" }, 400);
    }
    const completion = completeGitHubInstallState(db, {
      state: body.state,
      tenantId: principal.tenantId,
      principalId: principal.id,
      installationId: body.installationId,
      setupAction,
      now: nowIso(),
      requestId: c.get("requestId"),
    });
    if (completion.status === "pending") {
      c.header("Retry-After", "2");
      return c.json({ error: "installation_verification_pending" }, 202);
    }
    if (completion.status === "permissions_incomplete") {
      return c.json({ error: "installation_permissions_incomplete" }, 409);
    }
    if (completion.status === "repository_scope_incomplete") {
      return c.json({ error: "installation_repository_scope_incomplete" }, 409);
    }
    if (completion.status === "invalid") {
      return c.json({ error: "invalid_or_expired_state" }, 400);
    }
    if (!("installation" in completion)) {
      return c.json({ error: "installation_completion_failed" }, 500);
    }
    return c.json(
      {
        ok: true,
        replayed: completion.status === "replayed",
        installation: githubInstallationToApi(completion.installation),
        next: { web: "/install?done=1", repositories: "/consumer" },
      },
      completion.status === "completed" ? 201 : 200,
    );
  }

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
    normalized.repositories,
    normalized.tenantId,
  );

  requestAudit(c, {
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
        listGitHubInstallations(db, principal.tenantId).find((i) => i.id === id)!,
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
const hostname = process.env.API_HOST?.trim() || "0.0.0.0";

const server = serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(releaseBanner());
  console.log(`Mendpoint API listening on http://${hostname}:${port}`);
  console.log(
    `probes: /health /live /ready /version /status · auth=${effectiveAuthMode()} · channel=${RELEASE.channel}`,
  );
});

let shuttingDown = false;

function closeDurableStores() {
  transformerCampaigns.close();
  transformerExecutions.close();
  closeDefaultChangeSourceStore();
}

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[mendpoint] ${signal} — graceful shutdown`);
  try {
    // @hono/node-server Server
    const s = server as { close?: (cb?: () => void) => void };
    if (typeof s.close === "function") {
      s.close(() => {
        closeDurableStores();
        process.exit(0);
      });
      setTimeout(() => {
        closeDurableStores();
        process.exit(0);
      }, 5000).unref();
      return;
    }
  } catch {
    /* */
  }
  closeDurableStores();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
