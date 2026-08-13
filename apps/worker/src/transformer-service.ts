import { createHash } from "node:crypto";
import type { TransformerCheckpointProvider } from "./transformer-checkpoint-provider.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export type DeterministicTransformerTaskBase = Readonly<{
  tenantId: string;
  campaignId: string;
  episodeId: string;
  operation: string;
  source: Readonly<{ storageKey: string; digest: string }>;
}>;
export type DeterministicTransformerTask = DeterministicTransformerTaskBase & Readonly<{ requestDigest: string }>;
export type DeterministicTransformerExecutor = (source: Uint8Array, task: DeterministicTransformerTask) => Promise<Uint8Array>;
export type DeterministicTransformerResult = Readonly<{
  status: "completed";
  tenantId: string;
  campaignId: string;
  episodeId: string;
  requestDigest: string;
  operation: string;
  sourceDigest: string;
  resultArtifact: Readonly<{ storageKey: string; digest: string }>;
  workerId: string;
  leaseGeneration: number;
  replayed: boolean;
}>;

export type DeterministicTransformerService = Readonly<{
  mode: "checkpoint_required";
  run(task: DeterministicTransformerTask, signal?: AbortSignal): Promise<DeterministicTransformerResult>;
}>;

export function transformerTaskRequestDigest(task: DeterministicTransformerTaskBase): string {
  validateBase(task);
  return sha256(canonical(task));
}

export function createDeterministicTransformerService(
  config: Readonly<{ enabled: boolean; mode: "checkpoint_required"; workerId: string; leaseDurationMs: number }>,
  provider: TransformerCheckpointProvider,
  executor: DeterministicTransformerExecutor,
): DeterministicTransformerService {
  if (!config || typeof config !== "object" || Object.keys(config).sort().join(",") !== "enabled,leaseDurationMs,mode,workerId") throw new Error("transformer_service_config_invalid");
  if (config.enabled !== true) throw new Error("transformer_service_disabled");
  if (config.mode !== "checkpoint_required") throw new Error("transformer_service_mode_invalid");
  if (!ID.test(config.workerId) || !Number.isSafeInteger(config.leaseDurationMs) || config.leaseDurationMs < 1_000 || config.leaseDurationMs > 3_600_000 || !provider || provider.mode !== "checkpoint_required" || typeof executor !== "function") throw new Error("transformer_service_config_invalid");
  const workerId = config.workerId;
  const leaseDurationMs = config.leaseDurationMs;
  const coordinator = provider.coordinator;
  const artifacts = provider.artifacts;
  const execute = executor.bind(undefined);
  let sequence = 0;

  return Object.freeze({
    mode: "checkpoint_required" as const,
    async run(task, signal) {
      validateTask(task);
      const scope = { tenantId: task.tenantId, campaignId: task.campaignId, episodeId: task.episodeId, requestDigest: task.requestDigest, signal };
      const existing = await coordinator.readCheckpoint(scope);
      if (existing) return resultFromCheckpoint(existing.checkpoint, task, true);
      sequence += 1;
      const suffix = sha256(`${workerId}:${task.requestDigest}:${sequence}`).slice(7, 31);
      const lease = await coordinator.claimCheckpointLease({ ...scope, operationId: `claim-${suffix}`, idempotencyKey: `claim-${suffix}`, leaseDurationMs });
      const source = await artifacts.read({ tenantId: task.tenantId, storageKey: task.source.storageKey });
      if (!source || sha256(source) !== task.source.digest) throw new Error("transformer_service_source_materialization_failed");
      const immutableSource = new Uint8Array(source);
      const output = await execute(immutableSource, Object.freeze({ ...task, source: Object.freeze({ ...task.source }) }));
      if (!(output instanceof Uint8Array)) throw new Error("transformer_service_executor_output_invalid");
      const outputBytes = new Uint8Array(output);
      const resultArtifact = await artifacts.publishImmutable({
        tenantId: task.tenantId,
        artifactKey: `results/${task.campaignId}/${task.episodeId}/${task.requestDigest.slice(7)}`,
        bytes: outputBytes,
      });
      await artifacts.recordPending({ tenantId: task.tenantId, storageKey: resultArtifact.storageKey });
      const checkpoint = {
        schemaVersion: 1,
        status: "completed",
        tenantId: task.tenantId,
        campaignId: task.campaignId,
        episodeId: task.episodeId,
        requestDigest: task.requestDigest,
        operation: task.operation,
        source: { storageKey: task.source.storageKey, digest: task.source.digest },
        resultArtifact: { storageKey: resultArtifact.storageKey, digest: resultArtifact.digest },
        workerId,
        leaseGeneration: lease.leaseGeneration,
      } as const;
      const checkpointDigest = sha256(canonical(checkpoint));
      try {
        await coordinator.compareAndSwapCheckpoint({
          ...scope,
          operationId: `complete-${suffix}`,
          idempotencyKey: `complete-${suffix}`,
          expectedCheckpointDigest: null,
          checkpointDigest,
          leaseGeneration: lease.leaseGeneration,
          nextCheckpoint: checkpoint,
        });
        await artifacts.recordReferenced({ tenantId: task.tenantId, storageKey: resultArtifact.storageKey });
      } catch (error) {
        await artifacts.recordUnreferenced({ tenantId: task.tenantId, storageKey: resultArtifact.storageKey }).catch(() => undefined);
        throw error;
      }
      return resultFromCheckpoint(checkpoint, task, false);
    },
  });
}

