import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { createHash, randomBytes } from "node:crypto";
import {
  listProviders,
  getProviderBySlug,
  getProviderById,
  listChanges,
  listCapabilityAdoptionOpportunities,
  getChange,
  listConsumers,
  listPrs,
  getPr,
  findPrByGitHubIdentityAndNumber,
  findWardenCandidateDeliveryByPrUrl,
  recordWardenCandidateDeliveryOutcome,
  findAdaptiveDeliveryByPrUrl,
  recordAdaptiveDeliveryOutcome,
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
  provisionEntitlementForPlan,
  releaseRunUsage,
  RUN_USAGE_RESERVATION_KEY,
  RUN_USAGE_RESERVED_MCU_KEY,
  listTenants,
  getTenant,
  getTenantBySlug,
  getPrincipal,
  updateTenantPlan,
  tenantToApi,
  upsertGitHubInstallation,
  listGitHubInstallations,
  getGitHubInstallationByInstallationId,
  createGitHubInstallState,
  consumeGitHubInstallState,
  completeGitHubInstallState,
  recordGitHubWebhookDelivery,
  recordFettlerPrReviewEvent,
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
  getMission,
  getWardenCandidateDeliveryByRun,
  agentRunToApi,
  buildExposureReport,
  listConsumersForProvider,
  listConsumersImpactedByChange,
  registrySummaryMarkdown,
} from "@mendpoint/db";
import { parseAuditExportLimit } from "./audit-export.js";
import { changeDetailBody } from "./change-detail.js";
import {
  detectVendors,
  listCatalog,
  listCatalogFeeds,
  pollAllFeeds,
  probeKnownSdks,
} from "@mendpoint/catalog";
import {
  applyPrFeedback,
  REGAUGE_DEEPSEEK_APPROVED_SCOPE,
  runChangePipeline,
} from "@mendpoint/pipeline";
import {
  withTenantGraphHandle,
  type GraphHandleFailure,
} from "./tenant-graph-request.js";
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
  resolveGitHubInstallationTenant,
  resolveGitHubAccountTenantBinding,
  resolveGitHubTenantAccountBinding,
} from "@mendpoint/github";
import { wakeFettlerReviewFromWebhook } from "./warden-review-webhook.js";
import { dispatchFettlerPrReviewFromWebhook } from "./fettler-pr-review-webhook.js";
import { enqueueDeliveryOutcomeLearning } from "./delivery-outcome-learning-dispatch.js";
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
  assertPublicDocsApiRoutesMounted,
  evaluatePrGates,
  reviewOpenApiDesign,
  securityAttestationPolicyFromEnv,
  type ContractCase,
  type SecurityScanAttestation,
} from "@mendpoint/contract";
import {
  seedMemoryForAgent,
  createMemory,
  memoryForPlanner,
  createVmSandbox,
  vmStatusReport,
  startLiveSandbox,
  evaluateLatencyAlerts,
  canMutateSystemCatalog,
  envelopeKeyProvidersFromEnvironment,
  estimateCost,
  MCU_VERSION,
  selfServeBillingEnabled,
  setAlertPersistPath,
  defaultAlertPath,
} from "@mendpoint/platform";
import {
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
  GraphQuerySchema,
  type GraphLearnDb,
  type GraphTenantScope,
} from "@mendpoint/graph-learn";
import {
  resolveCiHarnessEvidence,
  type CiHarnessEvidence,
} from "./ci-check.js";
import { FeedbackOutcomeSchema, newId, nowIso, resolveRenamedEnv } from "@mendpoint/shared";
import { notifyWardenEvent, pageReadiness } from "@mendpoint/notify";
import {
  parseWardenRunInput,
  resolveWardenUseLlm,
} from "./warden-run-input.js";
import {
  readWardenCandidate,
} from "./warden-candidate.js";
import { registerTransformerAdaptiveReviewRoutes } from "./transformer-adaptive-review.js";
import { registerLegacyBehaviorRoutes } from "./legacy-behavior.js";
import {
  createSelfServeSignupRoutes,
  selfServeSignupEnabled,
} from "./self-serve-signup.js";
import {
  createSelfServeScanRoutes,
  selfServeWardenEnabled,
} from "./self-serve-scan.js";
import {
  createSelfServeConnectRoutes,
  selfServeConnectEnabled,
} from "./repository-connect.js";
import {
  createSelfServeOnboardingRoutes,
  selfServeOnboardingEnabled,
} from "./self-serve-onboarding.js";
import {
  decideCatalogMutation,
  providerVisibleToTenant,
} from "./self-serve-catalog.js";
import { normalizeChange } from "@mendpoint/change-intel";
import {
  createAuthMiddleware,
  createRbacMiddleware,
  effectiveAuthMode,
  type ApiEnv,
} from "./auth.js";
import {
  assertApiEnvOrExit,
  liveness,
  readiness,
  resolveRelease,
  resolveReleaseRevision,
  releaseBanner,
  featureMatrix,
  isProduction,
  flushTelemetry,
  isTelemetryEnabled,
} from "@mendpoint/ops";
import {
  requestIdMiddleware,
  requestBodyLimitMiddleware,
  securityHeadersMiddleware,
  rateLimitMiddleware,
  tenantQuotaMiddleware,
  mutationAdmissionMiddleware,
  corsOrigins,
} from "./production.js";
import { canonicalRepoPath, resolveRepoKey } from "./repo-path.js";
import {
  materializeConnectedRepository,
  createRepositoryCredentialDependencies,
  purgeExpiredSnapshots,
  registerConnectedRepository,
  registerScmConnection,
  revokeConnection,
  scmOverview,
} from "./repository-connections.js";
import {
  registerTransformerControlPlaneRoutes,
} from "./transformer-control-plane.js";
import { registerPlatformCanaryRoutes } from "./platform-canary.js";
import {
  registerTransformerPilotExecutionRoutes,
} from "./transformer-pilot-executions.js";
import { closeDefaultChangeSourceStore } from "./change-sources.js";
import {
  billingPlanChangeDecision,
  selfServePlanChangeDecision,
  monthlyBillingPeriod,
} from "./billing-plan-control.js";
import { admitRunUsage, estimateRunMcuMicros } from "./usage-enforcement.js";
import { registerWardenCandidateReviewRoutes } from "./warden-candidate-review.js";
import { createWardenPilotIntakeRoutes } from "./warden-pilot-intake.js";
import { createWardenCampaignEnrollmentRoutes } from "./warden-campaign-enrollment.js";
import { createOutcomeMetricsRoutes } from "./outcome-metrics-routes.js";
import { createDiagnosticsRoutes } from "./diagnostics-routes.js";
import { createDashboardRoutes } from "./dashboard-routes.js";
import { createLearningConsentRoutes } from "./learning-consent-routes.js";
import { createOrganizationMemoryRoutes } from "./organization-memory-routes.js";
import { createPlatformSandboxRoutes } from "./platform-sandbox.js";
import { createPlatformStateRoutes } from "./platform-state-routes.js";
import {
  createSecretBreakGlassDenialAuditMiddleware,
  createSecretLifecycleRoutes,
} from "./secret-lifecycle-routes.js";
import { secretLifecycleRequestCommitmentFromEnvironment } from "./secret-lifecycle-service.js";
import { createTenantCreationRoutes } from "./tenant-creation-routes.js";
import { createTransformerAttemptCoordinatorRoutes } from "./transformer-attempt-coordinator.js";
import { regaugeProductionBootstrapInputFromEnvironment } from "./regauge-production-bootstrap-runtime.js";
import { drainDedicatedRegaugeAdvisoryOutbox } from "./regauge-verifier-shadow.js";
import { readRegaugeVerifierObservations } from "./regauge-verifier-observations.js";
import { createTransformerDraftRepositoryAuthority } from "./transformer-draft-repository.js";
import { loadTransformerRecipeSnapshot } from "@mendpoint/worker/transformer-snapshot-loader";
import {
  createGraphQLSchemaIngestionRoutes,
  graphqlSchemaIngestionEnabled,
} from "./graphql-schema-ingestion.js";
import {
  advancedAiApplicationsEnabled,
  advancedAiAttestationCryptoFromEnv,
  advancedAiCanaryRuntimeFromEnv,
  advancedAiEvaluationRuntimeFromEnv,
  advancedAiTrainingRuntimeFromEnv,
  createDurableAttestationScopeAuthority,
  createDurablePostTrainedConsentReader,
  createDurablePostTrainedEvidenceAuthority,
  createAdvancedAiApplicationRoutes,
} from "./advanced-ai-applications.js";
import { initializeApiRuntime, synchronousPipelineExecutionAllowed } from "./api-runtime.js";
import {
  internalErrorResponse,
  mappedErrorResponse,
  type PublicErrorRule,
} from "./error-boundary.js";

// Fail fast in production if env invalid
assertApiEnvOrExit();

