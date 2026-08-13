export type {
  BsgNodeKind,
  BsgNode,
  BsgEdge,
  BehavioralSpecGraph,
  DagNodeStatus,
  MigrationDagNode,
  MigrationCampaign,
  DifferentialResult,
  TransformerDomainErrorCode,
} from "./types.js";
export { TransformerDomainError } from "./types.js";

export {
  collectBsgAnnotations,
  verifyExtractedBehavioralSpecGraph,
  type BsgEvidenceAssertion,
  type ExtractedBehavioralSpecGraph,
} from "./bsg-extractor.js";

export {
  extractLegacyBehavior,
  LegacyBehaviorExtractionError,
  type LegacyBehaviorArtifact,
  type LegacyBehaviorCollector,
  type LegacyBehaviorCollectorPin,
  type LegacyBehaviorExtractionInput,
  type LegacyBehaviorExtractionPolicy,
  type LegacyBehaviorExtractionResult,
  type LegacyBehaviorJsonValue,
} from "./legacy-behavior-extraction.js";

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
  MigrationLabelFamily,
  RecipeApplication,
  RecipeAnalysis,
  RecipeApplicability,
  RecipeClassification,
  GitBlobMode,
  RecipeFileModes,
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
  AWS_SDK_JS_V2_TO_V3_RECIPE,
  GOOGLEAPIS_V25_TO_V26_RECIPE,
  INTERNAL_API_ACME_USER_RENAME_RECIPE,
  NODE_RUNTIME_18_TO_20_RECIPE,
  NODE_RUNTIME_20_TO_22_RECIPE,
  REACT_DOM_17_TO_18_RECIPE,
  STRIPE_NODE_V10_TO_V11_RECIPE,
  RecipeAnalysisCache,
  analyzeRecipe,
  applyInverseOperations,
  applyRecipe,
  assertRecipePathAllowed,
  classifyRecipeContract,
  classifyRecipeReference,
  createInternalApiRenameRecipe,
  getRecipe,
  normalizeRecipeFileModes,
  recipeFilesDigest,
  recipeReference,
  resolveRecipe,
  validateRecipe,
  type InternalApiRenameSpec,
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
  runRecipeVerificationGate,
} from "./recipe-workspace-execution.js";

export * from "./attempt-checkpoint.js";
export * from "./attempt-checkpoint-storage.js";
export {
  createTransformerPilotAttemptCheckpointConfig,
  type TransformerPilotAttemptCheckpointConfigInput,
} from "./attempt-checkpoint-execution.js";

export {
  AWS_SDK_JS_V2_TO_V3_ARTIFACT,
  GOOGLEAPIS_V25_TO_V26_ARTIFACT,
  INTERNAL_API_ACME_USER_RENAME_ARTIFACT,
  NODE_RUNTIME_20_TO_22_ARTIFACT,
  REACT_DOM_17_TO_18_ARTIFACT,
  STRIPE_NODE_V10_TO_V11_ARTIFACT,
  PUBLISHED_PROVIDER_RECIPE_ARTIFACTS,
  createPublishedProviderRecipeCatalog,
  signPublishedProviderRecipes,
  type CreatePublishedProviderRecipeCatalogInput,
  type ProviderRecipeSigningKey,
  type ProviderRecipeTrustedKey,
} from "./published-recipes.js";

export {
  DEFAULT_ADAPTIVE_REPAIR_BOUNDS,
  runAdaptiveRepairLoop,
  type AdaptiveBestAttempt,
  type AdaptiveBoundExhaustion,
  type AdaptiveEdit,
  type AdaptiveExternalModelAccounting,
  type AdaptiveExternalModelReservation,
  type AdaptiveExternalModelSettlement,
  type AdaptiveGate,
  type AdaptiveRepairBounds,
  type AdaptiveRepairContextFile,
  type AdaptiveRepairOutcome,
  type AdaptiveRepairPlan,
  type AdaptiveRepairPlanner,
  type AdaptiveRepairPlannerBudget,
  type AdaptiveRepairPlannerInput,
  type AdaptiveRepairPlannerOutput,
  type AdaptiveRepairPlannerUsage,
  type AdaptiveRepairReviewEvidence,
  type LearningPrecedentEdit,
  type LearningPrecedentEntry,
  type AdaptiveReviewRisk,
  type AdaptiveSemanticCategory,
  type AdaptiveRepairUsage,
  type AdaptiveUnfixableMarker,
  type AdaptiveUnfixableReason,
  type AdaptiveVerifierResult,
  type RunAdaptiveRepairLoopInput,
} from "./adaptive-loop.js";

