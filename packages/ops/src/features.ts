/**
 * Feature flags — GA vs experimental.
 * Env: MENDPOINT_FEATURES=transformer,gnn  (comma list) or MENDPOINT_EXPERIMENTAL=1
 */
import { RELEASE } from "./release.js";

export type FeatureId =
  | (typeof RELEASE.gaFeatures)[number]
  | (typeof RELEASE.experimentalFeatures)[number]
  | string;

const experimentalSet = new Set<string>(RELEASE.experimentalFeatures);
const gaSet = new Set<string>(RELEASE.gaFeatures);

function envEnabled(): Set<string> {
  const raw = process.env.MENDPOINT_FEATURES ?? "";
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (process.env.MENDPOINT_EXPERIMENTAL === "1") {
    for (const f of RELEASE.experimentalFeatures) set.add(f);
  }
  return set;
}

/** GA features always on; experimental need flag or EXPERIMENTAL=1 */
export function isFeatureEnabled(id: FeatureId): boolean {
  if (gaSet.has(id)) return true;
  if (!experimentalSet.has(id) && !id.startsWith("exp_")) {
    // unknown custom flags: opt-in only
    return envEnabled().has(id);
  }
  return envEnabled().has(id);
}

export function featureMatrix(): Array<{
  id: string;
  tier: "ga" | "experimental";
  enabled: boolean;
}> {
  const rows: Array<{ id: string; tier: "ga" | "experimental"; enabled: boolean }> =
    [];
  for (const id of RELEASE.gaFeatures) {
    rows.push({ id, tier: "ga", enabled: true });
  }
  for (const id of RELEASE.experimentalFeatures) {
    rows.push({ id, tier: "experimental", enabled: isFeatureEnabled(id) });
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
