import { describe, expect, it } from "vitest";
import {
  resolveAgentModelEndpoint,
  resolveAgentModelName,
} from "./model-endpoint.js";

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

  it("external_allowed (default) still reaches a public provider unchanged", () => {
    expect(resolveAgentModelEndpoint({ LLM_AGENT_URL: "https://api.meta.ai/v1" }))
      .toBe("https://api.meta.ai/v1/chat/completions");
    expect(resolveAgentModelEndpoint({
      MENDPOINT_MODEL_EGRESS: "external_allowed",
      LLM_AGENT_URL: "https://api.meta.ai/v1",
    })).toBe("https://api.meta.ai/v1/chat/completions");
  });
});

describe("Warden model endpoint no-egress mode", () => {
  it("accepts loopback, private, link-local, unique-local, and allowlisted hosts", () => {
    for (const host of [
      "http://127.0.0.1:8080/v1",
      "http://localhost:11434/v1",
      "http://10.1.2.3/v1",
      "http://172.16.0.9/v1",
      "http://192.168.1.5/v1",
      "http://169.254.10.20/v1",
      "http://[::1]:8000/v1",
      "http://[fc00::1]/v1",
      "http://[fe80::1]/v1",
      "http://model.local/v1",
    ]) {
      expect(resolveAgentModelEndpoint({ MENDPOINT_MODEL_EGRESS: "local_only", LLM_AGENT_URL: host }))
        .toContain("/v1/chat/completions");
    }
    expect(resolveAgentModelEndpoint({
      MENDPOINT_MODEL_EGRESS: "local_only",
      MENDPOINT_MODEL_LOCAL_HOSTS: "model.internal, other.host",
      LLM_AGENT_URL: "https://model.internal/v1",
    })).toBe("https://model.internal/v1/chat/completions");
  });

  it("rejects a public host with model_egress_local_only_violation", () => {
    expect(() => resolveAgentModelEndpoint({
      MENDPOINT_MODEL_EGRESS: "local_only",
      LLM_AGENT_URL: "https://api.meta.ai/v1",
    })).toThrow("model_egress_local_only_violation");
    expect(() => resolveAgentModelEndpoint({
      MENDPOINT_MODEL_EGRESS: "local_only",
      LLM_AGENT_URL: "https://8.8.8.8/v1",
    })).toThrow("model_egress_local_only_violation");
  });

  it("allows the heuristic-only path (no endpoint) under local_only", () => {
    expect(resolveAgentModelEndpoint({ MENDPOINT_MODEL_EGRESS: "local_only" })).toBeNull();
  });
});

describe("Warden model name resolution", () => {
  it("resolves the configured model id, including approved contributor tiers", () => {
    expect(resolveAgentModelName({ LLM_AGENT_MODEL: "muse-spark-1.2-contributor" }))
      .toBe("muse-spark-1.2-contributor");
    expect(resolveAgentModelName({ LLM_AGENT_MODEL: "  muse-spark-1.2  " }))
      .toBe("muse-spark-1.2");
    expect(resolveAgentModelName({})).toBe("gpt-4o-mini");
  });
});
