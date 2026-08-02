import { describe, expect, it } from "vitest";
import {
  TRANSFORMER_GATE_SCHEMA_VERSION,
  assessTransformerGate,
  authorizeTransformerDelivery,
  authorizeTransformerWorkerAction,
  parseTransformerGateConfig,
} from "./transformer-gate.js";

function config(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
    tenantAllowlist: ["tenant-a"],
    environmentAllowlist: ["staging", "production"],
    grants: [
      {
        tenantId: "tenant-a",
        environment: "staging",
        boundaries: ["api_control_plane", "worker_action", "ui", "delivery"],
        acceptanceEvidenceRefs: ["acceptance:pilot-a:v1"],
        productionDeliveryApprovalRefs: [],
      },
      {
        tenantId: "tenant-a",
        environment: "production",
        boundaries: ["delivery"],
        acceptanceEvidenceRefs: ["acceptance:pilot-a:v1"],
        productionDeliveryApprovalRefs: ["approval:release-a"],
      },
    ],
    ...overrides,
  });
}

describe("Transformer experimental gate", () => {
  it("defaults deny when configuration is missing or malformed", () => {
    const input = { tenantId: "tenant-a", environment: "staging", boundary: "api_control_plane" } as const;
    expect(assessTransformerGate(input, undefined)).toMatchObject({ allowed: false, reasons: ["transformer_gate_config_missing"] });
    expect(assessTransformerGate(input, "{")).toMatchObject({ allowed: false, reasons: ["transformer_gate_config_malformed"] });
  });

  it("requires exact tenant, environment, boundary, and acceptance evidence grants", () => {
    expect(assessTransformerGate({ tenantId: "tenant-a", environment: "staging", boundary: "api_control_plane" }, config())).toMatchObject({
      allowed: true,
      acceptanceEvidenceRefs: ["acceptance:pilot-a:v1"],
    });
    expect(assessTransformerGate({ tenantId: "tenant-b", environment: "staging", boundary: "api_control_plane" }, config()).allowed).toBe(false);
    expect(assessTransformerGate({ tenantId: "tenant-a", environment: "development", boundary: "ui" }, config()).allowed).toBe(false);
    expect(assessTransformerGate({ tenantId: "tenant-a", environment: "production", boundary: "worker_action" }, config())).toMatchObject({ allowed: false, reasons: ["boundary_not_allowed"] });
  });

  it("fails closed on unknown boundaries and inconsistent grants", () => {
    expect(assessTransformerGate({ tenantId: "tenant-a", environment: "staging", boundary: "unknown" as never }, config())).toMatchObject({ allowed: false, reasons: ["boundary_unknown"] });
    expect(() => parseTransformerGateConfig(config({ tenantAllowlist: ["tenant-b"] }))).toThrow("transformer_gate_grant_tenant_invalid");
  });

  it("authorizes worker actions only through the worker boundary", () => {
    expect(authorizeTransformerWorkerAction({ tenantId: "tenant-a", environment: "staging" }, config())).toMatchObject({ allowed: true, boundary: "worker_action" });
    expect(authorizeTransformerWorkerAction({ tenantId: "tenant-a", environment: "production" }, config()).allowed).toBe(false);
  });

  it("requires an exact external approval reference for production delivery", () => {
    expect(authorizeTransformerDelivery({ tenantId: "tenant-a", environment: "production" }, config())).toMatchObject({ allowed: false, reasons: ["production_delivery_approval_missing"] });
    expect(authorizeTransformerDelivery({ tenantId: "tenant-a", environment: "production", productionDeliveryApprovalRefs: ["approval:wrong"] }, config()).allowed).toBe(false);
    expect(authorizeTransformerDelivery({ tenantId: "tenant-a", environment: "production", productionDeliveryApprovalRefs: ["approval:release-a"] }, config())).toMatchObject({ allowed: true, boundary: "delivery" });
  });
});
