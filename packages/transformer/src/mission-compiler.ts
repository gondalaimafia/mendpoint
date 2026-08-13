import { createHash } from "node:crypto";
import {
  verifyTransformerBlueprint,
  type TransformerBlueprint,
} from "./blueprint-planner.js";
import type { OrganizationConstraintContract } from "./organization-constraints.js";
import {
  applyRecipe,
  recipeFilesDigest,
  type RecipeFiles,
} from "./recipe.js";
import type {
  TransformerExactSnapshot,
  TransformerPilotCampaignInput,
} from "./pilot-execution.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_EVIDENCE = 512;

export type TransformerBlueprintApproval = Readonly<{
  reviewerId: string;
  blueprintId: string;
  blueprintDigest: string;
  approvedAt: string;
  evidenceRefs: readonly string[];
}>;

export type TransformerMissionRepository = Readonly<{
  snapshot: TransformerExactSnapshot;
  files: RecipeFiles;
}>;

export type TransformerMissionCompilationInput = Readonly<{
  tenantId: string;
  organizationId: string;
  environment: string;
  campaignId: string;
  blueprint: TransformerBlueprint;
  approvals: readonly TransformerBlueprintApproval[];
  repositories: readonly TransformerMissionRepository[];
  constraints: OrganizationConstraintContract;
  observedAt: string;
  evidenceRefs: readonly string[];
  idempotencyKey: string;
  adaptiveBudget?: TransformerPilotCampaignInput["adaptiveBudget"];
  gateConfig?: string;
}>;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value: unknown, code: string, maximum = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maximum) {
    throw new Error(code);
  }
  return value;
}

function identifier(value: unknown, code: string): string {
  const result = text(value, code, 200);
  if (!ID.test(result)) throw new Error(code);
  return result;
}

function timestamp(value: unknown, code: string): string {
  const result = text(value, code, 100);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) {
    throw new Error(code);
  }
  return result;
}

function references(values: readonly string[], code: string): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_EVIDENCE) throw new Error(code);
  const result = values.map((value) => text(value, code, 500)).sort(compareCodeUnits);
  if (new Set(result).size !== result.length) throw new Error(code);
  return result;
}

function deterministicCandidateRevision(input: {
  blueprintDigest: string;
  unitId: string;
  outputDigest: string;
}): string {
  return createHash("sha1")
    .update(`${input.blueprintDigest}\0${input.unitId}\0${input.outputDigest}`, "utf8")
    .digest("hex");
}

/**
 * Compile a reviewed, evidence-bound blueprint into the existing pilot
 * execution contract. This function plans no new scope and performs no I/O.
 */
