/**
 * Multi-provider model gateway registry.
 *
 * The Warden agent can drive its model calls through one of several named
 * backend providers, selected by the `MENDPOINT_MODEL_PROVIDER` environment
 * variable. Each provider declares its endpoint source, auth source, native
 * wire format, transport class, and a per-provider price table. Resolution is
 * ADDITIVE and DEFAULT-PRESERVING: when `MENDPOINT_MODEL_PROVIDER` is unset the
 * gateway returns exactly today's single OpenAI-compatible backend
 * (`resolveAgentModelEndpoint` + `OPENAI_API_KEY ?? XAI_API_KEY` +
 * `DEFAULT_MODEL_PRICE_TABLE`), so existing behavior and tests are unchanged.
 *
 * Native vs gateway-fronted (see docs/MODEL_PROVIDERS.md):
 * - OpenAI-compatible family (`openai`, `xai`, `muse-spark`, `openai-gateway`)
 *   speaks OpenAI /chat/completions directly — natively.
 * - `anthropic` and `gemini` are ALSO native: they speak their own wire format
 *   (Anthropic Messages API / Gemini generateContent) through the request and
 *   response adapters in model-adapters.ts.
 * - `openai-gateway` is explicitly a gateway-fronted provider: an
 *   OpenAI-compatible proxy or self-hosted endpoint that can front an arbitrary
 *   upstream model behind the OpenAI wire format.
 *
 * Pricing is honest: a provider's price table is keyed by exact model id, and an
 * unpriced model resolves to a null cost rather than a fabricated one. Built-in
 * vendor providers ship with empty price tables (operator-configured) except
 * `muse-spark`, which carries this deployment's known contributor-tier rates.
 */
import { enforceModelEndpointEgress } from "@mendpoint/shared";
import {
  resolveAgentModelEndpoint,
  resolveAgentModelName,
} from "./model-endpoint.js";
import {
  DEFAULT_MODEL_PRICE_TABLE,
  type LiveModelPrice,
} from "./model-provenance.js";

/** Wire formats the gateway can speak. */
export type ModelWireFormat = "openai" | "anthropic" | "gemini";

/**
 * Transport class. `native` means the provider's own wire format is spoken
 * directly; `gateway` means requests are fronted by an OpenAI-compatible proxy
 * that may relay to an arbitrary upstream model.
 */
export type ModelTransport = "native" | "gateway";

export type ModelProviderDescriptor = Readonly<{
  id: string;
  label: string;
  wireFormat: ModelWireFormat;
  transport: ModelTransport;
  /** Base-URL env vars, checked in order; first non-empty wins. */
  baseUrlEnvVars: readonly string[];
  /** Fallback base URL when no base-URL env var is set. */
  defaultBaseUrl: string | null;
  /** API-key env vars, checked in order; first non-empty wins. */
  authEnvVars: readonly string[];
  /** Model id used when `LLM_AGENT_MODEL` is unset. */
  defaultModel: string;
  /** Price table keyed by exact model id (empty => unpriced => null cost). */
  pricePerMillion: Readonly<Record<string, LiveModelPrice>>;
}>;

/** The fully resolved backend a single model call will use. */
export type ResolvedModelBackend = Readonly<{
  providerId: string;
  wireFormat: ModelWireFormat;
  transport: ModelTransport;
  endpoint: string;
  apiKey: string;
  model: string;
  priceTable: Readonly<Record<string, LiveModelPrice>>;
}>;

/** Environment variable that selects the active provider. */
export const MODEL_PROVIDER_ENV_VAR = "MENDPOINT_MODEL_PROVIDER";

/** Provider id used for the default, env-unset OpenAI-compatible backend. */
export const DEFAULT_PROVIDER_ID = "default";

const EMPTY_PRICE_TABLE: Readonly<Record<string, LiveModelPrice>> = Object.freeze({});

