/**
 * Renamed environment variables: Warden -> Fettler, Transformer -> Regauge.
 *
 * The rename produced two classes of aliases, kept apart deliberately:
 *
 *  - RENAMED_ENV holds the aliases that are STILL ACTIVE. Each read prefers the
 *    current (canonical) name and falls back to the superseded (legacy) one,
 *    because a live deployment still carries the value under the legacy name and
 *    that setter cannot be changed from this repository. Do NOT remove a legacy
 *    fallback here until the corresponding live secret has been migrated.
 *
 *  - RETIRED_ENV holds the aliases that have been RETIRED. Every place that used
 *    to set the legacy name now sets the current one (config, workflows, docs),
 *    so the reader no longer honours the legacy value: it reads the current name
 *    only. If a deployment still sets nothing but the retired legacy name, that
 *    is refused loudly at boot (see validateApiEnv in @mendpoint/ops) with a
 *    message naming the current variable, rather than silently falling back to a
 *    default. The mapping is kept so the boot check and the forward name
 *    resolution below still know the legacy name; the legacy VALUE is never read.
 *
 * Both maps together are the single source of truth for the rename. Read sites,
 * tests, and the customer configuration verification all enumerate them, so a
 * variable is only renamed correctly once it appears in one of them with the
 * matching read path wired.
 */

/**
 * Active aliases: still dual-read (current preferred, legacy fallback). These
 * are set under their legacy names by operator-provisioned customer Fettler
 * deployments (the Warden model/self-serve secrets, plus the Transformer ->
 * Regauge customer backup paths below), configuration this repository cannot
 * change, so the legacy fallback must stay until each live secret is migrated.
 */
export const RENAMED_ENV = Object.freeze({
  // Warden -> Fettler. These are set per customer as operator-managed Fly
  // secrets and [env] on customer Fettler deployments, under the legacy names,
  // and that configuration cannot be changed from this repository, so the
  // legacy fallback must stay until each live secret is migrated.
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

  // Transformer -> Regauge customer backup paths. These are NOT part of the
  // Regauge production surface; they are operator-provisioned per-customer Fly
  // secrets on customer Fettler deployments (CUSTOMER_WARDEN_REQUIRED_SECRETS in
  // scripts/customer-warden-profile.ts), delivered under the legacy names, and
  // that configuration cannot be changed from this repository. Kept active
  // (dual-read) for the same reason as the Warden secrets above: retiring the
  // fallback would fail a live customer boot on a secret we cannot migrate.
  MENDPOINT_BACKUP_REGAUGE_CONTROL_PLANE_PATH:
    "MENDPOINT_BACKUP_TRANSFORMER_CONTROL_PLANE_PATH",
  MENDPOINT_BACKUP_REGAUGE_PILOT_PATH: "MENDPOINT_BACKUP_TRANSFORMER_PILOT_PATH",
} as const satisfies Readonly<Record<string, string>>);

/**
 * Retired Transformer -> Regauge aliases. The legacy value is no longer read;
 * the current name is authoritative. The Regauge production surface is
 * configured entirely from this repository and its CI workflow, which set the
 * current names (see .github/workflows/regauge-production.yml, fly.transformer.toml,
 * fly.customer-warden.toml), so no live deployment depends on the legacy name.
 */
export const RETIRED_ENV = Object.freeze({
  // Transformer -> Regauge
  MENDPOINT_REGAUGE_ENVIRONMENT: "MENDPOINT_TRANSFORMER_ENVIRONMENT",
  MENDPOINT_REGAUGE_GATE: "MENDPOINT_TRANSFORMER_GATE",
  MENDPOINT_REGAUGE_ENABLED: "MENDPOINT_TRANSFORMER_ENABLED",
  MENDPOINT_REGAUGE_LEARNING_ENABLED: "MENDPOINT_TRANSFORMER_LEARNING_ENABLED",
  MENDPOINT_REGAUGE_RECIPE_AUTHORING_ENABLED:
    "MENDPOINT_TRANSFORMER_RECIPE_AUTHORING_ENABLED",
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

  // Transformer live eval -> Regauge live eval
  MENDPOINT_EVAL_LIVE_REGAUGE: "MENDPOINT_EVAL_LIVE_TRANSFORMER",
  MENDPOINT_REGAUGE_LIVE_EVAL_MAX_USD: "MENDPOINT_TRANSFORMER_LIVE_EVAL_MAX_USD",
  MENDPOINT_REGAUGE_LIVE_EVAL_TENANT: "MENDPOINT_TRANSFORMER_LIVE_EVAL_TENANT",
  MENDPOINT_REGAUGE_LIVE_MIN_PASS_RATE: "MENDPOINT_TRANSFORMER_LIVE_MIN_PASS_RATE",
  MENDPOINT_REGAUGE_LIVE_MIN_CONSISTENCY:
    "MENDPOINT_TRANSFORMER_LIVE_MIN_CONSISTENCY",
} as const satisfies Readonly<Record<string, string>>);

