import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  commitWardenCheckpoint as commitWardenCheckpointRecord,
  createWardenCheckpointEnvelope,
  createWardenRuntimeStateCommitment,
  openWardenRuntimeState,
  sealWardenRuntimeState,
  verifyWardenCheckpointEnvelope,
  type WardenCheckpointBinding,
  type WardenCheckpointEnvelope,
  type WardenCheckpointJournal,
  type WardenCheckpointPayload,
} from "./checkpoint.js";
import {
  createWardenRuntimeManifestDigest,
  createWardenRuntimeMutationOperationDigest,
  encodeWardenRuntimeState,
  projectWardenCheckpointPayload,
  type WardenPrivateRuntimeStateV1,
  type WardenRuntimeJson,
} from "./runtime-state.js";

const key = Buffer.from("11".repeat(32), "hex");
const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const sourceContent = "s".repeat(1200);
const candidateContent = "c".repeat(90);
const sourceDigest = digest(sourceContent);
const candidateDigest = digest(candidateContent);
const sourceManifest = Object.freeze([{
  path: "src/client.ts",
  digest: sourceDigest,
  bytes: Buffer.byteLength(sourceContent, "utf8"),
}]);

const binding: WardenCheckpointBinding = Object.freeze({
  schemaVersion: 1,
  tenantId: "tenant-a",
  jobId: "job-a",
  attemptId: "attempt-a",
  repositoryId: "repo-42",
  snapshotId: "snapshot-a",
  revision: "a".repeat(40),
  sourceManifestSha256: createWardenRuntimeManifestDigest(sourceManifest),
  allowedPathsDigest: `sha256:${"c".repeat(64)}`,
  verificationProfileDigest: `sha256:${"d".repeat(64)}`,
  modelPolicyDigest: `sha256:${"e".repeat(64)}`,
});

const zeroCounters: WardenCheckpointPayload["counters"] = Object.freeze({
  mutationCount: 0,
  toolCalls: 0,
  verifierCalls: 0,
  modelCalls: 0,
  modelSuccessfulCalls: 0,
  modelFailedCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  observedBytes: 0,
  searchBytes: 0,
  changedBytes: 0,
  groundedMutations: 0,
  blockedMutations: 0,
});

const genesisPayload: WardenCheckpointPayload = bindRuntimeState(Object.freeze({
  schemaVersion: 1,
  binding,
  generation: 1,
  writerLeaseGeneration: 7,
  workspaceName: "attempt-a-2f8c4d",
  workspaceDigest: `sha256:${"f".repeat(64)}`,
  runtimeStateCommitment: `hmac-sha256:${"0".repeat(64)}`,
  phase: "agent_running",
  nextStep: 0,
  steps: Object.freeze([]),
  sourceEvidence: Object.freeze([]),
  observedDirectories: Object.freeze([]),
  searchDigests: Object.freeze([]),
  changedFiles: Object.freeze([]),
  actionFingerprints: Object.freeze([]),
  counters: zeroCounters,
  previousEnvelopeDigest: null,
  createdAt: "2026-08-10T17:59:00.000Z",
}));

const genesisRuntimeState = runtimeStateFor(genesisPayload);

