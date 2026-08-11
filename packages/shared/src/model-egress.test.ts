import { describe, expect, it } from "vitest";
import {
  assessModelEgress,
  isPrivateModelHost,
  isValidModelEgressMode,
  modelEgressMode,
  parseModelLocalHosts,
} from "./model-egress.js";

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

  it("flags an invalid flag value and an unparseable endpoint", () => {
    expect(assessModelEgress({ MENDPOINT_MODEL_EGRESS: "on" }).violation)
      .toBe("model_egress_mode_invalid");
    expect(assessModelEgress({
      MENDPOINT_MODEL_EGRESS: "local_only",
      LLM_AGENT_URL: "not a url",
    }).violation).toBe("warden_model_endpoint_invalid");
  });
});
