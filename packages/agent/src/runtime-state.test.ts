import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeWardenRuntimeState,
  createWardenRuntimeManifestDigest,
  createWardenRuntimeMutationOperationDigest,
  encodeWardenRuntimeState,
  projectWardenCheckpointPayload,
  validateWardenRuntimeStateTransition,
  type WardenPrivateRuntimeStateV1,
  type WardenRuntimeJson,
} from "./runtime-state.js";
import {
  commitWardenCheckpoint,
  type WardenCheckpointBinding,
  type WardenCheckpointJournal,
} from "./checkpoint.js";

const key = Buffer.from("71".repeat(32), "hex");
const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const sourceContent = "export const endpoint = '/v1/chargess';\n";
const candidateContent = "export const endpoint = '/v1/charges';\n";
const sourceDigest = digest(sourceContent);
const candidateDigest = digest(candidateContent);
const sourceBytes = Buffer.byteLength(sourceContent, "utf8");
const candidateBytes = Buffer.byteLength(candidateContent, "utf8");
const sourceManifest = [{ path: "src/client.ts", digest: sourceDigest, bytes: sourceBytes }];

const binding: WardenCheckpointBinding = Object.freeze({
  schemaVersion: 1,
  tenantId: "tenant-a",
  jobId: "job-a",
  attemptId: "attempt-a",
  repositoryId: "repo-a",
  snapshotId: "snapshot-a",
  revision: "a".repeat(40),
  sourceManifestSha256: createWardenRuntimeManifestDigest(sourceManifest),
  allowedPathsDigest: digest("allowed-paths"),
  verificationProfileDigest: digest("verification-profile"),
  modelPolicyDigest: digest("model-policy"),
});

function state(): WardenPrivateRuntimeStateV1 {
  return {
    schemaVersion: 1,
    binding,
    generation: 2,
    writerLeaseGeneration: 7,
    workspaceName: "attempt-a-private",
    phase: "agent_running",
    previousEnvelopeDigest: digest("previous-envelope"),
    createdAt: "2026-08-11T17:00:00.000Z",
    executorDigest: digest("agent-build"),
    sourceManifest,
    workspaceManifest: [{ path: "src/client.ts", digest: candidateDigest, bytes: candidateBytes }],
    events: [{
      category: "tool",
      tool: "replace_in_file",
      plannerSource: "model",
      executed: true,
      ok: true,
      summaryCode: "replace_in_file_succeeded",
      call: {
        tool: "replace_in_file",
        args: { path: "src/client.ts", from: "/v1/chargess", to: "/v1/charges" },
        intent: {
          schemaVersion: 1,
          hypothesis: "The endpoint path contains a typo.",
          targetPath: "src/client.ts",
          targetSymbol: "endpoint",
          targetDigest: sourceDigest,
          evidenceRefs: [{ path: "src/client.ts", digest: sourceDigest }],
          precondition: "The source file is fully observed.",
          expectedObservation: "The endpoint uses the corrected path.",
          postcondition: "The endpoint matches the verifier contract.",
          rollback: "Restore the source blob.",
          confidence: 1,
          risk: "low",
          stopCondition: "Stop after the exact replacement.",
          assessmentSource: "model",
          operationDigest: createWardenRuntimeMutationOperationDigest(
            "replace_in_file",
            "src/client.ts",
            { path: "src/client.ts", from: "/v1/chargess", to: "/v1/charges" },
          ),
          expectedResultDigest: candidateDigest,
        },
      },
      result: {
        ok: true,
        tool: "replace_in_file",
        summary: "updated private source",
        data: { path: "src/client.ts" },
      },
      mutation: true,
    }],
    sourceEvidence: [{
      path: "src/client.ts",
      digest: sourceDigest,
      bytes: sourceBytes,
      totalChars: sourceContent.length,
      ranges: [{ start: 0, end: sourceContent.length }],
      fullyObserved: true,
    }],
    observedDirectories: ["src"],
    searches: [{ path: "src", query: "chargess" }],
    modelCalls: [{
      status: "succeeded",
      promptTokens: 100,
      completionTokens: 25,
      totalTokens: 125,
      costUsd: 0.02,
    }],
    sourceCounters: {
      observedBytes: sourceBytes,
      searchBytes: sourceBytes,
      changedBytes: candidateBytes,
      groundedMutations: 1,
      blockedMutations: 0,
    },
    privateState: {
      attemptStage: "agent_execution",
      commandCursor: 0,
      loopCursor: 2,
      heuristic: {
        phase: "verify",
        triedFixes: ["path_typo"],
      },
      planner: {
        consecutiveInvalidResponses: 0,
        consecutiveMissingMutationIntents: 0,
      },
      verifier: { status: "failed", output: "private verifier output" },
    },
    privateHistory: [{ stage: "source_copied" }, { stage: "agent_execution" }],
    rollbackPreimages: [{ path: "src/client.ts", existed: true, blobDigest: sourceDigest }],
    blobs: [
      { digest: sourceDigest, bytes: sourceBytes, contentBase64: Buffer.from(sourceContent).toString("base64") },
      { digest: candidateDigest, bytes: candidateBytes, contentBase64: Buffer.from(candidateContent).toString("base64") },
    ],
    effectReceipts: [],
    pendingEffect: { kind: "none" },
  };
}

