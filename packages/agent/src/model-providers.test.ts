import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_ID,
  modelProvider,
  registeredModelProviderIds,
  resolveModelBackend,
  resolveProviderEndpoint,
} from "./model-providers.js";
import { DEFAULT_MODEL_PRICE_TABLE, computeModelCostUsd } from "./model-provenance.js";

describe("multi-provider gateway: default (env unset) backend", () => {
  it("preserves today's OpenAI-compatible resolution byte-for-byte", () => {
    const backend = resolveModelBackend({
      LLM_AGENT_URL: "https://models.example/v1",
      OPENAI_API_KEY: "test-key",
      LLM_AGENT_MODEL: "muse-spark-1.2",
    });
    expect(backend).not.toBeNull();
    expect(backend!.providerId).toBe(DEFAULT_PROVIDER_ID);
    expect(backend!.wireFormat).toBe("openai");
    expect(backend!.transport).toBe("native");
    // Identical to resolveAgentModelEndpoint(): appends /chat/completions to /v1.
    expect(backend!.endpoint).toBe("https://models.example/v1/chat/completions");
    expect(backend!.apiKey).toBe("test-key");
    expect(backend!.model).toBe("muse-spark-1.2");
    expect(backend!.priceTable).toBe(DEFAULT_MODEL_PRICE_TABLE);
  });

  it("falls back to gpt-4o-mini and XAI_API_KEY exactly like the legacy path", () => {
    const backend = resolveModelBackend({
      OPENAI_BASE_URL: "https://models.example/custom",
      XAI_API_KEY: "xai-key",
    });
    expect(backend!.endpoint).toBe("https://models.example/custom/v1/chat/completions");
    expect(backend!.apiKey).toBe("xai-key");
    expect(backend!.model).toBe("gpt-4o-mini");
  });

  it("returns null (unavailable) when no endpoint or key is configured", () => {
    expect(resolveModelBackend({})).toBeNull();
    expect(resolveModelBackend({ LLM_AGENT_URL: "https://models.example/v1" })).toBeNull();
    expect(resolveModelBackend({ OPENAI_API_KEY: "k" })).toBeNull();
  });

  it("still enforces the legacy HTTPS-in-production and credential rules", () => {
    expect(() => resolveModelBackend({
      NODE_ENV: "production",
      LLM_AGENT_URL: "http://models.example/v1",
      OPENAI_API_KEY: "k",
    })).toThrow("warden_model_endpoint_https_required");
  });
});

describe("multi-provider gateway: named OpenAI-compatible providers", () => {
  it("resolves the OpenAI provider endpoint, auth, and default model", () => {
    const backend = resolveModelBackend({
      MENDPOINT_MODEL_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-openai",
    });
    expect(backend!.providerId).toBe("openai");
    expect(backend!.wireFormat).toBe("openai");
    expect(backend!.transport).toBe("native");
    expect(backend!.endpoint).toBe("https://api.openai.com/v1/chat/completions");
    expect(backend!.apiKey).toBe("sk-openai");
    expect(backend!.model).toBe("gpt-4o-mini");
  });

  it("resolves the xAI/Grok provider from XAI_API_KEY", () => {
    const backend = resolveModelBackend({
      MENDPOINT_MODEL_PROVIDER: "xai",
      XAI_API_KEY: "xai-key",
    });
    expect(backend!.providerId).toBe("xai");
    expect(backend!.endpoint).toBe("https://api.x.ai/v1/chat/completions");
    expect(backend!.apiKey).toBe("xai-key");
    expect(backend!.model).toBe("grok-2-latest");
  });

  it("marks the generic OpenAI-compatible gateway as gateway-fronted and needs a base URL", () => {
    const gateway = modelProvider("openai-gateway");
    expect(gateway!.transport).toBe("gateway");
    // No base URL configured => unavailable, not a crash.
    expect(resolveModelBackend({
      MENDPOINT_MODEL_PROVIDER: "openai-gateway",
      OPENAI_API_KEY: "k",
    })).toBeNull();
    const backend = resolveModelBackend({
      MENDPOINT_MODEL_PROVIDER: "openai-gateway",
      LLM_AGENT_URL: "https://gateway.internal/proxy/v1",
      OPENAI_API_KEY: "k",
    });
    expect(backend!.endpoint).toBe("https://gateway.internal/proxy/v1/chat/completions");
    expect(backend!.transport).toBe("gateway");
  });

  it("honors LLM_AGENT_MODEL overriding a provider default", () => {
    const backend = resolveModelBackend({
      MENDPOINT_MODEL_PROVIDER: "openai",
      OPENAI_API_KEY: "k",
      LLM_AGENT_MODEL: "gpt-4o",
    });
    expect(backend!.model).toBe("gpt-4o");
  });
});