// Published vendor list prices (USD per million tokens) known at authoring time.
// These are REFERENCE rates: operators should verify them and override per model
// as vendor pricing changes. Any model absent from a table resolves to a null
// cost (never a guessed one). Live runs fail closed on the cost-measurement gate
// for an unpriced model, so an operator fronting a new model must price it here
// (or via the gateway provider) before that model can complete a live call.
const OPENAI_PRICE_TABLE: Readonly<Record<string, LiveModelPrice>> = Object.freeze({
  "gpt-4o-mini": Object.freeze({ promptUsdPerMillion: 0.15, completionUsdPerMillion: 0.6 }),
  "gpt-4o": Object.freeze({ promptUsdPerMillion: 2.5, completionUsdPerMillion: 10 }),
});
const XAI_PRICE_TABLE: Readonly<Record<string, LiveModelPrice>> = Object.freeze({
  "grok-2-latest": Object.freeze({ promptUsdPerMillion: 2, completionUsdPerMillion: 10 }),
  "grok-2": Object.freeze({ promptUsdPerMillion: 2, completionUsdPerMillion: 10 }),
});
const ANTHROPIC_PRICE_TABLE: Readonly<Record<string, LiveModelPrice>> = Object.freeze({
  "claude-3-5-sonnet-latest": Object.freeze({ promptUsdPerMillion: 3, completionUsdPerMillion: 15 }),
  "claude-3-5-haiku-latest": Object.freeze({ promptUsdPerMillion: 0.8, completionUsdPerMillion: 4 }),
});
const GEMINI_PRICE_TABLE: Readonly<Record<string, LiveModelPrice>> = Object.freeze({
  "gemini-1.5-flash": Object.freeze({ promptUsdPerMillion: 0.075, completionUsdPerMillion: 0.3 }),
  "gemini-1.5-pro": Object.freeze({ promptUsdPerMillion: 1.25, completionUsdPerMillion: 5 }),
});

/**
 * The named provider registry. Every entry is additive: none changes the
 * default (env-unset) path, which is resolved separately below.
 */
const PROVIDER_LIST: readonly ModelProviderDescriptor[] = Object.freeze([
  // This deployment's real backend, exposed as a selectable named provider:
  // an OpenAI-compatible endpoint serving the approved muse-spark tiers.
  Object.freeze({
    id: "muse-spark",
    label: "Muse Spark (OpenAI-compatible)",
    wireFormat: "openai",
    transport: "native",
    baseUrlEnvVars: Object.freeze(["LLM_AGENT_URL", "OPENAI_BASE_URL"]),
    defaultBaseUrl: null,
    authEnvVars: Object.freeze(["OPENAI_API_KEY", "XAI_API_KEY"]),
    defaultModel: "muse-spark-1.2-contributor",
    pricePerMillion: DEFAULT_MODEL_PRICE_TABLE,
  }),
  Object.freeze({
    id: "openai",
    label: "OpenAI",
    wireFormat: "openai",
    transport: "native",
    baseUrlEnvVars: Object.freeze(["OPENAI_BASE_URL"]),
    defaultBaseUrl: "https://api.openai.com",
    authEnvVars: Object.freeze(["OPENAI_API_KEY"]),
    defaultModel: "gpt-4o-mini",
    pricePerMillion: OPENAI_PRICE_TABLE,
  }),
  Object.freeze({
    id: "xai",
    label: "xAI Grok",
    wireFormat: "openai",
    transport: "native",
    baseUrlEnvVars: Object.freeze(["XAI_BASE_URL"]),
    defaultBaseUrl: "https://api.x.ai",
    authEnvVars: Object.freeze(["XAI_API_KEY"]),
    defaultModel: "grok-2-latest",
    pricePerMillion: XAI_PRICE_TABLE,
  }),
  // Generic OpenAI-compatible gateway / self-hosted endpoint. Explicitly
  // gateway-fronted: the base URL must be supplied and may relay any upstream.
  Object.freeze({
    id: "openai-gateway",
    label: "OpenAI-compatible gateway",
    wireFormat: "openai",
    transport: "gateway",
    baseUrlEnvVars: Object.freeze(["LLM_AGENT_URL", "OPENAI_BASE_URL"]),
    defaultBaseUrl: null,
    authEnvVars: Object.freeze(["OPENAI_API_KEY", "XAI_API_KEY"]),
    defaultModel: "gpt-4o-mini",
    pricePerMillion: EMPTY_PRICE_TABLE,
  }),
  // Native Anthropic Messages API, via the request/response adapter.
  Object.freeze({
    id: "anthropic",
    label: "Anthropic (Messages API)",
    wireFormat: "anthropic",
    transport: "native",
    baseUrlEnvVars: Object.freeze(["ANTHROPIC_BASE_URL"]),
    defaultBaseUrl: "https://api.anthropic.com",
    authEnvVars: Object.freeze(["ANTHROPIC_API_KEY"]),
    defaultModel: "claude-3-5-sonnet-latest",
    pricePerMillion: ANTHROPIC_PRICE_TABLE,
  }),
  // Native Google Gemini generateContent, via the request/response adapter.
  Object.freeze({
    id: "gemini",
    label: "Google Gemini (generateContent)",
    wireFormat: "gemini",
    transport: "native",
    baseUrlEnvVars: Object.freeze(["GEMINI_BASE_URL"]),
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    authEnvVars: Object.freeze(["GOOGLE_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]),
    defaultModel: "gemini-1.5-flash",
    pricePerMillion: GEMINI_PRICE_TABLE,
  }),
]);

const PROVIDERS: ReadonlyMap<string, ModelProviderDescriptor> = new Map(
  PROVIDER_LIST.map((provider) => [provider.id, provider]),
);

/** All registered named provider ids, in registry order. */
export function registeredModelProviderIds(): readonly string[] {
  return PROVIDER_LIST.map((provider) => provider.id);
}

/** Look up a named provider descriptor, or null when it is not registered. */
export function modelProvider(id: string): ModelProviderDescriptor | null {
  return PROVIDERS.get(id) ?? null;
}

function firstEnvValue(
  keys: readonly string[],
  env: NodeJS.ProcessEnv,
): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Validate a provider base URL with the same rules the legacy resolver applies:
 * http/https only, no embedded credentials, no query or fragment, and HTTPS
 * required in production.
 */
function validatedBaseUrl(rawBaseUrl: string, env: NodeJS.ProcessEnv): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new Error("warden_model_endpoint_invalid");
  }
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("warden_model_endpoint_invalid");
  }
  if (env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error("warden_model_endpoint_https_required");
  }
  return parsed;
}

