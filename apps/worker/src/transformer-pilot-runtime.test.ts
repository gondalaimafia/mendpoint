import { describe, expect, it, vi } from "vitest";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import {
  admitTransformerPilotAttempt,
  observeTransformerPilotWave,
  type TransformerPilotWorkerPort,
} from "./transformer-pilot-runtime.js";

const gateConfig = JSON.stringify({
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

function mutation(key: string) {
  return {
    tenantId: "tenant-a",
    campaignId: "campaign-a",
    observedAt: "2026-08-02T12:00:00.000Z",
    evidenceRefs: [`evidence:${key}`],
    idempotencyKey: key,
  };
}

describe("Transformer pilot worker coordinator boundary", () => {
  it("fails closed before admission or observation reaches the coordinator", () => {
    const port = {
      claimNextAttempt: vi.fn(),
      reconcileWave: vi.fn(),
    } as unknown as TransformerPilotWorkerPort;
    expect(() => admitTransformerPilotAttempt(
      port,
      { tenantId: "tenant-a", environment: "staging" },
      { ...mutation("claim"), leaseToken: "lease-token-unit-a-00000001" },
      undefined,
    )).toThrow("transformer_worker_action_denied");
    expect(() => observeTransformerPilotWave(
      port,
      { tenantId: "tenant-a", environment: "staging" },
      { ...mutation("observe"), wave: 1, observations: [] },
      undefined,
    )).toThrow("transformer_worker_action_denied");
    expect(port.claimNextAttempt).not.toHaveBeenCalled();
    expect(port.reconcileWave).not.toHaveBeenCalled();
  });

  it("passes only gated admission and evidence observation commands to the coordinator", () => {
    const claimNextAttempt = vi.fn(() => null);
    const reconcileWave = vi.fn(() => ({ campaignId: "campaign-a" }));
    const port = { claimNextAttempt, reconcileWave } as unknown as TransformerPilotWorkerPort;
    const scope = { tenantId: "tenant-a", environment: "staging" };
    admitTransformerPilotAttempt(
      port,
      scope,
      { ...mutation("claim"), leaseToken: "lease-token-unit-a-00000001" },
      gateConfig,
    );
    observeTransformerPilotWave(
      port,
      scope,
      { ...mutation("observe"), wave: 1, observations: [] },
      gateConfig,
    );
    expect(claimNextAttempt).toHaveBeenCalledWith(expect.objectContaining({ gateConfig }));
    expect(reconcileWave).toHaveBeenCalledWith(expect.objectContaining({ gateConfig, observations: [] }));
  });

  it("rejects a tenant mismatch before consulting the coordinator", () => {
    const port = {
      claimNextAttempt: vi.fn(),
      reconcileWave: vi.fn(),
    } as unknown as TransformerPilotWorkerPort;
    expect(() => admitTransformerPilotAttempt(
      port,
      { tenantId: "tenant-b", environment: "staging" },
      { ...mutation("claim"), leaseToken: "lease-token-unit-a-00000001" },
      gateConfig,
    )).toThrow("transformer_worker_tenant_mismatch");
    expect(port.claimNextAttempt).not.toHaveBeenCalled();
  });
});
