/**
 * F3: Control-plane knowledge graph projection from SQLite.
 */
import type { AppDb } from "@mendpoint/db";
import {
  listChanges,
  listConsumers,
  listGitHubInstallations,
  listMonitoredForConsumer,
  listProviders,
  listPrs,
  listTenants,
  listVersionsForProvider,
  getProviderBySlug,
} from "@mendpoint/db";
import { edge, node, withStats, type GraphEdge, type GraphNode, type ProductGraph } from "./types.js";
import { productGraphCache } from "./cache.js";

export type ProductGraphFocus =
  | { type: "all" }
  | { type: "provider"; slug: string }
  | { type: "consumer"; id: string }
  | { type: "tenant"; id: string };

/**
 * Project control-plane entities into a navigable product knowledge graph.
 */
export function buildProductKnowledgeGraph(
  db: AppDb,
  focus: ProductGraphFocus = { type: "all" },
  tenantId?: string,
): ProductGraph {
  const focusKey =
    focus.type === "all"
      ? "all"
      : focus.type === "provider"
        ? `provider:${focus.slug}`
        : `${focus.type}:${focus.id}`;
  const tenantFocusKey = `${tenantId ?? "global"}:${focusKey}`;
  const cached = productGraphCache.get(tenantFocusKey) as ProductGraph | undefined;
  if (cached) return cached;

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  let ei = 0;

  // Shared catalog + this tenant's own private providers/changes (S1.1); never another
  // tenant's. With no tenant-private rows this is byte-identical to the global read.
  const providers = listProviders(db, undefined, 0, tenantId);
  const consumers = listConsumers(db, tenantId);
  const changes = listChanges(db, undefined, 0, tenantId);
  const prs = listPrs(db, tenantId);
  const tenants = listTenants(db).filter((tenant) => !tenantId || tenant.id === tenantId);
  const installs = listGitHubInstallations(db, tenantId);

  let providerFilter: Set<string> | null = null;
  let consumerFilter: Set<string> | null = null;

  if (focus.type === "provider") {
    const p = getProviderBySlug(db, focus.slug);
    providerFilter = new Set(p ? [p.id] : []);
  } else if (focus.type === "consumer") {
    consumerFilter = new Set([focus.id]);
  } else if (focus.type === "tenant") {
    consumerFilter = new Set(
      consumers.filter((c) => c.tenant_id === focus.id).map((c) => c.id),
    );
  }

  for (const t of tenants) {
    if (focus.type === "tenant" && t.id !== focus.id) continue;
    nodes.set(
      `tenant:${t.id}`,
      node(`tenant:${t.id}`, "tenant", t.name, { slug: t.slug, plan: t.plan }, 0),
    );
  }

  for (const p of providers) {
    if (providerFilter && !providerFilter.has(p.id)) continue;
    const pid = `provider:${p.id}`;
    nodes.set(pid, node(pid, "provider", p.name, { slug: p.slug }, 1));
    for (const v of listVersionsForProvider(db, p.id)) {
      const vid = `version:${v.id}`;
      nodes.set(
        vid,
        node(vid, "version", v.version_label, { providerId: p.id }, 2),
      );
      edges.push(edge(`e${ei++}`, pid, vid, "HAS_VERSION"));
    }
  }

  for (const c of consumers) {
    if (consumerFilter && !consumerFilter.has(c.id)) continue;
    const cid = `consumer:${c.id}`;
    nodes.set(
      cid,
      node(cid, "consumer", c.name, {
        githubOwner: c.github_owner,
        githubRepo: c.github_repo,
        tenantId: c.tenant_id,
      }, 1),
    );
    if (c.tenant_id) {
      const tid = `tenant:${c.tenant_id}`;
      if (nodes.has(tid)) {
        edges.push(edge(`e${ei++}`, tid, cid, "OWNS"));
      }
    }
    for (const m of listMonitoredForConsumer(db, c.id)) {
      const pid = `provider:${m.provider_id}`;
      if (nodes.has(pid) || !providerFilter) {
        if (!nodes.has(pid)) {
          const p = providers.find((x) => x.id === m.provider_id);
          if (p) {
            nodes.set(pid, node(pid, "provider", p.name, { slug: p.slug }, 1));
          }
        }
        if (nodes.has(pid)) {
          edges.push(
            edge(`e${ei++}`, cid, pid, "MONITORS", { source: m.detection_source }),
          );
        }
      }
    }
  }

  for (const ch of changes) {
    if (providerFilter && !providerFilter.has(ch.provider_id)) continue;
    const chid = `change:${ch.id}`;
    nodes.set(
      chid,
      node(chid, "change", ch.summary.slice(0, 64), {
        risk: ch.risk,
        providerId: ch.provider_id,
        createdAt: ch.created_at,
      }, 3),
    );
    const pid = `provider:${ch.provider_id}`;
    if (nodes.has(pid)) {
      edges.push(edge(`e${ei++}`, pid, chid, "PRODUCED_CHANGE"));
    }
    edges.push(
      edge(`e${ei++}`, `version:${ch.from_version_id}`, chid, "FROM_VERSION"),
    );
    edges.push(edge(`e${ei++}`, chid, `version:${ch.to_version_id}`, "TO_VERSION"));
  }

  for (const pr of prs) {
    if (consumerFilter && !consumerFilter.has(pr.consumer_id)) continue;
    const prid = `pr:${pr.id}`;
    nodes.set(
      prid,
      node(prid, "pr", pr.title.slice(0, 64), {
        status: pr.status,
        risk: pr.risk,
        url: pr.github_pr_url,
      }, 4),
    );
    const chid = `change:${pr.change_id}`;
    const cid = `consumer:${pr.consumer_id}`;
    if (nodes.has(chid) || !providerFilter) {
      if (!nodes.has(chid)) {
        const ch = changes.find((x) => x.id === pr.change_id);
        if (ch) {
          nodes.set(
            chid,
            node(chid, "change", ch.summary.slice(0, 64), { risk: ch.risk }, 3),
          );
        }
      }
      if (nodes.has(chid)) {
        edges.push(edge(`e${ei++}`, chid, prid, "OPENED_PR"));
      }
    }
    if (nodes.has(cid)) {
      edges.push(edge(`e${ei++}`, cid, prid, "RECEIVED_PR"));
    }
  }

  for (const inst of installs) {
    const iid = `installation:${inst.id}`;
    nodes.set(
      iid,
      node(iid, "installation", inst.account_login, {
        installationId: inst.installation_id,
      }, 1),
    );
    if (inst.tenant_id && nodes.has(`tenant:${inst.tenant_id}`)) {
      edges.push(edge(`e${ei++}`, `tenant:${inst.tenant_id}`, iid, "HAS_INSTALL"));
    }
  }

  // Drop dangling version edges without nodes
  const nodeIds = new Set(nodes.keys());
  const cleanEdges = edges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
  );

  // Cap product graph size for UI snappiness (keep newest changes/PRs)
  let nodeList = [...nodes.values()];
  if (nodeList.length > 180) {
    const keepKinds = new Set(["tenant", "provider", "consumer", "installation"]);
    const essentials = nodeList.filter((n) => keepKinds.has(n.kind));
    const rest = nodeList
      .filter((n) => !keepKinds.has(n.kind))
      .slice(0, 180 - essentials.length);
    nodeList = [...essentials, ...rest];
  }
  const keepIds = new Set(nodeList.map((n) => n.id));
  const trimmedEdges = cleanEdges.filter(
    (e) => keepIds.has(e.source) && keepIds.has(e.target),
  );

  const out = withStats({
    id: `product:${focus.type}${
      focus.type === "provider"
        ? `:${focus.slug}`
        : focus.type === "consumer" || focus.type === "tenant"
          ? `:${focus.id}`
          : ""
    }`,
    title: "Product knowledge graph",
    description: "Tenants · providers · versions · changes · consumers · PRs",
    nodes: nodeList,
    edges: trimmedEdges,
  });
  productGraphCache.set(tenantFocusKey, out);
  return out;
}
