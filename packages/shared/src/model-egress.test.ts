import { describe, expect, it } from "vitest";
import {
  assessModelEgress,
  effectiveModelEndpointUrl,
  enforceModelEndpointEgress,
  isPrivateModelHost,
  isValidModelEgressMode,
  modelEgressMode,
  parseModelLocalHosts,
} from "./index.js";

describe("model egress mode parsing", () => {
  it("defaults to external_allowed and only local_only flips it", () => {
    expect(modelEgressMode({})).toBe("external_allowed");
    expect(modelEgressMode({ MENDPOINT_MODEL_EGRESS: "external_allowed" })).toBe("external_allowed");
    expect(modelEgressMode({ MENDPOINT_MODEL_EGRESS: "  local_only  " })).toBe("local_only");
    expect(modelEgressMode({ MENDPOINT_MODEL_EGRESS: "localonly" })).toBe("external_allowed");
  });

  it("validates the flag value", () => {
    expect(isValidModelEgressMode(undefined)).toBe(true);
    expect(isValidModelEgressMode("")).toBe(true);
    expect(isValidModelEgressMode("local_only")).toBe(true);
    expect(isValidModelEgressMode("external_allowed")).toBe(true);
    expect(isValidModelEgressMode("localonly")).toBe(false);
  });
});

describe("private model host detection", () => {
  it("treats loopback, private, link-local, and unique-local hosts as private", () => {
    for (const host of [
      "127.0.0.1",
      "127.5.5.5",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.1.1",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "localhost",
      "model.local",
      "gateway.localhost",
    ]) {
      expect(isPrivateModelHost(host)).toBe(true);
    }
  });

  it("treats public hosts and public IPs as not private", () => {
    for (const host of [
      "api.meta.ai",
      "models.example.com",
      "8.8.8.8",
      "172.15.0.1",
      "172.32.0.1",
      "192.169.0.1",
      "2001:db8::1",
    ]) {
      expect(isPrivateModelHost(host)).toBe(false);
    }
  });

  it("honors the operator allowlist", () => {
    const allow = parseModelLocalHosts("model.internal, backend.host");
    expect(isPrivateModelHost("model.internal", allow)).toBe(true);
    expect(isPrivateModelHost("api.meta.ai", allow)).toBe(false);
  });
});

