/**
 * Git branch-name helpers for migration/adoption delivery.
 *
 * A provider's stored slug may be tenant-namespaced (`<tenantId>~<requested>`, S1.1 self-serve).
 * That namespaced slug must NEVER flow into a branch name: `~` is forbidden by
 * git check-ref-format (GitHub applies the same rules), so a private provider could otherwise
 * never open a PR, and the tenant id (an unsalted hash of issuer+email) would land in the
 * customer's repo. The branch's provider segment is therefore derived from a ref-safe display
 * slug — the requested (unnamespaced) part, sanitised to `[a-z0-9-]`. A SHARED provider's slug
 * has no separator and is returned unchanged, so existing shared-provider branch names are
 * byte-identical (no churn that would orphan an in-flight draft). Uniqueness of the branch
 * comes from the delivery-key hash, not from the slug, so collapsing the namespace is safe.
 */
import { publicProviderSlug } from "@mendpoint/shared";

/**
 * Ref-safe branch segment for a provider slug. Strips a tenant-private namespace prefix (via the
 * shared public-identity projection, the one source of truth) and sanitises the requested part to
 * `[a-z0-9-]`; a shared/legacy-bare slug (no separator) is returned unchanged so its branch name
 * never moves.
 */
export function refSafeBranchSegment(providerSlug: string): string {
  const requested = publicProviderSlug(providerSlug);
  if (requested === providerSlug) {
    // Shared or legacy-bare slug: unchanged, byte-identical to today's branch name.
    return providerSlug;
  }
  const sanitised = requested
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitised || "provider";
}

/**
 * Validate a branch name against git check-ref-format rules (the subset that applies to a
 * branch under refs/heads/). Used to fail closed if a branch builder ever produces an
 * unpushable ref, rather than discovering it only when GitHub rejects the push.
 */
export function isValidGitBranchName(name: string): boolean {
  if (name.length === 0) return false;
  if (name === "@") return false;
  if (name.startsWith("/") || name.endsWith("/")) return false;
  if (name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  // Control chars (<= 0x20), DEL (0x7f), space, and the ref-forbidden set ~ ^ : ? * [ \.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*\[\\]/.test(name)) return false;
  for (const component of name.split("/")) {
    if (component.length === 0) return false;
    if (component.startsWith(".")) return false;
    if (component.endsWith(".lock")) return false;
  }
  return true;
}
