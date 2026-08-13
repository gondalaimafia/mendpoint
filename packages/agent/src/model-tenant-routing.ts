/**
 * Per-tenant model-tier routing: the data-governance gate for self-serve.
 *
 * The default deployment tier is `muse-spark-1.2-contributor`, a training tier
 * where prompts and completions may be used for provider training (an explicit
 * founder opt-in). Customer tenants must NEVER touch a training tier. This
 * module resolves each tenant to a model tier and routes its model calls
 * accordingly, fail-closed:
 *
 * - `training_allowed` — only an explicitly allowlisted internal tenant
 *   (`MENDPOINT_TRAINING_TIER_TENANTS`). It MAY use the contributor training
 *   tier, exactly as today.
 * - `non_training` — EVERY other tenant, and any call with no verified tenant
 *   binding. Its calls select a config-supplied non-training provider, and a
 *   hard guard throws `model_training_tier_forbidden_for_tenant` if the resolved
 *   backend is a training tier. A customer can never be routed to a training
 *   tier.
 *
 * Default-safe: with customer routing unset (`MENDPOINT_CUSTOMER_MODEL_ROUTING`
 * off, the default) the deployment is in single-tenant / preview mode and this
 * layer is a byte-for-byte pass-through to `resolveModelBackend`, so the
 * existing founder/preview runs are unchanged. Customers — and therefore the
 * fail-closed rule — exist only once customer routing is turned on.
 *
 * The Muse tiers share ONE API, base URL, and key; only the model id differs
 * (`muse-spark-1.2-contributor` trains on submitted prompts/completions,
 * `muse-spark-1.2` does not). So a customer tenant is served by substituting the
 * non-training MODEL ID on the resolved backend -- no second provider, no extra
 * credential. `MENDPOINT_NON_TRAINING_MODEL_PROVIDER` remains an optional
 * override for deployments where the tiers really are different providers.
 *
 * Fail-closed either way: a training model with no known non-training
 * counterpart throws rather than being served, and the caller's guard is the
 * backstop, so a customer can never reach a training tier.
 */
import {
  MODEL_PROVIDER_ENV_VAR,
  resolveModelBackend,
  type ResolvedModelBackend,
} from "./model-providers.js";

/** The model tier a tenant is permitted to reach. */
export type TenantModelTier = "non_training" | "training_allowed";

/** Master switch that turns on multi-tenant customer routing + enforcement. */
export const CUSTOMER_MODEL_ROUTING_ENV_VAR = "MENDPOINT_CUSTOMER_MODEL_ROUTING";
/** Allowlist of internal tenant ids permitted to use a training tier. */
export const TRAINING_TIER_TENANTS_ENV_VAR = "MENDPOINT_TRAINING_TIER_TENANTS";
/** Extra model ids to treat as training tier, unioned with the built-in set. */
export const TRAINING_TIER_MODELS_ENV_VAR = "MENDPOINT_TRAINING_TIER_MODELS";
/** Registered provider id serving the config-supplied non-training endpoint. */
export const NON_TRAINING_MODEL_PROVIDER_ENV_VAR = "MENDPOINT_NON_TRAINING_MODEL_PROVIDER";

/** Thrown when a non-training tenant would reach a training-tier backend. */
export const TRAINING_TIER_FORBIDDEN_ERROR = "model_training_tier_forbidden_for_tenant";

/**
 * Built-in training-tier model ids. The contributor tier trains on submitted
 * prompts/completions. This set is always enforced and can only be EXTENDED via
 * config, never narrowed, so an operator can never declassify a known training
 * tier and open a fail-open hole.
 */
export const DEFAULT_TRAINING_TIER_MODELS: readonly string[] = Object.freeze([
  "muse-spark-1.2-contributor",
]);

const ROUTING_ENABLED_VALUES: ReadonlySet<string> = new Set([
  "on",
  "1",
  "true",
  "enabled",
  "yes",
]);

/**
 * Whether multi-tenant customer routing (and its fail-closed enforcement) is
 * active. Default (unset/empty/any other value) is OFF — single-tenant/preview
 * mode, so existing runs are preserved.
 */
export function customerModelRoutingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ROUTING_ENABLED_VALUES.has(
    (env[CUSTOMER_MODEL_ROUTING_ENV_VAR] ?? "").trim().toLowerCase(),
  );
}

/** Parse a case-sensitive tenant-id allowlist into a set. */
export function parseTenantAllowlist(value: string | undefined): Set<string> {
  const tenants = new Set<string>();
  if (!value) return tenants;
  for (const raw of value.split(/[,\s]+/)) {
    const tenant = raw.trim();
    if (tenant) tenants.add(tenant);
  }
  return tenants;
}

/** The enforced set of training-tier model ids: built-in ∪ configured extras. */
export function trainingTierModelSet(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  const models = new Set<string>(DEFAULT_TRAINING_TIER_MODELS);
  const raw = env[TRAINING_TIER_MODELS_ENV_VAR];
  if (raw) {
    for (const candidate of raw.split(/[,\s]+/)) {
      const model = candidate.trim();
      if (model) models.add(model);
    }
  }
  return models;
}

/** True when the exact model id is a training tier. */
export function isTrainingTierModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return trainingTierModelSet(env).has(model.trim());
}

/** True when a resolved backend would serve a training-tier model. */
export function isTrainingTierBackend(
  backend: ResolvedModelBackend,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTrainingTierModel(backend.model, env);
}

/**
 * Resolve a tenant's model tier. An allowlisted internal tenant is
 * `training_allowed`; every other tenant — and any call with no verified tenant
 * binding — fails safe to `non_training`.
 */
