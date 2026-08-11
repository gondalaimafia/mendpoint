import {
  configuredModelEndpointUrl,
  isPrivateModelHost,
  modelEgressMode,
  parseModelLocalHosts,
} from "@mendpoint/shared";

export function resolveAgentModelEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = configuredModelEndpointUrl(env);
  if (!configured) return null;
  let parsed: URL;
  try {
    parsed = new URL(configured);
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
  // Enforced no-egress mode: repository content may only reach a private,
  // loopback, link-local, or operator allowlisted model host.
  if (
    modelEgressMode(env) === "local_only" &&
    !isPrivateModelHost(
      parsed.hostname,
      parseModelLocalHosts(env.MENDPOINT_MODEL_LOCAL_HOSTS),
    )
  ) {
    throw new Error("model_egress_local_only_violation");
  }
  const basePath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = basePath.endsWith("/v1")
    ? `${basePath}/chat/completions`
    : `${basePath}/v1/chat/completions`;
  return parsed.toString();
}

/**
 * Resolve the exact model id used for a live provider call from configuration,
 * so a policy change is a config change, not a code change here. The live
 * evidence lane owns the approved-model allowlist; when a run carries a tenant
 * source policy the caller additionally binds this resolved model, and the
 * provider echo, to the policy model and fails closed on any mismatch.
 */
export function resolveAgentModelName(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.LLM_AGENT_MODEL?.trim() || "gpt-4o-mini";
}
