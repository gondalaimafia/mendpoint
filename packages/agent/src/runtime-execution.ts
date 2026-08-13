import { createHash } from "node:crypto";
import {
  commitWardenCheckpoint,
  openWardenRuntimeState,
  type WardenCheckpointBinding,
  type WardenCheckpointEnvelope,
  type WardenCheckpointJournal,
} from "./checkpoint.js";
import {
  decodeWardenRuntimeState,
  encodeWardenRuntimeState,
  projectWardenCheckpointPayload,
  type WardenPrivateRuntimeStateV1,
  type WardenRuntimeJson,
} from "./runtime-state.js";
import { validatedToolCall } from "./agent.js";

// Model effects use the runtime state's authenticated call and accounting
// binding so a paid planner result can be durable before its tool executes.
type EffectKind = "model" | "tool" | "verifier" | "artifact";

export type WardenRuntimeEffectInput<T extends WardenRuntimeJson> = Readonly<{
  kind: EffectKind;
  slot: string;
  request: WardenRuntimeJson;
  executor: WardenRuntimeIdempotentEffectExecutor<T>;
  validateResult: (value: WardenRuntimeJson) => T;
  apply: (
    state: WardenPrivateRuntimeStateV1,
    result: T,
    context: WardenRuntimeEffectContext,
  ) => WardenPrivateRuntimeStateV1;
}>;

export type WardenRuntimeEffectContext = Readonly<{
  effectId: string;
  requestDigest: string;
  resultDigest: string;
}>;

export type WardenRuntimeEffectOutcome<T extends WardenRuntimeJson> = Readonly<{
  value: T;
  replayed: boolean;
  effectId: string;
  requestDigest: string;
  resultDigest: string;
}>;

export type WardenRuntimeEffectReconciliation<T extends WardenRuntimeJson> =
  | Readonly<{ status: "completed"; value: T }>
  | Readonly<{ status: "not_started" }>
  | Readonly<{ status: "unknown" }>;

export type WardenRuntimeIdempotentEffectExecutor<T extends WardenRuntimeJson> = Readonly<{
  reconcile: (input: Readonly<{
    effectId: string;
    requestDigest: string;
    signal: AbortSignal;
  }>) => Promise<WardenRuntimeEffectReconciliation<T>>;
  /**
   * This is a trusted infrastructure boundary. Implementations must deduplicate
   * by effectId and enforce assertFence immediately before the external commit.
   */
  executeIdempotent: (input: Readonly<{
    effectId: string;
    requestDigest: string;
    writerLeaseGeneration: number;
    signal: AbortSignal;
    assertFence: () => Promise<void>;
  }>) => Promise<T>;
}>;

export type WardenRuntimeExecution = Readonly<{
  state: () => WardenPrivateRuntimeStateV1;
  effectRequest: (kind: EffectKind, slot: string) => WardenRuntimeJson | null;
  assertCurrent: () => Promise<void>;
  runEffect: <T extends WardenRuntimeJson>(
    input: WardenRuntimeEffectInput<T>,
  ) => Promise<WardenRuntimeEffectOutcome<T>>;
}>;

export type OpenWardenRuntimeExecutionInput = Readonly<{
  binding: WardenCheckpointBinding;
  journal: WardenCheckpointJournal;
  key: Uint8Array;
  executorDigest: string;
  writerLeaseGeneration: number;
  operationTimeoutMs?: number;
  signal?: AbortSignal;
  genesis?: WardenPrivateRuntimeStateV1;
  now?: () => string;
}>;

async function boundedOperation<T>(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  if (parentSignal?.aborted) {
    controller.abort(parentSignal.reason);
    throw new Error("warden_runtime_effect_aborted");
  }
  let rejectParentAbort: ((error: Error) => void) | undefined;
  const parentAbort = new Promise<never>((_resolve, reject) => {
    rejectParentAbort = reject;
  });
  const abortFromParent = (): void => {
    controller.abort(parentSignal?.reason);
    rejectParentAbort?.(new Error("warden_runtime_effect_aborted"));
  };
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      parentAbort,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error("warden_runtime_effect_timeout"));
          reject(new Error("warden_runtime_effect_timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function canonical(value: WardenRuntimeJson): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("warden_runtime_effect_json_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("warden_runtime_effect_json_invalid");
  }
  const record = value as Readonly<Record<string, WardenRuntimeJson>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key]!)}`
  ).join(",")}}`;
}

