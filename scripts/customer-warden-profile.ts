export const CUSTOMER_WARDEN_REQUIRED_SECRETS = Object.freeze([
  "MENDPOINT_API_KEY",
  "MENDPOINT_WEB_ACCESS_TOKEN",
  "MENDPOINT_ALLOWED_MACHINE_ID",
  "MENDPOINT_APPLICATION_DATA_KEY",
  "TRUST_PROXY_SECRET",
  "WEB_URL",
  "CORS_ORIGINS",
  "MENDPOINT_WEB_ALLOWED_ORIGINS",
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
  "OIDC_TENANT_CLAIM",
  "OIDC_REQUIRED_AMR",
  "MENDPOINT_BACKUP_SOURCE_ROOT",
  "MENDPOINT_BACKUP_FENCE_ROOT",
  "MENDPOINT_BACKUP_EVIDENCE_PATH",
  "MENDPOINT_BACKUP_KEY",
  "MENDPOINT_BACKUP_KEY_ID",
  "MENDPOINT_BACKUP_DATABASE_PATH",
  "MENDPOINT_BACKUP_GRAPH_PATH",
  "MENDPOINT_BACKUP_CHANGE_SOURCES_PATH",
  "MENDPOINT_BACKUP_TRANSFORMER_CONTROL_PLANE_PATH",
  "MENDPOINT_BACKUP_TRANSFORMER_PILOT_PATH",
  "MENDPOINT_BACKUP_ARTIFACTS_PATH",
  "MENDPOINT_BACKUP_CONFIGURATION_PATH",
  "MENDPOINT_WARDEN_MODEL_SOURCE_TENANTS",
  "MENDPOINT_WARDEN_MODEL_PROVIDER",
  "MENDPOINT_WARDEN_MODEL_REGION",
  "MENDPOINT_WARDEN_MODEL_MAXIMUM_DATA_CLASSIFICATION",
  "MENDPOINT_WARDEN_MODEL_ESTIMATED_COST_USD",
  "MENDPOINT_WARDEN_MODEL_MAXIMUM_CALL_COST_USD",
  "MENDPOINT_WARDEN_REPOSITORY_CLASSIFICATIONS",
  "LLM_AGENT_MODEL",
  "LLM_AGENT_URL",
  "OPENAI_API_KEY",
] as const);

export const CUSTOMER_WARDEN_RCLONE_REQUIRED_SECRETS = Object.freeze([
  "BUCKET_NAME",
  "AWS_ENDPOINT_URL_S3",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
] as const);

export const CUSTOMER_WARDEN_RCLONE_REQUIRED_SETTINGS = Object.freeze([
  "MENDPOINT_BACKUP_OUTPUT_ROOT",
  "MENDPOINT_BACKUP_STAGING_ROOT",
  "MENDPOINT_BACKUP_OBJECT_PREFIX",
  "MENDPOINT_BACKUP_OPERATION_TIMEOUT_MS",
  "AWS_REGION",
] as const);

const CUSTOMER_SENSITIVE_CHILD_ENV = Object.freeze([
  "MENDPOINT_API_KEY",
  "MENDPOINT_WEB_ACCESS_TOKEN",
  "MENDPOINT_APPLICATION_DATA_KEY",
  "TRUST_PROXY_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "OIDC_CLIENT_SECRET",
  "MENDPOINT_BACKUP_KEY",
  "OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "MENDPOINT_SANDBOX_FLY_TOKEN",
  "FLY_API_TOKEN",
] as const);

const CUSTOMER_ROLE_SECRETS = Object.freeze({
  api: Object.freeze([
    "MENDPOINT_API_KEY",
    "MENDPOINT_APPLICATION_DATA_KEY",
    "TRUST_PROXY_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "MENDPOINT_BACKUP_KEY",
  ]),
  worker: Object.freeze([
    "MENDPOINT_APPLICATION_DATA_KEY",
    "GITHUB_APP_PRIVATE_KEY",
    "OPENAI_API_KEY",
  ]),
  web: Object.freeze([
    "MENDPOINT_API_KEY",
    "MENDPOINT_WEB_ACCESS_TOKEN",
    "OIDC_CLIENT_SECRET",
  ]),
  backup: Object.freeze([
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
  ]),
} as const);

export function customerWardenChildEnvironment(
  role: keyof typeof CUSTOMER_ROLE_SECRETS,
  env: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const scoped = { ...env };
  for (const name of CUSTOMER_SENSITIVE_CHILD_ENV) delete scoped[name];
  for (const name of CUSTOMER_ROLE_SECRETS[role]) {
    if (env[name] !== undefined) scoped[name] = env[name];
  }
  return scoped;
}

