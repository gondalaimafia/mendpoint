import { createHash } from "node:crypto";
import {
  advanceTransformerAttemptCheckpoint,
  commitTransformerAttemptCheckpointGenesis,
  createTransformerAttemptEffectIdentity,
  createTransformerCandidatePublicationRequest,
  createTransformerCandidateSeal,
  createTransformerCandidateSealPayload,
  createTransformerCoordinatorCompletionRequest,
  createTransformerCoordinatorCompletionSlot,
  createTransformerCoordinatorEffectResultArtifact,
  createTransformerEffectRequestArtifact,
  createTransformerEffectResultArtifact,
  createTransformerEpisodeId,
  createTransformerVerificationPlanDigest,
  createTransformerVerifierEffectResultArtifact,
  createTransformerWorkspaceArtifact,
  createTransformerWorkspaceManifest,
  createTransformerWorkspaceManifestDigest,
  createTransformerWorkspaceTransitionRequest,
  openTransformerCoordinatorCompletionRequest,
  openTransformerAttemptCheckpoint,
  openTransformerVerifierEffectResultArtifact,
  openTransformerWorkspaceArtifact,
  openTransformerWorkspaceTransitionRequest,
  supersedeTransformerAttemptCheckpointCoordinatorCompletion,
  supersedeTransformerAttemptCheckpointFailedVerifier,
  verifyTransformerEffectRequestArtifact,
  verifyTransformerEffectResultArtifact,
  type TransformerAttemptCheckpointBinding,
  type TransformerAttemptCheckpointEffect,
  type TransformerAttemptCheckpointEffectReceipt,
  type TransformerAttemptCheckpointEnvelope,
  type TransformerAttemptCheckpointState,
  type TransformerEncryptedArtifact,
  type TransformerVerifierEffectResult,
  type TransformerWorkspaceArtifact,
  type TransformerWorkspaceArtifactFile,
} from "./attempt-checkpoint.js";
import {
  createTransformerAttemptAuthorizationDigest,
  createTransformerAttemptCompletionDigest,
  type TransformerAttemptCompletionIntent,
} from "./attempt-completion.js";
import {
  createTransformerPilotCheckpointJournal,
  finalizeTransformerPilotAttemptCheckpoint,
  type TransformerAttemptCheckpointArtifactStore,
} from "./attempt-checkpoint-storage.js";
import type {
  TransformerAttemptCheckpointConfig,
  TransformerAttemptCheckpointCompletion,
  TransformerAttemptCheckpointExecutionController,
  TransformerAttemptCheckpointFailure,
  TransformerAttemptCheckpointOpenInput,
} from "./attempt-runner.js";
import {
  createRecipeVerificationControl,
  type RecipeCommandProvenance,
  type RecipeCommandResult,
  type RecipeControlledCommandResult,
  type RecipeVerificationControlInput,
} from "./recipe-workspace-execution.js";
import {
  applyRecipe,
  normalizeRecipeFileModes,
  recipeFilesDigest,
  type GitBlobMode,
  type RecipeFileModes,
  type RecipeFiles,
} from "./recipe.js";
import {
  TransformerPilotExecutionStore,
  type TransformerAdaptiveAttemptAccounting,
} from "./pilot-execution.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;

export type TransformerPilotAttemptCheckpointConfigInput = Readonly<{
  pilotStore: TransformerPilotExecutionStore;
  artifactStore: TransformerAttemptCheckpointArtifactStore;
  encryptionKey: Uint8Array;
  executorDigest: string;
  evidenceRefs: readonly string[];
  gateConfig?: string;
  operationTimeoutMs?: number;
  now?: () => string;
}>;

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`
  ).join(",")}}`;
}

function accountingMatchesDurableCompletion(
  durable: TransformerAdaptiveAttemptAccounting,
  resumed: TransformerAdaptiveAttemptAccounting,
): boolean {
  return durable.plannerCalls === resumed.plannerCalls &&
    durable.modelCalls === resumed.modelCalls &&
    durable.inputTokens === resumed.inputTokens &&
    durable.outputTokens === resumed.outputTokens &&
    durable.totalTokens === resumed.totalTokens &&
    durable.actualCostUsd === resumed.actualCostUsd &&
    resumed.wallTimeMs >= durable.wallTimeMs;
}

function assertSignal(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("transformer_attempt_checkpoint_operation_aborted");
  }
}

async function boundedOperation<T>(
  signal: AbortSignal,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  assertSignal(signal);
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(
      signal.reason instanceof Error
        ? signal.reason
        : new Error("transformer_attempt_checkpoint_operation_aborted"),
    ));
    const timer = setTimeout(() => finish(() => reject(
      new Error("transformer_attempt_checkpoint_operation_timeout"),
    )), timeoutMs);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation()).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function assertTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("transformer_attempt_checkpoint_clock_invalid");
  }
  return value;
}

function workspaceFiles(files: RecipeFiles, modes: RecipeFileModes): readonly TransformerWorkspaceArtifactFile[] {
  const normalizedModes = normalizeRecipeFileModes(files, modes);
  return Object.freeze(Object.entries(files).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  ).map(([path, content]) => Object.freeze({
    path,
    content: Buffer.from(content, "utf8"),
    mode: normalizedModes[path] === "100755" ? "executable" as const : "file" as const,
  })));
}

function restoredWorkspace(files: readonly TransformerWorkspaceArtifactFile[]): Readonly<{
  files: RecipeFiles;
  modes: RecipeFileModes;
}> {
  const content: Record<string, string> = {};
  const modes: Record<string, GitBlobMode> = {};
  for (const file of files) {
    const text = Buffer.from(file.content).toString("utf8");
    if (!Buffer.from(text, "utf8").equals(Buffer.from(file.content))) {
      throw new Error("transformer_attempt_checkpoint_workspace_artifact_invalid");
    }
    content[file.path] = text;
    modes[file.path] = file.mode === "executable" ? "100755" : "100644";
  }
  return Object.freeze({ files: Object.freeze(content), modes: Object.freeze(modes) });
}

