import { parseTransformerGateConfig, resolveReleaseRevision } from "@mendpoint/ops";
import { resolveEitherRenamedEnv, resolveRenamedEnv } from "@mendpoint/shared";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const API_KEY = /^me_[A-Za-z0-9_-]{32,}$/;
const FLY_MACHINE_ID = /^[a-f0-9]{14,32}$/;
const NUMERIC_ID = /^[1-9][0-9]{0,19}$/;

export type TransformerProductionRole = "coordinator" | "worker";

type TransformerProductionProfileBase = Readonly<{
  tenantId: string;
  campaignId: string;
  environment: string;
}>;

export type TransformerProductionProfile =
  | (TransformerProductionProfileBase & Readonly<{ role: "coordinator" }>)
  | (TransformerProductionProfileBase & Readonly<{ role: "worker"; workerId: string }>);

export type TransformerS3Config = Readonly<{
  endpoint: string | undefined;
  region: string | undefined;
  bucket: string | undefined;
  accessKeyId: string | undefined;
  secretAccessKey: string | undefined;
  sessionToken: string | undefined;
}>;

export function resolveTransformerS3Config(env: NodeJS.ProcessEnv): TransformerS3Config {
  return Object.freeze({
    endpoint: resolveStorageAlias(
      resolveRenamedEnv(env, "MENDPOINT_REGAUGE_S3_ENDPOINT"),
      env.AWS_ENDPOINT_URL_S3,
      "transformer_production_s3_endpoint_conflict",
    ),
    region: resolveStorageAlias(
      resolveRenamedEnv(env, "MENDPOINT_REGAUGE_S3_REGION"),
      env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
      "transformer_production_s3_region_conflict",
    ),
    bucket: resolveStorageAlias(
      resolveRenamedEnv(env, "MENDPOINT_REGAUGE_S3_BUCKET"),
      env.BUCKET_NAME,
      "transformer_production_s3_bucket_conflict",
    ),
    accessKeyId: resolveStorageAlias(
      resolveRenamedEnv(env, "MENDPOINT_REGAUGE_S3_ACCESS_KEY_ID"),
      env.AWS_ACCESS_KEY_ID,
      "transformer_production_s3_access_key_conflict",
    ),
    secretAccessKey: resolveStorageAlias(
      resolveRenamedEnv(env, "MENDPOINT_REGAUGE_S3_SECRET_ACCESS_KEY"),
      env.AWS_SECRET_ACCESS_KEY,
      "transformer_production_s3_secret_key_conflict",
    ),
    sessionToken: resolveStorageAlias(
      resolveRenamedEnv(env, "MENDPOINT_REGAUGE_S3_SESSION_TOKEN"),
      env.AWS_SESSION_TOKEN,
      "transformer_production_s3_session_token_conflict",
    ),
  });
}

export function resolveTransformerWorkerId(env: NodeJS.ProcessEnv): string {
  if (env.MENDPOINT_DEPLOYMENT_PROFILE === "transformer_pilot") {
    exact(env.NODE_ENV, "production", "transformer_production_node_env_required");
    if (resolveRenamedEnv(env, "MENDPOINT_REGAUGE_WORKER_ID")?.trim()) {
      throw new Error("transformer_production_worker_id_override_forbidden");
    }
    const machineId = required(
      env.FLY_MACHINE_ID,
      "transformer_production_fly_machine_id_required",
    );
    if (!FLY_MACHINE_ID.test(machineId)) {
      throw new Error("transformer_production_fly_machine_id_invalid");
    }
    return `fly-${machineId}`;
  }
  return identifier(
    resolveRenamedEnv(env, "MENDPOINT_REGAUGE_WORKER_ID"),
    "transformer_multinode_worker_id_required",
  );
}

