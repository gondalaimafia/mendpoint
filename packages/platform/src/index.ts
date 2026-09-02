export type { MemoryLayer, MemoryEntry, AgentMemory } from "./memory.js";
export { scimBindingsFromEnv, type ScimBinding } from "./scim-bindings.js";
export {
  createMemory,
  remember,
  pruneMemory,
  memoryForPlanner,
  retrieveKnowledge,
} from "./memory.js";

export type {
  SandboxKind,
  MockUpstream,
  SandboxHandle,
  SandboxRunResult,
  CreateSandboxOpts,
  SandboxCacheScope,
} from "./sandbox.js";
export {
  createSandbox,
  createLocalSandbox,
  resolveSandboxKind,
  clearSandboxCache,
  getSandboxCacheStats,
  tenantScopedCacheKey,
  sandboxManifest,
  RUNTIME_MATRIX,
} from "./sandbox.js";

export type {
  FlyGuest,
  FlyMachineFile,
  FlyMachineConfig,
  FlyMachine,
  FlyExecResult,
  FlyMachineClient,
  FlySandboxResources,
  FlySandboxOptions,
  FlySandboxHandle,
  FlyRetryOptions,
  OrphanReconcileResult,
  MockFlyBehavior,
  MockFlyClient,
} from "./fly-sandbox.js";
export {
  FLY_SANDBOX_DEFAULTS,
  FlySandboxError,
  createFlyMachinesSandbox,
  resolveFlyClient,
  createMockFlyClient,
  createFlyRestClient,
  collectWorkspaceFiles,
  resolveSandboxImage,
  sandboxAllowUnpinnedImage,
  isTransientFlyError,
  withFlyRetry,
  reconcileOrphanedMachines,
} from "./fly-sandbox.js";

export type {
  SandboxEgressAttestationPayload,
  VerifiedSandboxEgressAttestationPayload,
  SandboxEgressAuthorityConfig,
} from "./sandbox-egress-attestation.js";
export {
  SANDBOX_EGRESS_ATTESTATION_LEGACY_SCHEMA,
  SANDBOX_EGRESS_ATTESTATION_SCHEMA,
  SANDBOX_EGRESS_ATTESTATION_SCHEMA_VERSIONS,
  SANDBOX_EGRESS_ATTESTATION_MIN_SCHEMA_FLOOR,
  resolveSandboxEgressMinimumSchema,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_URL,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_DIGEST,
  SANDBOX_EGRESS_ALLOWED_PROBE_COMMAND,
  SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST,
  sandboxEgressAttestationPayloadBytes,
  verifySandboxEgressAttestation,
  sandboxEgressAuthorityFromEnv,
} from "./sandbox-egress-attestation.js";

export type { KnowledgeDoc } from "./knowledge.js";
export {
  DEFAULT_API_STYLE_GUIDE,
  DEFAULT_MIGRATION_PLAYBOOK,
  loadKnowledgeFromDir,
  seedMemoryForAgent,
  captureFixup,
} from "./knowledge.js";

export type { CanaryPolicy, CanaryDecision, CrossPrRollback } from "./canary.js";
export {
  DEFAULT_CANARY,
  evaluateCanary,
  planCrossPrRollback,
} from "./canary.js";

export type { VmBackend, VmSandboxOpts, VmCapability } from "./vm.js";
export {
  createVmSandbox,
  detectVmCapabilities,
  vmStatusReport,
  getBuildCacheStats,
  clearBuildCache,
  ensureBuildCacheDir,
} from "./vm.js";

export type { LiveRoute, LiveSandbox } from "./live-sandbox.js";
export { startLiveSandbox } from "./live-sandbox.js";

export type { CostRates, CostInput, CostBreakdown, CostLedgerEntry } from "./cost.js";
export {
  DEFAULT_COST_RATES,
  estimateCost,
  estimateTokensFromRun,
  formatCost,
} from "./cost.js";

export type {
  McuWork,
  McuBreakdown,
  McuLedgerEntryType,
  McuLedgerEntry,
  McuLedgerEntryInput,
  McuLedgerLifecycle,
  McuLedgerReconciliation,
} from "./mcu.js";
export {
  MCU_VERSION,
  MCU_MICROS,
  MCU_SCHEDULE_V1,
  MCU_SCHEDULE_DIGEST,
  MCU_LEDGER_ENTRY_TYPES,
  mcuScheduleDigest,
  mcuLedgerEntryDigest,
  createMcuLedgerEntry,
  reconcileMcuLedgerLifecycle,
  assertMcuScheduleChange,
  calculateMcuV1,
  formatMcu,
} from "./mcu.js";

