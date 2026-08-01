export type { MemoryLayer, MemoryEntry, AgentMemory } from "./memory.js";
export {
  createMemory,
  remember,
  pruneMemory,
  memoryForPlanner,
  retrieveKnowledge,
} from "./memory.js";

export type { SandboxKind, MockUpstream, SandboxHandle, CreateSandboxOpts } from "./sandbox.js";
export {
  createSandbox,
  clearSandboxCache,
  getSandboxCacheStats,
  sandboxManifest,
  RUNTIME_MATRIX,
} from "./sandbox.js";

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

export type { Role, Permission, Principal } from "./rbac.js";
export {
  permissionsFor,
  can,
  assertCan,
  assertTenant,
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
} from "./repository-source.js";
export {
  RepositorySourceError,
  validateRepositoryRelativePath,
  createLocalGitRepositorySource,
} from "./repository-source.js";

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
  ExecutorRegistry,
  ExecutorCircuitBreaker,
  routeTask,
  selectPolicyBoundFallback,
  type DataClassification,
  type TaskRisk,
  type RouterTaskSpec,
  type RouterPolicySnapshot,
  type ExecutorDescriptor,
  type CircuitBreakerConfig,
  type CircuitBreakerState,
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
