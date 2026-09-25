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
 *  - the production checkout path `<reposDir>/<tenantId>/<repoKey>` becomes the
 *    public `owner/repo`, matching #713's registry line (when owner/repo is known);
 *  - the tenant-private namespace `<tenantId>~<slug>` collapses to its public
 *    slug (`<slug>`), matching `publicProviderSlug`;
 *  - any remaining bare occurrence of the tenant id (a JSON `"tenantId"` binding,
 *    a residual path segment, free text) is removed.
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

export type PublicPrIdentityOptions = Readonly<{
  /** The configured repositories root, so `<reposDir>/<tenantId>/<repoKey>` can be found. */
  reposDir?: string | null;
  /** The customer's public `owner/repo`, used to replace the server checkout path. */
  ownerRepo?: string | null;
}>;

/** Re-project stored PR text to public identity by removing the internal tenant id. */
export function renderPublicPrIdentity(
  text: string,
  tenantId: string,
  options: PublicPrIdentityOptions = {},
): string {
  if (!tenantId || !text) return text;
  const id = escapeRegExp(tenantId);
  const flags = "gi";
  let out = text;
  // The server checkout path `<reposDir>/<tenantId>/<repoKey>` -> public `owner/repo`
  // (the same identity #713 renders in the registry), so neither the tenant id nor
  // the server filesystem layout survives.
  if (options.reposDir && options.ownerRepo) {
    const root = escapeRegExp(options.reposDir.replace(/[/\\]+$/, ""));
    out = out.replace(
      new RegExp(`${root}[/\\\\]${id}[/\\\\][^\\s"'\`)\\]]+`, flags),
      options.ownerRepo,
    );
  }
  return (
    out
      // `<tenantId>~acme` -> `acme` (the public slug; matches publicProviderSlug).
      .replace(new RegExp(`${id}~`, flags), "")
      // `/<tenantId>/` and `\<tenantId>\` inside any remaining path -> collapse the segment.
      .replace(new RegExp(`([\\\\/])${id}[\\\\/]`, flags), "$1")
      // Any residual bare occurrence (JSON binding, free text).
      .replace(new RegExp(id, flags), "")
  );
}