export type { FanoutRunMeterSignals } from "./billing-metering.js";
export {
  SELF_SERVE_BILLING_FLAG,
  selfServeBillingEnabled,
  fanoutRunMcuWork,
  computeFanoutRunMcuMicros,
  resolveFanoutSettlementMcuMicros,
} from "./billing-metering.js";

export type { Role, Permission, Principal } from "./rbac.js";
export {
  permissionsFor,
  can,
  canMutateSystemCatalog,
  assertCan,
  assertTenant,
  GLOBAL_CATALOG_RESOURCES,
  parsePrincipalFromHeaders,
  isPublicRoute,
  permissionForRoute,
} from "./rbac.js";

export type { ScmProvider, ScmPr, ScmAdapter } from "./scm.js";
export {
  ScmRequestError,
  getScmAdapter,
  createGitHubAdapter,
  createGitLabAdapter,
  createBitbucketAdapter,
  createAzureDevOpsAdapter,
  listScmProviders,
} from "./scm.js";

export type { AlertSeverity, Alert, AlertSink } from "./alerts.js";
export {
  onAlert,
  emitAlert,
  recentAlerts,
  clearAlerts,
  evaluateLatencyAlerts,
  evaluateDogfoodAlerts,
  evaluateCostAlerts,
  setAlertPersistPath,
  defaultAlertPath,
} from "./alerts.js";

export type {
  RepositorySourcePolicy,
  RepositoryProbe,
  ResolvedRepositoryRef,
  SnapshotFile,
  SnapshotSubmodule,
  ImmutableRepositorySnapshot,
  DiscoveredDocument,
  DiscoveredCiConfig,
  DiscoveredVerificationCommand,
  RepositoryDiscovery,
  RepositorySource,
  RepositorySourceErrorCode,
  GitHubTransportRequest,
  GitHubTransportResponse,
  GitHubRepositoryTransport,
} from "./repository-source.js";
export {
  RepositorySourceError,
  validateRepositoryRelativePath,
  createLocalGitRepositorySource,
  FetchGitHubRepositoryTransport,
  createGitHubRepositorySource,
} from "./repository-source.js";

export {
  evaluateExecutableTarget,
  type CiRunEvidence,
  type ExecutableTargetEvidence,
} from "./execution-evidence.js";

export type {
  SecretReference,
  EnvSecretReference,
  MemorySecretReference,
  CredentialRotationMetadata,
  CredentialRevocation,
  CredentialDescriptor,
  SecretProvider,
  CredentialAccessReason,
  CredentialAccessAuditEvent,
  CredentialAccessAudit,
  CredentialAccessRequest,
  CredentialAccessErrorCode,
  ResolvedCredential,
  CredentialBrokerOptions,
} from "./credentials.js";
export {
  CredentialAccessError,
  SecretMaterial,
  EnvSecretProvider,
  MemorySecretProvider,
  CredentialBroker,
} from "./credentials.js";

export {
  ENVELOPE_SECRET_SCHEMA_VERSION,
  EnvelopeKeyLifecycleRegistry,
  DisabledExternalVaultProvider,
  ConfiguredEnvelopeKeyProvider,
  LocalEnvelopeKeyProvider,
  cryptographicKeyMaterialFingerprint,
  envelopeKeyProvidersFromEnvironment,
  attestEnvelopeKey,
  sealEnvelopeSecret,
  openEnvelopeSecret,
  EnvelopeSecretVault,
  DurableEnvelopeSecretProvider,
  type EnvelopeKeyReference,
  type EnvelopeKeyLocator,
  type EnvelopeKeyAttestation,
  type EnvelopeKeyState,
  type EnvelopeKeyLifecycle,
  type SecretAccessContext,
  type EnvelopeSecret,
  type EnvelopeAccessAuditEvent,
  type KeyEncryptionKeyProvider,
  type DurableEnvelopeSecretVersion,
  type DurableEnvelopeSecretProviderOptions,
} from "./vault-envelope.js";

