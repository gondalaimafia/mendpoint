import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CUSTOMER_WARDEN_REQUIRED_SECRETS,
  CUSTOMER_WARDEN_RCLONE_REQUIRED_SETTINGS,
  CUSTOMER_WARDEN_RCLONE_REQUIRED_SECRETS,
  customerWardenChildEnvironment,
  validateCustomerWardenRuntime,
} from "./customer-warden-profile.js";
import { SANDBOX_EGRESS_ATTESTATION_SCHEMA } from "@mendpoint/platform";

const manifestPath = resolve(import.meta.dirname, "../fly.customer-warden.toml");

function customerRuntime(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    MENDPOINT_DEPLOYMENT_PROFILE: "customer",
    MENDPOINT_DEPLOYMENT_CLASS: "customer",
    MENDPOINT_CUSTOMER_READY: "0",
    MENDPOINT_CUSTOMER_TOPOLOGY: "single_node",
    MENDPOINT_CUSTOMER_MAX_MACHINES: "1",
    FLY_MACHINE_ID: "machine-approved",
    GITHUB_MODE: "real",
    MENDPOINT_FEED_POLLING_ENABLED: "1",
    POLL_LOCAL_ONLY: "0",
    MENDPOINT_PILOT_SEED: "0",
    MENDPOINT_WARDEN_MODEL_SOURCE_ENABLED: "1",
    MENDPOINT_TRANSFORMER_ENABLED: "0",
    MENDPOINT_BACKUP_TRANSPORT: "rclone_s3",
    ...overrides,
  };
  for (const name of CUSTOMER_WARDEN_REQUIRED_SECRETS) env[name] ??= `${name}-configured`;
  env.MENDPOINT_SANDBOX_EGRESS_ATTESTATION_MIN_SCHEMA =
    SANDBOX_EGRESS_ATTESTATION_SCHEMA;
  env.MENDPOINT_ALLOWED_MACHINE_ID = overrides.MENDPOINT_ALLOWED_MACHINE_ID ?? env.FLY_MACHINE_ID;
  env.MENDPOINT_BACKUP_STAGING_ROOT = overrides.MENDPOINT_BACKUP_STAGING_ROOT ?? "/tmp/mendpoint-backup-staging";
  env.MENDPOINT_BACKUP_OUTPUT_ROOT = overrides.MENDPOINT_BACKUP_OUTPUT_ROOT ?? env.MENDPOINT_BACKUP_STAGING_ROOT;
  env.MENDPOINT_BACKUP_OBJECT_PREFIX = overrides.MENDPOINT_BACKUP_OBJECT_PREFIX ?? "backups";
  env.MENDPOINT_BACKUP_OPERATION_TIMEOUT_MS = overrides.MENDPOINT_BACKUP_OPERATION_TIMEOUT_MS ?? "14400000";
  env.MENDPOINT_BACKUP_STORAGE_CLASS = overrides.MENDPOINT_BACKUP_STORAGE_CLASS ?? "object_store_publish";
  env.BUCKET_NAME ??= "mendpoint-customer-backups";
  env.AWS_ENDPOINT_URL_S3 ??= "https://t3.storage.dev";
  env.AWS_ACCESS_KEY_ID ??= "configured-access-key";
  env.AWS_SECRET_ACCESS_KEY ??= "configured-secret-key";
  env.AWS_REGION ??= "auto";
  return env;
}

