import { createHash } from "node:crypto";
import {
  appendDomainEvent,
  createDb,
  createMission,
  getMission,
  getPrincipalBySubject,
  getTenant,
  insertPrincipal,
  insertTenant,
  linkRegaugeCampaignToMission,
  listConnectedRepositories,
  listDomainEvents,
  listRepositorySnapshots,
  listScmConnections,
  putTenantMembership,
  regaugeMissionId,
  transitionMission,
  upsertGitHubInstallation,
  verifyDomainEventIntegrity,
  type AppDb,
  type MissionState,
} from "@mendpoint/db";
import {
  InstallationTokenCache,
  defaultListInstallationRepositories,
  loadAppCredentials,
  resolveGitHubTenantAccountBinding,
  type InstallationRepository,
} from "@mendpoint/github";
import {
  CredentialBroker,
  type SecretProvider,
  type SecretReference,
} from "@mendpoint/platform";
import {
  AWS_SDK_JS_V2_TO_V3_RECIPE,
  GOOGLEAPIS_V25_TO_V26_RECIPE,
  NODE_RUNTIME_18_TO_20_RECIPE,
  NODE_RUNTIME_20_TO_22_RECIPE,
  REACT_DOM_17_TO_18_RECIPE,
  STRIPE_NODE_V10_TO_V11_RECIPE,
  verifyTransformerBlueprint,
  type TransformerBlueprint,
} from "@mendpoint/transformer";
import {
  bootstrapRegaugeProductionCampaign,
  type RegaugeProductionBootstrapInput,
  type RegaugeProductionBootstrapReceipt,
  type RegaugeProductionBootstrapRuntime,
  type RegaugeProductionControl,
  type RegaugeProductionExecution,
} from "./regauge-production-bootstrap.js";
import {
  materializeConnectedRepository,
  registerConnectedRepository,
  registerScmConnection,
  type RepositoryConnectionDependencies,
} from "./repository-connections.js";
import { TransformerCampaignService } from "./transformer-control-plane.js";
import { createAppDbTransformerMissionAuthority } from "./transformer-mission-authority.js";
import { TransformerMissionService } from "./transformer-missions.js";
import { TransformerPilotExecutionService } from "./transformer-pilot-executions.js";

