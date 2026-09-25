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
 * The tenant id never contains `~` (it is a 64-hex sha256 or an `[A-Za-z0-9._-]` id — see
 * `safeTenantId`), and the requested slug never contains `~` (see {@link PROVIDER_SLUG_PATTERN}),
 * so the FIRST `~` in a stored slug is always the namespace boundary. Splitting on the first
 * separator (not the last) is what keeps a requested slug safe even though `~` is legal elsewhere.
 *
 * This function must ONLY be applied to a STORED SLUG. It must never be handed a compound id such
 * as a surface canonical id (`<slug>.<path>.<op>`), because a `~` in an OpenAPI path would then be
 * mistaken for the namespace boundary. Project a compound id with {@link publicSurfaceId} (which
 * removes the known stored-slug prefix) or {@link publicGraphToken} instead.
 */
export function publicProviderSlug(storedSlug: string): string {
  const sepIndex = storedSlug.indexOf(TENANT_PRIVATE_SLUG_SEPARATOR);
  return sepIndex === -1 ? storedSlug : storedSlug.slice(sepIndex + 1);
}

/**
 * Project a surface canonical id (`<storedSlug>.<METHOD>.<path>.<op>...`) to its customer-facing
 * form by KNOWN-PREFIX removal: the display id is `publicProviderSlug(storedSlug)` followed by the
 * exact remainder of the canonical id after the stored-slug prefix. This never searches the id for
 * a separator, so a `~` inside an OpenAPI path (`/v1/users/~me`) is preserved verbatim. A shared
 * provider's canonical id is returned byte-identical because its public slug equals its stored one.
 */
export function publicSurfaceId(canonicalId: string, storedSlug: string): string {
  if (canonicalId === storedSlug) return publicProviderSlug(storedSlug);
  if (canonicalId.startsWith(`${storedSlug}.`)) {
    return `${publicProviderSlug(storedSlug)}${canonicalId.slice(storedSlug.length)}`;
  }
  return canonicalId;
}

/**
 * Project a Change-Graph node id or label to its customer-facing form. The graph keys its nodes by
 * tenant-scoped ids (`provider:<tenantId>:<storedSlug>`, `endpoint:<tenantId>:<storedSlug>:<method>:<path>`,
 * `surface:<storedSlug>.<path>.<op>`, `consumer:<tenantId>:<consumerId>`, ...) and a private
 * provider's slug carries the `<tenantId>~` namespace. Removal is anchored to the KNOWN identifiers,
 * never a free-text substring strip:
 *  - a whole `:`-delimited segment equal to the tenant id is dropped (the tenant scope), and
 *  - a segment equal to the stored slug, or that begins with `<storedSlug>.`, has that stored-slug
 *    prefix replaced by the public slug (so a `~` inside an API path segment is preserved).
 * Every other segment is left byte-identical, so a shared provider's output only loses its tenant
 * scope (#716) and a private provider's namespaced slug collapses to its public form (#704/#713).
 */
export function publicGraphToken(token: string, tenantId: string, storedSlug: string): string {
  const publicSlug = publicProviderSlug(storedSlug);
  return token
    .split(":")
    .filter((seg) => seg !== tenantId)
    .map((seg) =>
      seg === storedSlug
        ? publicSlug
        : seg.startsWith(`${storedSlug}.`)
          ? `${publicSlug}${seg.slice(storedSlug.length)}`
          : seg,
    )
    .join(":");
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
