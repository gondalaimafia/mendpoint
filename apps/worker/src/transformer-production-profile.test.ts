import { describe, expect, it } from "vitest";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import {
  resolveTransformerWorkerId,
  validateTransformerProductionProfile,
} from "./transformer-production-profile.js";

const gate = JSON.stringify({ schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION, tenantAllowlist: ["tenant-a"], environmentAllowlist: ["production"], grants: [{ tenantId: "tenant-a", environment: "production", boundaries: ["api_control_plane", "worker_action", "delivery"], acceptanceEvidenceRefs: ["acceptance:pilot"], productionDeliveryApprovalRefs: ["approval:pilot"] }] });

describe("Transformer production profile", () => {
  it("accepts the exact coordinator and worker production boundaries", () => {
    expect(validateTransformerProductionProfile(environment(), "coordinator")).toEqual({ role: "coordinator", tenantId: "tenant-a", campaignId: "campaign-a", environment: "production" });
    expect(validateTransformerProductionProfile(environment(), "worker")).toEqual({
      role: "worker",
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      environment: "production",
      workerId: "fly-abcd1234abcd12",
    });
  });

  it("derives production worker identity from the Fly machine and rejects app-wide overrides", () => {
    expect(resolveTransformerWorkerId(environment())).toBe("fly-abcd1234abcd12");
    expect(resolveTransformerWorkerId({
      ...environment(),
      FLY_MACHINE_ID: "abcd1234abcd13",
    })).toBe("fly-abcd1234abcd13");
    expect(() => resolveTransformerWorkerId({
      ...environment(),
      MENDPOINT_REGAUGE_WORKER_ID: "shared-worker",
    })).toThrow("transformer_production_worker_id_override_forbidden");
    expect(() => resolveTransformerWorkerId({
      ...environment(),
      MENDPOINT_TRANSFORMER_WORKER_ID: "shared-worker",
    })).toThrow("transformer_production_worker_id_override_forbidden");
    expect(() => validateTransformerProductionProfile({
      ...environment(),
      FLY_MACHINE_ID: undefined,
    }, "worker")).toThrow("transformer_production_fly_machine_id_required");
  });

  it("requires the immutable source revision that the public version probe reports", () => {
    expect(() => validateTransformerProductionProfile({
      ...environment(),
      MENDPOINT_RELEASE_REVISION: undefined,
    }, "coordinator")).toThrow("transformer_production_release_revision_required");
    expect(() => validateTransformerProductionProfile({
      ...environment(),
      MENDPOINT_RELEASE_REVISION: "main",
    }, "worker")).toThrow("transformer_production_release_revision_invalid");
  });

  it.each([
    ["MENDPOINT_TRANSFORMER_ENABLED", "0", "transformer_production_activation_required"],
    ["MENDPOINT_TRANSFORMER_ARTIFACT_BACKEND", "filesystem", "transformer_production_s3_required"],
    ["MENDPOINT_TRANSFORMER_COORDINATOR_TOKEN", "known-token", "transformer_production_worker_token_invalid"],
    ["MENDPOINT_TRANSFORMER_COORDINATOR_URL", "http://coordinator.internal", "transformer_production_coordinator_url_invalid"],
    ["MENDPOINT_TRANSFORMER_S3_PREFIX", "transformer/tenant-b/campaign-a", "transformer_production_s3_prefix_invalid"],
    ["MENDPOINT_PILOT_SEED", "1", "transformer_production_seed_forbidden"],
  ])("rejects unsafe %s configuration", (name, value, code) => {
    expect(() => validateTransformerProductionProfile({ ...environment(), [name]: value }, "worker")).toThrow(code);
  });

  it("rejects client activation without the exact server grant", () => {
    const wrongGate = JSON.stringify({ schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION, tenantAllowlist: ["tenant-a"], environmentAllowlist: ["production"], grants: [{ tenantId: "tenant-a", environment: "production", boundaries: ["ui"], acceptanceEvidenceRefs: ["acceptance:pilot"], productionDeliveryApprovalRefs: [] }] });
    expect(() => validateTransformerProductionProfile({ ...environment(), MENDPOINT_TRANSFORMER_GATE: wrongGate }, "worker")).toThrow("transformer_production_gate_scope_invalid");
  });
});

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production", API_AUTH: "required", API_HOST: "0.0.0.0", GITHUB_MODE: "real",
    MENDPOINT_DEPLOYMENT_PROFILE: "transformer_pilot", MENDPOINT_DEPLOYMENT_CLASS: "customer", MENDPOINT_TRANSFORMER_ENABLED: "1",
    MENDPOINT_TRANSFORMER_MULTINODE_COORDINATOR_ENABLED: "1", MENDPOINT_TRANSFORMER_MULTINODE_ENABLED: "1",
    MENDPOINT_TRANSFORMER_ARTIFACT_BACKEND: "s3", MENDPOINT_PILOT_SEED: "0", MENDPOINT_FEED_POLLING_ENABLED: "0",
    MENDPOINT_TRANSFORMER_TENANT_ID: "tenant-a", MENDPOINT_TRANSFORMER_CAMPAIGN_ID: "campaign-a", MENDPOINT_TRANSFORMER_ENVIRONMENT: "production",
    MENDPOINT_TRANSFORMER_GATE: gate, MENDPOINT_TRANSFORMER_COORDINATOR_TOKEN: `me_${"a".repeat(40)}`,
    MENDPOINT_TRANSFORMER_COORDINATOR_URL: "https://mendpoint-transformer-pilot.fly.dev/",
    MENDPOINT_TRANSFORMER_CHECKPOINT_KEY: Buffer.alloc(32, 1).toString("base64"), MENDPOINT_TRANSFORMER_OPERATION_SECRET: Buffer.alloc(32, 2).toString("base64"),
    MENDPOINT_TRANSFORMER_S3_ENDPOINT: "https://s3.example.com", MENDPOINT_TRANSFORMER_S3_REGION: "auto", MENDPOINT_TRANSFORMER_S3_BUCKET: "pilot",
    MENDPOINT_TRANSFORMER_S3_PREFIX: "transformer/tenant-a/campaign-a", MENDPOINT_TRANSFORMER_S3_ACCESS_KEY_ID: "access", MENDPOINT_TRANSFORMER_S3_SECRET_ACCESS_KEY: "secret",
    MENDPOINT_TRANSFORMER_EXECUTOR_DIGEST: `sha256:${"e".repeat(64)}`, MENDPOINT_TRANSFORMER_EVIDENCE_REFS: "evidence:pilot",
    MENDPOINT_TRANSFORMER_READINESS_HOST: "0.0.0.0", MENDPOINT_DATA_DIR: "/data/db", GITHUB_APP_ID: "42", GITHUB_APP_PRIVATE_KEY: "private",
    GITHUB_WEBHOOK_SECRET: "webhook", GITHUB_APP_ACCOUNT_TENANT_BINDINGS: '{"7123456":"tenant-a"}',
    FLY_MACHINE_ID: "abcd1234abcd12",
    MENDPOINT_RELEASE_REVISION: "a".repeat(40),
  };
}
