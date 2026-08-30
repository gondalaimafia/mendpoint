import * as dbModule from "@mendpoint/db";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  createMissionTask,
  getMissionTask,
  getRoutingLedgerForJob,
  listAdaptiveCandidates,
  insertConnectedRepository,
  insertRepositorySnapshot,
  insertRepositorySnapshotFiles,
  regaugeLaunchMissionTaskId,
  upsertScmConnection,
  type AppDb,
} from "@mendpoint/db";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import { ensureDefaultPolicyEnvelopeBinding } from "@mendpoint/pipeline";
import {
  canonicalPolicyEnvelopeJson,
  defaultPolicyEnvelope,
} from "@mendpoint/policy";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  RECOMMENDED_REVIEW_TIER_POLICY,
  TransformerPilotExecutionStore,
  applyRecipe,
  createOrganizationConstraintContract,
  createTransformerPilotAttemptCheckpointConfig,
  createTransformerPilotCheckpointAuthority,
  recipeFilesDigest,
  recipeReference,
  type TransformerAttemptCheckpointArtifactStore,
  type RecipeFiles,
} from "@mendpoint/transformer";
import {
  authorizeConfiguredTransformerAdaptiveExternalProcessing,
  resolveTransformerAdaptivePlannerAdapter,
} from "./transformer-adaptive-planner.js";
import {
  runTransformerPilotLaneOnce,
  transformerPilotWorkerPath,
  type TransformerPilotLaneStore,
} from "./transformer-pilot-lane.js";

const CREATED_AT = "2026-08-05T10:00:00.000Z";
const RUN_AT = "2026-08-05T10:01:00.000Z";
const EXPIRES_AT = "2026-08-06T10:00:00.000Z";
const SOURCE_REVISION = "a".repeat(40);
const CANDIDATE_REVISION = "c".repeat(40);
const FILES: RecipeFiles = Object.freeze({
  "package.json": `${JSON.stringify({
    name: "transformer-lane-fixture",
    private: true,
    engines: { node: ">=18 <19" },
  }, null, 2)}\n`,
  ".nvmrc": "18\n",
  ".node-version": "18.20.4\n",
  Dockerfile: "FROM node:18-alpine\nWORKDIR /app\n",
});

const roots: string[] = [];
const databases: AppDb[] = [];
const stores: TransformerPilotExecutionStore[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (stores.length) stores.pop()?.close();
  while (databases.length) databases.pop()?.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function gateConfig(tenantIds: readonly string[] = ["tenant-a"]): string {
  return JSON.stringify({
    schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
    tenantAllowlist: tenantIds,
    environmentAllowlist: ["staging"],
    grants: tenantIds.map((tenantId) => ({
      tenantId,
      environment: "staging",
      boundaries: ["worker_action"],
      acceptanceEvidenceRefs: ["acceptance:transformer-lane:v1"],
      productionDeliveryApprovalRefs: [],
    })),
  });
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-transformer-lane-"));
  roots.push(root);
  const db = createDb(join(root, "mendpoint.sqlite"));
  databases.push(db);
  const store = new TransformerPilotExecutionStore(join(root, "pilot.sqlite"));
  stores.push(store);
  const snapshotRoot = join(root, "snapshot");
  mkdirSync(snapshotRoot);
  for (const [path, content] of Object.entries(FILES)) {
    writeFileSync(join(snapshotRoot, path), content, "utf8");
  }
  upsertScmConnection(db, {
    id: "connection-a",
    tenantId: "tenant-a",
    provider: "local_git",
    credentialRef: "env://TENANT_A_LOCAL_GIT",
    externalAccountId: "tenant-a",
    displayName: "Tenant A",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  insertConnectedRepository(db, {
    id: "repository-a",
    tenantId: "tenant-a",
    connectionId: "connection-a",
    remoteId: "tenant-a/repository-a",
    owner: "tenant-a",
    name: "repository-a",
    defaultBranch: "main",
    status: "ready",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  insertRepositorySnapshot(db, {
    id: "snapshot-a",
    tenantId: "tenant-a",
    repositoryId: "repository-a",
    requestedRef: "main",
    resolvedSha: SOURCE_REVISION,
    manifestSha256: "b".repeat(64),
    storagePath: snapshotRoot,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
  });
  insertRepositorySnapshotFiles(db, {
    tenantId: "tenant-a",
    snapshotId: "snapshot-a",
    files: Object.entries(FILES).map(([path, content]) => ({
      path,
      mode: path === ".nvmrc" ? "100755" : "100644",
      kind: "file",
      size: Buffer.byteLength(content, "utf8"),
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    })),
  });
  const sourceDigest = recipeFilesDigest(FILES);
  const recipe = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
  const application = applyRecipe(recipe, FILES);
  const constraints = createOrganizationConstraintContract({
    tenantId: "tenant-a",
    organizationId: "organization-a",
    version: 1,
    effectiveAt: CREATED_AT,
    sources: [{
      id: "policy-a",
      kind: "explicit_policy",
      repositoryId: "repository-a",
      revision: SOURCE_REVISION,
      digest: `sha256:${"d".repeat(64)}`,
      locator: "policy://organization-a/repository-a/v1",
      evidenceRefs: ["evidence:policy-a"],
    }],
    rules: [{
      id: "allow-recipe",
      sourceId: "policy-a",
      repositoryId: "repository-a",
      pathPattern: "**",
      actions: ["change"],
      effect: "allow",
      ownerIds: ["owner-a"],
      rationale: "Approved migration fixture",
    }],
  });
  store.createCampaign({
    tenantId: "tenant-a",
    organizationId: "organization-a",
    environment: "staging",
    campaignId: "campaign-a",
    constraints,
    units: [{
      id: "unit-a",
      title: "Migrate repository A",
      ownerId: "owner-a",
      reviewerIds: ["reviewer-a"],
      dependsOn: [],
      snapshot: {
        snapshotId: "snapshot-a",
        repositoryId: "repository-a",
        revision: SOURCE_REVISION,
        manifestSha256: "b".repeat(64),
        digest: sourceDigest,
        evidenceRefs: ["evidence:snapshot-a"],
      },
      candidateRevision: CANDIDATE_REVISION,
      candidateDigest: application.outputDigest,
      recipe,
      changedPaths: application.operations.map((operation) => operation.path),
    }],
    observedAt: CREATED_AT,
    evidenceRefs: ["evidence:campaign-a"],
    idempotencyKey: "create-campaign-a",
    gateConfig: gateConfig(),
  });
  return { root, db, store };
}

function recursiveFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? recursiveFiles(child) : [child];
  });
}

class MemoryCheckpointArtifacts implements TransformerAttemptCheckpointArtifactStore {
  readonly values = new Map<string, Uint8Array>();
  readonly referenced = new Set<string>();
  readonly unreferenced = new Set<string>();

  async read(storageKey: string): Promise<Uint8Array | null> {
    const value = this.values.get(storageKey);
    return value ? new Uint8Array(value) : null;
  }

  async publishImmutableDurable(storageKey: string, bytes: Uint8Array): Promise<void> {
    const existing = this.values.get(storageKey);
    if (existing && !Buffer.from(existing).equals(Buffer.from(bytes))) {
      throw new Error("checkpoint_artifact_conflict");
    }
    this.values.set(storageKey, new Uint8Array(bytes));
  }

  async recordPending(): Promise<void> {}

  async recordReferenced(storageKey: string): Promise<void> {
    this.referenced.add(storageKey);
  }

  async recordUnreferenced(storageKey: string): Promise<void> {
    this.unreferenced.add(storageKey);
  }
}

function adaptiveModelEnv(): NodeJS.ProcessEnv {
  return {
    MENDPOINT_REGAUGE_ADAPTIVE_MODEL_SOURCE_ENABLED: "1",
    MENDPOINT_REGAUGE_ADAPTIVE_MODEL_SOURCE_TENANTS: "tenant-a",
    MENDPOINT_REGAUGE_ADAPTIVE_MODEL_PROVIDER: "openai-compatible",
    MENDPOINT_REGAUGE_ADAPTIVE_MODEL_DEPLOYMENT: "us-central-primary",
    MENDPOINT_REGAUGE_ADAPTIVE_EXTERNAL_PROCESSING_APPROVED: "1",
    MENDPOINT_REGAUGE_ADAPTIVE_EXECUTION_REGION: "us-central1",
    MENDPOINT_REGAUGE_ADAPTIVE_MAX_DATA_CLASSIFICATION: "confidential",
    LLM_AGENT_MODEL: "model-a",
    LLM_AGENT_URL: "https://models.example/v1",
    OPENAI_API_KEY: "test-secret",
  };
}

function adaptiveAdapter() {
  return resolveTransformerAdaptivePlannerAdapter("tenant-a", adaptiveModelEnv(), {
    priceTable: {
      "model-a": { promptUsdPerMillion: 1, completionUsdPerMillion: 2 },
    },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(String(init.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const input = JSON.parse(request.messages[1]!.content) as {
        context: Array<{ path: string; content: string; digest: string }>;
      };
      const file = input.context.find((entry) => entry.path === "package.json")!;
      const parsed = JSON.parse(file.content) as Record<string, unknown>;
      parsed.mendpointAdaptiveReview = "fixed";
      return new Response(JSON.stringify({
        id: "adaptive-body-request-a",
        model: "model-a",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
          plan: {
            edits: [{
              path: file.path,
              observedContentDigest: file.digest,
              nextContent: `${JSON.stringify(parsed, null, 2)}\n`,
              rationale: "Record the verified adaptive review marker required by the objective gate.",
              semanticCategory: "configuration",
              risk: "low",
              confidence: 95,
            }],
            requestContextPaths: [],
            markUnfixable: false,
            rationale: "Repair the failed objective gate without widening scope",
          },
        }) } }],
        usage: { prompt_tokens: 50, completion_tokens: 15, total_tokens: 65 },
      }), {
        status: 200,
        headers: { "x-request-id": "adaptive-header-request-a" },
      });
    },
  })!;
}

