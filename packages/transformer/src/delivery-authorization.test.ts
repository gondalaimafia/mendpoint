import { describe, expect, it } from "vitest";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import { assertTransformerDeliveryAuthorized } from "./delivery-authorization.js";

const config = JSON.stringify({
  schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
  tenantAllowlist: ["tenant-a"],
  environmentAllowlist: ["production"],
  grants: [{
    tenantId: "tenant-a",
    environment: "production",
    boundaries: ["delivery"],
    acceptanceEvidenceRefs: ["acceptance:pilot-a:v1"],
    productionDeliveryApprovalRefs: ["approval:release-a"],
  }],
});

describe("Transformer delivery authorization boundary", () => {
  it("fails closed before production delivery without exact approval evidence", () => {
    expect(() => assertTransformerDeliveryAuthorized({ tenantId: "tenant-a", environment: "production" }, config)).toThrow("transformer_delivery_denied:production_delivery_approval_missing");
  });

  it("authorizes only the delivery boundary and does not authorize merge or deploy", () => {
    const decision = assertTransformerDeliveryAuthorized({
      tenantId: "tenant-a",
      environment: "production",
      productionDeliveryApprovalRefs: ["approval:release-a"],
    }, config);
    expect(decision).toMatchObject({ allowed: true, boundary: "delivery" });
    expect(decision).not.toHaveProperty("mayMerge");
    expect(decision).not.toHaveProperty("mayDeploy");
  });
});
