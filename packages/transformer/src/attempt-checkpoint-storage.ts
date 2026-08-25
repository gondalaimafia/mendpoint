import { createHash } from "node:crypto";
import type {
  TransformerAttemptCheckpointBinding,
  TransformerAttemptCheckpointEnvelope,
  TransformerAttemptCheckpointJournal,
  TransformerAttemptCheckpointLease,
  TransformerAttemptCheckpointState,
  TransformerCandidateSeal,
  TransformerEncryptedArtifact,
  TransformerMissionArtifactRegistrationBinding,
} from "./attempt-checkpoint.js";
import {
  createTransformerAttemptEffectIdentity,
  createTransformerCoordinatorCompletionRequestDigest,
  createTransformerCoordinatorCompletionSlot,
  createTransformerEpisodeId,
  openTransformerCoordinatorCompletionRequest,
  openTransformerCoordinatorEffectResultArtifact,
  openTransformerAttemptCheckpoint,
  openTransformerWorkspaceArtifact,
  openTransformerWorkspaceTransitionRequest,
  prepareTransformerAttemptCheckpointTerminalAdvance,
  verifyTransformerEffectRequestArtifact,
} from "./attempt-checkpoint.js";
import {
  createTransformerAttemptCompletionDigest,
  createTransformerAttemptCompletionPayload,
  openTransformerAttemptCompletionPayload,
  type TransformerAttemptCompletionIntent,
} from "./attempt-completion.js";
import {
  transformerAttemptCheckpointEnvelopeStorageKey,
  TransformerPilotExecutionStore,
  type TransformerAttemptCheckpointCompletionInput,
  type TransformerAttemptCheckpointCompletionReceipt,
  type TransformerAttemptCheckpointFailureInput,
  type TransformerAttemptCheckpointFailureReceipt,
  type TransformerAttemptCheckpointHead,
} from "./pilot-execution.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const STORAGE_KEY = /^(?![A-Za-z]:)(?![\/])(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,1000}$/;
const MAX_ARTIFACT_BYTES = 80 * 1024 * 1024;

export type TransformerAttemptCheckpointArtifactStore = Readonly<{
  read(storageKey: string): Promise<Uint8Array | null>;
  publishImmutableDurable(storageKey: string, bytes: Uint8Array): Promise<void>;
  recordPending(storageKey: string): Promise<void>;
  recordReferenced(storageKey: string): Promise<void>;
  recordUnreferenced(storageKey: string): Promise<void>;
}>;

type MaybePromise<T> = T | PromiseLike<T>;

export type TransformerAttemptCheckpointBindingAuthority = Readonly<{
  tenantId: string;
  environment: string;
  campaignId: string;
  unitId: string;
  repositoryId: string;
  snapshotId: string;
  sourceRevision: string;
  sourceDigest: string;
  candidateRevision: string;
  candidateDigest: string;
  recipeDigest: string;
  constraintDigest: string;
}>;

export type TransformerAttemptCheckpointHeadMutation = Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  observedAt: string;
  evidenceRefs: readonly string[];
  idempotencyKey: string;
  attemptNumber: number;
  leaseGeneration: number;
  leaseToken: string;
  expectedStateDigest: string | null;
  next: TransformerAttemptCheckpointHead;
  gateConfig?: string;
}>;

export type TransformerAttemptCheckpointAuthorityPort = Readonly<{
  readBindingAuthority(input: Readonly<{
    tenantId: string;
    campaignId: string;
    unitId: string;
    signal?: AbortSignal;
  }>): MaybePromise<TransformerAttemptCheckpointBindingAuthority | null>;
  readLease(input: Readonly<{
    tenantId: string;
    campaignId: string;
    unitId: string;
    episodeId: string;
    observedAt: string;
  }>): MaybePromise<TransformerAttemptCheckpointLease | null>;
  readHead(input: Readonly<{
    tenantId: string;
    campaignId: string;
    unitId: string;
    episodeId: string;
  }>): MaybePromise<TransformerAttemptCheckpointHead | null>;
  compareAndSwapHead(
    input: TransformerAttemptCheckpointHeadMutation,
  ): MaybePromise<TransformerAttemptCheckpointHead>;
  completeWithHead(
    input: TransformerAttemptCheckpointCompletionInput,
  ): MaybePromise<Readonly<{ receipt: TransformerAttemptCheckpointCompletionReceipt }>>;
  failWithHead(input: TransformerAttemptCheckpointFailureInput): MaybePromise<void>;
  readFailureReceipt(
    input: TransformerAttemptCheckpointFailureInput,
  ): MaybePromise<TransformerAttemptCheckpointFailureReceipt | null>;
}>;