export {
  persistTransformerAttemptFailureEvidence,
  persistTransformerCandidate,
  runTransformerAttempt,
  transformerAttemptId,
  type RunTransformerAttemptInput,
  type TransformerAdaptiveCandidateHandoff,
  type TransformerAdaptiveRepairConfig,
  type TransformerAdaptiveSummary,
  type TransformerAttemptClaimInput,
  type TransformerAttemptCheckpointCompletion,
  type TransformerAttemptCheckpointConfig,
  type TransformerAttemptCheckpointExecutionController,
  type TransformerAttemptCheckpointFailure,
  type TransformerAttemptCheckpointOpenInput,
  type TransformerAttemptCompletionInput,
  type TransformerAttemptCoordinatorPort,
  type TransformerAttemptFailureArtifact,
  type TransformerAttemptFailureEvidenceRecord,
  type TransformerAttemptFailureInput,
  type TransformerAttemptUsageInput,
  type TransformerAttemptPhase,
  type TransformerAttemptRecoveryCode,
  type TransformerAttemptRunResult,
  type TransformerAttemptScope,
  type TransformerCandidateArtifact,
  type TransformerCandidateFileManifest,
  type TransformerCandidateManifest,
  type TransformerCurrentAttemptFence,
  type TransformerExecutableAttemptLease,
} from "./attempt-runner.js";

export {
  MAX_ADAPTIVE_REVIEW_FILES,
  MAX_ADAPTIVE_REVIEW_FILE_BYTES,
  MAX_ADAPTIVE_REVIEW_TOTAL_BYTES,
  MAX_ADAPTIVE_SEAL_BYTES,
} from "./adaptive-review-limits.js";

export {
  sealAdaptiveCandidate,
  readAdaptiveCandidateArtifact,
  promoteAdaptiveCandidateFiles,
  discardAdaptiveCandidate,
  reconcileAdaptiveCandidateArtifacts,
  type AdaptiveCandidateSeal,
  type AdaptiveCandidateArtifact,
  type AdaptiveCandidateReviewEdit,
  type AdaptiveCandidateReviewEvidence,
  type SealAdaptiveCandidateInput,
  type ReadAdaptiveCandidateInput,
  type DiscardAdaptiveCandidateInput,
  type PromotedAdaptiveCandidate,
  type ReconcileAdaptiveCandidateArtifactsInput,
  type AdaptiveCandidateReconcileResult,
} from "./adaptive-candidate.js";

export {
  classifyReviewTier,
  resolveReviewTierPolicy,
  isReviewTier,
  DEFAULT_REVIEW_TIER_POLICY,
  RECOMMENDED_REVIEW_TIER_POLICY,
  type ReviewTier,
  type ReviewTierBand,
  type ReviewTierPolicy,
  type ReviewTierClassifierInput,
} from "./review-tier.js";

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
  verifyTransformerBlueprint,
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
  compileApprovedTransformerMission,
  type TransformerBlueprintApproval,
  type TransformerMissionCompilationInput,
  type TransformerMissionRepository,
} from "./mission-compiler.js";

export {
  planTransformerMission,
  type TransformerMissionPlanningInput,
  type TransformerMissionPlanningRepository,
} from "./mission-planner.js";

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
  DEFAULT_TRANSFORMER_ADAPTIVE_CAMPAIGN_BUDGET,
  TRANSFORMER_PILOT_EXECUTION_SCHEMA_VERSION,
  TransformerPilotExecutionStore,
  type TransformerPilotUnitState,
  type TransformerPilotExceptionCode,
  type TransformerAttemptFailureCode,
  type TransformerExactSnapshot,
  type TransformerPilotUnitInput,
  type TransformerPilotCampaignInput,
  type TransformerPilotException,
  type TransformerPilotUnit,
  type TransformerPilotCampaign,
  type TransformerAttemptLease,
  type TransformerExpiredAttempt,
  type TransformerRunnableCampaign,
  type TransformerDraftAction,
  type TransformerRollbackAction,
  type TransformerScmObservation,
  type TransformerPilotMetrics,
  type TransformerPilotEvent,
  type TransformerAdaptiveCandidateHandoffInput,
  type TransformerAdaptiveCandidateHandoffRecord,
  type TransformerRegenerationReview,
  type TransformerPendingAdaptiveCandidateHandoff,
  type TransformerRoutingOutcomeRecord,
  type TransformerRoutingSettlementRecord,
  type TransformerPendingRoutingSettlement,
  type TransformerRoutingAttemptBindingInput,
  type TransformerAdaptiveAttemptAccounting,
  type TransformerAdaptiveCampaignBudgetCeilings,
  type TransformerAdaptiveCampaignBudgetTotals,
  type TransformerAdaptiveBudgetOverride,
  type TransformerAdaptiveCampaignBudget,
} from "./pilot-execution.js";
export {
  MODERNIZATION_REPORT_SCHEMA_VERSION,
  generateModernizationReport,
  renderModernizationReportMarkdown,
  type ModernizationReportSource,
  type ModernizationReport,
  type ModernizationReportSummary,
  type ModernizationReportCompletion,
  type ModernizationReportProgress,
  type ModernizationReportUnitProgress,
  type ModernizationReportWaveProgress,
  type ModernizationReportPullRequests,
  type ModernizationReportRecipeBreakdown,
  type ModernizationReportExceptions,
  type ModernizationReportRisks,
  type ModernizationReportGap,
} from "./modernization-report.js";

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
  RecipeVerificationGateResult,
  RunRecipeVerificationGateInput,
} from "./recipe-workspace-execution.js";
export {
  generateBehaviorDocumentation,
  BehaviorDocumentationError,
  type BehaviorDocumentationEvidenceRef,
  type BehaviorDocumentationInput,
  type BehaviorDocumentationPolicy,
  type BehaviorDocumentationResult,
} from "./behavior-documentation.js";
