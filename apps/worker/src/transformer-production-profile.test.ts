import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TRANSFORMER_GATE_SCHEMA_VERSION, validateApiEnv } from "@mendpoint/ops";
import {
  resolveTransformerWorkerId,
  validateTransformerProductionProfile,
} from "./transformer-production-profile.js";

const CANARY_REVISION = "a".repeat(40);
const RELEASE_REVISION = "b".repeat(40);
const TENANT = "tenant_regauge_canary";
const CAMPAIGN = "campaign_regauge_canary_20260814";
const testPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const approval = `approval:regauge:${TENANT}:${CAMPAIGN}:repository:123456:revision:${CANARY_REVISION}:draft:1:run:98765:attempt:1`;
const gate = JSON.stringify({ schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION, tenantAllowlist: [TENANT], environmentAllowlist: ["production"], grants: [{ tenantId: TENANT, environment: "production", boundaries: ["api_control_plane", "worker_action", "delivery"], acceptanceEvidenceRefs: ["acceptance:pilot"], productionDeliveryApprovalRefs: [approval] }] });

describe("Transformer production profile", () => {
  it("builds and runs the hardened transformer image stage", () => {
    const manifest = readFileSync(
      resolve(import.meta.dirname, "../../../fly.regauge.toml"),
      "utf8",
    ).replaceAll("\r\n", "\n");

    expect(manifest).toContain(
      '[build]\n  dockerfile = "Dockerfile"\n  build-target = "transformer"',
    );
    expect(manifest).toContain('app = "mendpoint-regauge-production"');
    expect(manifest).toContain(
      'MENDPOINT_REGAUGE_COORDINATOR_URL = "https://mendpoint-regauge-production.fly.dev/"',
    );
    expect(manifest).not.toMatch(/^\s*target\s*=/m);
    expect(manifest).toContain(
      '[experimental]\n  entrypoint = ["/app/scripts/start-transformer-entrypoint.sh"]',
    );
    expect(manifest).toContain(
      '[[vm]]\n  processes = ["coordinator"]\n  size = "shared-cpu-1x"\n  memory = "2gb"',
    );
    expect(manifest).not.toContain(
      '[[vm]]\n  processes = ["coordinator"]\n  size = "shared-cpu-2x"',
    );
    const roleEntrypoint = readFileSync(
      resolve(import.meta.dirname, "../../../scripts/start-transformer-role.mjs"),
      "utf8",
    );
    const roleIndex = roleEntrypoint.indexOf(
      'process.env.MENDPOINT_PROCESS_ROLE = "transformer_coordinator"',
    );
    const serverImportIndex = roleEntrypoint.indexOf('import("../apps/api/src/server.ts")');
    expect(roleIndex).toBeGreaterThanOrEqual(0);
    expect(serverImportIndex).toBeGreaterThan(roleIndex);
    expect(roleEntrypoint).toContain("processJobsOnce");
    expect(roleEntrypoint).toContain("jobTypes: [VERIFIER_ADVISORY_JOB_TYPE]");
    expect(roleEntrypoint).toContain("runWardenMaintenance: false");
  });

  it.each([
    [
      "fly.transformer.toml",
      "transformer_pilot",
      "https://mendpoint-transformer-pilot.fly.dev/",
    ],
    [
      "fly.regauge.toml",
      "regauge_production",
      "https://mendpoint-regauge-production.fly.dev/",
    ],
  ])("feeds %s environment into both API and worker boot validation", (
    manifestName,
    profile,
    coordinatorUrl,
  ) => {
    const manifest = readFileSync(
      resolve(import.meta.dirname, `../../../${manifestName}`),
      "utf8",
    );
    const env: NodeJS.ProcessEnv = {
      ...environment(),
      ...manifestEnvironment(manifest),
      MENDPOINT_PROCESS_ROLE: "transformer_coordinator",
      MENDPOINT_RELEASE_REVISION: RELEASE_REVISION,
      MENDPOINT_REGAUGE_ACTIVATION_EXPIRES_AT: undefined,
      GITHUB_APP_PRIVATE_KEY: testPrivateKey,
    };

    expect(env.MENDPOINT_DEPLOYMENT_PROFILE).toBe(profile);
    expect(env.MENDPOINT_REGAUGE_COORDINATOR_URL).toBe(coordinatorUrl);
    expect(validateApiEnv(env)).toMatchObject({ ok: true, errors: [] });
    expect(validateTransformerProductionProfile(env, "coordinator")).toMatchObject({
      role: "coordinator",
      tenantId: TENANT,
      campaignId: CAMPAIGN,
      environment: "production",
    });
    expect(validateTransformerProductionProfile(env, "worker")).toMatchObject({
      role: "worker",
      workerId: "fly-abcd1234abcd12",
    });
  });

  it("protects the dedicated ReGauge manifest with the existing deployment owner", () => {
    const codeowners = readFileSync(
      resolve(import.meta.dirname, "../../../.github/CODEOWNERS"),
      "utf8",
    );
    expect(codeowners).toMatch(/^\/fly\.regauge\.toml\s+@gondalaimafia$/m);
  });

  it("accepts the exact coordinator and worker production boundaries", () => {
    expect(validateTransformerProductionProfile(environment(), "coordinator")).toEqual({ role: "coordinator", tenantId: TENANT, campaignId: CAMPAIGN, environment: "production" });
    expect(validateTransformerProductionProfile(environment(), "worker")).toEqual({
      role: "worker",
      tenantId: TENANT,
      campaignId: CAMPAIGN,
      environment: "production",
      workerId: "fly-abcd1234abcd12",
    });
  });

  it("requires the bounded DeepSeek verifier advisory profile", () => {
    for (const [name, value] of [
      ["DEEPSEEK_VERIFIER_ENABLED", "false"],
      ["DEEPSEEK_API_KEY", ""],
      ["MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE", "offline"],
      ["MENDPOINT_AGENT_VERIFIER_SCORING_MODE", "upstream_thinking_logprobs"],
      ["MENDPOINT_AGENT_VERIFIER_EVALUATIONS", "2"],
      ["MENDPOINT_AGENT_VERIFIER_PIVOTS", "2"],
      ["MENDPOINT_AGENT_VERIFIER_MAXIMUM_CANDIDATES", "2"],
      ["MENDPOINT_AGENT_VERIFIER_MAXIMUM_COST_USD", "0.06"],
      ["MENDPOINT_AGENT_VERIFIER_TIMEOUT_MS", "30000"],
      ["MENDPOINT_AGENT_VERIFIER_MAXIMUM_RETRIES", "1"],
    ] as const) {
      expect(() => validateTransformerProductionProfile({ ...environment(), [name]: value }, "coordinator"))
        .toThrow("transformer_production_verifier_profile_invalid");
    }
    expect(() => validateTransformerProductionProfile({
      ...environment(),
      MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON: "{}",
    }, "coordinator")).toThrow("transformer_production_verifier_governance_invalid");
    expect(() => validateTransformerProductionProfile({
      ...environment(),
      MENDPOINT_AGENT_VERIFIER_PRICING_JSON: "{}",
    }, "coordinator")).toThrow("transformer_production_verifier_pricing_invalid");
    expect(() => validateTransformerProductionProfile({
      ...environment(),
      MENDPOINT_REGAUGE_VERIFIER_POLICY_ENVELOPE_JSON: "{}",
    }, "coordinator")).toThrow("transformer_production_verifier_policy_invalid");
    for (const baseUrl of [
      "http://api.deepseek.com",
      "https://attacker.example",
      "https://api.deepseek.com/v1",
      " https://api.deepseek.com",
    ]) {
      expect(() => validateTransformerProductionProfile({
        ...environment(),
        MENDPOINT_AGENT_VERIFIER_BASE_URL: baseUrl,
      }, "coordinator")).toThrow("transformer_production_verifier_base_url_invalid");
    }
    const mixedGovernance = JSON.parse(environment().MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON!);
    mixedGovernance.entries[0].externalModelAllowed = false;
    expect(() => validateTransformerProductionProfile({
      ...environment(),
      MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON: JSON.stringify(mixedGovernance),
    }, "coordinator")).toThrow("transformer_production_verifier_governance_invalid");
  });

  it("keeps the workflow policy version aligned with production boot validation", () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, "../../../.github/workflows/regauge-production.yml"),
      "utf8",
    );
    const stagedPolicy = workflow.match(
      /policy_envelope=[\s\S]*?policyEnvelopeId:[\s\S]*?version:\s*(\d+),[\s\S]*?createdAt:/,
    );
    const profilePolicy = JSON.parse(
      environment().MENDPOINT_REGAUGE_VERIFIER_POLICY_ENVELOPE_JSON!,
    ) as { version: number };
    expect(stagedPolicy?.[1]).toBe(String(profilePolicy.version));
    expect(() => validateTransformerProductionProfile(environment(), "coordinator"))
      .not.toThrow();
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
    // The retired legacy override name is no longer read, so it cannot smuggle a
    // shared worker id past the override guard; the Fly-derived id stands.
    expect(resolveTransformerWorkerId({
      ...environment(),
      MENDPOINT_TRANSFORMER_WORKER_ID: "shared-worker",
    })).toBe("fly-abcd1234abcd12");
    expect(() => validateTransformerProductionProfile({
      ...environment(),
      FLY_MACHINE_ID: undefined,
    }, "worker")).toThrow("transformer_production_fly_machine_id_required");
    expect(resolveTransformerWorkerId({
      ...environment(),
      MENDPOINT_DEPLOYMENT_PROFILE: "transformer_pilot",
      MENDPOINT_REGAUGE_COORDINATOR_URL: "https://mendpoint-transformer-pilot.fly.dev/",
    })).toBe("fly-abcd1234abcd12");
  });

  it.each([
    ["regauge_production", "https://mendpoint-regauge-production.fly.dev/"],
    ["transformer_pilot", "https://mendpoint-transformer-pilot.fly.dev/"],
  ])("binds %s to its exact canonical coordinator URL", (profile, canonicalUrl) => {
    expect(validateTransformerProductionProfile({
      ...environment(),
      MENDPOINT_DEPLOYMENT_PROFILE: profile,
      MENDPOINT_REGAUGE_COORDINATOR_URL: canonicalUrl,
    }, "worker").role).toBe("worker");

    for (const coordinatorUrl of [
      canonicalUrl.replace("https://", "http://"),
      canonicalUrl.replace(".fly.dev", "-attacker.fly.dev"),
      canonicalUrl.replace(".fly.dev/", ".fly.dev:443/"),
      canonicalUrl.replace("https://", "https://operator:secret@"),
      `${canonicalUrl}?tenant=other`,
      `${canonicalUrl}#fragment`,
      `${canonicalUrl}v1/regauge/attempt-coordinator`,
      ` ${canonicalUrl}`,
      `${canonicalUrl} `,
    ]) {
      expect(() => validateTransformerProductionProfile({
        ...environment(),
        MENDPOINT_DEPLOYMENT_PROFILE: profile,
        MENDPOINT_REGAUGE_COORDINATOR_URL: coordinatorUrl,
      }, "worker")).toThrow("transformer_production_coordinator_url_invalid");
    }
  });

  it("accepts Fly Tigris standard storage variables and rejects ambiguous aliases", () => {
    const tigris = environment();
    delete tigris.MENDPOINT_REGAUGE_S3_ENDPOINT;
    delete tigris.MENDPOINT_REGAUGE_S3_REGION;
    delete tigris.MENDPOINT_REGAUGE_S3_BUCKET;
    delete tigris.MENDPOINT_REGAUGE_S3_ACCESS_KEY_ID;
    delete tigris.MENDPOINT_REGAUGE_S3_SECRET_ACCESS_KEY;
    Object.assign(tigris, {
      AWS_ENDPOINT_URL_S3: "https://fly.storage.tigris.dev",
      AWS_REGION: "auto",
      BUCKET_NAME: "mendpoint-regauge-pilot",
      AWS_ACCESS_KEY_ID: "tigris-access",
      AWS_SECRET_ACCESS_KEY: "tigris-secret",
    });
    expect(validateTransformerProductionProfile(tigris, "worker").role).toBe("worker");
    expect(() => validateTransformerProductionProfile({
      ...tigris,
      MENDPOINT_REGAUGE_S3_BUCKET: "different-bucket",
    }, "worker")).toThrow("transformer_production_s3_bucket_conflict");
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

  it("requires the coordinator to run the exact production campaign bootstrap", () => {
    expect(() => validateTransformerProductionProfile({
      ...environment(),
      MENDPOINT_REGAUGE_BOOTSTRAP_ENABLED: undefined,
    }, "coordinator")).toThrow("transformer_production_bootstrap_required");
    expect(() => validateTransformerProductionProfile({
      ...environment(),
      MENDPOINT_REGAUGE_BOOTSTRAP_ENABLED: "0",
    }, "coordinator")).toThrow("transformer_production_bootstrap_required");
  });

  it.each([
    ["MENDPOINT_REGAUGE_ENABLED", "0", "transformer_production_activation_required"],
    ["MENDPOINT_REGAUGE_ARTIFACT_BACKEND", "filesystem", "transformer_production_s3_required"],
    ["MENDPOINT_REGAUGE_COORDINATOR_TOKEN", "known-token", "transformer_production_worker_token_invalid"],
    ["MENDPOINT_REGAUGE_COORDINATOR_URL", "http://coordinator.internal", "transformer_production_coordinator_url_invalid"],
    ["MENDPOINT_REGAUGE_S3_PREFIX", `transformer/tenant-b/${CAMPAIGN}`, "transformer_production_s3_prefix_invalid"],
    ["MENDPOINT_REGAUGE_VERIFIER_CONSENT_EXPIRES_AT", "2026-11-21T00:00:00.000Z", "transformer_production_verifier_consent_invalid"],
    ["MENDPOINT_PILOT_SEED", "1", "transformer_production_seed_forbidden"],
  ])("rejects unsafe %s configuration", (name, value, code) => {
    expect(() => validateTransformerProductionProfile({ ...environment(), [name]: value }, "worker")).toThrow(code);
  });

  it("rejects client activation without the exact server grant", () => {
    const wrongGate = JSON.stringify({ schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION, tenantAllowlist: [TENANT], environmentAllowlist: ["production"], grants: [{ tenantId: TENANT, environment: "production", boundaries: ["ui"], acceptanceEvidenceRefs: ["acceptance:pilot"], productionDeliveryApprovalRefs: [] }] });
    expect(() => validateTransformerProductionProfile({ ...environment(), MENDPOINT_REGAUGE_GATE: wrongGate }, "worker")).toThrow("transformer_production_gate_scope_invalid");
  });

  it("requires a single-run draft approval bound to campaign, repository, and canary source revision", () => {
    for (const value of [
      "approval:pilot",
      approval.replace(CAMPAIGN, "campaign-b"),
      approval.replace("repository:123456", "repository:654321"),
      approval.replace(`revision:${CANARY_REVISION}`, `revision:${"c".repeat(40)}`),
      approval.replace("draft:1", "draft:2"),
    ]) {
      const changedGate = JSON.stringify({ schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION, tenantAllowlist: [TENANT], environmentAllowlist: ["production"], grants: [{ tenantId: TENANT, environment: "production", boundaries: ["api_control_plane", "worker_action", "delivery"], acceptanceEvidenceRefs: ["acceptance:pilot"], productionDeliveryApprovalRefs: [value] }] });
      expect(() => validateTransformerProductionProfile({
        ...environment(),
        MENDPOINT_REGAUGE_GATE: changedGate,
        MENDPOINT_REGAUGE_PRODUCTION_APPROVAL_REF: value,
        MENDPOINT_REGAUGE_EVIDENCE_REFS: `${value},evidence:pilot`,
      }, "worker")).toThrow("transformer_production_delivery_approval_scope_invalid");
    }
    expect(() => validateTransformerProductionProfile({
      ...environment(),
      MENDPOINT_REGAUGE_CANARY_REVISION: undefined,
    }, "worker")).toThrow("transformer_production_canary_revision_required");
    expect(() => validateTransformerProductionProfile({
      ...environment(),
      MENDPOINT_REGAUGE_CANARY_REVISION: "main",
    }, "worker")).toThrow("transformer_production_canary_revision_invalid");
  });

  it("keeps expiring draft authority outside stable process boot validation", () => {
    expect(validateTransformerProductionProfile({
      ...environment(),
      MENDPOINT_REGAUGE_ACTIVATION_EXPIRES_AT: undefined,
    }, "worker").role).toBe("worker");
    expect(validateTransformerProductionProfile({
      ...environment(),
      MENDPOINT_REGAUGE_ACTIVATION_EXPIRES_AT: "tomorrow",
    }, "worker").role).toBe("worker");
    expect(validateTransformerProductionProfile({
      ...environment(),
      MENDPOINT_REGAUGE_ACTIVATION_EXPIRES_AT: new Date(Date.now() - 1_000).toISOString(),
    }, "worker").role).toBe("worker");
    expect(validateTransformerProductionProfile({
      ...environment(),
      MENDPOINT_REGAUGE_ACTIVATION_EXPIRES_AT: new Date(Date.now() + 91 * 60_000).toISOString(),
    }, "coordinator").role).toBe("coordinator");
  });
});

