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

const key = Buffer.from("11".repeat(32), "hex");

const binding: WardenCheckpointBinding = Object.freeze({
  schemaVersion: 1,
  tenantId: "tenant-a",
  jobId: "job-a",
  attemptId: "attempt-a",
  repositoryId: "repo-42",
  snapshotId: "snapshot-a",
  revision: "a".repeat(40),
  sourceManifestSha256: `sha256:${"b".repeat(64)}`,
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

const genesisRuntimeState = Buffer.from(JSON.stringify({
  generation: 1,
  nextStep: 0,
  privatePlannerState: "private-state-1",
  recentObservation: "private source bytes",
}), "utf8");

const genesisPayload: WardenCheckpointPayload = Object.freeze({
  schemaVersion: 1,
  binding,
  generation: 1,
  writerLeaseGeneration: 7,
  workspaceName: "attempt-a-2f8c4d",
  workspaceDigest: `sha256:${"f".repeat(64)}`,
  runtimeStateCommitment: createWardenRuntimeStateCommitment(
    genesisRuntimeState,
    key,
    binding,
    "attempt-a-2f8c4d",
    1,
  ),
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
});

function runtimeStateFor(payload: WardenCheckpointPayload): Uint8Array {
  return Buffer.from(JSON.stringify({
    generation: payload.generation,
    nextStep: payload.nextStep,
    privatePlannerState: `private-state-${payload.generation}`,
    recentObservation: "private source bytes",
  }), "utf8");
}

function bindRuntimeState(
  payload: WardenCheckpointPayload,
  signingKey: Uint8Array = key,
): WardenCheckpointPayload {
  const runtimeState = runtimeStateFor(payload);
  return {
    ...payload,
    runtimeStateCommitment: createWardenRuntimeStateCommitment(
      runtimeState,
      signingKey,
      payload.binding,
      payload.workspaceName,
      payload.generation,
    ),
  };
}

function commitWardenCheckpoint(
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
      digest: `sha256:${"3".repeat(64)}`,
      bytes: 1200,
      totalChars: 1200,
      ranges: [{ start: 0, end: 1200 }],
      fullyObserved: true,
    }],
    observedDirectories: ["src"],
    searchDigests: [`sha256:${"4".repeat(64)}`],
    changedFiles: [{ path: "src/client.ts", digest: `sha256:${"5".repeat(64)}` }],
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
    const nextPayload = {
      ...successor(current, "verification_failed", "a"),
      phase: "verification_feedback" as const,
      observedDirectories: [...current.payload.observedDirectories, "tests"],
      searchDigests: [...current.payload.searchDigests, `sha256:${"b".repeat(64)}`],
    };

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
          toolCalls: current.payload.counters.toolCalls - 1,
        },
      },
      key,
      binding,
    )).rejects.toThrow("warden_checkpoint_budget_regressed");
    for (const incomplete of [
      { ...next, nextStep: next.nextStep + 1 },
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
      { ...next, workspaceDigest: `sha256:${"0".repeat(64)}` },
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
      )).rejects.toThrow("warden_checkpoint_history_mismatch");
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
