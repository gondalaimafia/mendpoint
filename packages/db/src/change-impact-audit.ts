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

/**
 * Look up `impact.analyzed` events for one tenant and one shared catalog change.
 * Requires a non-empty tenant — the global `undefined` path used by `listAudit`
 * is refused here so a blank caller cannot scan every tenant's stamps.
 *
 * `fallback` is `raw_retrieval` when the latest analysis for any matching
 * consumer carries that stamp. Only a later graph-authoritative analysis --
 * one whose `impact_fallback` is NULL (no recognised or unrecognised fallback
 * label) -- clears the historical raw-retrieval label without deleting audit
 * history. A later analysis that itself carries a fallback label, including an
 * unrecognised value, does not clear the stamp. Does not mutate coverage or the
 * graph.
 */
export function lookupChangeImpactAudit(
  db: AppDb,
  tenantId: string,
  changeId: string,
): ChangeImpactAudit {
  const scopedTenant = requireTenantId(tenantId);
  const scopedChange = requireChangeId(changeId);
  const row = db.raw
    .prepare(
      `SELECT 1 AS matched
       FROM audit_events AS current
       WHERE current.tenant_id = ?
         AND current.action = 'impact.analyzed'
         AND current.impact_change_id = ?
         AND current.impact_fallback = 'raw_retrieval'
         AND NOT EXISTS (
           SELECT 1
           FROM audit_events AS later
           WHERE later.tenant_id = current.tenant_id
             AND later.action = current.action
             AND later.impact_change_id = current.impact_change_id
             AND later.impact_fallback IS NULL
             AND later.resource_type = current.resource_type
             AND later.resource_id IS current.resource_id
             AND later.event_sequence > current.event_sequence
         )
       LIMIT 1`,
    )
    .get(scopedTenant, scopedChange) as { matched: 1 } | undefined;

  return Object.freeze({ fallback: row ? ("raw_retrieval" as const) : null });
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