function privateRuntimeStateFor(payload: WardenCheckpointPayload): WardenPrivateRuntimeStateV1 {
  const changed = new Map(payload.changedFiles.map((entry) => [entry.path, entry.digest]));
  const workspaceManifest = sourceManifest.map((entry) => ({
    ...entry,
    digest: changed.get(entry.path) ?? entry.digest,
    bytes: changed.has(entry.path) ? Buffer.byteLength(candidateContent, "utf8") : entry.bytes,
  }));
  const successes = payload.counters.modelSuccessfulCalls;
  const failures = payload.counters.modelFailedCalls;
  const modelCalls = Array.from({ length: payload.counters.modelCalls }, (_, index) => ({
    status: index < successes ? "succeeded" as const : "failed" as const,
    promptTokens: index === 0 ? payload.counters.promptTokens : 0,
    completionTokens: index === 0 ? payload.counters.completionTokens : 0,
    totalTokens: index === 0 ? payload.counters.totalTokens : 0,
    costUsd: index === 0 ? payload.counters.costUsd : 0,
  }));
  if (successes + failures !== modelCalls.length) {
    throw new Error("invalid_test_model_counters");
  }
  let mutationEvents = payload.counters.mutationCount;
  const events = payload.steps.map((step, index) => {
    const mutation = mutationEvents > 0 &&
      (step.tool === "write_file" || step.tool === "replace_in_file");
    if (mutation) mutationEvents--;
    const mutationArgs: Readonly<Record<string, WardenRuntimeJson>> = step.tool === "write_file"
      ? { path: "src/client.ts", content: candidateContent }
      : { path: "src/client.ts", from: "source", to: "candidate" };
    const call: WardenRuntimeJson = mutation ? {
      tool: step.tool,
      args: mutationArgs,
      intent: {
        schemaVersion: 1,
        hypothesis: "The source requires one exact replacement.",
        targetPath: "src/client.ts",
        targetSymbol: null,
        targetDigest: sourceDigest,
        evidenceRefs: [{ path: "src/client.ts", digest: sourceDigest }],
        precondition: "The source is fully observed.",
        expectedObservation: "The candidate bytes match the expected digest.",
        postcondition: "The exact candidate is present.",
        rollback: "Restore the source blob.",
        confidence: 1,
        risk: "low",
        stopCondition: "Stop after the exact replacement.",
        assessmentSource: "model",
        operationDigest: createWardenRuntimeMutationOperationDigest(
          step.tool as "replace_in_file" | "write_file",
          "src/client.ts",
          mutationArgs,
        ),
        expectedResultDigest: candidateDigest,
      },
    } : { step: index, tool: step.tool };
    const result: WardenRuntimeJson = mutation
      ? { ok: true, tool: step.tool, summary: step.summary, data: { path: "src/client.ts" } }
      : { step: index, ok: step.ok, summary: step.summary, error: step.error ?? null };
    return {
      category: step.tool === "run_command" ? "verifier" as const : "tool" as const,
      tool: step.tool,
      plannerSource: step.plannerSource,
      executed: true,
      ok: step.ok,
      summaryCode: step.summary,
      ...(step.error === undefined ? {} : { errorCode: step.error }),
      call,
      result,
      mutation,
    };
  });
  const privateState = (generation: number) => ({
    generation,
    nextStep: generation === payload.generation ? payload.nextStep : Math.max(0, generation - 1),
    privatePlannerState: `private-state-${generation}`,
    recentObservation: "private source bytes",
  });
  return {
    schemaVersion: 1,
    binding: payload.binding,
    generation: payload.generation,
    writerLeaseGeneration: payload.writerLeaseGeneration,
    workspaceName: payload.workspaceName,
    phase: payload.phase,
    previousEnvelopeDigest: payload.previousEnvelopeDigest,
    createdAt: payload.createdAt,
    executorDigest: `sha256:${"6".repeat(64)}`,
    sourceManifest,
    workspaceManifest,
    events,
    sourceEvidence: payload.sourceEvidence,
    observedDirectories: payload.observedDirectories,
    searches: payload.searchDigests.map((_, index) => ({ index })),
    modelCalls,
    sourceCounters: {
      observedBytes: payload.counters.observedBytes,
      searchBytes: payload.counters.searchBytes,
      changedBytes: payload.counters.changedBytes,
      groundedMutations: payload.counters.groundedMutations,
      blockedMutations: payload.counters.blockedMutations,
    },
    privateState: privateState(payload.generation),
    privateHistory: Array.from(
      { length: payload.generation - 1 },
      (_, index) => privateState(index + 1),
    ),
    rollbackPreimages: payload.changedFiles.length === 0 ? [] : [{
      path: "src/client.ts",
      existed: true,
      blobDigest: sourceDigest,
    }],
    blobs: [
      {
        digest: sourceDigest,
        bytes: Buffer.byteLength(sourceContent, "utf8"),
        contentBase64: Buffer.from(sourceContent, "utf8").toString("base64"),
      },
      ...(payload.changedFiles.length === 0 ? [] : [{
        digest: candidateDigest,
        bytes: Buffer.byteLength(candidateContent, "utf8"),
        contentBase64: Buffer.from(candidateContent, "utf8").toString("base64"),
      }]),
    ],
    effectReceipts: [],
    pendingEffect: { kind: "none" },
  };
}

function runtimeStateFor(payload: WardenCheckpointPayload): Uint8Array {
  return encodeWardenRuntimeState(privateRuntimeStateFor(payload));
}

