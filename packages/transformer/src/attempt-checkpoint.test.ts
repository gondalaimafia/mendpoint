import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  advanceTransformerAttemptCheckpoint,
  commitTransformerAttemptCheckpointGenesis,
  createTransformerAttemptEffectIdentity,
  createTransformerCandidateSeal,
  createTransformerCandidateSealPayload,
  createTransformerCandidatePublicationRequest,
  createTransformerCandidatePublicationRequestDigest,
  createTransformerCoordinatorCompletionRequest,
  createTransformerCoordinatorCompletionRequestDigest,
  createTransformerCoordinatorCompletionSlot,
  createTransformerCoordinatorEffectResultArtifact,
  createTransformerMissionEvidenceArtifact,
  createTransformerEffectRequestArtifact,
  createTransformerEffectResultArtifact,
  createTransformerModelEffectResultArtifact,
  createTransformerEpisodeId,
  createTransformerVerificationPlanDigest,
  createTransformerVerifierEffectResultArtifact,
  createTransformerWorkspaceArtifact,
  createTransformerWorkspaceManifestDigest,
  createTransformerWorkspaceTransitionRequest,
  createTransformerWorkspaceTransitionDigest,
  openTransformerCoordinatorEffectResultArtifact,
  openTransformerCoordinatorCompletionRequest,
  openTransformerModelEffectResultArtifact,
  openTransformerAttemptCheckpoint,
  openTransformerAttemptCheckpointForDraftDelivery,
  openTransformerVerifierEffectResultArtifact,
  openTransformerWorkspaceArtifact,
  openTransformerWorkspaceTransitionRequest,
  prepareTransformerAttemptCheckpointAdvance,
  prepareTransformerAttemptCheckpointTerminalAdvance,
  supersedeTransformerAttemptCheckpointCoordinatorCompletion,
  upgradeTransformerAttemptCheckpointCoordinatorCompletionRequest,
  verifyTransformerWorkspaceArtifact,
  type TransformerAttemptCheckpointEnvelope,
  type TransformerAttemptCheckpointJournal,
  type TransformerAttemptCheckpointLease,
  type TransformerAttemptCheckpointState,
  type TransformerAttemptCheckpointEffectKind,
  type TransformerEncryptedArtifact,
  type TransformerWorkspaceArtifact,
} from "./attempt-checkpoint.js";
import {
  finalizeTransformerPilotAttemptCheckpoint,
  type TransformerAttemptCheckpointAuthorityPort,
  type TransformerAttemptCheckpointArtifactStore,
} from "./attempt-checkpoint-storage.js";
import {
  createTransformerAttemptAuthorizationDigest,
  createTransformerAttemptCompletionDigest,
  type TransformerAttemptCompletionIntent,
} from "./attempt-completion.js";
import {
  transformerAttemptCheckpointEnvelopeStorageKey,
  type TransformerAttemptCheckpointCompletionInput,
} from "./pilot-execution.js";
import { recipeFilesDigest } from "./recipe.js";

const key = Buffer.from("81".repeat(32), "hex");
const digest = (value: string | Uint8Array): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

class Journal implements TransformerAttemptCheckpointJournal {
  private heads = new Map<string, TransformerAttemptCheckpointEnvelope>();
  private leases = new Map<string, TransformerAttemptCheckpointLease>();
  private artifacts = new Map<string, Uint8Array>();

  setLease(episodeId: string, activeLease: TransformerAttemptCheckpointLease): void {
    this.leases.set(episodeId, activeLease);
  }

  putArtifact(storageKey: string, bytes: Uint8Array): void {
    this.artifacts.set(storageKey, bytes);
  }

  clone(): Journal {
    const copy = new Journal();
    copy.heads = new Map(this.heads);
    copy.leases = new Map(this.leases);
    copy.artifacts = new Map(this.artifacts);
    return copy;
  }

  async read(episodeId: string): Promise<TransformerAttemptCheckpointEnvelope | null> {
    return this.heads.get(episodeId) ?? null;
  }

  async readLease(episodeId: string): Promise<TransformerAttemptCheckpointLease | null> {
    return this.leases.get(episodeId) ?? null;
  }

  async readArtifact(storageKey: string): Promise<Uint8Array | null> {
    return this.artifacts.get(storageKey) ?? null;
  }

  async compareAndSwap(input: {
    episodeId: string;
    expectedStateDigest: string | null;
    activeLease: TransformerAttemptCheckpointLease;
    next: TransformerAttemptCheckpointEnvelope;
  }): Promise<boolean> {
    const current = this.heads.get(input.episodeId);
    if ((current?.stateDigest ?? null) !== input.expectedStateDigest ||
        JSON.stringify(this.leases.get(input.episodeId)) !== JSON.stringify(input.activeLease)) return false;
    this.heads.set(input.episodeId, input.next);
    return true;
  }
}

const lease = (attemptNumber = 1, generation = 1, token = "lease-a"):
TransformerAttemptCheckpointLease => ({
  attemptNumber,
  generation,
  tokenDigest: digest(token),
});

