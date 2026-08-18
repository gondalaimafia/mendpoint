/**
 * Warden trajectory capture (Intelligence Ownership Phases 4 + 7). Evidence that
 * the producer:
 *  - captures the observable (input -> output) surface and tool calls,
 *  - records the model that ACTUALLY answered (provider echo),
 *  - NEVER carries hidden chain-of-thought (spec 8.12),
 *  - degrades safely instead of throwing on the hot path.
 */
import { describe, expect, it } from "vitest";
import type { AgentRunResult, AgentStep } from "./types.js";
import {
  buildWardenAttemptCapture,
  wardenAvailableTools,
} from "./trajectory-capture.js";

const SECRET_THOUGHT = "PRIVATE_REASONING_THAT_MUST_NEVER_BE_STORED";

function step(overrides: Partial<AgentStep> & { call: AgentStep["call"] }): AgentStep {
  return {
    step: 1,
    thought: SECRET_THOUGHT,
    result: { ok: true, tool: overrides.call.tool, summary: "ok" },
    ...overrides,
  };
}

function agentResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    sessionId: "sess-1",
    ok: true,
    goal: "fix the failing endpoint",
    steps: [],
    filesChanged: [],
    verifier: { command: "npm test", source: "provided", status: "passed" },
    rollback: { performed: false, restoredFiles: [], failedFiles: [] },
    reportMarkdown: `### Report\n- *${SECRET_THOUGHT}* -> write_file`,
    stoppedReason: "verified",
    missionPlan: null,
    metrics: {
      durationMs: 4200,
      toolCalls: 0,
      verifierCalls: 1,
      model: {
        calls: 1,
        successfulCalls: 1,
        failedCalls: 0,
        timeouts: 0,
        invalidResponses: 0,
        responseBytes: 512,
        promptTokens: 100,
        completionTokens: 40,
        totalTokens: 140,
        costUsd: 0.0021,
        provenance: [
          {
            providerId: "muse",
            bodyRequestId: "body-1",
            headerRequestId: "hdr-1",
            model: "muse-spark-1.2-contributor",
            promptTokens: 100,
            completionTokens: 40,
            totalTokens: 140,
            host: "gateway.example",
            protocol: "https:",
            costUsd: 0.0021,
            monotonicTimestampMs: 1,
          },
        ],
      },
      sourceContext: {
        observedFiles: ["src/api.ts"],
        observedDirectories: ["src"],
        searches: ["fetch("],
        observedBytes: 1024,
        promptEvidenceBytes: 800,
        truncatedObservations: 0,
        groundedMutations: 1,
        blockedMutations: 0,
        evidenceDigests: [{ path: "src/api.ts", digest: "deadbeef" }],
      },
    },
    ...overrides,
  };
}

describe("wardenAvailableTools", () => {
  it("excludes http_probe without network and mutations under dry run", () => {
    const attempt = wardenAvailableTools({ allowNetwork: false, dryRun: false });
    expect(attempt).not.toContain("http_probe");
    expect(attempt).toContain("write_file");

    const dry = wardenAvailableTools({ allowNetwork: true, dryRun: true });
    expect(dry).toContain("http_probe");
    expect(dry).not.toContain("write_file");
    expect(dry).not.toContain("delete_file");
  });
});

describe("buildWardenAttemptCapture", () => {
  const agent = agentResult({
    steps: [
      step({
        call: { tool: "read_file", args: { path: "src/api.ts" }, thought: SECRET_THOUGHT },
        result: { ok: true, tool: "read_file", summary: "read 40 lines", data: "const x = 1;" },
        plannerSource: "model",
      }),
      step({
        call: {
          tool: "write_file",
          args: { path: "src/api.ts", content: "const x = 2;" },
          thought: SECRET_THOUGHT,
        },
        result: { ok: true, tool: "write_file", summary: "wrote src/api.ts" },
        plannerSource: "model",
      }),
    ],
    filesChanged: ["src/api.ts"],
  });

  const capture = buildWardenAttemptCapture({
    agent,
    goal: agent.goal,
    taskMode: "repair",
    verifyCommand: "npm test",
    availableTools: wardenAvailableTools({ allowNetwork: false, dryRun: false }),
    runId: "sess-1",
    sandboxBackend: "local",
    status: "succeeded",
    changedPaths: ["src/api.ts"],
    candidateDigest: "cand-digest",
    changedFiles: [{ path: "src/api.ts", content: "const x = 2;" }],
    verifications: [
      { verdict: "passed", exitCode: 0, command: "npm test", sandboxBackend: "local" },
    ],
  });

  it("records the model that actually answered (provider echo), not a requested id", () => {
    expect(capture.modelId).toBe("muse-spark-1.2-contributor");
    expect(capture.modelMeasured).toBe(true);
    expect(capture.costUsd).toBeCloseTo(0.0021);
    expect(capture.modelProvenance[0]?.model).toBe("muse-spark-1.2-contributor");
  });

  it("captures every tool call with observable args and results", () => {
    expect(capture.toolSteps).toHaveLength(2);
    expect(capture.toolSteps[0]?.toolName).toBe("read_file");
    expect(capture.toolSteps[1]?.toolName).toBe("write_file");
    expect(capture.toolSteps[1]?.args).toContain("const x = 2;");
    expect(capture.toolSteps[0]?.result).toContain("read 40 lines");
    expect(capture.toolSteps[0]?.plannerSource).toBe("model");
  });

  it("carries the observable (input -> output) surface", () => {
    expect(capture.assembledContext).toContain("fix the failing endpoint");
    expect(capture.assembledContext).toContain("src/api.ts");
    expect(capture.output).toContain("succeeded");
    expect(capture.output).toContain("const x = 2;");
    expect(capture.finalOutcome).toBe("candidate_ready");
  });

  it("never carries hidden chain-of-thought or reportMarkdown", () => {
    const serialized = JSON.stringify(capture);
    expect(serialized).not.toContain(SECRET_THOUGHT);
    expect(serialized).not.toContain("### Report");
  });

  it("reports no model-mediated pair for a heuristic-only run", () => {
    const heuristic = agentResult({
      metrics: {
        ...agent.metrics,
        model: { ...agent.metrics.model, calls: 0, successfulCalls: 0, provenance: [] },
      },
    });
    const built = buildWardenAttemptCapture({
      agent: heuristic,
      goal: heuristic.goal,
      taskMode: "repair",
      verifyCommand: "npm test",
      availableTools: [],
      runId: null,
      sandboxBackend: "local",
      status: "rejected",
      code: "warden_attempt_agent_failed",
    });
    expect(built.modelId).toBeNull();
    expect(built.modelMeasured).toBe(false);
    expect(built.costUsd).toBeNull();
    expect(built.finalOutcome).toBe("rejected:warden_attempt_agent_failed");
  });
});
