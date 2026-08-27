/**
 * ReGauge live-plan consults (spec §28.3). Topology comes from the Change Graph
 * when that graph actually has DEPENDS_ON edges; Organization Memory is consulted
 * through the single precedence resolver so a convention cannot override hard
 * policy. Missing graph or empty relation is declared, never treated as "no
 * dependencies" / "no conventions".
 */
import {
  createTenantGraphView,
  listNodesByKind,
  edgesFrom,
  type GraphLearnDb,
} from "@mendpoint/graph-learn";
import {
  createRegaugeDependencyProjectionV1,
  type RegaugeDependencyProjectionEdgeV1,
  type RegaugeDependencyProjectionRepositoryV1,
  type RegaugeDependencyProjectionV1,
} from "@mendpoint/transformer";
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

export type RegaugeGraphPlanConsult = RegaugeDependencyProjectionV1;

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

const DIGEST = /^sha256:[a-f0-9]{64}$/;

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) =>
    typeof entry !== "string" || !entry.trim() || entry !== entry.trim())) return null;
  return [...new Set(value as string[])].sort();
}

function manifestRootEvidence(
  node: ReturnType<typeof listNodesByKind>[number],
  tenantId: string,
  repositoryId: string,
): { evidenceRefs: string[]; contentDigest: string } | null {
  const props = node.props;
  const contentDigest = props?.manifest_content_digest;
  const evidenceRefs = strings(props?.manifest_evidence_refs);
  if (
    node.repo_id !== repositoryId ||
    props?.tenant_id !== tenantId ||
    props?.manifest_ingest_status !== "complete" ||
    props?.declared === true ||
    typeof props?.manifest !== "string" || !props.manifest.trim() ||
    typeof contentDigest !== "string" || !DIGEST.test(contentDigest) ||
    !evidenceRefs || !evidenceRefs.includes(`manifest-ingest:${contentDigest}`)
  ) return null;
  return { evidenceRefs, contentDigest };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function consultRegaugeGraphDependencies(input: {
  graph: GraphLearnDb | null;
  tenantId: string;
  repositoryIds: readonly string[];
}): RegaugeGraphPlanConsult {
  const requestedRepositoryIds = [...new Set(input.repositoryIds)].sort(compareCodeUnits);
  if (!input.graph) {
    return createRegaugeDependencyProjectionV1({
      tenantId: input.tenantId,
      requestedRepositoryIds,
      repositories: requestedRepositoryIds.map((repositoryId) => ({
        repositoryId,
        serviceId: null,
        coverage: "not_consulted" as const,
        reason: "graph_not_supplied",
        dependsOnRepositoryIds: [],
        evidenceRefs: [],
      })),
      edges: [],
    });
  }
  const scoped = createTenantGraphView(input.graph, { tenantId: input.tenantId });
  try {
    const services = listNodesByKind(scoped, "Service").sort((left, right) => compareCodeUnits(left.id, right.id));
    const roots = new Map<string, Array<{
      node: (typeof services)[number];
      evidence: { evidenceRefs: string[]; contentDigest: string };
    }>>();
    for (const repositoryId of requestedRepositoryIds) {
      roots.set(repositoryId, services.flatMap((node) => {
        const evidence = manifestRootEvidence(node, input.tenantId, repositoryId);
        return evidence ? [{ node, evidence }] : [];
      }));
    }
    const rootByLabel = new Map<string, Array<{ repositoryId: string; serviceId: string }>>();
    for (const [repositoryId, candidates] of roots) {
      if (candidates.length !== 1) continue;
      const root = candidates[0]!.node;
      rootByLabel.set(root.label, [
        ...(rootByLabel.get(root.label) ?? []),
        { repositoryId, serviceId: root.id },
      ]);
    }
    const repositories: RegaugeDependencyProjectionRepositoryV1[] = [];
    const projectionEdges: RegaugeDependencyProjectionEdgeV1[] = [];
    for (const repositoryId of requestedRepositoryIds) {
      const candidates = roots.get(repositoryId) ?? [];
      if (candidates.length === 0) {
        repositories.push({
          repositoryId,
          serviceId: null,
          coverage: "unknown",
          reason: "manifest_ingest_evidence_missing",
          dependsOnRepositoryIds: [],
          evidenceRefs: [],
        });
        continue;
      }
      if (candidates.length > 1) {
        repositories.push({
          repositoryId,
          serviceId: null,
          coverage: "unknown",
          reason: "manifest_root_ambiguous",
          dependsOnRepositoryIds: [],
          evidenceRefs: candidates.flatMap((candidate) => candidate.evidence.evidenceRefs),
        });
        continue;
      }
      const { node: source, evidence } = candidates[0]!;
      const repositoryEdges: RegaugeDependencyProjectionEdgeV1[] = [];
      let reason: string | null = null;
      for (const edge of edgesFrom(scoped, source.id, ["DEPENDS_ON"])
        .filter((candidate) => candidate.source_system === "manifest")
        .sort((left, right) => compareCodeUnits(left.id, right.id))) {
        const edgeEvidenceRefs = strings(edge.props?.evidence_refs);
        const target = services.find((node) => node.id === edge.target);
        if (
          !target || edge.props?.manifest_content_digest !== evidence.contentDigest ||
          !edgeEvidenceRefs || !evidence.evidenceRefs.every((ref) => edgeEvidenceRefs.includes(ref))
        ) {
          reason = "dependency_edge_evidence_invalid";
          break;
        }
        const matches = (rootByLabel.get(target.label) ?? [])
          .filter((candidate) => candidate.repositoryId !== repositoryId);
        if (matches.length === 0) {
          reason = "dependency_target_unmapped";
          break;
        }
        if (matches.length > 1) {
          reason = "dependency_target_ambiguous";
          break;
        }
        repositoryEdges.push({
          sourceRepositoryId: repositoryId,
          targetRepositoryId: matches[0]!.repositoryId,
          graphEdgeId: edge.id,
          sourceSystem: "manifest",
          confidence: edge.confidence ?? 1,
          evidenceRefs: edgeEvidenceRefs,
        });
      }
      if (reason) {
        repositories.push({
          repositoryId,
          serviceId: source.id,
          coverage: "unknown",
          reason,
          dependsOnRepositoryIds: [],
          evidenceRefs: evidence.evidenceRefs,
        });
        continue;
      }
      projectionEdges.push(...repositoryEdges);
      repositories.push({
        repositoryId,
        serviceId: source.id,
        coverage: "complete",
        reason: "manifest_ingest_complete",
        dependsOnRepositoryIds: [...new Set(repositoryEdges.map((edge) => edge.targetRepositoryId))]
          .sort(compareCodeUnits),
        evidenceRefs: evidence.evidenceRefs,
      });
    }
    return createRegaugeDependencyProjectionV1({
      tenantId: input.tenantId,
      requestedRepositoryIds,
      repositories,
      edges: projectionEdges,
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
