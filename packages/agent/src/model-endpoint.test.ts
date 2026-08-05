import { describe, expect, it } from "vitest";
import { resolveAgentModelEndpoint } from "./model-endpoint.js";

describe("Warden model endpoint", () => {
  it("normalizes the exact chat completion destination", () => {
    expect(resolveAgentModelEndpoint({ LLM_AGENT_URL: "https://models.example/v1/" }))
      .toBe("https://models.example/v1/chat/completions");
    expect(resolveAgentModelEndpoint({ OPENAI_BASE_URL: "https://models.example/custom" }))
      .toBe("https://models.example/custom/v1/chat/completions");
  });

  it("requires HTTPS in production and rejects embedded credentials", () => {
    expect(() => resolveAgentModelEndpoint({
      NODE_ENV: "production",
      LLM_AGENT_URL: "http://models.example/v1",
    })).toThrow("warden_model_endpoint_https_required");
    expect(() => resolveAgentModelEndpoint({
      LLM_AGENT_URL: "https://user:secret@models.example/v1",
    })).toThrow("warden_model_endpoint_invalid");
  });

  it("returns null when no provider endpoint is configured", () => {
    expect(resolveAgentModelEndpoint({})).toBeNull();
  });
});
