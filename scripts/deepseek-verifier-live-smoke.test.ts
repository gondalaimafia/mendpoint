import { describe, expect, it, vi } from "vitest";
import {
  runDeepSeekVerifierLiveSmoke,
  type DeepSeekVerifierLiveSmokeReport,
} from "./deepseek-verifier-live-smoke.js";

describe("DeepSeek verifier live smoke", () => {
  it("uses the bounded nonthinking logprob path and returns only sanitized evidence", async () => {
    const request = vi.fn(async (input: { body: Readonly<Record<string, unknown>> }) => ({
      status: 200,
      headers: {},
      body: {
        id: "response-a",
        model: "deepseek-v4-flash",
        system_fingerprint: "fp-a",
        choices: [{
          finish_reason: "stop",
          message: { content: "<score>A</score>" },
          logprobs: { content: [
            { token: "<score>", logprob: -0.01, top_logprobs: [{ token: "<score>", logprob: -0.01 }] },
            { token: "A", logprob: -0.01, top_logprobs: [{ token: "A", logprob: -0.01 }, { token: "T", logprob: -5 }] },
            { token: "</score>", logprob: -0.01, top_logprobs: [{ token: "</score>", logprob: -0.01 }] },
          ] },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 3, prompt_cache_hit_tokens: 0 },
      },
    }));
    const env = {
      DEEPSEEK_VERIFIER_ENABLED: "true",
      DEEPSEEK_API_KEY: "never-print-this-key",
      MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE: "shadow",
      MENDPOINT_AGENT_VERIFIER_SCORING_MODE: "nonthinking_logprobs",
      MENDPOINT_AGENT_VERIFIER_EVALUATIONS: "1",
      MENDPOINT_AGENT_VERIFIER_PIVOTS: "1",
      MENDPOINT_AGENT_VERIFIER_MAXIMUM_CANDIDATES: "1",
      MENDPOINT_AGENT_VERIFIER_MAXIMUM_COST_USD: "0.05",
      MENDPOINT_AGENT_VERIFIER_TIMEOUT_MS: "8000",
      MENDPOINT_AGENT_VERIFIER_MAXIMUM_RETRIES: "0",
      MENDPOINT_AGENT_VERIFIER_PRICING_JSON: JSON.stringify({
        version: "deepseek-v4-flash-2026-08-21",
        currency: "USD",
        effectiveAt: "2026-08-21T00:00:00.000Z",
        inputPerMillion: 0.14,
        cachedInputPerMillion: 0.0028,
        outputPerMillion: 0.28,
      }),
    };

    const report: DeepSeekVerifierLiveSmokeReport = await runDeepSeekVerifierLiveSmoke({
      env,
      observedAt: "2026-08-22T20:00:00.000Z",
      transport: { request },
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0].body).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "disabled" },
      logprobs: true,
      top_logprobs: 20,
    });
    expect(report).toMatchObject({
      model: "deepseek-v4-flash",
      scoringMode: "nonthinking_logprobs",
      status: "verified",
      recommendation: "ready_for_review",
      selectedCandidateId: "candidate-correct",
    });
    expect(JSON.stringify(report)).not.toContain("never-print-this-key");
  });
});
