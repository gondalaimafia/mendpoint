import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  WardenCheckpointBinding,
  WardenCheckpointJournal,
  WardenCheckpointJournalRecord,
} from "./checkpoint.js";
import {
  createWardenRuntimeManifestDigest,
  type WardenPrivateRuntimeStateV1,
  type WardenRuntimeJson,
} from "./runtime-state.js";
import { openWardenRuntimeExecution } from "./runtime-execution.js";

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const source = Buffer.from("export const endpoint = '/v1/charges';\n", "utf8");
const sourceDigest = digest(source.toString("utf8"));
const sourceManifest = Object.freeze([{
  path: "src/client.ts",
  digest: sourceDigest,
  bytes: source.byteLength,
}]);
const binding: WardenCheckpointBinding = Object.freeze({
  schemaVersion: 1,
  tenantId: "tenant-a",
  jobId: "job-a",
  attemptId: "attempt-a",
  repositoryId: "repo-a",
  snapshotId: "snapshot-a",
  revision: "a".repeat(40),
  sourceManifestSha256: createWardenRuntimeManifestDigest(sourceManifest),
  allowedPathsDigest: digest("src/client.ts"),
  verificationProfileDigest: digest("npm test"),
  modelPolicyDigest: digest("model-policy"),
});
const key = Buffer.alloc(32, 9);
const executorDigest = digest("warden-runtime-executor-v1");

function locatorResult(value: unknown): Readonly<{ locator: string }> {
  if (!value || typeof value !== "object" ||
      typeof (value as { locator?: unknown }).locator !== "string") {
    throw new Error("locator_result_invalid");
  }
  return Object.freeze({ locator: (value as { locator: string }).locator });
}

function genesis(writerLeaseGeneration = 1): WardenPrivateRuntimeStateV1 {
  return {
    schemaVersion: 1,
    binding,
    generation: 1,
    writerLeaseGeneration,
    workspaceName: "attempt-a-private",
    phase: "agent_running",
    previousEnvelopeDigest: null,
    createdAt: "2026-08-11T18:00:00.000Z",
    executorDigest,
    sourceManifest,
    workspaceManifest: sourceManifest,
    events: [],
    sourceEvidence: [],
    observedDirectories: [],
    searches: [],
    modelCalls: [],
    sourceCounters: {
      observedBytes: 0,
      searchBytes: 0,
      changedBytes: 0,
      groundedMutations: 0,
      blockedMutations: 0,
    },
    privateState: { cursor: 0 },
    privateHistory: [],
    rollbackPreimages: [],
    blobs: [{
      digest: sourceDigest,
      bytes: source.byteLength,
      contentBase64: source.toString("base64"),
    }],
    effectReceipts: [],
    pendingEffect: { kind: "none" },
  };
}

type MemoryJournal = WardenCheckpointJournal & Readonly<{
  record: () => WardenCheckpointJournalRecord;
  setLease: (value: number) => void;
  failBeforeGeneration: (value: number | null) => void;
  loseResponseAfterGeneration: (value: number | null) => void;
}>;

function memoryJournal(activeWriterLeaseGeneration = 1): MemoryJournal {
  let record: WardenCheckpointJournalRecord = {
    envelope: null,
    sealedRuntimeState: null,
    activeWriterLeaseGeneration,
  };
  let failBefore: number | null = null;
  let loseAfter: number | null = null;
  return {
    async read() {
      return record;
    },
    async compareAndSwap(input) {
      const generation = input.nextEnvelope.payload.generation;
      if (generation === failBefore) {
        failBefore = null;
        throw new Error("storage_unavailable_before_commit");
      }
      if (record.activeWriterLeaseGeneration !== input.expectedActiveWriterLeaseGeneration ||
          record.envelope?.payloadDigest !== input.expectedPayloadDigest &&
          !(record.envelope === null && input.expectedPayloadDigest === null)) {
        return false;
      }
      record = {
        envelope: input.nextEnvelope,
        sealedRuntimeState: input.nextSealedRuntimeState,
        activeWriterLeaseGeneration: record.activeWriterLeaseGeneration,
      };
      if (generation === loseAfter) {
        loseAfter = null;
        throw new Error("storage_response_lost_after_commit");
      }
      return true;
    },
    record: () => record,
    setLease(value) {
      record = { ...record, activeWriterLeaseGeneration: value };
    },
    failBeforeGeneration(value) {
      failBefore = value;
    },
    loseResponseAfterGeneration(value) {
      loseAfter = value;
    },
  };
}

