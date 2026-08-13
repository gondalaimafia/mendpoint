import { describe, expect, it } from "vitest";
import {
  assertBackendAllowedForTenant,
  customerModelRoutingEnabled,
  isTrainingTierBackend,
  isTrainingTierModel,
  parseTenantAllowlist,
  resolveNonTrainingModelBackend,
  resolveTenantModelBackend,
  resolveTenantModelTier,
  trainingTierModelSet,
  TRAINING_TIER_FORBIDDEN_ERROR,
} from "./model-tenant-routing.js";
import { DEFAULT_MODEL_PRICE_TABLE } from "./model-provenance.js";
import type { ResolvedModelBackend } from "./model-providers.js";

// The deployment's contributor (training) tier, served by the muse-spark provider.
const CONTRIBUTOR_ENV = Object.freeze({
  MENDPOINT_MODEL_PROVIDER: "muse-spark",
  LLM_AGENT_URL: "https://models.example/v1",
  OPENAI_API_KEY: "test-key",
  LLM_AGENT_MODEL: "muse-spark-1.2-contributor",
});

function trainingBackend(model = "muse-spark-1.2-contributor"): ResolvedModelBackend {
  return Object.freeze({
    providerId: "muse-spark",
    wireFormat: "openai",
    transport: "native",
    endpoint: "https://models.example/v1/chat/completions",
    apiKey: "test-key",
    model,
    priceTable: DEFAULT_MODEL_PRICE_TABLE,
  });
}

describe("customer routing master switch (default-safe)", () => {
  it("is off by default and for any non-enabling value", () => {
    expect(customerModelRoutingEnabled({})).toBe(false);
    expect(customerModelRoutingEnabled({ MENDPOINT_CUSTOMER_MODEL_ROUTING: "off" })).toBe(false);
    expect(customerModelRoutingEnabled({ MENDPOINT_CUSTOMER_MODEL_ROUTING: "0" })).toBe(false);
    expect(customerModelRoutingEnabled({ MENDPOINT_CUSTOMER_MODEL_ROUTING: "" })).toBe(false);
  });

  it("is on for the documented enabling values", () => {
    for (const value of ["on", "1", "true", "enabled", "yes", "  ON  "]) {
      expect(customerModelRoutingEnabled({ MENDPOINT_CUSTOMER_MODEL_ROUTING: value })).toBe(true);
    }
  });
});

describe("training-tier model classification (fail-closed union)", () => {
  it("always classifies the built-in contributor tier as training", () => {
    expect(isTrainingTierModel("muse-spark-1.2-contributor", {})).toBe(true);
    // A configured extras list can only ADD ids; it can never declassify the default.
    expect(isTrainingTierModel("muse-spark-1.2-contributor", { MENDPOINT_TRAINING_TIER_MODELS: "other" })).toBe(true);
    expect(trainingTierModelSet({ MENDPOINT_TRAINING_TIER_MODELS: "other-train" }))
      .toEqual(new Set(["muse-spark-1.2-contributor", "other-train"]));
  });

  it("does not classify the non-contributor tier or generic models as training", () => {
    expect(isTrainingTierModel("muse-spark-1.2", {})).toBe(false);
    expect(isTrainingTierModel("gpt-4o-mini", {})).toBe(false);
    expect(isTrainingTierBackend(trainingBackend("muse-spark-1.2"), {})).toBe(false);
    expect(isTrainingTierBackend(trainingBackend(), {})).toBe(true);
  });
});

describe("per-tenant tier resolution + allowlist", () => {
  it("defaults every tenant to non_training, and unbound calls fail safe to non_training", () => {
    expect(resolveTenantModelTier("cust-1", {})).toBe("non_training");
    expect(resolveTenantModelTier(undefined, {})).toBe("non_training");
    expect(resolveTenantModelTier("   ", {})).toBe("non_training");
  });

  it("marks only explicitly allowlisted internal tenants training_allowed", () => {
    const env = { MENDPOINT_TRAINING_TIER_TENANTS: "founder-internal, ops-internal" };
    expect(resolveTenantModelTier("founder-internal", env)).toBe("training_allowed");
    expect(resolveTenantModelTier("ops-internal", env)).toBe("training_allowed");
    expect(resolveTenantModelTier("cust-1", env)).toBe("non_training");
  });

  it("parses a comma/space separated, case-sensitive allowlist", () => {
    expect(parseTenantAllowlist("a, b  c\nd")).toEqual(new Set(["a", "b", "c", "d"]));
    expect(parseTenantAllowlist(undefined)).toEqual(new Set());
    expect(parseTenantAllowlist("Founder")).not.toContain("founder");
  });
});

describe("fail-closed guard: customer tenant can never reach a training tier", () => {
  it("throws when a non-training tenant would be served a training-tier backend", () => {
    expect(() => assertBackendAllowedForTenant("cust-1", trainingBackend(), {})).toThrow(
      TRAINING_TIER_FORBIDDEN_ERROR,
    );
  });

  it("does not throw for an allowlisted internal tenant on the training tier", () => {
    expect(() =>
      assertBackendAllowedForTenant("founder-internal", trainingBackend(), {
        MENDPOINT_TRAINING_TIER_TENANTS: "founder-internal",
      }),
    ).not.toThrow();
  });

  it("does not throw for a customer tenant on a non-training backend, nor on a null backend", () => {
    expect(() => assertBackendAllowedForTenant("cust-1", trainingBackend("muse-spark-1.2"), {})).not.toThrow();
    expect(() => assertBackendAllowedForTenant("cust-1", null, {})).not.toThrow();
  });

  it("end-to-end: routing a customer tenant to a training tier throws", () => {
    // Customer routing on, no non-training provider configured, base tier is the
    // contributor training tier: the customer cannot silently use it.
    expect(() =>
      resolveTenantModelBackend("cust-1", {
        ...CONTRIBUTOR_ENV,
        MENDPOINT_CUSTOMER_MODEL_ROUTING: "on",
      }),
    ).toThrow(TRAINING_TIER_FORBIDDEN_ERROR);
  });
});

