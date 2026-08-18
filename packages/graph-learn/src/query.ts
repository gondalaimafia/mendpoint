/**
 * Graph-RAG query layer — deterministic multi-hop templates for planners.
 * All queries record latency samples for SLO checks.
 */
import type {
  GlEdge,
  GlNode,
  GraphQuery,
  GraphQueryCoverage,
  GraphQueryResult,
} from "./schema.js";
import {
  countStats,
  edgesByKindAt,
  edgesFrom,
  edgesTo,
  getNode,
  listNodesByKind,
  type GraphLearnDb,
} from "./store.js";
import {
  formatLatencyReport,
  latencyReport,
  recordLatency,
} from "./slo.js";
import {
  createTenantGraphView,
  tenantGraphStats,
  tenantPatternSuccessRows,
  type GraphTenantScope,
} from "./tenant-scope.js";
import {
  enumerateDependencyPaths,
  HARD_MAX_HOPS,
  HARD_MAX_PATHS,
} from "./dependency-paths.js";

function collectNodes(db: GraphLearnDb, ids: Iterable<string>): GlNode[] {
  const out: GlNode[] = [];
  for (const id of ids) {
    const n = getNode(db, id);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Clamp a caller-supplied hop/size bound to a hard ceiling, reporting whether the
 * ceiling actually bound. A bound that binds must downgrade a result's coverage
 * to `partial` so a clamped traversal is never labelled `complete`. Mirrors the
 * boundedInt shape in dependency-paths.ts and reuses its HARD_MAX_* vocabulary.
 */
function clampBound(
  value: number | undefined,
  fallback: number,
  hardMax: number,
): { value: number; clamped: boolean } {
  if (value === undefined || !Number.isFinite(value)) {
    return { value: fallback, clamped: false };
  }
  const floored = Math.max(0, Math.floor(value));
  const bounded = Math.min(floored, hardMax);
  return { value: bounded, clamped: bounded < floored };
}

/**
 * BFS multi-hop neighborhood. Depth is bounded by `maxHops` and total breadth by
 * `maxNodes`; when the node cap stops expansion the result is flagged `truncated`
 * so the caller can report `partial` coverage rather than a false `complete`.
 */
export function blastRadius(
  db: GraphLearnDb,
  nodeId: string,
  maxHops = 2,
  maxNodes = HARD_MAX_PATHS,
): { nodes: GlNode[]; edges: GlEdge[]; truncated: boolean } {
  const seen = new Set<string>([nodeId]);
  const seenEdges = new Set<string>();
  const edgeAcc: GlEdge[] = [];
  let frontier = [nodeId];
  let truncated = false;
  for (let h = 0; h < maxHops; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of [...edgesFrom(db, id), ...edgesTo(db, id)]) {
        if (!seenEdges.has(e.id)) {
          seenEdges.add(e.id);
          edgeAcc.push(e);
        }
        const other = e.source === id ? e.target : e.source;
        if (!seen.has(other)) {
          if (seen.size >= maxNodes) {
            truncated = true;
            continue;
          }
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return { nodes: collectNodes(db, seen), edges: edgeAcc, truncated };
}

/**
 * Ensure every result carries a coverage assessment. Ops that do not know they
 * are incomplete are `complete` within their scope by construction (deterministic
 * template enumeration); ops that can be truncated or targeted at an absent node
 * set their own coverage, which is preserved here.
 */
function withDefaultCoverage(result: GraphQueryResult): GraphQueryResult {
  if (result.coverage) return result;
  return { ...result, coverage: { basis: "complete" } };
}

export function runGraphQuery(
  db: GraphLearnDb,
  q: GraphQuery,
  scope: GraphTenantScope,
): GraphQueryResult {
  // Fail closed by construction: the tenant scope is mandatory. Omitting it is a
  // type error at the call site; a blank tenant is rejected at runtime so no op
  // can ever fall back to the global cross-tenant graph.
  if (!scope || !scope.tenantId) {
    throw new Error("graph_tenant_scope_required");
  }
  const t0 = performance.now();
  let tenantView: GraphLearnDb | undefined;
  try {
    let result: GraphQueryResult;
    if (q.op === "pattern_success_rates") {
      const minSamples = q.minSamples ?? 1;
      const rows = tenantPatternSuccessRows(db, scope, minSamples);
      result = {
        op: q.op,
        nodes: [],
        edges: [],
        summary: `${rows.length} pattern(s) with >=${minSamples} samples`,
        rows,
      };
    } else if (q.op === "stats") {
      const stats = tenantGraphStats(db, scope);
      result = {
        op: "stats",
        nodes: [],
        edges: [],
        summary: `${stats.nodes} nodes, ${stats.edges} edges`,
        rows: [stats],
      };
    } else if (q.op === "latency_stats") {
      result = runGraphQueryInner(db, q);
    } else {
      tenantView = createTenantGraphView(db, scope);
      result = runGraphQueryInner(tenantView, q);
    }
    return withDefaultCoverage(result);
  } finally {
    tenantView?.raw.close();
    recordLatency(q.op, performance.now() - t0);
  }
}

function runGraphQueryInner(
  db: GraphLearnDb,
  q: GraphQuery,
): GraphQueryResult {
  switch (q.op) {
    case "stats": {
      const s = countStats(db);
      return {
        op: "stats",
        nodes: [],
        edges: [],
        summary: `${s.nodes} nodes, ${s.edges} edges`,
        rows: [s],
      };
    }
    case "latency_stats": {
      const report = latencyReport();
      return {
        op: "latency_stats",
        nodes: [],
        edges: [],
        summary: formatLatencyReport(report),
        rows: report.ops.map((o) => ({
          op: o.op,
          n: o.n,
          p50Ms: Number(o.p50Ms.toFixed(2)),
          p99Ms: Number(o.p99Ms.toFixed(2)),
          maxMs: Number(o.maxMs.toFixed(2)),
          p50Ok: o.p50Ok,
          p99Ok: o.p99Ok,
          targetP50: o.target.p50Ms,
          targetP99: o.target.p99Ms,
        })),
      };
    }
    case "repository_evidence": {
      const snapshots = listNodesByKind(db, "RepositorySnapshot")
        .filter(
          (node) =>
            node.props?.repository_id === q.repositoryId &&
            (!q.snapshotId || node.props?.snapshot_id === q.snapshotId),
        )
        .sort((a, b) =>
          String(b.props?.captured_at ?? "").localeCompare(
            String(a.props?.captured_at ?? ""),
          ),
        );
      const allowedTypes = q.evidenceTypes?.length
        ? new Set(q.evidenceTypes)
        : undefined;
      const available = snapshots
        .flatMap((snapshot) =>
          edgesTo(db, snapshot.id, ["EVIDENCES"]).map((edge) => ({
            snapshot,
            edge,
            evidence: getNode(db, edge.source),
          })),
        )
        .filter(
          (item) =>
            item.evidence &&
            (!allowedTypes ||
              allowedTypes.has(
                String(item.evidence.props?.evidence_type) as
                  | "runtime_trace"
                  | "test_coverage"
                  | "codeowners"
                  | "ci"
                  | "deployment"
                  | "collector",
              )),
        )
        .sort((a, b) =>
          String(a.evidence?.props?.observed_at ?? "").localeCompare(
            String(b.evidence?.props?.observed_at ?? ""),
          ),
        );
      const limit = Math.max(1, Math.min(100, q.limit ?? 50));
      const selected = available.slice(0, limit);
      const selectedSnapshotIds = new Set(selected.map((item) => item.snapshot.id));
      const nodes = [
        ...snapshots.filter((snapshot) => selectedSnapshotIds.has(snapshot.id)),
        ...selected.flatMap((item) => (item.evidence ? [item.evidence] : [])),
      ];
      return {
        op: q.op,
        nodes,
        edges: selected.map((item) => item.edge),
        summary: `${selected.length} of ${available.length} repository evidence record(s)`,
        rows: selected.map(({ evidence }) => ({
          id: evidence!.props?.evidence_id,
          type: evidence!.props?.evidence_type,
          observedAt: evidence!.props?.observed_at,
          repositoryId: evidence!.props?.repository_id,
          snapshotId: evidence!.props?.snapshot_id,
          exactCommit: evidence!.props?.exact_commit,
          operation: evidence!.props?.operation,
          status: evidence!.props?.status,
          durationMs: evidence!.props?.duration_ms,
          suite: evidence!.props?.suite,
          linesPercent: evidence!.props?.lines_percent,
          branchesPercent: evidence!.props?.branches_percent,
          reportPath: evidence!.props?.report_path,
          codeownersPath: evidence!.props?.codeowners_path,
          owners: evidence!.props?.owners,
          matchedPaths: evidence!.props?.matched_paths,
          provider: evidence!.props?.provider,
          workflow: evidence!.props?.workflow,
          job: evidence!.props?.job,
          conclusion: evidence!.props?.conclusion,
          runId: evidence!.props?.run_id,
          runUrl: evidence!.props?.run_url,
          environment: evidence!.props?.environment,
          deploymentId: evidence!.props?.deployment_id,
          artifactSha256: evidence!.props?.artifact_sha256,
          collectorId: evidence!.props?.collector_id,
          collectorVersion: evidence!.props?.collector_version,
          bindingKind: evidence!.props?.binding_kind,
          boundEvidenceId: evidence!.props?.bound_evidence_id,
          payloadSha256: evidence!.props?.payload_sha256,
        })),
      };
    }
    case "who_consumes_provider": {
      const pId = `provider:${q.providerSlug}`;
      const edges = [
        ...edgesTo(db, pId, ["MONITORS", "CONSUMES"]),
      ];
      const consumerIds = [...new Set(edges.map((e) => e.source))];
      const nodes = collectNodes(db, [pId, ...consumerIds]);
      return {
        op: q.op,
        nodes,
        edges,
        summary: `${consumerIds.length} consumer(s) monitor ${q.providerSlug}`,
        rows: consumerIds.map((id) => ({ consumerId: id.replace(/^consumer:/, "") })),
      };
    }
    case "who_consumes_endpoint": {
      const eid = `endpoint:${q.providerSlug}:${(q.method ?? "ANY").toUpperCase()}:${q.path}`;
      // db here is already the tenant-scoped view; recurse into the inner
      // dispatcher so we neither re-wrap the view nor require a redundant scope.
      const p = runGraphQueryInner(db, {
        op: "who_consumes_provider",
        providerSlug: q.providerSlug,
      });
      const breakEdges = edgesTo(db, eid, ["BREAKS"]);
      const consumeEp = edgesTo(db, eid, ["CONSUMES"]);
      return {
        op: q.op,
        nodes: [...p.nodes, ...collectNodes(db, [eid])],
        edges: [...p.edges, ...breakEdges, ...consumeEp],
        summary: `endpoint ${q.method ?? ""} ${q.path} — ${p.rows?.length ?? 0} provider consumer(s); ${breakEdges.length} break edge(s)`,
        rows: p.rows,
      };
    }
    case "blast_radius": {
      const present = Boolean(getNode(db, q.nodeId));
      const hops = clampBound(q.maxHops, 2, HARD_MAX_HOPS);
      const r = blastRadius(db, q.nodeId, hops.value);
      const coverage: GraphQueryCoverage = !present
        ? { basis: "target_absent", reason: `node ${q.nodeId} is not in the graph` }
        : hops.clamped || r.truncated
          ? {
              basis: "partial",
              reason: hops.clamped
                ? `maxHops clamped to ${HARD_MAX_HOPS}`
                : `result capped at ${HARD_MAX_PATHS} nodes`,
            }
          : { basis: "complete" };
      return {
        op: q.op,
        nodes: r.nodes,
        edges: r.edges,
        summary: `blast radius from ${q.nodeId}: ${r.nodes.length} nodes, ${r.edges.length} edges`,
        coverage,
      };
    }
    case "neighbors": {
      const present = Boolean(getNode(db, q.nodeId));
      const dir = q.direction ?? "both";
      const outE =
        dir === "in" ? [] : edgesFrom(db, q.nodeId, q.edgeKinds);
      const inE = dir === "out" ? [] : edgesTo(db, q.nodeId, q.edgeKinds);
      const edges = [...outE, ...inE];
      const ids = new Set<string>([q.nodeId]);
      for (const e of edges) {
        ids.add(e.source);
        ids.add(e.target);
      }
      return {
        op: q.op,
        nodes: collectNodes(db, ids),
        edges,
        summary: `${edges.length} neighbor edge(s)`,
        coverage: present
          ? { basis: "complete" }
          : { basis: "target_absent", reason: `node ${q.nodeId} is not in the graph` },
      };
    }
    case "depends_on_path": {
      const enumeration = enumerateDependencyPaths(db, q.nodeId, {
        maxHops: q.maxHops,
        maxPaths: q.maxPaths,
      });
      const coverage: GraphQueryCoverage =
        enumeration.coverage === "target_absent"
          ? { basis: "target_absent", reason: `node ${q.nodeId} is not in the graph` }
          : enumeration.coverage === "partial"
            ? {
                basis: "partial",
                reason: `truncated by ${enumeration.truncation.reasons.join(",")}`,
              }
            : { basis: "complete" };
      const reason =
        enumeration.coverage === "target_absent"
          ? "; node not in graph (no evidence either way)"
          : enumeration.truncation.truncated
            ? `; truncated by ${enumeration.truncation.reasons.join(",")}`
            : "; complete within bounds";
      return {
        op: q.op,
        nodes: collectNodes(db, enumeration.nodeIds),
        edges: enumeration.edges,
        summary: `depends_on ${enumeration.paths.length} terminal path(s) from ${q.nodeId}${reason}`,
        rows: enumeration.paths,
        truncation: enumeration.truncation,
        coverage,
      };
    }
    case "neighborhood": {
      // db here is already the tenant-scoped view (see who_consumes_endpoint).
      return runGraphQueryInner(db, {
        op: "blast_radius",
        nodeId: q.nodeId,
        maxHops: q.k ?? 1,
      });
    }
    case "callers": {
      const present = Boolean(getNode(db, q.symbolId));
      const edges = edgesTo(db, q.symbolId, ["CALLS", "IMPACTS"]);
      const ids = new Set<string>([q.symbolId, ...edges.map((e) => e.source)]);
      return {
        op: q.op,
        nodes: collectNodes(db, ids),
        edges,
        summary: `${edges.length} caller edge(s) into ${q.symbolId}`,
        rows: edges.map((e) => ({ from: e.source, kind: e.kind })),
        coverage: present
          ? { basis: "complete" }
          : { basis: "target_absent", reason: `symbol ${q.symbolId} is not in the graph` },
      };
    }
    case "path": {
      // BFS path from → to
      const fromPresent = Boolean(getNode(db, q.fromId));
      const toPresent = Boolean(getNode(db, q.toId));
      const hops = clampBound(q.maxHops, 6, HARD_MAX_HOPS);
      const maxHops = hops.value;
      const prev = new Map<string, { id: string; edge?: GlEdge }>();
      prev.set(q.fromId, { id: q.fromId });
      let frontier = [q.fromId];
      let found = false;
      for (let h = 0; h < maxHops && !found; h++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const e of edgesFrom(db, id)) {
            if (prev.has(e.target)) continue;
            prev.set(e.target, { id: e.target, edge: e });
            if (e.target === q.toId) {
              found = true;
              break;
            }
            next.push(e.target);
          }
          if (found) break;
        }
        frontier = next;
      }
      if (!found) {
        const absent = !fromPresent || !toPresent;
        const coverage: GraphQueryCoverage = absent
          ? {
              basis: "target_absent",
              reason: `${!fromPresent ? q.fromId : q.toId} is not in the graph`,
            }
          : hops.clamped
            ? {
                // Search stopped at the clamped depth; a longer path may exist.
                basis: "partial",
                reason: `maxHops clamped to ${HARD_MAX_HOPS}`,
              }
            : { basis: "complete" };
        return {
          op: q.op,
          nodes: [],
          edges: [],
          summary: `no path ${q.fromId} → ${q.toId}${absent ? " (endpoint not in graph)" : ""}`,
          coverage,
        };
      }
      const pathIds: string[] = [];
      const pathEdges: GlEdge[] = [];
      let cur: string | undefined = q.toId;
      while (cur) {
        pathIds.unshift(cur);
        const p = prev.get(cur);
        if (p?.edge) pathEdges.unshift(p.edge);
        if (cur === q.fromId) break;
        cur = p?.edge?.source;
        if (cur === undefined) break;
      }
      return {
        op: q.op,
        nodes: collectNodes(db, pathIds),
        edges: pathEdges,
        summary: `path length ${pathEdges.length}`,
        rows: pathIds.map((id, i) => ({ step: i, nodeId: id })),
      };
    }
    case "pattern_success_rates": {
      const minS = q.minSamples ?? 1;
      const stats = new Map<string, { ok: number; fail: number }>();
      for (const c of listNodesByKind(db, "Consumer")) {
        for (const e of edgesFrom(db, c.id, [
          "OUTCOME_MERGED",
          "OUTCOME_CLOSED",
          "OUTCOME_BROKE",
          "OUTCOME_WAIVED",
        ])) {
          const pattern = String(
            (e.props as { pattern?: string } | undefined)?.pattern ?? e.target,
          );
          const s = stats.get(pattern) ?? { ok: 0, fail: 0 };
          if (e.kind === "OUTCOME_MERGED" || e.kind === "OUTCOME_WAIVED") s.ok++;
          else s.fail++;
          stats.set(pattern, s);
        }
      }
      const rows = [...stats.entries()]
        .map(([pattern, s]) => {
          const n = s.ok + s.fail;
          return {
            pattern,
            samples: n,
            successRate: n ? s.ok / n : 0,
            ok: s.ok,
            fail: s.fail,
          };
        })
        .filter((r) => r.samples >= minS)
        .sort((a, b) => b.successRate - a.successRate);
      return {
        op: q.op,
        nodes: [],
        edges: [],
        summary: `${rows.length} pattern(s) with >=${minS} samples`,
        rows,
      };
    }
    case "outcomes_for_pattern": {
      const allOut = [...listNodesByKind(db, "PullRequest")];
      const rows: Array<Record<string, unknown>> = [];
      const edges: GlEdge[] = [];
      const nodes: GlNode[] = [];
      for (const n of allOut) {
        if (
          n.label.toLowerCase().includes(q.pattern.toLowerCase()) ||
          JSON.stringify(n.props ?? {}).toLowerCase().includes(q.pattern.toLowerCase())
        ) {
          nodes.push(n);
          const es = edgesFrom(db, n.id);
          edges.push(...es);
          rows.push({ pr: n.id, label: n.label, props: n.props });
        }
      }
      for (const kind of [
        "OUTCOME_MERGED",
        "OUTCOME_CLOSED",
        "OUTCOME_BROKE",
      ] as const) {
        const consumers = listNodesByKind(db, "Consumer");
        for (const c of consumers) {
          for (const e of edgesFrom(db, c.id, [kind])) {
            if (
              JSON.stringify(e.props ?? {})
                .toLowerCase()
                .includes(q.pattern.toLowerCase()) ||
              e.target.includes(q.pattern)
            ) {
              edges.push(e);
              rows.push({ edge: e.id, kind: e.kind, label: e.label });
            }
          }
        }
      }
      return {
        op: q.op,
        nodes,
        edges,
        summary: `${rows.length} outcome hit(s) for pattern ${JSON.stringify(q.pattern)}`,
        rows,
      };
    }
    case "consumers_of_field": {
      const fields = listNodesByKind(db, "Field").filter(
        (f) =>
          f.label === q.fieldName ||
          String(f.props?.name) === q.fieldName,
      );
      const edges: GlEdge[] = [];
      const nodeIds = new Set<string>();
      const schemaIds = new Set<string>();
      for (const f of fields) {
        for (const e of edgesTo(db, f.id, ["HAS_FIELD"])) {
          const schema = getNode(db, e.source);
          if (
            !schema ||
            !(
              schema.label === q.schemaName ||
              schema.id === q.schemaName ||
              schema.id.endsWith(`:${q.schemaName}`) ||
              String(schema.props?.name) === q.schemaName
            )
          ) {
            continue;
          }
          nodeIds.add(f.id);
          edges.push(e);
          nodeIds.add(e.source);
          schemaIds.add(e.source);
        }
      }

      const endpointIds = new Set<string>();
      // The path/method fan-out compares every schema against every Endpoint, so
      // a field shared by many schemas could otherwise drive an unbounded
      // O(schemas × endpoints) scan. Materialize the endpoint set once and cap
      // total comparisons at the shared result ceiling; if the cap binds, the
      // op reports `partial` coverage rather than a false `complete`.
      const allEndpoints = listNodesByKind(db, "Endpoint");
      let endpointScanBudget = HARD_MAX_PATHS;
      let endpointScanTruncated = false;
      for (const schemaId of schemaIds) {
        for (const edge of edgesTo(db, schemaId, ["HAS_SCHEMA"])) {
          edges.push(edge);
          endpointIds.add(edge.source);
          nodeIds.add(edge.source);
        }
        const schema = getNode(db, schemaId);
        const path = String(schema?.props?.path ?? "");
        const method = String(schema?.props?.method ?? "").toUpperCase();
        if (path) {
          for (const endpoint of allEndpoints) {
            if (endpointScanBudget-- <= 0) {
              endpointScanTruncated = true;
              break;
            }
            if (
              String(endpoint.props?.path) === path &&
              (!method || String(endpoint.props?.method).toUpperCase() === method)
            ) {
              endpointIds.add(endpoint.id);
              nodeIds.add(endpoint.id);
            }
          }
        }
        if (endpointScanTruncated) break;
      }

      const providerIds = new Set<string>();
      const consumerIds = new Set<string>();
      for (const endpointId of endpointIds) {
        for (const edge of edgesTo(db, endpointId, ["HAS_ENDPOINT"])) {
          edges.push(edge);
          providerIds.add(edge.source);
          nodeIds.add(edge.source);
        }
        for (const edge of edgesTo(db, endpointId, ["CONSUMES"])) {
          edges.push(edge);
          consumerIds.add(edge.source);
        }
      }
      for (const providerId of providerIds) {
        for (const edge of edgesTo(db, providerId, ["MONITORS", "CONSUMES"])) {
          edges.push(edge);
          consumerIds.add(edge.source);
        }
      }
      for (const id of consumerIds) nodeIds.add(id);

      return {
        op: q.op,
        nodes: collectNodes(db, nodeIds),
        edges,
        summary: `field ${q.schemaName}.${q.fieldName}: ${consumerIds.size} consumer(s)`,
        coverage: endpointScanTruncated
          ? {
              basis: "partial",
              reason: `endpoint scan capped at ${HARD_MAX_PATHS}`,
            }
          : { basis: "complete" },
        rows: [...consumerIds].map((id) => ({
          consumerId: id.replace(/^consumer:/, ""),
          schemaName: q.schemaName,
          fieldName: q.fieldName,
        })),
      };
    }
    case "broke_modes_for_endpoint": {
      const eps = listNodesByKind(db, "Endpoint").filter(
        (e) =>
          String(e.props?.operation_id ?? e.label).includes(q.operationId) ||
          e.id.includes(q.operationId),
      );
      const rows: Array<Record<string, unknown>> = [];
      const edges: GlEdge[] = [];
      const relatedChanges = new Set<string>();
      for (const ep of eps) {
        for (const e of edgesTo(db, ep.id, ["BREAKS", "BROKE"])) {
          edges.push(e);
          if (e.kind === "BREAKS") relatedChanges.add(e.source);
          const mode = (e.props as { failure_mode?: string } | undefined)
            ?.failure_mode ?? e.kind;
          rows.push({ endpoint: ep.id, failure_mode: mode });
        }
        for (const e of edgesFrom(db, ep.id, ["BROKE"])) {
          edges.push(e);
        }
      }
      // A PR failure is relevant only when it targets a change that breaks
      // the matched endpoint.
      for (const changeId of relatedChanges) {
        for (const e of edgesTo(db, changeId, ["BROKE"])) {
          edges.push(e);
          rows.push({
            pr: e.source,
            failure_mode: (e.props as { failure_mode?: string })?.failure_mode,
          });
        }
      }
      return {
        op: q.op,
        nodes: collectNodes(db, new Set(edges.flatMap((e) => [e.source, e.target]))),
        edges,
        summary: `${rows.length} break signal(s) for ${q.operationId}`,
        rows,
      };
    }
    case "migration_ready_units": {
      const units = listNodesByKind(db, "MigrationUnit").filter(
        (u) =>
          String(u.props?.campaign_id) === q.campaignId &&
          (u.props?.status === "pending" || !u.props?.status),
      );
      const ready = units.filter((u) => {
        const deps = edgesFrom(db, u.id, ["DEPENDS_ON"]);
        return deps.every((d) => {
          const dep = getNode(db, d.target);
          return dep?.props?.status === "merged" || deps.length === 0;
        });
      });
      const batch = ready.slice(0, q.batchSize ?? 10);
      return {
        op: q.op,
        nodes: batch,
        edges: [],
        summary: `${batch.length} ready MigrationUnit(s) for campaign ${q.campaignId}`,
        rows: batch.map((u) => ({ id: u.id, label: u.label, props: u.props })),
      };
    }
    case "invariants_for_symbol": {
      const symbols = listNodesByKind(db, "Symbol").filter(
        (s) =>
          s.label === q.qualifiedName ||
          String(s.props?.qualified_name) === q.qualifiedName,
      );
      const invs: GlNode[] = [];
      const edges: GlEdge[] = [];
      for (const s of symbols) {
        for (const e of edgesFrom(db, s.id, ["PRESERVES_INVARIANT"])) {
          edges.push(e);
          const inv = getNode(db, e.target);
          if (inv) invs.push(inv);
        }
        // via BSG: REALIZED_BY reverse
        for (const e of edgesTo(db, s.id, ["REALIZED_BY"])) {
          edges.push(e);
          for (const e2 of edgesFrom(db, e.source, ["EXTRACTED_FROM"])) {
            for (const e3 of edgesFrom(db, e2.target, ["PRESERVES_INVARIANT"])) {
              edges.push(e3);
              const inv = getNode(db, e3.target);
              if (inv) invs.push(inv);
            }
          }
        }
      }
      return {
        op: q.op,
        nodes: [...symbols, ...invs],
        edges,
        summary: `${invs.length} invariant(s) for ${q.qualifiedName}`,
        rows: invs.map((i) => ({
          id: i.id,
          expression: i.props?.expression ?? i.label,
          kind: i.props?.inv_kind,
        })),
      };
    }
    case "time_travel_calls": {
      // All CALLS edges valid at timestamp t
      const symbols = listNodesByKind(db, "Symbol");
      const edges: GlEdge[] = [];
      for (const s of symbols) {
        for (const e of edgesFrom(db, s.id, ["CALLS"], { at: q.at })) {
          edges.push(e);
        }
      }
      const ids = new Set<string>();
      for (const e of edges) {
        ids.add(e.source);
        ids.add(e.target);
      }
      return {
        op: q.op,
        nodes: collectNodes(db, ids),
        edges,
        summary: `${edges.length} CALLS edge(s) valid at ${q.at}`,
      };
    }
    case "time_travel_modifies": {
      let edges = edgesByKindAt(db, ["MODIFIES", "TOUCHES"], q.at, 5000);
      // Git emits both names for compatibility. Prefer MODIFIES so one commit
      // and file pair is one temporal fact, and exclude non-git TOUCHES.
      const temporal = new Map<string, GlEdge>();
      for (const edge of edges) {
        if (edge.source_system !== "git") continue;
        const key = `${edge.source}\u0000${edge.target}`;
        const current = temporal.get(key);
        if (!current || edge.kind === "MODIFIES") temporal.set(key, edge);
      }
      edges = [...temporal.values()];
      if (q.repoId) {
        const needle = q.repoId;
        edges = edges.filter(
          (e) => e.source.includes(needle) || e.target.includes(needle),
        );
      }
      const ids = new Set<string>();
      for (const e of edges) {
        ids.add(e.source);
        ids.add(e.target);
      }
      return {
        op: q.op,
        nodes: collectNodes(db, ids),
        edges,
        summary: `${edges.length} MODIFIES edge(s) valid at ${q.at}`,
        rows: edges.slice(0, 50).map((e) => ({
          id: e.id,
          from: e.source,
          to: e.target,
          valid_from: e.valid_from,
          valid_to: e.valid_to,
        })),
      };
    }
    default:
      return { op: "unknown", nodes: [], edges: [], summary: "unknown query" };
  }
}

/** Planner tool surface — string templates */
export const GRAPH_RAG_TOOLS = [
  "who_consumes_provider",
  "who_consumes_endpoint",
  "blast_radius",
  "neighbors",
  "neighborhood",
  "callers",
  "path",
  "depends_on_path",
  "outcomes_for_pattern",
  "pattern_success_rates",
  "consumers_of_field",
  "broke_modes_for_endpoint",
  "migration_ready_units",
  "invariants_for_symbol",
  "time_travel_calls",
  "time_travel_modifies",
  "latency_stats",
  "repository_evidence",
  "stats",
] as const;

/** How many rows/nodes {@link formatQueryForPlanner} renders inline. */
const PLANNER_ROW_LIMIT = 12;

/**
 * Render the coverage banner for a graph result. This is the honesty boundary:
 * a `partial` or `target_absent` result must never read as a definitive answer,
 * and a missing assessment is reported as UNKNOWN rather than assumed complete.
 * There is deliberately no `?? "complete"` fallback — an absent coverage field
 * is the one case that must fail closed, not open.
 */
function formatCoverageForPlanner(r: GraphQueryResult): string {
  const reason = r.coverage?.reason?.trim();
  const suffix = reason ? ` (${reason})` : "";
  switch (r.coverage?.basis) {
    case "complete":
      return `Coverage: complete. This result enumerates everything within the query's scope${suffix}.`;
    case "partial": {
      const omitted = r.truncation?.omittedPathsAtLeast;
      const omittedNote =
        typeof omitted === "number" && omitted > 0
          ? ` At least ${omitted} more path(s) exist beyond what is shown.`
          : "";
      return `Coverage: PARTIAL. Enumeration stopped at a safety bound, so more may exist than is shown${suffix}.${omittedNote}`;
    }
    case "target_absent":
      return `Coverage: TARGET ABSENT. This entity was never observed in the graph${suffix}; an empty result means there is no evidence either way, NOT that the entity has no relationships.`;
    default:
      return `Coverage: UNKNOWN. This result did not report coverage and must not be read as complete.`;
  }
}

/**
 * Render the inline rows/nodes, stating how many were omitted rather than
 * silently cutting at {@link PLANNER_ROW_LIMIT}.
 */
function formatRowsForPlanner(r: GraphQueryResult): string {
  if (r.rows?.length) {
    const lines = r.rows
      .slice(0, PLANNER_ROW_LIMIT)
      .map((row) => `- ${JSON.stringify(row)}`);
    const omitted = r.rows.length - PLANNER_ROW_LIMIT;
    if (omitted > 0) lines.push(`- (${omitted} more row(s) not shown here)`);
    return lines.join("\n");
  }
  const nodes = r.nodes ?? [];
  if (nodes.length) {
    const lines = nodes
      .slice(0, PLANNER_ROW_LIMIT)
      .map((n) => `- (${n.kind}) ${n.label} \`${n.id}\``);
    const omitted = nodes.length - PLANNER_ROW_LIMIT;
    if (omitted > 0) lines.push(`- (${omitted} more node(s) not shown here)`);
    return lines.join("\n");
  }
  return "";
}

/**
 * Format a graph result for a planner model and, downstream, the customer PR
 * body. Coverage is rendered directly after the summary — before the row list —
 * so it survives any head-truncation a caller applies to the string.
 */
export function formatQueryForPlanner(r: GraphQueryResult): string {
  return [
    `### Graph-RAG: ${r.op}`,
    r.summary,
    formatCoverageForPlanner(r),
    formatRowsForPlanner(r),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