export function createTransformerPilotCheckpointAuthority(
  pilotStore: TransformerPilotExecutionStore,
): TransformerAttemptCheckpointAuthorityPort {
  if (!(pilotStore instanceof TransformerPilotExecutionStore)) {
    throw new Error("transformer_attempt_checkpoint_authority_invalid");
  }
  return Object.freeze({
    readBindingAuthority(input) {
      const campaign = pilotStore.getCampaign(input.tenantId, input.campaignId);
      const unit = campaign?.units.find((candidate) => candidate.id === input.unitId);
      if (!campaign || !unit) return null;
      return Object.freeze({
        tenantId: campaign.tenantId,
        environment: campaign.environment,
        campaignId: campaign.campaignId,
        unitId: unit.id,
        repositoryId: unit.snapshot.repositoryId,
        snapshotId: unit.snapshot.snapshotId,
        sourceRevision: unit.snapshot.revision,
        sourceDigest: unit.snapshot.digest,
        candidateRevision: unit.candidateRevision,
        candidateDigest: unit.candidateDigest,
        recipeDigest: unit.recipe.digest,
        constraintDigest: campaign.constraintDigest,
      });
    },
    readLease: (input) => pilotStore.readAttemptCheckpointLease(input),
    readHead: (input) => pilotStore.readAttemptCheckpointHead(input),
    compareAndSwapHead: (input) => pilotStore.compareAndSwapAttemptCheckpointHead(input),
    completeWithHead: (input) => pilotStore.completeAttemptWithCheckpointHead(input),
    failWithHead(input) {
      pilotStore.recordAttemptFailureWithCheckpointHead(input);
    },
    readFailureReceipt(input) {
      return pilotStore.readAttemptCheckpointFailureReceipt(input);
    },
  });
}

export type TransformerPilotCheckpointJournalInput = Readonly<{
  authority: TransformerAttemptCheckpointAuthorityPort;
  artifactStore: TransformerAttemptCheckpointArtifactStore;
  tenantId: string;
  campaignId: string;
  unitId: string;
  binding: TransformerAttemptCheckpointBinding;
  encryptionKey: Uint8Array;
  leaseToken: string;
  evidenceRefs: readonly string[];
  gateConfig?: string;
  signal?: AbortSignal;
}>;

export type TransformerPilotCheckpointTerminalFinalizeInput =
  TransformerPilotCheckpointJournalInput & Readonly<{
    expectedStateDigest: string;
    resultArtifact: TransformerEncryptedArtifact;
    resultBytes: Uint8Array;
    completionIntent: TransformerAttemptCompletionIntent;
    candidateSeal: TransformerCandidateSeal;
    artifactRegistration?: TransformerMissionArtifactRegistrationBinding;
  }>;

export type TransformerPilotCheckpointTerminalFinalizeResult = Readonly<{
  envelope: TransformerAttemptCheckpointEnvelope;
  receipt: TransformerAttemptCheckpointCompletionReceipt;
}>;

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function requireStorageKey(value: string): string {
  if (typeof value !== "string" || !STORAGE_KEY.test(value) ||
      value.includes("\\") || value.includes(":") || value.includes("//") ||
      value.split("/").some((segment) => segment === ".") || value.endsWith("/")) {
    throw new Error("transformer_attempt_checkpoint_storage_key_invalid");
  }
  return value;
}

function encodeEnvelope(envelope: TransformerAttemptCheckpointEnvelope): Uint8Array {
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

function decodeEnvelope(bytes: Uint8Array): TransformerAttemptCheckpointEnvelope {
  let envelope: TransformerAttemptCheckpointEnvelope;
  try {
    envelope = JSON.parse(Buffer.from(bytes).toString("utf8")) as TransformerAttemptCheckpointEnvelope;
  } catch {
    throw new Error("transformer_attempt_checkpoint_envelope_invalid");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("transformer_attempt_checkpoint_envelope_invalid");
  }
  return envelope;
}

function sameLease(
  left: TransformerAttemptCheckpointLease,
  right: TransformerAttemptCheckpointLease,
): boolean {
  return left.attemptNumber === right.attemptNumber &&
    left.generation === right.generation &&
    left.tokenDigest === right.tokenDigest;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("transformer_attempt_checkpoint_clock_invalid");
  }
  return parsed;
}

