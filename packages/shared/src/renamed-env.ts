/**
 * Renamed environment variables: Warden -> Fettler, Transformer -> Regauge.
 *
 * Each key is the current (canonical) variable name; each value is the
 * superseded (legacy) name. Several of these are still set as secrets under
 * their legacy names on the live deployment, so every read must prefer the
 * current name and fall back to the legacy one. Do NOT remove a legacy fallback
 * until the corresponding live secret has been migrated to the current name.
 *
 * This map is the single source of truth for the rename. Read sites, tests, and
 * the customer configuration verification all enumerate it, so a variable is
 * only renamed correctly once it appears here with both a current and legacy
 * read path wired.
 */
export const RENAMED_ENV = Object.freeze({
  // Warden -> Fettler
  MENDPOINT_SELF_SERVE_FETTLER: "MENDPOINT_SELF_SERVE_WARDEN",
  MENDPOINT_FETTLER_MODEL_SOURCE_ENABLED: "MENDPOINT_WARDEN_MODEL_SOURCE_ENABLED",
  MENDPOINT_FETTLER_MODEL_SOURCE_TENANTS: "MENDPOINT_WARDEN_MODEL_SOURCE_TENANTS",
  MENDPOINT_FETTLER_MODEL_PROVIDER: "MENDPOINT_WARDEN_MODEL_PROVIDER",
  MENDPOINT_FETTLER_MODEL_REGION: "MENDPOINT_WARDEN_MODEL_REGION",
  MENDPOINT_FETTLER_MODEL_MAXIMUM_DATA_CLASSIFICATION:
    "MENDPOINT_WARDEN_MODEL_MAXIMUM_DATA_CLASSIFICATION",
  MENDPOINT_FETTLER_EXTERNAL_PROCESSING_ALLOWED:
    "MENDPOINT_WARDEN_EXTERNAL_PROCESSING_ALLOWED",
  MENDPOINT_FETTLER_MODEL_ESTIMATED_COST_USD:
    "MENDPOINT_WARDEN_MODEL_ESTIMATED_COST_USD",
  MENDPOINT_FETTLER_MODEL_MAXIMUM_CALL_COST_USD:
    "MENDPOINT_WARDEN_MODEL_MAXIMUM_CALL_COST_USD",
  MENDPOINT_FETTLER_CANDIDATE_TTL_MS: "MENDPOINT_WARDEN_CANDIDATE_TTL_MS",
  MENDPOINT_FETTLER_CANDIDATE_QUOTA_BYTES: "MENDPOINT_WARDEN_CANDIDATE_QUOTA_BYTES",
  MENDPOINT_FETTLER_ORPHAN_GRACE_MS: "MENDPOINT_WARDEN_ORPHAN_GRACE_MS",
  MENDPOINT_FETTLER_REPOSITORY_CLASSIFICATIONS:
    "MENDPOINT_WARDEN_REPOSITORY_CLASSIFICATIONS",
  MENDPOINT_FETTLER_CI_REENTRY_ENABLED: "MENDPOINT_WARDEN_CI_REENTRY_ENABLED",
  MENDPOINT_FETTLER_CI_REENTRY_CONFIG_JSON:
    "MENDPOINT_WARDEN_CI_REENTRY_CONFIG_JSON",

  // Transformer -> Regauge
  MENDPOINT_REGAUGE_ENVIRONMENT: "MENDPOINT_TRANSFORMER_ENVIRONMENT",
  MENDPOINT_REGAUGE_GATE: "MENDPOINT_TRANSFORMER_GATE",
  MENDPOINT_REGAUGE_ENABLED: "MENDPOINT_TRANSFORMER_ENABLED",
  MENDPOINT_REGAUGE_LEARNING_ENABLED: "MENDPOINT_TRANSFORMER_LEARNING_ENABLED",
  MENDPOINT_REGAUGE_HEARTBEAT_MAX_AGE_MS:
    "MENDPOINT_TRANSFORMER_HEARTBEAT_MAX_AGE_MS",
  MENDPOINT_REGAUGE_CONTROL_PLANE_DB: "MENDPOINT_TRANSFORMER_CONTROL_PLANE_DB",
  MENDPOINT_REGAUGE_PILOT_DB: "MENDPOINT_TRANSFORMER_PILOT_DB",
  MENDPOINT_REGAUGE_EVIDENCE_ROOT: "MENDPOINT_TRANSFORMER_EVIDENCE_ROOT",
  MENDPOINT_REGAUGE_CANDIDATE_ROOT: "MENDPOINT_TRANSFORMER_CANDIDATE_ROOT",
  MENDPOINT_REGAUGE_TEMP_ROOT: "MENDPOINT_TRANSFORMER_TEMP_ROOT",
  MENDPOINT_REGAUGE_LEASE_MS: "MENDPOINT_TRANSFORMER_LEASE_MS",

  // Transformer adaptive model source -> Regauge adaptive model source
  MENDPOINT_REGAUGE_ADAPTIVE_MODEL_SOURCE_ENABLED:
    "MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_ENABLED",
  MENDPOINT_REGAUGE_ADAPTIVE_MODEL_SOURCE_TENANTS:
    "MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_TENANTS",
  MENDPOINT_REGAUGE_ADAPTIVE_MODEL_PROVIDER:
    "MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_PROVIDER",
  MENDPOINT_REGAUGE_ADAPTIVE_MODEL_DEPLOYMENT:
    "MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_DEPLOYMENT",
  MENDPOINT_REGAUGE_ADAPTIVE_EXTERNAL_PROCESSING_APPROVED:
    "MENDPOINT_TRANSFORMER_ADAPTIVE_EXTERNAL_PROCESSING_APPROVED",
  MENDPOINT_REGAUGE_ADAPTIVE_EXECUTION_REGION:
    "MENDPOINT_TRANSFORMER_ADAPTIVE_EXECUTION_REGION",
  MENDPOINT_REGAUGE_ADAPTIVE_MAX_DATA_CLASSIFICATION:
    "MENDPOINT_TRANSFORMER_ADAPTIVE_MAX_DATA_CLASSIFICATION",

  // Transformer multinode / production service -> Regauge
  MENDPOINT_REGAUGE_MULTINODE_COORDINATOR_ENABLED:
    "MENDPOINT_TRANSFORMER_MULTINODE_COORDINATOR_ENABLED",
  MENDPOINT_REGAUGE_MULTINODE_ENABLED: "MENDPOINT_TRANSFORMER_MULTINODE_ENABLED",
  MENDPOINT_REGAUGE_ARTIFACT_BACKEND: "MENDPOINT_TRANSFORMER_ARTIFACT_BACKEND",
  MENDPOINT_REGAUGE_TENANT_ID: "MENDPOINT_TRANSFORMER_TENANT_ID",
  MENDPOINT_REGAUGE_CAMPAIGN_ID: "MENDPOINT_TRANSFORMER_CAMPAIGN_ID",
  MENDPOINT_REGAUGE_WORKER_ID: "MENDPOINT_TRANSFORMER_WORKER_ID",
  MENDPOINT_REGAUGE_COORDINATOR_TOKEN: "MENDPOINT_TRANSFORMER_COORDINATOR_TOKEN",
  MENDPOINT_REGAUGE_COORDINATOR_URL: "MENDPOINT_TRANSFORMER_COORDINATOR_URL",
  MENDPOINT_REGAUGE_COORDINATOR_TIMEOUT_MS:
    "MENDPOINT_TRANSFORMER_COORDINATOR_TIMEOUT_MS",
  MENDPOINT_REGAUGE_CHECKPOINT_KEY: "MENDPOINT_TRANSFORMER_CHECKPOINT_KEY",
  MENDPOINT_REGAUGE_OPERATION_SECRET: "MENDPOINT_TRANSFORMER_OPERATION_SECRET",
  MENDPOINT_REGAUGE_EXECUTOR_DIGEST: "MENDPOINT_TRANSFORMER_EXECUTOR_DIGEST",
  MENDPOINT_REGAUGE_EVIDENCE_REFS: "MENDPOINT_TRANSFORMER_EVIDENCE_REFS",
  MENDPOINT_REGAUGE_INTERVAL_MS: "MENDPOINT_TRANSFORMER_INTERVAL_MS",
  MENDPOINT_REGAUGE_MAX_RESPONSE_BYTES: "MENDPOINT_TRANSFORMER_MAX_RESPONSE_BYTES",
  MENDPOINT_REGAUGE_READINESS_HOST: "MENDPOINT_TRANSFORMER_READINESS_HOST",
  MENDPOINT_REGAUGE_READINESS_PORT: "MENDPOINT_TRANSFORMER_READINESS_PORT",
  MENDPOINT_REGAUGE_PRIVATE_DATA_ROOT: "MENDPOINT_TRANSFORMER_PRIVATE_DATA_ROOT",
  MENDPOINT_REGAUGE_SHARED_ARTIFACT_ROOT:
    "MENDPOINT_TRANSFORMER_SHARED_ARTIFACT_ROOT",

  // Transformer S3 artifact transport -> Regauge
  MENDPOINT_REGAUGE_S3_ENDPOINT: "MENDPOINT_TRANSFORMER_S3_ENDPOINT",
  MENDPOINT_REGAUGE_S3_BUCKET: "MENDPOINT_TRANSFORMER_S3_BUCKET",
  MENDPOINT_REGAUGE_S3_PREFIX: "MENDPOINT_TRANSFORMER_S3_PREFIX",
  MENDPOINT_REGAUGE_S3_REGION: "MENDPOINT_TRANSFORMER_S3_REGION",
  MENDPOINT_REGAUGE_S3_ACCESS_KEY_ID: "MENDPOINT_TRANSFORMER_S3_ACCESS_KEY_ID",
  MENDPOINT_REGAUGE_S3_SECRET_ACCESS_KEY:
    "MENDPOINT_TRANSFORMER_S3_SECRET_ACCESS_KEY",
  MENDPOINT_REGAUGE_S3_SESSION_TOKEN: "MENDPOINT_TRANSFORMER_S3_SESSION_TOKEN",

  // Transformer backup paths -> Regauge
  MENDPOINT_BACKUP_REGAUGE_CONTROL_PLANE_PATH:
    "MENDPOINT_BACKUP_TRANSFORMER_CONTROL_PLANE_PATH",
  MENDPOINT_BACKUP_REGAUGE_PILOT_PATH: "MENDPOINT_BACKUP_TRANSFORMER_PILOT_PATH",

  // Transformer live eval -> Regauge live eval
  MENDPOINT_EVAL_LIVE_REGAUGE: "MENDPOINT_EVAL_LIVE_TRANSFORMER",
  MENDPOINT_REGAUGE_LIVE_EVAL_MAX_USD: "MENDPOINT_TRANSFORMER_LIVE_EVAL_MAX_USD",
  MENDPOINT_REGAUGE_LIVE_EVAL_TENANT: "MENDPOINT_TRANSFORMER_LIVE_EVAL_TENANT",
  MENDPOINT_REGAUGE_LIVE_MIN_PASS_RATE: "MENDPOINT_TRANSFORMER_LIVE_MIN_PASS_RATE",
  MENDPOINT_REGAUGE_LIVE_MIN_CONSISTENCY:
    "MENDPOINT_TRANSFORMER_LIVE_MIN_CONSISTENCY",
} as const satisfies Readonly<Record<string, string>>);

