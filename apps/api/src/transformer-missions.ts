import {
  compileApprovedTransformerMission,
  planTransformerMission,
  resolveRecipe,
  verifyTransformerBlueprint,
  type MigrationRecipeContract,
  type OrganizationConstraintContract,
  type TransformerBlueprint,
  type TransformerMissionPlanningRepository,
  type TransformerMissionRepository,
} from "@mendpoint/transformer";
import {
  TransformerCampaignService,
  transformerBlueprintApprovalId,
  type TransformerMutationRequest,
} from "./transformer-control-plane.js";
import { TransformerPilotExecutionService } from "./transformer-pilot-executions.js";

export interface TransformerMissionRepositoryAuthority {
  load(tenantId: string, repositoryId: string, observedAt: string): Readonly<{
    planning: TransformerMissionPlanningRepository;
    execution: TransformerMissionRepository;
  }>;
}

export type TransformerMissionPlanInput = Readonly<{
  campaignId: string;
  environment: string;
  evaluatedAt: string;
  maxEvidenceAgeMs: number;
  constraints: Readonly<{ maxUnits: number; maxRepositories: number; maxPathsPerUnit: number }>;
  organization: Parameters<typeof planTransformerMission>[0]["organization"];
  repositoryIds: readonly string[];
  objective: Parameters<typeof planTransformerMission>[0]["objective"];
}>;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function blueprintPolicy(blueprint: TransformerBlueprint) {
  const recipes = [...new Set(blueprint.units.map((unit) =>
    `${unit.recipe.id}@${unit.recipe.version}:${unit.recipe.digest}`))];
  if (recipes.length !== 1) throw new Error("transformer_mission_mixed_recipe_campaign_unsupported");
  const verificationCommands = [...new Set(blueprint.units.flatMap((unit) =>
    resolveRecipe(unit.recipe).verificationCommands.map((command) => command.command)))]
    .sort(compareCodeUnits);
  return {
    ownerIds: [...new Set(blueprint.units.flatMap((unit) => unit.ownerIds))].sort(compareCodeUnits),
    risks: blueprint.risks,
    unknowns: blueprint.assumptions.map((assumption) => ({
      id: assumption.id,
      question: assumption.statement,
      ownerId: blueprint.units[0]!.ownerIds[0]!,
      evidenceRefs: assumption.evidenceRefs,
    })),
    verification: { commands: verificationCommands },
    rollback: {
      strategy: "inverse_operations" as const,
      verificationCommands,
    },
    approval: { required: true as const, reviewerIds: blueprint.review.reviewerIds },
    recipe: blueprint.units[0]!.recipe,
  };
}

export class TransformerMissionService {
  constructor(
    private readonly control: TransformerCampaignService,
    private readonly executions: TransformerPilotExecutionService,
    private readonly repositories: TransformerMissionRepositoryAuthority,
    private readonly recipeCatalog: readonly MigrationRecipeContract[],
    private readonly constraints: OrganizationConstraintContract,
    private readonly environment: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  plan(request: TransformerMutationRequest, input: TransformerMissionPlanInput) {
    const repositoryIds = [...new Set(input.repositoryIds)].sort(compareCodeUnits);
    if (repositoryIds.length !== input.repositoryIds.length || repositoryIds.length === 0) {
      throw new Error("transformer_mission_repository_invalid");
    }
    const repositories = repositoryIds.map((repositoryId) =>
      this.repositories.load(request.tenantId, repositoryId, input.evaluatedAt).planning);
    const planned = planTransformerMission({
      evaluatedAt: input.evaluatedAt,
      plannerActorId: request.actorId,
      maxEvidenceAgeMs: input.maxEvidenceAgeMs,
      constraints: input.constraints,
      organization: input.organization,
      repositories,
      objective: input.objective,
      recipeCatalog: this.recipeCatalog,
    });
    if (planned.decision === "abstained") return planned;
    const blueprint = planned.blueprint;
    const bsgNodes = blueprint.units.map((unit) => ({
      id: `migration-unit:${unit.id}`,
      kind: "migration_unit",
      spec: `${unit.title}: ${unit.scopePaths.join(", ")}`,
      sourceRefs: [...new Set([
        ...blueprint.objective.evidenceRefs,
        ...blueprint.scope.repositories.find((repository) => repository.id === unit.repositoryId)!
          .paths.flatMap((path) => path.evidenceRefs),
      ])].sort(compareCodeUnits),
    }));
    const control = this.control.createBundle(request, {
      campaign: {
        id: input.campaignId,
        name: blueprint.objective.statement,
        sourceSystem: blueprint.objective.sourceSystem,
        targetSystem: blueprint.objective.targetSystem,
      },
      blueprint: {
        id: blueprint.id,
        objective: blueprint.objective.statement,
        content: blueprint as unknown as Record<string, unknown>,
        policy: blueprintPolicy(blueprint),
      },
      bsg: { id: `bsg-${blueprint.id}`, nodes: bsgNodes, edges: [] },
    });
    return Object.freeze({ decision: "planned" as const, blueprint, control });
  }

  launch(request: TransformerMutationRequest, campaignId: string) {
    const campaign = this.control.store.getCampaign(request.tenantId, campaignId);
    if (!campaign || campaign.state !== "ready") throw new Error("transformer_mission_review_required");
    const stored = this.control.store.getBlueprint(request.tenantId, campaign.blueprintId);
    if (!stored || stored.state !== "reviewed") throw new Error("transformer_mission_review_required");
    const blueprint = verifyTransformerBlueprint(stored.content as unknown as TransformerBlueprint);
    const approvals = blueprint.review.reviewerIds.flatMap((reviewerId) => {
      const approval = this.control.store.getApproval(
        request.tenantId,
        transformerBlueprintApprovalId(blueprint.id, reviewerId),
      );
      return approval?.state === "approved" && approval.reviewerId === reviewerId
        ? [{
            reviewerId,
            blueprintId: blueprint.id,
            blueprintDigest: blueprint.digest,
            approvedAt: approval.createdAt,
            evidenceRefs: [`transformer-control-approval:${approval.id}:revision:${approval.revision}`],
          }]
        : [];
    });
    const executionRepositories = [...new Set(blueprint.units.map((unit) => unit.repositoryId))]
      .sort(compareCodeUnits)
      .map((repositoryId) => this.repositories.load(request.tenantId, repositoryId, this.now()).execution);
    const compiled = compileApprovedTransformerMission({
      tenantId: request.tenantId,
      organizationId: blueprint.evidence.organization.id,
      environment: this.environment,
      campaignId,
      blueprint,
      approvals,
      repositories: executionRepositories,
      constraints: this.constraints,
      observedAt: this.now(),
      evidenceRefs: request.evidenceRefs,
      idempotencyKey: request.idempotencyKey,
    });
    return this.executions.create(request, compiled);
  }
}
