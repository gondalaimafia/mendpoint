import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  insertConnectedRepository,
  insertRepositorySnapshot,
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
    expect(transformerPilotWorkerPath({ MENDPOINT_DATA_DIR: "C:\\data" }, "C:\\app"))
      .toBe(join("C:\\data", "transformer-pilot.sqlite"));
    expect(transformerPilotWorkerPath({
      MENDPOINT_TRANSFORMER_PILOT_DB: "C:\\state\\pilot.sqlite",
    }, "C:\\app")).toBe("C:\\state\\pilot.sqlite");
  });
});