export function validateTransformerProductionProfile(
  env: NodeJS.ProcessEnv,
  role: TransformerProductionRole,
): TransformerProductionProfile {
  if (role !== "coordinator" && role !== "worker") throw new Error("transformer_production_role_invalid");
  exact(env.NODE_ENV, "production", "transformer_production_node_env_required");
  exact(env.MENDPOINT_DEPLOYMENT_PROFILE, "transformer_pilot", "transformer_production_profile_required");
  exact(env.MENDPOINT_DEPLOYMENT_CLASS, "customer", "transformer_production_deployment_class_required");
  exact(env.API_AUTH, "required", "transformer_production_api_auth_required");
  exact(env.GITHUB_MODE, "real", "transformer_production_github_real_required");
  exact(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_ENABLED"), "1", "transformer_production_activation_required");
  exact(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_MULTINODE_COORDINATOR_ENABLED"), "1", "transformer_production_coordinator_required");
  exact(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_MULTINODE_ENABLED"), "1", "transformer_production_worker_required");
  exact(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_ARTIFACT_BACKEND"), "s3", "transformer_production_s3_required");
  if (!env.MENDPOINT_RELEASE_REVISION?.trim()) {
    throw new Error("transformer_production_release_revision_required");
  }
  try {
    const resolvedRevision = resolveReleaseRevision(env);
    if (!resolvedRevision) throw new Error("release_revision_missing");
  } catch {
    throw new Error("transformer_production_release_revision_invalid");
  }
  exact(env.MENDPOINT_PILOT_SEED ?? "0", "0", "transformer_production_seed_forbidden");
  exact(env.MENDPOINT_FEED_POLLING_ENABLED ?? "0", "0", "transformer_production_feed_forbidden");

  const tenantId = identifier(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_TENANT_ID"), "transformer_production_tenant_required");
  const campaignId = identifier(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_CAMPAIGN_ID"), "transformer_production_campaign_required");
  const environment = identifier(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_ENVIRONMENT"), "transformer_production_environment_required");
  if (environment !== "production") throw new Error("transformer_production_environment_invalid");
  const gate = parseTransformerGateConfig(required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_GATE"), "transformer_production_gate_required"));
  const grant = gate.grants.find((candidate) => candidate.tenantId === tenantId && candidate.environment === environment);
  if (!grant || !["api_control_plane", "worker_action", "delivery"].every((boundary) => grant.boundaries.includes(boundary as never))) {
    throw new Error("transformer_production_gate_scope_invalid");
  }
  if (!gate.tenantAllowlist.includes(tenantId) || !gate.environmentAllowlist.includes(environment)) {
    throw new Error("transformer_production_gate_scope_invalid");
  }
  if (!grant.productionDeliveryApprovalRefs.length) throw new Error("transformer_production_delivery_approval_required");
  const repositoryId = required(
    env.MENDPOINT_REGAUGE_CANARY_REPOSITORY_ID,
    "transformer_production_canary_repository_id_required",
  );
  if (!NUMERIC_ID.test(repositoryId)) {
    throw new Error("transformer_production_canary_repository_id_invalid");
  }
  const canaryRevision = required(
    env.MENDPOINT_REGAUGE_CANARY_REVISION,
    "transformer_production_canary_revision_required",
  );
  if (!/^[a-f0-9]{40}$/.test(canaryRevision)) {
    throw new Error("transformer_production_canary_revision_invalid");
  }
  const productionApprovalRef = required(
    env.MENDPOINT_REGAUGE_PRODUCTION_APPROVAL_REF,
    "transformer_production_delivery_approval_required",
  );
  const expectedApprovalPrefix = [
    "approval:regauge",
    tenantId,
    campaignId,
    "repository",
    repositoryId,
    "revision",
    canaryRevision,
    "draft:1:run",
  ].join(":");
  const approvalSuffix = productionApprovalRef.slice(expectedApprovalPrefix.length);
  if (
    !productionApprovalRef.startsWith(expectedApprovalPrefix) ||
    !/^:[1-9][0-9]*:attempt:[1-9][0-9]*$/.test(approvalSuffix) ||
    !grant.productionDeliveryApprovalRefs.includes(productionApprovalRef)
  ) {
    throw new Error("transformer_production_delivery_approval_scope_invalid");
  }
  const activationExpiry = required(
    env.MENDPOINT_REGAUGE_ACTIVATION_EXPIRES_AT,
    "transformer_production_activation_expiry_required",
  );
  const activationExpiresAt = Date.parse(activationExpiry);
  const now = Date.now();
  if (
    !Number.isFinite(activationExpiresAt) ||
    new Date(activationExpiresAt).toISOString() !== activationExpiry ||
    activationExpiresAt > now + 90 * 60_000
  ) {
    throw new Error("transformer_production_activation_expiry_invalid");
  }
  if (role === "worker" && activationExpiresAt <= now) {
    throw new Error("transformer_production_activation_expired");
  }

  const token = required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_COORDINATOR_TOKEN"), "transformer_production_worker_token_required");
  if (!API_KEY.test(token)) throw new Error("transformer_production_worker_token_invalid");
  const coordinatorUrl = required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_COORDINATOR_URL"), "transformer_production_coordinator_url_required");
  let parsedUrl: URL;
  try { parsedUrl = new URL(coordinatorUrl); } catch { throw new Error("transformer_production_coordinator_url_invalid"); }
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error("transformer_production_coordinator_url_invalid");
  }

  key(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_CHECKPOINT_KEY"), "transformer_production_checkpoint_key_required");
  key(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_OPERATION_SECRET"), "transformer_production_operation_secret_required");
  for (const name of [
    "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET",
    "GITHUB_APP_ACCOUNT_TENANT_BINDINGS",
  ] as const) required(resolveEitherRenamedEnv(env, name), `transformer_production_${name.toLowerCase()}_required`);
  const s3 = resolveTransformerS3Config(env);
  secureUrl(s3.endpoint, "transformer_production_s3_endpoint_invalid");
  required(s3.region, "transformer_production_s3_region_required");
  required(s3.accessKeyId, "transformer_production_s3_access_key_required");
  required(s3.secretAccessKey, "transformer_production_s3_secret_key_required");
  const bucket = required(s3.bucket, "transformer_production_s3_bucket_required");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("transformer_production_s3_bucket_invalid");
  if (required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_S3_PREFIX"), "transformer_production_s3_prefix_required") !== `transformer/${tenantId}/${campaignId}`) {
    throw new Error("transformer_production_s3_prefix_invalid");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_EXECUTOR_DIGEST"), "transformer_production_executor_digest_required"))) {
    throw new Error("transformer_production_executor_digest_invalid");
  }
  const evidenceRefs = required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_EVIDENCE_REFS"), "transformer_production_evidence_refs_required").split(",").map((value) => value.trim()).filter(Boolean);
  if (!evidenceRefs.length || new Set(evidenceRefs).size !== evidenceRefs.length) throw new Error("transformer_production_evidence_refs_invalid");
  if (!evidenceRefs.includes(productionApprovalRef)) {
    throw new Error("transformer_production_delivery_approval_scope_invalid");
  }

  if (role === "coordinator") {
    exact(env.MENDPOINT_REGAUGE_BOOTSTRAP_ENABLED, "1", "transformer_production_bootstrap_required");
    exact(env.API_HOST, "0.0.0.0", "transformer_production_api_host_invalid");
    const dataDir = required(env.MENDPOINT_DATA_DIR, "transformer_production_data_dir_required").replaceAll("\\", "/");
    if (dataDir !== "/data/db" && !dataDir.startsWith("/data/db/")) throw new Error("transformer_production_data_dir_invalid");
  } else {
    exact(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_READINESS_HOST"), "0.0.0.0", "transformer_production_readiness_host_invalid");
  }

  return role === "worker"
    ? Object.freeze({
      role,
      tenantId,
      campaignId,
      environment,
      workerId: resolveTransformerWorkerId(env),
    })
    : Object.freeze({ role, tenantId, campaignId, environment });
}

function exact(value: string | undefined, expected: string, code: string): void { if (value !== expected) throw new Error(code); }
function required(value: string | undefined, code: string): string { if (!value?.trim()) throw new Error(code); return value.trim(); }
function identifier(value: string | undefined, code: string): string { const result = required(value, code); if (!ID.test(result)) throw new Error(code); return result; }
function key(value: string | undefined, code: string): void { const encoded = required(value, code); const bytes = Buffer.from(encoded, "base64"); if (bytes.byteLength !== 32 || bytes.toString("base64") !== encoded) throw new Error(code); }
function secureUrl(value: string | undefined, code: string): void { let parsed: URL; try { parsed = new URL(required(value, code)); } catch { throw new Error(code); } if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(code); }
function resolveStorageAlias(custom: string | undefined, standard: string | undefined, code: string): string | undefined {
  const customValue = custom?.trim();
  const standardValue = standard?.trim();
  if (customValue && standardValue && customValue !== standardValue) throw new Error(code);
  return customValue || standardValue || custom || standard;
}
