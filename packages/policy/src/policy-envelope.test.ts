import { describe, expect, it } from "vitest";
import {
  canonicalPolicyEnvelopeJson,
  evaluatePolicyEnvelope,
  parsePolicyEnvelope,
  pathUnderZone,
  type PolicyEnvelope,
  type PolicyTaskRequest,
} from "./policy-envelope.js";

function envelope(overrides: Partial<PolicyEnvelope> = {}): PolicyEnvelope {
  return {
    policyEnvelopeId: "pe-1",
    tenantId: "t1",
    version: 1,
    repositoryScope: [],
    branchScope: [],
    forbiddenZones: [],
    allowedTools: [],
    allowedModelClasses: [],
    externalProcessingAllowed: false,
    residency: "us",
    riskCeiling: "high",
    reviewRequired: true,
    deploymentAllowed: false,
    trainingDataAllowed: false,
    retentionDays: 30,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function task(overrides: Partial<PolicyTaskRequest> = {}): PolicyTaskRequest {
  return {
    repositoryId: "repo-1",
    branch: "main",
    targetPaths: ["src/app.ts"],
    tool: "edit",
    modelClass: "deterministic",
    externalProcessing: false,
    risk: "low",
    isDeployment: false,
    wantsTrainingCapture: false,
    residency: "us",
    ...overrides,
  };
}

describe("evaluatePolicyEnvelope", () => {
  it("allows a task within an unrestricted-scope envelope", () => {
    const decision = evaluatePolicyEnvelope(envelope(), task());
    expect(decision.allowed).toBe(true);
    expect(decision.violations).toEqual([]);
    expect(decision.reviewRequired).toBe(true);
  });

  it("treats empty allowlists as unrestricted and non-empty allowlists as allowlists", () => {
    expect(evaluatePolicyEnvelope(envelope({ repositoryScope: [] }), task()).allowed).toBe(true);
    const scoped = evaluatePolicyEnvelope(envelope({ repositoryScope: ["repo-2"] }), task({ repositoryId: "repo-1" }));
    expect(scoped.allowed).toBe(false);
    expect(scoped.violations).toContainEqual({ code: "repository_out_of_scope", detail: "repo-1" });
  });

  it("denies a branch outside a non-empty branch scope", () => {
    const decision = evaluatePolicyEnvelope(envelope({ branchScope: ["release"] }), task({ branch: "main" }));
    expect(decision.violations).toContainEqual({ code: "branch_out_of_scope", detail: "main" });
  });

  it("denies an edit that lands in a forbidden zone, on a segment boundary", () => {
    const env = envelope({ forbiddenZones: ["infra/prod", "secrets"] });
    const decision = evaluatePolicyEnvelope(env, task({ targetPaths: ["infra/prod/main.tf", "src/app.ts"] }));
    expect(decision.allowed).toBe(false);
    expect(decision.violations).toContainEqual({ code: "forbidden_zone_edit", detail: "infra/prod/main.tf" });
    // "infra/production" must NOT match the "infra/prod" zone (segment boundary).
    expect(evaluatePolicyEnvelope(env, task({ targetPaths: ["infra/production/x.tf"] })).allowed).toBe(true);
  });

  it("fails closed on tool, model class, external processing, deployment, and training capture", () => {
    expect(evaluatePolicyEnvelope(envelope({ allowedTools: ["read"] }), task({ tool: "edit" })).violations)
      .toContainEqual({ code: "tool_not_allowed", detail: "edit" });
    expect(evaluatePolicyEnvelope(envelope({ allowedModelClasses: ["owned"] }), task({ modelClass: "rented_general" })).violations)
      .toContainEqual({ code: "model_class_not_allowed", detail: "rented_general" });
    expect(evaluatePolicyEnvelope(envelope(), task({ externalProcessing: true })).violations)
      .toContainEqual({ code: "external_processing_forbidden", detail: "external_processing" });
    expect(evaluatePolicyEnvelope(envelope(), task({ isDeployment: true })).violations)
      .toContainEqual({ code: "deployment_forbidden", detail: "deployment" });
    expect(evaluatePolicyEnvelope(envelope(), task({ wantsTrainingCapture: true })).violations)
      .toContainEqual({ code: "training_capture_forbidden", detail: "training_capture" });
  });

  it("enforces the risk ceiling by rank", () => {
    expect(evaluatePolicyEnvelope(envelope({ riskCeiling: "medium" }), task({ risk: "high" })).allowed).toBe(false);
    expect(evaluatePolicyEnvelope(envelope({ riskCeiling: "high" }), task({ risk: "high" })).allowed).toBe(true);
  });

  it("denies a residency mismatch", () => {
    expect(evaluatePolicyEnvelope(envelope({ residency: "eu" }), task({ residency: "us" })).violations)
      .toContainEqual({ code: "residency_mismatch", detail: "us" });
  });

  it("collects every violation rather than short-circuiting", () => {
    const env = envelope({ allowedTools: ["read"], riskCeiling: "low", residency: "eu" });
    const decision = evaluatePolicyEnvelope(env, task({ tool: "edit", risk: "critical", residency: "us", isDeployment: true }));
    const codes = decision.violations.map((v) => v.code).sort();
    expect(codes).toEqual(["deployment_forbidden", "residency_mismatch", "risk_ceiling_exceeded", "tool_not_allowed"]);
  });

  it("is a pure function: identical inputs give byte-identical decisions", () => {
    const env = envelope({ forbiddenZones: ["secrets"] });
    const t = task({ targetPaths: ["secrets/key.pem", "a.ts"] });
    expect(JSON.stringify(evaluatePolicyEnvelope(env, t))).toEqual(JSON.stringify(evaluatePolicyEnvelope(env, t)));
  });
});

describe("pathUnderZone", () => {
  it("matches the zone itself and children, on a segment boundary", () => {
    expect(pathUnderZone("secrets", "secrets")).toBe(true);
    expect(pathUnderZone("secrets/key.pem", "secrets")).toBe(true);
    expect(pathUnderZone("secretsx/key.pem", "secrets")).toBe(false);
    expect(pathUnderZone("./infra/prod/main.tf", "infra/prod")).toBe(true);
    expect(pathUnderZone("anything", "")).toBe(false);
  });
});

describe("parsePolicyEnvelope", () => {
  it("round-trips a valid envelope and rejects malformed input", () => {
    const parsed = parsePolicyEnvelope(JSON.parse(canonicalPolicyEnvelopeJson(envelope())));
    expect(parsed.policyEnvelopeId).toBe("pe-1");
    expect(parsed.riskCeiling).toBe("high");
    expect(() => parsePolicyEnvelope(null)).toThrow("policy_envelope_invalid");
    expect(() => parsePolicyEnvelope({ ...envelope(), version: 0 })).toThrow("policy_envelope_version_invalid");
    expect(() => parsePolicyEnvelope({ ...envelope(), riskCeiling: "extreme" })).toThrow("policy_envelope_riskCeiling_invalid");
    expect(() => parsePolicyEnvelope({ ...envelope(), allowedTools: [1] })).toThrow("policy_envelope_allowedTools_invalid");
  });

  it("produces stable canonical JSON regardless of key order", () => {
    const a = canonicalPolicyEnvelopeJson(envelope());
    const b = canonicalPolicyEnvelopeJson(parsePolicyEnvelope(JSON.parse(a)));
    expect(a).toEqual(b);
  });
});
