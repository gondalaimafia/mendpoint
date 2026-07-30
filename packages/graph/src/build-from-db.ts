/**
 * High-level builders that load from DB + optional local consumer index.
 * Optimized: never rebuilds index on GET paths; caches call graphs & results.
 */
import { existsSync, statSync } from "node:fs";
import {
  type AppDb,
  getChange,
  getConsumer,
  getConsumerRepo,
  getProviderBySlug,
  listFindingsForChange,
  listPrsForChange,
  listVersionsForProvider,
} from "@mendpoint/db";
import { defaultIndexPath, loadIndex, type CodebaseIndex } from "@mendpoint/codebase-index";
import type { CallGraph } from "@mendpoint/call-graph";
import { normalizeChange } from "@mendpoint/change-intel";
import { buildApiChangeGraph } from "./api-surface.js";
import { buildImpactGraph, mergeGraphs } from "./impact.js";
import { callGraphCache, changeGraphCache, productGraphCache } from "./cache.js";
import type { ProductGraph } from "./types.js";

const MAX_FINDINGS = 80;
const MAX_GRAPH_NODES = 220;

/**
 * Load call graph for read paths only — never builds a full index on request.
 * Uses on-disk index + TTL cache keyed by path+mtime.
 */
function loadCallGraph(repoPath: string): CallGraph | undefined {
  try {
    const idxPath = defaultIndexPath(repoPath);
    if (!existsSync(idxPath)) return undefined;
    const mtime = statSync(idxPath).mtimeMs;
    const cacheKey = `${idxPath}:${mtime}`;
    const hit = callGraphCache.get(cacheKey) as CallGraph | undefined;
    if (hit) return hit;

    const idx = loadIndex(idxPath) as CodebaseIndex;
    if (!idx?.callGraph) return undefined;
    callGraphCache.set(cacheKey, idx.callGraph);
    return idx.callGraph;
  } catch {
    return undefined;
  }
}

function surfacesFromDiffJson(diffJson: string) {
  try {
    const parsed = JSON.parse(diffJson) as {
      entries?: Array<Record<string, unknown>>;
      surfaces?: Array<Record<string, unknown>>;
    };
    if (parsed.surfaces?.length) {
      return parsed.surfaces.map((s, i) => ({
        id: String(s.id ?? `surface-${i}`),
        canonicalId: s.canonicalId as string | undefined,
        op: s.op as string | undefined,
        path: s.path as string | undefined,
        field: s.field as string | undefined,
        fromField: s.fromField as string | undefined,
        toField: s.toField as string | undefined,
        severity: s.severity as string | undefined,
        explanation: s.explanation as string | undefined,
      }));
    }
    if (parsed.entries?.length) {
      return parsed.entries.map((e, i) => ({
        id: `entry-${i}`,
        op: e.op as string | undefined,
        path: e.path as string | undefined,
        field: e.field as string | undefined,
        fromField: e.fromField as string | undefined,
        toField: e.toField as string | undefined,
        severity: e.breaking ? "breaking" : "non_breaking",
      }));
    }
  } catch {
    /* corrupt diff_json */
  }
  return [];
}

