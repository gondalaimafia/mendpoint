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