function manifestEnvironment(source: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const section = source.match(/\[env\]\s*([\s\S]*?)(?=\n\[|\n\[\[|$)/)?.[1] ?? "";
  for (const match of section.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"\s*$/gm)) {
    env[match[1]!] = match[2]!;
  }
  return env;
}

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production", API_AUTH: "required", API_HOST: "0.0.0.0", GITHUB_MODE: "real",
    MENDPOINT_DEPLOYMENT_PROFILE: "regauge_production", MENDPOINT_DEPLOYMENT_CLASS: "customer", MENDPOINT_REGAUGE_ENABLED: "1",
    MENDPOINT_REGAUGE_MULTINODE_COORDINATOR_ENABLED: "1", MENDPOINT_REGAUGE_MULTINODE_ENABLED: "1",
    MENDPOINT_REGAUGE_ARTIFACT_BACKEND: "s3", MENDPOINT_PILOT_SEED: "0", MENDPOINT_FEED_POLLING_ENABLED: "0",
    MENDPOINT_REGAUGE_TENANT_ID: TENANT, MENDPOINT_REGAUGE_CAMPAIGN_ID: CAMPAIGN, MENDPOINT_REGAUGE_ENVIRONMENT: "production",
    MENDPOINT_REGAUGE_GATE: gate, MENDPOINT_REGAUGE_COORDINATOR_TOKEN: `me_${"a".repeat(40)}`,
    MENDPOINT_REGAUGE_COORDINATOR_URL: "https://mendpoint-regauge-production.fly.dev/",
    MENDPOINT_REGAUGE_CHECKPOINT_KEY: Buffer.alloc(32, 1).toString("base64"), MENDPOINT_REGAUGE_OPERATION_SECRET: Buffer.alloc(32, 2).toString("base64"),
    MENDPOINT_REGAUGE_S3_ENDPOINT: "https://s3.example.com", MENDPOINT_REGAUGE_S3_REGION: "auto", MENDPOINT_REGAUGE_S3_BUCKET: "pilot",
    MENDPOINT_REGAUGE_S3_PREFIX: `transformer/${TENANT}/${CAMPAIGN}`, MENDPOINT_REGAUGE_S3_ACCESS_KEY_ID: "access", MENDPOINT_REGAUGE_S3_SECRET_ACCESS_KEY: "secret",
    MENDPOINT_REGAUGE_EXECUTOR_DIGEST: `sha256:${"e".repeat(64)}`, MENDPOINT_REGAUGE_EVIDENCE_REFS: `${approval},evidence:pilot`,
    MENDPOINT_REGAUGE_READINESS_HOST: "0.0.0.0", MENDPOINT_DATA_DIR: "/data/db", GITHUB_APP_ID: "42", GITHUB_APP_PRIVATE_KEY: "private",
    GITHUB_WEBHOOK_SECRET: "webhook", GITHUB_APP_ACCOUNT_TENANT_BINDINGS: `{"7123456":"${TENANT}"}`,
    FLY_MACHINE_ID: "abcd1234abcd12",
    MENDPOINT_RELEASE_REVISION: RELEASE_REVISION,
    MENDPOINT_REGAUGE_BOOTSTRAP_ENABLED: "1",
    MENDPOINT_REGAUGE_CANARY_REPOSITORY_ID: "123456",
    MENDPOINT_REGAUGE_CANARY_OWNER: "gondalaimafia",
    MENDPOINT_REGAUGE_CANARY_REPOSITORY: "mendpoint-canary-drill-20260801",
    MENDPOINT_REGAUGE_CANARY_BRANCH: "main",
    MENDPOINT_REGAUGE_CANARY_REVISION: CANARY_REVISION,
    MENDPOINT_REGAUGE_PRODUCTION_APPROVAL_REF: approval,
    MENDPOINT_REGAUGE_ACTIVATION_EXPIRES_AT: new Date(Date.now() + 60 * 60_000).toISOString(),
    DEEPSEEK_VERIFIER_ENABLED: "true",
    DEEPSEEK_API_KEY: "deepseek-secret",
    MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE: "advisory",
    MENDPOINT_AGENT_VERIFIER_SCORING_MODE: "nonthinking_logprobs",
    MENDPOINT_AGENT_VERIFIER_EVALUATIONS: "1",
    MENDPOINT_AGENT_VERIFIER_PIVOTS: "1",
    MENDPOINT_AGENT_VERIFIER_MAXIMUM_CANDIDATES: "1",
    MENDPOINT_AGENT_VERIFIER_MAXIMUM_COST_USD: "0.05",
    MENDPOINT_AGENT_VERIFIER_TIMEOUT_MS: "660000",
    MENDPOINT_AGENT_VERIFIER_MAXIMUM_RETRIES: "0",
    MENDPOINT_REGAUGE_VERIFIER_CONSENT_EFFECTIVE_AT: "2026-08-24T00:00:00.000Z",
    MENDPOINT_REGAUGE_VERIFIER_CONSENT_EXPIRES_AT: "2026-11-20T23:59:59.000Z",
    MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON: JSON.stringify({ schemaVersion: "2026-08-17.v1", entries: [{ tenantId: TENANT, products: ["regauge"], dataClassification: "confidential", requiredRegion: "cn", processingRegion: "cn", consentId: "consent-regauge", evidenceRef: "github-environment:regauge-production", externalModelAllowed: true, mayLeaveTenantBoundary: true, consentActive: true }] }),
    MENDPOINT_REGAUGE_VERIFIER_POLICY_ENVELOPE_JSON: JSON.stringify({ policyEnvelopeId: "regauge-deepseek-v4-flash-advisory-20260824", tenantId: TENANT, version: 2, repositoryScope: ["gondalaimafia/mendpoint-canary-drill-20260801"], branchScope: ["main"], forbiddenZones: [], allowedTools: ["deepseek-verifier"], allowedModelClasses: ["rented_specialist"], externalProcessingAllowed: true, residency: "cn", riskCeiling: "high", reviewRequired: true, deploymentAllowed: false, trainingDataAllowed: false, retentionDays: 90, createdAt: "2026-08-24T00:00:00.000Z" }),
    MENDPOINT_AGENT_VERIFIER_PRICING_JSON: JSON.stringify({ version: "deepseek-v4-flash-2026-08-21", currency: "USD", effectiveAt: "2026-08-21T00:00:00.000Z", inputPerMillion: 0.14, cachedInputPerMillion: 0.0028, outputPerMillion: 0.28 }),
  };
}
