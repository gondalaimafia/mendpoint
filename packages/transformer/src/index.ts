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