// Register tenant-a in the App DB so that `recordTrajectory` (which asserts the
// tenant exists) can persist. The lane fixtures otherwise seed only unreferenced
// tables (scm_connections etc. carry no tenants FK), so a real tenant row is
// what a production database would have but these fixtures lack.
function registerTenantA(db: AppDb): void {
  db.raw
    .prepare(
      `INSERT OR IGNORE INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?)`,
    )
    .run(CREATED_AT);
}

// Create and campaign-link the ReGauge Mission the API boundary would create for
// campaign-a, so the pilot-lane trajectory emit can resolve it.
function seedRegaugeMissionForCampaignA(db: AppDb): string {
  registerTenantA(db);
  dbModule.insertPrincipal(db, {
    id: "principal-a",
    tenantId: "tenant-a",
    kind: "human",
    subject: "owner@tenant-a.example",
    displayName: "Owner A",
    createdAt: CREATED_AT,
  });
  const mission = dbModule.createMission(db, {
    id: "mission-regauge-campaign-a",
    tenantId: "tenant-a",
    product: "regauge",
    triggerKind: "migration_objective",
    objective: "Runtime upgrade for campaign-a",
    ownerPrincipalId: "principal-a",
    eventId: "mission-regauge-campaign-a-created",
    idempotencyKey: "mission-regauge-campaign-a-create",
    correlationId: "campaign-a",
    createdAt: CREATED_AT,
  });
  dbModule.linkRegaugeCampaignToMission(db, {
    tenantId: "tenant-a",
    missionId: mission.id,
    regaugeCampaignId: "campaign-a",
    actorPrincipalId: "principal-a",
    eventId: "mission-regauge-campaign-a-linked",
    idempotencyKey: "mission-regauge-campaign-a-link",
    correlationId: "campaign-a",
    createdAt: CREATED_AT,
  });
  ensureDefaultPolicyEnvelopeBinding(db, {
    tenantId: "tenant-a",
    missionId: mission.id,
    actorPrincipalId: "principal-a",
    correlationId: "campaign-a",
    createdAt: CREATED_AT,
  });
  return mission.id;
}

function runAdaptiveLaneOnce(
  fixture: { root: string; db: AppDb; store: TransformerPilotExecutionStore },
  overrides?: { runId?: string; workerId?: string },
) {
  const adapter = adaptiveAdapter();
  return runTransformerPilotLaneOnce({
    db: fixture.db,
    store: fixture.store,
    gateConfig: gateConfig(),
    tenantId: "tenant-a",
    workerId: overrides?.workerId ?? "worker-adaptive",
    evidenceRoot: join(fixture.root, "evidence"),
    candidateRoot: join(fixture.root, "candidates"),
    tempRoot: join(fixture.root, "workspaces"),
    runId: overrides?.runId ?? "run-adaptive",
    now: () => RUN_AT,
    leaseToken: () => "transformer-adaptive-lease-token-0001",
    adaptivePlannerAdapterForTenant: () => adapter,
    authorizeAdaptiveExternalProcessing: (authorization) =>
      authorizeConfiguredTransformerAdaptiveExternalProcessing(authorization, adaptiveModelEnv()),
    adaptiveCandidateDataRoot: fixture.root,
    commandRunner: async ({ cwd }) => {
      const content = readFileSync(join(cwd, "package.json"), "utf8");
      const passed = content.includes('"mendpointAdaptiveReview": "fixed"');
      return {
        exitCode: passed ? 0 : 9,
        stdout: passed ? "verified" : "",
        stderr: passed ? "" : "deterministic gate failed",
      };
    },
  });
}

