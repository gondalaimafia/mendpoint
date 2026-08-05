const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function parseGitHubOwnerTenantBindings(
  value: string | undefined,
): ReadonlyMap<string, string> {
  if (!value?.trim()) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("github_app_owner_bindings_invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("github_app_owner_bindings_invalid_shape");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 200) throw new Error("github_app_owner_bindings_too_large");
  const bindings = new Map<string, string>();
  for (const [owner, tenantId] of entries) {
    if (!GITHUB_LOGIN.test(owner) || typeof tenantId !== "string" || !TENANT_ID.test(tenantId)) {
      throw new Error("github_app_owner_binding_invalid");
    }
    bindings.set(owner.toLowerCase(), tenantId);
  }
  return bindings;
}

export function resolveGitHubOwnerTenantBinding(
  owner: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return parseGitHubOwnerTenantBindings(
    env.GITHUB_APP_OWNER_TENANT_BINDINGS,
  ).get(owner.toLowerCase());
}