const durableState = initializeApiRuntime();
const {
  db,
  transformerCampaigns,
  transformerExecutions,
  transformerMissionRoutes,
  changeSourceRoutes,
  billingRoutes,
  designPartnerRoutes,
  pilotSuccessRoutes,
  migrationPrRoutes,
  tenantMembershipRoutes,
  servicePrincipalRoutes,
  identitySessionRoutes,
  scimRoutes,
} = durableState;
const app = new Hono<ApiEnv>();
const startedAt = Date.now();
const envelopeKeyProviders = envelopeKeyProvidersFromEnvironment(
  process.env.MENDPOINT_ENVELOPE_KEY_CATALOG_JSON,
);

function apiReadiness() {
  return readiness({
    dbPing: () => {
      db.raw.prepare("SELECT 1").get();
      return true;
    },
    schemaCheck: () => {
      const quickCheck = db.raw.prepare("PRAGMA quick_check").get() as {
        quick_check?: string;
      };
      if (quickCheck.quick_check !== "ok") return false;
      if (db.raw.prepare("PRAGMA foreign_key_check").all().length > 0) return false;
      const requiredTables = new Set([
        "agent_runs",
        "audit_events",
        "connected_repositories",
        "github_installations",
        "jobs",
        "principals",
        "repository_snapshots",
        "tenants",
        "regauge_adaptive_candidates",
      ]);
      const presentTables = new Set(
        (db.raw
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>).map((row) => row.name),
      );
      if ([...requiredTables].some((table) => !presentTables.has(table))) return false;
      const installationColumns = new Set(
        (db.raw.prepare("PRAGMA table_info(github_installations)").all() as Array<{
          name: string;
        }>).map((row) => row.name),
      );
      return installationColumns.has("account_id");
    },
  });
}

function publicErrorRules(
  status: PublicErrorRule["status"],
  ...internalCodes: readonly string[]
): readonly PublicErrorRule[] {
  return internalCodes.map((internalCode) => ({ internalCode, status }));
}

const SCM_CONNECTION_INPUT_ERRORS = publicErrorRules(
  400,
  "scm_provider_invalid",
  "external_account_id_invalid",
  "github_installation_id_invalid",
  "display_name_invalid",
  "credential_reference_required",
);
const SCM_REPOSITORY_INPUT_ERRORS = [
  ...publicErrorRules(
    400,
    "remote_id_invalid",
    "github_repository_id_invalid",
    "default_branch_invalid",
    "selected_branch_invalid",
    "repository_retention_invalid",
    "repository_owner_invalid",
    "repository_name_invalid",
    "repository_environment_invalid",
    "repo_key_must_be_relative",
    "repo_path_outside_tenant_root",
    "repo_path_not_directory",
  ),
  {
    internalCode: "scm_connection_tenant_mismatch",
    publicCode: "not_found",
    status: 404,
  },
] satisfies readonly PublicErrorRule[];
const SCM_SNAPSHOT_ERRORS = [
  {
    internalCode: "connected_repository_tenant_mismatch",
    publicCode: "not_found",
    status: 404,
  },
  {
    internalCode: "scm_connection_tenant_mismatch",
    publicCode: "not_found",
    status: 404,
  },
  { internalCode: "scm_connection_revoked", status: 409 },
  { internalCode: "github_credential_lifecycle_required", status: 409 },
  { internalCode: "consumer_repository_tenant_mismatch", publicCode: "not_found", status: 404 },
] satisfies readonly PublicErrorRule[];
const REPO_KEY_ERRORS = publicErrorRules(
  400,
  "tenant_id_not_path_safe",
  "repo_key_must_be_relative",
  "repo_path_outside_tenant_root",
  "repo_path_not_directory",
);
const USAGE_ERRORS = [
  ...publicErrorRules(
    400,
    "usage_currency_invalid",
    "usage_price_id_invalid",
    "usage_formula_version_invalid",
    "usage_price_per_mcu_money_micros_invalid",
    "usage_price_effective_at_invalid",
    "usage_price_expires_at_invalid",
    "usage_price_period_invalid",
    "usage_entitlement_id_invalid",
    "usage_quota_mcu_micros_invalid",
    "usage_period_start_invalid",
    "usage_period_end_invalid",
    "usage_price_version_required",
    "usage_period_invalid",
    "usage_contract_reference_mismatch",
    "usage_contract_reference_invalid",
    "usage_price_does_not_cover_entitlement",
    "usage_features_invalid",
    "usage_entry_id_invalid",
    "usage_idempotency_key_invalid",
    "usage_task_id_invalid",
    "usage_price_version_invalid",
    "usage_reason_invalid",
    "usage_campaign_id_invalid",
    "usage_invoice_reference_invalid",
    "usage_created_at_invalid",
    "usage_reserved_delta_invalid",
    "usage_consumed_delta_invalid",
    "usage_reservation_mcu_micros_invalid",
    "usage_settlement_mcu_micros_invalid",
    "usage_adjustment_mcu_micros_invalid",
    "usage_reservation_empty",
    "usage_plan_unknown",
    "usage_plan_seats_invalid",
    "usage_plan_quota_overflow",
  ),
  ...publicErrorRules(
    409,
    "usage_price_id_conflict",
    "usage_entitlement_id_conflict",
    "usage_idempotency_conflict",
    "usage_entitlement_required",
    "usage_quota_exceeded",
    "usage_reservation_closed",
    "usage_settlement_exceeds_reservation",
    "usage_credit_exceeds_consumption",
  ),
  { internalCode: "usage_reservation_not_found", status: 404 },
] satisfies readonly PublicErrorRule[];
const WARDEN_CANDIDATE_ERRORS = [
  ...publicErrorRules(
    409,
    "warden_candidate_path_invalid",
    "warden_candidate_path_escape",
    "warden_candidate_symlink_path",
    "warden_candidate_tenant_root_escape",
    "warden_candidate_artifact_missing",
    "warden_candidate_result_invalid",
    "warden_candidate_expiry_invalid",
    "warden_candidate_binary_file_unsupported",
    "warden_candidate_tree_limit",
    "warden_candidate_file_invalid",
    "warden_candidate_file_too_large",
    "warden_candidate_artifact_escape",
    "warden_candidate_artifact_invalid",
    "warden_candidate_not_ready",
    "warden_candidate_tenant_invalid",
    "warden_candidate_data_root_required",
    "warden_candidate_data_root_invalid",
    "warden_candidate_tenant_root_invalid",
    "warden_candidate_evidence_root_invalid",
    "warden_candidate_workspace_invalid",
    "warden_candidate_workspace_escape",
    "warden_candidate_source_invalid",
    "warden_candidate_changed_paths_invalid",
    "warden_candidate_integrity_failed",
    "warden_candidate_response_too_large",
  ),
  { internalCode: "warden_candidate_expired", status: 410 },
] satisfies readonly PublicErrorRule[];

app.onError((error, c) => internalErrorResponse(c, error));

function requestAudit(
  c: Context<ApiEnv>,
  input: Omit<Parameters<typeof recordAudit>[1], "tenantId" | "principalId" | "apiKeyId" | "requestId">,
) {
  const principal = c.get("principal");
  if (!principal) throw new Error("authenticated_principal_required");
  recordAudit(db, {
    ...input,
    tenantId: principal.tenantId,
    principalId: c.get("trustPrincipalId") ?? principal.id,
    apiKeyId: c.get("apiKeyId") ?? null,
    requestId: c.get("requestId") ?? null,
  });
}