function bindRuntimeState(
  payload: WardenCheckpointPayload,
  signingKey: Uint8Array = key,
): WardenCheckpointPayload {
  return projectWardenCheckpointPayload(privateRuntimeStateFor(payload), signingKey);
}

async function commitWardenCheckpoint(
  journal: WardenCheckpointJournal,
  payload: WardenCheckpointPayload,
  signingKey: Uint8Array,
  expectedBinding: WardenCheckpointBinding,
): ReturnType<typeof commitWardenCheckpointRecord> {
  const runtimeState = runtimeStateFor(payload);
  const boundPayload = bindRuntimeState(payload, signingKey);
  return commitWardenCheckpointRecord(
    journal,
    boundPayload,
    runtimeState,
    signingKey,
    expectedBinding,
  );
}

function mutationSuccessor(current: WardenCheckpointEnvelope): WardenCheckpointPayload {
  const step = current.payload.nextStep;
  const mutationCount = current.payload.counters.mutationCount + 1;
  const callDigest = `sha256:${"1".repeat(64)}`;
  const resultDigest = `sha256:${"2".repeat(64)}`;
  return bindRuntimeState({
    ...current.payload,
    generation: current.payload.generation + 1,
    workspaceDigest: `sha256:${"e".repeat(64)}`,
    nextStep: step + 1,
    steps: [
      ...current.payload.steps,
      {
        step,
        tool: "replace_in_file",
        ok: true,
        summary: "replace_in_file_succeeded",
        plannerSource: "model",
        callDigest,
        resultDigest,
      },
    ],
    sourceEvidence: [{
      path: "src/client.ts",
      digest: sourceDigest,
      bytes: 1200,
      totalChars: 1200,
      ranges: [{ start: 0, end: 1200 }],
      fullyObserved: true,
    }],
    observedDirectories: ["src"],
    searchDigests: [`sha256:${"4".repeat(64)}`],
    changedFiles: [{ path: "src/client.ts", digest: candidateDigest }],
    actionFingerprints: [
      ...current.payload.actionFingerprints,
      { callDigest, resultDigest, mutationCount },
    ],
    counters: {
      ...current.payload.counters,
      mutationCount,
      toolCalls: current.payload.counters.toolCalls + 1,
      groundedMutations: current.payload.counters.groundedMutations + 1,
      modelCalls: current.payload.counters.modelCalls + 1,
      modelSuccessfulCalls: current.payload.counters.modelSuccessfulCalls + 1,
      promptTokens: current.payload.counters.promptTokens + 10,
      completionTokens: current.payload.counters.completionTokens + 5,
      totalTokens: current.payload.counters.totalTokens + 15,
      costUsd: current.payload.counters.costUsd + 0.01,
      observedBytes: 1200,
      searchBytes: 800,
      changedBytes: 90,
    },
    previousEnvelopeDigest: current.payloadDigest,
    createdAt: new Date(Date.parse(current.payload.createdAt) + 60_000).toISOString(),
  });
}

function successor(
  current: WardenCheckpointEnvelope,
  summary: string,
  resultDigit: string,
  writerLeaseGeneration = current.payload.writerLeaseGeneration,
): WardenCheckpointPayload {
  const step = current.payload.nextStep;
  return bindRuntimeState({
    ...current.payload,
    generation: current.payload.generation + 1,
    writerLeaseGeneration,
    nextStep: step + 1,
    steps: [
      ...current.payload.steps,
      {
        step,
        tool: "run_command",
        ok: false,
        summary,
        error: "target_verifier_failed",
        plannerSource: "system",
        callDigest: `sha256:${"9".repeat(64)}`,
        resultDigest: `sha256:${resultDigit.repeat(64)}`,
      },
    ],
    counters: {
      ...current.payload.counters,
      toolCalls: current.payload.counters.toolCalls + 1,
      verifierCalls: current.payload.counters.verifierCalls + 1,
    },
    previousEnvelopeDigest: current.payloadDigest,
    createdAt: new Date(Date.parse(current.payload.createdAt) + 60_000).toISOString(),
  });
}