function resultFromCheckpoint(value: unknown, task: DeterministicTransformerTask, replayed: boolean): DeterministicTransformerResult {
  const checkpoint = value as Record<string, unknown>;
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint) || checkpoint.schemaVersion !== 1 || checkpoint.status !== "completed" || checkpoint.tenantId !== task.tenantId || checkpoint.campaignId !== task.campaignId || checkpoint.episodeId !== task.episodeId || checkpoint.requestDigest !== task.requestDigest || checkpoint.operation !== task.operation || !ID.test(String(checkpoint.workerId)) || !Number.isSafeInteger(checkpoint.leaseGeneration) || Number(checkpoint.leaseGeneration) < 1) throw new Error("transformer_service_checkpoint_invalid");
  const source = checkpoint.source as Record<string, unknown>;
  const result = checkpoint.resultArtifact as Record<string, unknown>;
  if (!source || source.storageKey !== task.source.storageKey || source.digest !== task.source.digest || !result || typeof result.storageKey !== "string" || !DIGEST.test(String(result.digest))) throw new Error("transformer_service_checkpoint_invalid");
  return Object.freeze({ status: "completed", tenantId: task.tenantId, campaignId: task.campaignId, episodeId: task.episodeId, requestDigest: task.requestDigest, operation: task.operation, sourceDigest: task.source.digest, resultArtifact: Object.freeze({ storageKey: result.storageKey, digest: String(result.digest) }), workerId: String(checkpoint.workerId), leaseGeneration: Number(checkpoint.leaseGeneration), replayed });
}
function validateTask(task: DeterministicTransformerTask): void {
  validateBase(task);
  const base = { tenantId: task.tenantId, campaignId: task.campaignId, episodeId: task.episodeId, operation: task.operation, source: task.source };
  if (task.requestDigest !== transformerTaskRequestDigest(base)) throw new Error("transformer_service_request_binding_invalid");
}
function validateBase(task: DeterministicTransformerTaskBase): void { if (!task || typeof task !== "object" || !ID.test(task.tenantId) || !ID.test(task.campaignId) || !ID.test(task.episodeId) || !ID.test(task.operation) || !task.source || typeof task.source.storageKey !== "string" || !DIGEST.test(task.source.digest)) throw new Error("transformer_service_task_invalid"); }
function sha256(value: string | Uint8Array): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("transformer_service_task_invalid"); return JSON.stringify(value); }
  if (!value || typeof value !== "object") throw new Error("transformer_service_task_invalid");
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
