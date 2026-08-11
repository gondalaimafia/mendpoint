import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import {
  commitTransformerAttemptCheckpointGenesis,
  createTransformerEpisodeId,
  createTransformerVerificationPlanDigest,
  createTransformerWorkspaceArtifact,
  createTransformerWorkspaceManifestDigest,
  type TransformerAttemptCheckpointBinding,
  type TransformerAttemptCheckpointEnvelope,
  type TransformerAttemptCheckpointJournal,
  type TransformerAttemptCheckpointLease,
  type TransformerAttemptCheckpointState,
} from "./attempt-checkpoint.js";
import {
  createTransformerPilotCheckpointJournal,
  type TransformerAttemptCheckpointArtifactStore,
} from "./attempt-checkpoint-storage.js";
import { createOrganizationConstraintContract } from "./organization-constraints.js";
import {
  TransformerPilotExecutionStore,
  type TransformerAttemptLease,
  type TransformerPilotCampaignInput,
} from "./pilot-execution.js";
import { NODE_RUNTIME_18_TO_20_RECIPE, recipeReference } from "./recipe.js";
import { recipeFilesDigest } from "./recipe.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const revision = (character: string) => character.repeat(40);
const testEpoch = Date.now() - 5 * 60_000;
const time = (minute: number) => new Date(testEpoch + minute * 60_000).toISOString();
const sourceText = '{"name":"fixture"}\n';
const sourceFilesDigest = recipeFilesDigest({ "package.json": sourceText });

function gateConfig(): string {
  return JSON.stringify({
    schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
    tenantAllowlist: ["tenant-a"],
    environmentAllowlist: ["staging"],
    grants: [{
      tenantId: "tenant-a",
      environment: "staging",
      boundaries: ["worker_action", "delivery"],
      acceptanceEvidenceRefs: ["acceptance:pilot-a:v1"],
      productionDeliveryApprovalRefs: [],
    }],
  });
}

function createInput(): TransformerPilotCampaignInput {
  return {
    tenantId: "tenant-a",
    organizationId: "organization-a",
    environment: "staging",
    campaignId: "campaign-a",
    constraints: createOrganizationConstraintContract({
      tenantId: "tenant-a",
      organizationId: "organization-a",
      version: 1,
      effectiveAt: time(0),
      sources: [{
        id: "policy-repo-a",
        kind: "explicit_policy",
        repositoryId: "repo-a",
        revision: revision("a"),
        digest: digest("a"),
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
        rationale: "Approved migration scope",
      }],
    }),
    units: [{
      id: "unit-a",
      title: "Migrate repo-a",
      ownerId: "owner-repo-a",
      reviewerIds: ["reviewer-repo-a"],
      dependsOn: [],
      snapshot: {
        snapshotId: "snapshot-repo-a",
        repositoryId: "repo-a",
        revision: revision("a"),
        manifestSha256: "a".repeat(64),
        digest: sourceFilesDigest,
        evidenceRefs: ["evidence://snapshot/repo-a/a"],
      },
      candidateRevision: revision("c"),
      candidateDigest: digest("c"),
      recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
      changedPaths: ["package.json"],
    }],
    observedAt: time(0),
    evidenceRefs: ["evidence://campaign/approved"],
    idempotencyKey: "create-campaign-a",
    gateConfig: gateConfig(),
  };
}

function claim(store: TransformerPilotExecutionStore, leaseToken: string): TransformerAttemptLease {
  return store.claimNextAttempt({
    tenantId: "tenant-a",
    campaignId: "campaign-a",
    observedAt: time(1),
    evidenceRefs: ["evidence://attempt/claim"],
    idempotencyKey: "claim-campaign-a",
    leaseToken,
    leaseDurationMs: 3_600_000,
    gateConfig: gateConfig(),
  })!;
}

const encryptionKey = Buffer.from("81".repeat(32), "hex");

