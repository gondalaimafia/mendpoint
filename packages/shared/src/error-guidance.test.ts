import { describe, expect, it } from "vitest";
import {
  cataloguedErrorCodes,
  explainError,
  normalizeErrorCode,
} from "./error-guidance.js";

// The brief-named codes that must have actionable, self-service guidance.
const REQUIRED_CODES = [
  "tenant_scope_required",
  "usage_quota_exceeded",
  "usage_entitlement_required",
  "self_serve_connect_disabled",
  "transformer_gate_config_missing",
  "github_app_credentials_missing",
  "model_training_tier_forbidden_for_tenant",
  "warden_candidate_delivery_evidence_invalid",
  "recipe_precondition_failed",
  "provider not monitored by tenant",
];

describe("explainError catalog", () => {
  it("returns actionable guidance for every catalogued code", () => {
    for (const code of cataloguedErrorCodes()) {
      const explained = explainError(code);
      expect(explained.code).toBe(code);
      expect(explained.title.length).toBeGreaterThan(0);
      expect(explained.whatHappened.length).toBeGreaterThan(0);
      expect(explained.likelyCause.length).toBeGreaterThan(0);
      // "actionable" means at least one concrete recovery step.
      expect(explained.howToFix.length).toBeGreaterThan(0);
      for (const step of explained.howToFix) {
        expect(step.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("covers each brief-named error code with a dedicated entry", () => {
    const catalogued = new Set(cataloguedErrorCodes());
    for (const code of REQUIRED_CODES) {
      expect(catalogued.has(code)).toBe(true);
      const explained = explainError(code);
      expect(explained.howToFix.length).toBeGreaterThan(0);
    }
  });

  it("degrades an unknown code gracefully without a blank entry", () => {
    const explained = explainError("totally_unheard_of_code");
    // Echoes the exact code so the customer can reference it.
    expect(explained.code).toBe("totally_unheard_of_code");
    expect(explained.title.length).toBeGreaterThan(0);
    expect(explained.whatHappened.length).toBeGreaterThan(0);
    expect(explained.howToFix.length).toBeGreaterThan(0);
  });

  it("never returns an empty code even for null or empty input", () => {
    for (const input of [null, undefined, "", "   "]) {
      const explained = explainError(input);
      expect(explained.code).toBe("unknown_error");
      expect(explained.howToFix.length).toBeGreaterThan(0);
    }
  });

  it("resolves colon-delimited recipe precondition variants to the base entry", () => {
    const explained = explainError("recipe_precondition_failed:Dockerfile:node_major");
    // Keeps the exact code, but uses the base entry's guidance.
    expect(explained.code).toBe("recipe_precondition_failed:Dockerfile:node_major");
    expect(explained.title).toBe(explainError("recipe_precondition_failed").title);
  });

  it("degrades unknown members of a known family to family guidance", () => {
    // mendpoint_config_* does not exist in this worktree; it must still be useful.
    const config = explainError("mendpoint_config_endpoint_invalid");
    expect(config.code).toBe("mendpoint_config_endpoint_invalid");
    expect(config.howToFix.length).toBeGreaterThan(0);
    expect(config.title).not.toBe("Something did not complete");

    const usage = explainError("usage_reservation_closed");
    expect(usage.docsHref).toBe("/billing");
  });

  it("unwraps an Error message and a JSON error envelope", () => {
    expect(normalizeErrorCode(new Error("usage_quota_exceeded"))).toBe("usage_quota_exceeded");
    // Some client surfaces throw new Error(JSON.stringify(json)).
    const envelope = JSON.stringify({ error: "usage_quota_exceeded", requestId: "req_1" });
    expect(normalizeErrorCode(new Error(envelope))).toBe("usage_quota_exceeded");
    expect(explainError(envelope).code).toBe("usage_quota_exceeded");
    // Nested envelope shape { error: { code } }.
    expect(normalizeErrorCode({ error: { code: "tenant_scope_required" } })).toBe(
      "tenant_scope_required",
    );
  });
});
