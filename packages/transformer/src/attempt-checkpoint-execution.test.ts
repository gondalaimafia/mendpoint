import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import { createTransformerPilotAttemptCheckpointConfig } from "./attempt-checkpoint-execution.js";
import {
  createTransformerPilotCheckpointAuthority,
  type TransformerAttemptCheckpointArtifactStore,
} from "./attempt-checkpoint-storage.js";
import { createOrganizationConstraintContract } from "./organization-constraints.js";
import {
  TransformerPilotExecutionStore,
  type TransformerAttemptLease,
  type TransformerPilotCampaignInput,
} from "./pilot-execution.js";
import {
  runTransformerAttempt,
  type TransformerAttemptCoordinatorPort,
} from "./attempt-runner.js";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  applyRecipe,
  recipeFilesDigest,
  recipeReference,
  type RecipeFiles,
} from "./recipe.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SOURCE_FILES: RecipeFiles = Object.freeze({
  "package.json": `${JSON.stringify({
    name: "transformer-checkpoint-controller",
    private: true,
    engines: { node: ">=18 <19" },
  }, null, 2)}\n`,
  ".nvmrc": "18\n",
  ".node-version": "18.20.4\n",
  Dockerfile: "FROM node:18-alpine\nWORKDIR /app\n",
  "src/server.js": "export const ready = true;\n",
});
const SOURCE_MODES = Object.freeze(Object.fromEntries(
  Object.keys(SOURCE_FILES).map((path) => [path, path === ".nvmrc" ? "100755" : "100644"]),
) as Record<string, "100644" | "100755">);
const RECIPE = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
const APPLICATION = applyRecipe(RECIPE, SOURCE_FILES);
const LEASE_TOKEN = "checkpoint-controller-lease-token-0001";
const ENCRYPTION_KEY = Buffer.from("91".repeat(32), "hex");
const epoch = Date.now() - 60_000;
const time = (seconds: number): string => new Date(epoch + seconds * 1_000).toISOString();
const sha256 = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function gateConfig(): string {
  return JSON.stringify({
    schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
    tenantAllowlist: ["tenant-a"],
    environmentAllowlist: ["staging"],
    grants: [{
      tenantId: "tenant-a",
      environment: "staging",
      boundaries: ["worker_action", "delivery"],
      acceptanceEvidenceRefs: ["acceptance:checkpoint-controller:v1"],
      productionDeliveryApprovalRefs: [],
    }],
  });
}

function campaignInput(): TransformerPilotCampaignInput {
  const constraints = createOrganizationConstraintContract({
    tenantId: "tenant-a",
    organizationId: "organization-a",
    version: 1,
    effectiveAt: time(0),
    sources: [{
      id: "policy-repo-a",
      kind: "explicit_policy",
      repositoryId: "repo-a",
      revision: "a".repeat(40),
      digest: sha256("policy"),
      locator: "policy://organization-a/repo-a/v1",
      evidenceRefs: ["evidence://policy/repo-a/v1"],
    }],
    rules: [{
      id: "allow-repo-a",
      sourceId: "policy-repo-a",
      repositoryId: "repo-a",
      pathPattern: "**",
      actions: ["change"],
      effect: "allow",
      ownerIds: ["owner-repo-a"],
      rationale: "Approved runtime migration",
    }],
  });
  return {
    tenantId: "tenant-a",
    organizationId: "organization-a",
    environment: "staging",
    campaignId: "campaign-a",
    constraints,
    units: [{
      id: "unit-a",
      title: "Migrate repo-a",
      ownerId: "owner-repo-a",
      reviewerIds: ["reviewer-repo-a"],
      dependsOn: [],
      snapshot: {
        snapshotId: "snapshot-repo-a",
        repositoryId: "repo-a",
        revision: "a".repeat(40),
        manifestSha256: "a".repeat(64),
        digest: recipeFilesDigest(SOURCE_FILES),
        evidenceRefs: ["evidence://snapshot/repo-a/a"],
      },
      candidateRevision: "c".repeat(40),
      candidateDigest: APPLICATION.outputDigest,
      recipe: RECIPE,
      changedPaths: APPLICATION.operations.map((operation) => operation.path),
    }],
    observedAt: time(0),
    evidenceRefs: ["evidence://campaign/approved"],
    idempotencyKey: "create-campaign-a",
    gateConfig: gateConfig(),
  };
}

