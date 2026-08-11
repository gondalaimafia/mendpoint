/**
 * Model egress boundary policy.
 *
 * Repository content is sent to a model provider as the chat-completions prompt.
 * The optional local_only mode enforces, at the application layer, that this
 * traffic can only reach a private, loopback, link-local, or operator
 * allowlisted host, so a customer can truthfully run within their own
 * infrastructure with control over where repository content goes.
 *
 * Default is external_allowed, which preserves the current behavior: any
 * reachable endpoint is permitted. This module is the single source of truth
 * for both resolve-time enforcement (agent) and boot validation (ops, warden
 * profile), so the two cannot drift.
 */

export type ModelEgressMode = "local_only" | "external_allowed";

export const MODEL_EGRESS_MODES: readonly ModelEgressMode[] = Object.freeze([
  "local_only",
  "external_allowed",
]);

export type ModelEgressViolation =
  | "model_egress_mode_invalid"
  | "model_egress_local_only_violation"
  | "warden_model_endpoint_invalid"
  | null;

export type ModelEgressAssessment = Readonly<{
  mode: ModelEgressMode;
  localOnly: boolean;
  endpointConfigured: boolean;
  endpointHost: string | null;
  localOnlySatisfied: boolean;
  violation: ModelEgressViolation;
}>;

type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the configured egress mode. Any value other than the exact string
 * local_only (including unset) resolves to external_allowed so the default
 * preserves current behavior. Use isValidModelEgressMode to fail fast on typos.
 */
export function modelEgressMode(env: EnvLike = process.env): ModelEgressMode {
  return env.MENDPOINT_MODEL_EGRESS?.trim() === "local_only"
    ? "local_only"
    : "external_allowed";
}

/** True when the flag is unset, empty, or one of the two exact valid values. */
export function isValidModelEgressMode(value: string | undefined): boolean {
  const v = value?.trim();
  return v === undefined || v === "" || v === "local_only" || v === "external_allowed";
}

/**
 * The raw model endpoint the agent would call, using the same precedence as
 * resolveAgentModelEndpoint so boot validation matches resolve-time behavior.
 */
export function configuredModelEndpointUrl(env: EnvLike = process.env): string | null {
  return env.LLM_AGENT_URL?.trim() || env.OPENAI_BASE_URL?.trim() || null;
}

/** Parse the operator allowlist of private hosts into a lowercased set. */
export function parseModelLocalHosts(value: string | undefined): Set<string> {
  const hosts = new Set<string>();
  if (!value) return hosts;
  for (const raw of value.split(/[,\s]+/)) {
    const host = raw.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  return hosts;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateIpv6(host: string): boolean {
  if (host === "::1") return true; // loopback
  const firstHextet = host.startsWith("::")
    ? 0
    : Number.parseInt(host.split(":")[0] ?? "", 16);
  if (!Number.isFinite(firstHextet)) return false;
  if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true; // fc00::/7 unique local
  if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true; // fe80::/10 link-local
  return false;
}

/**
 * Decide whether a URL host stays within the customer's environment.
 * Private means: loopback (127.0.0.0/8, ::1), private IPv4 (10/8, 172.16/12,
 * 192.168/16), link-local (169.254/16, fe80::/10), unique local IPv6
 * (fc00::/7), the localhost / .local / .localhost names, or a host on the
 * operator allowlist. A public hostname or address (for example api.meta.ai)
 * is not private.
 */
export function isPrivateModelHost(
  hostname: string,
  allowlist: ReadonlySet<string> = new Set(),
): boolean {
  let host = hostname.trim().toLowerCase();
  if (!host) return false;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zoneIndex = host.indexOf("%");
  if (zoneIndex >= 0) host = host.slice(0, zoneIndex);
  if (!host) return false;

  if (allowlist.has(host)) return true;
  if (host === "localhost") return true;
  if (host.endsWith(".localhost") || host.endsWith(".local")) return true;

  const v4 = IPV4.exec(host);
  if (v4) {
    const octets = v4.slice(1, 5).map((part) => Number.parseInt(part, 10));
    if (octets.some((octet) => octet > 255)) return false;
    const [a, b] = octets;
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 10) return true; // private 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
    return false;
  }
  if (host.includes(":")) return isPrivateIpv6(host);
  return false;
}

/**
 * Assess the current model egress posture for boot validation and readiness.
 * When local_only is active, a configured endpoint must resolve to a private
 * host; a missing endpoint is allowed (heuristic-only, no egress).
 */
export function assessModelEgress(env: EnvLike = process.env): ModelEgressAssessment {
  const modeValid = isValidModelEgressMode(env.MENDPOINT_MODEL_EGRESS);
  const mode = modelEgressMode(env);
  const configured = configuredModelEndpointUrl(env);
  const endpointConfigured = configured !== null;
  let endpointHost: string | null = null;
  let hostParseFailed = false;
  if (configured) {
    try {
      endpointHost = new URL(configured).hostname;
    } catch {
      hostParseFailed = true;
    }
  }

  let violation: ModelEgressViolation = null;
  let localOnlySatisfied = true;
  if (!modeValid) {
    violation = "model_egress_mode_invalid";
  } else if (mode === "local_only" && endpointConfigured) {
    if (hostParseFailed) {
      violation = "warden_model_endpoint_invalid";
      localOnlySatisfied = false;
    } else if (
      !isPrivateModelHost(
        endpointHost ?? "",
        parseModelLocalHosts(env.MENDPOINT_MODEL_LOCAL_HOSTS),
      )
    ) {
      violation = "model_egress_local_only_violation";
      localOnlySatisfied = false;
    }
  }

  return Object.freeze({
    mode,
    localOnly: mode === "local_only",
    endpointConfigured,
    endpointHost,
    localOnlySatisfied,
    violation,
  });
}
