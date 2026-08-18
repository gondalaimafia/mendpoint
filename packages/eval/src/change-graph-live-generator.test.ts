import { describe, expect, it, vi } from "vitest";
import { createChangeGraphLiveGenerator } from "./change-graph-live-generator.js";

const env = {
  LLM_AGENT_URL: "https://models.example/v1",
  LLM_AGENT_MODEL: "muse-spark-1.2-contributor",
  OPENAI_API_KEY: "secret",
  MENDPOINT_CHANGE_GRAPH_BENCHMARK_LIVE: "1",
  MENDPOINT_CHANGE_GRAPH_BENCHMARK_APPROVED_MODEL: "muse-spark-1.2-contributor",
  MENDPOINT_CHANGE_GRAPH_BENCHMARK_MAX_USD: "0.01",
};

describe("Change Graph live benchmark generator", () => {
  it("uses the approved model under a bounded budget and retains content-addressed evidence", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer secret" });
      expect(JSON.parse(String(init?.body))).toMatchObject({ max_tokens: 8_192 });
      return new Response(JSON.stringify({
        id: "request-1",
        model: "muse-spark-1.2-contributor",
        choices: [{ message: { content: JSON.stringify({ entityIds: ["src/client.ts"] }) } }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "header-1" },
      });
    });
    const runtime = createChangeGraphLiveGenerator({ env, fetchImpl, now: () => 100 });

    const result = await runtime.generator({
      scenarioId: "scenario-1",
      task: "Return impacted files",
      context: "bounded synthetic context",
      arm: "graph",
    });

    expect(result.entityIds).toEqual(["src/client.ts"]);
    expect(result.deterministicAccepted).toBe(true);
    expect(result.usage.inputTokens).toBe(20);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.costUsd).toBeGreaterThan(0);
    expect(runtime.snapshot()).toMatchObject({
      model: "muse-spark-1.2-contributor",
      calls: 1,
      inputTokens: 20,
      outputTokens: 5,
    });
    expect(runtime.snapshot().receipts[0]).toMatchObject({
      scenarioId: "scenario-1",
      arm: "graph",
      bodyRequestId: "request-1",
      headerRequestId: "header-1",
    });
    expect(runtime.snapshot().receipts[0]?.requestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(runtime.snapshot().receipts[0]?.responseDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("fails before network on missing approval, model mismatch, or insufficient budget", async () => {
    const fetchImpl = vi.fn();
    expect(() => createChangeGraphLiveGenerator({
      env: { ...env, MENDPOINT_CHANGE_GRAPH_BENCHMARK_LIVE: undefined },
      fetchImpl,
    })).toThrow("change_graph_live_benchmark_not_approved");
    expect(() => createChangeGraphLiveGenerator({
      env: { ...env, MENDPOINT_CHANGE_GRAPH_BENCHMARK_APPROVED_MODEL: "other" },
      fetchImpl,
    })).toThrow("change_graph_live_benchmark_model_not_approved");
    const runtime = createChangeGraphLiveGenerator({
      env: { ...env, MENDPOINT_CHANGE_GRAPH_BENCHMARK_MAX_USD: "0.00000001" },
      fetchImpl,
    });
    await expect(runtime.generator({
      scenarioId: "scenario-1",
      task: "Return impacted files",
      context: "context",
      arm: "raw",
    })).rejects.toThrow("change_graph_live_benchmark_budget_exceeded");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed on malformed model output and charges the reserved call", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: "request-bad",
      model: "muse-spark-1.2-contributor",
      choices: [{ message: { content: "not json" } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { status: 200 }));
    const runtime = createChangeGraphLiveGenerator({ env, fetchImpl });
    await expect(runtime.generator({
      scenarioId: "scenario-bad",
      task: "Return impacted files",
      context: "context",
      arm: "raw",
    })).rejects.toThrow("change_graph_live_benchmark_content_invalid");
    expect(runtime.snapshot().spentUsd).toBeGreaterThan(0);
  });

  it("accepts structured strict-schema content from the approved OpenAI-compatible backend", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: "request-object",
      model: "muse-spark-1.2-contributor",
      choices: [{
        finish_reason: "stop",
        message: { content: { entityIds: ["src/client.ts"] } },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    }), { status: 200 }));
    const runtime = createChangeGraphLiveGenerator({ env, fetchImpl });

    await expect(runtime.generator({
      scenarioId: "scenario-object",
      task: "Return impacted files",
      context: "context",
      arm: "graph",
    })).resolves.toMatchObject({ entityIds: ["src/client.ts"] });
  });

  it("distinguishes actual-model drift from invalid provider accounting", async () => {
    const modelDrift = createChangeGraphLiveGenerator({
      env,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        model: "muse-spark-1.2",
        choices: [{ message: { content: JSON.stringify({ entityIds: [] }) } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }), { status: 200 })),
    });
    await expect(modelDrift.generator({
      scenarioId: "model-drift",
      task: "Return impacted files",
      context: "context",
      arm: "raw",
    })).rejects.toThrow("change_graph_live_benchmark_actual_model_mismatch");

    const invalidUsage = createChangeGraphLiveGenerator({
      env,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        model: "muse-spark-1.2-contributor",
        choices: [{ message: { content: JSON.stringify({ entityIds: [] }) } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 99 },
      }), { status: 200 })),
    });
    await expect(invalidUsage.generator({
      scenarioId: "invalid-usage",
      task: "Return impacted files",
      context: "context",
      arm: "raw",
    })).rejects.toThrow("change_graph_live_benchmark_usage_invalid");
  });

  it("retains a provider refusal as an explicit abstention receipt", async () => {
    const runtime = createChangeGraphLiveGenerator({
      env,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        id: "request-refused",
        model: "muse-spark-1.2-contributor",
        choices: [{ message: { content: null, refusal: { category: "policy" } } }],
        usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
      }), { status: 200 })),
    });

    await expect(runtime.generator({
      scenarioId: "scenario-refused",
      task: "Return impacted files",
      context: "context",
      arm: "raw",
    })).resolves.toMatchObject({
      entityIds: [],
      deterministicAccepted: false,
      failureCategory: "model_refused",
    });
    expect(runtime.snapshot().receipts).toHaveLength(1);
  });
});
