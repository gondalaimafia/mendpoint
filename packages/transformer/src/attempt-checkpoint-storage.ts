import { createHash } from "node:crypto";
import type {
  TransformerAttemptCheckpointBinding,
  TransformerAttemptCheckpointEnvelope,
  TransformerAttemptCheckpointJournal,
  TransformerAttemptCheckpointLease,
} from "./attempt-checkpoint.js";
import {
  createTransformerEpisodeId,
  openTransformerAttemptCheckpoint,
} from "./attempt-checkpoint.js";
import {
  transformerAttemptCheckpointEnvelopeStorageKey,
  TransformerPilotExecutionStore,
} from "./pilot-execution.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const STORAGE_KEY = /^(?![A-Za-z]:)(?![\/])(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,1000}$/;
const MAX_ARTIFACT_BYTES = 80 * 1024 * 1024;

export type TransformerAttemptCheckpointArtifactStore = Readonly<{
  read(storageKey: string): Promise<Uint8Array | null>;
  publishImmutableDurable(storageKey: string, bytes: Uint8Array): Promise<void>;
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
      try {
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
        return true;
      } catch (error) {
        await input.artifactStore.recordUnreferenced(storageKey);
        if (error instanceof Error && error.message === "transformer_pilot_checkpoint_head_conflict") {
          return false;
        }
        throw error;
      }
    },
  });
}