function fixture(activeLease = lease()): Readonly<{
  state: TransformerAttemptCheckpointState;
  artifactBytes: Uint8Array;
}> {
  const sourceContent = Buffer.from('{"name":"fixture"}\n');
  const sourceManifest = [{
    path: "package.json",
    digest: digest(sourceContent),
    bytes: sourceContent.byteLength,
    mode: "file" as const,
  }];
  const verificationPlan = [{
    index: 0,
    commandId: "typecheck",
    commandDigest: digest("npm run typecheck"),
  }];
  const candidateContent = Buffer.from('{"name":"changed"}\n');
  const candidateManifest = [{
    path: "package.json",
    digest: digest(candidateContent),
    bytes: candidateContent.byteLength,
    mode: "file" as const,
  }];
  const binding = {
    schemaVersion: 1 as const,
    tenantId: "tenant-a",
    environment: "customer",
    campaignId: "campaign-a",
    unitId: "unit-a",
    repositoryId: "repo-a",
    snapshotId: "snapshot-a",
    sourceRevision: "a".repeat(40),
    sourceManifestDigest: createTransformerWorkspaceManifestDigest(sourceManifest),
    candidateRevision: "b".repeat(40),
    candidateDigest: recipeFilesDigest({ "package.json": '{"name":"changed"}\n' }),
    candidateManifestDigest: createTransformerWorkspaceManifestDigest(candidateManifest),
    recipeDigest: digest("recipe"),
    constraintDigest: digest("constraints"),
    executorDigest: digest("executor"),
    verificationPlanDigest: createTransformerVerificationPlanDigest(verificationPlan),
    requiredVerificationCount: verificationPlan.length,
  };
  const episodeId = createTransformerEpisodeId(binding);
  const workspace = createTransformerWorkspaceArtifact(
    { tenantId: binding.tenantId, episodeId },
    [{ path: "package.json", content: sourceContent, mode: "file" }],
    key,
  );
  return {
    artifactBytes: workspace.bytes,
    state: {
      schemaVersion: 1,
      episodeId,
      binding,
      generation: 1,
      attemptNumber: activeLease.attemptNumber,
      writerLeaseGeneration: activeLease.generation,
      writerLeaseTokenDigest: activeLease.tokenDigest,
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

function install(journal: Journal, value: ReturnType<typeof fixture>, activeLease = lease()): void {
  journal.setLease(value.state.episodeId, activeLease);
  journal.putArtifact(value.state.workspaceArtifact.storageKey, value.artifactBytes);
}

async function consumeEffect(
  journal: Journal,
  head: TransformerAttemptCheckpointEnvelope,
  state: TransformerAttemptCheckpointState,
  input: Readonly<{
    kind: TransformerAttemptCheckpointEffectKind;
    slot: string;
    requestPayload: Uint8Array;
    createResult(effectId: string): Readonly<{
      artifact: TransformerEncryptedArtifact | TransformerWorkspaceArtifact;
      bytes: Uint8Array;
    }>;
    consume: (
      completed: TransformerAttemptCheckpointState,
      requestArtifact: TransformerEncryptedArtifact,
      resultArtifact: TransformerEncryptedArtifact | TransformerWorkspaceArtifact,
    ) => Partial<TransformerAttemptCheckpointState>;
  }>,
): Promise<Readonly<{
  head: TransformerAttemptCheckpointEnvelope;
  state: TransformerAttemptCheckpointState;
}>> {
  const requestDigest = digest(input.requestPayload);
  const identity = createTransformerAttemptEffectIdentity(
    state.episodeId,
    input.kind,
    input.slot,
    requestDigest,
  );
  const request = createTransformerEffectRequestArtifact({
    tenantId: state.binding.tenantId,
    episodeId: state.episodeId,
    effectId: identity.effectId,
  }, input.requestPayload, key);
  const result = input.createResult(identity.effectId);
  journal.putArtifact(request.artifact.storageKey, request.bytes);
  journal.putArtifact(result.artifact.storageKey, result.bytes);
  const timestamp = (generation: number): string =>
    new Date(Date.parse("2026-08-11T17:59:00.000Z") + generation * 60_000).toISOString();
  const prepared = {
    ...state,
    generation: state.generation + 1,
    pendingEffect: {
      kind: input.kind,
      state: "prepared" as const,
      slot: input.slot,
      ...identity,
      requestDigest,
      requestArtifact: request.artifact,
    },
    previousCheckpointDigest: head.stateDigest,
    createdAt: timestamp(state.generation + 1),
  } satisfies TransformerAttemptCheckpointState;
  const preparedHead = await advanceTransformerAttemptCheckpoint(
    journal, head.stateDigest, prepared, key, state.binding,
  );
  const dispatched = {
    ...prepared,
    generation: prepared.generation + 1,
    pendingEffect: { ...prepared.pendingEffect, state: "dispatched" as const },
    previousCheckpointDigest: preparedHead.stateDigest,
    createdAt: timestamp(prepared.generation + 1),
  } satisfies TransformerAttemptCheckpointState;
  const dispatchedHead = await advanceTransformerAttemptCheckpoint(
    journal, preparedHead.stateDigest, dispatched, key, state.binding,
  );
  const completed = {
    ...dispatched,
    generation: dispatched.generation + 1,
    pendingEffect: {
      ...dispatched.pendingEffect,
      state: "completed" as const,
      resultArtifact: result.artifact,
    },
    previousCheckpointDigest: dispatchedHead.stateDigest,
    createdAt: timestamp(dispatched.generation + 1),
  } satisfies TransformerAttemptCheckpointState;
  const completedHead = await advanceTransformerAttemptCheckpoint(
    journal, dispatchedHead.stateDigest, completed, key, state.binding,
  );
  const consumed = {
    ...completed,
    ...input.consume(completed, request.artifact, result.artifact),
    generation: completed.generation + 1,
    completedEffects: [...completed.completedEffects, {
      kind: input.kind,
      slot: input.slot,
      ...identity,
      requestDigest,
      requestArtifact: request.artifact,
      resultArtifact: result.artifact,
    }],
    pendingEffect: { kind: "none" as const },
    previousCheckpointDigest: completedHead.stateDigest,
    createdAt: timestamp(completed.generation + 1),
  } satisfies TransformerAttemptCheckpointState;
  const consumedHead = await advanceTransformerAttemptCheckpoint(
    journal, completedHead.stateDigest, consumed, key, state.binding,
  );
  return {
    head: consumedHead,
    state: openTransformerAttemptCheckpoint(consumedHead, key, state.binding),
  };
}

describe("Transformer attempt checkpoint", () => {
  it("creates only a strict source-bound genesis through the authoritative journal", async () => {
    const journal = new Journal();
    const current = fixture();
    install(journal, current);
    const envelope = await commitTransformerAttemptCheckpointGenesis(journal, current.state, key);

    expect(openTransformerAttemptCheckpoint(envelope, key, current.state.binding)).toEqual(current.state);
    expect(await commitTransformerAttemptCheckpointGenesis(journal, current.state, key)).toEqual(envelope);
    await expect(commitTransformerAttemptCheckpointGenesis(journal, {
      ...current.state,
      generation: 50,
    }, key)).rejects.toThrow(/transformer_attempt_checkpoint_genesis/);
    const wrongSource = fixture();
    install(new Journal(), wrongSource);
    await expect(commitTransformerAttemptCheckpointGenesis(journal, {
      ...current.state,
      binding: { ...current.state.binding, sourceManifestDigest: digest("wrong source") },
    }, key)).rejects.toThrow(/transformer_attempt_checkpoint_(binding|genesis|state)/);
  });

  it("opens an authenticated delivery checkpoint across only an executor revision change", async () => {
    const journal = new Journal();
    const current = fixture();
    install(journal, current);
    const envelope = await commitTransformerAttemptCheckpointGenesis(journal, current.state, key);
    const newerExecutorBinding = {
      ...current.state.binding,
      executorDigest: digest("newer executor deployment"),
    };

    expect(() => openTransformerAttemptCheckpoint(
      envelope,
      key,
      newerExecutorBinding,
    )).toThrow("transformer_attempt_checkpoint_binding_mismatch");
    expect(openTransformerAttemptCheckpointForDraftDelivery(
      envelope,
      key,
      newerExecutorBinding,
    )).toEqual(current.state);
    expect(() => openTransformerAttemptCheckpointForDraftDelivery(
      envelope,
      key,
      { ...newerExecutorBinding, constraintDigest: digest("changed constraint") },
    )).toThrow("transformer_attempt_checkpoint_binding_mismatch");
  });

  it("encrypts checkpoint and workspace bytes and rejects tampering", async () => {
    const journal = new Journal();
    const current = fixture();
    install(journal, current);
    const envelope = await commitTransformerAttemptCheckpointGenesis(journal, current.state, key);

    expect(JSON.stringify(envelope)).not.toContain("tenant-a");
    expect(JSON.stringify(envelope)).not.toContain("package.json");
    expect(Buffer.from(current.artifactBytes).toString("utf8")).not.toContain("fixture");
    const tampered = `${envelope.ciphertextBase64[0] === "A" ? "B" : "A"}${envelope.ciphertextBase64.slice(1)}`;
    expect(() => openTransformerAttemptCheckpoint(
      { ...envelope, ciphertextBase64: tampered },
      key,
      current.state.binding,
    )).toThrow(/transformer_attempt_checkpoint_(authentication|envelope)/);
  });

  it("reopens exact portable workspace and typed effect results", () => {
    const current = fixture();
    const scope = {
      tenantId: current.state.binding.tenantId,
      episodeId: current.state.episodeId,
    };
    expect(openTransformerWorkspaceArtifact(
      current.state.workspaceArtifact,
      current.artifactBytes,
      key,
      scope,
    )).toEqual([{
      path: "package.json",
      content: Buffer.from('{"name":"fixture"}\n'),
      mode: "file",
    }]);

    const effectId = "effect-a";
    const effectScope = { ...scope, effectId };
    const modelResult = {
      schemaVersion: 1 as const,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      costUsd: 0.01,
      wallTimeMs: 250,
      responseDigest: digest("model response"),
      responseBase64: Buffer.from("model response").toString("base64"),
    };
    const modelArtifact = createTransformerModelEffectResultArtifact(
      effectScope, modelResult, key,
    );
    expect(openTransformerModelEffectResultArtifact(
      modelArtifact.artifact, modelArtifact.bytes, key, effectScope,
    )).toEqual(modelResult);

    const verifierResult = {
      schemaVersion: 1 as const,
      status: "failed" as const,
      outputDigest: digest("verifier output"),
      outputBase64: Buffer.from("verifier output").toString("base64"),
    };
    const verifierArtifact = createTransformerVerifierEffectResultArtifact(
      effectScope, verifierResult, key,
    );
    expect(openTransformerVerifierEffectResultArtifact(
      verifierArtifact.artifact, verifierArtifact.bytes, key, effectScope,
    )).toEqual(verifierResult);

    const coordinatorResult = {
      schemaVersion: 1 as const,
      status: "accepted" as const,
      completionDigest: digest("completion"),
    };
    const coordinatorArtifact = createTransformerCoordinatorEffectResultArtifact(
      effectScope, coordinatorResult, key,
    );
    expect(openTransformerCoordinatorEffectResultArtifact(
      coordinatorArtifact.artifact, coordinatorArtifact.bytes, key, effectScope,
    )).toEqual(coordinatorResult);

    expect(() => openTransformerWorkspaceArtifact(
      current.state.workspaceArtifact,
      current.artifactBytes,
      key,
      { ...scope, episodeId: "episode-wrong" },
    )).toThrow("transformer_attempt_checkpoint_artifact_authentication_failed");

    const nextWorkspace = createTransformerWorkspaceArtifact(
      scope,
      [{ path: "package.json", content: Buffer.from('{"name":"changed"}\n'), mode: "executable" }],
      key,
    );
    const transitionPayload = createTransformerWorkspaceTransitionRequest(
      current.state.workspaceArtifact,
      nextWorkspace.artifact,
    );
    const transitionRequest = createTransformerEffectRequestArtifact(
      effectScope,
      transitionPayload,
      key,
    );
    expect(openTransformerWorkspaceTransitionRequest(
      transitionRequest.artifact,
      transitionRequest.bytes,
      key,
      effectScope,
    )).toEqual({
      current: current.state.workspaceArtifact,
      next: nextWorkspace.artifact,
    });
  });

  it("atomically chooses one sibling, replays it exactly, and rejects a stale lease", async () => {
    const journal = new Journal();
    const current = fixture();
    install(journal, current);
    const head = await commitTransformerAttemptCheckpointGenesis(journal, current.state, key);
    const nextLease = lease(2, 2, "lease-b");
    journal.setLease(current.state.episodeId, nextLease);
    const left = {
      ...current.state,
      generation: 2,
      attemptNumber: 2,
      writerLeaseGeneration: 2,
      writerLeaseTokenDigest: nextLease.tokenDigest,
      previousCheckpointDigest: head.stateDigest,
      createdAt: "2026-08-11T18:01:00.000Z",
    } satisfies TransformerAttemptCheckpointState;
    const right = { ...left, createdAt: "2026-08-11T18:01:01.000Z" };

    const siblings = await Promise.allSettled([
      advanceTransformerAttemptCheckpoint(journal, head.stateDigest, left, key, current.state.binding),
      advanceTransformerAttemptCheckpoint(journal, head.stateDigest, right, key, current.state.binding),
    ]);
    expect(siblings.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(siblings.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = siblings.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("missing winner");
    const winnerState = openTransformerAttemptCheckpoint(winner.value, key, current.state.binding);
    expect(await advanceTransformerAttemptCheckpoint(
      journal,
      head.stateDigest,
      winnerState,
      key,
      current.state.binding,
    )).toEqual(winner.value);
    await expect(advanceTransformerAttemptCheckpoint(
      journal,
      head.stateDigest,
      {
        ...left,
        attemptNumber: 1,
        writerLeaseGeneration: 1,
        writerLeaseTokenDigest: lease().tokenDigest,
      },
      key,
      current.state.binding,
    )).rejects.toThrow(/transformer_attempt_checkpoint_(head|lease)/);
  });

  it("prepares an authenticated transition without publishing the checkpoint head", async () => {
    const journal = new Journal();
    const current = fixture();
    install(journal, current);
    const head = await commitTransformerAttemptCheckpointGenesis(journal, current.state, key);
    const nextState = {
      ...current.state,
      generation: 2,
      previousCheckpointDigest: head.stateDigest,
      createdAt: "2026-08-11T18:01:00.000Z",
    } satisfies TransformerAttemptCheckpointState;

    const prepared = await prepareTransformerAttemptCheckpointAdvance(
      journal,
      head.stateDigest,
      nextState,
      key,
      current.state.binding,
    );

    expect(prepared.kind).toBe("advance");
    expect((await journal.read(current.state.episodeId))?.stateDigest).toBe(head.stateDigest);
    if (prepared.kind !== "advance") throw new Error("expected prepared advance");
    expect(await journal.compareAndSwap(prepared.operation)).toBe(true);
    expect(openTransformerAttemptCheckpoint(
      prepared.operation.next,
      key,
      current.state.binding,
    )).toEqual(nextState);
  });

  it("publishes and reconstructs an exact encrypted workspace on another node", async () => {
    const journal = new Journal();
    const current = fixture();
    install(journal, current);
    const head = await commitTransformerAttemptCheckpointGenesis(journal, current.state, key);
    const nextWorkspace = createTransformerWorkspaceArtifact(
      { tenantId: current.state.binding.tenantId, episodeId: current.state.episodeId },
      [{ path: "package.json", content: Buffer.from('{"name":"changed"}\n'), mode: "executable" }],
      key,
    );
    journal.putArtifact(nextWorkspace.artifact.storageKey, nextWorkspace.bytes);
    const requestPayload = createTransformerWorkspaceTransitionRequest(
      current.state.workspaceArtifact,
      nextWorkspace.artifact,
    );
    const requestDigest = createTransformerWorkspaceTransitionDigest(
      current.state.workspaceArtifact,
      nextWorkspace.artifact,
    );
    const slot = `workspace:${nextWorkspace.artifact.manifestDigest}:0`;
    const identity = createTransformerAttemptEffectIdentity(
      current.state.episodeId,
      "workspace_publish",
      slot,
      requestDigest,
    );
    const request = createTransformerEffectRequestArtifact(
      {
        tenantId: current.state.binding.tenantId,
        episodeId: current.state.episodeId,
        effectId: identity.effectId,
      },
      requestPayload,
      key,
    );
    journal.putArtifact(request.artifact.storageKey, request.bytes);
    const prepared = {
      ...current.state,
      generation: 2,
      pendingEffect: {
        kind: "workspace_publish" as const,
        state: "prepared" as const,
        slot,
        ...identity,
        requestDigest,
        requestArtifact: request.artifact,
      },
      previousCheckpointDigest: head.stateDigest,
      createdAt: "2026-08-11T18:01:00.000Z",
    };
    const preparedHead = await advanceTransformerAttemptCheckpoint(
      journal, head.stateDigest, prepared, key, current.state.binding,
    );
    const dispatched = {
      ...prepared,
      generation: 3,
      pendingEffect: { ...prepared.pendingEffect, state: "dispatched" as const },
      previousCheckpointDigest: preparedHead.stateDigest,
      createdAt: "2026-08-11T18:02:00.000Z",
    };
    const dispatchedHead = await advanceTransformerAttemptCheckpoint(
      journal, preparedHead.stateDigest, dispatched, key, current.state.binding,
    );
    const completed = {
      ...dispatched,
      generation: 4,
      pendingEffect: {
        ...dispatched.pendingEffect,
        state: "completed" as const,
        resultArtifact: nextWorkspace.artifact,
      },
      previousCheckpointDigest: dispatchedHead.stateDigest,
      createdAt: "2026-08-11T18:03:00.000Z",
    };
    const completedHead = await advanceTransformerAttemptCheckpoint(
      journal, dispatchedHead.stateDigest, completed, key, current.state.binding,
    );
    const consumed = {
      ...completed,
      generation: 5,
      stage: "recipe_applied" as const,
      workspaceManifest: nextWorkspace.manifest,
      workspaceArtifact: nextWorkspace.artifact,
      completedEffects: [{
        kind: "workspace_publish" as const,
        slot,
        ...identity,
        requestDigest,
        requestArtifact: request.artifact,
        resultArtifact: nextWorkspace.artifact,
      }],
      pendingEffect: { kind: "none" as const },
      previousCheckpointDigest: completedHead.stateDigest,
      createdAt: "2026-08-11T18:04:00.000Z",
    };
    const finalHead = await advanceTransformerAttemptCheckpoint(
      journal, completedHead.stateDigest, consumed, key, current.state.binding,
    );

    const restored = openTransformerAttemptCheckpoint(finalHead, key, current.state.binding);
    expect(verifyTransformerWorkspaceArtifact(
      restored.workspaceArtifact,
      nextWorkspace.bytes,
      key,
      { tenantId: restored.binding.tenantId, episodeId: restored.episodeId },
    )).toEqual(nextWorkspace.manifest);
    expect(restored.workspaceManifest[0]?.mode).toBe("executable");
    expect(restored.workspaceArtifact.filesDigest).toBe(current.state.binding.candidateDigest);
    expect(() => createTransformerCandidateSeal(
      current.state.binding,
      restored.workspaceArtifact,
    )).toThrow("transformer_attempt_checkpoint_candidate_seal_invalid");

    const verificationStage = {
      ...restored,
      generation: 6,
      stage: "verification" as const,
      previousCheckpointDigest: finalHead.stateDigest,
      createdAt: "2026-08-11T18:05:00.000Z",
    };
    const verificationStageHead = await advanceTransformerAttemptCheckpoint(
      journal, finalHead.stateDigest, verificationStage, key, current.state.binding,
    );
    const verificationPayload = Buffer.from("npm run typecheck", "utf8");
    const verificationIdentity = createTransformerAttemptEffectIdentity(
      current.state.episodeId,
      "verifier",
      `verification:${nextWorkspace.artifact.manifestDigest}:0:0`,
      digest(verificationPayload),
    );
    const verificationRequest = createTransformerEffectRequestArtifact(
      {
        tenantId: current.state.binding.tenantId,
        episodeId: current.state.episodeId,
        effectId: verificationIdentity.effectId,
      },
      verificationPayload,
      key,
    );
    const verificationResult = createTransformerVerifierEffectResultArtifact(
      {
        tenantId: current.state.binding.tenantId,
        episodeId: current.state.episodeId,
        effectId: verificationIdentity.effectId,
      },
      {
        schemaVersion: 1,
        status: "passed",
        outputDigest: digest("typecheck output"),
        outputBase64: Buffer.from("typecheck output", "utf8").toString("base64"),
      },
      key,
    );
    journal.putArtifact(verificationRequest.artifact.storageKey, verificationRequest.bytes);
    journal.putArtifact(verificationResult.artifact.storageKey, verificationResult.bytes);
    const verificationPrepared = {
      ...verificationStage,
      generation: 7,
      pendingEffect: {
        kind: "verifier" as const,
        state: "prepared" as const,
        slot: `verification:${nextWorkspace.artifact.manifestDigest}:0:0`,
        ...verificationIdentity,
        requestDigest: verificationRequest.artifact.payloadDigest,
        requestArtifact: verificationRequest.artifact,
      },
      previousCheckpointDigest: verificationStageHead.stateDigest,
      createdAt: "2026-08-11T18:06:00.000Z",
    };
    const verificationPreparedHead = await advanceTransformerAttemptCheckpoint(
      journal, verificationStageHead.stateDigest, verificationPrepared, key, current.state.binding,
    );
    const verificationDispatched = {
      ...verificationPrepared,
      generation: 8,
      pendingEffect: { ...verificationPrepared.pendingEffect, state: "dispatched" as const },
      previousCheckpointDigest: verificationPreparedHead.stateDigest,
      createdAt: "2026-08-11T18:07:00.000Z",
    };
    const verificationDispatchedHead = await advanceTransformerAttemptCheckpoint(
      journal, verificationPreparedHead.stateDigest, verificationDispatched, key, current.state.binding,
    );
    const verificationCompleted = {
      ...verificationDispatched,
      generation: 9,
      pendingEffect: {
        ...verificationDispatched.pendingEffect,
        state: "completed" as const,
        resultArtifact: verificationResult.artifact,
      },
      previousCheckpointDigest: verificationDispatchedHead.stateDigest,
      createdAt: "2026-08-11T18:08:00.000Z",
    };
    const verificationCompletedHead = await advanceTransformerAttemptCheckpoint(
      journal, verificationDispatchedHead.stateDigest, verificationCompleted, key, current.state.binding,
    );
    const verificationConsumed = {
      ...verificationCompleted,
      generation: 10,
      commandCursor: 1,
      verificationReceipts: [{
        sequence: 0,
        round: 0,
        index: 0,
        commandId: "typecheck",
        commandDigest: digest(verificationPayload),
        workspaceManifestDigest: nextWorkspace.artifact.manifestDigest,
        status: "passed" as const,
        outputDigest: digest("typecheck output"),
      }],
      completedEffects: [...verificationCompleted.completedEffects, {
        kind: "verifier" as const,
        slot: `verification:${nextWorkspace.artifact.manifestDigest}:0:0`,
        ...verificationIdentity,
        requestDigest: verificationRequest.artifact.payloadDigest,
        requestArtifact: verificationRequest.artifact,
        resultArtifact: verificationResult.artifact,
      }],
      pendingEffect: { kind: "none" as const },
      previousCheckpointDigest: verificationCompletedHead.stateDigest,
      createdAt: "2026-08-11T18:09:00.000Z",
    };
    for (const invalidReceipt of [
      {
        ...verificationConsumed.verificationReceipts[0]!,
        workspaceManifestDigest: current.state.binding.sourceManifestDigest,
      },
      {
        ...verificationConsumed.verificationReceipts[0]!,
        status: "failed" as const,
      },
    ]) {
      await expect(advanceTransformerAttemptCheckpoint(
        journal,
        verificationCompletedHead.stateDigest,
        { ...verificationConsumed, verificationReceipts: [invalidReceipt] },
        key,
        current.state.binding,
      )).rejects.toThrow(/transformer_attempt_checkpoint_/);
    }
    const verifiedHead = await advanceTransformerAttemptCheckpoint(
      journal, verificationCompletedHead.stateDigest, verificationConsumed, key, current.state.binding,
    );
    expect(openTransformerAttemptCheckpoint(
      verifiedHead, key, current.state.binding,
    ).verificationReceipts[0]?.workspaceManifestDigest).toBe(nextWorkspace.artifact.manifestDigest);

    const verified = openTransformerAttemptCheckpoint(verifiedHead, key, current.state.binding);
    const adaptive = {
      ...verified,
      generation: 11,
      stage: "adaptive" as const,
      previousCheckpointDigest: verifiedHead.stateDigest,
      createdAt: "2026-08-11T18:10:00.000Z",
    };
    const adaptiveHead = await advanceTransformerAttemptCheckpoint(
      journal, verifiedHead.stateDigest, adaptive, key, current.state.binding,
    );
    const repairedWorkspace = createTransformerWorkspaceArtifact(
      { tenantId: current.state.binding.tenantId, episodeId: current.state.episodeId },
      [{ path: "package.json", content: Buffer.from('{"name":"changed"}\n'), mode: "file" }],
      key,
    );
    journal.putArtifact(repairedWorkspace.artifact.storageKey, repairedWorkspace.bytes);
    const repairPayload = createTransformerWorkspaceTransitionRequest(
      nextWorkspace.artifact,
      repairedWorkspace.artifact,
    );
    const repairIdentity = createTransformerAttemptEffectIdentity(
      current.state.episodeId,
      "workspace_publish",
      `workspace:${repairedWorkspace.artifact.manifestDigest}:1`,
      digest(repairPayload),
    );
    const repairRequest = createTransformerEffectRequestArtifact({
      tenantId: current.state.binding.tenantId,
      episodeId: current.state.episodeId,
      effectId: repairIdentity.effectId,
    }, repairPayload, key);
    journal.putArtifact(repairRequest.artifact.storageKey, repairRequest.bytes);
    const repairPrepared = {
      ...adaptive,
      generation: 12,
      pendingEffect: {
        kind: "workspace_publish" as const,
        state: "prepared" as const,
        slot: `workspace:${repairedWorkspace.artifact.manifestDigest}:1`,
        ...repairIdentity,
        requestDigest: repairRequest.artifact.payloadDigest,
        requestArtifact: repairRequest.artifact,
      },
      previousCheckpointDigest: adaptiveHead.stateDigest,
      createdAt: "2026-08-11T18:11:00.000Z",
    };
    const repairPreparedHead = await advanceTransformerAttemptCheckpoint(
      journal, adaptiveHead.stateDigest, repairPrepared, key, current.state.binding,
    );
    const repairDispatched = {
      ...repairPrepared,
      generation: 13,
      pendingEffect: { ...repairPrepared.pendingEffect, state: "dispatched" as const },
      previousCheckpointDigest: repairPreparedHead.stateDigest,
      createdAt: "2026-08-11T18:12:00.000Z",
    };
    const repairDispatchedHead = await advanceTransformerAttemptCheckpoint(
      journal, repairPreparedHead.stateDigest, repairDispatched, key, current.state.binding,
    );
    const repairCompleted = {
      ...repairDispatched,
      generation: 14,
      pendingEffect: {
        ...repairDispatched.pendingEffect,
        state: "completed" as const,
        resultArtifact: repairedWorkspace.artifact,
      },
      previousCheckpointDigest: repairDispatchedHead.stateDigest,
      createdAt: "2026-08-11T18:13:00.000Z",
    };
    const repairCompletedHead = await advanceTransformerAttemptCheckpoint(
      journal, repairDispatchedHead.stateDigest, repairCompleted, key, current.state.binding,
    );
    const repaired = {
      ...repairCompleted,
      generation: 15,
      commandCursor: 0,
      workspaceManifest: repairedWorkspace.manifest,
      workspaceArtifact: repairedWorkspace.artifact,
      completedEffects: [...repairCompleted.completedEffects, {
        kind: "workspace_publish" as const,
        slot: `workspace:${repairedWorkspace.artifact.manifestDigest}:1`,
        ...repairIdentity,
        requestDigest: repairRequest.artifact.payloadDigest,
        requestArtifact: repairRequest.artifact,
        resultArtifact: repairedWorkspace.artifact,
      }],
      pendingEffect: { kind: "none" as const },
      previousCheckpointDigest: repairCompletedHead.stateDigest,
      createdAt: "2026-08-11T18:14:00.000Z",
    };
    const repairedHead = await advanceTransformerAttemptCheckpoint(
      journal, repairCompletedHead.stateDigest, repaired, key, current.state.binding,
    );
    expect(openTransformerAttemptCheckpoint(
      repairedHead, key, current.state.binding,
    ).commandCursor).toBe(0);

    const repairedSeal = createTransformerCandidateSeal(
      current.state.binding,
      repairedWorkspace.artifact,
    );
    expect(digest(createTransformerCandidateSealPayload(
      current.state.binding,
      repairedWorkspace.artifact,
    ))).toBe(repairedSeal.sealDigest);
    expect(digest(createTransformerCandidatePublicationRequest(
      current.state.episodeId,
      repairedSeal,
    ))).toBe(createTransformerCandidatePublicationRequestDigest(
      current.state.episodeId,
      repairedSeal,
    ));
    const coordinatorCompletionIntent = {
      schemaVersion: 1,
      tenantId: current.state.binding.tenantId,
      campaignId: current.state.binding.campaignId,
      unitId: current.state.binding.unitId,
      episodeId: current.state.episodeId,
      candidateSealDigest: repairedSeal.sealDigest,
      attemptNumber: current.state.attemptNumber,
      leaseGeneration: current.state.writerLeaseGeneration,
      leaseTokenDigest: current.state.writerLeaseTokenDigest,
      sourceRevision: current.state.binding.sourceRevision,
      sourceDigest: current.state.workspaceArtifact.filesDigest,
      candidateRevision: current.state.binding.candidateRevision,
      candidateDigest: current.state.binding.candidateDigest,
      authorizationDigest: createTransformerAttemptAuthorizationDigest(undefined),
      verificationPassed: true,
      actualCostUsd: 0,
      accounting: {
        plannerCalls: 0,
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        actualCostUsd: 0,
        wallTimeMs: 0,
      },
      observedAt: "2026-08-11T19:30:00.000Z",
      evidenceRefs: ["evidence://attempt/terminal"],
    } satisfies TransformerAttemptCompletionIntent;
    const coordinatorCompletionDigest = createTransformerAttemptCompletionDigest(
      coordinatorCompletionIntent,
    );
    const candidateMissionEvidence = createTransformerMissionEvidenceArtifact({
      tenantId: current.state.binding.tenantId,
      episodeId: current.state.episodeId,
      artifactId: `tcman_${"1".repeat(64)}`,
    }, Buffer.from("candidate manifest"), key);
    const executionMissionEvidence = createTransformerMissionEvidenceArtifact({
      tenantId: current.state.binding.tenantId,
      episodeId: current.state.episodeId,
      artifactId: `tre_execution_${"2".repeat(64)}`,
    }, Buffer.from("execution evidence"), key);
    const artifactRegistration = {
      schemaVersion: 2 as const,
      episodeId: current.state.episodeId,
      attemptId: `tfattempt_${"3".repeat(32)}`,
      sourceSnapshotId: current.state.binding.snapshotId,
      candidateArtifactId: `tcman_${"1".repeat(64)}`,
      candidateManifestDigest: candidateMissionEvidence.artifact.payloadDigest,
      candidateManifestArtifact: candidateMissionEvidence.artifact,
      executionArtifactId: `tre_execution_${"2".repeat(64)}`,
      executionEvidenceDigest: executionMissionEvidence.artifact.payloadDigest,
      executionEvidenceArtifact: executionMissionEvidence.artifact,
      executionSchemaVersion: 3,
    };
    const coordinatorRequest = createTransformerCoordinatorCompletionRequest(
      current.state.episodeId,
      repairedSeal,
      coordinatorCompletionIntent,
      artifactRegistration,
    );
    expect(digest(createTransformerCoordinatorCompletionRequest(
      current.state.episodeId,
      repairedSeal,
      coordinatorCompletionIntent,
      artifactRegistration,
    ))).toBe(createTransformerCoordinatorCompletionRequestDigest(
      current.state.episodeId,
      repairedSeal,
      coordinatorCompletionIntent,
      artifactRegistration,
    ));
    expect(openTransformerCoordinatorCompletionRequest(coordinatorRequest)).toEqual({
      episodeId: current.state.episodeId,
      seal: repairedSeal,
      completionDigest: coordinatorCompletionDigest,
      completionIntent: coordinatorCompletionIntent,
      artifactRegistration,
    });
    expect(createTransformerCoordinatorCompletionRequestDigest(
      current.state.episodeId,
      repairedSeal,
      coordinatorCompletionIntent,
    )).not.toBe(createTransformerCoordinatorCompletionRequestDigest(
      current.state.episodeId,
      repairedSeal,
      coordinatorCompletionIntent,
      artifactRegistration,
    ));

    await expect(advanceTransformerAttemptCheckpoint(
      journal,
      repairedHead.stateDigest,
      {
        ...repaired,
        generation: 16,
        stage: "candidate_sealed" as const,
        candidateSeal: repairedSeal,
        previousCheckpointDigest: repairedHead.stateDigest,
        createdAt: "2026-08-11T18:15:00.000Z",
      },
      key,
      current.state.binding,
    )).rejects.toThrow("transformer_attempt_checkpoint_candidate_seal_invalid");

    const reverified = await consumeEffect(journal, repairedHead, repaired, {
      kind: "verifier",
      slot: `verification:${repairedWorkspace.artifact.manifestDigest}:0:0`,
      requestPayload: verificationPayload,
      createResult: (effectId) => createTransformerVerifierEffectResultArtifact({
        tenantId: current.state.binding.tenantId,
        episodeId: current.state.episodeId,
        effectId,
      }, {
        schemaVersion: 1,
        status: "passed",
        outputDigest: digest("repaired typecheck output"),
        outputBase64: Buffer.from("repaired typecheck output", "utf8").toString("base64"),
      }, key),
      consume: () => ({
        commandCursor: 1,
        verificationReceipts: [...repaired.verificationReceipts, {
          sequence: repaired.verificationReceipts.length,
          round: 0,
          index: 0,
          commandId: "typecheck",
          commandDigest: digest(verificationPayload),
          workspaceManifestDigest: repairedWorkspace.artifact.manifestDigest,
          status: "passed" as const,
          outputDigest: digest("repaired typecheck output"),
        }],
      }),
    });
    const candidatePublished = await consumeEffect(journal, reverified.head, reverified.state, {
      kind: "candidate_publish",
      slot: "candidate:seal",
      requestPayload: createTransformerCandidatePublicationRequest(
        current.state.episodeId,
        repairedSeal,
      ),
      createResult: (effectId) => createTransformerEffectResultArtifact({
        tenantId: current.state.binding.tenantId,
        episodeId: current.state.episodeId,
        effectId,
      }, createTransformerCandidateSealPayload(
        current.state.binding,
        repairedWorkspace.artifact,
      ), key),
      consume: () => ({
        stage: "candidate_sealed" as const,
        candidateSeal: repairedSeal,
      }),
    });
    const completionPrepared = {
      ...candidatePublished.state,
      generation: candidatePublished.state.generation + 1,
      stage: "completion_prepared" as const,
      previousCheckpointDigest: candidatePublished.head.stateDigest,
      createdAt: new Date(
        Date.parse(candidatePublished.state.createdAt) + 60_000,
      ).toISOString(),
    } satisfies TransformerAttemptCheckpointState;
    const completionPreparedHead = await advanceTransformerAttemptCheckpoint(
      journal,
      candidatePublished.head.stateDigest,
      completionPrepared,
      key,
      current.state.binding,
    );
    const mismatchedCompletionIntent = {
      ...coordinatorCompletionIntent,
      evidenceRefs: ["evidence://attempt/mismatched"],
    } satisfies TransformerAttemptCompletionIntent;
    const mismatchedRequestPayload = createTransformerCoordinatorCompletionRequest(
      current.state.episodeId,
      repairedSeal,
      mismatchedCompletionIntent,
    );
    const mismatchedRequestDigest = digest(mismatchedRequestPayload);
    const mismatchedIdentity = createTransformerAttemptEffectIdentity(
      current.state.episodeId,
      "coordinator_complete",
      createTransformerCoordinatorCompletionSlot(coordinatorCompletionDigest),
      mismatchedRequestDigest,
    );
    const mismatchedRequest = createTransformerEffectRequestArtifact({
      tenantId: current.state.binding.tenantId,
      episodeId: current.state.episodeId,
      effectId: mismatchedIdentity.effectId,
    }, mismatchedRequestPayload, key);
    const mismatchedJournal = journal.clone();
    mismatchedJournal.putArtifact(mismatchedRequest.artifact.storageKey, mismatchedRequest.bytes);
    await expect(advanceTransformerAttemptCheckpoint(
      mismatchedJournal,
      completionPreparedHead.stateDigest,
      {
        ...completionPrepared,
        generation: completionPrepared.generation + 1,
        pendingEffect: {
          kind: "coordinator_complete",
          state: "prepared" as const,
          slot: createTransformerCoordinatorCompletionSlot(coordinatorCompletionDigest),
          ...mismatchedIdentity,
          requestDigest: mismatchedRequestDigest,
          requestArtifact: mismatchedRequest.artifact,
        },
        previousCheckpointDigest: completionPreparedHead.stateDigest,
        createdAt: new Date(
          Date.parse(completionPrepared.createdAt) + 60_000,
        ).toISOString(),
      },
      key,
      current.state.binding,
    )).rejects.toThrow("transformer_attempt_checkpoint_effect_invalid");
    await expect(consumeEffect(
      journal.clone(),
      completionPreparedHead,
      completionPrepared,
      {
        kind: "coordinator_complete",
        slot: createTransformerCoordinatorCompletionSlot(coordinatorCompletionDigest),
        requestPayload: createTransformerCoordinatorCompletionRequest(
          current.state.episodeId,
          repairedSeal,
          coordinatorCompletionIntent,
        ),
        createResult: (effectId) => createTransformerCoordinatorEffectResultArtifact({
          tenantId: current.state.binding.tenantId,
          episodeId: current.state.episodeId,
          effectId,
        }, {
          schemaVersion: 1,
          status: "rejected",
          completionDigest: digest("coordinator rejection receipt"),
        }, key),
        consume: () => ({ stage: "terminal" as const }),
      },
    )).rejects.toThrow("transformer_attempt_checkpoint_terminal_atomic_required");
    const completionRequestPayload = createTransformerCoordinatorCompletionRequest(
      current.state.episodeId,
      repairedSeal,
      coordinatorCompletionIntent,
    );
    const completionRequestDigest = digest(completionRequestPayload);
    const completionSlot = createTransformerCoordinatorCompletionSlot(
      coordinatorCompletionDigest,
    );
    const completionIdentity = createTransformerAttemptEffectIdentity(
      current.state.episodeId,
      "coordinator_complete",
      completionSlot,
      completionRequestDigest,
    );
    const completionRequest = createTransformerEffectRequestArtifact({
      tenantId: current.state.binding.tenantId,
      episodeId: current.state.episodeId,
      effectId: completionIdentity.effectId,
    }, completionRequestPayload, key);
    const completionResult = createTransformerCoordinatorEffectResultArtifact({
      tenantId: current.state.binding.tenantId,
      episodeId: current.state.episodeId,
      effectId: completionIdentity.effectId,
    }, {
      schemaVersion: 1,
      status: "accepted",
      completionDigest: coordinatorCompletionDigest,
    }, key);
    journal.putArtifact(completionRequest.artifact.storageKey, completionRequest.bytes);
    journal.putArtifact(completionResult.artifact.storageKey, completionResult.bytes);
    const coordinatorPrepared = {
      ...completionPrepared,
      generation: completionPrepared.generation + 1,
      pendingEffect: {
        kind: "coordinator_complete" as const,
        state: "prepared" as const,
        slot: completionSlot,
        ...completionIdentity,
        requestDigest: completionRequestDigest,
        requestArtifact: completionRequest.artifact,
      },
      previousCheckpointDigest: completionPreparedHead.stateDigest,
      createdAt: new Date(Date.parse(completionPrepared.createdAt) + 60_000).toISOString(),
    } satisfies TransformerAttemptCheckpointState;
    const coordinatorPreparedHead = await advanceTransformerAttemptCheckpoint(
      journal,
      completionPreparedHead.stateDigest,
      coordinatorPrepared,
      key,
      current.state.binding,
    );
    const upgradedJournal = journal.clone();
    const upgradedPayload = createTransformerCoordinatorCompletionRequest(
      current.state.episodeId,
      repairedSeal,
      coordinatorCompletionIntent,
      artifactRegistration,
    );
    const upgradedDigest = digest(upgradedPayload);
    const upgradedIdentity = createTransformerAttemptEffectIdentity(
      current.state.episodeId,
      "coordinator_complete",
      completionSlot,
      upgradedDigest,
    );
    const upgradedRequest = createTransformerEffectRequestArtifact({
      tenantId: current.state.binding.tenantId,
      episodeId: current.state.episodeId,
      effectId: upgradedIdentity.effectId,
    }, upgradedPayload, key);
    upgradedJournal.putArtifact(upgradedRequest.artifact.storageKey, upgradedRequest.bytes);
    const upgradedHead = await upgradeTransformerAttemptCheckpointCoordinatorCompletionRequest(
      upgradedJournal,
      coordinatorPreparedHead.stateDigest,
      {
        kind: "coordinator_complete",
        state: "prepared",
        slot: completionSlot,
        ...upgradedIdentity,
        requestDigest: upgradedDigest,
        requestArtifact: upgradedRequest.artifact,
      },
      new Date(Date.parse(coordinatorPrepared.createdAt) + 1_000).toISOString(),
      key,
      current.state.binding,
    );
    expect(openTransformerAttemptCheckpoint(
      upgradedHead,
      key,
      current.state.binding,
    ).pendingEffect).toMatchObject({
      kind: "coordinator_complete",
      state: "prepared",
      effectId: upgradedIdentity.effectId,
    });
    const coordinatorDispatched = {
      ...coordinatorPrepared,
      generation: coordinatorPrepared.generation + 1,
      pendingEffect: { ...coordinatorPrepared.pendingEffect, state: "dispatched" as const },
      previousCheckpointDigest: coordinatorPreparedHead.stateDigest,
      createdAt: new Date(Date.parse(coordinatorPrepared.createdAt) + 60_000).toISOString(),
    } satisfies TransformerAttemptCheckpointState;
    const coordinatorDispatchedHead = await advanceTransformerAttemptCheckpoint(
      journal,
      coordinatorPreparedHead.stateDigest,
      coordinatorDispatched,
      key,
      current.state.binding,
    );
    const takeoverJournal = journal.clone();
    const takeoverLease = lease(1, 2, "lease-b");
    takeoverJournal.setLease(current.state.episodeId, takeoverLease);
    const takeoverIntent = {
      ...coordinatorCompletionIntent,
      leaseGeneration: takeoverLease.generation,
      leaseTokenDigest: takeoverLease.tokenDigest,
      observedAt: new Date(Date.parse(coordinatorDispatched.createdAt) + 60_000).toISOString(),
    } satisfies TransformerAttemptCompletionIntent;
    const takeoverDigest = createTransformerAttemptCompletionDigest(takeoverIntent);
    const takeoverPayload = createTransformerCoordinatorCompletionRequest(
      current.state.episodeId,
      repairedSeal,
      takeoverIntent,
    );
    const takeoverRequestDigest = digest(takeoverPayload);
    const takeoverSlot = createTransformerCoordinatorCompletionSlot(takeoverDigest);
    const takeoverIdentity = createTransformerAttemptEffectIdentity(
      current.state.episodeId,
      "coordinator_complete",
      takeoverSlot,
      takeoverRequestDigest,
    );
    const takeoverRequest = createTransformerEffectRequestArtifact({
      tenantId: current.state.binding.tenantId,
      episodeId: current.state.episodeId,
      effectId: takeoverIdentity.effectId,
    }, takeoverPayload, key);
    takeoverJournal.putArtifact(takeoverRequest.artifact.storageKey, takeoverRequest.bytes);
    const takeoverHead = await supersedeTransformerAttemptCheckpointCoordinatorCompletion(
      takeoverJournal,
      coordinatorDispatchedHead.stateDigest,
      {
        kind: "coordinator_complete",
        state: "prepared",
        slot: takeoverSlot,
        ...takeoverIdentity,
        requestDigest: takeoverRequestDigest,
        requestArtifact: takeoverRequest.artifact,
      },
      takeoverIntent.observedAt,
      key,
      current.state.binding,
    );
    expect(openTransformerAttemptCheckpoint(
      takeoverHead,
      key,
      current.state.binding,
    )).toMatchObject({
      writerLeaseGeneration: takeoverLease.generation,
      writerLeaseTokenDigest: takeoverLease.tokenDigest,
      pendingEffect: {
        kind: "coordinator_complete",
        state: "prepared",
        effectId: takeoverIdentity.effectId,
      },
    });
    await expect(prepareTransformerAttemptCheckpointTerminalAdvance(
      takeoverJournal,
      takeoverHead.stateDigest,
      completionResult.artifact,
      new Date(Date.parse(takeoverIntent.observedAt) + 60_000).toISOString(),
      key,
      current.state.binding,
    )).rejects.toThrow(/transformer_attempt_checkpoint_/);
    const terminalPrepared = await prepareTransformerAttemptCheckpointTerminalAdvance(
      journal,
      coordinatorDispatchedHead.stateDigest,
      completionResult.artifact,
      new Date(Date.parse(coordinatorDispatched.createdAt) + 60_000).toISOString(),
      key,
      current.state.binding,
    );
    expect(terminalPrepared.kind).toBe("advance");
    if (terminalPrepared.kind !== "advance") throw new Error("expected terminal advance");
    const terminalState = openTransformerAttemptCheckpoint(
      terminalPrepared.operation.next,
      key,
      current.state.binding,
    );
    await expect(advanceTransformerAttemptCheckpoint(
      journal,
      coordinatorDispatchedHead.stateDigest,
      terminalState,
      key,
      current.state.binding,
    )).rejects.toThrow("transformer_attempt_checkpoint_terminal_atomic_required");
    const stored = new Map<string, Uint8Array>();
    const pending: string[] = [];
    const referenced: string[] = [];
    const unreferenced: string[] = [];
    const currentBytes = Buffer.from(JSON.stringify(coordinatorDispatchedHead), "utf8");
    const currentEnvelopeDigest = digest(currentBytes);
    const currentStorageKey = transformerAttemptCheckpointEnvelopeStorageKey({
      tenantId: current.state.binding.tenantId,
      campaignId: current.state.binding.campaignId,
      unitId: current.state.binding.unitId,
      episodeId: current.state.episodeId,
      generation: coordinatorDispatchedHead.generation,
      envelopeDigest: currentEnvelopeDigest,
    });
    stored.set(currentStorageKey, currentBytes);
    stored.set(completionRequest.artifact.storageKey, completionRequest.bytes);
    const sourcePublication = coordinatorDispatched.completedEffects.find(
      (effect) => effect.kind === "workspace_publish",
    );
    if (sourcePublication === undefined) throw new Error("missing source publication");
    const sourceRequestBytes = await journal.readArtifact(sourcePublication.requestArtifact.storageKey);
    if (sourceRequestBytes === null) throw new Error("missing source publication request");
    stored.set(sourcePublication.requestArtifact.storageKey, sourceRequestBytes);
    const sourceArtifact = openTransformerWorkspaceTransitionRequest(
      sourcePublication.requestArtifact,
      sourceRequestBytes,
      key,
      {
        tenantId: current.state.binding.tenantId,
        episodeId: current.state.episodeId,
        effectId: sourcePublication.effectId,
      },
    ).current;
    const sourceWorkspaceBytes = await journal.readArtifact(sourceArtifact.storageKey);
    if (sourceWorkspaceBytes === null) throw new Error("missing source workspace artifact");
    stored.set(sourceArtifact.storageKey, sourceWorkspaceBytes);
    const artifactStore: TransformerAttemptCheckpointArtifactStore = {
      async read(storageKey) {
        const value = stored.get(storageKey);
        return value ? new Uint8Array(value) : null;
      },
      async publishImmutableDurable(storageKey, bytes) {
        const existing = stored.get(storageKey);
        if (existing && !Buffer.from(existing).equals(Buffer.from(bytes))) {
          throw new Error("artifact_conflict");
        }
        stored.set(storageKey, new Uint8Array(bytes));
      },
      async recordPending(storageKey) {
        pending.push(storageKey);
      },
      async recordReferenced(storageKey) {
        referenced.push(storageKey);
      },
      async recordUnreferenced(storageKey) {
        unreferenced.push(storageKey);
      },
    };
    let currentHead = {
      schemaVersion: 1 as const,
      episodeId: current.state.episodeId,
      stateDigest: coordinatorDispatchedHead.stateDigest,
      envelopeStorageKey: currentStorageKey,
      envelopeDigest: currentEnvelopeDigest,
      generation: coordinatorDispatchedHead.generation,
      attemptNumber: current.state.attemptNumber,
      writerLeaseGeneration: current.state.writerLeaseGeneration,
      writerLeaseTokenDigest: current.state.writerLeaseTokenDigest,
    };
    const completionInputs: TransformerAttemptCheckpointCompletionInput[] = [];
    let lostResponsesRemaining = 2;
    let committedResult: Readonly<{
      campaign: typeof campaign;
      receipt: Readonly<{
        schemaVersion: 1;
        tenantId: string;
        campaignId: string;
        unitId: string;
        episodeId: string;
        completionDigest: string;
        campaignRevision: number;
        observedAt: string;
        checkpointHead: TransformerAttemptCheckpointCompletionInput["nextCheckpointHead"];
      }>;
    }> | null = null;
    const campaign = {
      environment: current.state.binding.environment,
      constraintDigest: current.state.binding.constraintDigest,
      units: [{
        id: current.state.binding.unitId,
        snapshot: {
          repositoryId: current.state.binding.repositoryId,
          snapshotId: current.state.binding.snapshotId,
          revision: current.state.binding.sourceRevision,
          digest: coordinatorCompletionIntent.sourceDigest,
        },
        candidateRevision: current.state.binding.candidateRevision,
        candidateDigest: current.state.binding.candidateDigest,
        recipe: { digest: current.state.binding.recipeDigest },
      }],
    };
    const authority: TransformerAttemptCheckpointAuthorityPort = {
      async readBindingAuthority() {
        const unit = campaign.units[0]!;
        return {
          tenantId: current.state.binding.tenantId,
          environment: campaign.environment,
          campaignId: current.state.binding.campaignId,
          unitId: unit.id,
          repositoryId: unit.snapshot.repositoryId,
          snapshotId: unit.snapshot.snapshotId,
          sourceRevision: unit.snapshot.revision,
          sourceDigest: unit.snapshot.digest,
          candidateRevision: unit.candidateRevision,
          candidateDigest: unit.candidateDigest,
          recipeDigest: unit.recipe.digest,
          constraintDigest: campaign.constraintDigest,
        };
      },
      async readHead() {
        return currentHead;
      },
      async readLease() {
        return {
          attemptNumber: current.state.attemptNumber,
          generation: current.state.writerLeaseGeneration,
          tokenDigest: current.state.writerLeaseTokenDigest,
        };
      },
      async compareAndSwapHead() {
        throw new Error("unexpected_checkpoint_head_cas");
      },
      async completeWithHead(input: TransformerAttemptCheckpointCompletionInput) {
        completionInputs.push(input);
        if (committedResult === null) {
          currentHead = input.nextCheckpointHead;
          committedResult = {
            campaign,
            receipt: {
              schemaVersion: 1 as const,
              tenantId: input.tenantId,
              campaignId: input.campaignId,
              unitId: input.completionIntent.unitId,
              episodeId: input.completionIntent.episodeId,
              completionDigest: coordinatorCompletionDigest,
              campaignRevision: 7,
              observedAt: input.observedAt,
              checkpointHead: input.nextCheckpointHead,
            },
          };
        }
        if (lostResponsesRemaining > 0) {
          lostResponsesRemaining -= 1;
          throw new Error("simulated_commit_response_loss");
        }
        return committedResult;
      },
      async failWithHead() {
        throw new Error("unexpected_checkpoint_failure");
      },
      async readFailureReceipt() {
        return null;
      },
    };
    const finalizeInput = {
      authority,
      artifactStore,
      tenantId: current.state.binding.tenantId,
      campaignId: current.state.binding.campaignId,
      unitId: current.state.binding.unitId,
      binding: current.state.binding,
      encryptionKey: key,
      leaseToken: "lease-a",
      evidenceRefs: coordinatorCompletionIntent.evidenceRefs,
      expectedStateDigest: coordinatorDispatchedHead.stateDigest,
      resultArtifact: completionResult.artifact,
      resultBytes: completionResult.bytes,
      completionIntent: coordinatorCompletionIntent,
      candidateSeal: repairedSeal,
    } as const;
    const recoveredInProcess = await finalizeTransformerPilotAttemptCheckpoint(finalizeInput);
    expect(currentHead.stateDigest).not.toBe(coordinatorDispatchedHead.stateDigest);
    expect(recoveredInProcess.receipt.checkpointHead).toEqual(currentHead);
    expect(unreferenced).toEqual([]);
    const finalized = await finalizeTransformerPilotAttemptCheckpoint(finalizeInput);
    expect(completionInputs).toHaveLength(4);
    expect(completionInputs[1]).toEqual(completionInputs[0]);
    expect(completionInputs[2]).toEqual(completionInputs[0]);
    expect(completionInputs[3]).toEqual(completionInputs[0]);
    expect(finalized.receipt.checkpointHead).toEqual(completionInputs[0]!.nextCheckpointHead);
    expect(openTransformerAttemptCheckpoint(
      finalized.envelope,
      key,
      current.state.binding,
    ).stage).toBe("terminal");
    expect(pending).toHaveLength(2);
    expect(new Set(referenced)).toEqual(new Set([
      finalized.receipt.checkpointHead.envelopeStorageKey,
      completionResult.artifact.storageKey,
    ]));
    expect(unreferenced).toEqual([]);

    currentHead = {
      schemaVersion: 1,
      episodeId: current.state.episodeId,
      stateDigest: coordinatorDispatchedHead.stateDigest,
      envelopeStorageKey: currentStorageKey,
      envelopeDigest: currentEnvelopeDigest,
      generation: coordinatorDispatchedHead.generation,
      attemptNumber: current.state.attemptNumber,
      writerLeaseGeneration: current.state.writerLeaseGeneration,
      writerLeaseTokenDigest: current.state.writerLeaseTokenDigest,
    };
    committedResult = null;
    lostResponsesRemaining = 0;
    pending.length = 0;
    referenced.length = 0;
    unreferenced.length = 0;
    completionInputs.length = 0;
    const siblings = await Promise.all([
      finalizeTransformerPilotAttemptCheckpoint(finalizeInput),
      finalizeTransformerPilotAttemptCheckpoint(finalizeInput),
    ]);
    expect(siblings[0]!.receipt.checkpointHead).toEqual(siblings[1]!.receipt.checkpointHead);
    expect(currentHead).toEqual(siblings[0]!.receipt.checkpointHead);
    expect(unreferenced).toHaveLength(1);
    expect(unreferenced[0]).not.toBe(currentHead.envelopeStorageKey);
  });

  it("rejects cursor skips, unbound verification plans, hollow seals, and premature terminal state", async () => {
    const journal = new Journal();
    const current = fixture();
    install(journal, current);
    const head = await commitTransformerAttemptCheckpointGenesis(journal, current.state, key);
    expect(() => createTransformerCandidateSeal(
      current.state.binding,
      current.state.workspaceArtifact,
    )).toThrow("transformer_attempt_checkpoint_candidate_seal_invalid");

    for (const invalid of [
      { ...current.state, generation: 2, commandCursor: 1 },
      {
        ...current.state,
        generation: 2,
        verificationPlan: [{
          index: 0,
          commandId: "other",
          commandDigest: digest("other"),
        }],
      },
      {
        ...current.state,
        generation: 2,
        stage: "candidate_sealed" as const,
        candidateSeal: {
          schemaVersion: 1 as const,
          candidateRevision: current.state.binding.candidateRevision,
          candidateDigest: digest("forged"),
          workspaceManifestDigest: current.state.workspaceArtifact.manifestDigest,
          workspacePayloadDigest: current.state.workspaceArtifact.payloadDigest,
          sealDigest: digest("forged seal"),
        },
      },
      { ...current.state, generation: 2, stage: "terminal" as const },
    ]) {
      await expect(advanceTransformerAttemptCheckpoint(
        journal,
        head.stateDigest,
        {
          ...invalid,
          previousCheckpointDigest: head.stateDigest,
          createdAt: "2026-08-11T18:01:00.000Z",
        } as TransformerAttemptCheckpointState,
        key,
        current.state.binding,
      )).rejects.toThrow(/transformer_attempt_checkpoint_/);
    }
  });

  it("rejects plaintext aliases and missing shared artifacts before commit", async () => {
    for (const path of [
      "src//index.ts",
      "src/file:stream",
      "CON",
      "src/NUL.txt",
      "src/file?.ts",
      "src/file*.ts",
      'src/file".ts',
      "src/file<.ts",
      "src/file>.ts",
      "src/file|.ts",
      "CONIN$",
      "CONOUT$",
      `src/${"a".repeat(256)}.ts`,
    ]) {
      expect(() => createTransformerWorkspaceArtifact(
        { tenantId: "tenant-a", episodeId: "episode-a" },
        [{ path, content: Buffer.from("bad"), mode: "file" }],
        key,
      )).toThrow("transformer_attempt_checkpoint_workspace_artifact_invalid");
    }

    const journal = new Journal();
    const current = fixture();
    journal.setLease(current.state.episodeId, lease());
    await expect(commitTransformerAttemptCheckpointGenesis(journal, current.state, key))
      .rejects.toThrow("transformer_attempt_checkpoint_artifact_missing");
  });

  it("requires a stored immutable request before an effect can be dispatched", async () => {
    const journal = new Journal();
    const current = fixture();
    install(journal, current);
    const head = await commitTransformerAttemptCheckpointGenesis(journal, current.state, key);
    const nextWorkspace = createTransformerWorkspaceArtifact(
      { tenantId: current.state.binding.tenantId, episodeId: current.state.episodeId },
      [{ path: "package.json", content: Buffer.from('{"name":"changed"}\n'), mode: "file" }],
      key,
    );
    const payload = createTransformerWorkspaceTransitionRequest(
      current.state.workspaceArtifact,
      nextWorkspace.artifact,
    );
    const identity = createTransformerAttemptEffectIdentity(
      current.state.episodeId,
      "workspace_publish",
      `workspace:${nextWorkspace.artifact.manifestDigest}:0`,
      digest(payload),
    );
    const firstRequest = createTransformerEffectRequestArtifact({
      tenantId: current.state.binding.tenantId,
      episodeId: current.state.episodeId,
      effectId: identity.effectId,
    }, payload, key);
    const prepared = {
      ...current.state,
      generation: 2,
      pendingEffect: {
        kind: "workspace_publish" as const,
        state: "prepared" as const,
        slot: `workspace:${nextWorkspace.artifact.manifestDigest}:0`,
        ...identity,
        requestDigest: digest(payload),
        requestArtifact: firstRequest.artifact,
      },
      previousCheckpointDigest: head.stateDigest,
      createdAt: "2026-08-11T18:01:00.000Z",
    };

    await expect(advanceTransformerAttemptCheckpoint(
      journal, head.stateDigest, prepared, key, current.state.binding,
    )).rejects.toThrow("transformer_attempt_checkpoint_artifact_missing");

    journal.putArtifact(firstRequest.artifact.storageKey, firstRequest.bytes);
    const preparedHead = await advanceTransformerAttemptCheckpoint(
      journal, head.stateDigest, prepared, key, current.state.binding,
    );
    const secondRequest = createTransformerEffectRequestArtifact({
      tenantId: current.state.binding.tenantId,
      episodeId: current.state.episodeId,
      effectId: identity.effectId,
    }, payload, key);
    journal.putArtifact(secondRequest.artifact.storageKey, secondRequest.bytes);
    await expect(advanceTransformerAttemptCheckpoint(
      journal,
      preparedHead.stateDigest,
      {
        ...prepared,
        generation: 3,
        pendingEffect: {
          ...prepared.pendingEffect,
          state: "dispatched" as const,
          requestArtifact: secondRequest.artifact,
        },
        previousCheckpointDigest: preparedHead.stateDigest,
        createdAt: "2026-08-11T18:02:00.000Z",
      },
      key,
      current.state.binding,
    )).rejects.toThrow("transformer_attempt_checkpoint_effect_transition_invalid");
  });

  it("supports the active runner's bounded midscale workspace size", () => {
    const content = Buffer.alloc(17 * 1024 * 1024, "a");
    const workspace = createTransformerWorkspaceArtifact(
      { tenantId: "tenant-a", episodeId: "episode-a" },
      [{ path: "src/large.ts", content, mode: "file" }],
      key,
    );
    expect(workspace.manifest[0]?.bytes).toBe(content.byteLength);
    expect(workspace.artifact.bytes).toBeGreaterThan(16 * 1024 * 1024);
  });

  it("derives model accounting exactly from the authenticated result", async () => {
    const journal = new Journal();
    const current = fixture();
    install(journal, current);
    const genesisHead = await commitTransformerAttemptCheckpointGenesis(journal, current.state, key);
    const workspace = createTransformerWorkspaceArtifact(
      { tenantId: current.state.binding.tenantId, episodeId: current.state.episodeId },
      [{ path: "package.json", content: Buffer.from('{"name":"changed"}\n'), mode: "file" }],
      key,
    );
    journal.putArtifact(workspace.artifact.storageKey, workspace.bytes);
    const published = await consumeEffect(journal, genesisHead, current.state, {
      kind: "workspace_publish",
      slot: `workspace:${workspace.artifact.manifestDigest}:0`,
      requestPayload: createTransformerWorkspaceTransitionRequest(
        current.state.workspaceArtifact,
        workspace.artifact,
      ),
      createResult: () => ({ artifact: workspace.artifact, bytes: workspace.bytes }),
      consume: () => ({
        stage: "recipe_applied" as const,
        workspaceManifest: workspace.manifest,
        workspaceArtifact: workspace.artifact,
      }),
    });
    const verification = {
      ...published.state,
      generation: published.state.generation + 1,
      stage: "verification" as const,
      previousCheckpointDigest: published.head.stateDigest,
      createdAt: new Date(Date.parse(published.state.createdAt) + 60_000).toISOString(),
    } satisfies TransformerAttemptCheckpointState;
    const verificationHead = await advanceTransformerAttemptCheckpoint(
      journal, published.head.stateDigest, verification, key, current.state.binding,
    );
    const adaptive = {
      ...verification,
      generation: verification.generation + 1,
      stage: "adaptive" as const,
      previousCheckpointDigest: verificationHead.stateDigest,
      createdAt: new Date(Date.parse(verification.createdAt) + 60_000).toISOString(),
    } satisfies TransformerAttemptCheckpointState;
    const adaptiveHead = await advanceTransformerAttemptCheckpoint(
      journal, verificationHead.stateDigest, adaptive, key, current.state.binding,
    );
    const usage = {
      schemaVersion: 1 as const,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      costUsd: 0.25,
      wallTimeMs: 500,
      responseDigest: digest("planner response"),
      responseBase64: Buffer.from("planner response", "utf8").toString("base64"),
    };
    const modelEffect = {
      kind: "model" as const,
      slot: "planner:0",
      requestPayload: Buffer.from("planner request", "utf8"),
      createResult: (effectId: string) => createTransformerModelEffectResultArtifact({
        tenantId: current.state.binding.tenantId,
        episodeId: current.state.episodeId,
        effectId,
      }, usage, key),
    };
    await expect(consumeEffect(journal.clone(), adaptiveHead, adaptive, {
      ...modelEffect,
      consume: () => ({
        accounting: { ...adaptive.accounting, plannerCalls: 1, costUsd: 0.01 },
      }),
    })).rejects.toThrow("transformer_attempt_checkpoint_accounting_invalid");
    const consumed = await consumeEffect(journal, adaptiveHead, adaptive, {
      ...modelEffect,
      consume: () => ({
        accounting: {
          plannerCalls: 1,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          costUsd: usage.costUsd,
          wallTimeMs: usage.wallTimeMs,
        },
      }),
    });
    expect(consumed.state.accounting).toEqual({
      plannerCalls: 1,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      costUsd: 0.25,
      wallTimeMs: 500,
    });
  });

  it("allows an adaptive worker to revisit an exact prior workspace", async () => {
    const journal = new Journal();
    const current = fixture();
    install(journal, current);
    const genesisHead = await commitTransformerAttemptCheckpointGenesis(journal, current.state, key);
    const workspaceB = createTransformerWorkspaceArtifact(
      { tenantId: current.state.binding.tenantId, episodeId: current.state.episodeId },
      [{ path: "package.json", content: Buffer.from('{"name":"changed"}\n'), mode: "file" }],
      key,
    );
    const publish = async (
      head: TransformerAttemptCheckpointEnvelope,
      state: TransformerAttemptCheckpointState,
      workspace: ReturnType<typeof createTransformerWorkspaceArtifact>,
    ) => consumeEffect(journal, head, state, {
      kind: "workspace_publish",
      slot: `workspace:${workspace.artifact.manifestDigest}:${state.completedEffects.filter((effect) =>
        effect.kind === "workspace_publish"
      ).length}`,
      requestPayload: createTransformerWorkspaceTransitionRequest(
        state.workspaceArtifact,
        workspace.artifact,
      ),
      createResult: () => ({ artifact: workspace.artifact, bytes: workspace.bytes }),
      consume: () => ({
        stage: state.stage === "source_loaded" ? "recipe_applied" as const : state.stage,
        commandCursor: 0,
        workspaceManifest: workspace.manifest,
        workspaceArtifact: workspace.artifact,
      }),
    });
    const advanceStage = async (
      head: TransformerAttemptCheckpointEnvelope,
      state: TransformerAttemptCheckpointState,
      stage: "verification" | "adaptive",
    ) => {
      const next = {
        ...state,
        generation: state.generation + 1,
        stage,
        previousCheckpointDigest: head.stateDigest,
        createdAt: new Date(Date.parse(state.createdAt) + 60_000).toISOString(),
      } satisfies TransformerAttemptCheckpointState;
      const nextHead = await advanceTransformerAttemptCheckpoint(
        journal, head.stateDigest, next, key, state.binding,
      );
      return { head: nextHead, state: openTransformerAttemptCheckpoint(nextHead, key, state.binding) };
    };
    const verify = async (
      head: TransformerAttemptCheckpointEnvelope,
      state: TransformerAttemptCheckpointState,
      round: number,
    ) => {
      const output = Buffer.from(`verified ${state.workspaceArtifact.manifestDigest} ${round}`, "utf8");
      return consumeEffect(journal, head, state, {
        kind: "verifier",
        slot: `verification:${state.workspaceArtifact.manifestDigest}:${round}:0`,
        requestPayload: Buffer.from("npm run typecheck", "utf8"),
        createResult: (effectId) => createTransformerVerifierEffectResultArtifact({
          tenantId: state.binding.tenantId,
          episodeId: state.episodeId,
          effectId,
        }, {
          schemaVersion: 1,
          status: "passed",
          outputDigest: digest(output),
          outputBase64: output.toString("base64"),
        }, key),
        consume: () => ({
          commandCursor: 1,
          verificationReceipts: [...state.verificationReceipts, {
            sequence: state.verificationReceipts.length,
            round,
            index: 0,
            commandId: "typecheck",
            commandDigest: digest("npm run typecheck"),
            workspaceManifestDigest: state.workspaceArtifact.manifestDigest,
            status: "passed" as const,
            outputDigest: digest(output),
          }],
        }),
      });
    };
    const firstB = await publish(genesisHead, current.state, workspaceB);
    const firstBVerification = await advanceStage(firstB.head, firstB.state, "verification");
    const verifiedB = await verify(firstBVerification.head, firstBVerification.state, 0);
    const adaptiveB = await advanceStage(verifiedB.head, verifiedB.state, "adaptive");
    const backToA = await publish(adaptiveB.head, adaptiveB.state, {
      artifact: current.state.workspaceArtifact,
      bytes: current.artifactBytes,
      manifest: current.state.workspaceManifest,
    });
    const verifiedA = await verify(backToA.head, backToA.state, 0);
    const secondB = await publish(verifiedA.head, verifiedA.state, workspaceB);
    const reverifiedB = await verify(secondB.head, secondB.state, 1);
    expect(reverifiedB.state.workspaceArtifact.manifestDigest).toBe(workspaceB.artifact.manifestDigest);
    expect(reverifiedB.state.completedEffects.filter((effect) =>
      effect.kind === "workspace_publish" &&
      effect.slot.startsWith(`workspace:${workspaceB.artifact.manifestDigest}:`)
    )).toHaveLength(2);
    expect(reverifiedB.state.verificationReceipts.map((receipt) => [
      receipt.workspaceManifestDigest,
      receipt.round,
    ])).toEqual([
      [workspaceB.artifact.manifestDigest, 0],
      [current.state.workspaceArtifact.manifestDigest, 0],
      [workspaceB.artifact.manifestDigest, 1],
    ]);
  });
});
