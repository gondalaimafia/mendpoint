import { describe, expect, it, vi } from "vitest";
import {
  runPolicyRoutedWarden,
  type WardenRoutingRuntimePort,
} from "./routed-agent.js";
import type { AgentRunResult } from "./types.js";

const passedRun: AgentRunResult = {
  sessionId: "run-1",
  ok: true,
  goal: "Repair API client",
  steps: [],
  filesChanged: ["src/client.ts"],
  verifier: {
    command: "npm test",
    source: "provided",
    status: "passed",
    output: "ok",
  },
  rollback: { performed: false, restoredFiles: [], failedFiles: [] },
  reportMarkdown: "verified",
  stoppedReason: "verify_passed",
  metrics: {
    durationMs: 1,
    toolCalls: 1,
    verifierCalls: 1,
    model: {
      calls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      timeouts: 0,
      invalidResponses: 0,
      responseBytes: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      provenance: [],
    },
    sourceContext: {
      observedFiles: [],
      observedDirectories: [],
      searches: [],
      observedBytes: 0,
      promptEvidenceBytes: 0,
      truncatedObservations: 0,
      groundedMutations: 0,
      blockedMutations: 0,
      evidenceDigests: [],
    },
  },
};

describe("policy routed Warden", () => {
  it("does not start Warden when policy requires a human", async () => {
    const runtime: WardenRoutingRuntimePort<{ taskId: string }> = {
      prepare: () => ({
        envelopeId: "route-1",
        action: "human_handoff",
        selectedExecutorId: null,
        reason: "high_risk",
      }),
      recordOutcome: vi.fn(),
    };

    const result = await runPolicyRoutedWarden({
      task: { goal: "Repair API client", repoRoot: "." },
      routingRequest: { taskId: "task-1" },
      runtime,
      outcomeIdempotencyKey: "task-1-run-1",
      telemetry: () => ({ actualCostUsd: null }),
    });

    expect(result.run).toBeNull();
    expect(result.routing.action).toBe("human_handoff");
  });

  it("records Warden verification and authoritative actual cost", async () => {
    const recordOutcome = vi.fn(() => ({
      envelopeId: "route-2",
      action: "completed" as const,
      selectedExecutorId: null,
    }));
    const runtime: WardenRoutingRuntimePort<{ taskId: string }> = {
      prepare: () => ({
        envelopeId: "route-2",
        action: "execute",
        selectedExecutorId: "warden-recipe",
        dispatch: {
          executorId: "warden-recipe",
          providerId: "mendpoint-internal",
        },
      }),
      recordOutcome,
    };
    const times = [
      new Date("2026-08-01T12:00:00.000Z"),
      new Date("2026-08-01T12:00:02.500Z"),
    ];

    const result = await runPolicyRoutedWarden({
      task: {
        goal: "Repair API client",
        repoRoot: ".",
        verifyCommand: "npm test",
      },
      routingRequest: { taskId: "task-2" },
      runtime,
      outcomeIdempotencyKey: "task-2-run-1",
      telemetry: () => ({
        actualCostUsd: 0.42,
        evidenceArtifactIds: ["verify-run-1"],
        verifierId: "test-command",
        verifierVersion: "vitest-3",
      }),
      executor: {
        executorId: "warden-recipe",
        providerId: "mendpoint-internal",
        run: async (_task, dispatch) => {
          expect(dispatch).toMatchObject({
            executorId: "warden-recipe",
            providerId: "mendpoint-internal",
          });
          return passedRun;
        },
      },
      now: () => times.shift()!,
    });

    expect(result.run).toBe(passedRun);
    expect(result.routing.action).toBe("completed");
    expect(recordOutcome).toHaveBeenCalledWith(
      "route-2",
      expect.objectContaining({
        executorId: "warden-recipe",
        providerId: "mendpoint-internal",
        outcome: "succeeded",
        actualLatencyMs: 2_500,
        actualCostUsd: 0.42,
        verification: {
          verdict: "passed",
          evidenceArtifactIds: ["verify-run-1"],
          verifierId: "test-command",
          verifierVersion: "vitest-3",
        },
      }),
    );
  });

  it("forwards measured token attribution through the router to recordOutcome", async () => {
    const recordOutcome = vi.fn(() => ({
      envelopeId: "route-tokens",
      action: "completed" as const,
      selectedExecutorId: null,
    }));
    const runtime: WardenRoutingRuntimePort<{ taskId: string }> = {
      prepare: () => ({
        envelopeId: "route-tokens",
        action: "execute",
        selectedExecutorId: "warden-recipe",
        dispatch: {
          executorId: "warden-recipe",
          providerId: "mendpoint-internal",
        },
      }),
      recordOutcome,
    };

    await runPolicyRoutedWarden({
      task: { goal: "Repair API client", repoRoot: "." },
      routingRequest: { taskId: "task-tokens" },
      runtime,
      outcomeIdempotencyKey: "task-tokens-run-1",
      telemetry: () => ({
        actualCostUsd: 0.0125,
        inputTokens: 900,
        outputTokens: 150,
        totalTokens: 1050,
      }),
      executor: {
        executorId: "warden-recipe",
        providerId: "mendpoint-internal",
        run: async () => passedRun,
      },
    });

    expect(recordOutcome).toHaveBeenCalledWith(
      "route-tokens",
      expect.objectContaining({
        actualCostUsd: 0.0125,
        inputTokens: 900,
        outputTokens: 150,
        totalTokens: 1050,
      }),
    );
  });

  it("records a typed failed outcome when the selected executor throws", async () => {
    const recordOutcome = vi.fn(() => ({
      envelopeId: "route-thrown",
      action: "human_handoff" as const,
      selectedExecutorId: null,
    }));
    const runtime: WardenRoutingRuntimePort<{ taskId: string }> = {
      prepare: () => ({
        envelopeId: "route-thrown",
        action: "execute",
        selectedExecutorId: "warden-model",
        dispatch: {
          executorId: "warden-model",
          providerId: "provider-a",
        },
      }),
      recordOutcome,
    };

    await expect(runPolicyRoutedWarden({
      task: { goal: "Repair API client", repoRoot: "." },
      routingRequest: { taskId: "task-thrown" },
      runtime,
      outcomeIdempotencyKey: "task-thrown-run-1",
      telemetry: () => ({ actualCostUsd: null }),
      executor: {
        executorId: "warden-model",
        providerId: "provider-a",
        run: async () => {
          throw new Error("provider_unavailable");
        },
      },
    })).rejects.toThrow("provider_unavailable");

    expect(recordOutcome).toHaveBeenCalledWith(
      "route-thrown",
      expect.objectContaining({
        outcome: "failed",
        errorCode: "provider_unavailable",
        actualCostUsd: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        verification: expect.objectContaining({ verdict: "unknown" }),
      }),
    );
  });

  it("defaults token attribution to null when telemetry omits it", async () => {
    const recordOutcome = vi.fn(() => ({
      envelopeId: "route-null-tokens",
      action: "completed" as const,
      selectedExecutorId: null,
    }));
    const runtime: WardenRoutingRuntimePort<{ taskId: string }> = {
      prepare: () => ({
        envelopeId: "route-null-tokens",
        action: "execute",
        selectedExecutorId: "warden-recipe",
        dispatch: {
          executorId: "warden-recipe",
          providerId: "mendpoint-internal",
        },
      }),
      recordOutcome,
    };

    await runPolicyRoutedWarden({
      task: { goal: "Repair API client", repoRoot: "." },
      routingRequest: { taskId: "task-null-tokens" },
      runtime,
      outcomeIdempotencyKey: "task-null-tokens-run-1",
      telemetry: () => ({ actualCostUsd: null }),
      executor: {
        executorId: "warden-recipe",
        providerId: "mendpoint-internal",
        run: async () => passedRun,
      },
    });

    expect(recordOutcome).toHaveBeenCalledWith(
      "route-null-tokens",
      expect.objectContaining({
        actualCostUsd: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      }),
    );
  });

  it("does not run a retry before its policy backoff", async () => {
    const run = vi.fn();
    const runtime: WardenRoutingRuntimePort<{ taskId: string }> = {
      prepare: () => ({
        envelopeId: "route-3",
        action: "retry",
        selectedExecutorId: "warden-recipe",
        dispatch: {
          executorId: "warden-recipe",
          providerId: "mendpoint-internal",
          notBefore: "2026-08-01T12:00:05.000Z",
        },
      }),
      recordOutcome: vi.fn(),
    };

    const result = await runPolicyRoutedWarden({
      task: { goal: "Repair API client", repoRoot: "." },
      routingRequest: { taskId: "task-3" },
      runtime,
      outcomeIdempotencyKey: "task-3-run-2",
      telemetry: () => ({ actualCostUsd: null }),
      executor: {
        executorId: "warden-recipe",
        providerId: "mendpoint-internal",
        run,
      },
      now: () => new Date("2026-08-01T12:00:04.000Z"),
    });

    expect(result.run).toBeNull();
    expect(result.routing.action).toBe("retry");
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed when no execution port is bound", async () => {
    const recordOutcome = vi.fn();
    const runtime: WardenRoutingRuntimePort<{ taskId: string }> = {
      prepare: () => ({
        envelopeId: "route-4",
        action: "execute",
        selectedExecutorId: "warden-recipe",
        dispatch: {
          executorId: "warden-recipe",
          providerId: "mendpoint-internal",
        },
      }),
      recordOutcome,
    };

    await expect(
      runPolicyRoutedWarden({
        task: { goal: "Repair API client", repoRoot: "." },
        routingRequest: { taskId: "task-4" },
        runtime,
        outcomeIdempotencyKey: "task-4-run-1",
        telemetry: () => ({ actualCostUsd: null }),
      }),
    ).rejects.toThrow("Warden routing execution port is required");
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it("fails closed when executor identity differs from the dispatch", async () => {
    const run = vi.fn(async () => passedRun);
    const recordOutcome = vi.fn();
    const runtime: WardenRoutingRuntimePort<{ taskId: string }> = {
      prepare: () => ({
        envelopeId: "route-5",
        action: "execute",
        selectedExecutorId: "warden-recipe",
        dispatch: {
          executorId: "warden-recipe",
          providerId: "mendpoint-internal",
        },
      }),
      recordOutcome,
    };

    await expect(
      runPolicyRoutedWarden({
        task: { goal: "Repair API client", repoRoot: "." },
        routingRequest: { taskId: "task-5" },
        runtime,
        outcomeIdempotencyKey: "task-5-run-1",
        telemetry: () => ({ actualCostUsd: null }),
        executor: {
          executorId: "another-executor",
          providerId: "another-provider",
          run,
        },
      }),
    ).rejects.toThrow(
      "Warden executor identity does not match the selected dispatch",
    );
    expect(run).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
  });
});