const RECEIPT_SCHEMA = "2026-08-14.v1" as const;
const RECEIPT_EVENT = "regauge.production.bootstrap.completed";
const RECEIPT_AGGREGATE = "regauge_production_bootstrap";
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RECIPE_CATALOG = Object.freeze([
  NODE_RUNTIME_18_TO_20_RECIPE,
  NODE_RUNTIME_20_TO_22_RECIPE,
  AWS_SDK_JS_V2_TO_V3_RECIPE,
  STRIPE_NODE_V10_TO_V11_RECIPE,
  GOOGLEAPIS_V25_TO_V26_RECIPE,
  REACT_DOM_17_TO_18_RECIPE,
]);

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 24)}`;
}

// Ordered ReGauge mission lifecycle up to the point a launch can honestly claim.
// The full section 8.6 model continues verifying -> awaiting_review -> accepted|
// rejected|partial|failed, but those depend on the ASYNC attempt outcome that the
// launch seam never observes (it is produced later by the worker pilot lane,
// which has no request principal and no mission-advance wiring today). They are
// therefore deliberately left unreachable from here.
const REGAUGE_MISSION_LAUNCH_ORDER: readonly MissionState[] = [
  "created",
  "discovering",
  "scoped",
  "planning",
  "executing",
];

/**
 * Create-or-bind the App-DB Mission for a ReGauge control-plane campaign at the
 * live LAUNCH seam and advance it to `executing`.
 *
 * This is the single place on the production ReGauge path where a real principal
 * AND the exact verified repository snapshot coexist: the control-plane campaign
 * is created on a different surface (POST /regauge/control-plane/campaigns) that
 * has neither, and the production orchestration launches through the mission
 * plan/launch service, which carries the snapshot but creates no mission. So the
 * mission is born here, bound to what it was launched from, and advanced.
 *
 * Scope binding is FAIL-CLOSED. The mission row carries a SINGLE
 * repository_id/snapshot_id, which is honest only when the campaign launched
 * exactly one repository. For any other count we bind NEITHER (null) rather than
 * privileging one repository: per-unit scope belongs on a per-migration-task
 * object that does not exist yet, and asserting a single-repo scope for a
 * multi-repo campaign would be a fabricated claim. The production bootstrap is
 * structurally single-repo (mapExecution enforces one unit), so the bound branch
 * is the live one; the null branch is the guard.
 *
 * Advance is idempotent and tolerant of partial prior progress: each step runs
 * only from its immediate predecessor state, so a replayed launch (or a mission
 * already advanced) is a no-op rather than an illegal transition or a CAS throw.
 */
export function bindRegaugeMissionAtLaunch(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    campaignId: string;
    ownerPrincipalId: string;
    objective: string;
    repositories: readonly Readonly<{ repositoryId: string; snapshotId: string }>[];
    createdAt: string;
  }>,
): void {
  const missionId = regaugeMissionId(input.tenantId, input.campaignId);
  const scope = input.repositories.length === 1 ? input.repositories[0]! : null;
  const objective = input.objective.trim().slice(0, 200) || input.campaignId;
  createMission(db, {
    id: missionId,
    tenantId: input.tenantId,
    product: "regauge",
    triggerKind: "migration_objective",
    objective,
    ownerPrincipalId: input.ownerPrincipalId,
    repositoryId: scope?.repositoryId ?? null,
    snapshotId: scope?.snapshotId ?? null,
    eventId: `${missionId}-created`,
    idempotencyKey: `mission-create-${missionId}`,
    correlationId: input.campaignId,
    createdAt: input.createdAt,
  });
  linkRegaugeCampaignToMission(db, {
    tenantId: input.tenantId,
    missionId,
    regaugeCampaignId: input.campaignId,
    actorPrincipalId: input.ownerPrincipalId,
    eventId: `${missionId}-linked`,
    idempotencyKey: `mission-link-${missionId}`,
    correlationId: input.campaignId,
    createdAt: input.createdAt,
  });
  // By the time launch runs, the orchestrator has already proven the campaign is
  // reviewed and approved (campaignState === "ready"), so discovery, scoping, and
  // planning are accomplished facts on the way to `executing`, not guesses.
  for (let i = 1; i < REGAUGE_MISSION_LAUNCH_ORDER.length; i += 1) {
    const to = REGAUGE_MISSION_LAUNCH_ORDER[i]!;
    const current = getMission(db, input.tenantId, missionId);
    if (!current) return;
    const fromIndex = REGAUGE_MISSION_LAUNCH_ORDER.indexOf(current.state);
    if (fromIndex < 0) return; // mission left the linear path (cancelled/failed); do not force
    if (fromIndex >= i) continue; // already at or past this state (idempotent replay)
    if (fromIndex !== i - 1) return; // a gap we cannot honestly bridge; stop
    transitionMission(db, {
      tenantId: input.tenantId,
      missionId,
      expectedRevision: current.revision,
      to,
      actorPrincipalId: input.ownerPrincipalId,
      eventId: `${missionId}-transition-${to}`,
      idempotencyKey: `mission-transition-${missionId}-${to}`,
      correlationId: input.campaignId,
      createdAt: input.createdAt,
    });
  }
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`regauge_production_bootstrap_${name.toLowerCase()}_required`);
  return value;
}

function evidenceRefs(value: string): string[] {
  const refs = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!refs.length || refs.length !== new Set(refs).size) {
    throw new Error("regauge_production_bootstrap_evidence_invalid");
  }
  return refs;
}

export function regaugeProductionBootstrapInputFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RegaugeProductionBootstrapInput {
  const tenantId = required(env, "MENDPOINT_REGAUGE_TENANT_ID");
  const accountId = resolveGitHubTenantAccountBinding(tenantId, env);
  if (!accountId) throw new Error("regauge_production_bootstrap_account_binding_required");
  const owner = required(env, "MENDPOINT_REGAUGE_CANARY_OWNER");
  return {
    tenantId,
    campaignId: required(env, "MENDPOINT_REGAUGE_CAMPAIGN_ID"),
    environment: required(env, "MENDPOINT_REGAUGE_ENVIRONMENT"),
    repository: {
      owner,
      name: required(env, "MENDPOINT_REGAUGE_CANARY_REPOSITORY"),
      remoteRepositoryId: required(env, "MENDPOINT_REGAUGE_CANARY_REPOSITORY_ID"),
      defaultBranch: required(env, "MENDPOINT_REGAUGE_CANARY_DEFAULT_BRANCH"),
      selectedBranch: required(env, "MENDPOINT_REGAUGE_CANARY_BRANCH"),
      expectedRevision: required(env, "MENDPOINT_REGAUGE_CANARY_REVISION"),
      installationId: required(env, "MENDPOINT_REGAUGE_GITHUB_INSTALLATION_ID"),
      accountId,
      accountLogin: owner,
    },
    plannerActorId: "service:regauge-production-bootstrap",
    reviewer: {
      issuer: required(env, "MENDPOINT_REGAUGE_REVIEWER_ISSUER"),
      subject: required(env, "MENDPOINT_REGAUGE_REVIEWER_SUBJECT"),
      displayName: required(env, "MENDPOINT_REGAUGE_REVIEWER_DISPLAY_NAME"),
      email: env.MENDPOINT_REGAUGE_REVIEWER_EMAIL?.trim() || null,
    },
    objective: {
      id: "regauge-node-20-to-22-canary",
      statement: "Upgrade the approved canary from Node 20 to Node 22.",
      sourceSystem: "node@20",
      targetSystem: "node@22",
    },
    gateConfig: required(env, "MENDPOINT_REGAUGE_GATE"),
    productionApprovalRef: required(env, "MENDPOINT_REGAUGE_PRODUCTION_APPROVAL_REF"),
    evidenceRefs: evidenceRefs(required(env, "MENDPOINT_REGAUGE_EVIDENCE_REFS")),
  };
}

type RuntimeOptions = Readonly<{
  db: AppDb;
  control: TransformerCampaignService;
  executions: TransformerPilotExecutionService;
  missions: TransformerMissionService;
  repositoryDependencies: RepositoryConnectionDependencies;
  listInstallationRepositories(): Promise<readonly InstallationRepository[]>;
  now?: () => string;
}>;

function receiptFromEvent(
  event: ReturnType<typeof listDomainEvents>[number],
): RegaugeProductionBootstrapReceipt {
  let payload: unknown;
  try { payload = JSON.parse(event.payload_json); } catch { throw new Error("regauge_production_bootstrap_receipt_invalid"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("regauge_production_bootstrap_receipt_invalid");
  }
  const value = payload as Record<string, unknown>;
  const receipt = {
    ...value,
    eventHash: `sha256:${event.event_hash}`,
  } as RegaugeProductionBootstrapReceipt;
  if (
    receipt.schemaVersion !== RECEIPT_SCHEMA ||
    !SHA256.test(receipt.requestDigest) || !SHA256.test(receipt.snapshotDigest) ||
    !SHA256.test(receipt.blueprintDigest) || !SHA256.test(receipt.eventHash) ||
    event.aggregate_id !== receipt.campaignId
  ) {
    throw new Error("regauge_production_bootstrap_receipt_invalid");
  }
  return Object.freeze(structuredClone(receipt));
}

function mapControl(
  options: RuntimeOptions,
  tenantId: string,
  campaignId: string,
): RegaugeProductionControl | undefined {
  const campaign = options.control.store.getCampaign(tenantId, campaignId);
  if (!campaign) return undefined;
  const storedBlueprint = options.control.store.getBlueprint(tenantId, campaign.blueprintId);
  const bsg = options.control.store.getBsg(tenantId, campaign.bsgId);
  if (!storedBlueprint || !bsg) throw new Error("regauge_production_bootstrap_control_drift");
  const blueprint = verifyTransformerBlueprint(storedBlueprint.content as TransformerBlueprint);
  if (blueprint.evidence.repositories.length !== 1 || blueprint.units.length !== 1) {
    throw new Error("regauge_production_bootstrap_control_drift");
  }
  const repository = blueprint.evidence.repositories[0]!;
  const snapshots = listRepositorySnapshots(options.db, tenantId, repository.id)
    .filter((snapshot) => snapshot.resolved_sha === repository.revision);
  if (snapshots.length !== 1) throw new Error("regauge_production_bootstrap_snapshot_ambiguous");
  const campaignState = campaign.state;
  const blueprintState = storedBlueprint.state;
  if ((campaignState !== "draft" && campaignState !== "ready") ||
      (blueprintState !== "draft" && blueprintState !== "reviewed")) {
    throw new Error("regauge_production_bootstrap_control_drift");
  }
  return Object.freeze({
    campaignId: campaign.id,
    campaignState,
    campaignRevision: campaign.revision,
    blueprintId: blueprint.id,
    blueprintDigest: blueprint.digest,
    blueprintState,
    blueprintRevision: storedBlueprint.revision,
    bsgRevision: bsg.revision,
    repositoryId: repository.id,
    snapshotId: snapshots[0]!.id,
    revision: repository.revision,
    snapshotDigest: repository.snapshotDigest,
    plannerActorId: blueprint.review.plannerActorId,
    reviewerActorIds: Object.freeze([...blueprint.review.reviewerIds]),
    sourceSystem: blueprint.objective.sourceSystem,
    targetSystem: blueprint.objective.targetSystem,
    objectiveStatement: blueprint.objective.statement,
  });
}

function mapExecution(
  options: RuntimeOptions,
  tenantId: string,
  campaignId: string,
): RegaugeProductionExecution | undefined {
  const campaign = options.executions.store.getCampaign(tenantId, campaignId);
  if (!campaign) return undefined;
  if (campaign.units.length !== 1) throw new Error("regauge_production_bootstrap_execution_drift");
  const unit = campaign.units[0]!;
  const control = mapControl(options, tenantId, campaignId);
  if (!control) throw new Error("regauge_production_bootstrap_control_drift");
  return Object.freeze({
    campaignId: campaign.campaignId,
    state: campaign.state,
    repositoryId: unit.snapshot.repositoryId,
    snapshotId: unit.snapshot.snapshotId,
    revision: unit.snapshot.revision,
    snapshotDigest: unit.snapshot.digest,
    blueprintId: control.blueprintId,
    blueprintDigest: control.blueprintDigest,
  });
}

function findRepository(
  repositories: readonly InstallationRepository[],
  input: RegaugeProductionBootstrapInput,
): InstallationRepository {
  const expected = input.repository;
  const matches = repositories.filter((repository) =>
    String(repository.id) === expected.remoteRepositoryId &&
    repository.owner.toLowerCase() === expected.owner.toLowerCase() &&
    repository.name.toLowerCase() === expected.name.toLowerCase());
  if (matches.length !== 1) throw new Error("regauge_production_bootstrap_repository_not_authorized");
  const repository = matches[0]!;
  if (!repository.private || repository.archived || repository.disabled ||
      repository.defaultBranch !== expected.defaultBranch) {
    throw new Error("regauge_production_bootstrap_repository_not_authorized");
  }
  return repository;
}

export function createRegaugeProductionBootstrapRuntime(
  options: RuntimeOptions,
): RegaugeProductionBootstrapRuntime {
  const now = options.now ?? (() => new Date().toISOString());
  return Object.freeze({
    async prepareRepository({ bootstrap, reviewerActorId }) {
      findRepository(await options.listInstallationRepositories(), bootstrap);
      const at = now();
      const existingTenant = getTenant(options.db, bootstrap.tenantId);
      if (!existingTenant) {
        insertTenant(options.db, {
          id: bootstrap.tenantId,
          slug: bootstrap.tenantId,
          name: "Regauge production canary",
          plan: "enterprise",
          billingStatus: "active",
          seatLimit: 2,
          createdAt: at,
        });
      } else if (existingTenant.id !== bootstrap.tenantId) {
        throw new Error("regauge_production_bootstrap_tenant_drift");
      }
      const serviceSubject = bootstrap.plannerActorId;
      const servicePrincipalId = stableId("principal-regauge-service", bootstrap.tenantId);
      insertPrincipal(options.db, {
        id: servicePrincipalId,
        tenantId: bootstrap.tenantId,
        kind: "service",
        subject: serviceSubject,
        displayName: "Regauge production bootstrap",
        createdAt: at,
      });
      const reviewerSubject = `${bootstrap.reviewer.issuer}|${bootstrap.reviewer.subject}`;
      insertPrincipal(options.db, {
        id: stableId("principal-regauge-reviewer", bootstrap.tenantId, reviewerSubject),
        tenantId: bootstrap.tenantId,
        kind: "human",
        subject: reviewerSubject,
        displayName: bootstrap.reviewer.displayName,
        createdAt: at,
      });
      putTenantMembership(options.db, {
        tenantId: bootstrap.tenantId,
        issuer: bootstrap.reviewer.issuer,
        subject: bootstrap.reviewer.subject,
        email: bootstrap.reviewer.email,
        displayName: bootstrap.reviewer.displayName,
        role: "owner",
        status: "active",
        updatedAt: at,
      });
      if (reviewerActorId !== `human:${reviewerSubject}`) {
        throw new Error("regauge_production_bootstrap_reviewer_drift");
      }
      upsertGitHubInstallation(options.db, {
        id: stableId("github-installation", bootstrap.repository.installationId),
        installationId: bootstrap.repository.installationId,
        accountId: bootstrap.repository.accountId,
        accountLogin: bootstrap.repository.accountLogin,
        accountType: "Organization",
        tenantId: bootstrap.tenantId,
        permissions: { contents: "write", pull_requests: "write", checks: "read", metadata: "read" },
        repositories: [{
          id: Number(bootstrap.repository.remoteRepositoryId),
          owner: bootstrap.repository.owner,
          name: bootstrap.repository.name,
        }],
        repositorySelection: "selected",
        createdAt: at,
        updatedAt: at,
      });
      const connections = listScmConnections(options.db, bootstrap.tenantId)
        .filter((connection) => connection.provider === "github" &&
          connection.external_account_id === bootstrap.repository.installationId);
      if (connections.length > 1) throw new Error("regauge_production_bootstrap_connection_ambiguous");
      const connection = connections[0]
        ? { id: connections[0].id }
        : registerScmConnection(options.db, {
            tenantId: bootstrap.tenantId,
            provider: "github",
            credentialRef: `regauge-installation://${bootstrap.repository.installationId}`,
            externalAccountId: bootstrap.repository.installationId,
            displayName: "Regauge canary GitHub App",
          });
      const repositories = listConnectedRepositories(options.db, bootstrap.tenantId)
        .filter((repository) => repository.remote_id === bootstrap.repository.remoteRepositoryId);
      if (repositories.length > 1) throw new Error("regauge_production_bootstrap_repository_ambiguous");
      const stored = repositories[0] ?? registerConnectedRepository(options.db, {
        tenantId: bootstrap.tenantId,
        connectionId: connection.id,
        remoteId: bootstrap.repository.remoteRepositoryId,
        owner: bootstrap.repository.owner,
        name: bootstrap.repository.name,
        defaultBranch: bootstrap.repository.defaultBranch,
        selectedBranch: bootstrap.repository.selectedBranch,
        environment: bootstrap.environment,
        retentionDays: 30,
      });
      if (
        stored.connection_id !== connection.id || stored.owner !== bootstrap.repository.owner ||
        stored.name !== bootstrap.repository.name || stored.default_branch !== bootstrap.repository.defaultBranch ||
        stored.selected_branch !== bootstrap.repository.selectedBranch || stored.environment !== bootstrap.environment
      ) {
        throw new Error("regauge_production_bootstrap_repository_drift");
      }
      const materialized = await materializeConnectedRepository(options.db, {
        tenantId: bootstrap.tenantId,
        repositoryId: stored.id,
        expectedRevision: bootstrap.repository.expectedRevision,
      }, options.repositoryDependencies);
      const matchingRecipes = RECIPE_CATALOG.filter((recipe) =>
        recipe.source === bootstrap.objective.sourceSystem &&
        recipe.target === bootstrap.objective.targetSystem);
      if (matchingRecipes.length !== 1) {
        throw new Error("regauge_production_bootstrap_recipe_ambiguous");
      }
      const authority = createAppDbTransformerMissionAuthority(options.db)
        .repositories.load(bootstrap.tenantId, stored.id, at, matchingRecipes[0]!.allowedPaths);
      return Object.freeze({
        repositoryId: stored.id,
        snapshotId: materialized.snapshot.id,
        revision: materialized.snapshot.exactCommit,
        snapshotDigest: authority.planning.snapshotDigest,
      });
    },
    async readControl(tenantId, campaignId) { return mapControl(options, tenantId, campaignId); },
    async plan(input) {
      const planned = options.missions.plan({
        tenantId: input.tenantId,
        actorId: input.plannerActorId,
        requestId: `bootstrap-plan-${input.requestDigest.slice(7, 31)}`,
        idempotencyKey: `bootstrap-plan-${input.requestDigest.slice(7, 39)}`,
        evidenceRefs: input.evidenceRefs,
      }, {
        campaignId: input.campaignId,
        environment: input.environment,
        evaluatedAt: now(),
        maxEvidenceAgeMs: 60 * 60_000,
        constraints: { maxUnits: 1, maxRepositories: 1, maxPathsPerUnit: 8 },
        repositoryIds: [input.repositoryId],
        objective: {
          ...input.objective,
          evidenceRefs: [...input.evidenceRefs],
          assumptions: [{
            id: "approved-snapshot-remains-immutable",
            statement: "The approved source snapshot remains immutable for this draft-only canary.",
            evidenceRefs: [...input.evidenceRefs],
          }],
          risks: [{
            id: "runtime-compatibility",
            statement: "Node runtime behavior can change and requires verification before review.",
            severity: "high",
            ownerId: input.reviewerActorId,
            evidenceRefs: [...input.evidenceRefs],
          }],
        },
      });
      if (planned.decision !== "planned") {
        throw new Error(`regauge_production_bootstrap_recipe_abstained:${planned.reasons.join(",")}`);
      }
      return mapControl(options, input.tenantId, input.campaignId)!;
    },
    async review(input) {
      options.control.reviewToReady({
        tenantId: input.tenantId,
        actorId: input.reviewerActorId,
        requestId: `bootstrap-review-${input.requestDigest.slice(7, 31)}`,
        idempotencyKey: `bootstrap-review-${input.requestDigest.slice(7, 39)}`,
        evidenceRefs: input.evidenceRefs,
      }, input.campaignId, {
        campaign: input.control.campaignRevision,
        blueprint: input.control.blueprintRevision,
        bsg: input.control.bsgRevision,
      });
      return mapControl(options, input.tenantId, input.campaignId)!;
    },
    async readExecution(tenantId, campaignId) { return mapExecution(options, tenantId, campaignId); },
    async launch(input) {
      options.missions.launch({
        tenantId: input.tenantId,
        actorId: input.reviewerActorId,
        requestId: `bootstrap-launch-${input.requestDigest.slice(7, 31)}`,
        idempotencyKey: `bootstrap-launch-${input.requestDigest.slice(7, 39)}`,
        evidenceRefs: input.evidenceRefs,
      }, input.campaignId);
      const execution = mapExecution(options, input.tenantId, input.campaignId)!;
      // Create-or-bind the Mission here, at the live launch seam, and advance it
      // to `executing`. Best-effort by deliberate choice: mission bookkeeping must
      // never fail production provisioning (the same convention the other two
      // mission writers follow). It is NOT silent — a failure is logged loudly
      // with identifiers, AND because the mission's own `state` column is the
      // source of truth, a failed advance leaves the mission in its true
      // (un-advanced) state rather than fabricating a success: there is no
      // third state where "did not advance" masquerades as "advanced".
      try {
        const owner = getPrincipalBySubject(
          options.db,
          input.tenantId,
          "service",
          "service:regauge-production-bootstrap",
        );
        if (!owner) {
          console.error(
            `regauge mission launch wiring skipped: service principal missing tenant=${input.tenantId} campaign=${input.campaignId}`,
          );
        } else {
          const campaign = options.control.store.getCampaign(input.tenantId, input.campaignId);
          bindRegaugeMissionAtLaunch(options.db, {
            tenantId: input.tenantId,
            campaignId: input.campaignId,
            ownerPrincipalId: owner.id,
            objective: campaign?.name ?? input.campaignId,
            repositories: [{ repositoryId: execution.repositoryId, snapshotId: execution.snapshotId }],
            createdAt: now(),
          });
        }
      } catch (error) {
        console.error(
          `regauge mission launch wiring failed tenant=${input.tenantId} campaign=${input.campaignId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return execution;
    },
    async readReceipt(tenantId, campaignId) {
      const integrity = verifyDomainEventIntegrity(options.db, tenantId);
      if (!integrity.ok) throw new Error("regauge_production_bootstrap_event_integrity_invalid");
      const events = listDomainEvents(options.db, tenantId, RECEIPT_AGGREGATE, campaignId)
        .filter((event) => event.event_type === RECEIPT_EVENT);
      if (events.length > 1) throw new Error("regauge_production_bootstrap_receipt_ambiguous");
      return events[0] ? receiptFromEvent(events[0]) : undefined;
    },
    async recordReceipt(input) {
      const principal = getPrincipalBySubject(options.db, input.tenantId, "service", "service:regauge-production-bootstrap");
      if (!principal) throw new Error("regauge_production_bootstrap_principal_missing");
      const result = appendDomainEvent(options.db, {
        id: stableId("event-regauge-bootstrap", input.tenantId, input.campaignId),
        tenantId: input.tenantId,
        schemaVersion: 1,
        eventType: RECEIPT_EVENT,
        aggregateType: RECEIPT_AGGREGATE,
        aggregateId: input.campaignId,
        actorPrincipalId: principal.id,
        correlationId: input.requestDigest,
        idempotencyKey: `regauge-production-bootstrap:${input.campaignId}`,
        payload: input,
        createdAt: now(),
      });
      return receiptFromEvent(result.row);
    },
  });
}

class InstallationSecretProvider implements SecretProvider {
  readonly provider = "regauge-installation";
  constructor(private readonly installationId: string, private readonly token: InstallationTokenCache) {}
  async read(reference: SecretReference): Promise<string | undefined> {
    return reference.provider === this.provider && reference.id === this.installationId
      ? this.token.get()
      : undefined;
  }
}

export async function runRegaugeProductionBootstrapFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RegaugeProductionBootstrapReceipt> {
  if (env.MENDPOINT_REGAUGE_BOOTSTRAP_ENABLED !== "1") {
    throw new Error("regauge_production_bootstrap_disabled");
  }
  const input = regaugeProductionBootstrapInputFromEnvironment(env);
  const appCredentials = loadAppCredentials(env);
  if (!appCredentials) throw new Error("regauge_production_bootstrap_github_app_credentials_required");
  const token = new InstallationTokenCache(
    appCredentials,
    Number(input.repository.installationId),
    undefined,
    Date.now,
    [Number(input.repository.remoteRepositoryId)],
  );
  const provider = new InstallationSecretProvider(input.repository.installationId, token);
  const broker = new CredentialBroker({ providers: [provider], audit: () => undefined });
  const db = createDb();
  const control = new TransformerCampaignService();
  const executions = new TransformerPilotExecutionService(undefined, {
    rawGateConfig: input.gateConfig,
    environment: input.environment,
  });
  const authority = createAppDbTransformerMissionAuthority(db);
  const missions = new TransformerMissionService(
    control,
    executions,
    authority.repositories,
    authority.organizations,
    RECIPE_CATALOG,
    input.environment,
  );
  try {
    const runtime = createRegaugeProductionBootstrapRuntime({
      db,
      control,
      executions,
      missions,
      repositoryDependencies: {
        credentialBroker: broker,
        actorId: "service:regauge-production-bootstrap",
        requestId: `bootstrap-materialize-${input.campaignId}`,
      },
      listInstallationRepositories: async () => defaultListInstallationRepositories(await token.get()),
    });
    return await bootstrapRegaugeProductionCampaign(input, runtime);
  } finally {
    executions.close();
    control.close();
    db.raw.close();
  }
}