function requestTenantId(c: Context<ApiEnv>): string {
  const principal = c.get("principal");
  if (!principal) throw new Error("authenticated_principal_required");
  // A blank tenantId (e.g. an empty x-tenant-id header parsed into a principal) must
  // never reach a tenant-scoped query, where the fail-open branch would drop the filter
  // and read across tenants. Fail closed instead.
  if (principal.tenantId.trim() === "") throw new Error("tenant_scope_required");
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

function catalogAuthorityDeniedResponse(c: Context<ApiEnv>) {
  return c.json(
    {
      error: "catalog_authority_required",
      message: "Shared provider catalog changes require system administrator authority",
    },
    403,
  );
}

/**
 * Authorize a provider-catalog mutation and resolve the tenant scope to stamp on it.
 *
 * Returns `{ deny }` (a 403 Response) when unauthorized, otherwise `{ tenantScope }` where a
 * null scope means the shared system catalog and a non-null scope is the owning tenant of a
 * self-serve tenant-private provider (S1.1, MENDPOINT_SELF_SERVE_WARDEN). Pass the resolved
 * provider for mutations of an existing provider; omit it when creating a new one. With the
 * flag off this collapses to the legacy catalogMutationDenied behavior (shared / system-admin
 * only), so existing shared-catalog semantics are byte-identical.
 */
function catalogMutationScope(
  c: Context<ApiEnv>,
  provider?: { tenant_id?: string | null },
): { deny: Response } | { tenantScope: string | null } {
  const decision = decideCatalogMutation({
    authEnforced: effectiveAuthMode() !== "off",
    principal: c.get("principal"),
    provider,
    selfServeEnabled: selfServeWardenEnabled(),
  });
  if (!decision.allowed) return { deny: catalogAuthorityDeniedResponse(c) };
  return { tenantScope: decision.tenantScope };
}

/**
 * Optional tenant scope for provider-catalog READS. `undefined` under auth-off (open/global
 * read, unchanged legacy behavior); the authenticated tenant otherwise (requestTenantId fails
 * closed on a blank tenant, so a tenant-private provider is never leaked). Feeds the shared+own
 * filter on listProviders / listChanges and the provider visibility guards.
 */
function catalogReadTenantId(c: Context<ApiEnv>): string | undefined {
  if (effectiveAuthMode() === "off") return undefined;
  return requestTenantId(c);
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

function graphHandleUnavailable(c: Context<ApiEnv>, failure: GraphHandleFailure) {
  return c.json(failure, 503);
}

function withRequestGraphHandle<T>(
  c: Context<ApiEnv>,
  fn: (graphDb: GraphLearnDb) => T,
  opts?: { allowEmpty?: boolean },
) {
  return withTenantGraphHandle(
    {
      ...requestGraphTenantScope(c),
      allowEmpty: opts?.allowEmpty,
    },
    fn,
  );
}

function repositoryCredentialDependencies(c: Context<ApiEnv>) {
  const principal = c.get("principal");
  if (!principal) throw new Error("authenticated_principal_required");
  return createRepositoryCredentialDependencies(db, {
    tenantId: principal.tenantId,
    actorId: principal.id,
    requestId: c.get("requestId") ?? undefined,
    keyProviders: envelopeKeyProviders,
    credentialAudit: (event) =>
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
    envelopeAudit: (event) =>
      requestAudit(c, {
        actor: "system",
        action: `secret.envelope.${event.operation}.${event.outcome}`,
        resourceType: "scm_credential",
        resourceId: event.secretId,
        metadata: {
          purpose: event.purpose,
          reason: event.reason,
          keyProvider: event.key.provider,
          keyId: event.key.keyId,
          keyVersion: event.key.version,
          customerManaged: event.key.customerManaged,
        },
      }),
  });
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
app.use("*", requestBodyLimitMiddleware());
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
        `internal_error:${c.get("requestId")}`,
      );
    }
    return internalErrorResponse(c, e);
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
app.use("*", mutationAdmissionMiddleware());
app.use("*", createSecretBreakGlassDenialAuditMiddleware({ db }));
app.use("*", createAuthMiddleware(db));
app.use("*", rateLimitMiddleware({ identity: "principal" }));

/** RBAC identity comes from the authenticated API key in protected modes. */
app.use("*", createRbacMiddleware());

// Per-tenant quota runs after the principal (API key, OIDC, or header-parsed) is resolved,
// so it can budget by tenant. Disabled by default; see tenantQuotaMiddleware.
app.use("*", tenantQuotaMiddleware());

app.route("/graphql/schemas", createGraphQLSchemaIngestionRoutes({
  db,
  enabled: graphqlSchemaIngestionEnabled(process.env),
}));
app.route("/platform/secrets", createSecretLifecycleRoutes({
  db,
  providers: envelopeKeyProviders,
  breakGlassEnabled: process.env.MENDPOINT_SECRET_BREAK_GLASS === "true",
  requestCommitment: secretLifecycleRequestCommitmentFromEnvironment(process.env),
}));
app.route("/advanced-ai", createAdvancedAiApplicationRoutes({
  db,
  enabled: advancedAiApplicationsEnabled(process.env),
  ...advancedAiAttestationCryptoFromEnv(process.env),
  ...advancedAiTrainingRuntimeFromEnv(db, process.env),
  ...advancedAiEvaluationRuntimeFromEnv(db, process.env),
  ...advancedAiCanaryRuntimeFromEnv(db, process.env),
  authorizeAttestationScope: createDurableAttestationScopeAuthority(),
  readConsent: createDurablePostTrainedConsentReader(db),
  verifyEvidence: createDurablePostTrainedEvidenceAuthority(db),
  authorizeHumanApprover: (tenantId, principalId) => Boolean(db.raw.prepare("SELECT 1 FROM principals WHERE tenant_id = ? AND id = ? AND kind = 'human' AND revoked_at IS NULL").get(tenantId, principalId)),
}));

registerTransformerControlPlaneRoutes(app, transformerCampaigns, {}, requestAudit, db);
registerTransformerPilotExecutionRoutes(app, transformerExecutions, requestAudit);
// Canonical (Regauge) mounts plus their legacy /transformer aliases; both point
// at the same route instance, so external/legacy callers keep working forever.
app.route("/regauge/missions", transformerMissionRoutes);
app.route("/transformer/missions", transformerMissionRoutes);
const transformerAttemptCoordinatorEnabled =
  resolveRenamedEnv(process.env, "MENDPOINT_REGAUGE_MULTINODE_COORDINATOR_ENABLED") === "1";
const regaugeActivationExpiresAt =
  process.env.MENDPOINT_REGAUGE_ACTIVATION_EXPIRES_AT?.trim() ||
  "1970-01-01T00:00:00.000Z";
const transformerDraftAuthorization = transformerAttemptCoordinatorEnabled
  ? (() => {
      const bootstrap = regaugeProductionBootstrapInputFromEnvironment(process.env);
      return Object.freeze({
        tenantId: bootstrap.tenantId,
        campaignId: bootstrap.campaignId,
        environment: bootstrap.environment,
        remoteRepositoryId: Number(bootstrap.repository.remoteRepositoryId),
        sourceRevision: bootstrap.repository.expectedRevision,
        productionApprovalRef: bootstrap.productionApprovalRef,
        activationExpiresAt: regaugeActivationExpiresAt,
        maximumDrafts: 1 as const,
      });
    })()
  : undefined;
const drainRegaugeAdvisoryOutbox = async (): Promise<void> => {
  if (!transformerDraftAuthorization) return;
  await drainDedicatedRegaugeAdvisoryOutbox({
    db,
    store: transformerExecutions.store,
    env: process.env,
    tenantId: transformerDraftAuthorization.tenantId,
    loadExactSource: (completion) => {
      const unit = completion.campaign.units.find(
        (candidate) => candidate.id === completion.receipt.unitId,
      );
      if (!unit) throw new Error("regauge_verifier_advisory_completion_invalid");
      return loadTransformerRecipeSnapshot(db, {
        tenantId: completion.campaign.tenantId,
        snapshot: unit.snapshot,
        recipe: unit.recipe,
      }, completion.receipt.observedAt);
    },
  });
};
const transformerAttemptCoordinatorRoutes = createTransformerAttemptCoordinatorRoutes({
  enabled: transformerAttemptCoordinatorEnabled,
  store: transformerExecutions.store,
  gateConfig: resolveRenamedEnv(process.env, "MENDPOINT_REGAUGE_GATE"),
  ...(transformerDraftAuthorization ? { draftAuthorization: transformerDraftAuthorization } : {}),
  verifierAdvisoryScope: {
    tenantId: REGAUGE_DEEPSEEK_APPROVED_SCOPE.tenantId,
    campaignId: REGAUGE_DEEPSEEK_APPROVED_SCOPE.campaignId,
  },
  observeCompletedAttempt: async () => drainRegaugeAdvisoryOutbox(),
  drainPendingCompletedAttempts: drainRegaugeAdvisoryOutbox,
  readVerifierObservations: ({ tenantId, campaignId }) =>
    readRegaugeVerifierObservations(db, { tenantId, campaignId }),
  loadExactSource: (lease, observedAt) => loadTransformerRecipeSnapshot(db, lease, observedAt),
  resolveDraftRepository: createTransformerDraftRepositoryAuthority(db, process.env),
});
app.route("/v1/regauge/attempt-coordinator", transformerAttemptCoordinatorRoutes);
app.route("/v1/transformer/attempt-coordinator", transformerAttemptCoordinatorRoutes);
app.route("/auth/signup", createSelfServeSignupRoutes({
  db,
  enabled: selfServeSignupEnabled(process.env),
}));
app.route("/self-serve/connect", createSelfServeConnectRoutes({
  db,
  enabled: selfServeConnectEnabled(process.env),
}));
app.route("/self-serve/scan", createSelfServeScanRoutes({
  db,
  enabled: selfServeWardenEnabled(process.env),
}));
app.route("/self-serve/onboarding", createSelfServeOnboardingRoutes({
  db,
  enabled: selfServeOnboardingEnabled(process.env),
}));
app.route("/change-sources", changeSourceRoutes);
app.route("/billing", billingRoutes);
app.route("/design-partner-applications", designPartnerRoutes);
app.route("/pilot-success-contracts", pilotSuccessRoutes);
app.route("/prs", migrationPrRoutes);
app.route("/tenants/memberships", tenantMembershipRoutes);
app.route("/tenants/service-principals", servicePrincipalRoutes);
app.route("/auth/sessions", identitySessionRoutes);
app.route("/scim/v2", scimRoutes);
const wardenPilotIntakeRoutes = createWardenPilotIntakeRoutes({ db });
app.route("/fettler/pilot", wardenPilotIntakeRoutes);
app.route("/warden/pilot", wardenPilotIntakeRoutes);
const wardenCampaignEnrollmentRoutes = createWardenCampaignEnrollmentRoutes({ db });
app.route("/fettler/campaigns", wardenCampaignEnrollmentRoutes);
app.route("/warden/campaigns", wardenCampaignEnrollmentRoutes);
app.route("/metrics/outcomes", createOutcomeMetricsRoutes({ db }));
app.route("/diagnostics", createDiagnosticsRoutes({ db }));
app.route("/metrics/dashboard", createDashboardRoutes({ db }));
app.route("/platform/sandbox", createPlatformSandboxRoutes());
app.route("/learning", createLearningConsentRoutes({ db }));
app.route("/organization-memory", createOrganizationMemoryRoutes({ db }));

// Persist alerts under data/
try {
  setAlertPersistPath(defaultAlertPath(process.cwd()));
} catch {
  /* */
}

app.get("/health", (c) => {
  const release = resolveRelease();
  return c.json({
    ok: true,
    service: "mendpoint-api",
    product: release.product,
    platform: release.platform,
    version: release.version,
    channel: release.channel,
    banner: releaseBanner(),
    auth: effectiveAuthMode(),
    graphNative: true,
    rbac: true,
    production: isProduction(),
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  });
});

/** Kubernetes-style probes */
app.get("/live", (c) => c.json(liveness()));

app.get("/ready", (c) => {
  const r = apiReadiness();
  // Best-effort page when readiness is failing. Fire-and-forget so a paging
  // outage can never delay or break the probe response; no-op when the probe is
  // healthy or no paging sink is configured. Fly polls /ready, so this is the
  // unattended trigger a `readiness_fail` page needs.
  void pageReadiness(r).catch(() => undefined);
  return c.json(r, r.status === "fail" ? 503 : 200);
});

app.get("/version", (c) => {
  const release = resolveRelease();
  return c.json({
    ...release,
    revision: resolveReleaseRevision(),
    banner: releaseBanner(),
    features: featureMatrix(),
  });
});

app.get("/status", (c) => {
  const r = apiReadiness();
  const release = resolveRelease();
  return c.json({
    ...r,
    ga: {
      version: release.version,
      channel: release.channel,
      gaFeatures: release.gaFeatures,
      experimental: release.experimentalFeatures,
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
      tenantId: requestTenantId(c),
      includeApiGraph: includeApi,
    });
    if (!g) return c.json({ error: "change not found" }, 404);
    c.header("Cache-Control", "private, max-age=10");
    return c.json(g);
  } catch (e) {
    return internalErrorResponse(c, e);
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
      tenantId: requestTenantId(c),
      includeApiGraph: true,
    });
    if (!g) return c.json({ error: "change not found" }, 404);
    c.header("Cache-Control", "private, max-age=10");
    return c.json(g);
  } catch (e) {
    return internalErrorResponse(c, e);
  }
});