describe("multi-provider gateway: native non-OpenAI providers", () => {
  it("resolves the Anthropic Messages API endpoint and auth", () => {
    const backend = resolveModelBackend({
      MENDPOINT_MODEL_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant",
    });
    expect(backend!.wireFormat).toBe("anthropic");
    expect(backend!.transport).toBe("native");
    expect(backend!.endpoint).toBe("https://api.anthropic.com/v1/messages");
    expect(backend!.apiKey).toBe("sk-ant");
    expect(backend!.model).toBe("claude-3-5-sonnet-latest");
  });

  it("resolves the Gemini generateContent endpoint with the model in the path", () => {
    const backend = resolveModelBackend({
      MENDPOINT_MODEL_PROVIDER: "gemini",
      GEMINI_API_KEY: "g-key",
    });
    expect(backend!.wireFormat).toBe("gemini");
    expect(backend!.endpoint).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
    );
    expect(backend!.apiKey).toBe("g-key");
  });

  it("rebuilds the Gemini path when LLM_AGENT_MODEL overrides the model", () => {
    const provider = modelProvider("gemini")!;
    expect(resolveProviderEndpoint(provider, "https://generativelanguage.googleapis.com", "gemini-1.5-pro"))
      .toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent");
  });
});

describe("multi-provider gateway: fail-closed and pricing", () => {
  it("throws on an unknown provider id rather than silently defaulting", () => {
    expect(() => resolveModelBackend({
      MENDPOINT_MODEL_PROVIDER: "not-a-provider",
      OPENAI_API_KEY: "k",
    })).toThrow("warden_model_provider_unknown");
  });

  it("keys pricing per provider and returns honest null for unpriced models", () => {
    const museSpark = resolveModelBackend({
      MENDPOINT_MODEL_PROVIDER: "muse-spark",
      LLM_AGENT_URL: "https://models.example/v1",
      OPENAI_API_KEY: "k",
      LLM_AGENT_MODEL: "muse-spark-1.2",
    });
    expect(computeModelCostUsd("muse-spark-1.2", 1_000, 1_000, museSpark!.priceTable))
      .toBeCloseTo((1_000 * 1.25 + 1_000 * 4.25) / 1_000_000, 12);

    // OpenAI provider prices its own model from its own table...
    const openai = resolveModelBackend({ MENDPOINT_MODEL_PROVIDER: "openai", OPENAI_API_KEY: "k" });
    expect(computeModelCostUsd("gpt-4o-mini", 1_000_000, 1_000_000, openai!.priceTable))
      .toBeCloseTo(0.15 + 0.6, 10);
    // ...but a model it does not carry resolves to null, never a guess.
    expect(computeModelCostUsd("muse-spark-1.2", 1_000, 1_000, openai!.priceTable)).toBeNull();

    // The generic OpenAI-compatible gateway ships unpriced: cost is honestly
    // null until an operator configures the fronted model's rate.
    const gateway = resolveModelBackend({
      MENDPOINT_MODEL_PROVIDER: "openai-gateway",
      LLM_AGENT_URL: "https://gateway.internal/v1",
      OPENAI_API_KEY: "k",
    });
    expect(computeModelCostUsd("gpt-4o-mini", 1_000, 1_000, gateway!.priceTable)).toBeNull();
  });

  it("registers exactly the documented providers", () => {
    expect(registeredModelProviderIds()).toEqual([
      "muse-spark",
      "openai",
      "xai",
      "openai-gateway",
      "anthropic",
      "gemini",
    ]);
  });
});

