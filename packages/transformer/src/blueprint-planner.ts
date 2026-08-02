import { createHash } from "node:crypto";
import {
  resolveRecipe,
  type RecipeReference,
  type RecipeVerificationCommand,
} from "./recipe.js";

const BLUEPRINT_SCHEMA_VERSION = "2026-08-02.v1" as const;
const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_TEXT = 1_000;
const ABSOLUTE_MAX_UNITS = 100;
const ABSOLUTE_MAX_REPOSITORIES = 50;
const ABSOLUTE_MAX_PATHS_PER_UNIT = 50;
const ABSOLUTE_MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export type TransformerBlueprintFileEvidence = {
  path: string;
  digest: string;
  ownerIds: string[];
  evidenceRefs: string[];
};

export type TransformerBlueprintRepositoryEvidence = {
  id: string;
  organizationId: string;
  revision: string;
  snapshotDigest: string;
  observedAt: string;
  evidenceRefs: string[];
  supportedRecipes: RecipeReference[];
  files: TransformerBlueprintFileEvidence[];
};

export type TransformerBlueprintOrganizationEvidence = {
  id: string;
  revision: string;
  digest: string;
  observedAt: string;
  repositoryIds: string[];
  memberIds: string[];
  evidenceRefs: string[];
  humanReviewPolicy: {
    required: boolean;
    minimumApprovals: number;
    reviewerIds: string[];
    prohibitPlannerApproval: boolean;
  };
};

export type TransformerObjectiveUnit = {
  id: string;
  title: string;
  repositoryId: string;
  dependsOn: string[];
  scopePaths: string[];
  ownerIds: string[];
  recipe: RecipeReference;
};

export type TransformerObjective = {
  id: string;
  statement: string;
  sourceSystem: string;
  targetSystem: string;
  evidenceRefs: string[];
  assumptions: Array<{
    id: string;
    statement: string;
    evidenceRefs: string[];
  }>;
  risks: Array<{
    id: string;
    statement: string;
    severity: "low" | "medium" | "high" | "critical";
    ownerId: string;
    evidenceRefs: string[];
  }>;
  units: TransformerObjectiveUnit[];
};

export type TransformerBlueprintPlanningInput = {
  evaluatedAt: string;
  plannerActorId: string;
  maxEvidenceAgeMs: number;
  constraints: {
    maxUnits: number;
    maxRepositories: number;
    maxPathsPerUnit: number;
  };
  organization: TransformerBlueprintOrganizationEvidence;
  repositories: TransformerBlueprintRepositoryEvidence[];
  objective: TransformerObjective;
};

export type TransformerBlueprint = Readonly<{
  schemaVersion: typeof BLUEPRINT_SCHEMA_VERSION;
  id: string;
  digest: string;
  evaluatedAt: string;
  objective: Readonly<{
    id: string;
    statement: string;
    sourceSystem: string;
    targetSystem: string;
    evidenceRefs: readonly string[];
  }>;
  evidence: Readonly<{
    organization: Readonly<{
      id: string;
      revision: string;
      digest: string;
      observedAt: string;
      evidenceRefs: readonly string[];
    }>;
    repositories: readonly Readonly<{
      id: string;
      revision: string;
      snapshotDigest: string;
      observedAt: string;
      evidenceRefs: readonly string[];
    }>[];
  }>;
  scope: Readonly<{
    repositories: readonly Readonly<{
      id: string;
      revision: string;
      snapshotDigest: string;
      paths: readonly Readonly<{
        path: string;
        digest: string;
        ownerIds: readonly string[];
        evidenceRefs: readonly string[];
      }>[];
    }>[];
  }>;
  units: readonly Readonly<{
    id: string;
    title: string;
    repositoryId: string;
    repositoryRevision: string;
    repositorySnapshotDigest: string;
    dependsOn: readonly string[];
    scopePaths: readonly string[];
    ownerIds: readonly string[];
    recipe: RecipeReference;
    verification: readonly RecipeVerificationCommand[];
    rollback: Readonly<{
      strategy: "inverse_operations";
      requireCurrentDigest: true;
      successCriteria: readonly string[];
    }>;
  }>[];
  waves: readonly Readonly<{ id: string; unitIds: readonly string[] }>[];
  constraints: Readonly<{
    maxUnits: number;
    maxRepositories: number;
    maxPathsPerUnit: number;
    maxEvidenceAgeMs: number;
  }>;
  owners: readonly Readonly<{ unitId: string; ownerIds: readonly string[] }>[];
  review: Readonly<{
    state: "awaiting_human_review";
    required: true;
    plannerActorId: string;
    minimumApprovals: number;
    reviewerIds: readonly string[];
    prohibitPlannerApproval: true;
  }>;
  assumptions: readonly Readonly<{
    id: string;
    statement: string;
    evidenceRefs: readonly string[];
  }>[];
  risks: readonly Readonly<{
    id: string;
    statement: string;
    severity: "low" | "medium" | "high" | "critical";
    ownerId: string;
    evidenceRefs: readonly string[];
  }>[];
  abstentionReasons: readonly [];
  automation: Readonly<{
    mayMutate: false;
    mayApprove: false;
    mayMerge: false;
    mayDeploy: false;
  }>;
}>;