// ─── Warden matrix P0: plans, contracts, registry, transformer scaffold ──────

// Canonical (Fettler) paths plus the legacy /warden aliases (kept forever for
// external/legacy callers). Both register the same handlers.
const registerFettlerMatrixRoutes = (base: string): void => {
/** Spec-first plan-of-record from provider OpenAPI pair */
app.post(`${base}/plans/from-spec`, async (c) => {
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
      requestTenantId(c),
    );
    return c.json({
      plan,
      markdown: planToMarkdown(plan),
      registry: consumers,
      registryMarkdown: registrySummaryMarkdown(consumers, provider.slug),
    });
  } catch (e) {
    return internalErrorResponse(c, e);
  }
});

/** PR gates: oas-breaking + contract suite + security stub */
app.post(`${base}/gates`, async (c) => {
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
      // A request body is a caller assertion, never a scan this server ran, so
      // it is named as an attestation. `securityScanOk` is still accepted from
      // older clients and mapped to the attested field below.
      securityScanAttested?: boolean;
      /** @deprecated Ambiguous name — clients should send `securityScanAttested`. */
      securityScanOk?: boolean;
      /** Structured, subject-bound attestation from a current client. */
      securityScanAttestation?: SecurityScanAttestation;
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
      securityScanAttested: body.securityScanAttested ?? body.securityScanOk,
      securityScanAttestation: body.securityScanAttestation,
      // The dry-run evaluator reflects the same deployment policy as delivery.
      securityAttestationPolicy: securityAttestationPolicyFromEnv(process.env),
    });
    return c.json(result);
  } catch (e) {
    return internalErrorResponse(c, e);
  }
});

/** Read-only API design critic */
app.post(`${base}/review`, async (c) => {
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
    return internalErrorResponse(c, e);
  }
});
};
registerFettlerMatrixRoutes("/fettler");
registerFettlerMatrixRoutes("/warden");

/** Consumer registry for a provider */
app.get("/registry/providers/:slug/consumers", (c) => {
  const slug = c.req.param("slug");
  const hits = listConsumersForProvider(
    db,
    slug,
    requestTenantId(c),
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
      requestTenantId(c),
    ),
  });
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

/**
 * Canary decision (hooks only — no auto production deploy). Registered via a
 * small registrar so rollback decisions route through the canonical audit sink.
 */
registerPlatformCanaryRoutes(app, requestAudit);

/** Dimension 6 — Graph learning / graph-RAG. Never create an empty sqlite file. */
app.get("/graph-learn/stats", (c) => {
  const opened = withRequestGraphHandle(c, (graphDb) =>
    runGraphQuery(graphDb, { op: "stats" }, requestGraphTenantScope(c)),
  );
  if (!opened.ok) return graphHandleUnavailable(c, opened.failure);
  return c.json({ ...(opened.value.rows?.[0] ?? {}), tools: GRAPH_RAG_TOOLS });
});

app.post("/graph-learn/query", async (c) => {
  try {
    // Validate the untrusted body against a schema instead of casting: a
    // malformed query (missing op, wrong field types) is rejected with 400 here
    // rather than reaching the engine. Oversized traversal bounds are accepted
    // and clamped by the engine, which owns the hard ceilings.
    const parsed = GraphQuerySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "invalid graph query", issues: parsed.error.issues },
        400,
      );
    }
    const opened = withRequestGraphHandle(c, (graphDb) =>
      runGraphQuery(graphDb, parsed.data, requestGraphTenantScope(c)),
    );
    if (!opened.ok) return graphHandleUnavailable(c, opened.failure);
    return c.json({
      ...opened.value,
      markdown: formatQueryForPlanner(opened.value),
    });
  } catch (e) {
    return internalErrorResponse(c, e);
  }
});

/** Graph-RAG v1 natural-language query pick */
app.post("/graph-learn/pick", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { q?: string; run?: boolean };
  if (!body.q) return c.json({ error: "q required" }, 400);
  const pick = pickGraphQuery(body.q);
  if (body.run) {
    const opened = withRequestGraphHandle(c, (graphDb) =>
      runGraphQuery(graphDb, pick.query, requestGraphTenantScope(c)),
    );
    if (!opened.ok) return graphHandleUnavailable(c, opened.failure);
    return c.json({
      pick,
      result: { ...opened.value, markdown: formatQueryForPlanner(opened.value) },
    });
  }
  return c.json({ pick });
});

app.post("/graph-learn/promote-patterns", (c) => {
  const opened = withRequestGraphHandle(c, (graphDb) =>
    promotePatterns(graphDb, {}, requestGraphTenantScope(c)),
  );
  if (!opened.ok) return graphHandleUnavailable(c, opened.failure);
  const promotions = opened.value;
  // Graph-update audit at the mutation entry point (not per node/edge): one
  // event per promotion sweep records who promoted patterns and how many, which
  // is the security- and migration-relevant fact (spec 19.8 graph updates).
  requestAudit(c, {
    actor: "api",
    action: "graph.patterns_promoted",
    resourceType: "graph",
    resourceId: null,
    metadata: { count: promotions.length },
  });
  return c.json({ count: promotions.length, promotions });
});