describe("model egress assessment", () => {
  it("reports satisfied when external_allowed regardless of host", () => {
    const a = assessModelEgress({ LLM_AGENT_URL: "https://api.meta.ai/v1" });
    expect(a.mode).toBe("external_allowed");
    expect(a.violation).toBeNull();
    expect(a.localOnlySatisfied).toBe(true);
  });

  it("flags a public endpoint under local_only", () => {
    const a = assessModelEgress({
      MENDPOINT_MODEL_EGRESS: "local_only",
      LLM_AGENT_URL: "https://api.meta.ai/v1",
    });
    expect(a.violation).toBe("model_egress_local_only_violation");
    expect(a.localOnlySatisfied).toBe(false);
  });

  it("allows a private endpoint or no endpoint under local_only", () => {
    expect(assessModelEgress({
      MENDPOINT_MODEL_EGRESS: "local_only",
      LLM_AGENT_URL: "http://127.0.0.1:8080/v1",
    }).violation).toBeNull();
    const heuristicOnly = assessModelEgress({ MENDPOINT_MODEL_EGRESS: "local_only" });
    expect(heuristicOnly.violation).toBeNull();
    expect(heuristicOnly.endpointConfigured).toBe(false);
    expect(heuristicOnly.localOnlySatisfied).toBe(true);
  });

  it("flags a public repair-lane LLM_REPAIR_URL even when the primary endpoint is private", () => {
    // The exploiting configuration: a private agent URL passes the primary
    // check, but the repair lane egresses to a public host that primary
    // resolution never inspects.
    const a = assessModelEgress({
      MENDPOINT_MODEL_EGRESS: "local_only",
      LLM_AGENT_URL: "http://127.0.0.1:8000",
      LLM_REPAIR_URL: "https://public-model.invalid",
    });
    expect(a.violation).toBe("model_egress_local_only_violation");
    expect(a.localOnlySatisfied).toBe(false);
    expect(a.endpointHost).toBe("public-model.invalid");
  });

  it("treats OPENAI_API_BASE / XAI_API_BASE as egress only when the confirm lane is enabled", () => {
    // The code-impact confirm lane is opt-in and off by default. A stale base
    // URL whose lane can never run must NOT refuse a local_only boot: booting
    // is impossible to justify as an egress risk when resolveLlmConfirmMode()
    // would return "off". (Previously these were added unconditionally, so a
    // stale value refused boot even though nothing could egress.)
    for (const name of ["OPENAI_API_BASE", "XAI_API_BASE"] as const) {
      const bootsDespiteStale = assessModelEgress({
        MENDPOINT_MODEL_EGRESS: "local_only",
        LLM_AGENT_URL: "http://127.0.0.1:8000",
        [name]: "https://stale-confirm.invalid/v1",
      });
      expect(bootsDespiteStale.violation).toBeNull();
      expect(bootsDespiteStale.localOnlySatisfied).toBe(true);
    }

    // With the lane actually enabled (explicit opt-in AND a usable key), the
    // same public base URL is inspected and refused at its own host.
    const refusedOpenai = assessModelEgress({
      MENDPOINT_MODEL_EGRESS: "local_only",
      LLM_AGENT_URL: "http://127.0.0.1:8000",
      LLM_CONFIRM_MODE: "live",
      OPENAI_API_KEY: "configured",
      OPENAI_API_BASE: "https://openai-confirm.invalid/v1",
    });
    expect(refusedOpenai.violation).toBe("model_egress_local_only_violation");
    expect(refusedOpenai.localOnlySatisfied).toBe(false);
    expect(refusedOpenai.endpointHost).toBe("openai-confirm.invalid");

    const refusedXai = assessModelEgress({
      MENDPOINT_MODEL_EGRESS: "local_only",
      LLM_AGENT_URL: "http://127.0.0.1:8000",
      LLM_CONFIRM_MODE: "live",
      XAI_API_KEY: "configured",
      XAI_API_BASE: "https://xai-confirm.invalid/v1",
    });
    expect(refusedXai.violation).toBe("model_egress_local_only_violation");
    expect(refusedXai.localOnlySatisfied).toBe(false);
    expect(refusedXai.endpointHost).toBe("xai-confirm.invalid");
  });

  it("flags a public OPENAI_BASE_URL hidden behind a private primary URL", () => {
    const a = assessModelEgress({
      MENDPOINT_MODEL_EGRESS: "local_only",
      MENDPOINT_MODEL_PROVIDER: "muse-spark",
      LLM_AGENT_URL: "http://127.0.0.1:8000",
      OPENAI_BASE_URL: "https://repair-fallback.invalid/v1",
      LLM_REPAIR_URL: "",
    });
    expect(a.violation).toBe("model_egress_local_only_violation");
    expect(a.endpointHost).toBe("repair-fallback.invalid");
  });

  it("flags the public code-impact provider default when live confirmation is enabled", () => {
    const a = assessModelEgress({
      MENDPOINT_MODEL_EGRESS: "local_only",
      LLM_AGENT_URL: "http://127.0.0.1:8000",
      LLM_CONFIRM_MODE: "live",
      OPENAI_API_KEY: "configured",
    });
    expect(a.violation).toBe("model_egress_local_only_violation");
    expect(a.endpointHost).toBe("api.openai.com");
  });

  it("allows a private repair-lane LLM_REPAIR_URL under local_only", () => {
    expect(assessModelEgress({
      MENDPOINT_MODEL_EGRESS: "local_only",
      LLM_AGENT_URL: "http://127.0.0.1:8000",
      LLM_REPAIR_URL: "http://127.0.0.1:9000/v1",
    }).violation).toBeNull();
    expect(assessModelEgress({
      MENDPOINT_MODEL_EGRESS: "local_only",
      LLM_REPAIR_URL: "https://repair.internal/v1",
      MENDPOINT_MODEL_LOCAL_HOSTS: "repair.internal",
    }).violation).toBeNull();
  });

  it("fails closed on an unparseable repair-lane endpoint under local_only", () => {
    expect(assessModelEgress({
      MENDPOINT_MODEL_EGRESS: "local_only",
      LLM_REPAIR_URL: "not a url",
    }).violation).toBe("warden_model_endpoint_invalid");
  });

  it("ignores LLM_REPAIR_URL when external_allowed", () => {
    expect(assessModelEgress({ LLM_REPAIR_URL: "https://public-model.invalid" }).violation)
      .toBeNull();
  });

  it("flags an invalid flag value and an unparseable endpoint", () => {
    expect(assessModelEgress({ MENDPOINT_MODEL_EGRESS: "on" }).violation)
      .toBe("model_egress_mode_invalid");
    expect(assessModelEgress({
      MENDPOINT_MODEL_EGRESS: "local_only",
      LLM_AGENT_URL: "not a url",
    }).violation).toBe("warden_model_endpoint_invalid");
  });
});