const REQUIRED_SETTINGS = Object.freeze({
  MENDPOINT_DEPLOYMENT_PROFILE: "customer",
  MENDPOINT_DEPLOYMENT_CLASS: "customer",
  MENDPOINT_CUSTOMER_READY: "1",
  MENDPOINT_CUSTOMER_TOPOLOGY: "single_node",
  GITHUB_MODE: "real",
  MENDPOINT_FEED_POLLING_ENABLED: "1",
  POLL_LOCAL_ONLY: "0",
  MENDPOINT_PILOT_SEED: "0",
  MENDPOINT_WARDEN_MODEL_SOURCE_ENABLED: "1",
  MENDPOINT_TRANSFORMER_ENABLED: "0",
} as const);

export function validateCustomerWardenRuntime(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const errors: string[] = [];
  for (const [name, expected] of Object.entries(REQUIRED_SETTINGS)) {
    if (env[name]?.trim() !== expected) {
      errors.push(`Customer Warden profile requires ${name}=${expected}`);
    }
  }
  if (env.MENDPOINT_CUSTOMER_MAX_MACHINES?.trim() !== "1") {
    errors.push("Customer Warden profile is bounded to exactly one machine");
  }
  if (env.FLY_MACHINE_ID?.trim() !== env.MENDPOINT_ALLOWED_MACHINE_ID?.trim()) {
    errors.push("Customer Warden profile is bound to its approved Fly machine");
  }
  if (env.MENDPOINT_TRANSFORMER_GATE?.trim()) {
    errors.push("Customer Warden profile forbids MENDPOINT_TRANSFORMER_GATE");
  }
  if (env.MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_ENABLED?.trim() === "1") {
    errors.push(
      "Customer Warden profile forbids MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_ENABLED=1",
    );
  }
  for (const name of CUSTOMER_WARDEN_REQUIRED_SECRETS) {
    if (!env[name]?.trim()) errors.push(`Customer Warden profile requires ${name}`);
  }
  const transport = env.MENDPOINT_BACKUP_TRANSPORT?.trim();
  if (transport !== "rclone_s3" && transport !== "pre_mounted") {
    errors.push("Customer Warden profile requires MENDPOINT_BACKUP_TRANSPORT=rclone_s3 or pre_mounted");
  }
  if (
    (transport === "rclone_s3" && env.MENDPOINT_BACKUP_STORAGE_CLASS?.trim() !== "object_store_publish") ||
    (transport === "pre_mounted" && env.MENDPOINT_BACKUP_STORAGE_CLASS?.trim() !== "durable_isolated_mount")
  ) {
    errors.push(
      "Customer Warden profile requires a storage class matching its backup transport",
    );
  }
  if (
    transport === "rclone_s3" &&
    env.MENDPOINT_BACKUP_OUTPUT_ROOT?.trim() &&
    env.MENDPOINT_BACKUP_OUTPUT_ROOT?.trim() !== env.MENDPOINT_BACKUP_STAGING_ROOT?.trim()
  ) {
    errors.push("Customer Warden profile requires backup output to equal its isolated staging root");
  }
  if (transport === "rclone_s3") {
    for (const name of CUSTOMER_WARDEN_RCLONE_REQUIRED_SETTINGS) {
      if (!env[name]?.trim()) errors.push(`Customer Warden profile requires ${name}`);
    }
    for (const name of CUSTOMER_WARDEN_RCLONE_REQUIRED_SECRETS) {
      if (!env[name]?.trim()) errors.push(`Customer Warden profile requires ${name}`);
    }
    try {
      loadCustomerObjectStoreConfig(env);
    } catch (error) {
      errors.push(
        `Customer Warden profile has invalid object store settings: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
  // Enforced no-egress mode: when local_only is requested, the configured model
  // endpoint (if any) must resolve to a private host before the profile boots.
  const egress = assessModelEgress(env);
  if (egress.violation === "model_egress_mode_invalid") {
    errors.push(
      "Customer Warden profile requires MENDPOINT_MODEL_EGRESS=local_only or external_allowed",
    );
  } else if (egress.violation) {
    errors.push(
      "Customer Warden profile requires a private, loopback, link-local, or allowlisted model endpoint when MENDPOINT_MODEL_EGRESS=local_only",
    );
  }
  return errors;
}
import { loadCustomerObjectStoreConfig } from "./customer-object-store.js";
import { assessModelEgress } from "@mendpoint/shared";