app.get("/graph-learn/ab", (c) => {
  const opened = withRequestGraphHandle(c, (graphDb) =>
    measureAbLift(graphDb, undefined, requestGraphTenantScope(c)),
  );
  if (!opened.ok) return graphHandleUnavailable(c, opened.failure);
  return c.json({ ...opened.value, markdown: formatAbReport(opened.value) });
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
  const opened = withRequestGraphHandle(
    c,
    (graphDb) =>
      ingestAstRepo(graphDb, {
        repoPath: repo.local_path,
        repoId: `${tenantId}:${consumer.id}`,
        maxFiles: Math.min(Math.max(body.maxFiles ?? 100, 1), 500),
      }),
    { allowEmpty: true },
  );
  if (!opened.ok) return graphHandleUnavailable(c, opened.failure);
  const r = opened.value;
  requestAudit(c, {
    actor: "api",
    action: "graph.updated",
    resourceType: "graph",
    resourceId: consumer.id,
    metadata: { source: "ast", consumerId: consumer.id, files: r.files, symbols: r.symbols, calls: r.calls },
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
  const opened = withRequestGraphHandle(
    c,
    (graphDb) =>
      ingestLspSymbols(graphDb, {
        repoPath: repo.local_path,
        repoId: `${tenantId}:${consumer.id}`,
      }),
    { allowEmpty: true },
  );
  if (!opened.ok) return graphHandleUnavailable(c, opened.failure);
  const r = opened.value;
  requestAudit(c, {
    actor: "api",
    action: "graph.updated",
    resourceType: "graph",
    resourceId: consumer.id,
    metadata: { source: "lsp", consumerId: consumer.id, symbols: r.symbols },
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
  const opened = withRequestGraphHandle(
    c,
    (graphDb) =>
      incrementalReingest(graphDb, {
        repoPath: repo.local_path,
        repoId: `${tenantId}:${consumer.id}`,
        maxFiles: 150,
      }),
    { allowEmpty: true },
  );
  if (!opened.ok) return graphHandleUnavailable(c, opened.failure);
  const r = opened.value;
  requestAudit(c, {
    actor: "api",
    action: "graph.updated",
    resourceType: "graph",
    resourceId: consumer.id,
    metadata: {
      source: "incremental",
      consumerId: consumer.id,
      changed: r.changed.length,
      removed: r.removed.length,
      unchanged: r.unchanged,
      fullRebuild: r.fullRebuild,
    },
  });
  return c.json(r);
});

app.get("/graph-learn/gnn-export", (c) => {
  const opened = withRequestGraphHandle(c, (graphDb) =>
    exportGnnFeatures(graphDb, requestGraphTenantScope(c)),
  );
  if (!opened.ok) return graphHandleUnavailable(c, opened.failure);
  const exp = opened.value;
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
    tenantId: requestTenantId(c),
  });
  return c.json(check);
});

app.post("/graph-learn/embed", (c) => {
  const opened = withRequestGraphHandle(c, (graphDb) =>
    embedGraphNodes(graphDb, undefined, requestGraphTenantScope(c)),
  );
  if (!opened.ok) return graphHandleUnavailable(c, opened.failure);
  return c.json(opened.value);
});

app.get("/graph-learn/kuzu", (c) => {
  const status = kuzuStatus();
  const opened = withRequestGraphHandle(c, (graphDb) =>
    exportSqliteToKuzuScript(graphDb, { maxNodes: 100 }, requestGraphTenantScope(c)),
  );
  if (!opened.ok) return graphHandleUnavailable(c, opened.failure);
  const script = opened.value;
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
  // The build-cache identity is bound to the authenticated tenant, never trusted
  // from the body. A body cacheKey is only a sub-key within that tenant's scope,
  // so one tenant can never hit, seed, or probe another tenant's cached root by
  // replaying its cacheKey.
  const tenantId = requestTenantId(c);
  const backend = body.backend ?? "local";
  const files = { "README": "vm sandbox\n" };
  const sbx =
    body.cacheKey !== undefined
      ? createVmSandbox({ backend, cacheKey: body.cacheKey, tenantId, files })
      : createVmSandbox({ backend, tenantId, files });
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
    return mappedErrorResponse(c, error, SCM_CONNECTION_INPUT_ERRORS);
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
    return mappedErrorResponse(c, error, SCM_REPOSITORY_INPUT_ERRORS);
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
    return mappedErrorResponse(c, error, SCM_SNAPSHOT_ERRORS);
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
    return mappedErrorResponse(c, error, [
      {
        internalCode: "scm_connection_tenant_mismatch",
        publicCode: "not_found",
        status: 404,
      },
    ]);
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

app.route("/platform", createPlatformStateRoutes());

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
      buildProductKnowledgeGraph(db, f, requestTenantId(c)),
    );
  } catch (e) {
    return internalErrorResponse(c, e);
  }
});

app.get("/graph/api/:providerSlug", (c) => {
  try {
    const provider = getProviderBySlug(db, c.req.param("providerSlug"));
    // Isolation: a tenant-private provider's API graph is 404 for anyone but its owner.
    if (
      !provider ||
      !providerVisibleToTenant(provider, catalogReadTenantId(c))
    ) {
      return c.json({ error: "provider not found" }, 404);
    }
    const g = buildProviderApiGraph(db, provider.slug);
    if (!g) return c.json({ error: "provider not found" }, 404);
    c.header("Cache-Control", "private, max-age=15");
    return c.json(g);
  } catch (e) {
    return internalErrorResponse(c, e);
  }
});


app.get("/providers", (c) => {
  const limit = requestListLimit(c);
  const offset = requestListOffset(c);
  // Shared catalog + this tenant's own private providers (S1.1); never another tenant's.
  return pagedJson(
    c,
    listProviders(db, limit, offset, catalogReadTenantId(c)).map(providerToApi),
    limit,
    offset,
  );
});

app.get("/providers/:slug", (c) => {
  const p = getProviderBySlug(db, c.req.param("slug"));
  // Isolation: a tenant-private provider is 404 for anyone but its owning tenant.
  if (!p || !providerVisibleToTenant(p, catalogReadTenantId(c))) {
    return c.json({ error: "not found" }, 404);
  }
  const versions = listVersionsForProvider(db, p.id).map(versionToApi);
  return c.json({ ...providerToApi(p), versions });
});

// Read-only: capability-adoption opportunities (NEW capabilities linked consumers
// are not yet using), tenant-scoped for this provider.
app.get("/providers/:slug/capability-opportunities", (c) => {
  const p = getProviderBySlug(db, c.req.param("slug"));
  if (!p || !providerVisibleToTenant(p, catalogReadTenantId(c))) {
    return c.json({ error: "not found" }, 404);
  }
  const opportunities = listCapabilityAdoptionOpportunities(db, requestTenantId(c), {
    providerSlug: p.slug,
  });
  return c.json({ opportunities });
});