export type TransformerBlueprintPlanningResult =
  | Readonly<{ decision: "planned"; reasons: readonly []; blueprint: TransformerBlueprint }>
  | Readonly<{ decision: "abstained"; reasons: readonly string[]; blueprint: null }>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function add(reasons: Set<string>, reason: string): void {
  reasons.add(reason);
}

function text(value: unknown, code: string, reasons: Set<string>): value is string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > MAX_TEXT) {
    add(reasons, code);
    return false;
  }
  return true;
}

function uniqueText(values: unknown, code: string, reasons: Set<string>): values is string[] {
  if (!Array.isArray(values) || !values.length || values.some((value) => !text(value, code, reasons))) {
    add(reasons, code);
    return false;
  }
  if (new Set(values).size !== values.length) add(reasons, code);
  return true;
}

function validInstant(value: unknown, code: string, reasons: Set<string>): number | undefined {
  if (typeof value !== "string") {
    add(reasons, code);
    return undefined;
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    add(reasons, code);
    return undefined;
  }
  return epoch;
}

function checkFreshness(
  observedAt: unknown,
  evaluatedEpoch: number | undefined,
  maxAgeMs: number,
  code: string,
  reasons: Set<string>,
): void {
  const scopedCode = (suffix: string) => {
    const separator = code.indexOf(":");
    return separator < 0
      ? `${code}_${suffix}`
      : `${code.slice(0, separator)}_${suffix}:${code.slice(separator + 1)}`;
  };
  const observedEpoch = validInstant(observedAt, scopedCode("timestamp_invalid"), reasons);
  if (observedEpoch === undefined || evaluatedEpoch === undefined) return;
  if (observedEpoch > evaluatedEpoch || evaluatedEpoch - observedEpoch > maxAgeMs) {
    add(reasons, scopedCode("stale"));
  }
}

function boundedPositiveInteger(value: unknown, maximum: number, code: string, reasons: Set<string>): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    add(reasons, code);
    return 0;
  }
  return value as number;
}

function recipeKey(reference: RecipeReference): string {
  return `${reference.id}@${reference.version}:${reference.digest}`;
}

function dependencyWaves(units: readonly TransformerObjectiveUnit[], reasons: Set<string>): string[][] {
  const byId = new Map<string, TransformerObjectiveUnit>();
  for (const unit of units) {
    if (byId.has(unit.id)) add(reasons, `objective_unit_conflict:${unit.id}`);
    else byId.set(unit.id, unit);
  }
  for (const unit of units) {
    if (new Set(unit.dependsOn).size !== unit.dependsOn.length) {
      add(reasons, `objective_dependency_conflict:${unit.id}`);
    }
    for (const dependency of unit.dependsOn) {
      if (!byId.has(dependency)) add(reasons, `objective_dependency_missing:${unit.id}:${dependency}`);
      if (dependency === unit.id) add(reasons, `objective_dependency_self:${unit.id}`);
    }
  }
  if (reasons.size) return [];

  const completed = new Set<string>();
  const remaining = new Set([...byId.keys()]);
  const waves: string[][] = [];
  while (remaining.size) {
    const wave = [...remaining]
      .filter((id) => byId.get(id)!.dependsOn.every((dependency) => completed.has(dependency)))
      .sort((left, right) => left.localeCompare(right));
    if (!wave.length) {
      add(reasons, `objective_dependency_cycle:${[...remaining].sort().join(",")}`);
      return [];
    }
    waves.push(wave);
    for (const id of wave) {
      remaining.delete(id);
      completed.add(id);
    }
  }
  return waves;
}

