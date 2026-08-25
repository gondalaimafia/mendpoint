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

export type RegaugeOrgMemoryConsult = Readonly<{
  consulted: true;
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
  const scoped = input.graph.path === ":memory:"
    ? input.graph
    : createTenantGraphView(input.graph, { tenantId: input.tenantId });
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

export function consultRegaugeOrganizationMemory(input: {
  tenantId: string;
  records: readonly MemoryHead[];
  hardPolicy: Readonly<{ tenantId: string; id: string; directive: string }>;
}): RegaugeOrgMemoryConsult {
  const confirmed = input.records.find((record) =>
    organizationMemoryPrecedenceLayer(record) === "confirmed_org_memory",
  );
  const inferred = input.records.find((record) =>
    organizationMemoryPrecedenceLayer(record) === "inferred_candidate",
  );
  const resolved = resolveOrganizationDecision({
    tenantId: input.tenantId,
    hardPolicy: input.hardPolicy,
    ...(confirmed
      ? {
          confirmedOrgMemory: {
            tenantId: confirmed.tenantId,
            memoryId: confirmed.memoryId,
            recordId: confirmed.recordId,
            status: confirmed.status,
            statement: confirmed.statement,
          },
        }
      : {}),
    ...(inferred
      ? {
          inferredCandidate: {
            tenantId: inferred.tenantId,
            memoryId: inferred.memoryId,
            recordId: inferred.recordId,
            status: inferred.status,
            statement: inferred.statement,
          },
        }
      : {}),
  });
  return Object.freeze({
    consulted: true,
    winner: resolved.winner,
    reason: resolved.reason,
    appliedMemoryId: resolved.appliedMemory?.memoryId ?? null,
    overriddenMemoryIds: Object.freeze(resolved.overriddenMemory.map((entry) => entry.memory.memoryId)),
  });
}