/**
 * Compute the exact request URL for a named provider from its base URL, wire
 * format, and (for Gemini) model. Mirrors the legacy normalization for the
 * OpenAI wire format so OpenAI-compatible providers resolve identically.
 */
export function resolveProviderEndpoint(
  provider: ModelProviderDescriptor,
  rawBaseUrl: string,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const parsed = validatedBaseUrl(rawBaseUrl, env);
  const basePath = parsed.pathname.replace(/\/+$/, "");
  if (provider.wireFormat === "openai") {
    parsed.pathname = basePath.endsWith("/v1")
      ? `${basePath}/chat/completions`
      : `${basePath}/v1/chat/completions`;
  } else if (provider.wireFormat === "anthropic") {
    parsed.pathname = basePath.endsWith("/v1")
      ? `${basePath}/messages`
      : `${basePath}/v1/messages`;
  } else {
    const encodedModel = encodeURIComponent(model);
    parsed.pathname = basePath.endsWith("/v1beta")
      ? `${basePath}/models/${encodedModel}:generateContent`
      : `${basePath}/v1beta/models/${encodedModel}:generateContent`;
  }
  const endpoint = parsed.toString();
  // Apply the same local_only egress control the default path enforces, so a
  // named provider cannot ship repository content to a public host that the
  // agent-path check would have refused. External_allowed leaves this a no-op.
  enforceModelEndpointEgress(endpoint, env);
  return endpoint;
}

/**
 * Resolve the active model backend from configuration.
 *
 * - `MENDPOINT_MODEL_PROVIDER` unset => the default OpenAI-compatible backend,
 *   byte-for-byte today's resolution. Returns null (=> caller reports the model
 *   as unavailable) when no endpoint or key is configured.
 * - Set to a registered provider id => that provider's endpoint/auth/wire/price.
 *   Returns null when the selected provider is configured but missing its base
 *   URL or API key.
 * - Set to an UNKNOWN provider id => throws `warden_model_provider_unknown`
 *   (fails closed; never silently falls back to the default).
 */
export function resolveModelBackend(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedModelBackend | null {
  const selected = env[MODEL_PROVIDER_ENV_VAR]?.trim();
  if (!selected) {
    const endpoint = resolveAgentModelEndpoint(env);
    const apiKey = env.OPENAI_API_KEY ?? env.XAI_API_KEY;
    if (!endpoint || !apiKey) return null;
    return Object.freeze({
      providerId: DEFAULT_PROVIDER_ID,
      wireFormat: "openai",
      transport: "native",
      endpoint,
      apiKey,
      model: resolveAgentModelName(env),
      priceTable: DEFAULT_MODEL_PRICE_TABLE,
    });
  }
  const provider = PROVIDERS.get(selected);
  if (!provider) {
    throw new Error("warden_model_provider_unknown");
  }
  const baseUrl = firstEnvValue(provider.baseUrlEnvVars, env) ?? provider.defaultBaseUrl;
  const apiKey = firstEnvValue(provider.authEnvVars, env);
  if (!baseUrl || !apiKey) return null;
  const model = env.LLM_AGENT_MODEL?.trim() || provider.defaultModel;
  const endpoint = resolveProviderEndpoint(provider, baseUrl, model, env);
  return Object.freeze({
    providerId: provider.id,
    wireFormat: provider.wireFormat,
    transport: provider.transport,
    endpoint,
    apiKey,
    model,
    priceTable: provider.pricePerMillion,
  });
}