export function resolveTenantModelTier(
  tenantId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): TenantModelTier {
  const tenant = tenantId?.trim();
  if (!tenant) return "non_training";
  return parseTenantAllowlist(env[TRAINING_TIER_TENANTS_ENV_VAR]).has(tenant)
    ? "training_allowed"
    : "non_training";
}

/**
 * The core fail-closed guard. Throws `model_training_tier_forbidden_for_tenant`
 * if a non-training tenant would be served by a training-tier backend. A null
 * backend (endpoint/keys not configured) is unavailable, not a violation.
 */
export function assertBackendAllowedForTenant(
  tenantId: string | undefined,
  backend: ResolvedModelBackend | null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (resolveTenantModelTier(tenantId, env) === "training_allowed") return;
  if (backend && isTrainingTierBackend(backend, env)) {
    throw new Error(TRAINING_TIER_FORBIDDEN_ERROR);
  }
}

/**
 * Built-in training -> non-training model substitutions.
 *
 * The Muse tiers are the SAME API, base URL, and key; only the model id differs
 * (`muse-spark-1.2-contributor` trains on submitted prompts/completions,
 * `muse-spark-1.2` does not). So a customer tenant is served by swapping the
 * model id on the resolved backend -- not by pointing at a second provider.
 */
export const DEFAULT_NON_TRAINING_MODEL_SUBSTITUTIONS: Readonly<Record<string, string>> =
  Object.freeze({
    "muse-spark-1.2-contributor": "muse-spark-1.2",
  });

/** Overrides the non-training model id for every training model. */
export const NON_TRAINING_MODEL_ENV_VAR = "MENDPOINT_NON_TRAINING_MODEL";
/** Extra `training=non_training` substitutions, comma separated. */
export const NON_TRAINING_MODEL_MAP_ENV_VAR = "MENDPOINT_NON_TRAINING_MODEL_MAP";

/** Thrown when a training model has no known non-training counterpart. */
export const NON_TRAINING_MODEL_UNMAPPED_ERROR = "model_non_training_substitute_unknown";

/**
 * The non-training model id for a training model: an explicit override wins,
 * then configured substitutions, then the built-ins. Returns undefined when no
 * counterpart is known so the caller can fail closed instead of serving the
 * training tier.
 */
export function nonTrainingModelFor(
  trainingModel: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const override = env[NON_TRAINING_MODEL_ENV_VAR]?.trim();
  if (override) return override;
  const configured: Record<string, string> = {};
  for (const entry of (env[NON_TRAINING_MODEL_MAP_ENV_VAR] ?? "").split(",")) {
    const [from, to] = entry.split("=");
    const key = from?.trim();
    const value = to?.trim();
    if (key && value) configured[key] = value;
  }
  const substitute =
    configured[trainingModel.trim()] ??
    DEFAULT_NON_TRAINING_MODEL_SUBSTITUTIONS[trainingModel.trim()];
  return substitute?.trim() || undefined;
}

/**
 * Resolve the non-training backend a customer tenant should use.
 *
 * Default (and the Muse case): resolve the normal backend and substitute the
 * non-training MODEL ID, keeping the same provider, endpoint, and API key.
 * A separate non-training provider remains an optional override for
 * deployments where the tiers really are different providers.
 *
 * Fails closed: if the resolved model is a training tier with no known
 * non-training counterpart, this throws rather than serving the training tier.
 * The caller also runs the guard, so a misconfigured substitution is caught.
 */
export function resolveNonTrainingModelBackend(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedModelBackend | null {
  const provider = env[NON_TRAINING_MODEL_PROVIDER_ENV_VAR]?.trim();
  const backend = provider
    ? resolveModelBackend({ ...env, [MODEL_PROVIDER_ENV_VAR]: provider })
    : resolveModelBackend(env);
  if (!backend) return null;
  if (!isTrainingTierModel(backend.model, env)) return backend;

  const substitute = nonTrainingModelFor(backend.model, env);
  if (!substitute) {
    throw new Error(
      `${NON_TRAINING_MODEL_UNMAPPED_ERROR}: no non-training model is configured for ` +
        `"${backend.model}". Set ${NON_TRAINING_MODEL_ENV_VAR} or add an entry to ` +
        `${NON_TRAINING_MODEL_MAP_ENV_VAR} (for example ` +
        `"${backend.model}=<non-training-model-id>").`,
    );
  }
  // Same provider, endpoint, and key -- only the model id changes.
  return Object.freeze({ ...backend, model: substitute });
}

/**
 * Resolve the active model backend for a tenant, enforcing the per-tenant tier.
 *
 * - Customer routing OFF (default) => single-tenant/preview pass-through:
 *   byte-for-byte `resolveModelBackend(env)` for every tenant.
 * - Customer routing ON, allowlisted internal tenant => may use its current
 *   (possibly training) tier unchanged.
 * - Customer routing ON, any other tenant (or an unbound call) => the
 *   config-supplied non-training backend, guarded so a training tier throws.
 *
 * Inherits the gateway's own fail-closed throws (unknown provider id, invalid
 * endpoint, HTTPS-in-production) unchanged.
 */
export function resolveTenantModelBackend(
  tenantId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedModelBackend | null {
  if (!customerModelRoutingEnabled(env)) {
    return resolveModelBackend(env);
  }
  if (resolveTenantModelTier(tenantId, env) === "training_allowed") {
    return resolveModelBackend(env);
  }
  const backend = resolveNonTrainingModelBackend(env);
  assertBackendAllowedForTenant(tenantId, backend, env);
  return backend;
}
