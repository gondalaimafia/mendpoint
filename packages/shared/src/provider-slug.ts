/**
 * Provider slug rules shared between the API catalog surface and the branch/PR builders.
 *
 * A tenant-private provider's slug is namespaced as `<tenantId>~<requested>` so it can never
 * collide with a shared vendor slug (which is `[a-z0-9-]+` and can never contain `~`). The
 * separator lives here, not in the API package, because the generation package must also strip
 * the tenant namespace out of git branch names (a tenant id must never land in a customer
 * repo's branch), and both packages depend on `@mendpoint/shared` — this keeps one source of
 * truth for the separator.
 */

/** Separator between a tenant namespace and the requested slug of a tenant-private provider. */
export const TENANT_PRIVATE_SLUG_SEPARATOR = "~" as const;

/**
 * The single public-identity projection: map a STORED provider slug to its customer-facing form.
 *
 * A tenant-private provider is stored namespaced as `<tenantId>~<requested>`. The tenant id is an
 * internal identifier (an unsalted hash of issuer+email) that must NEVER reach a customer repo,
 * so the public identity is the requested (unnamespaced) part. A shared / legacy-bare slug has no
 * separator and is returned unchanged, so shared-provider rendered output stays byte-identical.
 *
 * This is deliberately safe on a compound id that BEGINS with the stored slug — a surface
 * canonical id `<slug>.<path>.<op>` — because neither the tenant id (`[0-9a-f]{64}`) nor a
 * requested slug (`[a-z0-9-]`) can contain `~`, so the only `~` in such an id is the namespace
 * boundary and slicing after it yields `<requested><rest>`. Every string that a renderer sends to
 * a customer repo (PR title, body, commit message, branch, file content, check/comment text) must
 * derive from this projection, never from the raw stored slug.
 */
export function publicProviderSlug(storedSlug: string): string {
  const sepIndex = storedSlug.lastIndexOf(TENANT_PRIVATE_SLUG_SEPARATOR);
  return sepIndex === -1 ? storedSlug : storedSlug.slice(sepIndex + 1);
}

/**
 * Remove tenant scoping from a graph-rendered string so it is safe to show a customer.
 *
 * The Change Graph keys its nodes by tenant-scoped ids (`provider:<tenantId>:<slug>`,
 * `consumer:<tenantId>:<consumerId>`, ...) and a private provider's slug carries the
 * `<tenantId>~` namespace. Those keyed ids stay as-is in the graph store, ledgers and audits;
 * this projection is applied ONLY to the rendered graph section of a customer PR body, stripping
 * both the `<tenantId>:` scope prefix and the `<tenantId>~` private-slug namespace. For a shared
 * provider the result is byte-identical to today except that the tenant id is gone (#716); for a
 * private provider the namespaced slug additionally collapses to its public form (#704/#713).
 */
export function stripTenantScopeForDisplay(text: string, tenantId: string): string {
  if (!tenantId) return text;
  return text
    .split(`${tenantId}${TENANT_PRIVATE_SLUG_SEPARATOR}`).join("")
    .split(`${tenantId}:`).join("");
}

/**
 * Requested provider slug format: lowercase, starts alphanumeric, then `[a-z0-9-]`, max 63
 * chars. Rejects empty, uppercase, path separators (`a/b`), the namespace separator (`~`) and
 * anything that is not ref-safe, so the stored slug (and the branch segment derived from it)
 * are always safe.
 */
export const PROVIDER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Is `slug` a well-formed requested provider slug? Narrow, so an undefined body never throws. */
export function isValidProviderSlug(slug: unknown): slug is string {
  return typeof slug === "string" && PROVIDER_SLUG_PATTERN.test(slug);
}