describe("model egress assessment across named providers", () => {
  it("flags a named provider's hardcoded public default under local_only (no base-URL env)", () => {
    for (const [provider, host] of [
      ["openai", "api.openai.com"],
      ["xai", "api.x.ai"],
      ["anthropic", "api.anthropic.com"],
      ["gemini", "generativelanguage.googleapis.com"],
    ] as const) {
      const a = assessModelEgress({
        MENDPOINT_MODEL_EGRESS: "local_only",
        MENDPOINT_MODEL_PROVIDER: provider,
      });
      expect(a.violation).toBe("model_egress_local_only_violation");
      expect(a.endpointHost).toBe(host);
      expect(a.localOnlySatisfied).toBe(false);
    }
  });

  it("flags a named provider pointed at a public base-URL env under local_only", () => {
    const a = assessModelEgress({
      MENDPOINT_MODEL_EGRESS: "local_only",
      MENDPOINT_MODEL_PROVIDER: "openai-gateway",
      LLM_AGENT_URL: "https://gateway.public.example/v1",
    });
    expect(a.violation).toBe("model_egress_local_only_violation");
  });

  it("allows a private, loopback, or allowlisted host for a named provider under local_only", () => {
    expect(assessModelEgress({
      MENDPOINT_MODEL_EGRESS: "local_only",
      MENDPOINT_MODEL_PROVIDER: "anthropic",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8000",
    }).violation).toBeNull();
    expect(assessModelEgress({
      MENDPOINT_MODEL_EGRESS: "local_only",
      MENDPOINT_MODEL_PROVIDER: "gemini",
      GEMINI_BASE_URL: "https://gemini.internal",
      MENDPOINT_MODEL_LOCAL_HOSTS: "gemini.internal",
    }).violation).toBeNull();
  });

  it("treats a base-URL-less provider (no default) as no egress under local_only", () => {
    const a = assessModelEgress({
      MENDPOINT_MODEL_EGRESS: "local_only",
      MENDPOINT_MODEL_PROVIDER: "muse-spark",
    });
    expect(a.violation).toBeNull();
    expect(a.endpointConfigured).toBe(false);
    expect(a.localOnlySatisfied).toBe(true);
  });

  it("fails closed on an unrecognized provider id under local_only", () => {
    const a = assessModelEgress({
      MENDPOINT_MODEL_EGRESS: "local_only",
      MENDPOINT_MODEL_PROVIDER: "some-unmirrored-provider",
    });
    expect(a.violation).toBe("model_egress_local_only_violation");
    expect(a.localOnlySatisfied).toBe(false);
    expect(effectiveModelEndpointUrl({ MENDPOINT_MODEL_PROVIDER: "some-unmirrored-provider" }).determinable)
      .toBe(false);
  });

  it("does not check the host when external_allowed, even for a public provider default", () => {
    const a = assessModelEgress({ MENDPOINT_MODEL_PROVIDER: "openai" });
    expect(a.violation).toBeNull();
    expect(a.endpointHost).toBe("api.openai.com");
    expect(a.endpointConfigured).toBe(true);
  });
});

describe("enforceModelEndpointEgress", () => {
  it("is a no-op under external_allowed", () => {
    expect(() => enforceModelEndpointEgress("https://api.meta.ai/v1/chat/completions", {})).not.toThrow();
  });

  it("permits a private or allowlisted host and refuses a public one under local_only", () => {
    expect(() => enforceModelEndpointEgress("http://127.0.0.1:8000/v1/messages", {
      MENDPOINT_MODEL_EGRESS: "local_only",
    })).not.toThrow();
    expect(() => enforceModelEndpointEgress("https://model.internal/v1", {
      MENDPOINT_MODEL_EGRESS: "local_only",
      MENDPOINT_MODEL_LOCAL_HOSTS: "model.internal",
    })).not.toThrow();
    expect(() => enforceModelEndpointEgress("https://api.meta.ai/v1", {
      MENDPOINT_MODEL_EGRESS: "local_only",
    })).toThrow("model_egress_local_only_violation");
  });

  it("fails closed on an unparseable URL under local_only", () => {
    expect(() => enforceModelEndpointEgress("not a url", { MENDPOINT_MODEL_EGRESS: "local_only" }))
      .toThrow("warden_model_endpoint_invalid");
  });
});
