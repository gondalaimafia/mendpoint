import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWarden } from "./agent.js";
import type { AgentTask } from "./types.js";

const dirs: string[] = [];

function repo(): string {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-model-gateway-"));
  dirs.push(directory);
  writeFileSync(join(directory, "client.js"), "export const client = true;\n");
  writeFileSync(join(directory, "check.mjs"), "process.exit(1);\n");
  return directory;
}

// A fully authorized task bound to a given provider/model/endpoint, mirroring the
// live-source scaffolding the agent requires for any real provider dispatch.
function gatewayTask(
  directory: string,
  policy: { provider: string; model: string; endpoint: string },
): AgentTask {
  return {
    goal: "inspect the API client",
    tenantId: "tenant-gateway",
    repoRoot: directory,
    verifyCommand: "node check.mjs",
    errorLog: "unknown failure",
    useLlm: true,
    maxSteps: 20,
    modelBudget: { maxCalls: 1 },
    allowModelSource: true,
    modelSourcePolicy: {
      approved: true,
      tenantId: "tenant-gateway",
      policyDigest: `sha256:${"a".repeat(64)}`,
      provider: policy.provider,
      model: policy.model,
      endpoint: policy.endpoint,
    },
    externalModelAccounting: {
      executionScopeId: `sha256:${"b".repeat(64)}`,
      maximumCostUsd: 10,
      reserve: async () => undefined,
      settle: async () => undefined,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("multi-provider gateway end-to-end (native Anthropic adapter, mock server)", () => {
  it("translates the outbound request to the Messages API and parses the native response", async () => {
    const directory = repo();
    vi.stubEnv("MENDPOINT_MODEL_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    // Transmit the same model the policy approves and the mock server echoes.
    vi.stubEnv("LLM_AGENT_MODEL", "claude-3-5-sonnet-latest");

    // Mock server: capture the request the gateway sent, then reply with a native
    // Messages API response carrying a valid tool call.
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        id: "msg-live-1",
        model: "claude-3-5-sonnet-latest",
        content: [{ type: "text", text: JSON.stringify({
          tool: "read_file",
          args: { path: "client.js" },
          thought: "inspect the client",
        }) }],
        usage: { input_tokens: 200, output_tokens: 80 },
      }), { headers: { "content-type": "application/json", "x-request-id": "req-ant-1" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runWarden(gatewayTask(directory, {
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      endpoint: "https://api.anthropic.com/v1/messages",
    }));

    // Budget of 1 model call: the parsed read_file tool call runs, then the
    // budget is exhausted — the same terminal state the OpenAI path reaches.
    expect(result.stoppedReason).toBe("model_call_budget_exhausted");

    // Outbound translation: native Anthropic endpoint + header auth + body shape.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.Authorization).toBeUndefined();
    const sentBody = JSON.parse(String(seen[0]!.init.body));
    expect(sentBody.model).toBe("claude-3-5-sonnet-latest");
    expect(sentBody.system).toContain("Reply with JSON only");
    expect(sentBody.messages[0]).toMatchObject({ role: "user" });

    // Inbound translation: provenance captured the parsed Messages response and
    // attributed it to the selected provider with per-provider pricing.
    expect(result.metrics.model.provenance).toHaveLength(1);
    const record = result.metrics.model.provenance[0]!;
    expect(record.providerId).toBe("anthropic");
    expect(record.model).toBe("claude-3-5-sonnet-latest");
    expect(record.promptTokens).toBe(200);
    expect(record.completionTokens).toBe(80);
    expect(record.totalTokens).toBe(280);
    expect(record.host).toBe("api.anthropic.com");
    // Anthropic price table: 200*3 + 80*15 per million.
    expect(record.costUsd).toBeCloseTo((200 * 3 + 80 * 15) / 1_000_000, 12);
    expect(result.metrics.model.successfulCalls).toBe(1);
  });

  it("fails closed on an unknown provider id before any dispatch", async () => {
    const directory = repo();
    vi.stubEnv("MENDPOINT_MODEL_PROVIDER", "not-a-real-provider");
    vi.stubEnv("OPENAI_API_KEY", "k");
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runWarden(gatewayTask(directory, {
      provider: "whatever",
      model: "whatever-model",
      endpoint: "https://example.invalid/v1/chat/completions",
    }))).rejects.toThrow("warden_model_provider_unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
