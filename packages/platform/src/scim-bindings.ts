export type ScimBinding = Readonly<{ tenantId: string; principalId: string; issuer: string }>;

function text(value: unknown, code: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new Error(code);
  return value.trim();
}

function httpsIssuer(value: unknown): string {
  const issuer = text(value, "scim_issuer_invalid", 2_048);
  let url: URL;
  try { url = new URL(issuer); } catch { throw new Error("scim_issuer_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("scim_issuer_invalid");
  }
  return issuer;
}

function issuerWithoutTrailingSlash(issuer: string): string {
  return issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
}

export function scimBindingsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyMap<string, ScimBinding> {
  const raw = env.MENDPOINT_SCIM_BINDINGS_JSON?.trim();
  if (!raw) return new Map();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("scim_bindings_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("scim_bindings_invalid");
  const document = value as { schemaVersion?: unknown; bindings?: unknown };
  if (document.schemaVersion !== 1 || !Array.isArray(document.bindings)) throw new Error("scim_bindings_invalid");
  const oidcIssuerValue = env.OIDC_ISSUER?.trim();
  if (document.bindings.length > 0 && !oidcIssuerValue) throw new Error("scim_oidc_issuer_required");
  const oidcIssuer = oidcIssuerValue ? httpsIssuer(oidcIssuerValue) : null;
  const result = new Map<string, ScimBinding>();
  for (const item of document.bindings) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("scim_bindings_invalid");
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some((key) => !["tenantId", "principalId", "issuer"].includes(key))) {
      throw new Error("scim_bindings_invalid");
    }
    const tenantId = text(row.tenantId, "scim_bindings_invalid", 255);
    const principalId = text(row.principalId, "scim_bindings_invalid", 128);
    const configuredIssuer = httpsIssuer(row.issuer);
    if (!oidcIssuer) throw new Error("scim_oidc_issuer_required");
    if (issuerWithoutTrailingSlash(configuredIssuer) !== issuerWithoutTrailingSlash(oidcIssuer)) {
      throw new Error("scim_oidc_issuer_mismatch");
    }
    if (result.has(tenantId)) throw new Error("scim_bindings_invalid");
    result.set(tenantId, Object.freeze({ tenantId, principalId, issuer: oidcIssuer }));
  }
  return result;
}
