import { createHash } from "node:crypto";
import type {
  TransformerAttemptCheckpointBinding,
  TransformerAttemptCheckpointEnvelope,
  TransformerAttemptCheckpointJournal,
  TransformerAttemptCheckpointLease,
  TransformerCandidateSeal,
  TransformerEncryptedArtifact,
} from "./attempt-checkpoint.js";
import {
  createTransformerAttemptEffectIdentity,
  createTransformerCoordinatorCompletionRequestDigest,
  createTransformerCoordinatorCompletionSlot,
  createTransformerEpisodeId,
  openTransformerCoordinatorCompletionRequest,
  openTransformerCoordinatorEffectResultArtifact,
  openTransformerAttemptCheckpoint,
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
  type TransformerAttemptCheckpointCompletionReceipt,
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

export type TransformerPilotCheckpointJournalInput = Readonly<{
  pilotStore: TransformerPilotExecutionStore;
  artifactStore: TransformerAttemptCheckpointArtifactStore;
  tenantId: string;
  campaignId: string;
  unitId: string;
  binding: TransformerAttemptCheckpointBinding;
  encryptionKey: Uint8Array;
  leaseToken: string;
  evidenceRefs: readonly string[];
  gateConfig?: string;
}>;

export type TransformerPilotCheckpointTerminalFinalizeInput =
  TransformerPilotCheckpointJournalInput & Readonly<{
    expectedStateDigest: string;
    resultArtifact: TransformerEncryptedArtifact;
    resultBytes: Uint8Array;
    completionIntent: TransformerAttemptCompletionIntent;
    candidateSeal: TransformerCandidateSeal;
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

export function createTransformerPilotCheckpointJournal(
  input: TransformerPilotCheckpointJournalInput,
): TransformerAttemptCheckpointJournal {
  const binding = Object.freeze(structuredClone(input.binding));
  const evidenceRefs = Object.freeze([...input.evidenceRefs]);
  if (binding.tenantId !== input.tenantId ||
      binding.campaignId !== input.campaignId || binding.unitId !== input.unitId) {
    throw new Error("transformer_attempt_checkpoint_binding_mismatch");
  }
  const campaign = input.pilotStore.getCampaign(input.tenantId, input.campaignId);
  const unit = campaign?.units.find((candidate) => candidate.id === input.unitId);
  if (!campaign || !unit || campaign.environment !== binding.environment ||
      unit.snapshot.repositoryId !== binding.repositoryId ||
      unit.snapshot.snapshotId !== binding.snapshotId ||
      unit.snapshot.revision !== binding.sourceRevision ||
      unit.candidateRevision !== binding.candidateRevision ||
      unit.candidateDigest !== binding.candidateDigest ||
      unit.recipe.digest !== binding.recipeDigest ||
      campaign.constraintDigest !== binding.constraintDigest) {
    throw new Error("transformer_attempt_checkpoint_binding_authority_mismatch");
  }
  const sourceDigest = unit.snapshot.digest;
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
    input.pilotStore.readAttemptCheckpointLease({
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      unitId: input.unitId,
      episodeId,
      observedAt,
    });

  return Object.freeze({
    async read(episodeId) {
      requireEpisode(episodeId);
      const head = input.pilotStore.readAttemptCheckpointHead({
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
      openTransformerAttemptCheckpoint(envelope, encryptionKey, binding);
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
        input.pilotStore.compareAndSwapAttemptCheckpointHead({
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
          next: {
            schemaVersion: 1,
            episodeId,
            stateDigest: operation.next.stateDigest,
            envelopeStorageKey: storageKey,
            envelopeDigest,
            generation: operation.next.generation,
            attemptNumber: activeLease.attemptNumber,
            writerLeaseGeneration: activeLease.generation,
            writerLeaseTokenDigest: activeLease.tokenDigest,
          },
          gateConfig: input.gateConfig,
        });
        headCommitted = true;
        await input.artifactStore.recordReferenced(storageKey);
        return true;
      } catch (error) {
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
  );
  const identity = createTransformerAttemptEffectIdentity(
    completionIntent.episodeId,
    "coordinator_complete",
    createTransformerCoordinatorCompletionSlot(completionDigest),
    requestDigest,
  );
  const journal = createTransformerPilotCheckpointJournal(input);
  const complete = (checkpointHead: TransformerAttemptCheckpointHead) => {
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
      ...(input.gateConfig === undefined ? {} : { gateConfig: input.gateConfig }),
    });
    try {
      return input.pilotStore.completeAttemptWithCheckpointHead(completionInput);
    } catch {
      return input.pilotStore.completeAttemptWithCheckpointHead(completionInput);
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
    const currentHead = input.pilotStore.readAttemptCheckpointHead({
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
    const completed = complete(currentHead);
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
    const completed = complete(checkpointHead);
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
