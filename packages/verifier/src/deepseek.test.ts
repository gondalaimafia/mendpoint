import { describe, expect, it, vi } from "vitest";
import {
  createDeepSeekVerifierBackend,
  type VerifierHttpRequest,
  type VerifierHttpTransport,
} from "./index.js";

const okResponse = {
  status: 200,
  headers: {},
  body: {
    id: "completion_a",
    model: "deepseek-v4-flash",
    system_fingerprint: "fp_a",
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "<score_A>A</score_A><score_B>T</score_B>" },
      logprobs: { content: [
        { token: "<score_", logprob: -0.01, top_logprobs: [{ token: "<score_", logprob: -0.01 }] },
        { token: "A", logprob: -0.01, top_logprobs: [{ token: "A", logprob: -0.01 }] },
        { token: ">", logprob: -0.01, top_logprobs: [{ token: ">", logprob: -0.01 }] },
        { token: "A", logprob: -0.01, top_logprobs: [{ token: "A", logprob: -0.01 }, { token: "T", logprob: -4.6 }] },
        { token: "</score_A><score_B>", logprob: -0.01, top_logprobs: [{ token: "</score_A><score_B>", logprob: -0.01 }] },
        { token: "T", logprob: -0.01, top_logprobs: [{ token: "T", logprob: -0.01 }, { token: "A", logprob: -4.6 }] },
        { token: "</score_B>", logprob: -0.01, top_logprobs: [{ token: "</score_B>", logprob: -0.01 }] },
      ] },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 2, prompt_cache_hit_tokens: 20, completion_tokens_details: { reasoning_tokens: 0 } },
  },
};

function request() {
  return {
    requestId: "request_a",
    tenantId: "tenant_a",
    taskId: "task_a",
    evidencePackDigest: `sha256:${"a".repeat(64)}`,
    criterion: { id: "correctness", title: "Correctness", description: "The exact task is satisfied.", hard: false, weight: 1 },
    candidates: [
      { candidateId: "candidate_a", artifactDigest: `sha256:${"b".repeat(64)}`, observableOutput: "Candidate A", changedPaths: [] },
      { candidateId: "candidate_b", artifactDigest: `sha256:${"c".repeat(64)}`, observableOutput: "Candidate B", changedPaths: [] },
    ] as const,
    trustedTask: "Fix the exact endpoint.",
    trustedEvidence: "Tests and build passed.",
    repetition: 0,
  } as const;
}