describe("routing: customer tenant selects a non-training provider", () => {
  it("resolves a customer tenant to the config-supplied non-training provider (not the contributor tier)", () => {
    const backend = resolveTenantModelBackend("cust-1", {
      // Deployment base tier is the contributor (training) provider...
      MENDPOINT_MODEL_PROVIDER: "muse-spark",
      MENDPOINT_CUSTOMER_MODEL_ROUTING: "on",
      // ...but the customer is routed to the config-supplied non-training endpoint
      // (keys are real operator config, not faked).
      MENDPOINT_NON_TRAINING_MODEL_PROVIDER: "openai-gateway",
      LLM_AGENT_URL: "https://non-training.internal/v1",
      OPENAI_API_KEY: "operator-supplied-key",
    });
    expect(backend).not.toBeNull();
    expect(backend!.providerId).toBe("openai-gateway");
    expect(backend!.endpoint).toBe("https://non-training.internal/v1/chat/completions");
    expect(backend!.model).toBe("gpt-4o-mini");
    expect(isTrainingTierBackend(backend!, {})).toBe(false);
  });

  it("still throws if the non-training provider is misconfigured onto the contributor model id", () => {
    // Guard is model-id based: even routed to openai-gateway, an LLM_AGENT_MODEL
    // that forces the contributor tier is caught, not silently served.
    expect(() =>
      resolveTenantModelBackend("cust-1", {
        MENDPOINT_CUSTOMER_MODEL_ROUTING: "on",
        MENDPOINT_NON_TRAINING_MODEL_PROVIDER: "openai-gateway",
        LLM_AGENT_URL: "https://non-training.internal/v1",
        OPENAI_API_KEY: "operator-supplied-key",
        LLM_AGENT_MODEL: "muse-spark-1.2-contributor",
      }),
    ).toThrow(TRAINING_TIER_FORBIDDEN_ERROR);
  });

  it("resolves to null (unavailable) — never a fabricated key — when the non-training endpoint is not yet configured", () => {
    const backend = resolveTenantModelBackend("cust-1", {
      MENDPOINT_CUSTOMER_MODEL_ROUTING: "on",
      MENDPOINT_NON_TRAINING_MODEL_PROVIDER: "openai-gateway",
      // No base URL / key for the non-training provider => unavailable, not fake.
    });
    expect(backend).toBeNull();
  });

  it("resolveNonTrainingModelBackend overrides the active provider with the non-training one", () => {
    const backend = resolveNonTrainingModelBackend({
      MENDPOINT_MODEL_PROVIDER: "muse-spark",
      MENDPOINT_NON_TRAINING_MODEL_PROVIDER: "openai",
      OPENAI_API_KEY: "k",
    });
    expect(backend!.providerId).toBe("openai");
    expect(backend!.model).toBe("gpt-4o-mini");
  });
});

describe("internal tenant MAY use the contributor tier", () => {
  it("routes an allowlisted internal tenant to the contributor training tier unchanged", () => {
    const backend = resolveTenantModelBackend("founder-internal", {
      ...CONTRIBUTOR_ENV,
      MENDPOINT_CUSTOMER_MODEL_ROUTING: "on",
      MENDPOINT_TRAINING_TIER_TENANTS: "founder-internal",
    });
    expect(backend).not.toBeNull();
    expect(backend!.providerId).toBe("muse-spark");
    expect(backend!.model).toBe("muse-spark-1.2-contributor");
    expect(isTrainingTierBackend(backend!, {})).toBe(true);
  });
});

describe("default-safe: existing preview/single-tenant behavior is preserved", () => {
  it("passes through byte-for-byte when customer routing is off, for any tenant", () => {
    const routingOff = { ...CONTRIBUTOR_ENV };
    // The existing preview tenant ("tenant-test") — unbound, allowlisted, or not:
    for (const tenantId of [undefined, "tenant-test", "cust-1"]) {
      const backend = resolveTenantModelBackend(tenantId, routingOff);
      expect(backend).not.toBeNull();
      expect(backend!.providerId).toBe("muse-spark");
      // Still the contributor tier — nothing broken for the founder/preview run.
      expect(backend!.model).toBe("muse-spark-1.2-contributor");
      expect(isTrainingTierBackend(backend!, {})).toBe(true);
    }
  });

  it("preserves the default env-unset OpenAI-compatible resolution", () => {
    const backend = resolveTenantModelBackend(undefined, {
      LLM_AGENT_URL: "https://models.example/v1",
      OPENAI_API_KEY: "test-key",
      LLM_AGENT_MODEL: "muse-spark-1.2",
    });
    expect(backend!.providerId).toBe("default");
    expect(backend!.endpoint).toBe("https://models.example/v1/chat/completions");
    expect(backend!.model).toBe("muse-spark-1.2");
  });
});