export {
  ExecutorRegistry,
  ExecutorCircuitBreaker,
  ROUTER_REGISTRY_SCHEMA_VERSION,
  ROUTER_FAILURE_CODES,
  routeTask,
  selectPolicyBoundFallback,
  type DataClassification,
  type TaskRisk,
  type RouterFailureCode,
  type ExecutorKind,
  ROUTER_PRODUCTS,
  type RouterProduct,
  type RouterBlastRadius,
  type RouterTaskSpec,
  type RouterPolicySnapshot,
  type ExecutorDescriptor,
  type ExecutorRegistryContract,
  type ExecutorRegistryBinding,
  type CircuitBreakerConfig,
  type CircuitBreakerState,
  type ExecutorAvailability,
  type RoutingExclusionReason,
  type ExecutorEvaluation,
  type PolicyBoundExecutorRoute,
  type RoutingPlan,
  type HumanHandoffReason,
  type HumanHandoff,
  type RoutingDecisionRecord,
  type ExecutionActualTelemetryRecord,
  type RoutingOutcome,
  type RouteTaskInput,
  type SelectFallbackInput,
} from "./router.js";

export {
  ADAPTIVE_ROUTER_ENV,
  ADAPTIVE_QUALITY_SMOOTHING,
  ADAPTIVE_QUALITY_GAIN,
  ADAPTIVE_COST_SMOOTHING,
  ADAPTIVE_LATENCY_SMOOTHING,
  aggregateRouterOutcomes,
  adaptiveAggregateKey,
  effectiveRoutingMetrics,
  indexAdaptiveStats,
  isAdaptiveRoutingEnabled,
  type AdaptiveRoutingStats,
  type AdaptiveBaselineMetrics,
  type RouterOutcomeAggregate,
} from "./router-adaptive.js";

export {
  type PersistedRouterTaskSpec,
  type RouterActualOutcomeInput,
  type RouterAttemptEvidence,
  type RouterDispatch,
  type RouterEvidenceEvent,
  type RouterPreparedEnvelope,
  type RouterRetryPolicy,
  type RouterVerificationEvidence,
} from "./router-runtime.js";

export {
  ADAPTER_LIFECYCLE_STATES,
  AdapterLifecycleError,
  AdapterLifecycleRegistry,
  type AdapterLifecycleState,
  type BaseModelBinding,
  type TrainingDatasetBinding,
  type HeldOutEvaluationBinding,
  type PromotionThresholdBinding,
  type ApprovedInfrastructureBinding,
  type MonitoringWindowBinding,
  type RollbackTargetBinding,
  type HumanApproverBinding,
  type CanaryEvidenceBinding,
  type AdapterLifecycleEvent,
  type AdapterLifecycleRecord,
  type RegisterAdapterInput,
  type AdapterLifecycleBindings,
  type TransitionAdapterInput,
  type AdapterLifecycleErrorCode,
} from "./adapter-lifecycle.js";

export {
  PostTrainedAdmissionError,
  resolvePostTrainedExecutor,
  type PostTrainedAdmissionErrorCode,
  type PostTrainedConsentSnapshot,
  type PostTrainedDispatchAuthorization,
  type PostTrainedDispatchIntent,
  type PostTrainedExecutorAdmission,
  type PostTrainedExpectedBindings,
  type PostTrainedLifecycleSource,
  type PostTrainedPreDispatchGuard,
  type PostTrainedRuntimeBindings,
  type ResolvePostTrainedExecutorInput,
} from "./post-trained-runtime.js";

export {
  GitLabFixtureAdapter,
  GitLabFixtureError,
  type GitLabFixtureAuth,
  type GitLabFixtureCredential,
  type GitLabFixtureProjectSeed,
  type GitLabSnapshotFile,
  type GitLabImmutableSnapshot,
  type GitLabPipelineStatus,
  type GitLabMergeRequest,
  type GitLabDiscussion,
  type GitLabApproval,
  type GitLabFixtureAuditEvent,
  type GitLabFixtureErrorCode,
} from "./gitlab-fixture.js";

export {
  authorizeScmDraftDelivery,
  ScmInstallationBoundaryError,
  type ScmPermissionLevel,
  type ScmRepositoryBinding,
  type ScmInstallationBinding,
  type ScmDraftDeliveryIntent,
  type ScmDraftDeliveryAuthorization,
  type ScmInstallationBoundaryErrorCode,
} from "./scm-installation-boundary.js";