function abstained(reasons: Set<string>): TransformerBlueprintPlanningResult {
  return deepFreeze({
    decision: "abstained" as const,
    reasons: [...reasons].sort((left, right) => left.localeCompare(right)),
    blueprint: null,
  });
}

/**
 * Produce an evidence bound plan for human review. This function never reads a
 * workspace, runs a command, changes a repository, approves, merges, or deploys.
 */
export function planTransformerBlueprint(
  input: TransformerBlueprintPlanningInput,
): TransformerBlueprintPlanningResult {
  const reasons = new Set<string>();
  if (!input || typeof input !== "object") return abstained(new Set(["planning_input_required"]));

  const evaluatedEpoch = validInstant(input.evaluatedAt, "evaluated_at_invalid", reasons);
  text(input.plannerActorId, "planner_actor_required", reasons);
  const maxEvidenceAgeMs = boundedPositiveInteger(
    input.maxEvidenceAgeMs,
    ABSOLUTE_MAX_EVIDENCE_AGE_MS,
    "evidence_age_limit_invalid",
    reasons,
  );
  const maxUnits = boundedPositiveInteger(
    input.constraints?.maxUnits,
    ABSOLUTE_MAX_UNITS,
    "unit_limit_invalid",
    reasons,
  );
  const maxRepositories = boundedPositiveInteger(
    input.constraints?.maxRepositories,
    ABSOLUTE_MAX_REPOSITORIES,
    "repository_limit_invalid",
    reasons,
  );
  const maxPathsPerUnit = boundedPositiveInteger(
    input.constraints?.maxPathsPerUnit,
    ABSOLUTE_MAX_PATHS_PER_UNIT,
    "path_limit_invalid",
    reasons,
  );

  const organization = input.organization;
  if (!organization || typeof organization !== "object") {
    add(reasons, "organization_evidence_required");
    return abstained(reasons);
  }
  text(organization.id, "organization_id_required", reasons);
  if (!REVISION.test(organization.revision)) add(reasons, "organization_revision_invalid");
  if (!DIGEST.test(organization.digest)) add(reasons, "organization_digest_invalid");
  checkFreshness(
    organization.observedAt,
    evaluatedEpoch,
    maxEvidenceAgeMs,
    "organization_evidence",
    reasons,
  );
  uniqueText(organization.repositoryIds, "organization_repository_ids_invalid", reasons);
  uniqueText(organization.memberIds, "organization_member_ids_invalid", reasons);
  uniqueText(organization.evidenceRefs, "organization_evidence_refs_invalid", reasons);
  const organizationRepositoryIds = Array.isArray(organization.repositoryIds)
    ? organization.repositoryIds.filter((value): value is string => typeof value === "string")
    : [];
  const organizationMemberIds = Array.isArray(organization.memberIds)
    ? organization.memberIds.filter((value): value is string => typeof value === "string")
    : [];

  const review = organization.humanReviewPolicy;
  if (!review?.required || !review.prohibitPlannerApproval) add(reasons, "human_review_policy_required");
  const minimumApprovals = boundedPositiveInteger(
    review?.minimumApprovals,
    20,
    "human_review_approval_count_invalid",
    reasons,
  );
  const rawReviewerIds = Array.isArray(review?.reviewerIds) ? review.reviewerIds : [];
  uniqueText(rawReviewerIds, "human_review_reviewers_invalid", reasons);
  const reviewerIds = [...new Set(
    rawReviewerIds.filter((value): value is string => typeof value === "string"),
  )].sort();
  if (!reviewerIds.length || reviewerIds.length !== rawReviewerIds.length) {
    add(reasons, "human_review_reviewers_invalid");
  }
  if (reviewerIds.some((reviewerId) => !organizationMemberIds.includes(reviewerId))) {
    add(reasons, "human_review_reviewer_not_member");
  }
  const independentReviewers = reviewerIds.filter((reviewerId) => reviewerId !== input.plannerActorId);
  if (!independentReviewers.length) add(reasons, "independent_human_reviewer_required");
  else if (minimumApprovals > independentReviewers.length) add(reasons, "human_review_approval_count_unreachable");

  const repositories = Array.isArray(input.repositories) ? input.repositories : [];
  if (!repositories.length) add(reasons, "repository_evidence_required");
  if (maxRepositories && repositories.length > maxRepositories) add(reasons, "repository_scope_exceeds_limit");
  const repositoryById = new Map<string, TransformerBlueprintRepositoryEvidence>();
  for (const repository of repositories) {
    if (!repository || typeof repository !== "object" || !text(repository.id, "repository_id_invalid", reasons)) {
      continue;
    }
    if (repositoryById.has(repository.id)) {
      add(reasons, `repository_evidence_conflict:${repository.id}`);
      continue;
    }
    repositoryById.set(repository.id, repository);
    if (repository.organizationId !== organization.id || !organizationRepositoryIds.includes(repository.id)) {
      add(reasons, `repository_organization_conflict:${repository.id}`);
    }
    if (!REVISION.test(repository.revision)) add(reasons, `repository_revision_invalid:${repository.id}`);
    if (!DIGEST.test(repository.snapshotDigest)) add(reasons, `repository_digest_invalid:${repository.id}`);
    checkFreshness(
      repository.observedAt,
      evaluatedEpoch,
      maxEvidenceAgeMs,
      `repository_evidence:${repository.id}`,
      reasons,
    );
    uniqueText(repository.evidenceRefs, `repository_evidence_refs_invalid:${repository.id}`, reasons);
    if (!Array.isArray(repository.supportedRecipes) || !repository.supportedRecipes.length) {
      add(reasons, `repository_supported_recipes_missing:${repository.id}`);
    }
    const filePaths = new Set<string>();
    if (!Array.isArray(repository.files) || !repository.files.length) {
      add(reasons, `repository_file_evidence_missing:${repository.id}`);
      continue;
    }
    for (const file of repository.files) {
      if (!file || !text(file.path, `repository_path_invalid:${repository.id}`, reasons)) continue;
      if (filePaths.has(file.path)) add(reasons, `repository_path_evidence_conflict:${repository.id}:${file.path}`);
      filePaths.add(file.path);
      if (!DIGEST.test(file.digest)) add(reasons, `repository_path_digest_invalid:${repository.id}:${file.path}`);
      uniqueText(file.ownerIds, `repository_path_owners_invalid:${repository.id}:${file.path}`, reasons);
      uniqueText(file.evidenceRefs, `repository_path_refs_invalid:${repository.id}:${file.path}`, reasons);
    }
  }

  const objective = input.objective;
  if (!objective || typeof objective !== "object") {
    add(reasons, "objective_required");
    return abstained(reasons);
  }
  text(objective.id, "objective_id_required", reasons);
  text(objective.statement, "objective_statement_required", reasons);
  text(objective.sourceSystem, "objective_source_required", reasons);
  text(objective.targetSystem, "objective_target_required", reasons);
  uniqueText(objective.evidenceRefs, "objective_evidence_refs_required", reasons);
  if (!Array.isArray(objective.assumptions) || !objective.assumptions.length) {
    add(reasons, "objective_assumptions_required");
  }
  if (!Array.isArray(objective.risks) || !objective.risks.length) add(reasons, "objective_risks_required");
  const objectiveAssumptions = Array.isArray(objective.assumptions) ? objective.assumptions : [];
  const assumptions = objectiveAssumptions.map((assumption) => {
    text(assumption.id, "objective_assumption_id_invalid", reasons);
    text(assumption.statement, `objective_assumption_statement_invalid:${assumption.id}`, reasons);
    uniqueText(assumption.evidenceRefs, `objective_assumption_evidence_invalid:${assumption.id}`, reasons);
    return {
      id: assumption.id,
      statement: assumption.statement,
      evidenceRefs: [...assumption.evidenceRefs].sort(),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(assumptions.map((assumption) => assumption.id)).size !== assumptions.length) {
    add(reasons, "objective_assumption_conflict");
  }
  const objectiveRisks = Array.isArray(objective.risks) ? objective.risks : [];
  const risks = objectiveRisks.map((risk) => {
    text(risk.id, "objective_risk_id_invalid", reasons);
    text(risk.statement, `objective_risk_statement_invalid:${risk.id}`, reasons);
    if (!["low", "medium", "high", "critical"].includes(risk.severity)) {
      add(reasons, `objective_risk_severity_invalid:${risk.id}`);
    }
    if (!organizationMemberIds.includes(risk.ownerId)) add(reasons, `objective_risk_owner_invalid:${risk.id}`);
    uniqueText(risk.evidenceRefs, `objective_risk_evidence_invalid:${risk.id}`, reasons);
    return {
      id: risk.id,
      statement: risk.statement,
      severity: risk.severity,
      ownerId: risk.ownerId,
      evidenceRefs: [...risk.evidenceRefs].sort(),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(risks.map((risk) => risk.id)).size !== risks.length) add(reasons, "objective_risk_conflict");

  const units = Array.isArray(objective.units) ? objective.units : [];
  if (!units.length) add(reasons, "objective_units_required");
  if (maxUnits && units.length > maxUnits) add(reasons, "objective_units_exceed_limit");
  const normalizedUnits: Array<TransformerBlueprint["units"][number]> = [];
  const referencedRepositories = new Set<string>();
  for (const unit of units) {
    if (!unit || typeof unit !== "object" || !text(unit.id, "objective_unit_id_invalid", reasons)) continue;
    text(unit.title, `objective_unit_title_invalid:${unit.id}`, reasons);
    text(unit.repositoryId, `objective_unit_repository_invalid:${unit.id}`, reasons);
    if (!Array.isArray(unit.dependsOn)) {
      add(reasons, `objective_dependencies_invalid:${unit.id}`);
      continue;
    }
    if (!uniqueText(unit.scopePaths, `objective_scope_invalid:${unit.id}`, reasons)) continue;
    if (maxPathsPerUnit && unit.scopePaths.length > maxPathsPerUnit) {
      add(reasons, `objective_scope_exceeds_limit:${unit.id}`);
    }
    if (!uniqueText(unit.ownerIds, `objective_owners_invalid:${unit.id}`, reasons)) continue;
    if (unit.ownerIds.some((ownerId) => !organizationMemberIds.includes(ownerId))) {
      add(reasons, `objective_owner_not_member:${unit.id}`);
    }
    const repository = repositoryById.get(unit.repositoryId);
    if (!repository) {
      add(reasons, `repository_evidence_missing:${unit.repositoryId}`);
      continue;
    }
    referencedRepositories.add(repository.id);

    let recipe;
    try {
      recipe = resolveRecipe(unit.recipe);
    } catch {
      add(reasons, `objective_recipe_unsupported:${unit.id}`);
      continue;
    }
    if (recipe.source !== objective.sourceSystem || recipe.target !== objective.targetSystem) {
      add(reasons, `objective_recipe_target_mismatch:${unit.id}`);
    }
    if (!Array.isArray(repository.supportedRecipes) ||
      !repository.supportedRecipes.some((reference) => recipeKey(reference) === recipeKey(unit.recipe))) {
      add(reasons, `repository_recipe_evidence_missing:${unit.id}`);
    }
    for (const path of unit.scopePaths) {
      if (!recipe.allowedPaths.includes(path)) add(reasons, `objective_recipe_path_unsupported:${unit.id}:${path}`);
      const repositoryFiles = Array.isArray(repository.files) ? repository.files : [];
      const file = repositoryFiles.find((entry) => entry.path === path);
      if (!file) {
        add(reasons, `repository_path_evidence_missing:${unit.id}:${path}`);
      } else if (!file.ownerIds.some((ownerId) => unit.ownerIds.includes(ownerId))) {
        add(reasons, `repository_path_owner_mismatch:${unit.id}:${path}`);
      }
    }
    normalizedUnits.push({
      id: unit.id,
      title: unit.title,
      repositoryId: repository.id,
      repositoryRevision: repository.revision,
      repositorySnapshotDigest: repository.snapshotDigest,
      dependsOn: [...(unit.dependsOn ?? [])].sort(),
      scopePaths: [...unit.scopePaths].sort(),
      ownerIds: [...unit.ownerIds].sort(),
      recipe: { ...unit.recipe },
      verification: recipe.verificationCommands.map((command) => ({ ...command })),
      rollback: {
        strategy: "inverse_operations",
        requireCurrentDigest: true,
        successCriteria: [
          `Restore repository ${repository.id} to revision ${repository.revision}`,
          `Restore snapshot digest ${repository.snapshotDigest}`,
        ],
      },
    });
  }

  if (maxRepositories && referencedRepositories.size > maxRepositories) {
    add(reasons, "objective_repository_scope_exceeds_limit");
  }
  const waves = reasons.size ? [] : dependencyWaves(units, reasons);
  if (reasons.size) return abstained(reasons);

  normalizedUnits.sort((left, right) => left.id.localeCompare(right.id));
  const repositoryScope = [...referencedRepositories]
    .sort()
    .map((repositoryId) => {
      const repository = repositoryById.get(repositoryId)!;
      const paths = [...new Set(
        units
          .filter((unit) => unit.repositoryId === repositoryId)
          .flatMap((unit) => unit.scopePaths),
      )].sort();
      return {
        id: repository.id,
        revision: repository.revision,
        snapshotDigest: repository.snapshotDigest,
        paths: paths.map((path) => {
          const file = repository.files.find((entry) => entry.path === path)!;
          return {
            path,
            digest: file.digest,
            ownerIds: [...file.ownerIds].sort(),
            evidenceRefs: [...file.evidenceRefs].sort(),
          };
        }),
      };
    });

  const blueprintBody = {
    schemaVersion: BLUEPRINT_SCHEMA_VERSION,
    evaluatedAt: input.evaluatedAt,
    objective: {
      id: objective.id,
      statement: objective.statement,
      sourceSystem: objective.sourceSystem,
      targetSystem: objective.targetSystem,
      evidenceRefs: [...objective.evidenceRefs].sort(),
    },
    evidence: {
      organization: {
        id: organization.id,
        revision: organization.revision,
        digest: organization.digest,
        observedAt: organization.observedAt,
        evidenceRefs: [...organization.evidenceRefs].sort(),
      },
      repositories: [...referencedRepositories].sort().map((repositoryId) => {
        const repository = repositoryById.get(repositoryId)!;
        return {
          id: repository.id,
          revision: repository.revision,
          snapshotDigest: repository.snapshotDigest,
          observedAt: repository.observedAt,
          evidenceRefs: [...repository.evidenceRefs].sort(),
        };
      }),
    },
    scope: { repositories: repositoryScope },
    units: normalizedUnits,
    waves: waves.map((unitIds, index) => ({ id: `wave-${String(index + 1).padStart(3, "0")}`, unitIds })),
    constraints: { maxUnits, maxRepositories, maxPathsPerUnit, maxEvidenceAgeMs },
    owners: normalizedUnits.map((unit) => ({ unitId: unit.id, ownerIds: unit.ownerIds })),
    review: {
      state: "awaiting_human_review" as const,
      required: true as const,
      plannerActorId: input.plannerActorId,
      minimumApprovals,
      reviewerIds,
      prohibitPlannerApproval: true as const,
    },
    assumptions,
    risks,
    abstentionReasons: [] as [],
    automation: {
      mayMutate: false as const,
      mayApprove: false as const,
      mayMerge: false as const,
      mayDeploy: false as const,
    },
  };
  const digest = sha256(blueprintBody);
  const blueprint = deepFreeze({
    ...blueprintBody,
    id: `tfb_${digest.slice("sha256:".length, "sha256:".length + 24)}`,
    digest,
  }) satisfies TransformerBlueprint;
  return deepFreeze({ decision: "planned" as const, reasons: [] as [], blueprint });
}