function deepFreezeJson<T extends WardenRuntimeJson>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      deepFreezeJson(child as WardenRuntimeJson);
    }
    Object.freeze(value);
  }
  return value;
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exactBinding(left: WardenCheckpointBinding, right: WardenCheckpointBinding): boolean {
  return canonical(left as unknown as WardenRuntimeJson) ===
    canonical(right as unknown as WardenRuntimeJson);
}

function effectIdentity(
  binding: WardenCheckpointBinding,
  kind: EffectKind,
  slot: string,
): string {
  if (typeof slot !== "string" || !slot.trim() || slot.length > 200) {
    throw new Error("warden_runtime_effect_slot_invalid");
  }
  return sha256(canonical({
    schemaVersion: 1,
    binding: binding as unknown as WardenRuntimeJson,
    kind,
    slot,
  }));
}

function resultBytes(value: WardenRuntimeJson): Uint8Array {
  return Buffer.from(canonical(value), "utf8");
}

function validateReconciliation<T extends WardenRuntimeJson>(
  value: WardenRuntimeEffectReconciliation<T>,
): WardenRuntimeEffectReconciliation<T> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("warden_runtime_effect_reconciliation_invalid");
  }
  const record = value as unknown as Readonly<Record<string, WardenRuntimeJson>>;
  if (record.status === "completed") {
    if (Object.keys(record).sort().join(",") !== "status,value") {
      throw new Error("warden_runtime_effect_reconciliation_invalid");
    }
    canonical(record.value!);
    return value;
  }
  if ((record.status === "not_started" || record.status === "unknown") &&
      Object.keys(record).join(",") === "status") {
    return value;
  }
  throw new Error("warden_runtime_effect_reconciliation_invalid");
}

function modelReceiptFields(value: WardenRuntimeJson): Readonly<{
  plannedCallDigest: string;
  modelAccounting: WardenPrivateRuntimeStateV1["modelCalls"][number];
}> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("warden_runtime_effect_model_result_invalid");
  }
  const result = value as Readonly<Record<string, WardenRuntimeJson>>;
  const keys = Object.keys(result).sort().join(",");
  if ((keys !== "accounting,call" && keys !== "accounting,call,telemetry") ||
      !result.call || Array.isArray(result.call) || typeof result.call !== "object" ||
      !result.accounting || Array.isArray(result.accounting) || typeof result.accounting !== "object") {
    throw new Error("warden_runtime_effect_model_result_invalid");
  }
  const call = validatedToolCall(result.call);
  const accounting = result.accounting as unknown as Record<string, unknown>;
  if (!call || canonical(call as unknown as WardenRuntimeJson) !== canonical(result.call) ||
      Object.keys(accounting).sort().join(",") !==
        "completionTokens,costUsd,promptTokens,status,totalTokens" ||
      accounting.status !== "succeeded" ||
      !Number.isSafeInteger(accounting.promptTokens) || (accounting.promptTokens as number) < 0 ||
      !Number.isSafeInteger(accounting.completionTokens) ||
        (accounting.completionTokens as number) < 0 ||
      !Number.isSafeInteger(accounting.totalTokens) ||
      accounting.totalTokens !==
        (accounting.promptTokens as number) + (accounting.completionTokens as number) ||
      typeof accounting.costUsd !== "number" || !Number.isFinite(accounting.costUsd) ||
      accounting.costUsd < 0) {
    throw new Error("warden_runtime_effect_model_result_invalid");
  }
  if (result.telemetry !== undefined) {
    const telemetry = result.telemetry as unknown as Record<string, unknown>;
    if (!telemetry || Array.isArray(telemetry) ||
        Object.keys(telemetry).sort().join(",") !== "provenance,responseBytes" ||
        !Number.isSafeInteger(telemetry.responseBytes) || (telemetry.responseBytes as number) < 0 ||
        !Array.isArray(telemetry.provenance)) {
      throw new Error("warden_runtime_effect_model_result_invalid");
    }
  }
  return {
    plannedCallDigest: sha256(canonical(call as unknown as WardenRuntimeJson)),
    modelAccounting: result.accounting as WardenPrivateRuntimeStateV1["modelCalls"][number],
  };
}