export type ActiveRenamedEnvName = keyof typeof RENAMED_ENV;
export type RetiredRenamedEnvName = keyof typeof RETIRED_ENV;
export type RenamedEnvName = ActiveRenamedEnvName | RetiredRenamedEnvName;

/**
 * Retired (current, legacy) pairs, in declaration order. Consumed by the boot
 * validation so a deployment that sets only the retired legacy name fails loudly
 * naming the current variable.
 */
export const RETIRED_ENV_ALIASES: ReadonlyArray<
  readonly [RetiredRenamedEnvName, string]
> = Object.freeze(
  (Object.entries(RETIRED_ENV) as ReadonlyArray<[RetiredRenamedEnvName, string]>)
    .map(([current, legacy]) => [current, legacy] as const),
);

type EnvLike = Readonly<Record<string, string | undefined>>;

const ACTIVE_LEGACY = RENAMED_ENV as Readonly<Record<string, string>>;
const RETIRED_LEGACY = RETIRED_ENV as Readonly<Record<string, string>>;

/** Reverse maps: legacy name -> current name, kept separate by class. */
const ACTIVE_LEGACY_TO_CURRENT: Readonly<Record<string, ActiveRenamedEnvName>> =
  Object.freeze(
    Object.fromEntries(
      (Object.entries(RENAMED_ENV) as ReadonlyArray<[ActiveRenamedEnvName, string]>)
        .map(([current, legacy]) => [legacy, current] as const),
    ),
  );
const RETIRED_LEGACY_TO_CURRENT: Readonly<Record<string, RetiredRenamedEnvName>> =
  Object.freeze(
    Object.fromEntries(
      (Object.entries(RETIRED_ENV) as ReadonlyArray<[RetiredRenamedEnvName, string]>)
        .map(([current, legacy]) => [legacy, current] as const),
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
 * reading the legacy variable directly. This is the ACTIVE (still-dual-read)
 * path; retired aliases never reach it.
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
 * the source-of-truth maps. Prefer this at read sites where the current name is
 * known statically, so a typo is a compile error rather than a silent miss.
 *
 * Active aliases dual-read (current preferred, legacy fallback). Retired aliases
 * read the current name only: the legacy value is never honoured, so a
 * deployment that still sets it does not get a silent fallback.
 */
export function resolveRenamedEnv(
  env: EnvLike,
  current: RenamedEnvName,
): string | undefined {
  const legacy = ACTIVE_LEGACY[current];
  if (legacy !== undefined) return readRenamedEnv(env, current, legacy);
  // Retired: current name only.
  return env[current];
}

/**
 * Resolve a variable given either its current name, its legacy name, or an
 * unrelated name. Used where code iterates a list of variable names that predate
 * the rename (for example the customer configuration required-secrets list and
 * the production profile checks).
 *
 * Active names dual-read. Retired names — whether the current or the legacy name
 * is supplied — resolve forward to the current name and read that only, so the
 * legacy value is never honoured. Unrelated names read directly.
 */
export function resolveEitherRenamedEnv(
  env: EnvLike,
  name: string,
): string | undefined {
  const activeLegacy = ACTIVE_LEGACY[name];
  if (activeLegacy !== undefined) return readRenamedEnv(env, name, activeLegacy);
  if (RETIRED_LEGACY[name] !== undefined) return env[name];
  const activeCurrent = ACTIVE_LEGACY_TO_CURRENT[name];
  if (activeCurrent !== undefined) return readRenamedEnv(env, activeCurrent, name);
  const retiredCurrent = RETIRED_LEGACY_TO_CURRENT[name];
  if (retiredCurrent !== undefined) return env[retiredCurrent];
  return env[name];
}