class MemoryArtifactStore implements TransformerAttemptCheckpointArtifactStore {
  readonly values = new Map<string, Uint8Array>();
  readonly referenced = new Set<string>();
  readonly unreferenced = new Set<string>();
  resultPublications = 0;
  failResultPublicationAt: number | null = null;
  failNextNewResultReference = false;
  failNextNewMissionReference = false;

  async read(storageKey: string): Promise<Uint8Array | null> {
    const value = this.values.get(storageKey);
    return value ? new Uint8Array(value) : null;
  }

  async publishImmutableDurable(storageKey: string, bytes: Uint8Array): Promise<void> {
    if (storageKey.includes("/effects/results/")) {
      this.resultPublications += 1;
      if (this.resultPublications === this.failResultPublicationAt) {
        throw new Error("injected coordinator result publication failure");
      }
    }
    const existing = this.values.get(storageKey);
    if (existing && !Buffer.from(existing).equals(Buffer.from(bytes))) throw new Error("artifact_conflict");
    this.values.set(storageKey, new Uint8Array(bytes));
  }

  async recordPending(): Promise<void> {}

  async recordReferenced(storageKey: string): Promise<void> {
    if (this.failNextNewMissionReference && storageKey.includes("/mission-evidence/") &&
        !this.referenced.has(storageKey)) {
      this.failNextNewMissionReference = false;
      throw new Error("injected mission reference ledger failure");
    }
    if (this.failNextNewResultReference && storageKey.includes("/effects/results/") &&
        !this.referenced.has(storageKey)) {
      this.failNextNewResultReference = false;
      throw new Error("injected reference ledger failure");
    }
    this.referenced.add(storageKey);
  }

  async recordUnreferenced(storageKey: string): Promise<void> {
    this.unreferenced.add(storageKey);
  }
}

function coordinatorFor(
  store: TransformerPilotExecutionStore,
  lease: TransformerAttemptLease,
): TransformerAttemptCoordinatorPort {
  return {
    claimNextAttempt: async () => lease,
    renewAttemptLease: (input) => store.renewAttemptLease(input),
    assertCurrentAttemptFence: (input) => store.assertCurrentAttemptFence(input),
    recordAdaptiveAttemptUsage: (input) => store.recordAdaptiveAttemptUsage(input),
    recordAdaptiveCandidateHandoff: (input) => store.recordAdaptiveCandidateHandoff(input),
    completeAttempt: (input) => store.completeAttempt(input),
    recordAttemptFailure: (input) => store.recordAttemptFailure(input),
  };
}

