import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWarden } from "./agent.js";
import type {
  AgentExternalModelReservation,
  AgentExternalModelSettlement,
  AgentPlanner,
  AgentTask,
} from "./types.js";

const dirs: string[] = [];

function repo(): string {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-warden-accounting-agent-"));
  dirs.push(directory);
  writeFileSync(join(directory, "client.js"), "export const client = true;\n");
  writeFileSync(join(directory, "check.mjs"), "process.exit(1);\n");
  return directory;
}

function task(
  directory: string,
  planner: AgentPlanner,
  accounting?: AgentTask["externalModelAccounting"],
): AgentTask {
  return {
    goal: "inspect the API client",
    tenantId: "tenant-a",
    repoRoot: directory,
    verifyCommand: "node check.mjs",
    errorLog: "unknown failure",
    useLlm: true,
    planner,
    modelRequired: true,
    allowModelSource: true,
    modelSourcePolicy: {
      approved: true,
      tenantId: "tenant-a",
      policyDigest: `sha256:${"a".repeat(64)}`,
      provider: "provider-a",
      model: "model-a",
      endpoint: "https://models.example/v1/chat/completions",
    },
    modelBudget: { maxCalls: 1, maxOutputTokens: 200 },
    sessionId: "run-a",
    ...(accounting ? { externalModelAccounting: accounting } : {}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("Warden external model accounting boundary", () => {
  it("fails before provider dispatch when durable accounting is missing or unavailable", async () => {
    const directory = repo();
    const planner = vi.fn<AgentPlanner>(async () => ({
      call: { tool: "read_file", args: { path: "client.js" } },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.1 },
    }));

    await expect(runWarden(task(directory, planner))).rejects.toThrow(
      "warden_model_accounting_missing",
    );
    expect(planner).not.toHaveBeenCalled();

    await expect(runWarden(task(directory, planner, {
      executionScopeId: `sha256:${"b".repeat(64)}`,
      maximumCostUsd: 1,
      reserve: async () => { throw new Error("accounting_store_unavailable"); },
      settle: async () => { throw new Error("unexpected settlement"); },
    }))).rejects.toThrow("accounting_store_unavailable");
    expect(planner).not.toHaveBeenCalled();
  });

  it("reserves before dispatch and settles exact measured economics with stable provenance", async () => {
    const directory = repo();
    const events: Array<AgentExternalModelReservation | AgentExternalModelSettlement> = [];
    let reserved = false;
    const planner: AgentPlanner = async () => {
      expect(reserved).toBe(true);
      return {
        call: { tool: "read_file", args: { path: "client.js" } },
        usage: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          costUsd: 0.25,
          model: "model-a",
          modelRevision: "model-a-20260806",
        },
      };
    };
    const result = await runWarden(task(directory, planner, {
      executionScopeId: `sha256:${"b".repeat(64)}`,
      maximumCostUsd: 1,
      reserve: async (value) => { reserved = true; events.push(value); },
      settle: async (value) => { events.push(value); },
    }));

    expect(result.stoppedReason).toBe("model_call_budget_exhausted");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      reservationId: expect.stringMatching(/^wdmodel_[a-f0-9]{48}$/),
      requestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      provider: "provider-a",
      configuredModel: "model-a",
      endpointHost: "models.example",
      maximumOutputTokens: 200,
      maximumCostUsd: 1,
      callIndex: 1,
    });
    expect(events[1]).toMatchObject({
      reservationId: (events[0] as AgentExternalModelReservation).reservationId,
      status: "succeeded",
      actualModel: "model-a-20260806",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUsd: 0.25,
    });
  });

  it("conservatively settles provider failure and never hides settlement failure", async () => {
    const directory = repo();
    const settlements: AgentExternalModelSettlement[] = [];
    const failingPlanner: AgentPlanner = async () => { throw new Error("provider timed out"); };
    const result = await runWarden(task(directory, failingPlanner, {
      executionScopeId: `sha256:${"c".repeat(64)}`,
      maximumCostUsd: 0.75,
      reserve: async () => undefined,
      settle: async (value) => { settlements.push(value); },
    }));
    expect(result.stoppedReason).toBe("model_response_invalid");
    expect(settlements).toEqual([
      expect.objectContaining({ status: "failed", errorCode: "warden_model_request_failed" }),
    ]);

    await expect(runWarden(task(directory, failingPlanner, {
      executionScopeId: `sha256:${"d".repeat(64)}`,
      maximumCostUsd: 0.75,
      reserve: async () => undefined,
      settle: async () => { throw new Error("settlement_store_unavailable"); },
    }))).rejects.toThrow("settlement_store_unavailable");
  });

  it("settles an invalid direct provider response exactly once", async () => {
    const directory = repo();
    const settlements: AgentExternalModelSettlement[] = [];
    const accounting: NonNullable<AgentTask["externalModelAccounting"]> = {
      executionScopeId: `sha256:${"e".repeat(64)}`,
      maximumCostUsd: 0.75,
      reserve: async () => undefined,
      settle: async (value) => { settlements.push(value); },
    };
    const configured = task(directory, async () => ({ call: null }), accounting);
    const { planner: _planner, ...baseDirectTask } = configured;
    const directTask: AgentTask = {
      ...baseDirectTask,
      modelSourcePolicy: {
        ...baseDirectTask.modelSourcePolicy!,
        model: "muse-spark-1.2",
      },
    };
    vi.stubEnv("LLM_AGENT_URL", "https://models.example/v1");
    vi.stubEnv("LLM_AGENT_MODEL", "muse-spark-1.2");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "provider-request-a",
      model: "muse-spark-1.2",
      choices: [{ message: { content: "not-json" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { headers: { "x-request-id": "header-request-a" } })));

    const result = await runWarden(directTask);

    expect(result.stoppedReason).toBe("model_response_invalid");
    expect(settlements).toEqual([
      expect.objectContaining({
        status: "failed",
        headerRequestId: "header-request-a",
        errorCode: "warden_model_response_invalid",
      }),
    ]);
  });

  it("conservatively settles an invalid custom planner response exactly once", async () => {
    const directory = repo();
    const settlements: AgentExternalModelSettlement[] = [];
    const planner: AgentPlanner = async () => ({
      call: { tool: "read_file", args: {} } as never,
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        costUsd: 0.1,
        model: "model-a",
      },
    });

    const result = await runWarden(task(directory, planner, {
      executionScopeId: `sha256:${"f".repeat(64)}`,
      maximumCostUsd: 0.75,
      reserve: async () => undefined,
      settle: async (value) => { settlements.push(value); },
    }));

    expect(result.stoppedReason).toBe("model_response_invalid");
    expect(settlements).toEqual([
      expect.objectContaining({
        status: "failed",
        actualModel: "model-a",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUsd: 0.1,
        errorCode: "warden_model_response_invalid",
      }),
    ]);
  });
});