describe("multi-provider gateway: local_only egress enforcement on the provider path", () => {
  // Auth env per provider so resolution reaches endpoint construction rather
  // than returning null on a missing key.
  const authFor: Record<string, Record<string, string>> = {
    "muse-spark": { OPENAI_API_KEY: "k" },
    openai: { OPENAI_API_KEY: "k" },
    xai: { XAI_API_KEY: "k" },
    "openai-gateway": { OPENAI_API_KEY: "k" },
    anthropic: { ANTHROPIC_API_KEY: "k" },
    gemini: { GEMINI_API_KEY: "k" },
  };
  // Providers that ship a hardcoded public default base URL: naming them under
  // local_only WITHOUT a base-URL env var must still be refused (the default is
  // exercised and is a public host).
  const publicDefaultProviders = ["openai", "xai", "anthropic", "gemini"] as const;
  // Providers with no default base URL: they need an explicit base URL to reach
  // a host, so a public one is supplied to exercise the same enforcement.
  const baseUrlRequiredProviders = ["muse-spark", "openai-gateway"] as const;

  it("refuses every named provider's public host under local_only via model_egress_local_only_violation", () => {
    for (const id of publicDefaultProviders) {
      expect(() => resolveModelBackend({
        MENDPOINT_MODEL_EGRESS: "local_only",
        MENDPOINT_MODEL_PROVIDER: id,
        ...authFor[id],
      })).toThrow("model_egress_local_only_violation");
    }
    for (const id of baseUrlRequiredProviders) {
      expect(() => resolveModelBackend({
        MENDPOINT_MODEL_EGRESS: "local_only",
        MENDPOINT_MODEL_PROVIDER: id,
        LLM_AGENT_URL: "https://api.public.example/v1",
        ...authFor[id],
      })).toThrow("model_egress_local_only_violation");
    }
  });

  it("still resolves a private, loopback, or allowlisted host for a named provider under local_only", () => {
    // Private/loopback base URL for a public-default provider (Anthropic).
    const anthropic = resolveModelBackend({
      MENDPOINT_MODEL_EGRESS: "local_only",
      MENDPOINT_MODEL_PROVIDER: "anthropic",
      ANTHROPIC_BASE_URL: "http://localhost:8000",
      ANTHROPIC_API_KEY: "k",
    });
    expect(anthropic!.endpoint).toBe("http://localhost:8000/v1/messages");

    // Operator allowlist works identically on the provider path (Gemini).
    const gemini = resolveModelBackend({
      MENDPOINT_MODEL_EGRESS: "local_only",
      MENDPOINT_MODEL_PROVIDER: "gemini",
      GEMINI_BASE_URL: "https://gemini.internal/v1beta",
      MENDPOINT_MODEL_LOCAL_HOSTS: "gemini.internal",
      GEMINI_API_KEY: "k",
    });
    expect(gemini!.endpoint).toBe(
      "https://gemini.internal/v1beta/models/gemini-1.5-flash:generateContent",
    );

    // Self-hosted OpenAI-compatible gateway on a private host.
    const gateway = resolveModelBackend({
      MENDPOINT_MODEL_EGRESS: "local_only",
      MENDPOINT_MODEL_PROVIDER: "openai-gateway",
      LLM_AGENT_URL: "http://127.0.0.1:11434/v1",
      OPENAI_API_KEY: "k",
    });
    expect(gateway!.endpoint).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });

  it("leaves external_allowed (the default) reaching a named provider's public host unchanged", () => {
    const openai = resolveModelBackend({ MENDPOINT_MODEL_PROVIDER: "openai", OPENAI_API_KEY: "k" });
    expect(openai!.endpoint).toBe("https://api.openai.com/v1/chat/completions");
    const anthropic = resolveModelBackend({
      MENDPOINT_MODEL_EGRESS: "external_allowed",
      MENDPOINT_MODEL_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "k",
    });
    expect(anthropic!.endpoint).toBe("https://api.anthropic.com/v1/messages");
  });
});
