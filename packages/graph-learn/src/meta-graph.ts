/**
 * Cross-campaign meta-graph — promote high-success patterns to shared Pattern nodes.
 */
import { upsertEdge, upsertNode, listNodesByKind, type GraphLearnDb } from "./store.js";
import { runGraphQuery } from "./query.js";
import { graphNodeBelongsToTenant, type GraphTenantScope } from "./tenant-scope.js";

export type Promotion = {
  pattern: string;
  successRate: number;
  samples: number;
  patternNodeId: string;
  promoted: boolean;
};

export type PromoteOptions = {
  minSamples?: number;
  minSuccessRate?: number;
};

/**
 * Read pattern_success_rates and materialize/promote Pattern nodes + PROMOTED edges.
 */
export function promotePatterns(
  db: GraphLearnDb,
  opts: PromoteOptions = {},
  scope: GraphTenantScope,
): Promotion[] {
  const minSamples = opts.minSamples ?? 2;
  const minSuccessRate = opts.minSuccessRate ?? 0.6;
  const rates = runGraphQuery(
    db,
    { op: "pattern_success_rates", minSamples },
    scope,
  );
  const out: Promotion[] = [];

  for (const row of rates.rows ?? []) {
    const pattern = String(row.pattern ?? "");
    const successRate = Number(row.successRate ?? 0);
    const samples = Number(row.samples ?? 0);
    if (!pattern) continue;
    const tenantPrefix = scope ? `${scope.tenantId}:` : "";
    const id = `pattern:${tenantPrefix}${pattern.slice(0, 80).replace(/\s+/g, "_")}`;
    const promoted = successRate >= minSuccessRate && samples >= minSamples;
    upsertNode(db, {
      id,
      kind: "Pattern",
      label: pattern.slice(0, 120),
      repo_id: scope ? `${scope.tenantId}:patterns` : undefined,
      props: {
        name: pattern,
        success_rate: successRate,
        sample_count: samples,
        promoted,
        source: "meta-graph",
      },
    });
    if (promoted) {
      upsertEdge(db, {
        id: `PROMOTED:${id}`,
        kind: "PROMOTED",
        source: id,
        target: id,
        source_system: "pipeline",
        confidence: successRate,
        label: successRate,
        props: { samples },
      });
    }
    out.push({
      pattern,
      successRate,
      samples,
      patternNodeId: id,
      promoted,
    });
  }

  // Link campaigns to promoted patterns when present
  const campaigns = listNodesByKind(db, "Campaign").filter(
    (campaign) => !scope || graphNodeBelongsToTenant(campaign, scope),
  );
  for (const camp of campaigns) {
    for (const p of out.filter((x) => x.promoted)) {
      upsertEdge(db, {
        id: `MATCHED_PATTERN:${camp.id}:${p.patternNodeId}`.slice(0, 240),
        kind: "MATCHED_PATTERN",
        source: camp.id,
        target: p.patternNodeId,
        source_system: "pipeline",
        confidence: p.successRate,
      });
    }
  }

  return out;
}

export function listPromotedPatterns(db: GraphLearnDb) {
  return listNodesByKind(db, "Pattern").filter((p) => p.props?.promoted === true);
}