function checkpointFixture(
  lease: TransformerAttemptLease,
  source = sourceText,
): Readonly<{
  binding: TransformerAttemptCheckpointBinding;
  state: TransformerAttemptCheckpointState;
  workspaceBytes: Uint8Array;
}> {
  const sourceContent = Buffer.from(source, "utf8");
  const sourceManifest = [{
    path: "package.json",
    digest: `sha256:${createHash("sha256").update(sourceContent).digest("hex")}`,
    bytes: sourceContent.byteLength,
    mode: "file" as const,
  }];
  const candidateContent = Buffer.from('{"name":"changed"}\n', "utf8");
  const candidateManifest = [{
    path: "package.json",
    digest: `sha256:${createHash("sha256").update(candidateContent).digest("hex")}`,
    bytes: candidateContent.byteLength,
    mode: "file" as const,
  }];
  const verificationPlan = [{
    index: 0,
    commandId: "typecheck",
    commandDigest: digest("f"),
  }];
  const authority = createInput();
  const authorityUnit = authority.units[0]!;
  const binding: TransformerAttemptCheckpointBinding = {
    schemaVersion: 1,
    tenantId: "tenant-a",
    environment: "staging",
    campaignId: "campaign-a",
    unitId: "unit-a",
    repositoryId: "repo-a",
    snapshotId: "snapshot-repo-a",
    sourceRevision: revision("a"),
    sourceManifestDigest: createTransformerWorkspaceManifestDigest(sourceManifest),
    candidateRevision: authorityUnit.candidateRevision,
    candidateDigest: authorityUnit.candidateDigest,
    candidateManifestDigest: createTransformerWorkspaceManifestDigest(candidateManifest),
    recipeDigest: authorityUnit.recipe.digest,
    constraintDigest: authority.constraints.digest,
    executorDigest: digest("d"),
    verificationPlanDigest: createTransformerVerificationPlanDigest(verificationPlan),
    requiredVerificationCount: verificationPlan.length,
  };
  const episodeId = createTransformerEpisodeId(binding);
  const workspace = createTransformerWorkspaceArtifact(
    { tenantId: binding.tenantId, episodeId },
    [{ path: "package.json", content: sourceContent, mode: "file" }],
    encryptionKey,
  );
  return {
    binding,
    workspaceBytes: workspace.bytes,
    state: {
      schemaVersion: 1,
      episodeId,
      binding,
      generation: 1,
      attemptNumber: lease.attemptNumber,
      writerLeaseGeneration: lease.leaseGeneration,
      writerLeaseTokenDigest: lease.leaseTokenDigest,
      stage: "source_loaded",
      commandCursor: 0,
      verificationPlan,
      workspaceManifest: workspace.manifest,
      workspaceArtifact: workspace.artifact,
      verificationReceipts: [],
      accounting: {
        plannerCalls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        wallTimeMs: 0,
      },
      completedEffects: [],
      pendingEffect: { kind: "none" },
      candidateSeal: null,
      previousCheckpointDigest: null,
      createdAt: "2026-08-11T18:00:00.000Z",
    },
  };
}

class DurableArtifactStore implements TransformerAttemptCheckpointArtifactStore {
  readonly values = new Map<string, Uint8Array>();
  readonly unreferenced: string[] = [];

  async read(storageKey: string): Promise<Uint8Array | null> {
    const value = this.values.get(storageKey);
    return value ? new Uint8Array(value) : null;
  }

  async publishImmutableDurable(storageKey: string, bytes: Uint8Array): Promise<void> {
    const existing = this.values.get(storageKey);
    if (existing && !Buffer.from(existing).equals(Buffer.from(bytes))) {
      throw new Error("artifact_conflict");
    }
    this.values.set(storageKey, new Uint8Array(bytes));
  }

  async recordUnreferenced(storageKey: string): Promise<void> {
    this.unreferenced.push(storageKey);
  }
}

class EnvelopeJournal implements TransformerAttemptCheckpointJournal {
  #head: TransformerAttemptCheckpointEnvelope | null = null;
  readonly #artifacts = new Map<string, Uint8Array>();

