/**
 * ReGauge live-plan consults (spec §28.3). Topology comes from the Change Graph
 * when that graph actually has DEPENDS_ON edges; Organization Memory is consulted
 * through the single precedence resolver so a convention cannot override hard
 * policy. Missing graph or empty relation is declared, never treated as "no
 * dependencies" / "no conventions".
 */
import { createHash } from "node:crypto";
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
): {
  evidenceRefs: string[];
  contentDigest: string;
  manifestPath: string;
  versionId: string;
  coverage: "complete" | "unknown";
} | null {
  const props = node.props;
  const contentDigest = props?.manifest_content_digest;
  const evidenceRefs = strings(props?.manifest_evidence_refs);
  const manifestPath = props?.manifest;
  const versionId = props?.manifest_version_id;
  const status = props?.manifest_ingest_status;
  if (
    node.repo_id !== repositoryId ||
    props?.tenant_id !== tenantId ||
    !["complete", "incomplete"].includes(String(status ?? "")) ||
    props?.declared === true ||
    typeof manifestPath !== "string" || !["package.json", "pyproject.toml", "go.mod"].includes(manifestPath) ||
    typeof contentDigest !== "string" || !DIGEST.test(contentDigest) ||
    typeof versionId !== "string" || !DIGEST.test(versionId) ||
    !evidenceRefs || !evidenceRefs.includes(`manifest-ingest:${contentDigest}`)
  ) return null;
  return {
    evidenceRefs,
    contentDigest,
    manifestPath,
    versionId,
    coverage: status === "complete" ? "complete" : "unknown",
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function canonicalManifestText(value: string): string {
  return value.replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n");
}

function normalizeSnapshotPath(value: string): string | null {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

function workspacePatterns(files: Readonly<Record<string, string>>, manifestPath: string): string[] {
  try {
    const parsed = JSON.parse(files[manifestPath] ?? "") as { workspaces?: unknown };
    const value = parsed.workspaces;
    const patterns = Array.isArray(value)
      ? value
      : value && typeof value === "object" && Array.isArray((value as { packages?: unknown }).packages)
        ? (value as { packages: unknown[] }).packages
        : [];
    return patterns.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function workspacePatternMatches(pattern: string, path: string): boolean {
  const normalized = normalizeSnapshotPath(pattern);
  if (!normalized) return false;
  if (!normalized.includes("*")) return normalized === path;
  const escaped = normalized.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
  return new RegExp(`^${escaped}$`).test(path);
}

export function consultRegaugeGraphDependencies(input: {
  graph: GraphLearnDb | null;
  tenantId: string;
  evaluatedAt: string;
  repositoryIds: readonly string[];
  repositorySnapshots?: readonly Readonly<{
    id: string;
    snapshotId: string;
    revision: string;
    snapshotDigest: string;
    workspacePath?: string;
    workspacePaths?: readonly string[];
    files: Readonly<Record<string, string>>;
  }>[];
}): RegaugeGraphPlanConsult {
  const requestedRepositoryIds = [...new Set(input.repositoryIds)].sort(compareCodeUnits);
  const evaluatedAt = new Date(input.evaluatedAt).toISOString();
  if (!input.graph) {
    return createRegaugeDependencyProjectionV1({
      tenantId: input.tenantId,
      evaluatedAt,
      graphVersionId: "not_consulted",
      graphContentDigest: sha256("not_consulted"),
      requestedRepositoryIds,
      repositories: requestedRepositoryIds.map((repositoryId) => ({
        repositoryId,
        serviceId: null,
        manifestPath: null,
        manifestContentDigest: null,
        manifestVersionId: null,
        snapshotId: null,
        snapshotRevision: null,
        snapshotDigest: null,
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
    const services = listNodesByKind(scoped, "Service")
      .filter((node) => {
        if (node.props?.declared === true || node.props?.manifest_version_id === undefined) return true;
        const validFrom = node.props?.manifest_valid_from;
        const validTo = node.props?.manifest_valid_to;
        return typeof validFrom === "string" && validFrom <= evaluatedAt &&
          (validTo === null || (typeof validTo === "string" && validTo > evaluatedAt));
      })
      .sort((left, right) => compareCodeUnits(left.id, right.id));
    const roots = new Map<string, Array<{
      node: (typeof services)[number];
      evidence: NonNullable<ReturnType<typeof manifestRootEvidence>>;
    }>>();
    for (const repositoryId of requestedRepositoryIds) {
      roots.set(repositoryId, services.flatMap((node) => {
        const evidence = manifestRootEvidence(node, input.tenantId, repositoryId);
        return evidence ? [{ node, evidence }] : [];
      }));
    }
    const repositories: RegaugeDependencyProjectionRepositoryV1[] = [];
    const projectionEdges: RegaugeDependencyProjectionEdgeV1[] = [];
    const snapshotByRepository = new Map(
      (input.repositorySnapshots ?? []).map((snapshot) => [snapshot.id, snapshot]),
    );
    for (const repositoryId of requestedRepositoryIds) {
      const candidates = roots.get(repositoryId) ?? [];
      if (candidates.length === 0) {
        repositories.push({
          repositoryId,
          serviceId: null,
          manifestPath: null,
          manifestContentDigest: null,
          manifestVersionId: null,
          snapshotId: null,
          snapshotRevision: null,
          snapshotDigest: null,
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
          manifestPath: null,
          manifestContentDigest: null,
          manifestVersionId: null,
          snapshotId: null,
          snapshotRevision: null,
          snapshotDigest: null,
          coverage: "unknown",
          reason: "manifest_root_ambiguous",
          dependsOnRepositoryIds: [],
          evidenceRefs: candidates.flatMap((candidate) => candidate.evidence.evidenceRefs),
        });
        continue;
      }
      const { node: source, evidence } = candidates[0]!;
      const snapshot = snapshotByRepository.get(repositoryId);
      if (
        evidence.coverage !== "complete" ||
        !snapshot ||
        typeof snapshot.files[evidence.manifestPath] !== "string" ||
        sha256(canonicalManifestText(snapshot.files[evidence.manifestPath]!)) !==
          evidence.contentDigest
      ) {
        repositories.push({
          repositoryId,
          serviceId: source.id,
          manifestPath: evidence.manifestPath,
          manifestContentDigest: evidence.contentDigest,
          manifestVersionId: evidence.versionId,
          snapshotId: snapshot?.snapshotId ?? null,
          snapshotRevision: snapshot?.revision ?? null,
          snapshotDigest: snapshot?.snapshotDigest ?? null,
          coverage: "unknown",
          reason: evidence.coverage !== "complete"
            ? "manifest_ingest_incomplete"
            : "manifest_snapshot_digest_mismatch",
          dependsOnRepositoryIds: [],
          evidenceRefs: evidence.evidenceRefs,
        });
        continue;
      }
      const repositoryEdges: RegaugeDependencyProjectionEdgeV1[] = [];
      let reason: string | null = null;
      for (const edge of edgesFrom(scoped, source.id, ["DEPENDS_ON"], { at: evaluatedAt })
        .filter((candidate) => candidate.source_system === "manifest")
        .sort((left, right) => compareCodeUnits(left.id, right.id))) {
        const edgeEvidenceRefs = strings(edge.props?.evidence_refs);
        const target = services.find((node) => node.id === edge.target);
        if (
          !target || edge.props?.manifest_content_digest !== evidence.contentDigest ||
          edge.props?.manifest_version_id !== evidence.versionId ||
          !edgeEvidenceRefs || !evidence.evidenceRefs.every((ref) => edgeEvidenceRefs.includes(ref))
        ) {
          reason = "dependency_edge_evidence_invalid";
          break;
        }
        if (edge.props?.dependency_scope === "external_registry") continue;
        if (edge.props?.dependency_scope !== "repository_local") {
          reason = "dependency_edge_scope_invalid";
          break;
        }
        const specifier = typeof edge.props?.specifier === "string" ? edge.props.specifier : "";
        const sourceWorkspacePath = normalizeSnapshotPath(snapshot.workspacePath ?? "");
        const sourceManifestDirectory = normalizeSnapshotPath(
          [sourceWorkspacePath, evidence.manifestPath.split("/").slice(0, -1).join("/")]
            .filter(Boolean).join("/"),
        ) ?? "";
        const relative = specifier.replace(/^(?:file:|link:|portal:)/i, "");
        const resolvedPath = /^(?:file:|link:|portal:|\.\.?[\\/])/i.test(specifier)
          ? normalizeSnapshotPath(`${sourceManifestDirectory}/${relative}`)
          : null;
        const patterns = [
          ...workspacePatterns(snapshot.files, evidence.manifestPath),
          ...(snapshot.workspacePaths ?? []),
        ];
        const matches = [...roots.entries()].flatMap(([candidateRepositoryId, candidateRoots]) => {
          if (candidateRepositoryId === repositoryId || candidateRoots.length !== 1) return [];
          const candidateSnapshot = snapshotByRepository.get(candidateRepositoryId);
          const candidateWorkspacePath = candidateSnapshot?.workspacePath
            ? normalizeSnapshotPath(candidateSnapshot.workspacePath)
            : null;
          const candidateRoot = candidateRoots[0]!.node;
          const pathProven = Boolean(candidateWorkspacePath && resolvedPath === candidateWorkspacePath);
          const workspaceProven = specifier.startsWith("workspace:") && Boolean(
            candidateWorkspacePath && candidateRoot.label === target.label &&
            patterns.some((pattern) => workspacePatternMatches(pattern, candidateWorkspacePath)),
          );
          return pathProven || workspaceProven
            ? [{ repositoryId: candidateRepositoryId, serviceId: candidateRoot.id }]
            : [];
        });
        if (matches.length === 0) {
          reason = "dependency_target_unmapped";
          break;
        }
        if (matches.length > 1) {
          reason = "dependency_target_ambiguous";
          break;
        }
        const resolutionEvidence = `manifest-resolution:${sha256(JSON.stringify({
          sourceSnapshotId: snapshot.snapshotId,
          sourceWorkspacePath,
          targetSnapshotId: snapshotByRepository.get(matches[0]!.repositoryId)!.snapshotId,
          targetWorkspacePath: snapshotByRepository.get(matches[0]!.repositoryId)!.workspacePath,
          workspaceMembership: [...patterns].sort(compareCodeUnits),
          specifier,
        }))}`;
        repositoryEdges.push({
          sourceRepositoryId: repositoryId,
          targetRepositoryId: matches[0]!.repositoryId,
          graphEdgeId: edge.id,
          sourceSystem: "manifest",
          confidence: edge.confidence ?? 1,
          evidenceRefs: [...edgeEvidenceRefs, resolutionEvidence].sort(compareCodeUnits),
        });
      }
      if (reason) {
        repositories.push({
          repositoryId,
          serviceId: source.id,
          manifestPath: evidence.manifestPath,
          manifestContentDigest: evidence.contentDigest,
          manifestVersionId: evidence.versionId,
          snapshotId: snapshot.snapshotId,
          snapshotRevision: snapshot.revision,
          snapshotDigest: snapshot.snapshotDigest,
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
        manifestPath: evidence.manifestPath,
        manifestContentDigest: evidence.contentDigest,
        manifestVersionId: evidence.versionId,
        snapshotId: snapshot.snapshotId,
        snapshotRevision: snapshot.revision,
        snapshotDigest: snapshot.snapshotDigest,
        coverage: "complete",
        reason: "manifest_ingest_complete",
        dependsOnRepositoryIds: [...new Set(repositoryEdges.map((edge) => edge.targetRepositoryId))]
          .sort(compareCodeUnits),
        evidenceRefs: evidence.evidenceRefs,
      });
    }
    const authorityBody = JSON.stringify({
      tenantId: input.tenantId,
      evaluatedAt,
      roots: [...roots.entries()].flatMap(([repositoryId, candidates]) => candidates.map(({ node, evidence }) => ({
        repositoryId,
        nodeId: node.id,
        manifestVersionId: evidence.versionId,
        manifestContentDigest: evidence.contentDigest,
      }))).sort((left, right) => compareCodeUnits(left.nodeId, right.nodeId)),
      edges: [...projectionEdges].sort((left, right) => compareCodeUnits(left.graphEdgeId, right.graphEdgeId)),
    });
    const graphContentDigest = sha256(authorityBody);
    return createRegaugeDependencyProjectionV1({
      tenantId: input.tenantId,
      evaluatedAt,
      graphVersionId: `topology-v1:${graphContentDigest.slice("sha256:".length)}`,
      graphContentDigest,
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