function sameCheckpointHead(
  left: TransformerAttemptCheckpointHead,
  right: TransformerAttemptCheckpointHead,
): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.episodeId === right.episodeId && left.stateDigest === right.stateDigest &&
    left.envelopeStorageKey === right.envelopeStorageKey &&
    left.envelopeDigest === right.envelopeDigest && left.generation === right.generation &&
    left.attemptNumber === right.attemptNumber &&
    left.writerLeaseGeneration === right.writerLeaseGeneration &&
    left.writerLeaseTokenDigest === right.writerLeaseTokenDigest;
}

async function publishAndVerify(
  artifactStore: TransformerAttemptCheckpointArtifactStore,
  storageKey: string,
  bytes: Uint8Array,
  expectedDigest: string,
  mismatchCode: string,
): Promise<void> {
  await artifactStore.publishImmutableDurable(storageKey, bytes);
  const stored = await artifactStore.read(storageKey);
  if (stored === null || digest(stored) !== expectedDigest) throw new Error(mismatchCode);
}

export async function createTransformerPilotCheckpointJournal(
  input: TransformerPilotCheckpointJournalInput,
): Promise<TransformerAttemptCheckpointJournal> {
  const binding = Object.freeze(structuredClone(input.binding));
  const evidenceRefs = Object.freeze([...input.evidenceRefs]);
  if (binding.tenantId !== input.tenantId ||
      binding.campaignId !== input.campaignId || binding.unitId !== input.unitId) {
    throw new Error("transformer_attempt_checkpoint_binding_mismatch");
  }
  const authority = await input.authority.readBindingAuthority({
    tenantId: input.tenantId,
    campaignId: input.campaignId,
    unitId: input.unitId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!authority || authority.tenantId !== input.tenantId ||
      authority.campaignId !== input.campaignId || authority.unitId !== input.unitId ||
      authority.environment !== binding.environment ||
      authority.repositoryId !== binding.repositoryId ||
      authority.snapshotId !== binding.snapshotId ||
      authority.sourceRevision !== binding.sourceRevision ||
      authority.candidateRevision !== binding.candidateRevision ||
      authority.candidateDigest !== binding.candidateDigest ||
      authority.recipeDigest !== binding.recipeDigest ||
      authority.constraintDigest !== binding.constraintDigest) {
    throw new Error("transformer_attempt_checkpoint_binding_authority_mismatch");
  }
  const sourceDigest = authority.sourceDigest;
  const episodeId = createTransformerEpisodeId(binding);
  const encryptionKey = new Uint8Array(input.encryptionKey);
  const artifactPrefix = `transformer/${input.tenantId}/${episodeId}/`;
  const trustedNow = (): string => new Date().toISOString();
  const requireEpisode = (episodeId: string) => {
    if (episodeId !== createTransformerEpisodeId(binding)) {
      throw new Error("transformer_attempt_checkpoint_episode_mismatch");
    }
  };
  const readLease = async (observedAt = trustedNow()): Promise<TransformerAttemptCheckpointLease | null> =>
    input.authority.readLease({
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      unitId: input.unitId,
      episodeId,
      observedAt,
    });
  const verifySourceAuthority = async (state: TransformerAttemptCheckpointState): Promise<void> => {
    let sourceArtifact = state.workspaceArtifact;
    if (state.stage !== "source_loaded") {
      const publication = state.completedEffects.find((effect) => effect.kind === "workspace_publish");
      if (publication === undefined) {
        throw new Error("transformer_attempt_checkpoint_source_authority_mismatch");
      }
      const requestBytes = await input.artifactStore.read(publication.requestArtifact.storageKey);
      if (requestBytes === null) {
        throw new Error("transformer_attempt_checkpoint_source_authority_mismatch");
      }
      sourceArtifact = openTransformerWorkspaceTransitionRequest(
        publication.requestArtifact,
        requestBytes,
        encryptionKey,
        { tenantId: input.tenantId, episodeId, effectId: publication.effectId },
      ).current;
    }
    const sourceBytes = await input.artifactStore.read(sourceArtifact.storageKey);
    if (sourceBytes === null) {
      throw new Error("transformer_attempt_checkpoint_source_authority_mismatch");
    }
    openTransformerWorkspaceArtifact(
      sourceArtifact,
      sourceBytes,
      encryptionKey,
      { tenantId: input.tenantId, episodeId },
    );
    if (sourceArtifact.filesDigest !== sourceDigest) {
      throw new Error("transformer_attempt_checkpoint_source_authority_mismatch");
    }
  };

  return Object.freeze({
    async read(episodeId) {
      requireEpisode(episodeId);
      const head = await input.authority.readHead({
        tenantId: input.tenantId,
        campaignId: input.campaignId,
        unitId: input.unitId,
        episodeId,
      });
      if (head === null) return null;
      const bytes = await input.artifactStore.read(head.envelopeStorageKey);
      if (bytes === null || digest(bytes) !== head.envelopeDigest) {
        throw new Error("transformer_attempt_checkpoint_envelope_artifact_mismatch");
      }
      const envelope = decodeEnvelope(bytes);
      if (envelope.episodeId !== episodeId || envelope.stateDigest !== head.stateDigest ||
          envelope.generation !== head.generation ||
          envelope.writerLeaseGeneration !== head.writerLeaseGeneration ||
          envelope.writerLeaseTokenDigest !== head.writerLeaseTokenDigest) {
        throw new Error("transformer_attempt_checkpoint_envelope_artifact_mismatch");
      }
      const state = openTransformerAttemptCheckpoint(envelope, encryptionKey, binding);
      await verifySourceAuthority(state);
      return Object.freeze(structuredClone(envelope));
    },
    async readLease(episodeId) {
      requireEpisode(episodeId);
      return readLease();
    },
    async readArtifact(storageKey) {
      requireStorageKey(storageKey);
      if (!storageKey.startsWith(artifactPrefix)) {
        throw new Error("transformer_attempt_checkpoint_artifact_scope_mismatch");
      }
      return input.artifactStore.read(storageKey);
    },
    async compareAndSwap(operation) {
      requireEpisode(operation.episodeId);
      const startedAt = trustedNow();
      timestamp(startedAt);
      const activeLease = await readLease(startedAt);
      if (activeLease === null || !sameLease(activeLease, operation.activeLease)) {
        throw new Error("transformer_attempt_checkpoint_lease_mismatch");
      }
      if (operation.next.episodeId !== episodeId ||
          operation.next.stateDigest.length === 0 || !DIGEST.test(operation.next.stateDigest) ||
          operation.next.writerLeaseGeneration !== activeLease.generation ||
          operation.next.writerLeaseTokenDigest !== activeLease.tokenDigest) {
        throw new Error("transformer_attempt_checkpoint_envelope_mismatch");
      }
      const opened = openTransformerAttemptCheckpoint(operation.next, encryptionKey, binding);
      if (opened.stage === "terminal") {
        throw new Error("transformer_attempt_checkpoint_terminal_atomic_required");
      }
      if (operation.expectedStateDigest === null &&
          opened.workspaceArtifact.filesDigest !== sourceDigest) {
        throw new Error("transformer_attempt_checkpoint_source_authority_mismatch");
      }
      const bytes = encodeEnvelope(operation.next);
      if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
        throw new Error("transformer_attempt_checkpoint_artifact_size_invalid");
      }
      const envelopeDigest = digest(bytes);
      const storageKey = transformerAttemptCheckpointEnvelopeStorageKey({
        tenantId: input.tenantId,
        campaignId: input.campaignId,
        unitId: input.unitId,
        episodeId,
        generation: operation.next.generation,
        envelopeDigest,
      });
      const expectedHead: TransformerAttemptCheckpointHead = Object.freeze({
        schemaVersion: 1,
        episodeId,
        stateDigest: operation.next.stateDigest,
        envelopeStorageKey: storageKey,
        envelopeDigest,
        generation: operation.next.generation,
        attemptNumber: activeLease.attemptNumber,
        writerLeaseGeneration: activeLease.generation,
        writerLeaseTokenDigest: activeLease.tokenDigest,
      });
      let headCommitted = false;
      try {
        await input.artifactStore.recordPending(storageKey);
        await input.artifactStore.publishImmutableDurable(storageKey, bytes);
      } catch (error) {
        await input.artifactStore.recordUnreferenced(storageKey);
        throw error;
      }
      try {
        const stored = await input.artifactStore.read(storageKey);
        if (stored === null || digest(stored) !== envelopeDigest) {
          throw new Error("transformer_attempt_checkpoint_envelope_artifact_mismatch");
        }
        const commitAt = trustedNow();
        if (timestamp(commitAt) < timestamp(startedAt)) {
          throw new Error("transformer_attempt_checkpoint_clock_regressed");
        }
        const committedHead = await input.authority.compareAndSwapHead({
          tenantId: input.tenantId,
          campaignId: input.campaignId,
          unitId: input.unitId,
          observedAt: commitAt,
          evidenceRefs,
          idempotencyKey: `tfcheckpoint_${envelopeDigest.slice("sha256:".length)}`,
          attemptNumber: activeLease.attemptNumber,
          leaseGeneration: activeLease.generation,
          leaseToken: input.leaseToken,
          expectedStateDigest: operation.expectedStateDigest,
          next: expectedHead,
          gateConfig: input.gateConfig,
        });
        if (!sameCheckpointHead(committedHead, expectedHead)) {
          throw new Error("transformer_attempt_checkpoint_head_authority_mismatch");
        }
        const authoritativeHead = await input.authority.readHead({
          tenantId: input.tenantId,
          campaignId: input.campaignId,
          unitId: input.unitId,
          episodeId,
        });
        if (authoritativeHead === null || !sameCheckpointHead(authoritativeHead, expectedHead)) {
          throw new Error("transformer_attempt_checkpoint_head_authority_mismatch");
        }
        headCommitted = true;
        await input.artifactStore.recordReferenced(storageKey);
        return true;
      } catch (error) {
        if (!headCommitted) {
          const authoritativeHead = await input.authority.readHead({
            tenantId: input.tenantId,
            campaignId: input.campaignId,
            unitId: input.unitId,
            episodeId,
          });
          if (authoritativeHead !== null && sameCheckpointHead(authoritativeHead, expectedHead)) {
            headCommitted = true;
            await input.artifactStore.recordReferenced(storageKey);
            return true;
          }
        }
        if (!headCommitted) await input.artifactStore.recordUnreferenced(storageKey);
        if (error instanceof Error && error.message === "transformer_pilot_checkpoint_head_conflict") {
          return false;
        }
        throw error;
      }
    },
  });
}

