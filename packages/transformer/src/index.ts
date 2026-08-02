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
  RecipeFiles,
  RecipeOperation,
  RecipePrecondition,
  RecipeReference,
  RecipeTransform,
  RecipeVerificationCommand,
} from "./recipe.js";
export {
  NODE_RUNTIME_18_TO_20_RECIPE,
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
  RecipeWorkspaceExecutionError,
  executeRecipeInWorkspace,
  restoreRecipeExecutionInWorkspace,
} from "./recipe-workspace-execution.js";
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
