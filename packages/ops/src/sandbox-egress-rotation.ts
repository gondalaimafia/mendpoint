/**
 * Resolve the set of Fly apps that must receive the rotated sandbox-egress
 * attestation secrets.
 *
 * WHY THIS EXISTS: the egress receipt was rotated onto a single hardcoded
 * `$SANDBOX_VERIFYING_APP`, while `fly.customer-warden.toml` enables
 * `MENDPOINT_SANDBOX_KIND=fly_machines` on every customer app — all of which
 * verify the receipt before they can boot. A single-app rotation left every
 * other consuming app with a stale receipt, so they crash-looped as the receipt
 * lapsed. A hardcoded name list is how this became wrong, and would drift again
 * the moment a new customer app is provisioned.
 *
 * So the target set is enumerated FROM CONFIGURATION: the live Fly app inventory
 * (`flyctl apps list --json`) filtered by the operator-configured naming
 * convention (`includePrefixes`) and org, minus the sandbox image app itself
 * (which IS the isolation boundary and must never carry a receipt). A newly
 * provisioned app that matches the convention is covered without editing any
 * list here.
 *
 * Fail closed: an invalid verifying app, or a configuration that resolves to
 * zero targets, throws rather than silently rotating nothing.
 */

/** Fly app-name shape, matching the attestation scope validator. */
const APP = /^[a-z0-9][a-z0-9-]{0,62}$/u;

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * One entry from `flyctl apps list --json`. Only the fields we filter on are
 * modelled; the org can arrive either as a slug string or a nested object across
 * flyctl versions, so both shapes are accepted.
 */
export type FlyAppListing = Readonly<{
  name?: unknown;
  organization?: unknown;
  org?: unknown;
}>;

export type SandboxEgressRotationConfig = Readonly<{
  /** Always rotated, even if the live listing has not caught up yet. */
  verifyingApp: string;
  /**
   * Operator-configured naming convention (e.g. `mendpoint-customer-`). When
   * non-empty, only listed apps whose name starts with one of these prefixes are
   * targeted. When empty, every valid listed app (after `excludeApps`) is a
   * target — use only when the org contains nothing but consuming apps.
   */
  includePrefixes?: readonly string[];
  /** Optional org-slug filter applied to the live listing. */
  org?: string;
  /**
   * Apps that must NEVER receive the receipt — above all the sandbox image app
   * (`mendpoint-sandbox`), which is the isolation boundary itself.
   */
  excludeApps?: readonly string[];
}>;

function organizationSlug(app: FlyAppListing): string | undefined {
  const org = app.organization ?? app.org;
  if (typeof org === "string") return org.trim() || undefined;
  if (org && typeof org === "object") {
    const slug = (org as Record<string, unknown>).slug;
    if (typeof slug === "string") return slug.trim() || undefined;
  }
  return undefined;
}

/**
 * Resolve the ordered, de-duplicated set of apps to rotate the receipt onto.
 *
 * @param apps parsed `flyctl apps list --json`
 * @param config operator configuration (verifying app, naming convention, org, exclusions)
 * @throws sandbox_egress_rotation_verifying_app_invalid — verifying app empty/malformed
 * @throws sandbox_egress_rotation_verifying_app_excluded — verifying app also listed as excluded
 * @throws sandbox_egress_rotation_targets_empty — configuration matched no app
 */
export function resolveSandboxEgressRotationTargets(
  apps: readonly FlyAppListing[],
  config: SandboxEgressRotationConfig,
): readonly string[] {
  const verifyingApp = config.verifyingApp?.trim();
  if (!verifyingApp || !APP.test(verifyingApp)) {
    throw new Error("sandbox_egress_rotation_verifying_app_invalid");
  }

  const exclude = new Set(
    (config.excludeApps ?? [])
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
  if (exclude.has(verifyingApp)) {
    throw new Error("sandbox_egress_rotation_verifying_app_excluded");
  }

  const prefixes = (config.includePrefixes ?? [])
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix.length > 0);
  const orgFilter = config.org?.trim() || undefined;

  const targets = new Set<string>();
  // The verifying app is always covered, independent of listing freshness.
  targets.add(verifyingApp);

  for (const app of apps) {
    const name = typeof app.name === "string" ? app.name.trim() : "";
    if (!name || !APP.test(name)) continue;
    if (exclude.has(name)) continue;
    if (orgFilter && organizationSlug(app) !== orgFilter) continue;
    if (prefixes.length > 0 && !prefixes.some((prefix) => name.startsWith(prefix))) {
      continue;
    }
    targets.add(name);
  }

  const ordered = [...targets].sort(codeUnitCompare);
  if (ordered.length === 0) {
    // Unreachable while verifyingApp is valid, but a defensive floor: rotating
    // to nothing must fail loudly rather than report a hollow success.
    throw new Error("sandbox_egress_rotation_targets_empty");
  }
  return Object.freeze(ordered);
}

/**
 * Parse `flyctl apps list --json` output into `FlyAppListing[]`. Tolerates an
 * empty string (no apps) but refuses anything that is not a JSON array, so a
 * malformed inventory fails closed rather than resolving to only the verifying
 * app.
 *
 * @throws sandbox_egress_rotation_inventory_invalid
 */
export function parseFlyAppListing(json: string): FlyAppListing[] {
  const trimmed = json.trim();
  if (!trimmed) return [];
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new Error("sandbox_egress_rotation_inventory_invalid");
  }
  if (!Array.isArray(value)) {
    throw new Error("sandbox_egress_rotation_inventory_invalid");
  }
  return value as FlyAppListing[];
}