export function compileApprovedTransformerMission(
  rawInput: TransformerMissionCompilationInput,
): TransformerPilotCampaignInput {
  let input: TransformerMissionCompilationInput;
  try {
    input = structuredClone(rawInput);
  } catch {
    throw new Error("transformer_mission_input_invalid");
  }
  const blueprint = verifyTransformerBlueprint(input.blueprint);
  const tenantId = identifier(input.tenantId, "transformer_mission_tenant_invalid");
  const organizationId = identifier(input.organizationId, "transformer_mission_organization_invalid");
  const environment = identifier(input.environment, "transformer_mission_environment_invalid");
  const campaignId = identifier(input.campaignId, "transformer_mission_campaign_invalid");
  const idempotencyKey = text(input.idempotencyKey, "transformer_mission_idempotency_invalid", 500);
  const evaluatedAt = Date.parse(timestamp(blueprint.evaluatedAt, "transformer_blueprint_integrity_invalid"));
  const observedAt = timestamp(input.observedAt, "transformer_mission_observed_at_invalid");
  const observedTime = Date.parse(observedAt);
  if (observedTime < evaluatedAt) throw new Error("transformer_mission_observed_at_invalid");
  if (input.constraints.tenantId !== tenantId || input.constraints.organizationId !== organizationId) {
    throw new Error("transformer_mission_constraint_binding_invalid");
  }

  if (!Array.isArray(input.approvals)) throw new Error("transformer_mission_approvals_incomplete");
  const reviewerIds = new Set<string>();
  const approvalEvidence: string[] = [];
  for (const approval of input.approvals) {
    const reviewerId = identifier(approval.reviewerId, "transformer_mission_reviewer_invalid");
    if (reviewerIds.has(reviewerId)) throw new Error("transformer_mission_approval_duplicate");
    reviewerIds.add(reviewerId);
    if (reviewerId === blueprint.review.plannerActorId || !blueprint.review.reviewerIds.includes(reviewerId)) {
      throw new Error("transformer_mission_reviewer_invalid");
    }
    if (approval.blueprintId !== blueprint.id || approval.blueprintDigest !== blueprint.digest) {
      throw new Error("transformer_mission_approval_binding_invalid");
    }
    const approvedTime = Date.parse(timestamp(approval.approvedAt, "transformer_mission_approval_time_invalid"));
    if (approvedTime < evaluatedAt || approvedTime > observedTime) {
      throw new Error("transformer_mission_approval_time_invalid");
    }
    approvalEvidence.push(...references(approval.evidenceRefs, "transformer_mission_approval_evidence_invalid"));
  }
  if (reviewerIds.size < blueprint.review.minimumApprovals) {
    throw new Error("transformer_mission_approvals_incomplete");
  }

  if (!Array.isArray(input.repositories) || input.repositories.length === 0) {
    throw new Error("transformer_mission_repository_required");
  }
  const repositories = new Map<string, TransformerMissionRepository>();
  for (const repository of input.repositories) {
    const repositoryId = identifier(repository.snapshot.repositoryId, "transformer_mission_repository_invalid");
    if (repositories.has(repositoryId)) throw new Error("transformer_mission_repository_duplicate");
    if (!REVISION.test(repository.snapshot.revision) || !DIGEST.test(repository.snapshot.digest) ||
        !/^[a-f0-9]{64}$/.test(repository.snapshot.manifestSha256)) {
      throw new Error("transformer_mission_snapshot_invalid");
    }
    if (recipeFilesDigest(repository.files) !== repository.snapshot.digest) {
      throw new Error("transformer_mission_snapshot_digest_mismatch");
    }
    repositories.set(repositoryId, repository);
  }

  const sortedReviewers = [...reviewerIds].sort(compareCodeUnits);
  const units = blueprint.units.map((unit) => {
    const repository = repositories.get(unit.repositoryId);
    const evidence = blueprint.evidence.repositories.find((candidate) => candidate.id === unit.repositoryId);
    if (!repository || !evidence || repository.snapshot.revision !== unit.repositoryRevision ||
        repository.snapshot.revision !== evidence.revision ||
        repository.snapshot.digest !== unit.repositorySnapshotDigest ||
        repository.snapshot.digest !== evidence.snapshotDigest) {
      throw new Error("transformer_mission_snapshot_binding_invalid");
    }
    const application = applyRecipe(unit.recipe, repository.files);
    const changedPaths = [...new Set(application.operations.map((operation) => operation.path))]
      .sort(compareCodeUnits);
    if (changedPaths.length === 0 || changedPaths.some((path) => !unit.scopePaths.includes(path))) {
      throw new Error("transformer_mission_changed_path_out_of_scope");
    }
    return {
      id: unit.id,
      title: unit.title,
      ownerId: unit.ownerIds[0]!,
      reviewerIds: sortedReviewers,
      dependsOn: [...unit.dependsOn],
      snapshot: repository.snapshot,
      candidateRevision: deterministicCandidateRevision({
        blueprintDigest: blueprint.digest,
        unitId: unit.id,
        outputDigest: application.outputDigest,
      }),
      candidateDigest: application.outputDigest,
      recipe: unit.recipe,
      changedPaths,
    };
  });
  const usedRepositoryIds = new Set(units.map((unit) => unit.snapshot.repositoryId));
  if (usedRepositoryIds.size !== repositories.size) throw new Error("transformer_mission_repository_unreferenced");

  const evidenceRefs = [...new Set([
    ...references(input.evidenceRefs, "transformer_mission_evidence_invalid"),
    ...approvalEvidence,
    ...units.map((unit) => `transformer-blueprint:${unit.id}:${blueprint.digest}`),
  ])].sort(compareCodeUnits);
  if (evidenceRefs.length > MAX_EVIDENCE) throw new Error("transformer_mission_evidence_invalid");

  return deepFreeze({
    tenantId,
    organizationId,
    environment,
    campaignId,
    constraints: input.constraints,
    units,
    observedAt,
    evidenceRefs,
    idempotencyKey,
    ...(input.adaptiveBudget === undefined ? {} : { adaptiveBudget: input.adaptiveBudget }),
    ...(input.gateConfig === undefined ? {} : {
      gateConfig: text(input.gateConfig, "transformer_mission_gate_invalid", 5_000),
    }),
  });
}