  constructor(readonly activeLease: TransformerAttemptCheckpointLease) {}

  put(storageKey: string, bytes: Uint8Array): void {
    this.#artifacts.set(storageKey, bytes);
  }

  async read(): Promise<TransformerAttemptCheckpointEnvelope | null> {
    return this.#head;
  }

  async readLease(): Promise<TransformerAttemptCheckpointLease> {
    return this.activeLease;
  }

  async readArtifact(storageKey: string): Promise<Uint8Array | null> {
    return this.#artifacts.get(storageKey) ?? null;
  }

  async compareAndSwap(input: Readonly<{
    expectedStateDigest: string | null;
    next: TransformerAttemptCheckpointEnvelope;
  }>): Promise<boolean> {
    if ((this.#head?.stateDigest ?? null) !== input.expectedStateDigest) return false;
    this.#head = input.next;
    return true;
  }
}

describe("Transformer attempt checkpoint storage", () => {
  it("rejects a sealed binding that disagrees with coordinator authority", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput());
    const leaseToken = "lease-token-checkpoint-authority-01";
    const lease = claim(store, leaseToken);
    const checkpoint = checkpointFixture(lease);

    expect(() => createTransformerPilotCheckpointJournal({
      pilotStore: store,
      artifactStore: new DurableArtifactStore(),
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: "unit-a",
      binding: { ...checkpoint.binding, candidateDigest: digest("b") },
      encryptionKey,
      leaseToken,
      evidenceRefs: ["evidence://checkpoint/authority"],
      gateConfig: gateConfig(),
    })).toThrow("transformer_attempt_checkpoint_binding_authority_mismatch");
    store.close();
  });

  it("rejects authenticated genesis bytes that disagree with the source snapshot digest", async () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput());
    const leaseToken = "lease-token-checkpoint-source-00001";
    const lease = claim(store, leaseToken);
    const checkpoint = checkpointFixture(lease, '{"name":"wrong-source"}\n');
    const artifactStore = new DurableArtifactStore();
    await artifactStore.publishImmutableDurable(
      checkpoint.state.workspaceArtifact.storageKey,
      checkpoint.workspaceBytes,
    );
    const journal = createTransformerPilotCheckpointJournal({
      pilotStore: store,
      artifactStore,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: "unit-a",
      binding: checkpoint.binding,
      encryptionKey,
      leaseToken,
      evidenceRefs: ["evidence://checkpoint/source-authority"],
      gateConfig: gateConfig(),
    });

    await expect(commitTransformerAttemptCheckpointGenesis(
      journal,
      checkpoint.state,
      encryptionKey,
    )).rejects.toThrow("transformer_attempt_checkpoint_source_authority_mismatch");
    expect(store.readAttemptCheckpointHead({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: "unit-a",
      episodeId: checkpoint.state.episodeId,
    })).toBeNull();
    store.close();
  });

  it("recovers the exact envelope through a small coordinator head after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-checkpoint-journal-"));
    roots.push(root);
    const dbPath = join(root, "pilot.sqlite");
    const artifactStore = new DurableArtifactStore();
    const leaseToken = "lease-token-checkpoint-storage-0001";
    let pilotStore = new TransformerPilotExecutionStore(dbPath);
    pilotStore.createCampaign(createInput());
    const activeLease = claim(pilotStore, leaseToken);
    const checkpoint = checkpointFixture(activeLease);
    const episodeId = checkpoint.state.episodeId;
    await artifactStore.publishImmutableDurable(
      checkpoint.state.workspaceArtifact.storageKey,
      checkpoint.workspaceBytes,
    );
    let journal = createTransformerPilotCheckpointJournal({
      pilotStore,
      artifactStore,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: "unit-a",
      binding: checkpoint.binding,
      encryptionKey,
      leaseToken,
      evidenceRefs: ["evidence://checkpoint/storage"],
      gateConfig: gateConfig(),
    });
    const first = await commitTransformerAttemptCheckpointGenesis(
      journal,
      checkpoint.state,
      encryptionKey,
    );
    expect(await journal.read(episodeId)).toEqual(first);
    expect(JSON.stringify(pilotStore.getCampaign("tenant-a", "campaign-a")))
      .not.toContain(first.ciphertextBase64);
    pilotStore.close();

    pilotStore = new TransformerPilotExecutionStore(dbPath);
    journal = createTransformerPilotCheckpointJournal({
      pilotStore,
      artifactStore,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: "unit-a",
      binding: checkpoint.binding,
      encryptionKey,
      leaseToken,
      evidenceRefs: ["evidence://checkpoint/storage"],
      gateConfig: gateConfig(),
    });
    expect(await journal.read(episodeId)).toEqual(first);
    expect(await journal.readLease(episodeId)).toEqual({
      attemptNumber: activeLease.attemptNumber,
      generation: activeLease.leaseGeneration,
      tokenDigest: activeLease.leaseTokenDigest,
    });
    expect(await journal.readLease(episodeId)).not.toBeNull();
    pilotStore.close();
  });

  it("allows one competing head and leaves the losing coordinator unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-checkpoint-contention-"));
    roots.push(root);
    const path = join(root, "pilot.sqlite");
    const artifactStore = new DurableArtifactStore();
    const firstStore = new TransformerPilotExecutionStore(path);
    const secondStore = new TransformerPilotExecutionStore(path);
    firstStore.createCampaign(createInput());
    const leaseToken = "lease-token-checkpoint-contention-1";
    const lease = claim(firstStore, leaseToken);
    const checkpoint = checkpointFixture(lease);
    const episodeId = checkpoint.state.episodeId;
    await artifactStore.publishImmutableDurable(
      checkpoint.state.workspaceArtifact.storageKey,
      checkpoint.workspaceBytes,
    );
    const adapter = (pilotStore: TransformerPilotExecutionStore) =>
      createTransformerPilotCheckpointJournal({
        pilotStore,
        artifactStore,
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        unitId: "unit-a",
        binding: checkpoint.binding,
        encryptionKey,
        leaseToken,
        evidenceRefs: ["evidence://checkpoint/contention"],
        gateConfig: gateConfig(),
      });
    const activeLease = {
      attemptNumber: lease.attemptNumber,
      generation: lease.leaseGeneration,
      tokenDigest: lease.leaseTokenDigest,
    };
    const winnerJournal = new EnvelopeJournal(activeLease);
    winnerJournal.put(checkpoint.state.workspaceArtifact.storageKey, checkpoint.workspaceBytes);
    const winner = await commitTransformerAttemptCheckpointGenesis(
      winnerJournal,
      checkpoint.state,
      encryptionKey,
    );
    const loserJournal = new EnvelopeJournal(activeLease);
    loserJournal.put(checkpoint.state.workspaceArtifact.storageKey, checkpoint.workspaceBytes);
    const loser = await commitTransformerAttemptCheckpointGenesis(
      loserJournal,
      { ...checkpoint.state, createdAt: "2026-08-11T18:00:01.000Z" },
      encryptionKey,
    );

    await expect(adapter(firstStore).compareAndSwap({
      episodeId,
      expectedStateDigest: null,
      activeLease,
      next: winner,
    })).resolves.toBe(true);
    await expect(adapter(secondStore).compareAndSwap({
      episodeId,
      expectedStateDigest: null,
      activeLease,
      next: loser,
    })).resolves.toBe(false);
    expect(await adapter(secondStore).read(episodeId)).toEqual(winner);
    expect(loser.stateDigest).not.toBe(winner.stateDigest);
    expect(artifactStore.unreferenced).toHaveLength(1);
    expect(firstStore.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "attempt.checkpoint_head_advanced"
    )).toHaveLength(1);
    secondStore.close();
    firstStore.close();
  });
});