function commandPayload(result: RecipeCommandResult): Uint8Array {
  return Buffer.from(canonical({
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout,
  }), "utf8");
}

function parseCommandPayload(payload: Uint8Array): RecipeCommandResult {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch {
    throw new Error("transformer_attempt_checkpoint_verifier_result_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      canonical(value) !== Buffer.from(payload).toString("utf8")) {
    throw new Error("transformer_attempt_checkpoint_verifier_result_invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "exitCode,stderr,stdout" ||
      !Number.isSafeInteger(record.exitCode) || typeof record.stderr !== "string" ||
      typeof record.stdout !== "string") {
    throw new Error("transformer_attempt_checkpoint_verifier_result_invalid");
  }
  return Object.freeze({
    exitCode: record.exitCode as number,
    stderr: record.stderr,
    stdout: record.stdout,
  });
}

function verificationRound(state: TransformerAttemptCheckpointState): number {
  const rounds = state.verificationReceipts
    .filter((receipt) => receipt.workspaceManifestDigest === state.workspaceArtifact.manifestDigest)
    .map((receipt) => receipt.round);
  return rounds.length === 0 ? 0 : Math.max(...rounds);
}

function effectReceipt(effect: Exclude<TransformerAttemptCheckpointEffect, { kind: "none" }>):
TransformerAttemptCheckpointEffectReceipt {
  if (effect.state !== "completed") {
    throw new Error("transformer_attempt_checkpoint_effect_transition_invalid");
  }
  return Object.freeze({
    kind: effect.kind,
    effectId: effect.effectId,
    slot: effect.slot,
    idempotencyKey: effect.idempotencyKey,
    requestDigest: effect.requestDigest,
    requestArtifact: effect.requestArtifact,
    resultArtifact: effect.resultArtifact,
  });
}

function uniqueEvidence(...groups: readonly (readonly string[])[]): readonly string[] {
  const values = [...new Set(groups.flat().filter((entry) => typeof entry === "string" && entry.trim()))].sort();
  if (values.length === 0) throw new Error("transformer_attempt_checkpoint_evidence_required");
  return Object.freeze(values);
}

function validateFactoryInput(input: TransformerPilotAttemptCheckpointConfigInput): void {
  if (!(input.pilotStore instanceof TransformerPilotExecutionStore) ||
      !input.artifactStore || typeof input.artifactStore.read !== "function" ||
      !(input.encryptionKey instanceof Uint8Array) || input.encryptionKey.byteLength !== 32 ||
      !DIGEST.test(input.executorDigest) || !Array.isArray(input.evidenceRefs) ||
      input.evidenceRefs.length === 0 || input.evidenceRefs.some((entry) => !entry.trim()) ||
      (input.operationTimeoutMs !== undefined &&
       (!Number.isSafeInteger(input.operationTimeoutMs) || input.operationTimeoutMs < 1))) {
    throw new Error("transformer_attempt_checkpoint_config_invalid");
  }
}

export function createTransformerPilotAttemptCheckpointConfig(
  factory: TransformerPilotAttemptCheckpointConfigInput,
): TransformerAttemptCheckpointConfig {
  validateFactoryInput(factory);
  const encryptionKey = new Uint8Array(factory.encryptionKey);
  const factoryEvidence = Object.freeze([...factory.evidenceRefs]);
  const now = factory.now ?? (() => new Date().toISOString());
  const operationTimeoutMs = factory.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;

  return Object.freeze({
    operationTimeoutMs,
    async open(openInput): Promise<TransformerAttemptCheckpointExecutionController> {
      return openController({
        factory: { ...factory, encryptionKey, evidenceRefs: factoryEvidence, now, operationTimeoutMs },
        input: openInput,
      });
    },
  });
}

type TrustedFactory = TransformerPilotAttemptCheckpointConfigInput & Readonly<{
  now: () => string;
  operationTimeoutMs: number;
}>;

async function openController(context: Readonly<{
  factory: TrustedFactory;
  input: TransformerAttemptCheckpointOpenInput;
}>): Promise<TransformerAttemptCheckpointExecutionController> {
  const { factory, input } = context;
  const encryptionKey = factory.encryptionKey;
  assertSignal(input.signal);
  await input.assertFence();
  assertSignal(input.signal);
  const application = applyRecipe(input.lease.recipe, input.source.files);
  if (application.outputDigest !== input.lease.candidateDigest ||
      input.source.digest !== input.lease.snapshot.digest ||
      input.source.revision !== input.lease.snapshot.revision) {
    throw new Error("transformer_attempt_checkpoint_binding_authority_mismatch");
  }
  const sourceFiles = workspaceFiles(input.source.files, input.source.fileModes);
  const candidateModes = normalizeRecipeFileModes(application.files, input.source.fileModes);
  const candidateFiles = workspaceFiles(application.files, candidateModes);
  const sourceManifest = createTransformerWorkspaceManifest(sourceFiles);
  const candidateManifest = createTransformerWorkspaceManifest(candidateFiles);
  const verificationPlan = Object.freeze(application.verificationCommands.map((command, index) => Object.freeze({
    index,
    commandId: command.id,
    commandDigest: sha256(command.command),
  })));
  const binding: TransformerAttemptCheckpointBinding = Object.freeze({
    schemaVersion: 1,
    tenantId: input.lease.tenantId,
    environment: input.scope.environment,
    campaignId: input.lease.campaignId,
    unitId: input.lease.unitId,
    repositoryId: input.lease.snapshot.repositoryId,
    snapshotId: input.lease.snapshot.snapshotId,
    sourceRevision: input.lease.snapshot.revision,
    sourceManifestDigest: createTransformerWorkspaceManifestDigest(sourceManifest),
    candidateRevision: input.lease.candidateRevision,
    candidateDigest: input.lease.candidateDigest,
    candidateManifestDigest: createTransformerWorkspaceManifestDigest(candidateManifest),
    recipeDigest: input.lease.recipe.digest,
    constraintDigest: input.lease.constraintDigest,
    executorDigest: factory.executorDigest,
    verificationPlanDigest: createTransformerVerificationPlanDigest(verificationPlan),
    requiredVerificationCount: verificationPlan.length,
  });
  const episodeId = createTransformerEpisodeId(binding);
  const journalInput = Object.freeze({
    pilotStore: factory.pilotStore,
    artifactStore: factory.artifactStore,
    tenantId: input.lease.tenantId,
    campaignId: input.lease.campaignId,
    unitId: input.lease.unitId,
    binding,
    encryptionKey,
    leaseToken: input.leaseToken,
    evidenceRefs: uniqueEvidence(factory.evidenceRefs, input.lease.gateEvidenceRefs),
    ...(factory.gateConfig === undefined ? {} : { gateConfig: factory.gateConfig }),
  });
  const journal = createTransformerPilotCheckpointJournal(journalInput);
  let head: TransformerAttemptCheckpointEnvelope;
  let state: TransformerAttemptCheckpointState;
  let serialized = Promise.resolve();
  const readState = (): TransformerAttemptCheckpointState => state;

  const publish = async (
    storageKey: string,
    bytes: Uint8Array,
    expectedDigest: string,
    signal = input.signal,
  ): Promise<void> => {
    assertSignal(signal);
    await boundedOperation(signal, factory.operationTimeoutMs, async () =>
      await factory.artifactStore.recordPending(storageKey));
    assertSignal(signal);
    await boundedOperation(signal, factory.operationTimeoutMs, async () =>
      await factory.artifactStore.publishImmutableDurable(storageKey, bytes));
    assertSignal(signal);
    const stored = await boundedOperation(signal, factory.operationTimeoutMs, async () =>
      await factory.artifactStore.read(storageKey));
    if (stored === null || sha256(stored) !== expectedDigest) {
      await boundedOperation(signal, factory.operationTimeoutMs, async () =>
        await factory.artifactStore.recordUnreferenced(storageKey));
      throw new Error("transformer_attempt_checkpoint_artifact_mismatch");
    }
    assertSignal(signal);
  };
  const markReferenced = async (
    storageKeys: readonly string[],
    signal = input.signal,
  ): Promise<void> => {
    for (const storageKey of storageKeys) {
      assertSignal(signal);
      await boundedOperation(signal, factory.operationTimeoutMs, async () =>
        await factory.artifactStore.recordReferenced(storageKey));
    }
    assertSignal(signal);
  };
  const readArtifact = async (
    storageKey: string,
    signal = input.signal,
  ): Promise<Uint8Array | null> => await boundedOperation(
    signal,
    factory.operationTimeoutMs,
    async () => await journal.readArtifact(storageKey),
  );
  const transition = async (
    patch: Omit<Partial<TransformerAttemptCheckpointState>,
      "generation" | "previousCheckpointDigest" | "createdAt" | "writerLeaseGeneration" |
      "writerLeaseTokenDigest" | "attemptNumber">,
    createdAt = assertTimestamp(factory.now()),
    signal = input.signal,
  ): Promise<void> => {
    assertSignal(signal);
    await boundedOperation(signal, factory.operationTimeoutMs, input.assertFence);
    assertSignal(signal);
    const lease = await boundedOperation(signal, factory.operationTimeoutMs, async () =>
      await journal.readLease(episodeId));
    if (lease === null) throw new Error("transformer_attempt_checkpoint_lease_mismatch");
    const next = {
      ...state,
      ...patch,
      generation: state.generation + 1,
      attemptNumber: lease.attemptNumber,
      writerLeaseGeneration: lease.generation,
      writerLeaseTokenDigest: lease.tokenDigest,
      previousCheckpointDigest: head.stateDigest,
      createdAt,
    } satisfies TransformerAttemptCheckpointState;
    head = await boundedOperation(signal, factory.operationTimeoutMs, async () =>
      await advanceTransformerAttemptCheckpoint(journal, head.stateDigest, next, encryptionKey, binding));
    state = openTransformerAttemptCheckpoint(head, encryptionKey, binding);
    assertSignal(signal);
  };
  const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    const prior = serialized;
    let release!: () => void;
    serialized = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const current = await boundedOperation(input.signal, factory.operationTimeoutMs, async () =>
    await journal.read(episodeId));
  if (current === null) {
    const source = createTransformerWorkspaceArtifact(
      { tenantId: binding.tenantId, episodeId }, sourceFiles, encryptionKey,
    );
    await publish(source.artifact.storageKey, source.bytes, source.artifact.ciphertextDigest);
    const activeLease = await boundedOperation(input.signal, factory.operationTimeoutMs, async () =>
      await journal.readLease(episodeId));
    if (activeLease === null) throw new Error("transformer_attempt_checkpoint_lease_mismatch");
    state = Object.freeze({
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
      workspaceManifest: source.manifest,
      workspaceArtifact: source.artifact,
      verificationReceipts: Object.freeze([]),
      accounting: Object.freeze({
        plannerCalls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        wallTimeMs: 0,
      }),
      completedEffects: Object.freeze([]),
      pendingEffect: Object.freeze({ kind: "none" }),
      candidateSeal: null,
      previousCheckpointDigest: null,
      createdAt: assertTimestamp(factory.now()),
    });
    head = await commitTransformerAttemptCheckpointGenesis(journal, state, encryptionKey);
    state = openTransformerAttemptCheckpoint(head, encryptionKey, binding);
    await markReferenced([source.artifact.storageKey]);
  } else {
    head = current;
    state = openTransformerAttemptCheckpoint(head, encryptionKey, binding);
  }

  if (state.pendingEffect.kind === "verifier" && state.pendingEffect.state === "completed") {
    const activeLease = await boundedOperation(input.signal, factory.operationTimeoutMs, async () =>
      await journal.readLease(episodeId));
    const newerLease = activeLease !== null && (
      activeLease.attemptNumber > state.attemptNumber ||
      (activeLease.attemptNumber === state.attemptNumber &&
        activeLease.generation > state.writerLeaseGeneration)
    );
    if (newerLease) {
      const supersededResultKey = state.pendingEffect.resultArtifact.storageKey;
      head = await boundedOperation(input.signal, factory.operationTimeoutMs, async () =>
        await supersedeTransformerAttemptCheckpointFailedVerifier(
          journal,
          head.stateDigest,
          assertTimestamp(factory.now()),
          encryptionKey,
          binding,
        ));
      state = openTransformerAttemptCheckpoint(head, encryptionKey, binding);
      await boundedOperation(input.signal, factory.operationTimeoutMs, async () =>
        await factory.artifactStore.recordUnreferenced(supersededResultKey));
    }
  }

  const repairReachableArtifacts = async (): Promise<void> => {
    const checkpointHead = factory.pilotStore
      .getCampaign(binding.tenantId, binding.campaignId)
      ?.units.find((unit) => unit.id === binding.unitId)?.attemptCheckpointHead;
    if (!checkpointHead || checkpointHead.stateDigest !== head.stateDigest ||
        checkpointHead.episodeId !== episodeId) {
      throw new Error("transformer_attempt_checkpoint_head_conflict");
    }
    const reachable = new Set<string>([
      checkpointHead.envelopeStorageKey,
      state.workspaceArtifact.storageKey,
    ]);
    const verifyWorkspace = async (artifact: TransformerWorkspaceArtifact): Promise<void> => {
      reachable.add(artifact.storageKey);
      const bytes = await readArtifact(artifact.storageKey);
      if (bytes === null) throw new Error("transformer_attempt_checkpoint_artifact_missing");
      openTransformerWorkspaceArtifact(
        artifact,
        bytes,
        encryptionKey,
        { tenantId: binding.tenantId, episodeId },
      );
    };
    const verifyEffect = async (
      effect: TransformerAttemptCheckpointEffectReceipt |
        Exclude<TransformerAttemptCheckpointEffect, Readonly<{ kind: "none" }>>,
    ): Promise<void> => {
      reachable.add(effect.requestArtifact.storageKey);
      const requestBytes = await readArtifact(effect.requestArtifact.storageKey);
      if (requestBytes === null) throw new Error("transformer_attempt_checkpoint_artifact_missing");
      if (effect.kind === "workspace_publish") {
        const request = openTransformerWorkspaceTransitionRequest(
          effect.requestArtifact,
          requestBytes,
          encryptionKey,
          { tenantId: binding.tenantId, episodeId, effectId: effect.effectId },
        );
        await verifyWorkspace(request.current);
        await verifyWorkspace(request.next);
      } else {
        verifyTransformerEffectRequestArtifact(
          effect.requestArtifact,
          requestBytes,
          encryptionKey,
          { tenantId: binding.tenantId, episodeId, effectId: effect.effectId },
        );
      }
      if ("state" in effect && effect.state !== "completed") return;
      const resultArtifact = "resultArtifact" in effect ? effect.resultArtifact : undefined;
      if (!resultArtifact) return;
      reachable.add(resultArtifact.storageKey);
      const resultBytes = await readArtifact(resultArtifact.storageKey);
      if (resultBytes === null) throw new Error("transformer_attempt_checkpoint_artifact_missing");
      if (effect.kind === "workspace_publish") {
        await verifyWorkspace(resultArtifact as TransformerWorkspaceArtifact);
      } else {
        verifyTransformerEffectResultArtifact(
          resultArtifact as TransformerEncryptedArtifact,
          resultBytes,
          encryptionKey,
          { tenantId: binding.tenantId, episodeId, effectId: effect.effectId },
        );
      }
    };
    await verifyWorkspace(state.workspaceArtifact);
    for (const effect of state.completedEffects) await verifyEffect(effect);
    if (state.pendingEffect.kind !== "none") await verifyEffect(state.pendingEffect);
    await markReferenced([...reachable]);
  };
  await repairReachableArtifacts();

  const workspaceForPending = async (): Promise<Readonly<{
    artifact: TransformerWorkspaceArtifact;
    bytes: Uint8Array;
    manifest: ReturnType<typeof createTransformerWorkspaceManifest>;
  }>> => {
    const effect = state.pendingEffect;
    if (effect.kind === "workspace_publish") {
      const requestBytes = await readArtifact(effect.requestArtifact.storageKey);
      if (requestBytes === null) throw new Error("transformer_attempt_checkpoint_artifact_missing");
      const request = openTransformerWorkspaceTransitionRequest(
        effect.requestArtifact,
        requestBytes,
        encryptionKey,
        { tenantId: binding.tenantId, episodeId, effectId: effect.effectId },
      );
      const bytes = await readArtifact(request.next.storageKey);
      if (bytes === null) throw new Error("transformer_attempt_checkpoint_artifact_missing");
      const openedFiles = openTransformerWorkspaceArtifact(
        request.next,
        bytes,
        encryptionKey,
        { tenantId: binding.tenantId, episodeId },
      );
      return Object.freeze({
        artifact: request.next,
        bytes,
        manifest: createTransformerWorkspaceManifest(openedFiles),
      });
    }
    const created = createTransformerWorkspaceArtifact(
      { tenantId: binding.tenantId, episodeId }, candidateFiles, encryptionKey,
    );
    await publish(created.artifact.storageKey, created.bytes, created.artifact.ciphertextDigest);
    return created;
  };

  while (state.stage === "source_loaded") {
    const workspace = await workspaceForPending();
    if (state.pendingEffect.kind === "none") {
      const requestPayload = createTransformerWorkspaceTransitionRequest(
        state.workspaceArtifact, workspace.artifact,
      );
      const requestDigest = sha256(requestPayload);
      const slot = `workspace:${workspace.artifact.manifestDigest}:0`;
      const identity = createTransformerAttemptEffectIdentity(episodeId, "workspace_publish", slot, requestDigest);
      const request = createTransformerEffectRequestArtifact(
        { tenantId: binding.tenantId, episodeId, effectId: identity.effectId },
        requestPayload,
        encryptionKey,
      );
      await publish(request.artifact.storageKey, request.bytes, request.artifact.ciphertextDigest);
      await transition({ pendingEffect: Object.freeze({
        kind: "workspace_publish",
        state: "prepared",
        slot,
        ...identity,
        requestDigest,
        requestArtifact: request.artifact,
      }) });
      await markReferenced([request.artifact.storageKey]);
      continue;
    }
    if (state.pendingEffect.kind !== "workspace_publish") {
      throw new Error("transformer_attempt_checkpoint_stage_mismatch");
    }
    if (state.pendingEffect.state === "prepared") {
      await transition({ pendingEffect: Object.freeze({ ...state.pendingEffect, state: "dispatched" }) });
      continue;
    }
    if (state.pendingEffect.state === "dispatched") {
      await transition({ pendingEffect: Object.freeze({
        ...state.pendingEffect,
        state: "completed",
        resultArtifact: workspace.artifact,
      }) });
      await markReferenced([workspace.artifact.storageKey]);
      continue;
    }
    const completed = state.pendingEffect;
    await transition({
      stage: "recipe_applied",
      workspaceManifest: workspace.manifest,
      workspaceArtifact: workspace.artifact,
      completedEffects: Object.freeze([...state.completedEffects, effectReceipt(completed)]),
      pendingEffect: Object.freeze({ kind: "none" }),
    });
  }
  if (state.stage === "recipe_applied" && state.pendingEffect.kind === "none") {
    await transition({ stage: "verification" });
  }
  if (state.stage !== "verification" && state.stage !== "adaptive" &&
      state.stage !== "candidate_sealed" &&
      state.stage !== "completion_prepared" && state.stage !== "terminal") {
    throw new Error("transformer_attempt_checkpoint_stage_unsupported");
  }

  const workspaceBytes = await readArtifact(state.workspaceArtifact.storageKey);
  if (workspaceBytes === null) throw new Error("transformer_attempt_checkpoint_artifact_missing");
  const openedWorkspace = openTransformerWorkspaceArtifact(
    state.workspaceArtifact,
    workspaceBytes,
    encryptionKey,
    { tenantId: binding.tenantId, episodeId },
  );
  const restored = restoredWorkspace(openedWorkspace);

  const recovered: RecipeControlledCommandResult[] = [];
  for (let index = 0; index < state.commandCursor; index++) {
    const receipt = [...state.verificationReceipts].reverse().find((entry) =>
      entry.workspaceManifestDigest === state.workspaceArtifact.manifestDigest && entry.index === index
    );
    if (!receipt || receipt.commandDigest !== verificationPlan[index]?.commandDigest) {
      throw new Error("transformer_attempt_checkpoint_receipt_invalid");
    }
    const effect = state.completedEffects.find((entry) =>
      entry.kind === "verifier" && entry.slot ===
        `verification:${state.workspaceArtifact.manifestDigest}:${receipt.round}:${index}`
    );
    if (!effect) throw new Error("transformer_attempt_checkpoint_receipt_invalid");
    const bytes = await readArtifact(effect.resultArtifact.storageKey);
    if (bytes === null) throw new Error("transformer_attempt_checkpoint_artifact_missing");
    const result = openTransformerVerifierEffectResultArtifact(
      effect.resultArtifact as TransformerEncryptedArtifact,
      bytes,
      encryptionKey,
      { tenantId: binding.tenantId, episodeId, effectId: effect.effectId },
    );
    const output = parseCommandPayload(Buffer.from(result.outputBase64, "base64"));
    if (result.outputDigest !== receipt.outputDigest ||
        (result.status === "passed") !== (output.exitCode === 0)) {
      throw new Error("transformer_attempt_checkpoint_receipt_invalid");
    }
    const provenance: RecipeCommandProvenance = Object.freeze({
      kind: "checkpoint_replay",
      commandDigest: receipt.commandDigest,
      workspaceManifestDigest: receipt.workspaceManifestDigest,
      effectResultDigest: effect.resultArtifact.payloadDigest,
    });
    recovered.push(Object.freeze({ result: output, provenance }));
  }

  const execute = async (commandInput: RecipeVerificationControlInput): Promise<RecipeControlledCommandResult> =>
    exclusive(async () => {
      assertSignal(input.signal);
      if (state.stage !== "verification" || commandInput.index !== state.commandCursor ||
          commandInput.command.id !== verificationPlan[commandInput.index]?.commandId ||
          sha256(commandInput.command.command) !== verificationPlan[commandInput.index]?.commandDigest) {
        throw new Error("transformer_attempt_checkpoint_verifier_slot_invalid");
      }
      const round = verificationRound(state);
      const slot = `verification:${state.workspaceArtifact.manifestDigest}:${round}:${commandInput.index}`;
      const requestPayload = Buffer.from(commandInput.command.command, "utf8");
      const requestDigest = sha256(requestPayload);
      const identity = createTransformerAttemptEffectIdentity(episodeId, "verifier", slot, requestDigest);
      if (state.pendingEffect.kind === "none") {
        const request = createTransformerEffectRequestArtifact(
          { tenantId: binding.tenantId, episodeId, effectId: identity.effectId },
          requestPayload,
          encryptionKey,
        );
        await publish(request.artifact.storageKey, request.bytes, request.artifact.ciphertextDigest);
        await transition({ pendingEffect: Object.freeze({
          kind: "verifier",
          state: "prepared",
          slot,
          ...identity,
          requestDigest,
          requestArtifact: request.artifact,
        }) });
        await markReferenced([request.artifact.storageKey]);
      }
      if (state.pendingEffect.kind !== "verifier" || state.pendingEffect.slot !== slot ||
          state.pendingEffect.effectId !== identity.effectId) {
        throw new Error("transformer_attempt_checkpoint_verifier_slot_invalid");
      }
      if (state.pendingEffect.state === "prepared") {
        await transition({ pendingEffect: Object.freeze({ ...state.pendingEffect, state: "dispatched" }) });
      }
      let executed = false;
      if (state.pendingEffect.kind === "verifier" && state.pendingEffect.state === "dispatched") {
        assertSignal(input.signal);
        await boundedOperation(input.signal, factory.operationTimeoutMs, input.assertFence);
        const result = await commandInput.run();
        executed = true;
        const output = commandPayload(result);
        const verifierResult: TransformerVerifierEffectResult = Object.freeze({
          schemaVersion: 1,
          status: result.exitCode === 0 ? "passed" : "failed",
          outputDigest: sha256(output),
          outputBase64: Buffer.from(output).toString("base64"),
        });
        const durable = createTransformerVerifierEffectResultArtifact(
          { tenantId: binding.tenantId, episodeId, effectId: state.pendingEffect.effectId },
          verifierResult,
          encryptionKey,
        );
        await publish(durable.artifact.storageKey, durable.bytes, durable.artifact.ciphertextDigest);
        await transition({ pendingEffect: Object.freeze({
          ...state.pendingEffect,
          state: "completed",
          resultArtifact: durable.artifact,
        }) });
        await markReferenced([durable.artifact.storageKey]);
      }
      if (state.pendingEffect.kind !== "verifier" || state.pendingEffect.state !== "completed") {
        throw new Error("transformer_attempt_checkpoint_verifier_result_invalid");
      }
      const completed = state.pendingEffect;
      const resultBytes = await readArtifact(completed.resultArtifact.storageKey);
      if (resultBytes === null) throw new Error("transformer_attempt_checkpoint_artifact_missing");
      const durableResult = openTransformerVerifierEffectResultArtifact(
        completed.resultArtifact as TransformerEncryptedArtifact,
        resultBytes,
        encryptionKey,
        { tenantId: binding.tenantId, episodeId, effectId: completed.effectId },
      );
      const result = parseCommandPayload(Buffer.from(durableResult.outputBase64, "base64"));
      if (durableResult.status === "failed") {
        return Object.freeze({
          result,
          provenance: Object.freeze({
            kind: "checkpoint_replay" as const,
            commandDigest: requestDigest,
            workspaceManifestDigest: state.workspaceArtifact.manifestDigest,
            effectResultDigest: completed.resultArtifact.payloadDigest,
          }),
        });
      }
      await transition({
        commandCursor: state.commandCursor + 1,
        verificationReceipts: Object.freeze([...state.verificationReceipts, Object.freeze({
          sequence: state.verificationReceipts.length,
          round,
          index: commandInput.index,
          commandId: commandInput.command.id,
          commandDigest: requestDigest,
          workspaceManifestDigest: state.workspaceArtifact.manifestDigest,
          status: durableResult.status,
          outputDigest: durableResult.outputDigest,
        })]),
        completedEffects: Object.freeze([...state.completedEffects, effectReceipt(completed)]),
        pendingEffect: Object.freeze({ kind: "none" }),
      });
      return Object.freeze({
        result,
        provenance: executed
          ? Object.freeze({ kind: "executed" as const })
          : Object.freeze({
              kind: "checkpoint_replay" as const,
              commandDigest: requestDigest,
              workspaceManifestDigest: state.workspaceArtifact.manifestDigest,
              effectResultDigest: completed.resultArtifact.payloadDigest,
            }),
      });
    });

  const verificationControl = createRecipeVerificationControl({
    restoredFiles: restored.files,
    restoredFileModes: restored.modes,
    recoveredResults: recovered,
    execute,
  });

  const complete = async (completion: TransformerAttemptCheckpointCompletion): Promise<void> =>
    exclusive(async () => {
      assertSignal(completion.signal);
      await boundedOperation(completion.signal, factory.operationTimeoutMs, input.assertFence);
      if (state.stage === "terminal") return;
      const validateCompletion = (): void => {
        const current = readState();
        const fresh = current.stage === "verification" && current.pendingEffect.kind === "none";
        const candidateResume = current.stage === "adaptive" &&
          (current.pendingEffect.kind === "none" || current.pendingEffect.kind === "candidate_publish");
        const sealedResume = current.stage === "candidate_sealed" && current.pendingEffect.kind === "none";
        const completionResume = current.stage === "completion_prepared" &&
          (current.pendingEffect.kind === "none" ||
            (current.pendingEffect.kind === "coordinator_complete" &&
              (current.pendingEffect.state === "prepared" || current.pendingEffect.state === "dispatched")));
        if ((!fresh && !candidateResume && !sealedResume && !completionResume) ||
            current.commandCursor !== verificationPlan.length ||
            current.verificationReceipts.slice(-verificationPlan.length).some((receipt) =>
              receipt.workspaceManifestDigest !== current.workspaceArtifact.manifestDigest ||
              receipt.status !== "passed"
            ) || completion.execution.outputDigest !== binding.candidateDigest ||
            recipeFilesDigest(completion.execution.outputFiles) !== binding.candidateDigest ||
            canonical(completion.execution.outputFiles) !== canonical(restored.files) ||
            canonical(completion.execution.outputFileModes) !== canonical(restored.modes) ||
            completion.artifact.outputDigest !== binding.candidateDigest) {
          throw new Error("transformer_attempt_checkpoint_completion_invalid");
        }
      };
      validateCompletion();
      const seal = createTransformerCandidateSeal(binding, state.workspaceArtifact);
      if (state.stage === "verification") {
        await transition({ stage: "adaptive" }, assertTimestamp(factory.now()), completion.signal);
      }
      while (readState().stage === "adaptive") {
        const requestPayload = createTransformerCandidatePublicationRequest(episodeId, seal);
        const requestDigest = sha256(requestPayload);
        const identity = createTransformerAttemptEffectIdentity(
          episodeId, "candidate_publish", "candidate:seal", requestDigest,
        );
        if (readState().pendingEffect.kind === "none") {
          const request = createTransformerEffectRequestArtifact(
            { tenantId: binding.tenantId, episodeId, effectId: identity.effectId },
            requestPayload,
            encryptionKey,
          );
          await publish(
            request.artifact.storageKey,
            request.bytes,
            request.artifact.ciphertextDigest,
            completion.signal,
          );
          await transition({ pendingEffect: Object.freeze({
            kind: "candidate_publish", state: "prepared", slot: "candidate:seal", ...identity,
            requestDigest, requestArtifact: request.artifact,
          }) }, assertTimestamp(factory.now()), completion.signal);
          await markReferenced([request.artifact.storageKey], completion.signal);
          continue;
        }
        const candidateEffect = readState().pendingEffect;
        if (candidateEffect.kind !== "candidate_publish" || candidateEffect.effectId !== identity.effectId) {
          throw new Error("transformer_attempt_checkpoint_candidate_transition_invalid");
        }
        if (candidateEffect.state === "prepared") {
          await transition(
            { pendingEffect: Object.freeze({ ...candidateEffect, state: "dispatched" }) },
            assertTimestamp(factory.now()),
            completion.signal,
          );
          continue;
        }
        if (candidateEffect.state === "dispatched") {
          const result = createTransformerEffectResultArtifact(
            { tenantId: binding.tenantId, episodeId, effectId: identity.effectId },
            createTransformerCandidateSealPayload(binding, state.workspaceArtifact),
            encryptionKey,
          );
          await publish(
            result.artifact.storageKey,
            result.bytes,
            result.artifact.ciphertextDigest,
            completion.signal,
          );
          await transition({ pendingEffect: Object.freeze({
            ...candidateEffect,
            state: "completed", resultArtifact: result.artifact,
          }) }, assertTimestamp(factory.now()), completion.signal);
          await markReferenced([result.artifact.storageKey], completion.signal);
          continue;
        }
        if (candidateEffect.state !== "completed") {
          throw new Error("transformer_attempt_checkpoint_candidate_transition_invalid");
        }
        const resultBytes = await readArtifact(
          candidateEffect.resultArtifact.storageKey,
          completion.signal,
        );
        if (resultBytes === null || canonical(JSON.parse(Buffer.from(verifyTransformerEffectResultArtifact(
          candidateEffect.resultArtifact,
          resultBytes,
          encryptionKey,
          { tenantId: binding.tenantId, episodeId, effectId: candidateEffect.effectId },
        )).toString("utf8"))) !== canonical(JSON.parse(Buffer.from(
          createTransformerCandidateSealPayload(binding, state.workspaceArtifact),
        ).toString("utf8")))) {
          throw new Error("transformer_attempt_checkpoint_candidate_result_invalid");
        }
        await transition({
          stage: "candidate_sealed",
          candidateSeal: seal,
          completedEffects: Object.freeze([...state.completedEffects, effectReceipt(candidateEffect)]),
          pendingEffect: Object.freeze({ kind: "none" }),
        }, assertTimestamp(factory.now()), completion.signal);
      }
      if (readState().stage === "candidate_sealed") {
        await transition({ stage: "completion_prepared" }, assertTimestamp(factory.now()), completion.signal);
      }
      const candidateSeal = readState().candidateSeal;
      if (readState().stage !== "completion_prepared" || candidateSeal === null) {
        throw new Error("transformer_attempt_checkpoint_completion_invalid");
      }
      const evidenceRefs = uniqueEvidence(
        factory.evidenceRefs,
        input.lease.gateEvidenceRefs,
        completion.evidenceRefs,
      );
      const buildIntent = (observedAt: string): TransformerAttemptCompletionIntent => Object.freeze({
          schemaVersion: 1,
          tenantId: binding.tenantId,
          campaignId: binding.campaignId,
          unitId: binding.unitId,
          episodeId,
          candidateSealDigest: candidateSeal.sealDigest,
          attemptNumber: input.lease.attemptNumber,
          leaseGeneration: input.lease.leaseGeneration,
          leaseTokenDigest: input.lease.leaseTokenDigest,
          sourceRevision: binding.sourceRevision,
          sourceDigest: input.lease.snapshot.digest,
          candidateRevision: binding.candidateRevision,
          candidateDigest: binding.candidateDigest,
          authorizationDigest: createTransformerAttemptAuthorizationDigest(factory.gateConfig),
          verificationPassed: true,
          actualCostUsd: completion.actualCostUsd,
          accounting: Object.freeze({ ...completion.accounting }),
          observedAt,
          evidenceRefs,
        });
      let intent: TransformerAttemptCompletionIntent;
      let completionDigest: string;
      let identity: ReturnType<typeof createTransformerAttemptEffectIdentity>;
      let completionObservedAt: string;
      const existingCoordinator = readState().pendingEffect;
      if (existingCoordinator.kind === "coordinator_complete") {
        const requestBytes = await readArtifact(
          existingCoordinator.requestArtifact.storageKey,
          completion.signal,
        );
        if (requestBytes === null) throw new Error("transformer_attempt_checkpoint_artifact_missing");
        const payload = verifyTransformerEffectRequestArtifact(
          existingCoordinator.requestArtifact,
          requestBytes,
          encryptionKey,
          { tenantId: binding.tenantId, episodeId, effectId: existingCoordinator.effectId },
        );
        const existingRequest = openTransformerCoordinatorCompletionRequest(payload);
        const currentLease = existingRequest.completionIntent.attemptNumber === input.lease.attemptNumber &&
          existingRequest.completionIntent.leaseGeneration === input.lease.leaseGeneration &&
          existingRequest.completionIntent.leaseTokenDigest === input.lease.leaseTokenDigest;
        if (currentLease) {
          if (existingRequest.completionIntent.actualCostUsd !== completion.actualCostUsd) {
            throw new Error("transformer_attempt_checkpoint_completion_cost_mismatch");
          }
          if (!accountingMatchesDurableCompletion(
            existingRequest.completionIntent.accounting,
            completion.accounting,
          )) {
            throw new Error("transformer_attempt_checkpoint_completion_accounting_mismatch");
          }
          if (existingRequest.completionIntent.authorizationDigest !==
              createTransformerAttemptAuthorizationDigest(factory.gateConfig)) {
            throw new Error("transformer_attempt_checkpoint_completion_authorization_mismatch");
          }
          if (existingRequest.seal.sealDigest !== candidateSeal.sealDigest) {
            throw new Error("transformer_attempt_checkpoint_completion_seal_mismatch");
          }
          intent = existingRequest.completionIntent;
          completionDigest = existingRequest.completionDigest;
          completionObservedAt = intent.observedAt;
          identity = createTransformerAttemptEffectIdentity(
            episodeId,
            "coordinator_complete",
            existingCoordinator.slot,
            existingCoordinator.requestDigest,
          );
        } else {
          completionObservedAt = assertTimestamp(factory.now());
          intent = buildIntent(completionObservedAt);
          completionDigest = createTransformerAttemptCompletionDigest(intent);
          const requestPayload = createTransformerCoordinatorCompletionRequest(
            episodeId, candidateSeal, intent,
          );
          const requestDigest = sha256(requestPayload);
          const slot = createTransformerCoordinatorCompletionSlot(completionDigest);
          identity = createTransformerAttemptEffectIdentity(
            episodeId, "coordinator_complete", slot, requestDigest,
          );
          const request = createTransformerEffectRequestArtifact(
            { tenantId: binding.tenantId, episodeId, effectId: identity.effectId },
            requestPayload,
            encryptionKey,
          );
          await publish(
            request.artifact.storageKey,
            request.bytes,
            request.artifact.ciphertextDigest,
            completion.signal,
          );
          head = await boundedOperation(completion.signal, factory.operationTimeoutMs, async () =>
            await supersedeTransformerAttemptCheckpointCoordinatorCompletion(
              journal,
              head.stateDigest,
              Object.freeze({
                kind: "coordinator_complete",
                state: "prepared",
                slot,
                ...identity,
                requestDigest,
                requestArtifact: request.artifact,
              }),
              completionObservedAt,
              encryptionKey,
              binding,
            ));
          state = openTransformerAttemptCheckpoint(head, encryptionKey, binding);
          await markReferenced([request.artifact.storageKey], completion.signal);
        }
      } else {
        completionObservedAt = assertTimestamp(factory.now());
        intent = buildIntent(completionObservedAt);
        completionDigest = createTransformerAttemptCompletionDigest(intent);
        const requestPayload = createTransformerCoordinatorCompletionRequest(
          episodeId, candidateSeal, intent,
        );
        const requestDigest = sha256(requestPayload);
        const slot = createTransformerCoordinatorCompletionSlot(completionDigest);
        identity = createTransformerAttemptEffectIdentity(
          episodeId, "coordinator_complete", slot, requestDigest,
        );
        const request = createTransformerEffectRequestArtifact(
          { tenantId: binding.tenantId, episodeId, effectId: identity.effectId },
          requestPayload,
          encryptionKey,
        );
        await publish(
          request.artifact.storageKey,
          request.bytes,
          request.artifact.ciphertextDigest,
          completion.signal,
        );
        await transition({ pendingEffect: Object.freeze({
          kind: "coordinator_complete", state: "prepared", slot, ...identity,
          requestDigest, requestArtifact: request.artifact,
        }) }, completionObservedAt, completion.signal);
        await markReferenced([request.artifact.storageKey], completion.signal);
      }
      const coordinatorEffect = readState().pendingEffect;
      if (coordinatorEffect.kind !== "coordinator_complete" ||
          coordinatorEffect.effectId !== identity.effectId) {
        throw new Error("transformer_attempt_checkpoint_completion_invalid");
      }
      if (coordinatorEffect.state === "prepared") {
        await transition(
          { pendingEffect: Object.freeze({ ...coordinatorEffect, state: "dispatched" }) },
          completionObservedAt,
          completion.signal,
        );
      }
      const dispatchedCoordinator = readState().pendingEffect;
      if (dispatchedCoordinator.kind !== "coordinator_complete" ||
          dispatchedCoordinator.state !== "dispatched") {
        throw new Error("transformer_attempt_checkpoint_completion_invalid");
      }
      const accepted = createTransformerCoordinatorEffectResultArtifact(
        { tenantId: binding.tenantId, episodeId, effectId: dispatchedCoordinator.effectId },
        { schemaVersion: 1, status: "accepted", completionDigest },
        encryptionKey,
      );
      assertSignal(completion.signal);
      const finalized = await boundedOperation(completion.signal, factory.operationTimeoutMs, async () =>
        await finalizeTransformerPilotAttemptCheckpoint({
          ...journalInput,
          expectedStateDigest: head.stateDigest,
          resultArtifact: accepted.artifact,
          resultBytes: accepted.bytes,
          completionIntent: intent,
          candidateSeal,
        }));
      assertSignal(completion.signal);
      head = finalized.envelope;
      state = openTransformerAttemptCheckpoint(head, encryptionKey, binding);
    });

  const fail = async (failure: TransformerAttemptCheckpointFailure): Promise<void> =>
    exclusive(async () => {
      assertSignal(failure.signal);
      await boundedOperation(failure.signal, factory.operationTimeoutMs, input.assertFence);
      assertSignal(failure.signal);
      const latest = state.verificationReceipts.at(-1);
      const failedEffect = state.pendingEffect;
      if (failure.recoveryCode !== "verification_failed" ||
          failedEffect.kind !== "verifier" || failedEffect.state !== "completed" ||
          (latest !== undefined && latest.status === "failed")) {
        throw new Error("transformer_attempt_checkpoint_failure_invalid");
      }
      const idempotencyKey = `tfcheckpointfailure_${sha256(
        `${episodeId}\0${head.stateDigest}\0${failure.errorCode}`,
      ).slice("sha256:".length, "sha256:".length + 32)}`;
      await boundedOperation(failure.signal, factory.operationTimeoutMs, async () => {
        factory.pilotStore.recordAttemptFailureWithCheckpointHead({
        tenantId: binding.tenantId,
        campaignId: binding.campaignId,
        unitId: binding.unitId,
        episodeId,
        leaseGeneration: input.lease.leaseGeneration,
        leaseToken: input.leaseToken,
        expectedStateDigest: head.stateDigest,
        code: failure.recoveryCode,
        errorCode: failure.errorCode,
        accounting: failure.accounting,
        observedAt: failure.observedAt,
        evidenceRefs: uniqueEvidence(factory.evidenceRefs, input.lease.gateEvidenceRefs, failure.evidenceRefs),
        idempotencyKey,
        ...(factory.gateConfig === undefined ? {} : { gateConfig: factory.gateConfig }),
        });
      });
      assertSignal(failure.signal);
    });

  return Object.freeze({
    verificationControl,
    complete,
    fail,
  });
}
