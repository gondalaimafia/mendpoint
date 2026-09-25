/**
 * Re-project a STORED PR title/body to public identity (#724).
 *
 * #713 renders every customer section from an allowlist of public fields at the
 * structured source, so NEW deliveries are already clean. But bodies delivered
 * (or stored as write-ahead artifacts) by main-era code carry the internal tenant
 * id in their graph sections and the server checkout path, and the structured
 * source is not available at a delivery-only retry or when refreshing an already
 * open draft — only the rendered text is. This projects that stored text back to
 * public identity by neutralising the known internal identifiers:
 *
 *  - the tenant-private namespace `<tenantId>~<slug>` collapses to its public
 *    slug (`<slug>`), matching `publicProviderSlug`;
 *  - the production checkout path segment `<reposDir>/<tenantId>/<repoKey>` loses
 *    its tenant component;
 *  - any remaining bare occurrence of the tenant id (a JSON `"tenantId"` binding,
 *    free text) is removed.
 *
 * The match is a case-insensitive substring, exactly as the fail-closed guard
 * matches, so a projection that passes here also passes the guard. This is NOT a
 * return to `stripTenantScopeForDisplay` on the live render path — it applies only
 * to legacy stored text at retry/refresh, and the fail-closed guard at the write
 * boundary is the backstop if a format is ever missed.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Re-project stored PR text to public identity by removing the internal tenant id. */
export function renderPublicPrIdentity(text: string, tenantId: string): string {
  if (!tenantId || !text) return text;
  const id = escapeRegExp(tenantId);
  const flags = "gi";
  return (
    text
      // `<tenantId>~acme` -> `acme` (the public slug; matches publicProviderSlug).
      .replace(new RegExp(`${id}~`, flags), "")
      // `/<tenantId>/` and `\<tenantId>\` inside a checkout path -> collapse the segment.
      .replace(new RegExp(`([\\\\/])${id}[\\\\/]`, flags), "$1")
      // Any residual bare occurrence (JSON binding, free text).
      .replace(new RegExp(id, flags), "")
  );
}
