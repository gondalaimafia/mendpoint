const GITHUB_ACCOUNT_ID = /^[1-9][0-9]{0,19}$/;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function parseGitHubAccountTenantBindings(
  value: string | undefined,
): ReadonlyMap<string, string> {
  if (!value?.trim()) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("github_app_account_bindings_invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("github_app_account_bindings_invalid_shape");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 200) throw new Error("github_app_account_bindings_too_large");
  const bindings = new Map<string, string>();
  for (const [accountId, tenantId] of entries) {
    if (
      !GITHUB_ACCOUNT_ID.test(accountId) ||
      typeof tenantId !== "string" ||
      !TENANT_ID.test(tenantId)
    ) {
      throw new Error("github_app_account_binding_invalid");
    }
    bindings.set(accountId, tenantId);
  }
  return bindings;
}

function configuredBindings(env: NodeJS.ProcessEnv): ReadonlyMap<string, string> {
  if (env.GITHUB_APP_OWNER_TENANT_BINDINGS?.trim()) {
    throw new Error("github_app_legacy_owner_bindings_forbidden");
  }
  return parseGitHubAccountTenantBindings(env.GITHUB_APP_ACCOUNT_TENANT_BINDINGS);
}

export function resolveGitHubAccountTenantBinding(
  accountId: number | string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const normalized = String(accountId);
  if (!GITHUB_ACCOUNT_ID.test(normalized)) {
    throw new Error("github_app_account_id_invalid");
  }
  return configuredBindings(env).get(normalized);
}

export function resolveGitHubTenantAccountBinding(
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!TENANT_ID.test(tenantId)) throw new Error("github_app_tenant_id_invalid");
  const matches = [...configuredBindings(env)]
    .filter(([, configuredTenantId]) => configuredTenantId === tenantId)
    .map(([accountId]) => accountId);
  if (matches.length > 1) {
    throw new Error("github_app_tenant_account_binding_ambiguous");
  }
  return matches[0];
}

export function resolveGitHubInstallationTenant(input: Readonly<{
  accountId: string;
  configuredTenantId?: string;
  existing?: Readonly<{ accountId: string | null; tenantId: string | null }>;
}>): string | undefined {
  if (!GITHUB_ACCOUNT_ID.test(input.accountId)) {
    throw new Error("github_app_account_id_invalid");
  }
  const existing = input.existing;
  if (existing?.accountId && existing.accountId !== input.accountId) {
    throw new Error("github_installation_account_identity_mismatch");
  }
  if (
    existing?.tenantId &&
    (!existing.accountId || input.configuredTenantId) &&
    input.configuredTenantId !== existing.tenantId
  ) {
    throw new Error("github_installation_tenant_identity_mismatch");
  }
  return existing?.tenantId ?? input.configuredTenantId;
}