describe("Warden canonical private runtime state", () => {
  it("round trips private state canonically and projects every public field", () => {
    const runtime = state();
    const encoded = encodeWardenRuntimeState(runtime);
    const decoded = decodeWardenRuntimeState(encoded, binding);
    const payload = projectWardenCheckpointPayload(decoded, key);

    expect(encodeWardenRuntimeState(decoded)).toEqual(encoded);
    expect(decoded.privateState).toEqual(runtime.privateState);
    expect(payload).toMatchObject({
      binding,
      generation: 2,
      writerLeaseGeneration: 7,
      workspaceName: "attempt-a-private",
      phase: "agent_running",
      nextStep: 1,
      previousEnvelopeDigest: digest("previous-envelope"),
      counters: {
        mutationCount: 1,
        toolCalls: 1,
        verifierCalls: 0,
        modelCalls: 1,
        modelSuccessfulCalls: 1,
        modelFailedCalls: 0,
        promptTokens: 100,
        completionTokens: 25,
        totalTokens: 125,
        costUsd: 0.02,
      },
      changedFiles: [{ path: "src/client.ts", digest: candidateDigest }],
    });
    expect(payload.steps).toHaveLength(1);
    expect(payload.actionFingerprints).toHaveLength(1);
    expect(payload.searchDigests).toHaveLength(1);
    expect(payload.runtimeStateCommitment).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(payload)).not.toContain("private verifier output");
    expect(JSON.stringify(payload)).not.toContain("/v1/chargess");
  });

  it("uses one canonical encoding regardless of collection insertion order", () => {
    const left = state();
    const right: WardenPrivateRuntimeStateV1 = {
      ...state(),
      sourceManifest: [...left.sourceManifest].reverse(),
      workspaceManifest: [...left.workspaceManifest].reverse(),
      sourceEvidence: [...left.sourceEvidence].reverse(),
      observedDirectories: [...left.observedDirectories].reverse(),
      searches: [...left.searches].reverse(),
      blobs: [...left.blobs].reverse(),
    };

    expect(encodeWardenRuntimeState(right)).toEqual(encodeWardenRuntimeState(left));
  });

  it("rejects noncanonical bytes, cross-tenant restore, and corrupted blobs", () => {
    const runtime = state();
    const encoded = encodeWardenRuntimeState(runtime);

    expect(() => decodeWardenRuntimeState(
      Buffer.from(`${encoded.toString()} `, "utf8"),
      binding,
    )).toThrow("warden_runtime_state_noncanonical");
    expect(() => decodeWardenRuntimeState(encoded, { ...binding, tenantId: "tenant-b" }))
      .toThrow("warden_runtime_state_binding_mismatch");
    expect(() => encodeWardenRuntimeState({
      ...runtime,
      blobs: [{ ...runtime.blobs[0]!, contentBase64: Buffer.from("tampered").toString("base64") }],
    })).toThrow("warden_runtime_state_blob_invalid");
  });

  it("rejects counters and source evidence that disagree with executed state", () => {
    const runtime = state();

    expect(() => projectWardenCheckpointPayload({
      ...runtime,
      sourceCounters: { ...runtime.sourceCounters, groundedMutations: 0 },
    }, key)).toThrow("warden_runtime_state_counters_invalid");
    expect(() => projectWardenCheckpointPayload({
      ...runtime,
      sourceEvidence: [{
        ...runtime.sourceEvidence[0]!,
        digest: digest("different-source"),
      }],
    }, key)).toThrow("warden_runtime_state_source_evidence_invalid");
  });

  it("binds the immutable source manifest and mutation results to the workspace", () => {
    const runtime = state();

    expect(() => projectWardenCheckpointPayload({
      ...runtime,
      binding: { ...binding, sourceManifestSha256: digest("other-manifest") },
    }, key)).toThrow("warden_runtime_state_source_manifest_invalid");
    expect(() => projectWardenCheckpointPayload({
      ...runtime,
      workspaceManifest: [
        ...runtime.workspaceManifest,
        { path: "src/unrelated.ts", digest: candidateDigest, bytes: candidateBytes },
      ],
    }, key)).toThrow("warden_runtime_state_mutation_manifest_mismatch");
    expect(() => projectWardenCheckpointPayload({
      ...runtime,
      events: [{
        ...runtime.events[0]!,
        call: {
          ...(runtime.events[0]!.call as Record<string, WardenRuntimeJson>),
          intent: {
            ...((runtime.events[0]!.call as Record<string, WardenRuntimeJson>)
              .intent as Record<string, WardenRuntimeJson>),
            expectedResultDigest: sourceDigest,
          },
        },
      }],
    }, key)).toThrow("warden_runtime_state_mutation_manifest_mismatch");
    expect(() => projectWardenCheckpointPayload({
      ...runtime,
      events: [{
        ...runtime.events[0]!,
        call: {
          ...(runtime.events[0]!.call as Record<string, WardenRuntimeJson>),
          args: { path: "src/other.ts", from: "/v1/chargess", to: "/v1/charges" },
        },
      }],
    }, key)).toThrow("warden_runtime_state_event_invalid");
  });

  it("requires every resume dependency to resolve to an authenticated blob", () => {
    const runtime = state();

    expect(() => encodeWardenRuntimeState({
      ...runtime,
      blobs: runtime.blobs.filter((entry) => entry.digest !== sourceDigest),
    })).toThrow("warden_runtime_state_blob_reference_missing");
    expect(() => encodeWardenRuntimeState({
      ...runtime,
      blobs: runtime.blobs.filter((entry) => entry.digest !== candidateDigest),
    })).toThrow("warden_runtime_state_blob_reference_missing");
    expect(() => encodeWardenRuntimeState({
      ...runtime,
      rollbackPreimages: [],
    })).toThrow("warden_runtime_state_rollback_invalid");
  });

  it("rejects path aliases and preserves deterministic code unit ordering", () => {
    const runtime = state();

    expect(() => encodeWardenRuntimeState({
      ...runtime,
      sourceManifest: [{ ...runtime.sourceManifest[0]!, path: "src\\client.ts" }],
    })).toThrow("warden_runtime_state_source_manifest_invalid");
    expect(() => encodeWardenRuntimeState({
      ...runtime,
      sourceManifest: [
        ...runtime.sourceManifest,
        { ...runtime.sourceManifest[0]!, path: "SRC/client.ts" },
      ],
    })).toThrow("warden_runtime_state_source_manifest_invalid");
  });

  it("retains private history, repeated searches, blobs, and prepared effects", () => {
    const current = state();
    const preparedContent = Buffer.from("prepared request", "utf8");
    const preparedDigest = digest("prepared request");
    const withPrepared: WardenPrivateRuntimeStateV1 = {
      ...current,
      blobs: [
        ...current.blobs,
        { digest: preparedDigest, bytes: preparedContent.length,
          contentBase64: preparedContent.toString("base64") },
      ],
      searches: [...current.searches, current.searches[0]!],
      pendingEffect: {
        kind: "tool",
        state: "prepared",
        effectId: "effect-a",
        requestDigest: preparedDigest,
      },
    };
    const validNext: WardenPrivateRuntimeStateV1 = {
      ...withPrepared,
      generation: withPrepared.generation + 1,
      createdAt: "2026-08-11T17:01:00.000Z",
    };

    expect(() => validateWardenRuntimeStateTransition(withPrepared, {
      ...validNext,
      pendingEffect: { kind: "none" },
    })).toThrow("warden_runtime_state_pending_effect_transition_invalid");
    expect(() => validateWardenRuntimeStateTransition(withPrepared, {
      ...validNext,
      searches: [withPrepared.searches[0]!],
    })).toThrow("warden_runtime_state_transition_invalid");
    expect(() => validateWardenRuntimeStateTransition(withPrepared, {
      ...validNext,
      privateHistory: withPrepared.privateHistory.slice(1),
    })).toThrow("warden_runtime_state_transition_invalid");
    expect(() => validateWardenRuntimeStateTransition(withPrepared, {
      ...validNext,
      privateState: { stage: "rewritten_without_history" },
    })).toThrow("warden_runtime_state_transition_invalid:private_state");
    expect(() => validateWardenRuntimeStateTransition(withPrepared, {
      ...validNext,
      blobs: withPrepared.blobs.slice(1),
    })).toThrow("warden_runtime_state_transition_invalid");
  });

  it("consumes completed effects only through an exact authenticated receipt", () => {
    const current = state();
    const request = Buffer.from("effect request", "utf8");
    const result = Buffer.from("effect result", "utf8");
    const requestDigest = digest("effect request");
    const resultDigest = digest("effect result");
    const completed: WardenPrivateRuntimeStateV1 = {
      ...current,
      blobs: [
        ...current.blobs,
        { digest: requestDigest, bytes: request.length, contentBase64: request.toString("base64") },
        { digest: resultDigest, bytes: result.length, contentBase64: result.toString("base64") },
      ],
      pendingEffect: {
        kind: "artifact",
        state: "completed",
        effectId: "effect-artifact-a",
        requestDigest,
        resultDigest,
      },
    };
    const successor: WardenPrivateRuntimeStateV1 = {
      ...completed,
      generation: completed.generation + 1,
      createdAt: "2026-08-11T17:01:00.000Z",
      pendingEffect: { kind: "none" },
    };

    expect(() => validateWardenRuntimeStateTransition(current, {
      ...completed,
      generation: current.generation + 1,
      createdAt: "2026-08-11T17:01:00.000Z",
    })).toThrow("warden_runtime_state_pending_effect_transition_invalid");

    expect(() => validateWardenRuntimeStateTransition(completed, successor))
      .toThrow("warden_runtime_state_pending_effect_transition_invalid");
    expect(() => validateWardenRuntimeStateTransition(completed, {
      ...successor,
      effectReceipts: [{
        kind: "artifact",
        effectId: "effect-artifact-a",
        requestDigest,
        resultDigest,
      }],
    })).not.toThrow();
    expect(() => encodeWardenRuntimeState({
      ...completed,
      phase: "terminal",
    })).toThrow("warden_runtime_state_terminal_effect_unresolved");
    expect(() => encodeWardenRuntimeState({
      ...completed,
      effectReceipts: [{
        kind: "artifact",
        effectId: "effect-artifact-a",
        requestDigest,
        resultDigest,
      }],
      pendingEffect: {
        kind: "artifact",
        state: "prepared",
        effectId: "effect-artifact-a",
        requestDigest,
      },
    })).toThrow("warden_runtime_state_pending_effect_invalid");
  });

  it("binds a consumed tool receipt to exactly one matching runtime event", () => {
    const current = state();
    const requestValue = {
      call: { tool: "read_file", args: { path: "src/client.ts" } },
      plannerSource: "heuristic",
    };
    const resultValue = {
      ok: true,
      tool: "read_file",
      summary: "read source",
      data: { path: "src/client.ts" },
    };
    const request = Buffer.from(
      '{"call":{"args":{"path":"src/client.ts"},"tool":"read_file"},"plannerSource":"heuristic"}',
      "utf8",
    );
    const result = Buffer.from(
      '{"result":{"data":{"path":"src/client.ts"},"ok":true,"summary":"read source","tool":"read_file"}}',
      "utf8",
    );
    const requestDigest = digest(request.toString("utf8"));
    const resultDigest = digest(result.toString("utf8"));
    const effectId = digest("tool effect");
    const completed: WardenPrivateRuntimeStateV1 = {
      ...current,
      blobs: [
        ...current.blobs,
        { digest: requestDigest, bytes: request.length, contentBase64: request.toString("base64") },
        { digest: resultDigest, bytes: result.length, contentBase64: result.toString("base64") },
      ],
      pendingEffect: {
        kind: "tool",
        state: "completed",
        effectId,
        requestDigest,
        resultDigest,
      },
    };
    const receipt = {
      kind: "tool" as const,
      effectId,
      requestDigest,
      resultDigest,
    };
    const consumedWithoutEvent: WardenPrivateRuntimeStateV1 = {
      ...completed,
      generation: completed.generation + 1,
      createdAt: "2026-08-11T17:01:00.000Z",
      effectReceipts: [receipt],
      pendingEffect: { kind: "none" },
    };

    expect(() => validateWardenRuntimeStateTransition(completed, consumedWithoutEvent))
      .toThrow("warden_runtime_state_pending_effect_transition_invalid");

    const consumed = {
      ...consumedWithoutEvent,
      events: [...completed.events, {
        category: "tool" as const,
        tool: "read_file" as const,
        plannerSource: "heuristic" as const,
        executed: true,
        ok: true,
        summaryCode: "read_file_succeeded",
        effectId,
        call: requestValue.call,
        result: resultValue,
        mutation: false,
      }],
    } as unknown as WardenPrivateRuntimeStateV1;

    expect(() => validateWardenRuntimeStateTransition(completed, consumed)).not.toThrow();
    expect(() => encodeWardenRuntimeState(consumed)).not.toThrow();
    expect(() => encodeWardenRuntimeState({
      ...consumed,
      events: consumed.events.map((event) => event.effectId === effectId
        ? { ...event, plannerSource: "system" }
        : event),
    })).toThrow("warden_runtime_state_effect_event_invalid");
    expect(() => validateWardenRuntimeStateTransition(completed, {
      ...consumed,
      events: [...consumed.events, consumed.events.at(-1)!],
    })).toThrow("warden_runtime_state_pending_effect_transition_invalid");
  });

  it("binds durable model receipts and legacy model steps to successful calls", () => {
    const current = state();
    const nextGeneration = {
      generation: current.generation + 1,
      createdAt: "2026-08-11T17:01:00.000Z",
    };
    const successfulCall = {
      status: "succeeded" as const,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      costUsd: 0.01,
    };
    const modelEvent = {
      category: "tool" as const,
      tool: "read_file" as const,
      plannerSource: "model" as const,
      executed: true,
      ok: true,
      summaryCode: "read_file_succeeded",
      call: { tool: "read_file", args: { path: "src/client.ts" } },
      result: {
        ok: true,
        tool: "read_file",
        summary: "read source",
        data: { path: "src/client.ts" },
      },
      mutation: false,
    };

    expect(() => validateWardenRuntimeStateTransition(current, {
      ...current,
      ...nextGeneration,
      modelCalls: [...current.modelCalls, successfulCall],
    })).toThrow("warden_runtime_state_transition_invalid:model_calls");
    expect(() => validateWardenRuntimeStateTransition(current, {
      ...current,
      ...nextGeneration,
      events: [...current.events, modelEvent],
    })).toThrow("warden_runtime_state_transition_invalid:model_calls");
    expect(() => validateWardenRuntimeStateTransition(current, {
      ...current,
      ...nextGeneration,
      events: [...current.events, modelEvent],
      modelCalls: [...current.modelCalls, successfulCall],
    })).not.toThrow();
    expect(() => validateWardenRuntimeStateTransition(current, {
      ...current,
      ...nextGeneration,
      events: [...current.events, { ...modelEvent, executed: false }],
      modelCalls: [...current.modelCalls, successfulCall],
    })).toThrow("warden_runtime_state_transition_invalid:model_calls");
  });

  it("preserves an unused durable model receipt alongside legacy model history", () => {
    const current = state();
    const request = Buffer.from("planner request", "utf8");
    const modelAccounting = {
      status: "succeeded" as const,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      costUsd: 0.01,
    };
    const result = Buffer.from(JSON.stringify({
      call: { args: { path: "src/client.ts" }, tool: "read_file" },
      accounting: modelAccounting,
    }), "utf8");
    const requestDigest = digest(request.toString("utf8"));
    const resultDigest = digest(result.toString("utf8"));
    const effectId = digest("planner effect");
    const completed: WardenPrivateRuntimeStateV1 = {
      ...current,
      blobs: [
        ...current.blobs,
        { digest: requestDigest, bytes: request.length, contentBase64: request.toString("base64") },
        { digest: resultDigest, bytes: result.length, contentBase64: result.toString("base64") },
      ],
      pendingEffect: {
        kind: "model",
        state: "completed",
        effectId,
        requestDigest,
        resultDigest,
      },
    };
    const consumed: WardenPrivateRuntimeStateV1 = {
      ...completed,
      generation: current.generation + 1,
      createdAt: "2026-08-11T17:01:00.000Z",
      modelCalls: [...current.modelCalls, modelAccounting],
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
    const laterModelStep: WardenPrivateRuntimeStateV1 = {
      ...consumed,
      generation: consumed.generation + 1,
      createdAt: "2026-08-11T17:02:00.000Z",
      events: [...consumed.events, {
        category: "tool",
        tool: "read_file",
        plannerSource: "model",
        modelEffectId: effectId,
        executed: true,
        ok: true,
        summaryCode: "read_file_succeeded",
        call: { tool: "read_file", args: { path: "src/client.ts" } },
        result: {
          ok: true,
          tool: "read_file",
          summary: "read source",
          data: { path: "src/client.ts" },
        },
        mutation: false,
      }],
    };

    expect(() => validateWardenRuntimeStateTransition(completed, consumed)).not.toThrow();
    expect(() => validateWardenRuntimeStateTransition(completed, {
      ...consumed,
      modelCalls: [...consumed.modelCalls, {
        status: "failed",
        promptTokens: 20,
        completionTokens: 0,
        totalTokens: 20,
        costUsd: 0.02,
      }],
    })).toThrow("warden_runtime_state_transition_invalid:model_calls");
    expect(() => validateWardenRuntimeStateTransition(completed, {
      ...consumed,
      modelCalls: [...current.modelCalls, { ...modelAccounting, costUsd: 0.02 }],
    })).toThrow("warden_runtime_state_transition_invalid:model_calls");
    expect(() => validateWardenRuntimeStateTransition(completed, {
      ...consumed,
      events: laterModelStep.events,
    })).toThrow("warden_runtime_state_transition_invalid:model_event");
    expect(() => validateWardenRuntimeStateTransition(consumed, {
      ...laterModelStep,
      events: [...consumed.events, {
        ...laterModelStep.events.at(-1)!,
        tool: "run_command",
      }],
    })).toThrow("warden_runtime_state_transition_invalid:model_event");
    expect(() => validateWardenRuntimeStateTransition(consumed, {
      ...laterModelStep,
      events: [...consumed.events, { ...laterModelStep.events.at(-1)!, executed: false }],
    })).toThrow("warden_runtime_state_transition_invalid:model_calls");
    expect(() => validateWardenRuntimeStateTransition(consumed, {
      ...laterModelStep,
      events: [...consumed.events, {
        ...laterModelStep.events.at(-1)!,
        call: { tool: "read_file", args: { path: "src/other.ts" } },
      }],
    })).toThrow("warden_runtime_state_transition_invalid:model_event");
    expect(() => validateWardenRuntimeStateTransition(consumed, laterModelStep)).not.toThrow();
  });

  it("allows an authenticated mutation to restore a file to its source digest", () => {
    const runtime = state();
    const restored: WardenPrivateRuntimeStateV1 = {
      ...runtime,
      workspaceManifest: runtime.sourceManifest,
      events: [{
        ...runtime.events[0]!,
        call: {
          ...(runtime.events[0]!.call as Record<string, WardenRuntimeJson>),
          intent: {
            ...((runtime.events[0]!.call as Record<string, WardenRuntimeJson>)
              .intent as Record<string, WardenRuntimeJson>),
            expectedResultDigest: sourceDigest,
          },
        },
      }],
    };

    expect(projectWardenCheckpointPayload(restored, key).changedFiles).toEqual([]);
  });

  it("rejects signed public metadata that differs from the canonical private projection", async () => {
    const runtime: WardenPrivateRuntimeStateV1 = {
      ...state(),
      generation: 1,
      previousEnvelopeDigest: null,
      workspaceManifest: state().sourceManifest,
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
      rollbackPreimages: [],
      blobs: [],
      effectReceipts: [],
    };
    const encoded = encodeWardenRuntimeState(runtime);
    const projected = projectWardenCheckpointPayload(runtime, key);
    let record: Awaited<ReturnType<WardenCheckpointJournal["read"]>> = {
      envelope: null,
      sealedRuntimeState: null,
      activeWriterLeaseGeneration: runtime.writerLeaseGeneration,
    };
    const journal: WardenCheckpointJournal = {
      async read() {
        return record;
      },
      async compareAndSwap(input) {
        record = {
          envelope: input.nextEnvelope,
          sealedRuntimeState: input.nextSealedRuntimeState,
          activeWriterLeaseGeneration: record.activeWriterLeaseGeneration,
        };
        return true;
      },
    };

    await expect(commitWardenCheckpoint(
      journal,
      { ...projected, workspaceDigest: digest("forged-workspace") },
      encoded,
      key,
      binding,
    )).rejects.toThrow("warden_checkpoint_runtime_projection_mismatch");
    expect(record.envelope).toBeNull();
  });
});