app.post("/providers", async (c) => {
  // A new provider has no owner yet: a shared-catalog create needs system-admin authority,
  // while a self-serve tenant admin (flag on) creates a provider private to their tenant.
  const scope = catalogMutationScope(c);
  if ("deny" in scope) return scope.deny;
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
    tenantId: scope.tenantScope,
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
  const p = getProviderBySlug(db, c.req.param("slug"));
  const scope = catalogMutationScope(c, p);
  if ("deny" in scope) return scope.deny;
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
  const scope = catalogMutationScope(c, p);
  if ("deny" in scope) return scope.deny;
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
  if (!synchronousPipelineExecutionAllowed()) {
    return c.json({ error: "synchronous_pipeline_execution_disabled" }, 503);
  }
  const provider = getProviderBySlug(db, c.req.param("slug"));
  const scope = catalogMutationScope(c, provider);
  if ("deny" in scope) return scope.deny;
  try {
    const body = await c.req
      .json<{
        severity?: "required" | "recommended" | "optional";
        notificationsOnly?: boolean;
        mode?: "migrate" | "adopt";
        contractCases?: ContractCase[];
        securityScanAttested?: boolean;
        /** @deprecated Ambiguous name — send `securityScanAttested`. */
        securityScanOk?: boolean;
        securityScanAttestation?: SecurityScanAttestation;
      }>()
      .catch(() => (
        {} as {
          severity?: never;
          notificationsOnly?: boolean;
          mode?: never;
          contractCases?: ContractCase[];
          securityScanAttested?: boolean;
          securityScanOk?: boolean;
          securityScanAttestation?: SecurityScanAttestation;
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
      securityScanAttested: body.securityScanAttested ?? body.securityScanOk,
      securityScanAttestation: body.securityScanAttestation,
    });
    invalidateGraphCaches();
    void notifyWardenEvent(
      "warden_finished",
      `${c.req.param("slug")} change ${report.changeId} risk=${report.risk}`,
    ).catch(() => undefined);
    return c.json(report, 201);
  } catch (e) {
    return internalErrorResponse(c, e);
  }
});

/** Phase C: upload OpenAPI version and optionally publish (run pipeline) in one step */
app.post("/providers/:slug/publish-version", async (c) => {
  const p = getProviderBySlug(db, c.req.param("slug"));
  const scope = catalogMutationScope(c, p);
  if ("deny" in scope) return scope.deny;
  if (!p) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{
    versionLabel: string;
    openapi: unknown;
    changelogMd?: string;
    runPipeline?: boolean;
    contractCases?: ContractCase[];
    securityScanAttested?: boolean;
    /** @deprecated Ambiguous name — send `securityScanAttested`. */
    securityScanOk?: boolean;
    securityScanAttestation?: SecurityScanAttestation;
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
        securityScanAttested: body.securityScanAttested ?? body.securityScanOk,
        securityScanAttestation: body.securityScanAttestation,
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
  // Shared-catalog changes + this tenant's own private-provider changes (S1.1); a
  // tenant-private provider's changes never surface to another tenant.
  return pagedJson(
    c,
    listChanges(db, limit, offset, catalogReadTenantId(c)).map(changeToApi),
    limit,
    offset,
  );
});

app.get("/changes/:id", (c) => {
  // Shared-catalog contract: the change row and its diff come from `api_changes`, a shared
  // provider / API-change catalog that is tenant-agnostic BY DESIGN (see getChange). Only
  // public provider spec data is exposed here. Everything tenant-private — impact findings
  // and migration PRs — is read through tenant-scoped accessors so tenant A can never see
  // tenant B's findings or PRs on the same shared change.
  const change = getChange(db, c.req.param("id"));
  if (!change) return c.json({ error: "not found" }, 404);
  // Isolation (S1.1): a change on a tenant-private provider is 404 for anyone but its owner.
  const changeProvider = getProviderById(db, change.provider_id);
  if (
    changeProvider &&
    !providerVisibleToTenant(changeProvider, catalogReadTenantId(c))
  ) {
    return c.json({ error: "not found" }, 404);
  }
  const tenantId = requestTenantId(c);
  return c.json(changeDetailBody(db, tenantId, change));
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
    return mappedErrorResponse(c, error, REPO_KEY_ERRORS);
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
    requestTenantId(c),
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
    requestTenantId(c),
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
  if ((body.runPipeline ?? true) && !synchronousPipelineExecutionAllowed()) {
    return c.json({ error: "synchronous_pipeline_execution_disabled" }, 503);
  }
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
    !getConsumer(db, consumerId, requestTenantId(c))
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
  const pr = getPr(db, c.req.param("id"), requestTenantId(c));
  if (!pr) return c.json({ error: "not found" }, 404);
  return c.json(prToApi(pr));
});

app.post("/prs/:id/feedback", async (c) => {
  const tenantId = requestTenantId(c);
  const pr = getPr(db, c.req.param("id"), tenantId);
  if (!pr) return c.json({ error: "not found" }, 404);
  const body = await c.req.json();
  const parsed = FeedbackOutcomeSchema.safeParse(body.outcome);
  if (!parsed.success) return c.json({ error: "invalid outcome" }, 400);
  await applyPrFeedback(db, pr.id, parsed.data, {
    tenantId,
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
  const tenantId = requestTenantId(c);
  const pr = getPr(db, c.req.param("id"), tenantId);
  if (!pr) return c.json({ error: "not found" }, 404);
  const consumer = getConsumer(db, pr.consumer_id, tenantId);
  if (!consumer) return c.json({ error: "consumer missing" }, 400);
  const findings = listFindingsForChange(db, pr.change_id, tenantId);
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
    authorityPrincipalId: c.get("authorityPrincipalId"),
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
    if (
      !Number.isSafeInteger(event.installationId) ||
      event.installationId < 1 ||
      !Number.isSafeInteger(event.accountId) ||
      Number(event.accountId) < 1 ||
      !event.accountLogin
    ) {
      return c.json({ error: "github_installation_stable_identity_required" }, 400);
    }
    const installationId = String(event.installationId);
    const accountId = String(event.accountId);
    const existing = getGitHubInstallationByInstallationId(db, installationId);
    const configuredTenantId = resolveGitHubAccountTenantBinding(accountId);
    if (configuredTenantId && !getTenant(db, configuredTenantId)) {
      return c.json({ error: "github_owner_binding_tenant_not_found" }, 503);
    }
    let tenantId: string | undefined;
    try {
      tenantId = resolveGitHubInstallationTenant({
        accountId,
        ...(configuredTenantId ? { configuredTenantId } : {}),
        ...(existing
          ? { existing: { accountId: existing.account_id, tenantId: existing.tenant_id } }
          : {}),
      });
    } catch (error) {
      return mappedErrorResponse(c, error, publicErrorRules(
        409,
        "github_installation_account_identity_mismatch",
        "github_installation_tenant_identity_mismatch",
      ));
    }
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
          accountId,
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
          accountId,
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
        accountId,
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
          metadata: { delivery: wh.delivery, accountId },
        });
      }
    }
    return c.json({ ok: true, type: "installation", installationId: event.installationId });
  }

  if (event.type === "pull_request_review") {
    if (!wh.delivery) return c.json({ error: "delivery id required" }, 400);
    try {
      const result = wakeFettlerReviewFromWebhook({ db, event, deliveryId: wh.delivery, observedAt: nowIso() });
      recordAudit(db, {
        tenantId: result.cycle?.tenantId ?? "tenant_system_unassigned",
        actor: "github_webhook",
        action: `fettler.review.${event.source}.${event.action}`,
        resourceType: "fettler_ci_cycle",
        resourceId: result.cycle?.id,
        requestId: c.get("requestId"),
        metadata: {
          delivery: wh.delivery,
          repositoryId: event.repositoryId,
          installationId: event.installationId,
          accountId: event.accountId,
          pullRequestNumber: event.pullRequestNumber,
          headSha: event.headSha,
          sourceId: event.sourceId,
          wakeStatus: result.status,
        },
      });
      return c.json({ ok: true, type: event.type, wakeStatus: result.status, cycleId: result.cycle?.id ?? null });
    } catch (error) {
      return mappedErrorResponse(c, error, publicErrorRules(
        409,
        "warden_review_webhook_identity_invalid",
        "warden_review_webhook_installation_not_authorized",
        "warden_review_webhook_repository_not_authorized",
        "warden_ci_review_wake_ambiguous",
      ));
    }
  }

  if (event.type === "pull_request") {
    // A customer opening or updating their own pull request enqueues a Fettler
    // analysis run. This path only ever queues analysis; it never approves,
    // merges, or pushes. The remaining `pull_request` handling below records
    // close/merge feedback on PRs the product itself delivered.
    if (event.action === "opened" || event.action === "synchronize") {
      if (!wh.delivery) return c.json({ error: "delivery id required" }, 400);
      try {
        const result = dispatchFettlerPrReviewFromWebhook({
          db,
          event,
          deliveryId: wh.delivery,
          observedAt: nowIso(),
        });
        const auditTenantId =
          result.status === "enqueued" || result.status === "duplicate"
            ? result.tenantId
            : "tenant_system_unassigned";
        recordAudit(db, {
          tenantId: auditTenantId,
          actor: "github_webhook",
          action: `fettler.pr.${event.action}.${result.status}`,
          resourceType: "fettler_pr_review",
          resourceId:
            result.status === "enqueued" || result.status === "duplicate"
              ? result.dispatchJobId
              : undefined,
          requestId: c.get("requestId"),
          metadata: {
            delivery: wh.delivery,
            repositoryId: event.repositoryId,
            installationId: event.installationId,
            accountId: event.accountId,
            pullRequestNumber: event.number,
            headSha: event.headSha,
            reason: "reason" in result ? result.reason : null,
          },
        });
        if (result.status === "refused") {
          return c.json(
            { ok: false, type: event.type, action: event.action, outcome: "refused", reason: result.reason },
            403,
          );
        }
        if (result.status === "ignored") {
          return c.json({
            ok: true,
            type: event.type,
            action: event.action,
            outcome: "ignored",
            reason: result.reason,
          });
        }
        return c.json(
          {
            ok: true,
            type: event.type,
            action: event.action,
            outcome: result.status,
            dispatchJobId: result.dispatchJobId,
          },
          202,
        );
      } catch (error) {
        // Fail closed: record the failure distinctly from a deliberate ignore,
        // then return 500 so GitHub retries under a fresh delivery id.
        try {
          recordFettlerPrReviewEvent(db, {
            deliveryId: wh.delivery,
            outcome: "failed",
            reason: error instanceof Error ? error.message.slice(0, 200) : "dispatch_failed",
            action: event.action,
            pullRequestNumber: Number.isSafeInteger(event.number) ? event.number : null,
            headSha: event.headSha ?? null,
            installationId: event.installationId ? String(event.installationId) : null,
            remoteRepositoryId: event.repositoryId ? String(event.repositoryId) : null,
            createdAt: nowIso(),
          });
        } catch {
          // The helper already recorded the failure for this delivery id; the
          // INSERT OR IGNORE above is a no-op in that case.
        }
        return internalErrorResponse(c, error);
      }
    }
    const outcome = prFeedbackFromWebhook(event);
    if (!outcome) {
      return c.json({ ok: true, ignored: event.action });
    }
    // Lane 1: the legacy migration_prs path, keyed on the GitHub numeric identity
    // it stores. Only attempted when that identity is present on the event.
    if (event.repositoryId && event.installationId && event.accountId) {
      const match = findPrByGitHubIdentityAndNumber(db, {
        repositoryId: String(event.repositoryId),
        installationId: String(event.installationId),
        accountId: String(event.accountId),
        number: event.number,
      });
      if (match) {
        // Explicit allowlisted global read: the GitHub webhook has no authenticated
        // principal, so there is no request tenant. The tenant is derived from the
        // matched PR's consumer row and used to scope every subsequent write.
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
            repositoryId: event.repositoryId,
            installationId: event.installationId,
            accountId: event.accountId,
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
    }
    // Lanes 2 and 3: the candidate-delivery lanes that actually ship PRs today.
    // These tables carry no GitHub numeric identity, so the PR is resolved by the
    // durable draft PR URL each lane recorded when it opened the PR. As with the
    // migration_prs path, the webhook has no authenticated principal, so the
    // tenant is derived from the matched delivery row and used to scope the write.
    // 'closed' (unmerged) is recorded distinctly from 'merged'; a null outcome
    // (no webhook yet) is never touched, so it stays pending, not negative.
    const deliveryOutcome = outcome === "merged" ? "merged" : "closed_unmerged";
    const prUrl = event.htmlUrl;
    const auditDeliveryOutcome = (tenantId: string, deliveryId: string, resourceType: string) => {
      recordAudit(db, {
        id: wh.delivery
          ? `webhook_${createHash("sha256")
              .update(`${wh.delivery}\0delivery.${deliveryOutcome}\0${deliveryId}`)
              .digest("hex")}`
          : undefined,
        tenantId,
        actor: "github_webhook",
        action: `delivery.${deliveryOutcome}`,
        resourceType,
        resourceId: deliveryId,
        requestId: c.get("requestId"),
        metadata: {
          delivery: wh.delivery,
          owner: event.owner,
          repo: event.repo,
          number: event.number,
          htmlUrl: prUrl,
        },
      });
    };
    // Re-invoke the governed learning producer now that a terminal outcome is
    // durably recorded. Best-effort and idempotent: the outcome is already
    // committed above, so a lost enqueue must not fail the webhook (GitHub retries
    // under the same delivery id, which the upstream dedup drops), and the enqueue
    // itself deduplicates per delivery. A failure is recorded so it stays
    // diagnosable. The worker reads the outcome from the delivery row and lets the
    // producer decide what to admit; nothing about the outcome is carried here.
    const enqueueDeliveryLearning = (
      lane: "fettler" | "regauge",
      tenantId: string,
      deliveryId: string,
      resourceType: string,
    ) => {
      try {
        enqueueDeliveryOutcomeLearning({ db, lane, tenantId, deliveryId, createdAt: nowIso() });
      } catch (error) {
        recordAudit(db, {
          tenantId,
          actor: "github_webhook",
          action: "learning.outcome_resolution_enqueue_failed",
          resourceType,
          resourceId: deliveryId,
          requestId: c.get("requestId"),
          metadata: {
            lane,
            error: error instanceof Error ? error.message.slice(0, 200) : String(error),
          },
        });
      }
    };
    const fettlerDelivery = prUrl ? findWardenCandidateDeliveryByPrUrl(db, prUrl) : undefined;
    if (fettlerDelivery) {
      const updated = recordWardenCandidateDeliveryOutcome(db, {
        tenantId: fettlerDelivery.tenantId,
        deliveryId: fettlerDelivery.id,
        outcome: deliveryOutcome,
        source: "github_webhook",
        observedAt: nowIso(),
      });
      auditDeliveryOutcome(fettlerDelivery.tenantId, fettlerDelivery.id, "fettler_candidate_delivery");
      enqueueDeliveryLearning("fettler", updated.tenantId, updated.id, "fettler_candidate_delivery");
      return c.json({
        ok: true,
        applied: updated.outcome,
        deliveryId: updated.id,
        lane: "fettler_candidate_delivery",
      });
    }
    const regaugeDelivery = prUrl ? findAdaptiveDeliveryByPrUrl(db, prUrl) : undefined;
    if (regaugeDelivery) {
      const updated = recordAdaptiveDeliveryOutcome(db, {
        tenantId: regaugeDelivery.tenantId,
        deliveryId: regaugeDelivery.id,
        outcome: deliveryOutcome,
        source: "github_webhook",
        observedAt: nowIso(),
      });
      auditDeliveryOutcome(regaugeDelivery.tenantId, regaugeDelivery.id, "regauge_adaptive_delivery");
      enqueueDeliveryLearning("regauge", updated.tenantId, updated.id, "regauge_adaptive_delivery");
      return c.json({
        ok: true,
        applied: updated.outcome,
        deliveryId: updated.id,
        lane: "regauge_adaptive_delivery",
      });
    }
    return c.json({ ok: true, applied: null, reason: "no matching migration PR or delivery" });
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
  if (!getConsumer(db, c.req.param("id"), requestTenantId(c))) {
    return c.json({ error: "not found" }, 404);
  }
  const report = buildExposureReport(db, c.req.param("id"));
  if (!report) return c.json({ error: "not found" }, 404);
  return c.json(report);
});

app.get("/consumers/:id/exposure.md", (c) => {
  if (!getConsumer(db, c.req.param("id"), requestTenantId(c))) {
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
  let limit: number;
  try {
    limit = parseAuditExportLimit(c.req.query("limit"));
  } catch {
    return c.json({ error: "audit_export_limit_invalid" }, 400);
  }
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

/** Reservation id a usage-enforced run carries in its job payload, or null. */
function runReservationIdFromJob(job: { payload_json: string } | undefined): string | null {
  if (!job) return null;
  try {
    const payload = JSON.parse(job.payload_json) as Record<string, unknown>;
    const reservationId = payload[RUN_USAGE_RESERVATION_KEY];
    return typeof reservationId === "string" && reservationId ? reservationId : null;
  } catch {
    return null;
  }
}

/** Fan-out job: run pipeline for a provider across consumers */
app.post("/jobs/fanout", async (c) => {
  const body = await c.req.json<{
    providerSlug: string;
    severity?: string;
    notificationsOnly?: boolean;
    contractCases?: ContractCase[];
    securityScanAttested?: boolean;
    /** @deprecated Ambiguous name — send `securityScanAttested`. */
    securityScanOk?: boolean;
    securityScanAttestation?: SecurityScanAttestation;
    repairVerifyCommands?: string[];
  }>();
  if (!body.providerSlug) return c.json({ error: "providerSlug required" }, 400);
  const tenantId = requestTenantId(c);
  const id = newId();
  // Wave C: reserve the run's deterministic MCU estimate before admitting work.
  // Default-OFF (MENDPOINT_USAGE_ENFORCEMENT); when off this is a no-op and the
  // enqueue below is byte-for-byte identical to the legacy path.
  let usageHold: { reservationId: string; reservedMcuMicros: number } | undefined;
  try {
    const targetCount = listConsumersForProvider(db, body.providerSlug, tenantId).length;
    const admission = admitRunUsage(db, {
      tenantId,
      runId: id,
      mcuMicros: estimateRunMcuMicros({ targetCount }),
      reason: `run admission: pipeline.fanout ${body.providerSlug}`,
      actorPrincipalId: c.get("trustPrincipalId"),
      createdAt: nowIso(),
    });
    if (admission.enforced && !admission.admitted) {
      return c.json(admission.body, admission.status);
    }
    if (admission.enforced && admission.admitted) {
      usageHold = {
        reservationId: admission.reservationId,
        reservedMcuMicros: admission.reservedMcuMicros,
      };
    }
  } catch (error) {
    return mappedErrorResponse(c, error, USAGE_ERRORS);
  }
  enqueueJob(db, {
    id,
    tenantId,
    type: "pipeline.fanout",
    payload: {
      providerSlug: body.providerSlug,
      tenantId,
      severity: body.severity,
      notificationsOnly: body.notificationsOnly,
      contractCases: body.contractCases,
      securityScanAttested: body.securityScanAttested ?? body.securityScanOk,
      securityScanAttestation: body.securityScanAttestation,
      repairVerifyCommands: body.repairVerifyCommands,
      ...(usageHold
        ? {
            [RUN_USAGE_RESERVATION_KEY]: usageHold.reservationId,
            [RUN_USAGE_RESERVED_MCU_KEY]: usageHold.reservedMcuMicros,
          }
        : {}),
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
  const jobId = c.req.param("id");
  const jobBeforeCancel = getJob(db, jobId, tenantId);
  const cancelled = cancelJob(db, jobId, nowIso(), {
    tenantId,
    reason: body.reason,
  });
  if (!cancelled) return c.json({ error: "job is not eligible for cancellation" }, 409);
  // Wave C: release the run's usage hold so a cancelled run burns no quota. Only
  // runs admitted with enforcement on carry a reservation id, so when the flag was
  // never on this branch never runs and the legacy path is unchanged.
  const cancelledReservationId = runReservationIdFromJob(jobBeforeCancel);
  if (cancelledReservationId) {
    try {
      releaseRunUsage(db, {
        tenantId,
        reservationId: cancelledReservationId,
        reason: `run cancelled: job ${jobId}`,
        actorPrincipalId: c.get("trustPrincipalId"),
        createdAt: nowIso(),
      });
    } catch (error) {
      console.error(
        `usage release skipped for cancelled job=${jobId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
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

function wardenRunResponse(run: Parameters<typeof agentRunToApi>[0]) {
  return {
    ...agentRunToApi(run),
    delivery: getWardenCandidateDeliveryByRun(db, run.tenant_id, run.id) ?? null,
  };
}

app.get("/agent/runs", (c) =>
  c.json(
    listAgentRuns(db, 40, requestTenantId(c)).map(wardenRunResponse),
  ),
);

app.get("/agent/runs/:id", (c) => {
  const r = getAgentRun(db, c.req.param("id"), requestTenantId(c));
  if (!r) return c.json({ error: "not found" }, 404);
  return c.json(wardenRunResponse(r));
});

function markWardenCandidateExpired(
  run: Readonly<{ id: string; status: string; result_json: string | null }>,
  tenantId: string,
): void {
  if (run.status !== "candidate_ready") return;
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
     WHERE id = ? AND tenant_id = ? AND status = 'candidate_ready'`,
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
    return c.json({
      ...(await readWardenCandidate({
      tenantId: run.tenant_id,
      repoPath: run.repo_path,
      status: run.status,
      resultJson: run.result_json,
      })),
      delivery: getWardenCandidateDeliveryByRun(db, run.tenant_id, run.id) ?? null,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "warden_candidate_expired") {
      markWardenCandidateExpired(run, run.tenant_id);
    }
    return mappedErrorResponse(c, error, WARDEN_CANDIDATE_ERRORS);
  }
});

registerWardenCandidateReviewRoutes(app, db, requestAudit);


// Transformer adaptive candidate review (distinct human sign-off for adaptive
// fixes that diverge from the deterministic recipe output).
registerTransformerAdaptiveReviewRoutes(app, db, requestAudit, {
  regenerationGate: (tenantId) => transformerExecutions.gate(tenantId, "api_control_plane"),
});

registerLegacyBehaviorRoutes(app, db, {
  enabled: process.env.MENDPOINT_LEGACY_BEHAVIOR_ENABLED === "1",
  now: nowIso,
});

/**
 * Run Warden — Mendpoint API debug agent (tool loop).
 * Body: { mode?, goal, consumerId, allowedChangedPaths, verifyCommand?, errorLog?, maxSteps?, useLlm?, missionId? }
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
    if (body.missionId && !getMission(db, tenantId, body.missionId)) {
      return c.json({ error: "mission not found" }, 404);
    }
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
      mode: body.mode,
      goal: body.goal,
      consumerId: consumer.id,
      allowedChangedPaths: body.allowedChangedPaths,
      verifyCommand: body.verifyCommand,
      errorLog: body.errorLog,
      maxSteps: body.maxSteps,
      dryRun: body.dryRun,
      useLlm: resolveWardenUseLlm(body),
      allowNetwork: false,
      sessionId,
      ...(body.missionId ? { missionId: body.missionId } : {}),
    };
    const payloadJson = JSON.stringify(payload);
    const createdAt = nowIso();
    db.raw.exec("BEGIN IMMEDIATE");
    try {
      const existing = getJob(db, jobId, tenantId);
      if (existing) {
        if (existing.type !== "agent.run" || existing.payload_json !== payloadJson) {
          db.raw.exec("ROLLBACK");
          return c.json({ error: "idempotency key was already used for a different Fettler run" }, 409);
        }
        db.raw.exec("COMMIT");
        return c.json(
          {
            sessionId,
            jobId,
            status: existing.status,
            product: "warden",
            replayed: true,
            message: "The existing Fettler run was returned",
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
          taskMode: body.mode,
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
          taskMode: body.mode,
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
    return internalErrorResponse(c, e);
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
    return internalErrorResponse(c, e);
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
    return internalErrorResponse(c, error);
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
    return mappedErrorResponse(c, error, USAGE_ERRORS);
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
    return mappedErrorResponse(c, error, USAGE_ERRORS);
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
    return mappedErrorResponse(c, error, USAGE_ERRORS);
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
    return mappedErrorResponse(c, error, USAGE_ERRORS);
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
    return mappedErrorResponse(c, error, USAGE_ERRORS);
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
    return mappedErrorResponse(c, error, USAGE_ERRORS);
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

app.route("/tenants", createTenantCreationRoutes({
  db,
  onCreated: (c, tenant) => requestAudit(c, {
    actor: "api",
    action: "tenant.created",
    resourceType: "tenant",
    resourceId: tenant.id,
    metadata: { slug: tenant.slug, plan: tenant.plan },
  }),
}));

app.post("/tenants/:id/plan", async (c) => {
  const principal = c.get("principal");
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  // S0-B: when the self-serve billing flag is on, owner/admin change their own plan
  // (no manual-contract flag) and selecting a plan provisions its MCU entitlement.
  // Flag off => the manual-contract gate below, byte-for-byte unchanged.
  const selfServe = selfServeBillingEnabled();
  const planDecision = selfServe
    ? selfServePlanChangeDecision(principal.role)
    : billingPlanChangeDecision(principal.role);
  if (!planDecision.allowed) return c.json({ error: planDecision.error }, planDecision.status);
  const t = getTenant(db, c.req.param("id"));
  if (!t) return c.json({ error: "not found" }, 404);
  if (t.id !== principal.tenantId) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ plan: string }>();
  if (!BILLING_PLANS.some((p) => p.id === body.plan)) {
    return c.json({ error: "invalid plan", plans: BILLING_PLANS.map((p) => p.id) }, 400);
  }
  updateTenantPlan(db, t.id, body.plan);
  if (planDecision.mode === "self_serve") {
    const now = nowIso();
    const period = monthlyBillingPeriod(now);
    try {
      provisionEntitlementForPlan(db, {
        tenantId: t.id,
        plan: body.plan,
        periodStart: period.start,
        periodEnd: period.end,
        seats: t.seat_limit,
        now,
      });
    } catch (error) {
      return mappedErrorResponse(c, error, USAGE_ERRORS);
    }
  }
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
  let expectedAccountId: string | undefined;
  if (!config.mockMode) {
    try {
      expectedAccountId = resolveGitHubTenantAccountBinding(principal.tenantId);
    } catch {
      return c.json({ error: "github_account_binding_invalid" }, 503);
    }
    if (!expectedAccountId) {
      return c.json({ error: "github_account_binding_required" }, 503);
    }
  }
  createGitHubInstallState(db, {
    state,
    tenantId: principal.tenantId,
    principalId: principal.id,
    expectedAccountId,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 10 * 60_000).toISOString(),
  });
  const result = buildInstallUrl({ state });
  return c.json(result);
});

app.get("/github/app/installations", (c) =>
  c.json(
    listGitHubInstallations(db, requestTenantId(c)).map(
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
    if (completion.status === "account_identity_mismatch") {
      return c.json({ error: "installation_account_identity_mismatch" }, 409);
    }
    if (completion.status === "repository_scope_incomplete") {
      return c.json({ error: "installation_repository_scope_incomplete" }, 409);
    }
    if (completion.status === "invalid") {
      return c.json({ error: "invalid_or_expired_state" }, 400);
    }
    if (!("installation" in completion)) {
      return internalErrorResponse(c, new Error("installation_completion_failed"));
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
    accountId: "1",
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

assertPublicDocsApiRoutesMounted(app.routes);

const port = Number(process.env.API_PORT ?? 3001);
const hostname = process.env.API_HOST?.trim() || "0.0.0.0";

const server = serve({ fetch: app.fetch, port, hostname }, () => {
  const release = resolveRelease();
  console.log(releaseBanner());
  console.log(`Mendpoint API listening on http://${hostname}:${port}`);
  console.log(
    `probes: /health /live /ready /version /status · auth=${effectiveAuthMode()} · channel=${release.channel}`,
  );
});

let shuttingDown = false;

function closeDurableStores() {
  transformerCampaigns.close();
  transformerExecutions.close();
  closeDefaultChangeSourceStore();
}

// Export buffered telemetry to OTLP on a fixed cadence so the module-level
// buffers cannot grow unbounded between shutdowns. No-op (and no timer) when
// telemetry is disabled; unref'd so it never keeps the process alive.
const TELEMETRY_FLUSH_INTERVAL_MS = Math.max(
  1_000,
  Number(process.env.MENDPOINT_TELEMETRY_FLUSH_MS ?? 15_000),
);
const telemetryFlushTimer = isTelemetryEnabled()
  ? setInterval(() => {
      void flushTelemetry();
    }, TELEMETRY_FLUSH_INTERVAL_MS)
  : null;
telemetryFlushTimer?.unref();

let finalized = false;
function finalizeAndExit() {
  if (finalized) return;
  finalized = true;
  if (telemetryFlushTimer) clearInterval(telemetryFlushTimer);
  // A final flush drains whatever accumulated since the last cadence tick.
  // Safe when telemetry is disabled (resets buffers, never throws); the
  // hard-cap timer in shutdown() guarantees exit even if the export stalls.
  void flushTelemetry().finally(() => {
    closeDurableStores();
    process.exit(0);
  });
}

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[mendpoint] ${signal} — graceful shutdown`);
  // Hard cap so a slow socket drain or telemetry export can never hang exit.
  setTimeout(() => {
    if (telemetryFlushTimer) clearInterval(telemetryFlushTimer);
    closeDurableStores();
    process.exit(0);
  }, 5000).unref();
  try {
    // @hono/node-server Server
    const s = server as { close?: (cb?: () => void) => void };
    if (typeof s.close === "function") {
      s.close(() => finalizeAndExit());
      return;
    }
  } catch {
    /* */
  }
  finalizeAndExit();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