describe("Warden runtime effect execution", () => {
  it("resumes a durable external result without executing the effect twice", async () => {
    const journal = memoryJournal();
    const externalResults = new Map<string, Readonly<{ locator: string }>>();
    let executions = 0;
    const first = await openWardenRuntimeExecution({
      binding,
      journal,
      key,
      executorDigest,
      writerLeaseGeneration: 1,
      genesis: genesis(),
      now: () => "2026-08-11T18:00:01.000Z",
    });
    journal.failBeforeGeneration(3);

    await expect(first.runEffect({
      kind: "artifact",
      slot: "candidate-manifest",
      request: { path: "candidate-manifest.json" },
      executor: {
        reconcile: async ({ effectId }) => externalResults.get(effectId) ?? null,
        executeIdempotent: async ({ effectId, assertFence }) => {
          await assertFence();
          const existing = externalResults.get(effectId);
          if (existing) return existing;
          executions++;
          const result = Object.freeze({ locator: `artifact:${effectId}` });
          externalResults.set(effectId, result);
          return result;
        },
      },
      validateResult: locatorResult,
      apply: (state, result) => ({
        ...state,
        privateState: { cursor: 1, locator: result.locator },
        privateHistory: [...state.privateHistory, { stage: "artifact_published" }],
      }),
    })).rejects.toThrow("storage_unavailable_before_commit");

    const successor = await openWardenRuntimeExecution({
      binding,
      journal,
      key,
      executorDigest,
      writerLeaseGeneration: 1,
      now: () => "2026-08-11T18:00:02.000Z",
    });
    const resumed = await successor.runEffect({
      kind: "artifact",
      slot: "candidate-manifest",
      request: { path: "candidate-manifest.json" },
      executor: {
        reconcile: async ({ effectId }) => externalResults.get(effectId) ?? null,
        executeIdempotent: async () => {
          executions++;
          throw new Error("effect_must_not_execute_twice");
        },
      },
      validateResult: locatorResult,
      apply: (state, result) => ({
        ...state,
        privateState: { cursor: 1, locator: result.locator },
        privateHistory: [...state.privateHistory, { stage: "artifact_published" }],
      }),
    });

    expect(executions).toBe(1);
    expect(resumed.replayed).toBe(true);
    expect(resumed.value.locator).toMatch(/^artifact:sha256:/);
    expect(successor.state().pendingEffect).toEqual({ kind: "none" });
    expect(successor.state().effectReceipts).toHaveLength(1);
    expect(successor.state().privateState).toMatchObject({ cursor: 1 });
  });

  it("lets a newer lease reconcile a result while fencing the old writer", async () => {
    const journal = memoryJournal();
    const externalResults = new Map<string, Readonly<{ locator: string }>>();
    let executions = 0;
    const first = await openWardenRuntimeExecution({
      binding,
      journal,
      key,
      executorDigest,
      writerLeaseGeneration: 1,
      genesis: genesis(),
    });
    journal.failBeforeGeneration(3);
    const effect = {
      kind: "artifact" as const,
      slot: "takeover-artifact",
      request: { path: "takeover.json" },
      executor: {
        reconcile: async ({ effectId }: Readonly<{ effectId: string }>) =>
          externalResults.get(effectId) ?? null,
        executeIdempotent: async ({
          effectId,
          assertFence,
        }: Readonly<{ effectId: string; assertFence: () => Promise<void> }>) => {
          await assertFence();
          const existing = externalResults.get(effectId);
          if (existing) return existing;
          executions++;
          const value = Object.freeze({ locator: `artifact:${effectId}` });
          externalResults.set(effectId, value);
          return value;
        },
      },
      validateResult: locatorResult,
      apply: (state: WardenPrivateRuntimeStateV1) => state,
    };
    await expect(first.runEffect(effect)).rejects.toThrow("storage_unavailable_before_commit");
    journal.setLease(2);

    const successor = await openWardenRuntimeExecution({
      binding,
      journal,
      key,
      executorDigest,
      writerLeaseGeneration: 2,
    });
    const resumed = await successor.runEffect(effect);

    expect(executions).toBe(1);
    expect(resumed.replayed).toBe(true);
    expect(successor.state().writerLeaseGeneration).toBe(2);
    await expect(first.runEffect(effect)).rejects.toThrow("warden_runtime_effect_lease_stale");
  });

  it("reconciles a committed checkpoint when the journal response is lost", async () => {
    const journal = memoryJournal();
    const execution = await openWardenRuntimeExecution({
      binding,
      journal,
      key,
      executorDigest,
      writerLeaseGeneration: 1,
      genesis: genesis(),
      now: () => "2026-08-11T18:01:00.000Z",
    });
    journal.loseResponseAfterGeneration(3);
    let executions = 0;

    const result = await execution.runEffect({
      kind: "artifact",
      slot: "evidence-bundle",
      request: { path: "evidence.json" },
      executor: {
        reconcile: async () => null,
        executeIdempotent: async ({ assertFence }) => {
          await assertFence();
          executions++;
          return { locator: "artifact:evidence" };
        },
      },
      validateResult: locatorResult,
      apply: (state) => ({
        ...state,
        privateHistory: [...state.privateHistory, { stage: "evidence_published" }],
      }),
    });

    expect(executions).toBe(1);
    expect(result.replayed).toBe(false);
    expect(journal.record().envelope?.payload.generation).toBe(4);
  });

  it("checks the current lease immediately before an external effect", async () => {
    const journal = memoryJournal();
    const execution = await openWardenRuntimeExecution({
      binding,
      journal,
      key,
      executorDigest,
      writerLeaseGeneration: 1,
      genesis: genesis(),
      now: () => "2026-08-11T18:02:00.000Z",
    });
    let executions = 0;

    await expect(execution.runEffect({
      kind: "artifact",
      slot: "stale-artifact",
      request: { path: "stale.json" },
      executor: {
        reconcile: async () => {
          journal.setLease(2);
          return null;
        },
        executeIdempotent: async ({ assertFence }) => {
          await assertFence();
          executions++;
          return { locator: "artifact:stale" };
        },
      },
      validateResult: locatorResult,
      apply: (state) => state,
    })).rejects.toThrow("warden_runtime_effect_lease_stale");

    expect(executions).toBe(0);
    expect(journal.record().envelope?.payload.generation).toBe(2);
  });

  it("rejects a journal lease that regresses behind the authenticated writer", async () => {
    const journal = memoryJournal(2);
    await openWardenRuntimeExecution({
      binding,
      journal,
      key,
      executorDigest,
      writerLeaseGeneration: 2,
      genesis: genesis(2),
    });
    journal.setLease(1);

    await expect(openWardenRuntimeExecution({
      binding,
      journal,
      key,
      executorDigest,
      writerLeaseGeneration: 1,
    })).rejects.toThrow("warden_runtime_effect_lease_stale");
  });

  it("rejects a different executor before replaying private state", async () => {
    const journal = memoryJournal();
    await openWardenRuntimeExecution({
      binding,
      journal,
      key,
      executorDigest,
      writerLeaseGeneration: 1,
      genesis: genesis(),
    });

    await expect(openWardenRuntimeExecution({
      binding,
      journal,
      key,
      executorDigest: digest("different-executor"),
      writerLeaseGeneration: 1,
    })).rejects.toThrow("warden_runtime_effect_executor_mismatch");
  });

  it("returns and reduces canonical copies instead of mutable checkpoint state", async () => {
    const journal = memoryJournal();
    const execution = await openWardenRuntimeExecution({
      binding,
      journal,
      key,
      executorDigest,
      writerLeaseGeneration: 1,
      genesis: genesis(),
    });
    const exposed = execution.state() as WardenPrivateRuntimeStateV1 & {
      privateHistory: WardenRuntimeJson[];
    };
    exposed.privateHistory.push({ injected: true });

    await execution.runEffect({
      kind: "artifact",
      slot: "copy-artifact",
      request: { path: "copy.json" },
      executor: {
        reconcile: async () => null,
        executeIdempotent: async ({ assertFence }) => {
          await assertFence();
          return { locator: "artifact:copy" };
        },
      },
      validateResult: locatorResult,
      apply: (state, result) => {
        (state.privateHistory as WardenRuntimeJson[]).push({ reducerMutation: true });
        return {
          ...state,
          privateState: { locator: result.locator },
        };
      },
    });

    expect(execution.state().privateHistory).toEqual([
      { cursor: 0 },
      { reducerMutation: true },
    ]);
    expect(JSON.stringify(execution.state())).not.toContain("injected");
  });

  it("aborts a bounded effect operation when its deadline expires", async () => {
    const journal = memoryJournal();
    const execution = await openWardenRuntimeExecution({
      binding,
      journal,
      key,
      executorDigest,
      writerLeaseGeneration: 1,
      operationTimeoutMs: 10,
      genesis: genesis(),
    });
    let observedAbort = false;

    await expect(execution.runEffect({
      kind: "artifact",
      slot: "bounded-artifact",
      request: { path: "bounded.json" },
      executor: {
        reconcile: async () => null,
        executeIdempotent: async ({ signal, assertFence }) => {
          await assertFence();
          signal.addEventListener("abort", () => {
            observedAbort = true;
          }, { once: true });
          await new Promise<void>((resolve) => setTimeout(resolve, 30));
          return { locator: "artifact:late" };
        },
      },
      validateResult: locatorResult,
      apply: (state) => state,
    })).rejects.toThrow("warden_runtime_effect_timeout");

    expect(observedAbort).toBe(true);
    expect(execution.state().pendingEffect).toMatchObject({ state: "prepared" });
  });

  it("rejects terminal phase changes from ordinary effect reducers", async () => {
    const journal = memoryJournal();
    const execution = await openWardenRuntimeExecution({
      binding,
      journal,
      key,
      executorDigest,
      writerLeaseGeneration: 1,
      genesis: genesis(),
    });

    await expect(execution.runEffect({
      kind: "artifact",
      slot: "unauthorized-terminal",
      request: { path: "terminal.json" },
      executor: {
        reconcile: async () => null,
        executeIdempotent: async ({ assertFence }) => {
          await assertFence();
          return { locator: "artifact:terminal" };
        },
      },
      validateResult: locatorResult,
      apply: (state) => ({ ...state, phase: "terminal" }),
    })).rejects.toThrow("warden_runtime_effect_phase_invalid");

    expect(execution.state().phase).toBe("agent_running");
    expect(execution.state().pendingEffect).toMatchObject({ state: "completed" });
  });

  it("settles a nonresponsive effect promptly when its parent is aborted", async () => {
    const journal = memoryJournal();
    const controller = new AbortController();
    const execution = await openWardenRuntimeExecution({
      binding,
      journal,
      key,
      executorDigest,
      writerLeaseGeneration: 1,
      operationTimeoutMs: 200,
      signal: controller.signal,
      genesis: genesis(),
    });
    const started = Date.now();
    setTimeout(() => controller.abort(), 5);

    await expect(execution.runEffect({
      kind: "artifact",
      slot: "abort-reconcile",
      request: { path: "abort.json" },
      executor: {
        reconcile: async () => await new Promise<never>(() => undefined),
        executeIdempotent: async () => ({ locator: "must-not-run" }),
      },
      validateResult: locatorResult,
      apply: (state) => state,
    })).rejects.toThrow("warden_runtime_effect_aborted");

    expect(Date.now() - started).toBeLessThan(100);
  });

  it("settles a nonresponsive journal read promptly when its parent is aborted", async () => {
    const controller = new AbortController();
    const journal: WardenCheckpointJournal = {
      read: async () => await new Promise<never>(() => undefined),
      compareAndSwap: async () => false,
    };
    const started = Date.now();
    setTimeout(() => controller.abort(), 5);

    await expect(openWardenRuntimeExecution({
      binding,
      journal,
      key,
      executorDigest,
      writerLeaseGeneration: 1,
      operationTimeoutMs: 200,
      signal: controller.signal,
      genesis: genesis(),
    })).rejects.toThrow("warden_runtime_effect_aborted");

    expect(Date.now() - started).toBeLessThan(100);
  });
});
