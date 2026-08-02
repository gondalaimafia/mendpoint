import { describe, expect, it } from "vitest";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import { assertTransformerWorkerActionAuthorized } from "./transformer-authorization.js";

const config = JSON.stringify({
  schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
  tenantAllowlist: ["tenant-a"],
  environmentAllowlist: ["staging"],
  grants: [{
    tenantId: "tenant-a",
    environment: "staging",
    boundaries: ["worker_action"],
    acceptanceEvidenceRefs: ["acceptance:pilot-a:v1"],
    productionDeliveryApprovalRefs: [],
  }],
});

describe("Transformer worker authorization boundary", () => {
  it("defaults deny without an explicit tenant grant", () => {
    expect(() => assertTransformerWorkerActionAuthorized({ tenantId: "tenant-a", environment: "staging" }, undefined)).toThrow("transformer_worker_action_denied:transformer_gate_config_missing");
  });

  it("returns the versioned evidence bound decision without executing work", () => {
    expect(assertTransformerWorkerActionAuthorized({ tenantId: "tenant-a", environment: "staging" }, config)).toMatchObject({
      allowed: true,
      boundary: "worker_action",
      acceptanceEvidenceRefs: ["acceptance:pilot-a:v1"],
    });
  });
});
