/**
 * Feature flags — GA vs experimental.
 * Env: MENDPOINT_FEATURES=transformer,gnn  (comma list) or MENDPOINT_EXPERIMENTAL=1
 */
import { RELEASE, REGAUGE_RELEASE, resolveRelease } from "./release.js";

export type FeatureId =
  | (typeof RELEASE.gaFeatures)[number]
  | (typeof RELEASE.experimentalFeatures)[number]
  | (typeof REGAUGE_RELEASE.gaFeatures)[number]
  | string;

function envEnabled(env: Readonly<Record<string, string | undefined>>): Set<string> {
  const release = resolveRelease(env);
  const raw = env.MENDPOINT_FEATURES ?? "";
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (env.MENDPOINT_EXPERIMENTAL === "1") {
    for (const f of release.experimentalFeatures) set.add(f);
  }
  return set;
}

/** GA features always on; experimental need flag or EXPERIMENTAL=1 */
export function isFeatureEnabled(
  id: FeatureId,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const release = resolveRelease(env);
  const experimentalSet = new Set<string>(release.experimentalFeatures);
  const gaSet = new Set<string>(release.gaFeatures);
  if (gaSet.has(id)) return true;
  if (!experimentalSet.has(id) && !id.startsWith("exp_")) {
    // unknown custom flags: opt-in only
    return envEnabled(env).has(id);
  }
  return envEnabled(env).has(id);
}

export function featureMatrix(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Array<{
  id: string;
  tier: "ga" | "experimental";
  enabled: boolean;
}> {
  const rows: Array<{ id: string; tier: "ga" | "experimental"; enabled: boolean }> =
    [];
  const release = resolveRelease(env);
  for (const id of release.gaFeatures) {
    rows.push({ id, tier: "ga", enabled: true });
  }
  for (const id of release.experimentalFeatures) {
    rows.push({ id, tier: "experimental", enabled: isFeatureEnabled(id, env) });
  }
  return rows;
}

export function assertGaOnly(id: FeatureId): void {
  if (!isFeatureEnabled(id)) {
    throw new Error(
      `feature_disabled: ${id} is experimental — set MENDPOINT_FEATURES=${id} or MENDPOINT_EXPERIMENTAL=1`,
    );
  }
}