function decodeResult<T extends WardenRuntimeJson>(
  state: WardenPrivateRuntimeStateV1,
  resultDigest: string,
  validate: (value: WardenRuntimeJson) => T,
): T {
  const blob = state.blobs.find((candidate) => candidate.digest === resultDigest);
  if (!blob) throw new Error("warden_runtime_effect_result_missing");
  const bytes = Buffer.from(blob.contentBase64, "base64");
  if (bytes.byteLength !== blob.bytes || sha256(bytes) !== resultDigest) {
    throw new Error("warden_runtime_effect_result_invalid");
  }
  let parsed: WardenRuntimeJson;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as WardenRuntimeJson;
  } catch {
    throw new Error("warden_runtime_effect_result_invalid");
  }
  if (canonical(parsed) !== bytes.toString("utf8")) {
    throw new Error("warden_runtime_effect_result_invalid");
  }
  const authenticatedCanonical = canonical(parsed);
  const validated = validate(parsed);
  if (canonical(validated) !== authenticatedCanonical) {
    throw new Error("warden_runtime_effect_result_invalid");
  }
  return deepFreezeJson(JSON.parse(authenticatedCanonical) as T);
}

function withResultBlob(
  state: WardenPrivateRuntimeStateV1,
  value: WardenRuntimeJson,
): Readonly<{ state: WardenPrivateRuntimeStateV1; digest: string }> {
  const bytes = resultBytes(value);
  const digest = sha256(bytes);
  const existing = state.blobs.find((blob) => blob.digest === digest);
  if (existing) {
    if (existing.bytes !== bytes.byteLength ||
        existing.contentBase64 !== Buffer.from(bytes).toString("base64")) {
      throw new Error("warden_runtime_effect_result_invalid");
    }
    return { state, digest };
  }
  return {
    state: {
      ...state,
      blobs: [...state.blobs, {
        digest,
        bytes: bytes.byteLength,
        contentBase64: Buffer.from(bytes).toString("base64"),
      }],
    },
    digest,
  };
}

function openRecordState(
  record: Awaited<ReturnType<WardenCheckpointJournal["read"]>>,
  key: Uint8Array,
  binding: WardenCheckpointBinding,
): Readonly<{ envelope: WardenCheckpointEnvelope; state: WardenPrivateRuntimeStateV1 }> {
  if (!record.envelope || !record.sealedRuntimeState) {
    throw new Error("warden_runtime_effect_checkpoint_missing");
  }
  const bytes = openWardenRuntimeState(
    record.sealedRuntimeState,
    record.envelope,
    key,
    binding,
    record.envelope.payload.writerLeaseGeneration,
  );
  return {
    envelope: record.envelope,
    state: decodeWardenRuntimeState(bytes, binding),
  };
}

