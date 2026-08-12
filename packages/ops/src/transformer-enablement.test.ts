import { describe, expect, it } from "vitest";
import {
  PILOT_SAMPLE_DELIVERY_APPROVAL_REF,
  PILOT_SAMPLE_ENVIRONMENT,
  PILOT_SAMPLE_TENANT_ID,
  TRANSFORMER_CANARY_ACCEPTANCE_EVIDENCE_REF,
  assessTransformerGate,
  generatePilotTransformerGateConfig,
  samplePilotTransformerGateConfig,
  serializePilotTransformerGateConfig,
  TRANSFORMER_GATE_BOUNDARIES,
} from "./index.js";

const PILOT_TENANT = "tenant-pilot-alpha";
const OTHER_TENANT = "tenant-other";

describe("Transformer pilot enablement (T5) generator", () => {
  it("produces a valid single-tenant, single-environment gate config referencing the canary", () => {
    const config = generatePilotTransformerGateConfig({
      tenantId: PILOT_TENANT,
      environment: "staging",
    });
    expect(config.tenantAllowlist).toEqual([PILOT_TENANT]);
    expect(config.environmentAllowlist).toEqual(["staging"]);
    expect(config.grants).toHaveLength(1);
    expect(config.grants[0]!.boundaries).toEqual([...TRANSFORMER_GATE_BOUNDARIES]);
    expect(config.grants[0]!.acceptanceEvidenceRefs).toEqual([
      TRANSFORMER_CANARY_ACCEPTANCE_EVIDENCE_REF,
    ]);
  });

  it("allows the pilot tenant on every granted boundary in the granted environment", () => {
    const raw = serializePilotTransformerGateConfig({
      tenantId: PILOT_TENANT,
      environment: "staging",
    });
    for (const boundary of TRANSFORMER_GATE_BOUNDARIES) {
      const decision = assessTransformerGate(
        { tenantId: PILOT_TENANT, environment: "staging", boundary },
        raw,
      );
      expect(decision.allowed).toBe(true);
      expect(decision.acceptanceEvidenceRefs).toEqual([
        TRANSFORMER_CANARY_ACCEPTANCE_EVIDENCE_REF,
      ]);
    }
  });

  it("denies every other tenant (fail-closed)", () => {
    const raw = serializePilotTransformerGateConfig({
      tenantId: PILOT_TENANT,
      environment: "staging",
    });
    const decision = assessTransformerGate(
      { tenantId: OTHER_TENANT, environment: "staging", boundary: "api_control_plane" },
      raw,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("tenant_not_allowed");
  });

  it("denies every other environment (fail-closed)", () => {
    const raw = serializePilotTransformerGateConfig({
      tenantId: PILOT_TENANT,
      environment: "staging",
    });
    const decision = assessTransformerGate(
      { tenantId: PILOT_TENANT, environment: "production", boundary: "api_control_plane" },
      raw,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("environment_not_allowed");
  });

  it("denies boundaries the grant does not include (fail-closed)", () => {
    const raw = serializePilotTransformerGateConfig({
      tenantId: PILOT_TENANT,
      environment: "staging",
      boundaries: ["api_control_plane"],
    });
    expect(
      assessTransformerGate(
        { tenantId: PILOT_TENANT, environment: "staging", boundary: "api_control_plane" },
        raw,
      ).allowed,
    ).toBe(true);
    const denied = assessTransformerGate(
      { tenantId: PILOT_TENANT, environment: "staging", boundary: "worker_action" },
      raw,
    );
    expect(denied.allowed).toBe(false);
    expect(denied.reasons).toContain("boundary_not_allowed");
  });

  it("gates production delivery on a matching approval reference", () => {
    const approvalRef = "approval:pilot-alpha-release";
    const raw = serializePilotTransformerGateConfig({
      tenantId: PILOT_TENANT,
      environment: "production",
      productionDeliveryApprovalRefs: [approvalRef],
    });
    // Missing approval refs => denied, fail-closed.
    expect(
      assessTransformerGate(
        { tenantId: PILOT_TENANT, environment: "production", boundary: "delivery" },
        raw,
      ),
    ).toMatchObject({ allowed: false, reasons: ["production_delivery_approval_missing"] });
    // Wrong approval ref => denied.
    expect(
      assessTransformerGate(
        {
          tenantId: PILOT_TENANT,
          environment: "production",
          boundary: "delivery",
          productionDeliveryApprovalRefs: ["approval:wrong"],
        },
        raw,
      ).allowed,
    ).toBe(false);
    // Matching approval ref => allowed.
    expect(
      assessTransformerGate(
        {
          tenantId: PILOT_TENANT,
          environment: "production",
          boundary: "delivery",
          productionDeliveryApprovalRefs: [approvalRef],
        },
        raw,
      ).allowed,
    ).toBe(true);
  });

  it("refuses to emit a production delivery grant without an approval reference", () => {
    expect(() =>
      generatePilotTransformerGateConfig({
        tenantId: PILOT_TENANT,
        environment: "production",
      }),
    ).toThrow("transformer_enablement_production_delivery_approval_required");
  });

  it("refuses empty boundaries or empty acceptance evidence", () => {
    expect(() =>
      generatePilotTransformerGateConfig({
        tenantId: PILOT_TENANT,
        environment: "staging",
        boundaries: [],
      }),
    ).toThrow("transformer_enablement_boundaries_required");
    expect(() =>
      generatePilotTransformerGateConfig({
        tenantId: PILOT_TENANT,
        environment: "staging",
        acceptanceEvidenceRefs: [],
      }),
    ).toThrow("transformer_enablement_acceptance_evidence_required");
  });

  it("rejects an invalid tenant identifier through the gate parser", () => {
    expect(() =>
      generatePilotTransformerGateConfig({
        tenantId: "bad tenant id",
        environment: "staging",
      }),
    ).toThrow();
  });

  it("denies everything with no gate config (the production default)", () => {
    for (const boundary of TRANSFORMER_GATE_BOUNDARIES) {
      const decision = assessTransformerGate(
        { tenantId: PILOT_TENANT, environment: "staging", boundary },
        undefined,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reasons).toContain("transformer_gate_config_missing");
    }
    // Even the pilot tenant on production delivery is denied without a config.
    expect(
      assessTransformerGate(
        {
          tenantId: PILOT_TENANT,
          environment: "production",
          boundary: "delivery",
          productionDeliveryApprovalRefs: ["approval:pilot-alpha-release"],
        },
        undefined,
      ).allowed,
    ).toBe(false);
  });
});

describe("Transformer pilot enablement sample config", () => {
  it("names a clearly-fake example tenant, not a real customer", () => {
    const config = samplePilotTransformerGateConfig();
    expect(config.tenantAllowlist).toEqual([PILOT_SAMPLE_TENANT_ID]);
    expect(PILOT_SAMPLE_TENANT_ID).toBe("tenant-pilot-example");
    expect(config.environmentAllowlist).toEqual([PILOT_SAMPLE_ENVIRONMENT]);
  });

  it("allows the sample pilot only on its granted scope and denies all others", () => {
    const raw = JSON.stringify(samplePilotTransformerGateConfig());
    // Allowed: sample tenant, sample environment, delivery with the sample approval.
    expect(
      assessTransformerGate(
        {
          tenantId: PILOT_SAMPLE_TENANT_ID,
          environment: PILOT_SAMPLE_ENVIRONMENT,
          boundary: "delivery",
          productionDeliveryApprovalRefs: [PILOT_SAMPLE_DELIVERY_APPROVAL_REF],
        },
        raw,
      ).allowed,
    ).toBe(true);
    // Denied: any other tenant.
    expect(
      assessTransformerGate(
        {
          tenantId: OTHER_TENANT,
          environment: PILOT_SAMPLE_ENVIRONMENT,
          boundary: "ui",
        },
        raw,
      ).allowed,
    ).toBe(false);
    // Denied: sample tenant, delivery, without the approval reference.
    expect(
      assessTransformerGate(
        {
          tenantId: PILOT_SAMPLE_TENANT_ID,
          environment: PILOT_SAMPLE_ENVIRONMENT,
          boundary: "delivery",
        },
        raw,
      ).allowed,
    ).toBe(false);
  });
});