function trimGraph(g: ProductGraph, maxNodes = MAX_GRAPH_NODES): ProductGraph {
  if (g.nodes.length <= maxNodes) return g;
  // Keep higher-priority kinds first
  const priority: Record<string, number> = {
    change: 0,
    consumer: 1,
    surface: 2,
    operation: 2,
    field: 3,
    finding: 4,
    pr: 5,
    file: 6,
    function: 7,
    provider: 1,
    version: 2,
  };
  const sorted = [...g.nodes].sort(
    (a, b) => (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9),
  );
  const keep = new Set(sorted.slice(0, maxNodes).map((n) => n.id));
  // Always keep neighbors of kept change/finding nodes one hop
  for (const e of g.edges) {
    if (keep.has(e.source) && sorted.some((n) => n.id === e.target && n.kind !== "function")) {
      keep.add(e.target);
    }
  }
  const nodes = g.nodes.filter((n) => keep.has(n.id));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = g.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  return {
    ...g,
    nodes,
    edges,
    description: `${g.description ?? ""} · trimmed ${g.nodes.length}→${nodes.length} nodes`.trim(),
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      byKind: nodes.reduce(
        (acc, n) => {
          acc[n.kind] = (acc[n.kind] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
    },
  };
}

export function buildChangeImpactGraph(
  db: AppDb,
  changeId: string,
  opts?: {
    consumerId?: string;
    tenantId?: string;
    includeApiGraph?: boolean;
    maxFindings?: number;
  },
): ProductGraph | null {
  const cacheKey =
    `chg:${opts?.tenantId ?? "global"}:${changeId}:` +
    `${opts?.consumerId ?? ""}:${opts?.includeApiGraph !== false}`;
  const cached = changeGraphCache.get(cacheKey) as ProductGraph | undefined;
  if (cached) return cached;

  const change = getChange(db, changeId);
  if (!change) return null;

  if (
    opts?.consumerId &&
    !getConsumer(db, opts.consumerId, opts.tenantId)
  ) {
    return null;
  }

  let findings = listFindingsForChange(db, changeId, opts?.tenantId);
  if (opts?.consumerId) {
    findings = findings.filter((f) => f.consumer_id === opts.consumerId);
  }
  // Prefer high confidence first when capping
  const confRank = { high: 0, medium: 1, low: 2 } as Record<string, number>;
  findings = [...findings]
    .sort((a, b) => (confRank[a.confidence] ?? 3) - (confRank[b.confidence] ?? 3))
    .slice(0, opts?.maxFindings ?? MAX_FINDINGS);

  let callGraph: CallGraph | undefined;
  let consumerName: string | undefined;
  const consumerId = opts?.consumerId ?? findings[0]?.consumer_id;
  if (consumerId) {
    const cons = getConsumer(db, consumerId, opts?.tenantId);
    consumerName = cons?.name;
    const repo = getConsumerRepo(db, consumerId, opts?.tenantId);
    if (repo?.local_path) {
      callGraph = loadCallGraph(repo.local_path);
    }
  }

  const surfaces = surfacesFromDiffJson(change.diff_json);

  let impact = buildImpactGraph({
    changeId: change.id,
    summary: change.summary,
    risk: change.risk,
    findings: findings.map((f) => ({
      id: f.id,
      filePath: f.file_path,
      lineStart: f.line_start,
      lineEnd: f.line_end,
      symbol: f.symbol,
      confidence: f.confidence,
      consumerId: f.consumer_id,
      evidenceJson: f.evidence_json,
    })),
    surfaces,
    callGraph,
    consumerId,
    consumerName,
    maxCallerDepth: 2,
  });

  const prs = listPrsForChange(db, changeId, opts?.tenantId);
  for (const pr of prs) {
    if (opts?.consumerId && pr.consumer_id !== opts.consumerId) continue;
    impact.nodes.push({
      id: `pr:${pr.id}`,
      kind: "pr",
      label: pr.title.slice(0, 48),
      rank: 6,
      meta: { status: pr.status, url: pr.github_pr_url },
    });
    impact.edges.push({
      id: `e-pr-${pr.id}`,
      source: `change:${change.id}`,
      target: `pr:${pr.id}`,
      kind: "OPENED_PR",
    });
  }

  if (opts?.includeApiGraph !== false) {
    try {
      const diff = JSON.parse(change.diff_json) as {
        entries: Array<{
          op: string;
          path?: string;
          method?: string;
          field?: string;
          fromField?: string;
          toField?: string;
          detail?: string;
          breaking: boolean;
        }>;
        risk: "breaking" | "non_breaking" | "new_capability";
        summary: string;
      };
      if (diff.entries) {
        const api = buildApiChangeGraph(
          {
            entries: diff.entries as never,
            risk: diff.risk ?? "non_breaking",
            summary: diff.summary ?? change.summary,
          },
          { id: `api:${change.id}`, title: "API delta" },
        );
        impact = mergeGraphs(api, impact, `Change graph · ${change.summary.slice(0, 40)}`);
      }
    } catch {
      /* impact only */
    }
  }

  const out = trimGraph(impact);
  changeGraphCache.set(cacheKey, out);
  return out;
}

export function buildProviderApiGraph(db: AppDb, providerSlug: string): ProductGraph | null {
  const p = getProviderBySlug(db, providerSlug);
  if (!p) return null;
  const versions = listVersionsForProvider(db, p.id);
  if (versions.length < 2) {
    return {
      id: `api:${providerSlug}:insufficient`,
      title: `${p.name} — need ≥2 versions`,
      nodes: [
        {
          id: `provider:${p.id}`,
          kind: "provider",
          label: p.name,
          meta: { slug: p.slug },
        },
      ],
      edges: [],
      stats: { nodeCount: 1, edgeCount: 0, byKind: { provider: 1 } },
    };
  }
  const from = versions[versions.length - 2]!;
  const to = versions[versions.length - 1]!;
  try {
    const { diff } = normalizeChange(
      JSON.parse(from.openapi_json),
      JSON.parse(to.openapi_json),
      { providerSlug: p.slug },
    );
    return buildApiChangeGraph(diff, {
      id: `${p.slug}:${from.version_label}→${to.version_label}`,
      title: `${p.name} ${from.version_label} → ${to.version_label}`,
      providerSlug: p.slug,
    });
  } catch (e) {
    return {
      id: `api:${providerSlug}:error`,
      title: `${p.name} — failed to diff versions`,
      description: e instanceof Error ? e.message : String(e),
      nodes: [
        {
          id: `provider:${p.id}`,
          kind: "provider",
          label: p.name,
          meta: { error: true },
        },
      ],
      edges: [],
      stats: { nodeCount: 1, edgeCount: 0, byKind: { provider: 1 } },
    };
  }
}

export function invalidateGraphCaches(): void {
  callGraphCache.clear();
  changeGraphCache.clear();
  productGraphCache.clear();
}