export async function openWardenRuntimeExecution(
  input: OpenWardenRuntimeExecutionInput,
): Promise<WardenRuntimeExecution> {
  if (!Number.isSafeInteger(input.writerLeaseGeneration) || input.writerLeaseGeneration < 1) {
    throw new Error("warden_runtime_effect_lease_invalid");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.executorDigest)) {
    throw new Error("warden_runtime_effect_executor_invalid");
  }
  const operationTimeoutMs = input.operationTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 ||
      operationTimeoutMs > 300_000) {
    throw new Error("warden_runtime_effect_timeout_invalid");
  }
  const now = input.now ?? (() => new Date().toISOString());
  const journalOperation = async <T>(operation: () => Promise<T>): Promise<T> =>
    await boundedOperation(operationTimeoutMs, input.signal, async () => await operation());
  let record = await journalOperation(async () => await input.journal.read(input.binding));
  if (record.activeWriterLeaseGeneration !== input.writerLeaseGeneration) {
    throw new Error("warden_runtime_effect_lease_stale");
  }
  if (!record.envelope) {
    if (!input.genesis || !exactBinding(input.genesis.binding, input.binding) ||
        input.genesis.generation !== 1 || input.genesis.previousEnvelopeDigest !== null ||
        input.genesis.writerLeaseGeneration !== input.writerLeaseGeneration) {
      throw new Error("warden_runtime_effect_genesis_invalid");
    }
    const encoded = encodeWardenRuntimeState(input.genesis);
    if (input.genesis.executorDigest !== input.executorDigest) {
      throw new Error("warden_runtime_effect_executor_mismatch");
    }
    await journalOperation(async () => await commitWardenCheckpoint(
      input.journal,
      projectWardenCheckpointPayload(input.genesis!, input.key),
      encoded,
      input.key,
      input.binding,
    ));
    record = await journalOperation(async () => await input.journal.read(input.binding));
  }
  let opened = openRecordState(record, input.key, input.binding);
  let envelope = opened.envelope;
  let current = opened.state;
  if (current.writerLeaseGeneration > input.writerLeaseGeneration) {
    throw new Error("warden_runtime_effect_lease_stale");
  }
  if (current.executorDigest !== input.executorDigest) {
    throw new Error("warden_runtime_effect_executor_mismatch");
  }
  let active = false;

  async function readAuthoritative(): Promise<void> {
    const nextRecord = await journalOperation(async () => await input.journal.read(input.binding));
    if (nextRecord.activeWriterLeaseGeneration !== input.writerLeaseGeneration) {
      throw new Error("warden_runtime_effect_lease_stale");
    }
    opened = openRecordState(nextRecord, input.key, input.binding);
    envelope = opened.envelope;
    current = opened.state;
    if (current.writerLeaseGeneration > input.writerLeaseGeneration) {
      throw new Error("warden_runtime_effect_lease_stale");
    }
    if (current.executorDigest !== input.executorDigest) {
      throw new Error("warden_runtime_effect_executor_mismatch");
    }
  }

  async function assertFence(): Promise<void> {
    const nextRecord = await journalOperation(async () => await input.journal.read(input.binding));
    if (nextRecord.activeWriterLeaseGeneration !== input.writerLeaseGeneration) {
      throw new Error("warden_runtime_effect_lease_stale");
    }
    if (nextRecord.envelope?.payloadDigest !== envelope.payloadDigest) {
      throw new Error("warden_runtime_effect_head_conflict");
    }
  }

  async function commitState(
    update: (state: WardenPrivateRuntimeStateV1) => WardenPrivateRuntimeStateV1,
  ): Promise<void> {
    const expected = update(current);
    if (expected.phase !== current.phase) {
      throw new Error("warden_runtime_effect_phase_invalid");
    }
    const next: WardenPrivateRuntimeStateV1 = {
      ...expected,
      binding: current.binding,
      generation: current.generation + 1,
      writerLeaseGeneration: input.writerLeaseGeneration,
      workspaceName: current.workspaceName,
      previousEnvelopeDigest: envelope.payloadDigest,
      createdAt: now(),
    };
    const encoded = encodeWardenRuntimeState(next);
    try {
      await journalOperation(async () => await commitWardenCheckpoint(
        input.journal,
        projectWardenCheckpointPayload(next, input.key),
        encoded,
        input.key,
        input.binding,
      ));
    } catch (error) {
      const nextRecord = await journalOperation(async () => await input.journal.read(input.binding));
      if (nextRecord.activeWriterLeaseGeneration !== input.writerLeaseGeneration) {
        throw new Error("warden_runtime_effect_lease_stale");
      }
      if (!nextRecord.envelope || !nextRecord.sealedRuntimeState) {
        throw error;
      }
      const authoritative = openRecordState(nextRecord, input.key, input.binding);
      if (!Buffer.from(encodeWardenRuntimeState(authoritative.state)).equals(Buffer.from(encoded))) {
        throw error;
      }
    }
    await readAuthoritative();
  }

  async function runEffect<T extends WardenRuntimeJson>(
    effect: WardenRuntimeEffectInput<T>,
  ): Promise<WardenRuntimeEffectOutcome<T>> {
    if (active) throw new Error("warden_runtime_effect_concurrent");
    active = true;
    try {
      const requestDigest = sha256(canonical(effect.request));
      const effectId = effectIdentity(input.binding, effect.kind, effect.slot);
      let executedHere = false;
      let dispatchedHere = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        const receipt = current.effectReceipts.find((candidate) => candidate.effectId === effectId);
        if (receipt) {
          if (receipt.kind !== effect.kind || receipt.requestDigest !== requestDigest) {
            throw new Error("warden_runtime_effect_identity_conflict");
          }
          const value = decodeResult<T>(current, receipt.resultDigest, effect.validateResult);
          if (effect.kind === "model") modelReceiptFields(value);
          return {
            value,
            replayed: true,
            effectId,
            requestDigest,
            resultDigest: receipt.resultDigest,
          };
        }
        if (current.pendingEffect.kind === "none") {
          await commitState((state) => {
            const storedRequest = withResultBlob(state, effect.request);
            if (storedRequest.digest !== requestDigest) {
              throw new Error("warden_runtime_effect_request_invalid");
            }
            return {
              ...storedRequest.state,
              pendingEffect: {
                kind: effect.kind,
                state: "prepared",
                effectId,
                requestDigest,
              },
            };
          });
          continue;
        }
        const pending = current.pendingEffect;
        if (pending.effectId !== effectId || pending.kind !== effect.kind ||
            pending.requestDigest !== requestDigest) {
          throw new Error("warden_runtime_effect_pending_conflict");
        }
        if (pending.state === "prepared") {
          await assertFence();
          await commitState((state) => ({
            ...state,
            pendingEffect: { ...pending, state: "dispatched" },
          }));
          dispatchedHere = true;
          continue;
        }
        if (pending.state === "dispatched") {
          const reconciliation = dispatchedHere
            ? { status: "not_started" as const }
            : validateReconciliation(await boundedOperation(
              operationTimeoutMs,
              input.signal,
              async (signal) => await effect.executor.reconcile({ effectId, requestDigest, signal }),
            ));
          if (reconciliation.status === "unknown") {
            throw new Error("warden_runtime_effect_outcome_uncertain");
          }
          let value: T;
          if (reconciliation.status === "completed") {
            value = reconciliation.value;
          } else {
            await assertFence();
            value = await boundedOperation(
              operationTimeoutMs,
              input.signal,
              async (signal) => await effect.executor.executeIdempotent({
                effectId,
                requestDigest,
                writerLeaseGeneration: input.writerLeaseGeneration,
                signal,
                assertFence,
              }),
            );
            executedHere = true;
          }
          value = effect.validateResult(value);
          if (effect.kind === "model") modelReceiptFields(value);
          const stored = withResultBlob(current, value);
          await commitState(() => ({
            ...stored.state,
            pendingEffect: {
              ...pending,
              state: "completed",
              resultDigest: stored.digest,
            },
          }));
          continue;
        }
        const value = decodeResult<T>(current, pending.resultDigest!, effect.validateResult);
        const modelFields = effect.kind === "model" ? modelReceiptFields(value) : undefined;
        await commitState((state) => {
          const reducerState = decodeWardenRuntimeState(
            encodeWardenRuntimeState(state),
            input.binding,
          );
          const effectContext = Object.freeze({
            effectId,
            requestDigest,
            resultDigest: pending.resultDigest!,
          });
          const applied = effect.apply(reducerState, value, effectContext);
          const privateStateChanged = canonical(applied.privateState) !== canonical(state.privateState);
          const appendedHistory = applied.privateHistory.slice(state.privateHistory.length);
          const privateHistory = privateStateChanged &&
              canonical(appendedHistory[0] ?? null) !== canonical(state.privateState)
            ? [...state.privateHistory, state.privateState, ...appendedHistory]
            : applied.privateHistory;
          return {
            ...applied,
            privateHistory,
            effectReceipts: [...applied.effectReceipts, {
              kind: effect.kind,
              effectId,
              requestDigest,
              resultDigest: pending.resultDigest!,
              ...(modelFields ?? {}),
            }],
            pendingEffect: { kind: "none" },
          };
        });
        return {
          value,
          replayed: !executedHere,
          effectId,
          requestDigest,
          resultDigest: pending.resultDigest!,
        };
      }
      throw new Error("warden_runtime_effect_progress_exhausted");
    } finally {
      active = false;
    }
  }

  function effectRequest(kind: EffectKind, slot: string): WardenRuntimeJson | null {
    const effectId = effectIdentity(input.binding, kind, slot);
    const receipt = current.effectReceipts.find((candidate) => candidate.effectId === effectId);
    const pending = current.pendingEffect.kind !== "none" &&
        current.pendingEffect.effectId === effectId
      ? current.pendingEffect
      : null;
    const requestDigest = receipt?.requestDigest ?? pending?.requestDigest;
    if (!requestDigest) return null;
    return decodeResult(current, requestDigest, (value) => value);
  }

  return Object.freeze({
    state: () => decodeWardenRuntimeState(encodeWardenRuntimeState(current), input.binding),
    effectRequest,
    assertCurrent: assertFence,
    runEffect,
  });
}