describe("Fettler-only customer Fly profile", () => {
  it("declares a single-node Fettler-only production topology without embedding secrets", () => {
    const manifest = readFileSync(manifestPath, "utf8");
    const dockerfile = readFileSync(resolve(import.meta.dirname, "../Dockerfile"), "utf8");

    for (const setting of [
      'MENDPOINT_DEPLOYMENT_PROFILE = "customer"',
      'MENDPOINT_DEPLOYMENT_CLASS = "customer"',
      'MENDPOINT_CUSTOMER_TOPOLOGY = "single_node"',
      'MENDPOINT_CUSTOMER_MAX_MACHINES = "1"',
      'GITHUB_MODE = "real"',
      'MENDPOINT_FEED_POLLING_ENABLED = "1"',
      'MENDPOINT_WARDEN_MODEL_SOURCE_ENABLED = "1"',
      'MENDPOINT_TRANSFORMER_ENABLED = "0"',
      'MENDPOINT_BACKUP_TRANSPORT = "rclone_s3"',
      'MENDPOINT_BACKUP_OUTPUT_ROOT = "/tmp/mendpoint-backup-staging"',
      'MENDPOINT_BACKUP_STAGING_ROOT = "/tmp/mendpoint-backup-staging"',
      'MENDPOINT_BACKUP_OBJECT_PREFIX = "backups"',
      'MENDPOINT_BACKUP_OPERATION_TIMEOUT_MS = "14400000"',
      'MENDPOINT_BACKUP_STORAGE_CLASS = "object_store_publish"',
      'AWS_REGION = "auto"',
      'min_machines_running = 1',
      'auto_stop_machines = "off"',
      'path = "/livez"',
    ]) expect(manifest).toContain(setting);

    expect(manifest).not.toContain("MENDPOINT_TRANSFORMER_GATE");
    // Readiness is declared per deployment, never baked into the shared profile
    // as an inherited constant.
    expect(manifest).not.toMatch(/^\s*MENDPOINT_CUSTOMER_READY\s*=/m);
    expect(manifest).toContain(
      "Readiness is declared per deployment, never inherited as a shared constant.",
    );
    expect(dockerfile).toMatch(/apt-get install[^\n]*rclone/);
    expect(dockerfile).not.toContain("fuse3");
    expect(dockerfile).not.toContain("user_allow_other");
    for (const name of CUSTOMER_WARDEN_REQUIRED_SECRETS) {
      expect(manifest).not.toMatch(new RegExp(`^\\s*${name}\\s*=`, "m"));
    }
  });

  it("requires real GitHub, browser OIDC, feed, and isolated backup material by name", () => {
    expect(CUSTOMER_WARDEN_REQUIRED_SECRETS).toEqual(expect.arrayContaining([
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_APP_ACCOUNT_TENANT_BINDINGS",
      "OIDC_ISSUER",
      "OIDC_AUDIENCE",
      "OIDC_JWKS_URI",
      "OIDC_CLIENT_ID",
      "OIDC_CLIENT_SECRET",
      "OIDC_REDIRECT_URI",
      "MENDPOINT_BACKUP_KEY",
      "MENDPOINT_BACKUP_KEY_ID",
      "MENDPOINT_ALLOWED_MACHINE_ID",
      "MENDPOINT_WARDEN_REPOSITORY_CLASSIFICATIONS",
      "MENDPOINT_SANDBOX_FLY_TOKEN",
      "MENDPOINT_SANDBOX_EGRESS_ATTESTATION_BASE64",
      "MENDPOINT_SANDBOX_EGRESS_ATTESTATION_PUBLIC_KEY_SPKI_BASE64",
      "MENDPOINT_SANDBOX_EGRESS_ATTESTATION_KEY_ID",
      "MENDPOINT_SANDBOX_EGRESS_POLICY_DIGEST",
    ]));

    for (const name of CUSTOMER_WARDEN_REQUIRED_SECRETS) {
      const env = customerRuntime();
      delete env[name];
      expect(validateCustomerWardenRuntime(env)).toContain(
        `Customer Fettler profile requires ${name}`,
      );
    }
    for (const name of CUSTOMER_WARDEN_RCLONE_REQUIRED_SECRETS) {
      const env = customerRuntime();
      delete env[name];
      expect(validateCustomerWardenRuntime(env)).toContain(
        `Customer Fettler profile requires ${name}`,
      );
    }
    for (const name of CUSTOMER_WARDEN_RCLONE_REQUIRED_SETTINGS) {
      const env = customerRuntime();
      delete env[name];
      expect(validateCustomerWardenRuntime(env)).toContain(
        `Customer Fettler profile requires ${name}`,
      );
    }
    expect(validateCustomerWardenRuntime(customerRuntime({
      MENDPOINT_BACKUP_OBJECT_PREFIX: "../escape",
    }))).toContain(
      "Customer Fettler profile has invalid object store settings: customer_backup_object_prefix_invalid",
    );
    expect(validateCustomerWardenRuntime(customerRuntime({
      MENDPOINT_BACKUP_OPERATION_TIMEOUT_MS: "120000",
    }))).toEqual([]);
    expect(validateCustomerWardenRuntime(customerRuntime({
      MENDPOINT_BACKUP_OPERATION_TIMEOUT_MS: "59999",
    }))).toContain(
      "Customer Fettler profile has invalid object store settings: customer_backup_operation_timeout_invalid",
    );
  });

  it("limits each runtime child to the secrets it needs", () => {
    const env = customerRuntime();
    env.MENDPOINT_SANDBOX_FLY_TOKEN = "sandbox-token";
    env.FLY_API_TOKEN = "deploy-token";
    env.AWS_SESSION_TOKEN = "aws-session";
    const api = customerWardenChildEnvironment("api", env);
    const worker = customerWardenChildEnvironment("worker", env);
    const web = customerWardenChildEnvironment("web", env);
    const backup = customerWardenChildEnvironment("backup", env);

    expect(api.GITHUB_APP_PRIVATE_KEY).toBe(env.GITHUB_APP_PRIVATE_KEY);
    expect(api.MENDPOINT_BACKUP_KEY).toBe(env.MENDPOINT_BACKUP_KEY);
    expect(api.OPENAI_API_KEY).toBeUndefined();
    expect(api.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(api.MENDPOINT_SANDBOX_KIND).toBe(env.MENDPOINT_SANDBOX_KIND);
    expect(api.MENDPOINT_SANDBOX_FLY_APP).toBe(env.MENDPOINT_SANDBOX_FLY_APP);
    expect(api.MENDPOINT_SANDBOX_FLY_IMAGE).toBe(env.MENDPOINT_SANDBOX_FLY_IMAGE);
    expect(api.MENDPOINT_SANDBOX_FLY_TOKEN).toBe(env.MENDPOINT_SANDBOX_FLY_TOKEN);
    expect(api.MENDPOINT_SANDBOX_EGRESS_ATTESTATION_MIN_SCHEMA).toBe(
      SANDBOX_EGRESS_ATTESTATION_SCHEMA,
    );
    expect(api.MENDPOINT_PROCESS_ROLE).toBe("api");
    expect(api.FLY_API_TOKEN).toBeUndefined();
    expect(worker.OPENAI_API_KEY).toBe(env.OPENAI_API_KEY);
    expect(worker.GITHUB_APP_PRIVATE_KEY).toBe(env.GITHUB_APP_PRIVATE_KEY);
    expect(worker.MENDPOINT_BACKUP_KEY).toBeUndefined();
    expect(worker.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(worker.MENDPOINT_SANDBOX_FLY_TOKEN).toBe(env.MENDPOINT_SANDBOX_FLY_TOKEN);
    expect(worker.MENDPOINT_SANDBOX_KIND).toBe(env.MENDPOINT_SANDBOX_KIND);
    expect(worker.MENDPOINT_SANDBOX_FLY_APP).toBe(env.MENDPOINT_SANDBOX_FLY_APP);
    expect(worker.MENDPOINT_SANDBOX_FLY_IMAGE).toBe(env.MENDPOINT_SANDBOX_FLY_IMAGE);
    expect(worker.MENDPOINT_PROCESS_ROLE).toBe("worker");
    expect(worker.FLY_API_TOKEN).toBeUndefined();
    expect(web.MENDPOINT_API_KEY).toBe(env.MENDPOINT_API_KEY);
    expect(web.OIDC_CLIENT_SECRET).toBe(env.OIDC_CLIENT_SECRET);
    expect(web.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(web.OPENAI_API_KEY).toBeUndefined();
    expect(web.MENDPOINT_SANDBOX_FLY_TOKEN).toBeUndefined();
    expect(web.FLY_API_TOKEN).toBeUndefined();
    expect(backup.AWS_SECRET_ACCESS_KEY).toBe(env.AWS_SECRET_ACCESS_KEY);
    expect(backup.AWS_SESSION_TOKEN).toBe(env.AWS_SESSION_TOKEN);
    expect(backup.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(backup.MENDPOINT_BACKUP_KEY).toBeUndefined();
  });

  it("fails closed when Regauge authority or a multi-node topology is requested", () => {
    expect(validateCustomerWardenRuntime(customerRuntime())).toEqual([]);
    expect(validateCustomerWardenRuntime(customerRuntime({
      MENDPOINT_TRANSFORMER_ENABLED: "1",
    }))).toContain("Customer Fettler profile requires MENDPOINT_TRANSFORMER_ENABLED=0");
    expect(validateCustomerWardenRuntime(customerRuntime({
      MENDPOINT_TRANSFORMER_GATE: '{"tenant_default":true}',
    }))).toContain("Customer Fettler profile forbids MENDPOINT_TRANSFORMER_GATE");
    expect(validateCustomerWardenRuntime(customerRuntime({
      MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_ENABLED: "1",
    }))).toContain(
      "Customer Fettler profile forbids MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_ENABLED=1",
    );
    expect(validateCustomerWardenRuntime(customerRuntime({
      MENDPOINT_CUSTOMER_MAX_MACHINES: "2",
    }))).toContain("Customer Fettler profile is bounded to exactly one machine");
    expect(validateCustomerWardenRuntime(customerRuntime({
      FLY_MACHINE_ID: "machine-unapproved",
      MENDPOINT_ALLOWED_MACHINE_ID: "machine-approved",
    }))).toContain("Customer Fettler profile is bound to its approved Fly machine");
    expect(validateCustomerWardenRuntime(customerRuntime({
      MENDPOINT_BACKUP_TRANSPORT: "local_directory",
    }))).toContain(
      "Customer Fettler profile requires MENDPOINT_BACKUP_TRANSPORT=rclone_s3 or pre_mounted",
    );
  });

  it("lets a deployment declare its own readiness and fails closed when it cannot", () => {
    // A realistic configuration that declares itself ready boots ready.
    expect(
      validateCustomerWardenRuntime(customerRuntime({ MENDPOINT_CUSTOMER_READY: "1" })),
    ).toEqual([]);

    // An honest not-ready hold still boots; the readiness probe reports it.
    expect(
      validateCustomerWardenRuntime(customerRuntime({ MENDPOINT_CUSTOMER_READY: "0" })),
    ).toEqual([]);

    // Declared ready but a precondition is unmet: the specific precondition is
    // named and the deployment does not boot ready.
    const missingSecret = customerRuntime({ MENDPOINT_CUSTOMER_READY: "1" });
    delete missingSecret.OIDC_ISSUER;
    const missingSecretErrors = validateCustomerWardenRuntime(missingSecret);
    expect(missingSecretErrors).toContain("Customer Fettler profile requires OIDC_ISSUER");
    expect(missingSecretErrors).not.toEqual([]);

    // Indeterminate (unset) declaration fails closed at boot, named.
    const unset = customerRuntime();
    delete unset.MENDPOINT_CUSTOMER_READY;
    const unsetErrors = validateCustomerWardenRuntime(unset);
    expect(unsetErrors).not.toEqual([]);
    expect(unsetErrors.some((e) => e.includes("MENDPOINT_CUSTOMER_READY could not be determined")))
      .toBe(true);
    expect(unsetErrors.some((e) => e.includes("got unset"))).toBe(true);

    // Indeterminate (unrecognized value) fails closed at boot, named.
    const garbageErrors = validateCustomerWardenRuntime(
      customerRuntime({ MENDPOINT_CUSTOMER_READY: "maybe" }),
    );
    expect(garbageErrors.some((e) => e.includes("MENDPOINT_CUSTOMER_READY could not be determined")))
      .toBe(true);
    expect(garbageErrors.some((e) => e.includes('got "maybe"'))).toBe(true);
  });

  it("asserts a local model endpoint at boot under local_only egress", () => {
    expect(validateCustomerWardenRuntime(customerRuntime({
      MENDPOINT_MODEL_EGRESS: "local_only",
      LLM_AGENT_URL: "https://api.meta.ai/v1",
    }))).toContain(
      "Customer Fettler profile requires a private, loopback, link-local, or allowlisted model endpoint when MENDPOINT_MODEL_EGRESS=local_only",
    );
    expect(validateCustomerWardenRuntime(customerRuntime({
      MENDPOINT_MODEL_EGRESS: "local_only",
      LLM_AGENT_URL: "http://127.0.0.1:11434/v1",
    }))).toEqual([]);
    expect(validateCustomerWardenRuntime(customerRuntime({
      MENDPOINT_MODEL_EGRESS: "on",
      LLM_AGENT_URL: "http://127.0.0.1:11434/v1",
    }))).toContain(
      "Customer Fettler profile requires MENDPOINT_MODEL_EGRESS=local_only or external_allowed",
    );
  });
});
