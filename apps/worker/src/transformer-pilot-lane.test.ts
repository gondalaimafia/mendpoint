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
  getRoutingLedgerForJob,
  listAdaptiveCandidates,
  insertConnectedRepository,
  insertRepositorySnapshot,
  insertRepositorySnapshotFiles,
  upsertScmConnection,
  type AppDb,
} from "@mendpoint/db";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  TransformerPilotExecutionStore,
  applyRecipe,
  createOrganizationConstraintContract,
  recipeFilesDigest,
  recipeReference,
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

function adaptiveModelEnv(): NodeJS.ProcessEnv {
  return {
    MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_ENABLED: "1",
    MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_TENANTS: "tenant-a",
    MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_PROVIDER: "openai-compatible",
    MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_DEPLOYMENT: "us-central-primary",
    MENDPOINT_TRANSFORMER_ADAPTIVE_EXTERNAL_PROCESSING_APPROVED: "1",
    MENDPOINT_TRANSFORMER_ADAPTIVE_EXECUTION_REGION: "us-central1",
    MENDPOINT_TRANSFORMER_ADAPTIVE_MAX_DATA_CLASSIFICATION: "confidential",
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
      expect(store.listEvents("tenant-a", "campaign-a").at(-1)?.type)
        .toBe("attempt.adaptive_candidate_handoff");
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
        failingCommandId: "runtime-declarations",
        changedPaths: [".node-version", ".nvmrc", "Dockerfile", "package.json"],
      }),
    ]);
    expect(recorder).toHaveBeenCalledTimes(1);
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

  it("recovers the exact fenced seal after App DB import fails", async () => {
    const { root, db, store } = setup();
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
    expect(result.adaptiveModelEvidence).toBeUndefined();
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
      exceptions: [{ code: "worker_crash", state: "open" }],
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
      expect.objectContaining({
        campaignId: "campaign-a",
        unitId: "unit-a",
        status: "review_pending",
      }),
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
            MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_DEPLOYMENT: "drifted-deployment",
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
      MENDPOINT_TRANSFORMER_PILOT_DB: databasePath,
    }, resolve("worker-app"))).toBe(databasePath);
  });
});