describe("Transformer production pilot lane", () => {
  it("loads an exact snapshot, executes one fenced attempt, and persists the candidate", async () => {
    const { root, db, store } = setup();
    const result = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-a",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      runId: "run-a",
      now: () => RUN_AT,
      leaseToken: () => "transformer-lane-lease-token-00000001",
      commandRunner: async () => ({ exitCode: 0, stdout: "verified", stderr: "" }),
    });

    expect(result).toEqual({
      enabled: true,
      expired: 0,
      attempted: 1,
      completed: 1,
      failed: 0,
      stale: 0,
      idle: 0,
      routingSettled: 1,
      errors: [],
    });
    expect(store.getCampaign("tenant-a", "campaign-a")).toMatchObject({
      state: "running",
      units: [{ state: "executed", verificationPassed: true, actualCostUsd: 0 }],
    });
    expect(recursiveFiles(join(root, "candidates")).some((path) =>
      path.endsWith("manifest.json")
    )).toBe(true);
    expect(recursiveFiles(join(root, "workspaces"))).toEqual([]);
  });

  it("injects a tenant scoped checkpoint provider into the routed attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN_AT);
    const { root, db, store } = setup();
    const artifacts = new MemoryCheckpointArtifacts();
    let checkpointClock = 0;
    const checkpoint = createTransformerPilotAttemptCheckpointConfig({
      authority: createTransformerPilotCheckpointAuthority(store),
      artifactStore: artifacts,
      encryptionKey: Buffer.from("92".repeat(32), "hex"),
      executorDigest: `sha256:${"e".repeat(64)}`,
      evidenceRefs: ["evidence:worker-checkpoint-provider"],
      gateConfig: gateConfig(),
      now: () => new Date(Date.parse(RUN_AT) + checkpointClock++).toISOString(),
      operationTimeoutMs: 5_000,
    });
    let openReads = 0;
    let timeoutReads = 0;
    const statefulCheckpoint = new Proxy(checkpoint, {
      get(target, property, receiver) {
        if (property === "open" && openReads++ > 0) {
          throw new Error("checkpoint open was read twice");
        }
        if (property === "operationTimeoutMs" && timeoutReads++ > 0) {
          throw new Error("checkpoint timeout was read twice");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const checkpointForCampaign = vi.fn(async () => statefulCheckpoint);
    const result = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-checkpoint-provider",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      runId: "run-checkpoint-provider",
      now: () => RUN_AT,
      leaseToken: () => "transformer-checkpoint-provider-token-0001",
      commandRunner: async () => ({ exitCode: 0, stdout: "verified", stderr: "" }),
      checkpointForCampaign,
    });

    expect(result).toMatchObject({ attempted: 1, completed: 1, failed: 0, errors: [] });
    expect(checkpointForCampaign).toHaveBeenCalledOnce();
    expect(checkpointForCampaign).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      environment: "staging",
    });
    expect(openReads).toBe(1);
    expect(timeoutReads).toBe(1);
    const unit = store.getCampaign("tenant-a", "campaign-a")!.units[0]!;
    expect(unit).toMatchObject({ state: "executed", verificationPassed: true });
    expect(unit.attemptCheckpointHead).toBeDefined();
    expect(artifacts.referenced).toContain(unit.attemptCheckpointHead?.envelopeStorageKey);
  });

  it("fails closed when a configured checkpoint provider returns no controller", async () => {
    const { root, db, store } = setup();
    const claim = vi.spyOn(store, "claimNextAttempt");
    const complete = vi.spyOn(store, "completeAttempt");
    const failure = vi.spyOn(store, "recordAttemptFailure");
    const result = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-invalid-checkpoint-provider",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      runId: "run-invalid-checkpoint-provider",
      now: () => RUN_AT,
      leaseToken: () => "transformer-invalid-checkpoint-token-0001",
      commandRunner: async () => ({ exitCode: 0, stdout: "verified", stderr: "" }),
      checkpointForCampaign: async () => undefined,
    });

    expect(result).toMatchObject({ attempted: 1, completed: 0, failed: 1 });
    expect(result.errors).toContain("transformer_lane_checkpoint_provider_invalid");
    expect(claim).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    const pendingUnit = store.getCampaign("tenant-a", "campaign-a")!.units[0]!;
    expect(pendingUnit.state).toBe("pending");
    expect(pendingUnit.routingSettlement).toBeUndefined();

    claim.mockRestore();
    complete.mockRestore();
    failure.mockRestore();
    const recovered = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-valid-after-invalid-checkpoint-provider",
      evidenceRoot: join(root, "evidence-recovered"),
      candidateRoot: join(root, "candidates-recovered"),
      runId: "run-valid-after-invalid-checkpoint-provider",
      now: () => RUN_AT,
      leaseToken: () => "transformer-valid-checkpoint-token-00001",
      commandRunner: async () => ({ exitCode: 0, stdout: "verified", stderr: "" }),
    });
    expect(recovered).toMatchObject({ attempted: 1, completed: 1, failed: 0 });
  });

  it("rejects a throwing checkpoint config before routing or claim", async () => {
    const { root, db, store } = setup();
    const claim = vi.spyOn(store, "claimNextAttempt");
    const result = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-throwing-checkpoint-provider",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      runId: "run-throwing-checkpoint-provider",
      now: () => RUN_AT,
      leaseToken: () => "transformer-throwing-checkpoint-token-001",
      checkpointForCampaign: async () => new Proxy({}, {
        get() {
          throw new Error("provider getter failed");
        },
      }) as never,
    });

    expect(result).toMatchObject({ attempted: 1, completed: 0, failed: 1 });
    expect(result.errors).toContain("transformer_lane_checkpoint_provider_unavailable");
    expect(claim).not.toHaveBeenCalled();
    expect(store.getCampaign("tenant-a", "campaign-a")!.units[0]!.routingSettlement)
      .toBeUndefined();
  });

  it("rejects an oversized checkpoint timeout before routing or claim", async () => {
    const { root, db, store } = setup();
    const claim = vi.spyOn(store, "claimNextAttempt");
    const result = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-oversized-checkpoint-timeout",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      runId: "run-oversized-checkpoint-timeout",
      now: () => RUN_AT,
      leaseToken: () => "transformer-oversized-checkpoint-token-01",
      checkpointForCampaign: async () => ({
        operationTimeoutMs: 450_001,
        open: async () => {
          throw new Error("must not open invalid checkpoint config");
        },
      }),
    });

    expect(result).toMatchObject({ attempted: 1, completed: 0, failed: 1 });
    expect(result.errors).toContain("transformer_lane_checkpoint_provider_invalid");
    expect(claim).not.toHaveBeenCalled();
    expect(store.getCampaign("tenant-a", "campaign-a")!.units[0]!.routingSettlement)
      .toBeUndefined();
  });

  it("bounds a nonresponsive checkpoint provider before routing or claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN_AT);
    const { root, db, store } = setup();
    const claim = vi.spyOn(store, "claimNextAttempt");
    const pending = runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-nonresponsive-checkpoint-provider",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      runId: "run-nonresponsive-checkpoint-provider",
      now: () => RUN_AT,
      leaseDurationMs: 1_000,
      leaseToken: () => "transformer-nonresponsive-token-000001",
      checkpointForCampaign: () => new Promise(() => {}),
    });
    await vi.advanceTimersByTimeAsync(334);
    const result = await pending;

    expect(result).toMatchObject({ attempted: 1, completed: 0, failed: 1 });
    expect(result.errors).toContain("transformer_lane_checkpoint_provider_unavailable");
    expect(claim).not.toHaveBeenCalled();
    expect(store.getCampaign("tenant-a", "campaign-a")!.units[0]!.routingSettlement)
      .toBeUndefined();
  });

  it("reconciles a committed pilot terminal outcome without rerunning after transient routing persistence failure", async () => {
    const { root, db, store } = setup();
    let commandCalls = 0;
    db.raw.exec(`
      CREATE TRIGGER fail_transformer_routing_outcome
      BEFORE INSERT ON routing_outcome_applications
      BEGIN SELECT RAISE(ABORT, 'transient routing persistence failure'); END;
    `);
    const run = (runId: string) => runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-routing-settlement",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      runId,
      now: () => RUN_AT,
      leaseToken: () => "transformer-routing-settlement-token-0001",
      commandRunner: async () => {
        commandCalls++;
        return { exitCode: 0, stdout: "verified", stderr: "" };
      },
    });

    const first = await run("run-routing-settlement-original");
    const callsAfterExecution = commandCalls;
    expect(first).toMatchObject({
      attempted: 1,
      completed: 1,
      infrastructureError: "routing_outcome_persistence_failed",
    });
    expect(callsAfterExecution).toBeGreaterThan(0);
    expect(store.listPendingRoutingSettlements("tenant-a")).toHaveLength(1);
    expect(store.getCampaign("tenant-a", "campaign-a")!.units[0]).toMatchObject({
      state: "executed",
      routingSettlement: {
        outcome: {
          outcome: "succeeded",
          actualCostUsd: null,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          verification: {
            verdict: "passed",
            evidenceArtifactIds: expect.any(Array),
            verifierId: "transformer-attempt-verifier",
          },
        },
      },
    });
    const stateAfterFailure = store.getCampaign("tenant-a", "campaign-a")!;
    expect(stateAfterFailure.units[0]!.routingSettlement!.outcome!.verification.evidenceArtifactIds)
      .not.toHaveLength(0);
    expect(getRoutingLedgerForJob(db, "campaign-a", "tenant-a")[0]?.outcome).toBeNull();

    db.raw.exec("DROP TRIGGER fail_transformer_routing_outcome");
    const second = await run("run-routing-settlement-recovery");
    expect(second).toMatchObject({ attempted: 0, completed: 0, failed: 0, routingSettled: 1 });
    expect(commandCalls).toBe(callsAfterExecution);
    expect(store.listPendingRoutingSettlements("tenant-a")).toEqual([]);
    expect(getRoutingLedgerForJob(db, "campaign-a", "tenant-a")).toEqual([
      expect.objectContaining({
        outcome: "succeeded",
        action: "completed",
        cost_usd: null,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
      }),
    ]);
    expect((db.raw.prepare(
      "SELECT COUNT(*) AS count FROM routing_outcome_applications",
    ).get() as { count: number }).count).toBe(1);

    const third = await run("run-routing-settlement-exact-replay");
    expect(third).toMatchObject({ attempted: 0, completed: 0, failed: 0 });
    expect(third.routingSettled).toBeUndefined();
    expect(commandCalls).toBe(callsAfterExecution);
    expect((db.raw.prepare(
      "SELECT COUNT(*) AS count FROM routing_outcome_applications",
    ).get() as { count: number }).count).toBe(1);
  });

  it("does not apply failure breaker feedback twice when pilot settlement marking fails after the App DB commit", async () => {
    const { root, db, store } = setup();
    let commandCalls = 0;
    const recordFailure = store.recordAttemptFailure.bind(store);
    vi.spyOn(store, "recordAttemptFailure").mockImplementation((input) =>
      recordFailure({ ...input, errorCode: "model_unavailable" }));
    vi.spyOn(store, "markRoutingOutcomeSettled").mockImplementationOnce(() => {
      throw new Error("routing_settlement_mark_failed");
    });
    const run = (runId: string) => runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-a",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      runId,
      now: () => RUN_AT,
      leaseToken: () => "transformer-routing-breaker-token-0001",
      commandRunner: async () => {
        commandCalls++;
        return { exitCode: 1, stdout: "", stderr: "verification failed" };
      },
    });

    const first = await run("run-routing-breaker-original");
    const callsAfterExecution = commandCalls;
    expect(first).toMatchObject({
      attempted: 1,
      failed: 1,
      infrastructureError: "routing_settlement_mark_failed",
    });
    expect(store.listPendingRoutingSettlements("tenant-a")).toHaveLength(1);
    expect((db.raw.prepare(
      `SELECT consecutive_failures AS failures FROM routing_executor_health
       WHERE tenant_id = ? AND scope = 'executor' AND executor_id = ? AND provider_id = ?`,
    ).get("tenant-a", "transformer-attempt", "mendpoint-transformer") as {
      failures: number;
    }).failures).toBe(1);
    expect((db.raw.prepare(
      `SELECT consecutive_failures AS failures FROM routing_executor_health
       WHERE tenant_id = ? AND scope = 'provider' AND provider_id = ?`,
    ).get("tenant-a", "mendpoint-transformer") as { failures: number }).failures).toBe(1);

    const second = await run("run-routing-breaker-recovery");
    expect(second).toMatchObject({ attempted: 0, failed: 0, routingSettled: 1 });
    expect(commandCalls).toBe(callsAfterExecution);
    expect(store.listPendingRoutingSettlements("tenant-a")).toEqual([]);
    expect((db.raw.prepare(
      "SELECT COUNT(*) AS count FROM routing_outcome_applications",
    ).get() as { count: number }).count).toBe(1);
    expect((db.raw.prepare(
      `SELECT consecutive_failures AS failures FROM routing_executor_health
       WHERE tenant_id = ? AND scope = 'executor' AND executor_id = ? AND provider_id = ?`,
    ).get("tenant-a", "transformer-attempt", "mendpoint-transformer") as {
      failures: number;
    }).failures).toBe(1);
    expect((db.raw.prepare(
      `SELECT consecutive_failures AS failures FROM routing_executor_health
       WHERE tenant_id = ? AND scope = 'provider' AND provider_id = ?`,
    ).get("tenant-a", "mendpoint-transformer") as { failures: number }).failures).toBe(1);
  });

  it("records a review-pending adaptive candidate after the deterministic gate fails", async () => {
    const { root, db, store } = setup();
    registerTenantA(db);
    const adapter = adaptiveAdapter();
    const recorder = vi.fn<typeof dbModule.recordAdaptiveCandidate>((candidateDb, input) => {
      expect(store.getCampaign("tenant-a", "campaign-a")!.units[0]!.adaptiveCandidateHandoff)
        .toMatchObject({
          attemptId: input.attemptId,
          repositoryId: input.repositoryId,
          snapshotId: input.snapshotId,
          baseBranch: input.baseBranch,
          expectedBaseRevision: input.expectedBaseRevision,
          divergedFromDigest: input.divergedFromDigest,
          candidateDigest: input.candidateDigest,
          changedPaths: input.changedPaths,
        });
      const events = store.listEvents("tenant-a", "campaign-a");
      expect(events.some((event) => event.type === "attempt.adaptive_candidate_handoff"))
        .toBe(true);
      expect(events.at(-1)?.type).toBe("routing.outcome_settled");
      return dbModule.recordAdaptiveCandidate(candidateDb, input);
    });

    const result = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-adaptive",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      runId: "run-adaptive",
      now: () => RUN_AT,
      leaseToken: () => "transformer-adaptive-lease-token-0001",
      adaptivePlannerAdapterForTenant: () => adapter,
      authorizeAdaptiveExternalProcessing: (authorization) =>
        authorizeConfiguredTransformerAdaptiveExternalProcessing(
          authorization,
          adaptiveModelEnv(),
        ),
      adaptiveCandidateDataRoot: root,
      adaptiveCandidateRecorder: recorder,
      commandRunner: async ({ cwd }) => {
        const content = readFileSync(join(cwd, "package.json"), "utf8");
        const passed = content.includes('"mendpointAdaptiveReview": "fixed"');
        return {
          exitCode: passed ? 0 : 9,
          stdout: passed ? "verified" : "",
          stderr: passed ? "" : "deterministic gate failed",
        };
      },
    });

    expect(result).toMatchObject({ attempted: 1, completed: 0, failed: 1 });
    const adaptiveRoute = getRoutingLedgerForJob(db, "campaign-a", "tenant-a")[0]!;
    expect(adaptiveRoute.provider_id).toBe("openai-compatible");
    expect(adaptiveRoute.selected_executor_id).toMatch(/^transformer-model-[a-f0-9]{64}$/);
    expect(adaptiveRoute.decision_json).toContain("model-a@us-central-primary@sha256:");
    expect(listAdaptiveCandidates(db, "tenant-a")).toEqual([
      expect.objectContaining({
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        unitId: "unit-a",
        kind: "adaptive",
        status: "review_pending",
        // Default policy is disabled: the candidate records as `standard`, so the
        // existing uniform single-approval review path is unchanged.
        reviewTier: "standard",
        failingCommandId: "runtime-declarations",
        changedPaths: [".node-version", ".nvmrc", "Dockerfile", "package.json"],
      }),
    ]);
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(recorder.mock.calls[0]![1].reviewTier).toBe("standard");
    expect(result.adaptiveModelEvidence).toEqual([
      expect.objectContaining({
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        provider: "openai-compatible",
        model: "model-a",
        deployment: "us-central-primary",
        executionRegion: "us-central1",
        maximumDataClassification: "confidential",
        endpointHost: "models.example",
        endpointProtocol: "https:",
        bodyRequestIds: ["adaptive-body-request-a"],
        headerRequestIds: ["adaptive-header-request-a"],
        promptTokens: 50,
        completionTokens: 15,
        totalTokens: 65,
        costUsd: 0.00008,
        path: expect.any(String),
        sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }),
    ]);
    const evidence = JSON.parse(
      readFileSync(result.adaptiveModelEvidence![0]!.path, "utf8"),
    ) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      kind: "transformer.adaptive.model_evidence",
      policy: {
        approvedExternalProcessing: true,
        executionRegion: "us-central1",
        maximumDataClassification: "confidential",
      },
      calls: [expect.objectContaining({
        actualModel: "model-a",
        bodyRequestId: "adaptive-body-request-a",
        headerRequestId: "adaptive-header-request-a",
      })],
    });
  });

  it("drives the launch MissionTask when the live claim takes a lease", async () => {
    const { root, db, store } = setup();
    const missionId = seedRegaugeMissionForCampaignA(db);
    const task = createMissionTask(db, {
      id: regaugeLaunchMissionTaskId(missionId, "repository-a"),
      tenantId: "tenant-a",
      missionId,
      taskType: "code_migration",
      acceptanceCriteria: "Complete the launched ReGauge unit for repository repository-a.",
      risk: "medium",
      actorPrincipalId: "principal-a",
      eventId: "mt-regauge-claim-created",
      idempotencyKey: "mt-regauge-claim-create",
      correlationId: "campaign-a",
      createdAt: CREATED_AT,
    });
    expect(task.status).toBe("unassigned");

    const result = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-a",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      runId: "run-mission-task-claim",
      now: () => RUN_AT,
      leaseToken: () => "transformer-lane-lease-token-mission-task",
      commandRunner: async () => ({ exitCode: 0, stdout: "verified", stderr: "" }),
    });

    expect(result).toMatchObject({ attempted: 1, completed: 1, errors: [] });
    expect(getMissionTask(db, "tenant-a", task.id)).toMatchObject({
      status: "human_review_required",
      ownerType: "human",
      handoffReason: "architecture_decision_required",
    });
  });

  it("does not hand the launch MissionTask to review when the attempt fails", async () => {
    const { root, db, store } = setup();
    const missionId = seedRegaugeMissionForCampaignA(db);
    const task = createMissionTask(db, {
      id: regaugeLaunchMissionTaskId(missionId, "repository-a"),
      tenantId: "tenant-a",
      missionId,
      taskType: "code_migration",
      acceptanceCriteria: "Complete the launched ReGauge unit for repository repository-a.",
      risk: "medium",
      actorPrincipalId: "principal-a",
      eventId: "mt-regauge-fail-created",
      idempotencyKey: "mt-regauge-fail-create",
      correlationId: "campaign-a",
      createdAt: CREATED_AT,
    });

    const result = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-a",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      runId: "run-mission-task-fail",
      now: () => RUN_AT,
      leaseToken: () => "transformer-lane-lease-token-mission-task-fail",
      commandRunner: async () => ({
        exitCode: 9,
        stdout: "",
        stderr: "deterministic gate failed",
      }),
    });

    expect(result).toMatchObject({ attempted: 1, completed: 0, failed: 1 });
    expect(getMissionTask(db, "tenant-a", task.id)).toMatchObject({
      status: "agent_working",
      ownerType: "agent",
    });
  });

  it("does not hand the launch MissionTask to review when completing loses the lease", async () => {
    const { root, db, store } = setup();
    const missionId = seedRegaugeMissionForCampaignA(db);
    const task = createMissionTask(db, {
      id: regaugeLaunchMissionTaskId(missionId, "repository-a"),
      tenantId: "tenant-a",
      missionId,
      taskType: "code_migration",
      acceptanceCriteria: "Complete the launched ReGauge unit for repository repository-a.",
      risk: "medium",
      actorPrincipalId: "principal-a",
      eventId: "mt-regauge-lease-lost-created",
      idempotencyKey: "mt-regauge-lease-lost-create",
      correlationId: "campaign-a",
      createdAt: CREATED_AT,
    });
    // The lease is lost at completion: `store.completeAttempt` throws on the fence
    // (the reference lease discipline), so the review handoff must never run.
    const complete = vi.spyOn(store, "completeAttempt").mockImplementation(() => {
      throw new Error("transformer_pilot_fence_stale");
    });

    await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-a",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      runId: "run-mission-task-lease-lost",
      now: () => RUN_AT,
      leaseToken: () => "transformer-lane-lease-token-mission-task-lease-lost",
      commandRunner: async () => ({ exitCode: 0, stdout: "verified", stderr: "" }),
    }).catch(() => undefined);

    expect(complete).toHaveBeenCalled();
    // The claim drove the task to agent_working; a lost-lease complete must leave
    // it there, never at human_review_required.
    expect(getMissionTask(db, "tenant-a", task.id)).toMatchObject({
      status: "agent_working",
      ownerType: "agent",
    });
    complete.mockRestore();
  });

  it("stamps the campaign Mission id onto the trajectory a ReGauge run produces", async () => {
    const fixture = setup();
    const missionId = seedRegaugeMissionForCampaignA(fixture.db);

    const result = await runAdaptiveLaneOnce(fixture);
    expect(result).toMatchObject({ attempted: 1, failed: 1 });

    const candidates = listAdaptiveCandidates(fixture.db, "tenant-a");
    expect(candidates).toHaveLength(1);
    const attemptId = candidates[0]!.attemptId;

    const trajectories = fixture.db.raw
      .prepare(
        `SELECT product, mission_id, run_id, final_outcome FROM trajectories WHERE tenant_id = ?`,
      )
      .all("tenant-a") as Array<{
        product: string;
        mission_id: string | null;
        run_id: string | null;
        final_outcome: string | null;
      }>;
    expect(trajectories).toHaveLength(1);
    expect(trajectories[0]).toMatchObject({
      product: "regauge",
      mission_id: missionId,
      // run_id stays populated with the attempt id: the existing per-attempt key
      // is preserved, not replaced by mission_id.
      run_id: attemptId,
      final_outcome: "candidate_review_pending",
    });
  });

  it("does not claim a bound Mission when the inherited envelope denies the repository", async () => {
    const { root, db, store } = setup();
    registerTenantA(db);
    dbModule.insertPrincipal(db, {
      id: "principal-a",
      tenantId: "tenant-a",
      kind: "human",
      subject: "owner@tenant-a.example",
      displayName: "Owner A",
      createdAt: CREATED_AT,
    });
    const mission = dbModule.createMission(db, {
      id: "mission-regauge-denied",
      tenantId: "tenant-a",
      product: "regauge",
      triggerKind: "migration_objective",
      objective: "Runtime upgrade for campaign-a",
      ownerPrincipalId: "principal-a",
      eventId: "mission-regauge-denied-created",
      idempotencyKey: "mission-regauge-denied-create",
      correlationId: "campaign-a",
      createdAt: CREATED_AT,
    });
    dbModule.linkRegaugeCampaignToMission(db, {
      tenantId: "tenant-a",
      missionId: mission.id,
      regaugeCampaignId: "campaign-a",
      actorPrincipalId: "principal-a",
      eventId: "mission-regauge-denied-linked",
      idempotencyKey: "mission-regauge-denied-link",
      correlationId: "campaign-a",
      createdAt: CREATED_AT,
    });
    const envelope = {
      ...defaultPolicyEnvelope({
        tenantId: "tenant-a",
        policyEnvelopeId: "pe-denied-a",
        createdAt: CREATED_AT,
        version: 1,
      }),
      repositoryScope: Object.freeze(["repository-other"]),
    };
    dbModule.createPolicyEnvelope(db, {
      tenantId: "tenant-a",
      version: 1,
      policyEnvelopeId: envelope.policyEnvelopeId,
      envelopeJson: canonicalPolicyEnvelopeJson(envelope),
      createdAt: CREATED_AT,
    });
    dbModule.bindMissionToPolicyEnvelope(db, {
      tenantId: "tenant-a",
      missionId: mission.id,
      version: 1,
      actorPrincipalId: "principal-a",
      eventId: "mission-regauge-denied-bound",
      idempotencyKey: "mission-regauge-denied-bind",
      correlationId: "campaign-a",
      createdAt: CREATED_AT,
    });

    const result = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-a",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      runId: "run-policy-denied",
      now: () => RUN_AT,
      leaseToken: () => "transformer-lane-lease-token-policy-denied",
      commandRunner: async () => ({ exitCode: 0, stdout: "verified", stderr: "" }),
    });

    expect(result.attempted).toBe(0);
    expect(result.completed).toBe(0);
    expect(result.errors.some((error) => error.includes("mission_policy_denied"))).toBe(true);
    expect(store.getCampaign("tenant-a", "campaign-a")?.units[0]?.state).toBe("pending");
  });

  it("does not claim a bound Mission when the inherited envelope forbids the unit's changed paths", async () => {
    const { root, db, store } = setup();
    registerTenantA(db);
    dbModule.insertPrincipal(db, {
      id: "principal-a",
      tenantId: "tenant-a",
      kind: "human",
      subject: "owner@tenant-a.example",
      displayName: "Owner A",
      createdAt: CREATED_AT,
    });
    const mission = dbModule.createMission(db, {
      id: "mission-regauge-forbidden",
      tenantId: "tenant-a",
      product: "regauge",
      triggerKind: "migration_objective",
      objective: "Runtime upgrade for campaign-a",
      ownerPrincipalId: "principal-a",
      eventId: "mission-regauge-forbidden-created",
      idempotencyKey: "mission-regauge-forbidden-create",
      correlationId: "campaign-a",
      createdAt: CREATED_AT,
    });
    dbModule.linkRegaugeCampaignToMission(db, {
      tenantId: "tenant-a",
      missionId: mission.id,
      regaugeCampaignId: "campaign-a",
      actorPrincipalId: "principal-a",
      eventId: "mission-regauge-forbidden-linked",
      idempotencyKey: "mission-regauge-forbidden-link",
      correlationId: "campaign-a",
      createdAt: CREATED_AT,
    });
    // The tenant declares the unit's exact changed paths as forbidden zones. The
    // lane must refuse to claim the unit rather than rewrite them.
    const envelope = {
      ...defaultPolicyEnvelope({
        tenantId: "tenant-a",
        policyEnvelopeId: "pe-forbidden-a",
        createdAt: CREATED_AT,
        version: 1,
      }),
      forbiddenZones: Object.freeze([".node-version", ".nvmrc", "Dockerfile", "package.json"]),
    };
    dbModule.createPolicyEnvelope(db, {
      tenantId: "tenant-a",
      version: 1,
      policyEnvelopeId: envelope.policyEnvelopeId,
      envelopeJson: canonicalPolicyEnvelopeJson(envelope),
      createdAt: CREATED_AT,
    });
    dbModule.bindMissionToPolicyEnvelope(db, {
      tenantId: "tenant-a",
      missionId: mission.id,
      version: 1,
      actorPrincipalId: "principal-a",
      eventId: "mission-regauge-forbidden-bound",
      idempotencyKey: "mission-regauge-forbidden-bind",
      correlationId: "campaign-a",
      createdAt: CREATED_AT,
    });

    const result = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-a",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      runId: "run-policy-forbidden",
      now: () => RUN_AT,
      leaseToken: () => "transformer-lane-lease-token-policy-forbid",
      commandRunner: async () => ({ exitCode: 0, stdout: "verified", stderr: "" }),
    });

    expect(result.attempted).toBe(0);
    expect(result.completed).toBe(0);
    expect(result.errors.some((error) => error.includes("mission_policy_denied"))).toBe(true);
    expect(result.errors.some((error) => error.includes("forbidden_zone_edit"))).toBe(true);
    expect(store.getCampaign("tenant-a", "campaign-a")?.units[0]?.state).toBe("pending");
  });

  it("does not claim a bound Mission when the envelope forbids training capture and the adaptive model would capture", async () => {
    const { root, db, store } = setup();
    registerTenantA(db);
    dbModule.insertPrincipal(db, {
      id: "principal-a",
      tenantId: "tenant-a",
      kind: "human",
      subject: "owner@tenant-a.example",
      displayName: "Owner A",
      createdAt: CREATED_AT,
    });
    const mission = dbModule.createMission(db, {
      id: "mission-regauge-training",
      tenantId: "tenant-a",
      product: "regauge",
      triggerKind: "migration_objective",
      objective: "Runtime upgrade for campaign-a",
      ownerPrincipalId: "principal-a",
      eventId: "mission-regauge-training-created",
      idempotencyKey: "mission-regauge-training-create",
      correlationId: "campaign-a",
      createdAt: CREATED_AT,
    });
    dbModule.linkRegaugeCampaignToMission(db, {
      tenantId: "tenant-a",
      missionId: mission.id,
      regaugeCampaignId: "campaign-a",
      actorPrincipalId: "principal-a",
      eventId: "mission-regauge-training-linked",
      idempotencyKey: "mission-regauge-training-link",
      correlationId: "campaign-a",
      createdAt: CREATED_AT,
    });
    // The default envelope forbids training-data capture (trainingDataAllowed:
    // false). Everything else is unrestricted, so training_capture is the only
    // dimension that can deny — a clean signal it fired.
    ensureDefaultPolicyEnvelopeBinding(db, {
      tenantId: "tenant-a",
      missionId: mission.id,
      actorPrincipalId: "principal-a",
      correlationId: "campaign-a",
      createdAt: CREATED_AT,
    });

    // An adaptive adapter whose external call routes to the contributor training
    // tier (muse-spark-1.2-contributor). The policy assert runs before any model
    // call, so no request is made.
    const contributorEnv: NodeJS.ProcessEnv = {
      ...adaptiveModelEnv(),
      LLM_AGENT_MODEL: "muse-spark-1.2-contributor",
    };
    const contributorAdapter = resolveTransformerAdaptivePlannerAdapter("tenant-a", contributorEnv, {
      priceTable: {
        "muse-spark-1.2-contributor": { promptUsdPerMillion: 1, completionUsdPerMillion: 2 },
      },
      fetchImpl: async () => new Response("{}", { status: 200 }),
    })!;

    const result = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-a",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      runId: "run-policy-training",
      now: () => RUN_AT,
      leaseToken: () => "transformer-lane-lease-token-policy-train",
      adaptivePlannerAdapterForTenant: () => contributorAdapter,
      authorizeAdaptiveExternalProcessing: () => ({
        allowed: true as const,
        evidenceRef: "evidence:adaptive-training-capture",
      }),
      adaptiveCandidateDataRoot: root,
      commandRunner: async () => ({ exitCode: 0, stdout: "verified", stderr: "" }),
    });

    expect(result.attempted).toBe(0);
    expect(result.completed).toBe(0);
    expect(result.errors.some((error) => error.includes("mission_policy_denied"))).toBe(true);
    expect(result.errors.some((error) => error.includes("training_capture_forbidden"))).toBe(true);
    expect(store.getCampaign("tenant-a", "campaign-a")?.units[0]?.state).toBe("pending");
  });

  it("records a null-mission trajectory for a campaign with no Mission and never fabricates one", async () => {
    const fixture = setup();
    // Tenant exists but no Mission is linked — a campaign created before the
    // Mission primitive was wired. The trajectory must still record, mission NULL.
    registerTenantA(fixture.db);

    const result = await runAdaptiveLaneOnce(fixture);
    expect(result).toMatchObject({ attempted: 1, failed: 1 });
    expect(listAdaptiveCandidates(fixture.db, "tenant-a")).toHaveLength(1);

    const trajectories = fixture.db.raw
      .prepare(`SELECT product, mission_id FROM trajectories WHERE tenant_id = ?`)
      .all("tenant-a") as Array<{ product: string; mission_id: string | null }>;
    expect(trajectories).toHaveLength(1);
    expect(trajectories[0]!.product).toBe("regauge");
    expect(trajectories[0]!.mission_id).toBeNull();
  });

  it("rolls back ReGauge candidate persistence when trajectory accounting fails", async () => {
    const fixture = setup();
    // tenant-a is deliberately NOT registered, so recordTrajectory (which asserts
    // the tenant exists) fails closed. Candidate + trajectory accounting are one
    // App DB transaction, so neither may become visible independently.
    const result = await runAdaptiveLaneOnce(fixture);
    expect(result).toMatchObject({ attempted: 1, failed: 1 });
    expect(listAdaptiveCandidates(fixture.db, "tenant-a")).toHaveLength(0);
    const count = fixture.db.raw
      .prepare(`SELECT COUNT(*) AS n FROM trajectories WHERE tenant_id = ?`)
      .get("tenant-a") as { n: number };
    expect(count.n).toBe(0);
  });

  it("records an escalated tier when a review-tier policy is configured", async () => {
    const { root, db, store } = setup();
    registerTenantA(db);
    const adapter = adaptiveAdapter();
    const recorder = vi.fn<typeof dbModule.recordAdaptiveCandidate>((candidateDb, input) =>
      dbModule.recordAdaptiveCandidate(candidateDb, input),
    );
    // Enable tiering with an escalate band that any real candidate trips (the
    // converged fix changes four files > 1). This proves the configured policy
    // flows through the lane and raises the required sign-off. It never lowers
    // the bar: every candidate is still human-reviewed, nothing auto-merges.
    const result = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-adaptive-tier",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      runId: "run-adaptive-tier",
      now: () => RUN_AT,
      leaseToken: () => "transformer-adaptive-lease-token-0003",
      adaptivePlannerAdapterForTenant: () => adapter,
      authorizeAdaptiveExternalProcessing: (authorization) =>
        authorizeConfiguredTransformerAdaptiveExternalProcessing(
          authorization,
          adaptiveModelEnv(),
        ),
      adaptiveCandidateDataRoot: root,
      adaptiveCandidateRecorder: recorder,
      adaptiveReviewTierPolicy: {
        ...RECOMMENDED_REVIEW_TIER_POLICY,
        enabled: true,
        escalate: {
          ...RECOMMENDED_REVIEW_TIER_POLICY.escalate,
          minConfidence: 100,
          maxChangedFiles: 1,
        },
      },
      commandRunner: async ({ cwd }) => {
        const content = readFileSync(join(cwd, "package.json"), "utf8");
        const passed = content.includes('"mendpointAdaptiveReview": "fixed"');
        return {
          exitCode: passed ? 0 : 9,
          stdout: passed ? "verified" : "",
          stderr: passed ? "" : "deterministic gate failed",
        };
      },
    });

    expect(result).toMatchObject({ attempted: 1, completed: 0, failed: 1 });
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(recorder.mock.calls[0]![1].reviewTier).toBe("escalated");
    expect(listAdaptiveCandidates(db, "tenant-a")).toEqual([
      expect.objectContaining({ kind: "adaptive", status: "review_pending", reviewTier: "escalated" }),
    ]);
  });

  it("recovers the exact fenced seal after App DB import fails", async () => {
    const { root, db, store } = setup();
    registerTenantA(db);
    const recorder = vi.fn<typeof dbModule.recordAdaptiveCandidate>(() => {
      throw new Error("database unavailable");
    });
    const result = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-adaptive-failure",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      runId: "run-adaptive-failure",
      now: () => RUN_AT,
      leaseToken: () => "transformer-adaptive-lease-token-0002",
      adaptivePlannerAdapterForTenant: () => adaptiveAdapter(),
      authorizeAdaptiveExternalProcessing: (authorization) =>
        authorizeConfiguredTransformerAdaptiveExternalProcessing(
          authorization,
          adaptiveModelEnv(),
        ),
      adaptiveCandidateDataRoot: root,
      adaptiveCandidateRecorder: recorder,
      commandRunner: async ({ cwd }) => {
        const passed = readFileSync(join(cwd, "package.json"), "utf8")
          .includes('"mendpointAdaptiveReview": "fixed"');
        return { exitCode: passed ? 0 : 9, stdout: "", stderr: passed ? "" : "failed" };
      },
    });

    expect(result).toMatchObject({ failed: 1, completed: 0 });
    expect(result.errors).toContain("transformer_adaptive_candidate_persistence_failed");
    expect(result.adaptiveModelEvidence).toEqual([
      expect.objectContaining({
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        unitId: "unit-a",
        created: true,
      }),
    ]);
    expect(store.getCampaign("tenant-a", "campaign-a")).toMatchObject({
      state: "paused",
      units: [{
        state: "failed",
        retryAuthorized: false,
        adaptiveCandidateHandoff: {
          repositoryId: "repository-a",
          snapshotId: "snapshot-a",
          baseBranch: "main",
          expectedBaseRevision: SOURCE_REVISION,
          changedPaths: [".node-version", ".nvmrc", "Dockerfile", "package.json"],
        },
      }],
      exceptions: [{ code: "verification_failed", state: "open" }],
    });
    expect(store.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "attempt.adaptive_candidate_handoff"
    )).toHaveLength(1);
    expect(listAdaptiveCandidates(db, "tenant-a")).toEqual([]);
    expect(recursiveFiles(join(root, "transformer-adaptive-candidates"))).toHaveLength(1);
    expect(recursiveFiles(join(root, "evidence", "adaptive-model"))).toHaveLength(1);
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(store.listAdaptiveCandidateHandoffs("tenant-a", 10, gateConfig())).toHaveLength(1);

    const recovered = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-adaptive-recovery",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      runId: "run-adaptive-recovery",
      now: () => RUN_AT,
      adaptiveCandidateDataRoot: root,
    });

    expect(recovered.errors).toEqual([]);
    expect(recovered).toMatchObject({
      attempted: 0,
      completed: 0,
      failed: 0,
      adaptiveRecovered: 1,
    });
    expect(listAdaptiveCandidates(db, "tenant-a")).toEqual([
      expect.objectContaining({ campaignId: "campaign-a", unitId: "unit-a", status: "review_pending" }),
    ]);
    expect(store.getCampaign("tenant-a", "campaign-a")).toMatchObject({
      units: [{ adaptiveCandidateHandoff: { importedAt: RUN_AT } }],
    });

    const replay = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-adaptive-recovery-replay",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      runId: "run-adaptive-recovery-replay",
      now: () => RUN_AT,
      adaptiveCandidateDataRoot: root,
    });
    expect(replay.adaptiveRecovered).toBeUndefined();
    expect(listAdaptiveCandidates(db, "tenant-a")).toHaveLength(1);
  });

  it("hands off before claim or model execution without exact external-processing authorization", async () => {
    const { root, db, store } = setup();
    const result = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "worker-adaptive-denied",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      runId: "run-adaptive-denied",
      now: () => RUN_AT,
      leaseToken: () => "transformer-adaptive-lease-token-denied",
      adaptivePlannerAdapterForTenant: () => adaptiveAdapter(),
      authorizeAdaptiveExternalProcessing: (authorization) =>
        authorizeConfiguredTransformerAdaptiveExternalProcessing(
          authorization,
          {
            ...adaptiveModelEnv(),
            MENDPOINT_REGAUGE_ADAPTIVE_MODEL_DEPLOYMENT: "drifted-deployment",
          },
        ),
    });

    expect(result).toMatchObject({ attempted: 0, completed: 0, failed: 0, handoff: 1 });
    expect(result.errors).toEqual([
      "transformer_adaptive_external_processing_not_authorized:campaign-a",
    ]);
    expect(store.getCampaign("tenant-a", "campaign-a")).toMatchObject({
      state: "running",
      units: [{ state: "pending" }],
    });
    expect(listAdaptiveCandidates(db, "tenant-a")).toEqual([]);
    expect(recursiveFiles(join(root, "evidence", "adaptive-model"))).toEqual([]);
  });

  it("expires a dead worker lease and pauses the campaign without executing it", async () => {
    const { root, db, store } = setup();
    store.claimNextAttempt({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      observedAt: CREATED_AT,
      evidenceRefs: ["evidence:claim-a"],
      idempotencyKey: "claim-before-death",
      leaseToken: "transformer-dead-worker-token-000001",
      leaseDurationMs: 1_000,
      gateConfig: gateConfig(),
    });

    const result = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(),
      tenantId: "tenant-a",
      workerId: "replacement-worker",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      now: () => "2026-08-05T10:00:02.000Z",
      runId: "expiry-run",
    });

    expect(result).toMatchObject({ enabled: true, expired: 1, attempted: 0 });
    expect(store.getCampaign("tenant-a", "campaign-a")).toMatchObject({
      state: "paused",
      units: [{ state: "failed", retryAuthorized: false }],
      exceptions: [{ code: "worker_crash", state: "open" }],
    });
    expect(recursiveFiles(join(root, "candidates"))).toEqual([]);
  });

  it("does not let revoked campaigns consume the authorized campaign limit", async () => {
    const { root, db, store } = setup();
    const deniedConstraints = createOrganizationConstraintContract({
      tenantId: "tenant-b",
      organizationId: "organization-b",
      version: 1,
      effectiveAt: "2026-08-05T09:00:00.000Z",
      sources: [{
        id: "policy-b",
        kind: "explicit_policy",
        repositoryId: "repository-b",
        revision: SOURCE_REVISION,
        digest: `sha256:${"e".repeat(64)}`,
        locator: "policy://organization-b/repository-b/v1",
        evidenceRefs: ["evidence:policy-b"],
      }],
      rules: [{
        id: "allow-recipe-b",
        sourceId: "policy-b",
        repositoryId: "repository-b",
        pathPattern: "**",
        actions: ["change"],
        effect: "allow",
        ownerIds: ["owner-b"],
        rationale: "Previously approved migration fixture",
      }],
    });
    const recipe = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
    const application = applyRecipe(recipe, FILES);
    for (let index = 0; index < 11; index++) {
      const campaignId = `revoked-${String(index).padStart(2, "0")}`;
      store.createCampaign({
        tenantId: "tenant-b",
        organizationId: "organization-b",
        environment: "staging",
        campaignId,
        constraints: deniedConstraints,
        units: [{
          id: "unit-b",
          title: "Migrate revoked repository",
          ownerId: "owner-b",
          reviewerIds: ["reviewer-b"],
          dependsOn: [],
          snapshot: {
            snapshotId: `snapshot-revoked-${String(index).padStart(2, "0")}`,
            repositoryId: "repository-b",
            revision: SOURCE_REVISION,
            manifestSha256: "f".repeat(64),
            digest: recipeFilesDigest(FILES),
            evidenceRefs: ["evidence:snapshot-b"],
          },
          candidateRevision: CANDIDATE_REVISION,
          candidateDigest: application.outputDigest,
          recipe,
          changedPaths: application.operations.map((operation) => operation.path),
        }],
        observedAt: "2026-08-05T09:00:00.000Z",
        evidenceRefs: ["evidence:revoked-campaign"],
        idempotencyKey: `create-${campaignId}`,
        gateConfig: gateConfig(["tenant-a", "tenant-b"]),
      });
    }

    const result = await runTransformerPilotLaneOnce({
      db,
      store,
      gateConfig: gateConfig(["tenant-a"]),
      workerId: "worker-a",
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      maxCampaigns: 10,
      runId: "fair-run",
      now: () => RUN_AT,
      leaseToken: () => "transformer-fair-lane-token-00000001",
      commandRunner: async () => ({ exitCode: 0, stdout: "verified", stderr: "" }),
    });

    expect(result.completed).toBe(1);
    expect(store.getCampaign("tenant-a", "campaign-a")?.units[0]?.state).toBe("executed");
    expect(store.getCampaign("tenant-b", "revoked-00")?.units[0]?.state).toBe("pending");
  });

  it("does not inspect or mutate campaigns when the default deny gate is absent", async () => {
    const store = {
      listExpiredAttempts: vi.fn(),
      expireAttempt: vi.fn(),
      listRunnableCampaigns: vi.fn(),
      claimNextAttempt: vi.fn(),
      assertCurrentAttemptFence: vi.fn(),
      completeAttempt: vi.fn(),
      recordAttemptFailure: vi.fn(),
    } as unknown as TransformerPilotLaneStore;
    const db = { raw: {} } as AppDb;

    await expect(runTransformerPilotLaneOnce({
      db,
      store,
      workerId: "worker-a",
      evidenceRoot: "C:\\evidence",
      candidateRoot: "C:\\candidates",
    })).resolves.toEqual({
      enabled: false,
      expired: 0,
      attempted: 0,
      completed: 0,
      failed: 0,
      stale: 0,
      idle: 0,
      errors: [],
    });
    expect(store.listExpiredAttempts).not.toHaveBeenCalled();
    expect(store.listRunnableCampaigns).not.toHaveBeenCalled();
  });

  it("resolves the same shared pilot database path as the API", () => {
    const dataRoot = resolve("shared-transformer-data");
    const databasePath = resolve("shared-transformer-state", "pilot.sqlite");
    expect(transformerPilotWorkerPath({ MENDPOINT_DATA_DIR: dataRoot }, resolve("worker-app")))
      .toBe(join(dataRoot, "transformer-pilot.sqlite"));
    expect(transformerPilotWorkerPath({
      MENDPOINT_REGAUGE_PILOT_DB: databasePath,
    }, resolve("worker-app"))).toBe(databasePath);
  });
});
