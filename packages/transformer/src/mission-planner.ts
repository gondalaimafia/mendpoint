import { createHash } from "node:crypto";
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

export type TransformerMissionPlanningRepository = Readonly<{
  id: string;
  organizationId: string;
  revision: string;
  snapshotDigest: string;
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
  /**
   * Repository-id → repository-ids this unit depends on, from a consulted Change
   * Graph. Absent or empty means the planner does not invent dependencies.
   */
  dependsOnByRepositoryId?: Readonly<Record<string, readonly string[]>>;
}>;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
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
  for (const unit of units) {
    const declared = input.dependsOnByRepositoryId?.[unit.repositoryId] ?? [];
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
    objective: { ...input.objective, units },
  });
}
