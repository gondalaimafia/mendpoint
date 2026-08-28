import { createHash } from "node:crypto";
import {
  compileMissionGraphTopologyProjection,
  verifyMissionGraphTopologyProjection,
  type MissionGraphTopologyProjection,
} from "@mendpoint/graph-learn";
import {
  planTransformerBlueprint,
  type TransformerBlueprintOrganizationEvidence,
  type TransformerBlueprintPlanningResult,
  type TransformerObjective,
} from "./blueprint-planner.js";
import {
  analyzeRecipe,
  applyRecipe,
  recipeFilesDigest,
  recipeReference,
  validateRecipe,
  type MigrationRecipeContract,
  type RecipeFiles,
} from "./recipe.js";

const MAX_RECIPE_CATALOG = 128;
export const REGAUGE_DEPENDENCY_PROJECTION_SCHEMA_VERSION = "mendpoint.mission-graph-projection.topology.v1" as const;

export type RegaugeDependencyCoverage = MissionGraphTopologyProjection["repositories"][number]["coverage"];
export type RegaugeDependencyProjectionRepositoryV1 = MissionGraphTopologyProjection["repositories"][number];
export type RegaugeDependencyProjectionEdgeV1 = MissionGraphTopologyProjection["edges"][number];
export type RegaugeDependencyProjectionV1 = MissionGraphTopologyProjection;
export type RegaugeDependencyProjectionInputV1 = Omit<
  MissionGraphTopologyProjection,
  "schemaVersion" | "projectionKind" | "missionId" | "contentDigest"
>;

export type TransformerMissionPlanningRepository = Readonly<{
  id: string;
  snapshotId: string;
  organizationId: string;
  revision: string;
  snapshotDigest: string;
  workspacePath: string | null;
  workspaceIdentityDigest: string;
  observedAt: string;
  evidenceRefs: readonly string[];
  files: RecipeFiles;
  fileEvidence: readonly Readonly<{
    path: string;
    digest: string;
    ownerIds: readonly string[];
    evidenceRefs: readonly string[];
  }>[];
}>;

export type TransformerMissionPlanningInput = Readonly<{
  tenantId: string;
  evaluatedAt: string;
  plannerActorId: string;
  maxEvidenceAgeMs: number;
  constraints: Readonly<{
    maxUnits: number;
    maxRepositories: number;
    maxPathsPerUnit: number;
  }>;
  organization: TransformerBlueprintOrganizationEvidence;
  repositories: readonly TransformerMissionPlanningRepository[];
  objective: Omit<TransformerObjective, "units">;
  recipeCatalog: readonly MigrationRecipeContract[];
  dependencyProjection: RegaugeDependencyProjectionV1;
}>;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export function createRegaugeDependencyProjectionV1(
  rawInput: RegaugeDependencyProjectionInputV1,
): RegaugeDependencyProjectionV1 {
  return compileMissionGraphTopologyProjection({
    missionId: null,
    ...rawInput,
    edges: rawInput.edges.map((edge) => ({ ...edge, sourceSystem: "manifest" as const })),
  });
}

export function verifyRegaugeDependencyProjectionV1(
  value: RegaugeDependencyProjectionV1,
): RegaugeDependencyProjectionV1 {
  try {
    return verifyMissionGraphTopologyProjection(value);
  } catch {
    throw new Error("regauge_dependency_projection_integrity_invalid");
  }
}

function unitId(repositoryId: string, recipeId: string): string {
  const candidate = `${repositoryId}-${recipeId}`;
  if (candidate.length <= 200) return candidate;
  return `${candidate.slice(0, 175)}-${digest(candidate).slice("sha256:".length, "sha256:".length + 24)}`;
}

function abstained(reasons: Iterable<string>): TransformerBlueprintPlanningResult {
  return Object.freeze({
    decision: "abstained" as const,
    reasons: Object.freeze([...new Set(reasons)].sort(compareCodeUnits)),
    blueprint: null,
  });
}

/**
 * Inspect immutable repository inputs, select one exact deterministic recipe
 * per repository, and derive the units submitted to the existing blueprint
 * authority. Ambiguous or unsupported scope is an abstention, never a guess.
 */
