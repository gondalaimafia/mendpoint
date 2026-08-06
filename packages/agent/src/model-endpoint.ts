export function resolveAgentModelEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = env.LLM_AGENT_URL?.trim() || env.OPENAI_BASE_URL?.trim();
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
  const basePath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = basePath.endsWith("/v1")
    ? `${basePath}/chat/completions`
    : `${basePath}/v1/chat/completions`;
  return parsed.toString();
}

/**
 * Resolve the exact model id used for a live provider call from configuration.
 * The live evidence lane (not this generic client) enforces the approved-model
 * allowlist, so a policy change is a config change, not a code change here.
 */
export function resolveAgentModelName(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.LLM_AGENT_MODEL?.trim() || "gpt-4o-mini";
}