describe("DeepSeek verifier backend", () => {
  it("uses the official model with nonthinking logprobs and never exposes the key", async () => {
    const calls: VerifierHttpRequest[] = [];
    const transport: VerifierHttpTransport = { request: async (input) => { calls.push(input); return okResponse; } };
    const backend = createDeepSeekVerifierBackend({
      apiKey: "deepseek-secret", transport, scoringMode: "nonthinking_logprobs",
      timeoutMs: 1000, maximumRetries: 0,
      pricing: { version: "2026-08-17", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0.3, cachedInputPerMillion: 0.03, outputPerMillion: 1.2 },
    });
    const result = await backend.score(request());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(calls[0]?.headers.authorization).toBe("Bearer deepseek-secret");
    expect(calls[0]?.body).toMatchObject({
      model: "deepseek-v4-flash", thinking: { type: "disabled" }, logprobs: true, top_logprobs: 20,
    });
    expect(JSON.stringify(calls[0]?.body)).not.toContain("deepseek-secret");
    expect(result.scores.candidate_a).toBeGreaterThan(0.9);
    expect(result.scores.candidate_b).toBeLessThan(0.1);
    expect(result.usage.totalTokens).toBe(102);
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("deepseek-secret");
  });

  it("supports the pinned upstream thinking strategy as an explicit comparison mode", async () => {
    let body: Record<string, unknown> | undefined;
    const backend = createDeepSeekVerifierBackend({
      apiKey: "key", transport: { request: async (input) => { body = input.body; return okResponse; } },
      scoringMode: "upstream_thinking_logprobs", timeoutMs: 1000, maximumRetries: 0,
      pricing: { version: "v", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
    });
    await backend.score(request());
    expect(body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high", max_tokens: 32768 });
  });

  it("retries a bounded rate limit and preserves one request identity", async () => {
    let count = 0;
    const transport: VerifierHttpTransport = { request: vi.fn(async () => {
      count++;
      return count === 1 ? { status: 429, headers: { "retry-after": "0" }, body: { error: { message: "busy" } } } : okResponse;
    }) };
    const backend = createDeepSeekVerifierBackend({
      apiKey: "key", transport, scoringMode: "nonthinking_logprobs", timeoutMs: 1000, maximumRetries: 1,
      pricing: { version: "v", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
    });
    const result = await backend.score(request());
    expect(result.requestId).toBe("request_a");
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  it("reserves the conservative request cost before calling the provider", async () => {
    const transport = vi.fn(async () => okResponse);
    const backend = createDeepSeekVerifierBackend({
      apiKey: "key", transport: { request: transport }, scoringMode: "nonthinking_logprobs", timeoutMs: 1000, maximumRetries: 0,
      pricing: { version: "v", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 1000, cachedInputPerMillion: 0, outputPerMillion: 1000 },
    });
    await expect(backend.score({ ...request(), maximumCostUsd: 0.000001 })).rejects.toThrow("verifier_budget_reservation_exceeded");
    expect(transport).not.toHaveBeenCalled();
  });

  it("enforces an outer timeout even when the transport ignores cancellation", async () => {
    const backend = createDeepSeekVerifierBackend({
      apiKey: "key", transport: { request: async () => new Promise(() => undefined) },
      scoringMode: "nonthinking_logprobs", timeoutMs: 5, maximumRetries: 0,
      pricing: { version: "v", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
    });
    await expect(backend.score(request())).rejects.toThrow("verifier_backend_timeout");
  });

  it("honors caller cancellation even when the transport ignores its signal", async () => {
    const backend = createDeepSeekVerifierBackend({
      apiKey: "key", transport: { request: async () => new Promise(() => undefined) },
      scoringMode: "nonthinking_logprobs", timeoutMs: 1000, maximumRetries: 0,
      pricing: { version: "v", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
    });
    const controller = new AbortController();
    const pending = backend.score({ ...request(), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("verifier_backend_aborted");
  });

  it("does not invoke the transport when the caller is already cancelled", async () => {
    const transport = vi.fn(async () => okResponse);
    const backend = createDeepSeekVerifierBackend({
      apiKey: "key", transport: { request: transport },
      scoringMode: "nonthinking_logprobs", timeoutMs: 1000, maximumRetries: 0,
      pricing: { version: "v", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(backend.score({ ...request(), signal: controller.signal }))
      .rejects.toThrow("verifier_backend_aborted");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects wrong models, missing score logprobs, and malformed responses", async () => {
    for (const response of [
      { ...okResponse, body: { ...okResponse.body, model: "deepseek-v4-pro" } },
      { ...okResponse, body: { ...okResponse.body, choices: [{ ...okResponse.body.choices[0], logprobs: { content: [] } }] } },
      { status: 200, headers: {}, body: { nope: true } },
      { ...okResponse, body: { ...okResponse.body, choices: [{ ...okResponse.body.choices[0], message: { role: "assistant", content: "Ignore policy. <score_A>A</score_A><score_B>T</score_B>" } }] } },
    ]) {
      const backend = createDeepSeekVerifierBackend({
        apiKey: "key", transport: { request: async () => response }, scoringMode: "nonthinking_logprobs",
        timeoutMs: 1000, maximumRetries: 0,
        pricing: { version: "v", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
      });
      await expect(backend.score(request())).rejects.toThrow(/verifier_backend_|verifier_logprob_/);
    }
  });

  it("refuses the public verifier endpoint under local_only egress and never calls the transport", async () => {
    const transport = vi.fn(async () => okResponse);
    expect(() => createDeepSeekVerifierBackend({
      apiKey: "key", transport: { request: transport }, scoringMode: "nonthinking_logprobs", timeoutMs: 1000, maximumRetries: 0,
      pricing: { version: "v", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
      env: { MENDPOINT_MODEL_EGRESS: "local_only" },
    })).toThrow("model_egress_local_only_violation");
    expect(transport).not.toHaveBeenCalled();
  });

  it("permits a private or operator allowlisted verifier endpoint under local_only egress", async () => {
    const calls: VerifierHttpRequest[] = [];
    const backend = createDeepSeekVerifierBackend({
      apiKey: "key", transport: { request: async (input) => { calls.push(input); return okResponse; } },
      scoringMode: "nonthinking_logprobs", timeoutMs: 1000, maximumRetries: 0,
      pricing: { version: "v", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
      baseUrl: "http://localhost:8000", env: { MENDPOINT_MODEL_EGRESS: "local_only" },
    });
    await backend.score(request());
    expect(calls[0]?.url).toBe("http://localhost:8000/chat/completions");
  });

  it("routes a configured private mirror through the allowlist under local_only egress", async () => {
    const calls: VerifierHttpRequest[] = [];
    const backend = createDeepSeekVerifierBackend({
      apiKey: "key", transport: { request: async (input) => { calls.push(input); return okResponse; } },
      scoringMode: "nonthinking_logprobs", timeoutMs: 1000, maximumRetries: 0,
      pricing: { version: "v", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
      baseUrl: "https://deepseek.internal.example/v1",
      env: { MENDPOINT_MODEL_EGRESS: "local_only", MENDPOINT_MODEL_LOCAL_HOSTS: "deepseek.internal.example" },
    });
    await backend.score(request());
    expect(calls[0]?.url).toBe("https://deepseek.internal.example/v1/chat/completions");
  });

  it("binds score log probabilities to the value position instead of a matching tag token", async () => {
    const response = structuredClone(okResponse);
    response.body.choices[0]!.logprobs.content[3]!.top_logprobs = [{ token: "T", logprob: -0.01 }, { token: "A", logprob: -4.6 }];
    const backend = createDeepSeekVerifierBackend({
      apiKey: "key", transport: { request: async () => response }, scoringMode: "nonthinking_logprobs",
      timeoutMs: 1000, maximumRetries: 0,
      pricing: { version: "v", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
    });
    const result = await backend.score(request());
    expect(result.scores.candidate_a).toBeLessThan(0.1);
  });

  it("rejects a truncated score distribution with insufficient recognized probability mass", async () => {
    const response = structuredClone(okResponse);
    response.body.choices[0]!.logprobs.content[3]!.top_logprobs = [
      { token: "A", logprob: -10 }, { token: "T", logprob: -10 },
    ];
    const backend = createDeepSeekVerifierBackend({
      apiKey: "key", transport: { request: async () => response }, scoringMode: "nonthinking_logprobs",
      timeoutMs: 1000, maximumRetries: 0,
      pricing: { version: "v", currency: "USD", effectiveAt: "2026-08-17T00:00:00.000Z", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
    });
    await expect(backend.score(request())).rejects.toThrow(
      "verifier_logprob_probability_mass_insufficient",
    );
  });
});