export function planTransformerMission(
  rawInput: TransformerMissionPlanningInput,
): TransformerBlueprintPlanningResult {
  let input: TransformerMissionPlanningInput;
  try {
    input = structuredClone(rawInput);
  } catch {
    return abstained(["mission_input_invalid"]);
  }
  if (!input.dependencyProjection) return abstained(["dependency_projection_required"]);
  let dependencyProjection: RegaugeDependencyProjectionV1;
  try {
    dependencyProjection = verifyRegaugeDependencyProjectionV1(input.dependencyProjection);
  } catch {
    return abstained(["dependency_projection_integrity_invalid"]);
  }
  if (dependencyProjection.tenantId !== input.tenantId) {
    return abstained(["dependency_projection_tenant_mismatch"]);
  }
  const planningRepositoryIds = input.repositories.map((repository) => repository.id).sort(compareCodeUnits);
  if (stableJson(dependencyProjection.requestedRepositoryIds) !== stableJson(planningRepositoryIds)) {
    return abstained(["dependency_projection_repository_scope_mismatch"]);
  }
  const incomplete = dependencyProjection.repositories
    .filter((repository) => repository.coverage !== "complete")
    .map((repository) => `dependency_projection_incomplete:${repository.repositoryId}:${repository.reason}`);
  if (incomplete.length) return abstained(incomplete);
  const snapshotBindingFailures = dependencyProjection.repositories.flatMap((binding) => {
    const repository = input.repositories.find((candidate) => candidate.id === binding.repositoryId);
    if (
      !repository ||
      binding.coverage !== "complete" ||
      binding.manifestPath === null ||
      binding.manifestContentDigest === null ||
      binding.snapshotId !== repository.snapshotId ||
      binding.snapshotRevision !== repository.revision ||
      binding.snapshotDigest !== repository.snapshotDigest ||
      typeof repository.files[binding.manifestPath] !== "string" ||
      digest(repository.files[binding.manifestPath]!) !== binding.manifestContentDigest
    ) {
      return [`dependency_projection_snapshot_mismatch:${binding.repositoryId}`];
    }
    return [];
  });
  if (snapshotBindingFailures.length) return abstained(snapshotBindingFailures);
  if (!Array.isArray(input.recipeCatalog) || input.recipeCatalog.length === 0 ||
      input.recipeCatalog.length > MAX_RECIPE_CATALOG) {
    return abstained(["recipe_catalog_invalid"]);
  }
  const catalog = [...input.recipeCatalog].sort((left, right) =>
    compareCodeUnits(`${left.id}@${left.version}`, `${right.id}@${right.version}`));
  const recipeIdentities = new Set<string>();
  try {
    for (const recipe of catalog) {
      validateRecipe(recipe);
      const identity = `${recipe.id}@${recipe.version}`;
      if (recipeIdentities.has(identity)) return abstained(["recipe_catalog_duplicate"]);
      recipeIdentities.add(identity);
    }
  } catch {
    return abstained(["recipe_catalog_invalid"]);
  }

  const reasons: string[] = [];
  const repositories = [...input.repositories].sort((left, right) => compareCodeUnits(left.id, right.id));
  const repositoryIds = new Set<string>();
  const blueprintRepositories = [];
  const units = [];
  for (const repository of repositories) {
    if (repositoryIds.has(repository.id)) {
      reasons.push(`repository_duplicate:${repository.id}`);
      continue;
    }
    repositoryIds.add(repository.id);
    if (repository.organizationId !== input.organization.id) {
      reasons.push(`repository_organization_mismatch:${repository.id}`);
      continue;
    }
    if (recipeFilesDigest(repository.files) !== repository.snapshotDigest) {
      reasons.push(`repository_snapshot_digest_mismatch:${repository.id}`);
      continue;
    }
    const fileEvidence = [...repository.fileEvidence].sort((left, right) => compareCodeUnits(left.path, right.path));
    const evidenceByPath = new Map<string, (typeof fileEvidence)[number]>();
    let evidenceInvalid = fileEvidence.length !== Object.keys(repository.files).length;
    for (const evidence of fileEvidence) {
      const content = repository.files[evidence.path];
      if (content === undefined || evidenceByPath.has(evidence.path) || digest(content) !== evidence.digest) {
        evidenceInvalid = true;
      }
      evidenceByPath.set(evidence.path, evidence);
    }
    if (evidenceInvalid) {
      reasons.push(`repository_file_evidence_invalid:${repository.id}`);
      continue;
    }
    const matching = catalog.filter((recipe) =>
      recipe.source === input.objective.sourceSystem &&
      recipe.target === input.objective.targetSystem &&
      analyzeRecipe(recipeReference(recipe), repository.files).status === "applicable");
    if (matching.length === 0) {
      reasons.push(`repository_recipe_not_applicable:${repository.id}`);
      continue;
    }
    if (matching.length > 1) {
      reasons.push(`repository_recipe_ambiguous:${repository.id}`);
      continue;
    }
    const recipe = matching[0]!;
    const reference = recipeReference(recipe);
    const selectedFiles = Object.freeze(Object.fromEntries(recipe.allowedPaths
      .filter((path: string) => repository.files[path] !== undefined)
      .map((path: string) => [path, repository.files[path]!])));
    const selectedEvidence = fileEvidence.filter((evidence) => recipe.allowedPaths.includes(evidence.path));
    const application = applyRecipe(reference, selectedFiles);
    const scopePaths = [...new Set(application.operations.map((operation) => operation.path))]
      .sort(compareCodeUnits);
    const operationOwnerMissing = scopePaths.some(
      (path) => (evidenceByPath.get(path)?.ownerIds.length ?? 0) === 0,
    );
    const ownerIds = [...new Set(scopePaths.flatMap((path) => evidenceByPath.get(path)?.ownerIds ?? []))]
      .sort(compareCodeUnits);
    if (operationOwnerMissing || ownerIds.length === 0) {
      reasons.push(`repository_operation_owner_missing:${repository.id}`);
      continue;
    }
    blueprintRepositories.push({
      id: repository.id,
      snapshotId: repository.snapshotId,
      organizationId: repository.organizationId,
      revision: repository.revision,
      snapshotDigest: recipeFilesDigest(selectedFiles),
      observedAt: repository.observedAt,
      evidenceRefs: [...repository.evidenceRefs],
      supportedRecipes: [reference],
      files: selectedEvidence.map((evidence) => ({
        path: evidence.path,
        digest: evidence.digest,
        ownerIds: [...evidence.ownerIds],
        evidenceRefs: [...evidence.evidenceRefs],
      })),
    });
    units.push({
      id: unitId(repository.id, recipe.id),
      title: `${recipe.title} in ${repository.id}`,
      repositoryId: repository.id,
      dependsOn: [] as string[],
      scopePaths,
      ownerIds,
      recipe: reference,
    });
  }
  if (reasons.length > 0) return abstained(reasons);
  if (units.length === 0) return abstained(["mission_unit_required"]);
  const unitByRepository = new Map(units.map((unit) => [unit.repositoryId, unit.id]));
  const dependencyByRepository = new Map(
    dependencyProjection.repositories.map((repository) => [repository.repositoryId, repository]),
  );
  for (const unit of units) {
    const declared = dependencyByRepository.get(unit.repositoryId)!.dependsOnRepositoryIds;
    unit.dependsOn = [...new Set(declared)]
      .map((repositoryId) => unitByRepository.get(repositoryId))
      .filter((dependencyId): dependencyId is string => Boolean(dependencyId) && dependencyId !== unit.id)
      .sort(compareCodeUnits);
  }

  return planTransformerBlueprint({
    evaluatedAt: input.evaluatedAt,
    plannerActorId: input.plannerActorId,
    maxEvidenceAgeMs: input.maxEvidenceAgeMs,
    constraints: input.constraints,
    organization: input.organization,
    repositories: blueprintRepositories,
    dependencyProjection,
    objective: { ...input.objective, units },
  });
}
