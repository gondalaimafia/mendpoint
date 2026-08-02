export type {
  BsgNodeKind,
  BsgNode,
  BsgEdge,
  BehavioralSpecGraph,
  DagNodeStatus,
  MigrationDagNode,
  MigrationCampaign,
  DifferentialResult,
} from "./types.js";

export {
  CampaignValidationError,
  emptyBsg,
  orderDag,
  createCampaign,
  validateCampaignInput,
  planFromCampaign,
  diffOutputs,
} from "./campaign.js";
export type { CampaignInput } from "./campaign.js";

export type { RepoAgentAssignment, MultiRepoPlan } from "./multi-repo.js";
export { planMultiRepoAgents, formatMultiRepoMarkdown } from "./multi-repo.js";

export type {
  CompatibilityDimension,
  MigrationSeverity,
  MigrationChangeKind,
  CompatibilityRule,
} from "./compatibility.js";
export {
  MIGRATION_COMPATIBILITY_RULES,
  classifyMigrationChange,
} from "./compatibility.js";

export {
  TransformerControlPlaneStore,
  type CampaignState,
  type BlueprintState,
  type BsgState,
  type UnitState,
  type WaveState,
  type AttemptState,
  type ApprovalState,
  type ExceptionState,
  type PullRequestState,
  type MutationContext,
  type BlueprintRisk,
  type BlueprintUnknown,
  type BlueprintPolicy,
  type Versioned,
  type CampaignContract,
  type BlueprintContract,
  type BsgNodeContract,
  type BsgEdgeContract,
  type BsgContract,
  type UnitContract,
  type WaveContract,
  type AttemptContract,
  type ApprovalContract,
  type ExceptionContract,
  type ArtifactContract,
  type PullRequestContract,
  type TransformerEvent,
  type TransformerEntityKind,
} from "./control-plane-store.js";

export type {
  MigrationRecipeContract,
  RecipeApplication,
  RecipeAnalysis,
  RecipeApplicability,
  RecipeFiles,
  RecipeOperation,
  RecipePrecondition,
  RecipeReference,
  RecipeTransform,
  RecipeVerificationCommand,
} from "./recipe.js";
export {
  assertTransformerDeliveryAuthorized,
  type TransformerDeliveryAuthorizationInput,
} from "./delivery-authorization.js";
export {
  NODE_RUNTIME_18_TO_20_RECIPE,
  RecipeAnalysisCache,
  analyzeRecipe,
  applyInverseOperations,
  applyRecipe,
  assertRecipePathAllowed,
  getRecipe,
  recipeFilesDigest,
  recipeReference,
  resolveRecipe,
  validateRecipe,
} from "./recipe.js";

export {
  PROVIDER_RECIPE_SCHEMA_VERSION,
  PROVIDER_CATEGORIES,
  PROVIDER_CHANGE_TARGETS,
  PROVIDER_CHANGE_KINDS,
  RecipeCatalogError,
  createProviderRecipeCatalog,
  createRecipeOutcomeEvent,
  recipeArtifactSha256,
  signProviderRecipe,
  verifyProviderRecipeSignature,
  type ProviderCategory,
  type ProviderChangeTarget,
  type ProviderChangeKind,
  type ProviderRecipeSignal,
  type ProviderRecipePrecondition,
  type ProviderRecipeArtifact,
  type SignedProviderRecipe,
  type ProviderRecipeResolution,
  type ProviderRecipeOutcomeEvent,
} from "./recipe-catalog.js";

export {
  RecipeWorkspaceExecutionError,
  executeRecipeInWorkspace,
  restoreRecipeExecutionInWorkspace,
} from "./recipe-workspace-execution.js";

export {
  planStagedPullRequestBatches,
  reconcileStagedPullRequestResume,
  type StagedPullRequestProvider,
  type VerifiedStagedPullRequestUnit,
  type StagedPullRequestBatchPlanningInput,
  type StagedPullRequestBatchPlan,
  type StagedPullRequestBatchPlanningResult,
  type StagedPullRequestObservation,
  type StagedPullRequestResumeSnapshot,
  type StagedPullRequestDraftAction,
  type StagedPullRequestResumeDecision,
} from "./staged-pr-batches.js";

export {
  planTransformerBlueprint,
  type TransformerBlueprint,
  type TransformerBlueprintFileEvidence,
  type TransformerBlueprintOrganizationEvidence,
  type TransformerBlueprintPlanningInput,
  type TransformerBlueprintPlanningResult,
  type TransformerBlueprintRepositoryEvidence,
  type TransformerObjective,
  type TransformerObjectiveUnit,
} from "./blueprint-planner.js";

export {
  ORGANIZATION_CONSTRAINT_SCHEMA_VERSION,
  ORGANIZATION_CONSTRAINT_PRECEDENCE,
  createOrganizationConstraintContract,
  assessOrganizationConstraint,
  type OrganizationConstraintSourceKind,
  type OrganizationConstraintAction,
  type OrganizationConstraintEffect,
  type OrganizationConstraintSource,
  type OrganizationConstraintRule,
  type OrganizationConstraintContract,
  type OrganizationConstraintDecision,
} from "./organization-constraints.js";

export {
  TRANSFORMER_PILOT_EXECUTION_SCHEMA_VERSION,
  TransformerPilotExecutionStore,
  type TransformerPilotUnitState,
  type TransformerPilotExceptionCode,
  type TransformerExactSnapshot,
  type TransformerPilotUnitInput,
  type TransformerPilotCampaignInput,
  type TransformerPilotException,
  type TransformerPilotUnit,
  type TransformerPilotCampaign,
  type TransformerAttemptLease,
  type TransformerDraftAction,
  type TransformerRollbackAction,
  type TransformerScmObservation,
  type TransformerPilotMetrics,
  type TransformerPilotEvent,
} from "./pilot-execution.js";
export type {
  ExactSourceSnapshot,
  PersistedRecipeEvidence,
  RecipeCommandEvidence,
  RecipeCommandInvocation,
  RecipeCommandResult,
  RecipeCommandRunner,
  RecipeExecutionFence,
  RecipeExecutionFenceEvidence,
  RecipeExecutionEvidenceRecord,
  RecipeExecutionRollback,
  RecipeOperationEvidence,
  RecipeRestoreEvidenceRecord,
  RecipeWorkspaceExecutionResult,
  RecipeWorkspaceRestoreResult,
  ExecuteRecipeWorkspaceInput,
  RestoreRecipeWorkspaceInput,
} from "./recipe-workspace-execution.js";
