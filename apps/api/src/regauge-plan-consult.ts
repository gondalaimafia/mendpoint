/**
 * ReGauge live-plan consults (spec §28.3). Topology comes from the Change Graph
 * when that graph actually has DEPENDS_ON edges; Organization Memory is consulted
 * through the single precedence resolver so a convention cannot override hard
 * policy. Missing graph or empty relation is declared, never treated as "no
 * dependencies" / "no conventions".
 */
import {
  createTenantGraphView,
  listAllEdges,
  listNodesByKind,
  edgesFrom,
  type GraphLearnDb,
} from "@mendpoint/graph-learn";
import {
  organizationMemoryPrecedenceLayer,
  resolveOrganizationDecision,
  type PrecedenceResult,
} from "@mendpoint/pipeline";
import type { OrganizationMemoryRecord } from "@mendpoint/db";

type MemoryHead = Pick<
  OrganizationMemoryRecord,
  "tenantId" | "memoryId" | "recordId" | "status" | "statement"
>;

export type RegaugeGraphPlanConsult = Readonly<{
  consulted: boolean;
  coverage: Readonly<{
    basis: "complete" | "target_absent" | "not_consulted";
    reason?: string;
  }>;
  dependsOnByRepositoryId: Readonly<Record<string, readonly string[]>>;
}>;

export type RegaugeOrgMemoryConsult =
  | Readonly<{
      consulted: false;
      basis: "not_consulted";
      reason: string;
    }>
  | Readonly<{
      consulted: true;
      basis: "resolved";
      winner: PrecedenceResult["winner"];
      reason: string;
      appliedMemoryId: string | null;
      overriddenMemoryIds: readonly string[];
    }>;

function serviceMatchesRepository(nodeId: string, label: string, repositoryId: string): boolean {
  return (
    nodeId === `service:${repositoryId}` ||
    label === repositoryId ||
    nodeId.endsWith(`:${repositoryId}`)
  );
}

export function consultRegaugeGraphDependencies(input: {
  graph: GraphLearnDb | null;
  tenantId: string;
  repositoryIds: readonly string[];
}): RegaugeGraphPlanConsult {
  if (!input.graph) {
    return Object.freeze({
      consulted: false,
      coverage: { basis: "not_consulted" as const, reason: "tenant_graph_not_supplied" },
      dependsOnByRepositoryId: Object.freeze({}),
    });
  }
  const scoped = createTenantGraphView(input.graph, { tenantId: input.tenantId });
  try {
    const populated = listAllEdges(scoped).some((edge) => edge.kind === "DEPENDS_ON");
    if (!populated) {
      return Object.freeze({
        consulted: true,
        coverage: {
          basis: "target_absent" as const,
          reason: "DEPENDS_ON is not populated by any ingest path",
        },
        dependsOnByRepositoryId: Object.freeze({}),
      });
    }
    const services = listNodesByKind(scoped, "Service");
    const dependsOnByRepositoryId: Record<string, string[]> = {};
    for (const repositoryId of input.repositoryIds) {
      const source = services.find((node) =>
        serviceMatchesRepository(node.id, node.label, repositoryId),
      );
      if (!source) {
        dependsOnByRepositoryId[repositoryId] = [];
        continue;
      }
      const deps = edgesFrom(scoped, source.id, ["DEPENDS_ON"])
        .map((edge) => {
          const target = services.find((node) => node.id === edge.target);
          if (!target) return null;
          return input.repositoryIds.find((id) =>
            serviceMatchesRepository(target.id, target.label, id),
          ) ?? null;
        })
        .filter((id): id is string => Boolean(id) && id !== repositoryId)
        .sort();
      dependsOnByRepositoryId[repositoryId] = [...new Set(deps)];
    }
    return Object.freeze({
      consulted: true,
      coverage: { basis: "complete" as const },
      dependsOnByRepositoryId: Object.freeze(dependsOnByRepositoryId),
    });
  } finally {
    if (scoped !== input.graph) scoped.raw.close();
  }
}

function memoryReference(record: MemoryHead) {
  return {
    tenantId: record.tenantId,
    memoryId: record.memoryId,
    recordId: record.recordId,
    status: record.status,
    statement: record.statement,
  };
}

export function consultRegaugeOrganizationMemory(input: {
  tenantId: string;
  records: readonly MemoryHead[] | null;
  hardPolicy: Readonly<{ tenantId: string; id: string; directive: string }>;
}): RegaugeOrgMemoryConsult {
  // No provider wired is not the same as a provider that returned nothing. A
  // null record source means Organization Memory was never consulted, so it is
  // declared as such rather than resolved into an empty "found nothing" result.
  if (input.records === null) {
    return Object.freeze({
      consulted: false,
      basis: "not_consulted" as const,
      reason: "organization_memory_not_supplied",
    });
  }
  // Deterministic, layer-ordered selection so the resolver names a stable memory
  // and every participating record is carried, not just the first per layer.
  const byRecordId = (a: MemoryHead, b: MemoryHead) => a.recordId.localeCompare(b.recordId);
  const confirmed = input.records
    .filter((record) => organizationMemoryPrecedenceLayer(record) === "confirmed_org_memory")
    .sort(byRecordId);
  const inferred = input.records
    .filter((record) => organizationMemoryPrecedenceLayer(record) === "inferred_candidate")
    .sort(byRecordId);
  const resolved = resolveOrganizationDecision({
    tenantId: input.tenantId,
    hardPolicy: input.hardPolicy,
    ...(confirmed[0] ? { confirmedOrgMemory: memoryReference(confirmed[0]) } : {}),
    ...(inferred[0] ? { inferredCandidate: memoryReference(inferred[0]) } : {}),
  });
  const appliedMemoryId = resolved.appliedMemory?.memoryId ?? null;
  // Every present-but-outranked memory, strongest layer first — records beyond
  // the resolver's per-layer representative are surfaced here, never dropped.
  const overriddenMemoryIds = [...confirmed, ...inferred]
    .map((record) => record.memoryId)
    .filter((memoryId) => memoryId !== appliedMemoryId);
  return Object.freeze({
    consulted: true,
    basis: "resolved" as const,
    winner: resolved.winner,
    reason: resolved.reason,
    appliedMemoryId,
    overriddenMemoryIds: Object.freeze(overriddenMemoryIds),
  });
}