describe("Transformer attempt checkpoint execution controller", () => {
  it("bounds and aborts the initial remote authority lookup", async () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(campaignInput());
    const lease = store.claimNextAttempt({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      observedAt: time(1),
      evidenceRefs: ["evidence://attempt/claim"],
      idempotencyKey: "claim-campaign-a",
      leaseToken: LEASE_TOKEN,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    const localAuthority = createTransformerPilotCheckpointAuthority(store);
    let authoritySignal: AbortSignal | undefined;
    const checkpoint = createTransformerPilotAttemptCheckpointConfig({
      authority: Object.freeze({
        ...localAuthority,
        readBindingAuthority(input: Parameters<typeof localAuthority.readBindingAuthority>[0]) {
          authoritySignal = input.signal;
          return new Promise<never>(() => {});
        },
      }),
      artifactStore: new MemoryArtifactStore(),
      encryptionKey: ENCRYPTION_KEY,
      executorDigest: sha256("transformer-attempt-executor-v1"),
      evidenceRefs: ["evidence://checkpoint/controller"],
      gateConfig: gateConfig(),
      now: () => time(2),
      operationTimeoutMs: 10,
    });
    const signal = new AbortController().signal;

    await expect(checkpoint.open({
      scope: { tenantId: "tenant-a", environment: "staging", campaignId: "campaign-a" },
      lease,
      leaseToken: LEASE_TOKEN,
      attemptId: "attempt-a",
      source: {
        repositoryId: "repo-a",
        revision: "a".repeat(40),
        digest: recipeFilesDigest(SOURCE_FILES),
        files: SOURCE_FILES,
        fileModes: SOURCE_MODES,
      },
      fence: {
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        unitId: "unit-a",
        attemptId: "attempt-a",
        leaseGeneration: lease.leaseGeneration,
        leaseToken: LEASE_TOKEN,
      },
      assertFence: async () => {},
      observedAt: time(2),
      signal,
      operationTimeoutMs: 10,
    })).rejects.toThrow("transformer_attempt_checkpoint_operation_timeout");
    expect(authoritySignal?.aborted).toBe(true);
    store.close();
  });

  it("resumes after a verifier crash and completes atomically without replaying consumed work", async () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-checkpoint-controller-"));
    roots.push(root);
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(campaignInput());
    const lease = store.claimNextAttempt({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      observedAt: time(1),
      evidenceRefs: ["evidence://attempt/claim"],
      idempotencyKey: "claim-campaign-a",
      leaseToken: LEASE_TOKEN,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    const artifactStore = new MemoryArtifactStore();
    let clock = 2;
    const checkpoint = createTransformerPilotAttemptCheckpointConfig({
      authority: createTransformerPilotCheckpointAuthority(store),
      artifactStore,
      encryptionKey: ENCRYPTION_KEY,
      executorDigest: sha256("transformer-attempt-executor-v1"),
      evidenceRefs: ["evidence://checkpoint/controller"],
      gateConfig: gateConfig(),
      now: () => time(clock++),
      operationTimeoutMs: 5_000,
    });
    const commandRunner = vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "first passed", stderr: "" })
      .mockRejectedValueOnce(new Error("injected worker crash"))
      .mockResolvedValueOnce({ exitCode: 0, stdout: "second passed", stderr: "" });
    const input = {
      scope: { tenantId: "tenant-a", environment: "staging", campaignId: "campaign-a" },
      gateConfig: gateConfig(),
      coordinator: coordinatorFor(store, lease),
      loadExactSource: async () => ({
        repositoryId: "repo-a",
        revision: "a".repeat(40),
        digest: recipeFilesDigest(SOURCE_FILES),
        files: SOURCE_FILES,
        fileModes: SOURCE_MODES,
      }),
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      leaseDurationMs: 60_000,
      observedAt: (phase: "claim" | "execute" | "renew" | "usage" | "complete" | "failure") =>
        phase === "claim" ? time(1) : time(clock++),
      idempotencyKey: (phase: string, attemptId?: string) =>
        `controller:${phase}:${attemptId ?? "claim"}`,
      leaseToken: () => LEASE_TOKEN,
      commandRunner,
      actualCostUsd: 0,
      checkpoint,
    } as const;

    const interrupted = await runTransformerAttempt(input);
    expect(interrupted).toMatchObject({ status: "failed", recoveryCode: "worker_crash" });
    expect(commandRunner).toHaveBeenCalledTimes(2);
    expect(store.getCampaign("tenant-a", "campaign-a")?.units[0]?.state).toBe("running");

    artifactStore.failResultPublicationAt = 3;
    const candidateInterrupted = await runTransformerAttempt(input);
    expect(candidateInterrupted).toMatchObject({
      status: "failed",
      recoveryCode: "worker_crash",
    });
    expect(commandRunner).toHaveBeenCalledTimes(3);
    expect(store.getCampaign("tenant-a", "campaign-a")?.units[0]?.state).toBe("running");

    artifactStore.failNextNewResultReference = true;
    const ledgerInterrupted = await runTransformerAttempt(input);
    expect(ledgerInterrupted).toMatchObject({
      status: "failed",
      recoveryCode: "worker_crash",
    });
    expect(commandRunner).toHaveBeenCalledTimes(3);
    expect(store.getCampaign("tenant-a", "campaign-a")?.units[0]?.state).toBe("running");

    artifactStore.failNextNewMissionReference = true;
    const missionReferenceInterrupted = await runTransformerAttempt(input);
    expect(missionReferenceInterrupted).toMatchObject({
      status: "failed",
      recoveryCode: "worker_crash",
    });
    expect(commandRunner).toHaveBeenCalledTimes(3);
    const missionKeys = [...artifactStore.values.keys()].filter((key) => key.includes("/mission-evidence/"));
    expect(missionKeys).toHaveLength(2);
    expect(missionKeys.some((key) => !artifactStore.referenced.has(key))).toBe(true);

    artifactStore.failResultPublicationAt = artifactStore.resultPublications + 1;
    const coordinatorInterrupted = await runTransformerAttempt(input);
    expect(coordinatorInterrupted).toMatchObject({
      status: "failed",
      recoveryCode: "worker_crash",
    });
    expect(commandRunner).toHaveBeenCalledTimes(3);
    expect(store.getCampaign("tenant-a", "campaign-a")?.units[0]?.state).toBe("running");
    expect(missionKeys.every((key) => artifactStore.referenced.has(key))).toBe(true);

    const resumed = await runTransformerAttempt(input);
    expect(resumed.status).toBe("completed");
    expect(commandRunner).toHaveBeenCalledTimes(3);
    const campaign = store.getCampaign("tenant-a", "campaign-a")!;
    expect(campaign.units[0]?.state).toBe("executed");
    expect(campaign.units[0]?.attemptCheckpointHead).toMatchObject({
      episodeId: expect.stringMatching(/^tfepisode_/),
      generation: expect.any(Number),
    });
    expect(artifactStore.unreferenced).not.toContain(
      campaign.units[0]?.attemptCheckpointHead?.envelopeStorageKey,
    );
    store.close();
  });

  it("records an authenticated failed verifier result exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-checkpoint-failure-"));
    roots.push(root);
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(campaignInput());
    const lease = store.claimNextAttempt({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      observedAt: time(1),
      evidenceRefs: ["evidence://attempt/claim"],
      idempotencyKey: "claim-campaign-a",
      leaseToken: LEASE_TOKEN,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    const localAuthority = createTransformerPilotCheckpointAuthority(store);
    let failureCalls = 0;
    let durableFailureInput: Parameters<typeof localAuthority.failWithHead>[0] | undefined;
    const checkpoint = createTransformerPilotAttemptCheckpointConfig({
      authority: Object.freeze({
        ...localAuthority,
        async failWithHead(input) {
          failureCalls += 1;
          if (failureCalls <= 2) return;
          durableFailureInput = input;
          await localAuthority.failWithHead(input);
          if (failureCalls === 3) throw new Error("simulated_failure_response_loss");
        },
      }),
      artifactStore: new MemoryArtifactStore(),
      encryptionKey: ENCRYPTION_KEY,
      executorDigest: sha256("transformer-attempt-executor-v1"),
      evidenceRefs: ["evidence://checkpoint/controller"],
      gateConfig: gateConfig(),
      now: () => time(2),
      operationTimeoutMs: 5_000,
    });
    let clock = 3;
    const commandRunner = vi.fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "verification failed" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "retry first passed", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "retry second passed", stderr: "" });
    const attemptInput = {
      scope: { tenantId: "tenant-a", environment: "staging", campaignId: "campaign-a" },
      gateConfig: gateConfig(),
      coordinator: coordinatorFor(store, lease),
      loadExactSource: async () => ({
        repositoryId: "repo-a",
        revision: "a".repeat(40),
        digest: recipeFilesDigest(SOURCE_FILES),
        files: SOURCE_FILES,
        fileModes: SOURCE_MODES,
      }),
      evidenceRoot: join(root, "evidence"),
      candidateRoot: join(root, "candidates"),
      tempRoot: join(root, "workspaces"),
      leaseDurationMs: 60_000,
      observedAt: (phase: "claim" | "execute" | "renew" | "usage" | "complete" | "failure") =>
        phase === "claim" ? time(1) : time(clock++),
      idempotencyKey: (phase: string, attemptId?: string) =>
        `failure:${phase}:${attemptId ?? "claim"}`,
      leaseToken: () => LEASE_TOKEN,
      commandRunner,
      actualCostUsd: 0,
      checkpoint,
    } as const;
    const falseAcknowledgement = await runTransformerAttempt(attemptInput);
    expect(falseAcknowledgement).toMatchObject({ status: "failed", recoveryCode: "worker_crash" });
    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(store.getCampaign("tenant-a", "campaign-a")?.units[0]?.state).toBe("running");

    const result = await runTransformerAttempt(attemptInput);
    expect(result).toMatchObject({ status: "failed", recoveryCode: "verification_failed" });
    expect(commandRunner).toHaveBeenCalledTimes(1);
    const campaign = store.getCampaign("tenant-a", "campaign-a")!;
    expect(campaign.state).toBe("paused");
    expect(campaign.units[0]).toMatchObject({ state: "failed", retryAuthorized: false });
    expect(campaign.units[0]?.attemptCheckpointHead).toBeDefined();
    expect(failureCalls).toBe(4);
    expect(store.listEvents("tenant-a", "campaign-a")
      .filter((event) => event.type === "attempt.failed_with_checkpoint")).toHaveLength(1);
    if (durableFailureInput === undefined) throw new Error("missing durable failure input");
    expect(await localAuthority.readFailureReceipt(durableFailureInput)).toMatchObject({
      idempotencyKey: durableFailureInput.idempotencyKey,
      expectedStateDigest: durableFailureInput.expectedStateDigest,
    });
    expect(await localAuthority.readFailureReceipt({
      ...durableFailureInput,
      idempotencyKey: "different-failure-idempotency-key",
    })).toBeNull();

    const exceptionId = campaign.exceptions[0]!.id;
    store.control({
      tenantId: "tenant-a", campaignId: "campaign-a", action: "authorize_retry", unitId: "unit-a",
      observedAt: time(clock++), evidenceRefs: ["evidence://retry/authorized"],
      idempotencyKey: "authorize-retry-a",
    });
    store.control({
      tenantId: "tenant-a", campaignId: "campaign-a", action: "resolve_exception", exceptionId,
      resolution: "Transient verifier failure approved for one retry",
      observedAt: time(clock++), evidenceRefs: ["evidence://retry/resolved"],
      idempotencyKey: "resolve-retry-a",
    });
    store.control({
      tenantId: "tenant-a", campaignId: "campaign-a", action: "resume",
      observedAt: time(clock++), evidenceRefs: ["evidence://retry/resumed"],
      idempotencyKey: "resume-retry-a",
    });
    const retryToken = "retry-lease-token-abcdefghijklmnopqrstuvwxyz0123456789";
    const retryLease = store.claimNextAttempt({
      tenantId: "tenant-a", campaignId: "campaign-a", observedAt: time(clock++),
      evidenceRefs: ["evidence://retry/claim"], idempotencyKey: "retry-claim-a",
      leaseToken: retryToken, leaseDurationMs: 3_600_000, gateConfig: gateConfig(),
    })!;
    const retry = await runTransformerAttempt({
      ...attemptInput,
      coordinator: coordinatorFor(store, retryLease),
      leaseToken: () => retryToken,
    });
    expect(retry.status).toBe("completed");
    expect(commandRunner).toHaveBeenCalledTimes(3);
    expect(store.getCampaign("tenant-a", "campaign-a")?.units[0]?.state).toBe("executed");
    expect(await localAuthority.readFailureReceipt(durableFailureInput)).toMatchObject({
      idempotencyKey: durableFailureInput.idempotencyKey,
      expectedStateDigest: durableFailureInput.expectedStateDigest,
    });
    store.close();
  });
});