export type RenamedEnvName = keyof typeof RENAMED_ENV;

type EnvLike = Readonly<Record<string, string | undefined>>;

/** Reverse of RENAMED_ENV: legacy name -> current (canonical) name. */
const LEGACY_TO_CURRENT: Readonly<Record<string, RenamedEnvName>> = Object.freeze(
  Object.fromEntries(
    (Object.entries(RENAMED_ENV) as ReadonlyArray<[RenamedEnvName, string]>).map(
      ([current, legacy]) => [legacy, current] as const,
    ),
  ),
);

/**
 * Read a renamed environment variable, preferring the current name and falling
 * back to the superseded one. Presence is decided by trimming: a missing or
 * whitespace-only value on the current name falls through to the legacy name, so
 * the current name only wins when it actually carries a value.
 *
 * The raw (untrimmed) configured value is returned unchanged, and a value that
 * is set but empty on both names is still surfaced, so call sites that trim,
 * compare, or specifically validate emptiness behave exactly as they did when
 * reading the legacy variable directly. Production still holds secrets under the
 * legacy names, so the fallback must not be removed until they are migrated.
 */
export function readRenamedEnv(
  env: EnvLike,
  current: string,
  legacy: string,
): string | undefined {
  const currentValue = env[current];
  if (currentValue !== undefined && currentValue.trim() !== "") return currentValue;
  const legacyValue = env[legacy];
  if (legacyValue !== undefined && legacyValue.trim() !== "") return legacyValue;
  // Neither name carries a non-whitespace value. Preserve a set-but-empty value
  // (current first) so nothing that treats "set but empty" specially changes.
  if (currentValue !== undefined) return currentValue;
  return legacyValue;
}

/**
 * Resolve a renamed variable by its current name, taking its legacy name from
 * the source-of-truth map. Prefer this at read sites where the current name is
 * known statically, so a typo is a compile error rather than a silent miss.
 */
export function resolveRenamedEnv(
  env: EnvLike,
  current: RenamedEnvName,
): string | undefined {
  return readRenamedEnv(env, current, RENAMED_ENV[current]);
}

/**
 * Resolve a variable given either its current name, its legacy name, or an
 * unrelated name. Used where code iterates a list of variable names that predate
 * the rename (for example the customer configuration required-secrets list and
 * the production profile checks): renamed names dual-read, unrelated names read
 * directly.
 */
export function resolveEitherRenamedEnv(
  env: EnvLike,
  name: string,
): string | undefined {
  const legacy = (RENAMED_ENV as Readonly<Record<string, string>>)[name];
  if (legacy !== undefined) return readRenamedEnv(env, name, legacy);
  const current = LEGACY_TO_CURRENT[name];
  if (current !== undefined) return readRenamedEnv(env, current, name);
  return env[name];
}
