/**
 * FET-018 change-level audit lookup: surface whether impact analysis used the
 * raw-retrieval fallback, without rewriting the FET-017 coverage discriminator
 * and without writing fallback relationships into a later graph version.
 *
 * The pipeline stamps `impact.analyzed` with `metadata.fallback = "raw_retrieval"`
 * only when `analyzeImpact` ran because no endpoint surface or tenant graph
 * handle was available. Graph-authoritative runs stay unlabeled. This read
 * path is a targeted tenant+action+changeId query — never `listAudit`.
 */
import type { AppDb } from "./index.js";
import {
  summarizeChangeImpactCoverage,
  type ChangeCoverageInput,
  type ChangeImpactCoverage,
} from "./change-impact-coverage.js";

export type ChangeImpactFallback = "raw_retrieval";

export type ChangeImpactAudit = Readonly<{
  fallback: ChangeImpactFallback | null;
}>;

export type ChangeImpactCoverageWithFallback = ChangeImpactCoverage & {
  fallback: ChangeImpactFallback | null;
};

function requireTenantId(tenantId: string): string {
  if (typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new Error("tenant_scope_required");
  }
  return tenantId;
}

function requireChangeId(changeId: string): string {
  if (typeof changeId !== "string" || changeId.trim() === "") {
    throw new Error("change_id_required");
  }
  return changeId;
}

function fallbackOf(metadataJson: string | null): ChangeImpactFallback | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as { fallback?: unknown };
    return parsed.fallback === "raw_retrieval" ? "raw_retrieval" : null;
  } catch {
    return null;
  }
}

/**
 * Look up `impact.analyzed` events for one tenant and one shared catalog change.
 * Requires a non-empty tenant — the global `undefined` path used by `listAudit`
 * is refused here so a blank caller cannot scan every tenant's stamps.
 *
 * `fallback` is `raw_retrieval` when any matching event carries that stamp;
 * otherwise `null` (no events, unlabeled graph-authoritative events, or
 * unrecognised fallback values). Does not mutate coverage or the graph.
 */
export function lookupChangeImpactAudit(
  db: AppDb,
  tenantId: string,
  changeId: string,
): ChangeImpactAudit {
  const scopedTenant = requireTenantId(tenantId);
  const scopedChange = requireChangeId(changeId);
  const rows = db.raw
    .prepare(
      `SELECT metadata_json AS metadataJson
       FROM audit_events
       WHERE tenant_id = ?
         AND action = 'impact.analyzed'
         AND json_extract(metadata_json, '$.changeId') = ?`,
    )
    .all(scopedTenant, scopedChange) as Array<{ metadataJson: string | null }>;

  const fallback = rows.some((row) => fallbackOf(row.metadataJson) === "raw_retrieval")
    ? ("raw_retrieval" as const)
    : null;
  return Object.freeze({ fallback });
}

/**
 * Compose FET-017 coverage with the FET-018 audit stamp. The discriminator is
 * computed only from findings + PR coverage; a raw-retrieval stamp never
 * flips `no_impact` into `unknown_impact` or the reverse.
 */
export function loadChangeImpactCoverage(
  db: AppDb,
  tenantId: string,
  changeId: string,
  input: ChangeCoverageInput,
): ChangeImpactCoverageWithFallback {
  const coverage = summarizeChangeImpactCoverage(input);
  const audit = lookupChangeImpactAudit(db, tenantId, changeId);
  return Object.freeze({ ...coverage, fallback: audit.fallback });
}