export async function finalizeTransformerPilotAttemptCheckpoint(
  input: TransformerPilotCheckpointTerminalFinalizeInput,
): Promise<TransformerPilotCheckpointTerminalFinalizeResult> {
  const completionIntent = openTransformerAttemptCompletionPayload(
    createTransformerAttemptCompletionPayload(input.completionIntent),
  );
  const completionDigest = createTransformerAttemptCompletionDigest(completionIntent);
  const requestDigest = createTransformerCoordinatorCompletionRequestDigest(
    completionIntent.episodeId,
    input.candidateSeal,
    completionIntent,
    input.artifactRegistration,
  );
  const identity = createTransformerAttemptEffectIdentity(
    completionIntent.episodeId,
    "coordinator_complete",
    createTransformerCoordinatorCompletionSlot(completionDigest),
    requestDigest,
  );
  const journal = await createTransformerPilotCheckpointJournal(input);
  const complete = async (checkpointHead: TransformerAttemptCheckpointHead) => {
    const completionInput = Object.freeze({
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      observedAt: completionIntent.observedAt,
      evidenceRefs: completionIntent.evidenceRefs,
      idempotencyKey: identity.idempotencyKey,
      leaseToken: input.leaseToken,
      expectedStateDigest: input.expectedStateDigest,
      nextCheckpointHead: checkpointHead,
      candidateSeal: input.candidateSeal,
      completionIntent,
      ...(input.artifactRegistration === undefined
        ? {}
        : { artifactRegistration: input.artifactRegistration }),
      ...(input.gateConfig === undefined ? {} : { gateConfig: input.gateConfig }),
    });
    try {
      return await input.authority.completeWithHead(completionInput);
    } catch {
      return await input.authority.completeWithHead(completionInput);
    }
  };
  const validateReceipt = (
    receipt: TransformerAttemptCheckpointCompletionReceipt,
    checkpointHead: TransformerAttemptCheckpointHead,
  ): void => {
    if (receipt.schemaVersion !== 1 ||
        receipt.tenantId !== input.tenantId || receipt.campaignId !== input.campaignId ||
        receipt.unitId !== input.unitId || receipt.episodeId !== completionIntent.episodeId ||
        receipt.completionDigest !== completionDigest ||
        receipt.observedAt !== completionIntent.observedAt ||
        !Number.isSafeInteger(receipt.campaignRevision) || receipt.campaignRevision < 1 ||
        !sameCheckpointHead(receipt.checkpointHead, checkpointHead)) {
      throw new Error("transformer_attempt_checkpoint_completion_receipt_invalid");
    }
  };
  const reconcileTerminal = async (): Promise<Readonly<{
    result: TransformerPilotCheckpointTerminalFinalizeResult;
    resultStorageKey: string;
  }> | null> => {
    const currentHead = await input.authority.readHead({
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      unitId: input.unitId,
      episodeId: completionIntent.episodeId,
    });
    if (currentHead === null || currentHead.stateDigest === input.expectedStateDigest) return null;
    const envelope = await journal.read(completionIntent.episodeId);
    if (envelope === null || envelope.stateDigest !== currentHead.stateDigest) {
      throw new Error("transformer_attempt_checkpoint_head_conflict");
    }
    const terminal = openTransformerAttemptCheckpoint(envelope, input.encryptionKey, input.binding);
    if (terminal.stage !== "terminal" || terminal.pendingEffect.kind !== "none") {
      throw new Error("transformer_attempt_checkpoint_head_conflict");
    }
    const receipts = terminal.completedEffects.filter((entry) =>
      entry.kind === "coordinator_complete" && entry.effectId === identity.effectId
    );
    if (receipts.length !== 1) {
      throw new Error("transformer_attempt_checkpoint_completion_receipt_invalid");
    }
    const effect = receipts[0]!;
    if (effect.slot !== createTransformerCoordinatorCompletionSlot(completionDigest) ||
        effect.idempotencyKey !== identity.idempotencyKey ||
        effect.requestDigest !== requestDigest) {
      throw new Error("transformer_attempt_checkpoint_completion_receipt_invalid");
    }
    const requestBytes = await journal.readArtifact(effect.requestArtifact.storageKey);
    const resultBytes = await journal.readArtifact(effect.resultArtifact.storageKey);
    if (requestBytes === null || resultBytes === null) {
      throw new Error("transformer_attempt_checkpoint_artifact_missing");
    }
    const requestPayload = verifyTransformerEffectRequestArtifact(
      effect.requestArtifact,
      requestBytes,
      input.encryptionKey,
      {
        tenantId: input.tenantId,
        episodeId: completionIntent.episodeId,
        effectId: identity.effectId,
      },
    );
    const request = openTransformerCoordinatorCompletionRequest(requestPayload);
    if (request.completionDigest !== completionDigest ||
        createTransformerAttemptCompletionDigest(request.completionIntent) !== completionDigest ||
        request.seal.sealDigest !== input.candidateSeal.sealDigest ||
        request.seal.workspaceManifestDigest !== input.candidateSeal.workspaceManifestDigest ||
        request.seal.workspacePayloadDigest !== input.candidateSeal.workspacePayloadDigest) {
      throw new Error("transformer_attempt_checkpoint_completion_receipt_invalid");
    }
    const accepted = openTransformerCoordinatorEffectResultArtifact(
      effect.resultArtifact,
      resultBytes,
      input.encryptionKey,
      {
        tenantId: input.tenantId,
        episodeId: completionIntent.episodeId,
        effectId: identity.effectId,
      },
    );
    if (accepted.status !== "accepted" || accepted.completionDigest !== completionDigest) {
      throw new Error("transformer_attempt_checkpoint_coordinator_result_invalid");
    }
    const completed = await complete(currentHead);
    validateReceipt(completed.receipt, currentHead);
    await input.artifactStore.recordReferenced(currentHead.envelopeStorageKey);
    await input.artifactStore.recordReferenced(effect.resultArtifact.storageKey);
    return Object.freeze({
      result: Object.freeze({
        envelope: Object.freeze(structuredClone(envelope)),
        receipt: Object.freeze(structuredClone(completed.receipt)),
      }),
      resultStorageKey: effect.resultArtifact.storageKey,
    });
  };

  const existing = await reconcileTerminal();
  if (existing !== null) return existing.result;

  const result = openTransformerCoordinatorEffectResultArtifact(
    input.resultArtifact,
    input.resultBytes,
    input.encryptionKey,
    {
      tenantId: input.tenantId,
      episodeId: completionIntent.episodeId,
      effectId: identity.effectId,
    },
  );
  if (result.status !== "accepted" || result.completionDigest !== completionDigest) {
    throw new Error("transformer_attempt_checkpoint_coordinator_result_invalid");
  }
  requireStorageKey(input.resultArtifact.storageKey);
  const resultStoragePrefix = `transformer/${input.tenantId}/${completionIntent.episodeId}` +
    `/effects/results/${identity.effectId}/`;
  if (!input.resultArtifact.storageKey.startsWith(resultStoragePrefix)) {
    throw new Error("transformer_attempt_checkpoint_artifact_scope_mismatch");
  }
  let resultPublicationAttempted = false;
  let envelopePublicationAttempted = false;
  let envelopeStorageKey = "";
  try {
    resultPublicationAttempted = true;
    await input.artifactStore.recordPending(input.resultArtifact.storageKey);
    await publishAndVerify(
      input.artifactStore,
      input.resultArtifact.storageKey,
      input.resultBytes,
      input.resultArtifact.ciphertextDigest,
      "transformer_attempt_checkpoint_result_artifact_mismatch",
    );
    const prepared = await prepareTransformerAttemptCheckpointTerminalAdvance(
      journal,
      input.expectedStateDigest,
      input.resultArtifact,
      completionIntent.observedAt,
      input.encryptionKey,
      input.binding,
    );
    if (prepared.kind !== "advance") {
      throw new Error("transformer_attempt_checkpoint_terminal_invalid");
    }
    const terminal = openTransformerAttemptCheckpoint(
      prepared.operation.next,
      input.encryptionKey,
      input.binding,
    );
    if (terminal.stage !== "terminal" || terminal.episodeId !== completionIntent.episodeId) {
      throw new Error("transformer_attempt_checkpoint_terminal_invalid");
    }
    const envelopeBytes = encodeEnvelope(prepared.operation.next);
    if (envelopeBytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error("transformer_attempt_checkpoint_artifact_size_invalid");
    }
    const envelopeDigest = digest(envelopeBytes);
    envelopeStorageKey = transformerAttemptCheckpointEnvelopeStorageKey({
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      unitId: input.unitId,
      episodeId: completionIntent.episodeId,
      generation: prepared.operation.next.generation,
      envelopeDigest,
    });
    envelopePublicationAttempted = true;
    await input.artifactStore.recordPending(envelopeStorageKey);
    await publishAndVerify(
      input.artifactStore,
      envelopeStorageKey,
      envelopeBytes,
      envelopeDigest,
      "transformer_attempt_checkpoint_envelope_artifact_mismatch",
    );
    const checkpointHead: TransformerAttemptCheckpointHead = Object.freeze({
      schemaVersion: 1,
      episodeId: completionIntent.episodeId,
      stateDigest: prepared.operation.next.stateDigest,
      envelopeStorageKey,
      envelopeDigest,
      generation: prepared.operation.next.generation,
      attemptNumber: prepared.operation.activeLease.attemptNumber,
      writerLeaseGeneration: prepared.operation.activeLease.generation,
      writerLeaseTokenDigest: prepared.operation.activeLease.tokenDigest,
    });
    const completed = await complete(checkpointHead);
    validateReceipt(completed.receipt, checkpointHead);
    await input.artifactStore.recordReferenced(envelopeStorageKey);
    await input.artifactStore.recordReferenced(input.resultArtifact.storageKey);
    return Object.freeze({
      envelope: Object.freeze(structuredClone(prepared.operation.next)),
      receipt: Object.freeze(structuredClone(completed.receipt)),
    });
  } catch (error) {
    const reconciled = await reconcileTerminal();
    if (reconciled !== null) {
      if (envelopePublicationAttempted &&
          envelopeStorageKey !== reconciled.result.receipt.checkpointHead.envelopeStorageKey) {
        await input.artifactStore.recordUnreferenced(envelopeStorageKey);
      }
      if (resultPublicationAttempted &&
          input.resultArtifact.storageKey !== reconciled.resultStorageKey) {
        await input.artifactStore.recordUnreferenced(input.resultArtifact.storageKey);
      }
      return reconciled.result;
    }
    if (envelopePublicationAttempted) {
      await input.artifactStore.recordUnreferenced(envelopeStorageKey);
    }
    if (resultPublicationAttempted) {
      await input.artifactStore.recordUnreferenced(input.resultArtifact.storageKey);
    }
    throw error;
  }
}