function memoryJournal(activeWriterLeaseGeneration: number): WardenCheckpointJournal & {
  setActiveWriterLeaseGeneration(value: number): void;
} {
  let record: Awaited<ReturnType<WardenCheckpointJournal["read"]>> = {
    envelope: null,
    sealedRuntimeState: null,
    activeWriterLeaseGeneration,
  };
  return {
    async read() {
      return record;
    },
    async compareAndSwap(input) {
      const currentDigest = record.envelope?.payloadDigest ?? null;
      if (currentDigest !== input.expectedPayloadDigest ||
          record.activeWriterLeaseGeneration !== input.expectedActiveWriterLeaseGeneration) {
        return false;
      }
      record = {
        envelope: input.nextEnvelope,
        sealedRuntimeState: input.nextSealedRuntimeState,
        activeWriterLeaseGeneration: record.activeWriterLeaseGeneration,
      };
      return true;
    },
    setActiveWriterLeaseGeneration(value) {
      record = { ...record, activeWriterLeaseGeneration: value };
    },
  };
}

describe("Warden checkpoint envelope", () => {
  it("encrypts private runtime state and binds it to the exact checkpoint", () => {
    const checkpoint = createWardenCheckpointEnvelope(genesisPayload, key);
    const runtimeState = genesisRuntimeState;

    const sealed = sealWardenRuntimeState(runtimeState, checkpoint, key, binding);

    expect(JSON.stringify(sealed)).not.toContain("private source bytes");
    expect(openWardenRuntimeState(
      sealed,
      checkpoint,
      key,
      binding,
      genesisPayload.writerLeaseGeneration,
    )).toEqual(runtimeState);
    expect(() => sealWardenRuntimeState(
      Buffer.from("different but valid state", "utf8"),
      checkpoint,
      key,
      binding,
    )).toThrow("warden_checkpoint_runtime_state_mismatch");
    expect(() => openWardenRuntimeState(
      { ...sealed, ciphertext: `${sealed.ciphertext.slice(0, -2)}AA` },
      checkpoint,
      key,
      binding,
      genesisPayload.writerLeaseGeneration,
    )).toThrow("warden_checkpoint_runtime_state_authentication_failed");
    expect(() => openWardenRuntimeState(
      sealed,
      checkpoint,
      Buffer.alloc(32, 7),
      binding,
      genesisPayload.writerLeaseGeneration,
    )).toThrow("warden_checkpoint_authentication_failed");
    expect(() => openWardenRuntimeState(
      sealed,
      checkpoint,
      key,
      { ...binding, tenantId: "tenant-b" },
      genesisPayload.writerLeaseGeneration,
    )).toThrow("warden_checkpoint_binding_mismatch");
  });

  it("authenticates bounded checkpoint metadata and verifies the exact execution binding", () => {
    const envelope = createWardenCheckpointEnvelope(genesisPayload, key);

    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.algorithm).toBe("HMAC-SHA256");
    expect(envelope.payloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(envelope.authenticationTag).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(envelope)).not.toContain("source code");
    expect(verifyWardenCheckpointEnvelope(
      envelope,
      key,
      binding,
      genesisPayload.writerLeaseGeneration,
    )).toEqual(genesisPayload);
  });

  it("rejects payload, tag, key, and execution-binding tampering", () => {
    const envelope = createWardenCheckpointEnvelope(genesisPayload, key);

    expect(() => verifyWardenCheckpointEnvelope(
      { ...envelope, payload: { ...genesisPayload, nextStep: 1 } },
      key,
      binding,
      genesisPayload.writerLeaseGeneration,
    )).toThrow("warden_checkpoint_payload_digest_mismatch");
    expect(() => verifyWardenCheckpointEnvelope(
      { ...envelope, authenticationTag: `hmac-sha256:${"0".repeat(64)}` },
      key,
      binding,
      genesisPayload.writerLeaseGeneration,
    )).toThrow("warden_checkpoint_authentication_failed");
    expect(() => verifyWardenCheckpointEnvelope(
      envelope,
      Buffer.alloc(32, 7),
      binding,
      genesisPayload.writerLeaseGeneration,
    ))
      .toThrow("warden_checkpoint_authentication_failed");
    expect(() => verifyWardenCheckpointEnvelope(
      envelope,
      key,
      { ...binding, tenantId: "tenant-b" },
      genesisPayload.writerLeaseGeneration,
    )).toThrow("warden_checkpoint_binding_mismatch");
    expect(() => verifyWardenCheckpointEnvelope(
      envelope,
      key,
      binding,
      genesisPayload.writerLeaseGeneration + 1,
    )).toThrow("warden_checkpoint_lease_mismatch");
  });

  it("rejects unbounded or source-bearing metadata before it can be signed", () => {
    expect(() => createWardenCheckpointEnvelope(
      {
        ...genesisPayload,
        steps: [{
          ...successor(createWardenCheckpointEnvelope(genesisPayload, key), "step_succeeded", "a")
            .steps[0]!,
          summary: "private source code",
        }],
      },
      key,
    )).toThrow("warden_checkpoint_step_invalid");

    expect(() => createWardenCheckpointEnvelope(
      {
        ...genesisPayload,
        steps: [{
          ...successor(createWardenCheckpointEnvelope(genesisPayload, key), "step_succeeded", "a")
            .steps[0]!,
          summary: "x".repeat(501),
        }],
      },
      key,
    )).toThrow("warden_checkpoint_step_invalid");

    expect(() => createWardenCheckpointEnvelope(
      {
        ...genesisPayload,
        sourceEvidence: [{
          path: "src/client.ts",
          digest: `sha256:${"3".repeat(64)}`,
          bytes: 20,
          totalChars: 20,
          ranges: [{ start: 0, end: 20 }],
          fullyObserved: true,
          content: "private source code",
        }] as unknown as WardenCheckpointPayload["sourceEvidence"],
      },
      key,
    )).toThrow("warden_checkpoint_source_evidence_invalid");
    expect(() => createWardenCheckpointEnvelope(
      {
        ...genesisPayload,
        binding: { ...binding, revision: "private source code" },
      },
      key,
    )).toThrow("warden_checkpoint_binding_invalid");
  });

  it("creates only genesis envelopes and commits one lease-authorized successor", async () => {
    expect(() => createWardenCheckpointEnvelope(
      {
        ...genesisPayload,
        generation: 2,
        previousEnvelopeDigest: `sha256:${"8".repeat(64)}`,
      },
      key,
    ))
      .toThrow("warden_checkpoint_genesis_invalid");

    const crossTenantJournal = memoryJournal(genesisPayload.writerLeaseGeneration);
    await expect(commitWardenCheckpoint(
      crossTenantJournal,
      {
        ...genesisPayload,
        binding: { ...binding, tenantId: "tenant-b" },
      },
      key,
      binding,
    )).rejects.toThrow("warden_checkpoint_binding_mismatch");
    expect((await crossTenantJournal.read(binding)).envelope).toBeNull();

    const journal = memoryJournal(genesisPayload.writerLeaseGeneration);
    const genesis = await commitWardenCheckpoint(journal, genesisPayload, key, binding);
    const genesisRecord = await journal.read(binding);
    expect(genesisRecord.sealedRuntimeState).toBeDefined();
    await expect(commitWardenCheckpointRecord(
      journal,
      genesis.payload,
      Buffer.from("different private state", "utf8"),
      key,
      binding,
    )).rejects.toThrow("warden_checkpoint_runtime_state_mismatch");
    const missingStateJournal: WardenCheckpointJournal = {
      async read() {
        return {
          envelope: genesis,
          sealedRuntimeState: null,
          activeWriterLeaseGeneration: genesisPayload.writerLeaseGeneration,
        };
      },
      async compareAndSwap() {
        throw new Error("compare_and_swap_must_not_run");
      },
    };
    await expect(commitWardenCheckpoint(
      missingStateJournal,
      successor(genesis, "target_verifier_failed", "d"),
      key,
      binding,
    )).rejects.toThrow("warden_checkpoint_runtime_state_missing");
    const corruptedStateJournal: WardenCheckpointJournal = {
      async read() {
        return {
          ...genesisRecord,
          sealedRuntimeState: {
            ...genesisRecord.sealedRuntimeState!,
            authenticationTag: Buffer.alloc(16, 0).toString("base64"),
          },
        };
      },
      async compareAndSwap() {
        throw new Error("compare_and_swap_must_not_run");
      },
    };
    await expect(commitWardenCheckpoint(
      corruptedStateJournal,
      successor(genesis, "target_verifier_failed", "e"),
      key,
      binding,
    )).rejects.toThrow("warden_checkpoint_runtime_state_authentication_failed");
    const regressedLeaseJournal: WardenCheckpointJournal = {
      async read() {
        return {
          ...genesisRecord,
          activeWriterLeaseGeneration: genesisPayload.writerLeaseGeneration - 1,
        };
      },
      async compareAndSwap() {
        return true;
      },
    };
    await expect(commitWardenCheckpoint(
      regressedLeaseJournal,
      successor(
        genesis,
        "target_verifier_failed",
        "f",
        genesisPayload.writerLeaseGeneration - 1,
      ),
      key,
      binding,
    )).rejects.toThrow("warden_checkpoint_lease_mismatch");
    const siblingA = successor(genesis, "target_verifier_failed", "a");
    const siblingB = successor(genesis, "regression_verifier_failed", "b");
    const outcomes = await Promise.allSettled([
      commitWardenCheckpoint(journal, siblingA, key, binding),
      commitWardenCheckpoint(journal, siblingB, key, binding),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const committed = (await journal.read(binding)).envelope!;
    await expect(commitWardenCheckpoint(journal, committed.payload, key, binding))
      .resolves.toEqual(committed);

    journal.setActiveWriterLeaseGeneration(genesisPayload.writerLeaseGeneration + 1);
    await expect(commitWardenCheckpoint(
      journal,
      successor(committed, "security_verifier_failed", "c"),
      key,
      binding,
    )).rejects.toThrow("warden_checkpoint_lease_mismatch");
    const adopted = successor(
      committed,
      "security_verifier_failed",
      "c",
      genesisPayload.writerLeaseGeneration + 1,
    );
    await expect(commitWardenCheckpoint(journal, adopted, key, binding)).resolves.toMatchObject({
      payload: adopted,
    });
  });

  it("advances checkpoint history and cumulative budgets exactly once", async () => {
    const journal = memoryJournal(genesisPayload.writerLeaseGeneration);
    const genesis = await commitWardenCheckpoint(journal, genesisPayload, key, binding);
    const current = await commitWardenCheckpoint(journal, mutationSuccessor(genesis), key, binding);
    const nextPayload = bindRuntimeState({
      ...successor(current, "verification_failed", "a"),
      phase: "verification_feedback" as const,
      observedDirectories: [...current.payload.observedDirectories, "tests"],
      searchDigests: [...current.payload.searchDigests, `sha256:${"b".repeat(64)}`],
    });

    const advanced = await commitWardenCheckpoint(journal, nextPayload, key, binding);

    expect(verifyWardenCheckpointEnvelope(
      advanced,
      key,
      binding,
      genesisPayload.writerLeaseGeneration,
    )).toEqual(nextPayload);
    await expect(commitWardenCheckpoint(
      journal,
      advanced.payload,
      key,
      binding,
    )).resolves.toEqual(advanced);
  });

  it("commits a paid model receipt before the later model-planned tool step", async () => {
    const journal = memoryJournal(genesisPayload.writerLeaseGeneration);
    const genesis = await commitWardenCheckpoint(journal, genesisPayload, key, binding);
    const base = privateRuntimeStateFor(genesis.payload);
    const requestBytes = Buffer.from('{"prompt":"repair the failing client"}', "utf8");
    const modelAccounting = {
      status: "succeeded" as const,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      costUsd: 0.01,
    };
    const resultBytes = Buffer.from(
      JSON.stringify({ call: { tool: "read_file", args: { path: "src/client.ts" } },
        accounting: modelAccounting }),
      "utf8",
    );
    const requestDigest = digest(requestBytes.toString("utf8"));
    const resultDigest = digest(resultBytes.toString("utf8"));
    const effectId = digest("planner:1");
    const commitRuntime = async (state: WardenPrivateRuntimeStateV1) =>
      await commitWardenCheckpointRecord(
        journal,
        projectWardenCheckpointPayload(state, key),
        encodeWardenRuntimeState(state),
        key,
        binding,
      );
    const preparedState: WardenPrivateRuntimeStateV1 = {
      ...base,
      generation: 2,
      previousEnvelopeDigest: genesis.payloadDigest,
      createdAt: "2026-08-10T18:00:00.000Z",
      blobs: [...base.blobs, {
        digest: requestDigest,
        bytes: requestBytes.byteLength,
        contentBase64: requestBytes.toString("base64"),
      }],
      pendingEffect: {
        kind: "model",
        state: "prepared",
        effectId,
        requestDigest,
      },
    };
    const prepared = await commitRuntime(preparedState);
    const completedState: WardenPrivateRuntimeStateV1 = {
      ...preparedState,
      generation: 3,
      previousEnvelopeDigest: prepared.payloadDigest,
      createdAt: "2026-08-10T18:00:01.000Z",
      blobs: [...preparedState.blobs, {
        digest: resultDigest,
        bytes: resultBytes.byteLength,
        contentBase64: resultBytes.toString("base64"),
      }],
      pendingEffect: {
        kind: "model",
        state: "completed",
        effectId,
        requestDigest,
        resultDigest,
      },
    };
    const completed = await commitRuntime(completedState);
    const consumedState: WardenPrivateRuntimeStateV1 = {
      ...completedState,
      generation: 4,
      previousEnvelopeDigest: completed.payloadDigest,
      createdAt: "2026-08-10T18:00:02.000Z",
      modelCalls: [modelAccounting],
      effectReceipts: [{
        kind: "model",
        effectId,
        requestDigest,
        resultDigest,
        plannedCallDigest: digest('{"args":{"path":"src/client.ts"},"tool":"read_file"}'),
        modelAccounting,
      }],
      pendingEffect: { kind: "none" },
    };

    const consumed = await commitRuntime(consumedState);

    expect(consumed.payload.counters).toMatchObject({
      modelCalls: 1,
      modelSuccessfulCalls: 1,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      costUsd: 0.01,
      toolCalls: 0,
    });
    expect(consumed.payload.steps).toHaveLength(0);
  });

  it("rejects generation skips, history rewrites, budget regression, and terminal advancement", async () => {
    const journal = memoryJournal(genesisPayload.writerLeaseGeneration);
    const genesis = await commitWardenCheckpoint(journal, genesisPayload, key, binding);
    const current = await commitWardenCheckpoint(journal, mutationSuccessor(genesis), key, binding);
    const next = successor(current, "verification_failed", "a");

    await expect(commitWardenCheckpoint(
      journal,
      { ...next, generation: next.generation + 1 },
      key,
      binding,
    )).rejects.toThrow("warden_checkpoint_generation_mismatch");
    await expect(commitWardenCheckpoint(
      journal,
      {
        ...next,
        steps: [{ ...current.payload.steps[0]!, summary: "history_rewritten" }],
      },
      key,
      binding,
    )).rejects.toThrow("warden_checkpoint_history_mismatch");
    await expect(commitWardenCheckpoint(
      journal,
      {
        ...next,
        counters: {
          ...next.counters,
          promptTokens: current.payload.counters.promptTokens - 1,
          totalTokens: current.payload.counters.totalTokens - 1,
        },
      },
      key,
      binding,
    )).rejects.toThrow("warden_checkpoint_budget_regressed");
    for (const incomplete of [
      { ...next, sourceEvidence: [] },
      {
        ...next,
        sourceEvidence: [{
          ...current.payload.sourceEvidence[0]!,
          digest: `sha256:${"0".repeat(64)}`,
        }],
      },
      { ...next, observedDirectories: [] },
      { ...next, searchDigests: [] },
      { ...next, changedFiles: [] },
      {
        ...next,
        changedFiles: [{
          path: current.payload.changedFiles[0]!.path,
          digest: `sha256:${"0".repeat(64)}`,
        }],
      },
      {
        ...next,
        steps: [
          ...current.payload.steps,
          { ...next.steps.at(-1)!, plannerSource: "model" as const },
        ],
      },
    ] satisfies WardenCheckpointPayload[]) {
      await expect(commitWardenCheckpoint(
        journal,
        incomplete,
        key,
        binding,
      )).rejects.toThrow(/warden_(checkpoint_(runtime_projection_mismatch|history_mismatch)|runtime_state_)/);
    }

    const terminalPayload = {
      ...current.payload,
      generation: current.payload.generation + 1,
      phase: "terminal" as const,
      previousEnvelopeDigest: current.payloadDigest,
      createdAt: new Date(Date.parse(current.payload.createdAt) + 60_000).toISOString(),
    };
    const terminal = await commitWardenCheckpoint(journal, terminalPayload, key, binding);
    await expect(commitWardenCheckpoint(
      journal,
      successor(terminal, "verification_failed", "b"),
      key,
      binding,
    )).rejects.toThrow("warden_checkpoint_terminal_sealed");
  });
});
